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
import type { Placement } from './transform';
import { GcodeEmitter, ZMode } from './gcodeEmitter';
import { buildCutout, type CutoutParams } from './cutout';

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
  stepover: number; // mm between adjacent raster lines (XY) — FINISHING surface quality
  /**
   * Optional coarser stepover (mm) for the ROUGHING bulk-clearing raster. When
   * omitted, roughing reuses {@link stepover}. A larger roughing stepover clears
   * stock far faster while finishing keeps the fine stepover for surface finish.
   */
  roughStepover?: number;
  stepdown: number; // mm depth per roughing level
  safeZ: number; // retract height above stock top (mm)
  maxDepth: number; // max material depth to remove below the top surface (mm)
  feedXY: number; // cutting feed (mm/min) — "Cut speed" in the UI
  feedZ: number; // plunge feed (mm/min)
  travelFeed: number; // "free"/link feed for non-cutting links (mm/min)
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
    travelFeed: 1200,
    spindleRPM: 10000,
    doRoughing: true,
    doFinishing: true,
    finishDir: 'x',
    ...overrides,
  };
}

/** Derived, ready-to-use carving parameters from a tool + material. */
export interface AutoCarveParams {
  /** Fine stepover for the FINISHING raster (mm) — surface quality. */
  finishStepover: number;
  /** Coarse stepover for the ROUGHING bulk clearing (mm) — faster removal. */
  roughStepover: number;
  /** Depth removed per roughing level (mm). */
  stepdown: number;
  /**
   * Whether a separate roughing phase is worth it. Roughing only pays off when
   * the relief is deeper than a single stepdown; for shallow reliefs the finish
   * pass alone removes everything, so we skip roughing for a faster job.
   */
  doRoughing: boolean;
}

/**
 * Derive good default carving parameters from the tool + material + (optional)
 * relief depth. Pure (no DOM/React), callable from the panel and the worker.
 *
 *  - FINISHING stepover comes from the desired surface scallop: for a ball-nose
 *    bit the stepover that leaves a scallop height `h` is 2·√(2·r·h − h²),
 *    clamped to a sane fraction of the diameter. A flat bit can't smoothly blend
 *    a relief, so its finishing stepover is a small fraction of the diameter.
 *  - ROUGHING stepover is a LARGE fraction of the diameter (bulk removal); it is
 *    always ≥ the finishing stepover.
 *  - STEPDOWN is the material's depth-of-cut fraction × diameter (clamped).
 *  - doRoughing is false when the whole relief fits in one stepdown (finishing
 *    alone clears it — skipping roughing roughly halves the program).
 *
 * @param toolDiameter   cutter diameter (mm)
 * @param toolType       'ball' | 'flat'
 * @param stepdownFrac   material depth-of-cut as a fraction of diameter (0..1)
 * @param reliefDepth    total relief depth below the stock top (mm); when known,
 *                       lets us decide whether roughing is worthwhile
 * @param scallopMm      desired finishing scallop height (mm); default 0.05mm
 */
export function autoCarveParams(
  toolDiameter: number,
  toolType: ToolType,
  stepdownFrac: number,
  reliefDepth?: number,
  scallopMm = 0.05,
): AutoCarveParams {
  const dia = toolDiameter > 0 ? toolDiameter : 3.175;
  const r = dia / 2;
  const MIN_STEP = 0.05;

  // Finishing stepover from the scallop-height relation for a ball-nose tip.
  let finishStepover: number;
  if (toolType === 'ball') {
    const h = Math.min(Math.max(scallopMm, 0.005), r * 0.9);
    finishStepover = 2 * Math.sqrt(Math.max(0, 2 * r * h - h * h));
    // Keep it within a practical 5%–35% of the diameter so it never collapses to
    // a hair-thin pass nor blows out coarse.
    finishStepover = Math.min(Math.max(finishStepover, dia * 0.05), dia * 0.35);
  } else {
    // A flat bit leaves a faceted relief regardless of stepover; use a modest
    // fraction of the diameter for a reasonable finish without crawling.
    finishStepover = dia * 0.25;
  }
  finishStepover = Math.max(MIN_STEP, Math.round(finishStepover * 100) / 100);

  // Roughing clears bulk: a large fraction of the diameter, always ≥ finishing.
  const roughStepover = Math.max(
    finishStepover,
    Math.round(dia * 0.6 * 100) / 100,
  );

  // Stepdown from the material's depth-of-cut fraction, clamped to a sane band.
  const frac = stepdownFrac > 0 ? stepdownFrac : 0.5;
  let stepdown = frac * dia;
  stepdown = Math.min(Math.max(stepdown, 0.1), dia * 1.0);
  stepdown = Math.round(stepdown * 100) / 100;

  // Skip roughing when the entire relief fits in one finishing pass depth.
  const doRoughing = reliefDepth == null ? true : reliefDepth > stepdown + 1e-6;

  return { finishStepover, roughStepover, stepdown, doRoughing };
}

