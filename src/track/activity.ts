// Centralized, batched activity logger → Firestore.
//
// Graceful degradation: every public function no-ops silently when Firebase is
// not configured OR no user is signed in. Nothing here touches the network until
// both are true, so the unconfigured live app is completely unaffected.
//
// COST MODEL — minimizing Firestore write OPS is a hard requirement.
// Events are buffered in memory and flushed in BATCHES (every ~25s, or once the
// buffer reaches FLUSH_AT events, and eagerly on visibilitychange/pagehide).
// Each flush writes a SINGLE doc `users/{uid}/events/{autoId}` whose `events`
// field is an ARRAY of the buffered events — so N events cost exactly ONE write
// (not N). High-frequency identical consecutive events are coalesced (with a
// `count`) before flushing, keeping the array small. Presence is one cheap
// `users/{uid}` upsert per ~60s heartbeat (skipped when lastSeen wouldn't
// meaningfully advance).
//
// Firestore security-rule note: the per-flush doc still carries a TOP-LEVEL
// `uid` field, so the existing rule `request.resource.data.uid == uid` keeps
// working unchanged. The flattened per-event objects live under `events[]`.
//
// WRITES PER ACTIVE USER (cost-minimized cadence):
//   - events:    ~1 write / HOUR (FLUSH_MS = 1h), each a single doc holding up to
//                ~480 coalesced events; plus one best-effort flush on tab hide/
//                close. The buffer is mirrored to localStorage so a reload/crash
//                between hourly flushes doesn't lose it (shipped on next sign-in).
//   - presence:  ~1 write / 5 min (HEARTBEAT_MS), skipped when lastSeen wouldn't
//                meaningfully advance. (Admin ONLINE_WINDOW_MS widened to ~6.5 min.)
//   ⇒ a steady-state active user costs only a couple of writes per hour here, plus
//     the live-machine mirror (also throttled to ~5 min in machine/liveSync.ts).

import { firebaseConfigured, getDb } from '../auth/firebase'

// ───────────────────────────────────────────────────────────────────────────
// 'ui_click' payload schema (element-level interaction analytics)
//
// Emitted by useActivityTracking's delegated click listener for every activated
// control. Stored (flattened) inside a per-flush doc's `events[]` as:
//
//   { type: 'ui_click', id, kind, tab, count?, ts }
//
//   id    — stable, meaningful control identifier, resolved in priority order:
//           data-track > aria-label > title > visible text > name/id > role >
//           short CSS path. Truncated; never contains input VALUES (privacy).
//   kind  — coarse element class: 'button' | 'link' | 'tab' | 'select' |
//           'checkbox' | 'radio' | 'slider' | 'menuitem' | 'disclosure' | etc.
//   tab   — the active tab/panel at click time (or 'none').
//   count — present (>1) when identical consecutive clicks were coalesced.
//
// HOW TO AGGREGATE "most-used controls":
//   For each ui_click event, add `count ?? 1` to a tally keyed by (tab, id) — or
//   (tab, kind) for a coarser view. Sum across all users' event docs. Because
//   coalescing already pre-sums consecutive repeats and a flush is ONE write
//   regardless of array size, a heavy clicker still costs only ~few writes/min.
// ───────────────────────────────────────────────────────────────────────────

/** A single tracked event. Payload is flattened into the stored doc. */
export interface TrackEvent {
  type: string
  /** Arbitrary small payload (no file contents, nothing huge). */
  payload?: Record<string, unknown>
}

interface BufferedEvent extends TrackEvent {
  ts: number
  sessionId: string
  /** The active tab/panel at the time, when known. */
  tab?: string
  /** Coalesced repeat count for identical consecutive events (default 1). */
  count?: number
  /** True if this event was recorded BEFORE sign-in (anonymous explore window).
   *  Surfaced as `preSignin` on the flushed doc so the journey is distinguishable. */
  pre?: boolean
}

/** Flush cadence — bigger = fewer writes. Each flush is exactly one doc. Set to
 *  1 HOUR: events are collected LOCALLY (in-memory + mirrored to localStorage so a
 *  crash/close doesn't lose them) and shipped to Firestore at most once an hour
 *  (plus on tab-hide/close), drastically cutting write ops. */
const FLUSH_MS = 3_600_000
/** Max events written per Firestore doc — the security-rule cap is 500, so we
 *  chunk a large buffer into multiple docs of this size (no events are dropped). */
const EVENTS_PER_DOC = 480
/** While SIGNED IN, auto-flush once the buffer reaches this (keeps docs flowing
 *  hourly OR sooner for a busy session). Anonymous explorers don't flush — they
 *  accumulate locally until sign-in (see ensureRestored / migrate-on-sign-in). */
