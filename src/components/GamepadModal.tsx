import { Gamepad2, Vibrate, Move, ChevronsUpDown, RotateCcw, X, Crosshair, Sliders, Layers, Tag } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Modal } from './Modal'
import { GamepadModel3D } from './GamepadModel3D'
import { GamepadDiagnostic } from './GamepadDiagnostic'
import { type GamepadState, type RawSnapshot } from '../machine/useGamepad'
import {
  useGamepadMap,
  padBindings,
  GAMEPAD_ACTIONS,
  GAMEPAD_ANALOG,
  buttonToken,
  axisToken,
  triggerToken,
  tokenPressed,
  type GamepadActionId,
  type GamepadAnalogId,
  type ControlToken,
  type PadFamily,
} from '../store/gamepadMap'
import { useGamepadLabels, labelFor, baseToken, STD_CONTROL_NAMES } from '../store/gamepadLabels'
import {
  TABS_WITH_ACTIONS,
  tabLegend,
  tabCommandCatalogue,
} from '../machine/gamepadTabActions'
import { availablePanels } from '../app/panelRegistry'
import { CamEmpty } from './cam/CamUI'
import { usePersistentState } from '../store'
import { useT } from '../i18n'
import './../styles/gamepad.css'
import '../styles/controller.css'

interface GamepadModalProps {
  open: boolean
  onClose: () => void
  gp: GamepadState
  armed: boolean
  setArmed: (v: boolean) => void
  machineConnected: boolean
  haptics: boolean
  setHaptics: (v: boolean) => void
  hapticIntensity: number
  setHapticIntensity: (v: number) => void
}

/** Friendly, family-classified controller name (connection-agnostic). */
function controllerName(gp: GamepadState, t: ReturnType<typeof useT>): string {
  if (!gp.connected) return t('gp.none', 'No controller')
  switch (gp.type) {
    case 'xbox':
      return t('gp.type.xbox', 'Xbox-style controller')
    case 'playstation':
      return t('gp.type.ps', 'PlayStation controller')
    case 'nintendo':
      return t('gp.type.nintendo', 'Nintendo controller')
    default:
      return t('gp.type.generic', 'Generic controller')
  }
}

/** Press threshold for capturing an analog/trigger deflection as a binding. */
const CAPTURE_AXIS_THRESHOLD = 0.55
/** A trigger axis sweeps unipolar (−1→+1 or 0→+1); detect by total travel. */
const CAPTURE_TRIGGER_TRAVEL = 0.7

/**
 * Capture the NEXT control the user presses, returning its TOKEN. Polls the live
 * pad via rAF while `active`, snapshotting whatever is already held so the click
 * that armed capture doesn't self-bind. The first NEW input resolves:
 *   - a button rising-edge → `b<i>`;
 *   - a bipolar axis crossing the threshold → `a<i>±` (its sign);
 *   - an axis that sweeps from rest (≈−1 or ≈0) most of the way to +1 → a TRIGGER
 *     `t<i>` (so SHANWAN-style trigger axes are captured as triggers, normalised
 *     0..1, not as a half-axis).
 *
 * Works regardless of `gamepad.mapping`, which is exactly what binds a
 * non-standard pad's ML/MR/shifted buttons and trigger axes.
 */
