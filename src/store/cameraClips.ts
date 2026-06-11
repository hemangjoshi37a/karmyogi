/**
 * IndexedDB-backed store for AUTO-recorded camera clips (the camera records the
 * machine while a program streams). Clips are large video blobs, so they live in
 * IndexedDB — NOT localStorage — under one object store keyed by a numeric id.
 *
 * UI-independent (no React/DOM beyond IndexedDB + Blob), so CameraPanel can stay
 * focused on rendering: it loads the metadata list on mount, saves a blob when a
 * recording finishes, and reads/deletes blobs for play/download/delete actions.
 */

const DB_NAME = 'karmyogi-camera'
const DB_VERSION = 1
const STORE = 'clips'

/** Persisted clip record. The blob is stored alongside its metadata. */
export interface StoredClip {
  /** Auto-increment primary key. */
  id: number
  /** Human, timestamp-based name (also the suggested download filename). */
  name: string
  /** Unix ms when the recording finished. */
  createdAt: number
  /** Recording duration in milliseconds. */
  durationMs: number
  /** Blob byte size (cached so the list needn't read the blob). */
  bytes: number
  /** MIME type of the stored blob. */
  mimeType: string
  /** The recorded video data. */
  blob: Blob
}

/** Lightweight metadata for the clips list (everything except the heavy blob). */
export type ClipMeta = Omit<StoredClip, 'blob'>

let dbPromise: Promise<IDBDatabase> | null = null

function idbSupported(): boolean {
  return typeof indexedDB !== 'undefined'
}

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (!idbSupported()) {
      reject(new Error('IndexedDB is not available in this browser.'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Failed to open the clips database.'))
  })
  // If opening fails, drop the cached rejected promise so a later call can retry.
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

/** Wrap an IDBRequest as a promise. */
function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'))
  })
}

/** Save a recorded clip; resolves to the full stored record (with its new id). */
export async function saveClip(input: {
  name: string
  blob: Blob
  durationMs: number
  mimeType: string
  createdAt?: number
}): Promise<StoredClip> {
  const db = await openDb()
  const record: Omit<StoredClip, 'id'> = {
    name: input.name,
    createdAt: input.createdAt ?? Date.now(),
    durationMs: input.durationMs,
    bytes: input.blob.size,
    mimeType: input.mimeType,
    blob: input.blob,
  }
  const tx = db.transaction(STORE, 'readwrite')
  const id = await reqAsPromise(tx.objectStore(STORE).add(record as StoredClip))
  return { ...record, id: id as number }
}

/** List all clips' metadata (newest first), without loading their blobs. */
export async function listClips(): Promise<ClipMeta[]> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const all = await reqAsPromise(tx.objectStore(STORE).getAll())
  const metas: ClipMeta[] = (all as StoredClip[]).map(
    ({ id, name, createdAt, durationMs, bytes, mimeType }) => ({
      id,
      name,
      createdAt,
      durationMs,
      bytes,
      mimeType,
    }),
  )
  metas.sort((a, b) => b.createdAt - a.createdAt)
  return metas
}

/** Read one clip's blob (for play / download). Null if it no longer exists. */
export async function getClipBlob(id: number): Promise<Blob | null> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readonly')
  const rec = await reqAsPromise(tx.objectStore(STORE).get(id))
  return rec ? (rec as StoredClip).blob : null
}

/** Delete one clip by id. */
export async function deleteClip(id: number): Promise<void> {
  const db = await openDb()
  const tx = db.transaction(STORE, 'readwrite')
  await reqAsPromise(tx.objectStore(STORE).delete(id))
}
