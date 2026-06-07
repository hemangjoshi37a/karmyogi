// Part CUTOUT pass for 3D relief carving — UI-independent, pure TypeScript.
// No React / DOM / three.js imports (mirrors the cadcam lib split).
//
// After the relief top surface is carved, this profiles the OUTER perimeter of
// the finished part down through the stock so the part is freed from the block,
// leaving evenly-spaced holding TABS (bridges of un-cut material) so the part
// doesn't break loose mid-cut.
//
// Two cut SHAPES the operator chooses up front:
//   • 'outline' — follow the carved part's OUTER perimeter (the edges of the 3D
//     part), offset outward by the tool radius so the freed part keeps its size.
//   • 'rect'    — a user-sized rectangle (auto = part bbox + margin, or explicit
//     X/Y origin + width/height). Cuts a clean rectangular blank out of the stock.
//
// Either shape can additionally CLEAR the material around the part down to the
// bottom level (a pocket): concentric inset rings fill the region between the
// boundary (rectangle or outline-derived bbox) and the part outline, so the part
// is left standing proud on a cleared floor instead of merely profiled free.
//
// Strategy:
//   1. Part outline — trace the OUTER boundary of the carved part's footprint
//      from the heightmap `covered` coverage mask (the up-facing region that was
//      actually carved). Each disjoint island becomes its own closed polygon in
//      bed-mm, simplified with Douglas–Peucker.
//   2. Offset OUTWARD by toolRadius (+ optional finishAllowance) via offset.ts so
//      the freed part keeps its full size (the tool rides OUTSIDE the boundary).
//      For 'rect' the rectangle is used directly (tool rides on its line).
//   3. Depth passes + tabs — profile the cut ring(s) from Z=0 down to
//      Z = -(stockThickness + breakThrough) in cutStepdown increments. N tabs are
//      spaced evenly along the perimeter; on passes deeper than the tab top the
//      tool rises over each tab span so a bridge of material is left. When
//      clearing-around (pocket) is on, each level also runs inset clearing rings.
//
// All Z values are <= 0 (cut DOWN into the stock); the emitter adds the safe-Z
// lifts. We only emit Feed / Plunge / Rapid moves here; the caller emits this
// toolpath AFTER the relief finishing pass so one program does carve + cut-out.

import { Toolpath } from './toolpath';
import { Polyline, Point, pointInPolygon, orderLoopsInsideOut } from './geometry';
import { offsetPolygon } from './offset';
import type { Heightmap } from './carve3d';

/** Cut SHAPE the operator picks up front. */
export type CutoutShape = 'outline' | 'rect';

/** User-defined rectangle for the 'rect' shape (mm, bed coordinates). */
export interface CutoutRect {
  /**
   * 'auto'   — the rectangle is the part bounding box grown by {@link marginMm}.
   * 'manual' — the rectangle is the explicit x/y origin + width/height below.
   */
  mode: 'auto' | 'manual';
  /** Auto mode: extra clearance added around the part bbox on every side (mm). */
  marginMm: number;
  /** Manual mode: rectangle origin (lower-left corner, bed-mm). */
  x: number;
  y: number;
  /** Manual mode: rectangle size (mm). */
  width: number;
  height: number;
}

/** Parameters for the optional cut-the-part-free pass. Distances in mm. */
export interface CutoutParams {
  enabled: boolean;
  /** Cut shape: follow the part outline, or cut a user-sized rectangle. */
  shape: CutoutShape;
  /**
   * Also CLEAR the material around the part down to the bottom level (pocket the
   * region between the cut boundary and the part outline) instead of only cutting
   * the perimeter free. The part is left standing on a cleared floor.
   */
  clearAround: boolean;
  /** Rectangle definition (used when {@link shape} is 'rect'). */
  rect: CutoutRect;
  /** Full stock thickness (mm) the part is cut out of. */
  stockThicknessMm: number;
  /** Depth removed per profile pass (mm). */
  cutStepdownMm: number;
  /** Extra depth below the stock bottom so the cut goes fully through (mm). */
  breakThroughMm: number;
  /** Holding tabs that keep the part attached until removed by hand. */
  tabs: {
    /** Number of tabs spaced evenly around each island perimeter. */
    count: number;
    /** Arc length of each tab along the perimeter (mm). */
    lengthMm: number;
    /** Height of the bridge left under each tab, measured from the stock bottom (mm). */
    heightMm: number;
  };
  /**
   * Extra clearance added to the outward offset beyond the tool radius (mm) so
   * the finished edge keeps a sliver of stock if desired. 0 = ride exactly the
   * tool radius outside the traced boundary.
   */
  finishAllowanceMm: number;
  /** The tool always rides OUTSIDE the part boundary for a cutout. */
  side: 'outside';
  /**
   * Max HELICAL-RAMP angle from horizontal (deg) for descending into each profile
   * depth level instead of plunging straight down (HARDWARE SAFETY). Optional;
   * defaults to 3°. Lower = gentler/longer ramp.
   */
  rampAngleDeg?: number;
  /**
   * Hard cap on a single straight-down vertical plunge (mm) in the cutout pass.
   * Optional; defaults to 0.5mm.
   */
  maxStraightPlungeMm?: number;
}

