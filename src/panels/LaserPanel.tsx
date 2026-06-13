import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { Icon, type IconName } from '../components/Icons'
import { FrameButton } from '../components/FrameButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { importDxfString } from '../core/dxf'
import { nestFootprints, type NestItem, type NestWarning } from '../core/nesting'
import { distance } from '../core/geometry'
import {
  LaserMode,
  LaserPowerMode,
  defaultLaserParams,
  drawingToContours,
  contoursBounds,
  countContours,
  placeContours,
  orderContours,
  emitLaserProgram,
  percentFromPower,
  powerFromPercent,
  type LaserContour,
  type PlacedContour,
} from '../core/laser'
import '../styles/laser.css'

/** Hard cap on the Quantity field — keeps the O(n²) nest hill-climb bounded. */
const MAX_QUANTITY = 200

/** Clamp `n` into [lo, hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n
}

/** Format a duration (seconds) as "1h 23m" / "12m 30s" / "45s". */
function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—'
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

/** Non-empty G-code line count for the operator status strip. */
function gcodeLineCount(gcode: string): number {
  let n = 0
  for (const l of gcode.split(/\r?\n/)) if (l.trim().length > 0) ++n
  return n
}

/**
 * Sleek slider + number-input + unit row, modelled on the CAD/CAM panel's
 * `SliderField` (which mirrors the Controller jog "Feed" control). A compact
 * one-line row: leading glyph + label · themed draggable `.laser-slider`
 * (accent fill via the inline `--pct` var) · small typable `.laser-snum`
 * clamped to [min, max] for the slider but allowing exact entry · inline unit.
 *
 * `value`/`onChange` carry the existing wiring untouched — only the input WIDGET
 * changes (bare number box → slider + number). All theming is via CSS vars so it
 * follows light/dark.
 */
function SliderField(props: {
  icon: ReactNode
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit?: string
  title?: string
  integer?: boolean
  onChange: (n: number) => void
}) {
  const { icon, label, value, min, max, step = 1, unit, title, integer, onChange } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the accent fill (read as --pct by the WebKit/Blink
  // track gradient; Firefox fills via ::-moz-range-progress). Uses the CLAMPED
  // value so an out-of-range typed value doesn't overflow the fill.
  const pct = max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="laser-sfield" title={title}>
      <span className="laser-sfield-lbl">
        <span className="laser-sfield-ico" aria-hidden>
          {icon}
        </span>
        <span className="laser-sfield-txt">{label}</span>
      </span>
      <input
        type="range"
        className="laser-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="laser-snum">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-label={label}
          onChange={(e) => {
            // Allow EXACT entry (don't clamp the typed number) — only blank/NaN is
            // rejected; the caller's own guard re-clamps where it must reach the emitter.
            const v = integer ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <i>{unit}</i> : null}
      </span>
    </div>
  )
}

/** One option in a {@link SegControl}. */
interface SegOption<T> {
  value: T
  label: string
  icon?: IconName
  title?: string
}

/**
 * Compact icon-led segmented control (mirrors `.cc-opseg`) for mode/enum choices
 * — replaces the bare radio rows. Themed via CSS vars; the active pill fills with
 * the accent. Each button is a real <button role=radio> so it stays keyboard- and
 * touch-friendly.
 */
function SegControl<T extends string>(props: {
  ariaLabel: string
  value: T
  options: SegOption<T>[]
  onChange: (v: T) => void
}) {
  const { ariaLabel, value, options, onChange } = props
  return (
    <div className="laser-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`laser-seg-btn${value === o.value ? ' is-on' : ''}`}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.icon && (
            <span className="laser-seg-ico" aria-hidden>
              <Icon name={o.icon} size={14} />
            </span>
          )}
          <span className="laser-seg-lbl">{o.label}</span>
        </button>
      ))}
    </div>
  )
}

/** The combined-laser params persisted to localStorage. */
interface PanelParams {
  mode: LaserMode
  cutFeed: number
  power: number
  sMax: number
  passes: number
  powerMode: LaserPowerMode
  useFocusZ: boolean
  focusZ: number
  pierce: boolean
  piercePower: number
  pierceTime: number
  decimals: number
}

