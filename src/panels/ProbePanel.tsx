import { useEffect, useRef, useState } from 'react'
import { grbl } from '../serial/controller'
import { useGrblSettings, useMachine, usePersistentState } from '../store'
import { useBed } from '../store/bed'
import { InfoTip } from '../components/InfoTip'
import { IconButton } from '../components/IconButton'
import { useT } from '../i18n'
import '../styles/probe.css'

/**
 * Probe & Limits panel.
 *
 * Designed beginner-first, expert-deep:
 *  1. Live switch detection — prominent indicator "lights" for X/Y/Z limit
 *     switches, Probe and Door, lit when their letter is present in the GRBL
 *     status report's `Pn:` field (surfaced by the store as `pins: string[]`).
 *     The controller polls status ~5 Hz so these update live; press each switch
 *     by hand to confirm wiring.
 *  2. Z-Probe — G38.2/G38.3 toward the workpiece, then G10 L20 to zero work Z
 *     accounting for a probe-plate thickness. Clear "Probe Z" + "Set Z zero".
 *  3. Advanced: limits & homing — collapsed by default. The GRBL limit/homing
 *     $-setting toggles ($20/$21/$22 + $5/$6 invert masks), Home/Unlock/Sync,
 *     and the caution notes. Novices use detection + probe; experts open this.
 */

/** Letters GRBL reports in `Pn:` and how we label them. */
const PIN_DEFS: { letter: string; label: string; sub: string; door?: boolean }[] = [
  { letter: 'X', label: 'X', sub: 'limit' },
  { letter: 'Y', label: 'Y', sub: 'limit' },
  { letter: 'Z', label: 'Z', sub: 'limit' },
  { letter: 'P', label: 'Probe', sub: 'P' },
  { letter: 'D', label: 'Door', sub: 'D', door: true },
]

/** A 0/1 GRBL boolean setting wired to a labelled toggle. */
function BoolSetting({
  num,
  title,
  desc,
  value,
  connected,
}: {
  num: number
  title: string
  desc: string
  value: string | undefined
  connected: boolean
}) {
  const t = useT()
  const on = value !== undefined && parseFloat(value) >= 0.5
  const known = value !== undefined
  const current = known
    ? on
      ? t('probe.bool.on1', 'ON (1)')
      : t('probe.bool.off0', 'OFF (0)')
    : t('probe.bool.unknownSync', 'unknown, Sync first')
  return (
    <div className="pr-field">
      <label htmlFor={`pr-set-${num}`}>
        <span className="pr-num">${num}</span> {title}
        <span className="pr-sub">{desc}</span>
      </label>
      <button
        id={`pr-set-${num}`}
        type="button"
        className="pr-toggle"
        data-on={known ? on : undefined}
        disabled={!connected}
        title={
          connected
            ? t('probe.bool.toggleTip', 'Toggle ${num} ({title}) — currently {current}', {
                num,
                title,
                current,
              })
            : t('probe.bool.connectFirst', 'Connect first')
        }
        onClick={() => {
          grbl.writeSetting(num, on ? 0 : 1).then(() => grbl.readSettings()).catch(() => {})
        }}
      >
        {known ? (on ? t('probe.bool.on', 'ON') : t('probe.bool.off', 'OFF')) : '—'}
      </button>
    </div>
  )
}

/** Read a GRBL numeric setting; returns undefined if absent or non-numeric. */
function settingNumber(
  values: Record<number, { numeric: number } | undefined>,
  n: number,
): number | undefined {
  const v = values[n]
  if (!v || !Number.isFinite(v.numeric)) return undefined
  return v.numeric
}

