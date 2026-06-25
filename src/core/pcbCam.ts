// PCB CAM: isolation routing, drilling, and board cutout — UI-independent.
// Ported from the Qt/C++ reference cadcam/pcbcam.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.

import { Polyline, Point, BBox, distance, distanceSquared, pointInPolygon, kEpsilon } from './geometry';
import { Tool, Toolpath, toolRadius } from './toolpath';
import { offsetPolygon } from './offset';
import { GerberData, GerberTrace } from './gerber';
import { ExcellonData, DrillHit } from './excellon';
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Ring } from 'polygon-clipping';

const COPPER_SNAP = 1e-3; // coordinate snap grid (mm) to defuse near-coincident vertices

/** Snap a coordinate to the COPPER_SNAP grid (kills floating-point near-coincidences). */
function snapCoord(v: number): number {
  return Math.round(v / COPPER_SNAP) * COPPER_SNAP;
}

// Append a closed/open loop cut at depth z, retracting to safeZ after.
function cutLoop(tp: Toolpath, loop: Polyline, z: number, safeZ: number): void {
  if (loop.points.length < 2) return;

  const start = loop.points[0];
  tp.rapid({ x: start.x, y: start.y, z: safeZ });
  tp.plunge({ x: start.x, y: start.y, z });

  for (let i = 1; i < loop.points.length; ++i)
    tp.feed({ x: loop.points[i].x, y: loop.points[i].y, z });

  if (loop.closed) tp.feed({ x: start.x, y: start.y, z });

  const end = loop.closed ? start : loop.points[loop.points.length - 1];
  tp.rapid({ x: end.x, y: end.y, z: safeZ });
}

/**
 * Cut a closed isolation loop in one or more DEPTH passes (P11 multi-depth) at the
 * chosen cut DIRECTION (P11 climb/conventional). A V-bit or fragile engraving bit
 * can rarely reach the full copper-clearance depth in a single plunge on an uneven
 * board, so `stepdown` (>0) splits the descent into successive passes; `cutZ` is
 * the final (deepest) negative depth. Each pass re-traces the same loop at a
 * shallower-then-deeper Z, retracting to safeZ only between *features* (the passes
 * stay down, plunging to each new level over the loop start).
 *
 * DIRECTION: `offsetPolygon(+delta)` returns the CCW boundary that hugs the copper;
 * traversed as-is the cutter walks CCW (conventional milling around an OUTER copper
 * island — the cutter's leading edge meets unmachined stock). Reversing the loop
 * gives CW = climb. We flip a CLONE so the caller's polyline winding is untouched.
 */
function cutLoopLayered(
  tp: Toolpath,
  loop: Polyline,
  cutZ: number,
  safeZ: number,
  stepdown: number,
  climb: boolean,
): void {
  if (loop.points.length < 2) return;
  // Choose direction. CCW (positive signed area) = conventional here; climb = CW.
  let path = loop;
  const wantCw = climb; // climb → clockwise traversal
  if (loop.points.length >= 3 && loop.isClockwise() !== wantCw) {
    path = loop.clone();
    path.reverse();
    path.closed = loop.closed;
  }

  // Depth levels: stepdown increments from the surface down to the final cutZ.
  const floor = -Math.abs(cutZ);
  const sd = stepdown > kEpsilon ? stepdown : Math.abs(floor);
  const levels: number[] = [];
  let z = -sd;
  while (z > floor + kEpsilon) {
    levels.push(z);
    z -= sd;
  }
  levels.push(floor);

  const start = path.points[0];
  tp.rapid({ x: start.x, y: start.y, z: safeZ });
  for (const lz of levels) {
    tp.plunge({ x: start.x, y: start.y, z: lz });
    for (let i = 1; i < path.points.length; ++i)
      tp.feed({ x: path.points[i].x, y: path.points[i].y, z: lz });
    if (path.closed) tp.feed({ x: start.x, y: start.y, z: lz });
  }
  const end = path.closed ? start : path.points[path.points.length - 1];
  tp.rapid({ x: end.x, y: end.y, z: safeZ });
}

/** Remove consecutive duplicate vertices (within kEpsilon). */
function dedupePoints(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    if (out.length === 0 || distance(out[out.length - 1], p) > kEpsilon) out.push({ x: p.x, y: p.y });
  }
  return out;
}

/**
 * Offset an OPEN polyline laterally by signed `dist` (left of travel direction is
 * positive). Each vertex is shifted along the bisector of its two adjacent
 * segment normals (miter join); endpoints shift along their single segment
 * normal. This is the correct construction for isolation routing along a copper
 * trace centreline — one offset path per side of the trace.
 */
export function offsetOpenPolyline(line: Polyline, dist: number): Polyline {
  const pts = dedupePoints(line.points);
  const out = new Polyline();
  const n = pts.length;
  if (n < 2 || Math.abs(dist) <= kEpsilon) {
    for (const p of pts) out.add(p);
    return out;
  }

  // Left-hand unit normal of segment i (points to the left of travel a->b).
  const seg: Point[] = [];
  for (let i = 0; i < n - 1; ++i) {
    const dx = pts[i + 1].x - pts[i].x;
    const dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    seg.push(len > kEpsilon ? { x: -dy / len, y: dx / len } : { x: 0, y: 0 });
  }

  for (let i = 0; i < n; ++i) {
    let nx: number;
    let ny: number;
    if (i === 0) {
      nx = seg[0].x;
      ny = seg[0].y;
    } else if (i === n - 1) {
      nx = seg[n - 2].x;
      ny = seg[n - 2].y;
    } else {
      // Miter: average the two segment normals, then rescale so the cut stays at
      // `dist` from both edges (1/cos(half-angle)). Clamp the miter length to
      // avoid spikes at sharp corners.
      let mx = seg[i - 1].x + seg[i].x;
      let my = seg[i - 1].y + seg[i].y;
      const mlen = Math.hypot(mx, my);
      if (mlen <= kEpsilon) {
        // 180° reversal: fall back to the previous normal.
        nx = seg[i - 1].x;
        ny = seg[i - 1].y;
      } else {
        mx /= mlen;
        my /= mlen;
        const cos = mx * seg[i].x + my * seg[i].y; // = cos(half angle)
        const scale = cos > 0.2 ? 1 / cos : 1 / 0.2; // clamp ≤5× to avoid spikes
        nx = mx * scale;
        ny = my * scale;
      }
    }
    out.add({ x: pts[i].x + nx * dist, y: pts[i].y + ny * dist });
  }
  return out;
}