/**
 * A sampled top-surface heightmap over the mesh XY footprint. `z[iy*nx + ix]` is
 * the highest reachable UP-FACING surface Z at the centre of cell (ix, iy),
 * referenced so the stock top is Z=0 and the surface dips into negative Z.
 *
 * Only the Z-axis-facing TOP surface drives the heightmap — down-facing facets
 * (the model underside) are ignored. Cells with no up-facing surface over them
 * are "air / background": they keep Z = `zTop` (the stock top) AND their
 * `covered` flag is 0, so downstream passes know there is nothing to carve there
 * and must leave the stock untouched (never flatten the background).
 */
export interface Heightmap {
  nx: number;
  ny: number;
  /** World-space origin (min corner) and cell pitch (mm). */
  x0: number;
  y0: number;
  dx: number;
  dy: number;
  /** Top surface Z per cell (mm). Length nx*ny. Uncovered cells hold `zTop`. */
  z: Float32Array;
  /**
   * Coverage mask (length nx*ny). 1 = an up-facing surface was rasterized into
   * this cell (real material to follow/carve); 0 = air/background (no up-facing
   * surface here — treat as the stock top and DO NOT mill it).
   */
  covered: Uint8Array;
  /**
   * Model SILHOUETTE / footprint mask (length nx*ny). 1 = the model occupies this
   * cell in XY (ANY triangle — up-, down- or side-facing — projects onto it);
   * 0 = outside the model's XY shadow. Unlike {@link covered}, this is independent
   * of how the surface faces or how deep anything is carved, so a flat-top part
   * (nothing to mill) still has a complete footprint to cut around. The cutout
   * pass derives the part outline from THIS mask.
   */
  footprint: Uint8Array;
  /**
   * True when the model's up-facing top surface is essentially flat at the stock
   * top — there is no relief to carve (every covered cell sits at z≈0). The UI
   * uses this to show a clear "top is flat — nothing to carve" hint instead of a
   * scary "no toolpaths produced".
   */
  flatTop: boolean;
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
  // CNC relief convention: the TOP of the relief is the stock surface = work Z 0,
  // and the tool cuts DOWNWARD into negative Z. The mesh lives in its own
  // (absolute) Z space, so we reference every height to the mesh's highest point:
  // `zRef` is the mesh top, which maps to Z 0. The heightmap then stores surface
  // depth-below-top (<= 0), roughing/finishing cut at <= 0, and the safe-Z
  // retract (> 0) is genuinely above all cutting — never the old bug where cuts
  // happened at +Z above the work zero and "safe-Z" sat below the material.
  const zRef = mesh.bbox.max[2];
  const zTop = 0; // mesh top after referencing to the stock surface
  const zBottom = mesh.bbox.min[2] - zRef; // <= 0
  const floorZ = zTop - Math.max(0, params.maxDepth); // = -maxDepth (<= 0)

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
  // Uncovered (air/background) cells default to the STOCK TOP (Z=0), NOT the carve
  // floor — there is nothing to carve there, so the surface "is" the stock top and
  // no downward cut may happen. The `covered` mask records where a real up-facing
  // surface actually exists so passes can distinguish "surface at top" from "air".
  z.fill(zTop);
  const covered = new Uint8Array(nx * ny);
  // Model XY silhouette — every cell ANY triangle projects onto, regardless of
  // facing. Drives the cutout outline so a flat-top part still has a footprint.
  const footprint = new Uint8Array(nx * ny);

  if (mesh.triangleCount > 0 && mesh.triangleCount <= MAX_CARVE_TRIANGLES) {
    rasterizeTriangles(mesh, z, covered, footprint, nx, ny, minX, minY, dx, dy, floorZ, zRef);
  }

