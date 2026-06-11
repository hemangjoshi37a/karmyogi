import { useCallback, useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { RealtimeByte } from '../serial'
import { useMachine, useSettings, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { DroReadout } from '../components/DroReadout'
import { JogPad, jogKeyToDelta, jogParamsFromDelta, HOLD_DELAY_MS, type JogDelta } from '../components/JogPad'
import { HomeIcon, UnlockIcon, ResetIcon, PauseIcon, PlayIcon, SpindleCwIcon, SpindleCcwIcon, AxisZeroIcon, GoToZeroIcon, PlusIcon, MinusIcon, OvResetIcon } from '../components/MachineIcons'
import { InfoTip } from '../components/InfoTip'
import { useT } from '../i18n'
import '../styles/controller.css'

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

/** Tiny, barely-visible corner badge showing a button's keyboard shortcut. */
function Kbd({ k }: { k: string }) {
  return (
    <span className="kbd-hint" aria-hidden="true">
      {k}
    </span>
  )
}

/**
 * Compact Adobe-style numeric control: a slider you can DRAG plus a small number
 * input you can TYPE into — both synced and clamped to [min, max]. The whole row
 * carries one explanatory `title` tooltip (replacing the per-field ⓘ icon).
 */
function SliderField(props: {
  label: string
  rowTitle: string
  inputId: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  unit: string
  ariaLabel: string
}) {
  const { label, rowTitle, inputId, value, onChange, min, max, step, unit, ariaLabel } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  return (
    <div className="mc-field mc-sliderfield" title={rowTitle}>
      <label className="mc-label" htmlFor={inputId}>
        {label}
      </label>
      <input
        type="range"
        className="mc-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={ariaLabel}
        tabIndex={-1}
      />
      <input
        id={inputId}
        type="number"
        className="mc-input mc-slider-num"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(clamp(Number(e.target.value) || 0))}
        aria-label={ariaLabel}
      />
      <span className="mc-unit">{unit}</span>
    </div>
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
  // Machine-reported active WCS (from a `$G` parser-state poll). Authoritative
  // when known; falls back to the persisted local guess only when unknown.
  const machineWcs = useMachine((s) => s.activeWcs)
  const units = useSettings((s) => s.units)
  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)

  const connected = connection === 'connected'
  const decimals = units === 'inch' ? 4 : 3
  // Refuse / confirm destructive ops while the machine is doing something.
  const busy = connected && BUSY_STATES.has(machineState)
  // Realtime overrides are meaningless (and ignored) in Alarm/Door — disable
  // them there, but keep them live during Run/Hold (their whole purpose).
  const overridesUsable = connected && machineState !== 'Alarm' && machineState !== 'Door'
  const unitMm = t('ctrl.unit.mm', 'mm')
  const unitMmMin = t('ctrl.unit.mmmin', 'mm/min')
  const unitRpm = t('ctrl.unit.rpm', 'RPM')

  const [step, setStep] = usePersistentState('karmyogi.jog.step', 1)
  const [jogFeed, setJogFeed] = usePersistentState('karmyogi.jog.feed', 1000)
  const [spindleRpm, setSpindleRpm] = usePersistentState('karmyogi.spindle.rpm', 10000)
  const [spindleDir, setSpindleDir] = usePersistentState<'cw' | 'ccw'>('karmyogi.spindle.dir', 'cw')
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
    const rpm = Math.max(0, Math.round(spindleRpm) || 0)
    const cmd = spindleDir === 'ccw' ? 'M4' : 'M3'
    void grbl.send(`${cmd} S${rpm}`)
  }, [spindleRpm, spindleDir])
  const spindleOff = useCallback(() => void grbl.send('M5'), [])
  // Toggle from the optimistic running flag: running -> stop, stopped -> start.
  const spindleToggle = useCallback(() => {
    // Starting a spindle mid-Run/Alarm is a footgun — only allow OFF then.
    if (spindleRunning) {
      setSpindleWanted(false)
      spindleOff()
      return
    }
    if (busy) return
    setSpindleWanted(true)
    spindleOn()
  }, [spindleRunning, busy, spindleOn, spindleOff])

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

  // A single precise step (a tap).
  const doJog = useCallback(
    (delta: JogDelta) => {
      if (!grbl.isConnected) return
      void grbl.jog(jogParamsFromDelta(delta, jogFeed))
    },
    [jogFeed],
  )

  // A continuous jog (a hold): jog a large distance in the sign of each nonzero
  // axis. Motion continues until cancelJog() (0x85) flushes it.
  const doJogHold = useCallback(
    (delta: JogDelta) => {
      if (!grbl.isConnected) return
      const big: JogDelta = {}
      if (delta.x) big.x = Math.sign(delta.x) * continuousJogMm
      if (delta.y) big.y = Math.sign(delta.y) * continuousJogMm
      if (delta.z) big.z = Math.sign(delta.z) * continuousJogMm
      // The continuous hold is a single intentional move that stops on release
      // (0x85); force it past the discrete-jog flood cap.
      void grbl.jog(jogParamsFromDelta(big, jogFeed), { force: true })
    },
    [jogFeed, continuousJogMm],
  )

  // Immediately stop / flush any in-progress jog (GRBL 0x85).
  const cancelJog = useCallback(() => {
    void grbl.jogCancel()
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
    if (!grbl.isConnected) return
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
  }, [busy, machineState, safeZ, t])

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
      // Don't hijack typing in inputs/selects/editable fields.
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return
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
            by reconnecting / a new action that clears it. */}
        {machineError && (
          <div className="mc-error" role="alert">
            {machineError}
          </div>
        )}
      </section>

      {/* Machine commands — no card chrome / no title; spacing preserved. */}
      <section className="mc-section mc-section--bare">
        <div className="mc-row mc-row--6">
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.home()}
            title={t('ctrl.home.title', 'Home — run the homing cycle ($H)')}
            aria-label={t('ctrl.home', 'Home')}
          >
            <HomeIcon />
            <span className="mc-btn-label">{t('ctrl.home', 'Home')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">$H</span>
            <Kbd k="h" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.unlock()}
            title={t('ctrl.unlock.title', 'Unlock — clear alarm / kill alarm lock ($X)')}
            aria-label={t('ctrl.unlock', 'Unlock')}
          >
            <UnlockIcon />
            <span className="mc-btn-label">{t('ctrl.unlock', 'Unlock')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">$X</span>
            <Kbd k="u" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.softReset()}
            title={t('ctrl.reset.title', 'Soft reset — abort & reset GRBL (Ctrl-X / 0x18)')}
            aria-label={t('ctrl.reset', 'Reset')}
          >
            <ResetIcon />
            <span className="mc-btn-label">{t('ctrl.reset', 'Reset')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">⌃X</span>
            <Kbd k="r" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.feedHold()}
            title={t('ctrl.hold.title', 'Feed hold — pause motion (!)')}
            aria-label={t('ctrl.hold', 'Hold')}
          >
            <PauseIcon />
            <span className="mc-btn-label">{t('ctrl.hold', 'Hold')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">!</span>
            <Kbd k="!" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.resume()}
            title={t('ctrl.resume.title', 'Cycle resume — continue (~)')}
            aria-label={t('ctrl.resume', 'Resume')}
          >
            <PlayIcon />
            <span className="mc-btn-label">{t('ctrl.resume', 'Resume')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">~</span>
            <Kbd k="~" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={doZeroAll}
            title={t('ctrl.zero.title', 'Zero — set the current position as work zero for X, Y and Z (G10 L20 P0)')}
            aria-label={t('ctrl.zero', 'Zero')}
          >
            <AxisZeroIcon />
            <span className="mc-btn-label">{t('ctrl.zero', 'Zero')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">G10</span>
            <Kbd k="z" />
          </button>
        </div>
      </section>

      {/* Jog */}
      <section className="mc-section">
        <h4>{t('ctrl.jog', 'Jog')}</h4>
        <div className="mc-field">
          <span className="mc-label">{t('ctrl.step', 'Step')}</span>
          <span className="mc-seg mc-grow" role="group" aria-label={t('ctrl.step.aria', 'Jog step (mm)')}>
            {STEP_SIZES.map((s, i) => (
              <button
                key={s}
                type="button"
                className={`has-kbd${step === s ? ' active' : ''}`}
                onClick={() => setStep(s)}
                aria-pressed={step === s}
                title={t('ctrl.step.btn', 'Jog step {n} mm (key {k})', { n: s, k: i + 1 })}
              >
                {s}
                <Kbd k={String(i + 1)} />
              </button>
            ))}
          </span>
          <span className="mc-unit">{unitMm}</span>
        </div>
        <SliderField
          label={t('ctrl.feed', 'Feed')}
          rowTitle={t(
            'ctrl.jogfeed.row',
            'Jog feed rate ({unit}) — how fast jog moves run. Drag the slider or type a value.',
            { unit: unitMmMin },
          )}
          inputId="jog-feed"
          value={jogFeed}
          onChange={setJogFeed}
          min={1}
          max={10000}
          step={10}
          unit={unitMmMin}
          ariaLabel={t('ctrl.jogfeed.aria', 'Jog feed rate (mm/min)')}
        />
        <SliderField
          label={t('ctrl.jog.continuous', 'Hold dist')}
          rowTitle={t(
            'ctrl.jog.continuous.row',
            'How far a press-and-hold jog travels before repeating — capped to machine travel ({cap} {unit}). Drag the slider or type a value.',
            { cap: Math.round(continuousJogMm), unit: unitMm },
          )}
          inputId="jog-cont"
          value={contJogMm}
          onChange={setContJogMm}
          min={1}
          max={CONTINUOUS_JOG_MAX_MM}
          step={10}
          unit={unitMm}
          ariaLabel={t('ctrl.jog.continuous.aria', 'Continuous (hold) jog distance (mm)')}
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
          <JogPad
            disabled={!connected}
            step={step}
            onJog={doJog}
            onJogHold={doJogHold}
            onCancel={cancelJog}
            zCenter={
              <button
                type="button"
                className="mc-btn mc-btn-icon mc-goto-zero"
                disabled={!connected}
                onClick={goToZero}
                aria-label={t('coord.quick.goto', 'Go to zero')}
                title={t('coord.quick.gotoTitle', 'Retract Z to the safe height, then rapid to work zero (X0 Y0)')}
              >
                <GoToZeroIcon size={18} />
              </button>
            }
          />
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
        <span className="mc-hint">
          {t(
            'ctrl.kbd.hint',
            'Keyboard control whenever this panel is visible (and you are not typing): arrows jog XY · PgUp/PgDn jog Z · Esc cancels · 1–4 step size · h Home · u Unlock · r Reset · ! Hold · ~ Resume · s Spindle · z Zero · [ ] feed ∓ · \\ feed 100%',
          )}
        </span>
      </section>

      {/* Spindle (below Jog) */}
      <section className="mc-section">
        <div className="mc-row tight mc-spindle-head">
          {/* iOS/Android-style toggle: ON = spindle on, OFF = spindle off. */}
          <button
            type="button"
            role="switch"
            aria-checked={spindleRunning}
            className={`mc-switch has-kbd${spindleRunning ? ' on' : ''}`}
            disabled={!connected || (busy && !spindleRunning)}
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
            <Kbd k="s" />
          </button>
          <h4 className="mc-spindle-title">{t('ctrl.spindle', 'Spindle')}</h4>
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
      </section>

      {/* Overrides */}
      <section className="mc-section">
        <h4>{t('ctrl.overrides', 'Overrides')}</h4>
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
      </div>
    </div>
  )
}
