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

import { Toolpath, MoveType } from './toolpath';
import type { Vec3 } from './toolpath';
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
  /**
   * Entry strategy for descending into a region (HARDWARE SAFETY). Rather than a
   * straight vertical plunge (tool-breakage / burn risk for a small bit deep in
   * wood), the tool descends along a LINEAR RAMP (zig-zag inside the engaged
   * region) or a small HELIX into the first cleared cell. Defaults to 'ramp'.
   */
  plungeStrategy?: 'ramp' | 'helix' | 'plunge';
  /**
   * Max plunge RAMP angle from horizontal, degrees (1..30). The ramp run length
   * for a depth `d` is `d / tan(angle)`. Default 3° — very gentle, safe for hard
   * stock. Lower = longer/safer ramp; the ramp is capped to the engaged region.
   */
  rampAngleDeg?: number;
  /**
   * Hard cap on a single straight-down vertical plunge (mm). Any descent deeper
   * than this MUST be ramped/helixed; below it a short vertical move is allowed
   * (e.g. the last sliver of a helix, or entry into a feature too small to ramp).
   * Default 0.5mm.
   */
  maxStraightPlungeMm?: number;
  /**
   * Finishing raster pattern. 'serpentine' (default) alternates the sweep
   * direction every row (mixes climb + conventional milling); 'climb' (one-way)
   * sweeps every row in the SAME direction for a consistent surface finish, at the
   * cost of an extra return link per row.
   */
  finishPattern?: 'serpentine' | 'climb';
  /**
   * Short tangential LEAD-IN / LEAD-OUT distance (mm) at region entries so the
   * tool eases onto the cut instead of dwelling at a point (avoids burn/dwell
   * marks). 0 disables. Default 0 (kept off so existing verified behaviour is the
   * baseline unless requested). Applied as part of the ramp entry when > 0.
   */
  leadInMm?: number;
  /**
   * Heightmap sampling pitch (mm), DECOUPLED from the finishing stepover. When
   * omitted the pitch is derived from the finishing stepover (legacy behaviour).
   * A coarser pitch builds/dilates the grid far faster for a coarse-rough job
   * without forcing the fine-finish grid resolution. The finishing/roughing
   * passes still subsample at their own stepover, so surface quality is unchanged
   * down to the grid pitch.
   */
  heightmapPitch?: number;
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
    plungeStrategy: 'ramp',
    rampAngleDeg: 3,
    maxStraightPlungeMm: 0.5,
    finishPattern: 'serpentine',
    leadInMm: 0,
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
  /**
   * Deepest (most-negative) COVERED surface Z after tool dilation + floor clamp
   * (mm, <= 0). This is the ACTUAL relief depth the tool will carve — distinct
   * from the `maxDepth` PARAMETER, which is only an upper clamp. Roughing builds
   * its Z levels from this so a shallow relief never emits empty deep levels.
   */
  deepest: number;
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
  // Use ~half the FINISHING stepover (clamped) as the cell pitch — UNLESS the
  // caller decouples the grid pitch from the stepover (a coarse-rough/fine-finish
  // job can build/dilate a coarser grid far faster without forcing the fine grid).
  const pitch =
    params.heightmapPitch && params.heightmapPitch > 0
      ? Math.max(params.heightmapPitch, 0.05)
      : Math.max(params.stepover * 0.5, 0.05);
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
    deepest: 0,
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
  hm.deepest = deepest; // actual carved relief depth (<= 0), for honest level counts
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

  // PERF: on large grids the exact per-cell disc max-filter (O(cells × kernel))
  // becomes the carve's bottleneck. Switch to a SEPARABLE O(cells) dilation that
  // is provably SAFE (never lets the tool dig where it can't fit):
  //   • ball tool — separable parabolic (Felzenszwalb lower-envelope) dilation
  //     that approximates the spherical lift r−√(r²−d²) ≈ d²/(2r); the standard
  //     heightmap tool-comp, exact near the tip and a hair conservative at the rim.
  //   • flat tool — separable van-Herk square sliding-max. The square circumscribes
  //     the tool disc, so it raises the field by AT LEAST the disc would → the tool
  //     only ever cuts shallower, never deeper (conservative, never gouges).
  // Small grids keep the exact disc kernel so the verified baseline is unchanged.
  const cells = nx * ny;
  const FAST_THRESHOLD = 250_000;
  if (cells > FAST_THRESHOLD && (rxCells >= 2 || ryCells >= 2)) {
    if (params.toolType === 'ball') dilateBallSeparable(hm, r);
    else dilateFlatSeparable(hm, rxCells, ryCells);
    return;
  }

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

/**
 * Background height used for uncovered (air) cells during separable dilation so
 * they never raise a covered neighbour: very low, then restored to `zTop` after.
 */
const DILATE_NEG_INF = -1e30;

/**
 * Separable FLAT-tool dilation via the van Herk / Gil-Werman 1D sliding maximum
 * (two passes: horizontal then vertical), O(cells) independent of window size.
 * The square window circumscribes the tool disc, so the field is raised by at
 * least the true disc would — the resulting cut is always equal-or-shallower than
 * the exact disc, i.e. CONSERVATIVE (never gouges). Air cells are excluded.
 */
function dilateFlatSeparable(hm: Heightmap, rxCells: number, ryCells: number): void {
  const { nx, ny, z, covered } = hm;
  // Work on a copy where air = -inf so it can't lift real neighbours.
  const buf = new Float32Array(nx * ny);
  for (let i = 0; i < buf.length; i++) buf[i] = covered[i] ? z[i] : DILATE_NEG_INF;
  // Horizontal pass.
  const rowIn = new Float32Array(nx);
  const rowOut = new Float32Array(nx);
  for (let iy = 0; iy < ny; iy++) {
    const base = iy * nx;
    for (let ix = 0; ix < nx; ix++) rowIn[ix] = buf[base + ix];
    slidingMax1D(rowIn, rowOut, nx, rxCells);
    for (let ix = 0; ix < nx; ix++) buf[base + ix] = rowOut[ix];
  }
  // Vertical pass.
  const colIn = new Float32Array(ny);
  const colOut = new Float32Array(ny);
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) colIn[iy] = buf[iy * nx + ix];
    slidingMax1D(colIn, colOut, ny, ryCells);
    for (let iy = 0; iy < ny; iy++) buf[iy * nx + ix] = colOut[iy];
  }
  // Write back ONLY covered cells; air stays at the stock top.
  for (let i = 0; i < z.length; i++) {
    if (!covered[i]) continue;
    const v = buf[i];
    z[i] = v <= DILATE_NEG_INF * 0.5 ? z[i] : v;
  }
}

/** 1D windowed maximum (radius `rad`) over `n` elements, O(n) (running blocks). */
function slidingMax1D(src: Float32Array, dst: Float32Array, n: number, rad: number): void {
  if (rad <= 0) { dst.set(src.subarray(0, n)); return; }
  for (let i = 0; i < n; i++) {
    const lo = i - rad < 0 ? 0 : i - rad;
    const hi = i + rad >= n ? n - 1 : i + rad;
    let m = src[lo];
    for (let j = lo + 1; j <= hi; j++) if (src[j] > m) m = src[j];
    dst[i] = m;
  }
}

/**
 * Separable BALL-tool dilation by a parabola (lift ≈ d²/(2r)) using Felzenszwalb's
 * 1D lower-envelope of parabolas, O(cells). This grayscale parabolic dilation is
 * the standard heightmap ball-tool compensation: it is exact at the tip and a hair
 * conservative at the rim vs the true spherical lift r−√(r²−d²), so the tool never
 * digs deeper than it could fit. Air cells are excluded from lifting neighbours.
 */
