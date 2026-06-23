import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  useMachine,
  useProgram,
  useNotifications,
  usePersistentState,
  useCameraCalib,
  useCameraLive,
} from '../store'
import { useSolderViz } from '../store/solderViz'
import { useProgramOwner } from '../store/programOwner'
import { useTabCommands } from '../machine/tabCommands'
import { grbl } from '../serial/controller'
import { detectPadsFromVideo, type MappedPad } from '../camera/padDetect'
import { runIronTouchZ } from '../camera/ironTouchZ'
import { videoToGray } from '../camera/bedTracking'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import {
  SolderFeedType,
  defaultSolderPoint,
  defaultSolderingParams,
  estimateSolderingSeconds,
  generateSolderingSegments,
  orderSolderPointsForTravel,
  solderTravelDistance,
  type SolderApproach,
  type SolderPoint,
  type SolderingParams,
} from '../core/soldering'
import {
  classifySolderCandidates,
  extractSolderPoints,
  type SolderLayerCandidate,
  type SolderLayerKind,
} from '../core/solderFromGerber'
import {
  unzipGerberPackage,
  GerberPackageError,
} from '../core/gerberPackage'
import { CamStatus, CamEmpty } from '../components/cam/CamUI'
import { SegControl } from '../components/ui/SegControl'
import '../styles/soldering.css'

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
  approach: SolderApproach
}

/** Global generator params held in panel state (programName/metric are fixed). */
type SolderParams = Omit<SolderingParams, 'programName' | 'metric'>

/**
 * A reusable SOLDERING preset: the feeder/motion params + the new-point defaults
 * (NOT the point list, which is the operator's actual work). Scoped to its own
 * persistence key, independent of the carving + writing presets.
 */
interface SolderingPreset {
  params: SolderParams
  defaults: RowDefaults
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

/** Coerce an (untrusted) value to a finite number, else the fallback. */
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

const CSV_HEADER = 'x,y,freeZ,touchZ,type,feedSeconds,approach'

/**
 * Per-point operation tint for the Program-tab breakdown + the Visualizer's
 * toolpath slice — the soldering accent cyan (matches the 3D SolderScene
 * highlight `hiColor`). One shared colour: every point reads as "soldering".
 */
const SOLDER_OP_COLOR = '#0891b2'

/** Serialize the soldering points to a CSV string (header + one row each). */
function pointsToCsv(points: SolderPoint[]): string {
  const rows = points.map((p) =>
    [p.x, p.y, p.freeZ, p.touchZ, p.type, p.feedSeconds, p.approach].join(','),
  )
  return [CSV_HEADER, ...rows].join('\n') + '\n'
}

/** Lenient feed-type parse: accepts the enum values or the human labels. */
function parseFeedType(v: string): SolderFeedType {
  const s = v.trim().toLowerCase().replace(/[\s_-]/g, '')
  return s === 'presolder' ? SolderFeedType.PreSolder : SolderFeedType.TouchDown
}

/**
 * Lenient approach parse: accepts the new directional values
 * ('angle-front'/'angle-right'/'angle-left'/'angle-back') in any
 * case/separator form, maps the LEGACY 'angle45'/'45'/'angle' to 'angle-front'
 * for backward compatibility, and otherwise falls back to 'plunge'.
 */
function parseApproach(v: string): SolderApproach {
  const s = v.trim().toLowerCase().replace(/[\s_-]/g, '')
  if (s === 'anglefront') return 'angle-front'
  if (s === 'angleright') return 'angle-right'
  if (s === 'angleleft') return 'angle-left'
  if (s === 'angleback') return 'angle-back'
  // Legacy single-direction 45° value → front (the new default 45° direction).
  if (s === 'angle45' || s === '45' || s === 'angle') return 'angle-front'
  return 'plunge'
}

/**
 * The five descent approaches in display order, with their UI labels. Reused by
 * the new-point defaults select, the per-row table select, and the mobile card
 * radios so the option set stays in one place.
 */
function approachOptions(t: ReturnType<typeof useT>): { value: SolderApproach; label: string }[] {
  return [
    { value: 'plunge', label: t('solder.approach.plunge', 'Plunge ↓') },
    { value: 'angle-front', label: t('solder.approach.front', '45° front') },
    { value: 'angle-right', label: t('solder.approach.right', '45° right') },
    { value: 'angle-left', label: t('solder.approach.left', '45° left') },
    { value: 'angle-back', label: t('solder.approach.back', '45° back') },
  ]
}

/**
 * Parse a CSV string into soldering points. Tolerant of an optional header row,
 * extra whitespace, and missing trailing columns (filled from the point
 * defaults). Returns [] if nothing usable was found.
 */
function csvToPoints(text: string): SolderPoint[] {
  const out: SolderPoint[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const cols = line.split(',').map((c) => c.trim())
    // Skip a header row (first cell non-numeric, e.g. "x").
    if (!Number.isFinite(parseFloat(cols[0]))) continue
    out.push(
      defaultSolderPoint({
        x: num(cols[0], 0),
        y: num(cols[1], 0),
        freeZ: num(cols[2], 5),
        touchZ: num(cols[3], -1),
        type: cols[4] ? parseFeedType(cols[4]) : SolderFeedType.TouchDown,
        feedSeconds: num(cols[5], 0.5),
        approach: cols[6] ? parseApproach(cols[6]) : 'plunge',
      }),
    )
  }
  return out
}

/**
 * A slim square icon button for the header toolbar. Its `title`/`body` are
 * combined into a native hover tooltip explainer (one that never intercepts the
 * action click), keeping the toolbar compact while every button stays
 * self-documenting.
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

/**
 * A themed slider + number-input + unit row, mirroring the Carving panel's
 * `SliderField` and the Controller jog "Feed" control: a compact one-line row of
 * [label · range slider · number input · unit]. The range shows a CSS accent fill
 * via the inline `--sol-pct` custom property; the number input stays editable so
 * exact typing still works. `min`/`max`/`step` set the slider drag range/step,
 * while the typed value is NOT clamped to that range (only blank/NaN is rejected,
 * via `parse`), so values outside the convenient slider range can still be typed.
 */
function NumField(props: {
  label: string
  value: number
  unit?: string
  /** Slider drag bounds + granularity. */
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  /** Optional coercion of a typed value (e.g. integer-only for Decimals). */
  parse?: (v: string, fallback: number) => number
  info?: { title: string; body: string }
}) {
  const { label, value, unit, min, max, step, onChange, parse = num, info } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the slider's accent fill (read as --sol-pct by the
  // WebKit/Blink gradient; Firefox fills via ::-moz-range-progress). Uses the
  // CLAMPED value so an out-of-range typed value doesn't overflow the fill.
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="sp-sfield">
      <span className="sp-sfield-lbl">
        <span className="sp-sfield-txt">{label}</span>
        {info && <InfoTip topic="solderField" title={info.title} body={info.body} />}
      </span>
      <input
        type="range"
        className="sp-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--sol-pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(parse(e.target.value, value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="sp-sfield-num">
        <input
          type="number"
          className="sp-slider-num"
          step={step}
          value={String(value)}
          aria-label={label}
          onChange={(e) => onChange(parse(e.target.value, value))}
        />
        {unit && <span className="sp-sfield-unit">{unit}</span>}
      </span>
    </div>
  )
}

/**
 * A compact segmented (pill) control for a small enum — mirrors the `.cc-opseg`
 * carving control and the `.sp-radio` chips. All-options-visible, the active one
 * highlighted in the accent. Used for the new-point default Feed type.
 */
function SegField<T extends string>(props: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  info?: { title: string; body: string }
}) {
  const { label, value, options, onChange, info } = props
  return (
    <div className="sp-segfield">
      <span className="sp-sfield-lbl">
        <span className="sp-sfield-txt">{label}</span>
        {info && <InfoTip topic="solderField" title={info.title} body={info.body} />}
      </span>
      {/* Canonical segmented control (§2.8/W-C): roving-tabindex + arrow keys.
          A feed-type MODE switch → tonal variant. */}
      <SegControl<T>
        options={options}
        value={value}
        onChange={onChange}
        ariaLabel={label}
        variant="tonal"
        size="sm"
      />
    </div>
  )
}

/** The per-point columns that support bulk "apply to all". X/Y are excluded —
 *  they are per-point coordinates, never sensibly the same across the board. */