/** A regular n-gon (CCW) approximating a circle of `r` about `c`, as a clip Ring. */
function circleRing(c: Point, r: number, sides = 24): Ring {
  const ring: Ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    ring.push([snapCoord(c.x + r * Math.cos(a)), snapCoord(c.y + r * Math.sin(a))]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** Convert a closed Polyline (a pad or region outline) to a clip Ring (snapped, closed). */
function polylineToRing(pl: Polyline): Ring {
  const ring: Ring = pl.points.map((p) => [snapCoord(p.x), snapCoord(p.y)] as [number, number]);
  if (ring.length) ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/** Convert a clip Ring back to a CLOSED Polyline (dropping the repeated last vertex). */
function ringToPolyline(ring: Ring): Polyline {
  const pl = new Polyline();
  const n = ring.length;
  const end = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
  for (let i = 0; i < end; i++) pl.add({ x: ring[i][0], y: ring[i][1] });
  pl.closed = true;
  return pl;
}

/**
 * Buffer (stroke) an OPEN/CLOSED centreline of width `w` into FILLED polygons:
 * each segment becomes a width-wide rectangle and each vertex a round cap, all
 * emitted as separate clip Polygons that the caller unions together (so the
 * stroke becomes one solid copper body with proper round joins/caps). Mirrors
 * the proven approach in `textPocket.bufferStrokesToContours`, kept local to
 * keep `src/core` modules self-contained.
 */
function strokeToPolygons(line: Polyline, w: number): MultiPolygon {
  const hw = Math.max(kEpsilon, w / 2);
  const out: MultiPolygon = [];
  const pts = dedupePoints(line.points);
  if (pts.length === 0) return out;
  if (pts.length === 1) {
    out.push([circleRing(pts[0], hw)]);
    return out;
  }
  // Round cap/join circle at every vertex.
  for (const p of pts) out.push([circleRing(p, hw)]);
  // Width-wide rectangle along each segment.
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < kEpsilon) continue;
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    const ring: Ring = [
      [snapCoord(a.x + nx), snapCoord(a.y + ny)],
      [snapCoord(b.x + nx), snapCoord(b.y + ny)],
      [snapCoord(b.x - nx), snapCoord(b.y - ny)],
      [snapCoord(a.x - nx), snapCoord(a.y - ny)],
    ];
    ring.push([ring[0][0], ring[0][1]]);
    out.push([ring]);
  }
  return out;
}

/**
 * UNION all copper geometry described by `gerber` into clean, non-overlapping,
 * correctly-wound polygons (outer rings CCW + holes CW). Traces are stroked to
 * their real width first; pads and regions are already filled outlines. The
 * union is accumulated INCREMENTALLY with a try/catch so one degenerate feature
 * can't abort the whole merge (polygon-clipping can throw "Unable to complete
 * output ring" on near-degenerate overlaps); a primitive that still fails is
 * skipped — its copper area is almost always already covered by an overlapping
 * neighbour, so the merged outline is preserved.
 */
function unionCopper(gerber: GerberData): MultiPolygon {
  const prims: MultiPolygon = [];
  for (const t of gerber.traces) {
    if (t.centreline.points.length < 2) continue;
    for (const poly of strokeToPolygons(t.centreline, t.width > 0 ? t.width : COPPER_SNAP)) prims.push(poly);
  }
  for (const pad of gerber.pads) if (pad.points.length >= 3) prims.push([polylineToRing(pad)]);
  for (const reg of gerber.regions) if (reg.points.length >= 3) prims.push([polylineToRing(reg)]);
  if (prims.length === 0) return [];

  let acc: MultiPolygon = [prims[0]];
  for (let i = 1; i < prims.length; i++) {
    try {
      acc = polygonClipping.union(acc, [prims[i]]);
    } catch {
      // Skip a degenerate primitive; overlapping neighbours keep the area filled.
    }
  }
  return acc;
}

/**
 * Isolation-route the copper described by `gerber`.
 *
 * APPROACH (merged-net isolation): every copper feature is first turned into a
 * FILLED polygon — TRACES are stroked to their real width (round joins/caps),
 * PADS and REGIONS are already filled outlines — and ALL of them are UNIONed
 * (via `polygon-clipping`) into one set of merged copper polygons. Connected
 * copper therefore becomes a SINGLE net with one outline, instead of the v1
 * behaviour of isolating every trace/pad individually (which emitted redundant,
 * overlapping passes on dense boards and could cut into copper that is really
 * one net).
 *
 * For each isolation pass `p` we offset the MERGED boundary AWAY from the copper
 * by (toolRadius + p*step) and emit that loop as a feed-following cut at `cutZ`:
 *
 *  - OUTER rings (copper on the inside): offset OUTWARD — the cutter hugs the
 *    true outer copper outline.
 *  - HOLE rings (copper voids / clearances): offset INTO the void so the cutter
 *    isolates the inner copper edge too. `offsetPolygon` normalises any ring to
 *    the CCW region it encloses and `+delta` grows that region, so passing each
 *    ring with `+delta` always moves the cut away from copper — correct for both
 *    outer rings and holes (islands inside voids are handled because the union
 *    nests them as their own outer rings).
 *
 *   safeZ   retract height (mm), cutZ engraving depth (negative into copper).
 *   passes  number of isolation passes (>=1); spacing = `step` (see below).
 *
 * UNIT CONTRACT: the per-pass lateral spacing is taken from `stepoverMm` — an
 * EXPLICIT metric (mm) value. When omitted/non-positive it defaults to one tool
 * radius. This is intentionally NOT `tool.stepover` (which the `Tool` interface
 * documents as a 0..1 fraction of diameter for pocketing); the PCB UI exposes a
 * "Pass stepover (mm)" field, so we keep the contract metric and unambiguous.
 *
 * `mergeNets` (default true) selects the unioned approach above. Set it false to
 * fall back to the legacy per-feature isolation (twin offset lines per trace +
 * concentric rings per pad/region) — kept as a safety net should the union ever
 * yield degenerate output for a pathological board.
 *
 * `opts` (P11) layers the depth and picks the cut direction:
 *  - `stepdown` (>0) splits the copper plunge into successive depth passes down
 *    to `cutZ` (single pass when omitted/0) — gentler on V-bits / uneven boards.
 *  - `climb` true = climb milling (CW around copper); false/omitted = conventional.
 */
export interface IsolationOptions {
  /** Depth per pass (mm, >0). Omitted/0 → a single full-depth pass. */
  stepdown?: number;
  /** true = climb (CW); false/undefined = conventional (CCW). */
  climb?: boolean;
}

export function isolationRoutes(
  gerber: GerberData,
  tool: Tool,
  safeZ: number,
  cutZ: number,
  passes: number,
  stepoverMm?: number,
  mergeNets = true,
  opts: IsolationOptions = {}
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Isolation';
  if (passes < 1) passes = 1;
  const stepdown = opts.stepdown != null && opts.stepdown > 0 ? opts.stepdown : 0;
  const climb = !!opts.climb;

  const r = toolRadius(tool);
  // Lateral spacing between successive isolation passes, in mm. Caller passes an
  // explicit metric value (the "Pass stepover (mm)" field); fall back to one
  // tool radius when not supplied so passes don't overlap to zero.
  let step = stepoverMm != null && Number.isFinite(stepoverMm) ? stepoverMm : 0;
  if (step <= 0.0) step = r > 0 ? r : 0.5;

  if (mergeNets) {
    // Merged-net isolation: union all copper, then offset the merged boundary.
    const merged = unionCopper(gerber);
    // Flatten every ring (outer + holes) of every merged polygon into closed
    // Polylines; each is a single, non-self-intersecting loop ready to offset.
    const rings: Polyline[] = [];
    for (const poly of merged) for (const ring of poly) if (ring.length >= 4) rings.push(ringToPolyline(ring));

    if (rings.length > 0) {
      for (const ring of rings) {
        if (ring.points.length < 3) continue;
        for (let pass = 0; pass < passes; ++pass) {
          const delta = r + pass * step; // away-from-copper isolation offset
          const loop = offsetPolygon(ring, +delta);
          if (loop.points.length < 3) continue;
          loop.closed = true;
          cutLoopLayered(tp, loop, cutZ, safeZ, stepdown, climb);
        }
      }
      return tp;
    }
    // Union produced nothing usable — fall through to per-feature isolation.
  }

  return perFeatureIsolation(gerber, tp, r, step, safeZ, cutZ, passes, stepdown, climb);
}

/**
 * Legacy per-feature isolation (the v1 behaviour), retained as a fallback for
 * `isolationRoutes`:
 *  - Open TRACES (centreline + width): the isolation cut runs parallel to the
 *    centreline on BOTH sides at distance (width/2 + toolRadius + pass*step).
 *  - Closed PADS / REGIONS: offset OUTWARD by (toolRadius + pass*step).
 * Features are isolated individually (overlapping copper is NOT merged).
 */
function perFeatureIsolation(
  gerber: GerberData,
  tp: Toolpath,
  r: number,
  step: number,
  safeZ: number,
  cutZ: number,
  passes: number,
  stepdown = 0,
  climb = false
): Toolpath {
  // ---- Open traces: offset the centreline to each side. ----
  // Open offset lines have no enclosed area, so climb direction is undefined for
  // them; they only honour multi-depth (each side cut layered to depth).
  for (const t of gerber.traces) {
    if (t.centreline.points.length < 2) continue;
    for (let pass = 0; pass < passes; ++pass) {
      const d = t.width / 2.0 + r + pass * step;
      for (const sign of [+1, -1]) {
        const side = offsetOpenPolyline(t.centreline, sign * d);
        if (side.points.length >= 2) cutLoopLayered(tp, side, cutZ, safeZ, stepdown, false);
      }
    }
  }

  // ---- Closed pads / regions: offset outward. ----
  const closedFeatures: Polyline[] = [];
  for (const pad of gerber.pads)
    if (pad.points.length >= 3) {
      const p = pad.clone();
      p.closed = true;
      closedFeatures.push(p);
    }
  for (const reg of gerber.regions)
    if (reg.points.length >= 3) {
      const p = reg.clone();
      p.closed = true;
      closedFeatures.push(p);
    }

  for (const feat of closedFeatures) {
    for (let pass = 0; pass < passes; ++pass) {
      const delta = r + pass * step; // outward isolation ring
      const ring = offsetPolygon(feat, +delta);
      if (ring.points.length < 3) continue;
      ring.closed = true;
      cutLoopLayered(tp, ring, cutZ, safeZ, stepdown, climb);
    }
  }
  return tp;
}

/**
 * Derive a single closed board-outline polygon from a Gerber edge-cuts /
 * mechanical layer. Board outlines are exported either as a closed region
 * (G36/G37), a flashed/closed pad, or — most commonly — as a chain of open
 * trace draws that together form the perimeter. This stitches trace segments
 * end-to-end into one loop. Returns `null` when no usable outline is found, so
 * the caller can fall back to the bounding box.
 */
export function boardOutlinePolygon(gerber: GerberData): Polyline | null {
  // 1. A real filled region is the cleanest source.
  let best: Polyline | null = null;
  let bestArea = 0;
  const consider = (poly: Polyline) => {
    if (poly.points.length < 3) return;
    const a = Math.abs(poly.signedArea());
    if (a > bestArea) {
      bestArea = a;
      best = poly;
    }
  };
  for (const r of gerber.regions) consider(r);
  // A single closed-ish trace (start ≈ end) is also a direct outline.
  for (const t of gerber.traces) {
    const p = t.centreline;
    if (p.points.length >= 3 && distance(p.points[0], p.points[p.points.length - 1]) < 0.5) {
      const c = p.clone();
      c.closed = true;
      consider(c);
    }
  }
  if (best) {
    const loop = (best as Polyline).clone();
    loop.closed = true;
    return loop;
  }

  // 2. Stitch open trace segments into a closed loop by joining nearest endpoints.
  const segs = gerber.traces
    .map((t) => dedupePoints(t.centreline.points))
    .filter((p) => p.length >= 2);
  if (segs.length > 0) {
    const tol = 0.2; // mm — endpoints within this are "the same" node
    const used = new Array<boolean>(segs.length).fill(false);
    used[0] = true;
    const loop: Point[] = segs[0].slice();
    let progressed = true;
    while (progressed) {
      progressed = false;
      const tail = loop[loop.length - 1];
      for (let i = 0; i < segs.length; ++i) {
        if (used[i]) continue;
        const s = segs[i];
        if (distance(tail, s[0]) <= tol) {
          for (let k = 1; k < s.length; ++k) loop.push(s[k]);
          used[i] = true;
          progressed = true;
          break;
        }
        if (distance(tail, s[s.length - 1]) <= tol) {
          for (let k = s.length - 2; k >= 0; --k) loop.push(s[k]);
          used[i] = true;
          progressed = true;
          break;
        }
      }
    }
    const out = new Polyline();
    for (const p of dedupePoints(loop)) out.add(p);
    out.closed = true;
    if (out.points.length >= 3) return out;
  }

  return null;
}

/**
 * Drill every hit: rapid above the hole, plunge to drillZ, retract to safeZ.
 * Hits are ordered nearest-neighbour from the origin to reduce travel.
 *
 * `peckDepth` (>0) enables peck drilling: the hole is descended in increments of
 * `peckDepth`, retracting to safeZ between pecks to clear chips. When `peckDepth`
 * is <= 0 (or >= |drillZ|) a single plunge is emitted.
 */
export function drillHits(
  drill: ExcellonData,
  safeZ: number,
  drillZ: number,
  peckDepth = 0
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Drill';
  if (drill.hits.length === 0) return tp;

  // Nearest-neighbour ordering from the origin to reduce rapid travel. (Feed
  // rates are applied by the emitter from EmitterOptions; the move types here
  // mark plunges so the emitter uses feedZ for them.)
  const n = drill.hits.length;
  const used = new Array<boolean>(n).fill(false);
  let cur: Point = { x: 0.0, y: 0.0 };

  const floorZ = -Math.abs(drillZ);

  for (let k = 0; k < n; ++k) {
    let best = -1;
    let bestD = Number.MAX_VALUE;
    for (let j = 0; j < n; ++j) {
      if (used[j]) continue;
      const d = distanceSquared(cur, drill.hits[j].pos);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) break;
    used[best] = true;
    const h = drill.hits[best];
    tp.rapid({ x: h.pos.x, y: h.pos.y, z: safeZ });

    if (peckDepth > kEpsilon && peckDepth < Math.abs(floorZ)) {
      // Peck drilling: descend in increments, retracting to safeZ between pecks.
      let z = -peckDepth;
      while (z > floorZ + kEpsilon) {
        tp.plunge({ x: h.pos.x, y: h.pos.y, z });
        tp.rapid({ x: h.pos.x, y: h.pos.y, z: safeZ });
        z -= peckDepth;
      }
      tp.plunge({ x: h.pos.x, y: h.pos.y, z: floorZ });
    } else {
      tp.plunge({ x: h.pos.x, y: h.pos.y, z: floorZ });
    }

    tp.rapid({ x: h.pos.x, y: h.pos.y, z: safeZ });
    cur = h.pos;
  }
  return tp;
}

/**
 * Profile-cut the board outline on the OUTSIDE, in multiple depth passes down to
 * (surface - cutDepthTotal). `outline` should be a closed polygon (mm).
 *
 * When `tabCount` > 0, that many uncut "tab" gaps are left at the floor pass so
 * the board stays attached to the stock; the final (deepest) pass skips short
 * spans around evenly-spaced positions along the loop instead of cutting through.
 */
export function boardCutout(
  outline: Polyline,
  tool: Tool,
  safeZ: number,
  cutDepthTotal: number,
  tabCount = 0,
  tabWidth = 2.0
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Cutout';
  if (outline.points.length < 3) return tp;

  const closed = outline.clone();
  closed.closed = true;

  // Profile OUTSIDE: offset outward by the tool radius so the finished board
  // keeps its nominal dimensions.
  let path = offsetPolygon(closed, +toolRadius(tool));
  if (path.points.length < 3) {
    path = closed; // offset collapsed — fall back to on-line
  }
  path.closed = true;

  // Multi-depth descent using the tool's stepdown.
  const floorZ = -Math.abs(cutDepthTotal);
  const stepdown = tool.stepdown > 0.0 ? tool.stepdown : Math.abs(cutDepthTotal);

  const levels: number[] = [];
  let z = -stepdown;
  while (z > floorZ + kEpsilon) {
    levels.push(z);
    z -= stepdown;
  }
  levels.push(floorZ);

  for (let li = 0; li < levels.length; ++li) {
    const lz = levels[li];
    const isFloor = li === levels.length - 1;
    if (isFloor && tabCount > 0 && tabWidth > kEpsilon) {
      cutLoopWithTabs(tp, path, lz, safeZ, tabCount, tabWidth);
    } else {
      cutLoop(tp, path, lz, safeZ);
    }
  }

  return tp;
}

// Cut a closed loop at depth z but leave `tabCount` uncut gaps of `tabWidth` mm
// spaced evenly along the loop perimeter (holding tabs). Tab spans are traversed
// at safeZ instead of being cut.
function cutLoopWithTabs(
  tp: Toolpath,
  loop: Polyline,
  z: number,
  safeZ: number,
  tabCount: number,
  tabWidth: number
): void {
  if (loop.points.length < 2) return;
  const perim = loop.length();
  if (perim <= kEpsilon || tabCount * tabWidth >= perim) {
    cutLoop(tp, loop, z, safeZ);
    return;
  }

  // Tab centre positions as arc-length fractions.
  const tabCentres: number[] = [];
  for (let i = 0; i < tabCount; ++i) tabCentres.push((i / tabCount) * perim);
  const half = tabWidth / 2;
  const inTab = (s: number): boolean => {
    for (const c of tabCentres) {
      // distance around the loop (account for wrap)
      let d = Math.abs(s - c);
      d = Math.min(d, perim - d);
      if (d < half) return true;
    }
    return false;
  };

  // Walk the closed loop edge by edge, accumulating arc length. Cut where not in
  // a tab, lift over tab spans.
  const pts = loop.points;
  const np = pts.length;
  let s = 0;
  // Establish the starting pen state.
  let penDown = !inTab(0);
  const first = pts[0];
  tp.rapid({ x: first.x, y: first.y, z: safeZ });
  if (penDown) tp.plunge({ x: first.x, y: first.y, z });

  for (let i = 0; i < np; ++i) {
    const a = pts[i];
    const b = pts[(i + 1) % np];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen <= kEpsilon) continue;

    // Sample along the segment to detect tab boundary crossings.
    const samples = Math.max(1, Math.ceil(segLen / Math.max(half, 0.25)));
    for (let k = 1; k <= samples; ++k) {
      const t = k / samples;
      const px = a.x + (b.x - a.x) * t;
      const py = a.y + (b.y - a.y) * t;
      const sAt = s + segLen * t;
      const tab = inTab(sAt % perim);
      if (tab && penDown) {
        // entering a tab: lift
        tp.rapid({ x: px, y: py, z: safeZ });
        penDown = false;
      } else if (!tab && !penDown) {
        // exiting a tab: drop and resume cutting
        tp.rapid({ x: px, y: py, z: safeZ });
        tp.plunge({ x: px, y: py, z });
        penDown = true;
      } else if (penDown) {
        tp.feed({ x: px, y: py, z });
      }
    }
    s += segLen;
  }

  tp.rapid({ x: first.x, y: first.y, z: safeZ });
}

