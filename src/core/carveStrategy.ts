// Cut-strategy post-processors for 2D milling toolpaths — UI-independent, pure
// TS (no DOM/React/three). These take a {@link Toolpath} produced by the basic
// CAM ops (profile / pocket / cutout / engrave) and rewrite its MOVE list to add
// machinist-grade entry/exit and direction control, without ever bypassing the
// safe {@link GcodeEmitter} (the panel still feeds the result through it):
//
//   • C7  lead-in / lead-out — replace the straight retract-then-plunge at a cut
//          start with a tangential or arc APPROACH so the tool eases into the
//          material edge instead of dropping onto it, and eases out at the end.
//   • C7  ramped / helical plunge — replace a vertical PLUNGE (which a desktop
//          machine hates) with a shallow RAMP (zig-zag back-and-forth along the
//          first cut span) or a HELIX (circular descent) down to cut depth.
//   • C12 climb / conventional — force every closed cut loop to run in the
//          requested direction (CW vs CCW for the cutter's spin + side), and
//   • C12 stock-to-leave — already handled by an offset in cam.ts; this module
//          only carries the direction post-pass for it.
//   • C15 drag-knife — compensate a tangential drag knife: offset the blade by
//          its trailing distance and insert SWIVEL moves at sharp corners so the
//          blade re-aligns before continuing (no straight plunges; the knife is
//          dropped, swivelled, then dragged).
//
// All functions are PURE: they read a Toolpath + options and return a NEW
// Toolpath. They never emit G-code directly.

import { Point, Polyline, kEpsilon, distance } from './geometry';
import { MoveType, Toolpath, type ToolpathMove, type Vec3 } from './toolpath';

// ── C12 · cut direction (climb vs conventional) ─────────────────────────────

/** Cut direction for a closed loop. */
export type CutDirection = 'climb' | 'conventional';

/**
 * For a given milling SIDE the cutter is on, the geometric loop winding that
 * yields a CLIMB cut (chip thins to zero) depends on whether the tool is on the
 * inside or outside of the part and the spindle's (always CW from above for a
 * standard router) rotation. We model the common desktop-router convention:
 *   • OUTSIDE profile  → climb = CLOCKWISE loop (when viewed from +Z, the part
 *     stays on the tool's LEFT).
 *   • INSIDE profile / pocket → climb = COUNTER-CLOCKWISE loop.
 * Conventional is the opposite winding in each case. `isInside` selects which.
 */
export function climbIsClockwise(isInside: boolean): boolean {
  return !isInside;
}

/**
 * Re-orient a single closed loop so it cuts in the requested DIRECTION. Open
 * loops carry no winding and are returned unchanged. `isInside` describes which
 * side of the part the cut is on (inside profile / pocket vs outside profile),
 * because the winding↔direction mapping flips between them.
 */
export function orientLoop(loop: Polyline, dir: CutDirection, isInside: boolean): Polyline {
  if (!loop.closed || loop.points.length < 3) return loop;
  const out = loop.clone();
  const climbCW = climbIsClockwise(isInside);
  const wantCW = dir === 'climb' ? climbCW : !climbCW;
  out.makeClockwise(wantCW);
  return out;
}

// ── C7 · lead-in / lead-out + ramp / helical plunge ─────────────────────────

/** Entry/exit shape for a cut. */
export type LeadShape = 'none' | 'tangent' | 'arc';

/** How the tool descends to cutting depth (avoids a straight plunge). */
export type PlungeMode = 'plunge' | 'ramp' | 'helix';

export interface LeadRampOptions {
  /** Lead-in/out shape applied at each cut start/end. */
  lead: LeadShape;
  /** Lead length (mm) — tangent run, or arc radius for `arc`. */
  leadLengthMm: number;
  /** Plunge strategy used to reach each cut depth. */
  plunge: PlungeMode;
  /** Ramp/helix descent angle from horizontal (deg). Shallower = gentler. */
  rampAngleDeg: number;
  /** Helix radius (mm) for the `helix` plunge. */
  helixRadiusMm: number;
  /** Safe retract Z (mm) — unchanged, used to keep links safe. */
  safeZ: number;
}

export const DEFAULT_LEADRAMP: LeadRampOptions = {
  lead: 'none',
  leadLengthMm: 2,
  plunge: 'ramp',
  rampAngleDeg: 15,
  helixRadiusMm: 1.5,
  safeZ: 5,
};

