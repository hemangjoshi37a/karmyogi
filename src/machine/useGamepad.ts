import { useCallback, useEffect, useRef, useState } from 'react'
import { getActiveTab, subscribeActiveTab } from '../track/activity'
import { focusTab, openTabs } from '../track/tabNav'
import { tabActionFor } from './gamepadTabActions'
import {
  useGamepadMap,
  padBindings,
  padKeyFor,
  parseToken,
  triggerValue,
  type GamepadActionId,
  type GamepadAnalogId,
  type PadBindings,
  type ControlToken,
} from '../store/gamepadMap'

/**
 * Game-controller (Web Gamepad API) support for the machine Controller.
 *
 * Browser-only: uses `navigator.getGamepads()` and the
 * `gamepadconnected` / `gamepaddisconnected` events. When ENABLED, polls via
 * requestAnimationFrame, applies a deadzone, drives continuous jog from the
 * BOUND stick/trigger axes, and edge-triggers discrete actions from the BOUND
 * buttons-or-axes (fired once per press, not every frame).
 *
 * v2 — works regardless of `gamepad.mapping`. Inputs are read by the operator's
 * per-pad BINDINGS (button index OR axis half OR trigger axis), captured live
 * via the raw-inputs diagnostic, so a non-standard Android-mode HID pad (e.g.
 * SHANWAN 2563:0526, whose triggers are axes and D-pad is a hat) is fully usable.
 *
 * SAFETY: this hook NEVER touches the machine on its own — it only calls the
 * caller-supplied handlers, and the caller gates those on `grbl.isConnected`.
 * It also refuses to act while a modal/dialog is focused (mirroring the
 * keyboard-jog guard in ControllerPanel), and cancels any in-flight jog on
 * disconnect / blur / modal-focus / disable.
 */

/** Pad family for face-button glyphs (mirrors PadFamily in gamepadMap). */
export type GamepadType = 'xbox' | 'playstation' | 'nintendo' | 'generic'

export type RumblePattern = 'alarm' | 'error' | 'connect' | 'idle'

/** Standard-mapping button indices (gamepad.mapping === 'standard'). Reference. */
export const Btn = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8,
  Start: 9,
  L3: 10,
  R3: 11,
  DUp: 12,
  DDown: 13,
  DLeft: 14,
  DRight: 15,
} as const

export type GamepadAction = GamepadActionId

export interface GamepadHandlers {
  /**
   * Continuous combined jog: a single direction-preserving X/Y/Z vector at one
   * vector feed. Issuing all axes in ONE `$J=` is what lets Z and XY move
   * together — GRBL runs one jog at a time, so two separate jogXY/jogZ commands
   * made Z lose the race. `jogXY`/`jogZ` remain for any non-gamepad callers.
   */
  jog3: (dx: number, dy: number, dz: number, feed: number) => void
  jogXY: (dx: number, dy: number, feed: number) => void
  jogZ: (dz: number, feed: number) => void
  cancelJog: () => void
  onAction: (action: GamepadAction) => void
}

export interface GamepadOptions {
  jogFeed: number
  haptics?: boolean
  hapticIntensity?: number
}

/** Parsed identity of a controller from its `id` string. */
export interface GamepadIds {
  family: GamepadType
  vendor: string | null
  product: string | null
  /** True when `gamepad.mapping !== 'standard'` (incl. ''). */
  nonStandard: boolean
}

/** Live raw snapshot of the active pad, for the diagnostic UI. */
export interface RawSnapshot {
  id: string
  mapping: string
  vendor: string | null
  product: string | null
  family: GamepadType
  nonStandard: boolean
  /** Per-button pressed flags. */
  buttons: boolean[]
  /** Per-button analog values (0..1). */
  buttonValues: number[]
  /** Per-axis values (−1..1). */
  axes: number[]
}

