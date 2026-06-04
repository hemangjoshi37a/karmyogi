// PCB CAM: isolation routing, drilling, and board cutout — UI-independent.
// Ported from the Qt/C++ reference cadcam/pcbcam.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.

import { Polyline, Point, distance, distanceSquared, kEpsilon } from './geometry';
import { Tool, Toolpath, toolRadius } from './toolpath';
import { offsetPolygon } from './offset';
import { GerberData } from './gerber';
import { ExcellonData } from './excellon';

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

/**
 * Isolation-route the copper described by `gerber`.
 *
 * The tool follows a path that clears copper by exactly the tool radius (plus
 * one tool-width per extra pass) away from every copper edge:
 *
 *  - Open TRACES (centreline + width): the isolation cut runs parallel to the
 *    centreline on BOTH sides at distance (width/2 + toolRadius + pass*step).
 *    Each side is a separate open feed path — this is what isolation milling
 *    actually does and what a correct preview shows (twin lines hugging every
 *    track), instead of inflating a zero-area slab (which collapsed to dots).
 *  - Closed PADS / REGIONS (real area): offset OUTWARD by (toolRadius +
 *    pass*step) to mill a ring around the feature.
 *
 * Each pass is a feed-following toolpath at `cutZ`. Features are isolated
 * individually (overlapping copper is not merged into single nets in v1).
 *   safeZ   retract height (mm), cutZ engraving depth (negative into copper).
 *   passes  number of isolation passes (>=1); spacing = one tool width (step).
 */
export function isolationRoutes(
  gerber: GerberData,
  tool: Tool,
  safeZ: number,
  cutZ: number,
  passes: number
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Isolation';
  if (passes < 1) passes = 1;

  const r = toolRadius(tool);
  // tool.stepover is a fraction (0..1) of the diameter; resolve to a metric step
  // (the lateral spacing between successive isolation passes).
  let step = tool.stepover;
  if (step <= 0.0) step = 0.5;
  if (step <= 1.0) step = step * tool.diameter; // <=1 is a fraction of Ø
  else step = step; // already metric

  // ---- Open traces: offset the centreline to each side. ----
  for (const t of gerber.traces) {
    if (t.centreline.points.length < 2) continue;
    for (let pass = 0; pass < passes; ++pass) {
      const d = t.width / 2.0 + r + pass * step;
      for (const sign of [+1, -1]) {
        const side = offsetOpenPolyline(t.centreline, sign * d);
        if (side.points.length >= 2) cutLoop(tp, side, cutZ, safeZ);
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
      cutLoop(tp, ring, cutZ, safeZ);
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
