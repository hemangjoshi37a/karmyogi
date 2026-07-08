import { useCallback, useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { RealtimeByte } from '../serial'
import { useMachine, useSettings, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { useMachines } from '../store/machines'
import { DroReadout } from '../components/DroReadout'
import { JogPad, jogKeyToDelta, jogParamsFromDelta, HOLD_DELAY_MS, type JogDelta } from '../components/JogPad'
import { HomeIcon, UnlockIcon, ResetIcon, PauseIcon, PlayIcon, SpindleCwIcon, SpindleCcwIcon, AxisZeroIcon, GoToZeroIcon, PlusIcon, MinusIcon, OvResetIcon } from '../components/MachineIcons'
import { InfoTip } from '../components/InfoTip'
import { SegControl } from '../components/ui/SegControl'
import { SliderField } from '../components/ui/SliderField'
import {
  Gamepad2,
  Disc3,
  Crosshair,
  Navigation,
  RefreshCw,
  Trash2,
  ChevronDown,
  Keyboard,
  X,
  Droplets,
  Snowflake,
  Wind,
  SquareParking,
  Lock,
  LockOpen,
  ShieldAlert,
  Wrench,
  ListStart,
  Gauge,
  CircleCheck,
  Download,
  FileText,
} from 'lucide-react'
import { useTeachPoints, type TeachFrame, type TeachPoint } from '../store/teachPoints'
import { useProgram } from '../store/program'
import { GamepadModal } from '../components/GamepadModal'
import { FluidDialModal } from '../components/FluidDialModal'
import { useGamepad, type GamepadAction, type GamepadHandlers } from '../machine/useGamepad'
import { useGamepadMap, padBindings, controlGlyph, tokenPressed, type GamepadActionId, type PadFamily } from '../store/gamepadMap'
import { openTabs } from '../track/tabNav'
import { usePlayback } from '../store/playback'
import { useNotifications } from '../store/notifications'
import { CamError } from '../components/cam/CamUI'
import { availablePanels } from '../app/panelRegistry'
import { explainGrblMessage } from '../core/explainers'
import { useT } from '../i18n'
import '../styles/controller.css'
import '../styles/teach.css'

const STEP_SIZES = [0.1, 1, 10, 100]
/** Largest continuous-jog distance (mm) we'll ever feed, regardless of travel. */
const CONTINUOUS_JOG_MAX_MM = 2000
/** Machine states in which destructive commands (Zero) must be confirmed / refused. */
const BUSY_STATES = new Set(['Run', 'Hold', 'Jog', 'Home', 'Alarm', 'Door'])
/** Default safe-Z retract height (mm, work coords) used before any XY return. */
const DEFAULT_SAFE_Z = 5

/**
 * Work coordinate systems. `code` is the GRBL command sent on select; `label`
 * is the compact chip text (so all six fit in a narrow row); `tk`/`title`
 * resolve the full hover description (name + gcode).
 */
const WCS = [
  { code: 'G54', label: 'W1', tk: 'coord.wcs.g54', title: 'G54 — Work coordinate system 1 (default datum). The active work zero used for positioning.' },
  { code: 'G55', label: 'W2', tk: 'coord.wcs.g55', title: 'G55 — Work coordinate system 2.' },
  { code: 'G56', label: 'W3', tk: 'coord.wcs.g56', title: 'G56 — Work coordinate system 3.' },
  { code: 'G57', label: 'W4', tk: 'coord.wcs.g57', title: 'G57 — Work coordinate system 4.' },
  { code: 'G58', label: 'W5', tk: 'coord.wcs.g58', title: 'G58 — Work coordinate system 5.' },
  { code: 'G59', label: 'W6', tk: 'coord.wcs.g59', title: 'G59 — Work coordinate system 6.' },
] as const

/** Tiny, barely-visible UPPER-RIGHT corner badge showing a button's keyboard shortcut. */
function Kbd({ k }: { k: string }) {
  return (
    <span className="kbd-hint" aria-hidden="true">
      {k}
    </span>
  )
}

/**
 * Tiny UPPER-LEFT corner badge showing the GAMEPAD control bound to an element's
 * action — the gamepad counterpart of `Kbd`. Same subtle visual family, mirrored
 * to the left corner so both fit. Renders nothing when no glyph (action unbound)
 * is supplied. When `active` it lights up (the live "operating" highlight is on
 * the host element via `.gp-active`; the badge brightens in sympathy).
 */
function Pad({ glyph, active }: { glyph: string; active?: boolean }) {
  if (!glyph) return null
  return (
    <span className={`pad-hint${active ? ' on' : ''}`} aria-hidden="true">
      {glyph}
    </span>
  )
}

/**
 * The full keyboard shortcut map, shown as `<kbd>` chips in the help popover.
 * Each entry is one [keys, description] pair. Kept as data so the inline summary
 * and the popover stay in sync and the legend is never silently dropped.
 */
const KBD_MAP: Array<{ keys: string[]; tk: string; desc: string }> = [
  { keys: ['←', '→', '↑', '↓'], tk: 'ctrl.kbd.row.jogxy', desc: 'Jog X / Y' },
  { keys: ['PgUp', 'PgDn'], tk: 'ctrl.kbd.row.jogz', desc: 'Jog Z' },
  { keys: ['Esc'], tk: 'ctrl.kbd.row.cancel', desc: 'Cancel jog' },
  { keys: ['1', '2', '3', '4'], tk: 'ctrl.kbd.row.step', desc: 'Step size (0.1 / 1 / 10 / 100 mm)' },
  { keys: ['h'], tk: 'ctrl.kbd.row.home', desc: 'Home' },
  { keys: ['u'], tk: 'ctrl.kbd.row.unlock', desc: 'Unlock' },
  { keys: ['r'], tk: 'ctrl.kbd.row.reset', desc: 'Soft reset' },
  { keys: ['!'], tk: 'ctrl.kbd.row.hold', desc: 'Feed hold' },
  { keys: ['~'], tk: 'ctrl.kbd.row.resume', desc: 'Resume' },
  { keys: ['s'], tk: 'ctrl.kbd.row.spindle', desc: 'Spindle on / off' },
  { keys: ['z'], tk: 'ctrl.kbd.row.zero', desc: 'Zero work X / Y / Z' },
  { keys: ['[', ']'], tk: 'ctrl.kbd.row.feed', desc: 'Feed override −/+ 10%' },
  { keys: ['\\'], tk: 'ctrl.kbd.row.feed100', desc: 'Feed override 100%' },
]

/**
 * W-I — Controller keyboard help. SAFETY: the legend is never hidden. A reduced,
 * always-visible one-line summary keeps the essential jog/cancel keys on screen,
 * and a persistent WORDED `?` button opens the FULL `<kbd>`-chip map in a popover.
 * Open/closed state is persisted (disclosure rule).
 */
function KbdHelp() {
  const t = useT()
  const [open, setOpen] = usePersistentState('karmyogi.ctrl.kbdHelp.open', false)
  const ref = useRef<HTMLDivElement>(null)

  // Dismiss the popover on an outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, setOpen])

  return (
    <div className="mc-kbd" ref={ref}>
      <span className="mc-kbd-summary">
        {t(
          'ctrl.kbd.summary',
          'Arrows jog · PgUp/Dn Z · Esc cancel',
        )}
      </span>
      <button
        type="button"
        className={`mc-kbd-toggle${open ? ' on' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title={t('ctrl.kbd.toggle.title', 'Show all keyboard shortcuts')}
      >
        <Keyboard size={13} aria-hidden="true" />
        <span className="mc-kbd-toggle-q" aria-hidden="true">?</span>
        <span className="mc-kbd-toggle-label">{t('ctrl.kbd.toggle', 'Shortcuts')}</span>
      </button>
      {open && (
        <div className="mc-kbd-pop" role="dialog" aria-label={t('ctrl.kbd.pop.aria', 'Keyboard shortcuts')}>
          <div className="mc-kbd-pop-head">
            <Keyboard size={14} aria-hidden="true" />
            <span className="mc-kbd-pop-title">{t('ctrl.kbd.pop.title', 'Keyboard shortcuts')}</span>
            <span className="mc-grow" />
            <button
              type="button"
              className="mc-kbd-pop-close"
              onClick={() => setOpen(false)}
              aria-label={t('ctrl.kbd.pop.close', 'Close')}
              title={t('ctrl.kbd.pop.close', 'Close')}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="mc-kbd-pop-note">
            {t(
              'ctrl.kbd.pop.note',
              'Work whenever this panel is visible and you are not typing in a field. Tap = step, hold = continuous.',
            )}
          </p>
          <ul className="mc-kbd-pop-list">
            {KBD_MAP.map((row) => (
              <li className="mc-kbd-pop-row" key={row.tk}>
                <span className="mc-kbd-pop-keys">
                  {row.keys.map((k, i) => (
                    <kbd key={i} className="mc-kbd-chip">
                      {k}
                    </kbd>
                  ))}
                </span>
                <span className="mc-kbd-pop-desc">{t(row.tk, row.desc)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

/**
 * F1 — Teach / record-position section.
 *
 * Jog the machine to a spot, hit "Capture current position", and the live X/Y/Z
 * (and A if present) are saved into a named, editable list (rename inline,
 * re-capture, go-to, delete) backed by the persisted `useTeachPoints` store so
 * other workbenches (Soldering, Glue, PnP, Screw, Signature) can later consume
 * the same taught points. A compact, collapsible section so it never bloats the
 * Controller panel.
 */
function TeachSection({
  connected,
  busy,
  machineState,
  wpos,
  mpos,
  decimals,
  safeZ,
}: {
  connected: boolean
  busy: boolean
  machineState: string
  wpos: { x: number; y: number; z: number }
  mpos: { x: number; y: number; z: number }
  decimals: number
  safeZ: number
}) {
  const t = useT()
  const points = useTeachPoints((s) => s.points)
  const capture = useTeachPoints((s) => s.capture)
  const rename = useTeachPoints((s) => s.rename)
  const recapture = useTeachPoints((s) => s.recapture)
  const remove = useTeachPoints((s) => s.remove)
  const clear = useTeachPoints((s) => s.clear)

  // Collapsed by default (persisted) so the section stays out of the way until
  // the operator wants it; opens automatically the first time a point exists.
  const [open, setOpen] = usePersistentState('karmyogi.teach.open', false)
  // Which coordinate frame the captured X/Y/Z are recorded in (persisted).
  const [frame, setFrame] = usePersistentState<TeachFrame>('karmyogi.teach.frame', 'work')

  const livePos = frame === 'machine' ? mpos : wpos
  const fmt = (n: number) => n.toFixed(decimals)

  const doCapture = useCallback(() => {
    capture({ x: livePos.x, y: livePos.y, z: livePos.z, frame })
  }, [capture, livePos.x, livePos.y, livePos.z, frame])

  // SAFETY: go to a taught point — retract Z to the safe height FIRST, then
  // rapid to its XY, then lower to its Z. Work-frame points use G90 work coords;
  // machine-frame points use G53 (machine coords) for the moves.
  const goTo = useCallback(
    (p: TeachPoint) => {
      if (!grbl.isConnected) return
      if (busy) {
        const ok = window.confirm(
          t('teach.goto.confirmBusy', 'Machine is {state}. Retract Z and rapid to “{name}” anyway?', {
            state: machineState,
            name: p.name,
          }),
        )
        if (!ok) return
      }
      const z = Number.isFinite(safeZ) ? safeZ : DEFAULT_SAFE_Z
      const g53 = p.frame === 'machine' ? 'G53 ' : ''
      // The initial retract is ALWAYS a work-frame safe-Z lift (just get the head
      // clear before the XY rapid). `safeZ` is a work-coordinate clearance, so it
      // must NOT be combined with G53 — a machine-frame point would otherwise
      // command machine Z=safeZ and trip a soft limit / retract to the wrong height.
      Promise.resolve()
        .then(() => grbl.send(`G90 G0 Z${z}`))
        .then(() => grbl.send(`${g53}G90 G0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`))
        .then(() => grbl.send(`${g53}G90 G0 Z${p.z.toFixed(3)}`))
        .catch(() => {})
    },
    [busy, machineState, safeZ, t],
  )

  const doRecapture = useCallback(
    (p: TeachPoint) => recapture(p.id, { x: livePos.x, y: livePos.y, z: livePos.z, frame }),
    [recapture, livePos.x, livePos.y, livePos.z, frame],
  )

  const doClear = useCallback(() => {
    if (points.length === 0) return
    if (window.confirm(t('teach.clear.confirm', 'Delete all {n} taught points?', { n: points.length }))) clear()
  }, [points.length, clear, t])

  return (
    <section className="mc-section mc-section--bare">
      <div className="teach-section">
        <button
          type="button"
          className="teach-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t('teach.head.title', 'Teach points — jog to a spot and capture its position into a reusable named list')}
        >
          <span className="teach-head-ico">
            <Crosshair size={15} aria-hidden="true" />
          </span>
          <span className="teach-head-title">{t('teach.head', 'Teach points')}</span>
          {points.length > 0 && <span className="teach-count">{points.length}</span>}
          <span className="teach-head-ico teach-head-chev">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {open && (
          <div className="teach-body">
            <div className="teach-capture-row">
              <button
                type="button"
                className="teach-capture"
                disabled={!connected}
                onClick={doCapture}
                title={t(
                  'teach.capture.title',
                  'Capture the current machine position ({x}, {y}, {z}) as a new taught point',
                  { x: fmt(livePos.x), y: fmt(livePos.y), z: fmt(livePos.z) },
                )}
              >
                <Crosshair size={15} aria-hidden="true" />
                {t('teach.capture', 'Capture current position')}
              </button>
              <span
                className="teach-frame"
                role="group"
                aria-label={t('teach.frame.aria', 'Coordinate frame for captured points')}
              >
                <button
                  type="button"
                  className={frame === 'work' ? 'active' : ''}
                  aria-pressed={frame === 'work'}
                  onClick={() => setFrame('work')}
                  title={t('teach.frame.work', 'Record points in WORK coordinates (relative to the active work zero)')}
                >
                  {t('teach.frame.work.label', 'Work')}
                </button>
                <button
                  type="button"
                  className={frame === 'machine' ? 'active' : ''}
                  aria-pressed={frame === 'machine'}
                  onClick={() => setFrame('machine')}
                  title={t('teach.frame.machine', 'Record points in MACHINE coordinates (absolute, from machine zero)')}
                >
                  {t('teach.frame.machine.label', 'Mach')}
                </button>
              </span>
            </div>

            {points.length === 0 ? (
              <div className="teach-empty">
                {t(
                  'teach.empty',
                  'No taught points yet. Jog the machine to a spot, then Capture to save it. Reuse taught points across Soldering, Glue, PnP and more.',
                )}
              </div>
            ) : (
              <>
                <table className="teach-table">
                  <thead>
                    <tr>
                      <th className="teach-col-name">{t('teach.col.name', 'Name')}</th>
                      <th>{t('teach.col.x', 'X')}</th>
                      <th>{t('teach.col.y', 'Y')}</th>
                      <th>{t('teach.col.z', 'Z')}</th>
                      <th className="teach-col-act" aria-label={t('teach.col.actions', 'Actions')} />
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.id}>
                        <td className="teach-col-name">
                          <input
                            className="teach-name-input"
                            type="text"
                            value={p.name}
                            onChange={(e) => rename(p.id, e.target.value)}
                            aria-label={t('teach.name.aria', 'Point name')}
                            title={t('teach.name.title', '{frame} coordinates · captured point', {
                              frame: p.frame === 'machine' ? t('teach.frame.machine.label', 'Mach') : t('teach.frame.work.label', 'Work'),
                            })}
                          />
                        </td>
                        <td className="teach-coord">{fmt(p.x)}</td>
                        <td className="teach-coord">{fmt(p.y)}</td>
                        <td className="teach-coord">{fmt(p.z)}</td>
                        <td className="teach-col-act">
                          <span className="teach-acts">
                            <button
                              type="button"
                              className="teach-icon-btn teach-goto"
                              disabled={!connected}
                              onClick={() => goTo(p)}
                              aria-label={t('teach.goto.aria', 'Go to {name}', { name: p.name })}
                              title={t('teach.goto.title', 'Retract Z to the safe height, then rapid to this point')}
                            >
                              <Navigation size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="teach-icon-btn"
                              disabled={!connected}
                              onClick={() => doRecapture(p)}
                              aria-label={t('teach.recapture.aria', 'Re-capture {name}', { name: p.name })}
                              title={t('teach.recapture.title', 'Overwrite this point with the current machine position')}
                            >
                              <RefreshCw size={14} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="teach-icon-btn teach-del"
                              onClick={() => remove(p.id)}
                              aria-label={t('teach.delete.aria', 'Delete {name}', { name: p.name })}
                              title={t('teach.delete.title', 'Delete this taught point')}
                            >
                              <Trash2 size={14} aria-hidden="true" />
                            </button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="teach-foot">
                  <button type="button" className="teach-clear" onClick={doClear}>
                    {t('teach.clear', 'Clear all')}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Coolant output state — purely a UI/optimistic mirror (GRBL doesn't report it). */
type CoolantState = 'off' | 'flood' | 'mist'

/**
 * O11 — Coolant / aux outputs + safe Park.
 *
 * Flood (M8) / Mist (M7) toggle the GRBL coolant outputs; Off (M9) clears both.
 * Park retracts Z to the safe height FIRST and then rapids to a configured
 * machine-coordinate park position (defaults to machine zero), so the head moves
 * clear of the work for tool/material changes. State is reflected on the chips.
 */
function CoolantParkSection({
  motionEnabled,
  busy,
  machineState,
  safeZ,
}: {
  motionEnabled: boolean
  busy: boolean
  machineState: string
  safeZ: number
}) {
  const t = useT()
  // Optimistic coolant mirror — GRBL gives no coolant feedback, so we track the
  // last command we sent. Cleared on disconnect by the parent (motionEnabled).
  const [coolant, setCoolant] = useState<CoolantState>('off')
  // Park position (machine coordinates, mm), persisted. Empty == use machine zero.
  const [parkX, setParkX] = usePersistentState('karmyogi.park.x', 0)
  const [parkY, setParkY] = usePersistentState('karmyogi.park.y', 0)

  useEffect(() => {
    if (!motionEnabled) setCoolant('off')
  }, [motionEnabled])

  const setCool = useCallback(
    (next: CoolantState) => {
      if (!grbl.isConnected) return
      const cmd = next === 'flood' ? 'M8' : next === 'mist' ? 'M7' : 'M9'
      setCoolant(next)
      void grbl.send(cmd)
    },
    [],
  )

  // SAFETY: retract Z to the safe height in WORK coords first, then rapid to the
  // park position in MACHINE coords (G53) so it's independent of the work zero.
  const park = useCallback(() => {
    if (!grbl.isConnected) return
    const z = Number.isFinite(safeZ) ? safeZ : DEFAULT_SAFE_Z
    if (busy) {
      const ok = window.confirm(
        t('ctrl.park.confirmBusy', 'Machine is {state}. Retract Z and park anyway?', { state: machineState }),
      )
      if (!ok) return
    }
    Promise.resolve()
      .then(() => grbl.send(`G90 G0 Z${z}`))
      .then(() => grbl.send(`G53 G90 G0 X${(parkX || 0).toFixed(3)} Y${(parkY || 0).toFixed(3)}`))
      .catch(() => {})
  }, [busy, machineState, safeZ, parkX, parkY, t])

  return (
    <section className="mc-section">
      <h4 className="ui-sec-head">{t('ctrl.coolant.head', 'Coolant & park')}</h4>
      <div className="mc-aux-row" role="group" aria-label={t('ctrl.coolant.aria', 'Coolant outputs')}>
        <button
          type="button"
          className={`mc-btn mc-btn-lead mc-aux-btn${coolant === 'flood' ? ' primary' : ''}`}
          disabled={!motionEnabled}
          aria-pressed={coolant === 'flood'}
          onClick={() => setCool(coolant === 'flood' ? 'off' : 'flood')}
          title={t('ctrl.coolant.flood.title', 'Flood coolant on (M8) — click again to turn off (M9)')}
        >
          <Droplets size={15} aria-hidden="true" />
          <span>{t('ctrl.coolant.flood', 'Flood')}</span>
          <span className="mc-btn-cmd" aria-hidden="true">M8</span>
        </button>
        <button
          type="button"
          className={`mc-btn mc-btn-lead mc-aux-btn${coolant === 'mist' ? ' primary' : ''}`}
          disabled={!motionEnabled}
          aria-pressed={coolant === 'mist'}
          onClick={() => setCool(coolant === 'mist' ? 'off' : 'mist')}
          title={t('ctrl.coolant.mist.title', 'Mist coolant on (M7) — click again to turn off (M9)')}
        >
          <Snowflake size={15} aria-hidden="true" />
          <span>{t('ctrl.coolant.mist', 'Mist')}</span>
          <span className="mc-btn-cmd" aria-hidden="true">M7</span>
        </button>
        <button
          type="button"
          className="mc-btn mc-btn-lead mc-aux-btn"
          disabled={!motionEnabled || coolant === 'off'}
          onClick={() => setCool('off')}
          title={t('ctrl.coolant.off.title', 'Coolant off (M9)')}
        >
          <Wind size={15} aria-hidden="true" />
          <span>{t('ctrl.coolant.off', 'Off')}</span>
          <span className="mc-btn-cmd" aria-hidden="true">M9</span>
        </button>
      </div>
      <div className="mc-park-row">
        <button
          type="button"
          className="mc-btn mc-btn-lead mc-park-btn"
          disabled={!motionEnabled}
          onClick={park}
          title={t('ctrl.park.title', 'Park — retract Z to the safe height, then rapid to the park position (G53 machine coords)')}
        >
          <SquareParking size={16} aria-hidden="true" />
          <span>{t('ctrl.park', 'Park')}</span>
        </button>
        <span className="mc-park-fields">
          <label className="mc-park-field">
            <span aria-hidden="true">X</span>
            <input
              className="mc-input mc-park-input"
              type="number"
              step={1}
              value={parkX}
              onChange={(e) => setParkX(Number(e.target.value) || 0)}
              aria-label={t('ctrl.park.x.aria', 'Park X (machine mm)')}
              title={t('ctrl.park.x.title', 'Park X position in machine coordinates (mm)')}
            />
          </label>
          <label className="mc-park-field">
            <span aria-hidden="true">Y</span>
            <input
              className="mc-input mc-park-input"
              type="number"
              step={1}
              value={parkY}
              onChange={(e) => setParkY(Number(e.target.value) || 0)}
              aria-label={t('ctrl.park.y.aria', 'Park Y (machine mm)')}
              title={t('ctrl.park.y.title', 'Park Y position in machine coordinates (mm)')}
            />
          </label>
        </span>
      </div>
    </section>
  )
}

/** A tool-change wizard step. */
const TC_STEPS = ['hold', 'change', 'probe', 'resume'] as const
type TcStep = (typeof TC_STEPS)[number]

/**
 * O4 — Tool-change (M6) wizard.
 *
 * A guided, step-by-step manual tool change: (1) pause + retract Z and move to a
 * tool-change position; (2) prompt the operator to change the bit; (3) optionally
 * re-probe tool length at a Z-probe position; (4) resume. Each step is explicit
 * and only the relevant machine command is sent, so nothing moves unexpectedly.
 * Collapsible (disclosure rule) so it stays out of the way until needed.
 */
function ToolChangeSection({
  motionEnabled,
  safeZ,
}: {
  motionEnabled: boolean
  safeZ: number
}) {
  const t = useT()
  const [open, setOpen] = usePersistentState('karmyogi.toolchange.open', false)
  const [active, setActive] = useState(false)
  const [stepIdx, setStepIdx] = useState(0)
  // Tool-change position (machine coords) + whether to include the probe step.
  const [tcX, setTcX] = usePersistentState('karmyogi.toolchange.x', 0)
  const [tcY, setTcY] = usePersistentState('karmyogi.toolchange.y', 0)
  const [doProbe, setDoProbe] = usePersistentState('karmyogi.toolchange.probe', false)
  // Z-probe feed + max travel for the optional tool-length re-probe (G38.2).
  const [probeFeed] = usePersistentState('karmyogi.toolchange.probeFeed', 50)
  const [probeMax] = usePersistentState('karmyogi.toolchange.probeMax', 25)

  const steps: TcStep[] = doProbe ? ['hold', 'change', 'probe', 'resume'] : ['hold', 'change', 'resume']
  const step = steps[Math.min(stepIdx, steps.length - 1)]

  const begin = useCallback(() => {
    setActive(true)
    setStepIdx(0)
  }, [])
  const cancel = useCallback(() => {
    setActive(false)
    setStepIdx(0)
  }, [])

  // SAFETY: pause (feed hold), retract Z to safe height (work coords), then rapid
  // to the tool-change position in machine coords (G53).
  const doPause = useCallback(() => {
    if (!grbl.isConnected) return
    const z = Number.isFinite(safeZ) ? safeZ : DEFAULT_SAFE_Z
    void grbl.feedHold()
    Promise.resolve()
      .then(() => grbl.send(`G90 G0 Z${z}`))
      .then(() => grbl.send(`G53 G90 G0 X${(tcX || 0).toFixed(3)} Y${(tcY || 0).toFixed(3)}`))
      .catch(() => {})
    setStepIdx((i) => i + 1)
  }, [safeZ, tcX, tcY])

  // Optional tool-length re-probe: straight-probe down (G38.2) then zero Z.
  const doProbeNow = useCallback(() => {
    if (!grbl.isConnected) return
    Promise.resolve()
      .then(() => grbl.send(`G38.2 Z-${Math.abs(probeMax) || 25} F${Math.abs(probeFeed) || 50}`))
      .then(() => grbl.send('G10 L20 P0 Z0'))
      .catch(() => {})
    setStepIdx((i) => i + 1)
  }, [probeFeed, probeMax])

  const doResume = useCallback(() => {
    if (!grbl.isConnected) return
    void grbl.resume()
    setActive(false)
    setStepIdx(0)
  }, [])

  return (
    <section className="mc-section mc-section--bare">
      <div className="teach-section">
        <button
          type="button"
          className="teach-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t('ctrl.tc.head.title', 'Tool-change wizard — guided pause, move, change and (optional) re-probe')}
        >
          <span className="teach-head-ico">
            <Wrench size={15} aria-hidden="true" />
          </span>
          <span className="teach-head-title">{t('ctrl.tc.head', 'Tool change')}</span>
          {active && <span className="teach-count">{stepIdx + 1}/{steps.length}</span>}
          <span className="teach-head-ico teach-head-chev">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {open && (
          <div className="teach-body">
            {!active ? (
              <>
                <div className="mc-tc-config">
                  <span className="mc-park-fields">
                    <label className="mc-park-field">
                      <span aria-hidden="true">X</span>
                      <input
                        className="mc-input mc-park-input"
                        type="number"
                        step={1}
                        value={tcX}
                        onChange={(e) => setTcX(Number(e.target.value) || 0)}
                        aria-label={t('ctrl.tc.x.aria', 'Tool-change X (machine mm)')}
                        title={t('ctrl.tc.x.title', 'Tool-change X position in machine coordinates (mm)')}
                      />
                    </label>
                    <label className="mc-park-field">
                      <span aria-hidden="true">Y</span>
                      <input
                        className="mc-input mc-park-input"
                        type="number"
                        step={1}
                        value={tcY}
                        onChange={(e) => setTcY(Number(e.target.value) || 0)}
                        aria-label={t('ctrl.tc.y.aria', 'Tool-change Y (machine mm)')}
                        title={t('ctrl.tc.y.title', 'Tool-change Y position in machine coordinates (mm)')}
                      />
                    </label>
                  </span>
                  <label className="mc-tc-probe-opt">
                    <input
                      type="checkbox"
                      checked={doProbe}
                      onChange={(e) => setDoProbe(e.target.checked)}
                    />
                    <span>{t('ctrl.tc.probe.opt', 'Re-probe tool length')}</span>
                  </label>
                </div>
                <button
                  type="button"
                  className="teach-capture"
                  disabled={!motionEnabled}
                  onClick={begin}
                  title={t('ctrl.tc.start.title', 'Start the guided tool-change sequence')}
                >
                  <Wrench size={15} aria-hidden="true" />
                  {t('ctrl.tc.start', 'Start tool change')}
                </button>
              </>
            ) : (
              <div className="mc-tc-wizard">
                <ol className="mc-tc-steps">
                  {steps.map((s, i) => (
                    <li
                      key={s}
                      className={`mc-tc-step${i === stepIdx ? ' is-active' : ''}${i < stepIdx ? ' is-done' : ''}`}
                    >
                      <span className="mc-tc-step-num" aria-hidden="true">
                        {i < stepIdx ? <CircleCheck size={13} /> : i + 1}
                      </span>
                      <span className="mc-tc-step-label">
                        {s === 'hold'
                          ? t('ctrl.tc.step.hold', 'Pause & move to change position')
                          : s === 'change'
                            ? t('ctrl.tc.step.change', 'Change the tool')
                            : s === 'probe'
                              ? t('ctrl.tc.step.probe', 'Re-probe tool length')
                              : t('ctrl.tc.step.resume', 'Resume the job')}
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="mc-tc-action">
                  {step === 'hold' && (
                    <button type="button" className="teach-capture" disabled={!motionEnabled} onClick={doPause}>
                      {t('ctrl.tc.do.hold', 'Pause & retract to change position')}
                    </button>
                  )}
                  {step === 'change' && (
                    <>
                      <p className="mc-tc-prompt">
                        {t('ctrl.tc.prompt.change', 'Mount the new tool now. The spindle is stopped and the head is parked. When ready, continue.')}
                      </p>
                      <button type="button" className="teach-capture" onClick={() => setStepIdx((i) => i + 1)}>
                        {t('ctrl.tc.do.changed', 'Tool changed — continue')}
                      </button>
                    </>
                  )}
                  {step === 'probe' && (
                    <button type="button" className="teach-capture" disabled={!motionEnabled} onClick={doProbeNow}>
                      {t('ctrl.tc.do.probe', 'Probe down & set Z zero (G38.2)')}
                    </button>
                  )}
                  {step === 'resume' && (
                    <button type="button" className="teach-capture" disabled={!motionEnabled} onClick={doResume}>
                      {t('ctrl.tc.do.resume', 'Resume the job (~)')}
                    </button>
                  )}
                  <button type="button" className="teach-clear" onClick={cancel}>
                    {t('ctrl.tc.cancel', 'Cancel')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * O5 — Start-from-line / job recovery.
 *
 * Pick any line of the currently loaded program and resume the job there. A SAFE
 * preamble is prepended: restore modal state (G21 mm / G90 absolute / G94 feed)
 * and lift Z to the safe height FIRST, so a recovered job never plunges from an
 * unknown modal state. Collapsible; only enabled when a program is loaded.
 */
function StartFromLineSection({
  motionEnabled,
  safeZ,
}: {
  motionEnabled: boolean
  safeZ: number
}) {
  const t = useT()
  const lines = useProgram((s) => s.lines)
  const streaming = useProgram((s) => s.streaming)
  const [open, setOpen] = usePersistentState('karmyogi.startline.open', false)
  const [line, setLine] = useState(1)

  const total = lines.length
  const clamped = Math.min(Math.max(1, line), Math.max(1, total))
  const preview = total > 0 ? lines[clamped - 1] : ''

  const start = useCallback(() => {
    if (!grbl.isConnected || total === 0) return
    const idx = clamped - 1
    const z = Number.isFinite(safeZ) ? safeZ : DEFAULT_SAFE_Z
    if (
      !window.confirm(
        t(
          'ctrl.startline.confirm',
          'Start the job from line {n} of {total}? A safe preamble (units/absolute/feed-mode + safe-Z lift) runs first.',
          { n: clamped, total },
        ),
      )
    )
      return
    // SAFETY preamble: restore modal state then lift to safe Z BEFORE the slice.
    const preamble = ['G21 G90 G94 G17', `G0 Z${z}`]
    grbl.startProgram([...preamble, ...lines.slice(idx)], { startIndex: idx })
  }, [clamped, total, lines, safeZ, t])

  return (
    <section className="mc-section mc-section--bare">
      <div className="teach-section">
        <button
          type="button"
          className="teach-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t('ctrl.startline.head.title', 'Start the loaded job from an arbitrary line, with a safe modal-restore preamble')}
        >
          <span className="teach-head-ico">
            <ListStart size={15} aria-hidden="true" />
          </span>
          <span className="teach-head-title">{t('ctrl.startline.head', 'Start from line')}</span>
          {total > 0 && <span className="teach-count">{total}</span>}
          <span className="teach-head-ico teach-head-chev">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {open && (
          <div className="teach-body">
            {total === 0 ? (
              <div className="teach-empty">
                {t('ctrl.startline.empty', 'No program loaded. Load a job in the Program tab, then choose a line to resume from.')}
              </div>
            ) : (
              <>
                <div className="mc-field">
                  <span className="mc-label">{t('ctrl.startline.line', 'Line')}</span>
                  <input
                    className="mc-input mc-input-grow"
                    type="number"
                    min={1}
                    max={total}
                    step={1}
                    value={clamped}
                    onChange={(e) => setLine(Math.min(total, Math.max(1, Number(e.target.value) || 1)))}
                    aria-label={t('ctrl.startline.line.aria', 'Start line number')}
                    title={t('ctrl.startline.line.title', 'The 1-based line to resume from')}
                  />
                  <span className="mc-unit">/ {total}</span>
                </div>
                <input
                  className="mc-input mc-startline-slider"
                  type="range"
                  min={1}
                  max={total}
                  step={1}
                  value={clamped}
                  onChange={(e) => setLine(Number(e.target.value) || 1)}
                  aria-label={t('ctrl.startline.slider.aria', 'Start line')}
                />
                <code className="mc-startline-preview" title={preview}>
                  {preview || ' '}
                </code>
                <p className="mc-tc-prompt">
                  {t('ctrl.startline.note', 'Safe preamble: G21 G90 G94 G17 + lift to safe-Z run before the chosen line.')}
                </p>
                <button
                  type="button"
                  className="teach-capture"
                  disabled={!motionEnabled || streaming}
                  onClick={start}
                  title={t('ctrl.startline.start.title', 'Stream the job from the chosen line with the safe preamble')}
                >
                  <ListStart size={15} aria-hidden="true" />
                  {t('ctrl.startline.start', 'Start from line {n}', { n: clamped })}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

/** Format milliseconds as m:ss / h:mm:ss. */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

/**
 * O9 — Live diagnostics / run stats.
 *
 * A compact grid of live machine telemetry: state, feed, spindle, planner/RX
 * buffer, and — while a job streams — elapsed time, progress %, and an ETA
 * extrapolated from the elapsed/progress ratio. Read-only; no commands sent.
 */
function DiagnosticsSection({
  connected,
  machineState,
  feed,
  spindle,
  buffer,
  mpos,
  wpos,
  pins,
  firmware,
}: {
  connected: boolean
  machineState: string
  feed: number
  spindle: number
  buffer: { plan: number; rx: number } | null
  mpos: { x: number; y: number; z: number }
  wpos: { x: number; y: number; z: number }
  pins: string | null
  firmware: string | null
}) {
  const t = useT()
  const [open, setOpen] = usePersistentState('karmyogi.diag.open', false)
  const streaming = useProgram((s) => s.streaming)
  const cursor = useProgram((s) => s.cursor)
  const total = useProgram((s) => s.lines.length)

  // Track job start time + elapsed (1 Hz tick while streaming).
  const startRef = useRef<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (streaming) {
      if (startRef.current === null) startRef.current = Date.now()
    } else {
      startRef.current = null
      setElapsed(0)
      return
    }
    const id = setInterval(() => {
      if (startRef.current !== null) setElapsed(Date.now() - startRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [streaming])

  const pct = streaming && total > 0 ? Math.min(100, Math.max(0, ((cursor + 1) / total) * 100)) : 0
  const eta = streaming && pct > 1 ? (elapsed / pct) * (100 - pct) : 0

  const stat = (label: string, value: string) => (
    <div className="mc-diag-cell">
      <span className="mc-diag-label">{label}</span>
      <span className="mc-diag-val">{value}</span>
    </div>
  )

  const pinLabel = pins && pins.length > 0 ? pins : t('ctrl.diag.pins.none', 'none')

  // O9 — assemble a self-contained diagnostics report (live telemetry + position
  // + pin states + firmware + job stats) for support / record-keeping.
  const buildReport = useCallback(() => {
    return {
      generatedAt: new Date().toISOString(),
      app: 'karmyogi',
      connected,
      state: connected ? machineState : 'offline',
      feed: Math.round(feed),
      spindle: Math.round(spindle),
      buffer: buffer ? { plan: buffer.plan, rx: buffer.rx } : null,
      firmware: firmware ?? null,
      pins: pins && pins.length ? pins.split('') : [],
      machinePos: { x: mpos.x, y: mpos.y, z: mpos.z },
      workPos: { x: wpos.x, y: wpos.y, z: wpos.z },
      job: streaming
        ? { line: Math.min(cursor + 1, total), total, percent: Math.round(pct), elapsedMs: elapsed, etaMs: Math.round(eta) }
        : null,
    }
  }, [connected, machineState, feed, spindle, buffer, firmware, pins, mpos, wpos, streaming, cursor, total, pct, elapsed, eta])

  const download = useCallback((name: string, text: string, mime: string) => {
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [])

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)

  const exportJson = useCallback(() => {
    download(`karmyogi-diagnostics-${stamp()}.json`, JSON.stringify(buildReport(), null, 2), 'application/json')
  }, [buildReport, download])

  // A human-readable text report (acts as the printable/PDF-ready report — the
  // browser's Print-to-PDF turns this into a PDF without a heavy PDF dependency).
  const exportText = useCallback(() => {
    const r = buildReport()
    const lines = [
      'karmyogi — machine diagnostics report',
      `Generated: ${r.generatedAt}`,
      '',
      `Connection : ${r.connected ? 'connected' : 'offline'}`,
      `State      : ${r.state}`,
      `Firmware   : ${r.firmware ?? 'unknown'}`,
      `Feed       : ${r.feed} mm/min`,
      `Spindle    : ${r.spindle} rpm`,
      `Buffer     : ${r.buffer ? `${r.buffer.plan} / ${r.buffer.rx}` : '—'}`,
      `Input pins : ${r.pins.length ? r.pins.join(', ') : 'none'}`,
      `Machine pos: X${r.machinePos.x} Y${r.machinePos.y} Z${r.machinePos.z}`,
      `Work pos   : X${r.workPos.x} Y${r.workPos.y} Z${r.workPos.z}`,
    ]
    if (r.job) {
      lines.push('', `Job line   : ${r.job.line} / ${r.job.total} (${r.job.percent}%)`, `Elapsed    : ${fmtDur(r.job.elapsedMs)}`, `ETA        : ${fmtDur(r.job.etaMs)}`)
    }
    download(`karmyogi-diagnostics-${stamp()}.txt`, lines.join('\n'), 'text/plain;charset=utf-8')
  }, [buildReport, download])

  return (
    <section className="mc-section mc-section--bare">
      <div className="teach-section">
        <button
          type="button"
          className="teach-head"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={t('ctrl.diag.head.title', 'Live diagnostics — machine state, feed/spindle, buffer, pins, firmware and job time/ETA')}
        >
          <span className="teach-head-ico">
            <Gauge size={15} aria-hidden="true" />
          </span>
          <span className="teach-head-title">{t('ctrl.diag.head', 'Diagnostics')}</span>
          {streaming && <span className="teach-count">{Math.round(pct)}%</span>}
          <span className="teach-head-ico teach-head-chev">
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </button>

        {open && (
          <div className="teach-body">
            <div className="mc-diag-grid">
              {stat(t('ctrl.diag.state', 'State'), connected ? machineState : t('ctrl.diag.offline', 'Offline'))}
              {stat(t('ctrl.diag.feed', 'Feed'), `${Math.round(feed)} mm/min`)}
              {stat(t('ctrl.diag.spindle', 'Spindle'), `${Math.round(spindle)} rpm`)}
              {stat(
                t('ctrl.diag.buffer', 'Buffer'),
                buffer ? `${buffer.plan} / ${buffer.rx}` : '—',
              )}
              {stat(t('ctrl.diag.pins', 'Input pins'), pinLabel)}
              {stat(t('ctrl.diag.firmware', 'Firmware'), firmware ?? t('ctrl.diag.firmware.unknown', 'unknown'))}
            </div>
            {streaming && (
              <>
                <div className="mc-diag-progress" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
                  <span className="mc-diag-progress-fill" style={{ width: `${pct}%` }} />
                </div>
                <div className="mc-diag-grid">
                  {stat(t('ctrl.diag.line', 'Line'), `${Math.min(cursor + 1, total)} / ${total}`)}
                  {stat(t('ctrl.diag.elapsed', 'Elapsed'), fmtDur(elapsed))}
                  {stat(t('ctrl.diag.eta', 'ETA'), eta > 0 ? fmtDur(eta) : '—')}
                </div>
              </>
            )}
            {/* O9 — one-click report export (JSON for tooling, text for print/PDF). */}
            <div className="mc-diag-export">
              <button
                type="button"
                className="mc-btn mc-btn-lead mc-diag-export-btn"
                onClick={exportJson}
                title={t('ctrl.diag.export.json.title', 'Download a JSON diagnostics report (machine state, position, pins, firmware, job stats)')}
              >
                <Download size={14} aria-hidden="true" />
                <span>{t('ctrl.diag.export.json', 'Export JSON')}</span>
              </button>
              <button
                type="button"
                className="mc-btn mc-btn-lead mc-diag-export-btn"
                onClick={exportText}
                title={t('ctrl.diag.export.text.title', 'Download a printable text report (use the browser’s Print → Save as PDF)')}
              >
                <FileText size={14} aria-hidden="true" />
                <span>{t('ctrl.diag.export.text', 'Export report')}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Controller panel: connection, DRO, jog pad, home/unlock/reset, and
 * feed/rapid/spindle overrides. Touch-friendly and fully keyboard-operable
 * whenever the panel is VISIBLE and you're not typing in a field — no focus on
 * the panel needed (see the key map in onKeyDown / the panel hint).
 */
export function ControllerPanel() {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const mpos = useMachine((s) => s.mpos)
  const wpos = useMachine((s) => s.wpos)
  const feed = useMachine((s) => s.feed)
  const spindle = useMachine((s) => s.spindle)
  const overrides = useMachine((s) => s.overrides)
  const machineState = useMachine((s) => s.state)
  const machineError = useMachine((s) => s.error)
  const buffer = useMachine((s) => s.buffer)
  // Surface machine errors / alarms in the notification BELL (app bar) instead of
  // an inline alert under the DRO. Push once per distinct error transition; the
  // decoded title + fix are translated so the bell entry matches the app language.
  const notifyBell = useNotifications((s) => s.notify)
  const lastErrRef = useRef<string | null>(null)
  useEffect(() => {
    if (machineError && machineError !== lastErrRef.current) {
      const ex = explainGrblMessage(machineError)
      const text = ex
        ? `${t(`grbl.${ex.kind}.${ex.code}.title`, ex.title)} — ${t('ctrl.error.fix', 'Fix: {fix}', {
            fix: t(`grbl.${ex.kind}.${ex.code}.fix`, ex.fix),
          })}`
        : machineError
      notifyBell('error', text)
    }
    lastErrRef.current = machineError
  }, [machineError, notifyBell, t])
  // O9 — live input-pin states (limit/probe/door) reported in GRBL `Pn:` status.
  const pins = useMachine((s) => s.pins)
  // Live per-direction limit state (FluidNC `LS:`); subscribing here re-renders the
  // jog pad whenever a switch trips so the matching direction greys out at once.
  // Read only for that side-effect — the block decision lives in grbl.isJogBlocked.
  const limitDirs = useMachine((s) => s.limitDirs)
  void limitDirs
  // Machine-reported active WCS (from a `$G` parser-state poll). Authoritative
  // when known; falls back to the persisted local guess only when unknown.
  const machineWcs = useMachine((s) => s.activeWcs)
  const units = useSettings((s) => s.units)
  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)
  // O9 — firmware label of the active machine (for the diagnostics report).
  const firmware = useMachines((s) => {
    const m = s.machines.find((e) => e.id === s.activeId)
    if (!m) return null
    return m.firmware
      ? `${m.firmware}${m.firmwareVersion ? ` ${m.firmwareVersion}` : ''}`
      : null
  })

  const connected = connection === 'connected'
  const decimals = units === 'inch' ? 4 : 3
  // Refuse / confirm destructive ops while the machine is doing something.
  const busy = connected && BUSY_STATES.has(machineState)
  // Realtime overrides are meaningless (and ignored) in Alarm/Door — disable
  // them there, but keep them live during Run/Hold (their whole purpose).
  const overridesUsable = connected && machineState !== 'Alarm' && machineState !== 'Door'
  // O12 — motion lockout. A UI safety guard: while LOCKED, every control that
  // commands machine motion (jog pad, go-to-zero, zero, spindle-on, coolant,
  // park, tool-change, start-from-line, gamepad jog) is disabled until the
  // operator explicitly ARMS motion. Persisted so it survives reloads; defaults
  // to locked so a fresh session can't be jogged by an accidental keypress.
  const [locked, setLocked] = usePersistentState('karmyogi.ctrl.locked', true)
  // The single gate the motion controls read instead of bare `connected`.
  const motionEnabled = connected && !locked
  const unitMm = t('ctrl.unit.mm', 'mm')
  const unitMmMin = t('ctrl.unit.mmmin', 'mm/min')
  const unitRpm = t('ctrl.unit.rpm', 'RPM')

  const [step, setStep] = usePersistentState('karmyogi.jog.step', 1)
  const [jogFeed, setJogFeed] = usePersistentState('karmyogi.jog.feed', 1000)
  const [spindleRpm, setSpindleRpm] = usePersistentState('karmyogi.spindle.rpm', 10000)
  const [spindleDir, setSpindleDir] = usePersistentState<'cw' | 'ccw'>('karmyogi.spindle.dir', 'cw')
  // Spindle output mode: 'spindle' = control by RPM (S = rpm); 'pwm' = drive the
  // GRBL board's spindle-PWM pin as a generic PWM signal, set by duty % (S maps
  // to the 0–1000 PWM range). The same M3/M4 + S word carries both.
  const [spindleMode, setSpindleMode] = usePersistentState<'spindle' | 'pwm'>('karmyogi.spindle.mode', 'spindle')
  const [spindlePwm, setSpindlePwm] = usePersistentState('karmyogi.spindle.pwm', 100)
  // Continuous-jog distance is user-configurable (persisted) and capped to the
  // machine's travel so a held jog can't ask GRBL to fly far past the envelope.
  const [contJogMm, setContJogMm] = usePersistentState('karmyogi.jog.continuousMm', 1000)
  // Persisted local guess of the active WCS — only updated by an explicit user
  // selection (and only while connected); the machine's `$G` report wins for the
  // chip highlight so it reflects the REAL active coordinate system.
  const [localWcs, setLocalWcs] = usePersistentState('karmyogi.wcs', 'G54')
  const activeWcs = (machineWcs ?? localWcs) as string
  // Safe-Z retract height (work Z, mm) prepended before any XY return so the tool
  // lifts clear of the work/clamps instead of dragging across them.
  const [safeZ] = usePersistentState('karmyogi.coord.safeZ', DEFAULT_SAFE_Z)
  // Game-controller (Gamepad API): persisted enable flag + modal open state.
  const [gamepadEnabled, setGamepadEnabled] = usePersistentState('karmyogi.gamepad.enabled', false)
  // Remembers an EXPLICIT user "off" so auto-arm-on-connect never fights them.
  const [gpAutoOptOut, setGpAutoOptOut] = usePersistentState('karmyogi.gamepad.autoArmOptOut', false)
  // Haptic (rumble) feedback on machine-state transitions — persisted, default on.
  const [gamepadHaptics, setGamepadHaptics] = usePersistentState('karmyogi.gamepad.haptics', true)
  const [gamepadHapticIntensity, setGamepadHapticIntensity] = usePersistentState('karmyogi.gamepad.hapticIntensity', 1)
  const [gamepadOpen, setGamepadOpen] = useState(false)
  // FluidDial (FluidNC-native dial pendant) UART setup modal.
  const [dialOpen, setDialOpen] = useState(false)
  // W-Q: when an ARMED gamepad is lost (e.g. battery dies / unplugged mid-jog),
  // surface a clear inline notice with how to recover. Presentation only — the
  // jog/disarm safety is handled by useGamepad; this just tells the operator.
  const [gamepadLost, setGamepadLost] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Optimistic spindle-running flag: flip instantly on click for responsive UI,
  // then reconcile from the polled RPM (`spindle`) so it self-corrects if the
  // command didn't take. Starts undefined = "trust the machine".
  const [spindleWanted, setSpindleWanted] = useState<boolean | null>(null)
  const spindleRunning = spindleWanted ?? spindle > 0
  useEffect(() => {
    // Reconcile: once the polled RPM agrees with our optimistic intent (or we
    // have no intent), drop the override and follow the machine.
    if (spindleWanted === null) return
    if (spindleWanted === spindle > 0) setSpindleWanted(null)
  }, [spindle, spindleWanted])
  // A lost connection clears any optimistic intent.
  useEffect(() => {
    if (!connected) setSpindleWanted(null)
  }, [connected])

  const spindleOn = useCallback(() => {
    const cmd = spindleDir === 'ccw' ? 'M4' : 'M3'
    // PWM mode: duty % → S over GRBL's 0–1000 PWM range ($30 default). Spindle
    // mode: S is the RPM directly. Same enable command (M3/M4) either way.
    const s =
      spindleMode === 'pwm'
        ? Math.round((Math.min(100, Math.max(0, spindlePwm)) / 100) * 1000)
        : Math.max(0, Math.round(spindleRpm) || 0)
    void grbl.send(`${cmd} S${s}`)
  }, [spindleRpm, spindlePwm, spindleMode, spindleDir])
  const spindleOff = useCallback(() => void grbl.send('M5'), [])
  // Toggle from the optimistic running flag: running -> stop, stopped -> start.
  const spindleToggle = useCallback(() => {
    // Starting a spindle mid-Run/Alarm is a footgun — only allow OFF then.
    if (spindleRunning) {
      setSpindleWanted(false)
      spindleOff()
      return
    }
    // Starting the spindle while motion is locked out is refused (O12).
    if (busy || locked) return
    setSpindleWanted(true)
    spindleOn()
  }, [spindleRunning, busy, locked, spindleOn, spindleOff])

  // Distance (mm) used for a continuous (held) jog. GRBL feeds this as a long
  // move that we cancel (0x85) on release, so the machine keeps moving only
  // while the button/key is held and stops the instant it's let go. Capped to
  // the largest configured travel axis so a hold can't overrun the envelope.
  const maxTravel = Math.max(bedW, bedD, bedH)
  const continuousJogMm = Math.min(
    CONTINUOUS_JOG_MAX_MM,
    Math.max(1, contJogMm || 0),
    maxTravel > 0 ? maxTravel : CONTINUOUS_JOG_MAX_MM,
  )

  // A single precise step (a tap). Refused while motion is locked out (O12). A tap
  // is one deliberate user action, so it force-sends (bypasses the discrete-jog
  // flood cap) from a freshly-cleared flow-gate — a wedged/ drifted gate can never
  // swallow a press. Rapid tapping is human-paced, so this can't flood the board.
  const doJog = useCallback(
    (delta: JogDelta) => {
      if (!grbl.isConnected || locked) return
      grbl.beginJog()
      void grbl.jog(jogParamsFromDelta(delta, jogFeed), { force: true })
    },
    [jogFeed, locked],
  )

  // A continuous jog (a hold): ONE long `$J=` move in the DIRECTION of the delta so
  // the machine keeps moving for as long as the control is held — the FluidNC/GRBL-
  // native method (fewest commands, gentle on the controller). `delta` may be a
  // non-axis-aligned vector (e.g. the gamepad stick) — only its ANGLE matters, so
  // diagonals stay true. `feed` defaults to the configured jog feed; the analog
  // stick passes its own magnitude-scaled feed. Re-calling with the same heading is
  // a no-op while the move runs (no command thrash); continuousJogMm bounds the move
  // to the travel envelope. Motion continues until cancelJog() flushes it (0x85).
  const doJogHold = useCallback(
    (delta: JogDelta, feed: number = jogFeed) => {
      if (!grbl.isConnected || locked) return
      grbl.startJog(delta, feed, continuousJogMm)
    },
    [jogFeed, continuousJogMm, locked],
  )

  // End any continuous jog and immediately stop / flush in-progress motion (0x85).
  const cancelJog = useCallback(() => {
    grbl.stopJog()
  }, [])

  // Tracks ALL currently-held jog keys (set of e.key) plus a single pending
  // hold-escalation timer. Tracking every held key — not just the last one —
  // is what closes the multi-arrow stuck-motion hole: with one key tracked, a
  // keyup for a key other than the tracked one never cancelled, so a continuous
  // jog could survive after all keys were released. Now a continuous jog is only
  // started/kept while ≥1 jog key is down and is cancelled the instant the LAST
  // one comes up.
  const heldKeys = useRef<Set<string>>(new Set())
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True once a held key has escalated to continuous motion (needs a 0x85 stop).
  const keyContinuous = useRef(false)

  const clearKeyJogTimer = useCallback(() => {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }, [])

  // Hard reset of all keyboard-jog tracking + stop the machine. Used on
  // Escape, blur/visibility loss, and disconnect so no continuous jog can
  // survive losing focus or the window.
  const resetKeyJog = useCallback(() => {
    clearKeyJogTimer()
    const wasMoving = keyContinuous.current || heldKeys.current.size > 0
    heldKeys.current.clear()
    keyContinuous.current = false
    if (wasMoving) cancelJog()
  }, [clearKeyJogTimer, cancelJog])

  // Zero all work axes (G10 L20 P0). Destructive — re-defining the work datum
  // mid-Run/Alarm is dangerous, so confirm when the machine isn't safely Idle.
  const doZeroAll = useCallback(() => {
    if (!grbl.isConnected) return
    if (busy) {
      const ok = window.confirm(
        t(
          'ctrl.zero.confirmBusy',
          'Machine is {state}. Re-zeroing the work origin now can be unsafe. Set X/Y/Z work zero anyway?',
          { state: machineState },
        ),
      )
      if (!ok) return
    }
    void grbl.send('G10 L20 P0 X0 Y0 Z0')
  }, [busy, machineState, t])

  // Select the active work coordinate system (G54–G59). Persist the local guess
  // only while connected; the `$G` poll confirms it from the machine shortly and
  // takes over the chip highlight.
  const selectWcs = useCallback((w: string) => {
    if (!grbl.isConnected) return
    setLocalWcs(w)
    grbl
      .send(w)
      .then(() => grbl.requestParserState().catch(() => {}))
      .catch(() => {})
  }, [setLocalWcs])

  // Zero a single work axis at the current position (G10 L20 P0 <axis>0).
  // Destructive — re-defining the work datum mid-Run/Alarm is dangerous, so
  // confirm when the machine isn't safely Idle.
  const zeroAxis = useCallback(
    (axis: 'X' | 'Y' | 'Z') => {
      if (!grbl.isConnected) return
      if (busy) {
        const ok = window.confirm(
          t('coord.zero.confirmBusy', 'Machine is {state}. Set {axes} work zero anyway?', {
            state: machineState,
            axes: axis,
          }),
        )
        if (!ok) return
      }
      void grbl.send(`G10 L20 P0 ${axis}0`)
    },
    [busy, machineState, t],
  )

  // SAFETY: return to work XY zero, retracting Z to a safe height FIRST so the
  // tool never drags through the workpiece or clamps. Sends the retract and the
  // XY rapid as two lines: `G90 G0 Z<safe>` then `G90 G0 X0 Y0`.
  const goToZero = useCallback(() => {
    if (!grbl.isConnected || locked) return
    const z = Number.isFinite(safeZ) ? safeZ : DEFAULT_SAFE_Z
    if (busy) {
      const ok = window.confirm(
        t('coord.goto.confirmBusy', 'Machine is {state}. Retract Z and rapid to X0 Y0 anyway?', {
          state: machineState,
        }),
      )
      if (!ok) return
    }
    Promise.resolve()
      .then(() => grbl.send(`G90 G0 Z${z}`))
      .then(() => grbl.send('G90 G0 X0 Y0'))
      .catch(() => {})
  }, [busy, machineState, safeZ, locked, t])

  // ---- Game controller (Gamepad API) ----
  // STEP_SIZES drives the LB/RB step-size cycling so it matches the on-screen
  // step buttons (and the keyboard 1–4 keys).
  const stepUp = useCallback(() => {
    const i = STEP_SIZES.indexOf(step)
    setStep(STEP_SIZES[Math.min(STEP_SIZES.length - 1, (i < 0 ? 1 : i) + 1)])
  }, [step, setStep])
  const stepDown = useCallback(() => {
    const i = STEP_SIZES.indexOf(step)
    setStep(STEP_SIZES[Math.max(0, (i < 0 ? 1 : i) - 1)])
  }, [step, setStep])

  // Analog jog from the sticks uses SHORT-INCREMENT continuous jog: the hook calls
  // jogXY/jogZ each due poll while deflected (a small move in the current stick
  // direction that blends with the next in GRBL's planner) and cancelJog (0x85)
  // when the sticks recenter. Unlike the keyboard hold (one long move), the stick
  // tracks live and direction changes need no 0x85 thrash.
  const gamepadHandlers = useRef<GamepadHandlers>({
    jog3: () => {},
    jogXY: () => {},
    jogZ: () => {},
    cancelJog: () => {},
    onAction: () => {},
  })
  gamepadHandlers.current = {
    jog3: (dx, dy, dz, feed) => {
      if (!grbl.isConnected) return
      // Combined X/Y/Z stick vector → ONE continuous `$J=` so all three axes move
      // together (doJogHold preserves the vector angle). A single command means Z
      // and XY never compete for GRBL's one jog slot — the old split jogXY+jogZ
      // issued two moves and Z routinely lost the race / didn't move at all.
      doJogHold({ x: dx, y: dy, z: dz }, feed)
    },
    jogXY: (dx, dy, feed) => {
      if (!grbl.isConnected) return
      // dx,dy is the normalized stick vector; feed is magnitude-scaled. One long
      // continuous move that runs smoothly until the hook re-issues it (on a stick
      // change) or cancels it (on release) — same path as press-and-hold.
      doJogHold({ x: dx, y: dy }, feed)
    },
    jogZ: (dz, feed) => {
      if (!grbl.isConnected) return
      doJogHold({ z: dz }, feed)
    },
    cancelJog,
    onAction: (action: GamepadAction) => {
      // simToggle drives the 3D simulation — no machine needed, so handle it
      // BEFORE the connected guard below.
      if (action === 'simToggle') {
        if (usePlayback.getState().timeline) usePlayback.getState().toggle()
        return
      }
      // tabNav is handled inside the hook (it never reaches a machine action).
      if (action === 'tabNav') return
      if (!grbl.isConnected) return
      switch (action) {
        case 'resume':
          void grbl.resume()
          break
        case 'hold':
          void grbl.feedHold()
          break
        case 'spindle':
          spindleToggle()
          break
        case 'home':
          void grbl.home()
          break
        case 'unlock':
          void grbl.unlock()
          break
        case 'reset':
          void grbl.softReset()
          break
        case 'zero':
          doZeroAll()
          break
        case 'stepUp':
          stepUp()
          break
        case 'stepDown':
          stepDown()
          break
        case 'stepJogXPlus':
          doJog({ x: step })
          break
        case 'stepJogXMinus':
          doJog({ x: -step })
          break
        case 'stepJogYPlus':
          doJog({ y: step })
          break
        case 'stepJogYMinus':
          doJog({ y: -step })
          break
        default:
          break
      }
    },
  }
  // Stable handlers object that always delegates to the latest closures (the
  // hook keeps its own ref; this avoids restarting its rAF loop on re-render).
  const stableGamepadHandlers = useRef<GamepadHandlers>({
    jog3: (dx, dy, dz, feed) => gamepadHandlers.current.jog3(dx, dy, dz, feed),
    jogXY: (dx, dy, feed) => gamepadHandlers.current.jogXY(dx, dy, feed),
    jogZ: (dz, feed) => gamepadHandlers.current.jogZ(dz, feed),
    cancelJog: () => gamepadHandlers.current.cancelJog(),
    onAction: (a) => gamepadHandlers.current.onAction(a),
  })
  // Only actually let the gamepad drive the machine while connected (mirrors the
  // keyboard guard); the modal toggle persists the user's "armed" intent. The
  // options carry the configured max jog feed (for magnitude-scaled analog jog)
  // and the haptics preferences.
  const gp = useGamepad(
    stableGamepadHandlers.current,
    gamepadEnabled && connected,
    { jogFeed, haptics: gamepadHaptics, hapticIntensity: gamepadHapticIntensity },
    setGamepadEnabled,
  )

  // ---- On-element gamepad hint badges + live "operating" highlight (Part A) ----
  // The programmable map (store) drives WHICH control each action shows; the live
  // pad state (gp.buttonsPressed / gp.axes) drives the active highlight. Badges
  // are only rendered while the pad is ARMED + connected (mirrors the keyboard
  // chips, which always show). All reads are cheap and gated, so the per-frame
  // gp state updates don't add meaningful work when the pad is idle/absent.
  // Per-pad bindings for the ACTIVE pad (so badges match the rebound layout).
  const gpStore = useGamepadMap()
  const gpBindings = padBindings(gpStore, gp.padKey)
  const gpHints = gamepadEnabled && gp.connected
  const padFamily: PadFamily = (gp.type as PadFamily) ?? 'xbox'
  // Glyph for an action's bound control (empty when unbound → badge hidden).
  const padGlyph = useCallback(
    (action: GamepadActionId): string => {
      const tok = gpBindings.actions[action] ?? ''
      return tok ? controlGlyph(tok, padFamily) : ''
    },
    [gpBindings, padFamily],
  )
  // Is the control bound to `action` currently pressed/deflected? Drives `.gp-active`.
  // Reads the FULL union (button / axis half / trigger axis) so non-standard pads
  // light up correctly. `gp.buttonsPressed` carries the live pressed flags; axis
  // values come from `gp.axes`. Button analog values aren't needed for highlight.
  const padActive = useCallback(
    (action: GamepadActionId): boolean => {
      if (!gpHints) return false
      const tok = gpBindings.actions[action] ?? ''
      return tokenPressed(tok, gp.buttonsPressed, gp.axes)
    },
    [gpHints, gpBindings, gp.buttonsPressed, gp.axes],
  )
  // Live jog-axis deflection for the jog-pad highlight — read the BOUND jog axes
  // (not fixed indices) so it works on remapped / non-standard pads.
  const anyAnalog = useCallback(
    (toks: string[]): boolean => gpHints && toks.some((tk) => tokenPressed(tk, [], gp.axes, { axisDead: 0.15, triggerThresh: 0.5 })),
    [gpHints, gp.axes],
  )
  const stickXyActive = anyAnalog([
    gpBindings.analog.jogXplus,
    gpBindings.analog.jogXminus,
    gpBindings.analog.jogYplus,
    gpBindings.analog.jogYminus,
  ])
  const stickZActive = anyAnalog([gpBindings.analog.jogZplus, gpBindings.analog.jogZminus])
  // Convenience: class string adding `gp-active` when a control is operating it.
  const gpCls = useCallback(
    (action: GamepadActionId): string => (padActive(action) ? ' gp-active' : ''),
    [padActive],
  )

  // ---- Auto-arm the pad as soon as one is detected ----
  // The operator shouldn't have to open the modal and click "on" — when a gamepad
  // connects we auto-arm it. The ONLY thing that suppresses this is an explicit
  // user "off" (remembered in `gpAutoOptOut`), so we never override a deliberate
  // decision. The modal toggle goes through `armPad`, which keeps that intent.
  const armPad = useCallback(
    (v: boolean) => {
      setGamepadEnabled(v)
      setGpAutoOptOut(!v) // explicit ON clears opt-out; explicit OFF opts out of auto-arm
    },
    [setGamepadEnabled, setGpAutoOptOut],
  )
  useEffect(() => {
    if (gp.connected && !gpAutoOptOut && !gamepadEnabled) setGamepadEnabled(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gp.connected, gpAutoOptOut])

  // ---- Haptic feedback driven off machine-state TRANSITIONS ----
  // Fire a rumble only when state/error CHANGES (not every frame), and only when
  // a pad is connected + control is armed. Feature-detection lives in the hook.
  const prevMachineState = useRef<string | null>(null)
  const prevMachineError = useRef<string | null>(null)
  const prevGamepadConnected = useRef(false)
  useEffect(() => {
    const active = gp.connected && gamepadEnabled
    const prevState = prevMachineState.current
    const prevErr = prevMachineError.current
    const wasConnected = prevGamepadConnected.current
    prevMachineState.current = machineState
    prevMachineError.current = machineError
    prevGamepadConnected.current = gp.connected
    if (!active) return

    // Controller just connected → short single tick.
    if (gp.connected && !wasConnected) gp.rumble('connect')

    // Error appeared (incl. soft-reset surfaced as an error) → sharp double pulse.
    if (machineError && machineError !== prevErr) {
      gp.rumble('error')
      window.setTimeout(() => gp.rumble('error'), 130)
    }

    // State transitions.
    if (prevState !== null && machineState !== prevState) {
      const isLimit = (s: string) => /alarm|limit|door/i.test(s)
      if (isLimit(machineState) && !isLimit(prevState)) {
        // Entered Alarm / limit / door → strong sustained rumble.
        gp.rumble('alarm')
      } else if (machineState === 'Idle' && (prevState === 'Run' || prevState === 'Home')) {
        // Returned to Idle from Run/Home (job / probe complete) → soft tick.
        gp.rumble('idle')
      }
    }
  }, [machineState, machineError, gp, gamepadEnabled])

  // ---- W-Q: gamepad-lost notice ----
  // Raise a recoverable notice when an ARMED controller drops; clear it the
  // moment a controller is back. Only flags a loss that follows a real
  // connection (so it never fires on first mount with no pad).
  const wasGamepadConnectedRef = useRef(false)
  useEffect(() => {
    const wasConnected = wasGamepadConnectedRef.current
    wasGamepadConnectedRef.current = gp.connected
    if (gp.connected) {
      if (gamepadLost) setGamepadLost(false)
      return
    }
    if (wasConnected && gamepadEnabled) setGamepadLost(true)
  }, [gp.connected, gamepadEnabled, gamepadLost])

  // ---- Haptic feedback on NEW notifications ----
  // A controller with a rumble motor buzzes whenever something notable is posted
  // (job done, errors, alarms, update-ready…). `gp.rumble` is a no-op when no pad
  // is attached or haptics are off, so this is always safe to call. We snapshot
  // the current head id at mount (skip the backlog) and only buzz for newer ones.
  const rumbleRef = useRef(gp.rumble)
  rumbleRef.current = gp.rumble
  const lastNotifIdRef = useRef(-1)
  useEffect(() => {
    lastNotifIdRef.current = useNotifications.getState().entries[0]?.id ?? 0
    return useNotifications.subscribe((s) => {
      const top = s.entries[0]
      if (!top || top.id <= lastNotifIdRef.current) return
      lastNotifIdRef.current = top.id
      rumbleRef.current(top.level === 'error' || top.level === 'warn' ? 'error' : 'connect')
    })
  }, [])

  // SAFETY: stop any continuous jog if the window loses focus or is hidden
  // (e.g. holding an arrow key then alt-tabbing) — keyup never fires for the
  // other window, so without this a held jog would run away. Wired at the
  // window level (not the panel) so it fires regardless of focus target.
  useEffect(() => {
    const stop = () => resetKeyJog()
    const onVisibility = () => {
      if (document.hidden) resetKeyJog()
    }
    window.addEventListener('blur', stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [resetKeyJog])

  // A lost connection also clears jog tracking (the machine stopped on its own).
  useEffect(() => {
    if (!connected) resetKeyJog()
  }, [connected, resetKeyJog])

  // Prime the machine's active WCS on connect so the W1–W6 chip resolves promptly
  // (the controller also polls `$G`). While disconnected we never touch the local
  // guess — it's only an offline fallback for the highlight.
  useEffect(() => {
    if (connected) grbl.requestParserState().catch(() => {})
  }, [connected])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!grbl.isConnected) return
      // Don't hijack typing in inputs/selects/editable fields. Check BOTH the
      // event target AND the actually-focused element, and bail whenever focus is
      // inside an open modal/dialog (e.g. the Pick & Place / GRBL settings modals)
      // — so jog/step/spindle keys never steal keystrokes meant for a form field.
      const editable = (n: Element | null): boolean => {
        const h = n as HTMLElement | null
        if (!h) return false
        const tag = h.tagName
        return (
          tag === 'INPUT' ||
          tag === 'SELECT' ||
          tag === 'TEXTAREA' ||
          h.isContentEditable ||
          !!h.closest?.('[role="dialog"], .km-modal')
        )
      }
      if (editable(e.target as Element) || editable(document.activeElement)) return
      // Don't fight browser/OS shortcuts (Ctrl/Meta/Alt combos).
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // 1) Jog (arrows / PageUp / PageDown): tap = precise step, hold =
      //    continuous, release = immediate stop (see onKeyUp).
      const delta = jogKeyToDelta(e.key, step)
      if (delta) {
        e.preventDefault()
        // Ignore OS auto-repeat — otherwise every repeat queues another jog and
        // the machine keeps moving after release. The hold timer drives
        // continuous motion instead.
        if (e.repeat) return
        // Ignore a re-press of an already-held key (defensive).
        if (heldKeys.current.has(e.key)) return
        heldKeys.current.add(e.key)
        // First (real) press: one precise nudge now…
        doJog(delta)
        // …then escalate to continuous if the key stays held. Recompute the
        // delta at fire time so it reflects whatever key remains held.
        clearKeyJogTimer()
        holdTimer.current = setTimeout(() => {
          holdTimer.current = null
          if (heldKeys.current.size === 0) return
          keyContinuous.current = true
          doJogHold(delta)
        }, HOLD_DELAY_MS)
        return
      }

      // 2) Everything else: a single, intentional key per action.
      switch (e.key) {
        // Cancel an in-progress jog.
        case 'Escape':
          e.preventDefault()
          resetKeyJog()
          return
        // Step size 0.1 / 1 / 10 / 100 mm.
        case '1':
          e.preventDefault()
          setStep(STEP_SIZES[0])
          return
        case '2':
          e.preventDefault()
          setStep(STEP_SIZES[1])
          return
        case '3':
          e.preventDefault()
          setStep(STEP_SIZES[2])
          return
        case '4':
          e.preventDefault()
          setStep(STEP_SIZES[3])
          return
        // Machine commands.
        case 'h':
        case 'H':
          e.preventDefault()
          void grbl.home()
          return
        case 'u':
        case 'U':
          e.preventDefault()
          void grbl.unlock()
          return
        case 'r':
        case 'R':
          e.preventDefault()
          void grbl.softReset()
          return
        case '!':
          e.preventDefault()
          void grbl.feedHold()
          return
        case '~':
          e.preventDefault()
          void grbl.resume()
          return
        // Spindle on/off toggle (M3/M4 vs M5).
        case 's':
        case 'S':
          e.preventDefault()
          spindleToggle()
          return
        // Zero all work axes at the current position (G10 L20 P0).
        case 'z':
        case 'Z':
          e.preventDefault()
          doZeroAll()
          return
        // Feed override −/+ 10%.
        case '[':
          e.preventDefault()
          void grbl.realtime(RealtimeByte.FeedOvMinus10)
          return
        case ']':
          e.preventDefault()
          void grbl.realtime(RealtimeByte.FeedOvPlus10)
          return
        // Feed override back to 100%.
        case '\\':
          e.preventDefault()
          void grbl.realtime(RealtimeByte.FeedOvReset)
          return
        default:
          return
      }
    },
    [step, doJog, doJogHold, clearKeyJogTimer, resetKeyJog, setStep, spindleToggle, doZeroAll],
  )

  // Releasing a jog key: drop it from the held set; only when the LAST jog key
  // comes up do we stop motion (0x85) — so multi-arrow diagonal jogs don't get
  // cut short, and no continuous jog can survive all keys being released.
  const onKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (!heldKeys.current.has(e.key)) return
      e.preventDefault()
      heldKeys.current.delete(e.key)
      if (heldKeys.current.size === 0) {
        clearKeyJogTimer()
        keyContinuous.current = false
        // Always cancel: even a quick tap may have queued a jog.
        cancelJog()
      }
    },
    [clearKeyJogTimer, cancelJog],
  )

  // Keyboard machine control works whenever the Controller panel is VISIBLE on
  // screen and the user is NOT typing in a field — NO focus on the panel needed.
  // Listeners live on the window; keydown is gated by panel visibility (so a
  // hidden/background tab can't start a jog), while keyup is ALWAYS processed so
  // a held jog can never survive the key being released. Visibility uses
  // offsetParent (null when dockview display:none-hides an inactive tab).
  useEffect(() => {
    const visible = () => {
      const el = rootRef.current
      return !!el && el.offsetParent !== null
    }
    const kd = (e: KeyboardEvent) => {
      if (visible()) onKeyDown(e)
    }
    const ku = (e: KeyboardEvent) => onKeyUp(e)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
    }
  }, [onKeyDown, onKeyUp])

  const ov = (byte: number) => () => void grbl.realtime(byte)

  return (
    <div
      className="mc-panel"
      ref={rootRef}
      aria-label={t('ctrl.panel.aria', 'Machine controller')}
    >
      <div className="mc-cols">
      {/* DRO — no card chrome / no title: a clean, prominent read-out. */}
      <section className="mc-section mc-section--bare mc-dro--xl">
        {/* (Idle/Run/Hold machine-state badge intentionally omitted per the
            operator's request — the DRO + the error alert below are enough.) */}
        <DroReadout wpos={wpos} mpos={mpos} decimals={decimals} unit={units} />
        {/* Last error (e.g. a mid-job disconnect) — prominent, dismissible only
            by reconnecting / a new action that clears it. O8: any GRBL
            ALARM:/error: code is decoded into a plain-language cause + fix, with
            an inline Unlock for alarm states. */}
        {/* Machine errors / alarms now surface in the NOTIFICATION BELL (app bar)
            via the machineError → notify effect above — no inline alert under the
            DRO. Alarm recovery (Home / Unlock $X / Reset) lives in the recovery
            section below. */}
      </section>

      {/* O12 — Motion lockout. A clear armed/locked guard so jogging/running
          can't happen by accident. While LOCKED the jog pad, go-to-zero,
          spindle-on, coolant, park, tool-change and start-from-line are
          disabled; Home/Unlock/Reset stay available for recovery. */}
      <section className="mc-section mc-section--bare">
        <button
          type="button"
          role="switch"
          aria-checked={!locked}
          className={`mc-lockout${locked ? ' is-locked' : ' is-armed'}`}
          onClick={() => setLocked((v) => !v)}
          title={
            locked
              ? t('ctrl.lockout.locked.title', 'Motion is LOCKED — jog/run are disabled. Click to ARM motion.')
              : t('ctrl.lockout.armed.title', 'Motion is ARMED — jog/run are enabled. Click to LOCK motion.')
          }
        >
          <span className="mc-lockout-ico" aria-hidden="true">
            {locked ? <Lock size={18} /> : <LockOpen size={18} />}
          </span>
          <span className="mc-lockout-text">
            <span className="mc-lockout-title">
              {locked ? t('ctrl.lockout.locked', 'Motion locked') : t('ctrl.lockout.armed', 'Motion armed')}
            </span>
            <span className="mc-lockout-sub">
              {locked
                ? t('ctrl.lockout.locked.sub', 'Jog & run disabled — click to arm')
                : t('ctrl.lockout.armed.sub', 'Jog & run enabled — click to lock')}
            </span>
          </span>
          {locked && <ShieldAlert className="mc-lockout-badge" size={16} aria-hidden="true" />}
        </button>
      </section>

      {/* Machine commands — no card chrome / no title; spacing preserved. */}
      <section className="mc-section mc-section--bare">
        <div className="mc-row mc-row--6">
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('home')}`}
            disabled={!connected}
            onClick={() => void grbl.home()}
            title={t('ctrl.home.title', 'Home — run the homing cycle ($H)')}
            aria-label={t('ctrl.home', 'Home')}
          >
            <HomeIcon />
            <span className="mc-btn-label">{t('ctrl.home', 'Home')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">$H</span>
            {gpHints && <Pad glyph={padGlyph('home')} active={padActive('home')} />}
            <Kbd k="h" />
          </button>
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('unlock')}`}
            disabled={!connected}
            onClick={() => void grbl.unlock()}
            title={t('ctrl.unlock.title', 'Unlock — clear alarm / kill alarm lock ($X)')}
            aria-label={t('ctrl.unlock', 'Unlock')}
          >
            <UnlockIcon />
            <span className="mc-btn-label">{t('ctrl.unlock', 'Unlock')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">$X</span>
            {gpHints && <Pad glyph={padGlyph('unlock')} active={padActive('unlock')} />}
            <Kbd k="u" />
          </button>
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('reset')}`}
            disabled={!connected}
            onClick={() => void grbl.softReset()}
            title={t('ctrl.reset.title', 'Soft reset — abort & reset GRBL (Ctrl-X / 0x18)')}
            aria-label={t('ctrl.reset', 'Reset')}
          >
            <ResetIcon />
            <span className="mc-btn-label">{t('ctrl.reset', 'Reset')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">⌃X</span>
            {gpHints && <Pad glyph={padGlyph('reset')} active={padActive('reset')} />}
            <Kbd k="r" />
          </button>
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('hold')}`}
            disabled={!connected}
            onClick={() => void grbl.feedHold()}
            title={t('ctrl.hold.title', 'Feed hold — pause motion (!)')}
            aria-label={t('ctrl.hold', 'Hold')}
          >
            <PauseIcon />
            <span className="mc-btn-label">{t('ctrl.hold', 'Hold')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">!</span>
            {gpHints && <Pad glyph={padGlyph('hold')} active={padActive('hold')} />}
            <Kbd k="!" />
          </button>
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('resume')}`}
            disabled={!connected}
            onClick={() => void grbl.resume()}
            title={t('ctrl.resume.title', 'Cycle resume — continue (~)')}
            aria-label={t('ctrl.resume', 'Resume')}
          >
            <PlayIcon />
            <span className="mc-btn-label">{t('ctrl.resume', 'Resume')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">~</span>
            {gpHints && <Pad glyph={padGlyph('resume')} active={padActive('resume')} />}
            <Kbd k="~" />
          </button>
          <button
            type="button"
            className={`mc-btn mc-btn-stack has-kbd${gpCls('zero')}`}
            disabled={!connected}
            onClick={doZeroAll}
            title={t('ctrl.zero.title', 'Zero — set the current position as work zero for X, Y and Z (G10 L20 P0)')}
            aria-label={t('ctrl.zero', 'Zero')}
          >
            <AxisZeroIcon />
            <span className="mc-btn-label">{t('ctrl.zero', 'Zero')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">G10</span>
            {gpHints && <Pad glyph={padGlyph('zero')} active={padActive('zero')} />}
            <Kbd k="z" />
          </button>
        </div>
      </section>

      {/* Jog */}
      <section className="mc-section">
        <h4 className="ui-sec-head">{t('ctrl.jog', 'Jog')}</h4>
        <div className="mc-field">
          <span className="mc-label">{t('ctrl.step', 'Step')}</span>
          <span className="mc-seg mc-grow" role="group" aria-label={t('ctrl.step.aria', 'Jog step (mm)')}>
            {STEP_SIZES.map((s, i) => {
              // LB/RB cycle the step DOWN/UP — surface those pad glyphs on the
              // first (−) and last (+) cells so the binding is discoverable.
              const padAction: GamepadActionId | null =
                i === 0 ? 'stepDown' : i === STEP_SIZES.length - 1 ? 'stepUp' : null
              return (
                <button
                  key={s}
                  type="button"
                  className={`has-kbd${step === s ? ' active' : ''}${padAction ? gpCls(padAction) : ''}`}
                  onClick={() => setStep(s)}
                  aria-pressed={step === s}
                  title={t('ctrl.step.btn', 'Jog step {n} mm (key {k})', { n: s, k: i + 1 })}
                >
                  {s}
                  {gpHints && padAction && <Pad glyph={padGlyph(padAction)} active={padActive(padAction)} />}
                  <Kbd k={String(i + 1)} />
                </button>
              )
            })}
          </span>
          <span className="mc-unit">{unitMm}</span>
        </div>
        <SliderField
          label={t('ctrl.feed', 'Feed')}
          title={t(
            'ctrl.jogfeed.row',
            'Jog feed rate ({unit}) — how fast jog moves run. Drag the slider or type a value.',
            { unit: unitMmMin },
          )}
          id="jog-feed"
          value={jogFeed}
          onChange={setJogFeed}
          min={1}
          max={10000}
          step={10}
          unit={unitMmMin}
        />
        <SliderField
          label={t('ctrl.jog.continuous', 'Hold dist')}
          title={t(
            'ctrl.jog.continuous.row',
            'How far a press-and-hold jog travels before repeating — capped to machine travel ({cap} {unit}). Drag the slider or type a value.',
            { cap: Math.round(continuousJogMm), unit: unitMm },
          )}
          id="jog-cont"
          value={contJogMm}
          onChange={setContJogMm}
          min={1}
          max={CONTINUOUS_JOG_MAX_MM}
          step={10}
          unit={unitMm}
        />
        {/* Work coordinate system (G54–G59 → W1–W6): a compact row above the
            jog arrows. The active system is highlighted (machine `$G` report
            wins; falls back to the persisted local guess). */}
        <div className="mc-wcs-row" role="group" aria-label={t('coord.wcs.aria.group', 'Work coordinate system')}>
          {WCS.map((w) => (
            <button
              key={w.code}
              type="button"
              className={`mc-btn coord-wcs-chip${activeWcs === w.code ? ' primary' : ''}`}
              disabled={!connected}
              aria-pressed={activeWcs === w.code}
              aria-label={t('coord.wcs.aria', '{code} work coordinate system', { code: w.code })}
              title={t(w.tk, w.title)}
              onClick={() => selectWcs(w.code)}
            >
              <span className="coord-wcs-label">{w.label}</span>
              <span className="coord-wcs-code" aria-hidden="true">{w.code}</span>
            </button>
          ))}
        </div>
        {/* Jog arrows (XY pad + Z column with Go-to-zero in its center) and, to
            the right, a stacked column of work-offset Zero X/Y/Z buttons. */}
        <div className="mc-jog-row">
          {/* The jog pad is driven by the LEFT STICK / D-pad (XY) and the RIGHT
              STICK / triggers (Z). A tiny pad badge sits at the pad's upper-left
              and lights up while a stick/trigger is deflected (live highlight). */}
          <div className={`pad-host mc-jogpad-host${stickXyActive || stickZActive ? ' gp-active' : ''}`}>
            {gpHints && (
              <Pad
                glyph="L✚"
                active={stickXyActive || stickZActive}
              />
            )}
          <JogPad
            disabled={!motionEnabled}
            step={step}
            onJog={doJog}
            onJogHold={doJogHold}
            onCancel={cancelJog}
            isBlocked={(d) => grbl.isJogBlocked(d)}
            zCenter={
              <button
                type="button"
                className="mc-btn mc-btn-icon mc-goto-zero"
                disabled={!motionEnabled}
                onClick={goToZero}
                aria-label={t('coord.quick.goto', 'Go to zero')}
                title={t('coord.quick.gotoTitle', 'Retract Z to the safe height, then rapid to work zero (X0 Y0)')}
              >
                <GoToZeroIcon size={18} />
              </button>
            }
          />
          </div>
          <div className="mc-zero-col" role="group" aria-label={t('coord.wco.heading', 'Work Offset (WCO)')}>
            {(['X', 'Y', 'Z'] as const).map((ax) => (
              <button
                key={ax}
                type="button"
                className="mc-btn mc-btn-lead mc-zero-btn"
                disabled={!connected}
                onClick={() => zeroAxis(ax)}
                title={t('coord.wco.zeroAxis.title', 'Set the current position as work zero for {axis} (G10 L20 P0)', { axis: ax })}
              >
                <AxisZeroIcon size={15} />
                <span>{t('coord.wco.zeroAxis', 'Zero {axis}', { axis: ax })}</span>
              </button>
            ))}
          </div>
        </div>
        <KbdHelp />
      </section>

      {/* Teach / record-position (F1) — capture jogged positions into a reusable
          named list other workbenches can consume. Collapsible to stay tidy. */}
      <TeachSection
        connected={connected}
        busy={busy}
        machineState={machineState}
        wpos={wpos}
        mpos={mpos}
        decimals={decimals}
        safeZ={safeZ}
      />

      {/* O11 — Coolant outputs + safe Park. */}
      <CoolantParkSection
        motionEnabled={motionEnabled}
        busy={busy}
        machineState={machineState}
        safeZ={safeZ}
      />

      {/* O4 — Tool-change wizard (collapsible). */}
      <ToolChangeSection motionEnabled={motionEnabled} safeZ={safeZ} />

      {/* O5 — Start-from-line / job recovery (collapsible). */}
      <StartFromLineSection motionEnabled={motionEnabled} safeZ={safeZ} />

      {/* O9 — Live diagnostics / run stats (collapsible). */}
      <DiagnosticsSection
        connected={connected}
        machineState={machineState}
        feed={feed}
        spindle={spindle}
        buffer={buffer}
        mpos={mpos}
        wpos={wpos}
        pins={pins.join('')}
        firmware={firmware}
      />

      {/* Spindle (below Jog) */}
      <section className="mc-section">
        <div className="mc-row tight mc-spindle-head">
          {/* iOS/Android-style toggle: ON = spindle on, OFF = spindle off. */}
          <button
            type="button"
            role="switch"
            aria-checked={spindleRunning}
            className={`mc-switch has-kbd${spindleRunning ? ' on' : ''}${gpCls('spindle')}`}
            disabled={!connected || ((busy || locked) && !spindleRunning)}
            onClick={spindleToggle}
            title={
              spindleRunning
                ? t('ctrl.spindle.on.title', 'Spindle is ON — click to stop (M5) · toggle with s')
                : busy
                  ? t('ctrl.spindle.busy.title', 'Machine is {state} — stop it before starting the spindle', { state: machineState })
                  : t('ctrl.spindle.off.title', 'Spindle is OFF — click to start ({cmd}) · toggle with s', {
                      cmd: spindleDir === 'ccw' ? 'M4' : 'M3',
                    })
            }
            aria-label={spindleRunning ? t('ctrl.spindle.on.aria', 'Spindle on (click to stop)') : t('ctrl.spindle.off.aria', 'Spindle off (click to start)')}
          >
            <span className="mc-switch-knob" aria-hidden="true" />
            {gpHints && <Pad glyph={padGlyph('spindle')} active={padActive('spindle')} />}
            <Kbd k="s" />
          </button>
          <SegControl
            className="mc-spindle-mode"
            ariaLabel={t('ctrl.spindle.mode', 'Spindle output mode')}
            size="sm"
            value={spindleMode}
            onChange={setSpindleMode}
            options={[
              {
                value: 'spindle',
                label: t('ctrl.spindle', 'Spindle'),
                title: t('ctrl.spindle.mode.spindle', 'Spindle — set speed in RPM (M3/M4 S<rpm>)'),
              },
              {
                value: 'pwm',
                label: t('ctrl.spindle.pwm', 'PWM'),
                title: t('ctrl.spindle.mode.pwm', 'PWM — drive the GRBL spindle-PWM output as a duty % (S over the 0–1000 PWM range)'),
              },
            ]}
          />
          <span className="mc-grow" />
          <span className="mc-seg mc-spindle-dir" role="group" aria-label={t('ctrl.spindle.dir', 'Spindle direction')}>
            <button
              type="button"
              className={`mc-icon-btn${spindleDir === 'cw' ? ' active' : ''}`}
              disabled={!connected}
              onClick={() => setSpindleDir('cw')}
              aria-pressed={spindleDir === 'cw'}
              aria-label={t('ctrl.spindle.cw.aria', 'Clockwise (M3)')}
              title={t('ctrl.spindle.cw.title', 'Clockwise direction (M3)')}
            >
              <SpindleCwIcon size={16} />
            </button>
            <button
              type="button"
              className={`mc-icon-btn${spindleDir === 'ccw' ? ' active' : ''}`}
              disabled={!connected}
              onClick={() => setSpindleDir('ccw')}
              aria-pressed={spindleDir === 'ccw'}
              aria-label={t('ctrl.spindle.ccw.aria', 'Counter-clockwise (M4)')}
              title={t('ctrl.spindle.ccw.title', 'Counter-clockwise direction (M4)')}
            >
              <SpindleCcwIcon size={16} />
            </button>
          </span>
        </div>
        {spindleMode === 'pwm' ? (
          <div className="mc-field">
            <label className="mc-label" htmlFor="spindle-pwm">{t('ctrl.pwm', 'PWM')}</label>
            <InfoTip
              topic="spindlePwm"
              title={t('ctrl.explain.pwm.title', 'PWM duty (%)')}
              body={t(
                'ctrl.explain.pwm.body',
                'Drives the GRBL board’s spindle-PWM output as a generic PWM signal (for a laser, LED, fan…). The duty % is sent as the S word over GRBL’s 0–1000 PWM range (S = % × 10), enabled with M3/M4 and stopped with M5. A streaming program keeps whatever S values it already contains.',
              )}
            />
            <input
              id="spindle-pwm"
              className="mc-input mc-input-grow"
              type="number"
              min={0}
              max={100}
              step={1}
              value={spindlePwm}
              onChange={(e) => setSpindlePwm(Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              disabled={!connected}
              aria-label={t('ctrl.pwm.aria', 'PWM duty percent')}
              title={t('ctrl.pwm.title', 'PWM duty % — sent as the S word (0–1000) with M3/M4')}
            />
            <span className="mc-unit">{t('ctrl.unit.pct', '%')}</span>
          </div>
        ) : (
          <div className="mc-field">
            <label className="mc-label" htmlFor="spindle-rpm">{t('ctrl.speed', 'Speed')}</label>
            <InfoTip
              topic="spindleRpm"
              title={t('ctrl.explain.spindleRpm.title', 'Spindle speed (RPM)')}
              body={t(
                'ctrl.explain.spindleRpm.body',
                'How fast the cutting tool spins, in turns per minute. Higher speeds suit small bits and soft material; too fast can burn wood or melt plastic, too slow can chip the bit. Follow the bit/material chart, or start moderate.',
              )}
            />
            <input
              id="spindle-rpm"
              className="mc-input mc-input-grow"
              type="number"
              min={0}
              step={1000}
              value={spindleRpm}
              onChange={(e) => setSpindleRpm(Math.max(0, Number(e.target.value) || 0))}
              disabled={!connected}
              aria-label={t('ctrl.speed.aria', 'Spindle speed (RPM)')}
              title={t('ctrl.speed.title', 'Spindle speed in RPM (S word sent with M3/M4)')}
            />
            <span className="mc-unit">{unitRpm}</span>
          </div>
        )}
      </section>

      {/* Overrides */}
      <section className="mc-section">
        <h4 className="ui-sec-head">{t('ctrl.overrides', 'Overrides')}</h4>
        <div className="ov-grid">
          <span className="ov-name">{t('ctrl.feed', 'Feed')}<InfoTip
            topic="feedOverride"
            title={t('ctrl.explain.feedOverride.title', 'Feed override')}
            body={t(
              'ctrl.explain.feedOverride.body',
              'A live dial to speed up or slow down the running job without editing it, shown as a percent of the programmed feed. Turn it down if the cut sounds harsh or struggles; 100% runs at the planned speed. Safe to adjust mid-cut.',
            )}
          /></span>
          <span className="ov-val">{overrides.feed}%</span>
          <button type="button" className="mc-btn mc-btn-icon has-kbd" disabled={!overridesUsable} onClick={ov(RealtimeByte.FeedOvMinus10)} aria-label={t('ctrl.ov.feed.minus', 'Feed override minus 10')} title={t('ctrl.ov.feed.minus.title', 'Feed override −10% (key [)')}><MinusIcon size={15} /><Kbd k="[" /></button>
          <button type="button" className="mc-btn mc-btn-icon has-kbd" disabled={!overridesUsable} onClick={ov(RealtimeByte.FeedOvReset)} aria-label={t('ctrl.ov.feed.reset', 'Feed override reset')} title={t('ctrl.ov.feed.reset.title', 'Feed override reset to 100% (key \\)')}><OvResetIcon size={15} /><Kbd k="\" /></button>
          <button type="button" className="mc-btn mc-btn-icon has-kbd" disabled={!overridesUsable} onClick={ov(RealtimeByte.FeedOvPlus10)} aria-label={t('ctrl.ov.feed.plus', 'Feed override plus 10')} title={t('ctrl.ov.feed.plus.title', 'Feed override +10% (key ])')}><PlusIcon size={15} /><Kbd k="]" /></button>

          <span className="ov-name">{t('ctrl.rapid', 'Rapid')}<InfoTip
            topic="rapidOverride"
            title={t('ctrl.explain.rapidOverride.title', 'Rapid override')}
            body={t(
              'ctrl.explain.rapidOverride.body',
              'A live control for how fast the NON-cutting (travel) moves go, as a percent of full speed. Lower it (25% or 50%) when testing a new job so fast moves are easy to watch and stop. 100% is full travel speed.',
            )}
          /></span>
          <span className="ov-val">{overrides.rapid}%</span>
          <button type="button" className="mc-btn" disabled={!overridesUsable} onClick={ov(RealtimeByte.RapidOv25)} aria-label={t('ctrl.ov.rapid.25', 'Rapid override 25 percent')} title={t('ctrl.ov.rapid.25.title', 'Rapid override 25%')}>25</button>
          <button type="button" className="mc-btn" disabled={!overridesUsable} onClick={ov(RealtimeByte.RapidOv50)} aria-label={t('ctrl.ov.rapid.50', 'Rapid override 50 percent')} title={t('ctrl.ov.rapid.50.title', 'Rapid override 50%')}>50</button>
          <button type="button" className="mc-btn" disabled={!overridesUsable} onClick={ov(RealtimeByte.RapidOvReset)} aria-label={t('ctrl.ov.rapid.100', 'Rapid override 100 percent')} title={t('ctrl.ov.rapid.100.title', 'Rapid override 100% (full speed)')}>100</button>

          <span className="ov-name">{t('ctrl.spindle', 'Spindle')}<InfoTip
            topic="spindleOverride"
            title={t('ctrl.explain.spindleOverride.title', 'Spindle override')}
            body={t(
              'ctrl.explain.spindleOverride.body',
              'A live dial to raise or lower the spinning speed while the job runs, as a percent of the programmed RPM. Nudge it down if the material burns, up if the bit bogs down. 100% runs at the planned speed.',
            )}
          /></span>
          <span className="ov-val">{overrides.spindle}%</span>
          <button type="button" className="mc-btn mc-btn-icon" disabled={!overridesUsable} onClick={ov(RealtimeByte.SpindleOvMinus10)} aria-label={t('ctrl.ov.spindle.minus', 'Spindle override minus 10')} title={t('ctrl.ov.spindle.minus.title', 'Spindle override −10%')}><MinusIcon size={15} /></button>
          <button type="button" className="mc-btn mc-btn-icon" disabled={!overridesUsable} onClick={ov(RealtimeByte.SpindleOvReset)} aria-label={t('ctrl.ov.spindle.reset', 'Spindle override reset')} title={t('ctrl.ov.spindle.reset.title', 'Spindle override reset to 100%')}><OvResetIcon size={15} /></button>
          <button type="button" className="mc-btn mc-btn-icon" disabled={!overridesUsable} onClick={ov(RealtimeByte.SpindleOvPlus10)} aria-label={t('ctrl.ov.spindle.plus', 'Spindle override plus 10')} title={t('ctrl.ov.spindle.plus.title', 'Spindle override +10%')}><PlusIcon size={15} /></button>
        </div>
        <div className="mc-row">
          <span className="mc-label">{t('ctrl.feed.live', 'Feed {n} mm/min', { n: Math.round(feed) })}</span>
          <span className="mc-grow" />
          <span className="mc-label">{t('ctrl.spindle.live', 'Spindle {n} rpm', { n: Math.round(spindle) })}</span>
        </div>
      </section>

      {/* Game controller — big full-width launcher into the mapping/setup modal. */}
      <section className="mc-section mc-gamepad-section">
        {/* W-Q: controller lost while armed — tell the operator how to recover. */}
        {gamepadLost && !gp.connected && (
          <div className="mc-gp-lost">
            <CamError
              icon={<Gamepad2 size={20} aria-hidden="true" />}
              title={t('ctrl.gamepad.lost.title', 'Controller disconnected')}
              message={t(
                'ctrl.gamepad.lost.msg',
                'The gamepad dropped (battery, cable or pairing). Any jog has stopped — reconnect or wake the controller and press any button to resume.',
              )}
              action={
                <button type="button" onClick={() => setGamepadLost(false)}>
                  {t('ctrl.gamepad.lost.dismiss', 'Dismiss')}
                </button>
              }
            />
          </div>
        )}
        <button
          type="button"
          className="mc-btn gp-launch"
          onClick={() => setGamepadOpen(true)}
          aria-haspopup="dialog"
          title={t('ctrl.gamepad.title', 'Game controller — jog and operate the machine with an Xbox / PlayStation / USB gamepad')}
        >
          <Gamepad2 size={22} aria-hidden="true" />
          <span className="gp-launch-text">
            <span className="gp-launch-title">{t('ctrl.gamepad', 'Game controller')}</span>
            <span className="gp-launch-sub">
              {gp.connected
                ? gamepadEnabled && connected
                  ? t('ctrl.gamepad.active', 'Active — {name}', { name: gp.id ?? '' })
                  : t('ctrl.gamepad.ready', 'Ready — {name}', { name: gp.id ?? '' })
                : t('ctrl.gamepad.none', 'Not connected')}
            </span>
          </span>
          {gp.connected && (
            <span className={`gp-launch-dot${gamepadEnabled && connected ? ' on' : ''}`} aria-hidden="true" />
          )}
        </button>
      </section>

      {/* FluidDial pendant — a FluidNC-native encoder+display dial wired to the
          controller's UART (RX/TX). This launcher configures that UART channel in
          the controller's config.yaml (FluidNC only). Sits directly under the
          game-controller launcher as a second "physical control" option. */}
      <section className="mc-section mc-gamepad-section">
        <button
          type="button"
          className="mc-btn gp-launch"
          onClick={() => setDialOpen(true)}
          aria-haspopup="dialog"
          disabled={!connected}
          title={t('ctrl.fluiddial.title', 'FluidDial pendant — set up the FluidNC UART (RX/TX) the dial connects to')}
        >
          <Disc3 size={22} aria-hidden="true" />
          <span className="gp-launch-text">
            <span className="gp-launch-title">{t('ctrl.fluiddial', 'FluidDial pendant')}</span>
            <span className="gp-launch-sub">
              {!connected
                ? t('ctrl.fluiddial.disconnected', 'Connect a FluidNC controller')
                : grbl.isFluidNC
                  ? t('ctrl.fluiddial.ready', 'Set up the RX/TX UART channel')
                  : t('ctrl.fluiddial.notfluidnc', 'FluidNC controllers only')}
            </span>
          </span>
        </button>
      </section>
      </div>

      <FluidDialModal open={dialOpen} onClose={() => setDialOpen(false)} />

      <GamepadModal
        open={gamepadOpen}
        onClose={() => setGamepadOpen(false)}
        gp={gp}
        armed={gamepadEnabled}
        setArmed={armPad}
        machineConnected={connected}
        haptics={gamepadHaptics}
        setHaptics={setGamepadHaptics}
        hapticIntensity={gamepadHapticIntensity}
        setHapticIntensity={setGamepadHapticIntensity}
      />

      {/* The big corner HUD overlays were removed — gamepad hints now live ON each
          mapped element (tiny upper-left pad glyph + the upper-right keyboard
          chip) with a live `.gp-active` highlight while a control operates it.
          The tab-switch overlay below still appears in tab-nav mode. */}
      {gp.tabNavMode && (
        <div className="gp-tabnav" role="status" aria-live="polite">
          <div className="gp-tabnav-card">
            <span className="gp-tabnav-title">
              {t('gp.tabnav.title', 'Switch tab')}
            </span>
            <div className="gp-tabnav-list">
              {openTabs().map((id) => {
                const spec = availablePanels.find((p) => p.id === id)
                const label = t('tab.' + id, spec?.title ?? id)
                return (
                  <span
                    key={id}
                    className={`gp-tabnav-item${id === gp.activeTab ? ' is-active' : ''}`}
                  >
                    {label}
                  </span>
                )
              })}
            </div>
            <span className="gp-tabnav-hint">
              {t('gp.tabnav.hint', '◀ ▶ / LB RB switch · A select · L3 close')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
