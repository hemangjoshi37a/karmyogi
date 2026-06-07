// FDM 3D-printing core — UI-independent, pure TypeScript.
// No React / DOM / three.js imports here (mirrors the Qt cadcam lib split).
//
// Pipeline:
//   parseStl()   ASCII or binary STL  -> triangle soup (+ normals) + bbox
//   sliceMesh()  triangle soup        -> per-layer { perimeters, infill }
//   sliceToGcode() slice result       -> standard 3D-printer G-code
//
// This is intentionally a *basic* FDM slicer: planar slicing, contour stitching,
// inset perimeters (via the shared polygon offsetter) and alternating 0/90°
// rectilinear infill. It is NOT a production slicer (no supports, no adaptive
// layers, no bridging, no proper non-manifold healing). It is robust enough to
// turn a clean watertight STL into runnable G-code for a GRBL-based printer.

import { Point, Polyline, BBox, distance } from './geometry';
import { offsetPolygon } from './offset';

// ---- Hard safety caps so a pathological mesh can never hang the UI ----------
/** Refuse to slice meshes larger than this (triangles). */
export const MAX_TRIANGLES = 2_000_000;
/** Never produce more than this many layers. */
export const MAX_LAYERS = 20_000;
/** Per-layer segment cap (stitching guard). */
export const MAX_SEGMENTS_PER_LAYER = 200_000;

// ============================================================================
// STL parsing
// ============================================================================

export interface StlMesh {
  /** Interleaved vertex data: [x,y,z, nx,ny,nz] per vertex, 3 vertices/triangle. */
  triangles: Float32Array;
  /** Number of vertices (= triangleCount * 3). */
  vertexCount: number;
  /** Axis-aligned bounding box over X/Y; min/max Z tracked separately. */
  bbox: { min: [number, number, number]; max: [number, number, number] };
  triangleCount: number;
  /** Detected source format. */
  format: 'binary' | 'ascii';
}

/** Per-vertex stride in the interleaved triangle array (3 pos + 3 normal). */
export const STL_STRIDE = 6;

/**
 * Heuristically decide if a buffer is ASCII STL. A binary STL is an 80-byte
 * header + uint32 count + 50 bytes/triangle; an ASCII STL starts with "solid".
 * We can't trust "solid" alone (some binary exporters write it in the header),
 * so we cross-check the binary size formula.
 */
function isAsciiStl(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 84) return true; // too small to be valid binary -> try ASCII
  // Sniff the first few non-space chars for the "solid" keyword.
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) i++;
  const head = String.fromCharCode(...bytes.slice(i, i + 5)).toLowerCase();
  const startsSolid = head === 'solid';
  // Binary size check: header(80) + count(4) + count*50.
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  const expectedBinarySize = 84 + triCount * 50;
  const sizeMatchesBinary = expectedBinarySize === bytes.length;
  // If the size matches the binary formula exactly, treat as binary even if it
  // happens to start with "solid". Otherwise, if it starts with solid -> ASCII.
  if (sizeMatchesBinary) return false;
  return startsSolid;
}

function emptyBBox() {
  return {
    min: [Infinity, Infinity, Infinity] as [number, number, number],
    max: [-Infinity, -Infinity, -Infinity] as [number, number, number],
  };
}

function expandBBox(bb: { min: number[]; max: number[] }, x: number, y: number, z: number): void {
  if (x < bb.min[0]) bb.min[0] = x;
  if (y < bb.min[1]) bb.min[1] = y;
  if (z < bb.min[2]) bb.min[2] = z;
  if (x > bb.max[0]) bb.max[0] = x;
  if (y > bb.max[1]) bb.max[1] = y;
  if (z > bb.max[2]) bb.max[2] = z;
}

function computeFaceNormal(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz);
  if (len > 1e-12) { nx /= len; ny /= len; nz /= len; }
  return [nx, ny, nz];
}

