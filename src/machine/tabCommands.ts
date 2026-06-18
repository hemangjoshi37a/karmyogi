// Per-tab COMMAND BUS — a scalable way for every workbench tab to expose a rich,
// gamepad-bindable action set.
//
// THE PROBLEM this solves
// -----------------------
// The old `gamepadTabActions` hardcoded a handful of `() => void` closures for 4
// tabs only. That doesn't scale to ~18 tabs, and many panel actions live in LOCAL
// React state (a selected row, a "regenerate" button, a viewer handle) that a
// module-scope closure simply can't reach.
//
// THE DESIGN
// ----------
//   1. A STATIC CATALOG (`TAB_COMMAND_CATALOG`) lists, per tab, every command a
//      tab CAN bind — id + i18n label. It is pure data, so the mapping UI can show
//      a tab's actions even when that tab isn't mounted.
//
//   2. A runtime REGISTRY maps tabId → (cmdId → handler). A mounted panel calls
//      `useTabCommands(tabId, handlers)` to register the REAL closures for the
//      commands it supports; the registration is torn down on unmount. The gamepad
//      calls `runTabCommand(tabId, cmdId)`, which looks up the live handler.
//
//   3. GLOBAL commands (stream / pause / abort / sim transport) don't need a
//      mounted panel — they act on the shared zustand stores + `grbl` singleton.
//      Their `run` lives right here in the catalog as a built-in fallback, so they
//      work whether or not the owning panel is open. A panel MAY still register a
//      richer handler for the same id (the registered one wins).
//
// PURITY: this module imports only the stores it needs for the global fallbacks
// (no React, no DOM, no heavy panel code). Panels supply their own closures.

import { useEffect, useRef } from 'react'
import { grbl } from '../serial/controller'
import { useProgram } from '../store/program'
import { usePlayback } from '../store/playback'

/** A single bindable command for a tab: stable id + i18n label. */
export interface TabCommandDef {
  /** Stable id, unique within its tab (e.g. 'stream', 'nextPoint'). */
  id: string
  /** i18n key + English fallback for the menu / legend label. */
  labelKey: string
  label: string
  /**
   * Optional GLOBAL fallback handler — runs even when the owning panel is not
   * mounted (acts on shared stores / the controller). A panel-registered handler
   * for the same id takes precedence. Must be self-guarding and never throw.
   */
  run?: () => void
}

// ─── global fallback handlers (store/controller-backed, panel-independent) ────
// These mirror the historic global tab actions; they reach into the shared
// stores so e.g. Stream works from the Program tab whether or not that panel is
// the active dock tab and mounted.

const streamRun = (): void => {
  if (!grbl.isConnected) return
  const prog = useProgram.getState()
  if (prog.streaming) {
    grbl.resume()
    return
  }
  if (prog.lines.length) grbl.startProgram(prog.lines)
}
const pauseRun = (): void => {
  if (!grbl.isConnected) return
  grbl.feedHold()
}
const resumeRun = (): void => {
  if (!grbl.isConnected) return
  grbl.resume()
}
const abortRun = (): void => {
  if (!grbl.isConnected) return
  grbl.abortProgram()
}
const simToggleRun = (): void => {
  if (usePlayback.getState().timeline) usePlayback.getState().toggle()
}
const simStartRun = (): void => {
  if (usePlayback.getState().timeline) usePlayback.getState().seek(0)
}
const simPrevSegRun = (): void => {
  if (usePlayback.getState().timeline) usePlayback.getState().stepSeg(-1)
}
const simNextSegRun = (): void => {
  if (usePlayback.getState().timeline) usePlayback.getState().stepSeg(1)
}

// Shared command DEFs reused across many tabs (same id + label + global run).
const STREAM: TabCommandDef = { id: 'stream', labelKey: 'gp.cmd.stream', label: 'Stream / Resume', run: streamRun }
const PAUSE: TabCommandDef = { id: 'pause', labelKey: 'gp.cmd.pause', label: 'Pause (feed hold)', run: pauseRun }
const RESUME: TabCommandDef = { id: 'resume', labelKey: 'gp.cmd.resume', label: 'Resume', run: resumeRun }
const ABORT: TabCommandDef = { id: 'abort', labelKey: 'gp.cmd.abort', label: 'Abort', run: abortRun }
const SIM_PLAY: TabCommandDef = { id: 'simPlayPause', labelKey: 'gp.cmd.simPlayPause', label: 'Play / pause sim', run: simToggleRun }
const SIM_START: TabCommandDef = { id: 'simStart', labelKey: 'gp.cmd.simStart', label: 'Jump sim to start', run: simStartRun }
const SIM_PREV: TabCommandDef = { id: 'simPrevSeg', labelKey: 'gp.cmd.simPrevSeg', label: 'Prev sim segment', run: simPrevSegRun }
const SIM_NEXT: TabCommandDef = { id: 'simNextSeg', labelKey: 'gp.cmd.simNextSeg', label: 'Next sim segment', run: simNextSegRun }

