import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Game-controller (Web Gamepad API) support for the machine Controller.
 *
 * Browser-only: uses `navigator.getGamepads()` and the
 * `gamepadconnected` / `gamepaddisconnected` events. When ENABLED, polls via
 * requestAnimationFrame, applies a deadzone to the sticks, drives continuous
 * jog from stick deflection, and edge-triggers discrete actions from the
 * face/dpad/bumper/menu buttons (fired once per press, not every frame).
 *
 * SAFETY: this hook NEVER touches the machine on its own — it only calls the
 * caller-supplied handlers, and the caller gates those on `grbl.isConnected`.
 * It also refuses to act while a modal/dialog is focused (mirroring the
 * keyboard-jog guard in ControllerPanel).
 */

export type GamepadType = 'xbox' | 'playstation' | 'switch' | '8bitdo' | 'generic'

/**
 * Haptic-feedback patterns the controller can play. Driven off MACHINE-STATE
 * TRANSITIONS by the caller (not per-frame). Each maps to a `dual-rumble`
 * effect; see `rumblePattern`.
 */
export type RumblePattern =
  | 'alarm' // entered Alarm / limit → strong sustained rumble
  | 'error' // error / soft-reset → sharp double pulse
  | 'connect' // controller connected → short single tick
  | 'idle' // job/probe complete / Run→Idle → short soft tick

/** Standard-mapping button indices (gamepad.mapping === 'standard'). */
export const Btn = {
  A: 0, // A / ✕
  B: 1, // B / ●
  X: 2, // X / ■
  Y: 3, // Y / ▲
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  Back: 8, // Back / Share
  Start: 9, // Start / Options
  L3: 10,
  R3: 11,
  DUp: 12,
  DDown: 13,
  DLeft: 14,
  DRight: 15,
} as const

/** Logical, controller-agnostic action ids emitted by `onAction`. */
export type GamepadAction =
  | 'resume' // A / ✕  → cycle start / resume (~)
  | 'hold' // B / ●  → feed hold (!)
  | 'spindle' // X / ■  → spindle toggle
  | 'home' // Y / ▲  → home ($H)
  | 'unlock' // Back / Share → unlock ($X)
  | 'reset' // Start / Options → soft reset (Ctrl-X)
  | 'stepDown' // LB → smaller jog step
  | 'stepUp' // RB → larger jog step
  | 'stepJogXPlus' // D-pad right
  | 'stepJogXMinus' // D-pad left
  | 'stepJogYPlus' // D-pad up
  | 'stepJogYMinus' // D-pad down

/** Maps a standard-mapping button index to its discrete action, if any. */
const BUTTON_ACTION: Partial<Record<number, GamepadAction>> = {
  [Btn.A]: 'resume',
  [Btn.B]: 'hold',
  [Btn.X]: 'spindle',
  [Btn.Y]: 'home',
  [Btn.Back]: 'unlock',
  [Btn.Start]: 'reset',
  [Btn.LB]: 'stepDown',
  [Btn.RB]: 'stepUp',
  [Btn.DRight]: 'stepJogXPlus',
  [Btn.DLeft]: 'stepJogXMinus',
  [Btn.DUp]: 'stepJogYPlus',
  [Btn.DDown]: 'stepJogYMinus',
}

export interface GamepadHandlers {
  /**
   * Start/continue a continuous jog in XY. `dx,dy` is the normalized stick
   * VECTOR (so motion follows the stick angle — true diagonals), and `feed` is
   * the magnitude-scaled jog feed (mm/min) the caller should run this move at.
   */
  jogXY: (dx: number, dy: number, feed: number) => void
  /**
   * Start/continue a continuous jog in Z. `dz` is the signed direction and
   * `feed` is the magnitude-scaled jog feed (mm/min).
   */
  jogZ: (dz: number, feed: number) => void
  /** Cancel any in-progress analog (stick/trigger) jog. */
  cancelJog: () => void
  /** Fire a discrete action (edge-triggered, once per press). */
  onAction: (action: GamepadAction) => void
}

/** Tuning for analog proportional jog + haptics, owned by the caller. */
export interface GamepadOptions {
  /**
   * Max jog feed (mm/min) — full stick deflection maps to this. Mirrors the
   * Controller's configured `jogFeed` so the pad and on-screen jog agree.
   */
  jogFeed: number
  /** Whether to play haptic (rumble) feedback when supported. */
  haptics?: boolean
  /** Rumble intensity scale, 0..1 (default 1). */
  hapticIntensity?: number
}