// ===========================================================================
// P3 — V-bit isolation depth-from-width
// ===========================================================================

/**
 * A V-shaped engraving bit cuts a groove whose WIDTH grows with depth. The cross
 * section is a flat tip of diameter `tipDia` followed by two faces at half-angle
 * `θ/2` (θ = full included tip angle). At a plunge depth `Z` below the surface the
 * cut width is:
 *
 *   width(Z) = tipDia + 2 · Z · tan(θ/2)
 *
 * For isolation routing we want a specific copper-clearance WIDTH; this inverts
 * the relation to give the plunge depth (a POSITIVE magnitude, mm) that yields it:
 *
 *   Z = (width − tipDia) / (2 · tan(θ/2))
 *
 * Returns 0 when the desired width is already covered by the flat tip (or the
 * inputs are degenerate) — the caller negates it into the cut Z. A 90° bit has
 * tan(45°)=1, so a 0.2 mm groove (0 tip) needs 0.1 mm depth — matching FlatCAM.
 */
export function vbitDepthForWidth(width: number, tipAngleDeg: number, tipDia = 0): number {
  if (!Number.isFinite(width) || !Number.isFinite(tipAngleDeg)) return 0;
  const halfRad = (Math.max(1, Math.min(179, tipAngleDeg)) / 2) * (Math.PI / 180);
  const tan = Math.tan(halfRad);
  if (tan <= kEpsilon) return 0;
  const extra = width - Math.max(0, tipDia);
  if (extra <= 0) return 0;
  return extra / (2 * tan);
}

