// Browser side of the camera→server-style relay, but for the GRBL MACHINE.
//
// The machine is connected over Web Serial in THIS browser; the agent runs on
// the SERVER. This hook makes the browser the relay endpoint for the dev-server
// middlewares in vite-machine-plugin.mjs:
//
//   • State push  — every ~400ms POST the live useMachine snapshot (+ any new
//     console lines) to /__machine_state, so the server can read machine state.
//   • Command pull — every ~350ms GET /__machine_cmd and run each queued command
//     through the controller's normal path (grbl.send / grbl.realtime).
//
// SAFETY: the bridge only RELAYS. It never invents or auto-sends motion; it runs
// exactly what the server queued, and only while connected. Default OFF; gated
// strictly on connection === 'connected'.

import { useEffect, useRef } from 'react'
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

/**
 * Relay this browser's live GRBL machine to the karmyogi dev server while
 * `enabled` AND the controller is connected. Cleans up its timers on unmount,
 * on disable, and on disconnect.
 */
export function useMachineBridge(enabled: boolean): void {
  // Highest console entry `id` already shipped, so each POST sends only NEW
  // lines. Tracked by monotonic id (not array index) so it survives the console
  // ring buffer evicting old entries from the front.
  const consoleSentIdRef = useRef(-1)
  // Guards so overlapping ticks (slow network) don't double-fire.
  const pushingRef = useRef(false)
  const pollingRef = useRef(false)
  // SAFETY: until "primed", the first command poll after (re)connecting DISCARDS
  // whatever is queued, so a stale backlog accumulated while the bridge was OFF
  // or the machine was disconnected can never suddenly fire as real motion.
  const primedRef = useRef(false)

  useEffect(() => {
    if (!enabled) return

    let stopped = false
    // Re-prime on every (re)enable: the first command poll will discard the
    // queue so a backlog from while the bridge was OFF never fires as motion.
    primedRef.current = false

    // --- state push loop -----------------------------------------------------
    const pushState = async () => {
      if (stopped || pushingRef.current) return
      const m = useMachine.getState()
      if (m.connection !== 'connected') return
      pushingRef.current = true
      try {
        const entries = useConsole.getState().entries
        // Ship only entries newer than the last id we sent (id is monotonic, so
        // this is correct even after the ring buffer drops old entries).
        const fresh = entries.filter((e) => e.id > consoleSentIdRef.current)
        const consoleLines = fresh
          .slice(-MAX_CONSOLE_PER_PUSH)
          .map((e) => `[${e.dir}] ${e.text}`)
        if (entries.length > 0) consoleSentIdRef.current = entries[entries.length - 1].id

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
        })
      } catch {
        /* network/dev-server hiccup — try again next tick */
      } finally {
        pushingRef.current = false
      }
    }

    // --- command pull loop ---------------------------------------------------
    const runCommand = async (c: BridgeCommand) => {
      try {
        if (typeof c.realtime === 'number') {
          await grbl.realtime(c.realtime)
        } else if (typeof c.cmd === 'string') {
          await grbl.send(c.cmd)
        } else if (Array.isArray(c.lines)) {
          for (const line of c.lines) {
            if (typeof line !== 'string') continue
            // Run sequentially so multi-line programs preserve order; one bad
            // line must not abort the rest.
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

    const pollCommands = async () => {
      if (stopped || pollingRef.current) return
      // Not connected → can't run anything, and force a re-prime so any backlog
      // queued during the disconnect is discarded on reconnect.
      if (useMachine.getState().connection !== 'connected') {
        primedRef.current = false
        return
      }
      pollingRef.current = true
      try {
        const res = await fetch('/__machine_cmd', { method: 'GET' })
        if (!res.ok) return
        const data = (await res.json()) as { cmds?: BridgeCommand[] }
        const cmds = Array.isArray(data.cmds) ? data.cmds : []
        // First poll after (re)connecting: DISCARD the queue (don't execute a
        // stale backlog), then start running fresh commands from now on.
        if (!primedRef.current) {
          primedRef.current = true
          return
        }
        const now = Date.now()
        for (const c of cmds) {
          if (stopped) break
          if (useMachine.getState().connection !== 'connected') break
          // Skip stale commands (belt-and-suspenders against any backlog).
          if (typeof c._t === 'number' && now - c._t > CMD_FRESH_MS) continue
          await runCommand(c)
        }
      } catch {
        /* network/dev-server hiccup — try again next tick */
      } finally {
        pollingRef.current = false
      }
    }

    const stateTimer = setInterval(() => void pushState(), STATE_PUSH_MS)
    const cmdTimer = setInterval(() => void pollCommands(), CMD_POLL_MS)

    return () => {
      stopped = true
      clearInterval(stateTimer)
      clearInterval(cmdTimer)
    }
  }, [enabled])
}
