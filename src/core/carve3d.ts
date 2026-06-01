// 3D relief carving core — UI-independent, pure TypeScript.
// No React / DOM / three.js imports here (mirrors the Qt cadcam lib split).
//
// Turns a triangle-soup STL mesh into CNC carving toolpaths using the classic
// two-stage relief strategy:
//
//   1. Heightmap   rasterize the XY footprint at the tool stepover and, for each
//                  grid cell, find the mesh's highest surface Z reachable by the
//                  tool there (ball- or flat-end compensated, approximately).
//   2. Roughing    multi-level Z clearing in stepdown layers: at each Z level,
//                  raster-scan the footprint and cut a flat pass wherever the
//                  heightmap surface is below that level (bulk material removal).
//   3. Finishing   a parallel raster pass that rides the heightmap (Z = surface
//                  height at each XY) — the relief surface finish.
//
// This is intentionally a *basic* 3D carving generator (axis-aligned parallel
// raster, sampled heightmap, approximate tool compensation). It is robust: the
// raster resolution and triangle counts are hard-capped so a pathological mesh
// can never hang the UI.

import { Toolpath } from './toolpath';
import { Polyline } from './geometry';
import type { StlMesh } from './slicer';
import { STL_STRIDE } from './slicer';

// ---- Hard safety caps -------------------------------------------------------
/** Never sample a heightmap larger than this many cells (≈ 1.2k × 1.2k). */
export const MAX_HEIGHTMAP_CELLS = 1_500_000;
/** Clamp grid resolution per axis so passes never explode. */
export const MAX_GRID_DIM = 1200;
/** Refuse meshes above this triangle count for carving (heightmap build). */
export const MAX_CARVE_TRIANGLES = 1_500_000;

export type ToolType = 'ball' | 'flat';

/** All carving parameters the generator needs. Distances in mm, feeds mm/min. */
export interface Carve3DParams {
  toolDiameter: number; // mm
  toolType: ToolType; // ball-nose or flat-end
  stepover: number; // mm between adjacent raster lines (XY)
  stepdown: number; // mm depth per roughing level
  safeZ: number; // retract height above stock top (mm)
  maxDepth: number; // max material depth to remove below the top surface (mm)
  feedXY: number; // cutting feed (mm/min)
  feedZ: number; // plunge feed (mm/min)
  spindleRPM: number;
  doRoughing: boolean;
  doFinishing: boolean;
  /** Raster direction: 'x' scans rows along X, 'y' scans columns along Y. */
  finishDir: 'x' | 'y';
}

export function defaultCarve3DParams(overrides: Partial<Carve3DParams> = {}): Carve3DParams {
  return {
    toolDiameter: 3.175,
    toolType: 'ball',
    stepover: 0.5,
    stepdown: 1.0,
    safeZ: 5.0,
    maxDepth: 10.0,
    feedXY: 600,
    feedZ: 200,
    spindleRPM: 10000,
    doRoughing: true,
    doFinishing: true,
    finishDir: 'x',
    ...overrides,
  };
}

/**
 * A sampled top-surface heightmap over the mesh XY footprint. `z[iy*nx + ix]` is
 * the highest reachable surface Z at the centre of cell (ix, iy); cells with no
 * surface over them carry `floorZ` (the carve floor) so the tool can clear them.
 */
export interface Heightmap {
  nx: number;
  ny: number;
  /** World-space origin (min corner) and cell pitch (mm). */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  /** Top surface Z per cell (mm). Length nx*ny. */
  z: Float32Array;
  /** Mesh Z extents (mm). */
  zTop: number;
  zBottom: number;
  /** XY bounds (mm). */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  warnings: string[];
}

export interface CarveResult {
  toolpaths: Toolpath[];
  warnings: string[];
  /** Stats for the UI. */
  roughLevels: number;
  finishLines: number;
  gridX: number;
  gridY: number;
  heightmap: Heightmap | null;
}

// ----------------------------------------------------------------------------
// Heightmap construction
// ----------------------------------------------------------------------------

/**
 * Build a top-surface heightmap by rasterizing each triangle into the grid and
 * keeping the maximum Z per covered cell (Z-buffer style). Cells never touched
 * keep `floorZ`. This is O(triangles + coveredCells) and never iterates the
 * whole grid per triangle, so it scales with mesh detail rather than area².
 *
 * Tool-radius compensation is applied as a post-pass dilation of the height
 * field (ball/flat), so a finite tool can't dig past a peak it can't fit into.
 */