/**
 * The effective cut WIDTH a V-bit produces at a given plunge depth (the forward
 * relation of {@link vbitDepthForWidth}) — used by the UI's tool-width calculator
 * and by DRC to know the real isolation gap a V-bit setup will clear.
 */
export function vbitWidthAtDepth(depth: number, tipAngleDeg: number, tipDia = 0): number {
  if (!Number.isFinite(depth) || depth <= 0) return Math.max(0, tipDia);
  const halfRad = (Math.max(1, Math.min(179, tipAngleDeg)) / 2) * (Math.PI / 180);
  return Math.max(0, tipDia) + 2 * depth * Math.tan(halfRad);
}

// ===========================================================================
// P5 — Drill grouping by tool diameter
// ===========================================================================

/** Drill hits grouped by their tool diameter (one machinable group per drill bit). */
export interface DrillGroup {
  diameter: number; // mm
  hits: DrillHit[];
}

/**
 * Group an Excellon set into per-diameter buckets, ascending by size. The
 * operator fits ONE drill bit per group, so emitting a separate program (or a
 * paused stage) per group means the holes for a given bit are drilled together —
 * no impossible mid-program bit changes. Hits within a group keep their order;
 * {@link drillHits} re-optimises travel per group when emitting.
 */
export function groupDrillHits(drill: ExcellonData): DrillGroup[] {
  const byDia = new Map<number, DrillHit[]>();
  for (const h of drill.hits) {
    const key = Math.round(h.diameter * 1000) / 1000;
    const arr = byDia.get(key);
    if (arr) arr.push(h);
    else byDia.set(key, [h]);
  }
  return [...byDia.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([diameter, hits]) => ({ diameter, hits }));
}

