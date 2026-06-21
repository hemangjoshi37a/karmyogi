/**
 * Carving SESSION export / import (pure core — no React / DOM / zustand).
 *
 * A "carving session" is everything the CAD/CAM (Carving) panel needs to restore
 * its full working state across a page reload / power-cycle: every loaded source
 * file (the raw DXF / EPS / STL bytes), the per-file/per-job operations and
 * parameters, the placement, and the active presets. We pack it as a ZIP (via
 * {@link https://github.com/101arrowz/fflate fflate}) containing:
 *
 *   carve-session.json   — the {@link CarveSessionManifest} (versioned JSON)
 *   sources/<safeName>   — one raw source file per loaded file / job
 *
 * The manifest references each source by its in-zip path, so a round-trip is
 * exact: unzip → parse the manifest → re-import the referenced bytes → restore
 * the operations/params/presets the manifest carries.
 *
 * This module is deliberately FRAMEWORK-FREE so it stays portable and testable;
 * the panel owns turning live React/zustand state into a manifest and back.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

/** Current manifest schema version. Bump on any breaking shape change. */
export const CARVE_SESSION_VERSION = 1

/** The well-known manifest file name inside the session zip. */
export const MANIFEST_NAME = 'carve-session.json'

/** Directory (inside the zip) the raw source files live under. */
export const SOURCES_DIR = 'sources'

/** The file-extension/suffix used for a downloaded session zip. */
export const CARVE_SESSION_EXT = 'karmyogi-carve.zip'

/**
 * One loaded source file recorded in the manifest. `path` is the in-zip path of
 * its raw bytes (under {@link SOURCES_DIR}); `kind` tells the importer how to
 * re-parse it. `payload` carries whatever per-file state the panel needs to
 * restore (ops, params, placement, …) — its exact shape is opaque to this core.
 */
export interface CarveSessionEntry {
  /** Stable id this entry's payload is keyed by in the live panel state. */
  id: string
  /** Original file name (with extension), for display + re-import. */
  name: string
  /** Family of the source so the importer picks the right parser. */
  kind: 'dxf' | 'eps' | 'mesh'
  /** In-zip path of the raw source bytes (under {@link SOURCES_DIR}). */
  path: string
  /** Opaque per-entry restore payload (operations / params / placement / …). */
  payload?: unknown
}

/** The versioned session manifest written to `carve-session.json`. */
export interface CarveSessionManifest {
  /** Must be `'karmyogi.carve-session'` — guards against unrelated zips. */
  kind: 'karmyogi.carve-session'
  /** Schema version (see {@link CARVE_SESSION_VERSION}). */
  version: number
  /** ISO timestamp the session was exported (informational). */
  savedAt: string
  /** Which family the panel was showing ('2d' | '3d'). */
  mode: string
  /** The loaded source files / jobs + their per-entry restore payloads. */
  entries: CarveSessionEntry[]
  /**
   * Opaque WHOLE-SESSION restore payload (global params, presets, the bottom-
   * section settings, op order, …). Shape is owned by the panel; we only
   * round-trip it as JSON.
   */
  globals?: unknown
}

/** Raw bytes for one source file, keyed by the entry id it belongs to. */
export interface CarveSessionSource {
  id: string
  /** Original file name (used to derive the in-zip path + extension). */
  name: string
  bytes: Uint8Array
}

/** The fully-parsed result of reading a session zip. */
export interface ParsedCarveSession {
  manifest: CarveSessionManifest
  /** Raw bytes for each entry, keyed by entry id. Missing if a source was absent. */
  sources: Map<string, Uint8Array>
}

/** Thrown when a session zip is malformed, unrelated, or an unsupported version. */
export class CarveSessionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CarveSessionError'
  }
}

/** Sanitise a file name into a safe single path segment (no slashes / spaces). */
function safeSegment(name: string): string {
  const cleaned = name.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'file'
}

/**
 * Build the in-zip path for an entry's source bytes. Prefixes the entry id so
 * two files that share a display name (e.g. "drawing.dxf" + its "(copy)") never
 * collide on one path.
 */
export function sourcePathFor(entry: { id: string; name: string }): string {
  return `${SOURCES_DIR}/${safeSegment(entry.id)}-${safeSegment(entry.name)}`
}

/**
 * Build a session ZIP from a manifest spec + the raw source bytes.
 *
 * The caller provides the per-entry metadata/payloads (without `path`) and a
 * matching list of raw source bytes; we assign each entry its in-zip path,
 * write the sources under {@link SOURCES_DIR}, serialise the manifest, and zip
 * it all. Returns the zip as a `Uint8Array` ready to download.
 */
