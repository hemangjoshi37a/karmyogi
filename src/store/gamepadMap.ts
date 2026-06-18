import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Programmable game-controller mapping (video-game-style rebinding).
 *
 * The gamepad subsystem used to hardcode its action→button map in two places:
 *   - the GLOBAL discrete-action map + analog-jog assignment in `useGamepad.ts`
 *     (A=resume, B=hold, X=spindle, Y=home, Back=unlock, Start=reset, LB/RB =
 *     step ∓, D-pad = step-jog, L3 = tab-nav, left stick = XY jog, right
 *     stick / triggers = Z jog), and
 *   - per-tab overrides in `gamepadTabActions.ts`.
 *
 * This store turns the GLOBAL map into DATA the operator can rebind from a tidy
 * UI (like remapping a game's controls), persists it to localStorage, and seeds
 * it from the exact hardcoded defaults below so behaviour is unchanged until the
 * user customises it. `useGamepad` + the on-element Pad badges both READ this
 * store, so a rebind is reflected live everywhere.
 *
 * NON-STANDARD PADS (the whole point of the v2 rewrite): a control is no longer
 * assumed to live at a fixed STANDARD-mapping index. Bindings capture WHATEVER
 * the operator actually presses — a button at any index, OR an axis half (a hat
 * / trigger reported as an axis on Android-mode HID pads, e.g. SHANWAN 2563:0526
 * where LT/RT are axes and the D-pad is a hat). The binding is therefore a
 * tagged union ('button' | 'axis', the latter carrying a direction + a
 * trigger-vs-stick flag), serialised to a compact string TOKEN for persistence.
 *
 * Bindings are persisted PER PAD (keyed by `vendor:product` + button/axis
 * counts) so a recognised controller reuses its own layout, with a built-in
 * default profile for the SHANWAN pad. A legacy single-map persist is migrated
 * gracefully into the per-pad store.
 *
 * UI-INDEPENDENT (no React/DOM imports) so it mirrors the pure store style used
 * elsewhere (teachPoints, grblSettings, …).
 */

// ─── control tokens (tagged union, serialised) ───────────────────────────────
// A "control" is a single physical input the operator can press to bind an
// action. We encode it as a compact, stable STRING token so it persists cleanly
// and is trivial to compare / display:
//   'b<index>'   → a button at the pad's raw button index (e.g. 'b0', 'b14')
//   'a<axis>+'   → the POSITIVE half of a bipolar analog axis (stick / hat)
//   'a<axis>-'   → the NEGATIVE half of a bipolar analog axis
//   't<axis>'    → a TRIGGER axis (rests near −1 or 0, travels to +1) normalised
//                  to 0..1 — captured when an axis sweeps unipolar like a trigger
// Discrete actions bind to a single control token (capturable by a press); the
// analog jog groups bind to a token too (a stick axis or trigger axis).
export type ControlToken = string

/** Structured form of a control token (parsed from / serialised to a string). */
export type ControlBinding =
  | { kind: 'button'; index: number }
  | { kind: 'axis'; index: number; dir: 1 | -1; trigger?: boolean }

/** Build the token for a raw button index. */
export function buttonToken(index: number): ControlToken {
  return `b${index}`
}
/** Build the token for a bipolar axis half. */
export function axisToken(axis: number, dir: 1 | -1): ControlToken {
  return `a${axis}${dir > 0 ? '+' : '-'}`
}
/** Build the token for a trigger axis (normalised 0..1, positive travel). */
export function triggerToken(axis: number): ControlToken {
  return `t${axis}`
}
/** Serialise a structured binding back to its token. */
export function bindingToken(b: ControlBinding): ControlToken {
  if (b.kind === 'button') return buttonToken(b.index)
  if (b.trigger) return triggerToken(b.index)
  return axisToken(b.index, b.dir)
}

/** Parse a control token into its structured form (or null if malformed). */
export function parseToken(tok: ControlToken): ControlBinding | null {
  if (!tok) return null
  const c = tok[0]
  if (c === 'b') {
    const n = Number(tok.slice(1))
    return Number.isFinite(n) && n >= 0 ? { kind: 'button', index: n } : null
  }
  if (c === 'a') {
    const dir: 1 | -1 = tok.endsWith('-') ? -1 : 1
    const n = Number(tok.slice(1, -1))
    return Number.isFinite(n) && n >= 0 ? { kind: 'axis', index: n, dir } : null
  }
  if (c === 't') {
    const n = Number(tok.slice(1))
    return Number.isFinite(n) && n >= 0 ? { kind: 'axis', index: n, dir: 1, trigger: true } : null
  }
  return null
}

// Standard-mapping button indices (mirror `Btn` in useGamepad.ts).
const A = 0
const B = 1
const X = 2
const Y = 3
const LB = 4
const RB = 5
const Back = 8
const Start = 9
const L3 = 10
const DUp = 12
const DDown = 13
const DLeft = 14
const DRight = 15

// ─── action catalogue ────────────────────────────────────────────────────────
/** Stable ids for every bindable DISCRETE action (the global map). */
export type GamepadActionId =
  | 'resume'
  | 'hold'
  | 'spindle'
  | 'home'
  | 'unlock'
  | 'reset'
  | 'zero'
  | 'stepDown'
  | 'stepUp'
  | 'stepJogXPlus'
  | 'stepJogXMinus'
  | 'stepJogYPlus'
  | 'stepJogYMinus'
  | 'tabNav'
  | 'simToggle'

/** The ANALOG (proportional) jog group ids — each binds to an axis/trigger token. */
export type GamepadAnalogId = 'jogXplus' | 'jogXminus' | 'jogYplus' | 'jogYminus' | 'jogZplus' | 'jogZminus'

/** Descriptor for one bindable action (id + label + a short hint). */
export interface ActionMeta {
  id: GamepadActionId
  /** i18n key (gp.act.*) and English fallback for the label. */
  labelKey: string
  label: string
  /** Whether this action is destructive/machine-moving (for a subtle warning). */
  machine?: boolean
}

/**
 * The full, ORDERED action catalogue with stable ids + labels. The remapping UI
 * renders one row per entry; `useGamepad` looks an action's bound control up by
 * id. Order = display order.
 */
export const GAMEPAD_ACTIONS: ActionMeta[] = [
  { id: 'resume', labelKey: 'gp.act.resume', label: 'Cycle start / Resume', machine: true },
  { id: 'hold', labelKey: 'gp.act.hold', label: 'Feed hold', machine: true },
  { id: 'spindle', labelKey: 'gp.act.spindle', label: 'Spindle toggle', machine: true },
  { id: 'home', labelKey: 'gp.act.home', label: 'Home', machine: true },
  { id: 'unlock', labelKey: 'gp.act.unlock', label: 'Unlock', machine: true },
  { id: 'reset', labelKey: 'gp.act.reset', label: 'Soft reset', machine: true },
  { id: 'zero', labelKey: 'gp.act.zero', label: 'Zero work XYZ', machine: true },
  { id: 'stepDown', labelKey: 'gp.act.stepdown', label: 'Step size −' },
  { id: 'stepUp', labelKey: 'gp.act.stepup', label: 'Step size +' },
  { id: 'stepJogXPlus', labelKey: 'gp.act.stepJogXplus', label: 'Step jog X+', machine: true },
  { id: 'stepJogXMinus', labelKey: 'gp.act.stepJogXminus', label: 'Step jog X−', machine: true },
  { id: 'stepJogYPlus', labelKey: 'gp.act.stepJogYplus', label: 'Step jog Y+', machine: true },
  { id: 'stepJogYMinus', labelKey: 'gp.act.stepJogYminus', label: 'Step jog Y−', machine: true },
  { id: 'tabNav', labelKey: 'gp.act.tabnav', label: 'Tab-switch mode' },
  { id: 'simToggle', labelKey: 'gp.act.simtoggle', label: 'Play / pause sim' },
]

/**
 * Analog (proportional) jog axes — each is a SINGLE bindable axis/trigger half.
 * Splitting jog into six directional half-axes lets the operator bind a
 * non-standard pad's stick halves / trigger axes / hat halves individually,
 * which is exactly what the SHANWAN-style HID pads need (their triggers are
 * axes, not buttons). `useGamepad` reads these to drive proportional jog.
 */
export const GAMEPAD_ANALOG: { id: GamepadAnalogId; labelKey: string; label: string }[] = [
  { id: 'jogXplus', labelKey: 'gp.act.jogXplus', label: 'Jog X +' },
  { id: 'jogXminus', labelKey: 'gp.act.jogXminus', label: 'Jog X −' },
  { id: 'jogYplus', labelKey: 'gp.act.jogYplus', label: 'Jog Y +' },
  { id: 'jogYminus', labelKey: 'gp.act.jogYminus', label: 'Jog Y −' },
  { id: 'jogZplus', labelKey: 'gp.act.jogZplus', label: 'Jog Z + (up)' },
  { id: 'jogZminus', labelKey: 'gp.act.jogZminus', label: 'Jog Z − (down)' },
]

/** A complete pad binding set: discrete actions + analog jog axes. */
export interface PadBindings {
  actions: Record<GamepadActionId, ControlToken>
  analog: Record<GamepadAnalogId, ControlToken>
}

/** Seeded discrete-action defaults — EXACTLY the previous hardcoded global map. */
export const DEFAULT_ACTIONS: Record<GamepadActionId, ControlToken> = {
  resume: buttonToken(A),
  hold: buttonToken(B),
  spindle: buttonToken(X),
  home: buttonToken(Y),
  unlock: buttonToken(Back),
  reset: buttonToken(Start),
  zero: '',
  stepDown: buttonToken(LB),
  stepUp: buttonToken(RB),
  stepJogXPlus: buttonToken(DRight),
  stepJogXMinus: buttonToken(DLeft),
  stepJogYPlus: buttonToken(DUp),
  stepJogYMinus: buttonToken(DDown),
  tabNav: buttonToken(L3),
  simToggle: '',
}

/**
 * Seeded analog defaults for a STANDARD pad: left stick → XY (axes 0/1), right
 * stick Y → Z (axis 3). Y is inverted in the loop (stick-up = +Y/+Z), so the
 * "+Y/+Z" halves bind to the NEGATIVE axis direction here.
 */
export const DEFAULT_ANALOG: Record<GamepadAnalogId, ControlToken> = {
  jogXplus: axisToken(0, 1),
  jogXminus: axisToken(0, -1),
  jogYplus: axisToken(1, -1),
  jogYminus: axisToken(1, 1),
  jogZplus: axisToken(3, -1),
  jogZminus: axisToken(3, 1),
}

export const DEFAULT_BINDINGS: PadBindings = {
  actions: { ...DEFAULT_ACTIONS },
  analog: { ...DEFAULT_ANALOG },
}

// Back-compat export (some code referenced DEFAULT_BINDINGS as the action map).
export const DEFAULT_ACTION_BINDINGS = DEFAULT_ACTIONS

// ─── built-in per-pad default profiles ────────────────────────────────────────
// A pad we RECOGNISE by vendor:product can ship a sensible head-start layout that
// matches its actual (possibly non-standard) HID report shape. The user can
// still rebind anything, and reset-to-default restores the profile (falling back
// to the generic standard defaults for unknown pads).

/**
 * SHANWAN Android-mode gamepad (2563:0526). Xbox-look-alike but `mapping !==
 * "standard"`: triggers are AXES, the D-pad is a HAT (axis pair), and the face /
 * L3/R3 / macro buttons sit at SHIFTED indices among ~15 HID buttons. These
 * values are a reasonable, SAFE head-start for the common Android HID layout —
 * the operator confirms/rebinds via the live raw-inputs diagnostic. Z jog is put
 * on the two trigger AXES (the headline fix: triggers that the old code couldn't
 * see as buttons[6/7]); the hat drives step-jog; face buttons keep the usual
 * actions at their typical Android indices (A0 B1 X2 Y3 L1=4 R1=5 select=6
 * start=7 L3=8 R3=9, hat axes 4/5 = D-pad).
 */
const SHANWAN_PROFILE: PadBindings = {
  actions: {
    resume: buttonToken(0), // A
    hold: buttonToken(1), // B
    spindle: buttonToken(2), // X
    home: buttonToken(3), // Y
    unlock: buttonToken(6), // Select / Back
    reset: buttonToken(7), // Start
    zero: '',
    stepDown: buttonToken(4), // L1
    stepUp: buttonToken(5), // R1
    stepJogXPlus: axisToken(4, 1), // hat X +  (D-pad →)
    stepJogXMinus: axisToken(4, -1), // hat X −  (D-pad ←)
    stepJogYPlus: axisToken(5, -1), // hat Y −  (D-pad ↑)
    stepJogYMinus: axisToken(5, 1), // hat Y +  (D-pad ↓)
    tabNav: buttonToken(8), // L3
    simToggle: '',
  },
  analog: {
    jogXplus: axisToken(0, 1),
    jogXminus: axisToken(0, -1),
    jogYplus: axisToken(1, -1),
    jogYminus: axisToken(1, 1),
    // Triggers as AXES — the SHANWAN headline fix. RT axis (commonly 5 or a
    // dedicated trigger axis) raises Z; LT lowers it. We default RT→axis2,
    // LT→axis3 as a common Android layout; the diagnostic lets the user correct it.
    jogZplus: triggerToken(2),
    jogZminus: triggerToken(3),
  },
}

/** vendor:product → built-in profile. */
const PAD_PROFILES: Record<string, PadBindings> = {
  '2563:0526': SHANWAN_PROFILE,
}

/** The built-in default bindings for a given pad key (profile or generic). */
export function defaultBindingsFor(padKey: string | null): PadBindings {
  const vp = padKey ? padKey.split('|')[0] : ''
  const prof = vp ? PAD_PROFILES[vp] : undefined
  if (prof) return { actions: { ...prof.actions }, analog: { ...prof.analog } }
  return { actions: { ...DEFAULT_ACTIONS }, analog: { ...DEFAULT_ANALOG } }
}

// ─── pad key (per-pad persistence) ────────────────────────────────────────────
/**
 * Identity used to persist a pad's bindings: `vendor:product|btnCount.axisCount`.
 * The counts disambiguate a controller that exposes different report shapes in
 * different modes (e.g. an XInput vs Android mode of the same chip), so a layout
 * mapped for one shape isn't wrongly reused for the other.
 */
export function padKeyFor(
  ids: { vendor: string | null; product: string | null; buttons: number; axes: number } | null,
): string {
  if (!ids) return 'none'
  const v = (ids.vendor ?? 'xxxx').toLowerCase()
  const p = (ids.product ?? 'xxxx').toLowerCase()
  return `${v}:${p}|${ids.buttons}.${ids.axes}`
}

// ─── store ────────────────────────────────────────────────────────────────────
interface GamepadMapStore {
  /** Per-pad GLOBAL bindings, keyed by padKey. */
  pads: Record<string, PadBindings>
  /** Per-pad, PER-TAB action OVERRIDES: pads2tab[padKey][tabId][actionTok] (sparse). */
  tabOverrides: Record<string, Record<string, Record<string, GamepadActionId>>>

  /** Ensure a pad entry exists (seeded from its built-in default) and return it. */
  ensurePad: (padKey: string) => PadBindings
  /** Bind a discrete action to a control for a pad (clears any other action holding it). */
  bind: (padKey: string, action: GamepadActionId, token: ControlToken) => void
  /** Bind an analog jog axis to a control for a pad. */
  bindAnalog: (padKey: string, analog: GamepadAnalogId, token: ControlToken) => void
  /** Clear a discrete action's binding for a pad. */
  clear: (padKey: string, action: GamepadActionId) => void
  /** Clear an analog jog binding for a pad. */
  clearAnalog: (padKey: string, analog: GamepadAnalogId) => void
  /** Reset every binding for a pad to its built-in default (profile or generic). */
  resetDefaults: (padKey: string) => void

  /** Set a per-tab override (tok→action) for a pad+tab. Empty action clears it. */
  setTabOverride: (padKey: string, tab: string, token: ControlToken, action: GamepadActionId | '') => void
  /** Clear a per-tab override at a control token. */
  clearTabOverride: (padKey: string, tab: string, token: ControlToken) => void
  /** Reset ALL per-tab overrides for a pad+tab back to the built-in tab defaults. */
  resetTabOverrides: (padKey: string, tab: string) => void
}

/** Default empty per-pad bindings used before a pad is known (avoids undefined). */
const EMPTY_PAD: PadBindings = { actions: { ...DEFAULT_ACTIONS }, analog: { ...DEFAULT_ANALOG } }

export const useGamepadMap = create<GamepadMapStore>()(
  persist(
    (set, get) => ({
      pads: {},
      tabOverrides: {},

      ensurePad: (padKey) => {
        const cur = get().pads[padKey]
        if (cur) return cur
        const seed = defaultBindingsFor(padKey)
        set((s) => ({ pads: { ...s.pads, [padKey]: seed } }))
        return seed
      },

      bind: (padKey, action, token) =>
        set((s) => {
          const base = s.pads[padKey] ?? defaultBindingsFor(padKey)
          const actions: Record<GamepadActionId, ControlToken> = { ...base.actions }
          // Enforce uniqueness within discrete actions: steal the control from any
          // other action holding it (a control drives at most one discrete action).
          if (token) {
            for (const k of Object.keys(actions) as GamepadActionId[]) {
              if (actions[k] === token) actions[k] = ''
            }
          }
          actions[action] = token
          return { pads: { ...s.pads, [padKey]: { ...base, actions } } }
        }),

      bindAnalog: (padKey, analog, token) =>
        set((s) => {
          const base = s.pads[padKey] ?? defaultBindingsFor(padKey)
          const an: Record<GamepadAnalogId, ControlToken> = { ...base.analog }
          if (token) {
            for (const k of Object.keys(an) as GamepadAnalogId[]) {
              if (an[k] === token) an[k] = ''
            }
          }
          an[analog] = token
          return { pads: { ...s.pads, [padKey]: { ...base, analog: an } } }
        }),

      clear: (padKey, action) =>
        set((s) => {
          const base = s.pads[padKey] ?? defaultBindingsFor(padKey)
          return { pads: { ...s.pads, [padKey]: { ...base, actions: { ...base.actions, [action]: '' } } } }
        }),

      clearAnalog: (padKey, analog) =>
        set((s) => {
          const base = s.pads[padKey] ?? defaultBindingsFor(padKey)
          return { pads: { ...s.pads, [padKey]: { ...base, analog: { ...base.analog, [analog]: '' } } } }
        }),

      resetDefaults: (padKey) =>
        set((s) => ({ pads: { ...s.pads, [padKey]: defaultBindingsFor(padKey) } })),

      setTabOverride: (padKey, tab, token, action) =>
        set((s) => {
          if (!token) return s
          const pad = { ...(s.tabOverrides[padKey] ?? {}) }
          const tabMap = { ...(pad[tab] ?? {}) }
          if (action === '') delete tabMap[token]
          else {
            // A control drives one tab action — steal it from any other token? No:
            // tab overrides are keyed BY token, so each token already maps to one
            // action. Just set it.
            tabMap[token] = action
          }
          pad[tab] = tabMap
          return { tabOverrides: { ...s.tabOverrides, [padKey]: pad } }
        }),

      clearTabOverride: (padKey, tab, token) =>
        set((s) => {
          const pad = s.tabOverrides[padKey]
          if (!pad || !pad[tab]) return s
          const tabMap = { ...pad[tab] }
          delete tabMap[token]
          return { tabOverrides: { ...s.tabOverrides, [padKey]: { ...pad, [tab]: tabMap } } }
        }),

      resetTabOverrides: (padKey, tab) =>
        set((s) => {
          const pad = s.tabOverrides[padKey]
          if (!pad || !pad[tab]) return s
          const { [tab]: _drop, ...rest } = pad
          return { tabOverrides: { ...s.tabOverrides, [padKey]: rest } }
        }),
    }),
    {
      name: 'karmyogi.gamepad.map',
      version: 2,
      // v1 → v2 migration: the old store was a SINGLE { bindings: Record<action,
      // token> } shared across all pads. Fold it into the per-pad store under a
      // synthetic 'legacy' key so the user's customisations aren't lost, and
      // normalise the new shape (always provide pads + tabOverrides + full
      // action/analog records so a newly-added id has an entry).
      migrate: (persisted, fromVersion): GamepadMapStore => {
        const blank = { pads: {}, tabOverrides: {} } as unknown as GamepadMapStore
        if (!persisted || typeof persisted !== 'object') return blank
        const p = persisted as Record<string, unknown>
        if (fromVersion < 2 && p.bindings && typeof p.bindings === 'object') {
          const legacy = p.bindings as Record<string, ControlToken>
          return {
            ...blank,
            pads: {
              legacy: {
                actions: { ...DEFAULT_ACTIONS, ...legacy },
                analog: { ...DEFAULT_ANALOG },
              },
            },
          }
        }
        return blank
      },
      // Always normalise: ensure every persisted pad has full action+analog maps
      // (forward-compatible across added action ids), and the two top-level maps.
      merge: (persisted, current): GamepadMapStore => {
        const p = (persisted as Partial<GamepadMapStore> | undefined) ?? {}
        const padsIn = (p.pads ?? {}) as Record<string, Partial<PadBindings>>
        const pads: Record<string, PadBindings> = {}
        for (const key of Object.keys(padsIn)) {
          const def = defaultBindingsFor(key)
          const pb = padsIn[key] ?? {}
          pads[key] = {
            actions: { ...def.actions, ...(pb.actions ?? {}) },
            analog: { ...def.analog, ...(pb.analog ?? {}) },
          }
        }
        return {
          ...current,
          pads,
          tabOverrides: (p.tabOverrides ?? {}) as GamepadMapStore['tabOverrides'],
        }
      },
    },
  ),
)

// ─── helpers (pure; usable outside React) ────────────────────────────────────

/** Read a pad's bindings from a snapshot, falling back to its built-in default. */
export function padBindings(s: GamepadMapStore, padKey: string): PadBindings {
  return s.pads[padKey] ?? (padKey ? defaultBindingsFor(padKey) : EMPTY_PAD)
}

/** The bound control token for a discrete action. */
export function tokenFor(b: PadBindings, action: GamepadActionId): ControlToken {
  return b.actions[action] ?? ''
}

/**
 * Does a control token MATCH a live pad input? Buttons match a pressed/edge
 * index; bipolar axes match a deflection past the deadzone in the bound
 * direction; trigger axes match a normalised press past the threshold. Pure +
 * defensive (guards short/missing arrays, NaN).
 */
export function tokenPressed(
  tok: ControlToken,
  buttons: ReadonlyArray<boolean>,
  axes: ReadonlyArray<number>,
  opts?: { axisDead?: number; triggerThresh?: number },
): boolean {
  const p = parseToken(tok)
  if (!p) return false
  if (p.kind === 'button') return !!buttons[p.index]
  const dead = opts?.axisDead ?? 0.12
  const tt = opts?.triggerThresh ?? 0.5
  const raw = axes[p.index]
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return false
  if (p.trigger) {
    // Normalise a trigger axis (rests near −1 or 0) to 0..1, then threshold.
    return triggerValue(raw) >= tt
  }
  return p.dir > 0 ? raw > dead : raw < -dead
}

/**
 * Reverse lookup for the discrete-action edge dispatch: given a control token,
 * the action it's bound to (if any). Matches the FULL union (button OR axis).
 */
export function actionForToken(b: PadBindings, tok: ControlToken): GamepadActionId | undefined {
  if (!tok) return undefined
  for (const k of Object.keys(b.actions) as GamepadActionId[]) {
    if (b.actions[k] === tok) return k
  }
  return undefined
}

/**
 * Normalise a raw trigger-axis value to 0..1. Gamepad trigger axes commonly rest
 * at −1 (released) and travel to +1 (pressed); some rest at 0. We map the −1..1
 * range to 0..1, which is correct for the −1-rest case and harmless (just a
 * scaled 0..1) for the 0-rest case once clamped.
 */
export function triggerValue(raw: number): number {
  if (!Number.isFinite(raw)) return 0
  const v = (raw + 1) / 2
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ─── control glyphs (for badges + the rebind list) ───────────────────────────
/** Family of the connected pad, for face-button glyphs. */
export type PadFamily = 'xbox' | 'playstation' | 'nintendo' | 'generic'

/**
 * Human glyph/label for a control token, given the pad family.
 *   - PlayStation: ✕●■▲ for buttons 0/1/2/3.
 *   - Nintendo: swaps A↔B and X↔Y positions vs Xbox (Nintendo's physical layout).
 *   - Xbox / generic (DEFAULT): A B X Y letters.
 * Axis halves render a terse "L/R↔", "L/R↕" or trigger label so a non-standard
 * binding is still readable. Returns a compact string suitable for a tiny badge.
 */
export function controlGlyph(tok: ControlToken, family: PadFamily): string {
  const p = parseToken(tok)
  if (!p) return ''
  if (p.kind === 'axis') {
    if (p.trigger) return `T${p.index}`
    return `A${p.index}${p.dir > 0 ? '+' : '−'}`
  }
  return faceGlyph(p.index, family)
}

/** Glyph for a button index given the pad family (handles 0..15 names + fallback). */
function faceGlyph(index: number, family: PadFamily): string {
  const ps = family === 'playstation'
  const nin = family === 'nintendo'
  switch (index) {
    case 0:
      return ps ? '✕' : nin ? 'B' : 'A'
    case 1:
      return ps ? '●' : nin ? 'A' : 'B'
    case 2:
      return ps ? '■' : nin ? 'Y' : 'X'
    case 3:
      return ps ? '▲' : nin ? 'X' : 'Y'
    case 4:
      return ps ? 'L1' : 'LB'
    case 5:
      return ps ? 'R1' : 'RB'
    case 6:
      return ps ? 'L2' : 'LT'
    case 7:
      return ps ? 'R2' : 'RT'
    case 8:
      return ps ? 'Share' : nin ? '−' : 'Back'
    case 9:
      return ps ? 'Opt' : nin ? '+' : 'Start'
    case 10:
      return 'L3'
    case 11:
      return 'R3'
    case 12:
      return '↑'
    case 13:
      return '↓'
    case 14:
      return '←'
    case 15:
      return '→'
    default:
      return `B${index}`
  }
}
