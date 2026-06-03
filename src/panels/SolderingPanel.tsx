import { useEffect, useMemo, useState } from 'react'
import { useMachine, useProgram } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import {
  SolderFeedType,
  defaultSolderPoint,
  defaultSolderingParams,
  generateSoldering,
  type SolderPoint,
  type SolderingParams,
} from '../core/soldering'
import '../styles/soldering.css'

/** Split G-code into non-empty lines for the line count shown to the operator. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

// Defaults used to prefill new rows. Mirror the core SolderPoint defaults but
// are user-editable from the panel so a batch of points share a Free-Z etc.
interface RowDefaults {
  freeZ: number
  touchZ: number
  feedSeconds: number
  type: SolderFeedType
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` are
 * combined into a native hover tooltip explainer (one that never intercepts the
 * action click), keeping the toolbar compact while every button stays
 * self-documenting.
 */
function ToolButton(props: {
  glyph: string
  title: string
  body: string
  onClick: () => void
  className?: string
  disabled?: boolean
  ariaExpanded?: boolean
}) {
  const { glyph, title, body, onClick, className = '', disabled, ariaExpanded } = props
  return (
    <button
      type="button"
      className={`sp-ico${className ? ' ' + className : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={title}
      aria-expanded={ariaExpanded}
      title={`${title} — ${body}`}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  )
}

/** A slim number field with an inline unit suffix, matching the dense theme. */
function NumField(props: {
  label: string
  value: number
  unit?: string
  step?: string
  min?: string
  max?: string
  onChange: (n: number) => void
  parse?: (v: string, fallback: number) => number
  info?: { title: string; body: string }
}) {
  const { label, value, unit, step = '0.1', min, max, onChange, parse = num, info } = props
  return (
    <label className="sp-field">
      <span className="sp-field-label">
        {label}
        {info && <InfoTip topic="solderField" title={info.title} body={info.body} />}
      </span>
      <span className={`sp-input${unit ? ' has-unit' : ''}`}>
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(parse(e.target.value, value))}
        />
        {unit && <i>{unit}</i>}
      </span>
    </label>
  )
}

/**
 * Auto-soldering panel (W9). An editable table of soldering points drives the
 * pure `generateSoldering` core, which emits a safe program where the spindle
 * output is repurposed as a solder-wire feeder (M3/G4/M5). "Record position"
 * captures the live machine work-position into a point. Generation is live:
 * every edit pushes a fresh program into the shared store — the Visualizer
 * renders it and the Program tab streams it (no send controls live here).
 */
export function SolderingPanel() {
  const t = useT()
  // Live machine work-position + connection (for "Record position").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)

  const [defaults, setDefaults] = useState<RowDefaults>({
    freeZ: 5.0,
    touchZ: -1.0,
    feedSeconds: 0.5,
    type: SolderFeedType.TouchDown,
  })

  const [points, setPoints] = useState<SolderPoint[]>([])
  const [selected, setSelected] = useState(-1)
  const [showRaw, setShowRaw] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Global generator params (programName is fixed here; metric stays mm/G21).
  const [params, setParams] = useState<Omit<SolderingParams, 'programName' | 'metric'>>(() => {
    const d = defaultSolderingParams()
    return {
      safeZ: d.safeZ,
      feederRPM: d.feederRPM,
      plungeFeed: d.plungeFeed,
      settleSeconds: d.settleSeconds,
      decimals: d.decimals,
    }
  })

  function newRow(x = 0, y = 0): SolderPoint {
    return defaultSolderPoint({
      x,
      y,
      freeZ: defaults.freeZ,
      touchZ: defaults.touchZ,
      feedSeconds: defaults.feedSeconds,
      type: defaults.type,
    })
  }

  function addRow() {
    setPoints((p) => [...p, newRow()])
    setSelected(points.length)
  }

  function deleteRow(i: number) {
    setPoints((p) => p.filter((_, idx) => idx !== i))
    setSelected((s) => (s === i ? -1 : s > i ? s - 1 : s))
  }

  function moveRow(i: number, dir: -1 | 1) {
    const j = i + dir
    if (j < 0 || j >= points.length) return
    setPoints((p) => {
      const next = [...p]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
    setSelected(j)
  }

  function updatePoint(i: number, patch: Partial<SolderPoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  // Record the live machine work-position. If a row is selected, fill its X/Y;
  // otherwise append a new row at that position.
  function recordPosition() {
    if (!connected) return
    if (selected >= 0 && selected < points.length) {
      updatePoint(selected, { x: wpos.x, y: wpos.y })
    } else {
      setPoints((p) => [...p, newRow(wpos.x, wpos.y)])
      setSelected(points.length)
    }
  }

  // Live G-code preview, recomputed whenever points/params change.
  const gcode = useMemo(() => generateSoldering(points, { ...params }), [points, params])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer + Program tab pick it up without a manual Generate step.
  useEffect(() => {
    if (points.length === 0) return
    const id = window.setTimeout(() => setProgram('soldering', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram])

  return (
    <div className="sp-panel">
      {/* Slim header: title + live line-count badge + icon toolbar. */}
      <header className="sp-head">
        <div className="sp-head-title">
          <span className="sp-head-name">{t('solder.title', 'Auto-solder')}</span>
          <InfoTip
            topic="solderMode"
            title={t('solder.title', 'Auto-solder')}
            body={t(
              'solder.intro',
              'Solders a list of points one by one. The spindle output drives a solder-wire feeder (M3 runs it, M5 stops). The program auto-syncs to the Program tab for streaming.',
            )}
          />
        </div>
        <div className="sp-tools">
          <ToolButton
            className="sp-ico-primary"
            glyph="+"
            onClick={addRow}
            title={t('solder.toolbar.add', 'Add point')}
            body={t('solder.toolbar.add.body', 'Append a soldering point prefilled from the defaults in Settings.')}
          />
          <ToolButton
            glyph="⌖"
            onClick={recordPosition}
            disabled={!connected}
            title={t('solder.toolbar.record', 'Record position')}
            body={
              connected
                ? selected >= 0
                  ? t('solder.toolbar.record.body.fill', 'Fills the selected row X/Y from the live machine position.')
                  : t('solder.toolbar.record.body.append', 'Appends a point at the current machine position.')
                : t('solder.toolbar.record.body.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            className="sp-ico-danger"
            glyph="🗑"
            onClick={() => setPoints([])}
            disabled={points.length === 0}
            title={t('solder.toolbar.clear', 'Clear all')}
            body={t('solder.toolbar.clear.body', 'Remove every soldering point and start over.')}
          />
          <span className="sp-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph="⚙"
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('solder.toolbar.settings', 'Settings')}
            body={t('solder.toolbar.settings.body', 'New-point defaults plus feeder and motion parameters (Safe-Z, feeder S, plunge feed, dwell).')}
          />
        </div>
      </header>

      {/* Live status strip: point + line counts, auto-synced to the Program tab. */}
      <div className="sp-status">
        <span className="sp-status-pill">
          <b>{points.length}</b> {t('solder.status.points', 'points')}
        </span>
        <span className="sp-status-sep" aria-hidden="true">·</span>
        <span className="sp-status-pill">
          <b>{lineCount}</b> {t('solder.status.lines', 'G-code lines')}
        </span>
        <span className="sp-status-sync" title={t('solder.live.title', 'Lines auto-synced to the Program tab')}>
          → {t('solder.status.program', 'Program')}
        </span>
      </div>

      {!connected && points.length > 0 && (
        <p className="sp-warn">
          {t('solder.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Collapsible Settings: new-point defaults + feeder/motion, dense cards. */}
      {showSettings && (
        <section className="sp-settings">
          <div className="sp-card">
            <div className="sp-card-head">
              <h4>{t('solder.defaults.title', 'New-point defaults')}</h4>
              <InfoTip
                topic="solderDefaults"
                title={t('solder.defaults.title', 'New-point defaults')}
                body={t('solder.defaults.body', 'Values used to prefill each newly added point. Free-Z is the travel height; Touch-Z is where the tip touches down.')}
              />
            </div>
            <div className="sp-fields">
              <NumField
                label={t('solder.field.freeZ', 'Free-Z')}
                unit="mm"
                value={defaults.freeZ}
                onChange={(n) => setDefaults((d) => ({ ...d, freeZ: n }))}
                info={{
                  title: t('solder.field.freeZ', 'Free-Z'),
                  body: t('solder.field.freeZ.body', 'Travel height the tip lifts to between points.'),
                }}
              />
              <NumField
                label={t('solder.field.touchZ', 'Touch-Z')}
                unit="mm"
                value={defaults.touchZ}
                onChange={(n) => setDefaults((d) => ({ ...d, touchZ: n }))}
                info={{
                  title: t('solder.field.touchZ', 'Touch-Z'),
                  body: t('solder.field.touchZ.body', 'Depth the tip touches down to at each point.'),
                }}
              />
              <NumField
                label={t('solder.field.feed', 'Feed')}
                unit="s"
                min="0"
                value={defaults.feedSeconds}
                onChange={(n) => setDefaults((d) => ({ ...d, feedSeconds: n }))}
                info={{
                  title: t('solder.field.feed', 'Feed'),
                  body: t('solder.field.feed.body', 'How long the wire feeder runs at each point (seconds).'),
                }}
              />
              <label className="sp-field">
                <span className="sp-field-label">
                  {t('solder.field.feedType', 'Feed type')}
                  <InfoTip
                    topic="solderFeedType"
                    title={t('solder.field.feedType', 'Feed type')}
                    body={t('solder.field.feedType.body', 'Pre-solder feeds wire before touch-down; touch-down feeds while the tip is down.')}
                  />
                </span>
                <select
                  value={defaults.type}
                  onChange={(e) => setDefaults((d) => ({ ...d, type: e.target.value as SolderFeedType }))}
                >
                  <option value={SolderFeedType.PreSolder}>{t('solder.feedType.preSolder', 'pre-solder')}</option>
                  <option value={SolderFeedType.TouchDown}>{t('solder.feedType.touchDown', 'touch-down')}</option>
                </select>
              </label>
            </div>
          </div>

          <div className="sp-card">
            <div className="sp-card-head">
              <h4>{t('solder.feeder.title', 'Feeder & motion')}</h4>
              <InfoTip
                topic="solderFeeder"
                title={t('solder.feeder.title', 'Feeder & motion')}
                body={t('solder.feeder.body', 'Safe-Z retract height, feeder spindle speed (S), plunge feed rate, and the settle dwell after each touch-down.')}
              />
            </div>
            <div className="sp-fields">
              <NumField
                label={t('solder.field.safeZ', 'Safe-Z')}
                unit="mm"
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('solder.field.safeZ', 'Safe-Z'),
                  body: t('solder.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
              <NumField
                label={t('solder.field.feederS', 'Feeder')}
                unit="S"
                step="100"
                min="0"
                value={params.feederRPM}
                onChange={(n) => setParams((p) => ({ ...p, feederRPM: n }))}
                info={{
                  title: t('solder.field.feederS', 'Feeder'),
                  body: t('solder.field.feederS.body', 'Spindle speed word (S) that drives the solder-wire feeder.'),
                }}
              />
              <NumField
                label={t('solder.field.plungeF', 'Plunge')}
                unit="mm/min"
                step="10"
                min="0"
                value={params.plungeFeed}
                onChange={(n) => setParams((p) => ({ ...p, plungeFeed: n }))}
                info={{
                  title: t('solder.field.plungeF', 'Plunge'),
                  body: t('solder.field.plungeF.body', 'Feed rate used to lower the tip from Free-Z to Touch-Z.'),
                }}
              />
              <NumField
                label={t('solder.field.settle', 'Settle')}
                unit="s"
                min="0"
                value={params.settleSeconds}
                onChange={(n) => setParams((p) => ({ ...p, settleSeconds: n }))}
                info={{
                  title: t('solder.field.settle', 'Settle'),
                  body: t('solder.field.settle.body', 'Dwell after each touch-down so the joint settles before lifting.'),
                }}
              />
              <NumField
                label={t('solder.field.decimals', 'Decimals')}
                step="1"
                min="0"
                max="6"
                value={params.decimals}
                parse={intNum}
                onChange={(n) => setParams((p) => ({ ...p, decimals: n }))}
                info={{
                  title: t('solder.field.decimals', 'Decimals'),
                  body: t('solder.field.decimals.body', 'Number of decimal places in the emitted coordinates.'),
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Points — compact editable table (reflows to stacked cards when narrow). */}
      <div className="sp-card sp-points">
        <div className="sp-card-head">
          <h4>{t('solder.points.title', 'Solder points')}</h4>
          <span className="sp-card-count">{points.length}</span>
        </div>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th className="sp-idx">#</th>
                <th>X</th>
                <th>Y</th>
                <th>{t('solder.table.freeZ', 'Free-Z')}</th>
                <th>{t('solder.table.touchZ', 'Touch-Z')}</th>
                <th>{t('solder.table.feedType', 'Type')}</th>
                <th>{t('solder.table.feedS', 'Feed s')}</th>
                <th className="sp-actions-col" aria-label={t('solder.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={8} className="sp-empty">
                    {t(
                      'solder.table.empty',
                      'No points yet. Press + to add one, or ⌖ to record the machine position.',
                    )}
                  </td>
                </tr>
              )}
              {points.map((pt, i) => (
                <tr
                  key={i}
                  className={i === selected ? 'sp-row-selected' : undefined}
                  onClick={() => setSelected(i)}
                >
                  <td className="sp-idx">{i + 1}</td>
                  <td data-label="X">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label="Y">
                    <input
                      type="number"
                      step="0.1"
                      value={pt.y}
                      onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    />
                  </td>
                  <td data-label={t('solder.table.freeZ', 'Free-Z')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.freeZ}
                      onChange={(e) => updatePoint(i, { freeZ: num(e.target.value, pt.freeZ) })}
                    />
                  </td>
                  <td data-label={t('solder.table.touchZ', 'Touch-Z')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.touchZ}
                      onChange={(e) => updatePoint(i, { touchZ: num(e.target.value, pt.touchZ) })}
                    />
                  </td>
                  <td data-label={t('solder.table.feedType', 'Type')}>
                    <select
                      value={pt.type}
                      onChange={(e) => updatePoint(i, { type: e.target.value as SolderFeedType })}
                    >
                      <option value={SolderFeedType.PreSolder}>{t('solder.feedType.preSolder', 'pre-solder')}</option>
                      <option value={SolderFeedType.TouchDown}>{t('solder.feedType.touchDown', 'touch-down')}</option>
                    </select>
                  </td>
                  <td data-label={t('solder.table.feedS', 'Feed s')}>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={pt.feedSeconds}
                      onChange={(e) =>
                        updatePoint(i, { feedSeconds: num(e.target.value, pt.feedSeconds) })
                      }
                    />
                  </td>
                  <td className="sp-actions">
                    <button
                      className="sp-row-ico"
                      title={t('solder.row.moveUp', 'Move up')}
                      aria-label={t('solder.row.moveUp', 'Move up')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, -1)
                      }}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="sp-row-ico"
                      title={t('solder.row.moveDown', 'Move down')}
                      aria-label={t('solder.row.moveDown', 'Move down')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, 1)
                      }}
                      disabled={i === points.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="sp-row-ico sp-del"
                      title={t('solder.row.delete', 'Delete point')}
                      aria-label={t('solder.row.delete', 'Delete point')}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteRow(i)
                      }}
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Raw G-code (collapsible, slim). */}
      <div className="sp-raw">
        <button
          className="sp-raw-toggle"
          onClick={() => setShowRaw((v) => !v)}
          aria-expanded={showRaw}
        >
          <span className="sp-raw-caret" aria-hidden="true">{showRaw ? '▾' : '▸'}</span>
          {t('solder.raw', 'Raw G-code ({count} lines)', { count: lineCount })}
        </button>
        {showRaw && <pre className="sp-preview">{gcode}</pre>}
      </div>
    </div>
  )
}