export function buildHeightmap(mesh: StlMesh, params: Carve3DParams): Heightmap {
  const warnings: string[] = [];
  const minX = mesh.bbox.min[0];
  const minY = mesh.bbox.min[1];
  const maxX = mesh.bbox.max[0];
  const maxY = mesh.bbox.max[1];
  const zTop = mesh.bbox.max[2];
  const zBottom = mesh.bbox.min[2];
  const floorZ = zTop - Math.max(0, params.maxDepth);

  if (mesh.triangleCount > MAX_CARVE_TRIANGLES) {
    warnings.push(
      `Mesh has ${mesh.triangleCount.toLocaleString()} triangles (cap ${MAX_CARVE_TRIANGLES.toLocaleString()}); carving refused.`,
    );
  }

  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  // Sample the surface finer than the stepover so the heightmap isn't blocky.
  // Use ~half the stepover (clamped) as the cell pitch.
  const pitch = Math.max(params.stepover * 0.5, 0.05);
  let nx = Math.max(2, Math.ceil(spanX / pitch) + 1);
  let ny = Math.max(2, Math.ceil(spanY / pitch) + 1);

  // Clamp per-axis and total cell budget so we never hang.
  if (nx > MAX_GRID_DIM || ny > MAX_GRID_DIM) {
    warnings.push(`Heightmap clamped to ${MAX_GRID_DIM}px/axis (model is large vs stepover).`);
    nx = Math.min(nx, MAX_GRID_DIM);
    ny = Math.min(ny, MAX_GRID_DIM);
  }
  if (nx * ny > MAX_HEIGHTMAP_CELLS) {
    const scale = Math.sqrt(MAX_HEIGHTMAP_CELLS / (nx * ny));
    nx = Math.max(2, Math.floor(nx * scale));
    ny = Math.max(2, Math.floor(ny * scale));
    warnings.push(`Heightmap downsampled to ${nx}×${ny} to stay within the cell budget.`);
  }

  const dx = spanX / (nx - 1);
  const dy = spanY / (ny - 1);
  const z = new Float32Array(nx * ny);
  z.fill(floorZ);

  if (mesh.triangleCount > 0 && mesh.triangleCount <= MAX_CARVE_TRIANGLES) {
    rasterizeTriangles(mesh, z, nx, ny, minX, minY, dx, dy, floorZ);
  }

  const hm: Heightmap = {
    nx,
    ny,
    x0: minX,
    y0: minY,
    dx,
    dy,
    z,
    zTop,
    zBottom,
    minX,
    minY,
    maxX,
    maxY,
    warnings,
  };

  // Compensate for the finite tool: a peak narrower than the tool can't be
  // reached at full height, so dilate the height field by the tool footprint.
  dilateForTool(hm, params);
  // Clamp everything to the carve floor (never go below maxDepth).
  for (let i = 0; i < z.length; i++) if (z[i] < floorZ) z[i] = floorZ;
  return hm;
}

/** Z-buffer rasterize: for each triangle, set covered cells to max(z). */
function rasterizeTriangles(
  mesh: StlMesh,
  z: Float32Array,
  nx: number,
  ny: number,
  minX: number,
  minY: number,
  dx: number,
  dy: number,
  floorZ: number,
): void {
  const tris = mesh.triangles;
  const stride3 = STL_STRIDE * 3;
  for (let o = 0; o < tris.length; o += stride3) {
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + STL_STRIDE], by = tris[o + STL_STRIDE + 1], bz = tris[o + STL_STRIDE + 2];
    const cx = tris[o + STL_STRIDE * 2], cy = tris[o + STL_STRIDE * 2 + 1], cz = tris[o + STL_STRIDE * 2 + 2];

    // Skip degenerate/below-floor triangles where it can't raise the surface.
    const triMaxZ = Math.max(az, bz, cz);
    if (triMaxZ <= floorZ) continue;

    // Triangle XY bounds → cell index range.
    const tMinX = Math.min(ax, bx, cx);
    const tMaxX = Math.max(ax, bx, cx);
    const tMinY = Math.min(ay, by, cy);
    const tMaxY = Math.max(ay, by, cy);

    let ix0 = Math.floor((tMinX - minX) / dx);
    let ix1 = Math.ceil((tMaxX - minX) / dx);
    let iy0 = Math.floor((tMinY - minY) / dy);
    let iy1 = Math.ceil((tMaxY - minY) / dy);
    if (ix0 < 0) ix0 = 0;
    if (iy0 < 0) iy0 = 0;
    if (ix1 > nx - 1) ix1 = nx - 1;
    if (iy1 > ny - 1) iy1 = ny - 1;
    if (ix1 < ix0 || iy1 < iy0) continue;

    // Barycentric setup for plane interpolation of Z over the triangle.
    const d00x = bx - ax, d00y = by - ay;
    const d01x = cx - ax, d01y = cy - ay;
    const denom = d00x * d01y - d01x * d00y;
    const flat = Math.abs(denom) < 1e-12; // vertical/degenerate triangle in XY

    for (let iy = iy0; iy <= iy1; iy++) {
      const py = minY + iy * dy;
      const rowBase = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + ix * dx;
        let zHere: number;
        if (flat) {
          // Degenerate XY projection — just use the triangle's max Z.
          zHere = triMaxZ;
        } else {
          const vpx = px - ax, vpy = py - ay;
          const u = (vpx * d01y - d01x * vpy) / denom;
          const v = (d00x * vpy - vpx * d00y) / denom;
          // Point-in-triangle with a small tolerance to avoid seams between
          // adjacent triangles dropping cells.
          const tol = 1e-6;
          if (u < -tol || v < -tol || u + v > 1 + tol) continue;
          zHere = az + u * (bz - az) + v * (cz - az);
        }
        const cell = rowBase + ix;
        if (zHere > z[cell]) z[cell] = zHere;
      }
    }
  }
}

