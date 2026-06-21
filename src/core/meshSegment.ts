// Mesh surface segmentation — UI-independent, pure TypeScript.
// No React / DOM / three.js imports here (mirrors the Qt cadcam lib split).
//
// Splits a triangle-soup STL mesh into connected near-coplanar FACE REGIONS so
// the carving UI can let the user apply a per-surface preset (mirroring how 2D
// drawings apply presets per closed/open LOOP). The approach is "auto flat/
// planar regions":
//
//   1. QUANTIZE vertex positions to merge coincident verts (STLs don't index —
//      each triangle carries its own copy of every vertex).
//   2. Build triangle ADJACENCY by shared (quantized) edges.
//   3. REGION-GROW (flood fill) where two adjacent triangles merge only when the
//      dihedral angle between their face normals is within `angleTolDeg`.
//   4. For each region compute area, area-weighted normal, centroid, 3D bbox,
//      whether it is roughly horizontal (normal ≈ ±Z → `planar`), and a
//      representative top Z (max Z over the region for an up-facing surface).
//   5. Drop negligible specks (area < `minAreaFrac` of total), sort by area
//      descending and cap to `maxRegions` so the picker UI stays sane.
//
// `regionOutlineXY` projects a (roughly horizontal) region's boundary to XY and
// assembles closed polyline(s) — these feed the existing 2D CAM ops (clear-out /
// pocket / profile / cutout) for that flat surface.

import { Polyline, distance } from './geometry';
import type { StlMesh } from './slicer';
import { STL_STRIDE } from './slicer';

// ---- Hard safety caps so a pathological mesh can never hang the UI ----------
/**
 * Above this triangle count we DECIMATE the mesh for segmentation (sample a
 * subset of triangles) rather than refuse — the regions stay representative and
 * the picker is still useful, while adjacency build stays bounded. Picked to be
 * well under carve3d's MAX_CARVE_TRIANGLES so segmentation never out-costs a
 * carve.
 */
export const MAX_SEGMENT_TRIANGLES = 200_000;

export interface SurfaceRegion {
  /** Stable id (= sorted position; assigned after the area-desc sort). */
  id: number;
  /** Triangle indices (into the mesh's triangle array) owned by this region. */
  triIndices: number[];
  /** Area-weighted unit normal. */
  normal: [number, number, number];
  /** Area-weighted centroid (world coords). */
  centroid: [number, number, number];
  /** 3D axis-aligned bounds of the region's vertices. */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  /** Total triangle area (mm²). */
  area: number;
  /** True when the region normal is within tolerance of ±Z (a horizontal face). */
  planar: boolean;
  /** Representative top Z (max region Z for an up-facing surface). */
  z: number;
}

export interface SegmentOptions {
  /** Max dihedral angle (deg) for two adjacent tris to join one region. */
  angleTolDeg?: number;
  /** Drop regions below this fraction of total mesh area. */
  minAreaFrac?: number;
  /** Cap on returned regions (keeps the picker UI sane). */
  maxRegions?: number;
  /** Tolerance (deg) of a region normal from ±Z to count as `planar`. */
  planarTolDeg?: number;
}