function parseBinaryStl(buffer: ArrayBuffer): StlMesh {
  const dv = new DataView(buffer);
  const triCount = dv.getUint32(80, true);
  if (triCount > MAX_TRIANGLES) {
    throw new Error(`STL has ${triCount} triangles (cap ${MAX_TRIANGLES}); refusing to load.`);
  }
  const out = new Float32Array(triCount * 3 * STL_STRIDE);
  const bb = emptyBBox();
  let o = 0;
  let off = 84;
  for (let t = 0; t < triCount; t++) {
    // 12 bytes face normal, then 3 vertices * 12 bytes, then 2 bytes attr.
    let nx = dv.getFloat32(off, true);
    let ny = dv.getFloat32(off + 4, true);
    let nz = dv.getFloat32(off + 8, true);
    off += 12;
    const v: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(off, true);
      const y = dv.getFloat32(off + 4, true);
      const z = dv.getFloat32(off + 8, true);
      off += 12;
      v.push(x, y, z);
      expandBBox(bb, x, y, z);
    }
    off += 2; // attribute byte count
    // Recompute normal if the stored one is degenerate.
    if (!(Math.hypot(nx, ny, nz) > 0.5)) {
      [nx, ny, nz] = computeFaceNormal(v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], v[8]);
    }
    for (let k = 0; k < 3; k++) {
      out[o++] = v[k * 3];
      out[o++] = v[k * 3 + 1];
      out[o++] = v[k * 3 + 2];
      out[o++] = nx;
      out[o++] = ny;
      out[o++] = nz;
    }
  }
  return finalizeMesh(out, triCount, bb, 'binary');
}

