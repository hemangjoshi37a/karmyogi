// Upload user-imported files to Firebase Storage (+ a Firestore metadata doc).
//
// Lets the super-admin later inspect exactly what a user imported (DXF, STL,
// Gerber, …) when assisting them. Graceful degradation: a COMPLETE silent no-op
// when Firebase is unconfigured or nobody is signed in — it must NEVER block or
// break a file import, so every failure is swallowed.
//
// Schema (shared with the admin console):
//   Bytes  → Storage  `userfiles/{uid}/{fileId}/{safeName}`
//   Meta   → Firestore `users/{uid}/files/{fileId}`:
//     { name, size, type, storagePath, context, ts, uploadedAt:<serverTimestamp> }

import { firebaseConfigured, getDb } from '../auth/firebase'
import { useAuth } from '../auth/authStore'

/** Hard cap — anything larger is skipped silently (keeps Storage cost bounded). */
const MAX_BYTES = 25 * 1024 * 1024 // 25 MB

/** Minimal file descriptor: a real File, or a name + raw bytes. */
type FileInput =
  | File
  | { name: string; data: ArrayBuffer | Uint8Array; type?: string }

/** Sanitize a filename for use as a Storage path segment. */
function safeFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file'
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned || 'file'
}

/** A short, collision-resistant file id. */
function makeFileId(): string {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** The signed-in uid, or null when signed out / unconfigured. */
function currentUid(): string | null {
  const s = useAuth.getState()
  return s.status === 'signedIn' ? s.user?.uid ?? null : null
}

/**
 * Upload an imported file to the user's vault. No-op (and never throws) when
 * unconfigured / signed out, when the file is empty, or when it exceeds the size
 * cap. `context` tags where the import came from (e.g. 'carve-import').
 */
export async function uploadUserFile(file: FileInput, context: string): Promise<void> {
  try {
    if (!firebaseConfigured()) return
    const uid = currentUid()
    if (!uid) return

    // Normalize to bytes + metadata.
    const name = file instanceof File ? file.name : file.name
    const type = file instanceof File ? file.type : file.type ?? ''
    let bytes: Uint8Array
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer())
    } else if (file.data instanceof Uint8Array) {
      bytes = file.data
    } else {
      bytes = new Uint8Array(file.data)
    }
    const size = bytes.byteLength
    if (size === 0 || size > MAX_BYTES) return

    // Ensure the default Firebase app is initialized (getDb spins it up).
    const db = await getDb()
    if (!db) return

    const fileId = makeFileId()
    const safeName = safeFileName(name)
    const storagePath = `userfiles/${uid}/${fileId}/${safeName}`

    const { getStorage, ref, uploadBytes } = await import('firebase/storage')
    const storage = getStorage()
    await uploadBytes(ref(storage, storagePath), bytes, {
      contentType: type || 'application/octet-stream',
    })

    const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
    await setDoc(doc(db, 'users', uid, 'files', fileId), {
      name,
      size,
      type,
      storagePath,
      context,
      ts: Date.now(),
      uploadedAt: serverTimestamp(),
    })
  } catch {
    /* vault upload is best-effort; never block or break the import */
  }
}
