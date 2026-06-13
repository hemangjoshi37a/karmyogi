import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMachine, useProgram, useNotifications, usePersistentState } from '../store'
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
  generateSoldering,
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
      <div className="sp-seg" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`sp-seg-btn${o.value === value ? ' active' : ''}`}
            aria-pressed={o.value === value}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
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

  const [defaults, setDefaults] = useState<RowDefaults>({
    freeZ: 5.0,
    touchZ: -1.0,
    feedSeconds: 0.5,
    type: SolderFeedType.TouchDown,
    approach: 'plunge',
  })

  const [points, setPoints] = useState<SolderPoint[]>([])
  const [selected, setSelected] = useState(-1)
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

  // Global generator params (programName is fixed here; metric stays mm/G21).
  const [params, setParams] = useState<SolderParams>(() => {
    const d = defaultSolderingParams()
    return {
      safeZ: d.safeZ,
      feederRPM: d.feederRPM,
      plungeFeed: d.plungeFeed,
      settleSeconds: d.settleSeconds,
      // Clamp on load so an out-of-range value can never reach toFixed().
      decimals: clampDecimals(d.decimals),
    }
  })

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
    // Prefill X/Y/Z from the LIVE machine work-position when connected so the
    // new point lands where the tip currently is (the operator jogs to the pad,
    // then clicks Add). Z maps to the touch-down height. When disconnected (no
    // live position) fall back to the plain defaults — never crash.
    const x = connected ? wpos.x : 0
    const y = connected ? wpos.y : 0
    const touchZ = connected ? wpos.z : defaults.touchZ
    // Compute the new index from the functional updater so it never reads a
    // stale `points` from this closure (which would select the wrong row).
    setPoints((p) => {
      setSelected(p.length)
      return [...p, newRow(x, y, touchZ)]
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
    setPoints((p) => (replace ? imported : [...p, ...imported]))
    setSelected(-1)
    notify(
      'success',
      t('solder.gerber.imported', 'Imported {n} point(s) from {layer}.', {
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
    if (selected >= 0 && selected < points.length) {
      updatePoint(selected, { x: wpos.x, y: wpos.y })
    } else {
      // Append at the live position (X/Y plus the touch-down Z) and select it
      // via the functional updater so the new index is computed from the current
      // list, not a stale closure.
      setPoints((p) => {
        setSelected(p.length)
        return [...p, newRow(wpos.x, wpos.y, wpos.z)]
      })
    }
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
  const gcode = useMemo(() => generateSoldering(safePoints, safeParams), [safePoints, safeParams])
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  const estSeconds = useMemo(
    () => estimateSolderingSeconds(safePoints, safeParams),
    [safePoints, safeParams],
  )

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
      return
    }
    const id = window.setTimeout(() => setProgram('soldering', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, points.length, setProgram, removeSection])

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
            className="sp-ico-danger"
            glyph={<Icon name="trash" />}
            onClick={clearAll}
            disabled={points.length === 0}
            title={t('solder.toolbar.clear', 'Clear all')}
            body={t('solder.toolbar.clear.body', 'Remove every soldering point and start over.')}
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
          <ToolButton
            className={showSettings ? 'is-active' : ''}
            glyph={<Icon name="settings" />}
            onClick={() => setShowSettings((v) => !v)}
            ariaExpanded={showSettings}
            title={t('solder.toolbar.settings', 'Settings')}
            body={t('solder.toolbar.settings.body', 'New-point defaults plus feeder and motion parameters (Safe-Z, feeder S, plunge feed, dwell).')}
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

      {/* Live status strip: point + line counts, auto-synced to the Program tab. */}
      <div className="sp-status">
        <span className="sp-status-pill">
          <b>{points.length}</b> {t('solder.status.points', 'points')}
        </span>
        <span className="sp-status-sep" aria-hidden="true">·</span>
        <span className="sp-status-pill">
          <b>{lineCount}</b> {t('solder.status.lines', 'G-code lines')}
        </span>
        <span className="sp-status-sep" aria-hidden="true">·</span>
        <span
          className="sp-status-pill"
          title={t('solder.status.est.title', 'Estimated cycle time (plunge + feeder + settle dwells; travel ignored)')}
        >
          <b>{fmtDuration(estSeconds, t)}</b> {t('solder.status.est', 'est.')}
        </span>
        <span className="sp-status-sync" title={t('solder.live.title', 'Lines auto-synced to the Program tab')}>
          → {t('solder.status.program', 'Program')}
        </span>
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
        </div>
        <div className="sp-table-wrap">
          <table className="sp-table">
            <thead>
              <tr>
                <th className="sp-idx">{t('solder.table.num', '#')}</th>
                <th>{t('solder.table.x', 'X')}</th>
                <th>{t('solder.table.y', 'Y')}</th>
                <th>{t('solder.table.freeZ', 'Free-Z')}</th>
                <th>{t('solder.table.touchZ', 'Touch-Z')}</th>
                <th>{t('solder.table.feedType', 'Type')}</th>
                <th>{t('solder.table.approach', 'Approach')}</th>
                <th>{t('solder.table.feedS', 'Feed s')}</th>
                <th className="sp-actions-col" aria-label={t('solder.table.actions', 'Actions')} />
              </tr>
            </thead>
            <tbody>
              {points.length === 0 && (
                <tr>
                  <td colSpan={9} className="sp-empty">
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
            <p className="sp-empty">
              {t(
                'solder.table.empty',
                'No points yet. Press + to add one, or ⌖ to record the machine position.',
              )}
            </p>
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