const FLUSH_AT = 480
/** Safety ceiling so a pathological runaway can't OOM the tab — effectively
 *  UNCAPPED for real use (~tens of thousands of interactions). At the ceiling we
 *  drop the OLDEST events so the most recent interactions are always kept. */
const MAX_BUFFER = 50000
/** Presence heartbeat cadence — refreshes the profile's `lastSeen` while visible.
 *  5 min: "online" is polled every ~5 minutes (admin ONLINE_WINDOW_MS widened to match). */
const HEARTBEAT_MS = 300_000
/** localStorage key holding the not-yet-flushed event buffer (survives reload/crash). */
const BUFFER_KEY = 'karmyogi.activity.buffer'
/** Throttle for mirroring the buffer to localStorage (avoid stringifying on every click). */
const PERSIST_MIN_MS = 8000

/**
 * Version stamp of the legal policies the user accepts at sign-in. Recorded on
 * the user's profile doc (`policiesAcceptedAt` + `policiesVersion`) the first
 * time they sign in, as durable evidence of consent. Keep in sync with the
 * "Last updated" date in src/components/policies.tsx; bump it if the policies
 * change materially so re-acceptance is distinguishable.
 */
const POLICIES_VERSION = '2026-06-05'

// A stable per-tab session id (one app load = one session).
const SESSION_ID = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** Identity captured alongside the uid so the profile doc can be filled in. */
export interface TrackingProfile {
  email: string | null
  displayName: string | null
  photoURL: string | null
}

let uid: string | null = null
let profile: TrackingProfile | null = null
let buffer: BufferedEvent[] = []
let timer: ReturnType<typeof setInterval> | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let flushing = false
let activeTab: string | undefined
/** Listeners notified whenever the active tab changes (see subscribeActiveTab). */
const activeTabListeners = new Set<(tab: string | undefined) => void>()
/** Wall-clock of the last presence write, to skip redundant heartbeat writes. */
let lastPresenceWriteAt = 0
/** Wall-clock of the last localStorage mirror of the buffer (throttle). */
let lastPersistAt = 0

/** Set once we've folded in any persisted backlog, so we only do it per app load. */
let restored = false

/**
 * Mirror the unflushed buffer to localStorage so events survive reload/crash —
 * AND so a user's anonymous explore-window interactions persist across sessions
 * until they sign in. Stored with the current `uid` (null while anonymous).
 */
function persistBuffer(): void {
  if (typeof localStorage === 'undefined') return
  try {
    if (buffer.length === 0) localStorage.removeItem(BUFFER_KEY)
    else localStorage.setItem(BUFFER_KEY, JSON.stringify({ uid, events: buffer }))
    lastPersistAt = Date.now()
  } catch {
    /* storage full/blocked — best-effort; events keep accumulating in memory */
  }
}

/** Throttled mirror, called as events accumulate. */
function maybePersist(): void {
  if (Date.now() - lastPersistAt >= PERSIST_MIN_MS) persistBuffer()
}

/**
 * Fold any persisted backlog into the in-memory buffer ONCE per app load. The
 * backlog is adopted when it's ANONYMOUS (saved.uid == null — the explore-window
 * interactions, which attribute to whoever signs in) or belongs to the current
 * uid; a different signed-in user's leftover is discarded (privacy). Pre-sign-in
 * events keep their `pre` flag, so on sign-in they flush tagged `preSignin`.
 */
