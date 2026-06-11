import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMachine, useProgram, useNotifications, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import {
  SCREW_PRESET_KEYS,
  defaultScrewPoint,
  defaultDrillingParams,
  generateDrilling,
  holeDiameter,
  resolvePreset,
  type HoleKind,
  type RecessKind,
  type DrillingParams,
  type ScrewPoint,
  type ScrewPresetKey,
} from '../core/drilling'
import '../styles/drilling.css'

/** Clamp decimals to the range toFixed() accepts (0..6) — guards the render-phase
 * useMemo from a RangeError that would white-screen the panel. */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Split G-code into non-empty lines for the line count shown to the operator. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Generator params editable from the panel (programName/metric are fixed here). */
type EditableParams = Omit<DrillingParams, 'programName' | 'metric'>

/** What a JSON save/load file holds: the hole list + the parameters. */
interface DrillDoc {
  points: ScrewPoint[]
  params: EditableParams
}

/** Coerce an unknown loaded value into a hole point (defensive, never throws). */
function toPoint(v: unknown): ScrewPoint {
  const o = (v ?? {}) as Record<string, unknown>
  return defaultScrewPoint({
    x: typeof o.x === 'number' ? o.x : 0,
    y: typeof o.y === 'number' ? o.y : 0,
  })
}

/**
 * Coerce an (untrusted) settings snapshot into the editable params, merging over
 * the defaults so unknown/missing/corrupt keys never feed a NaN to the emitter.
 * Shared by the preset apply path AND the settings Save/Load buttons.
 */
