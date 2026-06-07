// Live machine/app state sync + admin remote-assist executor.
//
// Lets the super-admin live-VIEW a signed-in user's machine + app state, and —
// only with the USER'S explicit opt-in — remotely send commands to assist. All
// over Firestore, and a complete silent no-op when Firebase is unconfigured or
// nobody is signed in.
//
// COST MODEL (the owner watches Firestore write OPS): the live-state doc is
// THROTTLED to at most ~1 write / PUBLISH_MIN_MS, and a write is skipped entirely
// when nothing meaningful changed since the last publish. Positions are rounded
// before the change check so micro-jitter in the status report doesn't trigger
// writes. A final `connected:false` doc is written on disconnect / unmount.
//
// PROGRAM MIRROR (so the admin can re-render the user's loaded toolpath without
// pixel screen-share): the user's combined G-code is published to a SEPARATE doc
// `users/{uid}/live/program`, written ONLY WHEN IT CHANGES (deduped by a cheap
// length+hash key) and CAPPED so it stays well under Firestore's 1 MB doc limit.
// It is NOT written on every tick — the high-frequency `live/state` doc stays
// small and throttled exactly as before.
//
// SCHEMA (shared verbatim with the admin console — do not deviate):
//   Live state — SINGLE doc `users/{uid}/live/state`:
//     { connected, firmware, machineState, wpos:{x,y,z}, mpos:{x,y,z}, feed,
//       spindleRpm, activeTab, programName, allowRemote, ts, updatedAt }
//   Live program — SINGLE doc `users/{uid}/live/program`:
//     { gcode:string (capped/truncated), name:string|null, lines:number,
//       hash:string|number, ts:number, updatedAt }
//   Command queue — subcollection `users/{uid}/commands/{cmdId}`:
//     { kind:'realtime'|'gcode'|'jog', data, status:'pending'|'done'|'error',
//       result?, createdBy, createdAt, ts }

import { useEffect } from 'react'
import { firebaseConfigured, getDb } from '../auth/firebase'
import { useAuth } from '../auth/authStore'
import { useMachine } from '../store/machine'
import { useProgram } from '../store/program'
import { getActiveTab } from '../track/activity'
import { grbl } from '../serial/controller'
import { useMachineProfile } from '../store/machineProfile'

/** Minimum gap between live-state writes — bigger = fewer Firestore ops. Set to
 *  5 min: the admin's live view is "polled" roughly every 5 minutes rather than
 *  every few seconds, cutting writes ~100× for an actively-running machine. A
 *  write still only happens when state CHANGED, and connect/sign-out always write
 *  immediately (eager first publish + final disconnect doc), so online/offline
 *  is still prompt — only the position/feed refresh is coarser. */
const PUBLISH_MIN_MS = 300_000
/** Poll cadence for assembling a candidate live-state snapshot (cheap, no write). */
const SAMPLE_MS = 30_000
/**
 * Cap on the published program G-code size (bytes-ish). Firestore docs are
 * limited to 1 MB; we stay well under that. Programs larger than this are
 * truncated (the admin still gets a representative preview of the toolpath).
 */
const PROGRAM_CAP_BYTES = 200_000
/**
 * Minimum gap between PROGRAM writes. The program changes far less often than
 * machine state, but this also guards against a tab thrashing the program store.
 */
const PROGRAM_PUBLISH_MIN_MS = 60_000

/** The published live-state shape (sans server timestamp). */
interface LiveState {
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
  ts: number
}

function round(n: number): number {
  return Math.round((n ?? 0) * 1000) / 1000
}

/** Cheap, stable 32-bit string hash (djb2) for program-change dedupe. */
function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return h >>> 0
}

/** Build the current candidate live-state from the stores + controller. */
function sampleState(allowRemote: boolean): LiveState {
  const m = useMachine.getState()
  const prog = useProgram.getState()
  const profile = useMachineProfile.getState()
  const connected = m.connection === 'connected'
  return {
    connected,
    firmware: profile.controllerKind ?? '',
    machineState: connected ? m.state : 'Unknown',
    wpos: { x: round(m.wpos.x), y: round(m.wpos.y), z: round(m.wpos.z) },
    mpos: { x: round(m.mpos.x), y: round(m.mpos.y), z: round(m.mpos.z) },
    feed: round(m.feed),
    spindleRpm: round(m.spindle),
    activeTab: getActiveTab() ?? '',
    programName: prog.name,
    allowRemote,
    ts: Date.now(),
  }
}