const DEFAULTS: Required<SegmentOptions> = {
  angleTolDeg: 14,
  minAreaFrac: 0.005,
  maxRegions: 32,
  planarTolDeg: 12,
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface TriGeom {
  /** Original triangle index. */
  idx: number;
  /** Three vertices [ax,ay,az, bx,by,bz, cx,cy,cz]. */
  v: number[];
  /** Unit face normal. */
  n: [number, number, number];
  /** Triangle area (mm²). */
  area: number;
}

function faceNormalArea(v: number[]): { n: [number, number, number]; area: number } {
  const ux = v[3] - v[0], uy = v[4] - v[1], uz = v[5] - v[2];
  const wx = v[6] - v[0], wy = v[7] - v[1], wz = v[8] - v[2];
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  const area = len / 2;
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
  return { n: [nx, ny, nz], area };
}

/** Read the triangle geometry list, optionally decimating a too-dense mesh. */
function readTriangles(mesh: StlMesh): { tris: TriGeom[]; decimated: boolean } {
  const data = mesh.triangles;
  const stride3 = STL_STRIDE * 3;
  const total = mesh.triangleCount;
  // Decimate by striding when the mesh is too dense for a bounded adjacency build.
  const step = total > MAX_SEGMENT_TRIANGLES ? Math.ceil(total / MAX_SEGMENT_TRIANGLES) : 1;
  const tris: TriGeom[] = [];
  for (let t = 0; t < total; t += step) {
    const o = t * stride3;
    const v = [
      data[o], data[o + 1], data[o + 2],
      data[o + STL_STRIDE], data[o + STL_STRIDE + 1], data[o + STL_STRIDE + 2],
      data[o + STL_STRIDE * 2], data[o + STL_STRIDE * 2 + 1], data[o + STL_STRIDE * 2 + 2],
    ];
    const { n, area } = faceNormalArea(v);
    if (area <= 1e-12) continue; // degenerate sliver
    tris.push({ idx: t, v, n, area });
  }
  return { tris, decimated: step > 1 };
}

/** Quantize a coordinate for coincident-vertex / shared-edge matching. */
function quant(value: number, q: number): number {
  return Math.round(value / q);
}

// ----------------------------------------------------------------------------
// Segmentation
// ----------------------------------------------------------------------------

/**
 * Segment a mesh into connected near-coplanar surface regions. Returns a single
 * "whole surface" region when the mesh is empty/degenerate so callers always
 * have something assignable.
 */
export function segmentSurfaces(mesh: StlMesh, opts: SegmentOptions = {}): SurfaceRegion[] {
  const o = { ...DEFAULTS, ...opts };
  if (mesh.triangleCount === 0) return [];

  const { tris } = readTriangles(mesh);
  if (tris.length === 0) return [];

  // Quantization pitch: a small fraction of the bbox diagonal so coincident
  // vertices merge but distinct ones stay distinct.
  const diag = Math.hypot(
    mesh.bbox.max[0] - mesh.bbox.min[0],
    mesh.bbox.max[1] - mesh.bbox.min[1],
    mesh.bbox.max[2] - mesh.bbox.min[2],
  );
  const q = Math.max(diag * 1e-5, 1e-5);

  // Map each undirected (quantized) edge → the triangle-list indices touching it.
  const edgeMap = new Map<string, number[]>();
  const edgeKey = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): string => {
    const ka = `${quant(ax, q)},${quant(ay, q)},${quant(az, q)}`;
    const kb = `${quant(bx, q)},${quant(by, q)},${quant(bz, q)}`;
    return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
  };
  for (let i = 0; i < tris.length; i++) {
    const v = tris[i].v;
    const e = [
      edgeKey(v[0], v[1], v[2], v[3], v[4], v[5]),
      edgeKey(v[3], v[4], v[5], v[6], v[7], v[8]),
      edgeKey(v[6], v[7], v[8], v[0], v[1], v[2]),
    ];
    for (const k of e) {
      const arr = edgeMap.get(k);
      if (arr) arr.push(i);
      else edgeMap.set(k, [i]);
    }
  }

  // Build per-triangle adjacency from shared edges.
  const adj: number[][] = tris.map(() => []);
  for (const list of edgeMap.values()) {
    if (list.length < 2) continue;
    // An edge may be shared by >2 tris on non-manifold meshes; link all pairs.
    for (let a = 0; a < list.length; a++)
      for (let b = a + 1; b < list.length; b++) {
        adj[list[a]].push(list[b]);
        adj[list[b]].push(list[a]);
      }
  }

  const cosTol = Math.cos((o.angleTolDeg * Math.PI) / 180);

  // Flood fill: grow a region across adjacent tris whose normals are within tol.
  const regionOf = new Int32Array(tris.length).fill(-1);
  const rawRegions: number[][] = [];
  const stack: number[] = [];
  for (let s = 0; s < tris.length; s++) {
    if (regionOf[s] >= 0) continue;
    const rid = rawRegions.length;
    const members: number[] = [];
    stack.length = 0;
    stack.push(s);
    regionOf[s] = rid;
    while (stack.length) {
      const c = stack.pop() as number;
      members.push(c);
      const cn = tris[c].n;
      for (const nb of adj[c]) {
        if (regionOf[nb] >= 0) continue;
        const nn = tris[nb].n;
        const dot = cn[0] * nn[0] + cn[1] * nn[1] + cn[2] * nn[2];
        if (dot >= cosTol) {
          regionOf[nb] = rid;
          stack.push(nb);
        }
      }
    }
    rawRegions.push(members);
  }

  // Build region descriptors (area-weighted normal/centroid, bbox, planar, z).
  let totalArea = 0;
  for (const t of tris) totalArea += t.area;

  interface Built {
    triIndices: number[];
    normal: [number, number, number];
    centroid: [number, number, number];
    bbox: { min: [number, number, number]; max: [number, number, number] };
    area: number;
  }
  const built: Built[] = [];
  for (const members of rawRegions) {
    let area = 0;
    let nx = 0, ny = 0, nz = 0;
    let cx = 0, cy = 0, cz = 0;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const triIndices: number[] = [];
    for (const mi of members) {
      const t = tris[mi];
      triIndices.push(t.idx);
      area += t.area;
      nx += t.n[0] * t.area; ny += t.n[1] * t.area; nz += t.n[2] * t.area;
      // Triangle centroid weighted by area.
      const tcx = (t.v[0] + t.v[3] + t.v[6]) / 3;
      const tcy = (t.v[1] + t.v[4] + t.v[7]) / 3;
      const tcz = (t.v[2] + t.v[5] + t.v[8]) / 3;
      cx += tcx * t.area; cy += tcy * t.area; cz += tcz * t.area;
      for (let k = 0; k < 3; k++) {
        const x = t.v[k * 3], y = t.v[k * 3 + 1], z = t.v[k * 3 + 2];
        if (x < min[0]) min[0] = x; if (y < min[1]) min[1] = y; if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x; if (y > max[1]) max[1] = y; if (z > max[2]) max[2] = z;
      }
    }
    if (area <= 1e-9) continue;
    const nlen = Math.hypot(nx, ny, nz) || 1;
    built.push({
      triIndices,
      normal: [nx / nlen, ny / nlen, nz / nlen],
      centroid: [cx / area, cy / area, cz / area],
      bbox: { min, max },
      area,
    });
  }

  // Drop negligible specks (their tris fall back to whole-mesh relief).
  const minArea = totalArea * o.minAreaFrac;
  let kept = built.filter((b) => b.area >= minArea);
  if (kept.length === 0) kept = built; // keep everything if all were tiny

  // Sort by area desc and cap to maxRegions.
  kept.sort((a, b) => b.area - a.area);
  if (kept.length > o.maxRegions) kept = kept.slice(0, o.maxRegions);

  const planarCos = Math.cos((o.planarTolDeg * Math.PI) / 180);
  return kept.map((b, i): SurfaceRegion => {
    const planar = Math.abs(b.normal[2]) >= planarCos;
    // Representative Z: top of the region for an up-facing surface, else centroid Z.
    const z = b.normal[2] >= 0 ? b.bbox.max[2] : b.centroid[2];
    return {
      id: i,
      triIndices: b.triIndices,
      normal: b.normal,
      centroid: b.centroid,
      bbox: b.bbox,
      area: b.area,
      planar,
      z,
    };
  });
}