export function defaultCutoutParams(overrides: Partial<CutoutParams> = {}): CutoutParams {
  const tabDefaults = { count: 4, lengthMm: 6, heightMm: 1.5 };
  const rectDefaults: CutoutRect = {
    mode: 'auto',
    marginMm: 3,
    x: 0,
    y: 0,
    width: 50,
    height: 50,
  };
  return {
    enabled: false,
    shape: 'outline',
    clearAround: false,
    stockThicknessMm: 12,
    cutStepdownMm: 1.5,
    breakThroughMm: 0.3,
    finishAllowanceMm: 0,
    side: 'outside',
    rampAngleDeg: 3,
    maxStraightPlungeMm: 0.5,
    ...overrides,
    // Merge nested objects so a partial override (or an OLDER saved shape missing
    // the new fields) keeps sensible defaults for everything not overridden.
    tabs: { ...tabDefaults, ...(overrides.tabs ?? {}) },
    rect: { ...rectDefaults, ...(overrides.rect ?? {}) },
  };
}

export interface CutoutResult {
  toolpath: Toolpath | null;
  /** Closed outer outlines (bed-mm) used for the cut, one per island. */
  outlines: Polyline[];
  warnings: string[];
}

// ----------------------------------------------------------------------------
// 1. Trace the OUTER boundary of the covered mask into closed polygons (bed-mm)
// ----------------------------------------------------------------------------

/**
 * Trace the boundary of the model FOOTPRINT (XY silhouette) of a heightmap into
 * one or more closed polygons in BED-MM. Each occupied cell contributes its 4
 * unit edges; an edge shared by two occupied cells cancels, leaving only the
 * silhouette. The surviving boundary edges are chained into closed loops along
 * the cell corner lattice, then mapped corner-index → mm via the origin/pitch.
 *
 * The footprint mask is used (NOT the carved-coverage mask) so the outline is
 * the part's full XY shadow regardless of how the surface faces or how deep
 * anything was carved — a flat-top part (nothing milled) still yields a complete
 * outline to profile out. Older meshes without a footprint mask fall back to the
 * carved-coverage mask so the behaviour degrades gracefully.
 *
 * OUTER vs HOLE: a loop's signed area sign distinguishes outer boundaries from
 * interior holes. We keep only OUTER loops (the part silhouette); holes inside
 * the footprint are not part of the cutout perimeter. Disjoint islands each
 * yield their own outer loop, so multiple parts are all cut.
 */
export function traceCoveredOutline(hm: Heightmap): Polyline[] {
  const { nx, ny } = hm;
  if (nx < 2 || ny < 2) return [];
  const cornersX = nx + 1;
  // Prefer the model footprint silhouette; fall back to carved coverage.
  const mask = hm.footprint ?? hm.covered;

  const isCovered = (ix: number, iy: number): boolean => {
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return false;
    return mask[iy * nx + ix] !== 0;
  };

  // Collect the silhouette boundary edges. Walk each covered cell and add the
  // edges on sides where the neighbour is NOT covered (a covered/air interface).
  // Store each as a DIRECTED segment in lattice-corner coords so chaining is
  // unambiguous; direction is chosen so material is on the LEFT (CCW outer).
  //
  // For a covered cell (ix,iy) occupying corner rect [ix..ix+1]×[iy..iy+1]:
  //   - top    edge (iy+1) faces +Y air → go from (ix+1,iy+1)→(ix,iy+1)
  //   - bottom edge (iy)   faces -Y air → go from (ix,iy)→(ix+1,iy)
  //   - left   edge (ix)   faces -X air → go from (ix,iy+1)→(ix,iy)
  //   - right  edge (ix+1) faces +X air → go from (ix+1,iy)→(ix+1,iy+1)
  // (CCW around the material so the outer loop has positive signed area.)
  type Seg = { ax: number; ay: number; bx: number; by: number };
  const segs: Seg[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (!isCovered(ix, iy)) continue;
      if (!isCovered(ix, iy - 1)) segs.push({ ax: ix, ay: iy, bx: ix + 1, by: iy }); // bottom
      if (!isCovered(ix, iy + 1)) segs.push({ ax: ix + 1, ay: iy + 1, bx: ix, by: iy + 1 }); // top
      if (!isCovered(ix - 1, iy)) segs.push({ ax: ix, ay: iy + 1, bx: ix, by: iy }); // left
      if (!isCovered(ix + 1, iy)) segs.push({ ax: ix + 1, ay: iy, bx: ix + 1, by: iy + 1 }); // right
    }
  }
  if (segs.length === 0) return [];

  // Chain segments into closed loops by matching each segment's end corner to
  // the next segment's start corner. A corner key indexes the lattice node.
  const cornerKey = (x: number, y: number): number => y * cornersX + x;
  // Map start-corner → list of segment indices that begin there.
  const startMap = new Map<number, number[]>();
  for (let i = 0; i < segs.length; i++) {
    const k = cornerKey(segs[i].ax, segs[i].ay);
    const arr = startMap.get(k);
    if (arr) arr.push(i);
    else startMap.set(k, [i]);
  }
  const used = new Uint8Array(segs.length);

  const loops: { x: number; y: number }[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const loop: { x: number; y: number }[] = [];
    let cur = i;
    let guard = 0;
    const maxGuard = segs.length + 4;
    while (cur >= 0 && !used[cur] && guard++ < maxGuard) {
      used[cur] = 1;
      const s = segs[cur];
      loop.push({ x: s.ax, y: s.ay });
      // Find a segment starting where this one ends. Prefer an UNUSED one; if
      // several share the corner (a pinch point), take any unused.
      const cand = startMap.get(cornerKey(s.bx, s.by));
      let next = -1;
      if (cand) {
        for (const c of cand) {
          if (!used[c]) {
            next = c;
            break;
          }
        }
      }
      cur = next;
    }
    if (loop.length >= 3) loops.push(loop);
  }

  // Convert lattice-corner loops to mm and collapse collinear runs. Corner (cx,cy)
  // sits at the boundary between cells; the heightmap stores cell-CENTRE values
  // at x0 + ix*dx, so a corner ix maps to x0 + (ix - 0.5)*dx.
  const { x0, y0, dx, dy } = hm;
  const toMm = (cx: number, cy: number): Point => ({
    x: x0 + (cx - 0.5) * dx,
    y: y0 + (cy - 0.5) * dy,
  });

  const outers: Polyline[] = [];
  for (const loop of loops) {
    const pl = new Polyline();
    pl.closed = true;
    for (const c of loop) pl.add(toMm(c.x, c.y));
    const collapsed = collapseCollinear(pl);
    if (collapsed.points.length < 3) continue;
    // Keep only OUTER loops (positive signed area, CCW). Holes (negative area)
    // are interior and not part of the silhouette perimeter to cut.
    if (collapsed.signedArea() <= 0) continue;
    outers.push(collapsed);
  }
  return outers;
}

