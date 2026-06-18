// V-carving (variable-depth from the vector MEDIAL AXIS) — UI-independent, pure
// TS (no DOM/React). Roadmap bet C1 (+ C3 flat-bit cleanup).
//
// A V-bit cuts a V-shaped groove: the wider the groove, the deeper the tip must
// go (depth = halfWidth / tan(tipHalfAngle)). To engrave a CRISP sign/letter/logo
// from closed vector contours we therefore:
//
//   1) RASTERIZE the filled region (even-odd rule, so counters/holes are empty),
//      mirroring core/centerline.ts. Cell size scales with the region size so a
//      stroke is several pixels across.
//   2) Compute a EUCLIDEAN DISTANCE TRANSFORM (EDT): every inside pixel learns
//      its distance (in mm) to the NEAREST edge (outer boundary OR a hole). This
//      distance is exactly the local half-width of the shape at that point.
//   3) THIN the region to its 1-px MEDIAL AXIS (skeleton) with Zhang-Suen — the
//      ridge of the distance field, i.e. the centreline of every stroke, with
//      holes preserved. Prune thinning spurs.
//   4) For each medial pixel set  Z = min(maxDepth, dist / tan(tipHalfAngle)).
//      The cut is SHARP/zero at thin tips (dist→0) and DEEPEST at wide centres.
//      A flat-tip V-bit (tip ⌀ > 0) only starts cutting once dist exceeds the tip
//      radius, so we subtract the tip radius before dividing (clamped at 0).
//   5) TRACE the skeleton into ordered polylines and emit a 3D toolpath that
//      follows them with varying Z, multi-depth (stepdown) if the depth is large.
//
// HOLES/COUNTERS: even-odd rasterization makes a counter (inside of an 'O') empty,
// so the EDT measures distance to BOTH the outer boundary and the hole boundary —
// the medial axis runs midway between them and the depth never exceeds what fits
// between the two walls. Islands (Relief-style) are handled the same way: only
// the filled band is carved.
//
// FLAT-BIT CLEANUP (C3): a V-bit physically can't reach maxDepth in regions wider
// than 2·maxDepth·tan(half) (its tip bottoms out as a flat at maxDepth). Those
// wide interiors are cleared with a flat endmill at maxDepth via an even-odd
// scanline over the "too-wide" region (region eroded by the V-reachable radius).

import { Polyline, kEpsilon } from './geometry';
import { Toolpath } from './toolpath';

export interface VCarveParams {
  /** Full included tip angle of the V-bit (deg). 60/90 are common. */
  vBitAngleDeg: number;
  /** Flat tip diameter of the V-bit (mm). 0 = perfectly sharp point. */
  vTipDiameterMm: number;
  /** Hard depth clamp (mm, >0). The groove never goes deeper than this. */
  maxDepthMm: number;
  /** Top surface Z of the stock (mm). Cuts go downward from here. */
  surfaceZ: number;
  /** Safe retract Z (mm). */
  safeZ: number;
  /** Max depth removed per pass (mm); <=0 → one full-depth pass. */
  stepdownMm: number;
  /** Carving feed (mm/min). */
  feedXY: number;
  /** Plunge feed (mm/min). */
  feedZ: number;
  /** Raster cells on the long axis (perf cap). Default 900. */
  maxCells?: number;
  // ---- optional flat-bit cleanup (C3) ----
  /** Run a flat-endmill clearance pass for areas the V-bit can't bottom. */
  cleanup?: boolean;
  /** Flat cleanup tool diameter (mm). */
  cleanupToolMm?: number;
  /** Cleanup stepover as a fraction of the cleanup tool ⌀ (0..1). */
  cleanupStepoverFrac?: number;
}