function parseAsciiStl(buffer: ArrayBuffer): StlMesh {
  const text = new TextDecoder().decode(buffer);
  // Pull out every floating-point number that follows a "vertex" token, in order.
  // We walk facet blocks to keep normals associated correctly.
  const verts: number[] = [];
  const faceNormals: number[] = [];
  // Tokenize cheaply with a regex stream over the whole text.
  const tokenRe = /(facet\s+normal|vertex|endfacet)|(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  let mode: 'normal' | 'vertex' | null = null;
  let pending: number[] = [];
  let curNormal: [number, number, number] = [0, 0, 0];
  let curFaceVerts: number[] = [];

  const flushFace = () => {
    if (curFaceVerts.length >= 9) {
      // Use first 3 vertices (assume triangulated facets).
      const f = curFaceVerts.slice(0, 9);
      let n = curNormal;
      if (!(Math.hypot(n[0], n[1], n[2]) > 0.5)) {
        n = computeFaceNormal(f[0], f[1], f[2], f[3], f[4], f[5], f[6], f[7], f[8]);
      }
      verts.push(...f);
      faceNormals.push(n[0], n[1], n[2]);
    }
    curFaceVerts = [];
    curNormal = [0, 0, 0];
  };

  while ((m = tokenRe.exec(text)) !== null) {
    if (m[1]) {
      const kw = m[1].toLowerCase();
      if (kw.startsWith('facet')) {
        flushFace(); // close any previous (defensive)
        mode = 'normal';
        pending = [];
      } else if (kw === 'vertex') {
        mode = 'vertex';
        pending = [];
      } else if (kw === 'endfacet') {
        flushFace();
        mode = null;
      }
    } else if (m[2] != null) {
      const num = parseFloat(m[2]);
      if (mode === 'normal') {
        pending.push(num);
        if (pending.length === 3) {
          curNormal = [pending[0], pending[1], pending[2]];
          pending = [];
          mode = null;
        }
      } else if (mode === 'vertex') {
        pending.push(num);
        if (pending.length === 3) {
          curFaceVerts.push(pending[0], pending[1], pending[2]);
          pending = [];
          mode = null;
        }
      }
    }
    if (verts.length / 9 > MAX_TRIANGLES) {
      throw new Error(`ASCII STL exceeds triangle cap ${MAX_TRIANGLES}; refusing to load.`);
    }
  }
  flushFace();

  const triCount = Math.floor(verts.length / 9);
  const out = new Float32Array(triCount * 3 * STL_STRIDE);
  const bb = emptyBBox();
  let o = 0;
  for (let t = 0; t < triCount; t++) {
    const fb = t * 9;
    const nx = faceNormals[t * 3], ny = faceNormals[t * 3 + 1], nz = faceNormals[t * 3 + 2];
    for (let k = 0; k < 3; k++) {
      const x = verts[fb + k * 3];
      const y = verts[fb + k * 3 + 1];
      const z = verts[fb + k * 3 + 2];
      expandBBox(bb, x, y, z);
      out[o++] = x; out[o++] = y; out[o++] = z;
      out[o++] = nx; out[o++] = ny; out[o++] = nz;
    }
  }
  return finalizeMesh(out, triCount, bb, 'ascii');
}

function finalizeMesh(
  triangles: Float32Array,
  triangleCount: number,
  bb: { min: number[]; max: number[] },
  format: 'binary' | 'ascii',
): StlMesh {
  if (triangleCount === 0) {
    return {
      triangles: new Float32Array(0),
      vertexCount: 0,
      triangleCount: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      format,
    };
  }
  return {
    triangles,
    vertexCount: triangleCount * 3,
    triangleCount,
    bbox: {
      min: [bb.min[0], bb.min[1], bb.min[2]],
      max: [bb.max[0], bb.max[1], bb.max[2]],
    },
    format,
  };
}

/** Parse a binary or ASCII STL file. Throws on an empty / over-cap mesh. */
export function parseStl(buffer: ArrayBuffer): StlMesh {
  if (buffer.byteLength === 0) throw new Error('Empty STL file.');
  return isAsciiStl(buffer) ? parseAsciiStl(buffer) : parseBinaryStl(buffer);
}

// ============================================================================
// Slicing
// ============================================================================

/**
 * A structured slicer warning. The core stays UI-independent (no i18n), so it
 * emits a STABLE machine-readable `code` plus any interpolation `params` and an
 * English `message` fallback. The panel maps `code` → a localized string via
 * `t()` (falling back to `message` for unknown codes). Keeping codes here means
 * the warning text can be translated without the core importing the UI layer.
 */
export type SliceWarningCode =
  | 'meshEmpty'
  | 'meshTooLarge'
  | 'layerHeightInvalid'
  | 'modelTooShort'
  | 'layerCapClamped'
  | 'layerSegmentCap'
  | 'degenerateLayers'
  | 'noLayers';

export interface SliceWarning {
  code: SliceWarningCode;
  /** English fallback text (already interpolated). */
  message: string;
  /** Interpolation params for the panel to feed into t(). */
  params?: Record<string, number>;
}

export interface SliceParams {
  layerHeight: number;        // mm
  lineWidth: number;          // mm (extrusion width)
  perimeters: number;         // wall loops
  infillDensity: number;      // 0..100 (%)
  /** Optional override of the slice height (mm). Defaults to mesh Z extent. */
  // (no field — derived from mesh bbox)
}

/** Toolpath geometry for one printed layer. */
export interface SliceLayer {
  z: number;                  // layer top Z (mm), >0
  /** Wall loops, outermost first. Closed polygons in object XY coordinates. */
  perimeters: Polyline[];
  /** Rectilinear infill lines (open 2-point polylines). */
  infill: Polyline[];
}

export interface SliceResult {
  layers: SliceLayer[];
  /** Footprint bounds in XY (after the mesh has been placed by the caller). */
  bounds: BBox;
  warnings: SliceWarning[];
  /** Total layer count actually produced. */
  layerCount: number;
}

/**
 * Optional progress reporter passed into the long-running slice / emit
 * functions so a worker (or any caller) can surface paced progress without the
 * core depending on any UI/DOM. `current`/`total` are unit-less step counts
 * (e.g. layers); `fraction` is a 0..1 convenience already scoped to the phase.
 * Returning `false` requests cooperative cancellation.
 */
export type SliceProgress = (info: {
  phase: 'slice' | 'gcode';
  current: number;
  total: number;
  fraction: number;
}) => void | boolean;

/** Thrown by the pure functions when a progress callback requests cancel. */
export class SliceCancelled extends Error {
  constructor() {
    super('Slicing cancelled.');
    this.name = 'SliceCancelled';
  }
}

interface Seg {
  a: Point;
  b: Point;
}

/**
 * Intersect one triangle with the horizontal plane z=planeZ. Returns the cut
 * segment (two points where edges cross the plane), or null if no clean cut.
 */
function triPlaneSegment(
  x0: number, y0: number, z0: number,
  x1: number, y1: number, z1: number,
  x2: number, y2: number, z2: number,
  planeZ: number,
): Seg | null {
  const pts: Point[] = [];
  const edges: [number, number, number, number, number, number][] = [
    [x0, y0, z0, x1, y1, z1],
    [x1, y1, z1, x2, y2, z2],
    [x2, y2, z2, x0, y0, z0],
  ];
  for (const [ax, ay, az, bx, by, bz] of edges) {
    const da = az - planeZ;
    const db = bz - planeZ;
    // Edge crosses the plane (strictly opposite signs).
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      pts.push({ x: ax + (bx - ax) * t, y: ay + (by - ay) * t });
    }
  }
  if (pts.length === 2 && distance(pts[0], pts[1]) > 1e-7) {
    return { a: pts[0], b: pts[1] };
  }
  return null;
}

/** Quantize a point for hash-based endpoint matching during stitching. */
function key(p: Point, q: number): string {
  return `${Math.round(p.x / q)}:${Math.round(p.y / q)}`;
}

/**
 * Stitch unordered cut segments into closed contour polygons by walking
 * endpoint adjacency. Open chains are closed if their ends are within `q`.
 */