/**
 * Emit a drilling toolpath for a SINGLE drill group (one bit). Travel-optimised
 * nearest-neighbour ordering + optional peck — identical safe motion to
 * {@link drillHits}, but scoped to one diameter so the group can become its own
 * paused stage / program.
 */
export function drillGroup(
  group: DrillGroup,
  safeZ: number,
  drillZ: number,
  peckDepth = 0
): Toolpath {
  const sub = new ExcellonData();
  sub.hits = group.hits;
  const tp = drillHits(sub, safeZ, drillZ, peckDepth);
  tp.name = `Drill Ø${group.diameter.toFixed(2)}`;
  return tp;
}

// ===========================================================================
// P4 — Copper-pour / non-copper clearing (NCC)
// ===========================================================================

/** Point-in-MultiPolygon test (even-odd over every ring; mm). */
function pointInMultiPolygon(mp: MultiPolygon, x: number, y: number): boolean {
  let inside = false;
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
      }
    }
  }
  return inside;
}

export interface CopperClearOptions {
  /** Lateral stepover between raster rows (mm). Defaults to ~0.8 × tool Ø. */
  stepoverMm?: number;
  /** Clearance kept between the cutter EDGE and copper (mm), beyond the tool radius. */
  clearanceMm?: number;
  /** Depth per pass (mm, >0). Omitted/0 → single full-depth pass. */
  stepdown?: number;
  /**
   * Hard cap on the number of raster rows, so a tiny stepover on a big board can't
   * lock the UI. When exceeded the stepover is widened to fit (a coarser clear).
   */
  maxRows?: number;
}

/**
 * P4 — clear the NON-COPPER area (copper pour / ground-plane relief) inside the
 * board so isolation routing isn't the only thing removing copper: everything that
 * is NOT copper (and not within the cutter's clearance of copper) is milled away to
 * `cutZ`, leaving the copper features standing. Reuses the same merged-copper union
 * the isolation pass builds; the keep-out is that copper grown by (toolRadius +
 * clearance). Rastered as a boustrophedon (alternating rows) at a shallow copper
 * depth, in optional multi-depth passes.
 *
 * `outline` bounds the clearing region (the board edge); when null the copper
 * bounding box (grown a little) is used. Copper that the isolation pass already
 * cut around is left intact — this only flattens the open field between nets.
 */