/** Drop vertices that lie on the straight line between their neighbours. */
function collapseCollinear(poly: Polyline): Polyline {
  const pts = poly.points;
  const n = pts.length;
  if (n < 3) return poly.clone();
  const out = new Polyline();
  out.closed = poly.closed;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const lenA = Math.hypot(b.x - a.x, b.y - a.y);
    const lenC = Math.hypot(c.x - b.x, c.y - b.y);
    // Collinear when the triangle area is ~0 relative to the edge lengths.
    if (Math.abs(cross) > 1e-7 * Math.max(1, lenA * lenC)) out.add(b);
  }
  return out;
}

/**
 * Douglas–Peucker simplification of a CLOSED polygon. Splits the ring at its two
 * farthest-apart vertices into two open chains, simplifies each, and rejoins —
 * so the result stays a faithful closed loop. `tol` is the max chord deviation
 * (mm).
 */
export function simplifyClosed(poly: Polyline, tol: number): Polyline {
  const pts = poly.points;
  const n = pts.length;
  if (n < 4 || tol <= 0) return poly.clone();

  // Pick the vertex farthest from pts[0] as the second anchor so the two open
  // chains span the ring well.
  let far = 1;
  let farD = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const chainA = pts.slice(0, far + 1);
  const chainB = pts.slice(far).concat([pts[0]]);
  const a = douglasPeucker(chainA, tol);
  const b = douglasPeucker(chainB, tol);
  // Rejoin: a ends at `far`, b starts at `far` and ends at start → drop the
  // shared endpoints to avoid duplicates.
  const merged = a.slice(0, a.length - 1).concat(b.slice(0, b.length - 1));
  const out = new Polyline();
  out.closed = true;
  for (const p of merged) out.add(p);
  if (out.points.length < 3) return poly.clone();
  return out;
}

function douglasPeucker(points: Point[], tol: number): Point[] {
  if (points.length < 3) return points.slice();
  const first = 0;
  const last = points.length - 1;
  let maxDist = -1;
  let idx = -1;
  const ax = points[first].x;
  const ay = points[first].y;
  const bx = points[last].x;
  const by = points[last].y;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let i = first + 1; i < last; i++) {
    const px = points[i].x - ax;
    const py = points[i].y - ay;
    let dist: number;
    if (len2 < 1e-12) {
      dist = Math.hypot(px, py);
    } else {
      // Perpendicular distance to the line A→B.
      const cross = Math.abs(px * dy - py * dx);
      dist = cross / Math.sqrt(len2);
    }
    if (dist > maxDist) {
      maxDist = dist;
      idx = i;
    }
  }
  if (maxDist > tol && idx > first) {
    const left = douglasPeucker(points.slice(first, idx + 1), tol);
    const right = douglasPeucker(points.slice(idx, last + 1), tol);
    return left.slice(0, left.length - 1).concat(right);
  }
  return [points[first], points[last]];
}