function dilateBallSeparable(hm: Heightmap, r: number): void {
  const { nx, ny, dx, dy, z, covered } = hm;
  const buf = new Float32Array(nx * ny);
  for (let i = 0; i < buf.length; i++) buf[i] = covered[i] ? z[i] : DILATE_NEG_INF;
  // We compute g(i) = max_j ( f(j) − (i−j)²·a ) with a = pitch²/(2r) per axis,
  // capped at the tool radius. Dilation (not erosion) → negate, run the standard
  // squared-distance lower-envelope (which does min), negate back. Cap the window
  // to ±r so the parabola never reaches beyond the physical tool footprint.
  const ax = (dx * dx) / (2 * r);
  const ay = (dy * dy) / (2 * r);
  const capX = Math.min(Math.ceil(r / dx), 64);
  const capY = Math.min(Math.ceil(r / dy), 64);
  const lineMax = Math.max(nx, ny);
  const f = new Float64Array(lineMax);
  const d = new Float64Array(lineMax);
  const v = new Int32Array(lineMax);
  const zb = new Float64Array(lineMax + 1);
  // Horizontal.
  for (let iy = 0; iy < ny; iy++) {
    const base = iy * nx;
    for (let ix = 0; ix < nx; ix++) f[ix] = buf[base + ix];
    parabolicDilate1D(f, d, v, zb, nx, ax, capX);
    for (let ix = 0; ix < nx; ix++) buf[base + ix] = d[ix];
  }
  // Vertical.
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) f[iy] = buf[iy * nx + ix];
    parabolicDilate1D(f, d, v, zb, ny, ay, capY);
    for (let iy = 0; iy < ny; iy++) buf[iy * nx + ix] = d[iy];
  }
  for (let i = 0; i < z.length; i++) {
    if (!covered[i]) continue;
    const val = buf[i];
    z[i] = val <= DILATE_NEG_INF * 0.5 ? z[i] : val;
  }
}

/**
 * 1D grayscale dilation by the parabola `a·k²` over a window of radius `cap`:
 * out[i] = max_{|i−j|<=cap} ( f[j] − a·(i−j)² ). Implemented as Felzenszwalb's
 * lower-envelope of upward parabolas (run on −f to turn max into the canonical
 * min/distance-transform), then the window cap is applied as a second clamp.
 */