function stitchContours(segs: Seg[], q: number): Polyline[] {
  // Build adjacency: endpoint key -> list of segment indices.
  const adj = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const arr = adj.get(k);
    if (arr) arr.push(i);
    else adj.set(k, [i]);
  };
  for (let i = 0; i < segs.length; i++) {
    add(key(segs[i].a, q), i);
    add(key(segs[i].b, q), i);
  }

  const used = new Array<boolean>(segs.length).fill(false);
  const polys: Polyline[] = [];

  for (let start = 0; start < segs.length; start++) {
    if (used[start]) continue;
    const pl = new Polyline();
    used[start] = true;
    pl.add(segs[start].a);
    let cur = segs[start].b;
    pl.add(cur);
    const firstKey = key(segs[start].a, q);

    // Walk forward until we return to the start or run out of links.
    let guard = 0;
    while (guard++ < segs.length + 4) {
      const ck = key(cur, q);
      if (ck === firstKey && pl.points.length >= 3) break; // closed loop
      const candidates = adj.get(ck);
      let next = -1;
      if (candidates) {
        for (const idx of candidates) {
          if (!used[idx]) { next = idx; break; }
        }
      }
      if (next < 0) break;
      used[next] = true;
      // Continue from whichever endpoint of `next` is NOT the current one.
      const s = segs[next];
      const nextPt = key(s.a, q) === ck ? s.b : s.a;
      cur = nextPt;
      pl.add(cur);
    }

    // Close & accept if it forms a polygon.
    if (pl.points.length >= 3) {
      // Drop a duplicate closing vertex if present.
      if (distance(pl.points[0], pl.points[pl.points.length - 1]) <= q * 2) pl.points.pop();
      if (pl.points.length >= 3) {
        pl.closed = true;
        polys.push(pl);
      }
    }
  }
  return polys;
}

/**
 * Build inset perimeter loops for a single contour. The first wall is offset
 * inward by lineWidth/2 (so the nozzle centre sits half a line inside the
 * outline); subsequent walls step inward by lineWidth.
 */
function buildPerimeters(contour: Polyline, lineWidth: number, count: number): Polyline[] {
  const walls: Polyline[] = [];
  for (let i = 0; i < count; i++) {
    const inset = lineWidth * (0.5 + i);
    const w = offsetPolygon(contour, -inset);
    if (w.points.length < 3) break; // collapsed — region too thin for more walls
    w.closed = true;
    walls.push(w);
  }
  return walls;
}

/**
 * Rectilinear infill: parallel lines at `angleDeg`, spaced by `spacing`, clipped
 * to the innermost wall (or the contour if there are no walls). Implemented by
 * scanning lines across the polygon bounds and keeping the spans inside.
 */
function buildInfill(boundary: Polyline, spacing: number, angleDeg: number): Polyline[] {
  if (boundary.points.length < 3 || spacing <= 0) return [];
  const bb = boundary.bounds();
  if (!bb.isValid()) return [];

  const ang = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  // Rotate the polygon into a frame where infill lines are horizontal, scan in Y.
  const rot = boundary.points.map((p) => ({ x: p.x * cos + p.y * sin, y: -p.x * sin + p.y * cos }));
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const p of rot) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
  }

  const lines: Polyline[] = [];
  const n = rot.length;
  // Start half a spacing in so we don't ride the wall.
  for (let y = minY + spacing * 0.5; y < maxY; y += spacing) {
    // Find X crossings of the scanline with each polygon edge.
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = rot[i];
      const p1 = rot[(i + 1) % n];
      const y0 = p0.y, y1 = p1.y;
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0);
        xs.push(p0.x + (p1.x - p0.x) * t);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    // Pair crossings into interior spans (even-odd rule).
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = xs[k];
      const xb = xs[k + 1];
      if (xb - xa < 1e-6) continue;
      // Rotate the two endpoints back into world space.
      const a: Point = { x: xa * cos - y * sin, y: xa * sin + y * cos };
      const b: Point = { x: xb * cos - y * sin, y: xb * sin + y * cos };
      const pl = new Polyline();
      pl.add(a);
      pl.add(b);
      lines.push(pl);
    }
  }
  return lines;
}

/**
 * Slice a triangle mesh into printable layers. The mesh is sliced in its own
 * coordinate frame; the caller is responsible for having transformed vertices
 * so the model sits on the bed (z>=0) where desired. Layers are generated from
 * the lowest non-empty Z up to the top by `layerHeight`.
 */