/** Axis-aligned XY bounding box (bed-mm) of the model footprint. */
function coveredBBox(hm: Heightmap): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const { nx, ny, x0, y0, dx, dy } = hm;
  const mask = hm.footprint ?? hm.covered;
  let minIx = Infinity;
  let minIy = Infinity;
  let maxIx = -Infinity;
  let maxIy = -Infinity;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      if (mask[iy * nx + ix] === 0) continue;
      if (ix < minIx) minIx = ix;
      if (ix > maxIx) maxIx = ix;
      if (iy < minIy) minIy = iy;
      if (iy > maxIy) maxIy = iy;
    }
  }
  if (!Number.isFinite(minIx)) return null;
  // Cell centres sit at x0 + ix*dx; the covered footprint spans half a cell past
  // the outermost centres (matching the corner-lattice mapping in the tracer).
  return {
    minX: x0 + (minIx - 0.5) * dx,
    maxX: x0 + (maxIx + 0.5) * dx,
    minY: y0 + (minIy - 0.5) * dy,
    maxY: y0 + (maxIy + 0.5) * dy,
  };
}

/** Closed CCW rectangle polyline from corner + size (bed-mm). */
function rectPolyline(x: number, y: number, w: number, h: number): Polyline {
  const pl = new Polyline();
  pl.closed = true;
  pl.add({ x, y });
  pl.add({ x: x + w, y });
  pl.add({ x: x + w, y: y + h });
  pl.add({ x, y: y + h });
  return pl;
}

// ----------------------------------------------------------------------------
// 2 + 3. Offset outward, depth passes with holding tabs
// ----------------------------------------------------------------------------

/** Cumulative arc-length parameterisation of a closed polygon. */
interface RingParam {
  pts: Point[]; // closed ring (no repeated first vertex)
  cum: number[]; // cumulative length at the START of each edge (cum[0] = 0)
  total: number; // perimeter length
}