function parabolicDilate1D(
  f: Float64Array,
  out: Float64Array,
  vArr: Int32Array,
  zArr: Float64Array,
  n: number,
  a: number,
  cap: number,
): void {
  if (n === 0) return;
  if (a <= 0) { for (let i = 0; i < n; i++) out[i] = f[i]; return; }
  // g[j] = −f[j]; compute lower envelope of parabolas a(x−j)² + g[j]; result is
  // min_j (...). Negating back gives max_j (f[j] − a(x−j)²).
  let k = 0;
  vArr[0] = 0;
  zArr[0] = -Infinity;
  zArr[1] = Infinity;
  const g = (j: number) => -f[j];
  for (let q = 1; q < n; q++) {
    let s: number;
    for (;;) {
      const p = vArr[k];
      s = ((g(q) + a * q * q) - (g(p) + a * p * p)) / (2 * a * (q - p));
      if (s <= zArr[k]) k--;
      else break;
    }
    k++;
    vArr[k] = q;
    zArr[k] = s;
    zArr[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (zArr[k + 1] < q) k++;
    const p = vArr[q < 0 ? 0 : k];
    // min-envelope value at q from the nearest qualifying parabola, but clamp to
    // the physical window: only parabolas within `cap` cells contribute.
    let best = Infinity;
    // The envelope's winning parabola:
    const dq = q - p;
    if (Math.abs(dq) <= cap) best = g(p) + a * dq * dq;
    // The envelope guarantees the global min, but the cap may exclude it; fall
    // back to a bounded local scan only when the winner is outside the window.
    if (best === Infinity) {
      const lo = q - cap < 0 ? 0 : q - cap;
      const hi = q + cap >= n ? n - 1 : q + cap;
      for (let j = lo; j <= hi; j++) {
        const val = g(j) + a * (q - j) * (q - j);
        if (val < best) best = val;
      }
    }
    out[q] = best === Infinity ? f[q] : -best;
  }
}

// ----------------------------------------------------------------------------
// Toolpath generation
// ----------------------------------------------------------------------------
//
// Both roughing and finishing share one travel-minimizing strategy:
//
//   1. Build an ENGAGED mask over the heightmap grid (a boolean per cell that is
//      true only where the tool should cut — for roughing: a covered cell whose
//      surface lies below the clearing level; for finishing: a covered cell whose
//      surface lies below the stock top).  Cuts and plunges can ONLY happen on
//      engaged cells, so the tool can never plunge/cut into air or background.
//   2. CONNECTED-COMPONENT the engaged mask (4-connectivity) so each disjoint
//      feature (separate islands, the two sides of a hole, etc.) is its own piece.
//   3. Cut each component with a continuous serpentine; row-to-row and span-to-span
//      LINKS are validated cell-by-cell against the engaged mask, so a link only
//      stays down when every cell it crosses is engaged (already-clear material).
//      Otherwise the tool lifts to safe-Z, repositions over a real engaged cell,
//      and re-plunges.  This collapses the old "retract on every row" behaviour.
//   4. ORDER the components by nearest-neighbour from the previous exit point, so
//      the rapids between disjoint cuts are short instead of crossing the bed.
//
// The grid is indexed by cell (ix,iy); world coords are derived from the heightmap
// origin/pitch.  We raster along the cell grid (one row = one heightmap row or a
// stepover-spaced subset) rather than independent world sampling, which keeps the
// engaged test and the link test on exactly the same cells.

/** A connected component of engaged cells, as a list of per-row runs. */
interface CompRun {
  iy: number; // grid row
  ix0: number; // first engaged cell ix (inclusive)
  ix1: number; // last engaged cell ix (inclusive)
}
interface Component {
  runs: CompRun[]; // grouped by iy, ascending
  iyMin: number;
  iyMax: number;
  cx: number; // centroid world X (for ordering)
  cy: number; // centroid world Y
  cells: number; // engaged cell count (used-rows view) — for noise gating / stats
}

/**
 * Remove STL-noise specks from a FULL-RESOLUTION engaged mask, in place. Real
 * triangle-soup meshes carry tiny isolated slivers/specks (a stray up-facing
 * facet a fraction of a tool-width across); left in, each speck becomes its own
 * component and earns a spurious plunge ("random drilling in random places").
 *
 * We flood-fill the FULL-resolution mask (every grid cell, not just the pass's
 * stepover rows) into 4-connected blobs and clear any blob whose area is below a
 * conservative threshold tied to the tool: a feature the tool can't even sit on
 * (smaller than a fraction of the tool's own footprint disc) can't be machined
 * meaningfully, so cutting it only drills noise. The threshold is deliberately
 * small (≈ 1/8 of the tool-disc area, floored at a few cells) so genuine small
 * details survive while single / small-cluster specks are dropped.
 *
 * Returns the number of cells cleared (for stats / warnings).
 */
function denoiseEngaged(
  engaged: Uint8Array,
  nx: number,
  ny: number,
  dx: number,
  dy: number,
  toolDiameter: number,
): number {
  const r = Math.max(toolDiameter / 2, dx, dy);
  // Tool-disc footprint area in cells; a real machinable feature occupies a
  // sensible fraction of it. 1/8 of the disc, floored at 4 cells, keeps the gate
  // conservative (small real features stay) while killing 1–3 cell specks.
  const discCells = (Math.PI * r * r) / (dx * dy);
  const minCells = Math.max(4, Math.round(discCells / 8));

  const seen = new Uint8Array(nx * ny);
  const stack: number[] = [];
  let cleared = 0;
  for (let s = 0; s < engaged.length; s++) {
    if (!engaged[s] || seen[s]) continue;
    // Flood this blob, recording its cells; clear it if it's below threshold.
    stack.length = 0;
    stack.push(s);
    seen[s] = 1;
    const blob: number[] = [];
    while (stack.length) {
      const c = stack.pop() as number;
      blob.push(c);
      const x = c % nx;
      const y = (c / nx) | 0;
      if (x > 0 && engaged[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; stack.push(c - 1); }
      if (x < nx - 1 && engaged[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; stack.push(c + 1); }
      if (y > 0 && engaged[c - nx] && !seen[c - nx]) { seen[c - nx] = 1; stack.push(c - nx); }
      if (y < ny - 1 && engaged[c + nx] && !seen[c + nx]) { seen[c + nx] = 1; stack.push(c + nx); }
    }
    if (blob.length < minCells) {
      for (const c of blob) engaged[c] = 0;
      cleared += blob.length;
    }
  }
  return cleared;
}

/**
 * Label the engaged mask into 4-connected components, but only at the rows used
 * by this pass (rows spaced `rowStride` cells apart). Connectivity is tested on
 * adjacent USED rows (so two stepover rows of the same feature merge) and on
 * adjacent cells within a row. Returns components with per-used-row runs.
 *
 * `engaged` is a Uint8Array of length nx*ny; `usedRows` is the ascending list of
 * grid-row indices this pass scans.
 */
function labelComponents(
  engaged: Uint8Array,
  nx: number,
  usedRows: number[],
  x0: number,
  y0: number,
  dx: number,
  dy: number,
): Component[] {
  // Extract runs per used row.
  interface Run {
    iy: number;
    ix0: number;
    ix1: number;
    comp: number; // component id (union-find index), -1 until assigned
  }
  const runsByRowIdx: Run[][] = [];
  for (const iy of usedRows) {
    const base = iy * nx;
    const rowRuns: Run[] = [];
    let start = -1;
    for (let ix = 0; ix < nx; ix++) {
      const on = engaged[base + ix] !== 0;
      if (on && start < 0) start = ix;
      else if (!on && start >= 0) {
        rowRuns.push({ iy, ix0: start, ix1: ix - 1, comp: -1 });
        start = -1;
      }
    }
    if (start >= 0) rowRuns.push({ iy, ix0: start, ix1: nx - 1, comp: -1 });
    runsByRowIdx.push(rowRuns);
  }

  // Union-find over runs.
  const parent: number[] = [];
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  let nextId = 0;
  for (const rowRuns of runsByRowIdx) {
    for (const r of rowRuns) {
      r.comp = nextId;
      parent[nextId] = nextId;
      nextId++;
    }
  }
  // Merge vertically adjacent used rows whose runs overlap in ix.
  for (let r = 1; r < runsByRowIdx.length; r++) {
    const prev = runsByRowIdx[r - 1];
    const cur = runsByRowIdx[r];
    for (const a of cur) {
      for (const b of prev) {
        if (a.ix0 <= b.ix1 && a.ix1 >= b.ix0) union(a.comp, b.comp);
      }
    }
  }

  // Gather runs per root component.
  const byRoot = new Map<number, CompRun[]>();
  for (const rowRuns of runsByRowIdx) {
    for (const r of rowRuns) {
      const root = find(r.comp);
      let arr = byRoot.get(root);
      if (!arr) byRoot.set(root, (arr = []));
      arr.push({ iy: r.iy, ix0: r.ix0, ix1: r.ix1 });
    }
  }

  const comps: Component[] = [];
  for (const runs of byRoot.values()) {
    runs.sort((p, q) => (p.iy - q.iy) || (p.ix0 - q.ix0));
    let iyMin = Infinity;
    let iyMax = -Infinity;
    let sx = 0;
    let sy = 0;
    let cells = 0;
    for (const run of runs) {
      if (run.iy < iyMin) iyMin = run.iy;
      if (run.iy > iyMax) iyMax = run.iy;
      const n = run.ix1 - run.ix0 + 1;
      sx += (x0 + ((run.ix0 + run.ix1) / 2) * dx) * n;
      sy += (y0 + run.iy * dy) * n;
      cells += n;
    }
    comps.push({ runs, iyMin, iyMax, cx: cells ? sx / cells : 0, cy: cells ? sy / cells : 0, cells });
  }
  return comps;
}

/**
 * Cut one connected component as a continuous serpentine. `zAt(ix,iy)` returns the
 * cut Z for a cell (flat `level` for roughing, the surface height for finishing).
 * `engaged` gates every move: a link stays DOWN only while every cell it crosses is
 * engaged; otherwise the tool lifts to safe-Z and re-plunges over the next run.
 *
 * Returns the world exit point so the caller can order the next component by
 * nearest-neighbour and emit the inter-component rapid itself.
 */
/** Region-entry / pattern options threaded into {@link cutComponent}. */
interface CutEntryOpts {
  /** 'ramp' (linear zig-zag), 'helix', or legacy 'plunge'. */
  strategy: 'ramp' | 'helix' | 'plunge';
  /** Max ramp angle from horizontal (degrees). */
  rampAngleDeg: number;
  /** Hard cap on a single straight-down vertical plunge (mm). */
  maxStraightPlungeMm: number;
  /** Tangential lead-in distance at region entry (mm); 0 = off. */
  leadInMm: number;
  /** Cut Z at the stock top (mm); ramp descends FROM here toward the target. */
  topZ: number;
  /**
   * The HIGHEST Z the tool may already be at when it begins descending into this
   * region without striking un-cut material above it (mm). For roughing this is
   * the previously-cleared level (= current level + one stepdown, capped at the
   * stock top); for finishing it is the stock top. The ramp's total vertical drop
   * is `entryStartZ − target`, so a roughing entry only ever ramps one stepdown.
   */
  entryStartZ: number;
  /** True for finishing (surface-following) — ramps must ride the surface. */
  surfaceMode: boolean;
  /**
   * One-way / climb raster: every run is entered from the SAME (low) end so the
   * tool sweeps in a single direction for a consistent surface finish (all-climb
   * or all-conventional), at the cost of a return link per row. Default false
   * (serpentine — alternates direction, mixing climb + conventional).
   */
  oneWay?: boolean;
}

function cutComponent(
  tp: Toolpath,
  comp: Component,
  engaged: Uint8Array,
  nx: number,
  x0: number,
  y0: number,
  dx: number,
  dy: number,
  safeZ: number,
  zAt: (ix: number, iy: number) => number,
  startFlip: boolean,
  cutLink: boolean, // true → in-material links cut at level (roughing); false → ride surface (finishing)
  entry: CutEntryOpts,
): { exitX: number; exitY: number; flip: boolean } {
  const wx = (ix: number) => x0 + ix * dx;
  const wy = (iy: number) => y0 + iy * dy;
  // Horizontal cell pitch along a run's scan axis (X for the normal grid; the
  // transposed finishing path passes its own swapped dx/dy so this stays correct).
  const cellPitch = Math.max(dx, 1e-6);

  let down = false;
  let curIx = 0;
  let curIy = 0;
  let exitX = comp.cx;
  let exitY = comp.cy;
  let flip = startFlip;

  /**
   * Is the straight cell-path between two cells fully engaged? Sampled at 4× cell
   * resolution (super-cover-ish) so a diagonal link can't slip across a corner gap
   * that a coarse DDA would miss — every cell the segment passes near must be on.
   */
  const segEngaged = (ax: number, ay: number, bx: number, by: number): boolean => {
    const span = Math.max(Math.abs(bx - ax), Math.abs(by - ay));
    if (span === 0) return inBoundsEngaged(ax, ay);
    const steps = Math.max(2, Math.ceil(span * 4));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const ix = Math.round(ax + (bx - ax) * t);
      const iy = Math.round(ay + (by - ay) * t);
      if (!inBoundsEngaged(ix, iy)) return false;
    }
    return true;
  };
  const inBoundsEngaged = (ix: number, iy: number): boolean =>
    ix >= 0 && iy >= 0 && ix < nx && iy * nx + ix < engaged.length && engaged[iy * nx + ix] !== 0;

  /**
   * Can the tool stay DOWN moving from (ax,ay) to (bx,by) WITHOUT crossing air?
   * A straight link is preferred; when it would cross a gap we also try the two
   * axis-aligned L-paths (X-then-Y and Y-then-X). The serpentine commonly links a
   * row's far end to the next row's near end, which is an L (along, then up) that
   * stays entirely on engaged stock even though the diagonal chord clips a corner.
   * Returns the ordered list of intermediate cell waypoints to traverse (excluding
   * the start, including the end) when a fully-engaged route exists, else null.
   */
  const engagedLink = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): [number, number][] | null => {
    if (segEngaged(ax, ay, bx, by)) return [[bx, by]];
    // X-then-Y: move along the start row to bx, then up the column to by.
    if (segEngaged(ax, ay, bx, ay) && segEngaged(bx, ay, bx, by)) return [[bx, ay], [bx, by]];
    // Y-then-X: move up the start column to by, then along to bx.
    if (segEngaged(ax, ay, ax, by) && segEngaged(ax, by, bx, by)) return [[ax, by], [bx, by]];
    // Last resort: a bounded breadth-first search through engaged cells finds ANY
    // staircase route that stays on stock when the straight/L links clip an air
    // gap (e.g. a thin neck joining two lobes of one feature). Bounded to a window
    // around the two endpoints so it can never scan the whole grid. The cell path
    // is collapsed to its turn points so the link emits few vertices.
    const path = bfsEngagedPath(ax, ay, bx, by);
    return path;
  };

  /**
   * Bounded BFS over engaged cells (4-connected) from (ax,ay) to (bx,by). Searches
   * only a window padded around the endpoints so it can never scan the whole grid
   * (and bails after a cap on visited cells). Returns the route as TURN-POINT
   * waypoints (excluding the start, including the end) when reachable, else null.
   */
  const bfsEngagedPath = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
  ): [number, number][] | null => {
    if (!inBoundsEngaged(ax, ay) || !inBoundsEngaged(bx, by)) return null;
    // Window: the endpoints' bbox padded by PAD cells, clamped to the grid. A
    // detour worth keeping the tool down for is short; a long way round would
    // travel farther than a safe-Z hop, so we cap the window tightly.
    const PAD = 8;
    const ny = (engaged.length / nx) | 0;
    const wMinX = Math.max(0, Math.min(ax, bx) - PAD);
    const wMaxX = Math.min(nx - 1, Math.max(ax, bx) + PAD);
    const wMinY = Math.max(0, Math.min(ay, by) - PAD);
    const wMaxY = Math.min(ny - 1, Math.max(ay, by) + PAD);
    const ww = wMaxX - wMinX + 1;
    const wh = wMaxY - wMinY + 1;
    const MAX_VISIT = 4096;
    if (ww * wh > MAX_VISIT * 2) return null;
    const idx = (x: number, y: number) => (y - wMinY) * ww + (x - wMinX);
    const prev = new Int32Array(ww * wh).fill(-1);
    const seen = new Uint8Array(ww * wh);
    const queue = new Int32Array(ww * wh);
    let qh = 0;
    let qt = 0;
    const startI = idx(ax, ay);
    seen[startI] = 1;
    prev[startI] = startI;
    queue[qt++] = startI;
    const goalI = idx(bx, by);
    let found = false;
    let visited = 0;
    while (qh < qt && visited < MAX_VISIT) {
      const ci = queue[qh++];
      visited++;
      if (ci === goalI) {
        found = true;
        break;
      }
      const cx = (ci % ww) + wMinX;
      const cy = ((ci / ww) | 0) + wMinY;
      const nb: [number, number][] = [
        [cx + 1, cy],
        [cx - 1, cy],
        [cx, cy + 1],
        [cx, cy - 1],
      ];
      for (const [nxp, nyp] of nb) {
        if (nxp < wMinX || nxp > wMaxX || nyp < wMinY || nyp > wMaxY) continue;
        if (!inBoundsEngaged(nxp, nyp)) continue;
        const ni = idx(nxp, nyp);
        if (seen[ni]) continue;
        seen[ni] = 1;
        prev[ni] = ci;
        queue[qt++] = ni;
      }
    }
    if (!found) return null;
    // Reconstruct the full cell path start→goal, then collapse to turn points.
    const cells: [number, number][] = [];
    let ci = goalI;
    while (ci !== startI) {
      cells.push([(ci % ww) + wMinX, ((ci / ww) | 0) + wMinY]);
      ci = prev[ci];
    }
    cells.reverse(); // now start-exclusive, goal-inclusive
    const way: [number, number][] = [];
    for (let i = 0; i < cells.length; i++) {
      const isLast = i === cells.length - 1;
      if (isLast) {
        way.push(cells[i]);
        break;
      }
      // Keep a waypoint only where the direction changes (a corner).
      const px2 = i === 0 ? ax : cells[i - 1][0];
      const py2 = i === 0 ? ay : cells[i - 1][1];
      const [cx2, cy2] = cells[i];
      const [nx2, ny2] = cells[i + 1];
      const turn = (cx2 - px2) * (ny2 - cy2) - (cy2 - py2) * (nx2 - cx2);
      if (turn !== 0) way.push(cells[i]);
    }
    return way.length ? way : [[bx, by]];
  };

  const retract = () => {
    if (down) {
      tp.rapid({ x: wx(curIx), y: wy(curIy), z: safeZ });
      down = false;
    }
  };
  const tanRamp = Math.tan((Math.max(1, Math.min(30, entry.rampAngleDeg)) * Math.PI) / 180);
  const maxStraight = Math.max(0, entry.maxStraightPlungeMm);

  /**
   * Descend into a region at the start of `run` (entry cell `eIx`) WITHOUT a deep
   * vertical plunge. Strategy (hardware safety):
   *   • RAMP — zig-zag back and forth along the run's engaged cells while
   *     descending, capped at the configured plunge angle, ending back at the
   *     entry cell at the target depth so the following `cutRun` proceeds normally.
   *   • HELIX — when the run is too short to ramp, spiral down a tiny engaged box.
   *   • Any residual vertical move is capped at `maxStraightPlungeMm`.
   * Leaves the tool DOWN at (eIx, run.iy) at the entry-cell cut depth.
   */
  const enterAt = (run: CompRun, eIx: number) => {
    const iy = run.iy;
    const ry = wy(iy);
    const zTarget = zAt(eIx, iy);
    const startZ = Math.min(entry.entryStartZ, entry.topZ);
    const drop = startZ - zTarget; // >= 0 normally
    // Rapid to safe-Z over the entry first (guaranteed clearance).
    tp.rapid({ x: wx(eIx), y: ry, z: safeZ });

    const far = eIx === run.ix0 ? run.ix1 : run.ix0;
    const dir = far >= eIx ? 1 : -1;
    const runCells = Math.abs(far - eIx); // cells available to ramp along
    const runSpanMm = runCells * cellPitch;

    // No meaningful descent (already shallow) or strategy disabled → STEPPED
    // vertical plunge, each step capped at maxStraightPlungeMm. (Previously this
    // path emitted a SINGLE plunge straight to zTarget, ignoring the cap on the
    // 'plunge' strategy / deep-drop case — a tool-breakage hazard. When drop is
    // already within the cap this is exactly one move, unchanged.)
    if (drop <= maxStraight + 1e-6 || entry.strategy === 'plunge' || tanRamp <= 1e-6) {
      if (startZ < safeZ - 1e-6) tp.rapid({ x: wx(eIx), y: ry, z: startZ });
      const cap = maxStraight > 1e-6 ? maxStraight : Math.abs(drop) + 1;
      let zNow = startZ;
      while (zNow - zTarget > cap + 1e-6) {
        zNow -= cap;
        tp.plunge({ x: wx(eIx), y: ry, z: zNow });
      }
      tp.plunge({ x: wx(eIx), y: ry, z: zTarget });
      down = true; curIx = eIx; curIy = iy;
      return;
    }

    const neededMm = drop / tanRamp; // horizontal travel for the full descent

    if (runCells >= 1 && entry.strategy !== 'helix' && runSpanMm > cellPitch * 0.5) {
      // RAMP: zig-zag out-and-back along the run, descending linearly, ending back
      // at the entry cell at zTarget so the following cutRun starts there. An even
      // leg count returns to the entry side; legs grow to keep the angle ≤ limit.
      let legs = Math.max(2, Math.ceil(neededMm / Math.max(runSpanMm, cellPitch)));
      if (legs % 2 === 1) legs += 1;
      const usableCells = runCells;
      if (startZ < safeZ - 1e-6) tp.rapid({ x: wx(eIx), y: ry, z: startZ });
      tp.feed({ x: wx(eIx), y: ry, z: startZ }); // first contact = a cut, not a rapid
      let leg = 0;
      let zSoFar = startZ;
      const zPerLeg = drop / legs;
      let atIx = eIx;
      while (leg < legs) {
        const goingOut = leg % 2 === 0;
        const dest = goingOut ? eIx + dir * usableCells : eIx;
        const zEnd = zSoFar - zPerLeg;
        const stepN = Math.max(1, Math.abs(dest - atIx));
        for (let s = 1; s <= stepN; s++) {
          const t = s / stepN;
          const cix = Math.round(atIx + (dest - atIx) * t);
          const zLin = zSoFar + (zEnd - zSoFar) * t;
          const zCell = zAt(cix, iy);
          // Never gouge below the local reachable Z (surface) / target (flat level).
          const zSafe = entry.surfaceMode ? Math.max(zLin, zCell) : Math.max(zLin, zTarget);
          tp.feed({ x: wx(cix), y: ry, z: zSafe });
        }
        atIx = dest;
        zSoFar = zEnd;
        leg++;
      }
      tp.feed({ x: wx(eIx), y: ry, z: zTarget }); // finish exactly at entry/target
      down = true; curIx = eIx; curIy = iy;
      return;
    }

    // HELIX fallback: the run is too short to ramp.
    helixDown(eIx, iy, startZ, zTarget);
    down = true;
  };

  /**
   * Descend in a tight helix (square micro-spiral) over engaged cells around
   * (eIx,iy) from `startZ` down to `zTarget`. Falls back to a capped stepped
   * vertical plunge (≤ maxStraightPlungeMm per move) when no engaged box exists.
   */
  const helixDown = (eIx: number, iy: number, startZ: number, zTarget: number) => {
    const ry = wy(iy);
    const box: [number, number][] = [];
    let haveLoop = false;
    for (const ox of [1, -1]) {
      for (const oy of [1, -1]) {
        if (
          inBoundsEngaged(eIx, iy) && inBoundsEngaged(eIx + ox, iy) &&
          inBoundsEngaged(eIx + ox, iy + oy) && inBoundsEngaged(eIx, iy + oy)
        ) {
          box.length = 0;
          box.push([eIx, iy], [eIx + ox, iy], [eIx + ox, iy + oy], [eIx, iy + oy]);
          haveLoop = true;
          break;
        }
      }
      if (haveLoop) break;
    }
    const drop = startZ - zTarget;
    if (haveLoop && drop > maxStraight + 1e-6) {
      if (startZ < safeZ - 1e-6) tp.rapid({ x: wx(box[0][0]), y: wy(box[0][1]), z: startZ });
      const perimeterMm = box.length * cellPitch;
      const neededMm = drop / Math.max(tanRamp, 1e-6);
      const loops = Math.max(1, Math.ceil(neededMm / Math.max(perimeterMm, cellPitch)));
      const steps = loops * box.length;
      let zNow = startZ;
      const zPer = drop / steps;
      tp.feed({ x: wx(box[0][0]), y: wy(box[0][1]), z: startZ });
      let k = 0;
      for (let i = 0; i < steps; i++) {
        k = (k + 1) % box.length;
        zNow -= zPer;
        const [cx, cy] = box[k];
        const zSafe = entry.surfaceMode ? Math.max(zNow, zAt(cx, cy)) : Math.max(zNow, zTarget);
        tp.feed({ x: wx(cx), y: wy(cy), z: zSafe });
      }
      tp.feed({ x: wx(eIx), y: ry, z: zTarget });
      curIx = eIx; curIy = iy;
      return;
    }
    // Last resort: stepped vertical plunge capped at maxStraightPlungeMm per move.
    if (startZ < safeZ - 1e-6) tp.rapid({ x: wx(eIx), y: ry, z: startZ });
    let zNow = startZ;
    const cap = maxStraight > 1e-6 ? maxStraight : Math.abs(drop) + 1;
    while (zNow - zTarget > cap + 1e-6) {
      zNow -= cap;
      tp.plunge({ x: wx(eIx), y: ry, z: zNow });
    }
    tp.plunge({ x: wx(eIx), y: ry, z: zTarget });
    curIx = eIx; curIy = iy;
  };
  // Collinearity tolerance for collapsing consecutive feed vertices that lie on a
  // straight line in the run's (X, Z) plane (Y is constant along a row). A flat
  // roughing run is perfectly collinear so it collapses to a single endpoint feed;
  // a surface-following finishing run only collapses runs of cells that genuinely
  // share a slope, so curvature is preserved. This removes ~99% of the redundant
  // per-cell feed points on flat clearing passes without altering tool motion.
  const COLLINEAR_TOL = 1e-4; // mm of allowed Z deviation from the straight chord
  /** Cut along a run, entering at `entryIx` and exiting at the far end. */
  const cutRun = (run: CompRun, entryIx: number) => {
    const toIx = entryIx === run.ix0 ? run.ix1 : run.ix0;
    const stepDir = toIx >= entryIx ? 1 : -1;
    const ry = wy(run.iy);
    if (entryIx === toIx) {
      tp.feed({ x: wx(entryIx), y: ry, z: zAt(entryIx, run.iy) });
    } else {
      // Walk the run, but only emit a vertex when the upcoming cell is NOT
      // collinear (in X–Z) with the pending straight segment. We keep a "segment
      // start" point and look ahead: while the next cell stays on the line from
      // the segment start through the current cell, we extend; on a slope change
      // we flush the current cell as a vertex and start a new segment there.
      let segStartIx = entryIx;
      let segStartZ = zAt(entryIx, run.iy);
      tp.feed({ x: wx(entryIx), y: ry, z: segStartZ }); // entry vertex
      let prevIx = entryIx;
      let prevZ = segStartZ;
      for (let ix = entryIx + stepDir; ; ix += stepDir) {
        const zHere = zAt(ix, run.iy);
        const last = ix === toIx;
        // Is `prev` collinear with the chord from segStart to (ix, zHere)?
        // Linear-interpolate the chord's Z at prevIx and compare.
        const denom = ix - segStartIx;
        const zChord =
          denom === 0 ? segStartZ : segStartZ + (zHere - segStartZ) * ((prevIx - segStartIx) / denom);
        const collinear = Math.abs(prevZ - zChord) <= COLLINEAR_TOL;
        if (!collinear) {
          // The chord can't pass through prev — flush prev as a real vertex and
          // begin a fresh segment there.
          tp.feed({ x: wx(prevIx), y: ry, z: prevZ });
          segStartIx = prevIx;
          segStartZ = prevZ;
        }
        if (last) {
          tp.feed({ x: wx(ix), y: ry, z: zHere });
          break;
        }
        prevIx = ix;
        prevZ = zHere;
      }
    }
    curIx = toIx;
    curIy = run.iy;
    exitX = wx(toIx);
    exitY = wy(run.iy);
  };

  /**
   * Emit a stay-DOWN link following the engaged waypoints (excludes start). The
   * tool NEVER lifts to safe-Z here — that is what keeps adjacent serpentine rows
   * joined into one continuous cut instead of a retract/replunge per row.
   *
   * Roughing (`cutLink`): the cleared floor is flat at `level`, so the link is
   * just feed moves across already-cleared stock at the cut depth.
   *
   * Finishing: the link rides the SURFACE across already-cut stock with feed moves
   * — following the surface Z cell-by-cell between turn-points so a curved surface
   * isn't gouged or skipped. This replaces the old lift-to-linkZ + re-plunge per
   * row (which generated a plunge cycle on every single row link); now a whole
   * connected region is one continuous on-surface serpentine with no Z cycling.
   */
  const linkDown = (way: [number, number][]) => {
    if (cutLink) {
      for (const [lx, ly] of way) tp.feed({ x: wx(lx), y: wy(ly), z: zAt(lx, ly) });
    } else {
      // Walk the cells between successive turn-points, emitting a surface-riding
      // feed at each so the link tracks the relief instead of chording over it.
      let fromX = curIx;
      let fromY = curIy;
      for (const [lx, ly] of way) {
        const span = Math.max(Math.abs(lx - fromX), Math.abs(ly - fromY));
        const steps = Math.max(1, span);
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const cx = Math.round(fromX + (lx - fromX) * t);
          const cy = Math.round(fromY + (ly - fromY) * t);
          tp.feed({ x: wx(cx), y: wy(cy), z: zAt(cx, cy) });
        }
        fromX = lx;
        fromY = ly;
      }
    }
    const last = way[way.length - 1];
    curIx = last[0];
    curIy = last[1];
    down = true;
  };

  // Serpentine-ordered traversal of the component's runs. Runs are grouped by row
  // (already sorted ascending by (iy, ix0)); we walk rows top-to-bottom and inside
  // each row alternate the X sweep direction (boustrophedon) so the exit of one
  // row sits next to the entry of the next — the classic minimal-travel raster.
  // Between consecutive runs we try to stay DOWN via an engaged route (straight or
  // an L of engaged cells); only when NO engaged route exists do we lift to safe-Z
  // and re-plunge. Plunges therefore land ONLY on engaged cells (real stock) and
  // happen once per disconnected piece, not once per row — killing the spurious
  // "random drill" plunges and the long air rapids they caused.
  // Greedy nearest-endpoint traversal of the component's runs: each step picks the
  // unused run whose nearest endpoint is closest to the tool, enters there, and
  // exits the far end. Within a solid block this naturally degenerates to a
  // boustrophedon (each next row's near end is closest); on fragmented relief or an
  // annulus it follows physical proximity so links are SHORT — short links are the
  // ones most likely to stay engaged. Between consecutive runs we try to stay DOWN
  // via an engaged route (straight, or an L of engaged cells along the grid); only
  // when NO engaged route exists do we lift to safe-Z and re-plunge. Plunges
  // therefore land ONLY on engaged cells (real stock) and happen once per truly
  // disconnected piece — not once per row — killing the spurious "random drill"
  // plunges and the long air rapids they caused.
  const allRuns = comp.runs.slice();
  const used = new Uint8Array(allRuns.length);

  if (entry.oneWay) {
    // ONE-WAY / CLIMB raster: walk runs in (iy, ix0) order and ALWAYS enter at the
    // low-X end so every row sweeps the SAME direction (consistent climb-or-
    // conventional surface). The row-to-row return is an engaged link when one
    // exists (stays down), else a safe-Z hop — never re-cuts in the opposite sense.
    const order = allRuns
      .map((_, i) => i)
      .sort((a, b) => (allRuns[a].iy - allRuns[b].iy) || (allRuns[a].ix0 - allRuns[b].ix0));
    for (const i of order) {
      const run = allRuns[i];
      const entryIx = run.ix0; // always the same end → single sweep direction
      if (!down) {
        enterAt(run, entryIx);
      } else {
        const way = engagedLink(curIx, curIy, entryIx, run.iy);
        if (way) linkDown(way);
        else {
          retract();
          enterAt(run, entryIx);
        }
      }
      cutRun(run, entryIx);
    }
    retract();
    flip = !flip;
    return { exitX, exitY, flip };
  }

  // Seed the walk near the requested serpentine corner so abutting components and
  // levels chain naturally (flip picks which X end of the top row to start from).
  const farX = (flip ? 1 : -1) * (Math.abs(x0) + nx * Math.abs(dx) + 1e6);
  let px = farX;
  let py = wy(comp.iyMin);
  let placed = 0;
  while (placed < allRuns.length) {
    // Find the nearest unused run endpoint to (px,py).
    let bestRun = -1;
    let bestEntryIx = 0;
    let bestD = Infinity;
    for (let i = 0; i < allRuns.length; i++) {
      if (used[i]) continue;
      const run = allRuns[i];
      const ry = wy(run.iy);
      for (const eIx of run.ix0 === run.ix1 ? [run.ix0] : [run.ix0, run.ix1]) {
        const ex = wx(eIx);
        const d = (ex - px) * (ex - px) + (ry - py) * (ry - py);
        if (d < bestD) {
          bestD = d;
          bestRun = i;
          bestEntryIx = eIx;
        }
      }
    }
    const run = allRuns[bestRun];
    used[bestRun] = 1;
    placed++;
    if (!down) {
      enterAt(run, bestEntryIx);
    } else {
      const way = engagedLink(curIx, curIy, bestEntryIx, run.iy);
      if (way) linkDown(way);
      else {
        retract();
        enterAt(run, bestEntryIx);
      }
    }
    cutRun(run, bestEntryIx);
    px = exitX;
    py = exitY;
  }
  retract();
  // Toggle the serpentine seed corner for the next component/level.
  flip = !flip;
  return { exitX, exitY, flip };
}