function ensureRestored(): void {
  if (restored || typeof localStorage === 'undefined') return
  restored = true
  try {
    const raw = localStorage.getItem(BUFFER_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as { uid?: string | null; events?: BufferedEvent[] }
    const sameOrAnon = saved.uid == null || saved.uid === uid
    if (sameOrAnon && Array.isArray(saved.events) && saved.events.length) {
      buffer = saved.events.concat(buffer).slice(-MAX_BUFFER) // keep most recent at the ceiling
    } else if (!sameOrAnon) {
      localStorage.removeItem(BUFFER_KEY) // a different signed-in user → discard
    }
  } catch {
    localStorage.removeItem(BUFFER_KEY) // corrupt → drop
  }
}

/** Whether tracking is currently live (configured AND a user is bound). */
function active(): boolean {
  return firebaseConfigured() && uid !== null
}

/**
 * Set/clear the signed-in uid (+ identity for the profile doc). Called by the
 * tracking hook on auth changes. On a NEW sign-in this also writes/refreshes the
 * listable `users/{uid}` profile doc and starts the presence heartbeat.
 */
export function setTrackingUser(nextUid: string | null, nextProfile?: TrackingProfile): void {
  if (nextUid === uid) {
    // Same user — just keep the profile fields fresh (e.g. displayName loaded late).
    if (nextProfile) profile = nextProfile
    return
  }
  // Flush whatever belonged to the previous user before switching.
  if (uid && buffer.length) void flush()
  uid = nextUid
  profile = nextProfile ?? null
  if (active()) {
    // Adopt any backlog — including the ANONYMOUS explore-window interactions
    // buffered before this sign-in — and ship it now (tagged preSignin), so the
    // pre-login journey isn't lost. No-op if already folded in during exploring.
    ensureRestored()
    if (buffer.length) void flush()
    startTimer()
    startHeartbeat()
    // Initial profile write (firstSeen only-if-absent) + immediate presence ping.
    void writeProfile(true)
  } else {
    stopTimer()
    stopHeartbeat()
  }
}

/**
 * Upsert the `users/{uid}` profile doc used by the admin console to LIST users
 * and compute presence ("online" = lastSeen within ~150s). Cheap: only called on
 * session start and on the ~60s heartbeat (never per event). `firstSeen` is set
 * only when absent. No-op when unconfigured / signed-out.
 *
 * To cut write OPS, a NON-session-start (heartbeat) call is SKIPPED when the
 * previous presence write was recent enough that `lastSeen` wouldn't meaningfully
 * advance (within ~HEARTBEAT_MS). Session-start / visibility-change calls always
 * write so presence is accurate immediately.
 */
async function writeProfile(isSessionStart: boolean): Promise<void> {
  if (!active() || !uid) return
  // Skip redundant heartbeat writes that wouldn't advance lastSeen meaningfully.
  if (!isSessionStart && Date.now() - lastPresenceWriteAt < HEARTBEAT_MS - 1000) return
  try {
    const db = await getDb()
    if (!db || !uid) return
    const { doc, getDoc, setDoc, serverTimestamp } = await import('firebase/firestore')
    const ref = doc(db, 'users', uid)
    const data: Record<string, unknown> = {
      uid,
      email: profile?.email ?? null,
      displayName: profile?.displayName ?? null,
      photoURL: profile?.photoURL ?? null,
      lastSeen: serverTimestamp(),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 300) : '',
      lang: typeof navigator !== 'undefined' ? navigator.language : '',
    }
    if (isSessionStart) {
      // firstSeen is "only-if-absent": one cheap read per session to preserve the
      // earliest value across sign-ins (heartbeats skip this and just bump lastSeen).
      // policiesAcceptedAt is recorded the SAME way — the user can only reach a
      // signed-in state by ticking the (default-checked) policy box on the sign-in
      // screen, so being signed in implies acceptance. We stamp the first such
      // moment + the policy version as durable legal evidence of consent.
      try {
        const snap = await getDoc(ref)
        if (!snap.exists() || !snap.get('firstSeen')) data.firstSeen = serverTimestamp()
        if (!snap.exists() || !snap.get('policiesAcceptedAt')) {
          data.policiesAcceptedAt = serverTimestamp()
          data.policiesVersion = POLICIES_VERSION
        }
      } catch {
        /* read denied/offline — skip rather than risk clobbering it */
      }
    }
    await setDoc(ref, data, { merge: true })
    lastPresenceWriteAt = Date.now()
  } catch {
    /* presence is best-effort; never surface */
  }
}

function startHeartbeat(): void {
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') {
      void writeProfile(false)
    }
  }, HEARTBEAT_MS)
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

let tabEnteredAt = 0

/**
 * Record the currently-active tab/panel id. Attached to subsequent events AND
 * used to compute per-tab DWELL time: switching away emits a `tab_dwell` event
 * with the seconds spent on the previous tab, then a `tab_enter` for the new one.
 */
export function setActiveTab(tab: string | undefined): void {
  if (tab === activeTab) return
  const now = Date.now()
  if (activeTab && tabEnteredAt) {
    // Emit dwell for the tab we're leaving (activeTab still set so it's attributed).
    track('tab_dwell', { tab: activeTab, seconds: Math.round((now - tabEnteredAt) / 1000) })
  }
  activeTab = tab
  tabEnteredAt = now
  // Notify any reactive consumers (e.g. context-aware gamepad mapping) of the
  // change. Listeners must never throw out into the tab-switch path.
  for (const fn of activeTabListeners) {
    try {
      fn(tab)
    } catch {
      /* a listener throwing must not break tab switching */
    }
  }
  if (tab) track('tab_enter', { tab })
}

export function getSessionId(): string {
  return SESSION_ID
}

/** The currently-active tab/panel id (undefined when none). Read-only accessor. */
export function getActiveTab(): string | undefined {
  return activeTab
}

/**
 * Subscribe to active-tab changes. The listener fires whenever `setActiveTab`
 * records a DIFFERENT tab id (it is NOT called for redundant same-tab sets), so
 * consumers get one callback per real switch. Returns an unsubscribe function.
 * Read-only: this never alters `setActiveTab`'s existing dwell/track behaviour.
 */
export function subscribeActiveTab(fn: (tab: string | undefined) => void): () => void {
  activeTabListeners.add(fn)
  return () => activeTabListeners.delete(fn)
}

