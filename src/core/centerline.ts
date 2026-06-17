// Outline-glyph → single-stroke CENTERLINE extraction — UI-independent, pure TS.
//
// Stroke mode wants to draw ANY font (including TrueType/OpenType outline fonts)
// as single pen strokes. An outline font only gives us FILLED glyph regions
// (closed contours: outer rings + hole rings), not centerlines. This module
// derives a centerline by "averaging" the stroke width away:
//
//   1) RASTERIZE the filled region to a binary grid using the even-odd rule
//      (so counters/holes are correctly empty). Cell size is chosen from the
//      estimated stroke thickness so a stroke is several pixels wide.
//   2) THIN the bitmap to a 1-pixel skeleton with the Zhang-Suen algorithm
//      (a classic, robust morphological thinning). The skeleton is the medial
//      axis — the centerline of every stroke, with holes preserved.
//   3) TRACE the skeleton pixels back into polylines (follow 8-connected runs,
//      breaking at junctions/endpoints) and map pixel coords back to mm.
//
// The result is open Polylines in the SAME mm coordinate space as the input
// contours, so the Writing panel can style + emit them exactly like the built-in
// stroke font — but they follow the SELECTED font's real shapes.

import { Point, Polyline, kEpsilon } from './geometry';

export interface CenterlineOptions {
  /** Cap height (mm) of the text — used to pick a sensible raster resolution. */
  charHeightMm: number;
  /** Max grid cells on the long axis (perf cap). Default 1400. */
  maxCells?: number;
  /** Min pixel run length to keep a traced stroke (prunes specks). Default 2. */
  minRunPx?: number;
}

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