/**
 * Collapse STRICTLY-collinear interior vertices in a finished toolpath, in place,
 * returning the same {@link Toolpath} for chaining. This is a final, purely
 * geometric clean-up of the redundant per-cell vertices the raster generator
 * emits where several code paths meet (a run's collinear merge stops at the
 * run's ends, but the LINKS between rows — `linkDown` — and the RAMP entries —
 * `enterAt` — emit one vertex per grid cell with no merging, and the junction
 * where a cut meets the next link is also un-merged). On a flat clearing floor or
 * any straight surface run those vertices lie exactly on the straight segment
 * between their neighbours, so dropping them changes NO tool motion whatsoever.
 *
 * Why this is provably safe (do-no-harm):
 *   • A vertex is removed ONLY when it lies on the segment between its two
 *     neighbours to within `tol` (default 1e-4 mm — a tenth of the emitter's
 *     finest coordinate step) AND its projection falls inside that segment, i.e.
 *     the cutter passes through the exact same point at the exact same time.
 *   • The neighbours on BOTH sides must share the vertex's move TYPE, so a
 *     Rapid (safe-Z retract / inter-region hop) can never be merged away or
 *     across — every real lift-to-safe-Z and re-plunge is preserved verbatim,
 *     and a Feed↔Plunge transition is never collapsed.
 *   • Endpoints are always kept. Curvature (a genuine slope change on the relief
 *     surface) exceeds `tol` and is preserved exactly.
 *
 * Because it works on emitted vertices rather than the generation strategy, it
 * catches the link/ramp/junction redundancy uniformly without altering cut
 * geometry or the safe-Z behaviour.
 */