export interface VCarveResult {
  /** Combined V-carve (+ optional cleanup) toolpath. */
  toolpath: Toolpath;
  /** Number of medial-axis paths emitted. */
  pathCount: number;
  /** Total cut segments (feed/plunge moves). */
  segmentCount: number;
  /** Deepest Z reached below the surface (mm, positive number). */
  maxReachedDepthMm: number;
  /** True when some regions were too wide for the V-bit to bottom out. */
  cleanupNeeded: boolean;
  /** Non-fatal notes for the UI. */
  warnings: string[];
}

const NB8: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

/** Even-odd inside test over a flat set of closed contour edges. */
function insideEvenOdd(contours: Polyline[], x: number, y: number): boolean {
  let inside = false;
  for (const c of contours) {
    const n = c.points.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = c.points[i];
      const pj = c.points[j];
      if (pi.y > y !== pj.y > y) {
        const xCross = ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
        if (x < xCross) inside = !inside;
      }
    }
  }
  return inside;
}

function boundsOf(contours: Polyline[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of contours) for (const p of c.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

// ---------------------------------------------------------------------------
// Exact Euclidean Distance Transform (Felzenszwalb & Huttenlocher, 1D-pass).
// `f` holds 0 for inside (foreground) and +∞ for outside (background); we want,
// for every inside cell, the distance to the nearest OUTSIDE cell. We seed the
// background as the zero set and run the squared-EDT, returning sqrt in CELLS.
// ---------------------------------------------------------------------------
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    d[q] = dq * dq + f[v[k]];
  }
}

/** Squared EDT to nearest BACKGROUND (grid===0) cell; returns distance in CELLS. */
function distanceTransform(grid: Uint8Array, cols: number, rows: number): Float64Array {
  const INF = 1e20;
  const sq = new Float64Array(cols * rows);
  // Seed: foreground (inside) = INF, background (edge/outside) = 0.
  for (let i = 0; i < cols * rows; i++) sq[i] = grid[i] ? INF : 0;

  const maxDim = Math.max(cols, rows);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);

  // Columns.
  for (let x = 0; x < cols; x++) {
    for (let y = 0; y < rows; y++) f[y] = sq[y * cols + x];
    edt1d(f, rows, d, v, z);
    for (let y = 0; y < rows; y++) sq[y * cols + x] = d[y];
  }
  // Rows.
  for (let y = 0; y < rows; y++) {
    const base = y * cols;
    for (let x = 0; x < cols; x++) f[x] = sq[base + x];
    edt1d(f, cols, d, v, z);
    for (let x = 0; x < cols; x++) sq[base + x] = d[x];
  }
  const out = new Float64Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) out[i] = Math.sqrt(sq[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Zhang-Suen thinning → 1-px skeleton (medial axis). Same algorithm as
// core/centerline.ts (kept local to keep that module's exports private).
// ---------------------------------------------------------------------------
function zhangSuenThin(grid: Uint8Array, cols: number, rows: number): void {
  const at = (x: number, y: number) => y * cols + x;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : grid[at(x, y)]);
  const toClear: number[] = [];
  let changed = true;
  let guard = 0;
  const maxIter = cols + rows + 64;
  while (changed && guard++ < maxIter) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toClear.length = 0;
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[at(x, y)] === 0) continue;
          const p2 = get(x, y - 1), p3 = get(x + 1, y - 1), p4 = get(x + 1, y), p5 = get(x + 1, y + 1);
          const p6 = get(x, y + 1), p7 = get(x - 1, y + 1), p8 = get(x - 1, y), p9 = get(x - 1, y - 1);
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let A = 0;
          for (let i = 0; i < 8; i++) if (seq[i] === 0 && seq[i + 1] === 1) A++;
          if (A !== 1) continue;
          if (step === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toClear.push(at(x, y));
        }
      }
      if (toClear.length) {
        for (const idx of toClear) grid[idx] = 0;
        changed = true;
      }
    }
  }
}

