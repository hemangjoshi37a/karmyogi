import { Fragment, useEffect, useState } from 'react'
import { grbl } from '../serial/controller'
import { useMachine, useSettings, usePersistentState } from '../store'
import { AxisZeroIcon, GoToZeroIcon } from '../components/MachineIcons'
import { useT } from '../i18n'
import '../styles/controller.css'

/**
 * Work coordinate systems. `code` is the GRBL command sent on select; `label`
 * is the compact human-readable chip text (short form so all six fit in the
 * narrow column); `tk`/`title` resolve the full hover description (name + gcode)
 * — `tk` is the translation key, `title` the English fallback.
 */
const WCS = [
  { code: 'G54', label: 'W1', tk: 'coord.wcs.g54', title: 'G54 — Work coordinate system 1 (default datum). The active work zero used for positioning.' },
  { code: 'G55', label: 'W2', tk: 'coord.wcs.g55', title: 'G55 — Work coordinate system 2.' },
  { code: 'G56', label: 'W3', tk: 'coord.wcs.g56', title: 'G56 — Work coordinate system 3.' },
  { code: 'G57', label: 'W4', tk: 'coord.wcs.g57', title: 'G57 — Work coordinate system 4.' },
  { code: 'G58', label: 'W5', tk: 'coord.wcs.g58', title: 'G58 — Work coordinate system 5.' },
  { code: 'G59', label: 'W6', tk: 'coord.wcs.g59', title: 'G59 — Work coordinate system 6.' },
] as const
const AXES = ['x', 'y', 'z'] as const

/** Default safe-Z retract height (mm, work coords) used before any XY return. */
const DEFAULT_SAFE_Z = 5

/**
 * Coordinate-system panel: select the active work coordinate system (G54–G59),
 * view the current work offset (WCO), and zero work axes at the current
 * position (`G10 L20 P0`). Disabled until connected.
 */
