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

/** How (if at all) to generate support material under overhangs. */
export type SupportType = 'none' | 'grid' | 'tree';

/**
 * Infill pattern (D7). All are realized on top of the rectilinear scanline core:
 * `rectilinear` is a single set of parallel lines alternating 0/90° per layer;
 * `grid` lays both 0° and 90° on every layer; `triangles` lays 0/60/120°;
 * `gyroid` phase-shifts the scan direction + offset per layer to approximate the
 * woven gyroid look; `concentric` follows the wall contour inward. Gyroid is the
 * default (best strength/weight + isotropy, matching modern slicers).
 */
export type InfillPattern = 'rectilinear' | 'grid' | 'triangles' | 'gyroid' | 'concentric';

/**
 * A height-range modifier (D4). For layers whose print-height Z falls in
 * [minZ, maxZ] (mm, inclusive), the listed fields OVERRIDE the global slice
 * params. Any omitted field is left at the global value. Modifiers apply in
 * order; the last matching one wins per field. This is karmyogi's
 * "per-object / height-range modifier" — e.g. solid 0–3 mm base, sparse middle.
 */
export interface HeightModifier {
  minZ: number;             // mm (inclusive)
  maxZ: number;             // mm (inclusive)
  infillDensity?: number;   // 0..100 (%) override
  perimeters?: number;      // wall-loop override
  infillPattern?: InfillPattern;
}

/**
 * A variable / adaptive layer-height band (D8). Within [minZ, maxZ] (in MODEL
 * Z, measured from the model's own minimum), slice at `layerHeight` mm instead
 * of the global height. Bands are a coarse, deterministic stand-in for a fully
 * paintable Z-profile: thinner layers where the user paints detail, thicker
 * elsewhere for speed. Slicing walks Z bottom-up, picking the band height that
 * covers the current Z (falling back to the global height outside any band).
 */
export interface LayerHeightBand {
  minZ: number;             // mm (model-relative, inclusive)
  maxZ: number;             // mm (model-relative, inclusive)
  layerHeight: number;      // mm (>0)
}