/**
 * Dilate the height field by the tool footprint so a finite tool isn't allowed
 * to plunge into a feature narrower than itself. For a flat tool this is a max
 * over a disc of the tool radius; for a ball tool it's a max over the ball's
 * spherical lower surface (z raised by r - sqrt(r²-d²) within the radius). This
 * is the standard "morphological" tool-compensation of a heightmap.
 */
function dilateForTool(hm: Heightmap, params: Carve3DParams): void {
  const r = Math.max(0, params.toolDiameter / 2);
  if (r <= 1e-6) return;
  const { nx, ny, dx, dy, z } = hm;
  const rxCells = Math.min(Math.ceil(r / dx), 64);
  const ryCells = Math.min(Math.ceil(r / dy), 64);
  if (rxCells === 0 && ryCells === 0) return;

  // Precompute the structuring element (offsets + z-lift) once.
  const offsets: { ox: number; oy: number; lift: number }[] = [];
  for (let oy = -ryCells; oy <= ryCells; oy++) {
    const wy = oy * dy;
    for (let ox = -rxCells; ox <= rxCells; ox++) {
      const wx = ox * dx;
      const d2 = wx * wx + wy * wy;
      if (d2 > r * r) continue;
      let lift = 0;
      if (params.toolType === 'ball') {
        // Lower point of the ball at horizontal distance d sits r - sqrt(r²-d²)
        // above the ball tip. To keep the tip ON the surface, the centre must be
        // lifted by that amount when a neighbour cell is high.
        lift = r - Math.sqrt(Math.max(0, r * r - d2));
      }
      offsets.push({ ox, oy, lift });
    }
  }

  const src = z.slice();
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      let best = src[iy * nx + ix];
      for (const { ox, oy, lift } of offsets) {
        const jx = ix + ox;
        const jy = iy + oy;
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
        // The tool tip resting so it clears neighbour height (src) requires the
        // tip Z >= neighbourZ - lift (ball) i.e. tip raised by neighbourZ-lift.
        const need = src[jy * nx + jx] - lift;
        if (need > best) best = need;
      }
      z[iy * nx + ix] = best;
    }
  }
}

/** Bilinear sample of the heightmap at world (x, y), clamped to bounds. */
function sampleHeight(hm: Heightmap, x: number, y: number): number {
  const { nx, ny, dx, dy, x0, y0, z } = hm;
  let fx = (x - x0) / dx;
  let fy = (y - y0) / dy;
  if (fx < 0) fx = 0;
  else if (fx > nx - 1) fx = nx - 1;
  if (fy < 0) fy = 0;
  else if (fy > ny - 1) fy = ny - 1;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const ix1 = Math.min(ix + 1, nx - 1);
  const iy1 = Math.min(iy + 1, ny - 1);
  const tx = fx - ix;
  const ty = fy - iy;
  const z00 = z[iy * nx + ix];
  const z10 = z[iy * nx + ix1];
  const z01 = z[iy1 * nx + ix];
  const z11 = z[iy1 * nx + ix1];
  const a = z00 + (z10 - z00) * tx;
  const b = z01 + (z11 - z01) * tx;
  return a + (b - a) * ty;
}