export function CoordSystemPanel() {
  const t = useT()
  const connected = useMachine((s) => s.connection === 'connected')
  const wco = useMachine((s) => s.wco)
  // Machine-reported active WCS (from a `$G` parser-state poll). Authoritative
  // when known; falls back to the persisted local guess only when unknown.
  const machineWcs = useMachine((s) => s.activeWcs)
  const machineState = useMachine((s) => s.state)
  const units = useSettings((s) => s.units)
  const unit = units === 'inch' ? t('coord.unit.inch', 'in') : t('coord.unit.mm', 'mm')
  const decimals = units === 'inch' ? 4 : 3
  // Persisted local guess of the active WCS. Only updated by an explicit user
  // selection (and only while connected); the machine's `$G` report wins for
  // display so the chip reflects the REAL active coordinate system.
  const [localWcs, setLocalWcs] = usePersistentState('karmyogi.wcs', 'G54')
  // What the chips highlight: the machine's reported WCS when known, else local.
  const active = (machineWcs ?? localWcs) as string

  // Safe-Z retract height (work Z, mm) prepended before any XY return so the
  // tool lifts clear of the work/clamps instead of dragging across them.
  const [safeZ, setSafeZ] = usePersistentState('karmyogi.coord.safeZ', DEFAULT_SAFE_Z)

  // Transient feedback for the last destructive (Zero) / Go-to-zero action.
  const [feedback, setFeedback] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Prime + keep the machine's active WCS fresh: the controller polls `$G`, but
  // request once on connect so the chip resolves promptly. While disconnected we
  // never touch the local guess (it's only an offline fallback).
  useEffect(() => {
    if (connected) grbl.requestParserState().catch(() => {})
  }, [connected])

  const busy = connected && (machineState === 'Run' || machineState === 'Jog' || machineState === 'Home')

  const selectWcs = (w: string) => {
    if (!grbl.isConnected) return
    // Only persist the local guess while connected; the `$G` poll will confirm
    // it from the machine shortly and take over the chip highlight.
    setLocalWcs(w)
    grbl
      .send(w)
      .then(() => grbl.requestParserState().catch(() => {}))
      .catch(() => {})
  }

  /** Zero the given work axes at the current position — confirmed when busy. */
  const zero = (axes: string, label: string) => {
    if (!grbl.isConnected) return
    if (busy) {
      const ok = window.confirm(
        t('coord.zero.confirmBusy', 'Machine is {state}. Set {axes} work zero anyway?', {
          state: machineState,
          axes: label,
        }),
      )
      if (!ok) return
    }
    grbl
      .send(`G10 L20 P0 ${axes}`)
      .then(() =>
        setFeedback({
          kind: 'ok',
          text: t('coord.zero.ok', 'Set {axes} work zero.', { axes: label }),
        }),
      )
      .catch((err: unknown) =>
        setFeedback({
          kind: 'error',
          text: t('coord.zero.err', 'Failed to set work zero: {err}', {
            err: err instanceof Error ? err.message : String(err),
          }),
        }),
      )
  }

  /**
   * SAFETY: return to work XY zero, retracting Z to a safe height FIRST so the
   * tool never drags through the workpiece or clamps. Sends the retract and the
   * XY rapid as two lines: `G90 G0 Z<safe>` then `G90 G0 X0 Y0`.
   */
  const goToZero = () => {
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
    setFeedback(null)
    Promise.resolve()
      .then(() => grbl.send(`G90 G0 Z${z}`))
      .then(() => grbl.send('G90 G0 X0 Y0'))
      .then(() =>
        setFeedback({
          kind: 'ok',
          text: t('coord.goto.ok', 'Retracted Z to {z} {unit}, returning to X0 Y0.', { z, unit }),
        }),
      )
      .catch((err: unknown) =>
        setFeedback({
          kind: 'error',
          text: t('coord.goto.err', 'Go to zero failed: {err}', {
            err: err instanceof Error ? err.message : String(err),
          }),
        }),
      )
  }

  return (
    <div className="mc-panel">
      <div className="mc-cols">
      <section className="mc-section">
        <h4>{t('coord.wcs.heading', 'Work Coordinate System')}</h4>
        <div className="mc-row tight">
          {WCS.map((w) => (
            <button
              key={w.code}
              type="button"
              className={`mc-btn coord-wcs-chip${active === w.code ? ' primary' : ''}`}
              disabled={!connected}
              aria-pressed={active === w.code}
              aria-label={t('coord.wcs.aria', '{code} work coordinate system', { code: w.code })}
              title={t(w.tk, w.title)}
              onClick={() => selectWcs(w.code)}
            >
              <span className="coord-wcs-label">{w.label}</span>
              <span className="coord-wcs-code" aria-hidden="true">{w.code}</span>
            </button>
          ))}
        </div>
        {connected && machineWcs === null && (
          <span className="mc-hint">
            {t('coord.wcs.unknown', 'Reading active system from the machine…')}
          </span>
        )}
      </section>

      <section className="mc-section">
        <h4>{t('coord.wco.heading', 'Work Offset (WCO)')}</h4>
        <div className="dro">
          <span className="dro-head axis-head">{t('coord.wco.axis', 'Axis')}</span>
          <span className="dro-head">{t('coord.wco.offset', 'Offset ({unit})', { unit })}</span>
          <span className="dro-head" />
          {AXES.map((ax) => (
            <Fragment key={ax}>
              <span className="dro-axis">{ax.toUpperCase()}</span>
              <span className="dro-val machine">{wco[ax].toFixed(decimals)}</span>
              <button
                type="button"
                className="mc-btn mc-btn-lead"
                disabled={!connected}
                onClick={() => zero(`${ax.toUpperCase()}0`, ax.toUpperCase())}
              >
                <AxisZeroIcon size={16} />
                <span>{t('coord.wco.zeroAxis', 'Zero {axis}', { axis: ax.toUpperCase() })}</span>
              </button>
            </Fragment>
          ))}
        </div>
      </section>

      <section className="mc-section">
        <h4>{t('coord.quick.heading', 'Quick Zero')}</h4>
        <div className="mc-row">
          <button
            type="button"
            className="mc-btn mc-btn-stack primary"
            disabled={!connected}
            onClick={() => zero('X0 Y0 Z0', t('coord.quick.allAxes', 'X, Y and Z'))}
            title={t('coord.quick.allTitle', 'Set the current position as work zero for X, Y and Z (G10 L20 P0)')}
          >
            <AxisZeroIcon size={18} />
            <span className="mc-btn-label">{t('coord.quick.all', 'Zero all axes')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">XYZ→0</span>
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack"
            disabled={!connected}
            onClick={() => zero('X0 Y0', t('coord.quick.xyAxes', 'X and Y'))}
            title={t('coord.quick.xyTitle', 'Set the current position as work zero for X and Y only (G10 L20 P0)')}
          >
            <AxisZeroIcon size={18} />
            <span className="mc-btn-label">{t('coord.quick.xy', 'Zero XY')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">XY→0</span>
          </button>
          <button
            type="button"
            className="mc-btn mc-btn-stack"
            disabled={!connected}
            onClick={goToZero}
            title={t('coord.quick.gotoTitle', 'Retract Z to the safe height, then rapid to work zero (X0 Y0)')}
          >
            <GoToZeroIcon size={18} />
            <span className="mc-btn-label">{t('coord.quick.goto', 'Go to zero')}</span>
            <span className="mc-btn-cmd" aria-hidden="true">Z↑ → XY0</span>
          </button>
        </div>
        <div className="mc-field">
          <label className="mc-label" htmlFor="coord-safez">{t('coord.safeZ', 'Safe Z')}</label>
          <input
            id="coord-safez"
            className="mc-input mc-input-grow"
            type="number"
            step={1}
            value={safeZ}
            disabled={!connected}
            onChange={(e) => setSafeZ(Number(e.target.value) || 0)}
            aria-label={t('coord.safeZ.aria', 'Safe Z retract height ({unit})', { unit })}
            title={t('coord.safeZ.title', 'Work-Z height the tool retracts to before any XY return — keeps it clear of the work and clamps')}
          />
          <span className="mc-unit">{unit}</span>
        </div>
        {feedback && (
          <div
            className={feedback.kind === 'error' ? 'mc-error' : 'mc-feedback'}
            role={feedback.kind === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {feedback.text}
          </div>
        )}
      </section>
      </div>
    </div>
  )
}