function paramRing(poly: Polyline): RingParam {
  const pts = poly.points.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  const cum: number[] = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    cum[i] = total;
    const a = pts[i];
    const b = pts[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return { pts, cum, total };
}

/** Point on the ring at arc-length `s` (wrapped into [0, total)). */
function pointAt(rp: RingParam, s: number): Point {
  const { pts, cum, total } = rp;
  if (total <= 0) return { ...pts[0] };
  let t = s % total;
  if (t < 0) t += total;
  const n = pts.length;
  // Binary-search the edge whose start cum <= t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= t) lo = mid;
    else hi = mid - 1;
  }
  const a = pts[lo];
  const b = pts[(lo + 1) % n];
  const segLen = (lo + 1 < n ? cum[lo + 1] : total) - cum[lo];
  const f = segLen > 1e-9 ? (t - cum[lo]) / segLen : 0;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/** Tab spans as [startS, endS] arc-length intervals (may wrap past total). */
function tabSpans(rp: RingParam, count: number, lengthMm: number): { s0: number; s1: number }[] {
  const spans: { s0: number; s1: number }[] = [];
  if (count <= 0 || lengthMm <= 0 || rp.total <= 0) return spans;
  const len = Math.min(lengthMm, rp.total / Math.max(count, 1) * 0.9);
  for (let i = 0; i < count; i++) {
    const center = (i + 0.5) * (rp.total / count);
    spans.push({ s0: center - len / 2, s1: center + len / 2 });
  }
  return spans;
}

/** True when arc-length `s` lies inside any tab span (wrapped). */
function inTab(s: number, spans: { s0: number; s1: number }[], total: number): boolean {
  let t = s % total;
  if (t < 0) t += total;
  for (const span of spans) {
    let a = span.s0 % total;
    if (a < 0) a += total;
    let b = span.s1 % total;
    if (b < 0) b += total;
    if (a <= b) {
      if (t >= a && t <= b) return true;
    } else {
      // Span wraps the seam.
      if (t >= a || t <= b) return true;
    }
  }
  return false;
}

/** Inputs the per-level profile emitter shares across shapes. */
interface ProfileCtx {
  tp: Toolpath;
  safeZ: number;
  levels: number[];
  tabTopZ: number;
  tabsCount: number;
  tabsLengthMm: number;
  /** Stock top Z (mm) — the ramp into the FIRST level descends from here. */
  topZ: number;
  /** Max ramp angle from horizontal (deg) for the helical descent into a level. */
  rampAngleDeg: number;
  /** Hard cap on a single straight-down vertical plunge (mm). */
  maxStraightPlungeMm: number;
}

/**
 * Emit a tabbed profile of one closed ring across all depth levels into `ctx.tp`.
 * Returns true if any tab ramp was actually applied (a pass dipped below the tab
 * top). Z stays <= 0 and every island lead-in/out happens at safe-Z.
 *
 * HARDWARE SAFETY: each level is entered with a HELICAL RAMP along the ring (the
 * Z descends gradually over the first arc-length of the perimeter, capped at the
 * configured plunge angle) instead of a straight vertical plunge — avoiding the
 * tool-breakage / burn risk and the dwell mark a point-plunge leaves. The ramp
 * doubles as a tangential LEAD-IN (the tool eases onto the cut along the contour).
 */
function emitProfileRing(ring: Polyline, ctx: ProfileCtx): boolean {
  const { tp, safeZ, levels, tabTopZ, tabsCount, tabsLengthMm, topZ } = ctx;
  const rp = paramRing(ring);
  if (rp.total < 1e-6) return false;
  const spans = tabSpans(rp, tabsCount, tabsLengthMm);
  const sampleStep = Math.max(0.5, Math.min(rp.total / 64, 2));
  const start = pointAt(rp, 0);
  let anyTabs = false;

  const tanRamp = Math.tan((Math.max(1, Math.min(30, ctx.rampAngleDeg)) * Math.PI) / 180);
  const maxStraight = Math.max(0, ctx.maxStraightPlungeMm);

  // Z the tool is currently at when each level begins: the stock top for the first
  // level, then the previous level for the rest (we ramp from there to the new one).
  let prevZ = topZ;

  /** Z honouring the tab bridge at arc-length s for a target `level`. */
  const tabbedZ = (s: number, level: number, belowTab: boolean): number => {
    if (belowTab && inTab(s, spans, rp.total)) {
      anyTabs = true;
      return Math.max(level, tabTopZ);
    }
    return level;
  };

  tp.rapid({ x: start.x, y: start.y, z: safeZ });
  for (const level of levels) {
    const levelBelowTabTop = level < tabTopZ - 1e-6 && spans.length > 0;
    const drop = prevZ - level; // descent for this level (>= 0)

    // Position over the ring start at the previous-level height (a no-cut rapid for
    // the first level from safe-Z; otherwise we're already on the contour).
    if (prevZ < safeZ - 1e-6) tp.rapid({ x: start.x, y: start.y, z: prevZ });

    if (drop <= maxStraight + 1e-6 || tanRamp <= 1e-6) {
      // Tiny descent — a short capped plunge is fine.
      tp.plunge({ x: start.x, y: start.y, z: tabbedZ(0, level, levelBelowTabTop) });
    } else {
      // HELICAL RAMP: descend from prevZ to `level` over the first `rampLen` of the
      // ring (capped to the perimeter), riding the contour. If the perimeter is too
      // short to make the angle, we loop the ring as many times as needed.
      const rampLen = drop / tanRamp;
      let sDone = 0;
      let zNow = prevZ;
      tp.feed({ x: start.x, y: start.y, z: zNow }); // first contact = a controlled cut
      while (sDone < rampLen - 1e-6 && zNow > level + 1e-6) {
        sDone += sampleStep;
        const frac = Math.min(1, sDone / rampLen);
        zNow = prevZ - drop * frac;
        const sWrap = sDone % rp.total;
        const p = pointAt(rp, sWrap);
        // Never ramp ABOVE the tab bridge height where a tab is required.
        const z = levelBelowTabTop ? Math.max(zNow, tabbedZ(sWrap, level, true)) : zNow;
        tp.feed({ x: p.x, y: p.y, z });
      }
    }

    // Full pass around the ring at the level (honouring tabs).
    let s = sampleStep;
    const end = rp.total;
    while (s < end - 1e-6) {
      const p = pointAt(rp, s);
      tp.feed({ x: p.x, y: p.y, z: tabbedZ(s, level, levelBelowTabTop) });
      s += sampleStep;
    }
    tp.feed({ x: start.x, y: start.y, z: tabbedZ(0, level, levelBelowTabTop) });
    prevZ = level;
  }
  tp.rapid({ x: start.x, y: start.y, z: safeZ });
  return anyTabs;
}

/**
 * Emit the AREA-CLEARING (pocket) passes that FLATTEN the empty rectangular field
 * around the part, leaving the part standing proud on a cleared floor. The cleared
 * region is everything inside `boundary` (the rectangle, already inset by the tool
 * radius so the cut stays inside the perimeter profile) but OUTSIDE any part
 * keep-out (the part outline grown outward by the tool radius so the tool edge
 * never touches the part).
 *
 * Rather than ring-tracing (which fragments into many short scattered moves and
 * re-plunges as it crosses the part — the "random moves" we must avoid), this
 * rasterizes the field into a boustrophedon: scan rows of constant Y across the
 * rectangle, cut the engaged spans (inside boundary, outside keep-out) left↔right
 * with the sweep direction alternating each row, and stay DOWN linking spans on
 * the same row when the gap between them is fully clear. The tool lifts to safe-Z
 * only when the next engaged span is unreachable on the floor (i.e. the part lies
 * between) — so plunges land only on real stock-to-remove and travel is minimal.
 *
 * One full-depth `level` is cut per call (the caller repeats per depth level).
 */
function emitClearLevel(
  tp: Toolpath,
  boundary: Polyline,
  keepOuts: Polyline[],
  level: number,
  safeZ: number,
  _toolRadius: number,
  stepover: number,
  ramp: { startZ: number; tanRamp: number; maxStraightMm: number },
): void {
  const step = Math.max(stepover, 0.1);
  // Ramp a span-entry plunge along the span instead of straight down (safety).
  // `spanLen` is the available cutting length from the entry toward `dir`; the
  // ramp zig-zags within it (an even number of legs returns to the entry point at
  // `level`). When the span is too short to make the angle, it falls back to a
  // capped stepped plunge so a single straight descent never exceeds the cap.
  const rampSpanPlunge = (entryX: number, y: number, dir: number, spanLen: number): void => {
    const drop = ramp.startZ - level;
    if (ramp.startZ < safeZ - 1e-6) tp.rapid({ x: entryX, y, z: ramp.startZ });
    if (drop <= ramp.maxStraightMm + 1e-6 || ramp.tanRamp <= 1e-6) {
      tp.plunge({ x: entryX, y, z: level });
      return;
    }
    const rampLen = drop / ramp.tanRamp;
    const legLen = Math.min(Math.max(spanLen, 0), Math.max(rampLen / 2, step));
    if (legLen < step * 0.5) {
      // Too short to ramp — capped stepped plunge.
      let zNow = ramp.startZ;
      const cap = ramp.maxStraightMm > 1e-6 ? ramp.maxStraightMm : drop + 1;
      while (zNow - level > cap + 1e-6) { zNow -= cap; tp.plunge({ x: entryX, y, z: zNow }); }
      tp.plunge({ x: entryX, y, z: level });
      return;
    }
    let legs = Math.max(2, Math.ceil(rampLen / legLen));
    if (legs % 2 === 1) legs += 1;
    const zPerLeg = drop / legs;
    const xStepRamp = Math.max(step * 0.5, 0.1);
    tp.feed({ x: entryX, y, z: ramp.startZ });
    let zSoFar = ramp.startZ;
    let atX = entryX;
    for (let leg = 0; leg < legs; leg++) {
      const goingOut = leg % 2 === 0;
      const destX = goingOut ? entryX + dir * legLen : entryX;
      const zEnd = zSoFar - zPerLeg;
      const n = Math.max(1, Math.ceil(Math.abs(destX - atX) / xStepRamp));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        tp.feed({ x: atX + (destX - atX) * t, y, z: zSoFar + (zEnd - zSoFar) * t });
      }
      atX = destX;
      zSoFar = zEnd;
    }
    tp.feed({ x: entryX, y, z: level });
  };
  // Rectangle (axis-aligned) bounds of the clear boundary.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of boundary.points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  if (!(maxX - minX > 1e-6 && maxY - minY > 1e-6)) return;

  // Sample X at half-stepover so the engaged/keep-out test resolves the part
  // boundary cleanly; rows are spaced a full stepover apart.
  const xStep = Math.max(step * 0.5, 0.1);
  const inField = (x: number, y: number): boolean => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    if (!pointInPolygon(boundary, { x, y })) return false;
    for (const k of keepOuts) if (pointInPolygon(k, { x, y })) return false;
    return true;
  };

  const rows: number[] = [];
  for (let y = minY + step * 0.5; y <= maxY - step * 0.5 + 1e-9; y += step) rows.push(y);
  if (rows.length === 0) rows.push((minY + maxY) / 2);

  let down = false;
  let leftToRight = true;
  let lastX = 0, lastY = 0;
  for (const y of rows) {
    // Collect engaged X spans on this row.
    interface Span { x0: number; x1: number; }
    const spans: Span[] = [];
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
    for (const span of ordered) {
      const entryX = leftToRight ? span.x0 : span.x1;
      const exitX = leftToRight ? span.x1 : span.x0;
      // Can we stay DOWN to reach this span's entry? Try the straight link, then
      // the boustrophedon L-link (along the previous row to entryX, then up to the
      // new row) — both must stay entirely in the cleared field (never over the
      // part). The L-link is what lets adjacent serpentine rows chain without a
      // safe-Z hop. Otherwise lift, reposition, re-plunge.
      const way = down ? linkClear(inField, lastX, lastY, entryX, y, xStep, step) : null;
      if (way) {
        for (const [lx, ly] of way) tp.feed({ x: lx, y: ly, z: level });
      } else {
        if (down) tp.rapid({ x: lastX, y: lastY, z: safeZ });
        tp.rapid({ x: entryX, y, z: safeZ });
        // Ramp the descent along this span instead of a straight plunge (safety).
        const spanLen = Math.abs(exitX - entryX);
        const dir = exitX >= entryX ? 1 : -1;
        rampSpanPlunge(entryX, y, dir, spanLen);
        down = true;
      }
      tp.feed({ x: exitX, y, z: level });
      lastX = exitX;
      lastY = y;
    }
    leftToRight = !leftToRight;
  }
  if (down) tp.rapid({ x: lastX, y: lastY, z: safeZ });
}

