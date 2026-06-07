/**
 * IndexedDB persistence for the 3D-carving job list (`useCarveJobs`).
 *
 * Carve jobs own large interleaved triangle arrays (Float32Array), which can be
 * many megabytes — far too big for localStorage (string-only, ~5MB quota) and
 * wasteful to base64-encode. IndexedDB stores structured-cloneable values
 * (including typed arrays / ArrayBuffers) natively, so the heavy mesh data
 * round-trips cheaply.
 *
 * This module is intentionally self-contained and DEFENSIVE:
 *   - every call is a silent no-op if IndexedDB is unavailable (private mode,
 *     old browser, blocked storage) — it must never throw into the UI;
 *   - writes are DEBOUNCED so rapid setting tweaks coalesce into one save;
 *   - loads/saves are async and never block the UI thread.
 *
 * Wiring: `useCarveJobs` calls `hydrateCarveJobs()` once at module init and
 * `saveCarveJobs()` after any mutation; both are guarded here.
 */

import type { StlMesh } from '../core/slicer'
import type {
  CarveJob,
  JobDefaults,
  GlobalCarveSettings,
} from './carveJobs'

const DB_NAME = 'karmyogi-carve'
const DB_VERSION = 1
const STORE = 'state'
/** Single fixed key — we persist one snapshot of the whole job list. */
const KEY = 'jobs'
/** Coalesce bursts of edits into one write. */
const SAVE_DEBOUNCE_MS = 400

/** Shape persisted to IndexedDB. Mesh typed arrays are stored as-is. */
interface PersistedMesh {
  triangles: Float32Array
  vertexCount: number
  triangleCount: number
  bbox: { min: [number, number, number]; max: [number, number, number] }
  format: 'binary' | 'ascii'
}

interface PersistedJob extends Omit<CarveJob, 'mesh'> {
  mesh: PersistedMesh
}

export interface CarveJobsSnapshot {
  /** Schema version so we can bail gracefully on incompatible old data. */
  v: number
  jobs: PersistedJob[]
  selectedId: string | null
  defaults: JobDefaults
  global: GlobalCarveSettings
}

const SNAPSHOT_VERSION = 1

/** True only in a browser that exposes a usable IndexedDB. */
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (!idbAvailable()) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  }).catch(() => null)
  return dbPromise
}

/** Convert a live mesh into a structured-cloneable snapshot (typed array kept). */
function packMesh(mesh: StlMesh): PersistedMesh {
  return {
    triangles: mesh.triangles,
    vertexCount: mesh.vertexCount,
    triangleCount: mesh.triangleCount,
    bbox: {
      min: [mesh.bbox.min[0], mesh.bbox.min[1], mesh.bbox.min[2]],
      max: [mesh.bbox.max[0], mesh.bbox.max[1], mesh.bbox.max[2]],
    },
    format: mesh.format,
  }
}

/** Rebuild a live mesh from a snapshot; null if the blob is malformed. */
function unpackMesh(m: PersistedMesh | undefined | null): StlMesh | null {
  if (!m) return null
  // After structured clone a Float32Array round-trips as a Float32Array; guard
  // against a corrupted/legacy blob where it may be an ArrayBuffer or missing.
  const raw = m.triangles as unknown
  let tris: Float32Array | null = null
  if (raw instanceof Float32Array) {
    tris = raw
  } else if (raw instanceof ArrayBuffer) {
    try {
      tris = new Float32Array(raw)
    } catch {
      tris = null
    }
  }
  if (!tris) return null
  if (!m.bbox || !Array.isArray(m.bbox.min) || !Array.isArray(m.bbox.max)) return null
  return {
    triangles: tris,
    vertexCount: m.vertexCount,
    triangleCount: m.triangleCount,
    bbox: m.bbox,
    format: m.format,
  }
}

/** What the store hands us when it asks to persist. */
export interface CarveJobsLiveState {
  jobs: CarveJob[]
  selectedId: string | null
  defaults: JobDefaults
  global: GlobalCarveSettings
}

/** What hydrate hands back to the store (live meshes restored). */
export interface CarveJobsHydrated {
  jobs: CarveJob[]
  selectedId: string | null
  defaults: JobDefaults
  global: GlobalCarveSettings
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
let pending: CarveJobsLiveState | null = null

/**
 * Persist the current job list (debounced). Safe no-op without IndexedDB.
 * Callers pass a snapshot of the live state; we keep the LATEST one and flush
 * once the debounce settles.
 */
export function saveCarveJobs(state: CarveJobsLiveState): void {
  if (!idbAvailable()) return
  pending = state
  if (saveTimer != null) clearTimeout(saveTimer)
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS)
}

function flush(): void {
  saveTimer = null
  const state = pending
  pending = null
  if (!state) return
  const snapshot: CarveJobsSnapshot = {
    v: SNAPSHOT_VERSION,
    jobs: state.jobs.map((j) => ({ ...j, mesh: packMesh(j.mesh) })),
    selectedId: state.selectedId,
    defaults: state.defaults,
    global: state.global,
  }
  void openDb().then((db) => {
    if (!db) return
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(snapshot, KEY)
      // Swallow tx errors — persistence is best-effort.
      tx.onerror = () => {}
      tx.onabort = () => {}
    } catch {
      /* ignore */
    }
  })
}

/**
 * Load the persisted snapshot. Resolves to null when nothing was saved, the
 * schema is incompatible, or IndexedDB is unavailable — so the store keeps its
 * in-memory defaults. Drops any job whose mesh failed to deserialize.
 */
export async function hydrateCarveJobs(): Promise<CarveJobsHydrated | null> {
  if (!idbAvailable()) return null
  const db = await openDb()
  if (!db) return null
  const snapshot = await new Promise<CarveJobsSnapshot | null>((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly')
      const req = tx.objectStore(STORE).get(KEY)
      req.onsuccess = () => resolve((req.result as CarveJobsSnapshot) ?? null)
      req.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  if (!snapshot || snapshot.v !== SNAPSHOT_VERSION || !Array.isArray(snapshot.jobs)) {
    return null
  }
  const jobs: CarveJob[] = []
  for (const pj of snapshot.jobs) {
    const mesh = unpackMesh(pj.mesh)
    if (!mesh) continue // skip corrupted entries rather than crash hydration
    const { mesh: _drop, ...rest } = pj
    void _drop
    jobs.push({ ...(rest as Omit<CarveJob, 'mesh'>), mesh })
  }
  // Keep the persisted selection only if it still resolves to a live job.
  const selectedId =
    snapshot.selectedId && jobs.some((j) => j.id === snapshot.selectedId)
      ? snapshot.selectedId
      : jobs.length
        ? jobs[jobs.length - 1].id
        : null
  return {
    jobs,
    selectedId,
    defaults: snapshot.defaults,
    global: snapshot.global,
  }
}

/** Clear the persisted snapshot (used when the store is explicitly cleared). */
export function clearPersistedCarveJobs(): void {
  if (!idbAvailable()) return
  if (saveTimer != null) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  pending = null
  void openDb().then((db) => {
    if (!db) return
    try {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(KEY)
      tx.onerror = () => {}
    } catch {
      /* ignore */
    }
  })
}