  const hm: Heightmap = {
    nx,
    ny,
    x0: minX,
    y0: minY,
    dx,
    dy,
    z,
    covered,
    footprint,
    flatTop: false,
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
  // (Only covered cells participate; air stays at the stock top.)
  dilateForTool(hm, params);
  // Clamp covered cells to the carve floor (never go below maxDepth). Uncovered
  // cells are left at the stock top (zTop) — they must never be cut. Track the
  // deepest covered surface so we can tell a flat top (nothing to carve) apart
  // from a real relief.
  const FLAT_TOL = 1e-3; // mm below the stock top before it counts as "relief"
  let deepest = 0; // most-negative covered surface Z (0 = at the stock top)
  let anyCovered = false;
  for (let i = 0; i < z.length; i++) {
    if (!covered[i]) continue;
    anyCovered = true;
    if (z[i] < floorZ) z[i] = floorZ;
    if (z[i] < deepest) deepest = z[i];
  }
  // Flat top = there IS a model surface but it never dips below the stock top by
  // more than the tolerance (so roughing/finishing have nothing to remove).
  hm.flatTop = anyCovered && deepest > -FLAT_TOL;
  return hm;
}

/**
 * Z-buffer rasterize the UP-FACING top surface only. For each triangle whose
 * normal points up (normal.z > eps), set every covered cell to max(z) and flag
 * it in the `covered` mask. Down-facing facets (the model underside) and
 * vertical/side facets are ignored so the underside can never drive a cut and
 * the background stays at the stock top. STL stores a per-facet normal; when it
 * is zero/degenerate we recompute it from the vertices (consistent winding).
 */
function rasterizeTriangles(
  mesh: StlMesh,
  z: Float32Array,
  covered: Uint8Array,
  footprint: Uint8Array,
  nx: number,
  ny: number,
  minX: number,
  minY: number,
  dx: number,
  dy: number,
  floorZ: number,
  zRef: number,
): void {
  const tris = mesh.triangles;
  const stride3 = STL_STRIDE * 3;
  // An up-facing facet has a positive Z normal component. Use a small epsilon so
  // near-vertical walls (n.z ~ 0) are excluded as "not a top surface".
  const NZ_EPS = 1e-4;
  for (let o = 0; o < tris.length; o += stride3) {
    // Reference every Z to the stock top (zRef -> 0); the tool cuts into <= 0.
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2] - zRef;
    const bx = tris[o + STL_STRIDE], by = tris[o + STL_STRIDE + 1], bz = tris[o + STL_STRIDE + 2] - zRef;
    const cx = tris[o + STL_STRIDE * 2], cy = tris[o + STL_STRIDE * 2 + 1], cz = tris[o + STL_STRIDE * 2 + 2] - zRef;

    // Triangle XY bounds → cell index range (shared by footprint + surface).
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

    // Up-facing test. Prefer the stored facet normal's Z; if the stored normal is
    // degenerate, derive the facet normal's Z sign from the vertex winding. Only
    // up-facing facets drive the surface heightmap (`z`/`covered`); EVERY facet
    // contributes to the model footprint silhouette.
    let nz = tris[o + 5]; // normal.z of vertex 0 (per-facet, shared across verts)
    const nLen = Math.hypot(tris[o + 3], tris[o + 4], tris[o + 5]);
    if (!(nLen > 0.5)) {
      // Recompute from vertices: nz = (B-A) x (C-A) .z (winding-consistent).
      nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    }
    const upFacing = nz > NZ_EPS;
    const triMaxZ = Math.max(az, bz, cz);
    // The surface heightmap only takes up-facing facets that can raise it above
    // the floor; the footprint takes them all.
    const surfaceFacet = upFacing && triMaxZ > floorZ;

    for (let iy = iy0; iy <= iy1; iy++) {
      const py = minY + iy * dy;
      const rowBase = iy * nx;
      for (let ix = ix0; ix <= ix1; ix++) {
        const px = minX + ix * dx;
        let inside: boolean;
        let zHere = triMaxZ;
        if (flat) {
          // Degenerate XY projection (vertical wall) — its shadow is the bbox
          // band; treat every cell in range as inside for the footprint.
          inside = true;
        } else {
          const vpx = px - ax, vpy = py - ay;
          const u = (vpx * d01y - d01x * vpy) / denom;
          const v = (d00x * vpy - vpx * d00y) / denom;
          // Point-in-triangle with a small tolerance to avoid seams between
          // adjacent triangles dropping cells.
          const tol = 1e-6;
          inside = !(u < -tol || v < -tol || u + v > 1 + tol);
          if (inside) zHere = az + u * (bz - az) + v * (cz - az);
        }
        if (!inside) continue;
        const cell = rowBase + ix;
        // EVERY facet's XY shadow marks the footprint silhouette.
        footprint[cell] = 1;
        if (!surfaceFacet) continue;
        // First up-facing surface to touch this cell sets it (the array was
        // pre-filled with zTop for air); later ones keep the TOPMOST surface Z.
        if (!covered[cell]) {
          covered[cell] = 1;
          z[cell] = zHere;
        } else if (zHere > z[cell]) {
          z[cell] = zHere;
        }
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
  const { nx, ny, dx, dy, z, covered } = hm;
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
      const cell = iy * nx + ix;
      // Only adjust real (covered) cells — air/background stays at the stock top.
      if (!covered[cell]) continue;
      let best = src[cell];
      for (const { ox, oy, lift } of offsets) {
        const jx = ix + ox;
        const jy = iy + oy;
        if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
        const ncell = jy * nx + jx;
        // Only let real surface neighbours raise this cell; air carries no
        // surface to fit the tool against.
        if (!covered[ncell]) continue;
        // The tool tip resting so it clears neighbour height (src) requires the
        // tip Z >= neighbourZ - lift (ball) i.e. tip raised by neighbourZ-lift.
        const need = src[ncell] - lift;
        if (need > best) best = need;
      }
      z[cell] = best;
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

/**
 * Nearest-cell coverage test at world (x, y). True when the cell under the point
 * holds a real up-facing surface (material to carve); false over air/background.
 * Roughing/finishing use this to refuse cuts where there is nothing to carve.
 */
function sampleCovered(hm: Heightmap, x: number, y: number): boolean {
  const { nx, ny, dx, dy, x0, y0, covered } = hm;
  let ix = Math.round((x - x0) / dx);
  let iy = Math.round((y - y0) / dy);
  if (ix < 0) ix = 0;
  else if (ix > nx - 1) ix = nx - 1;
  if (iy < 0) iy = 0;
  else if (iy > ny - 1) iy = ny - 1;
  return covered[iy * nx + ix] !== 0;
}

// ----------------------------------------------------------------------------
// Toolpath generation
// ----------------------------------------------------------------------------

/** One contiguous cut span on a roughing scan-row: [a, b] in the scan axis. */
interface Span {
  a: number; // span start coord (in scan-walk order)
  b: number; // span end coord
}

/**
 * Roughing: descend in stepdown layers from just under the top surface to the
 * carve floor. At each level we raster the footprint as a CONTINUOUS engaged
 * boustrophedon — the tool stays down and links rows/spans instead of lifting to
 * safe-Z between each one:
 *
 *  - Each row is cut as one move across its contiguous material span(s).
 *  - The step-over to the next row is a CUT at the level Z (a thin connector pass
 *    along the region boundary) whenever that row's span overlaps the previous
 *    one in the scan axis — so the link stays inside the material being cleared.
 *  - Within a row, separate spans (a genuine no-material gap) are bridged by a
 *    `travel` link just above the level only if that gap is already cleared;
 *    otherwise the tool retracts to safe-Z, repositions, and re-plunges.
 *  - A safe-Z retract happens ONLY when no in-material link is possible (disjoint
 *    regions / first contact), collapsing the old "forest of plunges".
 *
 * The result is long boustrophedon passes with very few plunges/retracts.
 */
function buildRoughing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; levels: number } {
  const tp = new Toolpath();
  tp.name = '3D Roughing';
  // Roughing clears bulk stock, so it may use a coarser stepover than finishing.
  const roughStep =
    params.roughStepover && params.roughStepover > 0 ? params.roughStepover : params.stepover;
  const step = Math.max(roughStep, hm.dx, 0.1);
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);
  const safeZ = params.safeZ;
  // Only material whose surface sits below the stock top by more than this is
  // worth cutting; at-top (z ~ 0) and air/background cells are left untouched.
  const cutTol = 1e-3;
  // Tiny clearance above the cut plane for in-material gap links (so the tool
  // doesn't rub the floor while repositioning, but never lifts to safe-Z).
  const linkClear = Math.min(0.3, Math.max(params.stepover * 0.25, 0.05));

  // Descending Z levels (each a flat clearing plane).
  const stepdown = params.stepdown > 0 ? params.stepdown : Math.max(params.maxDepth, 0.1);
  const levels: number[] = [];
  let zL = hm.zTop - stepdown;
  while (zL > floorZ + 1e-6) {
    levels.push(zL);
    zL -= stepdown;
  }
  levels.push(floorZ);

  const y0 = hm.minY;
  const y1 = hm.maxY;
  const x0 = hm.minX;
  const x1 = hm.maxX;
  const sampleStep = Math.max(hm.dx, step * 0.5, 0.1);

  // Sample X positions for a row once (shared across levels).
  const xsAsc: number[] = [];
  for (let x = x0; x <= x1 + 1e-9; x += sampleStep) xsAsc.push(x);
  if (xsAsc.length === 0 || xsAsc[xsAsc.length - 1] < x1) xsAsc.push(x1);

  // Build the rows (constant Y) once per level.
  const ys: number[] = [];
  for (let y = y0; y <= y1 + 1e-9; y += step) ys.push(y);
  if (ys.length === 0 || ys[ys.length - 1] < y1) ys.push(y1);

  for (const level of levels) {
    const linkZ = Math.min(level + linkClear, safeZ);
    // Track whether the tool is currently down (engaged at this level), where it
    // is, and the scan-axis [lo,hi] extent of the span it last cut.
    let down = false;
    let curX = 0;
    let curY = 0;
    let prevLo = 0;
    let prevHi = 0;
    let flip = false;

    /** Lift to safe-Z (only when no in-material link is possible). */
    const retract = () => {
      if (down) {
        tp.rapid({ x: curX, y: curY, z: safeZ });
        down = false;
      }
    };
    const approach = (x: number, y: number) => {
      tp.rapid({ x, y, z: safeZ });
      tp.plunge({ x, y, z: level });
      down = true;
    };

    for (const y of ys) {
      const ordered = flip ? xsAsc.slice().reverse() : xsAsc;
      // Find contiguous material spans along this row (surface above `level`).
      const spans: Span[] = [];
      let runStart: number | null = null;
      let prev = ordered[0];
      for (const x of ordered) {
        // Bulk to clear at this level only if (a) a real up-facing surface covers
        // this cell (never air/background), (b) that final surface is BELOW the
        // stock top (z < -cutTol — never carve the background/at-top), and (c) the
        // final surface lies BELOW this clearing level, so there is still material
        // between the level and the surface to remove. Where the surface is at or
        // above the level we'd gouge the relief, so we don't cut it.
        const surf = sampleHeight(hm, x, y);
        const material =
          sampleCovered(hm, x, y) && surf < -cutTol && surf < level - 1e-6;
        if (material && runStart === null) runStart = x;
        else if (!material && runStart !== null) {
          spans.push({ a: runStart, b: prev });
          runStart = null;
        }
        prev = x;
      }
      if (runStart !== null) spans.push({ a: runStart, b: ordered[ordered.length - 1] });

      let firstOfRow = true;
      for (const span of spans) {
        const lo = Math.min(span.a, span.b);
        const hi = Math.max(span.a, span.b);
        if (!down) {
          approach(span.a, y);
        } else if (firstOfRow) {
          // Row-to-row step-over. If this span overlaps the previous row's span
          // in the scan axis, the connector stays inside the cleared region →
          // link it as a CUT at the level Z (a thin boundary pass). Otherwise we
          // can't link without gouging/air-cutting across a feature → retract.
          const overlap = lo <= prevHi + step + 1e-6 && hi >= prevLo - step - 1e-6;
          if (overlap) {
            tp.feed({ x: span.a, y, z: level });
          } else {
            retract();
            approach(span.a, y);
          }
        } else {
          // Second+ span on the SAME row — a real no-material gap precedes it.
          // Bridge just above the level if that gap is already cleared, else
          // retract and re-plunge.
          if (linkClearOfMaterial(hm, curX, curY, span.a, y, level)) {
            tp.travel({ x: curX, y: curY, z: linkZ });
            tp.travel({ x: span.a, y, z: linkZ });
            tp.feed({ x: span.a, y, z: level });
          } else {
            retract();
            approach(span.a, y);
          }
        }
        // Cut across the engaged span.
        tp.feed({ x: span.b, y, z: level });
        curX = span.b;
        curY = y;
        prevLo = lo;
        prevHi = hi;
        firstOfRow = false;
      }
      flip = !flip;
    }
    retract();
  }

  return { tp, levels: levels.length };
}

/**
 * True when the straight link from (x0,y0)→(x1,y1) stays entirely in material
 * that has already been cleared at `level` (i.e. the surface is at or below the
 * level everywhere along it, so riding just above the level won't gouge).
 */
function linkClearOfMaterial(
  hm: Heightmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
): boolean {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const stepN = Math.max(2, Math.ceil(dist / Math.max(hm.dx, hm.dy, 0.1)));
  for (let i = 0; i <= stepN; i++) {
    const t = i / stepN;
    const sx = x0 + (x1 - x0) * t;
    const sy = y0 + (y1 - y0) * t;
    if (sampleHeight(hm, sx, sy) > level + 1e-6) return false;
  }
  return true;
}

/**
 * Finishing: a continuous serpentine raster that rides the heightmap (Z = surface
 * height at each XY). Adjacent rows are LINKED while staying on the surface — at a
 * row end the tool steps over to the next row's near end following the surface,
 * instead of retract→rapid→plunge every row.
 *
 * The link is only along-surface safe when nothing taller pokes up between the two
 * row ends. Rule: if the max surface height sampled along the step-over link
 * exceeds BOTH endpoints by more than a small tolerance, a direct surface link
 * would gouge that feature, so we retract to safe-Z, reposition, and re-plunge;
 * otherwise we ride the surface across the link at the cut feed.
 */
function buildFinishing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; lines: number } {
  const tp = new Toolpath();
  tp.name = '3D Finishing';
  const step = Math.max(params.stepover, 0.05);
  const safeZ = params.safeZ;
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);
  // Only ride/cut the surface where it dips below the stock top by more than this;
  // at-top (z ~ 0) and uncovered air cells are background and must be left alone.
  const cutTol = 1e-3;