export function sliceMesh(mesh: StlMesh, params: SliceParams, onProgress?: SliceProgress): SliceResult {
  const warnings: SliceWarning[] = [];
  const result: SliceResult = { layers: [], bounds: new BBox(), warnings, layerCount: 0 };

  if (mesh.triangleCount === 0) {
    warnings.push({ code: 'meshEmpty', message: 'Mesh is empty — nothing to slice.' });
    return result;
  }
  if (mesh.triangleCount > MAX_TRIANGLES) {
    warnings.push({
      code: 'meshTooLarge',
      message: `Mesh too large (${mesh.triangleCount} triangles); skipped.`,
      params: { tris: mesh.triangleCount, cap: MAX_TRIANGLES },
    });
    return result;
  }

  const layerH = params.layerHeight;
  if (!(layerH > 0)) {
    warnings.push({ code: 'layerHeightInvalid', message: 'Layer height must be > 0.' });
    return result;
  }
  const lineWidth = params.lineWidth > 0 ? params.lineWidth : 0.4;
  const perimeters = Math.max(1, Math.floor(params.perimeters));
  const density = Math.max(0, Math.min(100, params.infillDensity));

  const zMin = mesh.bbox.min[2];
  const zMax = mesh.bbox.max[2];
  const totalH = zMax - zMin;
  if (!(totalH > layerH * 0.25)) {
    warnings.push({ code: 'modelTooShort', message: 'Model is shorter than one layer; nothing to slice.' });
    return result;
  }

  let nLayers = Math.floor(totalH / layerH);
  if (nLayers > MAX_LAYERS) {
    warnings.push({
      code: 'layerCapClamped',
      message: `Layer count ${nLayers} exceeds cap ${MAX_LAYERS}; clamped.`,
      params: { count: nLayers, cap: MAX_LAYERS },
    });
    nLayers = MAX_LAYERS;
  }
  if (nLayers < 1) nLayers = 1;

  const tris = mesh.triangles;
  const stride3 = STL_STRIDE * 3; // floats per triangle
  // Stitch tolerance: a fraction of line width, in mm.
  const stitchQ = Math.max(1e-4, lineWidth * 0.1);
  // Infill spacing from density: 100% -> lineWidth spacing; lower -> wider.
  const infillSpacing = density <= 0 ? Infinity : (lineWidth * 100) / density;

  let degenerateLayers = 0;

  for (let li = 0; li < nLayers; li++) {
    if (onProgress) {
      const cancel = onProgress({ phase: 'slice', current: li, total: nLayers, fraction: nLayers > 0 ? li / nLayers : 0 });
      if (cancel === false) throw new SliceCancelled();
    }
    // Sample the plane at the middle of the layer slab for stable contours.
    const planeZ = zMin + (li + 0.5) * layerH;
    const segs: Seg[] = [];

    for (let o = 0; o < tris.length; o += stride3) {
      const z0 = tris[o + 2];
      const z1 = tris[o + STL_STRIDE + 2];
      const z2 = tris[o + STL_STRIDE * 2 + 2];
      // Quick reject: triangle entirely above or below the plane.
      const mn = Math.min(z0, z1, z2);
      const mx = Math.max(z0, z1, z2);
      if (planeZ < mn || planeZ > mx) continue;
      const seg = triPlaneSegment(
        tris[o], tris[o + 1], z0,
        tris[o + STL_STRIDE], tris[o + STL_STRIDE + 1], z1,
        tris[o + STL_STRIDE * 2], tris[o + STL_STRIDE * 2 + 1], z2,
        planeZ,
      );
      if (seg) segs.push(seg);
      if (segs.length > MAX_SEGMENTS_PER_LAYER) {
        warnings.push({
          code: 'layerSegmentCap',
          message: `Layer ${li}: too many segments; skipped.`,
          params: { layer: li },
        });
        break;
      }
    }

    if (segs.length < 3) {
      degenerateLayers++;
      continue;
    }

    const contours = stitchContours(segs, stitchQ);
    if (contours.length === 0) {
      degenerateLayers++;
      continue;
    }

    const z = (li + 1) * layerH; // print height for this layer (top of slab, >0)
    const layer: SliceLayer = { z, perimeters: [], infill: [] };

    for (const contour of contours) {
      if (contour.points.length < 3) continue;
      // Track footprint bounds.
      const cb = contour.bounds();
      if (cb.isValid()) {
        result.bounds.expand(cb.min);
        result.bounds.expand(cb.max);
      }
      const walls = buildPerimeters(contour, lineWidth, perimeters);
      for (const w of walls) layer.perimeters.push(w);

      // Infill is clipped to the innermost wall (or contour if walls collapsed).
      if (density > 0 && Number.isFinite(infillSpacing)) {
        const inner = walls.length > 0 ? walls[walls.length - 1] : contour;
        const angle = li % 2 === 0 ? 0 : 90;
        const fill = buildInfill(inner, infillSpacing, angle);
        for (const f of fill) layer.infill.push(f);
      }
    }

    if (layer.perimeters.length > 0 || layer.infill.length > 0) {
      result.layers.push(layer);
    }
  }

  if (degenerateLayers > 0) {
    warnings.push({
      code: 'degenerateLayers',
      message: `${degenerateLayers} layer(s) produced no usable contour and were skipped.`,
      params: { count: degenerateLayers },
    });
  }
  result.layerCount = result.layers.length;
  if (result.layerCount === 0) {
    warnings.push({
      code: 'noLayers',
      message: 'No printable layers produced. The mesh may be non-watertight or open.',
    });
  }
  return result;
}

