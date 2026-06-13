// Context-aware gamepad button mappings, keyed by the active dock tab.
//
// The base `useGamepad` hook always drives ANALOG JOG (left stick → XY, right
// stick / triggers → Z) and a GLOBAL set of discrete face-button actions (via
// the caller's `onAction`). THIS module layers a per-tab override on top: when
// the currently-active dock tab has a binding for a given standard-mapping
// button, pressing that button runs the tab's action INSTEAD of the global one,
// so each workbench tab can be driven from the controller.
//
// Design:
//   - Pure / UI-independent (no React, no DOM). Each action is a `() => void`
//     that reaches into the existing zustand stores (via getState()) and the
//     `grbl` controller singleton. Everything is GUARDED — a disconnected
//     machine or empty selection makes the action a safe no-op (never throws).
//   - The registry is a plain object keyed by dock-panel id (the same ids the
//     shell registers, e.g. 'program', 'cadcam'). Add a new tab by adding one
//     entry; see the FALLBACK note at the bottom for tabs not yet covered.
//   - Button indices follow the Gamepad API standard mapping (see `Btn` in
//     useGamepad.ts): A=0 B=1 X=2 Y=3 LB=4 RB=5 dpad=12..15 Start=9.
//
// SAFETY: these can move / stop the machine, so the hook only invokes them while
// the controller is armed + the machine is connected and no modal is focused —
// exactly the same gating the global jog/actions already use. The guards here
// are a second line of defence (each call checks `grbl.isConnected` etc.).

import { grbl } from '../serial/controller'
import { useProgram } from '../store/program'
import { useCarveJobs } from '../store/carveJobs'

/** Standard-mapping button index (mirrors `Btn` in useGamepad.ts). */
export type ButtonIndex = number

/** A single context action: a short label (for the modal legend) + a handler. */
export interface TabAction {
  /** Terse label shown in the modal legend, e.g. "Stream", "Pause", "Abort". */
  label: string
  /** Fire the action. MUST be self-guarding and never throw. */
  run: () => void
}

/** A tab's button → action bindings (sparse; only the buttons it overrides). */
export type TabBindings = Partial<Record<ButtonIndex, TabAction>>

// Button index constants — duplicated here (rather than imported from
// useGamepad) so this stays a leaf module with no cycle back into the hook.
const A = 0
const B = 1
const X = 2
const LB = 4
const RB = 5

// ─── program tab ────────────────────────────────────────────────────────────
// Drive a loaded G-code program straight from the pad:
//   A = Stream (start from the top) / Resume (release a feed-hold)
//   X = Pause (feed-hold)
//   B = Abort (soft-reset / stop the stream)
const programBindings: TabBindings = {
  [A]: {
    label: 'Stream / Resume',
    run: () => {
      if (!grbl.isConnected) return
      const prog = useProgram.getState()
      if (prog.streaming) {
        // Mid-stream A = resume a feed-hold (the `~` realtime byte; harmless if
        // not currently held).
        grbl.resume()
        return
      }
      // Not streaming → start the placed program from the first line.
      const lines = prog.lines
      if (!lines.length) return
      grbl.startProgram(lines)
    },
  },
  [X]: {
    label: 'Pause',
    run: () => {
      if (!grbl.isConnected) return
      grbl.feedHold()
    },
  },
  [B]: {
    label: 'Abort',
    run: () => {
      if (!grbl.isConnected) return
      grbl.abortProgram()
    },
  },
}

// ─── cadcam tab (2D/3D Carving) ─────────────────────────────────────────────
// Manage the multi-model carve job list:
//   B  = delete the selected job
//   LB = select the PREVIOUS job in the list
//   RB = select the NEXT job in the list
function cycleCarveJob(dir: -1 | 1): void {
  const st = useCarveJobs.getState()
  const { jobs, selectedId } = st
  if (jobs.length === 0) return
  const cur = jobs.findIndex((j) => j.id === selectedId)
  // From no selection, LB picks the last and RB picks the first; otherwise wrap.
  const start = cur < 0 ? (dir === 1 ? -1 : 0) : cur
  const next = (start + dir + jobs.length) % jobs.length
  const job = jobs[next]
  if (job) st.selectJob(job.id)
}

const cadcamBindings: TabBindings = {
  [B]: {
    label: 'Delete job',
    run: () => {
      const st = useCarveJobs.getState()
      if (st.selectedId) st.removeJob(st.selectedId)
    },
  },
  [LB]: {
    label: 'Prev job',
    run: () => cycleCarveJob(-1),
  },
  [RB]: {
    label: 'Next job',
    run: () => cycleCarveJob(1),
  },
}

/**
 * The full registry: dock-panel id → button bindings. Add a tab by appending an
 * entry here (and import any store it needs). Order is irrelevant.
 *
 * FALLBACK (intentional, follow-up work): every tab NOT listed here — including
 *   controller, writing, soldering, screwfitting, drilling, pcb, glue, pnp,
 *   signature, print, laser, welding, camera, visualizer, console
 * — has NO context bindings, so on those tabs the gamepad keeps its GLOBAL
 * behaviour (analog jog + the default face-button actions via `onAction`). In
 * particular the `controller` tab deliberately falls back so jog stays primary.
 * Wire more tabs here as their key actions are identified.
 */
export const GAMEPAD_TAB_ACTIONS: Record<string, TabBindings> = {
  program: programBindings,
  cadcam: cadcamBindings,
}

/** The bindings for a tab id, or undefined when it falls back to global. */
export function tabBindings(tab: string | undefined): TabBindings | undefined {
  if (!tab) return undefined
  return GAMEPAD_TAB_ACTIONS[tab]
}

/**
 * Look up the context action bound to `button` on `tab`, if any. Returns
 * undefined when the tab has no override for that button (→ caller should run
 * the global action instead).
 */
export function tabActionFor(tab: string | undefined, button: ButtonIndex): TabAction | undefined {
  return tabBindings(tab)?.[button]
}

/** A compact legend of a tab's bindings (for the modal), in display order. */
export interface LegendEntry {
  /** Friendly control label, e.g. "A", "B", "LB". */
  control: string
  /** The action label, e.g. "Stream / Resume". */
  action: string
}

/** Friendly control names per standard-mapping button index. */
const BUTTON_LABEL: Record<number, string> = {
  0: 'A',
  1: 'B',
  2: 'X',
  3: 'Y',
  4: 'LB',
  5: 'RB',
  9: 'Start',
  12: 'D-pad ↑',
  13: 'D-pad ↓',
  14: 'D-pad ←',
  15: 'D-pad →',
}

/**
 * Build the legend rows for the active tab's context bindings, sorted by button
 * index so the order is stable. Empty when the tab falls back to global.
 */
export function tabLegend(tab: string | undefined): LegendEntry[] {
  const bindings = tabBindings(tab)
  if (!bindings) return []
  return Object.keys(bindings)
    .map(Number)
    .sort((a, b) => a - b)
    .map((i) => ({
      control: BUTTON_LABEL[i] ?? `Btn ${i}`,
      action: bindings[i]!.label,
    }))
}