export interface GamepadState {
  connected: boolean
  type: GamepadType | null
  id: string | null
  /** Parsed identity of the active pad. */
  ids: GamepadIds | null
  /** Stable per-pad key (vendor:product|btn.axis) for binding persistence. */
  padKey: string
  buttonsPressed: boolean[]
  axes: number[]
  /** Live raw snapshot (null when no pad). Updated every polled frame. */
  raw: RawSnapshot | null
  /**
   * Subscribe to the high-frequency raw snapshot WITHOUT going through React
   * state — lets a consumer (the diagnostic) re-render itself every frame via
   * `useSyncExternalStore` while the rest of the tree (the modal + its native
   * `<select>` dropdowns) stays stable. Returns an unsubscribe fn.
   */
  subscribeRaw: (cb: () => void) => () => void
  /** Current raw snapshot for `useSyncExternalStore`'s getSnapshot. */
  getRawSnapshot: () => RawSnapshot | null
  enabled: boolean
  setEnabled: (v: boolean) => void
  activeTab: string | undefined
  tabNavMode: boolean
  rumble: (pattern: RumblePattern) => void
}

/** Stick deadzone — below this magnitude is treated as centered. Small enough
 * that a gentle push picks up promptly (snappy), large enough to absorb a
 * resting stick's drift on cheap pads so motion never creeps on its own. */
const DEADZONE = 0.12
/** Analog press threshold (axis-half discrete bindings). */
const PRESS_THRESHOLD = 0.5
/**
 * Trigger ON threshold (normalised 0..1) — DELIBERATELY above 0.5.
 *
 * `triggerValue(raw) = (raw+1)/2` assumes a trigger RESTS at raw=−1 (→0). But
 * many pads report an absent/phantom axis as raw=0, which normalises to exactly
 * 0.5 — so a 0.5 threshold reads that phantom axis as permanently half-pressed,
 * firing continuous input / continuous jog with nothing touched. Requiring ≥0.6
 * ignores a 0-resting axis while real triggers (which sweep to ~1.0) still work.
 */
const TRIGGER_ON = 0.6
const JOG_FEED_FLOOR = 30
/**
 * Min interval (ms) between jog RE-ISSUES. This is the dominant knob for how
 * SNAPPY the analog stick feels: it caps how fast a stick change (direction or
 * feed) reaches the machine. Too coarse and motion lags / steps behind the
 * stick; too fine and a fast sweep storms GRBL with cancel+re-issue. ~55 ms
 * (~18 Hz) tracks the stick fluidly while staying well under GRBL's planner /
 * RX-buffer limits (each re-issue is a single `force` jog + one `0x85`). A
 * steady-magnitude hold mostly coasts on its in-flight move and only refreshes
 * lazily (see REFRESH_MS) so we don't thrash a stick the operator isn't moving.
 */
const REISSUE_MIN_MS = 55
/**
 * Lazy refresh interval (ms) for a stick held at a STEADY deflection. The
 * continuous jog is a single finite `$J=` move (distance ≈ continuousJogMm), so
 * a long steady hold would eventually drain it and stutter to a stop. Re-issuing
 * (cancel + fresh jog) a few times a second keeps the move alive seamlessly —
 * GRBL blends the new jog into the running one — without depending on the stick
 * actually moving. Kept long enough that a still stick is mostly coasting.
 */
const REFRESH_MS = 220

/**
 * Stick → feed response. A MILD expo (blend of linear + cubic) keeps the
 * response proportional and lively near center (no quadratic dead band that
 * makes small pushes feel laggy) while still giving fine control at low
 * deflection. `norm` is the post-deadzone magnitude rescaled to 0..1.
 */
function responseCurve(mag: number): number {
  if (mag <= DEADZONE) return 0
  const norm = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE))
  // 70% linear + 30% cubic: ~0.72 of full feed at half-stick (vs 0.5 quad),
  // so a gentle push already moves perceptibly while a hard push still maxes.
  return 0.7 * norm + 0.3 * norm * norm * norm
}

function scaledFeed(response: number, jogFeed: number): number {
  const max = Math.max(JOG_FEED_FLOOR, jogFeed || JOG_FEED_FLOOR)
  return Math.round(JOG_FEED_FLOOR + response * (max - JOG_FEED_FLOOR))
}

function rumblePattern(p: RumblePattern): { duration: number; strong: number; weak: number } {
  switch (p) {
    case 'alarm':
      return { duration: 400, strong: 1.0, weak: 0.8 }
    case 'error':
      return { duration: 90, strong: 0.9, weak: 0.4 }
    case 'connect':
      return { duration: 90, strong: 0.4, weak: 0.4 }
    case 'idle':
      return { duration: 70, strong: 0.2, weak: 0.35 }
  }
}