// ============================================================================
// G-code emission
// ============================================================================

export interface GcodeParams {
  // Geometry / extrusion
  layerHeight: number;        // mm
  lineWidth: number;          // mm
  filamentDiameter: number;   // mm
  // Temperatures
  nozzleTemp: number;         // °C
  bedTemp: number;            // °C
  firstLayerNozzleTemp?: number;
  // Speeds (mm/min)
  printSpeed: number;
  travelSpeed: number;
  firstLayerSpeed?: number;
  // Retraction
  retractDistance: number;    // mm
  retractSpeed: number;       // mm/min
  // Cooling
  fanEnabled: boolean;
  // Skirt
  skirt: boolean;
  // Origin offset applied to all XY (so caller can centre the part on the bed).
  offsetX?: number;
  offsetY?: number;
  decimals?: number;
}

/** Format a number, snapping near-zero to avoid "-0.000". */
function fmt(value: number, decimals: number): string {
  if (Math.abs(value) < 0.5 * Math.pow(10, -decimals)) value = 0;
  let s = value.toFixed(decimals);
  if (s === '-' + (0).toFixed(decimals)) s = (0).toFixed(decimals);
  return s;
}

/**
 * Volumetric extrusion length for a printed move of geometric length `dist`
 * (mm), depositing a bead of cross-section lineWidth × layerHeight, fed from a
 * filament of the given diameter. E is the *filament* advance (absolute mode).
 */
function extrusionPerMm(lineWidth: number, layerHeight: number, filamentDiameter: number): number {
  const filArea = Math.PI * (filamentDiameter / 2) * (filamentDiameter / 2);
  if (filArea <= 0) return 0;
  const beadArea = lineWidth * layerHeight;
  return beadArea / filArea;
}

/**
 * Emit standard 3D-printer G-code (Marlin/GRBL-flavoured, absolute extrusion
 * via M82). Includes a safe start sequence (home, heat + wait, prime), per-layer
 * fan/Z handling, perimeters then infill with computed E, retraction on travel,
 * and an end sequence that turns everything off and parks.
 */