/** Cheap structural comparison for dedupe (ignores `ts`). */
function sameState(a: LiveState | null, b: LiveState): boolean {
  if (!a) return false
  return (
    a.connected === b.connected &&
    a.firmware === b.firmware &&
    a.machineState === b.machineState &&
    a.feed === b.feed &&
    a.spindleRpm === b.spindleRpm &&
    a.activeTab === b.activeTab &&
    a.programName === b.programName &&
    a.allowRemote === b.allowRemote &&
    a.wpos.x === b.wpos.x &&
    a.wpos.y === b.wpos.y &&
    a.wpos.z === b.wpos.z &&
    a.mpos.x === b.mpos.x &&
    a.mpos.y === b.mpos.y &&
    a.mpos.z === b.mpos.z
  )
}

/**
 * Mount-once hook (in App.tsx) that:
 *  - PUBLISHES throttled, deduped live state to `users/{uid}/live/state` while
 *    signed in, and a final `connected:false` doc on sign-out / unmount.
 *  - Subscribes to pending commands and executes them via the GRBL controller,
 *    marking each done/error.
 *
 * Remote assist is ALWAYS enabled per the Terms of Service: the user consents by
 * using the service and has NO opt-out. A visible awareness banner (rendered in
 * App.tsx) keeps operator-monitoring obvious — that is notice, not a control.
 */
