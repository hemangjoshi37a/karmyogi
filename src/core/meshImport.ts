// Multi-format 3D mesh importer for the 3D Carving pipeline.
//
// Produces the SAME `StlMesh` structure the carve3d worker already consumes
// (see core/slicer.ts), regardless of source format. STL is delegated to the
// existing `parseStl`; OBJ is parsed/triangulated here; STEP/STP/IGES go
// through the OpenCascade WASM build (occt-import-js), loaded lazily so it
// never bloats the initial bundle.
//
// Pure-ish: no React / DOM imports. It does use `fetch` + dynamic `import()`
// to lazy-load the WASM, which is fine in both the main thread and a worker.

import { parseStl, STL_STRIDE, MAX_TRIANGLES, type StlMesh } from './slicer'

// ---------------------------------------------------------------------------
// occt-import-js (OpenCascade WASM) — lazily-loaded STEP/IGES/BREP parser.
// The package ships a UMD-ish factory + a sibling .wasm; Vite gives us the
// hashed asset URL via the `?url` import and we point the loader at it.
// ---------------------------------------------------------------------------

// occt-import-js has no bundled types; describe just the bits we touch.
interface OcctMesh {
  attributes: {
    position: { array: number[] | Float32Array }
    normal?: { array: number[] | Float32Array }
  }
  index: { array: number[] | Uint32Array }
}
interface OcctResult {
  success: boolean
  meshes: OcctMesh[]
}
interface OcctTriParams {
  linearUnit?: 'millimeter' | 'centimeter' | 'meter' | 'inch' | 'foot'
  linearDeflectionType?: 'bounding_box_ratio' | 'absolute_value'
  linearDeflection?: number
  angularDeflection?: number
}
interface OcctModule {
  ReadStepFile(content: Uint8Array, params: OcctTriParams | null): OcctResult
  ReadIgesFile(content: Uint8Array, params: OcctTriParams | null): OcctResult
  ReadBrepFile(content: Uint8Array, params: OcctTriParams | null): OcctResult
}
type OcctFactory = (moduleArg?: {
  locateFile?: (path: string, prefix: string) => string
}) => Promise<OcctModule>

let occtPromise: Promise<OcctModule> | null = null

/** Lazily initialise the OpenCascade WASM module (cached after first load). */
async function loadOcct(): Promise<OcctModule> {
  if (occtPromise) return occtPromise
  occtPromise = (async () => {
    // Dynamic imports keep the ~heavy JS glue + the wasm URL out of the main
    // chunk; Vite emits the .wasm as a hashed asset and hands us its URL.
    const [{ default: factory }, { default: wasmUrl }] = await Promise.all([
      import('occt-import-js') as Promise<{ default: OcctFactory }>,
      import('occt-import-js/dist/occt-import-js.wasm?url') as Promise<{ default: string }>,
    ])
    return factory({
      // The glue calls locateFile('occt-import-js.wasm'); redirect it to the
      // bundled asset URL so the fetch resolves under any base path.
      locateFile: (path) => (path.endsWith('.wasm') ? wasmUrl : path),
    })
  })().catch((err) => {
    occtPromise = null // allow a retry on a later import attempt
    throw err
  })
  return occtPromise
}

// ---------------------------------------------------------------------------
// Shared StlMesh assembly (mirrors slicer.ts finalizeMesh, kept in sync).
// ---------------------------------------------------------------------------

/**
 * Build an `StlMesh` from a flat list of triangle vertex positions. `positions`
 * is [x,y,z, x,y,z, ...], 3 vertices per triangle (3*3 floats/triangle).
 * Per-vertex normals are optional; when absent (or degenerate) a face normal is
 * computed. The output layout matches `parseStl` exactly so the carve worker
 * accepts it unchanged.
 */
