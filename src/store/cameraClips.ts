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

// ── OOM caps (cyclic, drop-oldest) ───────────────────────────────────────────
// Auto-recorded clips are large video blobs that accumulate every time a program
// streams. Left unbounded they fill IndexedDB and (when listed/loaded) bloat
// memory → Chrome OOM. We bound the stored set by BOTH total bytes and count,
// evicting the OLDEST clips first (lowest createdAt) when saving a new one and
// pruning on every list() so an already-bloated DB self-heals without the user
// clearing cache.
//
// 128 MB ≈ many minutes of webm at typical bitrates while staying modest on disk
// and memory; the count cap is a coarse backstop for many tiny clips.
/** Max total stored clip bytes — evict oldest until under this. */
const MAX_TOTAL_CLIP_BYTES = 128 * 1024 * 1024 // 128 MB
/** Max stored clip count — coarse backstop alongside the byte cap. */
const MAX_CLIPS = 20

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

/**
 * Cyclic prune: delete the OLDEST clips (lowest createdAt) until the stored set
 * is within BOTH the byte and count caps. Reads only lightweight metadata to
 * decide, then deletes the heavy records. Best-effort — any failure is swallowed
 * so it never blocks save/list. Returns silently when already within caps.
 */
async function pruneClips(): Promise<void> {
  try {
    const db = await openDb()
    const tx = db.transaction(STORE, 'readonly')
    const all = (await reqAsPromise(tx.objectStore(STORE).getAll())) as StoredClip[]
    // Oldest first so we evict from the front.
    all.sort((a, b) => a.createdAt - b.createdAt)
    let total = all.reduce((sum, c) => sum + (c.bytes || 0), 0)
    let count = all.length
    const toDelete: number[] = []
    let i = 0
    while (i < all.length && (count > MAX_CLIPS || total > MAX_TOTAL_CLIP_BYTES)) {
      toDelete.push(all[i].id)
      total -= all[i].bytes || 0
      count -= 1
      i += 1
    }
    if (toDelete.length === 0) return
    const wtx = db.transaction(STORE, 'readwrite')
    const store = wtx.objectStore(STORE)
    for (const id of toDelete) store.delete(id)
    await new Promise<void>((resolve) => {
      wtx.oncomplete = () => resolve()
      wtx.onerror = () => resolve()
      wtx.onabort = () => resolve()
    })
  } catch {
    /* pruning is best-effort; never block save/list or surface */
  }
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
  // Cyclic eviction: trim the OLDEST clips so the store stays within caps.
  await pruneClips()
  return { ...record, id: id as number }
}

/** List all clips' metadata (newest first), without loading their blobs. */
export async function listClips(): Promise<ClipMeta[]> {
  // Prune-on-load: an already-bloated DB (grown before caps existed) self-heals
  // here so the user never has to clear cache. Best-effort; never blocks listing.
  await pruneClips()
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

/**
 * Delete ALL stored clips at once — used by the "free space" cache cleanup when
 * local storage is near-full. Auto-recorded video is the biggest disk/RAM hog
 * and is purely local (never uploaded), so it's safe disposable cache. Returns
 * the total bytes freed (0 on failure). Best-effort — never throws.
 */
export async function clearAllClips(): Promise<number> {
  try {
    const db = await openDb()
    const rtx = db.transaction(STORE, 'readonly')
    const all = (await reqAsPromise(rtx.objectStore(STORE).getAll())) as StoredClip[]
    const freed = all.reduce((sum, c) => sum + (c.bytes || 0), 0)
    const wtx = db.transaction(STORE, 'readwrite')
    wtx.objectStore(STORE).clear()
    await new Promise<void>((resolve) => {
      wtx.oncomplete = () => resolve()
      wtx.onerror = () => resolve()
      wtx.onabort = () => resolve()
    })
    return freed
  } catch {
    return 0
  }
}