// ----------------------------------------------------------------------------
// Region outline (XY)
// ----------------------------------------------------------------------------

/**
 * Project a region's boundary to XY and assemble it into closed polyline(s).
 * Boundary edges are those belonging to exactly ONE triangle of the region (an
 * interior edge is shared by two region triangles and cancels). The surviving
 * edges are stitched into closed loops by endpoint adjacency (quantized).
 *
 * This is meant for roughly HORIZONTAL regions; the XY projection of a sloped or
 * vertical region is a degenerate sliver and the caller should fall back to the
 * relief path for those (see `region.planar`).
 */
export function regionOutlineXY(mesh: StlMesh, region: SurfaceRegion): Polyline[] {
  const data = mesh.triangles;
  const stride3 = STL_STRIDE * 3;

  const diag = Math.hypot(
    mesh.bbox.max[0] - mesh.bbox.min[0],
    mesh.bbox.max[1] - mesh.bbox.min[1],
  );
  const q = Math.max(diag * 1e-5, 1e-5);
  const vkey = (x: number, y: number) => `${quant(x, q)},${quant(y, q)}`;

  // Count each undirected XY edge over the region's triangles; boundary edges
  // appear exactly once. Keep a representative coordinate per quantized endpoint.
  const edgeCount = new Map<string, number>();
  const edgeEndpoints = new Map<string, [string, string]>();
  const coord = new Map<string, { x: number; y: number }>();

  const addEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const ka = vkey(x0, y0);
    const kb = vkey(x1, y1);
    if (!coord.has(ka)) coord.set(ka, { x: x0, y: y0 });
    if (!coord.has(kb)) coord.set(kb, { x: x1, y: y1 });
    if (ka === kb) return;
    const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    edgeCount.set(key, (edgeCount.get(key) ?? 0) + 1);
    if (!edgeEndpoints.has(key)) edgeEndpoints.set(key, [ka, kb]);
  };

  for (const t of region.triIndices) {
    const o = t * stride3;
    const ax = data[o], ay = data[o + 1];
    const bx = data[o + STL_STRIDE], by = data[o + STL_STRIDE + 1];
    const cx = data[o + STL_STRIDE * 2], cy = data[o + STL_STRIDE * 2 + 1];
    addEdge(ax, ay, bx, by);
    addEdge(bx, by, cx, cy);
    addEdge(cx, cy, ax, ay);
  }

  // Boundary adjacency: quantized vertex → its boundary-edge neighbours.
  const nbr = new Map<string, string[]>();
  for (const [key, count] of edgeCount) {
    if (count !== 1) continue; // interior edge
    const [ka, kb] = edgeEndpoints.get(key)!;
    (nbr.get(ka) ?? nbr.set(ka, []).get(ka)!).push(kb);
    (nbr.get(kb) ?? nbr.set(kb, []).get(kb)!).push(ka);
  }

  // Walk closed loops over the boundary graph.
  const visited = new Set<string>(); // visited directed edges "a>b"
  const polys: Polyline[] = [];
  for (const start of nbr.keys()) {
    const startNbrs = nbr.get(start)!;
    for (const first of startNbrs) {
      if (visited.has(`${start}>${first}`)) continue;
      const loop: string[] = [start];
      let prev = start;
      let cur = first;
      let guard = 0;
      const maxGuard = edgeCount.size * 2 + 8;
      while (guard++ < maxGuard) {
        visited.add(`${prev}>${cur}`);
        loop.push(cur);
        if (cur === start) break;
        const opts = nbr.get(cur) ?? [];
        // Prefer a neighbour that isn't where we came from and isn't traversed.
        let next: string | null = null;
        for (const cand of opts) {
          if (cand === prev) continue;
          if (visited.has(`${cur}>${cand}`)) continue;
          next = cand;
          break;
        }
        if (next === null) {
          // Dead end — allow stepping back only to close a 2-edge spur.
          next = opts.find((c) => !visited.has(`${cur}>${c}`)) ?? null;
        }
        if (next === null) break;
        prev = cur;
        cur = next;
      }
      if (loop.length >= 4 && loop[loop.length - 1] === start) {
        const pl = new Polyline();
        for (let i = 0; i < loop.length - 1; i++) {
          const c = coord.get(loop[i]);
          if (c) pl.add({ x: c.x, y: c.y });
        }
        // Drop a trailing duplicate.
        if (
          pl.points.length >= 4 &&
          distance(pl.points[0], pl.points[pl.points.length - 1]) <= q * 2
        )
          pl.points.pop();
        if (pl.points.length >= 3) {
          pl.closed = true;
          polys.push(pl);
        }
      }
    }
  }

  // Keep the largest loops first (the outer boundary before holes).
  polys.sort((a, b) => Math.abs(b.signedArea()) - Math.abs(a.signedArea()));
  return polys;
}