function meshFromTriangles(
  positions: Float32Array | number[],
  normals: Float32Array | number[] | null,
): StlMesh {
  const vertCount = Math.floor(positions.length / 3)
  const triangleCount = Math.floor(vertCount / 3)
  if (triangleCount === 0) {
    return {
      triangles: new Float32Array(0),
      vertexCount: 0,
      triangleCount: 0,
      bbox: { min: [0, 0, 0], max: [0, 0, 0] },
      format: 'binary',
    }
  }
  if (triangleCount > MAX_TRIANGLES) {
    throw new Error(`Mesh has ${triangleCount} triangles (cap ${MAX_TRIANGLES}); refusing to load.`)
  }

  const out = new Float32Array(triangleCount * 3 * STL_STRIDE)
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const hasNormals = !!normals && normals.length >= positions.length

  let o = 0
  for (let t = 0; t < triangleCount; t++) {
    const p = t * 9
    const ax = positions[p], ay = positions[p + 1], az = positions[p + 2]
    const bx = positions[p + 3], by = positions[p + 4], bz = positions[p + 5]
    const cx = positions[p + 6], cy = positions[p + 7], cz = positions[p + 8]

    // Face normal (fallback / when per-vertex normals are missing or zero).
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let fnx = uy * vz - uz * vy
    let fny = uz * vx - ux * vz
    let fnz = ux * vy - uy * vx
    const flen = Math.hypot(fnx, fny, fnz)
    if (flen > 1e-12) { fnx /= flen; fny /= flen; fnz /= flen }

    const verts = [ax, ay, az, bx, by, bz, cx, cy, cz]
    for (let k = 0; k < 3; k++) {
      const x = verts[k * 3], y = verts[k * 3 + 1], z = verts[k * 3 + 2]
      if (x < min[0]) min[0] = x
      if (y < min[1]) min[1] = y
      if (z < min[2]) min[2] = z
      if (x > max[0]) max[0] = x
      if (y > max[1]) max[1] = y
      if (z > max[2]) max[2] = z

      let nx = fnx, ny = fny, nz = fnz
      if (hasNormals && normals) {
        const np = p + k * 3
        const vnx = normals[np], vny = normals[np + 1], vnz = normals[np + 2]
        if (Math.hypot(vnx, vny, vnz) > 0.5) { nx = vnx; ny = vny; nz = vnz }
      }
      out[o++] = x; out[o++] = y; out[o++] = z
      out[o++] = nx; out[o++] = ny; out[o++] = nz
    }
  }

  return {
    triangles: out,
    vertexCount: triangleCount * 3,
    triangleCount,
    bbox: { min, max },
    format: 'binary',
  }
}

// ---------------------------------------------------------------------------
// OBJ — minimal triangulating parser (v / f only; materials & textures ignored).
// ---------------------------------------------------------------------------

/**
 * Parse a Wavefront OBJ into an `StlMesh`. Only vertex (`v`) and face (`f`)
 * records are used; normals/UVs are ignored (face normals are recomputed).
 * Polygonal faces are fan-triangulated. Negative (relative) indices supported.
 */
function parseObj(text: string): StlMesh {
  const verts: number[] = [] // flat x,y,z
  const positions: number[] = [] // triangulated output positions

  const lines = text.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]
    // Cheap leading-char dispatch before splitting.
    const c0 = line.charCodeAt(0)
    if (c0 === 0x76 /* v */) {
      // Only plain "v " (skip vt / vn / vp).
      const c1 = line.charCodeAt(1)
      if (c1 !== 0x20 && c1 !== 0x09) continue
      const parts = line.trim().split(/\s+/)
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3])
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) verts.push(x, y, z)
    } else if (c0 === 0x66 /* f */) {
      const c1 = line.charCodeAt(1)
      if (c1 !== 0x20 && c1 !== 0x09) continue
      const parts = line.trim().split(/\s+/)
      // Resolve each face vertex's position index (handle v / v/vt / v//vn / v/vt/vn).
      const idx: number[] = []
      const total = verts.length / 3
      for (let i = 1; i < parts.length; i++) {
        const tok = parts[i]
        if (!tok) continue
        const slash = tok.indexOf('/')
        const vStr = slash >= 0 ? tok.slice(0, slash) : tok
        let vi = parseInt(vStr, 10)
        if (!Number.isFinite(vi)) continue
        if (vi < 0) vi = total + vi // relative index
        else vi -= 1 // OBJ is 1-based
        if (vi < 0 || vi >= total) continue
        idx.push(vi)
      }
      // Fan-triangulate the (possibly n-gon) face.
      for (let k = 2; k < idx.length; k++) {
        const a = idx[0] * 3, b = idx[k - 1] * 3, cc = idx[k] * 3
        positions.push(
          verts[a], verts[a + 1], verts[a + 2],
          verts[b], verts[b + 1], verts[b + 2],
          verts[cc], verts[cc + 1], verts[cc + 2],
        )
      }
      if (positions.length / 9 > MAX_TRIANGLES) {
        throw new Error(`OBJ exceeds triangle cap ${MAX_TRIANGLES}; refusing to load.`)
      }
    }
  }

  if (positions.length === 0) throw new Error('OBJ contained no triangular faces.')
  return meshFromTriangles(positions, null)
}