/** A stable key for coalescing identical consecutive events. */
function coalesceKey(type: string, tab: string | undefined, payload?: Record<string, unknown>): string {
  return `${type}|${tab ?? ''}|${payload ? JSON.stringify(payload) : ''}`
}

/**
 * Queue an event. Buffers whenever Firebase is CONFIGURED — including during the
 * anonymous explore window (no uid yet). While signed out the events accumulate
 * locally (in-memory + localStorage) and are NOT sent; on sign-in the whole
 * backlog flushes attributed to the user + tagged `preSignin`. When unconfigured
 * (the fully-open app), this is a complete no-op.
 *
 * Identical consecutive events (same type + tab + payload) are COALESCED into the
 * previous entry (bump `count`) so the stored arrays stay compact.
 */
export function track(type: string, payload?: Record<string, unknown>): void {
  if (!firebaseConfigured()) return
  ensureRestored()
  const now = Date.now()
  const isPre = uid === null // recorded before sign-in → flag it
  const last = buffer[buffer.length - 1]
  if (
    last &&
    last.type === type &&
    last.tab === activeTab &&
    coalesceKey(last.type, last.tab, last.payload) === coalesceKey(type, activeTab, payload)
  ) {
    last.count = (last.count ?? 1) + 1
    last.ts = now
    maybePersist()
    return
  }
  // Uncapped in practice; at the safety ceiling drop the OLDEST so recent stays.
  if (buffer.length >= MAX_BUFFER) buffer.shift()
  buffer.push({ type, payload, ts: now, sessionId: SESSION_ID, tab: activeTab, count: 1, ...(isPre ? { pre: true } : {}) })
  maybePersist()
  // Only SEND while signed in; anonymous explorers just keep buffering.
  if (active() && buffer.length >= FLUSH_AT) void flush()
}

function startTimer(): void {
  if (timer) return
  timer = setInterval(() => void flush(), FLUSH_MS)
}

function stopTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * Flush the buffer to Firestore. Only runs while SIGNED IN (anonymous events wait
 * for sign-in). A large backlog is CHUNKED into multiple docs of ≤EVENTS_PER_DOC
 * events (the security-rule cap is 500) so nothing is ever dropped — a long
 * anonymous explore simply produces several docs on sign-in.
 *
 * Per-doc schema (`users/{uid}/events/{autoId}`):
 *   { uid, sessionId, count, ts, serverTs,
 *     events: [ { type, ts, tab?, count?, preSignin?, ...payload }, ... ] }
 */
export async function flush(): Promise<void> {
  if (flushing || !active() || buffer.length === 0) return
  flushing = true
  const pending = buffer
  buffer = []
  let i = 0
  try {
    const db = await getDb()
    if (!db || !uid) {
      buffer = pending.concat(buffer).slice(-MAX_BUFFER) // couldn't write — requeue
      return
    }
    const { collection, doc, setDoc, serverTimestamp } = await import('firebase/firestore')
    const col = collection(db, 'users', uid, 'events')
    for (; i < pending.length; i += EVENTS_PER_DOC) {
      const slice = pending.slice(i, i + EVENTS_PER_DOC)
      const events = slice.map((ev) => ({
        type: ev.type,
        ts: ev.ts,
        ...(ev.tab ? { tab: ev.tab } : {}),
        ...(ev.count && ev.count > 1 ? { count: ev.count } : {}),
        ...(ev.payload ?? {}),
        ...(ev.pre ? { preSignin: true } : {}),
      }))
      await setDoc(doc(col), {
        uid,
        sessionId: slice[0]?.sessionId ?? SESSION_ID,
        count: events.length,
        ts: slice[slice.length - 1].ts, // last event → keeps orderBy('ts') correct
        serverTs: serverTimestamp(),
        events,
      })
    }
  } catch {
    // Requeue ONLY the un-written remainder (from i) so written chunks aren't duped.
    buffer = pending.slice(i).concat(buffer).slice(-MAX_BUFFER)
  } finally {
    flushing = false
    // Reflect the post-flush buffer in localStorage (cleared on success).
    persistBuffer()
  }
}

// Best-effort final flush when the page is hidden / unloaded. `flush()` is async
// but the browser usually keeps the tab alive long enough for a small batch on
// `visibilitychange:hidden`; `pagehide` is the last resort.
if (typeof document !== 'undefined') {
  const finalFlush = () => {
    if (document.visibilityState === 'hidden') {
      persistBuffer() // sync save first (reliable on hide), then best-effort flush
      void flush()
    } else {
      void writeProfile(false) // tab became visible again → refresh presence
    }
  }
  document.addEventListener('visibilitychange', finalFlush)
  window.addEventListener('pagehide', () => {
    persistBuffer()
    void flush()
    void writeProfile(false)
  })
}