function defaultsFor(mode: LaserMode): PanelParams {
  const d = defaultLaserParams(mode)
  return {
    mode,
    cutFeed: d.cutFeed,
    power: d.power,
    sMax: d.sMax,
    passes: d.passes,
    powerMode: d.powerMode,
    useFocusZ: d.useFocusZ,
    focusZ: d.focusZ,
    pierce: d.pierce,
    piercePower: d.piercePower,
    pierceTime: d.pierceTime,
    decimals: d.decimals,
  }
}

/** Sheet / nesting settings persisted alongside the laser params. */
interface SheetSettings {
  sheetW: number
  sheetH: number
  margin: number
  quantity: number
  doNest: boolean
}

/** The serializable Laser document written by Save / read by Load. */
interface LaserDoc {
  kind: 'karmyogi.laser'
  version: 1
  mode: LaserMode
  co2: PanelParams
  fiber: PanelParams
  sheet: SheetSettings
}

/**
 * A reusable LASER setting preset: the current mode plus BOTH mode param records
 * and the sheet/nesting settings (NOT the imported DXF contours, which are the
 * operator's actual work). Scoped to its own persistence key, independent of the
 * carving / soldering / writing presets.
 */
interface LaserPreset {
  mode: LaserMode
  co2: PanelParams
  fiber: PanelParams
  sheet: SheetSettings
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f
const boolOr = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)

const VALID_MODES: LaserMode[] = [LaserMode.CO2, LaserMode.Fiber]
const VALID_POWER_MODES: LaserPowerMode[] = [LaserPowerMode.Dynamic, LaserPowerMode.Constant]

/** Narrow unknown into a valid PanelParams, falling back per-field to `base`. */
function parseParams(v: unknown, base: PanelParams): PanelParams {
  if (!isRecord(v)) return base
  const mode = VALID_MODES.includes(v.mode as LaserMode) ? (v.mode as LaserMode) : base.mode
  const powerMode = VALID_POWER_MODES.includes(v.powerMode as LaserPowerMode)
    ? (v.powerMode as LaserPowerMode)
    : base.powerMode
  return {
    mode,
    cutFeed: numOr(v.cutFeed, base.cutFeed),
    power: numOr(v.power, base.power),
    sMax: numOr(v.sMax, base.sMax),
    passes: numOr(v.passes, base.passes),
    powerMode,
    useFocusZ: boolOr(v.useFocusZ, base.useFocusZ),
    focusZ: numOr(v.focusZ, base.focusZ),
    pierce: boolOr(v.pierce, base.pierce),
    piercePower: numOr(v.piercePower, base.piercePower),
    pierceTime: numOr(v.pierceTime, base.pierceTime),
    decimals: numOr(v.decimals, base.decimals),
  }
}

/** Narrow unknown into a valid SheetSettings, falling back per-field to `base`. */
function parseSheet(v: unknown, base: SheetSettings): SheetSettings {
  if (!isRecord(v)) return base
  return {
    sheetW: numOr(v.sheetW, base.sheetW),
    sheetH: numOr(v.sheetH, base.sheetH),
    margin: numOr(v.margin, base.margin),
    quantity: clamp(Math.floor(numOr(v.quantity, base.quantity)), 1, MAX_QUANTITY),
    doNest: boolOr(v.doNest, base.doNest),
  }
}

/** Map a structured nesting warning to a localized string (code → t(), else fallback). */
function useNestWarnText() {
  const t = useT()
  return (w: NestWarning): string => {
    switch (w.code) {
      case 'tooLarge':
        return t(
          'laser.nest.warn.tooLarge',
          'Job is larger ({jobW}×{jobH} mm) than the sheet ({bedW}×{bedH} mm) — shrink it or use a bigger sheet.',
          w.params,
        )
      case 'edgeOverflow':
        return t(
          'laser.nest.warn.edgeOverflow',
          'Not all jobs fit on the sheet — they are stacked but overlap the edge.',
        )
      default:
        return w.message
    }
  }
}

