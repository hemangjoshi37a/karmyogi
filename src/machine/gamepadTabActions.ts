// Context-aware gamepad bindings, keyed by the active dock tab.
//
// v3 — COMMAND BUS. This module is now a thin ADAPTER between the gamepad's
// control-token model and the per-tab COMMAND BUS in `tabCommands.ts`:
//   - a tab's DEFAULT bindings map gamepad control tokens → command IDs (drawn
//     from the static catalog);
//   - the operator's per-tab OVERRIDES (stored in `gamepadMap.ts`) map a control
//     token → command id and win over the defaults;
//   - `tabActionFor(tab, token, overrides)` resolves a control token to a
//     `{ labelKey, label, run }` whose `run` invokes `runTabCommand(tab, cmdId)`.
//
// `runTabCommand` dispatches to a mounted panel's registered handler when present
// (so it reaches LOCAL React state), else a global store/controller fallback, so
// every action is safe whether or not the owning panel is mounted/active.
//
// Pure / UI-independent (no React, no DOM).

import { buttonToken, parseToken, type ControlToken } from '../store/gamepadMap'
import {
  TAB_COMMAND_CATALOG,
  TABS_WITH_COMMANDS,
  tabCommandDef,
  runTabCommand,
} from './tabCommands'

/** Standard-mapping button index (mirrors `Btn` in useGamepad.ts). */
export type ButtonIndex = number

/** A resolved context action: a terse legend label + a guarded handler. */
export interface TabAction {
  /** i18n key + English fallback for the legend label, e.g. "Stream". */
  labelKey: string
  label: string
  /** Fire the action. Self-guarding; never throws. */
  run: () => void
}

// Standard face/shoulder button tokens used by the built-in default bindings.
const A = buttonToken(0)
const B = buttonToken(1)
const X = buttonToken(2)
const Y = buttonToken(3)
const LB = buttonToken(4)
const RB = buttonToken(5)

/**
 * Built-in DEFAULT bindings per tab: control token → command id (the command id
 * must exist in that tab's `TAB_COMMAND_CATALOG` entry). These reproduce — and
 * extend — the historic 4-tab behaviour:
 *   - program / springcoiling: A=Stream/Resume, X=Pause, B=Abort (+ Y=sim on spring)
 *   - cadcam: B=Delete job, LB/RB=Prev/Next job
 *   - visualizer: A=sim, X=jump-to-start, LB/RB=prev/next segment
 * Other tabs get sensible defaults from their catalog so the pad is immediately
 * useful; the operator can rebind anything per tab in the modal.
 */
const DEFAULTS: Record<string, Record<ControlToken, string>> = {
  program: { [A]: 'stream', [X]: 'pause', [B]: 'abort' },
  springcoiling: { [A]: 'stream', [X]: 'pause', [B]: 'abort', [Y]: 'simPlayPause' },
  cadcam: { [B]: 'deleteJob', [LB]: 'prevJob', [RB]: 'nextJob', [Y]: 'simPlayPause' },
  visualizer: { [A]: 'simPlayPause', [X]: 'simStart', [LB]: 'simPrevSeg', [RB]: 'simNextSeg' },
  laser: { [A]: 'stream', [Y]: 'simPlayPause', [X]: 'frame' },
  pcb: { [A]: 'stream', [Y]: 'simPlayPause', [X]: 'runAll' },
  writing: { [A]: 'stream', [Y]: 'simPlayPause', [X]: 'frame' },
  signature: { [A]: 'stream', [Y]: 'simPlayPause', [X]: 'frame', [B]: 'generate' },
  print: { [A]: 'stream', [Y]: 'simPlayPause', [B]: 'generate' },
  soldering: { [Y]: 'addPoint', [LB]: 'prevPoint', [RB]: 'nextPoint' },
  glue: { [LB]: 'prevPoint', [RB]: 'nextPoint' },
  pnp: { [Y]: 'addPoint', [LB]: 'prevPoint', [RB]: 'nextPoint' },
  screwfitting: { [Y]: 'addPoint', [LB]: 'prevPoint', [RB]: 'nextPoint' },
  drilling: { [Y]: 'addPoint', [LB]: 'prevPoint', [RB]: 'nextPoint' },
  welding: { [LB]: 'prevPoint', [RB]: 'nextPoint' },
  camera: { [Y]: 'recordToggle', [X]: 'snapshot' },
}

/** Tabs offered in the per-tab editor's tab selector (all catalog tabs). */
export const TABS_WITH_ACTIONS = TABS_WITH_COMMANDS

/** Build a TabAction that dispatches a command id on a tab via the command bus. */
function commandAction(tab: string, cmdId: string): TabAction | undefined {
  const def = tabCommandDef(tab, cmdId)
  if (!def) return undefined
  return { labelKey: def.labelKey, label: def.label, run: () => runTabCommand(tab, cmdId) }
}

/**
 * Resolve the context action bound to a control TOKEN on `tab`: the operator's
 * per-tab override wins, else the built-in default. Returns undefined when
 * neither binds that token (→ the gamepad runs the GLOBAL action instead).
 *
 * `overrides` is the per-tab override map for the ACTIVE pad (token → command id).
 */
export function tabActionFor(
  tab: string | undefined,
  token: ControlToken,
  overrides?: Record<string, string>,
): TabAction | undefined {
  if (!tab) return undefined
  const ovId = overrides?.[token]
  if (ovId) {
    const act = commandAction(tab, ovId)
    if (act) return act
  }
  const defId = DEFAULTS[tab]?.[token]
  if (defId) return commandAction(tab, defId)
  return undefined
}

/** A compact legend entry of a tab's effective bindings (for the modal). */
export interface LegendEntry {
  /** The control token (for glyph rendering). */
  token: ControlToken
  /** The command id this token runs. */
  cmdId: string
  /** i18n key + fallback for the command label. */
  labelKey: string
  label: string
  /** True when this row comes from a user override (vs a built-in default). */
  override?: boolean
}

/**
 * Build the legend rows for a tab's EFFECTIVE bindings — built-in defaults
 * overlaid with the active pad's overrides — sorted by token. Rows whose command
 * id no longer exists in the catalog are dropped (defensive against stale saves).
 */
export function tabLegend(tab: string | undefined, overrides?: Record<string, string>): LegendEntry[] {
  if (!tab) return []
  const out = new Map<ControlToken, LegendEntry>()
  const defaults = DEFAULTS[tab]
  if (defaults) {
    for (const tok of Object.keys(defaults)) {
      const def = tabCommandDef(tab, defaults[tok])
      if (def) out.set(tok, { token: tok, cmdId: def.id, labelKey: def.labelKey, label: def.label })
    }
  }
  if (overrides) {
    for (const tok of Object.keys(overrides)) {
      const def = tabCommandDef(tab, overrides[tok])
      if (def) out.set(tok, { token: tok, cmdId: def.id, labelKey: def.labelKey, label: def.label, override: true })
    }
  }
  return Array.from(out.values()).sort((a, b) => a.token.localeCompare(b.token))
}

/** The bindable command catalogue for a tab (for the per-tab editor's picker). */
export function tabCommandCatalogue(tab: string | undefined) {
  if (!tab) return []
  return TAB_COMMAND_CATALOG[tab] ?? []
}

/** True when a parsed token is a plain standard button (helper for legends). */
export function isButtonToken(tok: ControlToken): boolean {
  return parseToken(tok)?.kind === 'button'
}
