// Firestore read/management layer for the /admin console.
//
// All access goes through the lazy `getDb()` (null when Firebase unconfigured).
// Reads are gated by `firestore.rules` (admin email only) — the client helpers
// here trust that the server rules enforce authorization.

import { getDb } from '../auth/firebase'

/** A listable user (from the `users/{uid}` profile doc). */
export interface AdminUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  firstSeenMs: number | null
  lastSeenMs: number | null
  userAgent?: string
  lang?: string
}

/**
 * Live machine state — single doc at `users/{uid}/live/state`, written by the
 * user-side app (presence + machine telemetry). All fields optional/loose since
 * a partial/stale doc may exist.
 */
export interface LiveState {
  connected: boolean
  firmware: string
  machineState: string
  wpos: { x: number; y: number; z: number }
  mpos: { x: number; y: number; z: number }
  feed: number
  spindleRpm: number
  activeTab: string
  programName: string | null
  allowRemote: boolean
  ts: number | null
}

/**
 * Live loaded program — single doc at `users/{uid}/live/program`, written by the
 * user-side app ONLY when the program changes (deduped + capped). Lets the admin
 * re-render the user's current toolpath without a pixel screen-share.
 */
export interface LiveProgram {
  /** The combined G-code (may be truncated if the program exceeds the cap). */
  gcode: string
  /** Summary program name (section names joined), or null when empty. */
  name: string | null
  /** Line count of the FULL program (may exceed the lines present in `gcode`). */
  lines: number
  /** Change-detect hash of the full program. */
  hash: number | string
  /** True when `gcode` was truncated to fit the doc cap. */
  truncated: boolean
  ts: number | null
}

/** A queued remote command (admin creates, user-side app executes). */
export interface AdminCommand {
  id: string
  kind: 'realtime' | 'gcode' | 'jog'
  data: string
  status: 'pending' | 'done' | 'error'
  result?: string
  createdBy?: string
  ts: number | null
}

/** Metadata for a user-uploaded file (contents live in Firebase Storage). */
export interface FileMeta {
  id: string
  name: string
  size: number
  type: string
  storagePath: string
  context?: string
  ts: number | null
}

/** A single activity event (flattened from a batched `users/{uid}/events/{id}` doc). */
export interface AdminEvent {
  id: string
  type: string
  ts: number
  tab?: string
  sessionId?: string
  /** How many identical consecutive occurrences this entry represents (>=1). */
  count: number
  payload: Record<string, unknown>
}

/**
 * "Online" = lastSeen within this window (ms). The presence heartbeat now writes
 * every ~5 min (HEARTBEAT_MS in track/activity.ts, a big write-op saving), so this
 * window is ~6.5 min — comfortably longer than one heartbeat + jitter so a present
 * user never flickers offline between pings.
 */
export const ONLINE_WINDOW_MS = 390_000

export function isOnline(u: AdminUser, now = Date.now()): boolean {
  return u.lastSeenMs != null && now - u.lastSeenMs < ONLINE_WINDOW_MS
}

/** Convert a Firestore Timestamp-ish value to epoch ms (null when absent). */
function tsToMs(v: unknown): number | null {
  if (v == null) return null
  if (typeof v === 'number') return v
  // Firestore Timestamp has toMillis(); guard duck-typed.
  const t = v as { toMillis?: () => number; seconds?: number }
  if (typeof t.toMillis === 'function') return t.toMillis()
  if (typeof t.seconds === 'number') return t.seconds * 1000
  return null
}

function toUser(id: string, d: Record<string, unknown>): AdminUser {
  return {
    uid: (d.uid as string) ?? id,
    email: (d.email as string) ?? null,
    displayName: (d.displayName as string) ?? null,
    photoURL: (d.photoURL as string) ?? null,
    firstSeenMs: tsToMs(d.firstSeen),
    lastSeenMs: tsToMs(d.lastSeen),
    userAgent: d.userAgent as string | undefined,
    lang: d.lang as string | undefined,
  }
}

/**
 * Subscribe to the live `users` collection (ordered by lastSeen desc). Returns an
 * unsubscribe fn. Calls `onError` on permission/connection failure. No-op (returns
 * a noop unsub) when Firebase is unconfigured.
 */
export async function subscribeUsers(
  onData: (users: AdminUser[]) => void,
  onError: (e: Error) => void,
): Promise<() => void> {
  const db = await getDb()
  if (!db) {
    onError(new Error('unconfigured'))
    return () => {}
  }
  const { collection, query, orderBy, onSnapshot } = await import('firebase/firestore')
  const q = query(collection(db, 'users'), orderBy('lastSeen', 'desc'))
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => toUser(d.id, d.data() as Record<string, unknown>))),
    (e) => onError(e instanceof Error ? e : new Error(String(e))),
  )
}