export function sliceToGcode(slice: SliceResult, params: GcodeParams, onProgress?: SliceProgress): string {
  const dec = params.decimals ?? 3;
  const f = (v: number) => fmt(v, dec);
  const ePerMm = extrusionPerMm(params.lineWidth, params.layerHeight, params.filamentDiameter);

  const offX = params.offsetX ?? 0;
  const offY = params.offsetY ?? 0;

  const out: string[] = [];
  const firstNozzle = params.firstLayerNozzleTemp ?? params.nozzleTemp;
  const firstSpeed = params.firstLayerSpeed ?? Math.round(params.printSpeed * 0.5);

  // ---- Start sequence -------------------------------------------------------
  out.push('; karmyogi FDM slicer — basic perimeters + rectilinear infill');
  out.push(`; layers=${slice.layerCount} layerHeight=${params.layerHeight} lineWidth=${params.lineWidth}`);
  out.push('G21 ; mm');
  out.push('G90 ; absolute positioning');
  out.push('M82 ; absolute extrusion');
  out.push(`M140 S${f(params.bedTemp)} ; set bed temp`);
  out.push(`M104 S${f(firstNozzle)} ; set hotend temp`);
  out.push(`M190 S${f(params.bedTemp)} ; wait for bed`);
  out.push(`M109 S${f(firstNozzle)} ; wait for hotend`);
  out.push('G28 ; home all axes');
  out.push('G92 E0 ; zero extruder');
  out.push('M107 ; fan off');

  // Prime: advance a little extrusion at the home corner before drawing.
  out.push('; prime');
  out.push(`G1 Z${f(params.layerHeight)} F${f(params.travelSpeed)}`);
  out.push(`G1 E${f(3)} F${f(params.retractSpeed)} ; prime extruder`);

  let e = 3; // current absolute E
  let lastX = NaN;
  let lastY = NaN;
  let retracted = false;

  const retractMove = () => {
    if (params.retractDistance > 0 && !retracted) {
      e -= params.retractDistance;
      out.push(`G1 E${f(e)} F${f(params.retractSpeed)} ; retract`);
      retracted = true;
    }
  };
  const unretractMove = () => {
    if (params.retractDistance > 0 && retracted) {
      e += params.retractDistance;
      out.push(`G1 E${f(e)} F${f(params.retractSpeed)} ; unretract`);
      retracted = false;
    }
  };

  // Travel (non-extruding) move to (x,y) with optional retraction.
  const travelTo = (x: number, y: number, feed: number) => {
    retractMove();
    out.push(`G0 X${f(x + offX)} Y${f(y + offY)} F${f(feed)}`);
    lastX = x;
    lastY = y;
  };

  // Extruding move to (x,y); E advances by the bead volume.
  const extrudeTo = (x: number, y: number, feed: number) => {
    if (Number.isNaN(lastX)) { lastX = x; lastY = y; return; }
    const d = Math.hypot(x - lastX, y - lastY);
    e += d * ePerMm;
    out.push(`G1 X${f(x + offX)} Y${f(y + offY)} E${f(e)} F${f(feed)}`);
    lastX = x;
    lastY = y;
  };

  // Print a single open/closed polyline as: travel to first point, extrude rest.
  const printPath = (pl: Polyline, feed: number) => {
    const pts = pl.points;
    if (pts.length < 2) return;
    travelTo(pts[0].x, pts[0].y, params.travelSpeed);
    unretractMove();
    for (let i = 1; i < pts.length; i++) extrudeTo(pts[i].x, pts[i].y, feed);
    if (pl.closed) extrudeTo(pts[0].x, pts[0].y, feed); // close the loop
  };

  // ---- Optional skirt (around the first layer's footprint) ------------------
  // Drawn as a single loop offset out from the model bounds.
  const drawSkirt = () => {
    const bb = slice.bounds;
    if (!bb.isValid()) return;
    const m = 3; // skirt margin (mm)
    const x0 = bb.min.x - m, y0 = bb.min.y - m, x1 = bb.max.x + m, y1 = bb.max.y + m;
    const sk = new Polyline();
    sk.add({ x: x0, y: y0 });
    sk.add({ x: x1, y: y0 });
    sk.add({ x: x1, y: y1 });
    sk.add({ x: x0, y: y1 });
    sk.closed = true;
    out.push('; skirt');
    printPath(sk, firstSpeed);
  };

  // ---- Per-layer ------------------------------------------------------------
  const nLayers = slice.layers.length;
  for (let li = 0; li < nLayers; li++) {
    if (onProgress) {
      const cancel = onProgress({ phase: 'gcode', current: li, total: nLayers, fraction: nLayers > 0 ? li / nLayers : 0 });
      if (cancel === false) throw new SliceCancelled();
    }
    const layer = slice.layers[li];
    const isFirst = li === 0;
    const speed = isFirst ? firstSpeed : params.printSpeed;

    out.push(`; layer ${li + 1}/${slice.layers.length}  z=${f(layer.z)}`);
    // Fan: off on the first layer for adhesion, on afterwards (if enabled).
    if (li === 1) {
      out.push(params.fanEnabled ? 'M106 S255 ; fan on' : 'M107 ; fan off');
    }
    // After the first layer, drop nozzle temp to the steady-state value.
    if (li === 1 && (params.firstLayerNozzleTemp ?? params.nozzleTemp) !== params.nozzleTemp) {
      out.push(`M104 S${f(params.nozzleTemp)} ; steady hotend temp`);
    }

    out.push(`G1 Z${f(layer.z)} F${f(params.travelSpeed)}`);

    if (isFirst && params.skirt) drawSkirt();

    // Perimeters first (better surface), then infill.
    for (const w of layer.perimeters) printPath(w, speed);
    for (const fpath of layer.infill) printPath(fpath, speed);
  }

  // ---- End sequence ---------------------------------------------------------
  retractMove();
  out.push('; end');
  out.push('M104 S0 ; hotend off');
  out.push('M140 S0 ; bed off');
  out.push('M107 ; fan off');
  out.push(`G1 Z${f((slice.layers.at(-1)?.z ?? 0) + 10)} F${f(params.travelSpeed)} ; raise Z`);
  out.push('G28 X Y ; park');
  out.push('M84 ; disable steppers');

  return out.join('\n') + '\n';
}