// ─── classification (vendor/product table + fallbacks) ────────────────────────
/** Parse the 4-hex vendor/product ids out of a Gamepad `id` string. */
export function parseVendorProduct(id: string): { vendor: string | null; product: string | null } {
  const v = /vendor:?\s*([0-9a-f]{1,4})/i.exec(id)
  const p = /product:?\s*([0-9a-f]{1,4})/i.exec(id)
  const pad4 = (s: string) => s.toLowerCase().padStart(4, '0')
  return { vendor: v ? pad4(v[1]) : null, product: p ? pad4(p[1]) : null }
}

/** Vendor id → family. SHANWAN (2563) is treated as XBOX-STYLE per research. */
const VENDOR_FAMILY: Record<string, GamepadType> = {
  '045e': 'xbox', // Microsoft
  '054c': 'playstation', // Sony
  '057e': 'nintendo', // Nintendo
  '2dc8': 'xbox', // 8BitDo (XInput-emulating; Xbox glyphs)
  '3537': 'xbox', // GameSir
  '046d': 'xbox', // Logitech (XInput pads)
  '2563': 'xbox', // SHANWAN — Xbox-look-alike (Android HID)
}

/**
 * Classify a controller into a glyph family from its `id` + `mapping`.
 *
 * Priority: vendor-id table → DualSense/Sony id hints (PlayStation) → Pro
 * Controller / 057e (Nintendo) → XInput/Xbox id hints (Xbox). DEFAULT for an
 * unknown id OR a STANDARD mapping is Xbox-style (≈59% of users), so PlayStation
 * symbols only appear for genuine Sony pads and Nintendo swap only for Nintendo.
 */
export function classifyGamepad(id: string, mapping?: string): GamepadType {
  const { vendor } = parseVendorProduct(id)
  if (vendor && VENDOR_FAMILY[vendor]) return VENDOR_FAMILY[vendor]
  const s = id.toLowerCase()
  if (/dualsense|dualshock|playstation|sony/.test(s)) return 'playstation'
  if (/pro controller|057e/.test(s)) return 'nintendo'
  if (/xinput|xbox/.test(s)) return 'xbox'
  // Unknown id or a standard mapping → Xbox-style default.
  if (mapping === 'standard') return 'xbox'
  return 'xbox'
}

/** Full parsed identity for a pad. */
export function identify(pad: Gamepad): GamepadIds {
  const { vendor, product } = parseVendorProduct(pad.id)
  return {
    family: classifyGamepad(pad.id, pad.mapping),
    vendor,
    product,
    nonStandard: pad.mapping !== 'standard',
  }
}

function nowMs(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()
}

function modalFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return !!el.closest?.('[role="dialog"], .km-modal')
}

/** Safe length helpers for possibly-missing arrays on a degenerate pad. */
function safeButtons(pad: Gamepad): GamepadButton[] {
  return Array.isArray(pad.buttons) ? pad.buttons : []
}
function safeAxes(pad: Gamepad): number[] {
  return Array.isArray(pad.axes) ? Array.from(pad.axes) : []
}