/**
 * Flatten one stored events-doc into individual AdminEvents.
 *
 * New schema: the doc has an `events[]` array (one write per flush) — each entry
 * becomes its own AdminEvent, with `sessionId` inherited from the doc and a
 * stable synthetic id (`docId#index`).
 *
 * Backward-compat: an OLD doc (no `events[]`) is treated as a single event — the
 * doc's own fields ARE the event — so already-written data still renders.
 */
function flattenEventsDoc(
  docId: string,
  data: Record<string, unknown>,
): Array<{ ev: AdminEvent; docSessionId?: string }> {
  const docSessionId = data.sessionId as string | undefined
  const arr = data.events
  if (Array.isArray(arr)) {
    return arr.map((raw, i) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const { type, ts, tab, sessionId, count, ...rest } = item
      return {
        ev: {
          id: `${docId}#${i}`,
          type: (type as string) ?? 'unknown',
          ts: typeof ts === 'number' ? ts : (tsToMs(ts) ?? 0),
          tab: tab as string | undefined,
          sessionId: (sessionId as string | undefined) ?? docSessionId,
          count: typeof count === 'number' && count > 0 ? count : 1,
          payload: rest,
        },
        docSessionId,
      }
    })
  }
  // Legacy single-event doc: the doc itself is the event.
  const { type, ts, tab, sessionId, serverTs: _s, uid: _u, count, events: _e, ...rest } = data
  void _s
  void _u
  void _e
  return [
    {
      ev: {
        id: docId,
        type: (type as string) ?? 'unknown',
        ts: typeof ts === 'number' ? ts : (tsToMs(ts) ?? 0),
        tab: tab as string | undefined,
        sessionId: sessionId as string | undefined,
        count: typeof count === 'number' && count > 0 ? count : 1,
        payload: rest,
      },
      docSessionId,
    },
  ]
}

/**
 * Load the latest events for one user (newest first). Reads up to `maxDocs`
 * batched docs and flattens their `events[]` arrays; the result is capped at
 * `maxEvents`. Handles both new (array) and legacy (single-event) docs.
 */
export async function loadUserEvents(uid: string, maxEvents = 500): Promise<AdminEvent[]> {
  const db = await getDb()
  if (!db) return []
  const { collection, query, orderBy, limit, getDocs } = await import('firebase/firestore')
  // Each doc may hold many events, so a smaller doc limit yields plenty of events
  // while keeping the read op count (and cost) low.
  const q = query(collection(db, 'users', uid, 'events'), orderBy('ts', 'desc'), limit(maxEvents))
  const snap = await getDocs(q)
  const out: AdminEvent[] = []
  for (const d of snap.docs) {
    for (const { ev } of flattenEventsDoc(d.id, d.data() as Record<string, unknown>)) out.push(ev)
  }
  // Docs are newest-first by their (last-event) ts; sort flattened events too so
  // entries within a batch are correctly ordered, then cap.
  out.sort((a, b) => b.ts - a.ts)
  return out.slice(0, maxEvents)
}

/**
 * Recent events ACROSS ALL users via a collectionGroup query (dashboard aggregates).
 * Newest first, capped at `max`. Each event is tagged with its owner uid (parsed
 * from the doc path). Returns [] when unconfigured / on failure.
 */
export async function loadRecentEventsAllUsers(
  maxEvents = 1000,
): Promise<Array<AdminEvent & { uid: string }>> {
  const db = await getDb()
  if (!db) return []
  try {
    const { collectionGroup, query, orderBy, limit, getDocs } = await import('firebase/firestore')
    // Order by the doc's top-level ts (= last event in the batch); each doc may
    // expand into many events, so this read stays cheap.
    const q = query(collectionGroup(db, 'events'), orderBy('ts', 'desc'), limit(maxEvents))
    const snap = await getDocs(q)
    const out: Array<AdminEvent & { uid: string }> = []
    for (const d of snap.docs) {
      const data = d.data() as Record<string, unknown>
      // path: users/{uid}/events/{id}
      const ownerUid = (data.uid as string) ?? d.ref.parent.parent?.id ?? 'unknown'
      for (const { ev } of flattenEventsDoc(d.id, data)) out.push({ ...ev, uid: ownerUid })
    }
    out.sort((a, b) => b.ts - a.ts)
    return out.slice(0, maxEvents)
  } catch {
    // collectionGroup may need a composite index the first time; fail soft.
    return []
  }
}