function useControlCapture(active: boolean, onCaptured: (tok: ControlToken) => void) {
  const cbRef = useRef(onCaptured)
  cbRef.current = onCaptured
  useEffect(() => {
    if (!active) return
    let raf = 0
    let baseBtns: boolean[] | null = null
    let baseAxes: number[] | null = null
    const pollPads = () => (navigator.getGamepads ? navigator.getGamepads() : [])
    const tick = () => {
      const pads = pollPads()
      const pad = Array.from(pads).find((p): p is Gamepad => !!p) ?? null
      if (pad) {
        const btns = Array.isArray(pad.buttons) ? pad.buttons : []
        const ax = Array.isArray(pad.axes) ? Array.from(pad.axes) : []
        const pressed = btns.map((b) => !!b && (b.pressed || (b.value ?? 0) > 0.5))
        if (baseBtns == null) {
          baseBtns = pressed
          baseAxes = ax
        } else {
          for (let i = 0; i < pressed.length; i++) {
            if (pressed[i] && !baseBtns[i]) {
              cbRef.current(buttonToken(i))
              return
            }
          }
          for (let i = 0; i < ax.length; i++) {
            const base = baseAxes?.[i] ?? 0
            const v = ax[i] ?? 0
            if (!Number.isFinite(v)) continue
            const travel = Math.abs(v - base)
            // Trigger ONLY when the axis rests at the NEGATIVE rail (−1) and sweeps
            // far toward +1 — that's a real analog trigger. A CENTER-resting axis
            // (base ≈ 0) is a stick/D-pad-hat: each direction is a distinct axis
            // HALF, captured below as a<i>±. (The old `|Math.abs(base)<0.2|` wrongly
            // treated a centered hat going 0→+1 as a trigger, so D-pad ↑/→ couldn't
            // be bound as directions.)
            const restsAtNegRail = base <= -0.6
            if (restsAtNegRail && v > 0.4 && travel > CAPTURE_TRIGGER_TRAVEL) {
              cbRef.current(triggerToken(i))
              return
            }
            if (travel > CAPTURE_AXIS_THRESHOLD && Math.abs(v) > CAPTURE_AXIS_THRESHOLD) {
              cbRef.current(axisToken(i, v > 0 ? 1 : -1))
              return
            }
          }
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [active])
}

/**
 * A bound-control glyph chip that SHIMMERS while its control is held. It owns its
 * own subscription to the high-frequency raw snapshot (via `useSyncExternalStore`,
 * the same stable `subscribeRaw`/`getRawSnapshot` the diagnostic uses), so only
 * this tiny chip re-renders each animation frame — the surrounding rows,
 * dropdowns and memoised modal stay stable. `className` selects which row style
 * the chip wears (the glyph spans the rows used to render statically).
 */
function LiveGlyph({
  token,
  family,
  className,
  subscribeRaw,
  getRawSnapshot,
  title,
  padKey,
  labels,
}: {
  token: ControlToken
  family: PadFamily
  className: string
  subscribeRaw: (cb: () => void) => () => void
  getRawSnapshot: () => RawSnapshot | null
  title?: string
  padKey: string
  labels: Record<string, Record<string, string>>
}) {
  const raw = useSyncExternalStore(subscribeRaw, getRawSnapshot, getRawSnapshot)
  const pressed = token
    ? tokenPressed(token, raw?.buttons ?? [], raw?.axes ?? [], { triggerThresh: 0.6 })
    : false
  return (
    <span className={`${className}${pressed ? ' is-pressed' : ''}`} title={title}>
      {labelFor(padKey, token, family, labels)}
    </span>
  )
}

/**
 * A manual control-picker `<select>` shown ALONGSIDE Rebind/Clear: instead of
 * pressing the physical control, the user can pick it from a list. The option
 * list is built ONCE from `getRawSnapshot()` at render (button/axis counts are
 * stable per pad), so it does NOT subscribe to the per-frame raw stream. Picking
 * `''` clears the binding. Pure DISPLAY/selection path — it routes through the
 * same `bind`/`setTabOverride` the buttons use; no input-reading change.
 */
function ControlPicker({
  value,
  onPick,
  family,
  padKey,
  labels,
  subscribeRaw,
  getRawSnapshot,
}: {
  value: ControlToken
  onPick: (tok: ControlToken) => void
  family: PadFamily
  padKey: string
  labels: Record<string, Record<string, string>>
  subscribeRaw: (cb: () => void) => () => void
  getRawSnapshot: () => RawSnapshot | null
}) {
  const t = useT()
  // Subscribe but surface only a STABLE counts key ("nBtns:nAxes"). String
  // equality means this re-renders only when the pad (dis)connects or its control
  // count changes — NOT every frame — so the option list populates once the pad
  // is live (the old one-shot getRawSnapshot() read an empty/null snapshot at the
  // memoized modal's render and left the dropdown empty), while an open <select>
  // isn't torn down by per-frame input.
  const countsKey = useSyncExternalStore(subscribeRaw, () => {
    const r = getRawSnapshot()
    return r ? `${r.buttons.length}:${r.axes.length}` : ''
  })
  const [nBtns, nAxes] = countsKey ? countsKey.split(':').map(Number) : [0, 0]

  const buttonOpts = useMemo(() => {
    const out: { tok: ControlToken; text: string }[] = []
    for (let i = 0; i < nBtns; i++) {
      const tok = buttonToken(i)
      out.push({ tok, text: `${labelFor(padKey, tok, family, labels)} (b${i})` })
    }
    return out
  }, [nBtns, padKey, family, labels])

  const axisOpts = useMemo(() => {
    const out: { tok: ControlToken; text: string }[] = []
    for (let i = 0; i < nAxes; i++) {
      const plus = axisToken(i, 1)
      const minus = axisToken(i, -1)
      const trig = triggerToken(i)
      out.push({ tok: plus, text: `${labelFor(padKey, plus, family, labels)} (a${i}+)` })
      out.push({ tok: minus, text: `${labelFor(padKey, minus, family, labels)} (a${i}-)` })
      out.push({ tok: trig, text: `${labelFor(padKey, trig, family, labels)} (t${i})` })
    }
    return out
  }, [nAxes, padKey, family, labels])

  // If the current value isn't in the generated lists (snapshot null / pad
  // disconnected / exotic index), still surface it so the binding shows.
  const known = useMemo(() => {
    const s = new Set<ControlToken>([''])
    for (const o of buttonOpts) s.add(o.tok)
    for (const o of axisOpts) s.add(o.tok)
    return s
  }, [buttonOpts, axisOpts])
  const showCurrent = value !== '' && !known.has(value)

  const disabled = nBtns === 0 && nAxes === 0
  return (
    <select
      className="mc-select gp-remap-picker"
      value={value}
      disabled={disabled}
      onChange={(e) => onPick(e.target.value as ControlToken)}
      title={t('gp.remap.pick.title', 'Pick a control from the list')}
      aria-label={t('gp.remap.pick.aria', 'Pick a control')}
    >
      <option value="">{t('gp.remap.pick.none', '— none —')}</option>
      {showCurrent && (
        <option value={value}>{labelFor(padKey, value, family, labels)}</option>
      )}
      {buttonOpts.length > 0 && (
        <optgroup label={t('gp.remap.pick.buttons', 'Buttons')}>
          {buttonOpts.map((o) => (
            <option key={o.tok} value={o.tok}>
              {o.text}
            </option>
          ))}
        </optgroup>
      )}
      {axisOpts.length > 0 && (
        <optgroup label={t('gp.remap.pick.axes', 'Axes')}>
          {axisOpts.map((o) => (
            <option key={o.tok} value={o.tok}>
              {o.text}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

function GamepadModalInner({
  open,
  onClose,
  gp,
  armed,
  setArmed,
  machineConnected,
  haptics,
  setHaptics,
  hapticIntensity,
  setHapticIntensity,
}: GamepadModalProps) {
  const t = useT()
  const name = controllerName(gp, t)
  const family: PadFamily = (gp.type as PadFamily) ?? 'xbox'
  const padKey = gp.padKey

  // Per-pad bindings + per-tab overrides for the ACTIVE pad.
  const store = useGamepadMap()
  // User HID label layer (display names) — bound-control chips render through it.
  const labels = useGamepadLabels((s) => s.labels)
  const setLabel = useGamepadLabels((s) => s.setLabel)
  const clearLabel = useGamepadLabels((s) => s.clearLabel)
  const bindings = useMemo(() => padBindings(store, padKey), [store, padKey])
  const bind = store.bind
  const bindAnalog = store.bindAnalog
  const clearBind = store.clear
  const clearAnalog = store.clearAnalog
  const resetDefaults = store.resetDefaults

  // What's currently in "press a control…" capture mode: a discrete action, an
  // analog jog axis, or a per-tab override slot.
  type Capture =
    | { kind: 'action'; id: GamepadActionId }
    | { kind: 'analog'; id: GamepadAnalogId }
    | { kind: 'tab'; tab: string; action: string }
    | { kind: 'label'; name: string }
    | null
  const [capturing, setCapturing] = useState<Capture>(null)
  useEffect(() => {
    if (!open) setCapturing(null)
  }, [open])

  const onCaptured = useCallback(
    (tok: ControlToken) => {
      const cap = capturing
      if (!cap) return
      if (cap.kind === 'action') bind(padKey, cap.id, tok)
      else if (cap.kind === 'analog') bindAnalog(padKey, cap.id, tok)
      else if (cap.kind === 'tab') store.setTabOverride(padKey, cap.tab, tok, cap.action as GamepadActionId)
      else if (cap.kind === 'label') {
        const base = baseToken(tok)
        // Enforce uniqueness: a name maps to exactly one physical control. Clear
        // this name off any OTHER base it was previously assigned to.
        for (const [b, v] of Object.entries(labels[padKey] ?? {})) {
          if (v === cap.name && b !== base) clearLabel(padKey, b)
        }
        setLabel(padKey, base, cap.name)
      }
      setCapturing(null)
    },
    [capturing, bind, bindAnalog, store, padKey, labels, setLabel, clearLabel],
  )
  useControlCapture(capturing != null, onCaptured)

  const actionOwner = useCallback(
    (tok: ControlToken): GamepadActionId | undefined => {
      if (!tok) return undefined
      for (const a of GAMEPAD_ACTIONS) if (bindings.actions[a.id] === tok) return a.id
      return undefined
    },
    [bindings],
  )

  // W-I disclosure: how many bindings exist for this pad (actions + analog
  // directions + named labels) — surfaced as a "Mapping (N)" count badge so the
  // collapsed editor stays discoverable when no controller is connected.
  const bindCount = useMemo(() => {
    let n = 0
    for (const a of GAMEPAD_ACTIONS) if (bindings.actions[a.id]) n++
    for (const a of GAMEPAD_ANALOG) if (bindings.analog[a.id]) n++
    n += Object.keys(labels[padKey] ?? {}).length
    return n
  }, [bindings, labels, padKey])

  // Remember whether the operator expanded the mapping editor while no
  // controller is connected (disclosure rule: persist open/closed state).
  const [mapOpen, setMapOpen] = usePersistentState('karmyogi.gamepad.mapOpen', false)

  // The full mapping editor (Button names + Controller mapping + per-tab). Held
  // as a JSX value so it renders inline when a controller is connected, or
  // inside the collapsed <details> disclosure when none is — without duplicating
  // the markup.
  const mappingEditor = (
    <>
      {/* ───────── Button names (press-to-detect labelling) ─────────
          A SECOND way to label a physical control (the dropdowns in the live
          diagnostic above are the first): pick a standard name, click Rebind,
          then press the real button. Pure DISPLAY layer — never touches input
          reading or bindings. Each name maps to exactly one physical control. */}
      <div className="gp-remap gp-labels">
        <div className="gp-remap-head">
          <Tag size={14} aria-hidden="true" className="gp-sec-ico" />
          <h4>{t('gp.labels.title', 'Button names')}</h4>
          <span
            className="gp-remap-sub"
            title={t(
              'gp.labels.help',
              'Give each control its real-world name so every glyph in the app shows the correct label. Click Rebind, then press the button — or use the dropdowns in Live inputs above.',
            )}
          >
            {t('gp.labels.hint', 'Click Rebind, then press the button — or use the dropdowns in Live inputs above')}
          </span>
        </div>

        <div className="gp-remap-list">
          {STD_CONTROL_NAMES.map((nm) => {
            const base = Object.entries(labels[padKey] ?? {}).find(([, v]) => v === nm)?.[0]
            const isCapturing = capturing?.kind === 'label' && capturing.name === nm
            return (
              <div className={`gp-remap-row${isCapturing ? ' is-capturing' : ''}`} key={nm}>
                <span className="gp-remap-label" title={nm}>
                  {nm}
                </span>
                <span className="gp-remap-glyph-wrap">
                  {isCapturing ? (
                    <span className="gp-remap-capture" role="status">
                      {t('gp.remap.press', 'Press a control…')}
                    </span>
                  ) : base ? (
                    <LiveGlyph
                      token={base as ControlToken}
                      family={family}
                      className="gp-remap-glyph"
                      subscribeRaw={gp.subscribeRaw}
                      getRawSnapshot={gp.getRawSnapshot}
                      padKey={padKey}
                      labels={labels}
                    />
                  ) : (
                    <span className="gp-remap-unbound">{t('gp.labels.unmapped', 'Unmapped')}</span>
                  )}
                </span>
                <span className="gp-remap-acts">
                  <button
                    type="button"
                    className="gp-remap-btn"
                    onClick={() => setCapturing(isCapturing ? null : { kind: 'label', name: nm })}
                    aria-label={isCapturing ? t('gp.labels.rebind.cancel.aria', 'Cancel naming {name}', { name: nm }) : t('gp.labels.rebind.aria', 'Rebind {name}', { name: nm })}
                    title={t('gp.labels.rebind.title', 'Name a control — then press that button on your gamepad')}
                  >
                    {isCapturing ? t('gp.remap.cancel', 'Cancel') : t('gp.remap.rebind', 'Rebind')}
                  </button>
                  <button
                    type="button"
                    className="gp-remap-btn gp-remap-clear"
                    disabled={!base || isCapturing}
                    onClick={() => {
                      if (base) clearLabel(padKey, base)
                    }}
                    aria-label={t('gp.labels.clear.aria', 'Clear the control named {name}', { name: nm })}
                    title={t('gp.labels.clear.title', 'Clear this name')}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      </div>

      {/* ───────── Programmable mapping (video-game-style rebinding) ───────── */}
      <div className="gp-remap">
        <div className="gp-remap-head">
          <Sliders size={14} aria-hidden="true" className="gp-sec-ico" />
          <h4>{t('gp.remap.title', 'Controller mapping')}</h4>
          <span
            className="gp-remap-sub"
            title={t(
              'gp.remap.help',
              'Rebind any action to a controller button, stick, trigger or hat. Click Rebind, then press the control. Each control drives one action. Saved per controller.',
            )}
          >
            {t('gp.remap.hint', 'Click Rebind, then press a control')}
          </span>
          <span className="gp-remap-spacer" />
          <button
            type="button"
            className="gp-remap-reset"
            onClick={() => resetDefaults(padKey)}
            title={t('gp.remap.resetAll.title', 'Reset every binding for this controller to its default')}
          >
            <RotateCcw size={13} aria-hidden="true" />
            {t('gp.remap.resetAll', 'Reset all')}
          </button>
        </div>

        {/* Analog jog — now rebindable per direction (stick halves / trigger axes). */}
        <div className="gp-grouplbl">{t('gp.remap.group.analog', 'Analog jog')}</div>
        <div className="gp-remap-analog gp-remap-analog--grid">
          {GAMEPAD_ANALOG.map((a) => {
            const tok = bindings.analog[a.id] ?? ''
            const isCapturing = capturing?.kind === 'analog' && capturing.id === a.id
            return (
              <div className={`gp-remap-arow${isCapturing ? ' is-capturing' : ''}`} key={a.id}>
                <span className="gp-remap-aicon" aria-hidden="true">
                  {a.id.startsWith('jogZ') ? <ChevronsUpDown size={13} /> : <Move size={13} />}
                </span>
                <span className="gp-remap-alabel" title={t(a.labelKey, a.label)}>
                  {t(a.labelKey, a.label)}
                </span>
                <span className="gp-remap-aglyph">
                  {isCapturing ? (
                    <span className="gp-remap-capture" role="status">
                      {t('gp.remap.press', 'Press a control…')}
                    </span>
                  ) : tok ? (
                    <LiveGlyph
                      token={tok}
                      family={family}
                      className="gp-remap-actl"
                      subscribeRaw={gp.subscribeRaw}
                      getRawSnapshot={gp.getRawSnapshot}
                      padKey={padKey}
                      labels={labels}
                    />
                  ) : (
                    <span className="gp-remap-unbound">{t('gp.remap.unbound', 'Unbound')}</span>
                  )}
                </span>
                <button
                  type="button"
                  className="gp-remap-btn gp-remap-btn--sm"
                  onClick={() => setCapturing(isCapturing ? null : { kind: 'analog', id: a.id })}
                  aria-label={isCapturing ? t('gp.remap.rebind.cancel.aria', 'Cancel rebinding {action}', { action: t(a.labelKey, a.label) }) : t('gp.remap.rebind.aria', 'Rebind {action}', { action: t(a.labelKey, a.label) })}
                  title={t('gp.remap.rebind.title', 'Rebind this — then press a control on your gamepad')}
                >
                  {isCapturing ? t('gp.remap.cancel', 'Cancel') : t('gp.remap.rebind', 'Rebind')}
                </button>
                <button
                  type="button"
                  className="gp-remap-btn gp-remap-clear"
                  disabled={!tok || isCapturing}
                  onClick={() => clearAnalog(padKey, a.id)}
                  aria-label={t('gp.remap.clear.aria', 'Clear binding for {action}', { action: t(a.labelKey, a.label) })}
                  title={t('gp.remap.clear.title', 'Clear this binding')}
                >
                  <X size={12} aria-hidden="true" />
                </button>
              </div>
            )
          })}
        </div>

        <div className="gp-grouplbl">{t('gp.remap.group.actions', 'Buttons & commands')}</div>
        <div className="gp-remap-list">
          {GAMEPAD_ACTIONS.map((a) => {
            const tok = bindings.actions[a.id] ?? ''
            const isCapturing = capturing?.kind === 'action' && capturing.id === a.id
            const owner = isCapturing ? undefined : actionOwner(tok)
            const dupWarn = owner != null && owner !== a.id
            return (
              <div className={`gp-remap-row${isCapturing ? ' is-capturing' : ''}`} key={a.id}>
                <span className="gp-remap-label" title={t(a.labelKey, a.label)}>
                  {t(a.labelKey, a.label)}
                  {a.machine && (
                    <span className="gp-remap-machine" title={t('gp.remap.machineHint', 'Moves / commands the machine')}>
                      <Crosshair size={10} aria-hidden="true" />
                    </span>
                  )}
                </span>
                <span className="gp-remap-glyph-wrap">
                  {isCapturing ? (
                    <span className="gp-remap-capture" role="status">
                      {t('gp.remap.press', 'Press a control…')}
                    </span>
                  ) : tok ? (
                    <LiveGlyph
                      token={tok}
                      family={family}
                      className={`gp-remap-glyph${dupWarn ? ' warn' : ''}`}
                      subscribeRaw={gp.subscribeRaw}
                      getRawSnapshot={gp.getRawSnapshot}
                      title={dupWarn ? t('gp.remap.conflict', 'Also used elsewhere') : undefined}
                      padKey={padKey}
                      labels={labels}
                    />
                  ) : (
                    <span className="gp-remap-unbound">{t('gp.remap.unbound', 'Unbound')}</span>
                  )}
                </span>
                <span className="gp-remap-acts">
                  <ControlPicker
                    value={tok}
                    onPick={(tk) => (tk ? bind(padKey, a.id, tk) : clearBind(padKey, a.id))}
                    family={family}
                    padKey={padKey}
                    labels={labels}
                    subscribeRaw={gp.subscribeRaw}
                    getRawSnapshot={gp.getRawSnapshot}
                  />
                  <button
                    type="button"
                    className="gp-remap-btn"
                    onClick={() => setCapturing(isCapturing ? null : { kind: 'action', id: a.id })}
                    aria-label={isCapturing ? t('gp.remap.rebind.cancel.aria', 'Cancel rebinding {action}', { action: t(a.labelKey, a.label) }) : t('gp.remap.rebind.aria', 'Rebind {action}', { action: t(a.labelKey, a.label) })}
                    title={t('gp.remap.rebind.title', 'Rebind this — then press a control on your gamepad')}
                  >
                    {isCapturing ? t('gp.remap.cancel', 'Cancel') : t('gp.remap.rebind', 'Rebind')}
                  </button>
                  <button
                    type="button"
                    className="gp-remap-btn gp-remap-clear"
                    disabled={!tok || isCapturing}
                    onClick={() => clearBind(padKey, a.id)}
                    aria-label={t('gp.remap.clear.aria', 'Clear binding for {action}', { action: t(a.labelKey, a.label) })}
                    title={t('gp.remap.clear.title', 'Clear this binding')}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              </div>
            )
          })}
        </div>

        {/* Per-tab context overrides. */}
        <TabOverridesEditor
          padKey={padKey}
          family={family}
          labels={labels}
          capturing={capturing}
          setCapturing={setCapturing}
          subscribeRaw={gp.subscribeRaw}
          getRawSnapshot={gp.getRawSnapshot}
        />
      </div>
    </>
  )

  return (
    <Modal open={open} onClose={onClose} title={t('gp.title', 'Game controller')} size="xl">
      <div className="gp-modal gp-modal--v2">
        <div className="gp-space">
          <GamepadModel3D detectedType={family === 'playstation' ? 'playstation' : 'xbox'} />

          <div className="gp-ov gp-ov-tl">
            <span className={`gp-ov-dot${gp.connected ? ' on' : ''}`} aria-hidden="true" />
            <div className="gp-ov-status-txt">
              {gp.connected ? (
                <>
                  <strong>{name}</strong>
                  {gp.id && (
                    <span className="gp-ov-id" title={gp.id}>
                      {gp.id}
                    </span>
                  )}
                </>
              ) : (
                <strong>{t('gp.press', 'Press any button to connect')}</strong>
              )}
            </div>
          </div>

          <div className="gp-ov gp-ov-tr">
            <button
              type="button"
              role="switch"
              aria-checked={armed}
              className={`gp-chip${armed ? ' on' : ''}`}
              onClick={() => setArmed(!armed)}
              title={t('gp.safety', 'Controls the machine — keep clear. Jog only works when connected & idle.')}
            >
              <Gamepad2 size={14} aria-hidden="true" />
              {armed ? t('gp.on.s', 'Control ON') : t('gp.off.s', 'Control OFF')}
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={haptics}
              className={`gp-chip${haptics ? ' on' : ''}`}
              onClick={() => setHaptics(!haptics)}
              title={t('gp.haptics.note', 'Rumbles on machine events (Alarm/limit, error, job done). Informational only; needs a pad/browser that supports rumble.')}
            >
              <Vibrate size={14} aria-hidden="true" />
              {haptics ? t('gp.hap.on.s', 'Vibration ON') : t('gp.hap.off.s', 'Vibration OFF')}
            </button>
            {haptics && (
              <label className="gp-chip-slider" title={t('gp.haptics.intensity', 'Intensity')}>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={hapticIntensity}
                  onChange={(e) => setHapticIntensity(Number(e.target.value))}
                  onPointerUp={() => gp.rumble('idle')}
                  aria-label={t('gp.haptics.intensity.aria', 'Vibration intensity')}
                />
              </label>
            )}
          </div>

          {!machineConnected && (
            <div className="gp-ov gp-ov-bottom" role="status">
              {t('gp.noMachine.s', 'Connect a machine — jog & commands are inactive until you do.')}
            </div>
          )}
        </div>

        <p className="gp-space-note">
          {gp.connected
            ? t('gp.safety', 'Controls the machine — keep clear. Jog only works when connected & idle.')
            : t(
                'gp.connect.how',
                'Pair your controller over Bluetooth, or plug it in via USB or its wireless dongle, then press any button. Works the same on desktop and Android.',
              )}
        </p>

        {/* ★ Live raw-inputs diagnostic — cures "ML/MR / triggers not detected".
            It subscribes to the high-frequency raw snapshot itself (via
            useSyncExternalStore), so per-frame pad input re-renders ONLY this
            child — the modal + its dropdowns stay stable and an open menu stays
            open. */}
        <GamepadDiagnostic subscribeRaw={gp.subscribeRaw} getRawSnapshot={gp.getRawSnapshot} family={family} padKey={padKey} />

        {/* W-I: with NO controller connected, lead with a friendly empty state
            instead of the full Unbound form. The mapping editor below stays
            DISCOVERABLE (disclosure rule): it's collapsed into a labelled
            <details> with a persistent "Mapping (N)" badge + remembered open
            state, so a saved layout can still be reviewed/edited offline. When a
            controller IS connected the editor renders inline, always open. */}
        {!gp.connected && (
          <CamEmpty
            icon={<Gamepad2 size={26} aria-hidden="true" />}
            title={t('gp.empty.title', 'No controller connected')}
            hint={t(
              'gp.empty.hint',
              'Pair over Bluetooth, or plug in via USB or its wireless dongle, then press any button. Mapping is saved per controller — expand it below to review or edit your saved layout.',
            )}
          />
        )}

        {gp.connected ? (
          mappingEditor
        ) : (
          <details
            className="gp-map-disclose"
            open={mapOpen}
            onToggle={(e) => setMapOpen((e.target as HTMLDetailsElement).open)}
          >
            <summary className="gp-map-summary">
              <Sliders size={14} aria-hidden="true" className="gp-sec-ico" />
              <span className="gp-map-summary-label">
                {t('gp.empty.editTitle', 'Controller mapping & button names')}
              </span>
              <span className="gp-map-summary-badge">
                {t('gp.empty.count', 'Mapping ({n})', { n: bindCount })}
              </span>
            </summary>
            {mappingEditor}
          </details>
        )}
      </div>
    </Modal>
  )
}

/**
 * Memoised so the per-frame churn of the live pad (the `gp` object gets a fresh
 * identity every animation frame because the parent panel mirrors live button /
 * axis state) does NOT re-render the modal. We compare only the STABLE fields the
 * modal's own render actually depends on; the high-frequency raw snapshot is read
 * by the diagnostic via its own subscription, so it never needs the parent to
 * re-render. This is what keeps an open `<select>` dropdown from being torn down
 * mid-interaction.
 */
export const GamepadModal = memo(GamepadModalInner, (a, b) => {
  // NOTE: we deliberately do NOT compare function props (onClose / setArmed /
  // setHaptics / setHapticIntensity). The parent passes a fresh arrow for
  // `onClose` every render, but it only ever calls a stable state setter, so a
  // "stale" reference behaves identically — comparing it would defeat the memo.
  return (
    a.open === b.open &&
    a.armed === b.armed &&
    a.machineConnected === b.machineConnected &&
    a.haptics === b.haptics &&
    a.hapticIntensity === b.hapticIntensity &&
    // Only the stable fields of `gp` matter to the modal's own render; raw input
    // is consumed via subscribeRaw/getRawSnapshot, not by re-rendering here.
    a.gp.connected === b.gp.connected &&
    a.gp.type === b.gp.type &&
    a.gp.id === b.gp.id &&
    a.gp.padKey === b.gp.padKey
  )
})

// ─── per-tab override editor ──────────────────────────────────────────────────
function TabOverridesEditor({
  padKey,
  family,
  labels,
  capturing,
  setCapturing,
  subscribeRaw,
  getRawSnapshot,
}: {
  padKey: string
  family: PadFamily
  labels: Record<string, Record<string, string>>
  capturing:
    | { kind: 'action'; id: GamepadActionId }
    | { kind: 'analog'; id: GamepadAnalogId }
    | { kind: 'tab'; tab: string; action: string }
    | { kind: 'label'; name: string }
    | null
  setCapturing: (c: { kind: 'tab'; tab: string; action: string } | null) => void
  subscribeRaw: (cb: () => void) => () => void
  getRawSnapshot: () => RawSnapshot | null
}) {
  const t = useT()
  const [tab, setTab] = useState<string>(TABS_WITH_ACTIONS[0] ?? 'program')
  const store = useGamepadMap()
  const overrides = (store.tabOverrides[padKey]?.[tab] ?? {}) as Record<string, string>
  const legend = useMemo(() => tabLegend(tab, overrides), [tab, overrides])
  // EVERY bindable command for the SELECTED tab — the editor shows one row per
  // command (bind / rebind / clear), so the whole tab is programmable at a glance.
  const catalogue = useMemo(() => tabCommandCatalogue(tab), [tab])
  // Effective binding (token + whether it's a user override) for each command id.
  const byCmd = useMemo(() => {
    const m = new Map<string, { token: ControlToken; override: boolean }>()
    for (const row of legend) m.set(row.cmdId, { token: row.token, override: !!row.override })
    return m
  }, [legend])

  const tabTitle = (id: string) => {
    const spec = availablePanels.find((p) => p.id === id)
    return t('tab.' + id, spec?.title ?? id)
  }

  return (
    <div className="gp-tabedit">
      <div className="gp-tabedit-head">
        <Layers size={13} aria-hidden="true" className="gp-sec-ico" />
        <h5>{t('gp.tabedit.title', 'Per-tab actions')}</h5>
        <span className="gp-tabedit-sub" title={t('gp.tabedit.help', 'On the chosen workbench tab, these controls run a tab-specific action instead of the global one. Layered over the global map; saved per controller + tab.')}>
          {t('gp.tabedit.hint', 'Layered over Global on the chosen tab')}
        </span>
        <span className="gp-remap-spacer" />
        <button
          type="button"
          className="gp-remap-reset"
          onClick={() => store.resetTabOverrides(padKey, tab)}
          title={t('gp.tabedit.reset.title', 'Reset this tab’s overrides to the built-in defaults')}
        >
          <RotateCcw size={12} aria-hidden="true" />
          {t('gp.tabedit.reset', 'Reset tab')}
        </button>
      </div>

      {/* Tab picker as a horizontal strip (replaces the dropdown). */}
      <div className="gp-tabedit-tabs" role="tablist" aria-label={t('gp.tabedit.tab.aria', 'Workbench tab to customise')}>
        {TABS_WITH_ACTIONS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-pressed={id === tab}
            aria-selected={id === tab}
            className={`gp-tabedit-tab${id === tab ? ' is-active' : ''}`}
            onClick={() => setTab(id)}
          >
            {tabTitle(id)}
          </button>
        ))}
      </div>

      <div className="gp-tabedit-list">
        {catalogue.length === 0 && (
          <div className="gp-remap-unbound gp-tabedit-empty">{t('gp.tabedit.none', 'No actions for this tab.')}</div>
        )}
        {catalogue.map((c) => {
          const bound = byCmd.get(c.id)
          const tok = bound?.token ?? ''
          const override = bound?.override ?? false
          const isCapturing = capturing?.kind === 'tab' && capturing.tab === tab && capturing.action === c.id
          return (
            <div className={`gp-tabedit-row${isCapturing ? ' is-capturing' : ''}`} key={c.id}>
              <span className="gp-tabedit-cmdglyph">
                {isCapturing ? (
                  <span className="gp-remap-capture" role="status">{t('gp.remap.press', 'Press a control…')}</span>
                ) : tok ? (
                  <LiveGlyph
                    token={tok}
                    family={family}
                    className="gp-remap-glyph gp-tabedit-glyph"
                    subscribeRaw={subscribeRaw}
                    getRawSnapshot={getRawSnapshot}
                    padKey={padKey}
                    labels={labels}
                  />
                ) : (
                  <span className="gp-remap-unbound">{t('gp.remap.unbound', 'Unbound')}</span>
                )}
              </span>
              <span className="gp-tabedit-label">
                {t(c.labelKey, c.label)}
                {override && <span className="gp-tabedit-tag">{t('gp.tabedit.custom', 'custom')}</span>}
              </span>
              <span className="gp-remap-spacer" />
              <ControlPicker
                value={tok}
                onPick={(tk) =>
                  tk
                    ? store.setTabOverride(padKey, tab, tk, c.id as GamepadActionId)
                    : tok && store.clearTabOverride(padKey, tab, tok)
                }
                family={family}
                padKey={padKey}
                labels={labels}
                subscribeRaw={subscribeRaw}
                getRawSnapshot={getRawSnapshot}
              />
              <button
                type="button"
                className="gp-remap-btn"
                onClick={() => setCapturing(isCapturing ? null : { kind: 'tab', tab, action: c.id })}
                aria-label={isCapturing ? t('gp.tabedit.rebind.cancel.aria', 'Cancel rebinding {action} for this tab', { action: t(c.labelKey, c.label) }) : t('gp.tabedit.rebind.aria', 'Rebind {action} for this tab', { action: t(c.labelKey, c.label) })}
                title={t('gp.tabedit.rebind.title', 'Bind a control to this action on this tab — then press a control')}
              >
                {isCapturing ? t('gp.remap.cancel', 'Cancel') : t('gp.remap.rebind', 'Rebind')}
              </button>
              <button
                type="button"
                className="gp-remap-btn gp-remap-clear"
                disabled={!override || isCapturing}
                onClick={() => tok && store.clearTabOverride(padKey, tab, tok)}
                aria-label={t('gp.tabedit.remove.aria', 'Remove override')}
                title={t('gp.tabedit.remove.title', 'Remove this override')}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
