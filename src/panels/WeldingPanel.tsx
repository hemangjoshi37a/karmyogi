import { useEffect, useMemo, useState } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import {
  WeavePattern,
  defaultWeldLine,
  defaultWeldCircle,
  defaultWeldingParams,
  generateWelding,
  newWeldId,
  totalWeldLength,
  countLines,
  type Vec3,
  type WeldObject,
  type WeldLine,
  type WeldCircle,
  type WeldingParams,
} from '../core/welding'
import '../styles/welding.css'

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

/** Persisted GLOBAL params (everything except the fixed programName/metric). */
type PersistParams = Omit<WeldingParams, 'programName' | 'metric'>

/** Default persisted params, derived from the core defaults. */
function defaultParams(): PersistParams {
  const d = defaultWeldingParams()
  return {
    safeZ: d.safeZ,
    plungeFeed: d.plungeFeed,
    segmentsPerCycle: d.segmentsPerCycle,
    useArc: d.useArc,
    arcPower: d.arcPower,
    preFlowSeconds: d.preFlowSeconds,
    postFlowSeconds: d.postFlowSeconds,
    decimals: d.decimals,
  }
}

/** The serializable Welding document written by Save / read by Load. */
interface WeldingDoc {
  kind: 'karmyogi.welding'
  version: 2
  objects: WeldObject[]
  params: PersistParams
}

const VALID_PATTERNS: WeavePattern[] = [
  WeavePattern.Straight,
  WeavePattern.Zigzag,
  WeavePattern.Sine,
  WeavePattern.Circular,
]

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const boolOr = (v: unknown, fallback: boolean): boolean =>
  typeof v === 'boolean' ? v : fallback

const patternOr = (v: unknown, fallback: WeavePattern): WeavePattern =>
  VALID_PATTERNS.includes(v as WeavePattern) ? (v as WeavePattern) : fallback

/** Narrow an unknown into a Vec3, defaulting each coord. */
function parseVec3(v: unknown, base: Vec3): Vec3 {
  if (!isRecord(v)) return { ...base }
  return { x: numOr(v.x, base.x), y: numOr(v.y, base.y), z: numOr(v.z, base.z) }
}

/**
 * Narrow one unknown entry into a valid WeldObject, dropping bad ones (returns
 * null). Never throws. Accepts both `line` and `circle` kinds; coords/feeds/
 * pattern are validated per-field with sensible fallbacks.
 */
function parseObject(v: unknown): WeldObject | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' && v.id.length > 0 ? v.id : newWeldId()
  if (v.kind === 'circle') {
    const base = defaultWeldCircle()
    return {
      id,
      kind: 'circle',
      center: parseVec3(v.center, base.center),
      radius: numOr(v.radius, base.radius),
      peripheralFeed: numOr(v.peripheralFeed, base.peripheralFeed),
      pattern: patternOr(v.pattern, base.pattern),
      amplitude: numOr(v.amplitude, base.amplitude),
      patternSpeed: numOr(v.patternSpeed, base.patternSpeed),
    }
  }
  if (v.kind === 'line') {
    const base = defaultWeldLine()
    return {
      id,
      kind: 'line',
      start: parseVec3(v.start, base.start),
      end: parseVec3(v.end, base.end),
      travelFeed: numOr(v.travelFeed, base.travelFeed),
      pattern: patternOr(v.pattern, base.pattern),
      amplitude: numOr(v.amplitude, base.amplitude),
      patternSpeed: numOr(v.patternSpeed, base.patternSpeed),
    }
  }
  return null
}