// Panel-LOCAL command DEFs (no global run — only meaningful when the owning panel
// is mounted + has registered a handler). Defined once and reused per tab.
const GENERATE: TabCommandDef = { id: 'generate', labelKey: 'gp.cmd.generate', label: 'Generate G-code' }
const FRAME: TabCommandDef = { id: 'frame', labelKey: 'gp.cmd.frame', label: 'Frame (trace perimeter)' }
const PREV_JOB: TabCommandDef = { id: 'prevJob', labelKey: 'gp.cmd.prevJob', label: 'Previous job' }
const NEXT_JOB: TabCommandDef = { id: 'nextJob', labelKey: 'gp.cmd.nextJob', label: 'Next job' }
const DELETE_JOB: TabCommandDef = { id: 'deleteJob', labelKey: 'gp.cmd.deleteJob', label: 'Delete selected job' }
const PREV_POINT: TabCommandDef = { id: 'prevPoint', labelKey: 'gp.cmd.prevPoint', label: 'Previous point' }
const NEXT_POINT: TabCommandDef = { id: 'nextPoint', labelKey: 'gp.cmd.nextPoint', label: 'Next point' }
const ADD_POINT: TabCommandDef = { id: 'addPoint', labelKey: 'gp.cmd.addPoint', label: 'Teach point (record position)' }
const DELETE_POINT: TabCommandDef = { id: 'deletePoint', labelKey: 'gp.cmd.deletePoint', label: 'Delete selected point' }
const VIEW_FIT: TabCommandDef = { id: 'viewFit', labelKey: 'gp.cmd.viewFit', label: 'Fit to view' }
const VIEW_ISO: TabCommandDef = { id: 'viewIso', labelKey: 'gp.cmd.viewIso', label: 'Isometric view' }
const VIEW_TOP: TabCommandDef = { id: 'viewTop', labelKey: 'gp.cmd.viewTop', label: 'Top view' }
const HIDE_PROCESSED: TabCommandDef = { id: 'hideProcessed', labelKey: 'gp.cmd.hideProcessed', label: 'Toggle hide-processed' }

/**
 * THE STATIC CATALOG — every bindable command for each tab, in display order.
 * Tabs absent here expose no per-tab commands (only the global gamepad map),
 * which is correct for purely-interactive tabs (Controller / Console / Probe).
 */
export const TAB_COMMAND_CATALOG: Record<string, TabCommandDef[]> = {
  program: [STREAM, PAUSE, RESUME, ABORT, FRAME],
  cadcam: [GENERATE, FRAME, SIM_PLAY, PREV_JOB, NEXT_JOB, DELETE_JOB],
  laser: [FRAME, SIM_PLAY, STREAM],
  pcb: [GENERATE, FRAME, { id: 'runAll', labelKey: 'gp.cmd.runAll', label: 'Run / stream all stages' }, { id: 'levelProbe', labelKey: 'gp.cmd.levelProbe', label: 'Height-map probe' }, STREAM],
  soldering: [ADD_POINT, NEXT_POINT, PREV_POINT, DELETE_POINT, { id: 'optimize', labelKey: 'gp.cmd.optimize', label: 'Optimize travel order' }, STREAM],
  glue: [NEXT_POINT, PREV_POINT, DELETE_POINT, STREAM],
  pnp: [ADD_POINT, NEXT_POINT, PREV_POINT, DELETE_POINT, STREAM],
  screwfitting: [ADD_POINT, NEXT_POINT, PREV_POINT, DELETE_POINT, STREAM],
  drilling: [ADD_POINT, NEXT_POINT, PREV_POINT, DELETE_POINT, STREAM],
  welding: [NEXT_POINT, PREV_POINT, DELETE_POINT, STREAM],
  writing: [FRAME, SIM_PLAY, STREAM],
  signature: [GENERATE, FRAME, SIM_PLAY, STREAM],
  print: [GENERATE, SIM_PLAY, STREAM],
  visualizer: [SIM_PLAY, SIM_START, SIM_PREV, SIM_NEXT, VIEW_FIT, VIEW_ISO, VIEW_TOP, HIDE_PROCESSED],
  springcoiling: [SIM_PLAY, STREAM, PAUSE, ABORT],
  camera: [
    { id: 'recordToggle', labelKey: 'gp.cmd.recordToggle', label: 'Start / stop recording' },
    { id: 'snapshot', labelKey: 'gp.cmd.snapshot', label: 'Snapshot' },
  ],
}

/** Tabs that expose at least one per-tab command (for the editor's tab list). */
export const TABS_WITH_COMMANDS: string[] = Object.keys(TAB_COMMAND_CATALOG)

/** Map of catalog command defs for a tab, keyed by id (for fast resolution). */
const CATALOG_BY_TAB: Record<string, Map<string, TabCommandDef>> = Object.fromEntries(
  Object.entries(TAB_COMMAND_CATALOG).map(([tab, defs]) => [tab, new Map(defs.map((d) => [d.id, d]))]),
)