export function copperPourClear(
  gerber: GerberData,
  tool: Tool,
  safeZ: number,
  cutZ: number,
  outline: Polyline | null,
  opts: CopperClearOptions = {},
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Copper clear';
  const r = toolRadius(tool);
  if (r <= kEpsilon) return tp;

  // Merged copper grown outward to the cutter keep-out distance.
  const merged = unionCopper(gerber);
  if (merged.length === 0) return tp;
  const clearance = Math.max(0, opts.clearanceMm ?? 0) + r;
  const keepOut: MultiPolygon = [];
  for (const poly of merged) {
    for (const ring of poly) {
      if (ring.length < 4) continue;
      const pl = ringToPolyline(ring);
      const grown = offsetPolygon(pl, +clearance);
      if (grown.points.length >= 3) keepOut.push([polylineToRing(grown)]);
    }
  }

  // Field bounds: the outline (inset by the tool radius so the cutter stays inside
  // the board edge) or the copper bbox grown a little.
  const field = new BBox();
  if (outline && outline.points.length >= 3) {
    for (const p of outline.points) field.expand(p);
  } else {
    field.expand(gerber.bounds());
  }
  if (!field.isValid()) return tp;
  const minX = field.min.x + r;
  const maxX = field.max.x - r;
  const minY = field.min.y + r;
  const maxY = field.max.y - r;
  if (!(maxX - minX > kEpsilon && maxY - minY > kEpsilon)) return tp;

  // Stepover + row count guard.
  let step = opts.stepoverMm != null && opts.stepoverMm > 0 ? opts.stepoverMm : tool.diameter * 0.8;
  const maxRows = opts.maxRows ?? 2000;
  const span = maxY - minY;
  if (span / step > maxRows) step = span / maxRows;

  const outlineForTest = outline && outline.points.length >= 3 ? outline : null;
  const inField = (x: number, y: number): boolean => {
    if (outlineForTest && !pointInPolygon(outlineForTest, { x, y })) return false;
    if (pointInMultiPolygon(keepOut, x, y)) return false;
    return true;
  };

  const floor = -Math.abs(cutZ);
  const sd = opts.stepdown != null && opts.stepdown > 0 ? opts.stepdown : 0;
  const levels: number[] = [];
  if (sd > 0) {
    let z = -sd;
    while (z > floor + kEpsilon) {
      levels.push(z);
      z -= sd;
    }
  }
  levels.push(floor);

  const xStep = Math.max(step * 0.5, 0.1);
  for (const lz of levels) {
    let leftToRight = true;
    for (let y = minY; y <= maxY + 1e-9; y += step) {
      // Engaged X spans on this row.
      const spans: { x0: number; x1: number }[] = [];
      let runStart = NaN;
      for (let x = minX; x <= maxX + 1e-9; x += xStep) {
        const on = inField(x, y);
        if (on && Number.isNaN(runStart)) runStart = x;
        else if (!on && !Number.isNaN(runStart)) {
          spans.push({ x0: runStart, x1: x - xStep });
          runStart = NaN;
        }
      }
      if (!Number.isNaN(runStart)) spans.push({ x0: runStart, x1: maxX });
      if (spans.length === 0) continue;
      const ordered = leftToRight ? spans : spans.slice().reverse();
      for (const sp of ordered) {
        const a = leftToRight ? sp.x0 : sp.x1;
        const b = leftToRight ? sp.x1 : sp.x0;
        if (Math.abs(b - a) < kEpsilon) continue;
        tp.rapid({ x: a, y, z: safeZ });
        tp.plunge({ x: a, y, z: lz });
        tp.feed({ x: b, y, z: lz });
        tp.rapid({ x: b, y, z: safeZ });
      }
      leftToRight = !leftToRight;
    }
  }
  return tp;
}

// ===========================================================================
// P6 — Mill-drill / mill-holes (+ slots): holes larger than the bit
// ===========================================================================