/**
 * Batch-delete ALL of a user's events. Deletes in chunks (Firestore batch cap is
 * 500). Requires admin delete permission in the rules. Returns the count deleted.
 */
export async function deleteUserEvents(uid: string): Promise<number> {
  const db = await getDb()
  if (!db) return 0
  const { collection, query, orderBy, limit, getDocs, writeBatch } = await import(
    'firebase/firestore'
  )
  let total = 0
  for (;;) {
    const q = query(collection(db, 'users', uid, 'events'), orderBy('ts'), limit(400))
    const snap = await getDocs(q)
    if (snap.empty) break
    const batch = writeBatch(db)
    snap.docs.forEach((d) => batch.delete(d.ref))
    await batch.commit()
    total += snap.size
    if (snap.size < 400) break
  }
  return total
}

// ─── Live machine state / remote control / files ──────────────────────────────

function toLiveState(d: Record<string, unknown>): LiveState {
  const v3 = (o: unknown): { x: number; y: number; z: number } => {
    const p = (o ?? {}) as Record<string, unknown>
    return {
      x: typeof p.x === 'number' ? p.x : 0,
      y: typeof p.y === 'number' ? p.y : 0,
      z: typeof p.z === 'number' ? p.z : 0,
    }
  }
  return {
    connected: d.connected === true,
    firmware: (d.firmware as string) ?? '',
    machineState: (d.machineState as string) ?? '',
    wpos: v3(d.wpos),
    mpos: v3(d.mpos),
    feed: typeof d.feed === 'number' ? d.feed : 0,
    spindleRpm: typeof d.spindleRpm === 'number' ? d.spindleRpm : 0,
    activeTab: (d.activeTab as string) ?? '',
    programName: (d.programName as string) ?? null,
    allowRemote: d.allowRemote === true,
    ts: tsToMs(d.ts) ?? tsToMs(d.updatedAt),
  }
}

/**
 * Subscribe to one user's live machine state doc (`users/{uid}/live/state`).
 * Calls `onData(null)` when the doc does not exist (user-side app never wrote
 * it). Returns an unsubscribe fn; no-op when Firebase is unconfigured.
 */
export async function subscribeLiveState(
  uid: string,
  onData: (s: LiveState | null) => void,
  onError: (e: Error) => void,
): Promise<() => void> {
  const db = await getDb()
  if (!db) {
    onError(new Error('unconfigured'))
    return () => {}
  }
  const { doc, onSnapshot } = await import('firebase/firestore')
  return onSnapshot(
    doc(db, 'users', uid, 'live', 'state'),
    (snap) => onData(snap.exists() ? toLiveState(snap.data() as Record<string, unknown>) : null),
    (e) => onError(e instanceof Error ? e : new Error(String(e))),
  )
}

function toLiveProgram(d: Record<string, unknown>): LiveProgram {
  return {
    gcode: typeof d.gcode === 'string' ? d.gcode : '',
    name: typeof d.name === 'string' ? d.name : null,
    lines: typeof d.lines === 'number' ? d.lines : 0,
    hash: typeof d.hash === 'number' || typeof d.hash === 'string' ? d.hash : 0,
    truncated: d.truncated === true,
    ts: tsToMs(d.ts) ?? tsToMs(d.updatedAt),
  }
}

/**
 * Subscribe to one user's live PROGRAM doc (`users/{uid}/live/program`). Calls
 * `onData(null)` when the doc does not exist. Returns an unsubscribe fn; no-op
 * when Firebase is unconfigured. Subscribe only while the detail view is open.
 */
export async function subscribeLiveProgram(
  uid: string,
  onData: (p: LiveProgram | null) => void,
): Promise<() => void> {
  const db = await getDb()
  if (!db) return () => {}
  const { doc, onSnapshot } = await import('firebase/firestore')
  return onSnapshot(
    doc(db, 'users', uid, 'live', 'program'),
    (snap) => onData(snap.exists() ? toLiveProgram(snap.data() as Record<string, unknown>) : null),
    () => onData(null),
  )
}

/**
 * Subscribe to ALL currently-connected machines via a single collectionGroup
 * query over the `live` subcollection, filtered to `connected == true`. This is
 * the lower-cost approach: one query streams just the online docs instead of
 * fanning out a per-user live listener for every user. Each result carries the
 * owner uid parsed from the doc path. Needs a collectionGroup single-field
 * exemption/index on `connected`; fails soft to [] if the index is missing.
 */