/** Tight bounds of a contour set. */
function boundsOf(contours: Polyline[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours) for (const p of c.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/**
 * Convert one or more CLOSED filled glyph contours (mm) into open centerline
 * Polylines (mm), by even-odd rasterization → Zhang-Suen thinning → tracing.
 * Holes (counters) are preserved; the centerline follows each stroke's medial
 * axis. Returns [] if the region is empty/degenerate.
 */
export function outlineContoursToCenterlines(
  contours: Polyline[],
  opts: CenterlineOptions,
): Polyline[] {
  const closed = contours.filter((c) => c.points.length >= 3);
  if (closed.length === 0) return [];
  const b = boundsOf(closed);
  if (!b) return [];

  const wmm = b.maxX - b.minX;
  const hmm = b.maxY - b.minY;
  if (wmm < kEpsilon && hmm < kEpsilon) return [];

  // Resolution: aim for ~6 px across a typical stroke. Estimate stroke width as a
  // fraction of cap height (~12%); cell = strokeWidth/6, clamped by a cell cap.
  const maxCells = Math.max(200, opts.maxCells ?? 1400);
  const strokeMm = Math.max(kEpsilon, opts.charHeightMm * 0.12);
  let cell = strokeMm / 6;
  const longMm = Math.max(wmm, hmm);
  if (longMm / cell > maxCells) cell = longMm / maxCells;
  if (!(cell > 0)) return [];

  // Pad the grid by a couple cells so border strokes thin cleanly.
  const pad = 2;
  const cols = Math.ceil(wmm / cell) + 2 * pad + 1;
  const rows = Math.ceil(hmm / cell) + 2 * pad + 1;
  if (cols < 3 || rows < 3 || cols * rows > 5_000_000) return [];

  // Pixel center (px,py) -> mm. Row 0 is the TOP (max y) so traced polylines
  // come out upright; we map back accordingly.
  const px2mmX = (px: number) => b.minX + (px - pad + 0.5) * cell;
  const py2mmY = (py: number) => b.maxY - (py - pad + 0.5) * cell;

  // ---- 1) Rasterize (even-odd) -----------------------------------------------
  const grid = new Uint8Array(cols * rows);
  const at = (x: number, y: number) => y * cols + x;
  for (let y = 0; y < rows; y++) {
    const my = py2mmY(y);
    for (let x = 0; x < cols; x++) {
      if (insideEvenOdd(closed, px2mmX(x), my)) grid[at(x, y)] = 1;
    }
  }

  // ---- 2) Zhang-Suen thinning, then staircase cleanup ------------------------
  zhangSuenThin(grid, cols, rows);
  removeStaircases(grid, cols, rows);

  // Prune short spur branches (thinning hair) up to ~1.4 stroke widths long, so
  // the real strokes/loops are left clean. strokeMm/cell ≈ pixels per stroke.
  const spurPx = Math.max(3, Math.round((strokeMm / cell) * 2.0));
  pruneSpurs(grid, cols, rows, spurPx);

  // ---- 3) Trace the 1-px skeleton into polylines -----------------------------
  const minRun = Math.max(1, opts.minRunPx ?? 2);
  const segments = traceSkeleton(grid, cols, rows, minRun);

  // Map pixel polylines to mm. Drop residual specks shorter than ~1 stroke width
  // (leftover thinning hair). Isolated round marks (i/j tittles, periods) are
  // ~1 stroke across so they sit at this threshold; we keep a short isolated
  // piece if it is the sole trace of a self-contained blob (handled below by the
  // isolated check) so dots survive while spurs off real strokes are removed.
  const minSegMm = strokeMm * 1.0;
  const out: Polyline[] = [];
  for (const seg of segments) {
    if (seg.length < 2) continue;
    let L = 0;
    for (let i = 1; i < seg.length; i++) L += Math.hypot(seg[i].x - seg[i - 1].x, seg[i].y - seg[i - 1].y);
    if (L * cell < minSegMm) continue;
    const pl = new Polyline();
    for (const p of seg) pl.add({ x: px2mmX(p.x), y: py2mmY(p.y) });
    // Light simplification so we don't emit a vertex per pixel.
    out.push(simplify(pl, cell * 0.4));
  }
  return out;
}

// ----------------------------------------------------------------------------
// Zhang-Suen thinning. Iteratively peels boundary pixels until a 1-px skeleton
// remains, preserving connectivity. Operates in place on `grid` (0/1).
// ----------------------------------------------------------------------------
function zhangSuenThin(grid: Uint8Array, cols: number, rows: number): void {
  const at = (x: number, y: number) => y * cols + x;
  const get = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : grid[at(x, y)]);
  const toClear: number[] = [];
  let changed = true;
  let guard = 0;
  const maxIter = cols + rows + 64; // safety cap

  while (changed && guard++ < maxIter) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      toClear.length = 0;
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < cols - 1; x++) {
          if (grid[at(x, y)] === 0) continue;
          const p2 = get(x, y - 1);
          const p3 = get(x + 1, y - 1);
          const p4 = get(x + 1, y);
          const p5 = get(x + 1, y + 1);
          const p6 = get(x, y + 1);
          const p7 = get(x - 1, y + 1);
          const p8 = get(x - 1, y);
          const p9 = get(x - 1, y - 1);

          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;

          // A = number of 0->1 transitions in the ordered ring p2..p9,p2
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

// ----------------------------------------------------------------------------
// Staircase / redundant-pixel removal. Zhang-Suen can leave 2-pixel-wide
// diagonal "staircases" (filled 2x2 corners) that spawn spurious junctions and
// fragment tracing. We delete a pixel when it sits in a filled 2x2 block AND its
// removal keeps its 8-neighbourhood connected (so we never break a stroke). This
// collapses staircases to a clean 1-px diagonal.
// ----------------------------------------------------------------------------
function removeStaircases(grid: Uint8Array, cols: number, rows: number): void {
  const at = (x: number, y: number) => y * cols + x;
  const g = (x: number, y: number) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : grid[at(x, y)]);
  // Connectivity number (Yokoi-style): # of distinct 8-connected components in
  // the neighbourhood ring. If removing P keeps the ring as one component, P is
  // redundant for connectivity.
  const ringConnected = (x: number, y: number): boolean => {
    const r = [
      g(x + 1, y), g(x + 1, y - 1), g(x, y - 1), g(x - 1, y - 1),
      g(x - 1, y), g(x - 1, y + 1), g(x, y + 1), g(x + 1, y + 1),
    ];
    let transitions = 0;
    for (let i = 0; i < 8; i++) if (r[i] === 0 && r[(i + 1) % 8] === 1) transitions++;
    return transitions === 1; // exactly one run of set pixels => removal safe
  };
  let changed = true;
  let guard = 0;
  while (changed && guard++ < 8) {
    changed = false;
    const clear: number[] = [];
    for (let y = 1; y < rows - 1; y++) {
      for (let x = 1; x < cols - 1; x++) {
        if (grid[at(x, y)] === 0) continue;
        // In a filled 2x2 block (P plus its E, S, SE neighbours all set)?
        const inBlock =
          (g(x + 1, y) && g(x, y + 1) && g(x + 1, y + 1)) ||
          (g(x - 1, y) && g(x, y + 1) && g(x - 1, y + 1)) ||
          (g(x + 1, y) && g(x, y - 1) && g(x + 1, y - 1)) ||
          (g(x - 1, y) && g(x, y - 1) && g(x - 1, y - 1));
        if (!inBlock) continue;
        if (ringConnected(x, y)) clear.push(at(x, y));
      }
    }
    if (clear.length) {
      // Clear in raster order but re-check connectivity at delete time so we
      // don't punch a hole when two block pixels both qualified.
      for (const idx of clear) {
        const x = idx % cols;
        const y = (idx / cols) | 0;
        if (grid[idx] === 1 && ringConnected(x, y)) {
          grid[idx] = 0;
          changed = true;
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Prune short spur branches: from every degree-1 endpoint, walk inward along
// degree-2 pixels; if a junction (degree>=3) is reached within `maxLen` steps,
// delete the walked spur (it is thinning hair, not a real stroke). Repeats until
// stable so layered hairs are fully removed.
// ----------------------------------------------------------------------------
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
        // Walk inward collecting the spur pixels until we hit a junction or end.
        const path: [number, number][] = [[x, y]];
        let cx = x;
        let cy = y;
        let prevX = -1;
        let prevY = -1;
        let reachedJunction = false;
        for (let step = 0; step < maxLen; step++) {
          let nx = -1;
          let ny = -1;
          for (const [dx, dy] of NB8) {
            const tx = cx + dx;
            const ty = cy + dy;
            if (!on(tx, ty)) continue;
            if (tx === prevX && ty === prevY) continue;
            nx = tx;
            ny = ty;
            break;
          }
          if (nx < 0) break;
          if (deg(nx, ny) >= 3) {
            reachedJunction = true;
            break;
          }
          path.push([nx, ny]);
          prevX = cx;
          prevY = cy;
          cx = nx;
          cy = ny;
          if (deg(cx, cy) === 1) break; // tiny isolated piece; leave it for the speck filter
        }
        if (reachedJunction) {
          for (const [px, py] of path) grid[at(px, py)] = 0;
          changed = true;
        }
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Trace a thinned (1-px) skeleton into ordered pixel polylines. We walk
// 8-connected runs, starting at endpoints/junctions, consuming each edge once.
// ----------------------------------------------------------------------------
const NB8: ReadonlyArray<[number, number]> = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];

function traceSkeleton(grid: Uint8Array, cols: number, rows: number, minRun: number): Point[][] {
  const at = (x: number, y: number) => y * cols + x;
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && grid[at(x, y)] === 1;
  const degree = (x: number, y: number) => {
    let d = 0;
    for (const [dx, dy] of NB8) if (on(x + dx, y + dy)) d++;
    return d;
  };
  // Track consumed undirected edges between adjacent skeleton pixels.
  const used = new Set<number>();
  const edgeKey = (ax: number, ay: number, bx: number, by: number) => {
    const a = at(ax, ay);
    const b = at(bx, by);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo * (cols * rows) + hi;
  };

  const segs: Point[][] = [];

  // Greedy-longest walk: from (sx,sy) follow unused edges, at each step preferring
  // the neighbour that best continues the current heading (smallest turn) so a
  // stroke is traced as ONE long run rather than many fragments. Stops only when
  // no unused incident edge remains.
  const walkFrom = (sx: number, sy: number): Point[] => {
    let cx = sx;
    let cy = sy;
    let hx = 0; // current heading
    let hy = 0;
    const path: Point[] = [{ x: cx, y: cy }];
    for (;;) {
      let bestX = -1;
      let bestY = -1;
      let bestScore = -Infinity;
      for (const [dx, dy] of NB8) {
        const tx = cx + dx;
        const ty = cy + dy;
        if (!on(tx, ty)) continue;
        if (used.has(edgeKey(cx, cy, tx, ty))) continue;
        // Prefer least turn (dot product with current heading); favour straight.
        const len = Math.hypot(dx, dy);
        const score = hx === 0 && hy === 0 ? 0 : (dx * hx + dy * hy) / len;
        if (score > bestScore) {
          bestScore = score;
          bestX = tx;
          bestY = ty;
        }
      }
      if (bestX < 0) break;
      used.add(edgeKey(cx, cy, bestX, bestY));
      hx = bestX - cx;
      hy = bestY - cy;
      const hl = Math.hypot(hx, hy) || 1;
      hx /= hl;
      hy /= hl;
      path.push({ x: bestX, y: bestY });
      cx = bestX;
      cy = bestY;
    }
    return path;
  };

  const hasUnusedEdge = (x: number, y: number): boolean => {
    for (const [dx, dy] of NB8) {
      if (on(x + dx, y + dy) && !used.has(edgeKey(x, y, x + dx, y + dy))) return true;
    }
    return false;
  };

  // Pass 1: seed at endpoints/junctions (degree != 2) so open strokes trace fully.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[at(x, y)] !== 1) continue;
      if (degree(x, y) === 2) continue;
      let guard = 0;
      while (hasUnusedEdge(x, y) && guard++ < 16) {
        const p = walkFrom(x, y);
        if (p.length >= minRun) segs.push(p);
      }
    }
  }
  // Pass 2: remaining pure loops (all degree 2). Seed each once.
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (grid[at(x, y)] !== 1) continue;
      if (hasUnusedEdge(x, y)) {
        const p = walkFrom(x, y);
        if (p.length >= minRun) segs.push(p);
      }
    }
  }

  return segs;
}

// ----------------------------------------------------------------------------
// Ramer–Douglas–Peucker polyline simplification (keeps the shape, drops
// per-pixel vertices). Operates on an open polyline.
// ----------------------------------------------------------------------------
function simplify(pl: Polyline, tol: number): Polyline {
  const pts = pl.points;
  if (pts.length < 3) return pl;
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    const a = pts[lo];
    const bpt = pts[hi];
    for (let i = lo + 1; i < hi; i++) {
      const d = perpDist(pts[i], a, bpt);
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tol && idx > 0) {
      keep[idx] = 1;
      stack.push([lo, idx], [idx, hi]);
    }
  }
  const out = new Polyline();
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.add(pts[i]);
  return out;
}

function perpDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < kEpsilon) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}