/** Prune short spur branches off the skeleton (thinning hair). */
function pruneSpurs(grid: Uint8Array, cols: number, rows: number, maxLen: number): void {
  const at = (x: number, y: number) => y * cols + x;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && grid[at(x, y)] === 1;
  const deg = (x: number, y: number) => {
    let d = 0;
    for (const [dx, dy] of NB8) if (on(x + dx, y + dy)) d++;
    return d;
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < maxLen + 2) {
    changed = false;
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[at(x, y)] !== 1 || deg(x, y) !== 1) continue;
        const path: [number, number][] = [[x, y]];
        let cx = x, cy = y, prevX = -1, prevY = -1, reachedJunction = false;
        for (let step = 0; step < maxLen; step++) {
          let nx = -1, ny = -1;
          for (const [dx, dy] of NB8) {
            const tx = cx + dx, ty = cy + dy;
            if (!on(tx, ty) || (tx === prevX && ty === prevY)) continue;
            nx = tx; ny = ty; break;
          }
          if (nx < 0) break;
          if (deg(nx, ny) >= 3) { reachedJunction = true; break; }
          path.push([nx, ny]);
          prevX = cx; prevY = cy; cx = nx; cy = ny;
          if (deg(cx, cy) === 1) break;
        }
        if (reachedJunction) {
          for (const [px, py] of path) grid[at(px, py)] = 0;
          changed = true;
        }
      }
    }
  }
}

interface PixPt { x: number; y: number }

/** Trace a 1-px skeleton into ordered pixel polylines (greedy straightest walk). */
function traceSkeleton(grid: Uint8Array, cols: number, rows: number, minRun: number): PixPt[][] {
  const at = (x: number, y: number) => y * cols + x;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && grid[at(x, y)] === 1;
  const degree = (x: number, y: number) => {
    let d = 0;
    for (const [dx, dy] of NB8) if (on(x + dx, y + dy)) d++;
    return d;
  };
  const used = new Set<number>();
  const span = cols * rows;
  const edgeKey = (ax: number, ay: number, bx: number, by: number) => {
    const a = at(ax, ay), b = at(bx, by);
    return Math.min(a, b) * span + Math.max(a, b);
  };
  const segs: PixPt[][] = [];
  const walkFrom = (sx: number, sy: number): PixPt[] => {
    let cx = sx, cy = sy, hx = 0, hy = 0;
    const path: PixPt[] = [{ x: cx, y: cy }];
    for (;;) {
      let bestX = -1, bestY = -1, bestScore = -Infinity;
      for (const [dx, dy] of NB8) {
        const tx = cx + dx, ty = cy + dy;
        if (!on(tx, ty) || used.has(edgeKey(cx, cy, tx, ty))) continue;
        const len = Math.hypot(dx, dy);
        const score = hx === 0 && hy === 0 ? 0 : (dx * hx + dy * hy) / len;
        if (score > bestScore) { bestScore = score; bestX = tx; bestY = ty; }
      }
      if (bestX < 0) break;
      used.add(edgeKey(cx, cy, bestX, bestY));
      hx = bestX - cx; hy = bestY - cy;
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl; hy /= hl;
      path.push({ x: bestX, y: bestY });
      cx = bestX; cy = bestY;
    }
    return path;
  };
  const hasUnusedEdge = (x: number, y: number) => {
    for (const [dx, dy] of NB8) if (on(x + dx, y + dy) && !used.has(edgeKey(x, y, x + dx, y + dy))) return true;
    return false;
  };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[at(x, y)] !== 1 || degree(x, y) === 2) continue;
    let guard = 0;
    while (hasUnusedEdge(x, y) && guard++ < 16) {
      const p = walkFrom(x, y);
      if (p.length >= minRun) segs.push(p);
    }
  }
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    if (grid[at(x, y)] !== 1 || !hasUnusedEdge(x, y)) continue;
    const p = walkFrom(x, y);
    if (p.length >= minRun) segs.push(p);
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Bilinear sample of the (cell-unit) distance field at a fractional pixel coord.
// ---------------------------------------------------------------------------
function sampleDist(dist: Float64Array, cols: number, rows: number, px: number, py: number): number {
  const x0 = Math.max(0, Math.min(cols - 1, Math.floor(px)));
  const y0 = Math.max(0, Math.min(rows - 1, Math.floor(py)));
  const x1 = Math.min(cols - 1, x0 + 1);
  const y1 = Math.min(rows - 1, y0 + 1);
  const fx = px - x0;
  const fy = py - y0;
  const d00 = dist[y0 * cols + x0];
  const d10 = dist[y0 * cols + x1];
  const d01 = dist[y1 * cols + x0];
  const d11 = dist[y1 * cols + x1];
  return (d00 * (1 - fx) + d10 * fx) * (1 - fy) + (d01 * (1 - fx) + d11 * fx) * fy;
}