// ----------------------------------------------------------------------------
// Toolpath generation
// ----------------------------------------------------------------------------

/**
 * Roughing: descend in stepdown layers from just under the top surface to the
 * carve floor. At each level, raster across the footprint and cut only the spans
 * whose surface height is BELOW the level (i.e. there's material to clear at this
 * Z). This bulk-removes stock above the relief in flat passes.
 */
function buildRoughing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; levels: number } {
  const tp = new Toolpath();
  tp.name = '3D Roughing';
  const step = Math.max(params.stepover, hm.dx, 0.1);
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);
  const safeZ = params.safeZ;

  // Descending Z levels (each a flat clearing plane).
  const stepdown = params.stepdown > 0 ? params.stepdown : Math.max(params.maxDepth, 0.1);
  const levels: number[] = [];
  let zL = hm.zTop - stepdown;
  while (zL > floorZ + 1e-6) {
    levels.push(zL);
    zL -= stepdown;
  }
  levels.push(floorZ);

  // Scan rows along X, alternating direction (zig-zag) for efficiency.
  const y0 = hm.minY;
  const y1 = hm.maxY;
  const x0 = hm.minX;
  const x1 = hm.maxX;
  const sampleStep = Math.max(hm.dx, step * 0.5, 0.1);

  for (const level of levels) {
    let flip = false;
    for (let y = y0; y <= y1 + 1e-9; y += step) {
      // Walk this scan-row left→right (or reversed) and emit cut spans where the
      // surface sits below `level` (material present above the relief at this Z).
      const xs: number[] = [];
      for (let x = x0; x <= x1 + 1e-9; x += sampleStep) xs.push(x);
      if (xs.length === 0 || xs[xs.length - 1] < x1) xs.push(x1);
      const ordered = flip ? xs.slice().reverse() : xs;

      let inCut = false;
      let runStart = 0;
      const flushRun = (endX: number) => {
        if (!inCut) return;
        // Cut from runStart→endX at `level`.
        tp.rapid({ x: runStart, y, z: safeZ });
        tp.plunge({ x: runStart, y, z: level });
        tp.feed({ x: endX, y, z: level });
        tp.rapid({ x: endX, y, z: safeZ });
        inCut = false;
      };
      let prevX = ordered[0];
      for (const x of ordered) {
        const surf = sampleHeight(hm, x, y);
        const material = surf > level + 1e-6; // surface above this level → clear it
        if (material && !inCut) {
          inCut = true;
          runStart = x;
        } else if (!material && inCut) {
          flushRun(prevX);
        }
        prevX = x;
      }
      flushRun(ordered[ordered.length - 1]);
      flip = !flip;
    }
  }

  return { tp, levels: levels.length };
}

/**
 * Finishing: a single parallel raster pass that rides the heightmap. The tool
 * stays down following Z = surface height across each scan line, lifting only at
 * row ends. This produces the relief surface finish.
 */
function buildFinishing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; lines: number } {
  const tp = new Toolpath();
  tp.name = '3D Finishing';
  const step = Math.max(params.stepover, 0.05);
  const safeZ = params.safeZ;
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);

  const sampleStep = Math.max(hm.dx, hm.dy, step * 0.5, 0.05);
  let lineCount = 0;

  const clampZ = (z: number) => (z < floorZ ? floorZ : z > hm.zTop ? hm.zTop : z);

  if (params.finishDir === 'x') {
    // Rows along X, stepping in Y.
    let flip = false;
    for (let y = hm.minY; y <= hm.maxY + 1e-9; y += step) {
      const xs: number[] = [];
      for (let x = hm.minX; x <= hm.maxX + 1e-9; x += sampleStep) xs.push(x);
      if (xs.length === 0 || xs[xs.length - 1] < hm.maxX) xs.push(hm.maxX);
      const ordered = flip ? xs.slice().reverse() : xs;
      emitFinishRow(tp, hm, ordered, y, true, safeZ, clampZ);
      lineCount++;
      flip = !flip;
    }
  } else {
    // Columns along Y, stepping in X.
    let flip = false;
    for (let x = hm.minX; x <= hm.maxX + 1e-9; x += step) {
      const ys: number[] = [];
      for (let y = hm.minY; y <= hm.maxY + 1e-9; y += sampleStep) ys.push(y);
      if (ys.length === 0 || ys[ys.length - 1] < hm.maxY) ys.push(hm.maxY);
      const ordered = flip ? ys.slice().reverse() : ys;
      emitFinishRow(tp, hm, ordered, x, false, safeZ, clampZ);
      lineCount++;
      flip = !flip;
    }
  }

  return { tp, lines: lineCount };
}