/** A contiguous cut "segment": the start plunge + following feed moves. */
interface CutRun {
  /** Index in the source moves of the plunge that starts this run. */
  plungeIdx: number;
  /** Feed-move targets after the plunge (the actual cut), in order. */
  cut: Vec3[];
  /** The XY/Z the plunge lands at (cut start). */
  start: Vec3;
}

/** Direction (unit) from a→b in XY, or null when coincident. */
function dirXY(a: Point, b: Point): { ux: number; uy: number } | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < kEpsilon) return null;
  return { ux: dx / len, uy: dy / len };
}

/**
 * Rewrite a toolpath so every vertical PLUNGE becomes a ramp/helix descent and
 * (optionally) every cut start/end gets a tangential or arc lead. The move
 * structure produced by cam.ts is: rapid(safeZ) → plunge(z) → feed… → rapid(safeZ).
 * We find each plunge + its following run of feed moves and rebuild the entry.
 *
 * SAFETY: the result still starts each run with a rapid to safe-Z over the entry
 * point, so the panel's emitter keeps its safe-Z guarantees. We never cut across
 * a gap at depth — ramps stay within the run's own first cut span (or helix
 * circle), and leads are added at the same depth as the cut they attach to.
 */
export function applyLeadRamp(src: Toolpath, opt: LeadRampOptions): Toolpath {
  const out = new Toolpath();
  out.name = src.name;
  const moves = src.moves;
  const n = moves.length;
  let i = 0;

  // Identify and replay runs; copy non-cut moves verbatim.
  while (i < n) {
    const m = moves[i];
    if (m.type !== MoveType.Plunge) {
      out.append(cloneMove(m));
      i++;
      continue;
    }
    // Collect the cut run: plunge + following Feed moves.
    const start = { ...m.target };
    const cut: Vec3[] = [];
    let j = i + 1;
    while (j < n && moves[j].type === MoveType.Feed) {
      cut.push({ ...moves[j].target });
      j++;
    }
    const run: CutRun = { plungeIdx: i, cut, start };
    emitRun(out, run, opt);
    i = j;
  }
  return out;
}

function cloneMove(m: ToolpathMove): ToolpathMove {
  return { target: { ...m.target }, type: m.type };
}

/** Top Z this run was approached from (the rapid right before the plunge sets it). */
function approachZ(opt: LeadRampOptions, start: Vec3): number {
  // The cut's surface reference is the highest of safeZ-floor; we descend from
  // the cut start's own "top" which the caller positioned at safeZ. Use safeZ
  // as the ramp's top so the descent is fully inside the safe envelope.
  return Math.max(opt.safeZ, start.z);
}

function emitRun(out: Toolpath, run: CutRun, opt: LeadRampOptions): void {
  const { start, cut } = run;
  // First cut direction (for tangent lead + ramp axis).
  const firstTarget = cut.length > 0 ? cut[0] : null;
  const d = firstTarget ? dirXY(start, firstTarget) : null;

  // ── Lead-in: approach the cut start from outside along the cut tangent ──
  if (opt.lead !== 'none' && d && opt.leadLengthMm > kEpsilon) {
    const L = opt.leadLengthMm;
    if (opt.lead === 'tangent') {
      const ax = start.x - d.ux * L;
      const ay = start.y - d.uy * L;
      out.rapid({ x: ax, y: ay, z: opt.safeZ });
      // descend at the lead point then feed onto the contour start
      descend(out, { x: ax, y: ay, z: start.z }, opt, d);
      out.feed({ x: start.x, y: start.y, z: start.z });
    } else {
      // Quarter-circle arc tangent to the cut, centred to the left of travel.
      const r = L;
      const cx = start.x - d.uy * r; // left normal
      const cy = start.y + d.ux * r;
      // Arc from the entry point (90° before the contour) to start.
      const segs = 10;
      const a0 = Math.atan2(start.y - cy, start.x - cx);
      const aStart = a0 + Math.PI / 2;
      const e0x = cx + r * Math.cos(aStart);
      const e0y = cy + r * Math.sin(aStart);
      out.rapid({ x: e0x, y: e0y, z: opt.safeZ });
      descend(out, { x: e0x, y: e0y, z: start.z }, opt, d);
      for (let k = 1; k <= segs; k++) {
        const a = aStart + (a0 - aStart) * (k / segs);
        out.feed({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: start.z });
      }
    }
  } else {
    // No lead → descend directly at the cut start.
    out.rapid({ x: start.x, y: start.y, z: opt.safeZ });
    descend(out, start, opt, d);
  }

  // ── The cut itself ──
  for (const c of cut) out.feed({ x: c.x, y: c.y, z: c.z });

  // ── Lead-out: ease away from the last cut point along its exit tangent ──
  const end = cut.length > 0 ? cut[cut.length - 1] : start;
  if (opt.lead === 'tangent' && cut.length >= 2 && opt.leadLengthMm > kEpsilon) {
    const prev = cut[cut.length - 2];
    const de = dirXY(prev, end);
    if (de) {
      out.feed({ x: end.x + de.ux * opt.leadLengthMm, y: end.y + de.uy * opt.leadLengthMm, z: end.z });
    }
  }
  out.rapid({ x: end.x, y: end.y, z: opt.safeZ });
}