/** True when the X gap [a..b] at constant row y stays inside the clear field. */
function rowClear(
  inField: (x: number, y: number) => boolean,
  a: number,
  b: number,
  y: number,
  xStep: number,
): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let x = lo; x <= hi + 1e-9; x += xStep) {
    if (!inField(x, y)) return false;
  }
  return true;
}

/** True when the Y gap [a..b] at constant column x stays inside the clear field. */
function colClear(
  inField: (x: number, y: number) => boolean,
  x: number,
  a: number,
  b: number,
  yStep: number,
): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  for (let y = lo; y <= hi + 1e-9; y += yStep) {
    if (!inField(x, y)) return false;
  }
  return true;
}

/**
 * Can the tool stay DOWN on the cleared floor moving from (ax,ay) to (bx,by)?
 * Tries the straight same-row link first, then the boustrophedon L-link (along the
 * source row to bx, then up the column to by) — the route adjacent serpentine rows
 * use. Returns the axis-aligned waypoints (excluding start, including end) when a
 * fully-in-field route exists, else null (caller must lift to safe-Z and re-plunge).
 */
function linkClear(
  inField: (x: number, y: number) => boolean,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  xStep: number,
  yStep: number,
): [number, number][] | null {
  if (Math.abs(ay - by) < 1e-9) {
    return rowClear(inField, ax, bx, ay, xStep) ? [[bx, by]] : null;
  }
  // L-link: along the source row to bx, then up the column to by.
  if (rowClear(inField, ax, bx, ay, xStep) && colClear(inField, bx, ay, by, yStep)) {
    return [[bx, ay], [bx, by]];
  }
  // L-link the other way: up the source column to by, then along to bx.
  if (colClear(inField, ax, ay, by, yStep) && rowClear(inField, ax, bx, by, xStep)) {
    return [[ax, by], [bx, by]];
  }
  return null;
}

