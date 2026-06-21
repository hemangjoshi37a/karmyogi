import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useProgram, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import { buildFrameProgram, frameBoundsOfGcode } from '../core/framing'
import { useTabCommands } from '../machine/tabCommands'
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
import {
  DitherMode,
  ScanAngle,
  defaultImageAdjust,
  defaultRasterParams,
  rgbaToGray,
  dither,
  burnToRGBA,
  emitRasterProgram,
  dpiToInterval,
  intervalToDpi,
  type ImageAdjust,
  type RasterParams,
} from '../core/laserImage'
import { CamEmpty } from '../components/cam/CamUI'
import '../styles/laser.css'
import '../styles/laserImage.css'
import '../styles/cam.css'

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
/** Top-level workbench: vector cutting vs raster image engraving. */
type LaserWorkbench = 'vector' | 'image'

/**
 * Laser workbench shell — switches between the VECTOR cutting workbench (DXF →
 * cut loops/lines) and the RASTER IMAGE engraving workbench (PNG/JPG → dithered
 * PWM raster). The two share the same Program-store sync contract (`'laser'`
 * section name) so only ONE is ever pushing G-code at a time.
 */
export function LaserPanel() {
  const t = useT()
  const [workbench, setWorkbench] = usePersistentState<LaserWorkbench>(
    'karmyogi.laser.workbench',
    'vector',
  )
  return (
    <div className="cc-presets-host" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div className="li-wb-switch" role="tablist" aria-label={t('laser.img.wb.aria', 'Laser workbench')}>
        <button
          type="button"
          role="tab"
          aria-selected={workbench === 'vector'}
          className={`li-seg-btn${workbench === 'vector' ? ' is-on' : ''}`}
          onClick={() => setWorkbench('vector')}
          title={t('laser.img.wb.vector.title', 'Vector cutting — DXF contours become cut loops and lines.')}
        >
          <Icon name="frame" size={14} /> {t('laser.img.wb.vector', 'Vector cut')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workbench === 'image'}
          className={`li-seg-btn${workbench === 'image' ? ' is-on' : ''}`}
          onClick={() => setWorkbench('image')}
          title={t('laser.img.wb.image.title', 'Raster engraving — a photo or logo burned line-by-line with dithering.')}
        >
          <Icon name="camera" size={14} /> {t('laser.img.wb.image', 'Image engrave')}
        </button>
      </div>
      {workbench === 'image' ? <LaserImageWorkbench /> : <LaserVectorWorkbench />}
    </div>
  )
}

// ===========================================================================
//  RASTER IMAGE ENGRAVING WORKBENCH
// ===========================================================================

/** Cap the working (dither) resolution so the live preview stays responsive. */
const MAX_WORK_PX = 1100 // longest edge of the working raster (≈1.2 MP cap)