/** A circle (CCW) of radius `r` about `c` as a closed Polyline (mm). */
function circlePolyline(c: Point, r: number, sides = 32): Polyline {
  const pl = new Polyline();
  pl.closed = true;
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    pl.add({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
  }
  return pl;
}

/**
 * Mill a single round hole of `holeDia` with a smaller end mill (`toolDia`), in
 * `stepdown` depth passes down to `drillZ`. The bit spirals out from the centre in
 * concentric rings spaced by `stepoverMm` so the finished bore matches `holeDia`
 * (the OUTERMOST ring rides at radius holeDia/2 − toolRadius, so the tool edge
 * reaches the hole wall). Each depth level re-clears every ring. Returns an empty
 * toolpath when the hole is not actually bigger than the bit.
 */
function millOneHole(
  tp: Toolpath,
  c: Point,
  holeDia: number,
  toolDia: number,
  safeZ: number,
  drillZ: number,
  stepdown: number,
  stepoverMm: number,
): void {
  const tr = toolDia / 2;
  const outerR = holeDia / 2 - tr;
  if (outerR <= kEpsilon) return; // bit as big as / bigger than the hole — just drill it
  const floor = -Math.abs(drillZ);
  const sd = stepdown > kEpsilon ? stepdown : Math.abs(floor);
  const step = stepoverMm > kEpsilon ? stepoverMm : tr;

  // Ring radii from the centre outward (centre pilot ring is radius 0 → a plunge).
  const radii: number[] = [];
  for (let rr = step; rr < outerR - kEpsilon; rr += step) radii.push(rr);
  radii.push(outerR);

  const levels: number[] = [];
  let z = -sd;
  while (z > floor + kEpsilon) {
    levels.push(z);
    z -= sd;
  }
  levels.push(floor);

  for (const lz of levels) {
    // Plunge at centre, then spiral out through each ring at this depth.
    tp.rapid({ x: c.x, y: c.y, z: safeZ });
    tp.plunge({ x: c.x, y: c.y, z: lz });
    for (const rr of radii) {
      const ring = circlePolyline(c, rr);
      const s = ring.points[0];
      tp.feed({ x: s.x, y: s.y, z: lz });
      for (let i = 1; i < ring.points.length; i++) tp.feed({ x: ring.points[i].x, y: ring.points[i].y, z: lz });
      tp.feed({ x: s.x, y: s.y, z: lz });
    }
    tp.rapid({ x: c.x, y: c.y, z: safeZ });
  }
}

export interface MillHolesOptions {
  /** Mill (instead of drill) any hole whose Ø exceeds toolDia by at least this margin (mm). */
  minOversizeMm?: number;
  /** Depth per pass (mm, >0). Omitted/0 → single full-depth pass. */
  stepdown?: number;
  /** Lateral spacing between concentric clearing rings (mm). Defaults to tool radius. */
  stepoverMm?: number;
}

/**
 * P6 — mill-drill: for holes that are LARGER than the available end mill, mill the
 * bore out with concentric rings instead of plunge-drilling (which a small bit
 * cannot do). Holes at/under the bit Ø are left to the normal {@link drillHits}
 * drilling pass. Returns the milling toolpath for the oversized holes only (empty
 * when none qualify). The bit Ø is `toolDia`.
 */
export function millHoles(
  drill: ExcellonData,
  toolDia: number,
  safeZ: number,
  drillZ: number,
  opts: MillHolesOptions = {},
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Mill holes';
  const margin = opts.minOversizeMm != null && opts.minOversizeMm >= 0 ? opts.minOversizeMm : 0.1;
  const stepdown = opts.stepdown != null && opts.stepdown > 0 ? opts.stepdown : 0;
  const stepover = opts.stepoverMm != null && opts.stepoverMm > 0 ? opts.stepoverMm : 0;
  // Mill the larger holes first only matters for tool wear; keep file order but
  // nearest-neighbour from origin for travel.
  const oversized = drill.hits.filter((h) => h.diameter > toolDia + margin);
  if (oversized.length === 0) return tp;

  const n = oversized.length;
  const used = new Array<boolean>(n).fill(false);
  let cur: Point = { x: 0, y: 0 };
  for (let k = 0; k < n; k++) {
    let best = -1;
    let bestD = Number.MAX_VALUE;
    for (let j = 0; j < n; j++) {
      if (used[j]) continue;
      const d = distanceSquared(cur, oversized[j].pos);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    if (best < 0) break;
    used[best] = true;
    const h = oversized[best];
    millOneHole(tp, h.pos, h.diameter, toolDia, safeZ, drillZ, stepdown, stepover);
    cur = h.pos;
  }
  return tp;
}

/** Count of Excellon hits whose Ø exceeds the bit by `marginMm` (UI badge / DRC). */
export function oversizedHoleCount(drill: ExcellonData, toolDia: number, marginMm = 0.1): number {
  return drill.hits.filter((h) => h.diameter > toolDia + marginMm).length;
}

// ===========================================================================
// P10 — Units / origin handling: keep-positive + corner/center re-origin
// ===========================================================================

export type OriginMode = 'asis' | 'keepPositive' | 'corner' | 'center';

/** Translate a Gerber's geometry by (dx, dy) (mm), returning a new GerberData. */
function translateGerber(g: GerberData, dx: number, dy: number): GerberData {
  const shift = (pl: Polyline): Polyline => {
    const out = new Polyline();
    for (const p of pl.points) out.add({ x: p.x + dx, y: p.y + dy });
    out.closed = pl.closed;
    return out;
  };
  const out = new GerberData();
  out.traces = g.traces.map((t): GerberTrace => ({ centreline: shift(t.centreline), width: t.width }));
  out.pads = g.pads.map(shift);
  out.regions = g.regions.map(shift);
  return out;
}

/** Translate an Excellon set by (dx, dy) (mm), returning a new ExcellonData. */
function translateExcellon(d: ExcellonData, dx: number, dy: number): ExcellonData {
  const out = new ExcellonData();
  out.hits = d.hits.map((h) => ({ pos: { x: h.pos.x + dx, y: h.pos.y + dy }, diameter: h.diameter }));
  return out;
}

/**
 * Compute the (dx, dy) translation (mm) that re-origins a board to the requested
 * {@link OriginMode}, given the board's overall bounds `b`:
 *  - 'asis'         → no shift (0,0).
 *  - 'keepPositive' → shift the min corner up to (0,0) only if any extent is
 *    negative, so the whole job sits in the +X/+Y quadrant (machines that home to
 *    a corner can't reach negative work coords). Never moves an already-positive
 *    board.
 *  - 'corner'       → move the board's lower-left corner exactly to (0,0).
 *  - 'center'       → move the board centre to (0,0).
 *
 * Returning the delta (rather than transformed geometry) lets the caller apply the
 * SAME shift consistently to every layer + the drill file so they stay registered.
 */
export function originShift(b: BBox, mode: OriginMode): Point {
  if (!b.isValid() || mode === 'asis') return { x: 0, y: 0 };
  if (mode === 'corner') return { x: -b.min.x, y: -b.min.y };
  if (mode === 'center') {
    const c = b.center();
    return { x: -c.x, y: -c.y };
  }
  // keepPositive: only lift the part that's negative.
  return { x: b.min.x < 0 ? -b.min.x : 0, y: b.min.y < 0 ? -b.min.y : 0 };
}

/** Apply an {@link originShift} delta to a Gerber (new object; identity when 0,0). */
export function reoriginGerber(g: GerberData, delta: Point): GerberData {
  if (Math.abs(delta.x) <= kEpsilon && Math.abs(delta.y) <= kEpsilon) return g;
  return translateGerber(g, delta.x, delta.y);
}

/** Apply an {@link originShift} delta to an Excellon (new object; identity when 0,0). */
export function reoriginExcellon(d: ExcellonData, delta: Point): ExcellonData {
  if (Math.abs(delta.x) <= kEpsilon && Math.abs(delta.y) <= kEpsilon) return d;
  return translateExcellon(d, delta.x, delta.y);
}

// ===========================================================================
// P8 — Double-sided: mirror geometry about an axis
// ===========================================================================

export type MirrorAxis = 'x' | 'y';

function mirrorPoint(p: Point, axis: MirrorAxis, c: number): Point {
  return axis === 'y'
    ? { x: 2 * c - p.x, y: p.y } // flip about a vertical line x = c (mirror X)
    : { x: p.x, y: 2 * c - p.y }; // flip about a horizontal line y = c (mirror Y)
}

function mirrorPolyline(pl: Polyline, axis: MirrorAxis, c: number): Polyline {
  const out = new Polyline();
  // Reverse winding so an outer ring stays an outer ring after the reflection
  // (a mirror inverts orientation); preserves correct offset direction downstream.
  for (let i = pl.points.length - 1; i >= 0; i--) out.add(mirrorPoint(pl.points[i], axis, c));
  out.closed = pl.closed;
  return out;
}

/**
 * Mirror a copper Gerber about the board's mid-line on `axis` (P8 double-sided).
 * The flip axis defaults to the geometry centre so the mirrored bottom layer
 * registers on top of the front when the operator physically turns the stock
 * over about that same axis. Pass an explicit `axisCoord` (e.g. derived from the
 * board OUTLINE, or from two alignment-hole X/Y) to register against a shared
 * datum instead of each layer's own extents.
 *
 * Used to machine the BOTTOM copper from the TOP setup's coordinate frame after
 * a physical flip: the operator mills the front, flips the board about `axis`,
 * re-zeroes, and runs this mirrored bottom program.
 */
export function mirrorGerber(gerber: GerberData, axis: MirrorAxis, axisCoord?: number): GerberData {
  const b = gerber.bounds();
  const c = axisCoord != null && Number.isFinite(axisCoord)
    ? axisCoord
    : axis === 'y'
    ? b.center().x
    : b.center().y;
  const out = new GerberData();
  out.traces = gerber.traces.map(
    (t): GerberTrace => ({ centreline: mirrorPolyline(t.centreline, axis, c), width: t.width }),
  );
  out.pads = gerber.pads.map((p) => mirrorPolyline(p, axis, c));
  out.regions = gerber.regions.map((r) => mirrorPolyline(r, axis, c));
  return out;
}

/** Mirror an Excellon drill set about `axis` (for drilling from the flipped side). */
export function mirrorExcellon(drill: ExcellonData, axis: MirrorAxis, axisCoord?: number): ExcellonData {
  const b = drill.bounds();
  const c = axisCoord != null && Number.isFinite(axisCoord)
    ? axisCoord
    : axis === 'y'
    ? b.center().x
    : b.center().y;
  const out = new ExcellonData();
  out.hits = drill.hits.map((h) => ({ pos: mirrorPoint(h.pos, axis, c), diameter: h.diameter }));
  return out;
}

// ===========================================================================
// P12 — DRC-lite (pre-generate checks)
// ===========================================================================

export type DrcSeverity = 'error' | 'warning' | 'info';

export interface DrcIssue {
  severity: DrcSeverity;
  message: string;
}

export interface DrcInput {
  /** Effective isolation tool/groove width (mm): the bit Ø, or a V-bit's width@Z. */
  toolWidth: number;
  copper?: GerberData | null;
  drill?: ExcellonData | null;
  /** Smallest drill bit the operator actually has (mm), to flag tiny holes. */
  minDrillBit?: number;
}

/** Min centre-to-centre distance between any two of the supplied points (mm). */
function minPointSpacing(pts: Point[]): number {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = distance(pts[i], pts[j]);
      if (d < m) m = d;
    }
  return m;
}

/**
 * DRC-lite: cheap, conservative pre-flight checks surfaced as warnings BEFORE
 * generating G-code. Catches the common ways an isolation/drill job silently
 * fails: a cutter wider than the smallest copper gap (so it shorts adjacent
 * nets), tiny holes below the available bit, and a missing copper/drill input.
 *
 * The copper-gap estimate is conservative and bounded: it measures the closest
 * approach between DISTINCT copper bodies by sampling the unioned outline rings'
 * vertices (capped, so a dense board stays responsive). It can under-report on
 * pathological boards, so it is a WARNING, never a hard block.
 */
export function drcCheck(input: DrcInput): DrcIssue[] {
  const issues: DrcIssue[] = [];
  const { toolWidth, copper, drill } = input;

  if (copper) {
    const merged = unionCopper(copper);
    // Collect outer-ring vertices of each distinct copper body (cap per board).
    const bodies: Point[][] = [];
    for (const poly of merged) {
      if (!poly.length || poly[0].length < 4) continue;
      bodies.push(poly[0].map(([x, y]) => ({ x, y })));
    }
    if (bodies.length >= 2) {
      // Closest approach between distinct bodies = the smallest copper gap.
      const CAP = 600; // vertices/body sampled — bounds the O(n·m) probe
      let gap = Infinity;
      for (let a = 0; a < bodies.length; a++) {
        const A = bodies[a].length > CAP ? sampleEvenly(bodies[a], CAP) : bodies[a];
        for (let b = a + 1; b < bodies.length; b++) {
          const B = bodies[b].length > CAP ? sampleEvenly(bodies[b], CAP) : bodies[b];
          for (const pa of A)
            for (const pb of B) {
              const d = distance(pa, pb);
              if (d < gap) gap = d;
            }
        }
      }
      if (Number.isFinite(gap)) {
        if (toolWidth > gap + kEpsilon) {
          issues.push({
            severity: 'error',
            message: `Cutter width ${toolWidth.toFixed(3)} mm is wider than the smallest copper gap ≈ ${gap.toFixed(3)} mm — it will short adjacent nets. Use a smaller bit (or a shallower V-bit depth).`,
          });
        } else if (toolWidth > gap * 0.8) {
          issues.push({
            severity: 'warning',
            message: `Cutter width ${toolWidth.toFixed(3)} mm is close to the smallest copper gap ≈ ${gap.toFixed(3)} mm — isolation may be marginal.`,
          });
        }
      }
    } else if (bodies.length === 1) {
      issues.push({
        severity: 'info',
        message: 'Copper merges into a single net — no inter-net gap to violate (check this is intended).',
      });
    }
  } else {
    issues.push({ severity: 'info', message: 'No copper layer assigned — isolation DRC skipped.' });
  }

  if (drill && drill.hits.length > 0) {
    const dias = drill.toolDiameters();
    const smallest = dias.length ? Math.min(...dias) : 0;
    const minBit = input.minDrillBit;
    if (minBit != null && smallest > 0 && smallest < minBit - kEpsilon) {
      issues.push({
        severity: 'warning',
        message: `Smallest hole Ø${smallest.toFixed(2)} mm is below your smallest drill bit Ø${minBit.toFixed(2)} mm — those holes can't be drilled directly (mill them, or fit a finer bit).`,
      });
    }
    // Overlapping holes (centre spacing < the bit) usually means a slot exported
    // as drills — drilling them risks bit deflection / breakout.
    if (drill.hits.length >= 2) {
      const sp = minPointSpacing(drill.hits.map((h) => h.pos));
      if (Number.isFinite(sp) && sp < smallest - kEpsilon && smallest > 0) {
        issues.push({
          severity: 'warning',
          message: `Two holes are ${sp.toFixed(2)} mm apart — closer than the bit Ø${smallest.toFixed(2)} mm. This is likely a routed slot; drilling may break the bit.`,
        });
      }
    }
  }

  return issues;
}

/** Evenly subsample a vertex list down to ≤ `n` points (keeps shape, bounds cost). */
function sampleEvenly(pts: Point[], n: number): Point[] {
  if (pts.length <= n) return pts;
  const out: Point[] = [];
  const step = pts.length / n;
  for (let i = 0; i < n; i++) out.push(pts[Math.floor(i * step)]);
  return out;
}

/** Re-export BBox helper consumers occasionally need alongside the CAM ops. */
export { BBox };