export function simplifyToolpath(tp: Toolpath, tol = 1e-4): Toolpath {
  const src = tp.moves;
  if (src.length < 3) return tp;
  // Distance of point b from the segment a→c (0 when b is on the line through
  // a,c). Returns Infinity when b projects OUTSIDE the segment so we never drop a
  // vertex the cutter actually turns around at (a spike / hairpin).
  const offSegment = (a: Vec3, b: Vec3, c: Vec3): number => {
    const acx = c.x - a.x, acy = c.y - a.y, acz = c.z - a.z;
    const acl2 = acx * acx + acy * acy + acz * acz;
    if (acl2 < 1e-18) {
      // Degenerate segment (a≈c): b is redundant only if it also coincides.
      return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    }
    const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
    const t = (abx * acx + aby * acy + abz * acz) / acl2;
    if (t < -1e-6 || t > 1 + 1e-6) return Infinity; // projects beyond the segment
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    return Math.hypot(cx, cy, cz) / Math.sqrt(acl2);
  };

  const out: typeof src = [src[0]];
  for (let i = 1; i < src.length - 1; i++) {
    const prev = out[out.length - 1];
    const cur = src[i];
    const next = src[i + 1];
    // Only ever drop an interior vertex flanked by SAME-type moves (never merge
    // away or across a Rapid retract or a Feed↔Plunge transition), and only when
    // it lies exactly on the straight segment joining its neighbours.
    //
    // CRITICAL: NEVER collapse Plunge vertices. A safe descent is emitted as a
    // STEPPED sequence of collinear (straight-down) Plunge moves each capped at
    // maxStraightPlungeMm; they are perfectly collinear and same-type, so merging
    // them would fuse the steps back into ONE deep straight plunge — defeating the
    // hardware safety cap. The stepping is intentional, so plunges are preserved.
    if (
      cur.type !== MoveType.Plunge &&
      cur.type === prev.type &&
      cur.type === next.type &&
      offSegment(prev.target, cur.target, next.target) <= tol
    ) {
      continue; // redundant — the kept segment passes through it unchanged
    }
    out.push(cur);
  }
  out.push(src[src.length - 1]);
  tp.moves = out;
  return tp;
}