/** Emit one finishing scan line (constant Y if `alongX`, else constant X). */
function emitFinishRow(
  tp: Toolpath,
  hm: Heightmap,
  coords: number[],
  fixed: number,
  alongX: boolean,
  safeZ: number,
  clampZ: (z: number) => number,
): void {
  if (coords.length < 2) return;
  const at = (c: number) => (alongX ? { x: c, y: fixed } : { x: fixed, y: c });
  const first = at(coords[0]);
  const z0 = clampZ(sampleHeight(hm, first.x, first.y));
  tp.rapid({ x: first.x, y: first.y, z: safeZ });
  tp.plunge({ x: first.x, y: first.y, z: z0 });
  for (let i = 1; i < coords.length; i++) {
    const p = at(coords[i]);
    const z = clampZ(sampleHeight(hm, p.x, p.y));
    tp.feed({ x: p.x, y: p.y, z });
  }
  const last = at(coords[coords.length - 1]);
  tp.rapid({ x: last.x, y: last.y, z: safeZ });
}

/**
 * Top-level entry: build the heightmap from a placed mesh and generate roughing
 * and/or finishing toolpaths. The caller is responsible for placing the mesh
 * (e.g. base at Z=0 / origin) before calling; toolpaths are emitted in the
 * mesh's own XY/Z coordinates.
 */
export function carveMesh(mesh: StlMesh, params: Carve3DParams): CarveResult {
  const warnings: string[] = [];
  const result: CarveResult = {
    toolpaths: [],
    warnings,
    roughLevels: 0,
    finishLines: 0,
    gridX: 0,
    gridY: 0,
    heightmap: null,
  };

  if (mesh.triangleCount === 0) {
    warnings.push('Mesh is empty — nothing to carve.');
    return result;
  }
  if (!(params.toolDiameter > 0)) {
    warnings.push('Tool diameter must be > 0.');
    return result;
  }
  if (!(params.stepover > 0)) {
    warnings.push('Stepover must be > 0.');
    return result;
  }

  const hm = buildHeightmap(mesh, params);
  warnings.push(...hm.warnings);
  result.heightmap = hm;
  result.gridX = hm.nx;
  result.gridY = hm.ny;

  if (mesh.triangleCount > MAX_CARVE_TRIANGLES) {
    return result; // refused; warning already pushed
  }

  if (params.doRoughing) {
    const { tp, levels } = buildRoughing(hm, params);
    if (!tp.isEmpty()) result.toolpaths.push(tp);
    result.roughLevels = levels;
  }
  if (params.doFinishing) {
    const { tp, lines } = buildFinishing(hm, params);
    if (!tp.isEmpty()) result.toolpaths.push(tp);
    result.finishLines = lines;
  }

  if (result.toolpaths.length === 0) {
    warnings.push('No toolpaths produced — enable Roughing and/or Finishing.');
  }
  return result;
}

// ----------------------------------------------------------------------------
// EPS / AI best-effort vector path extraction
// ----------------------------------------------------------------------------

/**
 * Best-effort extraction of polylines from an EPS / Adobe Illustrator file.
 * EPS/AI are PostScript-based: vector paths are built from `moveto` (m),
 * `lineto` (l), and `curveto` (c) operators in user space, then painted with
 * `stroke` (S), `fill` (f), `closepath` (h), etc. We parse the simple operator
 * stream into polylines (cubic Béziers are flattened). We do NOT run a full
 * PostScript interpreter, do not honour the CTM beyond bbox flipping, and bail
 * out on binary/compressed (e.g. PDF-backed .ai) content.
 */
export interface EpsParseResult {
  ok: boolean;
  polylines: Polyline[];
  warnings: string[];
  error?: string;
}