export function buildCarveSessionZip(spec: {
  mode: string
  entries: Array<Omit<CarveSessionEntry, 'path'>>
  sources: CarveSessionSource[]
  globals?: unknown
}): Uint8Array {
  const sourceById = new Map(spec.sources.map((s) => [s.id, s]))
  const files: Record<string, Uint8Array> = {}
  const entries: CarveSessionEntry[] = []

  for (const e of spec.entries) {
    const src = sourceById.get(e.id)
    const entry: CarveSessionEntry = {
      id: e.id,
      name: e.name,
      kind: e.kind,
      path: src ? sourcePathFor({ id: e.id, name: src.name }) : '',
      payload: e.payload,
    }
    if (src) files[entry.path] = src.bytes
    entries.push(entry)
  }

  const manifest: CarveSessionManifest = {
    kind: 'karmyogi.carve-session',
    version: CARVE_SESSION_VERSION,
    savedAt: new Date().toISOString(),
    mode: spec.mode,
    entries,
    globals: spec.globals,
  }
  files[MANIFEST_NAME] = strToU8(JSON.stringify(manifest, null, 2))
  // Level 6 is a good balance — STL bytes compress well; the manifest is tiny.
  return zipSync(files, { level: 6 })
}

/**
 * Parse a session ZIP back into its manifest + per-entry source bytes.
 *
 * Validates that the zip carries a recognisable `carve-session.json` of a
 * supported version; throws {@link CarveSessionError} with a clear message on a
 * bad / unrelated / too-new zip so the caller can surface it to the user.
 */
export function parseCarveSessionZip(bytes: Uint8Array): ParsedCarveSession {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch (err) {
    throw new CarveSessionError(
      `Not a valid zip file (${err instanceof Error ? err.message : String(err)}).`,
    )
  }

  const manifestBytes = files[MANIFEST_NAME]
  if (!manifestBytes) {
    throw new CarveSessionError(
      `Missing ${MANIFEST_NAME} — this is not a karmyogi carving session.`,
    )
  }

  let manifest: CarveSessionManifest
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as CarveSessionManifest
  } catch {
    throw new CarveSessionError(`Corrupt ${MANIFEST_NAME} — could not parse the manifest.`)
  }

  if (!manifest || manifest.kind !== 'karmyogi.carve-session') {
    throw new CarveSessionError('This zip is not a karmyogi carving session.')
  }
  if (typeof manifest.version !== 'number' || manifest.version < 1) {
    throw new CarveSessionError('Unrecognised carving-session version.')
  }
  if (manifest.version > CARVE_SESSION_VERSION) {
    throw new CarveSessionError(
      `This session was saved by a newer karmyogi (v${manifest.version}); update to open it.`,
    )
  }
  if (!Array.isArray(manifest.entries)) {
    throw new CarveSessionError('Corrupt session — the entries list is missing.')
  }

  const sources = new Map<string, Uint8Array>()
  for (const e of manifest.entries) {
    if (e && e.id && e.path && files[e.path]) sources.set(e.id, files[e.path])
  }
  return { manifest, sources }
}

/**
 * Encode the interleaved [x,y,z,nx,ny,nz]-per-vertex triangle array of a parsed
 * mesh back into a BINARY STL byte stream, so a mesh whose ORIGINAL file bytes
 * weren't retained can still be round-tripped (re-imported on upload). Pure: it
 * only reads the typed array. `triangleCount` triangles, 3 verts each, stride 6.
 */
export function meshToBinaryStl(triangles: Float32Array, triangleCount: number): Uint8Array {
  const STRIDE = 6 // [x,y,z, nx,ny,nz] per vertex
  const buf = new ArrayBuffer(84 + triangleCount * 50)
  const view = new DataView(buf)
  // 80-byte header (zeroed) + uint32 triangle count.
  view.setUint32(80, triangleCount, true)
  let off = 84
  for (let tri = 0; tri < triangleCount; tri++) {
    const base = tri * 3 * STRIDE
    // Facet normal: reuse the first vertex's stored normal.
    view.setFloat32(off, triangles[base + 3], true)
    view.setFloat32(off + 4, triangles[base + 4], true)
    view.setFloat32(off + 8, triangles[base + 5], true)
    off += 12
    for (let v = 0; v < 3; v++) {
      const p = base + v * STRIDE
      view.setFloat32(off, triangles[p], true)
      view.setFloat32(off + 4, triangles[p + 1], true)
      view.setFloat32(off + 8, triangles[p + 2], true)
      off += 12
    }
    view.setUint16(off, 0, true) // attribute byte count
    off += 2
  }
  return new Uint8Array(buf)
}