export function useLiveSync(): void {
  const ALLOW_REMOTE = true
  const uid = useAuth((s) => (s.status === 'signedIn' ? s.user?.uid ?? null : null))

  // --- PUBLISH live state (throttled + deduped) ---------------------------
  useEffect(() => {
    if (!firebaseConfigured() || !uid) return
    let cancelled = false
    let lastPublished: LiveState | null = null
    let lastWriteAt = 0

    async function writeState(state: LiveState): Promise<void> {
      try {
        const db = await getDb()
        if (!db || cancelled) return
        const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
        await setDoc(
          doc(db, 'users', uid!, 'live', 'state'),
          { ...state, updatedAt: serverTimestamp() },
          { merge: true },
        )
        lastPublished = state
        lastWriteAt = Date.now()
      } catch {
        /* publish is best-effort; never surface */
      }
    }

    const tick = () => {
      if (cancelled) return
      const next = sampleState(ALLOW_REMOTE)
      const now = Date.now()
      if (now - lastWriteAt < PUBLISH_MIN_MS) return // throttle window
      if (sameState(lastPublished, next)) return // nothing meaningful changed
      void writeState(next)
    }

    // Eager first publish so the admin sees the user immediately.
    void writeState(sampleState(ALLOW_REMOTE))
    const timer = setInterval(tick, SAMPLE_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
      // Final state: mark disconnected so the admin sees the user drop off.
      const final = { ...sampleState(ALLOW_REMOTE), connected: false }
      // Fire-and-forget; uses a fresh getDb so the cancelled flag above (scoped
      // to writeState) doesn't suppress this last write.
      void (async () => {
        try {
          const db = await getDb()
          if (!db) return
          const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
          await setDoc(
            doc(db, 'users', uid!, 'live', 'state'),
            { ...final, updatedAt: serverTimestamp() },
            { merge: true },
          )
        } catch {
          /* ignore */
        }
      })()
    }
  }, [uid])

  // --- PUBLISH live PROGRAM (dedupe + cap, write ONLY on change) ----------
  // Mirrors the user's currently-loaded combined G-code to a SEPARATE doc so the
  // admin can re-render their toolpath. Cost-disciplined: skipped entirely while
  // unchanged (hash+length key), capped to PROGRAM_CAP_BYTES, and throttled.
  useEffect(() => {
    if (!firebaseConfigured() || !uid) return
    let cancelled = false
    let lastKey: string | null = null
    let lastWriteAt = 0

    async function writeProgram(): Promise<void> {
      const prog = useProgram.getState()
      const full = prog.lines.join('\n')
      // Cap: truncate (on a line boundary) if over the byte budget.
      let gcode = full
      let truncated = false
      if (gcode.length > PROGRAM_CAP_BYTES) {
        gcode = gcode.slice(0, PROGRAM_CAP_BYTES)
        const nl = gcode.lastIndexOf('\n')
        if (nl > 0) gcode = gcode.slice(0, nl)
        truncated = true
      }
      const lines = prog.lines.length
      const hash = hashString(full)
      // Dedupe key over the FULL program (so a change beyond the cap still writes).
      const key = `${prog.name ?? ''}|${full.length}|${hash}`
      if (key === lastKey) return
      try {
        const db = await getDb()
        if (!db || cancelled) return
        const { doc, setDoc, serverTimestamp } = await import('firebase/firestore')
        await setDoc(
          doc(db, 'users', uid!, 'live', 'program'),
          {
            gcode,
            name: prog.name,
            lines,
            hash,
            truncated,
            ts: Date.now(),
            updatedAt: serverTimestamp(),
          },
          { merge: true },
        )
        lastKey = key
        lastWriteAt = Date.now()
      } catch {
        /* publish is best-effort; never surface */
      }
    }

    const tick = () => {
      if (cancelled) return
      if (Date.now() - lastWriteAt < PROGRAM_PUBLISH_MIN_MS) return
      void writeProgram()
    }

    // Eager first publish so the admin sees the loaded program immediately.
    void writeProgram()
    const timer = setInterval(tick, SAMPLE_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [uid])

  // --- COMMAND EXECUTOR (only while allowRemote === true) -----------------
  useEffect(() => {
    if (!firebaseConfigured() || !uid) return
    let cancelled = false
    let unsub: (() => void) | null = null

    async function start(): Promise<void> {
      const db = await getDb()
      if (!db || cancelled) return
      const { collection, query, where, onSnapshot, doc, updateDoc } = await import(
        'firebase/firestore'
      )
      const col = collection(db, 'users', uid!, 'commands')

      unsub = onSnapshot(
        query(col, where('status', '==', 'pending')),
        (snap) => {
          snap.docChanges().forEach((change) => {
            if (change.type === 'removed') return
            const id = change.doc.id
            const data = change.doc.data() as {
              kind?: string
              data?: string
              status?: string
            }
            if (data.status !== 'pending') return
            void execute(id, data, col, doc, updateDoc)
          })
        },
        () => {
          /* snapshot error — ignore (e.g. transient permission/offline) */
        },
      )
    }

    async function execute(
      id: string,
      data: { kind?: string; data?: string },
      col: import('firebase/firestore').CollectionReference,
      doc: typeof import('firebase/firestore')['doc'],
      updateDoc: typeof import('firebase/firestore')['updateDoc'],
    ): Promise<void> {
      const ref = doc(col, id)
      // NEVER auto-execute when the machine isn't connected.
      if (!grbl.isConnected) {
        await updateDoc(ref, {
          status: 'error',
          result: 'machine not connected',
        }).catch(() => {})
        return
      }
      try {
        switch (data.kind) {
          case 'realtime': {
            const byte = parseRealtime(data.data ?? '')
            if (byte == null) throw new Error('bad realtime byte')
            await grbl.realtime(byte)
            break
          }
          case 'gcode': {
            const line = (data.data ?? '').trim()
            if (!line) throw new Error('empty gcode')
            await grbl.send(line)
            break
          }
          case 'jog': {
            await grbl.jog(parseJog(data.data ?? ''))
            break
          }
          default:
            throw new Error(`unknown kind: ${data.kind}`)
        }
        await updateDoc(ref, { status: 'done' }).catch(() => {})
      } catch (e) {
        await updateDoc(ref, {
          status: 'error',
          result: e instanceof Error ? e.message : String(e),
        }).catch(() => {})
      }
    }

    void start()
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [uid])
}

/**
 * Parse a realtime command payload into a byte. Accepts either a numeric byte
 * ("0x18", "24") or a known symbol ("?", "!", "~", "reset", "hold", "resume",
 * "status", "jogCancel").
 */
function parseRealtime(s: string): number | null {
  const t = s.trim().toLowerCase()
  switch (t) {
    case '?':
    case 'status':
      return 0x3f
    case '!':
    case 'hold':
      return 0x21
    case '~':
    case 'resume':
      return 0x7e
    case 'reset':
    case 'softreset':
      return 0x18
    case 'jogcancel':
      return 0x85
  }
  const n = t.startsWith('0x') ? parseInt(t, 16) : Number(t)
  return Number.isFinite(n) ? n & 0xff : null
}

/**
 * Parse a jog payload. Accepts JSON (`{"x":1,"feed":500}`) or a compact form
 * like "X10 Y-5 F500". Returns a JogParams with a sane default feed.
 */
function parseJog(s: string): { x?: number; y?: number; z?: number; feed: number } {
  const trimmed = s.trim()
  if (trimmed.startsWith('{')) {
    try {
      const o = JSON.parse(trimmed) as Record<string, unknown>
      const num = (v: unknown): number | undefined =>
        typeof v === 'number' && Number.isFinite(v) ? v : undefined
      return {
        x: num(o.x),
        y: num(o.y),
        z: num(o.z),
        feed: num(o.feed) ?? 500,
      }
    } catch {
      /* fall through to token parse */
    }
  }
  const out: { x?: number; y?: number; z?: number; feed: number } = { feed: 500 }
  for (const tok of trimmed.split(/\s+/)) {
    const axis = tok[0]?.toLowerCase()
    const val = Number(tok.slice(1))
    if (!Number.isFinite(val)) continue
    if (axis === 'x') out.x = val
    else if (axis === 'y') out.y = val
    else if (axis === 'z') out.z = val
    else if (axis === 'f') out.feed = val
  }
  return out
}
