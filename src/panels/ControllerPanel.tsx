import { useCallback, useRef } from 'react'
import { grbl } from '../serial/controller'
import { RealtimeByte } from '../serial'
import { useMachine, useSettings, usePersistentState } from '../store'
import { DroReadout } from '../components/DroReadout'
import { JogPad, jogKeyToDelta, jogParamsFromDelta, HOLD_DELAY_MS, type JogDelta } from '../components/JogPad'
import { HomeIcon, UnlockIcon, ResetIcon, PauseIcon, PlayIcon, SpindleCwIcon, SpindleCcwIcon } from '../components/MachineIcons'
import { InfoTip } from '../components/InfoTip'
import { useT } from '../i18n'
import '../styles/controller.css'

const STEP_SIZES = [0.1, 1, 10, 100]

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
  const units = useSettings((s) => s.units)

  const connected = connection === 'connected'
  const decimals = units === 'inch' ? 4 : 3

  const [step, setStep] = usePersistentState('karmyogi.jog.step', 1)
  const [jogFeed, setJogFeed] = usePersistentState('karmyogi.jog.feed', 1000)
  const [spindleRpm, setSpindleRpm] = usePersistentState('karmyogi.spindle.rpm', 10000)
  const [spindleDir, setSpindleDir] = usePersistentState<'cw' | 'ccw'>('karmyogi.spindle.dir', 'cw')
  const rootRef = useRef<HTMLDivElement>(null)

  const spindleOn = useCallback(() => {
    const rpm = Math.max(0, Math.round(spindleRpm) || 0)
    const cmd = spindleDir === 'ccw' ? 'M4' : 'M3'
    void grbl.send(`${cmd} S${rpm}`)
  }, [spindleRpm, spindleDir])
  const spindleOff = useCallback(() => void grbl.send('M5'), [])
  // Toggle from the live spindle RPM: running -> stop, stopped -> start.
  const spindleToggle = useCallback(() => {
    if (spindle > 0) spindleOff()
    else spindleOn()
  }, [spindle, spindleOn, spindleOff])

  // Distance (mm) used for a continuous (held) jog. GRBL feeds this as a long
  // move that we cancel (0x85) on release, so the machine keeps moving only
  // while the button/key is held and stops the instant it's let go.
  const CONTINUOUS_JOG_MM = 1000

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
      if (delta.x) big.x = Math.sign(delta.x) * CONTINUOUS_JOG_MM
      if (delta.y) big.y = Math.sign(delta.y) * CONTINUOUS_JOG_MM
      if (delta.z) big.z = Math.sign(delta.z) * CONTINUOUS_JOG_MM
      void grbl.jog(jogParamsFromDelta(big, jogFeed))
    },
    [jogFeed],
  )

  // Immediately stop / flush any in-progress jog (GRBL 0x85).
  const cancelJog = useCallback(() => {
    void grbl.jogCancel()
  }, [])

  // Tracks a keyboard-held jog: its delta + the pending hold-escalation timer.
  // Assumes one direction is held at a time (good enough for keyboard jogging).
  const keyJog = useRef<{ key: string; timer: ReturnType<typeof setTimeout> | null } | null>(null)

  const clearKeyJogTimer = useCallback(() => {
    if (keyJog.current?.timer) {
      clearTimeout(keyJog.current.timer)
      keyJog.current.timer = null
    }
  }, [])

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
        // First (real) press: one precise nudge now…
        doJog(delta)
        // …then escalate to continuous if the key stays held.
        clearKeyJogTimer()
        const timer = setTimeout(() => {
          if (keyJog.current) keyJog.current.timer = null
          doJogHold(delta)
        }, HOLD_DELAY_MS)
        keyJog.current = { key: e.key, timer }
        return
      }

      // 2) Everything else: a single, intentional key per action.
      switch (e.key) {
        // Cancel an in-progress jog.
        case 'Escape':
          e.preventDefault()
          clearKeyJogTimer()
          keyJog.current = null
          cancelJog()
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
    [step, doJog, doJogHold, cancelJog, clearKeyJogTimer, setStep, spindleToggle],
  )

  // Releasing a jog key: cancel the pending hold-escalation and stop motion at
  // once (0x85). Without this, a held key would keep the machine moving forever.
  const onKeyUp = useCallback(
    (e: React.KeyboardEvent) => {
      if (jogKeyToDelta(e.key, step) && keyJog.current?.key === e.key) {
        e.preventDefault()
        clearKeyJogTimer()
        keyJog.current = null
        cancelJog()
      }
    },
    [step, clearKeyJogTimer, cancelJog],
  )

  const ov = (byte: number) => () => void grbl.realtime(byte)

  return (
    <div
      className="mc-panel"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      aria-label={t('ctrl.panel.aria', 'Machine controller')}
    >
      <div className="mc-cols">
      {/* DRO — no card chrome / no title: a clean, prominent read-out. */}
      <section className="mc-section mc-section--bare mc-dro--xl">
        <DroReadout wpos={wpos} mpos={mpos} decimals={decimals} unit={units} />
      </section>

      {/* Machine commands — no card chrome / no title; spacing preserved. */}
      <section className="mc-section mc-section--bare">
        <div className="mc-row">
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
        </div>
      </section>

      {/* Jog */}
      <section className="mc-section">
        <h4>{t('ctrl.jog', 'Jog')}</h4>
        <div className="mc-field">
          <span className="mc-label">{t('ctrl.step', 'Step')}<InfoTip topic="jogStep" /></span>
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
          <span className="mc-unit">mm</span>
        </div>
        <div className="mc-field">
          <label className="mc-label" htmlFor="jog-feed">{t('ctrl.feed', 'Feed')}</label>
          <InfoTip topic="feedRate" />
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
          <span className="mc-unit">mm/min</span>
        </div>
        <JogPad disabled={!connected} step={step} onJog={doJog} onJogHold={doJogHold} onCancel={cancelJog} />
        <span className="mc-hint">
          {t(
            'ctrl.kbd.hint',
            'Fully keyboard-operable when focused: arrows jog XY · PgUp/PgDn jog Z · Esc cancels · 1–4 step size · h Home · u Unlock · r Reset · ! Hold · ~ Resume · s Spindle · [ ] feed ∓ · \\ feed 100%',
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
            aria-checked={spindle > 0}
            className={`mc-switch has-kbd${spindle > 0 ? ' on' : ''}`}
            disabled={!connected}
            onClick={spindleToggle}
            title={
              spindle > 0
                ? t('ctrl.spindle.on.title', 'Spindle is ON — click to stop (M5) · toggle with s')
                : t('ctrl.spindle.off.title', 'Spindle is OFF — click to start ({cmd}) · toggle with s', {
                    cmd: spindleDir === 'ccw' ? 'M4' : 'M3',
                  })
            }
            aria-label={spindle > 0 ? t('ctrl.spindle.on.aria', 'Spindle on (click to stop)') : t('ctrl.spindle.off.aria', 'Spindle off (click to start)')}
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
          <InfoTip topic="spindleRpm" />
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
          <span className="mc-unit">RPM</span>
        </div>
      </section>

      {/* Overrides */}
      <section className="mc-section">
        <h4>{t('ctrl.overrides', 'Overrides')}</h4>
        <div className="ov-grid">
          <span className="ov-name">{t('ctrl.feed', 'Feed')}<InfoTip topic="feedOverride" /></span>
          <span className="ov-val">{overrides.feed}%</span>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvMinus10)} aria-label={t('ctrl.ov.feed.minus', 'Feed override minus 10')} title={t('ctrl.ov.feed.minus.title', 'Feed override −10% (key [)')}>−<Kbd k="[" /></button>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvReset)} aria-label={t('ctrl.ov.feed.reset', 'Feed override reset')} title={t('ctrl.ov.feed.reset.title', 'Feed override reset to 100% (key \\)')}>100<Kbd k="\" /></button>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvPlus10)} aria-label={t('ctrl.ov.feed.plus', 'Feed override plus 10')} title={t('ctrl.ov.feed.plus.title', 'Feed override +10% (key ])')}>+<Kbd k="]" /></button>

          <span className="ov-name">{t('ctrl.rapid', 'Rapid')}<InfoTip topic="rapidOverride" /></span>
          <span className="ov-val">{overrides.rapid}%</span>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOv25)} aria-label={t('ctrl.ov.rapid.25', 'Rapid override 25 percent')} title={t('ctrl.ov.rapid.25.title', 'Rapid override 25%')}>25</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOv50)} aria-label={t('ctrl.ov.rapid.50', 'Rapid override 50 percent')} title={t('ctrl.ov.rapid.50.title', 'Rapid override 50%')}>50</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOvReset)} aria-label={t('ctrl.ov.rapid.100', 'Rapid override 100 percent')} title={t('ctrl.ov.rapid.100.title', 'Rapid override 100% (full speed)')}>100</button>

          <span className="ov-name">{t('ctrl.spindle', 'Spindle')}<InfoTip topic="spindleOverride" /></span>
          <span className="ov-val">{overrides.spindle}%</span>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvMinus10)} aria-label={t('ctrl.ov.spindle.minus', 'Spindle override minus 10')} title={t('ctrl.ov.spindle.minus.title', 'Spindle override −10%')}>−</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvReset)} aria-label={t('ctrl.ov.spindle.reset', 'Spindle override reset')} title={t('ctrl.ov.spindle.reset.title', 'Spindle override reset to 100%')}>100</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvPlus10)} aria-label={t('ctrl.ov.spindle.plus', 'Spindle override plus 10')} title={t('ctrl.ov.spindle.plus.title', 'Spindle override +10%')}>+</button>
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