  const sampleStep = Math.max(hm.dx, hm.dy, step * 0.5, 0.05);
  let lineCount = 0;

  const clampZ = (z: number) => (z < floorZ ? floorZ : z > hm.zTop ? hm.zTop : z);
  const alongX = params.finishDir === 'x';

  // Build each scan line's coordinate list, serpentine-ordered.
  const lines: { fixed: number; coords: number[] }[] = [];
  if (alongX) {
    let flip = false;
    for (let y = hm.minY; y <= hm.maxY + 1e-9; y += step) {
      const xs: number[] = [];
      for (let x = hm.minX; x <= hm.maxX + 1e-9; x += sampleStep) xs.push(x);
      if (xs.length === 0 || xs[xs.length - 1] < hm.maxX) xs.push(hm.maxX);
      lines.push({ fixed: y, coords: flip ? xs.slice().reverse() : xs });
      flip = !flip;
    }
  } else {
    let flip = false;
    for (let x = hm.minX; x <= hm.maxX + 1e-9; x += step) {
      const ys: number[] = [];
      for (let y = hm.minY; y <= hm.maxY + 1e-9; y += sampleStep) ys.push(y);
      if (ys.length === 0 || ys[ys.length - 1] < hm.maxY) ys.push(hm.maxY);
      lines.push({ fixed: x, coords: flip ? ys.slice().reverse() : ys });
      flip = !flip;
    }
  }

