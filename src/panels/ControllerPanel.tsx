import { useCallback, useRef } from 'react'
import { grbl } from '../serial/controller'
import { RealtimeByte } from '../serial'
import { useMachine, useSettings, usePersistentState } from '../store'
import { DroReadout } from '../components/DroReadout'
import { JogPad, jogKeyToDelta, jogParamsFromDelta, type JogDelta } from '../components/JogPad'
import { HomeIcon, UnlockIcon, ResetIcon, PauseIcon, PlayIcon, SpindleCwIcon, SpindleCcwIcon } from '../components/MachineIcons'
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

  const doJog = useCallback(
    (delta: JogDelta) => {
      if (!grbl.isConnected) return
      void grbl.jog(jogParamsFromDelta(delta, jogFeed))
    },
    [jogFeed],
  )

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!grbl.isConnected) return
      // Don't hijack typing in inputs/selects.
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      // Don't fight browser/OS shortcuts (Ctrl/Meta/Alt combos).
      if (e.ctrlKey || e.metaKey || e.altKey) return

      // 1) Jog (arrows / PageUp / PageDown) — unchanged behaviour.
      const delta = jogKeyToDelta(e.key, step)
      if (delta) {
        e.preventDefault()
        doJog(delta)
        return
      }

      // 2) Everything else: a single, intentional key per action.
      switch (e.key) {
        // Cancel an in-progress jog.
        case 'Escape':
          e.preventDefault()
          void grbl.jogCancel()
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
    [step, doJog, setStep, spindleToggle],
  )

  const ov = (byte: number) => () => void grbl.realtime(byte)

  return (
    <div
      className="mc-panel"
      ref={rootRef}
      tabIndex={0}
      onKeyDown={onKeyDown}
      aria-label="Machine controller"
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
            title="Home — run the homing cycle ($H)"
            aria-label="Home"
          >
            <HomeIcon />
            <span className="mc-btn-label">Home</span>
            <span className="mc-btn-cmd" aria-hidden="true">$H</span>
            <Kbd k="h" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.unlock()}
            title="Unlock — clear alarm / kill alarm lock ($X)"
            aria-label="Unlock"
          >
            <UnlockIcon />
            <span className="mc-btn-label">Unlock</span>
            <span className="mc-btn-cmd" aria-hidden="true">$X</span>
            <Kbd k="u" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.softReset()}
            title="Soft reset — abort & reset GRBL (Ctrl-X / 0x18)"
            aria-label="Reset"
          >
            <ResetIcon />
            <span className="mc-btn-label">Reset</span>
            <span className="mc-btn-cmd" aria-hidden="true">⌃X</span>
            <Kbd k="r" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.feedHold()}
            title="Feed hold — pause motion (!)"
            aria-label="Hold"
          >
            <PauseIcon />
            <span className="mc-btn-label">Hold</span>
            <span className="mc-btn-cmd" aria-hidden="true">!</span>
            <Kbd k="!" />
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack has-kbd"
            disabled={!connected}
            onClick={() => void grbl.resume()}
            title="Cycle resume — continue (~)"
            aria-label="Resume"
          >
            <PlayIcon />
            <span className="mc-btn-label">Resume</span>
            <span className="mc-btn-cmd" aria-hidden="true">~</span>
            <Kbd k="~" />
          </button>
        </div>
      </section>

      {/* Jog */}
      <section className="mc-section">
        <h4>Jog</h4>
        <div className="mc-field">
          <span className="mc-label">Step</span>
          <span className="mc-seg mc-grow" role="group" aria-label="Jog step (mm)">
            {STEP_SIZES.map((s, i) => (
              <button
                key={s}
                type="button"
                className={`has-kbd${step === s ? ' active' : ''}`}
                onClick={() => setStep(s)}
                aria-pressed={step === s}
                title={`Jog step ${s} mm (key ${i + 1})`}
              >
                {s}
                <Kbd k={String(i + 1)} />
              </button>
            ))}
          </span>
          <span className="mc-unit">mm</span>
        </div>
        <div className="mc-field">
          <label className="mc-label" htmlFor="jog-feed">Feed</label>
          <input
            id="jog-feed"
            className="mc-input mc-input-grow"
            type="number"
            min={1}
            step={50}
            value={jogFeed}
            onChange={(e) => setJogFeed(Math.max(1, Number(e.target.value) || 0))}
            aria-label="Jog feed rate (mm/min)"
            title="Jog feed rate (mm/min) — speed of jog moves"
          />
          <span className="mc-unit">mm/min</span>
        </div>
        <JogPad disabled={!connected} step={step} onJog={doJog} onCancel={() => void grbl.jogCancel()} />
        <span className="mc-hint">
          Fully keyboard-operable when focused: arrows jog XY · PgUp/PgDn jog Z · Esc cancels ·
          1–4 step size · h Home · u Unlock · r Reset · ! Hold · ~ Resume · s Spindle · [ ] feed ∓ · \ feed 100%
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
                ? 'Spindle is ON — click to stop (M5) · toggle with s'
                : `Spindle is OFF — click to start (${spindleDir === 'ccw' ? 'M4' : 'M3'}) · toggle with s`
            }
            aria-label={spindle > 0 ? 'Spindle on (click to stop)' : 'Spindle off (click to start)'}
          >
            <span className="mc-switch-knob" aria-hidden="true" />
            <Kbd k="s" />
          </button>
          <h4 className="mc-spindle-title">Spindle</h4>
          <span className="mc-grow" />
          <span className="mc-seg mc-spindle-dir" role="group" aria-label="Spindle direction">
            <button
              type="button"
              className={`mc-icon-btn${spindleDir === 'cw' ? ' active' : ''}`}
              disabled={!connected}
              onClick={() => setSpindleDir('cw')}
              aria-pressed={spindleDir === 'cw'}
              aria-label="Clockwise (M3)"
              title="Clockwise direction (M3)"
            >
              <SpindleCwIcon size={16} />
            </button>
            <button
              type="button"
              className={`mc-icon-btn${spindleDir === 'ccw' ? ' active' : ''}`}
              disabled={!connected}
              onClick={() => setSpindleDir('ccw')}
              aria-pressed={spindleDir === 'ccw'}
              aria-label="Counter-clockwise (M4)"
              title="Counter-clockwise direction (M4)"
            >
              <SpindleCcwIcon size={16} />
            </button>
          </span>
        </div>
        <div className="mc-field">
          <label className="mc-label" htmlFor="spindle-rpm">Speed</label>
          <input
            id="spindle-rpm"
            className="mc-input mc-input-grow"
            type="number"
            min={0}
            step={1000}
            value={spindleRpm}
            onChange={(e) => setSpindleRpm(Math.max(0, Number(e.target.value) || 0))}
            disabled={!connected}
            aria-label="Spindle speed (RPM)"
            title="Spindle speed in RPM (S word sent with M3/M4)"
          />
          <span className="mc-unit">RPM</span>
        </div>
      </section>

      {/* Overrides */}
      <section className="mc-section">
        <h4>Overrides</h4>
        <div className="ov-grid">
          <span className="ov-name">Feed</span>
          <span className="ov-val">{overrides.feed}%</span>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvMinus10)} aria-label="Feed override minus 10" title="Feed override −10% (key [)">−<Kbd k="[" /></button>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvReset)} aria-label="Feed override reset" title="Feed override reset to 100% (key \)">100<Kbd k="\" /></button>
          <button type="button" className="mc-btn has-kbd" disabled={!connected} onClick={ov(RealtimeByte.FeedOvPlus10)} aria-label="Feed override plus 10" title="Feed override +10% (key ])">+<Kbd k="]" /></button>

          <span className="ov-name">Rapid</span>
          <span className="ov-val">{overrides.rapid}%</span>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOv25)} aria-label="Rapid override 25 percent" title="Rapid override 25%">25</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOv50)} aria-label="Rapid override 50 percent" title="Rapid override 50%">50</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.RapidOvReset)} aria-label="Rapid override 100 percent" title="Rapid override 100% (full speed)">100</button>

          <span className="ov-name">Spindle</span>
          <span className="ov-val">{overrides.spindle}%</span>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvMinus10)} aria-label="Spindle override minus 10" title="Spindle override −10%">−</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvReset)} aria-label="Spindle override reset" title="Spindle override reset to 100%">100</button>
          <button type="button" className="mc-btn" disabled={!connected} onClick={ov(RealtimeByte.SpindleOvPlus10)} aria-label="Spindle override plus 10" title="Spindle override +10%">+</button>
        </div>
        <div className="mc-row">
          <span className="mc-label">Feed {Math.round(feed)} mm/min</span>
          <span className="mc-grow" />
          <span className="mc-label">Spindle {Math.round(spindle)} rpm</span>
        </div>
      </section>
      </div>
    </div>
  )
}