/** Narrow unknown params into valid PersistParams, falling back per-field. */
function parseWeldParams(v: unknown, base: PersistParams): PersistParams {
  if (!isRecord(v)) return base
  return {
    safeZ: numOr(v.safeZ, base.safeZ),
    plungeFeed: numOr(v.plungeFeed, base.plungeFeed),
    segmentsPerCycle: numOr(v.segmentsPerCycle, base.segmentsPerCycle),
    useArc: boolOr(v.useArc, base.useArc),
    arcPower: numOr(v.arcPower, base.arcPower),
    preFlowSeconds: numOr(v.preFlowSeconds, base.preFlowSeconds),
    postFlowSeconds: numOr(v.postFlowSeconds, base.postFlowSeconds),
    decimals: numOr(v.decimals, base.decimals),
  }
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` are
 * combined into a native hover tooltip explainer that never intercepts the
 * action click, keeping the toolbar compact while every button is self-doc.
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
      className={`wp-ico${className ? ' ' + className : ''}`}
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
    <label className="wp-field">
      <span className="wp-field-label">
        {label}
        {info && <InfoTip topic="weldField" title={info.title} body={info.body} />}
      </span>
      <span className={`wp-input${unit ? ' has-unit' : ''}`}>
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
 * Welding panel — a 3-axis welding planner. The operator defines a LIST of weld
 * OBJECTS: true 3D LINES (start {x,y,z} → end {x,y,z}, any angle) and CIRCLES
 * (centre {x,y,z} + radius, perimeter in the XY plane). Each object carries its
 * own travel/peripheral feed, weave pattern, amplitude and a separate PATTERN
 * SPEED — the weave density follows the ratio patternSpeed/travelSpeed (higher
 * pattern speed ⇒ denser weave). Global settings hold arc/gas control, safe-Z,
 * plunge feed and smoothness. The pure `generateWelding` core emits a safe
 * program where the spindle output is repurposed as the welder/arc on-off
 * (M3/M5) with gas pre-/post-flow dwells. "Record" captures the live machine
 * work-position into the selected field. Generation is live: every edit pushes
 * a fresh program into the shared store (Visualizer renders / Program streams).
 */
export function WeldingPanel() {
  const t = useT()
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)

  const [objects, setObjects] = usePersistentState<WeldObject[]>('karmyogi.welding.objects', [])
  const [selected, setSelected] = usePersistentState<string>('karmyogi.welding.selectedId', '')
  const [showSettings, setShowSettings] = usePersistentState<boolean>(
    'karmyogi.welding.showSettings',
    false,
  )
  const [params, setParams] = usePersistentState<PersistParams>(
    'karmyogi.welding.params',
    defaultParams(),
  )
  const [loadError, setLoadError] = useState<string>('')

  function addLine() {
    const line = defaultWeldLine()
    setObjects((s) => [...s, line])
    setSelected(line.id)
  }

  function addCircle() {
    const circle = defaultWeldCircle()
    setObjects((s) => [...s, circle])
    setSelected(circle.id)
  }

  function deleteObject(id: string) {
    setObjects((s) => s.filter((o) => o.id !== id))
    setSelected((sel) => (sel === id ? '' : sel))
  }

  function moveObject(id: string, dir: -1 | 1) {
    setObjects((s) => {
      const i = s.findIndex((o) => o.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= s.length) return s
      const next = [...s]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function updateObject(id: string, patch: Partial<WeldLine> & Partial<WeldCircle>) {
    setObjects((s) => s.map((o) => (o.id === id ? ({ ...o, ...patch } as WeldObject) : o)))
  }

  /** Convert the selected object between line and circle, preserving weave. */
  function setKind(id: string, kind: 'line' | 'circle') {
    setObjects((s) =>
      s.map((o) => {
        if (o.id !== id || o.kind === kind) return o
        if (kind === 'circle') {
          const base = defaultWeldCircle()
          const from = o as WeldLine
          return {
            id: o.id,
            kind: 'circle',
            center: { ...from.start },
            radius: base.radius,
            peripheralFeed: from.travelFeed,
            pattern: o.pattern,
            amplitude: o.amplitude,
            patternSpeed: o.patternSpeed,
          }
        }
        const base = defaultWeldLine()
        const from = o as WeldCircle
        return {
          id: o.id,
          kind: 'line',
          start: { ...from.center },
          end: { x: from.center.x + base.end.x, y: from.center.y, z: from.center.z },
          travelFeed: from.peripheralFeed,
          pattern: o.pattern,
          amplitude: o.amplitude,
          patternSpeed: o.patternSpeed,
        }
      }),
    )
  }

  /** Patch a single coord of a Vec3 field (start/end/center) on an object. */
  function updateVec(id: string, field: 'start' | 'end' | 'center', axis: 'x' | 'y' | 'z', val: number) {
    setObjects((s) =>
      s.map((o) => {
        if (o.id !== id) return o
        const cur = (o as unknown as Record<string, Vec3>)[field]
        if (!cur) return o
        return { ...o, [field]: { ...cur, [axis]: val } } as WeldObject
      }),
    )
  }

  // Record the live machine work-position into the selected object's field.
  function recordPoint(field: 'start' | 'end' | 'center') {
    if (!connected) return
    const obj = objects.find((o) => o.id === selected)
    if (!obj) return
    const pos: Vec3 = { x: wpos.x, y: wpos.y, z: wpos.z }
    if (field === 'center' && obj.kind === 'circle') {
      updateObject(obj.id, { center: pos })
    } else if (field === 'start' && obj.kind === 'line') {
      updateObject(obj.id, { start: pos })
    } else if (field === 'end' && obj.kind === 'line') {
      updateObject(obj.id, { end: pos })
    }
  }

  // Live G-code preview, recomputed whenever objects/params change.
  const gcode = useMemo(() => generateWelding(objects, { ...params }), [objects, params])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  const weldLen = useMemo(() => totalWeldLength(objects), [objects])
  const nLines = useMemo(() => countLines(objects), [objects])

  // Live generation: push the freshly-computed program (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step.
  useEffect(() => {
    if (objects.length === 0) return
    const id = window.setTimeout(() => setProgram('welding', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, objects.length, setProgram])

  const selObj = objects.find((o) => o.id === selected)
  const canRecStartEnd = connected && selObj?.kind === 'line'
  const canRecCenter = connected && selObj?.kind === 'circle'

  // ---- Save / Load document ------------------------------------------------
  const doc: WeldingDoc = { kind: 'karmyogi.welding', version: 2, objects, params }

  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('weld.load.bad', 'Could not load — not a valid welding file.'))
      return
    }
    if (Array.isArray(data.objects)) {
      const next: WeldObject[] = []
      for (const raw of data.objects) {
        const o = parseObject(raw)
        if (o) next.push(o)
      }
      setObjects(next)
      setSelected(next.length > 0 ? next[0].id : '')
    }
    setParams((p) => parseWeldParams(data.params, p))
    setLoadError('')
  }

  return (
    <div className="wp-panel">
      {/* Slim header: title + icon toolbar. */}
      <header className="wp-head">
        <div className="wp-head-title">
          <span className="wp-head-name">{t('weld.title', 'Welding')}</span>
          <InfoTip
            topic="weldMode"
            title={t('weld.title', 'Welding')}
            body={t(
              'weld.intro',
              'Welds a list of 3D LINES (any angle) and CIRCLES with a per-object weave. Each object has its own travel/peripheral feed, pattern, amplitude and a separate pattern speed — weave density follows pattern-speed ÷ travel-speed. The spindle output drives the welder/arc (M3 on, M5 off) with gas pre/post-flow. The program auto-syncs to the Program tab.',
            )}
          />
        </div>
        <div className="wp-tools">
          <ToolButton
            className="wp-ico-primary"
            glyph="╱"
            onClick={addLine}
            title={t('weld.toolbar.addLine', 'Add line')}
            body={t('weld.toolbar.addLine.body', 'Append a 3D weld line (start {x,y,z} → end {x,y,z}) you can edit.')}
          />
          <ToolButton
            className="wp-ico-primary"
            glyph="◯"
            onClick={addCircle}
            title={t('weld.toolbar.addCircle', 'Add circle')}
            body={t('weld.toolbar.addCircle.body', 'Append a circular weld (centre {x,y,z} + radius), perimeter traced in the XY plane.')}
          />
          <ToolButton
            glyph="⇤"
            onClick={() => recordPoint('start')}
            disabled={!canRecStartEnd}
            title={t('weld.toolbar.recStart', 'Record start')}
            body={
              connected
                ? selObj?.kind === 'line'
                  ? t('weld.toolbar.recStart.body', 'Set the selected line START {x,y,z} from the live machine position.')
                  : t('weld.toolbar.selectLine', 'Select a line object first.')
                : t('weld.toolbar.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            glyph="⇥"
            onClick={() => recordPoint('end')}
            disabled={!canRecStartEnd}
            title={t('weld.toolbar.recEnd', 'Record end')}
            body={
              connected
                ? selObj?.kind === 'line'
                  ? t('weld.toolbar.recEnd.body', 'Set the selected line END {x,y,z} from the live machine position.')
                  : t('weld.toolbar.selectLine', 'Select a line object first.')
                : t('weld.toolbar.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            glyph="⊙"
            onClick={() => recordPoint('center')}
            disabled={!canRecCenter}
            title={t('weld.toolbar.recCenter', 'Record centre')}
            body={
              connected
                ? selObj?.kind === 'circle'
                  ? t('weld.toolbar.recCenter.body', 'Set the selected circle CENTRE {x,y,z} from the live machine position.')
                  : t('weld.toolbar.selectCircle', 'Select a circle object first.')
                : t('weld.toolbar.connect', 'Connect to a machine to capture its live position.')
            }
          />
          <ToolButton
            className="wp-ico-danger"
            glyph="🗑"
            onClick={() => setObjects([])}
            disabled={objects.length === 0}
            title={t('weld.toolbar.clear', 'Clear all')}
            body={t('weld.toolbar.clear.body', 'Remove every object and start over.')}
          />
          <span className="wp-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph="⚙"
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('weld.toolbar.settings', 'Settings')}
            body={t('weld.toolbar.settings.body', 'Global arc power, gas pre/post-flow, safe-Z, plunge feed and weave smoothness. Per-object speed/pattern/amplitude live on each card.')}
          />
          <span className="wp-tools-sep" aria-hidden="true" />
          <SaveLoadButtons
            value={doc}
            onLoad={loadDoc}
            onError={setLoadError}
            fileBase="karmyogi-welding"
            ext="kweld"
            saveDisabled={objects.length === 0}
            saveTitle={t('weld.toolbar.save', 'Save objects + settings')}
            loadTitle={t('weld.toolbar.load', 'Load objects + settings')}
          />
        </div>
      </header>

      {/* Live status strip: object + length + line counts, synced to Program. */}
      <div className="wp-status">
        <span className="wp-status-pill">
          <b>{objects.length}</b> {t('weld.status.objects', 'objects')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span className="wp-status-pill">
          <b>{nLines}</b> {t('weld.status.lines2', 'lines')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span className="wp-status-pill">
          <b>{weldLen.toFixed(1)}</b> {t('weld.status.mm', 'mm weld')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span className="wp-status-pill">
          <b>{lineCount}</b> {t('weld.status.gcode', 'G-code lines')}
        </span>
        <span className="wp-status-sync" title={t('weld.live.title', 'Lines auto-synced to the Program tab')}>
          → {t('weld.status.program', 'Program')}
        </span>
      </div>

      {loadError && <p className="wp-warn">{loadError}</p>}

      {!connected && objects.length > 0 && (
        <p className="wp-warn">
          {t('weld.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Collapsible global Settings: arc/gas + motion, dense tiling cards. */}
      {showSettings && (
        <section className="wp-settings">
          <div className="wp-card">
            <div className="wp-card-head">
              <h4>{t('weld.motion.title', 'Travel & motion')}</h4>
              <InfoTip
                topic="weldMotion"
                title={t('weld.motion.title', 'Travel & motion')}
                body={t('weld.motion.body', 'Global motion. Safe-Z is the guaranteed retract; plunge feed lowers to the weld Z. Smoothness sets sampled points per weave cycle. Per-object travel speed lives on each card.')}
              />
            </div>
            <div className="wp-fields">
              <NumField
                label={t('weld.field.safeZ', 'Safe-Z')}
                unit="mm"
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('weld.field.safeZ', 'Safe-Z'),
                  body: t('weld.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
              <NumField
                label={t('weld.field.plungeF', 'Plunge')}
                unit="mm/min"
                step="10"
                min="1"
                value={params.plungeFeed}
                onChange={(n) => setParams((p) => ({ ...p, plungeFeed: n }))}
                info={{
                  title: t('weld.field.plungeF', 'Plunge'),
                  body: t('weld.field.plungeF.body', 'Feed rate used to lower the torch from Safe-Z to the weld Z.'),
                }}
              />
              <NumField
                label={t('weld.field.segs', 'Smoothness')}
                unit="pts/cyc"
                step="1"
                min="2"
                value={params.segmentsPerCycle}
                parse={intNum}
                onChange={(n) => setParams((p) => ({ ...p, segmentsPerCycle: n }))}
                info={{
                  title: t('weld.field.segs', 'Smoothness'),
                  body: t('weld.field.segs.body', 'Sampled points per weave cycle. Higher = smoother sine/circular curves at the cost of more G-code lines.'),
                }}
              />
              <NumField
                label={t('weld.field.decimals', 'Decimals')}
                step="1"
                min="0"
                max="6"
                value={params.decimals}
                parse={intNum}
                onChange={(n) => setParams((p) => ({ ...p, decimals: n }))}
                info={{
                  title: t('weld.field.decimals', 'Decimals'),
                  body: t('weld.field.decimals.body', 'Number of decimal places in the emitted coordinates.'),
                }}
              />
            </div>
          </div>

          <div className="wp-card">
            <div className="wp-card-head">
              <h4>{t('weld.arc.title', 'Arc & gas')}</h4>
              <InfoTip
                topic="weldArc"
                title={t('weld.arc.title', 'Arc & gas')}
                body={t('weld.arc.body', 'The spindle output is the welder/arc: M3 (S = power) strikes it, M5 stops it. Gas pre-flow runs before striking; post-flow runs after stopping.')}
              />
            </div>
            <div className="wp-fields">
              <label className="wp-field wp-field-check">
                <span className="wp-field-label">
                  {t('weld.field.useArc', 'Arc control')}
                  <InfoTip
                    topic="weldUseArc"
                    title={t('weld.field.useArc', 'Arc control')}
                    body={t('weld.field.useArc.body', 'Emit M3/M5 around each object. Turn off to move the path without striking the arc (dry run).')}
                  />
                </span>
                <label className={`wp-switch${params.useArc ? ' is-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={params.useArc}
                    onChange={(e) => setParams((p) => ({ ...p, useArc: e.target.checked }))}
                  />
                  <span>{params.useArc ? t('weld.on', 'On') : t('weld.off', 'Off')}</span>
                </label>
              </label>
              <NumField
                label={t('weld.field.arcPower', 'Arc power')}
                unit="S"
                step="10"
                min="0"
                value={params.arcPower}
                onChange={(n) => setParams((p) => ({ ...p, arcPower: n }))}
                info={{
                  title: t('weld.field.arcPower', 'Arc power'),
                  body: t('weld.field.arcPower.body', 'Emitted as the S word (M3 S<power>). Set 0 for a plain M3 with no power word.'),
                }}
              />
              <NumField
                label={t('weld.field.preFlow', 'Pre-flow')}
                unit="s"
                min="0"
                value={params.preFlowSeconds}
                onChange={(n) => setParams((p) => ({ ...p, preFlowSeconds: n }))}
                info={{
                  title: t('weld.field.preFlow', 'Pre-flow'),
                  body: t('weld.field.preFlow.body', 'Gas dwell (G4 P) after lowering but before the arc strikes. 0 = none.'),
                }}
              />
              <NumField
                label={t('weld.field.postFlow', 'Post-flow')}
                unit="s"
                min="0"
                value={params.postFlowSeconds}
                onChange={(n) => setParams((p) => ({ ...p, postFlowSeconds: n }))}
                info={{
                  title: t('weld.field.postFlow', 'Post-flow'),
                  body: t('weld.field.postFlow.body', 'Gas dwell (G4 P) after the arc stops, before retract. 0 = none.'),
                }}
              />
            </div>
          </div>
        </section>
      )}

      {/* Weld objects — one editable card each (line or circle). */}
      <div className="wp-card wp-objects">
        <div className="wp-card-head">
          <h4>{t('weld.objects.title', 'Weld objects')}</h4>
          <span className="wp-card-count">{objects.length}</span>
        </div>
        <div className="wp-obj-list">
          {objects.length === 0 && (
            <p className="wp-empty">
              {t('weld.empty', 'No objects yet. Press ╱ for a 3D line or ◯ for a circle, then ⇤ / ⇥ / ⊙ to record machine positions.')}
            </p>
          )}
          {objects.map((obj, i) => (
            <ObjectCard
              key={obj.id}
              obj={obj}
              index={i}
              isFirst={i === 0}
              isLast={i === objects.length - 1}
              selected={obj.id === selected}
              t={t}
              onSelect={() => setSelected(obj.id)}
              onSetKind={(k) => setKind(obj.id, k)}
              onUpdate={(patch) => updateObject(obj.id, patch)}
              onUpdateVec={(field, axis, val) => updateVec(obj.id, field, axis, val)}
              onMove={(dir) => moveObject(obj.id, dir)}
              onDelete={() => deleteObject(obj.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/** One weld object as an editable card. Line shows start/end XYZ; circle shows
 * centre XYZ + radius. Both show feed, pattern, amplitude, pattern speed. */
function ObjectCard(props: {
  obj: WeldObject
  index: number
  isFirst: boolean
  isLast: boolean
  selected: boolean
  t: ReturnType<typeof useT>
  onSelect: () => void
  onSetKind: (k: 'line' | 'circle') => void
  onUpdate: (patch: Partial<WeldLine> & Partial<WeldCircle>) => void
  onUpdateVec: (field: 'start' | 'end' | 'center', axis: 'x' | 'y' | 'z', val: number) => void
  onMove: (dir: -1 | 1) => void
  onDelete: () => void
}) {
  const { obj, index, isFirst, isLast, selected, t, onSelect, onSetKind, onUpdate, onUpdateVec, onMove, onDelete } = props
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const vecRow = (label: string, field: 'start' | 'end' | 'center', v: Vec3) => (
    <div className="wp-vec">
      <span className="wp-vec-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis} className="wp-mini">
          <span>{axis.toUpperCase()}</span>
          <input
            type="number"
            step="0.1"
            value={v[axis]}
            onClick={stop}
            onChange={(e) => onUpdateVec(field, axis, num(e.target.value, v[axis]))}
          />
        </label>
      ))}
    </div>
  )

  return (
    <div className={`wp-ocard${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <div className="wp-ocard-head">
        <span className="wp-ocard-idx">
          {obj.kind === 'line' ? t('weld.card.line', 'Line') : t('weld.card.circle', 'Circle')} {index + 1}
        </span>
        <div className="wp-kind-toggle" onClick={stop} role="group" aria-label={t('weld.card.kind', 'Kind')}>
          <button
            type="button"
            className={`wp-kind-btn${obj.kind === 'line' ? ' is-on' : ''}`}
            onClick={() => onSetKind('line')}
            title={t('weld.card.line', 'Line')}
          >
            {t('weld.card.line', 'Line')}
          </button>
          <button
            type="button"
            className={`wp-kind-btn${obj.kind === 'circle' ? ' is-on' : ''}`}
            onClick={() => onSetKind('circle')}
            title={t('weld.card.circle', 'Circle')}
          >
            {t('weld.card.circle', 'Circle')}
          </button>
        </div>
        <div className="wp-ocard-actions">
          <button className="wp-row-ico" title={t('weld.row.moveUp', 'Move up')}
            aria-label={t('weld.row.moveUp', 'Move up')}
            onClick={(e) => { stop(e); onMove(-1) }} disabled={isFirst}>↑</button>
          <button className="wp-row-ico" title={t('weld.row.moveDown', 'Move down')}
            aria-label={t('weld.row.moveDown', 'Move down')}
            onClick={(e) => { stop(e); onMove(1) }} disabled={isLast}>↓</button>
          <button className="wp-row-ico wp-del" title={t('weld.row.delete', 'Delete')}
            aria-label={t('weld.row.delete', 'Delete')}
            onClick={(e) => { stop(e); onDelete() }}>✕</button>
        </div>
      </div>

      <div className="wp-ocard-geom">
        {obj.kind === 'line' ? (
          <>
            {vecRow(t('weld.geom.start', 'Start'), 'start', obj.start)}
            {vecRow(t('weld.geom.end', 'End'), 'end', obj.end)}
          </>
        ) : (
          <>
            {vecRow(t('weld.geom.center', 'Centre'), 'center', obj.center)}
            <div className="wp-vec">
              <span className="wp-vec-label">{t('weld.geom.radius', 'Radius')}</span>
              <label className="wp-mini wp-mini-wide">
                <span>R</span>
                <input
                  type="number"
                  step="0.1"
                  value={obj.radius}
                  onClick={stop}
                  onChange={(e) => onUpdate({ radius: num(e.target.value, obj.radius) })}
                />
              </label>
            </div>
          </>
        )}
      </div>

      <div className="wp-ocard-weave" onClick={stop}>
        <label className="wp-mini">
          <span>{obj.kind === 'line' ? t('weld.weave.travel', 'Travel') : t('weld.weave.peripheral', 'Periph.')}</span>
          <span className="wp-mini-unit">
            <input
              type="number"
              step="10"
              min="1"
              value={obj.kind === 'line' ? obj.travelFeed : obj.peripheralFeed}
              onChange={(e) =>
                obj.kind === 'line'
                  ? onUpdate({ travelFeed: num(e.target.value, obj.travelFeed) })
                  : onUpdate({ peripheralFeed: num(e.target.value, obj.peripheralFeed) })
              }
            />
            <i>mm/min</i>
          </span>
        </label>
        <label className="wp-mini">
          <span>{t('weld.weave.pattern', 'Pattern')}</span>
          <select
            value={obj.pattern}
            onChange={(e) => onUpdate({ pattern: e.target.value as WeavePattern })}
          >
            <option value={WeavePattern.Straight}>{t('weld.pattern.straight', 'Straight')}</option>
            <option value={WeavePattern.Zigzag}>{t('weld.pattern.zigzag', 'Zigzag')}</option>
            <option value={WeavePattern.Sine}>{t('weld.pattern.sine', 'Sine')}</option>
            <option value={WeavePattern.Circular}>{t('weld.pattern.circular', 'Circular')}</option>
          </select>
        </label>
        <label className="wp-mini">
          <span>{t('weld.weave.amp', 'Amplitude')}</span>
          <span className="wp-mini-unit">
            <input
              type="number"
              step="0.1"
              min="0"
              value={obj.amplitude}
              onChange={(e) => onUpdate({ amplitude: num(e.target.value, obj.amplitude) })}
            />
            <i>mm</i>
          </span>
        </label>
        <label className="wp-mini">
          <span className="wp-mini-info">
            {t('weld.weave.patSpeed', 'Pattern speed')}
            <InfoTip
              topic="weldPatSpeed"
              title={t('weld.weave.patSpeed', 'Pattern speed')}
              body={t('weld.weave.patSpeed.body', 'A second, independent speed (mm/min) that sets how fast the weave oscillates. Density = pattern-speed ÷ travel-speed: higher pattern speed packs more cycles per mm (denser weave), lower stretches them out (scattered).')}
            />
          </span>
          <span className="wp-mini-unit">
            <input
              type="number"
              step="10"
              min="1"
              value={obj.patternSpeed}
              onChange={(e) => onUpdate({ patternSpeed: num(e.target.value, obj.patternSpeed) })}
            />
            <i>mm/min</i>
          </span>
        </label>
      </div>
    </div>
  )
}
