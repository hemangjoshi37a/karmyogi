import { useCallback, useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { RealtimeByte } from '../serial'
import { useMachine, useSettings, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { DroReadout } from '../components/DroReadout'
import { JogPad, jogKeyToDelta, jogParamsFromDelta, HOLD_DELAY_MS, type JogDelta } from '../components/JogPad'
import { HomeIcon, UnlockIcon, ResetIcon, PauseIcon, PlayIcon, SpindleCwIcon, SpindleCcwIcon, AxisZeroIcon, PlusIcon, MinusIcon, OvResetIcon } from '../components/MachineIcons'
import { InfoTip } from '../components/InfoTip'
import { useT } from '../i18n'
import '../styles/controller.css'

const STEP_SIZES = [0.1, 1, 10, 100]
/** Largest continuous-jog distance (mm) we'll ever feed, regardless of travel. */
const CONTINUOUS_JOG_MAX_MM = 2000
/** Machine states in which destructive commands (Zero) must be confirmed / refused. */
const BUSY_STATES = new Set(['Run', 'Hold', 'Jog', 'Home', 'Alarm', 'Door'])

/** Tiny, barely-visible corner badge showing a button's keyboard shortcut. */
function Kbd({ k }: { k: string }) {
  return (
    <span className="kbd-hint" aria-hidden="true">
      {k}
    </span>
  )
}

/**
 * Controller panel: connection, DRO, jog pad, home/unlock/reset, and
 * feed/rapid/spindle overrides. Touch-friendly and fully keyboard-operable when
 * the panel is focused (see the key map in onKeyDown / the panel hint).
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

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!grbl.isConnected) return
      // Don't hijack typing in inputs/selects.
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
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
    (e: React.KeyboardEvent) => {
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

  // Stop motion if focus actually LEAVES the panel (tab/click away) while a key
  // jog is active — complements the window-level blur handler above. Ignore
  // internal focus moves (button → button) so they don't cancel a held jog.
  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
      resetKeyJog()
    },
    [resetKeyJog],
  )

  const ov = (byte: number) => () => void grbl.realtime(byte)

  return (
    <div
      className="mc-panel"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={onBlur}
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
          <span className="mc-label">{t('ctrl.step', 'Step')}<InfoTip
            topic="jogStep"
            title={t('ctrl.explain.jogStep.title', 'Jog step')}
            body={t(
              'ctrl.explain.jogStep.body',
              'How far the machine moves each time you tap a jog (arrow) button — for example 0.1, 1, or 10 mm. Big steps move quickly across the table; small steps let you nudge precisely. Use small steps near the workpiece.',
            )}
          /></span>
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
        <div className="mc-field">
          <label className="mc-label" htmlFor="jog-feed">{t('ctrl.feed', 'Feed')}</label>
          <InfoTip
            topic="feedRate"
            title={t('ctrl.explain.feedRate.title', 'Feed rate')}
            body={t(
              'ctrl.explain.feedRate.body',
              'The speed the tool moves through the material while cutting, in mm per minute. Higher is faster but harder on the bit; lower is slower and cleaner. Start conservative and increase only if the cut stays smooth.',
            )}
          />
          <input
            id="jog-feed"
            className="mc-input mc-input-grow"
            type="number"
            min={1}
            step={50}
            value={jogFeed}
            onChange={(e) => setJogFeed(Math.max(1, Number(e.target.value) || 0))}
            aria-label={t('ctrl.jogfeed.aria', 'Jog feed rate (mm/min)')}
            title={t('ctrl.jogfeed.title', 'Jog feed rate (mm/min) — speed of jog moves')}
          />
          <span className="mc-unit">{unitMmMin}</span>
        </div>
        <div className="mc-field">
          <label className="mc-label" htmlFor="jog-cont">{t('ctrl.jog.continuous', 'Hold dist')}</label>
          <InfoTip
            topic="jogContinuous"
            title={t('ctrl.explain.jogCont.title', 'Continuous jog distance')}
            body={t(
              'ctrl.explain.jogCont.body',
              'How far a press-and-hold jog travels before it must be repeated. The machine keeps moving only while held and stops the instant you let go; this value is capped to the configured machine travel so a hold can never fly far past the bed.',
            )}
          />
          <input
            id="jog-cont"
            className="mc-input mc-input-grow"
            type="number"
            min={1}
            step={50}
            value={contJogMm}
            onChange={(e) => setContJogMm(Math.max(1, Number(e.target.value) || 0))}
            aria-label={t('ctrl.jog.continuous.aria', 'Continuous (hold) jog distance (mm)')}
            title={t('ctrl.jog.continuous.title', 'Distance a held jog travels — capped to machine travel ({cap} {unit})', { cap: Math.round(continuousJogMm), unit: unitMm })}
          />
          <span className="mc-unit">{unitMm}</span>
        </div>
        <JogPad disabled={!connected} step={step} onJog={doJog} onJogHold={doJogHold} onCancel={cancelJog} />
        <span className="mc-hint">
          {t(
            'ctrl.kbd.hint',
            'Fully keyboard-operable when focused: arrows jog XY · PgUp/PgDn jog Z · Esc cancels · 1–4 step size · h Home · u Unlock · r Reset · ! Hold · ~ Resume · s Spindle · z Zero · [ ] feed ∓ · \\ feed 100%',
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