export function parseEpsPaths(text: string): EpsParseResult {
  const warnings: string[] = [];

  // Detect binary / compressed payloads we can't read as plain PostScript.
  // Real .ai files are usually PDF; EPS may carry a binary preview header.
  if (text.charCodeAt(0) === 0xc5 || text.startsWith('%PDF')) {
    return {
      ok: false,
      polylines: [],
      warnings,
      error:
        'This looks like a PDF-based / binary Illustrator file. Re-export as plain EPS or DXF.',
    };
  }
  // A high ratio of non-printable bytes means it isn't a text PostScript stream.
  let nonPrintable = 0;
  const sniff = Math.min(text.length, 4096);
  for (let i = 0; i < sniff; i++) {
    const c = text.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32 || c > 126) nonPrintable++;
  }
  if (sniff > 0 && nonPrintable / sniff > 0.1) {
    return {
      ok: false,
      polylines: [],
      warnings,
      error: 'Couldn’t parse this EPS/AI (binary or compressed content). Please export as DXF.',
    };
  }

  // Tokenise the PostScript number/operator stream.
  // We only honour: x y moveto | x y lineto | x1 y1 x2 y2 x3 y3 curveto |
  // closepath. Y is kept as-is (caller treats it as world Y).
  const tokenRe = /(-?\d*\.?\d+(?:[eE][-+]?\d+)?)|\b(moveto|lineto|curveto|closepath|m|l|c|v|y|h)\b/g;
  const stack: number[] = [];
  const polylines: Polyline[] = [];
  let cur: Polyline | null = null;
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;
  let m: RegExpExecArray | null;
  const MAX_PTS = 2_000_000;
  let totalPts = 0;

  const flatCubic = (
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number,
    pl: Polyline,
  ) => {
    // Adaptive-ish flattening with a fixed modest subdivision (16 segs).
    const n = 16;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const mt = 1 - t;
      const x =
        mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3;
      const y =
        mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3;
      pl.add({ x, y });
    }
  };

  while ((m = tokenRe.exec(text)) !== null) {
    if (m[1] != null) {
      stack.push(parseFloat(m[1]));
      if (stack.length > 64) stack.shift(); // bound operand stack
      continue;
    }
    const op = m[2];
    switch (op) {
      case 'moveto':
      case 'm': {
        if (stack.length >= 2) {
          if (cur && cur.points.length >= 2) polylines.push(cur);
          curX = stack[stack.length - 2];
          curY = stack[stack.length - 1];
          startX = curX;
          startY = curY;
          cur = new Polyline();
          cur.add({ x: curX, y: curY });
          totalPts++;
        }
        stack.length = 0;
        break;
      }
      case 'lineto':
      case 'l': {
        if (cur && stack.length >= 2) {
          curX = stack[stack.length - 2];
          curY = stack[stack.length - 1];
          cur.add({ x: curX, y: curY });
          totalPts++;
        }
        stack.length = 0;
        break;
      }
      case 'curveto':
      case 'c': {
        if (cur && stack.length >= 6) {
          const x1 = stack[stack.length - 6];
          const y1 = stack[stack.length - 5];
          const x2 = stack[stack.length - 4];
          const y2 = stack[stack.length - 3];
          const x3 = stack[stack.length - 2];
          const y3 = stack[stack.length - 1];
          flatCubic(curX, curY, x1, y1, x2, y2, x3, y3, cur);
          curX = x3;
          curY = y3;
          totalPts += 16;
        }
        stack.length = 0;
        break;
      }
      case 'v': // first ctrl = current point
      case 'y': {
        // PDF-flavoured curve variants seen in .ai; treat as a curve with
        // duplicated control points so we still get a smooth-ish result.
        if (cur && stack.length >= 4) {
          const a = stack[stack.length - 4];
          const b = stack[stack.length - 3];
          const x3 = stack[stack.length - 2];
          const y3 = stack[stack.length - 1];
          if (op === 'v') flatCubic(curX, curY, curX, curY, a, b, x3, y3, cur);
          else flatCubic(curX, curY, a, b, x3, y3, x3, y3, cur);
          curX = x3;
          curY = y3;
          totalPts += 16;
        }
        stack.length = 0;
        break;
      }
      case 'closepath':
      case 'h': {
        if (cur && cur.points.length >= 2) {
          cur.closed = true;
          cur.add({ x: startX, y: startY });
          curX = startX;
          curY = startY;
        }
        stack.length = 0;
        break;
      }
    }
    if (totalPts > MAX_PTS) {
      warnings.push('EPS/AI path data truncated (too many points).');
      break;
    }
  }
  if (cur && cur.points.length >= 2) polylines.push(cur);

  if (polylines.length === 0) {
    return {
      ok: false,
      polylines: [],
      warnings,
      error:
        'No simple vector paths found in this EPS/AI. It may use clipping/compressed data — export as DXF.',
    };
  }
  if (totalPts > 0) {
    warnings.push(
      `Best-effort EPS/AI import: extracted ${polylines.length} path(s). Verify the toolpath before cutting.`,
    );
  }
  return { ok: true, polylines, warnings };
}