// ============================================================================
// Print estimate (filament + time)
// ============================================================================

/** Rough filament + time estimate for a sliced job. */
export interface PrintEstimate {
  /** Total extruded filament length (mm). */
  filamentMm: number;
  /** Filament mass (g), assuming PLA density 1.24 g/cm³. */
  filamentGrams: number;
  /** Estimated print time (seconds). A coarse upper-bound from path length / feed. */
  timeSeconds: number;
}

/** PLA density (g/cm³) — used for a ballpark mass estimate. */
const FILAMENT_DENSITY_G_CM3 = 1.24;

/**
 * Estimate filament use and print time from a slice result. This is a coarse
 * model: extrusion length comes from the printed bead volume (the same volumetric
 * formula the emitter uses); time sums each printed path's length / its feed plus
 * a small per-layer Z-move allowance. Travel/retraction time is approximated, so
 * treat the result as a ballpark — always sanity-check on the machine.
 */
export function estimatePrint(slice: SliceResult, params: GcodeParams): PrintEstimate {
  const ePerMm = extrusionPerMm(params.lineWidth, params.layerHeight, params.filamentDiameter);
  const firstSpeed = params.firstLayerSpeed ?? Math.round(params.printSpeed * 0.5);

  let printLenMm = 0; // total extruded XY distance
  let timeMin = 0;

  const pathLen = (pl: Polyline): number => {
    const pts = pl.points;
    if (pts.length < 2) return 0;
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += distance(pts[i - 1], pts[i]);
    if (pl.closed) d += distance(pts[pts.length - 1], pts[0]);
    return d;
  };

  for (let li = 0; li < slice.layers.length; li++) {
    const layer = slice.layers[li];
    const feed = li === 0 ? firstSpeed : params.printSpeed; // mm/min
    let layerLen = 0;
    for (const w of layer.perimeters) layerLen += pathLen(w);
    for (const f of layer.infill) layerLen += pathLen(f);
    printLenMm += layerLen;
    if (feed > 0) timeMin += layerLen / feed;
    // Per-layer Z move + a small travel allowance.
    if (params.travelSpeed > 0) timeMin += (params.layerHeight + 5) / params.travelSpeed;
  }

  const filamentMm = printLenMm * ePerMm;
  const filArea = Math.PI * (params.filamentDiameter / 2) * (params.filamentDiameter / 2); // mm²
  const volumeCm3 = (filArea * filamentMm) / 1000; // mm³ → cm³
  const filamentGrams = volumeCm3 * FILAMENT_DENSITY_G_CM3;

  return {
    filamentMm,
    filamentGrams,
    timeSeconds: timeMin * 60,
  };
}

// ============================================================================
// Worker message protocol (shared by slicer.worker.ts and the Print panel)
// ============================================================================

/**
 * Request posted to the slicer worker. The placed mesh is passed as raw
 * interleaved triangle data + bbox so the heavy `StlMesh` object never has to
 * be structured-cloned wholesale; the `triangles` buffer is sent as a
 * Transferable (zero-copy) by the panel.
 */
export interface SliceWorkerRequest {
  type: 'slice';
  triangles: Float32Array;
  triangleCount: number;
  vertexCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  format: 'binary' | 'ascii';
  sliceParams: SliceParams;
  gcodeParams: GcodeParams;
}

/** Cancel the in-flight slice. */
export interface SliceWorkerCancel {
  type: 'cancel';
}

export type SliceWorkerInbound = SliceWorkerRequest | SliceWorkerCancel;

/** Paced progress update from the worker. `fraction` is 0..1 over the whole job. */
export interface SliceWorkerProgress {
  type: 'progress';
  phase: 'slice' | 'gcode';
  current: number;
  total: number;
  fraction: number;
}

/** Final success: generated G-code plus summary stats. */
export interface SliceWorkerDone {
  type: 'done';
  gcode: string;
  layers: number;
  lines: number;
  warnings: SliceWarning[];
  /** Filament + time estimate (omitted when no layers were produced). */
  estimate?: PrintEstimate;
}

export interface SliceWorkerError {
  type: 'error';
  message: string;
  /** True when the failure was a cooperative cancel rather than a real error. */
  cancelled?: boolean;
}

export type SliceWorkerOutbound = SliceWorkerProgress | SliceWorkerDone | SliceWorkerError;