export async function subscribeOnlineMachines(
  onData: (machines: Array<LiveState & { uid: string }>) => void,
): Promise<() => void> {
  const db = await getDb()
  if (!db) return () => {}
  try {
    const { collectionGroup, query, where, onSnapshot } = await import('firebase/firestore')
    const q = query(collectionGroup(db, 'live'), where('connected', '==', true))
    return onSnapshot(
      q,
      (snap) => {
        const out: Array<LiveState & { uid: string }> = []
        for (const d of snap.docs) {
          // path: users/{uid}/live/state
          const ownerUid = d.ref.parent.parent?.id ?? 'unknown'
          out.push({ ...toLiveState(d.data() as Record<string, unknown>), uid: ownerUid })
        }
        onData(out)
      },
      () => onData([]), // index not ready yet → show none rather than break
    )
  } catch {
    onData([])
    return () => {}
  }
}

/**
 * Queue a remote command for the user-side app to execute. Writes to
 * `users/{uid}/commands/{auto}` with status:'pending' and a server timestamp.
 * The physical machine moves when the user-side app picks this up — callers
 * must gate on the user's `allowRemote` opt-in.
 */
export async function sendCommand(
  uid: string,
  kind: AdminCommand['kind'],
  data: string,
  adminEmail: string,
): Promise<void> {
  const db = await getDb()
  if (!db) throw new Error('unconfigured')
  const { collection, addDoc, serverTimestamp } = await import('firebase/firestore')
  await addDoc(collection(db, 'users', uid, 'commands'), {
    kind,
    data,
    status: 'pending',
    createdBy: adminEmail,
    createdAt: serverTimestamp(),
    ts: Date.now(),
  })
}

/**
 * Subscribe to a user's recent commands (newest first, capped) so the admin can
 * watch each command's status (pending → done/error). Returns an unsubscribe fn.
 */
export async function subscribeCommands(
  uid: string,
  onData: (cmds: AdminCommand[]) => void,
  max = 20,
): Promise<() => void> {
  const db = await getDb()
  if (!db) return () => {}
  const { collection, query, orderBy, limit, onSnapshot } = await import('firebase/firestore')
  const q = query(collection(db, 'users', uid, 'commands'), orderBy('ts', 'desc'), limit(max))
  return onSnapshot(
    q,
    (snap) =>
      onData(
        snap.docs.map((d) => {
          const data = d.data() as Record<string, unknown>
          return {
            id: d.id,
            kind: (data.kind as AdminCommand['kind']) ?? 'gcode',
            data: (data.data as string) ?? '',
            status: (data.status as AdminCommand['status']) ?? 'pending',
            result: data.result as string | undefined,
            createdBy: data.createdBy as string | undefined,
            ts: typeof data.ts === 'number' ? data.ts : tsToMs(data.createdAt),
          }
        }),
      ),
    () => onData([]),
  )
}

/** One-shot read of a user's uploaded-file metadata (`users/{uid}/files`), newest first. */
export async function listUserFiles(uid: string): Promise<FileMeta[]> {
  const db = await getDb()
  if (!db) return []
  const { collection, query, orderBy, limit, getDocs } = await import('firebase/firestore')
  try {
    const q = query(collection(db, 'users', uid, 'files'), orderBy('ts', 'desc'), limit(200))
    const snap = await getDocs(q)
    return snap.docs.map((d) => {
      const data = d.data() as Record<string, unknown>
      return {
        id: d.id,
        name: (data.name as string) ?? d.id,
        size: typeof data.size === 'number' ? data.size : 0,
        type: (data.type as string) ?? '',
        storagePath: (data.storagePath as string) ?? '',
        context: data.context as string | undefined,
        ts: typeof data.ts === 'number' ? data.ts : tsToMs(data.uploadedAt),
      }
    })
  } catch {
    return []
  }
}

/** Resolve a Firebase Storage download URL for a stored file's `storagePath`. */
export async function getFileDownloadUrl(storagePath: string): Promise<string> {
  const db = await getDb()
  if (!db) throw new Error('unconfigured')
  // Reuse the already-initialized FirebaseApp behind the Firestore instance so
  // we don't double-init the SDK.
  const { getStorage, ref, getDownloadURL } = await import('firebase/storage')
  const storage = getStorage((db as unknown as { app: import('firebase/app').FirebaseApp }).app)
  return getDownloadURL(ref(storage, storagePath))
}
