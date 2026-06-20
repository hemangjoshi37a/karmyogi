// Browser side of the DEV observability + control bridge (see
// vite-dev-bridge.mjs). Runs ONLY in dev. Two loops:
//
//   • State push — every ~600ms POST a compact snapshot of the relevant zustand
//     stores to /__app_state, so an agent on the server can READ the live app
//     state (especially the head-camera calibration) without touching the UI.
//   • Command pull — every ~400ms GET /__app_cmd and run each queued action.
//     `focus:<panelId>` activates that dock tab; everything else is re-emitted as
//     a `karmyogi:app` window event (handled by the owning panel, e.g. the Camera
//     panel's calibration controls). This channel does NOT need the machine
//     connected, so panel focus / mosaic / mask / tuning all work hardware-free.
//
// HMR-PROOF: the loops run at MODULE scope behind a window-level singleton flag —
// NOT inside a React effect. Earlier the loops lived in a `useEffect`, and Vite's
// Fast Refresh kept tearing that effect down (clearing the intervals) without
// re-establishing it, silently killing the bridge while the page stayed alive.
// Module-scope intervals are never cleared by Fast Refresh, and the global guard
// stops an HMR re-import from starting duplicates. DEV-only; stripped in prod.

import { useMachine } from '../store/machine'
import { useCameraCalib } from '../store/cameraCalib'
import { useBed } from '../store/bed'
import { useBedMosaic } from '../store/bedMosaic'
import { useToolMask } from '../store/toolMask'
import { getActiveTab } from '../track/activity'
import { focusTab, openTabs } from '../track/tabNav'

const STATE_PUSH_MS = 600
const CMD_POLL_MS = 400
/** Drop actions older than this (ms) so a stale backlog never fires unexpectedly. */
const CMD_FRESH_MS = 15000

/** Compact view of a camera slot — the calibration fields an agent needs to verify/tune. */
function slotSummary(c: ReturnType<typeof useCameraCalib.getState>['cameras'][number]) {
  return {
    mount: c.mount,
    frameW: c.frameW,
    frameH: c.frameH,
    pxPerMm: c.pxPerMm,
    rotationDeg: c.rotationDeg,
    headRotateQuarters: c.headRotateQuarters,
    headFlipH: c.headFlipH,
    headFlipV: c.headFlipV,
    offsetMm: c.offsetMm,
    distortK: c.distortK,
    headRefMm: c.headRefMm,
    hasH: c.H != null,
    hasHeadMap: c.headMap != null,
    hasHeadHomography: c.headHomography != null,
  }
}

/** Build the snapshot the server reads from /__app_state. */
function snapshot() {
  const m = useMachine.getState()
  const cc = useCameraCalib.getState()
  const bed = useBed.getState()
  const mosaic = useBedMosaic.getState()
  const mask = useToolMask.getState()
  return {
    ts: Date.now(),
    activeTab: getActiveTab(),
    openTabs: openTabs(),
    viewport: { w: window.innerWidth, h: window.innerHeight },
    machine: {
      state: m.state,
      connection: m.connection,
      wpos: m.wpos,
      mpos: m.mpos,
      wco: m.wco,
      feed: m.feed,
      spindle: m.spindle,
    },
    cameras: cc.cameras.map(slotSummary),
    bed: { width: bed.width, depth: bed.depth, height: bed.height, motionAxes: bed.motionAxes },
    mosaic: { enabled: mosaic.enabled, opacity: mosaic.opacity, clearSignal: mosaic.clearSignal },
    toolMask: { enabled: mask.enabled, rect: mask.rect },
    // Diagnostic: the 3D twin capture loop's last status + GL health, so the
    // server can tell rendering apart from context loss. Set in Viewer.tsx.
    viewerDebug: (window as unknown as { __viewerDebug?: unknown }).__viewerDebug ?? null,
    viewerHealth: (window as unknown as { __viewerHealth?: unknown }).__viewerHealth ?? null,
  }
}

interface AppCmd {
  action?: string
  _t?: number
}

function runAction(action: string) {
  if (action === 'reload') {
    // Soft reload — granted Web Serial ports auto-reconnect on load.
    window.location.reload()
    return
  }
  if (action.startsWith('focus:')) {
    focusTab(action.slice('focus:'.length))
    return
  }
  // Everything else is a panel-level action; the owning panel listens for it
  // (Camera calibration, Viewer view/rebuild, mosaic, etc.).
  window.dispatchEvent(new CustomEvent('karmyogi:app', { detail: action }))
}

async function pushState() {
  // NO in-flight guard: a backgrounded tab suspends the fetch AND throttles the
  // abort timer, so a boolean guard would latch true forever and silently kill
  // the loop (while setInterval keeps firing). The camera bridge has no guard and
  // survives backgrounding for exactly this reason — match it. Overlapping POSTs
  // are harmless (last-writer-wins); the 4s timeout cleans up suspended requests.
  try {
    await fetch('/__app_state', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(snapshot()),
      // Self-heal: a backgrounded tab suspends in-flight fetches; without a
      // timeout the awaited promise never settles and the `pushing` guard stays
      // stuck true, permanently stalling this loop. Abort after 4s so the guard
      // always resets and the next tick retries.
      signal: AbortSignal.timeout(4000),
    })
  } catch {
    /* dev-server hiccup / suspended request — retry next tick */
  }
}

async function pollCommands() {
  // No guard (see pushState). Overlapping GETs are safe: the server drains its
  // queue atomically, so a second concurrent GET just gets an empty list.
  try {
    const res = await fetch('/__app_cmd', { method: 'GET', signal: AbortSignal.timeout(4000) })
    if (!res.ok) return
    const data = (await res.json()) as { cmds?: AppCmd[] }
    const cmds = Array.isArray(data.cmds) ? data.cmds : []
    const now = Date.now()
    for (const c of cmds) {
      if (typeof c.action !== 'string') continue
      if (typeof c._t === 'number' && now - c._t > CMD_FRESH_MS) continue
      runAction(c.action)
    }
  } catch {
    /* dev-server hiccup / suspended request — retry next tick */
  }
}

/**
 * Start the bridge loops ONCE per page load. Idempotent + HMR-proof: the running
 * flag lives on `window`, so a Vite HMR re-import of this module finds it already
 * set and does nothing, while the intervals (started here, not in a React effect)
 * keep running across any number of Fast Refresh cycles.
 */
function startDevBridge(): void {
  if (!import.meta.env.DEV || typeof window === 'undefined') return
  const w = window as unknown as { __kmDevBridgeRunning?: boolean }
  if (w.__kmDevBridgeRunning) return
  w.__kmDevBridgeRunning = true
  setInterval(() => void pushState(), STATE_PUSH_MS)
  setInterval(() => void pollCommands(), CMD_POLL_MS)
}

// Kick the loops the moment this module is imported (App imports it).
startDevBridge()

/**
 * No-op-ish hook kept for the call site in App. The real work runs at module
 * scope above; calling this just guarantees the module is imported and the loops
 * are started (idempotent).
 */
export function useDevBridge(): void {
  startDevBridge()
}