  const at = (fixed: number, c: number) => (alongX ? { x: c, y: fixed } : { x: fixed, y: c });
  // A point is carveable when a real up-facing surface covers it AND that surface
  // sits below the stock top. Everywhere else (air / at-top) the tool stays up.
  const carveable = (x: number, y: number): boolean =>
    sampleCovered(hm, x, y) && sampleHeight(hm, x, y) < -cutTol;

  let engaged = false; // tool currently riding the surface (down, cutting)
  let prevX = 0;
  let prevY = 0;
  let prevZ = 0;

  /** Lift to safe-Z over the current point (only when engaged). */
  const lift = () => {
    if (engaged) {
      tp.rapid({ x: prevX, y: prevY, z: safeZ });
      engaged = false;
    }
  };

  for (const line of lines) {
    if (line.coords.length < 2) continue;
    let rowCut = false;
    for (let i = 0; i < line.coords.length; i++) {
      const p = at(line.fixed, line.coords[i]);
      if (!carveable(p.x, p.y)) {
        // Background / at-top: never cut here. Lift away and travel over it.
        lift();
        continue;
      }
      const z = clampZ(sampleHeight(hm, p.x, p.y));
      if (!engaged) {
        // (Re)enter the surface: rapid over at safe-Z, then plunge to the surface.
        tp.rapid({ x: p.x, y: p.y, z: safeZ });
        tp.plunge({ x: p.x, y: p.y, z });
        engaged = true;
      } else if (surfaceLinkSafe(hm, prevX, prevY, p.x, p.y, prevZ, z, clampZ)) {
        // Ride the surface across to the next sample.
        tp.feed({ x: p.x, y: p.y, z });
      } else {
        // A taller feature sits between the samples → retract, reposition, plunge.
        tp.rapid({ x: prevX, y: prevY, z: safeZ });
        tp.rapid({ x: p.x, y: p.y, z: safeZ });
        tp.plunge({ x: p.x, y: p.y, z });
      }
      prevX = p.x;
      prevY = p.y;
      prevZ = z;
      rowCut = true;
    }
    // End each scan line lifted so the serpentine step-over to the next row never
    // drags a cut across the background between disjoint relief regions.
    lift();
    if (rowCut) lineCount++;
  }