interface MedialNode {
  x: number; // mm
  y: number; // mm
  depth: number; // commanded depth (mm, >=0) below surfaceZ at this point
}

/**
 * Build the medial-axis polylines (in mm) with a per-vertex carve DEPTH, plus
 * the bookkeeping the cleanup pass needs. Returns null on a degenerate region.
 */
function buildMedial(
  contours: Polyline[],
  p: VCarveParams,
): {
  paths: MedialNode[][];
  maxDepth: number;
  cleanupNeeded: boolean;
  cellMm: number;
  cols: number;
  rows: number;
  dist: Float64Array; // cells
  px2mmX: (px: number) => number;
  py2mmY: (py: number) => number;
  b: { minX: number; minY: number; maxX: number; maxY: number };
} | null {
  const closed = contours.filter((c) => c.points.length >= 3);
  if (closed.length === 0) return null;
  const b = boundsOf(closed);
  if (!b) return null;

  const wmm = b.maxX - b.minX;
  const hmm = b.maxY - b.minY;
  if (wmm < kEpsilon && hmm < kEpsilon) return null;

  const half = (Math.max(1, Math.min(179, p.vBitAngleDeg)) * Math.PI) / 360; // tipHalfAngle (rad)
  const tan = Math.tan(half) || kEpsilon;
  const tipR = Math.max(0, p.vTipDiameterMm / 2);
  const maxDepth = Math.max(kEpsilon, p.maxDepthMm);

  // Resolution: aim for a fine grid so the depth ramp is smooth. The deepest the
  // V-bit reaches sets the relevant half-width (maxDepth*tan + tipR); resolve a
  // few cells across that, clamped by the long-axis cell cap.
  const maxCells = Math.max(200, p.maxCells ?? 900);
  const reachHalfW = Math.max(0.1, maxDepth * tan + tipR);
  let cell = reachHalfW / 8;
  const longMm = Math.max(wmm, hmm);
  if (longMm / cell > maxCells) cell = longMm / maxCells;
  if (!(cell > 0)) return null;

  const pad = 2;
  const cols = Math.ceil(wmm / cell) + 2 * pad + 1;
  const rows = Math.ceil(hmm / cell) + 2 * pad + 1;
  if (cols < 3 || rows < 3 || cols * rows > 6_000_000) return null;

  const px2mmX = (px: number) => b.minX + (px - pad + 0.5) * cell;
  const py2mmY = (py: number) => b.maxY - (py - pad + 0.5) * cell;

  // Rasterize (even-odd) — holes/counters drop out automatically.
  const grid = new Uint8Array(cols * rows);
  const at = (x: number, y: number) => y * cols + x;
  for (let y = 0; y < rows; y++) {
    const my = py2mmY(y);
    for (let x = 0; x < cols; x++) {
      if (insideEvenOdd(closed, px2mmX(x), my)) grid[at(x, y)] = 1;
    }
  }

  // Distance transform on the FILLED region (distance to nearest edge, in cells).
  const dist = distanceTransform(grid, cols, rows);

  // Skeleton (medial axis). Zhang-Suen thinning traces stroke-like regions well,
  // but on a CONVEX BLOB (e.g. a solid square) it collapses to a single centroid
  // pixel — losing the ridge. So we ALSO mark the distance-field RIDGE pixels
  // (local maxima of the distance transform) and union them in, which gives a
  // robust medial ridge for blobs while the thinning keeps thin strokes clean.
  const skel = grid.slice();
  zhangSuenThin(skel, cols, rows);
  markRidges(skel, dist, grid, cols, rows);
  // Re-thin the union so the added ridge band is 1-px wide, then prune hair.
  zhangSuenThin(skel, cols, rows);
  const spurPx = Math.max(2, Math.round(reachHalfW / cell));
  pruneSpurs(skel, cols, rows, spurPx);

  // Trace skeleton → pixel polylines, then map to mm with a per-vertex depth.
  const minRun = 2;
  const segs = traceSkeleton(skel, cols, rows, minRun);

  // The V-bit can only physically bottom out where the local half-width is small
  // enough; a region wider than maxDepth*tan + tipR needs the flat cleanup pass.
  // Decide this GLOBALLY from the distance field (any inside cell deeper than the
  // V-reach), so it's reported even when the skeleton over a wide blob degenerates.
  const reachCells = reachHalfW / cell;
  let cleanupNeeded = false;
  for (let i = 0; i < cols * rows && !cleanupNeeded; i++) {
    if (grid[i] && dist[i] > reachCells + 1) cleanupNeeded = true;
  }
  let observedMax = 0;

  const depthAt = (distCells: number): number => {
    const distMm = distCells * cell;
    // A flat-tip V-bit only deepens past the tip radius; subtract it (clamped).
    const eff = Math.max(0, distMm - tipR);
    let z = Math.min(maxDepth, eff / tan);
    if (z > observedMax) observedMax = z;
    return z;
  };

  const minSegMm = reachHalfW * 0.5;
  const paths: MedialNode[][] = [];
  for (const seg of segs) {
    if (seg.length < 2) continue;
    // Drop residual specks shorter than ~half a stroke width.
    let L = 0;
    for (let i = 1; i < seg.length; i++) L += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
    if (L * cell < minSegMm) continue;
    const out: MedialNode[] = [];
    for (const pix of seg) {
      const d = sampleDist(dist, cols, rows, pix.x, pix.y);
      out.push({ x: px2mmX(pix.x), y: py2mmY(pix.y), depth: depthAt(d) });
    }
    // Light simplification keyed on XY only (keep all depth detail at vertices).
    paths.push(simplifyMedial(out, cell * 0.4));
  }

  return { paths, maxDepth: observedMax, cleanupNeeded, cellMm: cell, cols, rows, dist, px2mmX, py2mmY, b };
}