export function useGamepad(
  handlers: GamepadHandlers,
  enabled: boolean,
  options: GamepadOptions,
  onEnabledChange?: (v: boolean) => void,
): GamepadState {
  const [connected, setConnected] = useState(false)
  const [type, setType] = useState<GamepadType | null>(null)
  const [id, setId] = useState<string | null>(null)
  const [ids, setIds] = useState<GamepadIds | null>(null)
  const [padKey, setPadKey] = useState('none')
  const [buttonsPressed, setButtonsPressed] = useState<boolean[]>([])
  const [axes, setAxes] = useState<number[]>([])
  const [tabNavMode, setTabNavMode] = useState(false)
  const tabNavRef = useRef(false)

  // ── High-frequency RAW snapshot: kept OUT of React state ──────────────────
  // The raw snapshot updates every animation frame. If it lived in React state,
  // every frame would re-render the modal subtree and tear down any open native
  // `<select>` popup. Instead we keep it in a ref and notify subscribers, who
  // re-render themselves in isolation via `useSyncExternalStore`. The modal
  // render stays stable; only the diagnostic's bars update.
  const rawRef = useRef<RawSnapshot | null>(null)
  const rawSubs = useRef<Set<() => void>>(new Set())
  const setRaw = useCallback((snap: RawSnapshot | null) => {
    rawRef.current = snap
    for (const cb of rawSubs.current) cb()
  }, [])
  const subscribeRaw = useCallback((cb: () => void) => {
    rawSubs.current.add(cb)
    return () => {
      rawSubs.current.delete(cb)
    }
  }, [])
  const getRawSnapshot = useCallback(() => rawRef.current, [])

  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const optionsRef = useRef(options)
  optionsRef.current = options
  const onEnabledChangeRef = useRef(onEnabledChange)
  onEnabledChangeRef.current = onEnabledChange

  const activeTabRef = useRef<string | undefined>(getActiveTab())
  const [activeTab, setActiveTabState] = useState<string | undefined>(() => getActiveTab())
  useEffect(() => {
    const cur = getActiveTab()
    activeTabRef.current = cur
    setActiveTabState(cur)
    return subscribeActiveTab((tab) => {
      activeTabRef.current = tab
      setActiveTabState(tab)
    })
  }, [])

  // Live per-pad bindings + per-tab overrides, mirrored into refs so the rAF loop
  // reads the LIVE bindings every frame without restarting on a rebind. The
  // bindings are resolved for the ACTIVE pad key (which the loop also tracks).
  const padKeyRef = useRef('none')
  padKeyRef.current = padKey
  const bindingsRef = useRef<PadBindings>(padBindings(useGamepadMap.getState(), padKey))
  const tabOverridesRef = useRef<Record<string, Record<string, GamepadActionId>>>({})
  const refreshBindings = useCallback(() => {
    const s = useGamepadMap.getState()
    bindingsRef.current = padBindings(s, padKeyRef.current)
    tabOverridesRef.current = s.tabOverrides[padKeyRef.current] ?? {}
  }, [])
  useEffect(() => {
    refreshBindings()
    return useGamepadMap.subscribe(refreshBindings)
  }, [refreshBindings])
  // Re-resolve bindings whenever the active pad changes.
  useEffect(() => {
    refreshBindings()
  }, [padKey, refreshBindings])

  const padIndex = useRef<number | null>(null)
  const rafId = useRef<number | null>(null)
  const prevPressed = useRef<boolean[]>([])
  // Previous-frame deflection of each axis-token (for axis edge detection).
  const prevAxisDefl = useRef<Map<ControlToken, boolean>>(new Map())
  const jogActive = useRef(false)
  // The last commanded jog VECTOR (per-axis amplitude, direction-preserving) plus
  // its single vector feed. One combined `$J=` covers all three axes at once, so
  // XY and Z never fight over GRBL's single jog slot (the old split jogXY+jogZ
  // issued two competing moves and Z routinely lost — see jog issuance below).
  const lastJog = useRef<{ x: number; y: number; z: number; feed: number }>({
    x: 0,
    y: 0,
    z: 0,
    feed: 0,
  })
  const lastReissueAt = useRef(0)

  const setEnabled = useCallback((v: boolean) => onEnabledChangeRef.current?.(v), [])

  const rumble = useCallback((pattern: RumblePattern) => {
    const opt = optionsRef.current
    if (!opt.haptics) return
    const idx = padIndex.current
    const pads = navigator.getGamepads ? navigator.getGamepads() : []
    const pad = (idx != null ? pads[idx] : Array.from(pads).find((p) => !!p)) ?? null
    if (!pad) return
    const { duration, strong, weak } = rumblePattern(pattern)
    const scale = Math.max(0, Math.min(1, opt.hapticIntensity ?? 1))
    const strongMagnitude = Math.max(0, Math.min(1, strong * scale))
    const weakMagnitude = Math.max(0, Math.min(1, weak * scale))
    try {
      const actuator = (pad as Gamepad & {
        vibrationActuator?: {
          playEffect?: (
            type: string,
            params: { duration: number; strongMagnitude: number; weakMagnitude: number; startDelay?: number },
          ) => Promise<unknown>
        }
      }).vibrationActuator
      if (actuator?.playEffect) {
        void actuator.playEffect('dual-rumble', { duration, strongMagnitude, weakMagnitude }).catch(() => {})
        return
      }
      const legacy = (pad as Gamepad & {
        hapticActuators?: Array<{ pulse?: (value: number, duration: number) => Promise<unknown> }>
      }).hapticActuators
      const act = legacy?.[0]
      if (act?.pulse) void act.pulse(Math.max(strongMagnitude, weakMagnitude), duration).catch(() => {})
    } catch {
      /* some browsers throw synchronously if the API shape is off — swallow it */
    }
  }, [])

  // Adopt a pad (connection / refresh): set identity + the per-pad key, and
  // ENSURE a binding entry exists for it (seeded from its built-in default).
  const adopt = useCallback((pad: Gamepad | null) => {
    if (!pad) {
      padIndex.current = null
      setConnected(false)
      setType(null)
      setId(null)
      setIds(null)
      setPadKey('none')
      setRaw(null)
      return
    }
    padIndex.current = pad.index
    const idObj = identify(pad)
    const key = padKeyFor({
      vendor: idObj.vendor,
      product: idObj.product,
      buttons: safeButtons(pad).length,
      axes: safeAxes(pad).length,
    })
    setConnected(true)
    setType(idObj.family)
    setId(pad.id)
    setIds(idObj)
    setPadKey(key)
    // Seed a binding entry so the diagnostic + rebind UI have something to show.
    useGamepadMap.getState().ensurePad(key)
  }, [])

  useEffect(() => {
    const refresh = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const found = Array.from(pads).find((p): p is Gamepad => !!p) ?? null
      adopt(found)
    }
    const onConnect = (e: GamepadEvent) => adopt(e.gamepad)
    const onDisconnect = () => refresh()
    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    refresh()
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [adopt])

  // RAW-MIRROR loop — runs whenever a pad is CONNECTED, INDEPENDENT of `enabled`
  // and of the machine connection. It only MIRRORS the live pad into React state
  // (raw snapshot + pressed flags + axes) for the diagnostic + the rebind UI; it
  // NEVER drives the machine. This is what lets the operator open the modal and
  // bind their controls (incl. ML/MR / triggers) BEFORE arming or connecting a
  // machine. When the machine-driving loop below is active it also mirrors, so we
  // suspend this one while `enabled` to avoid two setState callers per frame.
  const mirrorRaf = useRef<number | null>(null)
  useEffect(() => {
    if (!connected || enabled) {
      if (mirrorRaf.current != null) {
        cancelAnimationFrame(mirrorRaf.current)
        mirrorRaf.current = null
      }
      return
    }
    let alive = true
    const tick = () => {
      if (!alive) return
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const idx = padIndex.current
      const pad = (idx != null ? pads[idx] : Array.from(pads).find((p) => !!p)) ?? null
      if (pad) {
        const btns = safeButtons(pad)
        const ax = safeAxes(pad)
        const pressedNow = btns.map((b) => !!b && (b.pressed || (b.value ?? 0) > PRESS_THRESHOLD))
        const btnVals = btns.map((b) => (b && Number.isFinite(b.value) ? b.value : 0))
        const idObj = identify(pad)
        setButtonsPressed(pressedNow)
        setAxes(ax)
        setRaw({
          id: pad.id,
          mapping: pad.mapping ?? '',
          vendor: idObj.vendor,
          product: idObj.product,
          family: idObj.family,
          nonStandard: idObj.nonStandard,
          buttons: pressedNow,
          buttonValues: btnVals,
          axes: ax,
        })
      }
      mirrorRaf.current = requestAnimationFrame(tick)
    }
    mirrorRaf.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (mirrorRaf.current != null) {
        cancelAnimationFrame(mirrorRaf.current)
        mirrorRaf.current = null
      }
    }
  }, [connected, enabled])

  // Poll loop — runs ONLY while enabled. Reads the live pad each frame.
  useEffect(() => {
    if (!enabled) {
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      if (jogActive.current) {
        handlersRef.current.cancelJog()
        jogActive.current = false
      }
      lastJog.current = { x: 0, y: 0, z: 0, feed: 0 }
      prevPressed.current = []
      setButtonsPressed([])
      setAxes([])
      setRaw(null)
      if (tabNavRef.current) {
        tabNavRef.current = false
        setTabNavMode(false)
      }
      return
    }

    let alive = true

    const cancelIfMoving = () => {
      if (jogActive.current) {
        handlersRef.current.cancelJog()
        jogActive.current = false
        lastJog.current = { x: 0, y: 0, z: 0, feed: 0 }
      }
    }

    const tick = () => {
      if (!alive) return
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const idx = padIndex.current
      const pad = (idx != null ? pads[idx] : Array.from(pads).find((p) => !!p)) ?? null

      if (!pad) {
        // Pad vanished mid-loop (unplug). Make sure no jog is stranded.
        cancelIfMoving()
        rafId.current = requestAnimationFrame(tick)
        return
      }

      const btns = safeButtons(pad)
      const ax = safeAxes(pad)
      // Pressed flags + analog values, defensive against odd shapes.
      const pressedNow: boolean[] = btns.map((b) => !!b && (b.pressed || (b.value ?? 0) > PRESS_THRESHOLD))
      const btnVals: number[] = btns.map((b) => (b && Number.isFinite(b.value) ? b.value : 0))
      setButtonsPressed(pressedNow)
      setAxes(ax)
      const idObj = identify(pad)
      setRaw({
        id: pad.id,
        mapping: pad.mapping ?? '',
        vendor: idObj.vendor,
        product: idObj.product,
        family: idObj.family,
        nonStandard: idObj.nonStandard,
        buttons: pressedNow,
        buttonValues: btnVals,
        axes: ax,
      })

      // SAFETY: while a modal/dialog has focus, don't drive the machine.
      if (modalFocused()) {
        cancelIfMoving()
        prevPressed.current = pressedNow
        rafId.current = requestAnimationFrame(tick)
        return
      }

      const binds = bindingsRef.current
      const prev = prevPressed.current

      // Edge of a control TOKEN (button OR axis half / trigger). For axis tokens
      // we compare the current vs previous DEFLECTED state to derive an edge.
      const tokenState = (tok: ControlToken): boolean => {
        const p = parseToken(tok)
        if (!p) return false
        if (p.kind === 'button') return pressedNow[p.index] ?? false
        const v = ax[p.index]
        if (typeof v !== 'number' || !Number.isFinite(v)) return false
        if (p.trigger) return triggerValue(v) >= TRIGGER_ON
        return p.dir > 0 ? v > PRESS_THRESHOLD : v < -PRESS_THRESHOLD
      }
      // Previous-frame deflection for an axis token (buttons use prevPressed).
      const tokenWasOn = (tok: ControlToken): boolean => {
        const p = parseToken(tok)
        if (!p) return false
        if (p.kind === 'button') return prev[p.index] ?? false
        return prevAxisDefl.current.get(tok) ?? false
      }
      const tokenEdge = (tok: ControlToken): boolean => tokenState(tok) && !tokenWasOn(tok)

      // --- TAB NAVIGATION mode ---
      {
        if (tokenEdge(binds.actions.tabNav)) {
          tabNavRef.current = !tabNavRef.current
          setTabNavMode(tabNavRef.current)
          if (tabNavRef.current) cancelIfMoving()
        }
        if (tabNavRef.current) {
          cancelIfMoving()
          const tabs = openTabs()
          if (tabs.length > 0) {
            let dir = 0
            if (tokenEdge(binds.actions.stepJogXPlus) || tokenEdge(binds.actions.stepUp)) dir = 1
            else if (tokenEdge(binds.actions.stepJogXMinus) || tokenEdge(binds.actions.stepDown)) dir = -1
            if (dir !== 0) {
              let i = tabs.indexOf(activeTabRef.current ?? '')
              if (i < 0) i = 0
              focusTab(tabs[(i + dir + tabs.length) % tabs.length])
            }
          }
          if (tokenEdge(binds.actions.resume) || tokenEdge(binds.actions.hold)) {
            tabNavRef.current = false
            setTabNavMode(false)
          }
          rememberAxisDefl(binds, ax, prevAxisDefl.current)
          prevPressed.current = pressedNow
          rafId.current = requestAnimationFrame(tick)
          return
        }
      }

      // --- Analog proportional jog from the BOUND jog axes ---
      // Each direction reads its bound axis-half / trigger; opposing halves
      // subtract so a single bipolar stick axis works AND split bindings work.
      const jogComp = (plus: GamepadAnalogId, minus: GamepadAnalogId): number => {
        const p = axisMagnitude(binds.analog[plus], ax)
        const m = axisMagnitude(binds.analog[minus], ax)
        return p - m
      }
      const rawX = jogComp('jogXplus', 'jogXminus')
      const rawY = jogComp('jogYplus', 'jogYminus')
      const rawZ = jogComp('jogZplus', 'jogZminus')

      // Deadzone XY (as a unit) and Z SEPARATELY — so a little resting drift on
      // the XY stick can never bleed a stray X/Y component into a pure Z jog (and
      // vice versa). Each surviving group contributes its response amplitude to a
      // SINGLE combined vector; the vector feed is the dominant group's feed.
      const xyMag = Math.hypot(rawX, rawY)
      let nx = 0
      let ny = 0
      let xyResp = 0
      if (Number.isFinite(xyMag) && xyMag > DEADZONE) {
        nx = rawX / xyMag
        ny = rawY / xyMag
        xyResp = responseCurve(Math.min(1, xyMag))
      }
      const zMag = Math.abs(rawZ)
      let zResp = 0
      if (Number.isFinite(zMag) && zMag > DEADZONE) {
        zResp = responseCurve(Math.min(1, zMag))
      }
      // Combined jog vector: each axis component carries its group's amplitude so
      // `doJogHold` (which scales the LARGEST component to the configured
      // continuous distance) preserves the true 3D direction — push Z harder than
      // XY and you travel proportionally more in Z. The feed is the stronger
      // group's, so speed always tracks whichever stick is pushed hardest.
      let vx = nx * xyResp
      let vy = ny * xyResp
      let vz = Math.sign(rawZ) * zResp
      let feed = Math.max(xyResp, zResp) > 0 ? scaledFeed(Math.max(xyResp, zResp), optionsRef.current.jogFeed) : 0
      // NaN guard: never let a bad axis value reach GRBL.
      if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vz) || !Number.isFinite(feed)) {
        vx = vy = vz = feed = 0
      }

      const moving = feed > 0
      // SNAPPY continuous jog that tracks the stick. The hook commands a single
      // finite combined `$J=` move (X+Y+Z in ONE command) and keeps it current by
      // cancelling (0x85, instant — no waiting for it to drain) + re-issuing
      // whenever the commanded vector or feed changes meaningfully, throttled to
      // REISSUE_MIN_MS so a fast sweep can't storm GRBL. A stick held STEADY is
      // also refreshed lazily (REFRESH_MS) so the finite move never drains out
      // from under a long hold. Centering cancels immediately for a crisp stop.
      //
      // Thresholds are SMALL so the response feels proportional: a little more
      // push / a little rotation reaches the machine on the next ~55 ms tick
      // instead of waiting to cross a big dead band. Feed hysteresis is a small
      // fraction of max feed (with a low floor) so speed tracks the stick.
      const now = nowMs()
      const feedHyst = Math.max(8, (optionsRef.current.jogFeed || 1000) * 0.02)
      const vecChanged =
        Math.abs(vx - lastJog.current.x) > 0.02 ||
        Math.abs(vy - lastJog.current.y) > 0.02 ||
        Math.abs(vz - lastJog.current.z) > 0.02 ||
        Math.abs(feed - lastJog.current.feed) > feedHyst
      // A steady hold still needs an occasional refresh so the finite jog move
      // doesn't run dry and stutter to a stop on a long deflection.
      const stale = now - lastReissueAt.current >= REFRESH_MS
      if (moving) {
        if (!jogActive.current) {
          // First deflection → start the combined continuous move.
          handlersRef.current.jog3(vx, vy, vz, feed)
          jogActive.current = true
          lastJog.current = { x: vx, y: vy, z: vz, feed }
          lastReissueAt.current = now
        } else if ((vecChanged && now - lastReissueAt.current >= REISSUE_MIN_MS) || stale) {
          // Stick moved (or the move went stale) → flush the running move (0x85)
          // and re-issue the whole vector immediately in the current direction/speed.
          handlersRef.current.cancelJog()
          handlersRef.current.jog3(vx, vy, vz, feed)
          lastJog.current = { x: vx, y: vy, z: vz, feed }
          lastReissueAt.current = now
        }
        // else: steady hold within the refresh window → coast on the in-flight move.
      } else if (jogActive.current) {
        // Stick returned to center → cancel the continuous move (0x85).
        handlersRef.current.cancelJog()
        jogActive.current = false
        lastJog.current = { x: 0, y: 0, z: 0, feed: 0 }
      }

      // --- Edge-triggered discrete actions (fire once per press) ---
      const tab = activeTabRef.current
      const overrides = tabOverridesRef.current[tab ?? ''] as Record<string, string> | undefined
      // Iterate the bound action tokens, fire on a rising edge. A control bound to
      // a jog axis is NOT also a discrete action (uniqueness in the store), so we
      // never double-fire. Tab overrides (keyed by token) win over the global map.
      for (const actId of Object.keys(binds.actions) as GamepadActionId[]) {
        const tok = binds.actions[actId]
        if (!tok) continue
        if (!tokenEdge(tok)) continue
        // tabNav handled above; never reaches here while tab-nav is active.
        if (actId === 'tabNav') continue
        const ctx = tabActionFor(tab, tok, overrides)
        if (ctx) {
          try {
            ctx.run()
          } catch {
            /* a context action throwing must not break the gamepad loop */
          }
          continue
        }
        handlersRef.current.onAction(actId)
      }
      // ALSO honour a per-tab override on a control that has NO global action
      // bound (so a tab can use a free button). Token edges already computed.
      if (overrides) {
        for (const tok of Object.keys(overrides)) {
          // Skip tokens that already mapped to a bound global action above.
          if ((Object.values(binds.actions) as string[]).includes(tok)) continue
          if (!tokenEdge(tok)) continue
          const ctx = tabActionFor(tab, tok, overrides)
          if (ctx) {
            try {
              ctx.run()
            } catch {
              /* ignore */
            }
          }
        }
      }

      rememberAxisDefl(binds, ax, prevAxisDefl.current)
      prevPressed.current = pressedNow
      rafId.current = requestAnimationFrame(tick)
    }

    // Reset per-token axis deflection memory each time the loop (re)starts.
    prevAxisDefl.current = new Map<ControlToken, boolean>()

    rafId.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      if (jogActive.current) {
        handlersRef.current.cancelJog()
        jogActive.current = false
      }
      lastJog.current = { x: 0, y: 0, z: 0, feed: 0 }
      prevPressed.current = []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled])

  return {
    connected,
    type,
    id,
    ids,
    padKey,
    buttonsPressed,
    axes,
    raw: rawRef.current,
    subscribeRaw,
    getRawSnapshot,
    enabled,
    setEnabled,
    activeTab,
    tabNavMode,
    rumble,
  }
}