/**
 * Build the cutout toolpath for a carved part. `toolRadius` is the cutter radius
 * (mm).
 *
 * Shape:
 *   • 'outline' — profile each carved island's OUTER perimeter, offset OUTWARD by
 *     (toolRadius + finishAllowance) so the freed part keeps its full size.
 *   • 'rect'    — profile a single user-sized rectangle (auto = part bbox grown by
 *     the margin, or an explicit X/Y origin + W×H).
 *
 * Z descends from 0 to -(stock + breakThrough) in cutStepdown steps; tabs leave a
 * bridge of height `tabs.heightMm` above the stock bottom. When `clearAround` is
 * set, each level also clears the material between the boundary and the part
 * (a pocket), leaving the part standing on a cleared floor.
 */
export function buildCutout(hm: Heightmap, params: CutoutParams, toolRadius: number): CutoutResult {
  const warnings: string[] = [];
  const result: CutoutResult = { toolpath: null, outlines: [], warnings };
  if (!params.enabled) return result;

  const stock = Math.max(0, params.stockThicknessMm);
  if (!(stock > 0)) {
    warnings.push('Cutout: stock thickness must be > 0.');
    return result;
  }

  // 1. Trace the part silhouette from the covered mask (needed for outline mode
  //    and as the pocket keep-out region in both modes).
  const rawOutlines = traceCoveredOutline(hm);
  if (rawOutlines.length === 0) {
    warnings.push('Cutout: no part footprint found in the model to cut around.');
    return result;
  }
  const simpTol = Math.max(hm.dx, hm.dy) * 0.75;
  const outlines = rawOutlines.map((o) => simplifyClosed(o, simpTol)).filter((o) => o.points.length >= 3);

  const radius = Math.max(0, toolRadius);
  const off = radius + Math.max(0, params.finishAllowanceMm);

  // 2. Build the cut RING(S) for the chosen shape.
  const cutRings: Polyline[] = [];
  if (params.shape === 'rect') {
    let rx: number, ry: number, rw: number, rh: number;
    if (params.rect.mode === 'manual') {
      rx = params.rect.x;
      ry = params.rect.y;
      rw = Math.max(0, params.rect.width);
      rh = Math.max(0, params.rect.height);
    } else {
      const bb = coveredBBox(hm);
      if (!bb) {
        warnings.push('Cutout: could not size the rectangle from the part footprint.');
        return result;
      }
      const m = Math.max(0, params.rect.marginMm);
      rx = bb.minX - m;
      ry = bb.minY - m;
      rw = bb.maxX - bb.minX + 2 * m;
      rh = bb.maxY - bb.minY + 2 * m;
    }
    if (!(rw > 1e-6 && rh > 1e-6)) {
      warnings.push('Cutout: rectangle width/height must be > 0.');
      return result;
    }
    const rect = rectPolyline(rx, ry, rw, rh);
    result.outlines.push(rect);
    cutRings.push(rect);
  } else {
    // 'outline' — offset each island OUTWARD so the tool rides outside the edge.
    for (const outline of outlines) {
      const ring = off > 1e-6 ? offsetPolygon(outline, off) : outline.clone();
      if (ring.points.length >= 3) {
        result.outlines.push(ring);
        cutRings.push(ring);
      } else {
        warnings.push('Cutout: an island outline collapsed under the tool offset; skipped.');
      }
    }
  }
  if (cutRings.length === 0) return result;

  // CUT-ORDER SAFETY: when one cut ring is fully nested inside another (e.g. an
  // inner island's outline sitting inside a surrounding part's outline, or a
  // smaller rectangle inside a larger one), the INNER ring must be profiled free
  // BEFORE the outer one — otherwise cutting the outer ring first frees the
  // surrounding stock and the still-attached inner piece can wander while its own
  // perimeter is being cut. Reorder the rings inside-out (children before parents)
  // via the shared containment-tree ordering; siblings stay nearest-neighbour so
  // travel is unchanged where there is no nesting. Both the optional area-clear
  // (3a) and the perimeter profile (3b) iterate this same reordered array, so the
  // clearing and the freeing cuts agree on the inside-out sequence.
  if (cutRings.length > 1) {
    const order = orderLoopsInsideOut(cutRings);
    const reordered = order.map((i) => cutRings[i]);
    cutRings.length = 0;
    cutRings.push(...reordered);
  }

  // 3. Depth levels + tabs.
  const tp = new Toolpath();
  tp.name = params.shape === 'rect' ? 'Cutout (rectangle)' : 'Cutout (part outline)';
  const safeZ = hm.zTop > 0 ? hm.zTop + 1 : 1; // positive retract; emitter enforces its own safe-Z too
  const stepdown = params.cutStepdownMm > 0 ? params.cutStepdownMm : stock;
  const breakThrough = Math.max(0, params.breakThroughMm);
  const finalZ = -(stock + breakThrough);
  const tabHeight = Math.max(0, Math.min(params.tabs.heightMm, stock));
  const tabTopZ = -(stock - tabHeight);

  const levels: number[] = [];
  let z = -stepdown;
  while (z > finalZ + 1e-6) {
    levels.push(z);
    z -= stepdown;
  }
  levels.push(finalZ);

  // 3a. Optional area-clear (pocket) BEFORE the perimeter, so the freed part is
  //     left standing on a cleared floor. Keep-out = the part outline grown
  //     outward by the tool radius (tool edge must clear the part).
  //
  //     Field-clearing only makes sense for the RECTANGLE shape, where there is a
  //     well-defined empty rectangular field around the part to flatten. For the
  //     'outline' shape the cut already hugs the part perimeter (there is no field
  //     between the boundary and the part), so clearing is a no-op by design — the
  //     panel keeps clearAround off there; we additionally guard it here so an old
  //     saved 'outline' job with clearAround set can't error or emit stray moves.
  if (params.clearAround && params.shape === 'rect') {
    const keepOuts = outlines
      .map((o) => (radius > 1e-6 ? offsetPolygon(o, radius) : o.clone()))
      .filter((k) => k.points.length >= 3);
    const stepover = Math.max(radius, 0.5); // ~ tool diameter would be 2*radius; half-overlap
    const tanRamp = Math.tan((Math.max(1, Math.min(30, params.rampAngleDeg ?? 3)) * Math.PI) / 180);
    const maxStraightMm = Math.max(0, params.maxStraightPlungeMm ?? 0.5);
    // The clear boundary is the cut ring inset by the tool radius so the cleared
    // region stays inside the profile cut (the perimeter takes the outer edge).
    for (const ring of cutRings) {
      const clearBoundary = radius > 1e-6 ? offsetPolygon(ring, -radius) : ring.clone();
      if (clearBoundary.points.length < 3) continue;
      for (const level of levels) {
        // Each level's field was cleared one stepdown above (or the stock top for
        // the first level), so the span-entry ramp descends from there — never a
        // deep straight plunge.
        const startZ = Math.min(0, level + stepdown);
        emitClearLevel(tp, clearBoundary, keepOuts, level, safeZ, radius, stepover, {
          startZ,
          tanRamp,
          maxStraightMm,
        });
      }
    }
  }

  // 3b. Perimeter profile with tabs.
  const ctx: ProfileCtx = {
    tp,
    safeZ,
    levels,
    tabTopZ,
    tabsCount: params.tabs.count,
    tabsLengthMm: params.tabs.lengthMm,
    topZ: 0, // stock top = work Z 0 (relief convention); ramps descend from here
    rampAngleDeg: params.rampAngleDeg ?? 3,
    maxStraightPlungeMm: params.maxStraightPlungeMm ?? 0.5,
  };
  let anyTabs = false;
  for (const ring of cutRings) {
    if (emitProfileRing(ring, ctx)) anyTabs = true;
  }

  if (params.tabs.count > 0 && params.tabs.lengthMm > 0 && tabHeight > 0 && !anyTabs) {
    warnings.push(
      'Cutout: tabs were requested but no pass was deep enough to need them (check stock thickness vs tab height).',
    );
  }

  if (tp.isEmpty()) return result;
  result.toolpath = tp;
  return result;
}