  lift();

  return { tp, lines: lineCount };
}

/**
 * Decide if a straight surface-following link between two row ends is safe (won't
 * gouge). We sample the surface along the link; if the highest point along it
 * rises more than a small tolerance above BOTH endpoints, a feature sits between
 * the rows and a direct link would dig into it — return false (caller retracts).
 */
function surfaceLinkSafe(
  hm: Heightmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number,
  clampZ: (z: number) => number,
): boolean {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  // A normal step-over is short; if it's unexpectedly long (disjoint regions),
  // don't try to ride the surface across it.
  if (dist > Math.max(hm.dx, hm.dy) * 6 + 1e-6) return false;
  const stepN = Math.max(2, Math.ceil(dist / Math.max(hm.dx, hm.dy, 0.05)));
  const tol = 0.05;
  const hi = Math.max(z0, z1) + tol;
  for (let i = 1; i < stepN; i++) {
    const t = i / stepN;
    const sx = x0 + (x1 - x0) * t;
    const sy = y0 + (y1 - y0) * t;
    if (clampZ(sampleHeight(hm, sx, sy)) > hi) return false;
  }
  return true;
}

/**
 * The XY footprint (width × depth, mm) a mesh occupies after a uniform XY scale
 * and a Z-rotation about its own bbox centre. Used by the auto-nester to pack
 * several carve jobs onto the bed without overlap. Rotation is applied to the
 * four bbox corners and a fresh axis-aligned extent is measured — so a rotated
 * job reserves the space its turned rectangle actually needs.
 */