export interface SliceParams {
  layerHeight: number;        // mm
  lineWidth: number;          // mm (extrusion width)
  perimeters: number;         // wall loops
  infillDensity: number;      // 0..100 (%)
  /** Infill pattern (default 'gyroid'). */
  infillPattern?: InfillPattern;
  /** Support generation strategy (default 'none'). */
  supportType?: SupportType;
  /**
   * Overhang threshold (degrees from vertical). Faces steeper than this from
   * vertical (i.e. flatter / more horizontal-facing-down) need support.
   * Default 50°.
   */
  supportOverhangAngle?: number;
  /** Height-range modifiers (D4); empty/undefined = none. */
  modifiers?: HeightModifier[];
  /** Variable layer-height bands (D8); empty/undefined = uniform layerHeight. */
  layerBands?: LayerHeightBand[];
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
  /** Support-material toolpaths for this layer (open lines / loops). */
  support?: Polyline[];
  /** Layer thickness (mm) — varies when adaptive layer bands are used (D8). */
  thickness: number;
  /** True when this is a top surface (no model layer above it) — drives ironing (D10). */
  topSurface?: boolean;
  /** Innermost wall (or contour) per region — the ironing pass reuses these. */
  topRegions?: Polyline[];
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
 * Concentric infill: step the boundary inward by `spacing` repeatedly, each
 * inset ring becoming an infill loop, until the region collapses. Reuses the
 * shared polygon offsetter (same engine as the perimeters), so it follows the
 * wall contour — ideal for flexible (TPU) and round parts.
 */
function buildConcentricInfill(boundary: Polyline, spacing: number): Polyline[] {
  const rings: Polyline[] = [];
  // Guard against pathological tiny spacings producing thousands of rings.
  const maxRings = 2000;
  for (let i = 1; i <= maxRings; i++) {
    const r = offsetPolygon(boundary, -spacing * i);
    if (r.points.length < 3) break;
    r.closed = true;
    rings.push(r);
  }
  return rings;
}

/**
 * Build infill for one layer per the chosen {@link InfillPattern}. Rectilinear/
 * gyroid emit one line set at the per-layer angle; grid overlays 0°+90°;
 * triangles overlays 0/60/120°; concentric follows the contour inward. The
 * gyroid pattern additionally shifts the scan PHASE per layer (so successive
 * layers weave) — a cheap, robust approximation of a true gyroid that keeps the
 * output as printable straight runs.
 */
function buildInfillPattern(
  boundary: Polyline,
  spacing: number,
  layerIndex: number,
  pattern: InfillPattern,
): Polyline[] {
  if (boundary.points.length < 3 || !(spacing > 0) || !Number.isFinite(spacing)) return [];
  switch (pattern) {
    case 'concentric':
      return buildConcentricInfill(boundary, spacing);
    case 'grid':
      // Both directions every layer → square grid (≈2× density of one set).
      return [...buildInfill(boundary, spacing * 2, 0), ...buildInfill(boundary, spacing * 2, 90)];
    case 'triangles':
      // Three directions every layer → triangular grid (÷3 each so total ≈ density).
      return [
        ...buildInfill(boundary, spacing * 3, 0),
        ...buildInfill(boundary, spacing * 3, 60),
        ...buildInfill(boundary, spacing * 3, 120),
      ];
    case 'gyroid': {
      // Rotate the scan a little and shift the phase each layer so consecutive
      // layers cross — the woven look that gives gyroid its isotropy. Still a
      // single straight-line set per layer (printable + robust).
      const angle = (layerIndex * 45) % 180;
      const phase = (layerIndex % 4) * (spacing * 0.25);
      return buildInfill(boundary, spacing, angle, phase);
    }
    case 'rectilinear':
    default:
      return buildInfill(boundary, spacing, layerIndex % 2 === 0 ? 0 : 90);
  }
}

/**
 * Rectilinear infill: parallel lines at `angleDeg`, spaced by `spacing`, clipped
 * to the innermost wall (or the contour if there are no walls). Implemented by
 * scanning lines across the polygon bounds and keeping the spans inside.
 * `phase` (mm) shifts the first scanline along Y (used by the gyroid weave).
 */
function buildInfill(boundary: Polyline, spacing: number, angleDeg: number, phase = 0): Polyline[] {
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
  // Start half a spacing in so we don't ride the wall (+ optional phase shift).
  for (let y = minY + spacing * 0.5 + (phase % spacing); y < maxY; y += spacing) {
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

// ============================================================================
// Support generation (grid + tree)
// ============================================================================
//
// Strategy (pure, deterministic): we find OVERHANG sample points — downward-
// facing triangle centroids whose face is flatter than the overhang threshold —
// and treat each as a point that must be held up from below. A grid support
// fills the overhang footprint per layer with a sparse rectilinear pattern; a
// tree support consolidates nearby overhang points into branching columns that
// merge as they descend toward the bed (fewer, thicker contacts → less plastic,
// easier removal). Both are clipped to z < the overhang height so they only
// exist beneath the feature they hold up.

/** An overhang sample needing support: an XY anchor that must be reached from below up to `zTop`. */
interface OverhangPoint {
  x: number;
  y: number;
  /** Top Z (mm) the support must reach (the underside of the overhang). */
  zTop: number;
}

/**
 * Collect overhang anchor points from a placed mesh: triangle centroids whose
 * face normal points sufficiently downward (the face overhangs). `overhangDeg`
 * is measured from vertical — a normal at exactly -Z is a 90° overhang (a flat
 * ceiling); we flag faces whose downward tilt exceeds the threshold. Points
 * within ~one nozzle of the bed are skipped (they rest on the bed).
 */
function collectOverhangs(mesh: StlMesh, overhangDeg: number, layerH: number): OverhangPoint[] {
  const out: OverhangPoint[] = [];
  const tris = mesh.triangles;
  const stride3 = STL_STRIDE * 3;
  const zMin = mesh.bbox.min[2];
  // Face needs support when its downward angle from vertical exceeds threshold.
  // nz is the (normalized) Z of the outward normal. A downward face has nz < 0.
  // The angle the face makes with horizontal: a flat ceiling has nz = -1.
  // Support when nz < -sin(overhangDeg) (steeper overhang → more negative nz).
  const cutoff = -Math.sin((overhangDeg * Math.PI) / 180);
  for (let o = 0; o < tris.length; o += stride3) {
    const nz = tris[o + 5]; // normal is shared across the 3 verts (per-face)
    if (!(nz < cutoff)) continue;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + STL_STRIDE], by = tris[o + STL_STRIDE + 1], bz = tris[o + STL_STRIDE + 2];
    const cx = tris[o + STL_STRIDE * 2], cy = tris[o + STL_STRIDE * 2 + 1], cz = tris[o + STL_STRIDE * 2 + 2];
    const zTop = (az + bz + cz) / 3;
    // Skip overhangs resting on (or essentially at) the bed.
    if (zTop - zMin < layerH * 1.5) continue;
    out.push({ x: (ax + bx + cx) / 3, y: (ay + by + cy) / 3, zTop });
  }
  return out;
}

/**
 * Cluster overhang points into a coarse grid (cell ≈ `spacing`) and keep one
 * representative per occupied cell (the highest zTop, so a pillar reaches the
 * uppermost overhang it serves). Returns deduplicated anchors.
 */
function clusterOverhangs(pts: OverhangPoint[], spacing: number): OverhangPoint[] {
  const cell = Math.max(spacing, 1);
  const best = new Map<string, OverhangPoint>();
  for (const p of pts) {
    const k = `${Math.round(p.x / cell)}:${Math.round(p.y / cell)}`;
    const cur = best.get(k);
    if (!cur || p.zTop > cur.zTop) best.set(k, p);
  }
  return [...best.values()];
}

/**
 * Build GRID supports: for each layer below an overhang, draw a sparse
 * rectilinear pattern over the union footprint of all overhang anchors active
 * at that height. Implemented per-layer as short vertical/horizontal dashes
 * around each anchor cell so the result is printable open lines.
 */
function buildGridSupportForLayer(anchors: OverhangPoint[], z: number, spacing: number, lineWidth: number): Polyline[] {
  const out: Polyline[] = [];
  const half = spacing * 0.5;
  for (const a of anchors) {
    if (z >= a.zTop - lineWidth) continue; // only below the overhang
    // A small "#" of two crossing strokes per anchor cell — sparse but stable.
    const h = new Polyline();
    h.add({ x: a.x - half, y: a.y });
    h.add({ x: a.x + half, y: a.y });
    out.push(h);
    const v = new Polyline();
    v.add({ x: a.x, y: a.y - half });
    v.add({ x: a.x, y: a.y + half });
    out.push(v);
  }
  return out;
}

/** A node in a tree-support trunk: a contact at the top tapering to the bed. */
interface TreeBranch {
  /** XY at the overhang contact (top). */
  topX: number;
  topY: number;
  /** XY at the bed (base) — pulled toward the cluster centroid for stability. */
  baseX: number;
  baseY: number;
  zTop: number;
  zBase: number;
}

/**
 * Build TREE supports: cluster overhang anchors, then for each cluster create a
 * branch whose top sits under the overhang and whose base drifts toward the
 * shared cluster centroid as it descends (so nearby branches lean together into
 * a trunk). Each branch is realized at slice time as a short circle/segment at
 * its interpolated XY for the current layer Z.
 */
function buildTreeBranches(anchors: OverhangPoint[], spacing: number, zMin: number): TreeBranch[] {
  if (anchors.length === 0) return [];
  // Group anchors into clusters by a coarser grid so branches merge.
  const groupCell = Math.max(spacing * 2.5, 1);
  const groups = new Map<string, OverhangPoint[]>();
  for (const a of anchors) {
    const k = `${Math.round(a.x / groupCell)}:${Math.round(a.y / groupCell)}`;
    const arr = groups.get(k);
    if (arr) arr.push(a);
    else groups.set(k, [a]);
  }
  const branches: TreeBranch[] = [];
  for (const g of groups.values()) {
    let gx = 0, gy = 0;
    for (const a of g) { gx += a.x; gy += a.y; }
    gx /= g.length; gy /= g.length;
    for (const a of g) {
      branches.push({
        topX: a.x, topY: a.y,
        baseX: gx, baseY: gy, // lean toward the shared trunk
        zTop: a.zTop, zBase: zMin,
      });
    }
  }
  return branches;
}

/** Tree branch toolpath at a given Z: a tiny ring at the interpolated XY. */
function treeBranchAtZ(b: TreeBranch, z: number, radius: number): Polyline | null {
  if (z >= b.zTop - 1e-6 || z < b.zBase - 1e-6) return null;
  const span = b.zTop - b.zBase;
  // 0 at base, 1 at top.
  const t = span > 1e-6 ? (z - b.zBase) / span : 1;
  const x = b.baseX + (b.topX - b.baseX) * t;
  const y = b.baseY + (b.topY - b.baseY) * t;
  // A small square loop (cheap, printable) around the branch centre.
  const r = radius;
  const pl = new Polyline();
  pl.add({ x: x - r, y: y - r });
  pl.add({ x: x + r, y: y - r });
  pl.add({ x: x + r, y: y + r });
  pl.add({ x: x - r, y: y + r });
  pl.closed = true;
  return pl;
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

  // ---- Variable / adaptive layer-height bands (D8) -------------------------
  // Build the per-layer SLAB list: each slab has a sampling plane Z (mid), a
  // print height Z (top, model-relative→print coords), and a thickness. With no
  // bands this is a uniform stack; with bands we walk Z bottom-up and pick the
  // band height covering the current model Z.
  const bands = (params.layerBands ?? []).filter((b) => b.layerHeight > 0 && b.maxZ > b.minZ);
  const heightAt = (modelZ: number): number => {
    for (const b of bands) {
      if (modelZ >= b.minZ && modelZ < b.maxZ) return b.layerHeight;
    }
    return layerH;
  };
  interface Slab { planeZ: number; printZ: number; thickness: number; }
  const slabs: Slab[] = [];
  let cursor = 0; // model-relative Z at the bottom of the next slab
  let capClamped = false;
  while (cursor < totalH - 1e-6) {
    const h = Math.max(0.01, heightAt(cursor));
    const top = Math.min(cursor + h, totalH);
    const thickness = top - cursor;
    slabs.push({ planeZ: zMin + cursor + thickness * 0.5, printZ: top, thickness });
    cursor = top;
    if (slabs.length >= MAX_LAYERS) { capClamped = true; break; }
  }
  if (capClamped) {
    warnings.push({
      code: 'layerCapClamped',
      message: `Layer count exceeds cap ${MAX_LAYERS}; clamped.`,
      params: { count: slabs.length, cap: MAX_LAYERS },
    });
  }
  if (slabs.length < 1) slabs.push({ planeZ: zMin + totalH * 0.5, printZ: totalH, thickness: totalH });
  const nLayers = slabs.length;

  // ---- Height-range modifiers (D4): pick the matching override per layer. --
  const modifiers = (params.modifiers ?? []).filter((m) => m.maxZ >= m.minZ);
  const basePattern: InfillPattern = params.infillPattern ?? 'gyroid';
  const resolveLayer = (printZ: number): { density: number; perimeters: number; pattern: InfillPattern } => {
    let d = density, p = perimeters, pat = basePattern;
    for (const m of modifiers) {
      if (printZ < m.minZ - 1e-6 || printZ > m.maxZ + 1e-6) continue;
      if (m.infillDensity != null && Number.isFinite(m.infillDensity)) d = Math.max(0, Math.min(100, m.infillDensity));
      if (m.perimeters != null && Number.isFinite(m.perimeters)) p = Math.max(1, Math.floor(m.perimeters));
      if (m.infillPattern) pat = m.infillPattern;
    }
    return { density: d, perimeters: p, pattern: pat };
  };

  const tris = mesh.triangles;
  const stride3 = STL_STRIDE * 3; // floats per triangle
  // Stitch tolerance: a fraction of line width, in mm.
  const stitchQ = Math.max(1e-4, lineWidth * 0.1);
  // Infill spacing from density: 100% -> lineWidth spacing; lower -> wider.
  const spacingFor = (d: number) => (d <= 0 ? Infinity : (lineWidth * 100) / d);

  // ---- Supports (optional) -------------------------------------------------
  const supportType: SupportType = params.supportType ?? 'none';
  const supportSpacing = Math.max(lineWidth * 6, 3); // sparse columns
  const treeRingR = Math.max(lineWidth * 1.5, 0.6);
  let gridAnchors: OverhangPoint[] = [];
  let treeBranches: TreeBranch[] = [];
  if (supportType !== 'none') {
    const overhangDeg = params.supportOverhangAngle ?? 50;
    const raw = collectOverhangs(mesh, overhangDeg, layerH);
    const clustered = clusterOverhangs(raw, supportSpacing);
    if (supportType === 'grid') {
      gridAnchors = clustered;
    } else {
      treeBranches = buildTreeBranches(clustered, supportSpacing, zMin);
    }
  }

  let degenerateLayers = 0;

  for (let li = 0; li < nLayers; li++) {
    if (onProgress) {
      const cancel = onProgress({ phase: 'slice', current: li, total: nLayers, fraction: nLayers > 0 ? li / nLayers : 0 });
      if (cancel === false) throw new SliceCancelled();
    }
    // Sample the plane at the middle of the layer slab for stable contours.
    const slab = slabs[li];
    const planeZ = slab.planeZ;
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

    const z = slab.printZ; // print height for this layer (top of slab, >0)
    const thickness = slab.thickness;
    const mod = resolveLayer(z);

    // Support toolpaths for this layer (built even on layers with no model
    // contour, so columns reach the bed under a floating overhang).
    let support: Polyline[] | undefined;
    if (supportType === 'grid' && gridAnchors.length) {
      const s = buildGridSupportForLayer(gridAnchors, z, supportSpacing, lineWidth);
      if (s.length) support = s;
    } else if (supportType === 'tree' && treeBranches.length) {
      const s: Polyline[] = [];
      for (const b of treeBranches) {
        const ring = treeBranchAtZ(b, z, treeRingR);
        if (ring) s.push(ring);
      }
      if (s.length) support = s;
    }

    const contours = segs.length >= 3 ? stitchContours(segs, stitchQ) : [];
    if (contours.length === 0) {
      // No model on this layer, but support may still need to print here.
      if (support && support.length) {
        result.layers.push({ z, thickness, perimeters: [], infill: [], support });
      } else {
        degenerateLayers++;
      }
      continue;
    }

    const layer: SliceLayer = { z, thickness, perimeters: [], infill: [], support };
    const innerRegions: Polyline[] = []; // innermost wall per region (for ironing/top fill)
    const infillSpacing = spacingFor(mod.density);

    for (const contour of contours) {
      if (contour.points.length < 3) continue;
      // Track footprint bounds.
      const cb = contour.bounds();
      if (cb.isValid()) {
        result.bounds.expand(cb.min);
        result.bounds.expand(cb.max);
      }
      const walls = buildPerimeters(contour, lineWidth, mod.perimeters);
      for (const w of walls) layer.perimeters.push(w);

      // Infill is clipped to the innermost wall (or contour if walls collapsed).
      const inner = walls.length > 0 ? walls[walls.length - 1] : contour;
      innerRegions.push(inner);
      if (mod.density > 0 && Number.isFinite(infillSpacing)) {
        const fill = buildInfillPattern(inner, infillSpacing, li, mod.pattern);
        for (const f of fill) layer.infill.push(f);
      }
    }
    layer.topRegions = innerRegions;

    if (layer.perimeters.length > 0 || layer.infill.length > 0 || (layer.support && layer.support.length > 0)) {
      result.layers.push(layer);
    }
  }

  // ---- Top-surface detection (for ironing, D10) ----------------------------
  // A layer is a top surface where it has a model region but the NEXT printed
  // layer has no region overlapping it. Coarse + cheap: flag the final model
  // layer, plus any layer whose successor produced no perimeters (a step/top).
  for (let i = 0; i < result.layers.length; i++) {
    const cur = result.layers[i];
    if (!cur.topRegions || cur.topRegions.length === 0) continue;
    const next = result.layers[i + 1];
    const nextHasModel = next && next.perimeters.length > 0;
    if (!nextHasModel) cur.topSurface = true;
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
  // Skirt (legacy boolean kept for back-compat; `adhesion` supersedes it).
  skirt: boolean;
  /**
   * First-layer adhesion strategy (D7). `none` prints nothing extra; `skirt` is
   * a single priming loop offset out from the part (no contact); `brim` is N
   * concentric loops touching the part outline for grip; `raft` lays a sparse
   * solid first layer under the whole footprint. Defaults from `skirt` when
   * omitted (skirt→'skirt', else 'none').
   */
  adhesion?: 'none' | 'skirt' | 'brim' | 'raft';
  /** Number of brim loops (D7). Default 8. */
  brimLoops?: number;
  /**
   * Iron top surfaces (D10): after a top layer's normal extrusion, re-traverse
   * its surface at a tight spacing with near-zero flow to smooth it. Off by
   * default.
   */
  ironing?: boolean;
  /** Ironing flow as a fraction of normal extrusion (default 0.1 = 10%). */
  ironingFlow?: number;
  /**
   * Emit G2/G3 arcs for curved runs of perimeter points (shrinks G-code +
   * smooths motion on controllers that support arc interpolation). Off by
   * default; line moves are always valid, arcs are an opt-in optimisation.
   */
  arcFitting?: boolean;
  /** Max chord deviation (mm) an arc may have from the original points. Default 0.05. */
  arcTolerance?: number;
  // Origin offset applied to all XY (so caller can centre the part on the bed).
  offsetX?: number;
  offsetY?: number;
  decimals?: number;
}

// ---------------------------------------------------------------------------
// Arc fitting (G2/G3) — fit circular arcs to runs of near-cocircular points.
// ---------------------------------------------------------------------------

/** A fitted span of a polyline: either a straight move to `end` or an arc. */
export interface FittedMove {
  end: Point;
  /** Present for arc moves: circle centre, CCW flag (G3) vs CW (G2). */
  arc?: { center: Point; ccw: boolean };
}

/** Circle through 3 points, or null if (near-)colinear. */
function circleFrom3(a: Point, b: Point, c: Point): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  const r = Math.hypot(a.x - cx, a.y - cy);
  return { cx, cy, r };
}

/**
 * Fit a sequence of XY points (an open or already-unrolled closed loop) into a
 * minimal list of moves: greedily extend an arc as long as every intermediate
 * point stays within `tol` of the candidate circle and the turn direction is
 * consistent; otherwise emit a line. Pure + deterministic. Points are assumed
 * to start AT the current position (caller is already there), so the first
 * returned move begins from `pts[0]`.
 */
export function fitArcs(pts: Point[], tol: number): FittedMove[] {
  const moves: FittedMove[] = [];
  const n = pts.length;
  if (n < 2) return moves;
  let i = 0;
  while (i < n - 1) {
    // Try to grow an arc starting at i spanning at least 2 more points.
    let bestEnd = -1;
    let bestCircle: { cx: number; cy: number; r: number } | null = null;
    let bestCcw = false;
    if (i + 2 < n) {
      // Seed the circle from i, i+1, i+2 and extend while points stay on it.
      let j = i + 2;
      let circle = circleFrom3(pts[i], pts[i + 1], pts[j]);
      while (circle && j < n) {
        // Validate every point i..j against this circle.
        let ok = circle.r > 1e-3 && circle.r < 1e5;
        if (ok) {
          for (let k = i; k <= j; k++) {
            const dr = Math.abs(Math.hypot(pts[k].x - circle.cx, pts[k].y - circle.cy) - circle.r);
            if (dr > tol) { ok = false; break; }
          }
        }
        if (!ok) break;
        bestEnd = j;
        bestCircle = circle;
        // Determine sweep direction from the cross product of the first turn.
        const ux = pts[i + 1].x - pts[i].x, uy = pts[i + 1].y - pts[i].y;
        const vx = pts[i + 2].x - pts[i + 1].x, vy = pts[i + 2].y - pts[i + 1].y;
        bestCcw = ux * vy - uy * vx > 0;
        j++;
        if (j < n) circle = circleFrom3(pts[i], pts[Math.floor((i + j) / 2)], pts[j]);
      }
    }
    if (bestEnd > i + 1 && bestCircle) {
      moves.push({ end: pts[bestEnd], arc: { center: { x: bestCircle.cx, y: bestCircle.cy }, ccw: bestCcw } });
      i = bestEnd;
    } else {
      moves.push({ end: pts[i + 1] });
      i++;
    }
  }
  return moves;
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

  // Extruding move to (x,y); E advances by the bead volume × `flow` (1 = full).
  const extrudeTo = (x: number, y: number, feed: number, flow = 1) => {
    if (Number.isNaN(lastX)) { lastX = x; lastY = y; return; }
    const d = Math.hypot(x - lastX, y - lastY);
    e += d * ePerMm * flow;
    out.push(`G1 X${f(x + offX)} Y${f(y + offY)} E${f(e)} F${f(feed)}`);
    lastX = x;
    lastY = y;
  };

  // Extruding ARC move to (x,y) about `center` (G2 cw / G3 ccw), using I/J
  // (centre offset from the current point). E advances by the arc length so the
  // bead volume matches; arc length = radius × swept angle.
  const arcTo = (x: number, y: number, center: Point, ccw: boolean, feed: number) => {
    if (Number.isNaN(lastX)) { lastX = x; lastY = y; return; }
    const i = center.x - lastX;
    const j = center.y - lastY;
    const r = Math.hypot(i, j);
    // Swept angle from start→end about centre (sign per direction).
    const a0 = Math.atan2(lastY - center.y, lastX - center.x);
    const a1 = Math.atan2(y - center.y, x - center.x);
    let sweep = a1 - a0;
    if (ccw) { while (sweep <= 0) sweep += 2 * Math.PI; }
    else { while (sweep >= 0) sweep -= 2 * Math.PI; }
    const arcLen = Math.abs(sweep) * r;
    e += arcLen * ePerMm;
    // G2 = clockwise, G3 = counter-clockwise.
    out.push(`${ccw ? 'G3' : 'G2'} X${f(x + offX)} Y${f(y + offY)} I${f(i)} J${f(j)} E${f(e)} F${f(feed)}`);
    lastX = x;
    lastY = y;
  };

  const arcFit = params.arcFitting === true;
  const arcTol = params.arcTolerance ?? 0.05;

  // Print a single open/closed polyline as: travel to first point, extrude rest.
  // When arc-fitting is on, perimeter runs are condensed into G2/G3 arcs.
  const printPath = (pl: Polyline, feed: number, allowArcs = false) => {
    const pts = pl.points;
    if (pts.length < 2) return;
    travelTo(pts[0].x, pts[0].y, params.travelSpeed);
    unretractMove();
    // Build the ordered point list to traverse (append the closing vertex).
    const seq = pl.closed ? [...pts, pts[0]] : pts;
    if (allowArcs && arcFit && seq.length > 3) {
      const moves = fitArcs(seq, arcTol);
      for (const mv of moves) {
        if (mv.arc) arcTo(mv.end.x, mv.end.y, mv.arc.center, mv.arc.ccw, feed);
        else extrudeTo(mv.end.x, mv.end.y, feed);
      }
    } else {
      for (let i = 1; i < seq.length; i++) extrudeTo(seq[i].x, seq[i].y, feed);
    }
  };

  // ---- Adhesion (D7): skirt / brim / raft on the first layer ----------------
  // Back-compat: when `adhesion` is absent, fall back to the legacy `skirt` flag.
  const adhesion = params.adhesion ?? (params.skirt ? 'skirt' : 'none');
  const brimLoops = Math.max(1, Math.floor(params.brimLoops ?? 8));

  // A rectangular loop around the model footprint, expanded by `margin` mm.
  const footprintLoop = (margin: number): Polyline | null => {
    const bb = slice.bounds;
    if (!bb.isValid()) return null;
    const sk = new Polyline();
    sk.add({ x: bb.min.x - margin, y: bb.min.y - margin });
    sk.add({ x: bb.max.x + margin, y: bb.min.y - margin });
    sk.add({ x: bb.max.x + margin, y: bb.max.y + margin });
    sk.add({ x: bb.min.x - margin, y: bb.max.y + margin });
    sk.closed = true;
    return sk;
  };

  // Skirt: one priming loop offset out from the footprint (no part contact).
  const drawSkirt = () => {
    const sk = footprintLoop(3);
    if (!sk) return;
    out.push('; skirt');
    printPath(sk, firstSpeed);
  };
  // Brim: N loops from the part outline outward (each ~one line apart) — flat,
  // peelable grip. Implemented as concentric rectangular loops touching the bbox.
  const drawBrim = () => {
    if (!slice.bounds.isValid()) return;
    out.push('; brim');
    for (let i = brimLoops; i >= 1; i--) {
      const loop = footprintLoop(params.lineWidth * i);
      if (loop) printPath(loop, firstSpeed);
    }
  };
  // Raft: a sparse solid first-layer mat under the whole footprint (the model
  // then prints on top). Cheap rectilinear fill at 2× line spacing.
  const drawRaft = () => {
    const base = footprintLoop(2);
    if (!base) return;
    out.push('; raft');
    printPath(base, firstSpeed);
    const lines = buildInfill(base, params.lineWidth * 2, 0);
    for (const l of lines) printPath(l, firstSpeed);
  };
  const drawAdhesion = () => {
    if (adhesion === 'skirt') drawSkirt();
    else if (adhesion === 'brim') drawBrim();
    else if (adhesion === 'raft') drawRaft();
  };

  // ---- Ironing (D10): re-traverse a top surface at low flow to smooth it. ---
  const ironingFlow = params.ironingFlow ?? 0.1;
  const ironSpeed = Math.max(600, Math.round(params.printSpeed * 0.5));
  const ironLayer = (layer: SliceLayer) => {
    if (!params.ironing || !layer.topSurface || !layer.topRegions?.length) return;
    out.push('; ironing');
    const ironSpacing = Math.max(params.lineWidth * 0.25, 0.1);
    for (const region of layer.topRegions) {
      const passes = buildInfill(region, ironSpacing, 45);
      for (const p of passes) {
        const pts = p.points;
        if (pts.length < 2) continue;
        travelTo(pts[0].x, pts[0].y, params.travelSpeed);
        unretractMove();
        for (let i = 1; i < pts.length; i++) extrudeTo(pts[i].x, pts[i].y, ironSpeed, ironingFlow);
      }
    }
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

    if (isFirst) drawAdhesion();

    // Support first (printed before the model on each layer so the nozzle isn't
    // dragging over fresh part walls). Support never uses arc-fitting.
    if (layer.support && layer.support.length) {
      out.push('; support');
      for (const sp of layer.support) printPath(sp, speed);
    }
    // Perimeters (arc-fittable) for surface quality, then infill (straight).
    for (const w of layer.perimeters) printPath(w, speed, true);
    for (const fpath of layer.infill) printPath(fpath, speed);
    // Ironing pass over a finished top surface (low-flow smoothing, D10).
    ironLayer(layer);
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
    if (layer.support) for (const s of layer.support) layerLen += pathLen(s);
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
// Feature-typed preview segments (D3 — layer / feature preview)
// ============================================================================

/** Which feature a previewed move belongs to (drives the preview colour). */
export type FeatureType = 'perimeter' | 'infill' | 'support' | 'travel';

/** One previewed move: a polyline of XY points at layer height `z`, with a type. */
export interface PreviewSegment {
  type: FeatureType;
  z: number;
  /** Flat [x0,y0, x1,y1, …] coordinate pairs (cheap to ship + render). */
  pts: number[];
}

/** Preview geometry grouped per layer, ready for the 3D layer scrubber. */
export interface PreviewLayer {
  z: number;
  segments: PreviewSegment[];
}

/**
 * Build lightweight, feature-typed preview geometry from a slice result for the
 * 3D layer scrubber. Perimeters/infill/support are emitted as typed polylines,
 * and the travel hops BETWEEN printed paths are reconstructed as 'travel'
 * segments (so the preview can show rapids). Coordinates carry the same XY
 * offset the emitter applies, so the preview lines up with the toolpath.
 */
export function buildPreviewLayers(slice: SliceResult, offsetX = 0, offsetY = 0): PreviewLayer[] {
  const layers: PreviewLayer[] = [];
  const flat = (pl: Polyline): number[] => {
    const a: number[] = [];
    for (const p of pl.points) a.push(p.x + offsetX, p.y + offsetY);
    if (pl.closed && pl.points.length) a.push(pl.points[0].x + offsetX, pl.points[0].y + offsetY);
    return a;
  };
  for (const layer of slice.layers) {
    const segments: PreviewSegment[] = [];
    let prevEnd: [number, number] | null = null;
    const emit = (pl: Polyline, type: FeatureType) => {
      if (pl.points.length < 2) return;
      const pts = flat(pl);
      // Travel from the previous path's end to this path's start.
      const sx = pts[0], sy = pts[1];
      if (prevEnd && (prevEnd[0] !== sx || prevEnd[1] !== sy)) {
        segments.push({ type: 'travel', z: layer.z, pts: [prevEnd[0], prevEnd[1], sx, sy] });
      }
      segments.push({ type, z: layer.z, pts });
      prevEnd = [pts[pts.length - 2], pts[pts.length - 1]];
    };
    if (layer.support) for (const s of layer.support) emit(s, 'support');
    for (const w of layer.perimeters) emit(w, 'perimeter');
    for (const f of layer.infill) emit(f, 'infill');
    layers.push({ z: layer.z, segments });
  }
  return layers;
}

// ============================================================================
// Pressure-advance / linear-advance calibration pattern (D9)
// ============================================================================

export interface PaTestParams {
  /** Marlin (M900 K) vs Klipper (SET_PRESSURE_ADVANCE) flavour of the command. */
  firmware: 'marlin' | 'klipper';
  startK: number;       // first PA/K value
  endK: number;         // last PA/K value
  steps: number;        // number of swept lines (>=2)
  // Geometry
  lineLength: number;   // mm, length of each test line's fast section
  lineSpacing: number;  // mm, Y spacing between swept lines
  // Print params reused from the main settings
  layerHeight: number;
  lineWidth: number;
  filamentDiameter: number;
  nozzleTemp: number;
  bedTemp: number;
  slowSpeed: number;    // mm/min (start/end of each line)
  fastSpeed: number;    // mm/min (middle of each line — reveals PA error)
  // Bed centring
  bedX: number;
  bedY: number;
}

/**
 * Generate a pressure-advance / linear-advance calibration print: a fan of
 * horizontal lines, each printed at a different PA value, where every line has a
 * slow→fast→slow speed profile. The PA value that yields uniform extrusion at
 * the fast↔slow transitions is the calibrated one. Emits valid, safe FDM G-code
 * (heat + wait, prime, per-line PA command, safe end). Pure (no DOM).
 */
export function generatePaTest(p: PaTestParams): string {
  const dec = 3;
  const f = (v: number) => fmt(v, dec);
  const steps = Math.max(2, Math.floor(p.steps));
  const ePerMm = extrusionPerMm(p.lineWidth, p.layerHeight, p.filamentDiameter);
  const out: string[] = [];

  // Centre the pattern on the bed.
  const totalY = (steps - 1) * p.lineSpacing;
  const x0 = p.bedX / 2 - p.lineLength / 2;
  const slowLen = Math.min(20, p.lineLength * 0.25);
  const x1 = x0 + slowLen;
  const x2 = x0 + p.lineLength - slowLen;
  const x3 = x0 + p.lineLength;
  const yStart = p.bedY / 2 - totalY / 2;

  out.push('; karmyogi pressure-advance / linear-advance calibration');
  out.push(`; ${p.firmware} sweep K=${p.startK}..${p.endK} over ${steps} lines`);
  out.push('G21 ; mm');
  out.push('G90 ; absolute positioning');
  out.push('M82 ; absolute extrusion');
  out.push(`M140 S${f(p.bedTemp)} ; set bed temp`);
  out.push(`M104 S${f(p.nozzleTemp)} ; set hotend temp`);
  out.push(`M190 S${f(p.bedTemp)} ; wait for bed`);
  out.push(`M109 S${f(p.nozzleTemp)} ; wait for hotend`);
  out.push('G28 ; home all axes');
  out.push('G92 E0 ; zero extruder');
  out.push('M107 ; fan off');
  out.push(`G1 Z${f(p.layerHeight)} F${f(p.slowSpeed)}`);
  out.push(`G1 E${f(2)} F${f(p.slowSpeed)} ; prime`);

  let e = 2;
  const extrude = (fromX: number, toX: number, y: number, feed: number) => {
    e += Math.abs(toX - fromX) * ePerMm;
    out.push(`G1 X${f(toX)} Y${f(y)} E${f(e)} F${f(feed)}`);
  };

  for (let i = 0; i < steps; i++) {
    const k = p.startK + ((p.endK - p.startK) * i) / (steps - 1);
    const y = yStart + i * p.lineSpacing;
    out.push(`; line ${i + 1}/${steps}  K=${k.toFixed(4)}`);
    if (p.firmware === 'marlin') out.push(`M900 K${k.toFixed(4)} ; set linear advance`);
    else out.push(`SET_PRESSURE_ADVANCE ADVANCE=${k.toFixed(4)} ; set pressure advance`);
    // Travel to the line start.
    out.push(`G1 E${f(e - 0.8)} F${f(p.slowSpeed)} ; retract`);
    out.push(`G0 X${f(x0)} Y${f(y)} F${f(Math.max(p.fastSpeed, p.slowSpeed))}`);
    out.push(`G1 E${f(e)} F${f(p.slowSpeed)} ; unretract`);
    // slow → fast → slow profile.
    extrude(x0, x1, y, p.slowSpeed);
    extrude(x1, x2, y, p.fastSpeed);
    extrude(x2, x3, y, p.slowSpeed);
  }

  out.push('; end');
  out.push('M104 S0 ; hotend off');
  out.push('M140 S0 ; bed off');
  out.push('M107 ; fan off');
  out.push(`G1 Z${f(p.layerHeight + 10)} F${f(p.slowSpeed)} ; raise Z`);
  out.push('G28 X Y ; park');
  out.push('M84 ; disable steppers');
  return out.join('\n') + '\n';
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
  /** Feature-typed per-layer preview geometry for the 3D layer scrubber. */
  preview?: PreviewLayer[];
}

export interface SliceWorkerError {
  type: 'error';
  message: string;
  /** True when the failure was a cooperative cancel rather than a real error. */
  cancelled?: boolean;
}

export type SliceWorkerOutbound = SliceWorkerProgress | SliceWorkerDone | SliceWorkerError;