export interface GamepadState {
  connected: boolean
  type: GamepadType | null
  id: string | null
  /** Live per-button pressed flags (for the modal's highlight). */
  buttonsPressed: boolean[]
  /** Live axes values (for the modal's stick deflection display). */
  axes: number[]
  enabled: boolean
  setEnabled: (v: boolean) => void
  /**
   * Play a haptic feedback pattern on the active pad (feature-detected; a no-op
   * when unsupported or disabled). Call this from the caller on machine-state
   * TRANSITIONS — not every frame.
   */
  rumble: (pattern: RumblePattern) => void
}

/** Stick/trigger deadzone — below this magnitude is treated as centered. */
const DEADZONE = 0.15
/** Trigger press threshold (analog triggers report 0..1 on buttons 6/7). */
const TRIGGER_THRESHOLD = 0.4
/**
 * Floor for magnitude-scaled jog feed (mm/min): the slowest creep just past the
 * deadzone. Full deflection scales up to the caller's configured `jogFeed`.
 */
const JOG_FEED_FLOOR = 30

/**
 * Map a post-deadzone stick magnitude (0..1) to a 0..1 response with a SQUARED
 * curve so small deflections give fine, slow control near center and the feed
 * only ramps toward max near the rim. The magnitude is first re-normalized so
 * the response starts at 0 right at the deadzone edge (no jump).
 */
function responseCurve(mag: number): number {
  if (mag <= DEADZONE) return 0
  const norm = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE))
  return norm * norm
}

/** Scale jog feed between the floor and `jogFeed` from a 0..1 response value. */
function scaledFeed(response: number, jogFeed: number): number {
  const max = Math.max(JOG_FEED_FLOOR, jogFeed || JOG_FEED_FLOOR)
  return Math.round(JOG_FEED_FLOOR + response * (max - JOG_FEED_FLOOR))
}

/** dual-rumble effect parameters per pattern (magnitudes 0..1, duration ms). */
function rumblePattern(p: RumblePattern): { duration: number; strong: number; weak: number } {
  switch (p) {
    case 'alarm':
      return { duration: 400, strong: 1.0, weak: 0.8 }
    case 'error':
      // A sharp double pulse is approximated with one short, strong burst (the
      // caller may fire 'error' twice in quick succession for the double feel).
      return { duration: 90, strong: 0.9, weak: 0.4 }
    case 'connect':
      return { duration: 90, strong: 0.4, weak: 0.4 }
    case 'idle':
      return { duration: 70, strong: 0.2, weak: 0.35 }
  }
}

/** Classify a controller from its `id` string (USB/BT/dongle all look alike). */
export function classifyGamepad(id: string): GamepadType {
  const s = id.toLowerCase()
  // Xbox Series / One / 360 + generic XInput (045e = Microsoft vendor).
  if (/xbox|xinput|045e|02ea|0b12|0b13/.test(s)) return 'xbox'
  // PlayStation: DualSense (0ce6) + DualShock4 (09cc/05c4) + Sony (054c).
  if (/playstation|dualshock|dualsense|sony|054c|0ce6|09cc|05c4/.test(s)) return 'playstation'
  // Nintendo Switch Pro controller (057e = Nintendo vendor, 2009 = Pro pad).
  if (/switch|pro controller|057e|2009/.test(s)) return 'switch'
  // 8BitDo pads (2dc8 = 8BitDo vendor) — often emulate Switch/XInput.
  if (/8bitdo|2dc8/.test(s)) return '8bitdo'
  return 'generic'
}