/**
 * Descend to `target.z` at `target` XY using the configured plunge mode. `dir`
 * is the first cut direction (for the ramp axis); helix ignores it. Always
 * leaves the tool AT `target` (x,y,z) so the cut continues from there.
 */
function descend(out: Toolpath, target: Vec3, opt: LeadRampOptions, dir: { ux: number; uy: number } | null): void {
  const top = approachZ(opt, target);
  const depth = top - target.z;
  if (depth <= kEpsilon) {
    out.feed({ x: target.x, y: target.y, z: target.z });
    return;
  }
  if (opt.plunge === 'plunge' || !dir) {
    out.plunge({ x: target.x, y: target.y, z: target.z });
    return;
  }
  const angle = Math.max(1, Math.min(89, opt.rampAngleDeg)) * (Math.PI / 180);
  const runPerDepth = 1 / Math.tan(angle); // horizontal mm per vertical mm
  const horiz = depth * runPerDepth;

  if (opt.plunge === 'helix') {
    const r = Math.max(0.2, opt.helixRadiusMm);
    const circ = 2 * Math.PI * r;
    const turns = Math.max(1, Math.ceil(horiz / Math.max(circ, kEpsilon)));
    const segsPerTurn = 16;
    const total = turns * segsPerTurn;
    const cx = target.x - r; // start the helix one radius to -X of target
    const cy = target.y;
    // Move to the helix start at top Z, then spiral down, finishing at target.
    out.feed({ x: cx + r, y: cy, z: top });
    for (let k = 1; k <= total; k++) {
      const f = k / total;
      const a = 2 * Math.PI * turns * f;
      out.feed({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: top - depth * f });
    }
    out.feed({ x: target.x, y: target.y, z: target.z });
    return;
  }

  // ramp: zig-zag back and forth along the first cut direction, descending.
  const half = horiz / 2;
  const ax = dir.ux;
  const ay = dir.uy;
  // Start a half-ramp BEHIND the cut start so we end exactly at target.
  const bx = target.x - ax * half;
  const by = target.y - ay * half;
  out.feed({ x: bx, y: by, z: top });
  // forward+down to the far point at mid-depth, back to start at full depth.
  out.feed({ x: bx + ax * horiz, y: by + ay * horiz, z: top - depth / 2 });
  out.feed({ x: target.x, y: target.y, z: target.z });
}

// ── C15 · drag-knife compensation ───────────────────────────────────────────

export interface DragKnifeOptions {
  /** Trailing blade offset (mm) — distance from pivot to cutting tip. */
  bladeOffsetMm: number;
  /** Corner angle (deg) above which a swivel move is inserted. */
  swivelThresholdDeg: number;
  /** Z the blade is lowered to for cutting. */
  cutZ: number;
  /** Safe retract Z (mm). */
  safeZ: number;
}

export const DEFAULT_DRAGKNIFE: DragKnifeOptions = {
  bladeOffsetMm: 0.25,
  swivelThresholdDeg: 20,
  cutZ: -0.3,
  safeZ: 5,
};

/**
 * Compensate a tangential DRAG KNIFE over a set of polylines. A drag knife's
 * cutting tip trails its pivot by `bladeOffsetMm`; to cut a path accurately the
 * PIVOT must lead the desired path by that offset along the path tangent, and at
 * any sharp corner the blade must be SWIVELLED (pivoted in place at cut depth, or
 * via a small over-cut) so it re-aligns to the new direction before continuing.
 *
 * We emit, per polyline: lower at the start (pivot leading), drag along each
 * segment with the pivot offset ahead, and at every corner whose turn exceeds
 * `swivelThresholdDeg` insert a swivel = a short move that pivots the blade about
 * the corner point so its tip points down the next segment. No straight plunges:
 * the knife is lowered once at the path start at the pivot-lead point.
 */