/**
 * Order components to minimise inter-component RAPID travel. A greedy
 * nearest-neighbour tour from the start point is refined with a bounded 2-opt
 * pass (segment reversals that shorten the tour) — this cuts the criss-cross
 * rapids the pure greedy tour leaves on fragmented reliefs (e.g. 6.stl's 152
 * regions) without ever touching the cuts themselves, so the no-air-plunge
 * guarantee is untouched. Pure (no mutation of the inputs).
 */
function orderComponents(comps: Component[], startX: number, startY: number): Component[] {
  // 1. Greedy nearest-neighbour seed tour.
  const remaining = comps.slice();
  const out: Component[] = [];
  let px = startX;
  let py = startY;
  while (remaining.length) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = (remaining[i].cx - px) ** 2 + (remaining[i].cy - py) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    const c = remaining.splice(best, 1)[0];
    out.push(c);
    px = c.cx;
    py = c.cy;
  }

  // 2. Bounded 2-opt refinement. Reversing the tour segment [i..k] removes the
  // edges (i-1,i) and (k,k+1) and re-adds (i-1,k) and (i,k+1); apply whenever that
  // shortens the path. The start point is a fixed virtual node 0 so the first
  // component still chains from the previous exit. Capped passes keep it O(n²·P)
  // with a small P, negligible vs the carve compute and skipped for huge counts.
  const n = out.length;
  if (n < 4 || n > 4000) return out;
  const dist = (a: { cx: number; cy: number } | null, b: { cx: number; cy: number }): number => {
    const ax = a ? a.cx : startX;
    const ay = a ? a.cy : startY;
    return Math.hypot(b.cx - ax, b.cy - ay);
  };
  const at = (i: number) => (i < 0 ? null : out[i]);
  let improved = true;
  let passes = 0;
  const MAX_PASSES = 6;
  while (improved && passes < MAX_PASSES) {
    improved = false;
    passes++;
    for (let i = 0; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = at(i - 1);
        const b = out[i];
        const c = out[k];
        const d = k + 1 < n ? out[k + 1] : null;
        const before = dist(a, b) + (d ? dist(c, d) : 0);
        const after = dist(a, c) + (d ? dist(b, d) : 0);
        if (after + 1e-9 < before) {
          // Reverse out[i..k] in place.
          let lo = i;
          let hi = k;
          while (lo < hi) {
            const t = out[lo];
            out[lo] = out[hi];
            out[hi] = t;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
  return out;
}

/**
 * Roughing: descend in stepdown layers from just under the top surface to the
 * carve floor. At each level the engaged region (covered cells whose surface lies
 * below the level) is connected-component labelled and each component is cleared
 * with a continuous serpentine; components are ordered nearest-neighbour so the
 * rapids between them are short. Plunges/cuts only ever land on engaged cells.
 */
function buildRoughing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; levels: number } {
  const tp = new Toolpath();
  tp.name = '3D Roughing';
  const { nx, ny, dx, dy, z, covered } = hm;
  // Roughing clears bulk stock, so it may use a coarser stepover than finishing.
  const roughStep =
    params.roughStepover && params.roughStepover > 0 ? params.roughStepover : params.stepover;
  const step = Math.max(roughStep, dx, 0.1);
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);
  const safeZ = params.safeZ;
  const cutTol = 1e-3;

  // Rows used by this pass: every `rowStride`-th grid row (stepover spacing).
  const rowStride = Math.max(1, Math.round(step / dy));
  const usedRows: number[] = [];
  for (let iy = 0; iy < ny; iy += rowStride) usedRows.push(iy);
  if (usedRows[usedRows.length - 1] !== ny - 1) usedRows.push(ny - 1);

  // Descending Z levels (each a flat clearing plane). HONEST LEVELS: build from
  // the ACTUAL carved relief depth (the dilated/clamped `deepest`), NOT from the
  // maxDepth parameter — so a shallow relief never emits a stack of empty deep
  // passes (e.g. a 0.8mm relief no longer produces ~10 phantom levels). The relief
  // can't go below the carve floor, so the deepest level is whichever is higher.
  const reqStepdown = params.stepdown > 0 ? params.stepdown : Math.max(params.maxDepth, 0.1);
  const roughFloor = Math.max(floorZ, Number.isFinite(hm.deepest) ? hm.deepest : floorZ);
  const reliefDepth = Math.max(0, hm.zTop - roughFloor);
  // ADAPTIVE STEPDOWN: the first clearing plane sits one stepdown below the stock
  // top, so a SHALLOW relief whose depth ≲ stepdown gets only one usable level and
  // roughing barely engages (the whole 0..-stepdown top band is dumped on the
  // finishing pass). Shrink the EFFECTIVE stepdown so a shallow relief still gets
  // several clearing planes (≈ DESIRED_LEVELS), while a deep relief keeps the
  // requested material stepdown unchanged (min() picks reqStepdown there). Floored
  // so we never emit a pathological number of micro-levels.
  const DESIRED_LEVELS = 4;
  const MIN_STEPDOWN = 0.2;
  const MAX_LEVELS = 400; // hard cap (guards tiny-stepdown blow-ups / the line cap)
  let stepdown = reqStepdown;
  if (reliefDepth > 1e-6) {
    stepdown = Math.min(reqStepdown, Math.max(MIN_STEPDOWN, reliefDepth / DESIRED_LEVELS));
    // Never exceed MAX_LEVELS even for a deliberately tiny requested stepdown.
    if (reliefDepth / stepdown > MAX_LEVELS) stepdown = reliefDepth / MAX_LEVELS;
  }
  const levels: number[] = [];
  let zL = hm.zTop - stepdown;
  while (zL > roughFloor + 1e-6) {
    levels.push(zL);
    zL -= stepdown;
  }
  // Only add the floor as a real level when it lies meaningfully below the last
  // loop level — otherwise it engages zero cells (it IS the deepest surface) and
  // just wastes a labelling pass + inflates the reported level count.
  const lastLevel = levels.length ? levels[levels.length - 1] : hm.zTop;
  if (lastLevel - roughFloor > 1e-6) levels.push(roughFloor);

  // Minimum engaged-cell count (used-rows view) for a component to be worth a
  // plunge: at least one tool diameter of travel along a single scan row. Below
  // this, a "component" is a noise sliver, not a feature.
  const minCompCells = Math.max(2, Math.round(params.toolDiameter / Math.max(dx, 1e-6)));

  const engaged = new Uint8Array(nx * ny);
  let startX = hm.minX;
  let startY = hm.minY;
  let flip = false;

  for (const level of levels) {
    // Build the engaged mask for this level: covered, below the stock top, and
    // with material still BELOW the clearing plane (so we don't gouge the relief).
    engaged.fill(0);
    let any = false;
    for (let i = 0; i < engaged.length; i++) {
      if (covered[i] && z[i] < -cutTol && z[i] < level - 1e-6) {
        engaged[i] = 1;
        any = true;
      }
    }
    if (!any) continue;

    // Drop STL-noise specks before labelling so they never earn a plunge.
    denoiseEngaged(engaged, nx, ny, dx, dy, params.toolDiameter);

    const zAt = (): number => level; // flat clearing plane
    // RAMP ENTRY: the previous level already cleared down to `level + stepdown`
    // (capped at the stock top), so the tool may descend a ramp from there to this
    // level without striking un-cut material — only one stepdown of descent.
    const entry: CutEntryOpts = {
      strategy: params.plungeStrategy ?? 'ramp',
      rampAngleDeg: params.rampAngleDeg ?? 3,
      maxStraightPlungeMm: params.maxStraightPlungeMm ?? 0.5,
      leadInMm: params.leadInMm ?? 0,
      topZ: hm.zTop,
      entryStartZ: Math.min(hm.zTop, level + stepdown),
      surfaceMode: false,
    };
    let comps = labelComponents(engaged, nx, usedRows, hm.minX, hm.minY, dx, dy);
    // Secondary gate: a component whose USED-ROW footprint is below ~one tool
    // width of cut is a sliver the full-res denoise didn't catch — skip it.
    comps = comps.filter((c) => c.cells >= minCompCells);
    comps = orderComponents(comps, startX, startY);
    for (const comp of comps) {
      const r = cutComponent(
        tp, comp, engaged, nx, hm.minX, hm.minY, dx, dy, safeZ, zAt, flip, true, entry,
      );
      startX = r.exitX;
      startY = r.exitY;
      flip = r.flip;
    }
  }

  // Final geometry-preserving clean-up: drop strictly-collinear interior vertices
  // (flat clearing floors collapse a whole run + link to its endpoints) without
  // touching any retract / plunge.
  simplifyToolpath(tp);
  return { tp, levels: levels.length };
}

/**
 * Finishing: a continuous serpentine raster that rides the heightmap surface. The
 * engaged region (covered cells whose surface lies below the stock top) is
 * connected-component labelled; each component is cut with a serpentine that
 * follows the surface cell-by-cell and links rows while staying on the surface
 * (only over already-engaged cells). Components are ordered nearest-neighbour.
 */
function buildFinishing(hm: Heightmap, params: Carve3DParams): { tp: Toolpath; lines: number } {
  const tp = new Toolpath();
  tp.name = '3D Finishing';
  const { nx, ny, dx, dy, z, covered } = hm;
  const step = Math.max(params.stepover, 0.05);
  const safeZ = params.safeZ;
  const floorZ = hm.zTop - Math.max(0, params.maxDepth);
  const cutTol = 1e-3;
  const clampZ = (v: number) => (v < floorZ ? floorZ : v > hm.zTop ? hm.zTop : v);
  const alongX = params.finishDir === 'x';

  // Engaged mask: covered cells whose surface dips below the stock top.
  const engaged = new Uint8Array(nx * ny);
  let any = false;
  for (let i = 0; i < engaged.length; i++) {
    if (covered[i] && z[i] < -cutTol) {
      engaged[i] = 1;
      any = true;
    }
  }
  if (!any) return { tp, lines: 0 };

  // Drop STL-noise specks (isolated 1–few-cell slivers) before labelling so they
  // never earn a spurious plunge ("random drilling").
  denoiseEngaged(engaged, nx, ny, dx, dy, params.toolDiameter);
  // Minimum engaged-cell count for a component to be worth a plunge (≈ one tool
  // width along a scan line). Below this it is a sliver, not a feature.
  const minCompCells = Math.max(2, Math.round(params.toolDiameter / Math.max(dx, dy, 1e-6)));

  // zAt follows the surface; finishing links ride just above the local surface.
  const zAt = (ix: number, iy: number) => clampZ(z[iy * nx + ix]);

  // Entry options shared by both raster directions: ramp/helix into the surface
  // (no deep vertical plunge) and honour the climb / one-way finishing pattern.
  const entry: CutEntryOpts = {
    strategy: params.plungeStrategy ?? 'ramp',
    rampAngleDeg: params.rampAngleDeg ?? 3,
    maxStraightPlungeMm: params.maxStraightPlungeMm ?? 0.5,
    leadInMm: params.leadInMm ?? 0,
    topZ: hm.zTop,
    entryStartZ: hm.zTop, // finishing has no prior clearing — ramp from the top
    surfaceMode: true,
    oneWay: (params.finishPattern ?? 'serpentine') === 'climb',
  };

  // The serpentine scans along X (rows of constant Y) or along Y (transpose).
  // For the 'y' direction we relabel with a transposed view by swapping axes in
  // the run extraction; simplest is to treat usedRows as the FIXED-axis lines.
  if (alongX) {
    // FLOOR (not round): the raster line spacing is rowStride*dy, and `round` can
    // overshoot — leaving lines WIDER than the requested stepover (visibly sparse
    // passes). floor picks the largest stride whose spacing is ≤ the stepover, so
    // lines are at-or-finer-than requested, never coarser. (For the usual grid,
    // pitch = stepover/2 so floor and round both give 2 — unchanged.) If the grid
    // is so coarse (large model clamped) that even one cell exceeds the stepover,
    // the stepover simply can't be honored at this resolution — warn.
    if (dy > step + 1e-6) {
      hm.warnings.push(
        `Finishing stepover (${step.toFixed(2)}mm) is finer than the heightmap grid (${dy.toFixed(2)}mm) — the model is large vs the stepover, so lines are spaced at the grid pitch. Use a coarser stepover or a smaller model.`,
      );
    }
    const rowStride = Math.max(1, Math.floor(step / dy + 1e-6));
    const usedRows: number[] = [];
    for (let iy = 0; iy < ny; iy += rowStride) usedRows.push(iy);
    if (usedRows[usedRows.length - 1] !== ny - 1) usedRows.push(ny - 1);

    let comps = labelComponents(engaged, nx, usedRows, hm.minX, hm.minY, dx, dy);
    comps = comps.filter((c) => c.cells >= minCompCells);
    comps = orderComponents(comps, hm.minX, hm.minY);
    let flip = false;
    for (const comp of comps) {
      const r = cutComponent(
        tp, comp, engaged, nx, hm.minX, hm.minY, dx, dy, safeZ, zAt, flip, false, entry,
      );
      flip = r.flip;
    }
    // Report the number of raster scan-lines (used rows) that carried material.
    let lines = 0;
    for (const iy of usedRows) {
      const base = iy * nx;
      for (let ix = 0; ix < nx; ix++) {
        if (engaged[base + ix]) { lines++; break; }
      }
    }
    simplifyToolpath(tp);
    return { tp, lines };
  }

  // alongX === false: scan along Y. Build a transposed engaged mask + transposed
  // height accessor so the same row-based machinery walks columns of the grid.
  const tEngaged = new Uint8Array(nx * ny); // dims: tnx=ny, tny=nx
  const tnx = ny;
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      tEngaged[ix * tnx + iy] = engaged[iy * nx + ix];
    }
  }
  if (dx > step + 1e-6) {
    hm.warnings.push(
      `Finishing stepover (${step.toFixed(2)}mm) is finer than the heightmap grid (${dx.toFixed(2)}mm) — lines are spaced at the grid pitch. Use a coarser stepover or a smaller model.`,
    )
  }
  const colStride = Math.max(1, Math.floor(step / dx + 1e-6));
  const usedCols: number[] = [];
  for (let ix = 0; ix < nx; ix += colStride) usedCols.push(ix);
  if (usedCols[usedCols.length - 1] !== nx - 1) usedCols.push(nx - 1);

  // In the transposed grid: row index = original ix, cell index = original iy.
  // World origin/pitch swap so wx/wy in cutComponent map back to real X/Y.
  let comps = labelComponents(tEngaged, tnx, usedCols, hm.minY, hm.minX, dy, dx);
  comps = comps.filter((c) => c.cells >= minCompCells);
  comps = orderComponents(comps, hm.minY, hm.minX);
  // zAt in transposed space: (tix=origIy, tiy=origIx) → world handled by swap.
  const zAtT = (tix: number, tiy: number) => clampZ(z[tix * nx + tiy]);
  // cutComponent uses wx=x0+ix*dx etc.; pass swapped origins/pitches and a
  // post-swap remap by emitting through a proxy toolpath then swapping XY.
  const tmp = new Toolpath();
  let flip = false;
  for (const comp of comps) {
    const r = cutComponent(
      tmp, comp, tEngaged, tnx, hm.minY, hm.minX, dy, dx, safeZ, zAtT, flip, false, entry,
    );
    flip = r.flip;
  }
  // Swap X/Y of every emitted move back into real world space.
  for (const m of tmp.moves) {
    tp.moves.push({ type: m.type, target: { x: m.target.y, y: m.target.x, z: m.target.z } });
  }
  // Report the number of raster scan-lines (used columns) that carried material.
  let lines = 0;
  for (const ix of usedCols) {
    for (let iy = 0; iy < ny; iy++) {
      if (engaged[iy * nx + ix]) { lines++; break; }
    }
  }
  simplifyToolpath(tp);
  return { tp, lines };
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
  const hmWarnCount = hm.warnings.length; // pass-time warnings (below) are collected later
  warnings.push(...hm.warnings);
  result.heightmap = hm;
  result.gridX = hm.nx;
  result.gridY = hm.ny;

  if (mesh.triangleCount > MAX_CARVE_TRIANGLES) {
    return result; // refused; warning already pushed
  }

  // FINISH-ONLY FAST PATH: roughing only pays off when the relief is deeper than a
  // single stepdown. When the WHOLE relief fits in one finishing pass depth, the
  // finishing raster removes everything itself — skip the roughing scaffold (and
  // its plunges/levels) for a faster, cleaner program. Honours an explicit
  // doRoughing=false from the caller too.
  const stepdown = params.stepdown > 0 ? params.stepdown : Math.max(params.maxDepth, 0.1);
  const reliefDepth = Math.max(0, -(Number.isFinite(hm.deepest) ? hm.deepest : 0));
  const roughingWorthwhile = reliefDepth > stepdown + 1e-6;
  if (params.doRoughing && roughingWorthwhile) {
    const { tp, levels } = buildRoughing(hm, params);
    if (!tp.isEmpty()) result.toolpaths.push(tp);
    result.roughLevels = levels;
  }
  if (params.doFinishing) {
    const { tp, lines } = buildFinishing(hm, params);
    if (!tp.isEmpty()) result.toolpaths.push(tp);
    result.finishLines = lines;
  }
  // Surface any warnings the roughing/finishing passes appended to the heightmap
  // (e.g. "stepover finer than the grid") that weren't present at build time.
  if (hm.warnings.length > hmWarnCount) warnings.push(...hm.warnings.slice(hmWarnCount));

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
        // NOTE: append by loop — `bodies.push(label, ...body)` spreads `body` as
        // function arguments, which throws RangeError (max call stack) once a job
        // exceeds ~125k lines (a fine-stepover/deep job), aborting the whole carve.
        bodies.push(`(${job.name})`);
        for (const l of body) bodies.push(l);
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