/** True when keyboard/gamepad focus is inside an open modal/dialog. */
function modalFocused(): boolean {
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  return !!el.closest?.('[role="dialog"], .km-modal')
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
  const [buttonsPressed, setButtonsPressed] = useState<boolean[]>([])
  const [axes, setAxes] = useState<number[]>([])

  // Keep handlers in a ref so the rAF loop always calls the latest closures
  // without restarting the loop (which would reset edge/jog tracking).
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const optionsRef = useRef(options)
  optionsRef.current = options
  const onEnabledChangeRef = useRef(onEnabledChange)
  onEnabledChangeRef.current = onEnabledChange

  // Index of the active gamepad (the most recently connected one).
  const padIndex = useRef<number | null>(null)
  const rafId = useRef<number | null>(null)
  // Edge-detection: previous frame's pressed state, per button index.
  const prevPressed = useRef<boolean[]>([])
  // Whether an analog (stick/trigger) jog is currently in flight (needs cancel).
  const jogActive = useRef(false)
  // Last issued analog jog — normalized vector + scaled feed; only re-issue when
  // direction OR feed changes meaningfully (hysteresis) so GRBL isn't flooded.
  const lastJog = useRef<{ x: number; y: number; z: number; feedXY: number; feedZ: number }>({
    x: 0,
    y: 0,
    z: 0,
    feedXY: 0,
    feedZ: 0,
  })

  // `enabled` is owned by the caller (so it can be persisted and combined with
  // machine-connected state). The exposed setter just reports the desired value
  // back up; the poll loop reacts to the prop.
  const setEnabled = useCallback((v: boolean) => onEnabledChangeRef.current?.(v), [])

  // Haptics: play a `dual-rumble` effect on the active pad. Feature-detected and
  // a graceful no-op when the actuator API (or the older hapticActuators array)
  // is missing, or when haptics are disabled. Never throws.
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
      // Standard path: GamepadHapticActuator.playEffect('dual-rumble', …).
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
      // Legacy fallback: hapticActuators[].pulse(value, duration) (older Chrome).
      const legacy = (pad as Gamepad & {
        hapticActuators?: Array<{ pulse?: (value: number, duration: number) => Promise<unknown> }>
      }).hapticActuators
      const act = legacy?.[0]
      if (act?.pulse) void act.pulse(Math.max(strongMagnitude, weakMagnitude), duration).catch(() => {})
    } catch {
      // Some browsers throw synchronously if the API shape is off — swallow it.
    }
  }, [])

  // Detect (dis)connection. We keep `connected` true while ANY pad is present.
  useEffect(() => {
    const refresh = () => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const found = Array.from(pads).find((p): p is Gamepad => !!p) ?? null
      if (found) {
        padIndex.current = found.index
        setConnected(true)
        setType(classifyGamepad(found.id))
        setId(found.id)
      } else {
        padIndex.current = null
        setConnected(false)
        setType(null)
        setId(null)
      }
    }

    const onConnect = (e: GamepadEvent) => {
      padIndex.current = e.gamepad.index
      setConnected(true)
      setType(classifyGamepad(e.gamepad.id))
      setId(e.gamepad.id)
    }
    const onDisconnect = () => {
      // Re-scan: another pad may still be attached.
      refresh()
    }

    window.addEventListener('gamepadconnected', onConnect)
    window.addEventListener('gamepaddisconnected', onDisconnect)
    // Some browsers only surface pads after a button press; probe once.
    refresh()
    return () => {
      window.removeEventListener('gamepadconnected', onConnect)
      window.removeEventListener('gamepaddisconnected', onDisconnect)
    }
  }, [])

  // Poll loop — runs ONLY while enabled. Reads the live pad each frame.
  useEffect(() => {
    if (!enabled) {
      // Disabled: stop the loop, drop any in-flight jog, clear live state.
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      if (jogActive.current) {
        handlersRef.current.cancelJog()
        jogActive.current = false
      }
      lastJog.current = { x: 0, y: 0, z: 0, feedXY: 0, feedZ: 0 }
      prevPressed.current = []
      setButtonsPressed([])
      setAxes([])
      return
    }

    let alive = true

    const tick = () => {
      if (!alive) return
      const pads = navigator.getGamepads ? navigator.getGamepads() : []
      const idx = padIndex.current
      const pad = idx != null ? pads[idx] : Array.from(pads).find((p) => !!p) ?? null

      if (!pad) {
        rafId.current = requestAnimationFrame(tick)
        return
      }

      // Mirror live state into React for the modal's visualizer (cheap arrays).
      const pressedNow = pad.buttons.map((b) => b.pressed || b.value > TRIGGER_THRESHOLD)
      setButtonsPressed(pressedNow)
      setAxes(Array.from(pad.axes))

      // SAFETY: while a modal/dialog has focus, don't drive the machine. Cancel
      // any analog jog so motion can't survive opening a dialog, and skip input.
      if (modalFocused()) {
        if (jogActive.current) {
          handlersRef.current.cancelJog()
          jogActive.current = false
          lastJog.current = { x: 0, y: 0, z: 0, feedXY: 0, feedZ: 0 }
        }
        prevPressed.current = pressedNow
        rafId.current = requestAnimationFrame(tick)
        return
      }

      // --- Analog proportional jog from sticks / triggers ---
      // Left stick → 2D XY VECTOR. We jog along the stick angle (true diagonals)
      // and scale the FEED by the stick MAGNITUDE (squared curve → fine near
      // center, max near the rim). Re-issue only when direction OR feed changes
      // meaningfully (hysteresis) so we don't flood GRBL.
      const ax = pad.axes
      const rawX = ax[0] ?? 0
      // Screen/machine Y is inverted vs. the axis: stick up (negative) = +Y.
      const rawY = -(ax[1] ?? 0)
      const xyMag = Math.hypot(rawX, rawY)
      let nx = 0
      let ny = 0
      let feedXY = 0
      if (xyMag > DEADZONE) {
        // Normalize the vector for direction; clamp magnitude for the curve.
        nx = rawX / xyMag
        ny = rawY / xyMag
        feedXY = scaledFeed(responseCurve(Math.min(1, xyMag)), optionsRef.current.jogFeed)
      }

      // Z: prefer right-stick-Y (axis 3); fall back to triggers (LT down, RT up).
      let rawZ = -(ax[3] ?? 0)
      if (Math.abs(rawZ) <= DEADZONE) {
        const lt = pad.buttons[Btn.LT]?.value ?? 0
        const rt = pad.buttons[Btn.RT]?.value ?? 0
        const ltA = lt > TRIGGER_THRESHOLD ? lt : 0
        const rtA = rt > TRIGGER_THRESHOLD ? rt : 0
        rawZ = rtA - ltA
      }
      const zMag = Math.abs(rawZ)
      let dz = 0
      let feedZ = 0
      if (zMag > DEADZONE) {
        dz = Math.sign(rawZ)
        feedZ = scaledFeed(responseCurve(Math.min(1, zMag)), optionsRef.current.jogFeed)
      }

      const movingXY = feedXY > 0
      const movingZ = feedZ > 0
      const moving = movingXY || movingZ
      // Hysteresis: direction shift > ~0.05 in either component, or feed shift
      // > ~5% of max, counts as a meaningful change worth re-issuing.
      const feedHyst = Math.max(20, (optionsRef.current.jogFeed || 1000) * 0.05)
      const xyChanged =
        Math.abs(nx - lastJog.current.x) > 0.05 ||
        Math.abs(ny - lastJog.current.y) > 0.05 ||
        Math.abs(feedXY - lastJog.current.feedXY) > feedHyst
      const zChanged =
        Math.abs(dz - lastJog.current.z) > 0.05 ||
        Math.abs(feedZ - lastJog.current.feedZ) > feedHyst

      if (moving) {
        if (!jogActive.current || (movingXY && xyChanged)) {
          if (movingXY) handlersRef.current.jogXY(nx, ny, feedXY)
        }
        if (!jogActive.current || (movingZ && zChanged)) {
          if (movingZ) handlersRef.current.jogZ(dz, feedZ)
        }
        jogActive.current = true
        lastJog.current = { x: nx, y: ny, z: dz, feedXY, feedZ }
      } else if (jogActive.current) {
        // Sticks returned to center → CANCEL the continuous jog (0x85).
        handlersRef.current.cancelJog()
        jogActive.current = false
        lastJog.current = { x: 0, y: 0, z: 0, feedXY: 0, feedZ: 0 }
      }

      // --- Edge-triggered discrete actions (fire once per press) ---
      const prev = prevPressed.current
      for (const key of Object.keys(BUTTON_ACTION)) {
        const i = Number(key)
        // Triggers (LT/RT) are reserved for Z jog above — never as actions.
        if (i === Btn.LT || i === Btn.RT) continue
        const down = pressedNow[i] ?? false
        const was = prev[i] ?? false
        if (down && !was) {
          const action = BUTTON_ACTION[i]
          if (action) handlersRef.current.onAction(action)
        }
      }
      prevPressed.current = pressedNow

      rafId.current = requestAnimationFrame(tick)
    }

    rafId.current = requestAnimationFrame(tick)
    return () => {
      alive = false
      if (rafId.current != null) {
        cancelAnimationFrame(rafId.current)
        rafId.current = null
      }
      // Leaving the loop must not strand a moving machine.
      if (jogActive.current) {
        handlersRef.current.cancelJog()
        jogActive.current = false
      }
      lastJog.current = { x: 0, y: 0, z: 0, feedXY: 0, feedZ: 0 }
      prevPressed.current = []
    }
  }, [enabled])

  return {
    connected,
    type,
    id,
    buttonsPressed,
    axes,
    enabled,
    setEnabled,
    rumble,
  }
}
