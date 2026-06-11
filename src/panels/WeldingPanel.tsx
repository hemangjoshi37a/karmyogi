import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import {
  WeavePattern,
  defaultWeldLine,
  defaultWeldCircle,
  defaultWeldingParams,
  estimateWeldingSeconds,
  generateWelding,
  isDegenerate,
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

/** Clamp decimals to the range toFixed() accepts (0..6) — guards the
 * render-phase useMemo from a RangeError that would white-screen the panel. */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Human-readable duration from seconds (e.g. "1 m 30 s", "12 s"). */
function fmtDuration(totalSeconds: number, t: ReturnType<typeof useT>): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return t('time.seconds', '{s} s', { s })
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return t('time.minSec', '{m} m {s} s', { m, s: rem })
  const h = Math.floor(m / 60)
  const mm = m % 60
  return t('time.hourMin', '{h} h {m} m', { h, m: mm })
}

/**
 * Inline warnings for a single weld object — the operator sees, on the card,
 * exactly why an object would emit nothing useful:
 *  • zero-length line / zero-radius circle (degenerate — skipped entirely),
 *  • amplitude ≤ 0 while a non-Straight pattern is selected (the weave collapses
 *    to a plain bead, so the chosen pattern has no effect).
 */
function objectWarnings(obj: WeldObject, t: ReturnType<typeof useT>): string[] {
  const warns: string[] = []
  if (isDegenerate(obj)) {
    warns.push(
      obj.kind === 'line'
        ? t('weld.warn.zeroLine', 'Zero-length line — start and end coincide; nothing is welded.')
        : t('weld.warn.zeroCircle', 'Zero-radius circle — nothing is welded.'),
    )
  }
  if (obj.pattern !== WeavePattern.Straight && obj.amplitude <= 0) {
    warns.push(
      t('weld.warn.noAmp', 'Amplitude ≤ 0 with a {pattern} weave — the weave collapses to a straight bead.', {
        pattern: obj.pattern,
      }),
    )
  }
  return warns
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

/** Narrow unknown params into valid PersistParams, falling back per-field.
 * `decimals` is CLAMPED to 0..6 here so a corrupt/out-of-range value in a loaded
 * document (or persisted state) can never reach toFixed() and white-screen the
 * panel from inside the render-phase useMemo. */
function parseWeldParams(v: unknown, base: PersistParams): PersistParams {
  if (!isRecord(v)) return { ...base, decimals: clampDecimals(base.decimals) }
  return {
    safeZ: numOr(v.safeZ, base.safeZ),
    plungeFeed: numOr(v.plungeFeed, base.plungeFeed),
    segmentsPerCycle: numOr(v.segmentsPerCycle, base.segmentsPerCycle),
    useArc: boolOr(v.useArc, base.useArc),
    arcPower: numOr(v.arcPower, base.arcPower),
    preFlowSeconds: numOr(v.preFlowSeconds, base.preFlowSeconds),
    postFlowSeconds: numOr(v.postFlowSeconds, base.postFlowSeconds),
    decimals: clampDecimals(numOr(v.decimals, base.decimals)),
  }
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` are
 * combined into a native hover tooltip explainer that never intercepts the
 * action click, keeping the toolbar compact while every button is self-doc.
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
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)

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

  // Sanitize PERSISTED params once on mount: a value restored from localStorage
  // bypasses the input/load guards, so a corrupt out-of-range `decimals` could
  // otherwise reach toFixed() in the render-phase useMemo and white-screen the
  // panel. Clamp it back into range if needed.
  useEffect(() => {
    if (clampDecimals(params.decimals) !== params.decimals) {
      setParams((p) => ({ ...p, decimals: clampDecimals(p.decimals) }))
    }
    // run once on mount — intentionally not reactive to later edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  /** Clear all objects (confirm first when non-empty). The synced 'welding'
   * section is dropped by the live-generation effect once the list is empty. */
  function clearAll() {
    if (objects.length === 0) return
    if (!window.confirm(t('weld.clearConfirm', 'Remove all {n} weld object(s)?', { n: objects.length })))
      return
    setObjects([])
    setSelected('')
  }

  /** Duplicate an object: deep-copy it, give it a fresh id, insert right after
   * the original, and select the copy. */
  function duplicateObject(id: string) {
    setObjects((s) => {
      const i = s.findIndex((o) => o.id === id)
      if (i < 0) return s
      const src = s[i]
      const copy: WeldObject =
        src.kind === 'line'
          ? { ...src, id: newWeldId(), start: { ...src.start }, end: { ...src.end } }
          : { ...src, id: newWeldId(), center: { ...src.center } }
      const next = [...s]
      next.splice(i + 1, 0, copy)
      setSelected(copy.id)
      return next
    })
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
  // Routed through the functional updater so it always patches the CURRENT
  // object list, never a stale closure copy.
  function recordPoint(field: 'start' | 'end' | 'center') {
    if (!connected) return
    const pos: Vec3 = { x: wpos.x, y: wpos.y, z: wpos.z }
    setObjects((s) =>
      s.map((o) => {
        if (o.id !== selected) return o
        if (field === 'center' && o.kind === 'circle') return { ...o, center: pos }
        if (field === 'start' && o.kind === 'line') return { ...o, start: pos }
        if (field === 'end' && o.kind === 'line') return { ...o, end: pos }
        return o
      }),
    )
  }

  // Live G-code preview, recomputed whenever objects/params change. Decimals is
  // clamped here so the preview + estimate share one safe value even if a
  // persisted/loaded value slipped through before the mount-time sanitize ran.
  const safeParams = useMemo(
    () => ({ ...params, decimals: clampDecimals(params.decimals) }),
    [params],
  )
  const gcode = useMemo(() => generateWelding(objects, safeParams), [objects, safeParams])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  const weldLen = useMemo(() => totalWeldLength(objects), [objects])
  const nLines = useMemo(() => countLines(objects), [objects])
  const estSeconds = useMemo(
    () => estimateWeldingSeconds(objects, safeParams),
    [objects, safeParams],
  )

  // Live generation: push the freshly-computed program (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step. When the
  // list is emptied (Clear-all), DROP the section instead of leaving a stale
  // toolpath in the Visualizer / Program tab.
  useEffect(() => {
    // While a job is streaming, skip the sync so a fresh push can't reset the
    // running stream (setProgram forces streaming:false / cursor:-1) mid-weld.
    if (streaming) return
    if (objects.length === 0) {
      removeSection('welding')
      return
    }
    const id = window.setTimeout(() => setProgram('welding', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, objects.length, setProgram, removeSection, streaming])

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

  // ---- color-coded setting PRESETS (global welding params only) ------------
  // Snapshot the current global params (arc/gas + travel/motion) — NOT the
  // object list, which is the operator's actual work. Scoped to its own
  // persistence key, independent of the carving/soldering/writing presets.
  const capturePreset = (): PersistParams => ({ ...params })
  // Restore a captured preset, coercing each field defensively (via the same
  // parse helper Load uses) so a corrupt persisted slot can never feed a NaN /
  // out-of-range value to the emitter.
  const applyPreset = (p: PersistParams) => {
    setParams((prev) => parseWeldParams(p, prev))
  }
  const presets = usePresets<PersistParams>({
    storageKey: 'karmyogi.welding.presets',
    capture: capturePreset,
    onApply: applyPreset,
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('weld.presets.aria', 'Welding setting presets')}
      />
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
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={objects.length === 0}
            title={t('weld.toolbar.clear', 'Clear all')}
            body={t('weld.toolbar.clear.body', 'Remove every object and start over.')}
          />
          <span className="wp-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
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
        <span
          className="wp-status-pill"
          title={t('weld.status.lineObjects.title', 'Number of LINE objects (circles are counted separately).')}
        >
          <b>{nLines}</b> {t('weld.status.lineObjects', 'line objects')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span className="wp-status-pill">
          <b>{weldLen.toFixed(1)}</b> {t('weld.status.mm', 'mm weld')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span className="wp-status-pill">
          <b>{lineCount}</b> {t('weld.status.gcode', 'G-code lines')}
        </span>
        <span className="wp-status-sep" aria-hidden="true">·</span>
        <span
          className="wp-status-pill"
          title={t('weld.status.est.title', 'Estimated cycle time (woven-path travel + gas pre/post-flow; rapids ignored)')}
        >
          <b>{fmtDuration(estSeconds, t)}</b> {t('weld.status.est', 'est.')}
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
                unit={t('unit.mm', 'mm')}
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('weld.field.safeZ', 'Safe-Z'),
                  body: t('weld.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
              <NumField
                label={t('weld.field.plungeF', 'Plunge')}
                unit={t('unit.mmPerMin', 'mm/min')}
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
                unit={t('unit.ptsPerCyc', 'pts/cyc')}
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
                parse={(v, fb) => clampDecimals(intNum(v, fb))}
                onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                info={{
                  title: t('weld.field.decimals', 'Decimals'),
                  body: t('weld.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).'),
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
                unit={t('unit.sWord', 'S')}
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
                unit={t('unit.s', 's')}
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
                unit={t('unit.s', 's')}
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
              warnings={objectWarnings(obj, t)}
              t={t}
              onSelect={() => setSelected(obj.id)}
              onSetKind={(k) => setKind(obj.id, k)}
              onUpdate={(patch) => updateObject(obj.id, patch)}
              onUpdateVec={(field, axis, val) => updateVec(obj.id, field, axis, val)}
              onMove={(dir) => moveObject(obj.id, dir)}
              onDuplicate={() => duplicateObject(obj.id)}
              onDelete={() => deleteObject(obj.id)}
            />
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
            onLoad={(data) => setParams((p) => parseWeldParams(data, p))}
            onError={setLoadError}
            fileBase="welding-settings"
            ext="kweldset"
            saveTitle={t('weld.presets.saveSettings', 'Save welding settings to file')}
            loadTitle={t('weld.presets.loadSettings', 'Load welding settings from file')}
          />
        }
      />
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
  warnings: string[]
  t: ReturnType<typeof useT>
  onSelect: () => void
  onSetKind: (k: 'line' | 'circle') => void
  onUpdate: (patch: Partial<WeldLine> & Partial<WeldCircle>) => void
  onUpdateVec: (field: 'start' | 'end' | 'center', axis: 'x' | 'y' | 'z', val: number) => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { obj, index, isFirst, isLast, selected, warnings, t, onSelect, onSetKind, onUpdate, onUpdateVec, onMove, onDuplicate, onDelete } = props
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const axisLabel: Record<'x' | 'y' | 'z', string> = {
    x: t('weld.axis.x', 'X'),
    y: t('weld.axis.y', 'Y'),
    z: t('weld.axis.z', 'Z'),
  }
  const vecRow = (label: string, field: 'start' | 'end' | 'center', v: Vec3) => (
    <div className="wp-vec">
      <span className="wp-vec-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <label key={axis} className="wp-mini">
          <span>{axisLabel[axis]}</span>
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
          <button className="wp-row-ico" title={t('weld.row.duplicate', 'Duplicate')}
            aria-label={t('weld.row.duplicate', 'Duplicate')}
            onClick={(e) => { stop(e); onDuplicate() }}>
            <Icon name="duplicate" size={14} />
          </button>
          <button className="wp-row-ico wp-del" title={t('weld.row.delete', 'Delete')}
            aria-label={t('weld.row.delete', 'Delete')}
            onClick={(e) => { stop(e); onDelete() }}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="wp-ocard-warns" role="alert">
          {warnings.map((w, wi) => (
            <span className="wp-warn-badge" key={wi}>
              <Icon name="warning" size={13} />
              <span>{w}</span>
            </span>
          ))}
        </div>
      )}

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
                <span>{t('weld.geom.r', 'R')}</span>
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
            <i>{t('unit.mmPerMin', 'mm/min')}</i>
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
            <i>{t('unit.mm', 'mm')}</i>
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
            <i>{t('unit.mmPerMin', 'mm/min')}</i>
          </span>
        </label>
      </div>
    </div>
  )
}