type BulkField = 'freeZ' | 'touchZ' | 'feedSeconds' | 'type' | 'approach'

/**
 * A small "apply to all" affordance that lives inside a column header. It shows a
 * tiny "fill down" icon button; clicking it opens a compact popover with a value
 * editor (number input, segmented pills, or a select — matching the column's
 * native editor) and an "Apply to N" button that writes that value to every
 * existing point's that-column. Closes on apply, Escape, or outside click. This
 * edits the EXISTING points only — the new-point defaults are untouched.
 */
function ColumnBulkEdit(props: {
  field: BulkField
  /** Column label (e.g. "Touch-Z") for the popover title + aria. */
  label: string
  /** Number of points the action will affect (0 disables the trigger). */
  count: number
  /** Render the value editor for this column; calls back with the chosen value. */
  apply: (patch: Partial<SolderPoint>) => void
  t: ReturnType<typeof useT>
  approachOpts: { value: SolderApproach; label: string }[]
  unit?: string
  step?: number
}) {
  const { field, label, count, apply, t, approachOpts, unit, step = 0.1 } = props
  const [open, setOpen] = useState(false)
  const [numVal, setNumVal] = useState('0')
  const [feedType, setFeedType] = useState<SolderFeedType>(SolderFeedType.TouchDown)
  const [approach, setApproach] = useState<SolderApproach>('plunge')
  const wrapRef = useRef<HTMLSpanElement>(null)
  const firstRef = useRef<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>(null)

  // Close on outside-click / Escape while open; focus the first field on open.
  useEffect(() => {
    if (!open) return
    firstRef.current?.focus()
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const isNumber = field === 'freeZ' || field === 'touchZ' || field === 'feedSeconds'

  function commit() {
    if (field === 'type') apply({ type: feedType })
    else if (field === 'approach') apply({ approach })
    else {
      const n = num(numVal, 0)
      const v = field === 'feedSeconds' ? Math.max(0, n) : n
      apply({ [field]: v } as Partial<SolderPoint>)
    }
    setOpen(false)
  }

  return (
    <span className="sp-bulk" ref={wrapRef}>
      <button
        type="button"
        className={`sp-bulk-trigger${open ? ' is-open' : ''}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        disabled={count === 0}
        aria-expanded={open}
        aria-label={t('solder.bulk.aria', 'Set {label} for all points', { label })}
        title={t('solder.bulk.title', 'Set {label} for all {n} points at once', { label, n: count })}
      >
        {/* "fill down" glyph: a value dripping to the rows below */}
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3v9" />
          <path d="m8 9 4 4 4-4" />
          <path d="M5 18h14" />
          <path d="M5 21h14" />
        </svg>
      </button>
      {open && (
        <div className="sp-bulk-pop" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('solder.bulk.aria', 'Set {label} for all points', { label })}>
          <div className="sp-bulk-pop-title">
            {t('solder.bulk.popTitle', 'Set {label} on all points', { label })}
          </div>
          {isNumber && (
            <label className="sp-bulk-num">
              <input
                ref={firstRef as React.RefObject<HTMLInputElement>}
                type="number"
                step={step}
                min={field === 'feedSeconds' ? 0 : undefined}
                value={numVal}
                onChange={(e) => setNumVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commit()
                }}
                aria-label={label}
              />
              {unit && <span className="sp-bulk-unit">{unit}</span>}
            </label>
          )}
          {field === 'type' && (
            <div className="sp-bulk-seg" role="group" aria-label={label}>
              <button
                ref={firstRef as React.RefObject<HTMLButtonElement>}
                type="button"
                className={`sp-bulk-seg-btn${feedType === SolderFeedType.PreSolder ? ' active' : ''}`}
                aria-pressed={feedType === SolderFeedType.PreSolder}
                onClick={() => setFeedType(SolderFeedType.PreSolder)}
              >
                {t('solder.feedType.preSolder', 'pre-solder')}
              </button>
              <button
                type="button"
                className={`sp-bulk-seg-btn${feedType === SolderFeedType.TouchDown ? ' active' : ''}`}
                aria-pressed={feedType === SolderFeedType.TouchDown}
                onClick={() => setFeedType(SolderFeedType.TouchDown)}
              >
                {t('solder.feedType.touchDown', 'touch-down')}
              </button>
            </div>
          )}
          {field === 'approach' && (
            <select
              ref={firstRef as React.RefObject<HTMLSelectElement>}
              className="sp-bulk-select"
              value={approach}
              onChange={(e) => setApproach(e.target.value as SolderApproach)}
              aria-label={label}
            >
              {approachOpts.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          )}
          <button type="button" className="sp-bulk-apply" onClick={commit}>
            {t('solder.bulk.apply', 'Apply to {n}', { n: count })}
          </button>
        </div>
      )}
    </span>
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
  const approachOpts = useMemo(() => approachOptions(t), [t])
  // Live machine work-position + connection (for "Record position").
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const notify = useNotifications((s) => s.notify)
  const setSolderViz = useSolderViz((s) => s.set)
  const selectSolderViz = useSolderViz((s) => s.select)
  const clearSolderViz = useSolderViz((s) => s.clear)
  const setDetectedViz = useSolderViz((s) => s.setDetected)
  // Camera calibration + live video for vision pad-detection and the iron-touch
  // Z calibration (Phase 1/2). We use the PRIMARY camera slot (index 0), the
  // same slot the 3D overlay renders, so detected pads land where the operator
  // sees the live video pinned on the bed.
  const cameraSlot = useCameraCalib((s) => s.cameras[0])
  const liveVideo = useCameraLive((s) => s.videoEls[0])
  // Shared-program ownership (last writer wins): we claim it whenever we have
  // points, and yield (drop our section + 3D board) when another CAM panel claims.
  const programOwner = useProgramOwner((s) => s.owner)
  const claimOwner = useProgramOwner((s) => s.claim)
  const releaseOwner = useProgramOwner((s) => s.release)

  const [defaults, setDefaults] = usePersistentState<RowDefaults>('karmyogi.soldering.defaults', {
    freeZ: 5.0,
    touchZ: -1.0,
    feedSeconds: 0.5,
    type: SolderFeedType.TouchDown,
    approach: 'plunge',
  })

  const [points, setPoints] = useState<SolderPoint[]>([])
  const [selected, setSelected] = useState(-1)
  // True when the current points came from a DRILL file (the 3D PCB stand-in then
  // renders holes instead of surface pads). Set on import; manual edits keep it.
  const [fromDrill, setFromDrill] = useState(false)
  const [showSettings, setShowSettings] = usePersistentState<boolean>(
    'karmyogi.soldering.showSettings',
    false,
  )
  // Hidden <input type=file> trigger for "Load CSV".
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Hidden <input type=file> trigger for "Import from Gerber".
  const gerberInputRef = useRef<HTMLInputElement>(null)
  // When a ZIP holds several layers, hold the classified candidate layers here
  // and show a compact picker so the operator chooses the one that carries the
  // solder pads (best candidate — usually the paste layer — pre-highlighted).
  const [gerberLayers, setGerberLayers] = useState<SolderLayerCandidate[] | null>(null)

  // ── Camera pad-detection (Phase 1) review state ────────────────────────────
  // `detectedPads` holds the camera-detected candidate pads (bed-mm) awaiting the
  // operator's review; each can be ＋-added to the points list, or "Add all".
  const [detectedPads, setDetectedPads] = useState<MappedPad[]>([])
  const [detecting, setDetecting] = useState(false)
  // Min/max pad DIAMETER (mm) the detector keeps — exposed so the operator can
  // tune for their board (fine 0402 pads vs big through-hole pads).
  const [padMinMm, setPadMinMm] = usePersistentState<number>('karmyogi.soldering.padMinMm', 0.5)
  const [padMaxMm, setPadMaxMm] = usePersistentState<number>('karmyogi.soldering.padMaxMm', 5)
  // Detect dark pads on a light board (inverts the threshold polarity).
  const [padInvert, setPadInvert] = usePersistentState<boolean>('karmyogi.soldering.padInvert', false)

  // ── Iron-touch Z calibration (Phase 2) state ───────────────────────────────
  const [zCalBusy, setZCalBusy] = useState(false)
  const zCalAbortRef = useRef<AbortController | null>(null)

  // Global generator params (programName is fixed here; metric stays mm/G21).
  // Persisted so feeder/motion tuning survives a reload. The plain initial is
  // computed from the core defaults (usePersistentState reads localStorage first,
  // so this initial is only used when nothing was saved yet).
  const [params, setParams] = usePersistentState<SolderParams>('karmyogi.soldering.params', (() => {
    const d = defaultSolderingParams()
    return {
      safeZ: d.safeZ,
      feederRPM: d.feederRPM,
      plungeFeed: d.plungeFeed,
      settleSeconds: d.settleSeconds,
      // Clamp on load so an out-of-range value can never reach toFixed().
      decimals: clampDecimals(d.decimals),
    }
  })())

  // ---- color-coded setting PRESETS (feeder/motion + new-point defaults) -----
  // Snapshot the current feeder/motion + new-point defaults (NOT the points).
  const capturePreset = (): SolderingPreset => ({
    params: { ...params },
    defaults: { ...defaults },
  })
  // Restore a captured preset, coercing each field from the (untrusted)
  // persisted snapshot so a corrupt slot can never feed a NaN to the emitter.
  const applyPreset = (p: SolderingPreset) => {
    const pp = (p?.params ?? {}) as Record<string, unknown>
    setParams((prev) => ({
      safeZ: numOr(pp.safeZ, prev.safeZ),
      feederRPM: Math.max(0, numOr(pp.feederRPM, prev.feederRPM)),
      plungeFeed: Math.max(0, numOr(pp.plungeFeed, prev.plungeFeed)),
      settleSeconds: Math.max(0, numOr(pp.settleSeconds, prev.settleSeconds)),
      decimals: clampDecimals(numOr(pp.decimals, prev.decimals)),
    }))
    const pd = (p?.defaults ?? {}) as unknown as Record<string, unknown>
    setDefaults((prev) => ({
      freeZ: numOr(pd.freeZ, prev.freeZ),
      touchZ: numOr(pd.touchZ, prev.touchZ),
      feedSeconds: Math.max(0, numOr(pd.feedSeconds, prev.feedSeconds)),
      type: pd.type === SolderFeedType.PreSolder ? SolderFeedType.PreSolder : SolderFeedType.TouchDown,
      approach: parseApproach(typeof pd.approach === 'string' ? pd.approach : String(prev.approach)),
    }))
  }
  const presets = usePresets<SolderingPreset>({
    storageKey: 'karmyogi.soldering.presets',
    capture: capturePreset,
    onApply: applyPreset,
  })

  // Build a fresh point from the new-point defaults. X/Y (and the touch-down Z)
  // can be overridden — e.g. prefilled from the live machine position. When no
  // touch-down Z is supplied the default Touch-Z is kept.
  function newRow(x = 0, y = 0, touchZ = defaults.touchZ): SolderPoint {
    return defaultSolderPoint({
      x,
      y,
      freeZ: defaults.freeZ,
      touchZ,
      feedSeconds: defaults.feedSeconds,
      type: defaults.type,
      approach: defaults.approach,
    })
  }

  function addRow() {
    // Prefill X/Y from the LIVE machine work-position when connected so the new
    // point lands where the tip currently is (the operator jogs to the pad, then
    // clicks Add). Touch-Z / Free-Z come from the DEFAULTS (the board is flat — one
    // touch depth for all pads; the operator only positions X/Y per point). Edit a
    // row to override its Z. When disconnected, X/Y fall back to 0.
    const x = connected ? wpos.x : 0
    const y = connected ? wpos.y : 0
    // Compute the new index from the functional updater so it never reads a
    // stale `points` from this closure (which would select the wrong row).
    setPoints((p) => {
      setSelected(p.length)
      return [...p, newRow(x, y)]
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

  function updatePoint(i: number, patch: Partial<SolderPoint>) {
    setPoints((p) => p.map((pt, idx) => (idx === i ? { ...pt, ...patch } : pt)))
  }

  // Bulk "apply to all": set ONE field on EVERY existing point in one action, so
  // an operator who imported/recorded a long list doesn't have to retype the same
  // Touch-Z (etc.) row by row. This edits only the ALREADY-ADDED points; it does
  // NOT touch the new-point defaults above (those still drive freshly-added rows).
  // It flows through the same setPoints path as a manual edit, so the live G-code
  // + 3D regenerate exactly as they do for a single-row change.
  function applyToAll(patch: Partial<SolderPoint>) {
    setPoints((p) => p.map((pt) => ({ ...pt, ...patch })))
  }

  // Download the current point list as a CSV the operator can re-load later.
  function saveCsv() {
    const blob = new Blob([pointsToCsv(points)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'solder-points.csv'
    a.click()
    URL.revokeObjectURL(url)
    notify('success', t('solder.csv.saved', 'Saved {n} solder point(s) to CSV.', { n: points.length }))
  }

  // Read a CSV chosen from the local PC and REPLACE the current point list.
  // Confirms before discarding a non-empty list; toasts the imported count and
  // warns when the file held no usable rows.
  function loadCsvFile(file: File) {
    const reader = new FileReader()
    reader.onload = () => {
      const parsed = csvToPoints(String(reader.result ?? ''))
      if (parsed.length === 0) {
        notify('warn', t('solder.csv.empty', 'No usable solder points found in that CSV.'))
        return
      }
      if (
        points.length > 0 &&
        !window.confirm(
          t('solder.csv.replaceConfirm', 'Replace the current {n} point(s) with {m} from the CSV?', {
            n: points.length,
            m: parsed.length,
          }),
        )
      ) {
        return
      }
      setPoints(parsed)
      setFromDrill(false)
      setSelected(-1)
      notify('success', t('solder.csv.loaded', 'Loaded {n} solder point(s) from CSV.', { n: parsed.length }))
    }
    reader.readAsText(file)
  }

  // Turn the chosen layer (Gerber pad layer OR Excellon drill file) into
  // soldering points and merge them into the list. Each pad flash centre (or
  // drilled-hole centre) becomes a point built from the current new-point
  // defaults (Free-Z / Touch-Z / feed / approach), so the imported points are
  // individually editable exactly like manual ones and the operator zeros the
  // machine to the board origin then tweaks each as usual. When the list is
  // non-empty the operator chooses APPEND or REPLACE.
  function importPointsFromLayer(text: string, layerName: string, kind: SolderLayerKind) {
    const res = extractSolderPoints(text, kind, clampDecimals(params.decimals))
    if (!res.ok || res.points.length === 0) {
      notify(
        'warn',
        kind === 'drill'
          ? t('solder.gerber.noHoles', 'No drilled holes found in {layer}.', { layer: layerName })
          : t(
              'solder.gerber.noPads',
              'No pads found on {layer}. Pick the paste, copper or drill layer.',
              { layer: layerName },
            ),
      )
      return
    }
    const imported = res.points.map((p) => newRow(p.x, p.y))
    // Offer REPLACE vs APPEND only when there is existing work to preserve.
    let replace = false
    if (points.length > 0) {
      replace = window.confirm(
        t(
          'solder.gerber.replaceConfirm',
          'Replace the current {n} point(s) with {m} from {layer}? Cancel to append instead.',
          { n: points.length, m: imported.length, layer: layerName },
        ),
      )
    }
    // Order the resulting list for least free travel (the iron visits adjacent
    // pads in sequence instead of darting across the board and back). Imported
    // pad/hole order follows the Gerber/Excellon file, which is rarely
    // travel-efficient; optimizing here means a freshly imported board streams an
    // efficient path immediately.
    setPoints((p) => orderSolderPointsForTravel(replace ? imported : [...p, ...imported]))
    // Render holes (vs surface pads) in the 3D stand-in when this came from drill.
    setFromDrill(kind === 'drill')
    setSelected(-1)
    notify(
      'success',
      t('solder.gerber.imported', 'Imported {n} point(s) from {layer} (travel-optimized).', {
        n: imported.length,
        layer: layerName,
      }),
    )
  }

  // Read a chosen file. A ZIP is unzipped, every entry classified for soldering
  // (paste / copper / drill / other) and — when it holds more than one layer —
  // surfaced in the layer picker with the best candidate (usually the paste
  // layer) pre-highlighted. A single file is imported directly.
  function loadGerberFile(file: File) {
    setGerberLayers(null)
    if (/\.zip$/i.test(file.name)) {
      file
        .arrayBuffer()
        .then((buf) => {
          let cands: SolderLayerCandidate[]
          try {
            cands = classifySolderCandidates(unzipGerberPackage(new Uint8Array(buf)))
          } catch (err) {
            notify(
              'warn',
              err instanceof GerberPackageError
                ? err.message
                : t('solder.gerber.zipError', 'Could not read ZIP: {detail}', {
                    detail: err instanceof Error ? err.message : String(err),
                  }),
            )
            return
          }
          if (cands.length === 1) {
            importPointsFromLayer(cands[0].entry.text, cands[0].entry.name, cands[0].kind)
          } else {
            setGerberLayers(cands)
          }
        })
        .catch((err) =>
          notify('warn', t('solder.gerber.zipError', 'Could not read ZIP: {detail}', {
            detail: err instanceof Error ? err.message : String(err),
          })),
        )
      return
    }
    // Single Gerber / drill text file — classify by name so a lone .DRL is read
    // as Excellon and a lone .gbr/.gtp as Gerber.
    file
      .text()
      .then((text) => importPointsFromLayer(text, file.name, classifySolderCandidates([
        { name: file.name, text, role: 'Unknown', size: text.length },
      ])[0].kind))
      .catch((err) =>
        notify('warn', t('solder.gerber.readError', 'Could not read file: {detail}', {
          detail: err instanceof Error ? err.message : String(err),
        })),
      )
  }

  // Friendly localised role label for a solder-layer candidate kind.
  function solderKindLabel(kind: SolderLayerKind): string {
    switch (kind) {
      case 'paste':
        return t('solder.kind.paste', 'Paste (pads)')
      case 'copper-top':
        return t('solder.kind.copperTop', 'Top Copper')
      case 'copper-bottom':
        return t('solder.kind.copperBottom', 'Bottom Copper')
      case 'drill':
        return t('solder.kind.drill', 'Drill (holes)')
      default:
        return t('solder.kind.other', 'Other')
    }
  }

  // Reorder the current points for least free (XY) travel — nearest-neighbour +
  // 2-opt (see orderSolderPointsForTravel). Lets the operator re-optimize after
  // adding/editing points manually (imports are auto-optimized on load).
  function optimizeOrder() {
    if (points.length < 3) return
    const before = solderTravelDistance(points, { x: 0, y: 0 })
    const ordered = orderSolderPointsForTravel(points)
    const after = solderTravelDistance(ordered, { x: 0, y: 0 })
    setPoints(ordered)
    setSelected(-1)
    const saved = Math.max(0, before - after)
    notify(
      'success',
      t('solder.optimized', 'Reordered {n} points — travel {after} mm (saved {saved} mm).', {
        n: points.length,
        after: after.toFixed(0),
        saved: saved.toFixed(0),
      }),
    )
  }

  // Clear all points (confirm first when non-empty), and drop the synced section
  // so the Visualizer / Program tab don't keep showing a stale toolpath.
  function clearAll() {
    if (points.length === 0) return
    if (!window.confirm(t('solder.clearConfirm', 'Remove all {n} solder point(s)?', { n: points.length })))
      return
    setPoints([])
    setSelected(-1)
  }

  // Record the live machine work-position. If a row is selected, fill its X/Y;
  // otherwise append a new row at that position.
  function recordPosition() {
    if (!connected) return
    // ALWAYS append a new point per press (live X/Y) and select it. Touch-Z /
    // Free-Z come from the DEFAULTS, NOT the live head Z — the head's Z while
    // jogging X/Y isn't the touch depth, and the operator sets one default
    // Touch-Z for the flat board. Edit a row to override its Z. Record = "teach a
    // new point"; repeated presses build the list (it no longer overwrites).
    setPoints((p) => {
      setSelected(p.length)
      return [...p, newRow(wpos.x, wpos.y)]
    })
  }

  // ── Camera pad-detection (Phase 1) ─────────────────────────────────────────
  // Grab the current PRIMARY-camera frame, run the pure pad detector, map each
  // detected pad's pixel centroid to bed-mm via the camera calibration, and show
  // the result as a reviewable list (each ＋-addable, plus "Add all"). The camera
  // must be calibrated (a fixed-mount homography, or a head-mount map) so pixels
  // map to bed-mm — otherwise we can't place the pads. Z for every added point
  // comes from the new-point default Touch-Z (the board is flat; the Z-datum / the
  // iron-touch calibration sets the actual zero).
  function detectPads() {
    if (detecting) return
    setDetecting(true)
    // Run on a microtask so the "detecting…" state paints first (detection is a
    // synchronous full-frame scan — a few ms at typical webcam resolutions).
    setTimeout(() => {
      try {
        const out = detectPadsFromVideo(
          liveVideo,
          cameraSlot,
          { x: wpos.x, y: wpos.y },
          { minPadMm: Math.max(0, padMinMm), maxPadMm: Math.max(padMinMm, padMaxMm), invert: padInvert },
        )
        if (!out.ok) {
          const msg =
            out.reason === 'no-video'
              ? t('solder.detect.noVideo', 'No live camera. Open a camera in the Camera tab first.')
              : out.reason === 'tainted'
                ? t('solder.detect.tainted', 'Camera frame is not readable (cross-origin). Re-open the camera.')
                : out.reason === 'not-calibrated'
                  ? t('solder.detect.notCalibrated', 'Camera is not calibrated. Calibrate the camera (Camera tab) so pixels map to bed mm.')
                  : out.reason === 'no-pads'
                    ? t('solder.detect.noPads', 'No pads detected. Adjust the pad-size range or the bright/dark setting and retry.')
                    : t('solder.detect.noFrame', 'Could not grab a camera frame. Make sure the camera is live.')
          notify('warn', msg)
          setDetectedPads([])
          setDetectedViz([])
          return
        }
        setDetectedPads(out.pads)
        setDetectedViz(out.pads.map((p) => ({ x: p.x, y: p.y, rMm: p.rMm })))
        notify('success', t('solder.detect.found', 'Detected {n} candidate pad(s). Review and ＋-add them below.', { n: out.pads.length }))
      } finally {
        setDetecting(false)
      }
    }, 0)
  }

  // Add ONE detected pad to the soldering points (using the new-point defaults
  // for Z/feed/approach), and drop it from the review list.
  function addDetectedPad(i: number) {
    const pad = detectedPads[i]
    if (!pad) return
    setPoints((p) => [...p, newRow(pad.x, pad.y)])
    setDetectedPads((d) => {
      const next = d.filter((_, idx) => idx !== i)
      setDetectedViz(next.map((q) => ({ x: q.x, y: q.y, rMm: q.rMm })))
      return next
    })
  }

  // Add EVERY detected pad as a solder point, then clear the review list. The
  // resulting list is travel-optimized so a freshly detected board streams an
  // efficient path immediately (same treatment as a Gerber import).
  function addAllDetectedPads() {
    if (detectedPads.length === 0) return
    const added = detectedPads.map((pad) => newRow(pad.x, pad.y))
    setPoints((p) => orderSolderPointsForTravel([...p, ...added]))
    setFromDrill(false)
    setSelected(-1)
    notify('success', t('solder.detect.addedAll', 'Added {n} detected pad(s) (travel-optimized).', { n: added.length }))
    setDetectedPads([])
    setDetectedViz([])
  }

  // Dismiss the detected-pad review list without adding any.
  function clearDetectedPads() {
    setDetectedPads([])
    setDetectedViz([])
  }

  // ── Iron-touch Z calibration (Phase 2) ─────────────────────────────────────
  // ⚠️ NEEDS LIVE-HARDWARE VERIFICATION (see ironTouchZ.ts). Steps Z DOWN in
  // small increments; after each step it compares the camera frame to the last
  // one. While the spring-loaded iron tip is descending freely the frame keeps
  // changing; the instant the tip touches the board it stops moving (gantry keeps
  // going) — when the inter-frame motion drops below the threshold for a couple
  // of steps we STOP and set work Z0 there. Strictly gated on a connected machine
  // + a live camera; aborts safely if no contact within the travel limit.
  function calibrateZByIronTouch() {
    if (zCalBusy) {
      // A second press cancels an in-progress calibration.
      zCalAbortRef.current?.abort()
      return
    }
    if (!grbl.isConnected) {
      notify('warn', t('solder.zcal.notConnected', 'Connect to a machine before calibrating Z.'))
      return
    }
    if (!liveVideo) {
      notify('warn', t('solder.zcal.noCamera', 'Open a live camera (Camera tab) so the tip motion can be seen.'))
      return
    }
    const ac = new AbortController()
    zCalAbortRef.current = ac
    setZCalBusy(true)
    void runIronTouchZ(
      {
        jogDownZ: (step) => grbl.jog({ z: -Math.abs(step), feed: 60 }, { force: false }),
        grabGray: () => videoToGray(liveVideo),
        setWorkZeroZ: () => grbl.send('G10 L20 P0 Z0'),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        signal: ac.signal,
        jogCancel: () => grbl.jogCancel(),
      },
      { stepMm: 0.1, maxTravelMm: 8, settleMs: 220 },
    )
      .then((res) => {
        if (res.ok) {
          notify('success', t('solder.zcal.done', 'Iron touched the board after {mm} mm — work Z zeroed.', { mm: res.travelMm.toFixed(2) }))
        } else if (res.reason === 'no-contact') {
          notify('warn', t('solder.zcal.noContact', 'No contact detected within {mm} mm — aborted (no Z change). Lower the start height or tune the motion threshold.', { mm: res.travelMm.toFixed(1) }))
        } else if (res.reason === 'aborted') {
          notify('info', t('solder.zcal.aborted', 'Z calibration cancelled.'))
        } else if (res.reason === 'no-frame') {
          notify('warn', t('solder.zcal.noFrame', 'Lost the camera frame during calibration — aborted.'))
        } else {
          notify('warn', t('solder.zcal.failed', 'Z calibration failed to set zero — aborted.'))
        }
      })
      .catch((err) => {
        notify('warn', t('solder.zcal.error', 'Z calibration error: {detail}', { detail: err instanceof Error ? err.message : String(err) }))
      })
      .finally(() => {
        setZCalBusy(false)
        zCalAbortRef.current = null
      })
  }

  // Live G-code preview, recomputed whenever points/params change. The core
  // clamps decimals internally, but we also clamp here so the preview + the
  // estimate share one safe value. Times/feeds are clamped >= 0 so a typed
  // negative never produces an inverted dwell or backwards feed.
  const safeParams = useMemo(
    () => ({
      ...params,
      decimals: clampDecimals(params.decimals),
      plungeFeed: Math.max(0, params.plungeFeed),
      settleSeconds: Math.max(0, params.settleSeconds),
    }),
    [params],
  )
  const safePoints = useMemo(
    () => points.map((p) => ({ ...p, feedSeconds: Math.max(0, p.feedSeconds) })),
    [points],
  )
  // Per-point breakdown: `combined` is byte-identical to the old flat
  // generateSoldering output (streamed unchanged); `segments` is the per-point
  // structure the Program tab renders as an expandable op list (like carving).
  const breakdown = useMemo(
    () => generateSolderingSegments(safePoints, safeParams),
    [safePoints, safeParams],
  )
  const gcode = breakdown.combined
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  // ProgramOperation[] for the shared Program tab: one entry PER POINT, keyed by
  // the segment's stable id (matches the same-ordered solder point / 3D point),
  // labelled "Point N · (x, y)" in the panel's metric formatting, tinted the
  // soldering accent so the Visualizer can colour its slice. Purely additive —
  // the streamed `combined` is unchanged whether or not these are passed.
  const operations = useMemo(() => {
    const dp = clampDecimals(params.decimals)
    return breakdown.segments.map((seg, i) => {
      const pt = safePoints[i]
      return {
        id: seg.pointId,
        label: t('solder.op.point', 'Point {n} · ({x}, {y})', {
          n: i + 1,
          x: pt ? pt.x.toFixed(dp) : '0',
          y: pt ? pt.y.toFixed(dp) : '0',
        }),
        gcode: seg.gcode,
        color: SOLDER_OP_COLOR,
      }
    })
  }, [breakdown, safePoints, params.decimals, t])
  const estSeconds = useMemo(
    () => estimateSolderingSeconds(safePoints, safeParams),
    [safePoints, safeParams],
  )
  // Live free-travel distance over the current order (from the work origin) —
  // the figure the Optimize button shrinks. Shown so the operator can see the
  // effect of reordering at a glance.
  const travelMm = useMemo(() => solderTravelDistance(points, { x: 0, y: 0 }), [points])

  // Warn when a point's Touch-Z is at or above its Free-Z: the tip would never
  // descend to make contact (an inverted/degenerate move). Lists the 1-based
  // point indices so the operator can fix them.
  const invertedPoints = useMemo(
    () => points.map((p, i) => (p.touchZ >= p.freeZ ? i + 1 : -1)).filter((i) => i > 0),
    [points],
  )

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer + Program tab pick it up without a manual Generate step.
  // When the list is emptied (Clear-all), DROP the section instead of leaving a
  // stale toolpath in the Visualizer / Program tab.
  useEffect(() => {
    if (points.length === 0) {
      removeSection('soldering')
      releaseOwner('soldering')
      return
    }
    // We have points → CLAIM ownership (last writer wins) and publish the program
    // WITH its per-point breakdown (operations) so the Program tab can expand each
    // point's own G-code (like carving). `gcode` is byte-identical to the old flat
    // output, so streaming is unchanged — operations are additive display metadata.
    claimOwner('soldering')
    const id = window.setTimeout(() => setProgram('soldering', gcode, { operations }), 300)
    return () => window.clearTimeout(id)
  }, [gcode, operations, points.length, setProgram, removeSection, claimOwner, releaseOwner])

  // Publish the points to the 3D PCB stand-in (board + pads/holes). The yield
  // effect below clears it when another panel takes over; this re-publishes when
  // our points change. Cleared on unmount.
  useEffect(() => {
    if (points.length === 0) {
      clearSolderViz()
      return
    }
    setSolderViz(
      points.map((p) => ({ x: p.x, y: p.y, freeZ: p.freeZ, touchZ: p.touchZ })),
      fromDrill,
    )
    return () => clearSolderViz()
  }, [points, fromDrill, setSolderViz, clearSolderViz])

  // Yield: when ANOTHER CAM panel claims the program, drop our section + board so
  // they never bleed over its job. (No-op while we're the owner.)
  useEffect(() => {
    if (programOwner && programOwner !== 'soldering') {
      removeSection('soldering')
      clearSolderViz()
    }
  }, [programOwner, removeSection, clearSolderViz])

  // Mirror the selected row to the Viewer so the highlight cone parks over it.
  useEffect(() => {
    selectSolderViz(selected)
  }, [selected, selectSolderViz])

  // On unmount: clear the detected-pad markers from the Viewer and abort any
  // in-flight iron-touch Z calibration so it can't keep jogging after the panel
  // is gone.
  useEffect(() => {
    return () => {
      setDetectedViz([])
      zCalAbortRef.current?.abort()
    }
  }, [setDetectedViz])

  // ── Gamepad command bus: teach a point, navigate / delete points, optimize. ──
  // addPoint records the live machine position (or appends a default row); next/
  // prev walk the list with wrap; delete removes the selected row. All guarded.
  const stepSel = (dir: -1 | 1) => {
    if (points.length === 0) return
    const base = selected < 0 ? (dir === 1 ? -1 : 0) : selected
    setSelected((base + dir + points.length) % points.length)
  }
  useTabCommands('soldering', {
    addPoint: () => recordPosition(),
    nextPoint: () => stepSel(1),
    prevPoint: () => stepSel(-1),
    deletePoint: () => {
      if (selected >= 0 && selected < points.length) deleteRow(selected)
    },
    optimize: () => optimizeOrder(),
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('solder.presets.aria', 'Soldering setting presets')}
      />
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
            glyph={<Icon name="add" />}
            onClick={addRow}
            title={t('solder.toolbar.add', 'Add point')}
            body={t('solder.toolbar.add.body', 'Append a soldering point prefilled from the defaults in Settings.')}
          />
          <ToolButton
            glyph={<Icon name="probe" />}
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
            glyph={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="5" cy="6" r="2" />
                <circle cx="19" cy="9" r="2" />
                <circle cx="8" cy="18" r="2" />
                <path d="M7 6h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6" />
              </svg>
            }
            onClick={optimizeOrder}
            disabled={points.length < 3}
            title={t('solder.toolbar.optimize', 'Optimize travel order')}
            body={t('solder.toolbar.optimize.body', 'Reorder the points to minimize free travel between pads (nearest-neighbour + 2-opt) so the iron does not dart across the board and back.')}
          />
          <span className="sp-tools-sep" aria-hidden="true" />
          <ToolButton
            glyph={<Icon name="download" />}
            onClick={saveCsv}
            disabled={points.length === 0}
            title={t('solder.toolbar.saveCsv', 'Save CSV')}
            body={t('solder.toolbar.saveCsv.body', 'Download the current solder-point list as a CSV file you can re-load later.')}
          />
          <ToolButton
            glyph={<Icon name="upload" />}
            onClick={() => fileInputRef.current?.click()}
            title={t('solder.toolbar.loadCsv', 'Load CSV')}
            body={t('solder.toolbar.loadCsv.body', 'Load a solder-point list from a CSV file on your PC (replaces the current list).')}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadCsvFile(f)
              e.target.value = '' // allow re-loading the same file
            }}
          />
          <ToolButton
            glyph={
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" strokeWidth="1.3" />
                <circle cx="5.5" cy="5.5" r="1.2" fill="currentColor" />
                <circle cx="10.5" cy="5.5" r="1.2" fill="currentColor" />
                <circle cx="5.5" cy="10.5" r="1.2" fill="currentColor" />
                <circle cx="10.5" cy="10.5" r="1.2" fill="currentColor" />
              </svg>
            }
            onClick={() => gerberInputRef.current?.click()}
            title={t('solder.toolbar.gerber', 'Import from Gerber')}
            body={t('solder.toolbar.gerber.body', 'Turn the pads on a Gerber layer (or a Gerber ZIP — pick the layer) into solder points; then zero the machine and tweak each point.')}
          />
          <input
            ref={gerberInputRef}
            type="file"
            accept=".zip,.gbr,.ger,.gtl,.gbl,.gtp,.gbp,.gts,.gbs,.art,.drl,.xln,.drd,.exc,.nc,.tap,.txt"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) loadGerberFile(f)
              e.target.value = '' // allow re-loading the same file
            }}
          />
          <span className="sp-tools-sep" aria-hidden="true" />
          {/* Phase 1: detect pads from the live camera frame. */}
          <ToolButton
            className={detecting ? 'is-active' : ''}
            glyph={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M2 7V5a2 2 0 0 1 2-2h2" />
                <path d="M18 3h2a2 2 0 0 1 2 2v2" />
                <path d="M22 17v2a2 2 0 0 1-2 2h-2" />
                <path d="M6 21H4a2 2 0 0 1-2-2v-2" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            }
            onClick={detectPads}
            disabled={detecting}
            title={t('solder.toolbar.detect', 'Detect pads (camera)')}
            body={t('solder.toolbar.detect.body', 'Find solder pads in the live camera frame and list them as candidates you can ＋-add (needs a calibrated camera open in the Camera tab).')}
          />
          {/* Phase 2: vision iron-touch Z zero. */}
          <ToolButton
            className={zCalBusy ? 'is-active' : ''}
            glyph={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 2v9" />
                <path d="m8 7 4 4 4-4" />
                <path d="M4 15h16" />
                <path d="M4 19h16" />
              </svg>
            }
            onClick={calibrateZByIronTouch}
            disabled={!connected || !liveVideo}
            title={zCalBusy ? t('solder.toolbar.zcal.cancel', 'Cancel Z calibration') : t('solder.toolbar.zcal', 'Calibrate Z (iron touch)')}
            body={t('solder.toolbar.zcal.body', 'Step Z down until the camera sees the spring-loaded iron tip stop moving (it touched the board), then set work Z0 there. Needs a connected machine + a live camera. Click again to cancel.')}
          />
          <span className="sp-tools-sep" aria-hidden="true" />
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('solder.toolbar.settings', 'Settings')}
            body={t('solder.toolbar.settings.body', 'New-point defaults plus feeder and motion parameters (Safe-Z, feeder S, plunge feed, dwell).')}
          />
          {/* Destructive Clear sits LAST, isolated behind its own separator, so
              it never sits next to a benign action (W-H / §2.3). */}
          <span className="sp-tools-sep" aria-hidden="true" />
          <ToolButton
            className="sp-ico-danger"
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={points.length === 0}
            title={t('solder.toolbar.clear', 'Clear all')}
            body={t('solder.toolbar.clear.body', 'Remove every soldering point and start over.')}
          />
        </div>
      </header>

      {/* Gerber layer picker — shown only while a multi-layer ZIP awaits a choice.
          The operator picks the layer carrying the solder pads (paste / top
          copper); on Import each pad flash centre becomes a soldering point. */}
      {gerberLayers && (
        <div className="sp-card sp-gerber-pick">
          <div className="sp-card-head">
            <h4>{t('solder.gerber.pickTitle', 'Choose the pad layer')}</h4>
            <button
              className="sp-row-ico"
              title={t('solder.gerber.cancel', 'Cancel')}
              aria-label={t('solder.gerber.cancel', 'Cancel')}
              onClick={() => setGerberLayers(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <p className="sp-gerber-hint">
            {t(
              'solder.gerber.pickHint',
              'Pick the layer with the solder pads (usually the paste layer, else top copper, else the PTH drill). Each pad / hole becomes one solder point.',
            )}
          </p>
          <div className="sp-gerber-layers">
            {gerberLayers.map((c, i) => (
              <button
                key={c.entry.name}
                type="button"
                className={`sp-gerber-layer${i === 0 ? ' is-suggested' : ''}`}
                onClick={() => {
                  setGerberLayers(null)
                  importPointsFromLayer(c.entry.text, c.entry.name, c.kind)
                }}
                title={t('solder.gerber.layerTitle', '{name} — {role}', {
                  name: c.entry.name,
                  role: solderKindLabel(c.kind),
                })}
              >
                <span className="sp-gerber-layer-name">
                  {c.entry.name}
                  {i === 0 && (
                    <span className="sp-gerber-suggested">
                      {t('solder.gerber.suggested', '(suggested)')}
                    </span>
                  )}
                </span>
                <span className="sp-gerber-layer-role">{solderKindLabel(c.kind)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Camera-detected pads (Phase 1): a reviewable list. Each row ＋-adds the
          pad as a solder point (using the new-point defaults for Z/feed); "Add
          all" adds every one and travel-optimizes. Detection tunables (pad size
          range + bright/dark) live in the header here so the operator can adjust
          and re-detect without opening Settings. */}
      {detectedPads.length > 0 && (
        <div className="sp-card sp-detected">
          <div className="sp-card-head">
            <h4>{t('solder.detect.title', 'Detected pads')}</h4>
            <span className="sp-card-count">{detectedPads.length}</span>
            <div className="sp-detect-actions">
              <button
                type="button"
                className="sp-detect-addall"
                onClick={addAllDetectedPads}
                title={t('solder.detect.addAll.title', 'Add every detected pad as a solder point (travel-optimized)')}
              >
                {t('solder.detect.addAll', 'Add all {n}', { n: detectedPads.length })}
              </button>
              <button
                className="sp-row-ico"
                title={t('solder.detect.dismiss', 'Dismiss detected pads')}
                aria-label={t('solder.detect.dismiss', 'Dismiss detected pads')}
                onClick={clearDetectedPads}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          </div>
          <div className="sp-detect-tune" onClick={(e) => e.stopPropagation()}>
            <label className="sp-detect-tune-field">
              <span>{t('solder.detect.minMm', 'Min ⌀')}</span>
              <input
                type="number"
                step="0.1"
                min="0"
                value={padMinMm}
                onChange={(e) => setPadMinMm(Math.max(0, num(e.target.value, padMinMm)))}
              />
              <span className="sp-detect-unit">{t('unit.mm', 'mm')}</span>
            </label>
            <label className="sp-detect-tune-field">
              <span>{t('solder.detect.maxMm', 'Max ⌀')}</span>
              <input
                type="number"
                step="0.5"
                min="0"
                value={padMaxMm}
                onChange={(e) => setPadMaxMm(Math.max(0, num(e.target.value, padMaxMm)))}
              />
              <span className="sp-detect-unit">{t('unit.mm', 'mm')}</span>
            </label>
            <label className="sp-detect-tune-invert">
              <input
                type="checkbox"
                checked={padInvert}
                onChange={(e) => setPadInvert(e.target.checked)}
              />
              {t('solder.detect.darkPads', 'Dark pads')}
            </label>
            <button type="button" className="sp-detect-redo" onClick={detectPads} disabled={detecting}>
              {t('solder.detect.redo', 'Re-detect')}
            </button>
          </div>
          <div className="sp-detect-list">
            {detectedPads.map((p, i) => (
              <div key={`${p.xPx},${p.yPx},${i}`} className="sp-detect-item">
                <button
                  type="button"
                  className="sp-detect-add"
                  onClick={() => addDetectedPad(i)}
                  title={t('solder.detect.add.title', 'Add this pad as a solder point')}
                  aria-label={t('solder.detect.add', 'Add pad {n}', { n: i + 1 })}
                >
                  <span aria-hidden="true">＋</span>
                </button>
                <span className="sp-detect-xy">
                  X {p.x.toFixed(2)} · Y {p.y.toFixed(2)}
                  {p.rMm > 0 && (
                    <span className="sp-detect-r"> · ⌀ {(p.rMm * 2).toFixed(2)} {t('unit.mm', 'mm')}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live status strip: point + line counts, auto-synced to the Program tab.
          Uses the shared <CamStatus> kit so it reads identically to every tab. */}
      <div className="sp-status">
        <CamStatus
          items={[
            { value: points.length, unit: t('solder.status.points', 'points') },
            { value: lineCount, unit: t('solder.status.lines', 'G-code lines') },
            {
              value: travelMm.toFixed(0),
              unit: t('solder.status.travel', 'mm travel'),
              title: t('solder.status.travel.title', 'Total free (XY) travel between points in the current order, from the work origin. Use Optimize travel order to shrink it.'),
            },
            {
              value: fmtDuration(estSeconds, t),
              unit: t('solder.status.est', 'est.'),
              title: t('solder.status.est.title', 'Estimated cycle time (plunge + feeder + settle dwells; travel ignored)'),
            },
          ]}
        />
      </div>

      {invertedPoints.length > 0 && (
        <p className="sp-warn">
          {t(
            'solder.warn.inverted',
            'Touch-Z ≥ Free-Z on point(s) {list} — the tip will not descend to make contact. Lower Touch-Z below Free-Z.',
            { list: invertedPoints.join(', ') },
          )}
        </p>
      )}

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
                unit={t('unit.mm', 'mm')}
                min={0}
                max={30}
                step={0.5}
                value={defaults.freeZ}
                onChange={(n) => setDefaults((d) => ({ ...d, freeZ: n }))}
                info={{
                  title: t('solder.field.freeZ', 'Free-Z'),
                  body: t('solder.field.freeZ.body', 'Travel height the tip lifts to between points.'),
                }}
              />
              <NumField
                label={t('solder.field.touchZ', 'Touch-Z')}
                unit={t('unit.mm', 'mm')}
                min={-10}
                max={10}
                step={0.1}
                value={defaults.touchZ}
                onChange={(n) => setDefaults((d) => ({ ...d, touchZ: n }))}
                info={{
                  title: t('solder.field.touchZ', 'Touch-Z'),
                  body: t('solder.field.touchZ.body', 'Depth the tip touches down to at each point.'),
                }}
              />
              <NumField
                label={t('solder.field.feed', 'Feed')}
                unit={t('unit.s', 's')}
                min={0}
                max={5}
                step={0.1}
                value={defaults.feedSeconds}
                onChange={(n) => setDefaults((d) => ({ ...d, feedSeconds: Math.max(0, n) }))}
                info={{
                  title: t('solder.field.feed', 'Feed'),
                  body: t('solder.field.feed.body', 'How long the wire feeder runs at each point (seconds).'),
                }}
              />
              <SegField<SolderFeedType>
                label={t('solder.field.feedType', 'Feed type')}
                value={defaults.type}
                options={[
                  { value: SolderFeedType.PreSolder, label: t('solder.feedType.preSolder', 'pre-solder') },
                  { value: SolderFeedType.TouchDown, label: t('solder.feedType.touchDown', 'touch-down') },
                ]}
                onChange={(v) => setDefaults((d) => ({ ...d, type: v }))}
                info={{
                  title: t('solder.field.feedType', 'Feed type'),
                  body: t('solder.field.feedType.body', 'Pre-solder feeds wire before touch-down; touch-down feeds while the tip is down.'),
                }}
              />
              <div className="sp-segfield">
                <span className="sp-sfield-lbl">
                  <span className="sp-sfield-txt">{t('solder.field.approach', 'Approach')}</span>
                  <InfoTip
                    topic="solderApproach"
                    title={t('solder.field.approach', 'Approach')}
                    body={t('solder.field.approach.body', 'Plunge descends straight down onto the pad; the four 45° options approach (and retract) along a 45° angle from the named side — front (−Y), right (+X), left (−X) or back (+Y).')}
                  />
                </span>
                <select
                  className="sp-seg-select"
                  value={defaults.approach}
                  onChange={(e) => setDefaults((d) => ({ ...d, approach: e.target.value as SolderApproach }))}
                >
                  {approachOpts.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
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
                unit={t('unit.mm', 'mm')}
                min={0}
                max={50}
                step={0.5}
                value={params.safeZ}
                onChange={(n) => setParams((p) => ({ ...p, safeZ: n }))}
                info={{
                  title: t('solder.field.safeZ', 'Safe-Z'),
                  body: t('solder.field.safeZ.body', 'Guaranteed retract height before any XY travel and at program end.'),
                }}
              />
              <NumField
                label={t('solder.field.feederS', 'Feeder')}
                unit={t('unit.sWord', 'S')}
                min={0}
                max={2000}
                step={100}
                value={params.feederRPM}
                onChange={(n) => setParams((p) => ({ ...p, feederRPM: Math.max(0, n) }))}
                info={{
                  title: t('solder.field.feederS', 'Feeder'),
                  body: t('solder.field.feederS.body', 'Spindle speed word (S) that drives the solder-wire feeder.'),
                }}
              />
              <NumField
                label={t('solder.field.plungeF', 'Plunge')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={0}
                max={1000}
                step={10}
                value={params.plungeFeed}
                onChange={(n) => setParams((p) => ({ ...p, plungeFeed: Math.max(0, n) }))}
                info={{
                  title: t('solder.field.plungeF', 'Plunge'),
                  body: t('solder.field.plungeF.body', 'Feed rate used to lower the tip from Free-Z to Touch-Z.'),
                }}
              />
              <NumField
                label={t('solder.field.settle', 'Settle')}
                unit={t('unit.s', 's')}
                min={0}
                max={5}
                step={0.1}
                value={params.settleSeconds}
                onChange={(n) => setParams((p) => ({ ...p, settleSeconds: Math.max(0, n) }))}
                info={{
                  title: t('solder.field.settle', 'Settle'),
                  body: t('solder.field.settle.body', 'Dwell after each touch-down so the joint settles before lifting.'),
                }}
              />
              <NumField
                label={t('solder.field.decimals', 'Decimals')}
                min={0}
                max={6}
                step={1}
                value={params.decimals}
                parse={(v, fb) => clampDecimals(intNum(v, fb))}
                onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                info={{
                  title: t('solder.field.decimals', 'Decimals'),
                  body: t('solder.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).'),
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
          {/* Auto-optimize: reorder the rows (moves points up/down) to minimize the
              free travel between them — for points added/edited manually. Shows the
              current travel so the operator sees it shrink. */}
          <button
            type="button"
            className="sp-optimize-btn"
            onClick={optimizeOrder}
            disabled={points.length < 3}
            title={t(
              'solder.points.optimize.title',
              'Reorder the points to minimize free travel between pads (nearest-neighbour + 2-opt). Use after adding points manually.',
            )}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="5" cy="6" r="2" />
              <circle cx="19" cy="9" r="2" />
              <circle cx="8" cy="18" r="2" />
              <path d="M7 6h6a3 3 0 0 1 0 6H9a3 3 0 0 0 0 6" />
            </svg>
            <span>{t('solder.points.optimize', 'Optimize order')}</span>
            {points.length >= 2 && (
              <span className="sp-optimize-travel">{travelMm.toFixed(0)} mm</span>
            )}
          </button>
        </div>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th className="sp-idx">{t('solder.table.num', '#')}</th>
                <th>{t('solder.table.x', 'X')}</th>
                <th>{t('solder.table.y', 'Y')}</th>
                <th>
                  <span className="sp-th">
                    <span className="sp-th-txt">{t('solder.table.freeZ', 'Free-Z')}</span>
                    <ColumnBulkEdit field="freeZ" label={t('solder.table.freeZ', 'Free-Z')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.mm', 'mm')} />
                  </span>
                </th>
                <th>
                  <span className="sp-th">
                    <span className="sp-th-txt">{t('solder.table.touchZ', 'Touch-Z')}</span>
                    <ColumnBulkEdit field="touchZ" label={t('solder.table.touchZ', 'Touch-Z')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.mm', 'mm')} />
                  </span>
                </th>
                <th>
                  <span className="sp-th">
                    <span className="sp-th-txt">{t('solder.table.feedType', 'Type')}</span>
                    <ColumnBulkEdit field="type" label={t('solder.table.feedType', 'Type')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} />
                  </span>
                </th>
                <th>
                  <span className="sp-th">
                    <span className="sp-th-txt">{t('solder.table.approach', 'Approach')}</span>
                    <ColumnBulkEdit field="approach" label={t('solder.table.approach', 'Approach')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} />
                  </span>
                </th>
                <th>
                  <span className="sp-th">
                    <span className="sp-th-txt">{t('solder.table.feedS', 'Feed s')}</span>
                    <ColumnBulkEdit field="feedSeconds" label={t('solder.table.feedS', 'Feed s')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.s', 's')} />
                  </span>
                </th>
                <th className="sp-actions-col" aria-label={t('solder.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <CamEmpty
                      icon={<Icon name="add" size={22} />}
                      title={t('solder.empty.title', 'No solder points yet')}
                      hint={t(
                        'solder.empty.hint',
                        'Add a point, or jog the machine and record its position.',
                      )}
                      action={
                        <button type="button" className="cam-primary" onClick={addRow}>
                          <Icon name="add" size={15} /> {t('solder.toolbar.add', 'Add point')}
                        </button>
                      }
                    />
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
                  <td data-label={t('solder.table.x', 'X')}>
                    <input
                      type="number"
                      step="0.1"
                      value={pt.x}
                      onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    />
                  </td>
                  <td data-label={t('solder.table.y', 'Y')}>
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
                  <td data-label={t('solder.table.approach', 'Approach')}>
                    <select
                      value={pt.approach}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => updatePoint(i, { approach: e.target.value as SolderApproach })}
                    >
                      {approachOpts.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
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
                      <Icon name="close" size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Narrow PANEL: each point becomes a compact card — tight 3-char fields
            for X/Y/Free-Z/Touch-Z/Feed in a masonry grid, and radio buttons for
            the feed type so the choice is readable at a glance. Hidden on wide
            panels (the table above is shown instead) — toggled purely in CSS. */}
        <div className="sp-cards">
          {points.length === 0 && (
            <CamEmpty
              icon={<Icon name="add" size={22} />}
              title={t('solder.empty.title', 'No solder points yet')}
              hint={t(
                'solder.empty.hint',
                'Add a point, or jog the machine and record its position.',
              )}
              action={
                <button type="button" className="cam-primary" onClick={addRow}>
                  <Icon name="add" size={15} /> {t('solder.toolbar.add', 'Add point')}
                </button>
              }
            />
          )}
          {/* Bulk "apply to all" bar — the mobile equivalent of the per-header
              affordances (the table headers are hidden in this layout). One chip
              per bulk-editable column opens the same popover and writes to every
              point. Shown only when there are points to act on. */}
          {points.length > 0 && (
            <div className="sp-cards-bulk" onClick={(e) => e.stopPropagation()}>
              <span className="sp-cards-bulk-lbl">
                {t('solder.bulk.barLabel', 'Set for all {n}', { n: points.length })}
              </span>
              <span className="sp-cards-bulk-chip">
                <span>{t('solder.table.freeZ', 'Free-Z')}</span>
                <ColumnBulkEdit field="freeZ" label={t('solder.table.freeZ', 'Free-Z')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.mm', 'mm')} />
              </span>
              <span className="sp-cards-bulk-chip">
                <span>{t('solder.table.touchZ', 'Touch-Z')}</span>
                <ColumnBulkEdit field="touchZ" label={t('solder.table.touchZ', 'Touch-Z')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.mm', 'mm')} />
              </span>
              <span className="sp-cards-bulk-chip">
                <span>{t('solder.table.feedType', 'Type')}</span>
                <ColumnBulkEdit field="type" label={t('solder.table.feedType', 'Type')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} />
              </span>
              <span className="sp-cards-bulk-chip">
                <span>{t('solder.table.approach', 'Approach')}</span>
                <ColumnBulkEdit field="approach" label={t('solder.table.approach', 'Approach')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} />
              </span>
              <span className="sp-cards-bulk-chip">
                <span>{t('solder.card.feed', 'Feed')}</span>
                <ColumnBulkEdit field="feedSeconds" label={t('solder.table.feedS', 'Feed s')} count={points.length} apply={applyToAll} t={t} approachOpts={approachOpts} unit={t('unit.s', 's')} />
              </span>
            </div>
          )}
          {points.map((pt, i) => (
            <div
              key={i}
              className={`sp-pcard${i === selected ? ' is-selected' : ''}`}
              onClick={() => setSelected(i)}
            >
              <div className="sp-pcard-head">
                <span className="sp-pcard-idx">
                  {t('solder.card.point', 'Point')} {i + 1}
                </span>
                <div className="sp-pcard-actions">
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
                    <Icon name="close" size={14} />
                  </button>
                </div>
              </div>

              <div className="sp-pcard-grid">
                <label className="sp-mini">
                  <span>{t('solder.table.x', 'X')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.x}
                    onChange={(e) => updatePoint(i, { x: num(e.target.value, pt.x) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="sp-mini">
                  <span>{t('solder.table.y', 'Y')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.y}
                    onChange={(e) => updatePoint(i, { y: num(e.target.value, pt.y) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="sp-mini">
                  <span>{t('solder.table.freeZ', 'Free-Z')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.freeZ}
                    onChange={(e) => updatePoint(i, { freeZ: num(e.target.value, pt.freeZ) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="sp-mini">
                  <span>{t('solder.table.touchZ', 'Touch-Z')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={pt.touchZ}
                    onChange={(e) => updatePoint(i, { touchZ: num(e.target.value, pt.touchZ) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
                <label className="sp-mini">
                  <span>{t('solder.card.feed', 'Feed')}</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    value={pt.feedSeconds}
                    onChange={(e) => updatePoint(i, { feedSeconds: num(e.target.value, pt.feedSeconds) })}
                    onClick={(e) => e.stopPropagation()}
                  />
                </label>
              </div>

              <div className="sp-pcard-type" onClick={(e) => e.stopPropagation()}>
                <span className="sp-pcard-type-label">{t('solder.table.feedType', 'Type')}</span>
                <label className={`sp-radio${pt.type === SolderFeedType.PreSolder ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name={`sp-type-${i}`}
                    checked={pt.type === SolderFeedType.PreSolder}
                    onChange={() => updatePoint(i, { type: SolderFeedType.PreSolder })}
                  />
                  {t('solder.feedType.preSolder', 'pre-solder')}
                </label>
                <label className={`sp-radio${pt.type === SolderFeedType.TouchDown ? ' is-on' : ''}`}>
                  <input
                    type="radio"
                    name={`sp-type-${i}`}
                    checked={pt.type === SolderFeedType.TouchDown}
                    onChange={() => updatePoint(i, { type: SolderFeedType.TouchDown })}
                  />
                  {t('solder.feedType.touchDown', 'touch-down')}
                </label>
              </div>

              <div className="sp-pcard-type" onClick={(e) => e.stopPropagation()}>
                <span className="sp-pcard-type-label">{t('solder.table.approach', 'Approach')}</span>
                {approachOpts.map((o) => (
                  <label key={o.value} className={`sp-radio${pt.approach === o.value ? ' is-on' : ''}`}>
                    <input
                      type="radio"
                      name={`sp-approach-${i}`}
                      checked={pt.approach === o.value}
                      onChange={() => updatePoint(i, { approach: o.value })}
                    />
                    {o.label}
                  </label>
                ))}
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
            value={capturePreset()}
            onLoad={(data) => applyPreset(data as SolderingPreset)}
            onError={(msg) => notify('warn', msg)}
            fileBase="soldering-settings"
            ext="ksolder"
            saveTitle={t('solder.settings.save', 'Save soldering settings')}
            loadTitle={t('solder.settings.load', 'Load soldering settings')}
          />
        }
      />
    </div>
  )
}