export function ProbePanel() {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const state = useMachine((s) => s.state)
  const pins = useMachine((s) => s.pins)
  const values = useGrblSettings((s) => s.values)
  const loading = useGrblSettings((s) => s.loading)
  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)

  const connected = connection === 'connected'

  // Probe parameters (persisted so they survive a refresh).
  const [feed, setFeed] = usePersistentState<string>('karmyogi.probe.feed', '50')
  const [dist, setDist] = usePersistentState<string>('karmyogi.probe.dist', '20')
  const [thickness, setThickness] = usePersistentState<string>(
    'karmyogi.probe.thickness',
    '0',
  )
  // Advanced section is collapsed by default — novices stay in detection + probe.
  const [advOpen, setAdvOpen] = usePersistentState<boolean>('karmyogi.probe.advOpen', false)
  // Cheap UX state for the last probe action (not persisted).
  const [probed, setProbed] = useState(false)

  // Auto-sync settings when opened while connected with nothing cached yet, so
  // the limit/homing toggles show real values.
  useEffect(() => {
    if (connected && Object.keys(values).length === 0 && !loading) {
      grbl.readSettings().catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected])

  const setVal = (n: number) => values[n]?.value

  const num = (s: string, fallback: number) => {
    const v = parseFloat(s)
    return Number.isFinite(v) ? v : fallback
  }

  // The exact commands the buttons will emit, shown live so there are no
  // surprises before a move that lowers the tool into the workpiece.
  const probeDist = Math.abs(num(dist, 20))
  const probeFeed = Math.abs(num(feed, 50))
  const plateT = num(thickness, 0)
  const probeCmd = `G38.2 Z-${probeDist} F${probeFeed}`
  const zeroCmd = `G10 L20 P0 Z${plateT}`

  const doProbe = (mode: '2' | '3') => {
    grbl.send(`G38.${mode} Z-${probeDist} F${probeFeed}`).then(() => setProbed(true)).catch(() => {})
  }

  const setZeroWithPlate = () => {
    grbl.send(zeroCmd).catch(() => {})
  }

  // --- Auto-detect workspace ---------------------------------------------
  // Relevant GRBL settings: $22 homing enable, $21 hard limits, and the
  // configured per-axis max travel $130/$131/$132 (mm). These are what GRBL
  // *thinks* the machine envelope is — accurate only if calibrated.
  const homingOn = settingNumber(values, 22) === 1
  const hardLimitsOn = settingNumber(values, 21) === 1
  const settingsKnown = Object.keys(values).length > 0
  const travelX = settingNumber(values, 130)
  const travelY = settingNumber(values, 131)
  const travelZ = settingNumber(values, 132)
  const haveTravel =
    (travelX ?? 0) > 0 || (travelY ?? 0) > 0 || (travelZ ?? 0) > 0

  // 'idle' | 'confirm' (inline are-you-sure) | 'homing' | 'done' | 'error'
  const [detectPhase, setDetectPhase] = useState<
    'idle' | 'confirm' | 'homing' | 'done' | 'error'
  >('idle')
  const [detectMsg, setDetectMsg] = useState<string | null>(null)
  // Last size we wrote to the bed store, for the "Workspace set to …" readout.
  const [detected, setDetected] = useState<{
    width?: number
    depth?: number
    height?: number
  } | null>(null)
  // True while we're inside the homing flow and waiting for Idle — used by the
  // state-watcher effect so it only reacts to *our* homing cycle.
  const awaitingHome = useRef(false)
  // Set once the machine has actually left Idle (entered Home/Run/Jog) after our
  // $H, so we know the next Idle means "homing finished" — not the Idle we were
  // sitting in when we pressed the button.
  const sawBusy = useRef(false)
  // Fallback timer: if we never observe a Home/Run transition (cycle too fast to
  // catch, or a controller that doesn't surface it), finalize on Idle anyway.
  const homeFallback = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Copy the configured max-travel ($130–$132) into the bed store. Skips any
   * axis whose value is missing or 0 (uncalibrated), warning if it had to.
   * Returns the size that was actually written.
   */
  const applyTravelToBed = (): {
    width?: number
    depth?: number
    height?: number
  } => {
    const size: { width?: number; depth?: number; height?: number } = {}
    const skipped: string[] = []
    if ((travelX ?? 0) > 0) size.width = travelX
    else skipped.push('X ($130)')
    if ((travelY ?? 0) > 0) size.depth = travelY
    else skipped.push('Y ($131)')
    if ((travelZ ?? 0) > 0) size.height = travelZ
    else skipped.push('Z ($132)')
    if (size.width !== undefined || size.depth !== undefined || size.height !== undefined) {
      useBed.getState().setSize(size)
    }
    setDetected(size)
    if (skipped.length) {
      setDetectMsg(
        t(
          'pr.detect.skipped',
          'Skipped {axes} — set to 0 or unknown. Calibrate max travel in Motion settings.',
          { axes: skipped.join(', ') },
        ),
      )
    }
    return size
  }

  /** Movement-free: just copy $130–$132 into the bed size. */
  const useConfiguredTravel = () => {
    if (!settingsKnown) {
      // Pull settings first if we have a connection but no cache yet.
      if (connected) grbl.readSettings().catch(() => {})
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.noSettings', 'GRBL settings not read yet — press Sync, then retry.'),
      )
      return
    }
    if (!haveTravel) {
      setDetectPhase('error')
      setDetectMsg(
        t(
          'pr.detect.noTravel',
          'No usable max travel ($130–$132). Set them in Motion settings first.',
        ),
      )
      return
    }
    setDetectMsg(null)
    applyTravelToBed()
    setDetectPhase('done')
  }

  /** Tear down the homing watch (flags + fallback timer). */
  const endHomingWatch = () => {
    awaitingHome.current = false
    sawBusy.current = false
    if (homeFallback.current !== null) {
      clearTimeout(homeFallback.current)
      homeFallback.current = null
    }
  }

  /** Homing finished and the machine is Idle — learn the travel into the bed. */
  const finishHoming = () => {
    endHomingWatch()
    // Re-read travel from the (possibly just-synced) store at apply time.
    const size = applyTravelToBed()
    const wrote =
      size.width !== undefined || size.depth !== undefined || size.height !== undefined
    setDetectPhase(wrote ? 'done' : 'error')
    if (!wrote) {
      setDetectMsg(
        t(
          'pr.detect.noTravelAfter',
          'Homed, but no usable max travel ($130–$132) to learn. Set them in Motion settings.',
        ),
      )
    }
  }

  /** Start the home-then-learn flow (after the inline confirm). */
  const confirmAutoDetect = () => {
    setDetectPhase('homing')
    setDetectMsg(t('pr.detect.homing', 'Homing… keep clear of the machine.'))
    setDetected(null)
    awaitingHome.current = true
    sawBusy.current = false
    // Make sure we have fresh settings to read travel from once homing ends.
    grbl.readSettings().catch(() => {})
    grbl.home().catch((err: unknown) => {
      endHomingWatch()
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.homeErr', 'Homing failed to start: {err}', {
          err: err instanceof Error ? err.message : String(err),
        }),
      )
    })
    // Fallback: if we never observe a Home/Run transition (homing cycle too
    // brief to catch, or a controller — like the mock — that stays Idle through
    // an instant `ok`), finalize on the current Idle after a short grace period.
    if (homeFallback.current !== null) clearTimeout(homeFallback.current)
    homeFallback.current = setTimeout(() => {
      if (awaitingHome.current && useMachine.getState().state === 'Idle') finishHoming()
    }, 2500)
  }

  // Watch the machine state during our homing cycle. A real GRBL goes
  // Idle → Home → Idle on a clean cycle, or Alarm if a switch wasn't found.
  // We only treat Idle as "done" once we've seen the machine leave Idle (so the
  // Idle we started from doesn't false-trigger); a fallback timer covers the
  // case where that transition is too fast to observe.
  useEffect(() => {
    if (!awaitingHome.current) return
    if (state === 'Alarm') {
      endHomingWatch()
      setDetectPhase('error')
      setDetectMsg(
        t('pr.detect.alarm', 'Alarm during homing — check switches, then Unlock ($X) and retry.'),
      )
      return
    }
    if (state === 'Home' || state === 'Run' || state === 'Jog') {
      sawBusy.current = true
      return
    }
    if (state === 'Idle' && sawBusy.current) {
      finishHoming()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  // Clean up the fallback timer if the panel unmounts mid-homing.
  useEffect(() => endHomingWatch, [])

  const pinSet = new Set(pins)

  return (
    <div className="pr-panel" aria-label={t('probe.aria.panel', 'Probe and limits')}>
      <p className="pr-intro">
        {t(
          'probe.intro',
          'Find Z=0 with a touch probe, and watch your limit / probe switches live. Advanced GRBL limit & homing settings are tucked below.',
        )}
      </p>

      <div className="pr-cards">
      {/* 1. Live switch detection — the hero. "Press a switch to see it light up." */}
      <section className="pr-card pr-card-wide">
        <header className="pr-card-head">
          <h4>{t('probe.switch.title', 'Live switch detection')}</h4>
          <span className="pr-raw">
            Pn:&nbsp;<b>{pins.length ? pins.join('') : '—'}</b>
          </span>
        </header>
        <p className="pr-hint">{t('probe.switch.hint', 'Press a switch by hand — it lights up here.')}</p>
        <div className="pr-lights" role="group" aria-label={t('probe.switch.pinsAria', 'Input pin states')}>
          {PIN_DEFS.map((p) => {
            const on = pinSet.has(p.letter)
            return (
              <div
                key={p.letter}
                className={`pr-light${p.door ? ' door' : ''}`}
                data-on={on}
                title={t('probe.switch.lightTip', '{label} {sub} — {state} (Pn:{letter})', {
                  label: p.label,
                  sub: p.sub,
                  state: on ? t('probe.switch.triggered', 'TRIGGERED') : t('probe.switch.open', 'open'),
                  letter: p.letter,
                })}
              >
                <span className="pr-dot" aria-hidden="true" />
                <span className="pr-lbl">{p.label}</span>
                <span className="pr-sub">{on ? t('probe.switch.on', 'on') : p.sub}</span>
              </div>
            )
          })}
        </div>
        {!connected && (
          <p className="pr-note">{t('probe.switch.connectNote', 'Connect to a GRBL device to see live pin states.')}</p>
        )}
      </section>

      {/* 2. Z-Probe — simple Probe Z + Set Z zero. */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>{t('probe.z.title', 'Z-Probe')}</h4>
          <span className="pr-raw">{t('probe.z.tag', 'touch off Z')}</span>
        </header>
        <div className="pr-fields">
          <label htmlFor="pr-feed">
            <span className="pr-field-name">
              {t('probe.z.speed', 'Probe speed')}
              <InfoTip topic="probeFeed" />
              <span className="pr-units">mm/min</span>
            </span>
            <input
              id="pr-feed"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={feed}
              disabled={!connected}
              onChange={(e) => setFeed(e.target.value)}
              aria-label={t('probe.z.speedAria', 'Probe speed (mm/min)')}
            />
            <span className="pr-sub">{t('probe.z.speedSub', 'how fast to lower toward the workpiece')}</span>
          </label>
          <label htmlFor="pr-dist">
            <span className="pr-field-name">
              {t('probe.z.maxDist', 'Max distance')}
              <InfoTip topic="probeDistance" />
              <span className="pr-units">mm</span>
            </span>
            <input
              id="pr-dist"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={dist}
              disabled={!connected}
              onChange={(e) => setDist(e.target.value)}
              aria-label={t('probe.z.maxDistAria', 'Max probe distance (mm)')}
            />
            <span className="pr-sub">{t('probe.z.maxDistSub', 'give up if no contact within this far')}</span>
          </label>
          <label htmlFor="pr-thick">
            <span className="pr-field-name">
              {t('probe.z.plate', 'Plate thickness')}
              <InfoTip topic="workZero" />
              <span className="pr-units">mm</span>
            </span>
            <input
              id="pr-thick"
              className="pr-input"
              type="text"
              inputMode="decimal"
              value={thickness}
              disabled={!connected}
              onChange={(e) => setThickness(e.target.value)}
              aria-label={t('probe.z.plateAria', 'Plate thickness (mm)')}
            />
            <span className="pr-sub">{t('probe.z.plateSub', 'thickness of the probe / touch plate')}</span>
          </label>
        </div>
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn primary pr-grow"
            disabled={!connected}
            onClick={() => doProbe('2')}
            title={t('probe.z.probeTip', 'G38.2 Z- F — lower the tool until it touches the plate. Alarms if no contact within the max distance.')}
          >
            {t('probe.z.probe', 'Probe Z')}
          </button>
          <button
            type="button"
            className="pr-btn pr-grow"
            disabled={!connected}
            onClick={setZeroWithPlate}
            title={t('probe.z.setZeroTip', 'G10 L20 P0 Z<thickness> — set work Z=0 at the plate surface. Run after a successful probe.')}
          >
            {t('probe.z.setZero', 'Set Z zero')}
          </button>
        </div>
        <div className="pr-row pr-mini-row" role="group" aria-label={t('probe.z.miniGroupAria', 'Secondary probe actions')}>
          <IconButton
            className="pr-icon-btn"
            icon="⤓"
            label={`${t('probe.z.noAlarm', 'Probe (no alarm)')} — ${t('probe.z.noAlarmTip', 'G38.3 Z- F — probe toward the workpiece, but do NOT alarm if no contact is made.')}`}
            disabled={!connected}
            onClick={() => doProbe('3')}
          />
          <IconButton
            className="pr-icon-btn"
            icon="#"
            label={`${t('probe.z.lastProbe', 'Show last probe ($#)')} — ${t('probe.z.lastProbeTip', '$# — dump coordinate systems incl. PRB (last probe result) to the console')}`}
            disabled={!connected}
            onClick={() => grbl.send('$#').catch(() => {})}
          />
        </div>
        {/* Live G-code — exactly what the buttons send, so there's no surprise. */}
        <code className="pr-code" aria-label={t('probe.z.codeAria', 'G-code these buttons send')}>
          {probeCmd}
          <span className="pr-code-cmt">{'  ; Probe Z'}</span>
          {'\n'}
          {zeroCmd}
          <span className="pr-code-cmt">{'  ; Set Z zero'}</span>
        </code>
        <p className="pr-note caution">
          {t('probe.z.safetyLead', 'Safety:')} <b>{t('probe.z.probe', 'Probe Z')}</b>{' '}
          {t('probe.z.safety1', 'lowers the tool — clip the probe clip to the tool and rest the plate on the workpiece first. 1) Place the plate. 2)')}{' '}
          <b>{t('probe.z.probe', 'Probe Z')}</b>{' '}
          {t('probe.z.safety2', 'stops on contact (shows as')} <b>P</b> {t('probe.z.safety3', 'in the lights above). 3)')}{' '}
          <b>{t('probe.z.setZero', 'Set Z zero')}</b>{' '}
          {t('probe.z.safety4', 'writes')} <code>{zeroCmd}</code> {t('probe.z.safety5', 'so Z=0 sits at the plate surface.')}
          {probed && ' ' + t('probe.z.lastSent', 'Last probe sent — check the console / "Show last probe".')}
        </p>
      </section>

      {/* 2.5 Auto-detect workspace — home, then learn the work-area size. */}
      <section className="pr-card">
        <header className="pr-card-head">
          <h4>{t('pr.detect.title', 'Auto-detect workspace')}</h4>
          <span className="pr-raw">{t('pr.detect.tag', 'home → bed size')}</span>
        </header>
        <p className="pr-hint">
          {t(
            'pr.detect.hint',
            'Home the machine on its limit switches, then learn the work-area size from GRBL’s configured max travel. This drives the 3D bed grid and bed-fit checks.',
          )}
        </p>

        {/* Status line: homing/limits + configured travel. */}
        <div className="pr-detect-status" role="group" aria-label={t('probe.detectStatus.aria', 'Workspace detection status')}>
          <span className="pr-chip" data-on={settingsKnown ? homingOn : undefined}>
            {t('pr.detect.homingChip', 'Homing $22')}:{' '}
            <b>
              {!settingsKnown
                ? t('pr.detect.unknown', '?')
                : homingOn
                  ? t('pr.detect.on', 'ON')
                  : t('pr.detect.off', 'OFF')}
            </b>
          </span>
          <span className="pr-chip" data-on={settingsKnown ? hardLimitsOn : undefined}>
            {t('pr.detect.limitsChip', 'Hard limits $21')}:{' '}
            <b>
              {!settingsKnown
                ? t('pr.detect.unknown', '?')
                : hardLimitsOn
                  ? t('pr.detect.on', 'ON')
                  : t('pr.detect.off', 'OFF')}
            </b>
          </span>
          <span className="pr-chip mono" data-on={settingsKnown ? haveTravel : undefined}>
            {t('pr.detect.travelChip', 'Travel $130–$132')}:{' '}
            <b>
              {settingsKnown
                ? `${travelX ?? '?'} × ${travelY ?? '?'} × ${travelZ ?? '?'} mm`
                : t('pr.detect.unknown', '?')}
            </b>
          </span>
        </div>

        {/* Friendly hint when homing/limits aren't ready. */}
        {(!settingsKnown || !homingOn) && (
          <p className="pr-note caution">
            {t(
              'pr.detect.needHoming',
              'Auto-home needs homing enabled. Open Motion / GRBL settings (⚙) and set $22=1 (homing) and wire your limit switches first.',
            )}
          </p>
        )}

        {/* Primary action — gated behind an inline confirm (it MOVES the machine). */}
        {detectPhase !== 'confirm' ? (
          <div className="pr-row">
            <button
              type="button"
              className="pr-btn primary pr-grow"
              disabled={!connected || !homingOn || detectPhase === 'homing'}
              onClick={() => {
                setDetectMsg(null)
                setDetectPhase('confirm')
              }}
              title={
                !connected
                  ? t('pr.detect.connectFirst', 'Connect first')
                  : !homingOn
                    ? t('pr.detect.enableHomingFirst', 'Enable homing ($22=1) first')
                    : t(
                        'pr.detect.autoTip',
                        '$H homing cycle, then read $130–$132 into the bed size. Moves the machine.',
                      )
              }
            >
              {detectPhase === 'homing'
                ? t('pr.detect.homingBtn', '⟳ Homing…')
                : t('pr.detect.autoBtn', '⌖ Auto-detect workspace')}
            </button>
          </div>
        ) : (
          <div className="pr-row pr-confirm" role="alertdialog" aria-label={t('probe.confirmHoming.aria', 'Confirm homing')}>
            <span className="pr-confirm-q">
              {t('pr.detect.confirmQ', 'This will home the machine — keep clear. Continue?')}
            </span>
            <button
              type="button"
              className="pr-btn danger"
              onClick={confirmAutoDetect}
              title={t('pr.detect.confirmYesTip', 'Send $H and learn the workspace size')}
            >
              {t('pr.detect.confirmYes', 'Home & detect')}
            </button>
            <button
              type="button"
              className="pr-btn"
              onClick={() => setDetectPhase('idle')}
              title={t('pr.detect.confirmNoTip', 'Cancel — do not move the machine')}
            >
              {t('pr.detect.confirmNo', 'Cancel')}
            </button>
          </div>
        )}

        {/* Secondary, movement-free action. */}
        <div className="pr-row">
          <button
            type="button"
            className="pr-btn pr-grow pr-btn-sm"
            disabled={!settingsKnown || !haveTravel}
            onClick={useConfiguredTravel}
            title={t(
              'pr.detect.useTravelTip',
              'Copy the configured max travel ($130–$132) into the bed size. Does NOT move the machine.',
            )}
          >
            {t('pr.detect.useTravelBtn', '⤓ Use configured travel ($130–$132)')}
          </button>
        </div>

        {/* Progress / result message. */}
        {detectMsg && (
          <p
            className={`pr-note${detectPhase === 'error' ? ' caution' : ''}`}
            role="status"
            aria-live="polite"
          >
            {detectMsg}
          </p>
        )}

        {/* Detected-size readout + provenance. */}
        {detectPhase === 'done' && detected && (
          <p className="pr-note pr-detect-result" role="status" aria-live="polite">
            ✓{' '}
            {t('pr.detect.result', 'Workspace set to {w} × {d} × {h} mm', {
              w: detected.width ?? bedW,
              d: detected.depth ?? bedD,
              h: detected.height ?? bedH,
            })}
            <span className="pr-sub">
              {t(
                'pr.detect.provenance',
                'From GRBL’s configured max travel ($130–$132) — accurate only if those are calibrated to the real machine.',
              )}
            </span>
          </p>
        )}
      </section>

      {/* 3. Advanced: limits & homing — collapsed by default. */}
      <section className="pr-card pr-card-wide">
        <button
          type="button"
          className="pr-disclosure"
          aria-expanded={advOpen}
          aria-controls="pr-adv-body"
          onClick={() => setAdvOpen(!advOpen)}
        >
          <span className="pr-caret" aria-hidden="true">
            {advOpen ? '▾' : '▸'}
          </span>
          <span className="pr-disclosure-title">{t('probe.adv.title', 'Advanced: limits & homing')}</span>
          <span className="pr-disclosure-hint">
            {advOpen ? t('probe.adv.hide', 'hide') : t('probe.adv.settings', 'GRBL $-settings')}
          </span>
        </button>
        {advOpen && (
          <div id="pr-adv-body" className="pr-adv-body">
            <BoolSetting
              num={20}
              title={t('probe.adv.softLimits', 'Soft limits')}
              desc={t('probe.adv.softLimitsDesc', 'refuse moves past $130–$132 max travel (needs homing)')}
              value={setVal(20)}
              connected={connected}
            />
            <BoolSetting
              num={21}
              title={t('probe.adv.hardLimits', 'Hard limits')}
              desc={t('probe.adv.hardLimitsDesc', 'stop on a limit switch trigger (needs switches wired)')}
              value={setVal(21)}
              connected={connected}
            />
            <BoolSetting
              num={22}
              title={t('probe.adv.homingEnable', 'Homing enable')}
              desc={t('probe.adv.homingEnableDesc', 'allow the $H homing cycle')}
              value={setVal(22)}
              connected={connected}
            />
            <BoolSetting
              num={5}
              title={t('probe.adv.limitInvert', 'Limit pins invert')}
              desc={t('probe.adv.limitInvertDesc', 'invert limit inputs — set ON for NC (normally-closed) switches')}
              value={setVal(5)}
              connected={connected}
            />
            <BoolSetting
              num={6}
              title={t('probe.adv.probeInvert', 'Probe pin invert')}
              desc={t('probe.adv.probeInvertDesc', 'invert the probe input')}
              value={setVal(6)}
              connected={connected}
            />
            <div className="pr-row pr-adv-actions" role="group" aria-label={t('probe.adv.actionsAria', 'Homing actions')}>
              <button
                type="button"
                className="pr-btn primary pr-grow"
                disabled={!connected}
                onClick={() => grbl.home().catch(() => {})}
                title={t('probe.adv.homeTip', '$H — run the homing cycle')}
              >
                {t('probe.adv.home', 'Home ($H)')}
              </button>
              <IconButton
                className="pr-icon-btn"
                icon="⤓"
                label={`${t('probe.adv.unlock', 'Unlock ($X)')} — ${t('probe.adv.unlockTip', '$X — clear an alarm / unlock')}`}
                disabled={!connected}
                onClick={() => grbl.unlock().catch(() => {})}
              />
              <IconButton
                className="pr-icon-btn"
                icon="⟳"
                label={
                  loading
                    ? t('probe.adv.syncing', '⟳ Syncing…')
                    : `${t('probe.adv.sync', '⟳ Sync')} — ${t('probe.adv.syncTip', '$$ — re-read settings so the toggles reflect the machine')}`
                }
                disabled={!connected || loading}
                data-loading={loading || undefined}
                onClick={() => grbl.readSettings().catch(() => {})}
              />
            </div>
            <p className="pr-note caution">
              {t(
                'probe.adv.caution',
                'Caution: hard limits ($21) need limit switches physically wired. Many switches are normally-closed — if a switch reads triggered while open in the lights above, turn ON limit-pins invert ($5). Soft limits ($20) only work after a successful homing cycle.',
              )}
            </p>
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