/**
 * Laser-cutting workbench — handles BOTH CO2 and Fiber in one UI. A mode radio
 * at the top toggles the few mode-specific controls (piercing / focus-Z); DXF
 * import, nesting, ordering and the common cut params drive a single pure core
 * (`emitLaserProgram`). Generation is LIVE: every edit pushes a fresh program
 * into the shared store (debounced) so the Visualizer renders it and the
 * Program tab streams it — there is no explicit "send" here.
 */
export function LaserPanel() {
  const t = useT()
  const nestWarnText = useNestWarnText()
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)

  // ---- Mode (persisted) — gates the mode-specific controls below. ---------
  const [mode, setMode] = usePersistentState<LaserMode>('karmyogi.laser.mode', LaserMode.CO2)

  // ---- Common + mode params (persisted, one record per mode). -------------
  const [co2, setCo2] = usePersistentState<PanelParams>(
    'karmyogi.laser.params.co2',
    defaultsFor(LaserMode.CO2),
  )
  const [fiber, setFiber] = usePersistentState<PanelParams>(
    'karmyogi.laser.params.fiber',
    defaultsFor(LaserMode.Fiber),
  )
  const params = mode === LaserMode.Fiber ? fiber : co2
  const setParams = (patch: Partial<PanelParams>) => {
    if (mode === LaserMode.Fiber) setFiber((p) => ({ ...p, ...patch }))
    else setCo2((p) => ({ ...p, ...patch }))
  }

  // Collapse the two mode-specific (advanced) cards to tame vertical scroll.
  const [showAdvanced, setShowAdvanced] = useState(false)

  // ---- Sheet / nesting (persisted). ---------------------------------------
  const [sheetW, setSheetW] = usePersistentState<number>('karmyogi.laser.sheetW', 300)
  const [sheetH, setSheetH] = usePersistentState<number>('karmyogi.laser.sheetH', 200)
  const [margin, setMargin] = usePersistentState<number>('karmyogi.laser.margin', 5)
  const [quantity, setQuantity] = usePersistentState<number>('karmyogi.laser.qty', 1)
  const [doNest, setDoNest] = usePersistentState<boolean>('karmyogi.laser.nestOn', false)
  const [loadError, setLoadError] = useState<string>('')

  // ---- DXF (NOT persisted — re-import each session). ----------------------
  const [contours, setContours] = useState<LaserContour[]>([])
  const [fileName, setFileName] = useState<string>('')
  const [importError, setImportError] = useState<string>('')
  const [warnings, setWarnings] = useState<string[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)

  const bounds = useMemo(() => contoursBounds(contours), [contours])
  const counts = useMemo(() => countContours(contours), [contours])

  function loadDxfFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const res = importDxfString(String(reader.result ?? ''))
      setWarnings(res.warnings ?? [])
      if (!res.ok) {
        setContours([])
        setImportError(res.error ?? t('laser.dxf.parseFail', 'Failed to parse DXF'))
        return
      }
      setImportError('')
      setContours(drawingToContours(res.drawing))
      setFileName(file.name)
    }
    reader.onerror = () => {
      setContours([])
      setWarnings([])
      setImportError(t('laser.dxf.readFail', 'Could not read {name}.', { name: file.name }))
    }
    reader.readAsText(file)
  }

  // ---- Nesting: lay out `quantity` copies of the part on the sheet. -------
  // Each copy is one NestItem with the part footprint; the packer returns a
  // bottom-left placement we translate the part into. When nesting is off, all
  // copies are stacked at the origin (single copy use-case).
  //
  // The placed contours, the fit summary AND the warnings are derived from ONE
  // `nestFootprints` call (it runs an O(n²) hill-climb, so it must not run twice
  // per render — that froze the UI on large Quantity).
  const nest = useMemo(() => {
    if (contours.length === 0) {
      return { placed: [] as PlacedContour[], fit: null as null | { fit: number; total: number; overflow: boolean }, warnings: [] as NestWarning[] }
    }
    const qty = clamp(Math.floor(quantity), 1, MAX_QUANTITY)
    const w = bounds.width()
    const h = bounds.height()

    const out: PlacedContour[] = []
    let fit: { fit: number; total: number; overflow: boolean } | null = null
    let warnings: NestWarning[] = []

    if (doNest && qty > 0 && w > 0 && h > 0) {
      const items: NestItem[] = []
      for (let i = 0; i < qty; ++i) items.push({ id: `c${i}`, w, h })
      const res = nestFootprints(items, { bedW: sheetW, bedH: sheetH, margin })
      for (const pl of res.placements) {
        out.push(...placeContours(contours, bounds, pl.x, pl.y))
      }
      fit = { fit: res.placements.filter((p) => !p.overflow).length, total: qty, overflow: res.overflow }
      warnings = res.warningCodes
    } else {
      // No nesting → stack all copies at the sheet origin (+margin).
      for (let i = 0; i < qty; ++i) {
        out.push(...placeContours(contours, bounds, margin, margin))
      }
    }
    return { placed: orderContours(out), fit, warnings }
  }, [contours, bounds, quantity, doNest, sheetW, sheetH, margin])

  const placed = nest.placed
  const nestFit = nest.fit

  // ---- Live G-code (recomputed on any param/DXF change). ------------------
  // Power / pierce power are CLAMPED to [0, sMax] here so an out-of-range S value
  // can never reach the emitter (the GRBL controller caps at $30 = sMax anyway).
  const gcode = useMemo(() => {
    if (placed.length === 0) return ''
    const sMax = Math.max(1, params.sMax)
    return emitLaserProgram(placed, {
      mode: params.mode,
      cutFeed: params.cutFeed,
      power: clamp(params.power, 0, sMax),
      sMax,
      passes: params.passes,
      powerMode: params.powerMode,
      useFocusZ: params.useFocusZ,
      focusZ: params.focusZ,
      pierce: params.pierce,
      piercePower: clamp(params.piercePower, 0, sMax),
      pierceTime: params.pierceTime,
      decimals: params.decimals,
      programName: `hjLabs Laser — ${params.mode}`,
    })
  }, [placed, params])
  const lineCount = useMemo(() => gcodeLineCount(gcode), [gcode])

  // ---- Cut-path length + time estimate (XY only, all passes). -------------
  const estimate = useMemo(() => {
    if (placed.length === 0 || params.cutFeed <= 0) return null
    const passes = Math.max(1, Math.floor(params.passes))
    let len = 0
    for (const c of placed) {
      const pts = c.points
      for (let i = 1; i < pts.length; ++i) len += distance(pts[i - 1], pts[i])
      if (c.closed && pts.length > 1) len += distance(pts[pts.length - 1], pts[0])
    }
    len *= passes
    // time(min) = length(mm) / feed(mm/min); add pierce dwell per contour/pass.
    let timeMin = len / params.cutFeed
    if (params.pierce && params.pierceTime > 0) {
      timeMin += (placed.length * passes * params.pierceTime) / 60
    }
    return { lengthMm: len, timeSeconds: timeMin * 60 }
  }, [placed, params])

  // Live sync: push the freshly-computed program to the store (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step.
  // GUARD: never push WHILE a job is streaming — a fresh setProgram would reset
  // the program/cursor mid-cut. We skip the sync entirely while streaming.
  useEffect(() => {
    if (!gcode || streaming) return
    const id = window.setTimeout(() => setProgram('laser', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, setProgram, streaming])

  const powerPct = percentFromPower(params.power, params.sMax)
  const fiberMode = mode === LaserMode.Fiber

  // ---- Save / Load document (params + sheet/nesting only; DXF re-imported). --
  const doc: LaserDoc = {
    kind: 'karmyogi.laser',
    version: 1,
    mode,
    co2,
    fiber,
    sheet: { sheetW, sheetH, margin, quantity, doNest },
  }

  // Restore a (possibly untrusted) settings snapshot — shared by Load and by the
  // colour presets so corrupt persisted values can never reach the emitter.
  // `data.mode/co2/fiber/sheet` are each coerced per-field via the parse helpers.
  function applySettings(data: Record<string, unknown>) {
    if (VALID_MODES.includes(data.mode as LaserMode)) setMode(data.mode as LaserMode)
    setCo2((p) => parseParams(data.co2, p))
    setFiber((p) => parseParams(data.fiber, p))
    setSheetW((v) => parseSheet(data.sheet, { sheetW: v, sheetH, margin, quantity, doNest }).sheetW)
    setSheetH((v) => parseSheet(data.sheet, { sheetW, sheetH: v, margin, quantity, doNest }).sheetH)
    setMargin((v) => parseSheet(data.sheet, { sheetW, sheetH, margin: v, quantity, doNest }).margin)
    setQuantity((v) => parseSheet(data.sheet, { sheetW, sheetH, margin, quantity: v, doNest }).quantity)
    setDoNest((v) => parseSheet(data.sheet, { sheetW, sheetH, margin, quantity, doNest: v }).doNest)
  }

  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('laser.load.bad', 'Could not load — not a valid laser settings file.'))
      return
    }
    applySettings(data)
    setLoadError('')
  }

  // ---- color-coded setting PRESETS (mode + both param records + sheet) -------
  // Snapshot the current settings (NOT the imported DXF contours).
  const captureSettings = (): LaserPreset => ({ mode, co2, fiber, sheet: { sheetW, sheetH, margin, quantity, doNest } })
  // Restore a captured preset, coercing each field defensively (parseParams /
  // parseSheet) so a corrupt slot can never feed a NaN to the emitter.
  const applyPreset = (p: LaserPreset) => {
    if (isRecord(p)) applySettings(p as unknown as Record<string, unknown>)
  }
  const presets = usePresets<LaserPreset>({
    storageKey: 'karmyogi.laser.presets',
    capture: captureSettings,
    onApply: applyPreset,
  })

  // Settings-only payload for the preset-bar Save/Load pair (mirrors the header
  // Save/Load doc minus the kind/version envelope) — loaded the same path.
  const settings: LaserPreset = captureSettings()

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('laser.presets.aria', 'Laser setting presets')}
      />
    <div className="lp-panel">
      {/* Header: title + mode radio + live status. */}
      <header className="lp-head">
        <div className="lp-head-title">
          <span className="lp-head-name">{t('laser.title', 'Laser Cutting')}</span>
        </div>
        <div className="lp-mode-wrap">
          <SegControl
            ariaLabel={t('laser.mode.aria', 'Laser mode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: LaserMode.CO2, label: t('laser.mode.co2', 'CO2'), icon: 'laser' },
              { value: LaserMode.Fiber, label: t('laser.mode.fiber', 'Fiber'), icon: 'laser' },
            ]}
          />
        </div>
        <FrameButton
          lines={gcode ? gcode.split(/\r?\n/) : []}
          showOptions={false}
          label={t('laser.frame', 'Frame')}
          className="lp-frame"
        />
        <SaveLoadButtons
          value={doc}
          onLoad={loadDoc}
          onError={setLoadError}
          fileBase="karmyogi-laser"
          ext="klaser"
          saveTitle={t('laser.save', 'Save laser settings')}
          loadTitle={t('laser.load', 'Load laser settings')}
          className="lp-io"
        />
      </header>

      {loadError && <p className="lp-warn">{loadError}</p>}

      {/* Live status strip: contour + part + line counts, auto-synced. */}
      <div className="lp-status">
        <span className="lp-status-pill">
          <b>{counts.closed}</b> {t('laser.status.loops', 'loops')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{counts.open}</b> {t('laser.status.lines', 'lines')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{placed.length}</b> {t('laser.status.contours', 'contours out')}
        </span>
        <span className="lp-status-sep" aria-hidden="true">·</span>
        <span className="lp-status-pill">
          <b>{lineCount}</b> {t('laser.status.gcode', 'G-code lines')}
        </span>
        {estimate && (
          <>
            <span className="lp-status-sep" aria-hidden="true">·</span>
            <span
              className="lp-status-pill"
              title={t('laser.status.estTitle', 'Estimated cut path length and time (XY, all passes — pierce dwell included).')}
            >
              <b>{(estimate.lengthMm / 1000).toFixed(2)} m</b> · <b>{fmtDuration(estimate.timeSeconds)}</b>
            </span>
          </>
        )}
        <span
          className="lp-status-sync"
          title={
            streaming
              ? t('laser.status.streamingTitle', 'Streaming — live sync paused so the running job is not reset.')
              : t('laser.status.syncTitle', 'Lines auto-synced to the Program tab')
          }
        >
          {streaming ? (
            <>
              <Icon name="play" size={12} /> {t('laser.status.streaming', 'Streaming')}
            </>
          ) : (
            <>
              <Icon name="chevron-right" size={12} /> {t('laser.status.program', 'Program')}
            </>
          )}
        </span>
      </div>

      {/* DXF import. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{t('laser.dxf.title', 'Drawing (DXF)')}</h4>
          {fileName && <span className="lp-card-count">{fileName}</span>}
        </div>
        <div className="lp-import-row">
          <button
            type="button"
            className="lp-btn lp-btn-primary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="upload" size={15} /> {t('laser.dxf.import', 'Import DXF…')}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".dxf,application/dxf,image/vnd.dxf"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadDxfFile(f)
              e.target.value = ''
            }}
          />
          {contours.length > 0 && (
            <span className="lp-import-info">
              {t('laser.dxf.info', '{n} contours · {w}×{h} mm', {
                n: contours.length,
                w: bounds.width().toFixed(1),
                h: bounds.height().toFixed(1),
              })}
            </span>
          )}
        </div>
        {importError && <p className="lp-warn">{importError}</p>}
        {warnings.length > 0 && (
          <ul className="lp-warn-list">
            {warnings.slice(0, 4).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        )}
        {contours.length === 0 && !importError && (
          <p className="lp-hint">
            {t('laser.dxf.hint', 'Import a DXF: closed contours become cut loops, open paths become cut lines.')}
          </p>
        )}
      </section>

      {/* Nesting / sheet. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{t('laser.sheet.title', 'Sheet & nesting')}</h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={doNest}
              onChange={(e) => setDoNest(e.target.checked)}
            />
            {t('laser.sheet.nest', 'Nest')}
          </label>
        </div>
        <div className="lp-sliders">
          <SliderField
            icon={<Icon name="frame" size={14} />}
            label={t('laser.sheet.w', 'Sheet W')}
            unit="mm"
            min={1}
            max={2000}
            step={1}
            value={sheetW}
            onChange={(n) => setSheetW(n)}
            title={t('laser.sheet.w.title', 'Usable sheet width (X).')}
          />
          <SliderField
            icon={<Icon name="frame" size={14} />}
            label={t('laser.sheet.h', 'Sheet H')}
            unit="mm"
            min={1}
            max={2000}
            step={1}
            value={sheetH}
            onChange={(n) => setSheetH(n)}
            title={t('laser.sheet.h.title', 'Usable sheet height (Y).')}
          />
          <SliderField
            icon={<Icon name="jog" size={14} />}
            label={t('laser.sheet.spacing', 'Spacing')}
            unit="mm"
            min={0}
            max={50}
            step={0.5}
            value={margin}
            onChange={(n) => setMargin(n)}
            title={t('laser.sheet.spacing.title', 'Gap kept between parts and around the sheet edge.')}
          />
          <SliderField
            icon={<Icon name="duplicate" size={14} />}
            label={t('laser.sheet.qty', 'Quantity')}
            min={1}
            max={MAX_QUANTITY}
            step={1}
            integer
            value={quantity}
            onChange={(n) => setQuantity(clamp(Math.floor(n), 1, MAX_QUANTITY))}
            title={t('laser.sheet.qty.title', 'Number of copies of the imported part to lay out (max {max}).', { max: MAX_QUANTITY })}
          />
        </div>
        {nestFit && (
          <p className={`lp-hint${nestFit.overflow ? ' is-warn' : ''}`}>
            {t('laser.nest.fit', '{fit} of {total} copies fit on the {w}×{h} mm sheet', {
              fit: nestFit.fit,
              total: nestFit.total,
              w: sheetW,
              h: sheetH,
            })}
            {nestFit.overflow
              ? t('laser.nest.overflow', ' — some overflow the edge.')
              : t('laser.nest.period', '.')}
          </p>
        )}
        {/* Without nesting, >1 copies stack at the SAME spot → overlapping burns. */}
        {!doNest && quantity > 1 && contours.length > 0 && (
          <p className="lp-hint is-warn">
            <Icon name="warning" size={13} />{' '}
            {t(
              'laser.nest.stackWarn',
              'Nesting is off — all {n} copies overlap at the same spot. Enable Nest to lay them out separately.',
              { n: quantity },
            )}
          </p>
        )}
        {nest.warnings.length > 0 && (
          <ul className="lp-warn-list">
            {nest.warnings.map((w, i) => (
              <li key={i}>{nestWarnText(w)}</li>
            ))}
          </ul>
        )}
      </section>

      {/* Common cut parameters. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{t('laser.cut.title', 'Cut parameters')}</h4>
        </div>
        <div className="lp-sliders">
          <SliderField
            icon={<Icon name="jog" size={14} />}
            label={t('laser.cut.speed', 'Cut speed')}
            unit="mm/min"
            min={1}
            max={10000}
            step={10}
            value={params.cutFeed}
            onChange={(n) => setParams({ cutFeed: n })}
            title={t('laser.cut.speed.title', 'Feed rate while cutting (G1 F…).')}
          />
          <SliderField
            icon={<Icon name="laser" size={14} />}
            label={t('laser.cut.power', 'Power')}
            unit="S"
            min={0}
            max={Math.max(1, params.sMax)}
            step={10}
            value={params.power}
            onChange={(n) => setParams({ power: clamp(n, 0, Math.max(1, params.sMax)) })}
            title={t('laser.cut.power.title', 'Laser power as an S value (0..{sMax} = 0..100%). Currently {pct}%.', {
              sMax: params.sMax,
              pct: powerPct,
            })}
          />
          <SliderField
            icon={<Icon name="laser" size={14} />}
            label={t('laser.cut.powerPct', 'Power %')}
            unit="%"
            min={0}
            max={100}
            step={1}
            value={powerPct}
            onChange={(n) => setParams({ power: powerFromPercent(n, params.sMax) })}
            title={t('laser.cut.powerPct.title', 'Laser power as a percentage of S-max.')}
          />
          <SliderField
            icon={<Icon name="settings" size={14} />}
            label={t('laser.cut.sMax', 'S-max')}
            min={1}
            max={2000}
            step={10}
            value={params.sMax}
            onChange={(n) => setParams({ sMax: n })}
            title={t('laser.cut.sMax.title', 'Max S value the controller maps to 100% (GRBL $30).')}
          />
          <SliderField
            icon={<Icon name="copy" size={14} />}
            label={t('laser.cut.passes', 'Passes')}
            min={1}
            max={50}
            step={1}
            integer
            value={params.passes}
            onChange={(n) => setParams({ passes: n })}
            title={t('laser.cut.passes.title', 'How many times each contour is cut.')}
          />
          <SliderField
            icon={<Icon name="settings" size={14} />}
            label={t('laser.cut.decimals', 'Decimals')}
            min={0}
            max={6}
            step={1}
            integer
            value={params.decimals}
            onChange={(n) => setParams({ decimals: n })}
            title={t('laser.cut.decimals.title', 'Coordinate precision in the emitted G-code.')}
          />
        </div>
        <div className="lp-segrow">
          <span className="lp-segrow-label" title={t('laser.powerMode.title', 'M4 dynamic scales power with feed (best for cutting); M3 is constant power.')}>
            {t('laser.powerMode', 'Power mode')}
          </span>
          <SegControl
            ariaLabel={t('laser.powerMode', 'Power mode')}
            value={params.powerMode}
            onChange={(v) => setParams({ powerMode: v })}
            options={[
              { value: LaserPowerMode.Dynamic, label: t('laser.powerMode.dynamic', 'M4 dynamic'), icon: 'play' },
              { value: LaserPowerMode.Constant, label: t('laser.powerMode.constant', 'M3 constant'), icon: 'spindle' },
            ]}
          />
        </div>
      </section>

      {/* Advanced (mode-specific) — collapsed by default to reduce scroll. */}
      <button
        type="button"
        className="lp-advanced-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
      >
        <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
        {t('laser.advanced', 'Advanced — piercing & focus')}
      </button>

      {showAdvanced && (
      <>
      {/* Mode-specific: piercing. Both modes can pierce; defaults differ. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{fiberMode ? t('laser.pierce.title.fiber', 'Piercing (Fiber)') : t('laser.pierce.title.co2', 'Piercing (CO2 — usually off)')}</h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.pierce}
              onChange={(e) => setParams({ pierce: e.target.checked })}
            />
            {t('laser.pierce.toggle', 'Pierce')}
          </label>
        </div>
        {params.pierce ? (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="laser" size={14} />}
              label={t('laser.pierce.power', 'Pierce power')}
              unit="S"
              min={0}
              max={Math.max(1, params.sMax)}
              step={10}
              value={params.piercePower}
              onChange={(n) => setParams({ piercePower: clamp(n, 0, Math.max(1, params.sMax)) })}
              title={t('laser.pierce.power.title', 'Beam power during the pre-cut pierce dwell (0..{sMax}).', { sMax: params.sMax })}
            />
            <SliderField
              icon={<Icon name="pause" size={14} />}
              label={t('laser.pierce.time', 'Pierce time')}
              unit="s"
              min={0}
              max={5}
              step={0.05}
              value={params.pierceTime}
              onChange={(n) => setParams({ pierceTime: n })}
              title={t('laser.pierce.time.title', 'Dwell at the contour start before cutting begins (G4 P…).')}
            />
          </div>
        ) : (
          <p className="lp-hint">
            {fiberMode
              ? t('laser.pierce.hint.fiber', 'Fiber cuts normally pierce before each contour. Enable to dwell at the start point.')
              : t('laser.pierce.hint.co2', 'CO2 normally starts the cut immediately (no pierce). Enable only for thick material.')}
          </p>
        )}
      </section>

      {/* Mode-specific: focus-Z. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{fiberMode ? t('laser.focus.title.fiber', 'Autofocus / focus offset (Fiber)') : t('laser.focus.title.co2', 'Focus height (CO2)')}</h4>
          <label className="lp-toggle">
            <input
              type="checkbox"
              checked={params.useFocusZ}
              onChange={(e) => setParams({ useFocusZ: e.target.checked })}
            />
            {t('laser.focus.setZ', 'Set Z')}
          </label>
        </div>
        {params.useFocusZ ? (
          <div className="lp-sliders">
            <SliderField
              icon={<Icon name="probe" size={14} />}
              label={t('laser.focus.z', 'Focus Z')}
              unit="mm"
              min={0}
              max={200}
              step={0.1}
              value={params.focusZ}
              onChange={(n) => setParams({ focusZ: clamp(n, 0, 200) })}
              title={t('laser.focus.z.title', 'Absolute Z moved to at program start to set focus (0..200 mm). Negative Z is blocked — there is no safe-Z retract before this move.')}
            />
          </div>
        ) : (
          <p className="lp-hint">
            {t('laser.focus.hint', 'Z is left untouched — focus the head manually.')}
          </p>
        )}
        <p className="lp-note">
          {fiberMode
            ? t('laser.focus.note.fiber', 'Note: true capacitive height-following is not possible in plain GRBL — this sets a fixed focus Z.')
            : t('laser.focus.note.co2', 'CO2 focus is usually fixed/manual; set a Z here only if your machine focuses by Z.')}
        </p>
      </section>
      </>
      )}

      <p className="lp-safety">
        {t('laser.safety', 'Safety: laser OFF (M5 S0) during all travel; beam on (M3/M4 S…) only on cut feeds; requires GRBL laser mode $32=1.')}
      </p>
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
            value={settings}
            onLoad={loadDoc}
            onError={setLoadError}
            fileBase="laser-settings"
            ext="klaser"
            saveTitle={t('laser.preset.save', 'Save laser settings to file')}
            loadTitle={t('laser.preset.load', 'Load laser settings from file')}
          />
        }
      />
    </div>
  )
}