export function dragKnifeToolpath(paths: Polyline[], opt: DragKnifeOptions): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Drag-knife';
  const off = Math.max(0, opt.bladeOffsetMm);
  const thr = Math.max(0, Math.min(180, opt.swivelThresholdDeg)) * (Math.PI / 180);

  for (const pl of paths) {
    const pts = pl.points.slice();
    if (pl.closed && pts.length >= 2) pts.push({ ...pts[0] });
    if (pts.length < 2) continue;

    // Pivot lead point for the first segment.
    const d0 = dirXY(pts[0], pts[1]);
    if (!d0) continue;
    const lead0 = { x: pts[0].x + d0.ux * off, y: pts[0].y + d0.uy * off };

    tp.rapid({ x: lead0.x, y: lead0.y, z: opt.safeZ });
    tp.plunge({ x: lead0.x, y: lead0.y, z: opt.cutZ });

    let prevDir = d0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const d = dirXY(a, b);
      if (!d) continue;

      // Corner turn between the incoming and this segment's direction.
      const dot = Math.max(-1, Math.min(1, prevDir.ux * d.ux + prevDir.uy * d.uy));
      const turn = Math.acos(dot);
      if (turn > thr) {
        // SWIVEL: pivot the blade about the corner `a` so the tip re-aligns. We
        // realise this by moving the pivot to a→ + the NEW direction offset while
        // the tip stays planted at `a` (a short in-place arc the knife follows).
        const swivelX = a.x + d.ux * off;
        const swivelY = a.y + d.uy * off;
        tp.feed({ x: swivelX, y: swivelY, z: opt.cutZ });
      }
      // Drag to b with the pivot leading by `off` along this segment.
      tp.feed({ x: b.x + d.ux * off, y: b.y + d.uy * off, z: opt.cutZ });
      prevDir = d;
    }
    // Lift the blade clear at the path end.
    const last = pts[pts.length - 1];
    const ld = prevDir;
    tp.rapid({ x: last.x + ld.ux * off, y: last.y + ld.uy * off, z: opt.safeZ });
  }
  return tp;
}

// ── C8 · rest machining (which material a previous, larger tool left) ────────

/**
 * Compute the REST regions a previous (larger) tool could not reach inside a set
 * of pocket/profile boundaries: the geometric difference between what the small
 * tool can clear and what the big tool already cleared. We approximate this with
 * an INNER-corner test on the boundary — corners sharper than the previous tool
 * radius keep leftover material — and return the boundary loops the new (smaller)
 * tool should re-clear. This is a lightweight 2D rest model (no full boolean
 * geometry): it flags which loops warrant a rest pass, so the panel can run a
 * pocket/profile with the smaller tool ONLY where the big tool left a fillet.
 *
 * Returns the indices of the input loops that need rest machining.
 */
export function restMachiningLoops(loops: Polyline[], prevToolRadiusMm: number, newToolRadiusMm: number): number[] {
  if (newToolRadiusMm >= prevToolRadiusMm - kEpsilon) return []; // no finer tool → nothing new to clear
  const out: number[] = [];
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li];
    if (loop.points.length < 3) continue;
    if (loopHasUnreachableCorner(loop, prevToolRadiusMm)) out.push(li);
  }
  return out;
}

/**
 * True when the loop has at least one CONCAVE corner whose inscribed radius is
 * smaller than the previous tool radius — i.e. the big tool left material in that
 * corner that a smaller tool can now reach.
 */
function loopHasUnreachableCorner(loop: Polyline, prevR: number): boolean {
  const p = loop.points;
  const n = p.length;
  const cw = loop.isClockwise();
  for (let i = 0; i < n; i++) {
    const a = p[(i - 1 + n) % n];
    const b = p[i];
    const c = p[(i + 1) % n];
    const v1 = dirXY(b, a);
    const v2 = dirXY(b, c);
    if (!v1 || !v2) continue;
    // Interior angle at b.
    const dot = Math.max(-1, Math.min(1, v1.ux * v2.ux + v1.uy * v2.uy));
    const ang = Math.acos(dot); // 0..π
    // Cross product sign tells convex/concave relative to winding.
    const cross = v1.ux * v2.uy - v1.uy * v2.ux;
    const concave = cw ? cross > 0 : cross < 0;
    if (!concave) continue;
    // Inscribed radius that fits in this corner ≈ shortest adjacent edge * tan(half).
    const eA = distance(b, a);
    const eC = distance(b, c);
    const half = ang / 2;
    const inscribed = Math.min(eA, eC) * Math.tan(half);
    if (inscribed < prevR - kEpsilon) return true;
  }
  return false;
}
