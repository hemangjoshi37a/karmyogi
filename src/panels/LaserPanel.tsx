import { useEffect, useMemo, useRef, useState } from 'react'
import { useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { FrameButton } from '../components/FrameButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { importDxfString } from '../core/dxf'
import { nestFootprints, type NestItem } from '../core/nesting'
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

/** Non-empty G-code line count for the operator status strip. */
function gcodeLineCount(gcode: string): number {
  let n = 0
  for (const l of gcode.split(/\r?\n/)) if (l.trim().length > 0) ++n
  return n
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Slim number field with an inline unit suffix, matching the dense theme. */
function NumField(props: {
  label: string
  value: number
  unit?: string
  step?: string
  min?: string
  max?: string
  title?: string
  onChange: (n: number) => void
  parse?: (v: string, fallback: number) => number
}) {
  const { label, value, unit, step = '1', min, max, title, onChange, parse = num } = props
  return (
    <label className="lp-field" title={title}>
      <span className="lp-field-label">{label}</span>
      <span className={`lp-input${unit ? ' has-unit' : ''}`}>
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
  const setProgram = useProgram((s) => s.setProgram)

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
    reader.readAsText(file)
  }

  // ---- Nesting: lay out `quantity` copies of the part on the sheet. -------
  // Each copy is one NestItem with the part footprint; the packer returns a
  // bottom-left placement we translate the part into. When nesting is off, all
  // copies are stacked at the origin (single copy use-case).
  const placed = useMemo<PlacedContour[]>(() => {
    if (contours.length === 0) return []
    const qty = Math.max(1, Math.floor(quantity))
    const w = bounds.width()
    const h = bounds.height()

    const out: PlacedContour[] = []
    if (doNest && qty > 0 && w > 0 && h > 0) {
      const items: NestItem[] = []
      for (let i = 0; i < qty; ++i) items.push({ id: `c${i}`, w, h })
      const res = nestFootprints(items, { bedW: sheetW, bedH: sheetH, margin })
      for (const pl of res.placements) {
        out.push(...placeContours(contours, bounds, pl.x, pl.y))
      }
    } else {
      // No nesting → place a single copy at the sheet origin (+margin).
      for (let i = 0; i < qty; ++i) {
        out.push(...placeContours(contours, bounds, margin, margin))
      }
    }
    return orderContours(out)
  }, [contours, bounds, quantity, doNest, sheetW, sheetH, margin])

  // How many copies actually fit (nesting only) — for the status strip.
  const nestFit = useMemo(() => {
    if (!doNest || contours.length === 0) return null
    const qty = Math.max(1, Math.floor(quantity))
    const w = bounds.width()
    const h = bounds.height()
    if (!(w > 0 && h > 0)) return null
    const items: NestItem[] = []
    for (let i = 0; i < qty; ++i) items.push({ id: `c${i}`, w, h })
    const res = nestFootprints(items, { bedW: sheetW, bedH: sheetH, margin })
    const fit = res.placements.filter((p) => !p.overflow).length
    return { fit, total: qty, overflow: res.overflow }
  }, [doNest, contours.length, quantity, bounds, sheetW, sheetH, margin])

  // ---- Live G-code (recomputed on any param/DXF change). ------------------
  const gcode = useMemo(() => {
    if (placed.length === 0) return ''
    return emitLaserProgram(placed, {
      mode: params.mode,
      cutFeed: params.cutFeed,
      power: params.power,
      sMax: params.sMax,
      passes: params.passes,
      powerMode: params.powerMode,
      useFocusZ: params.useFocusZ,
      focusZ: params.focusZ,
      pierce: params.pierce,
      piercePower: params.piercePower,
      pierceTime: params.pierceTime,
      decimals: params.decimals,
      programName: `hjLabs Laser — ${params.mode}`,
    })
  }, [placed, params])
  const lineCount = useMemo(() => gcodeLineCount(gcode), [gcode])

  // Live sync: push the freshly-computed program to the store (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step.
  useEffect(() => {
    if (!gcode) return
    const id = window.setTimeout(() => setProgram('laser', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, setProgram])

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

  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('laser.load.bad', 'Could not load — not a valid laser settings file.'))
      return
    }
    if (VALID_MODES.includes(data.mode as LaserMode)) setMode(data.mode as LaserMode)
    setCo2((p) => parseParams(data.co2, p))
    setFiber((p) => parseParams(data.fiber, p))
    if (isRecord(data.sheet)) {
      const s = data.sheet
      setSheetW((v) => numOr(s.sheetW, v))
      setSheetH((v) => numOr(s.sheetH, v))
      setMargin((v) => numOr(s.margin, v))
      setQuantity((v) => numOr(s.quantity, v))
      setDoNest((v) => boolOr(s.doNest, v))
    }
    setLoadError('')
  }

  return (
    <div className="lp-panel">
      {/* Header: title + mode radio + live status. */}
      <header className="lp-head">
        <div className="lp-head-title">
          <span className="lp-head-name">{t('laser.title', 'Laser Cutting')}</span>
        </div>
        <div className="lp-mode" role="radiogroup" aria-label={t('laser.mode.aria', 'Laser mode')}>
          <label className={`lp-mode-opt${mode === LaserMode.CO2 ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="lp-mode"
              checked={mode === LaserMode.CO2}
              onChange={() => setMode(LaserMode.CO2)}
            />
            {t('laser.mode.co2', 'CO2')}
          </label>
          <label className={`lp-mode-opt${mode === LaserMode.Fiber ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="lp-mode"
              checked={mode === LaserMode.Fiber}
              onChange={() => setMode(LaserMode.Fiber)}
            />
            {t('laser.mode.fiber', 'Fiber')}
          </label>
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
        <span className="lp-status-sync" title={t('laser.status.syncTitle', 'Lines auto-synced to the Program tab')}>
          → {t('laser.status.program', 'Program')}
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
            {t('laser.dxf.import', 'Import DXF…')}
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
        <div className="lp-fields">
          <NumField
            label={t('laser.sheet.w', 'Sheet W')}
            unit="mm"
            min="1"
            value={sheetW}
            onChange={(n) => setSheetW(n)}
            title={t('laser.sheet.w.title', 'Usable sheet width (X).')}
          />
          <NumField
            label={t('laser.sheet.h', 'Sheet H')}
            unit="mm"
            min="1"
            value={sheetH}
            onChange={(n) => setSheetH(n)}
            title={t('laser.sheet.h.title', 'Usable sheet height (Y).')}
          />
          <NumField
            label={t('laser.sheet.spacing', 'Spacing')}
            unit="mm"
            min="0"
            step="0.5"
            value={margin}
            onChange={(n) => setMargin(n)}
            title={t('laser.sheet.spacing.title', 'Gap kept between parts and around the sheet edge.')}
          />
          <NumField
            label={t('laser.sheet.qty', 'Quantity')}
            min="1"
            value={quantity}
            parse={intNum}
            onChange={(n) => setQuantity(n)}
            title={t('laser.sheet.qty.title', 'Number of copies of the imported part to lay out.')}
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
      </section>

      {/* Common cut parameters. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>{t('laser.cut.title', 'Cut parameters')}</h4>
        </div>
        <div className="lp-fields">
          <NumField
            label={t('laser.cut.speed', 'Cut speed')}
            unit="mm/min"
            min="1"
            step="10"
            value={params.cutFeed}
            onChange={(n) => setParams({ cutFeed: n })}
            title={t('laser.cut.speed.title', 'Feed rate while cutting (G1 F…).')}
          />
          <NumField
            label={t('laser.cut.power', 'Power')}
            unit="S"
            min="0"
            step="10"
            value={params.power}
            onChange={(n) => setParams({ power: n })}
            title={t('laser.cut.power.title', 'Laser power as an S value (0..{sMax} = 0..100%). Currently {pct}%.', {
              sMax: params.sMax,
              pct: powerPct,
            })}
          />
          <NumField
            label={t('laser.cut.powerPct', 'Power %')}
            unit="%"
            min="0"
            max="100"
            value={powerPct}
            onChange={(n) => setParams({ power: powerFromPercent(n, params.sMax) })}
            title={t('laser.cut.powerPct.title', 'Laser power as a percentage of S-max.')}
          />
          <NumField
            label={t('laser.cut.sMax', 'S-max')}
            min="1"
            step="10"
            value={params.sMax}
            onChange={(n) => setParams({ sMax: n })}
            title={t('laser.cut.sMax.title', 'Max S value the controller maps to 100% (GRBL $30).')}
          />
          <NumField
            label={t('laser.cut.passes', 'Passes')}
            min="1"
            value={params.passes}
            parse={intNum}
            onChange={(n) => setParams({ passes: n })}
            title={t('laser.cut.passes.title', 'How many times each contour is cut.')}
          />
          <NumField
            label={t('laser.cut.decimals', 'Decimals')}
            min="0"
            max="6"
            value={params.decimals}
            parse={intNum}
            onChange={(n) => setParams({ decimals: n })}
            title={t('laser.cut.decimals.title', 'Coordinate precision in the emitted G-code.')}
          />
        </div>
        <div className="lp-radio-row">
          <span className="lp-radio-label" title={t('laser.powerMode.title', 'M4 dynamic scales power with feed (best for cutting); M3 is constant power.')}>
            {t('laser.powerMode', 'Power mode')}
          </span>
          <label className={`lp-radio${params.powerMode === LaserPowerMode.Dynamic ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="lp-powermode"
              checked={params.powerMode === LaserPowerMode.Dynamic}
              onChange={() => setParams({ powerMode: LaserPowerMode.Dynamic })}
            />
            {t('laser.powerMode.dynamic', 'M4 dynamic')}
          </label>
          <label className={`lp-radio${params.powerMode === LaserPowerMode.Constant ? ' is-on' : ''}`}>
            <input
              type="radio"
              name="lp-powermode"
              checked={params.powerMode === LaserPowerMode.Constant}
              onChange={() => setParams({ powerMode: LaserPowerMode.Constant })}
            />
            {t('laser.powerMode.constant', 'M3 constant')}
          </label>
        </div>
      </section>

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
          <div className="lp-fields">
            <NumField
              label={t('laser.pierce.power', 'Pierce power')}
              unit="S"
              min="0"
              step="10"
              value={params.piercePower}
              onChange={(n) => setParams({ piercePower: n })}
              title={t('laser.pierce.power.title', 'Beam power during the pre-cut pierce dwell (typically higher than cut power).')}
            />
            <NumField
              label={t('laser.pierce.time', 'Pierce time')}
              unit="s"
              min="0"
              step="0.05"
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
          <div className="lp-fields">
            <NumField
              label={t('laser.focus.z', 'Focus Z')}
              unit="mm"
              step="0.1"
              value={params.focusZ}
              onChange={(n) => setParams({ focusZ: n })}
              title={t('laser.focus.z.title', 'Absolute Z moved to at program start to set focus.')}
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

      <p className="lp-safety">
        {t('laser.safety', 'Safety: laser OFF (M5 S0) during all travel; beam on (M3/M4 S…) only on cut feeds; requires GRBL laser mode $32=1.')}
      </p>
    </div>
  )
}