/**
 * Mark distance-transform RIDGE pixels into `skel` (set to 1). A ridge pixel is
 * an inside pixel whose distance is a local maximum: it is >= all its 8-neighbour
 * distances (with a tiny bias so plateaus aren't all dropped). This recovers the
 * medial axis of convex blobs that morphological thinning collapses to a point.
 * Only pixels meaningfully away from the edge (>1.5 cells) qualify, so the outer
 * boundary isn't marked.
 */
function markRidges(
  skel: Uint8Array,
  dist: Float64Array,
  grid: Uint8Array,
  cols: number,
  rows: number,
): void {
  const at = (x: number, y: number) => y * cols + x;
  for (let y = 1; y < rows - 1; y++) {
    for (let x = 1; x < cols - 1; x++) {
      const i = at(x, y);
      if (!grid[i]) continue;
      const d = dist[i];
      if (d <= 1.5) continue; // too close to an edge to be a ridge
      let isMax = true;
      for (const [dx, dy] of NB8) {
        if (dist[at(x + dx, y + dy)] > d + 1e-6) { isMax = false; break; }
      }
      if (isMax) skel[i] = 1;
    }
  }
}

/** RDP simplify on the XY of a medial path, preserving each kept node's depth. */
function simplifyMedial(pts: MedialNode[], tol: number): MedialNode[] {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1, idx = -1;
    const a = pts[lo], bpt = pts[hi];
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], a, bpt);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out: MedialNode[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

function perpDist(p: MedialNode, a: MedialNode, b: MedialNode): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < kEpsilon) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------------------------------------------------------------------------
// Flat-endmill cleanup (C3): clear the interior that the V-bit can't bottom out.
// That is the region eroded inward by `reachHalfW` (distance > reachHalfW), cut
// FLAT at maxDepth with a boustrophedon even-odd scanline (the tool radius keeps
// it inside the too-wide zone). Reuses the same raster distance field.
// ---------------------------------------------------------------------------
function buildCleanup(
  m: NonNullable<ReturnType<typeof buildMedial>>,
  p: VCarveParams,
  half: number,
): { tp: Toolpath; segments: number } {
  const tp = new Toolpath();
  tp.name = 'V-carve cleanup';
  const tan = Math.tan(half) || kEpsilon;
  const tipR = Math.max(0, p.vTipDiameterMm / 2);
  const reachHalfW = Math.max(0.1, p.maxDepthMm * tan + tipR); // mm
  const reachCells = reachHalfW / m.cellMm;
  const toolMm = Math.max(0.2, p.cleanupToolMm ?? 3.175);
  const toolR = toolMm / 2;
  const pitch = Math.max(kEpsilon, p.cleanupStepoverFrac ?? 0.45) * toolMm;
  const floorZ = p.surfaceZ - p.maxDepthMm;
  // Multi-depth Z levels (descending) so the flat endmill steps down by `stepdownMm`
  // instead of one aggressive full-depth plunge into wide/deep regions.
  const cleanupLevels: number[] = [];
  if (p.stepdownMm > 0 && p.maxDepthMm > p.stepdownMm + kEpsilon) {
    for (let d = p.stepdownMm; d < p.maxDepthMm - kEpsilon; d += p.stepdownMm)
      cleanupLevels.push(p.surfaceZ - d);
  }
  cleanupLevels.push(floorZ);

  // A pixel is in the "too-wide" zone when its distance-to-edge exceeds the
  // V-reach; the FLAT tool must additionally stay toolR inside that zone, so a
  // valid centre needs dist > reachHalfW + toolR.
  const minCenterCells = reachCells + toolR / m.cellMm;
  const { cols, rows, dist, px2mmX, py2mmY } = m;

  let segments = 0;
  const pitchRows = Math.max(1, Math.round(pitch / m.cellMm));
  let rowIdx = 0;
  for (let py = 0; py < rows; py += pitchRows, rowIdx++) {
    // Collect inside spans on this raster row (contiguous runs of valid centres).
    const runs: { x0: number; x1: number }[] = [];
    let start = -1;
    for (let px = 0; px < cols; px++) {
      const ok = dist[py * cols + px] > minCenterCells;
      if (ok && start < 0) start = px;
      if ((!ok || px === cols - 1) && start >= 0) {
        const end = ok ? px : px - 1;
        if (end > start) runs.push({ x0: start, x1: end });
        start = -1;
      }
    }
    if (runs.length === 0) continue;
    const y = py2mmY(py);
    const ltr = rowIdx % 2 === 0;
    const ordered = ltr ? runs : runs.slice().reverse();
    for (const run of ordered) {
      const ax = px2mmX(ltr ? run.x0 : run.x1);
      const bx = px2mmX(ltr ? run.x1 : run.x0);
      tp.rapid({ x: ax, y, z: p.safeZ });
      // Step the flat tool down through the levels, feeding back and forth so it
      // never plunges the full depth at once.
      let curX = ax;
      for (const z of cleanupLevels) {
        tp.plunge({ x: curX, y, z });
        const toX = curX === ax ? bx : ax;
        tp.feed({ x: toX, y, z });
        curX = toX;
        segments += 1;
      }
      tp.rapid({ x: curX, y, z: p.safeZ });
    }
  }
  return { tp, segments };
}

