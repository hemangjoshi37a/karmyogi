import { Gamepad2, Vibrate, Move, ChevronsUpDown, RotateCcw, X, Crosshair, Plus, Sliders, Layers } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Modal } from './Modal'
import { GamepadModel3D } from './GamepadModel3D'
import { GamepadDiagnostic } from './GamepadDiagnostic'
import { type GamepadState } from '../machine/useGamepad'
import {
  useGamepadMap,
  padBindings,
  GAMEPAD_ACTIONS,
  GAMEPAD_ANALOG,
  controlGlyph,
  buttonToken,
  axisToken,
  triggerToken,
  type GamepadActionId,
  type GamepadAnalogId,
  type ControlToken,
  type PadFamily,
} from '../store/gamepadMap'
import {
  TABS_WITH_ACTIONS,
  tabLegend,
  tabCommandCatalogue,
} from '../machine/gamepadTabActions'
import { availablePanels } from '../app/panelRegistry'
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
            // Trigger heuristic: started near a rail (−1 or 0) and swept far toward +1.
            const startedAtRail = base <= -0.6 || Math.abs(base) < 0.2
            if (startedAtRail && v > 0.4 && travel > CAPTURE_TRIGGER_TRAVEL) {
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
      setCapturing(null)
    },
    [capturing, bind, bindAnalog, store, padKey],
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

  return (
    <Modal open={open} onClose={onClose} title={t('gp.title', 'Game controller')} width={860}>
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
        <GamepadDiagnostic subscribeRaw={gp.subscribeRaw} getRawSnapshot={gp.getRawSnapshot} family={family} />

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
              const glyph = tok ? controlGlyph(tok, family) : ''
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
                    ) : glyph ? (
                      <span className="gp-remap-actl">{glyph}</span>
                    ) : (
                      <span className="gp-remap-unbound">{t('gp.remap.unbound', 'Unbound')}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className="gp-remap-btn gp-remap-btn--sm"
                    onClick={() => setCapturing(isCapturing ? null : { kind: 'analog', id: a.id })}
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
              const glyph = tok ? controlGlyph(tok, family) : ''
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
                    ) : glyph ? (
                      <span className={`gp-remap-glyph${dupWarn ? ' warn' : ''}`} title={dupWarn ? t('gp.remap.conflict', 'Also used elsewhere') : undefined}>
                        {glyph}
                      </span>
                    ) : (
                      <span className="gp-remap-unbound">{t('gp.remap.unbound', 'Unbound')}</span>
                    )}
                  </span>
                  <span className="gp-remap-acts">
                    <button
                      type="button"
                      className="gp-remap-btn"
                      onClick={() => setCapturing(isCapturing ? null : { kind: 'action', id: a.id })}
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
          <TabOverridesEditor padKey={padKey} family={family} capturing={capturing} setCapturing={setCapturing} />
        </div>
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
  capturing,
  setCapturing,
}: {
  padKey: string
  family: PadFamily
  capturing:
    | { kind: 'action'; id: GamepadActionId }
    | { kind: 'analog'; id: GamepadAnalogId }
    | { kind: 'tab'; tab: string; action: string }
    | null
  setCapturing: (c: { kind: 'tab'; tab: string; action: string } | null) => void
}) {
  const t = useT()
  const [tab, setTab] = useState<string>(TABS_WITH_ACTIONS[0] ?? 'program')
  const store = useGamepadMap()
  const overrides = (store.tabOverrides[padKey]?.[tab] ?? {}) as Record<string, string>
  const legend = useMemo(() => tabLegend(tab, overrides), [tab, overrides])
  // The bindable command catalogue for the SELECTED tab (changes with the tab).
  const catalogue = useMemo(() => tabCommandCatalogue(tab), [tab])
  const [addAction, setAddAction] = useState<string>(catalogue[0]?.id ?? '')
  // Keep the "action to add" picker valid for the current tab's catalogue: when
  // the tab changes (or its catalogue doesn't contain the current pick), reset to
  // the tab's first command so the picker never shows a foreign action.
  useEffect(() => {
    if (!catalogue.some((d) => d.id === addAction)) {
      setAddAction(catalogue[0]?.id ?? '')
    }
  }, [catalogue, addAction])

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
        <label className="gp-tabedit-pick">
          <span className="gp-tabedit-picklbl">{t('gp.tabedit.tab', 'Tab')}</span>
          <select
            className="mc-select"
            value={tab}
            onChange={(e) => setTab(e.target.value)}
            aria-label={t('gp.tabedit.tab.aria', 'Workbench tab to customise')}
          >
            {TABS_WITH_ACTIONS.map((id) => (
              <option key={id} value={id}>
                {tabTitle(id)}
              </option>
            ))}
          </select>
        </label>
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

      <div className="gp-tabedit-list">
        {legend.length === 0 && (
          <div className="gp-remap-unbound gp-tabedit-empty">{t('gp.tabedit.empty', 'No tab actions — add one below.')}</div>
        )}
        {legend.map((row) => (
          <div className="gp-tabedit-row" key={row.token}>
            <span className="gp-remap-glyph gp-tabedit-glyph">{controlGlyph(row.token, family)}</span>
            <span className="gp-tabedit-label">
              {t(row.labelKey, row.label)}
              {row.override && <span className="gp-tabedit-tag">{t('gp.tabedit.custom', 'custom')}</span>}
            </span>
            <span className="gp-remap-spacer" />
            {row.override && (
              <button
                type="button"
                className="gp-remap-btn gp-remap-clear"
                onClick={() => store.clearTabOverride(padKey, tab, row.token)}
                aria-label={t('gp.tabedit.remove.aria', 'Remove override')}
                title={t('gp.tabedit.remove.title', 'Remove this override')}
              >
                <X size={12} aria-hidden="true" />
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="gp-tabedit-add">
        <select
          className="mc-select"
          value={addAction}
          onChange={(e) => setAddAction(e.target.value)}
          aria-label={t('gp.tabedit.add.aria', 'Action to bind on this tab')}
          disabled={catalogue.length === 0}
        >
          {catalogue.map((d) => (
            <option key={d.id} value={d.id}>
              {t(d.labelKey, d.label)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="gp-remap-btn gp-tabedit-addbtn"
          onClick={() => addAction && setCapturing({ kind: 'tab', tab, action: addAction })}
          disabled={capturing?.kind === 'tab' || !addAction}
          title={t('gp.tabedit.add.title', 'Bind a control to this action on the chosen tab — then press a control')}
        >
          {capturing?.kind === 'tab' ? (
            <span className="gp-remap-capture">{t('gp.remap.press', 'Press a control…')}</span>
          ) : (
            <>
              <Plus size={13} aria-hidden="true" />
              {t('gp.tabedit.add', 'Bind control')}
            </>
          )}
        </button>
        {capturing?.kind === 'tab' && (
          <button type="button" className="gp-remap-btn" onClick={() => setCapturing(null)}>
            {t('gp.remap.cancel', 'Cancel')}
          </button>
        )}
      </div>
    </div>
  )
}