/**
 * Signed magnitude of an axis-half / trigger token from the live axes (0..1 for
 * the bound direction; 0 otherwise). Used to build the jog vector from whatever
 * axes the operator bound, regardless of standard mapping.
 */
function axisMagnitude(tok: ControlToken, axes: ReadonlyArray<number>): number {
  const p = parseToken(tok)
  if (!p || p.kind !== 'axis') return 0
  const raw = axes[p.index]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  // A trigger axis rests at -1 → triggerValue maps it to 0..1 (0 when released).
  // Deadzone below TRIGGER_ON and rescale, so a phantom 0-resting axis (→0.5)
  // contributes ZERO jog instead of a permanent half-speed move, while a real
  // trigger still reaches full magnitude. (See TRIGGER_ON.)
  if (p.trigger) {
    const tv = triggerValue(raw)
    return tv <= TRIGGER_ON ? 0 : (tv - TRIGGER_ON) / (1 - TRIGGER_ON)
  }
  // A bipolar stick axis rests at 0; only the bound half contributes (0..1). A
  // released stick reads ~0 (the deadzone, applied to the vector, absorbs drift),
  // so the jog stops on release.
  if (p.dir > 0) return raw > 0 ? Math.min(1, raw) : 0
  return raw < 0 ? Math.min(1, -raw) : 0
}

/** Snapshot the deflection of every axis token used by a pad's bindings. */
function rememberAxisDefl(binds: PadBindings, axes: ReadonlyArray<number>, m: Map<ControlToken, boolean>): void {
  const note = (tok: ControlToken) => {
    const p = parseToken(tok)
    if (!p || p.kind !== 'axis') return
    const v = axes[p.index]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      m.set(tok, false)
      return
    }
    if (p.trigger) {
      m.set(tok, triggerValue(v) >= TRIGGER_ON)
      return
    }
    m.set(tok, p.dir > 0 ? v > PRESS_THRESHOLD : v < -PRESS_THRESHOLD)
  }
  for (const t of Object.values(binds.actions)) if (t) note(t)
}