/**
 * Generate a V-carve toolpath from CLOSED vector contours. The depth at each
 * medial-axis point is  min(maxDepth, (dist − tipR) / tan(tipHalfAngle)),
 * producing crisp sharp tips and deep wide centres. Holes/counters are respected
 * via even-odd rasterization. An optional flat-endmill cleanup pass clears wide
 * interiors the V-bit can't bottom out.
 */
export function vCarveContours(contours: Polyline[], params: VCarveParams): VCarveResult {
  const warnings: string[] = [];
  const empty: VCarveResult = {
    toolpath: new Toolpath(),
    pathCount: 0,
    segmentCount: 0,
    maxReachedDepthMm: 0,
    cleanupNeeded: false,
    warnings,
  };

  const m = buildMedial(contours, params);
  if (!m) {
    warnings.push('No closed region to V-carve.');
    return { ...empty, warnings };
  }
  // A wide convex region can have NO V-groove ridge (the medial axis collapses to
  // a point) yet still need clearing — only bail when there's truly nothing to do.
  if (m.paths.length === 0 && !(params.cleanup && m.cleanupNeeded)) {
    return {
      ...empty,
      cleanupNeeded: m.cleanupNeeded,
      warnings: m.cleanupNeeded
        ? ['Area is wider than the V-bit can reach at max depth — enable flat-bit cleanup to clear it.']
        : warnings,
    };
  }

  const half = (Math.max(1, Math.min(179, params.vBitAngleDeg)) * Math.PI) / 360;
  const tp = new Toolpath();
  tp.name = 'V-carve';
  const floorZ = params.surfaceZ - params.maxDepthMm;
  const stepdown = params.stepdownMm;

  // Multi-depth: cap each pass's commanded depth at successive stepdown floors so
  // a deep groove is removed in safe layers. The FINAL pass uses the true ramp.
  const passFloors: number[] = [];
  if (stepdown > 0 && m.maxDepth > stepdown + kEpsilon) {
    for (let d = stepdown; d < m.maxDepth - kEpsilon; d += stepdown) passFloors.push(d);
  }
  passFloors.push(m.maxDepth); // last = full ramp (clamped per-node anyway)

  let segments = 0;
  for (let pass = 0; pass < passFloors.length; pass++) {
    const cap = passFloors[pass];
    for (const path of m.paths) {
      if (path.length < 2) continue;
      const z0 = params.surfaceZ - Math.min(path[0].depth, cap);
      tp.rapid({ x: path[0].x, y: path[0].y, z: params.safeZ });
      tp.plunge({ x: path[0].x, y: path[0].y, z: z0 });
      for (let i = 1; i < path.length; i++) {
        const z = params.surfaceZ - Math.min(path[i].depth, cap);
        tp.feed({ x: path[i].x, y: path[i].y, z });
        segments++;
      }
      const end = path[path.length - 1];
      tp.rapid({ x: end.x, y: end.y, z: params.safeZ });
    }
  }

  const cleanupNeeded = m.cleanupNeeded;
  let reachedDepth = m.maxDepth;
  if (params.cleanup && cleanupNeeded) {
    const cl = buildCleanup(m, params, half);
    for (const mv of cl.tp.moves) tp.moves.push(mv);
    segments += cl.segments;
    if (cl.segments > 0) reachedDepth = Math.max(reachedDepth, params.maxDepthMm);
    if (cl.segments === 0) warnings.push('Cleanup pass produced no moves (tool too large for the wide area).');
  } else if (cleanupNeeded && !params.cleanup) {
    warnings.push('Some areas are wider than the V-bit can reach at max depth — enable flat-bit cleanup to clear them.');
  }

  void floorZ;
  return {
    toolpath: tp,
    pathCount: m.paths.length,
    segmentCount: segments,
    maxReachedDepthMm: reachedDepth,
    cleanupNeeded,
    warnings,
  };
}
