// Browser side of the camera→server-style relay, but for the GRBL MACHINE.
//
// The machine is connected over Web Serial in THIS browser; the agent runs on
// the SERVER. This module makes the browser the relay endpoint for the dev-server
// middlewares in vite-machine-plugin.mjs:
//
//   • State push  — every ~400ms POST the live useMachine snapshot (+ any new
//     console lines) to /__machine_state, so the server can read machine state.
//   • Command pull — every ~350ms GET /__machine_cmd and run each queued command
//     through the controller's normal path (grbl.send / grbl.realtime). A
//     `KMAPP:<action>` command is an APP action (not GRBL): dispatched as a
//     `karmyogi:app` window event instead of sent to the controller.
//
// HMR-PROOF SINGLETON: the loops run at MODULE scope behind a window-level flag —
// NOT inside a React effect. The old effect-based version was repeatedly torn
// down by Vite Fast Refresh (clearing its intervals) without being re-established,
// silently killing machine relay while the page stayed alive. Module-scope
// intervals survive any number of Fast Refresh cycles; the global guard stops a
// re-import from starting duplicates.
//
// SAFETY: the bridge only RELAYS. It never invents or auto-sends motion; it runs
// exactly what the server queued, and only while connected. The first poll after
// (re)connecting DISCARDS the queue so a stale backlog can never fire as motion,
// and commands older than CMD_FRESH_MS are dropped.

import { grbl } from '../serial/controller'
import { useMachine } from '../store/machine'
import { useConsole } from '../store/console'

const STATE_PUSH_MS = 400
const CMD_POLL_MS = 350
const MAX_CONSOLE_PER_PUSH = 200
/** Drop commands older than this (ms) — a stale backlog must never fire as motion. */
const CMD_FRESH_MS = 12000

/** One queued command as drained from GET /__machine_cmd. */
interface BridgeCommand {
  cmd?: string
  realtime?: number
  lines?: string[]
  /** Server enqueue time (ms); used to drop stale commands. */
  _t?: number
}

// Module-scope loop state (was per-effect refs). Highest console `id` already
// shipped, so each POST sends only NEW lines (monotonic id survives the ring
// buffer evicting old entries). No in-flight guards (a suspended backgrounded
// fetch would latch them and kill the loop — see pushState/pollCommands).
// `primed` discards the first queue after (re)connect so a backlog never fires.
let consoleSentId = -1
let primed = false

async function pushState(): Promise<void> {
  // NO in-flight guard (see devBridge.ts): a suspended backgrounded-tab fetch
  // would latch a boolean guard true forever and kill the loop. The camera bridge
  // has no guard and survives — match it. Overlapping POSTs are last-writer-wins.
  const m = useMachine.getState()
  if (m.connection !== 'connected') return
  try {
    const entries = useConsole.getState().entries
    const fresh = entries.filter((e) => e.id > consoleSentId)
    const consoleLines = fresh.slice(-MAX_CONSOLE_PER_PUSH).map((e) => `[${e.dir}] ${e.text}`)
    if (entries.length > 0) consoleSentId = entries[entries.length - 1].id

    const payload = {
      state: m.state,
      connection: m.connection,
      wpos: m.wpos,
      mpos: m.mpos,
      wco: m.wco,
      feed: m.feed,
      spindle: m.spindle,
      pins: m.pins,
      overrides: m.overrides,
      ts: Date.now(),
      console: consoleLines,
    }
    await fetch('/__machine_state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      // Self-heal: abort a suspended (backgrounded-tab) request so the `pushing`
      // guard always resets — otherwise a hung fetch permanently stalls the loop.
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    /* network/dev-server hiccup / suspended request — try again next tick */
  }
}

async function runCommand(c: BridgeCommand): Promise<void> {
  try {
    if (typeof c.realtime === 'number') {
      await grbl.realtime(c.realtime)
    } else if (typeof c.cmd === 'string' && c.cmd.startsWith('KMAPP:')) {
      // APP command (not GRBL): an agent drives an app action, e.g.
      // "KMAPP:autoAlign". Dispatched as a window event for the owning panel.
      const action = c.cmd.slice('KMAPP:'.length)
      window.dispatchEvent(new CustomEvent('karmyogi:app', { detail: action }))
    } else if (typeof c.cmd === 'string') {
      await grbl.send(c.cmd)
    } else if (Array.isArray(c.lines)) {
      for (const line of c.lines) {
        if (typeof line !== 'string') continue
        try {
          await grbl.send(line)
        } catch {
          /* swallow per-line error */
        }
      }
    }
  } catch {
    /* swallow per-command error so the loop keeps draining */
  }
}

async function pollCommands(): Promise<void> {
  // No in-flight guard (see pushState): a suspended fetch would latch it true and
  // kill the loop. Overlapping polls are safe — the server drains its queue
  // atomically, so only one concurrent GET ever receives the commands.
  // Not connected → can't run anything, and force a re-prime so any backlog
  // queued during the disconnect is discarded on reconnect.
  if (useMachine.getState().connection !== 'connected') {
    primed = false
    return
  }
  try {
    const res = await fetch('/__machine_cmd', { method: 'GET', signal: AbortSignal.timeout(4000) })
    if (!res.ok) return
    const data = (await res.json()) as { cmds?: BridgeCommand[] }
    const cmds = Array.isArray(data.cmds) ? data.cmds : []
    // First poll after (re)connecting: DISCARD the queue (don't execute a stale
    // backlog), then start running fresh commands from now on.
    if (!primed) {
      primed = true
      return
    }
    const now = Date.now()
    for (const c of cmds) {
      if (useMachine.getState().connection !== 'connected') break
      if (typeof c._t === 'number' && now - c._t > CMD_FRESH_MS) continue
      await runCommand(c)
    }
  } catch {
    /* network/dev-server hiccup / suspended request — try again next tick */
  }
}

/**
 * Start the relay loops ONCE per page load. Idempotent + HMR-proof: the running
 * flag lives on `window`, so a Vite HMR re-import finds it already set and does
 * nothing, while the intervals (started here, not in a React effect) keep running
 * across Fast Refresh cycles. Always runs in dev so an agent has machine access
 * without depending on a UI toggle; the connection gate + priming keep it safe.
 */
function startMachineBridge(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  const w = window as unknown as { __kmMachineBridgeRunning?: boolean }
  if (w.__kmMachineBridgeRunning) return
  w.__kmMachineBridgeRunning = true
  primed = false
  setInterval(() => void pushState(), STATE_PUSH_MS)
  setInterval(() => void pollCommands(), CMD_POLL_MS)
}

startMachineBridge()

/**
 * Relay this browser's live GRBL machine to the karmyogi dev server. In DEV the
 * loops run at module scope (HMR-proof, always on); this hook just guarantees the
 * module is imported. In production the relay is stripped (DEV-gated), so the
 * `enabled` flag is honored only there — kept for API compatibility with App.
 */
export function useMachineBridge(_enabled: boolean): void {
  startMachineBridge()
}