export function meshFootprint(
  mesh: StlMesh,
  opts: { rotDeg: number; scale: number },
): { w: number; h: number } {
  const minX = mesh.bbox.min[0];
  const minY = mesh.bbox.min[1];
  const maxX = mesh.bbox.max[0];
  const maxY = mesh.bbox.max[1];
  const s = Number.isFinite(opts.scale) && opts.scale > 0 ? opts.scale : 1;
  const rad = ((opts.rotDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const corners: [number, number][] = [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
  let nMinX = Infinity;
  let nMinY = Infinity;
  let nMaxX = -Infinity;
  let nMaxY = -Infinity;
  for (const [px, py] of corners) {
    const vx = (px - cx) * s;
    const vy = (py - cy) * s;
    const rx = vx * cos - vy * sin;
    const ry = vx * sin + vy * cos;
    if (rx < nMinX) nMinX = rx;
    if (ry < nMinY) nMinY = ry;
    if (rx > nMaxX) nMaxX = rx;
    if (ry > nMaxY) nMaxY = ry;
  }
  return { w: nMaxX - nMinX, h: nMaxY - nMinY };
}

/**
 * Bake a {@link Placement} (XY translate, Z-rotation about `pivot`, uniform XY
 * scale) into a toolpath's move coordinates, returning a NEW toolpath. Z is left
 * untouched (carve depth is independent of XY placement). The pivot is the job's
 * own XY-bbox centre so rotation/scale spin about the model, matching the
 * in-viewport gizmo and the G-code text transform in core/transform.ts.
 *
 * This lets several placed carve jobs be concatenated into ONE emitter call so
 * the combined program has a single header / spindle start / footer.
 */
export function placeToolpath(
  src: Toolpath,
  placement: Placement,
  pivot: { x: number; y: number },
): Toolpath {
  const out = new Toolpath();
  out.name = src.name;
  const s = Number.isFinite(placement.scale) && placement.scale > 0 ? placement.scale : 1;
  const rad = ((placement.rotDeg || 0) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (const m of src.moves) {
    const vx = (m.target.x - pivot.x) * s;
    const vy = (m.target.y - pivot.y) * s;
    const rx = vx * cos - vy * sin;
    const ry = vx * sin + vy * cos;
    out.moves.push({
      type: m.type,
      target: {
        x: rx + pivot.x + placement.dx,
        y: ry + pivot.y + placement.dy,
        z: m.target.z,
      },
    });
  }
  return out;
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
    if (hm.flatTop) {
      // The top surface is flush with the stock top — there is genuinely nothing
      // to carve. This is not an error; point the operator at the cutout instead.
      warnings.push(
        'Top surface is flat — nothing to carve; enable Cut-part-from-stock to cut it out.',
      );
    } else if (params.doRoughing || params.doFinishing) {
      warnings.push('No toolpaths produced — the model has no relief below the stock top.');
    } else {
      warnings.push('No toolpaths produced — enable Roughing and/or Finishing.');
    }
  }
  return result;
}

// ----------------------------------------------------------------------------
// Combined multi-job program builder + Web Worker protocol
// ----------------------------------------------------------------------------
//
// The heavy 3D-carve compute (heightmap raster + roughing + finishing + optional
// cutout + G-code emission for one OR MANY jobs) is identical whether it runs on
// the main thread or inside a Web Worker. `buildCarveProgram` is that single pure
// implementation; the worker (`carve3d.worker.ts`) is a thin adapter that
// reconstructs the meshes from transferred buffers and calls it.

/** One job to carve, fully described so it can be structured-cloned to a worker. */
export interface CarveJobSpec {
  name: string;
  /** Per-job carving parameters (tool/feeds/depth/strategy). */
  params: Carve3DParams;
  /** Placement baked into the toolpath (XY move / Z-rotate / uniform scale). */
  placement: Placement;
  /** Pivot for the placement (the mesh XY-bbox centre). */
  pivot: { x: number; y: number };
  /** Stock thickness for this job's cutout pass (mm). */
  stockThicknessMm: number;
}

/** Shared global settings for the combined program. */
export interface CarveProgramGlobals {
  safeZ: number;
  spindleRPM: number;
  feedZ: number;
  toolDiameter: number;
}

export interface CarveProgramResult {
  gcode: string;
  lineCount: number;
  /** Number of jobs that actually contributed cutting moves. */
  jobsCarved: number;
  /** Number of jobs whose heightmap built (grid produced). */
  grids: number;
  warnings: string[];
}

/**
 * Strip the standard {@link GcodeEmitter} header/footer from a single-job
 * program, returning just the cutting body so several jobs can be stitched under
 * ONE shared header (units/plane), spindle start, and footer. A safe-Z retract
 * is prepended so each stitched job begins above the stock before its first XY
 * travel. (Ported from the panel so the worker can stitch identically.)
 */
function extractEmitterBody(program: string, safeZ: number): string[] {
  const raw = program.split(/\r?\n/);
  const isHeaderLine = (l: string): boolean => {
    const s = l.trim();
    if (s === '') return true;
    if (/^G21$|^G20$|^G90$|^G91$|^G94$|^G17$/.test(s)) return true;
    if (/^M3\b/.test(s) || /^M4\b/.test(s) || /^G4\b/.test(s)) return true;
    if (/^G0\s+Z/i.test(s)) return true;
    if (/^\(Generated by /i.test(s)) return true;
    return false;
  };
  let start = 0;
  while (start < raw.length && isHeaderLine(raw[start])) start++;
  let end = raw.length;
  while (end > start) {
    const s = raw[end - 1].trim();
    if (s === '' || /^M30\b/.test(s) || /^M5\b/.test(s) || /^G0\s+Z/i.test(s)) {
      end--;
      continue;
    }
    break;
  }
  const body = raw.slice(start, end).filter((l) => l.trim().length > 0);
  if (body.length === 0) return [];
  return [`G0 Z${safeZ.toFixed(3)}`, ...body];
}

/**
 * Build the SINGLE combined G-code program for a set of carve jobs: for each job
 * build the heightmap, roughing/finishing toolpaths and (optionally) the cutout
 * pass, bake its placement, emit its body with its own feeds, and stitch all
 * bodies under one safe header / M3 / footer. Pure — no DOM/React; safe to call
 * from a worker or the main thread.
 *
 * `onProgress` (optional) is invoked as `(done, total)` after each job so a
 * worker can post progress; returning `false` requests cooperative cancellation
 * (the build stops and returns what it has).
 */
export function buildCarveProgram(
  jobs: CarveJobSpec[],
  meshes: StlMesh[],
  globals: CarveProgramGlobals,
  cutout: CutoutParams | null,
  onProgress?: (done: number, total: number) => boolean,
): CarveProgramResult {
  const warnings: string[] = [];
  const bodies: string[] = [];
  let grids = 0;
  let carved = 0;
  const total = jobs.length;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const mesh = meshes[i];
    const result = carveMesh(mesh, job.params);
    for (const w of result.warnings) warnings.push(`${job.name}: ${w}`);
    if (result.gridX > 0) grids += 1;

    const carveTps = [...result.toolpaths];
    if (cutout && cutout.enabled && result.heightmap) {
      const co = buildCutout(
        result.heightmap,
        { ...cutout, stockThicknessMm: job.stockThicknessMm },
        globals.toolDiameter / 2,
      );
      for (const w of co.warnings) warnings.push(`${job.name}: ${w}`);
      if (co.toolpath) carveTps.push(co.toolpath);
    }

    if (carveTps.length > 0) {
      const placed = carveTps.map((tp) => {
        const p = placeToolpath(tp, job.placement, job.pivot);
        p.name = `${job.name} — ${tp.name}`;
        return p;
      });
      const jobEmitter = new GcodeEmitter({
        programName: '',
        comments: true,
        safeZ: globals.safeZ,
        feedXY: job.params.feedXY,
        feedZ: globals.feedZ,
        travelFeed: job.params.travelFeed,
        zMode: ZMode.Spindle,
        useSpindle: false, // spindle handled once in the shared header
        spindleRPM: globals.spindleRPM,
      });
      const body = extractEmitterBody(jobEmitter.emitProgram(placed), globals.safeZ);
      if (body.length > 0) {
        bodies.push(`(${job.name})`, ...body);
        carved += 1;
      }
    }

    if (onProgress && onProgress(i + 1, total) === false) break;
  }

  if (bodies.length === 0) {
    return { gcode: '', lineCount: 0, jobsCarved: carved, grids, warnings };
  }

  const name =
    jobs.length === 1 ? `${jobs[0].name} — 3D Carving` : `${jobs.length} jobs — 3D Carving`;
  const safe = globals.safeZ.toFixed(3);
  const lines: string[] = [
    `(${name})`,
    '(Generated by karmyogi 3D Carving — multi-model)',
    'G21',
    'G90',
    'G94',
    'G17',
    `G0 Z${safe}`,
    `M3 S${globals.spindleRPM.toFixed(3)}`,
    ...bodies,
    `G0 Z${safe}`,
    'M5',
    'M30',
  ];
  const gcode = lines.join('\n') + '\n';
  let lineCount = 0;
  for (let i = 0, n = gcode.length; i < n; i++) if (gcode.charCodeAt(i) === 10) lineCount++;
  return { gcode, lineCount, jobsCarved: carved, grids, warnings };
}

// ---- Worker message protocol (shared by carve3d.worker.ts and CadCamPanel) ---

/** One job's serializable payload: raw mesh buffer + bbox + the job spec. */
export interface CarveWorkerJob {
  spec: CarveJobSpec;
  triangles: Float32Array;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  format: 'binary' | 'ascii';
}

/** Request posted to the carve worker. */
export interface CarveWorkerRequest {
  type: 'carve';
  /** Monotonic id so the panel can ignore results from a superseded request. */
  jobId: number;
  jobs: CarveWorkerJob[];
  globals: CarveProgramGlobals;
  cutout: CutoutParams | null;
}

export interface CarveWorkerCancel {
  type: 'cancel';
}

export type CarveWorkerInbound = CarveWorkerRequest | CarveWorkerCancel;

export interface CarveWorkerProgress {
  type: 'progress';
  jobId: number;
  done: number;
  total: number;
}

export interface CarveWorkerDone {
  type: 'done';
  jobId: number;
  gcode: string;
  lineCount: number;
  jobsCarved: number;
  grids: number;
  warnings: string[];
}

export interface CarveWorkerError {
  type: 'error';
  jobId: number;
  message: string;
  cancelled?: boolean;
}

export type CarveWorkerOutbound = CarveWorkerProgress | CarveWorkerDone | CarveWorkerError;

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