/** Compact slider+number row scoped to the image workbench (mirrors SliderField). */
function ImgField(props: {
  icon: IconName
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
  const cl = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  const pct = max > min ? Math.min(100, Math.max(0, ((cl(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="li-sfield" title={title}>
      <span className="li-sfield-lbl">
        <span className="li-sfield-ico" aria-hidden>
          <Icon name={icon} size={13} />
        </span>
        <span className="li-sfield-txt">{label}</span>
      </span>
      <input
        type="range"
        className="li-slider"
        min={min}
        max={max}
        step={step}
        value={cl(value)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(cl(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="li-snum">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-label={label}
          onChange={(e) => {
            const v = integer ? parseInt(e.target.value, 10) : parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <i>{unit}</i> : null}
      </span>
    </div>
  )
}

/** Decoded source image kept in memory as RGBA + its native dimensions. */
interface SourceImage {
  rgba: Uint8ClampedArray
  w: number
  h: number
  name: string
}

/** Image-engraving params persisted to localStorage (adjust + raster + dither). */
interface ImgParams {
  adjust: ImageAdjust
  dither: DitherMode
  newsCell: number
  // raster (subset of RasterParams driven by the UI)
  dpi: number
  scanAngle: ScanAngle
  overscan: number
  bidirectional: boolean
  widthMm: number
  lockAspect: boolean
  feed: number
  dynamicPower: boolean
  sMin: number
  sMax: number
  passes: number
  zPerPass: number
  useFocusZ: boolean
  focusZ: number
  decimals: number
}

function defaultImgParams(): ImgParams {
  const r = defaultRasterParams()
  return {
    adjust: defaultImageAdjust(),
    dither: DitherMode.FloydSteinberg,
    newsCell: 4,
    dpi: Math.round(intervalToDpi(r.lineInterval)),
    scanAngle: ScanAngle.Horizontal,
    overscan: r.overscan,
    bidirectional: r.bidirectional,
    widthMm: r.widthMm,
    lockAspect: true,
    feed: r.feed,
    dynamicPower: r.dynamicPower,
    sMin: r.sMin,
    sMax: r.sMax,
    passes: r.passes,
    zPerPass: r.zPerPass,
    useFocusZ: r.useFocusZ,
    focusZ: r.focusZ,
    decimals: r.decimals,
  }
}

function LaserImageWorkbench() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const streaming = useProgram((s) => s.streaming)

  const [params, setParams] = usePersistentState<ImgParams>(
    'karmyogi.laser.img.params',
    defaultImgParams(),
  )
  const patch = useCallback(
    (p: Partial<ImgParams>) => setParams((cur) => ({ ...cur, ...p })),
    [setParams],
  )
  const patchAdjust = useCallback(
    (p: Partial<ImageAdjust>) => setParams((cur) => ({ ...cur, adjust: { ...cur.adjust, ...p } })),
    [setParams],
  )

  // Source image (NOT persisted — re-import each session).
  const [src, setSrc] = useState<SourceImage | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<'dither' | 'source'>('dither')
  const [busy, setBusy] = useState(false)

  const previewCanvas = useRef<HTMLCanvasElement>(null)

  // ---- Load + decode an image file to RGBA via an offscreen canvas. -------
  const loadFile = useCallback((file: File) => {
    setLoadErr('')
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      // Downscale to the working cap on load (keeps everything fast).
      const scale = Math.min(1, MAX_WORK_PX / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const cv = document.createElement('canvas')
      cv.width = w
      cv.height = h
      const ctx = cv.getContext('2d')
      if (!ctx) {
        setLoadErr(t('laser.img.err.decode', 'Could not decode the image.'))
        URL.revokeObjectURL(url)
        return
      }
      ctx.drawImage(img, 0, 0, w, h)
      const data = ctx.getImageData(0, 0, w, h).data
      setSrc({ rgba: new Uint8ClampedArray(data), w, h, name: file.name })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      setLoadErr(t('laser.img.err.load', 'Could not load {name}. Use a PNG or JPG.', { name: file.name }))
      URL.revokeObjectURL(url)
    }
    img.src = url
  }, [t])

  // Engraved output height derived from aspect when locked.
  const aspect = src ? src.h / src.w : 0.75
  const heightMm = useMemo(
    () => (params.lockAspect && src ? params.widthMm * aspect : params.widthMm * aspect),
    [params.lockAspect, params.widthMm, aspect, src],
  )

  // ---- Live dither (debounced) → burn map + preview canvas. ---------------
  // The dither result is the SAME burn map the emitter uses, so the preview is
  // literally what will burn. Kept off the critical path via a debounce.
  const [burn, setBurn] = useState<{ map: Float32Array; w: number; h: number } | null>(null)

  useEffect(() => {
    if (!src) {
      setBurn(null)
      return
    }
    setBusy(true)
    const id = window.setTimeout(() => {
      const gray = rgbaToGray(src.rgba, src.w, src.h, params.adjust)
      const map = dither(gray, params.dither, params.newsCell)
      setBurn({ map, w: src.w, h: src.h })
      setBusy(false)
    }, 180)
    return () => window.clearTimeout(id)
  }, [src, params.adjust, params.dither, params.newsCell])

  // Paint the preview canvas whenever the burn map / source / tab changes.
  useEffect(() => {
    const cv = previewCanvas.current
    if (!cv || !src) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    cv.width = src.w
    cv.height = src.h
    if (preview === 'source') {
      const imgData = ctx.createImageData(src.w, src.h)
      imgData.data.set(src.rgba)
      ctx.putImageData(imgData, 0, 0)
    } else if (burn) {
      const rgba = burnToRGBA(burn.map, burn.w, burn.h)
      const imgData = ctx.createImageData(burn.w, burn.h)
      imgData.data.set(rgba)
      ctx.putImageData(imgData, 0, 0)
    }
  }, [burn, src, preview])

  // ---- Raster G-code (recomputed from the burn map + params). -------------
  const result = useMemo(() => {
    if (!burn) return null
    const rp: Partial<RasterParams> = {
      widthMm: Math.max(1, params.widthMm),
      heightMm: Math.max(1, params.widthMm * aspect),
      lineInterval: dpiToInterval(params.dpi),
      scanAngle: params.scanAngle,
      overscan: Math.max(0, params.overscan),
      bidirectional: params.bidirectional,
      feed: Math.max(1, params.feed),
      dynamicPower: params.dynamicPower,
      sMin: Math.max(0, Math.min(params.sMin, params.sMax)),
      sMax: Math.max(params.sMin, params.sMax),
      passes: Math.max(1, Math.floor(params.passes)),
      zPerPass: params.zPerPass,
      useFocusZ: params.useFocusZ,
      focusZ: params.focusZ,
      decimals: params.decimals,
      programName: `hjLabs Laser raster — ${src?.name ?? 'image'}`,
    }
    return emitRasterProgram(burn.map, burn.w, burn.h, rp)
  }, [burn, params, aspect, src])

  // Live sync to the Program store (debounced; never while streaming).
  useEffect(() => {
    if (streaming) return
    const gcode = result?.gcode ?? ''
    const id = window.setTimeout(() => setProgram('laser', gcode), 300)
    return () => window.clearTimeout(id)
  }, [result, setProgram, streaming])

  const showNewsCell = params.dither === DitherMode.Newsprint
  const sMaxPct = params.sMax > 0 ? Math.round((params.sMin / params.sMax) * 100) : 0

  // ── Gamepad command bus: frame the raster job's perimeter (tool/laser OFF). ──
  useTabCommands('laser', {
    frame: () => {
      const lines = result?.gcode ? result.gcode.split(/\r?\n/) : []
      if (!grbl.isConnected || lines.length === 0) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
  })

  return (
    <div className="li-root">
      {/* Header + live status. */}
      <header className="li-head">
        <span className="li-head-title">
          <span className="li-head-ico" aria-hidden>
            <Icon name="camera" size={15} />
          </span>
          {t('laser.img.title', 'Image raster engraving')}
        </span>
        <span className="li-head-spacer" />
        <FrameButton
          lines={result?.gcode ? result.gcode.split(/\r?\n/) : []}
          showOptions={false}
          label={t('laser.img.frame', 'Frame')}
          className="lp-frame"
        />
      </header>

      <div className="li-status">
        {src ? (
          <>
            <span className="li-status-pill">
              <b>{src.w}×{src.h}</b> px
            </span>
            <span className="li-status-sep" aria-hidden>·</span>
            <span className="li-status-pill">
              <b>{params.widthMm.toFixed(0)}×{heightMm.toFixed(0)}</b> mm
            </span>
            <span className="li-status-sep" aria-hidden>·</span>
            <span className="li-status-pill"><b>{params.dpi}</b> DPI</span>
            {result && (
              <>
                <span className="li-status-sep" aria-hidden>·</span>
                <span className="li-status-pill"><b>{result.scanLines}</b> {t('laser.img.status.lines', 'lines')}</span>
                <span className="li-status-sep" aria-hidden>·</span>
                <span
                  className="li-status-pill"
                  title={t('laser.img.status.estTitle', 'Estimated burn-path length and time (all passes).')}
                >
                  <b>{(result.pathLengthMm / 1000).toFixed(1)} m</b> · <b>{fmtDuration(result.timeSeconds)}</b>
                </span>
              </>
            )}
          </>
        ) : (
          <span>{t('laser.img.status.none', 'No image loaded')}</span>
        )}
        <span
          className="li-status-sync"
          title={
            streaming
              ? t('laser.img.status.streamingTitle', 'Streaming — live sync paused so the running job is not reset.')
              : t('laser.img.status.syncTitle', 'Lines auto-synced to the Program tab.')
          }
        >
          {streaming ? (
            <>
              <Icon name="play" size={12} /> {t('laser.img.status.streaming', 'Streaming')}
            </>
          ) : (
            <>
              <Icon name="chevron-right" size={12} /> {t('laser.img.status.program', 'Program')}
            </>
          )}
        </span>
      </div>

      {/* Live preview — the glance-to-understand centerpiece. */}
      <section className="li-card">
        <div className="li-card-head">
          <h4>
            <span className="li-card-ico" aria-hidden>
              <Icon name="eye" size={14} />
            </span>
            {t('laser.img.preview.title', 'Preview')}
          </h4>
          {src && (
            <div className="li-preview-tabs" role="tablist" aria-label={t('laser.img.preview.aria', 'Preview source')}>
              <button
                type="button"
                role="tab"
                aria-selected={preview === 'dither'}
                className={`li-preview-tab${preview === 'dither' ? ' is-on' : ''}`}
                onClick={() => setPreview('dither')}
                title={t('laser.img.preview.dither.title', 'Exactly what will burn — the dithered result.')}
              >
                {t('laser.img.preview.dither', 'Dithered')}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={preview === 'source'}
                className={`li-preview-tab${preview === 'source' ? ' is-on' : ''}`}
                onClick={() => setPreview('source')}
                title={t('laser.img.preview.source.title', 'The original image (before adjustments/dither).')}
              >
                {t('laser.img.preview.source', 'Original')}
              </button>
            </div>
          )}
        </div>
        <div className="li-preview">
          {src ? (
            <>
              <canvas ref={previewCanvas} />
              {busy && (
                <div className="li-preview-busy">{t('laser.img.preview.busy', 'Rendering…')}</div>
              )}
            </>
          ) : (
            <div className="li-preview-empty">
              <span className="li-empty-ico" aria-hidden>
                <Icon name="camera" size={26} />
              </span>
              <p>{t('laser.img.preview.empty', 'Load a PNG or JPG to see the live dithered preview — exactly what the laser will burn.')}</p>
            </div>
          )}
        </div>
        <div className="li-import-row" style={{ marginTop: 'var(--sp-2)' }}>
          <button type="button" className="li-primary" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={15} /> {src ? t('laser.img.replace', 'Replace image…') : t('laser.img.load', 'Load image…')}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/bmp,image/gif"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadFile(f)
              e.target.value = ''
            }}
          />
          {src && <span className="li-import-info">{src.name}</span>}
        </div>
        {loadErr && <p className="li-warn">{loadErr}</p>}
      </section>

      {/* Image adjustments. */}
      <section className="li-card">
        <div className="li-card-head">
          <h4>
            <span className="li-card-ico" aria-hidden>
              <Icon name="settings" size={14} />
            </span>
            {t('laser.img.adjust.title', 'Image')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.brightness', 'Brightness')}
            min={-100}
            max={100}
            step={1}
            integer
            value={params.adjust.brightness}
            onChange={(n) => patchAdjust({ brightness: n })}
            title={t('laser.img.adjust.brightness.title', 'Lighten or darken the whole image before dithering (−100…100).')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.contrast', 'Contrast')}
            min={-100}
            max={100}
            step={1}
            integer
            value={params.adjust.contrast}
            onChange={(n) => patchAdjust({ contrast: n })}
            title={t('laser.img.adjust.contrast.title', 'Expand or compress the tonal range around mid-grey (−100…100).')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.adjust.gamma', 'Gamma')}
            min={0.1}
            max={3}
            step={0.05}
            value={params.adjust.gamma}
            onChange={(n) => patchAdjust({ gamma: n })}
            title={t('laser.img.adjust.gamma.title', 'Midtone curve. <1 darkens mids, >1 lightens them (0.1…3).')}
          />
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.adjust.invert.title', 'Swap black and white — engrave the negative.')}>
            <input
              type="checkbox"
              checked={params.adjust.invert}
              onChange={(e) => patchAdjust({ invert: e.target.checked })}
            />
            {t('laser.img.adjust.invert', 'Invert')}
          </label>
        </div>
      </section>

      {/* Dither mode. */}
      <section className="li-card">
        <div className="li-card-head">
          <h4>
            <span className="li-card-ico" aria-hidden>
              <Icon name="copy" size={14} />
            </span>
            {t('laser.img.dither.title', 'Dither')}
          </h4>
        </div>
        <div className="li-dither-grid" role="radiogroup" aria-label={t('laser.img.dither.aria', 'Dither mode')}>
          {[
            { value: DitherMode.Threshold, label: t('laser.img.dither.threshold', 'Threshold'), title: t('laser.img.dither.threshold.title', 'Hard 50% cut — pure black/white, no shading.') },
            { value: DitherMode.Ordered, label: t('laser.img.dither.ordered', 'Ordered'), title: t('laser.img.dither.ordered.title', 'Bayer matrix — fast, regular crosshatch pattern.') },
            { value: DitherMode.FloydSteinberg, label: t('laser.img.dither.floyd', 'Floyd–Steinberg'), title: t('laser.img.dither.floyd.title', 'Classic error diffusion — best all-round photo detail.') },
            { value: DitherMode.Jarvis, label: t('laser.img.dither.jarvis', 'Jarvis'), title: t('laser.img.dither.jarvis.title', 'Wider diffusion — smoother gradients, slightly softer.') },
            { value: DitherMode.Stucki, label: t('laser.img.dither.stucki', 'Stucki'), title: t('laser.img.dither.stucki.title', 'Sharp, clean diffusion with strong edge retention.') },
            { value: DitherMode.Atkinson, label: t('laser.img.dither.atkinson', 'Atkinson'), title: t('laser.img.dither.atkinson.title', 'High-contrast, airy look (classic Mac).') },
            { value: DitherMode.Newsprint, label: t('laser.img.dither.newsprint', 'Newsprint'), title: t('laser.img.dither.newsprint.title', 'Clustered round dots — print/halftone look that survives low DPI.') },
            { value: DitherMode.Grayscale, label: t('laser.img.dither.grayscale', 'Grayscale'), title: t('laser.img.dither.grayscale.title', 'No dither — power varies continuously with tone (variable-depth).') },
          ].map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={params.dither === o.value}
              className={`li-seg-btn${params.dither === o.value ? ' is-on' : ''}`}
              title={o.title}
              onClick={() => patch({ dither: o.value })}
            >
              {o.label}
            </button>
          ))}
        </div>
        {showNewsCell && (
          <div className="li-fields" style={{ marginTop: 'var(--sp-2)' }}>
            <ImgField
              icon="settings"
              label={t('laser.img.dither.cell', 'Dot cell')}
              unit="px"
              min={2}
              max={12}
              step={1}
              integer
              value={params.newsCell}
              onChange={(n) => patch({ newsCell: n })}
              title={t('laser.img.dither.cell.title', 'Halftone cell size — bigger cells = coarser, more visible dots.')}
            />
          </div>
        )}
      </section>

      {/* Raster geometry. */}
      <section className="li-card">
        <div className="li-card-head">
          <h4>
            <span className="li-card-ico" aria-hidden>
              <Icon name="frame" size={14} />
            </span>
            {t('laser.img.raster.title', 'Raster')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="frame"
            label={t('laser.img.raster.width', 'Width')}
            unit="mm"
            min={1}
            max={1000}
            step={1}
            value={params.widthMm}
            onChange={(n) => patch({ widthMm: n })}
            title={t('laser.img.raster.width.title', 'Engraved output width (X). Height follows the image aspect ratio.')}
          />
          <ImgField
            icon="settings"
            label={t('laser.img.raster.dpi', 'DPI')}
            unit="dpi"
            min={50}
            max={1200}
            step={10}
            integer
            value={params.dpi}
            onChange={(n) => patch({ dpi: n })}
            title={t('laser.img.raster.dpi.title', 'Lines per inch. Interval = {mm} mm. Higher = finer + slower.', { mm: dpiToInterval(params.dpi).toFixed(3) })}
          />
          <ImgField
            icon="jog"
            label={t('laser.img.raster.overscan', 'Overscan')}
            unit="mm"
            min={0}
            max={20}
            step={0.5}
            value={params.overscan}
            onChange={(n) => patch({ overscan: n })}
            title={t('laser.img.raster.overscan.title', 'Extra travel past each end of a line so the head is at full speed over edge pixels (avoids edge over-burn).')}
          />
        </div>
        <div className="li-segrow">
          <span className="li-segrow-label" title={t('laser.img.raster.angle.title', 'Scan-line direction: horizontal (sweep X) or vertical (sweep Y).')}>
            {t('laser.img.raster.angle', 'Scan angle')}
          </span>
          <div className="li-seg" role="radiogroup" aria-label={t('laser.img.raster.angle', 'Scan angle')}>
            <button
              type="button"
              role="radio"
              aria-checked={params.scanAngle === ScanAngle.Horizontal}
              className={`li-seg-btn${params.scanAngle === ScanAngle.Horizontal ? ' is-on' : ''}`}
              onClick={() => patch({ scanAngle: ScanAngle.Horizontal })}
            >
              {t('laser.img.raster.angle.h', '0° (horizontal)')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={params.scanAngle === ScanAngle.Vertical}
              className={`li-seg-btn${params.scanAngle === ScanAngle.Vertical ? ' is-on' : ''}`}
              onClick={() => patch({ scanAngle: ScanAngle.Vertical })}
            >
              {t('laser.img.raster.angle.v', '90° (vertical)')}
            </button>
          </div>
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.raster.bidi.title', 'Engrave on both sweep directions (faster) vs always left-to-right (more consistent, slower).')}>
            <input
              type="checkbox"
              checked={params.bidirectional}
              onChange={(e) => patch({ bidirectional: e.target.checked })}
            />
            {t('laser.img.raster.bidi', 'Bidirectional')}
          </label>
        </div>
      </section>

      {/* Power + passes. */}
      <section className="li-card">
        <div className="li-card-head">
          <h4>
            <span className="li-card-ico" aria-hidden>
              <Icon name="laser" size={14} />
            </span>
            {t('laser.img.power.title', 'Power')}
          </h4>
        </div>
        <div className="li-fields">
          <ImgField
            icon="jog"
            label={t('laser.img.power.feed', 'Feed')}
            unit="mm/min"
            min={1}
            max={20000}
            step={50}
            value={params.feed}
            onChange={(n) => patch({ feed: n })}
            title={t('laser.img.power.feed.title', 'Engraving speed for every scan line (G1 F…).')}
          />
          <ImgField
            icon="laser"
            label={t('laser.img.power.sMin', 'S-min (white)')}
            unit="S"
            min={0}
            max={Math.max(1, params.sMax)}
            step={5}
            integer
            value={params.sMin}
            onChange={(n) => patch({ sMin: clamp(n, 0, Math.max(1, params.sMax)) })}
            title={t('laser.img.power.sMin.title', 'Power for the LIGHTEST tone. Keep low (often 0) so white stays unburnt. ({pct}% of S-max)', { pct: sMaxPct })}
          />
          <ImgField
            icon="laser"
            label={t('laser.img.power.sMax', 'S-max (black)')}
            unit="S"
            min={1}
            max={2000}
            step={10}
            integer
            value={params.sMax}
            onChange={(n) => patch({ sMax: n })}
            title={t('laser.img.power.sMax.title', 'Power for the DARKEST tone (also your GRBL $30 ceiling).')}
          />
          <ImgField
            icon="copy"
            label={t('laser.img.power.passes', 'Passes')}
            min={1}
            max={20}
            step={1}
            integer
            value={params.passes}
            onChange={(n) => patch({ passes: n })}
            title={t('laser.img.power.passes.title', 'How many times the whole image is engraved.')}
          />
          {params.passes > 1 && (
            <ImgField
              icon="probe"
              label={t('laser.img.power.zPerPass', 'Z / pass')}
              unit="mm"
              min={-5}
              max={5}
              step={0.05}
              value={params.zPerPass}
              onChange={(n) => patch({ zPerPass: n })}
              title={t('laser.img.power.zPerPass.title', 'Z change applied each pass (e.g. focus stepping for deep engraves). 0 = none.')}
            />
          )}
          <ImgField
            icon="settings"
            label={t('laser.img.power.decimals', 'Decimals')}
            min={0}
            max={6}
            step={1}
            integer
            value={params.decimals}
            onChange={(n) => patch({ decimals: n })}
            title={t('laser.img.power.decimals.title', 'Coordinate precision in the emitted G-code.')}
          />
        </div>
        <div className="li-segrow">
          <span className="li-segrow-label" title={t('laser.img.power.mode.title', 'M4 dynamic scales power with feed (recommended for engraving — even shading through accel); M3 is constant power.')}>
            {t('laser.img.power.mode', 'Power mode')}
          </span>
          <div className="li-seg" role="radiogroup" aria-label={t('laser.img.power.mode', 'Power mode')}>
            <button
              type="button"
              role="radio"
              aria-checked={params.dynamicPower}
              className={`li-seg-btn${params.dynamicPower ? ' is-on' : ''}`}
              onClick={() => patch({ dynamicPower: true })}
            >
              <Icon name="play" size={13} /> {t('laser.img.power.m4', 'M4 dynamic')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={!params.dynamicPower}
              className={`li-seg-btn${!params.dynamicPower ? ' is-on' : ''}`}
              onClick={() => patch({ dynamicPower: false })}
            >
              <Icon name="spindle" size={13} /> {t('laser.img.power.m3', 'M3 constant')}
            </button>
          </div>
        </div>
        <div className="li-toggle-row">
          <label className="li-toggle" title={t('laser.img.power.focus.title', 'Move Z to a fixed focus height at program start (no negative Z — there is no safe-Z retract before it).')}>
            <input
              type="checkbox"
              checked={params.useFocusZ}
              onChange={(e) => patch({ useFocusZ: e.target.checked })}
            />
            {t('laser.img.power.focus', 'Set focus Z')}
          </label>
          {params.useFocusZ && (
            <span className="li-snum">
              <input
                type="number"
                min={0}
                max={200}
                step={0.1}
                value={String(params.focusZ)}
                aria-label={t('laser.img.power.focusZ', 'Focus Z')}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  if (Number.isFinite(v)) patch({ focusZ: clamp(v, 0, 200) })
                }}
              />
              <i>mm</i>
            </span>
          )}
        </div>
      </section>

      <p className="li-safety">
        <span className="li-safety-ico" aria-hidden>
          <Icon name="warning" size={15} />
        </span>
        <span>
          {t(
            'laser.img.safety',
            'Safety: never leave a firing laser unattended and always wear rated eye protection. Beam is OFF (S0/M5) on every travel and at program end; it fires only on scan moves. Requires GRBL laser mode $32=1, and S-max should not exceed your $30 ceiling.',
          )}
        </span>
      </p>
    </div>
  )
}

function LaserVectorWorkbench() {
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
  const [showAdvanced, setShowAdvanced] = usePersistentState<boolean>('karmyogi.laser.showAdvanced', false)

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

  // ── Gamepad command bus: frame the vector cut's perimeter (laser OFF). ──
  useTabCommands('laser', {
    frame: () => {
      const lines = gcode ? gcode.split(/\r?\n/) : []
      if (!grbl.isConnected || lines.length === 0) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
  })

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
          <h4>
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="frame" size={14} />
            </span>
            {t('laser.dxf.title', 'Drawing (DXF)')}
          </h4>
          {fileName && <span className="lp-card-count">{fileName}</span>}
        </div>
        <div className="lp-import-row">
          <button
            type="button"
            className="cam-primary"
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
          <CamEmpty
            icon={<Icon name="laser" size={20} />}
            title={t('laser.dxf.empty.title', 'No drawing loaded')}
            hint={t('laser.dxf.empty.hint', 'Import a DXF — closed contours become cut loops, open paths become cut lines.')}
          />
        )}
      </section>

      {/* Nesting / sheet. */}
      <section className="lp-card">
        <div className="lp-card-head">
          <h4>
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="duplicate" size={14} />
            </span>
            {t('laser.sheet.title', 'Sheet & nesting')}
          </h4>
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
          <h4>
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="laser" size={14} />
            </span>
            {t('laser.cut.title', 'Cut parameters')}
          </h4>
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