/** The catalog command def for (tab, cmdId), or undefined. */
export function tabCommandDef(tab: string | undefined, cmdId: string): TabCommandDef | undefined {
  if (!tab) return undefined
  return CATALOG_BY_TAB[tab]?.get(cmdId)
}

/** All catalog command defs for a tab (empty when the tab has none). */
export function tabCommands(tab: string | undefined): TabCommandDef[] {
  if (!tab) return []
  return TAB_COMMAND_CATALOG[tab] ?? []
}

// ─── runtime registry ─────────────────────────────────────────────────────────
// A tab can have MORE THAN ONE concurrent registrant — a single tab (e.g. PCB)
// may host several sub-components that each own a disjoint slice of the command
// set (board ops vs. the height-map probe). We therefore keep an ORDERED list of
// per-registrant handler maps per tab and MERGE them at lookup time; later
// registrants win on a collision (last-mounted owns a shared id), which is the
// sensible default and never silently drops another component's commands.
const REGISTRY = new Map<string, Array<Map<string, () => void>>>()

/**
 * Register a set of live command handlers for a tab. Returns an unregister fn.
 * Only ids present in this tab's catalog are kept (the catalog is the single
 * source of truth). Multiple registrants for the same tab COEXIST (their handler
 * maps are merged on lookup); unregistering removes only this registrant's map.
 */
export function registerTabCommands(tab: string, handlers: Record<string, () => void>): () => void {
  const map = new Map<string, () => void>()
  const known = CATALOG_BY_TAB[tab]
  for (const [id, fn] of Object.entries(handlers)) {
    if (typeof fn !== 'function') continue
    if (known && !known.has(id)) continue
    map.set(id, fn)
  }
  const list = REGISTRY.get(tab) ?? []
  list.push(map)
  REGISTRY.set(tab, list)
  return () => {
    const cur = REGISTRY.get(tab)
    if (!cur) return
    const i = cur.indexOf(map)
    if (i >= 0) cur.splice(i, 1)
    if (cur.length === 0) REGISTRY.delete(tab)
  }
}

/** The live handler for (tab, cmdId) across all registrants (last wins). */
function liveHandler(tab: string, cmdId: string): (() => void) | undefined {
  const list = REGISTRY.get(tab)
  if (!list) return undefined
  for (let i = list.length - 1; i >= 0; i--) {
    const fn = list[i].get(cmdId)
    if (fn) return fn
  }
  return undefined
}

/**
 * Invoke a tab command from the gamepad. Resolution order:
 *   1. a live, panel-registered handler (richest — captures local React state);
 *   2. the catalog def's global `run` fallback (store/controller-backed);
 *   3. no-op (command has no handler and no fallback, e.g. tab not mounted).
 * NEVER throws — a misbehaving handler can't break the gamepad loop.
 */
export function runTabCommand(tab: string | undefined, cmdId: string): void {
  if (!tab || !cmdId) return
  try {
    const live = liveHandler(tab, cmdId)
    if (live) {
      live()
      return
    }
    CATALOG_BY_TAB[tab]?.get(cmdId)?.run?.()
  } catch {
    /* swallow — a tab command must never break the gamepad poll loop */
  }
}

/** True when a command is currently runnable (has a live handler or a fallback). */
export function isTabCommandRunnable(tab: string | undefined, cmdId: string): boolean {
  if (!tab || !cmdId) return false
  if (liveHandler(tab, cmdId)) return true
  return !!CATALOG_BY_TAB[tab]?.get(cmdId)?.run
}

// ─── React hook ───────────────────────────────────────────────────────────────
/**
 * Panel-facing hook: register this panel's live command closures for `tab` while
 * the panel is mounted, and unregister on unmount. SURGICAL by design — a panel
 * just maps the catalog command ids it supports to its existing handlers:
 *
 *   useTabCommands('soldering', { addPoint: recordPosition, nextPoint: ..., ... })
 *
 * The handlers object is read fresh on every invocation (via a ref), so a closure
 * that captures changing local state (a `selected` index, a viewer handle) always
 * runs against the LATEST render — no need to re-register on every state change.
 * The effect re-runs only when the SET of command ids changes (cheap + stable).
 */
export function useTabCommands(tab: string, handlers: Record<string, () => void>): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  // A stable key over the command-id SET so we register once per id-set, not per
  // render. Sorted so key order can't flip the dependency.
  const idsKey = Object.keys(handlers).sort().join(',')
  useEffect(() => {
    // Register thin trampolines that always dispatch to the latest closures.
    const trampolines: Record<string, () => void> = {}
    for (const id of idsKey ? idsKey.split(',') : []) {
      trampolines[id] = () => handlersRef.current[id]?.()
    }
    return registerTabCommands(tab, trampolines)
  }, [tab, idsKey])
}