function toParams(v: unknown): EditableParams {
  const d = defaultDrillingParams((v ?? {}) as Partial<DrillingParams>)
  return {
    preset: d.preset,
    hole: d.hole,
    holeDepth: d.holeDepth,
    peck: d.peck,
    recess: d.recess,
    recessKind: d.recessKind,
    recessDepth: d.recessDepth,
    toolDia: d.toolDia,
    feed: d.feed,
    plunge: d.plunge,
    safeZ: d.safeZ,
    decimals: clampDecimals(d.decimals),
  }
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` combine
 * into a native hover tooltip that never intercepts the action click — keeping
 * the toolbar compact while every button stays self-documenting.
 */
function ToolButton(props: {
  glyph: ReactNode
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
      className={`scf-ico${className ? ' ' + className : ''}`}
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
    <label className="scf-field">
      <span className="scf-field-label">
        {label}
        {info && <InfoTip topic="drillField" title={info.title} body={info.body} />}
      </span>
      <span className={`scf-input${unit ? ' has-unit' : ''}`}>
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
 * Bore / Drill / Hole panel. An editable table of hole points (captured from the
 * live machine X/Y) drives the pure `generateDrilling` core, which emits a safe
 * drilling program: peck-drilled pilot/clearance holes with an optional
 * counterbore/countersink for the screw head. The program auto-syncs to the
 * shared store so the Visualizer renders it and the Program tab streams it; a
 * Send button pushes it immediately, and the G-code can be copied/downloaded.
 */
export function DrillingPanel() {
  const t = useT()
  // Live machine work-position + connection (for "Add point" / "Record position").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const notify = useNotifications((s) => s.notify)

  const [points, setPoints] = useState<ScrewPoint[]>([])
  const [selected, setSelected] = useState(-1)
  const [showSettings, setShowSettings] = usePersistentState<boolean>(
    'karmyogi.drilling.showSettings',
    true,
  )

  const [params, setParams] = useState<EditableParams>(() => toParams(undefined))

  // ---- color-coded setting PRESETS (the drilling params, NOT the hole list) --
  // Snapshot the current settings (hole size/type/depth, recess, feeds, Safe-Z…).
  const capturePreset = (): EditableParams => ({ ...params })
  // Restore a captured preset, coercing each field from the (untrusted) snapshot
  // through the shared params coercion so a corrupt slot can never feed a NaN
  // to the emitter.
  const applyPreset = (p: EditableParams) => setParams(toParams(p))
  const presets = usePresets<EditableParams>({
    storageKey: 'karmyogi.drilling.presets',
    capture: capturePreset,
    onApply: applyPreset,
  })

  function addRow() {
    // Prefill X/Y from the LIVE machine work-position when connected so the new
    // point lands where the tool currently is (jog to the spot, then Add). When
    // disconnected fall back to the origin — never crash.
    const x = connected ? wpos.x : 0
    const y = connected ? wpos.y : 0
    setPoints((p) => {
      setSelected(p.length)
      return [...p, defaultScrewPoint({ x, y })]
    })
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

  function updatePoint(i: number, patch: Partial<ScrewPoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  // Record the live machine position: fill the selected row's X/Y, else append.
  function recordPosition() {
    if (!connected) return
    if (selected >= 0 && selected < points.length) {
      updatePoint(selected, { x: wpos.x, y: wpos.y })
    } else {
      setPoints((p) => {
        setSelected(p.length)
        return [...p, defaultScrewPoint({ x: wpos.x, y: wpos.y })]
      })
    }
  }

  function clearAll() {
    if (points.length === 0) return
    if (!window.confirm(t('drill.clearConfirm', 'Remove all {n} hole point(s)?', { n: points.length })))
      return
    setPoints([])
    setSelected(-1)
  }

  // Sanitised params for generation + preview: clamp decimals and force feeds /
  // depths / increments non-negative so a typed negative never produces an
  // inverted move or a backwards feed.
  const safeParams = useMemo<EditableParams>(
    () => ({
      ...params,
      decimals: clampDecimals(params.decimals),
      holeDepth: Math.max(0, params.holeDepth),
      peck: Math.max(0, params.peck),
      recessDepth: Math.max(0, params.recessDepth),
      toolDia: Math.max(0.01, params.toolDia),
      feed: Math.max(0, params.feed),
      plunge: Math.max(0, params.plunge),
      safeZ: Math.max(0, params.safeZ),
    }),
    [params],
  )

  const gcode = useMemo(() => generateDrilling(points, safeParams), [points, safeParams])
  // With no hole points there is nothing to drill, so report ZERO lines (and
  // never push a body-less program to the store) — the status strip must not
  // claim a line count while the list is empty.
  const lineCount = useMemo(
    () => (points.length === 0 ? 0 : gcodeLines(gcode).length),
    [gcode, points.length],
  )
  const preset = useMemo(() => resolvePreset(params.preset), [params.preset])
  const drilledDia = useMemo(
    () => holeDiameter(defaultDrillingParams(safeParams)),
    [safeParams],
  )

  // Warn when the head recess can't be cut: the chosen tool is not smaller than
  // the head radius, so no material would be removed (a degenerate pocket).
  const recessTooWide = useMemo(
    () => safeParams.recess && preset.headDia / 2 - safeParams.toolDia / 2 <= 0,
    [safeParams.recess, safeParams.toolDia, preset.headDia],
  )
  // Warn when a counterbore is as deep (or deeper) than the hole — the head seat
  // would punch through, which is almost never intended.
  const recessDeeper = useMemo(
    () => safeParams.recess && safeParams.recessDepth >= safeParams.holeDepth && safeParams.holeDepth > 0,
    [safeParams.recess, safeParams.recessDepth, safeParams.holeDepth],
  )

  const doc: DrillDoc = useMemo(() => ({ points, params }), [points, params])

  function loadDoc(data: unknown) {
    const o = (data ?? {}) as Record<string, unknown>
    const rawPoints = Array.isArray(o.points) ? o.points : []
    const parsed = rawPoints.map(toPoint)
    if (parsed.length === 0 && !o.params) {
      notify('warn', t('drill.load.empty', 'No usable hole points found in that file.'))
      return
    }
    if (
      points.length > 0 &&
      !window.confirm(
        t('drill.load.replaceConfirm', 'Replace the current {n} point(s) with {m} from the file?', {
          n: points.length,
          m: parsed.length,
        }),
      )
    ) {
      return
    }
    setPoints(parsed)
    setSelected(-1)
    // Merge any saved params over the defaults so unknown/missing keys are safe.
    if (o.params && typeof o.params === 'object') {
      setParams(toParams(o.params))
    }
    notify('success', t('drill.load.done', 'Loaded {n} hole point(s).', { n: parsed.length }))
  }

  // Copy the generated program to the clipboard.
  async function copyGcode() {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard')
      await navigator.clipboard.writeText(gcode)
      notify('success', t('drill.copied', 'Copied {n} G-code line(s) to the clipboard.', { n: lineCount }))
    } catch {
      notify('warn', t('drill.copyFailed', 'Could not copy to the clipboard.'))
    }
  }

  // Download the generated program as a .gcode/.nc file.
  function downloadGcode() {
    const blob = new Blob([gcode], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'drilling.nc'
    a.click()
    URL.revokeObjectURL(url)
    notify('success', t('drill.downloaded', 'Downloaded the drilling program.'))
  }

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer + Program tab pick it up without a manual step. When the
  // list is emptied, DROP the section so no stale toolpath lingers.
  useEffect(() => {
    if (points.length === 0) {
      removeSection('drilling')
      return
    }
    const id = window.setTimeout(() => setProgram('drilling', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram, removeSection])

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('drill.presets.aria', 'Drilling setting presets')}
      />
    <div className="scf-panel">
      {/* Slim header: title + icon toolbar. */}
      <header className="scf-head">
        <div className="scf-head-title">
          <span className="scf-head-name">{t('drill.title', 'Bore / Drill / Hole')}</span>
          <InfoTip
            topic="drillMode"
            title={t('drill.title', 'Bore / Drill / Hole')}
            body={t(
              'drill.intro',
              'Drills pilot/clearance holes at a set of points, with an optional counterbore/countersink for a screw head. Add points from the live machine position; the program auto-syncs to the Program tab for streaming.',
            )}
          />
        </div>
        <div className="scf-tools">
          <ToolButton
            className="scf-ico-primary"
            glyph={<Icon name="add" />}
            onClick={addRow}
            title={t('drill.toolbar.add', 'Add point')}
            body={
              connected
                ? t('drill.toolbar.add.body.live', 'Append a hole point at the current machine X/Y.')
                : t('drill.toolbar.add.body', 'Append a hole point at the origin (connect to capture the live position).')
            }
          />
          <ToolButton
            glyph={<Icon name="probe" />}
            onClick={recordPosition}
            disabled={!connected}
            title={t('drill.toolbar.record', 'Record position')}
            body={
              connected
                ? selected >= 0
                  ? t('drill.toolbar.record.body.fill', 'Fills the selected row X/Y from the live machine position.')
                  : t('drill.toolbar.record.body.append', 'Appends a point at the current machine position.')
                : t('drill.toolbar.record.body.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            className="scf-ico-danger"
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={points.length === 0}
            title={t('drill.toolbar.clear', 'Clear all')}
            body={t('drill.toolbar.clear.body', 'Remove every hole point and start over.')}
          />
          <span className="scf-tools-sep" aria-hidden="true" />
          <ToolButton
            glyph={<Icon name="copy" />}
            onClick={copyGcode}
            disabled={points.length === 0}
            title={t('drill.toolbar.copy', 'Copy G-code')}
            body={t('drill.toolbar.copy.body', 'Copy the generated drilling program to the clipboard.')}
          />
          <ToolButton
            glyph={<Icon name="download" />}
            onClick={downloadGcode}
            disabled={points.length === 0}
            title={t('drill.toolbar.download', 'Download G-code')}
            body={t('drill.toolbar.download.body', 'Download the generated drilling program as a .nc file.')}
          />
          <SaveLoadButtons
            value={doc}
            onLoad={loadDoc}
            fileBase="karmyogi-holes"
            ext="kdrill"
            saveDisabled={points.length === 0}
            saveTitle={t('drill.save', 'Save hole list')}
            loadTitle={t('drill.load', 'Load hole list')}
            onError={(m) => notify('warn', m)}
          />
          <span className="scf-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('drill.toolbar.settings', 'Settings')}
            body={t('drill.toolbar.settings.body', 'Hole size, hole type/depth, peck increment, counterbore/countersink, feeds and Safe-Z.')}
          />
        </div>
      </header>

      {/* Live status strip: point + line counts, drilled diameter, auto-synced. */}
      <div className="scf-status">
        <span className="scf-status-pill">
          <b>{points.length}</b> {t('drill.status.points', 'holes')}
        </span>
        <span className="scf-status-sep" aria-hidden="true">·</span>
        <span className="scf-status-pill">
          <b>{lineCount}</b> {t('drill.status.lines', 'G-code lines')}
        </span>
        <span className="scf-status-sep" aria-hidden="true">·</span>
        <span className="scf-status-pill">
          {preset.label} <b>⌀{drilledDia.toFixed(2)}</b> {t('unit.mm', 'mm')}
        </span>
        <span className="scf-status-sync" title={t('drill.live.title', 'Lines auto-synced to the Program tab')}>
          → {t('drill.status.program', 'Program')}
        </span>
      </div>

      {recessTooWide && (
        <p className="scf-warn">
          {t(
            'drill.warn.recessWide',
            'The recess tool (⌀{tool}) is not smaller than the screw head (⌀{head}) — no recess is cut. Use a smaller tool or disable the recess.',
            { tool: safeParams.toolDia.toFixed(2), head: preset.headDia.toFixed(2) },
          )}
        </p>
      )}
      {recessDeeper && (
        <p className="scf-warn">
          {t(
            'drill.warn.recessDeep',
            'Recess depth ({rd}) ≥ hole depth ({hd}) — the head seat reaches the bottom of the hole. Reduce the recess depth.',
            { rd: safeParams.recessDepth.toFixed(2), hd: safeParams.holeDepth.toFixed(2) },
          )}
        </p>
      )}
      {!connected && points.length > 0 && (
        <p className="scf-warn">
          {t('drill.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Collapsible Settings. */}
      {showSettings && (
        <section className="scf-settings">
          <div className="scf-card">
            <div className="scf-card-head">
              <h4>{t('drill.hole.title', 'Hole')}</h4>
              <InfoTip
                topic="drillHole"
                title={t('drill.hole.title', 'Hole')}
                body={t('drill.hole.body', 'Pick the metric size, choose a pilot (tapping) or clearance (through) hole, and set the full hole depth and the peck increment.')}
              />
            </div>
            <div className="scf-fields">
              <label className="scf-field">
                <span className="scf-field-label">
                  {t('drill.field.preset', 'Size')}
                  <InfoTip
                    topic="drillPreset"
                    title={t('drill.field.preset', 'Size')}
                    body={t('drill.field.preset.body', 'Metric size. Sets the pilot, clearance and head diameters used to plan each hole.')}
                  />
                </span>
                <select
                  value={params.preset}
                  onChange={(e) => setParams((p) => ({ ...p, preset: e.target.value as ScrewPresetKey }))}
                >
                  {SCREW_PRESET_KEYS.map((k) => (
                    <option key={k} value={k}>{resolvePreset(k).label}</option>
                  ))}
                </select>
              </label>
              <label className="scf-field">
                <span className="scf-field-label">
                  {t('drill.field.hole', 'Hole type')}
                  <InfoTip
                    topic="drillHoleType"
                    title={t('drill.field.hole', 'Hole type')}
                    body={t('drill.field.hole.body', 'Pilot drills the tapping diameter (a screw threads into the part); clearance drills the wider through diameter (the shank passes freely).')}
                  />
                </span>
                <select
                  value={params.hole}
                  onChange={(e) => setParams((p) => ({ ...p, hole: e.target.value as HoleKind }))}
                >
                  <option value="pilot">{t('drill.hole.pilot', 'pilot (tap)')}</option>
                  <option value="clearance">{t('drill.hole.clearance', 'clearance')}</option>
                </select>
              </label>
              <NumField
                label={t('drill.field.holeDepth', 'Hole depth')}
                unit={t('unit.mm', 'mm')}
                min="0"
                value={params.holeDepth}
                onChange={(n) => setParams((p) => ({ ...p, holeDepth: n }))}
                info={{
                  title: t('drill.field.holeDepth', 'Hole depth'),
                  body: t('drill.field.holeDepth.body', 'How far below the work surface the hole is drilled (mm).'),
                }}
              />
              <NumField
                label={t('drill.field.peck', 'Peck')}
                unit={t('unit.mm', 'mm')}
                min="0"
                value={params.peck}
                onChange={(n) => setParams((p) => ({ ...p, peck: n }))}
                info={{
                  title: t('drill.field.peck', 'Peck increment'),
                  body: t('drill.field.peck.body', 'Depth drilled per plunge before a partial retract to clear chips. 0 = one straight plunge.'),
                }}
              />
              <p className="scf-preset-note">
                {t('drill.preset.note', 'Pilot ⌀{pilot} · clearance ⌀{clear} · head ⌀{head} mm', {
                  pilot: preset.pilotDia.toFixed(2),
                  clear: preset.clearanceDia.toFixed(2),
                  head: preset.headDia.toFixed(2),
                })}
              </p>
            </div>
          </div>

          <div className="scf-card">
            <div className="scf-card-head">
              <h4>{t('drill.recess.title', 'Head recess')}</h4>
              <InfoTip
                topic="drillRecess"
                title={t('drill.recess.title', 'Head recess')}
                body={t('drill.recess.body', 'Optionally mill a counterbore (flat-bottomed bore for a cap head) or countersink (conical seat for a flat head) above the hole, widening out to the screw-head diameter.')}
              />
            </div>
            <div className="scf-fields">
              <label className="scf-check">
                <input
                  type="checkbox"
                  checked={params.recess}
                  onChange={(e) => setParams((p) => ({ ...p, recess: e.target.checked }))}
                />
                {t('drill.field.recessOn', 'Cut a counterbore / countersink for the head')}
              </label>
              <label className="scf-field">
                <span className="scf-field-label">
                  {t('drill.field.recessKind', 'Recess')}
                  <InfoTip
                    topic="drillRecessKind"
                    title={t('drill.field.recessKind', 'Recess type')}
                    body={t('drill.field.recessKind.body', 'Counterbore = a flat-bottomed vertical-wall bore for a socket-cap head, milled out to the head diameter at the recess depth. Countersink = a true conical seat for a flat head, milled as stepped circular passes following the head angle ({angle}°) — widening from the hole at the bottom to the head diameter at the surface.', { angle: preset.countersinkAngle })}
                  />
                </span>
                <select
                  value={params.recessKind}
                  disabled={!params.recess}
                  onChange={(e) => setParams((p) => ({ ...p, recessKind: e.target.value as RecessKind }))}
                >
                  <option value="counterbore">{t('drill.recess.counterbore', 'counterbore')}</option>
                  <option value="countersink">{t('drill.recess.countersink', 'countersink')}</option>
                </select>
              </label>
              <NumField
                label={t('drill.field.recessDepth', 'Recess depth')}
                unit={t('unit.mm', 'mm')}
                min="0"
                value={params.recessDepth}
                onChange={(n) => setParams((p) => ({ ...p, recessDepth: n }))}
                info={{
                  title: t('drill.field.recessDepth', 'Recess depth'),
                  body: t('drill.field.recessDepth.body', 'How far below the surface the head recess is cut (mm).'),
                }}
              />
              <NumField
                label={t('drill.field.toolDia', 'Tool ⌀')}
                unit={t('unit.mm', 'mm')}
                min="0.01"
                value={params.toolDia}
                onChange={(n) => setParams((p) => ({ ...p, toolDia: n }))}
                info={{
                  title: t('drill.field.toolDia', 'Tool diameter'),
                  body: t('drill.field.toolDia.body', 'End-mill diameter used to widen the recess to the head diameter (mm). Must be smaller than the screw head.'),
                }}
              />
              <p className="scf-preset-note">
                {params.recessKind === 'countersink'
                  ? t('drill.recess.note.countersink', 'Conical seat ⌀{head} mm at {angle}° included, sloping down to the hole.', {
                      head: preset.headDia.toFixed(2),
                      angle: preset.countersinkAngle,
                    })
                  : t('drill.recess.note.counterbore', 'Flat bore ⌀{head} mm at the recess depth.', {
                      head: preset.headDia.toFixed(2),
                    })}
              </p>
            </div>
          </div>

          <div className="scf-card">
            <div className="scf-card-head">
              <h4>{t('drill.motion.title', 'Feeds & motion')}</h4>
              <InfoTip
                topic="drillMotion"
                title={t('drill.motion.title', 'Feeds & motion')}
                body={t('drill.motion.body', 'Plunge feed for drilling, horizontal feed for recess passes, the guaranteed Safe-Z retract height, and the emitted coordinate precision.')}
              />
            </div>
            <div className="scf-fields">
              <NumField
                label={t('drill.field.plunge', 'Plunge')}
                unit={t('unit.mmPerMin', 'mm/min')}
                step="10"
                min="0"
                value={params.plunge}
                onChange={(n) => setParams((p) => ({ ...p, plunge: n }))}
                info={{
                  title: t('drill.field.plunge', 'Plunge feed'),
                  body: t('drill.field.plunge.body', 'Feed rate for the Z descents (drilling and recess plunge).'),
                }}
              />
              <NumField
                label={t('drill.field.feed', 'Feed')}
                unit={t('unit.mmPerMin', 'mm/min')}
                step="10"
                min="0"
                value={params.feed}
                onChange={(n) => setParams((p) => ({ ...p, feed: n }))}
                info={{
                  title: t('drill.field.feed', 'Feed'),
                  body: t('drill.field.feed.body', 'Horizontal feed rate for the circular recess passes.'),
                }}
              />
              <NumField
                label={t('drill.field.safeZ', 'Safe-Z')}
                unit={t('unit.mm', 'mm')}
                min="0"
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('drill.field.safeZ', 'Safe-Z'),
                  body: t('drill.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
              <NumField
                label={t('drill.field.decimals', 'Decimals')}
                step="1"
                min="0"
                max="6"
                value={params.decimals}
                parse={(v, fb) => clampDecimals(intNum(v, fb))}
                onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                info={{
                  title: t('drill.field.decimals', 'Decimals'),
                  body: t('drill.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).'),
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Points — compact editable table (reflows to stacked cards when narrow). */}
      <div className="scf-card scf-points">
        <div className="scf-card-head">
          <h4>{t('drill.points.title', 'Hole points')}</h4>
          <span className="scf-card-count">{points.length}</span>
        </div>
        <div className="scf-table-wrap">
          <table className="scf-table">
            <thead>
              <tr>
                <th className="scf-idx">{t('drill.table.num', '#')}</th>
                <th>{t('drill.table.x', 'X')}</th>
                <th>{t('drill.table.y', 'Y')}</th>
                <th className="scf-actions-col" aria-label={t('drill.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={4} className="scf-empty">
                    {t(
                      'drill.table.empty',
                      'No holes yet. Press + to add one, or ⌖ to record the machine position.',
                    )}
                  </td>
                </tr>
              )}
              {points.map((pt, i) => (
                <tr
                  key={i}
                  className={i === selected ? 'scf-row-selected' : undefined}
                  onClick={() => setSelected(i)}
                >
                  <td className="scf-idx">{i + 1}</td>
                  <td data-label={t('drill.table.x', 'X')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label={t('drill.table.y', 'Y')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.y}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    />
                  </td>
                  <td className="scf-actions">
                    <button
                      className="scf-row-ico"
                      title={t('drill.row.moveUp', 'Move up')}
                      aria-label={t('drill.row.moveUp', 'Move up')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, -1)
                      }}
                      disabled={i === 0}
                    >
                      ↑
                    </button>
                    <button
                      className="scf-row-ico"
                      title={t('drill.row.moveDown', 'Move down')}
                      aria-label={t('drill.row.moveDown', 'Move down')}
                      onClick={(e) => {
                        e.stopPropagation()
                        moveRow(i, 1)
                      }}
                      disabled={i === points.length - 1}
                    >
                      ↓
                    </button>
                    <button
                      className="scf-row-ico scf-del"
                      title={t('drill.row.delete', 'Delete point')}
                      aria-label={t('drill.row.delete', 'Delete point')}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteRow(i)
                      }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Narrow PANEL: each point becomes a compact card. */}
        <div className="scf-cards">
          {points.length === 0 && (
            <p className="scf-empty">
              {t(
                'drill.table.empty',
                'No holes yet. Press + to add one, or ⌖ to record the machine position.',
              )}
            </p>
          )}
          {points.map((pt, i) => (
            <div
              key={i}
              className={`scf-pcard${i === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(i)}
            >
              <div className="scf-pcard-head">
                <span className="scf-pcard-idx">
                  {t('drill.card.point', 'Hole')} {i + 1}
                </span>
                <div className="scf-pcard-actions">
                  <button
                    className="scf-row-ico"
                    title={t('drill.row.moveUp', 'Move up')}
                    aria-label={t('drill.row.moveUp', 'Move up')}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveRow(i, -1)
                    }}
                    disabled={i === 0}
                  >
                    ↑
                  </button>
                  <button
                    className="scf-row-ico"
                    title={t('drill.row.moveDown', 'Move down')}
                    aria-label={t('drill.row.moveDown', 'Move down')}
                    onClick={(e) => {
                      e.stopPropagation()
                      moveRow(i, 1)
                    }}
                    disabled={i === points.length - 1}
                  >
                    ↓
                  </button>
                  <button
                    className="scf-row-ico scf-del"
                    title={t('drill.row.delete', 'Delete point')}
                    aria-label={t('drill.row.delete', 'Delete point')}
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteRow(i)
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>

              <div className="scf-pcard-grid">
                <label className="scf-mini">
                  <span>{t('drill.table.x', 'X')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.x}
                    onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="scf-mini">
                  <span>{t('drill.table.y', 'Y')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.y}
                    onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
      <PresetSaveBar
        slots={presets.slots}
        selected={presets.selected}
        onSelect={presets.select}
        onSave={presets.save}
        onClear={presets.clear}
        onRename={presets.rename}
        extra={
          <SaveLoadButtons
            value={params}
            onLoad={(data) => setParams(toParams(data))}
            fileBase="drilling-settings"
            ext="kdset"
            saveTitle={t('drill.settings.save', 'Save drilling settings')}
            loadTitle={t('drill.settings.load', 'Load drilling settings')}
            onError={(m) => notify('warn', m)}
          />
        }
      />
    </div>
  )
}