// ---------------------------------------------------------------------------
// STEP / IGES / BREP via occt-import-js.
// ---------------------------------------------------------------------------

/** Merge every tessellated mesh in an occt result into one `StlMesh`. */
function meshFromOcct(result: OcctResult): StlMesh {
  if (!result.success) throw new Error('OpenCascade could not parse this file.')
  if (!result.meshes || result.meshes.length === 0) {
    throw new Error('File parsed but produced no geometry.')
  }

  // Expand indexed meshes into a single triangle-soup (positions + normals),
  // matching what meshFromTriangles expects.
  const positions: number[] = []
  const normals: number[] = []
  for (const m of result.meshes) {
    const pos = m.attributes?.position?.array
    const idxArr = m.index?.array
    if (!pos || !idxArr) continue
    const nrm = m.attributes?.normal?.array ?? null
    for (let i = 0; i < idxArr.length; i++) {
      const vi = idxArr[i] * 3
      positions.push(pos[vi], pos[vi + 1], pos[vi + 2])
      if (nrm) normals.push(nrm[vi], nrm[vi + 1], nrm[vi + 2])
      else normals.push(0, 0, 0)
    }
    if (positions.length / 9 > MAX_TRIANGLES) {
      throw new Error(`STEP exceeds triangle cap ${MAX_TRIANGLES}; refusing to load.`)
    }
  }

  if (positions.length === 0) throw new Error('STEP produced no triangles.')
  return meshFromTriangles(positions, normals)
}

/** Parse a STEP/STP file buffer into an `StlMesh` (units kept in mm). */
async function parseStep(buffer: ArrayBuffer): Promise<StlMesh> {
  let occt: OcctModule
  try {
    occt = await loadOcct()
  } catch (err) {
    throw new Error(
      `Couldn't load the STEP importer (OpenCascade WASM): ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
  }
  const result = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'millimeter' })
  return meshFromOcct(result)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** File extensions accepted by `importMesh`. */
export const MESH_IMPORT_EXTS = ['stl', 'obj', 'step', 'stp'] as const

/** True when `name`'s extension is a supported mesh format. */
export function isMeshFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return (MESH_IMPORT_EXTS as readonly string[]).includes(ext)
}

/** True when importing this file needs the heavy async WASM path (STEP). */
export function isHeavyMeshFile(name: string): boolean {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  return ext === 'step' || ext === 'stp'
}

export interface MeshSource {
  name: string
  buffer: ArrayBuffer
}

/**
 * Import a 3D mesh file (STL / OBJ / STEP / STP) into the carving pipeline's
 * `StlMesh` structure. Dispatches by extension; STEP is async (WASM). Throws a
 * descriptive Error on unsupported extensions or parse failures.
 */
export async function importMesh(file: File | MeshSource): Promise<StlMesh> {
  const name = file.name
  const ext = name.toLowerCase().split('.').pop() ?? ''
  const buffer = 'arrayBuffer' in file ? await file.arrayBuffer() : file.buffer

  switch (ext) {
    case 'stl':
      return parseStl(buffer)
    case 'obj':
      return parseObj(new TextDecoder().decode(buffer))
    case 'step':
    case 'stp':
      return parseStep(buffer)
    default:
      throw new Error(`Unsupported 3D file type ".${ext}".`)
  }
}
