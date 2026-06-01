// PCB CAM: isolation routing, drilling, and board cutout — UI-independent.
// Ported from the Qt/C++ reference cadcam/pcbcam.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.

import { Polyline, Point, distanceSquared, kEpsilon } from './geometry';
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

/**
 * Convert a (centreline, width) trace into a closed outline polygon by inflating
 * the centreline by width/2 (round caps approximated by the offset). For a
 * degenerate/zero-width trace the polyline is returned closed as-is.
 */
export function traceToOutline(centreline: Polyline, width: number): Polyline {
  // v1 simplification: build the outline of the inflated centreline by offsetting
  // it as a (closed) polygon by +width/2. For an open trace we first close it
  // (out-and-back) so the offsetter sees a thin slab around the path.
  if (centreline.points.length < 2 || width <= kEpsilon) {
    const c = centreline.clone();
    c.closed = true;
    return c;
  }

  // Construct a degenerate closed polygon that traces the centreline forward and
  // back, then offset it outward by width/2 to produce the copper outline.
  const slab = new Polyline();
  for (const p of centreline.points) slab.add(p);
  for (let i = centreline.points.length - 2; i >= 0; --i) slab.add(centreline.points[i]);
  slab.closed = true;

  const outline = offsetPolygon(slab, width / 2.0);
  if (outline.points.length < 3) {
    slab.closed = true;
    return slab;
  }
  outline.closed = true;
  return outline;
}

/**
 * Isolation-route the copper described by `gerber`.
 *
 * SIMPLIFICATION (v1): each copper feature is converted to a closed polygon and
 * offset OUTWARD by (toolRadius + pass*stepover) to mill an isolation gap around
 * it. Traces (centreline + width) are turned into a closed outline by inflating
 * the centreline by width/2; pads/regions are used directly. Each pass produces
 * a feed-following toolpath at `cutZ`. This does NOT merge overlapping copper
 * into single nets — features are isolated individually.
 *   safeZ   retract height (mm), cutZ engraving depth (negative into copper).
 *   passes  number of concentric isolation passes (>=1); spacing = tool.stepover.
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
  // stepover stored as fraction in Tool; for isolation we want a metric step.
  let step = tool.stepover;
  if (step <= 0.0) step = tool.diameter * 0.5;
  if (step <= 1.0) step = step * tool.diameter; // treat <=1 as a fraction

  // Collect every copper feature as a closed polygon to isolate.
  const features: Polyline[] = [];
  for (const t of gerber.traces) {
    const o = traceToOutline(t.centreline, t.width);
    if (o.points.length >= 3) features.push(o);
  }
  for (const pad of gerber.pads)
    if (pad.points.length >= 3) {
      const p = pad.clone();
      p.closed = true;
      features.push(p);
    }
  for (const reg of gerber.regions)
    if (reg.points.length >= 3) {
      const p = reg.clone();
      p.closed = true;
      features.push(p);
    }

  for (const feat of features) {
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
