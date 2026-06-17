import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Polyline } from '../core/geometry'
import { MoveType, Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { StrokeFont, TextAlign, type LayoutOptions } from '../core/strokeFont'
import { OutlineFont } from '../core/outlineFont'
import { applyTextStyle } from '../core/textStyle'
import {
  bufferStrokesToContours,
  boundsRect,
  pocketContoursToToolpath,
  unionContours,
} from '../core/textPocket'
import { outlineContoursToCenterlines } from '../core/centerline'
import {
  BUILTIN_ENTRY,
  detectKindByName,
  loadCatalogFont,
  loadFontCatalog,
  loadLocalFont,
  loadSystemFonts,
  systemFontsSupported,
  type FontCatalogEntry,
  type FontKind,
  type LoadedFont,
} from '../core/fontLibrary'
import { useProgram, usePersistentState } from '../store'
import { useProgramOwner } from '../store/programOwner'
import { useT } from '../i18n'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { IconButton } from '../components/IconButton'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import type { StatusNote } from '../core/fontLibrary'
import '../styles/writing.css'
import '../styles/cam.css'

const ALIGN_OPTIONS: { value: TextAlign; key: string; label: string; align: 'left' | 'center' | 'right' }[] = [
  { value: TextAlign.Left, key: 'writing.align.left', label: 'Left', align: 'left' },
  { value: TextAlign.Center, key: 'writing.align.center', label: 'Center', align: 'center' },
  { value: TextAlign.Right, key: 'writing.align.right', label: 'Right', align: 'right' },
]

/**
 * Parse a numeric input value, clamping to [min,max] and falling back to
 * `fallback` for any non-finite result (empty field, '-', 'e', etc.). This is
 * the P0 SAFETY guard: a NaN must never reach the emitter (it would print
 * literal 'F NaN' / 'Z NaN' into the streamed G-code).
 */
function clampNum(v: string, fallback: number, min: number, max: number): number {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/** The i18n translate function shape (key, English fallback, optional vars). */
type TFunc = (key: string, english: string, vars?: Record<string, string | number>) => string

/**
 * Tiny inline "text alignment" glyph (three lines, the middle offset per side).
 * Local to this panel because the shared Icon set has no alignment glyphs — and
 * unlike the old ⬅ ⬛ ➡ emoji these render identically across platforms and
 * recolor with the theme (currentColor).
 */
function AlignGlyph({ align }: { align: 'left' | 'center' | 'right' }) {
  // y2 line is short and anchored per the alignment; the rest span full width.
  const short =
    align === 'left' ? { x1: 3, x2: 14 } : align === 'right' ? { x1: 10, x2: 21 } : { x1: 6, x2: 18 }
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M3 6h18" />
      <path d={`M${short.x1} 12h${short.x2 - short.x1}`} />
      <path d="M3 18h18" />
    </svg>
  )
}

/**
 * Tiny inline glyph for each G-code mode (stroke / outline / carve-in / relief).
 * Pure SVG so it recolors with the theme (currentColor) and stays crisp.
 */
function ModeIcon({ mode }: { mode: GenMode }) {
  const common = {
    width: 15,
    height: 15,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false as const,
  }
  switch (mode) {
    case 'stroke': // a single pen squiggle
      return (
        <svg {...common}>
          <path d="M4 14c3-7 5 7 8 0s4-7 8 0" />
        </svg>
      )
    case 'outline': // a hollow 'A' outline
      return (
        <svg {...common}>
          <path d="M5 19 12 5l7 14" />
          <path d="M8 13h8" />
        </svg>
      )
    case 'carveIn': // letter with hatched (recessed) interior
      return (
        <svg {...common}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M7 9h10M7 12h10M7 15h10" strokeWidth={1.1} />
        </svg>
      )
    case 'relief': // raised letter — hatched background, clear letter
      return (
        <svg {...common}>
          <path d="M4 7h16M4 11h3M17 11h3M4 15h3M17 15h3M4 19h16" strokeWidth={1.1} />
          <path d="M9 19 12 8l3 11" />
        </svg>
      )
  }
}

/**
 * Sleek slider + typable number + unit row for a Writing numeric param. Mirrors
 * the CadCam tab's `SliderField` technique (themed `.cc-slider` accent fill via
 * the inline `--mc-pct`, exact entry in the `.cc-slider-num` box) so it matches
 * the rest of the app and themes cleanly in light + dark. The slider clamps to
 * [min,max] for dragging; the number box allows exact (even out-of-range) entry,
 * which the caller's own `clampNum` guard then sanitises — keeping typing fully
 * usable alongside the slider, with units preserved.
 */
function WrSlider({
  icon,
  label,
  htmlFor,
  unit,
  value,
  onChange,
  min,
  max,
  step,
  title,
}: {
  icon: ReactNode
  label: string
  htmlFor: string
  unit?: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step: number
  title?: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="cc-sfield" title={title}>
      <label className="cc-sfield-lbl" htmlFor={htmlFor}>
        <span className="cc-sfield-ico" aria-hidden>{icon}</span>
        <span className="cc-sfield-txt">{label}</span>
      </label>
      <input
        type="range"
        className="cc-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--mc-pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="cc-sfield-num">
        <input
          id={htmlFor}
          type="number"
          inputMode="decimal"
          className="cc-slider-num"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-label={label}
          onChange={(e) => onChange(clampNum(e.target.value, value, min, max))}
        />
        {unit ? <span className="cc-sfield-unit">{unit}</span> : null}
      </span>
    </div>
  )
}

/** Translate a font-library status note (stable code + params) for display. */
function noteText(t: TFunc, note: StatusNote): string {
  const p = note.params
  switch (note.code) {
    case 'httpError':
      return t('writing.fontNote.httpError', 'Font manifest unavailable (HTTP {status}).', { status: p?.status ?? '?' })
    case 'noList':
      return t('writing.fontNote.noList', 'Font manifest has no font list.')
    case 'skipped':
      return t('writing.fontNote.skipped', '{count} font(s) skipped (no file).', { count: p?.count ?? 0 })
    case 'unavailable':
      return t('writing.fontNote.unavailable', 'Font library unavailable (offline).')
    default:
      return ''
  }
}

/**
 * G-code generation mode.
 *   stroke  — follow font centerlines (pen mode).
 *   outline — trace glyph contours (pen mode).
 *   carveIn — area-clear (pocket) INSIDE the letters → recessed text (mill).
 *   relief  — area-clear (pocket) OUTSIDE the letters → raised text (mill).
 */
type GenMode = 'stroke' | 'outline' | 'carveIn' | 'relief'

/** Whether a mode is a milling pocket (Spindle Z) vs a pen-plot (Pen Z). */
function isPocketMode(m: GenMode): boolean {
  return m === 'carveIn' || m === 'relief'
}

/**
 * The serializable Writing document saved to / loaded from a `.kwrite` file
 * (plain JSON). Captures the text plus all style/layout/pen params. An uploaded
 * custom font cannot be embedded, so only `fontId` is stored; on load, an
 * `upload:`-prefixed id falls back to the built-in font.
 */
interface WritingDoc {
  text: string
  charHeight: number
  lineSpacing: number
  letterSpacing: number
  originX: number
  originY: number
  align: TextAlign
  penUpZ: number
  penDownZ: number
  feed: number
  bold: boolean
  italic: boolean
  underline: boolean
  fontId: string
  genMode: GenMode
}

/**
 * The single program-section label for ALL Writing output. Using ONE label for
 * every mode means switching modes REPLACES the section (setProgram overwrites a
 * same-named section) and never duplicates — there is only ever one Writing
 * section in the Program tab.
 */
const WRITING_SECTION = 'Writing'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Build pen-mode G-code from laid-out polylines. Each polyline becomes a rapid
 * (pen up) to its start, then feed moves (pen down) along its points; closed
 * polylines (outline contours) get a final feed back to the start. The emitter
 * maps Rapid->penUpZ and Feed->penDownZ in ZMode.Pen, so Z values here are
 * placeholders (0). `origin` offsets the whole layout in XY.
 */
function strokesToGcode(
  strokes: Polyline[],
  origin: { x: number; y: number },
  pen: { penUpZ: number; penDownZ: number; feedXY: number },
): string {
  const tp = new Toolpath()
  tp.name = 'Writing'
  for (const pl of strokes) {
    if (pl.points.length < 2) continue
    const first = pl.points[0]
    tp.rapid({ x: first.x + origin.x, y: first.y + origin.y, z: 0 })
    for (let i = 1; i < pl.points.length; i++) {
      const p = pl.points[i]
      tp.feed({ x: p.x + origin.x, y: p.y + origin.y, z: 0 })
    }
    // Close contours so the outline is fully traced.
    if (pl.closed) tp.feed({ x: first.x + origin.x, y: first.y + origin.y, z: 0 })
  }

  const emitter = new GcodeEmitter({
    programName: 'Writing',
    zMode: ZMode.Pen,
    penUpZ: pen.penUpZ,
    penDownZ: pen.penDownZ,
    safeZ: pen.penUpZ,
    useSpindle: false,
    feedXY: pen.feedXY,
  })
  return emitter.emitProgram(tp)
}

/** Carve / Relief milling parameters (mm; feeds mm/min; rpm). */
interface CarveParams {
  toolDiameter: number
  cutDepth: number
  stepdown: number
  stepoverPct: number // % of tool diameter
  feedXY: number
  feedZ: number
  spindleRPM: number
  safeZ: number
  strokeWidth: number
  margin: number
}

/**
 * Build MILLING (Spindle Z) pocket G-code for Carve-in / Relief. `fillContours`
 * are the CLOSED glyph fill contours (origin-offset already applied). Carve-in
 * pockets the glyph fill itself; Relief pockets a bordered rectangle MINUS the
 * letters (the letters + their counters are left as uncut islands via even-odd).
 * Returns the emitted G-code and the toolpath count for the status line.
 */
function pocketToGcode(
  mode: 'carveIn' | 'relief',
  fillContours: Polyline[],
  cp: CarveParams,
): { gcode: string; paths: number } {
  // ROBUSTNESS: union the glyph fill into clean, non-overlapping, correctly-wound
  // rings BEFORE pocketing. Outline fonts (esp. script / calligraphic ones) emit
  // OVERLAPPING contours; a raw even-odd scanline would treat the overlap as a
  // hole. Unioning first makes the even-odd fill exactly correct for any font.
  // Fall back to the raw contours if the union collapses everything.
  const cleanFill = unionContours(fillContours)
  const fill = cleanFill.length > 0 ? cleanFill : fillContours

  const region =
    mode === 'relief'
      ? [boundsRect(fill, cp.margin), ...fill]
      : fill

  const tp = pocketContoursToToolpath(fill, region, {
    toolDiameterMm: cp.toolDiameter,
    stepoverFrac: cp.stepoverPct / 100,
    stepdownMm: cp.stepdown,
    cutDepthMm: cp.cutDepth,
    safeZ: cp.safeZ,
    surfaceZ: 0,
    feedXY: cp.feedXY,
  })
  if (tp.isEmpty()) return { gcode: '', paths: 0 }

  const emitter = new GcodeEmitter({
    programName: 'Writing',
    zMode: ZMode.Spindle,
    safeZ: cp.safeZ,
    feedXY: cp.feedXY,
    feedZ: cp.feedZ,
    useSpindle: true,
    spindleRPM: cp.spindleRPM,
    comments: true,
  })
  // Count discrete plunges as a proxy for "pass count" in the status line.
  const paths = tp.moves.filter((m) => m.type === MoveType.Plunge).length
  return { gcode: emitter.emitProgram(tp), paths }
}

/**
 * Writing / Pen-plotter panel. Type text, pick a font (built-in Hershey,
 * bundled library fonts, or an uploaded JSON / TTF / OTF), style it (bold /
 * italic / underline, size, alignment), choose Stroke vs Outline G-code mode,
 * and it previews live in the Visualizer + auto-syncs to the Program tab.
 */
export function WritingPanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  // Shared-program ownership (last writer wins). Writing CLAIMS only on a real
  // text edit (not on the default mount text, and not on incidental re-renders
  // like an async font load) so it never steals the program back from another
  // job; it yields its Writing section when someone else owns.
  const programOwner = useProgramOwner((s) => s.owner)
  const prevTextRef = useRef<string | null>(null)

  const [text, setText] = usePersistentState('karmyogi.writing.text', 'Hello\nWorld 123')
  const [charHeight, setCharHeight] = usePersistentState('karmyogi.writing.charHeight', 10)
  const [lineSpacing, setLineSpacing] = usePersistentState('karmyogi.writing.lineSpacing', 1.5)
  const [letterSpacing, setLetterSpacing] = usePersistentState('karmyogi.writing.letterSpacing', 1)
  const [originX, setOriginX] = usePersistentState('karmyogi.writing.originX', 0)
  const [originY, setOriginY] = usePersistentState('karmyogi.writing.originY', 0)
  const [align, setAlign] = usePersistentState<TextAlign>('karmyogi.writing.align', TextAlign.Left)
  const [penUpZ, setPenUpZ] = usePersistentState('karmyogi.writing.penUpZ', 5)
  const [penDownZ, setPenDownZ] = usePersistentState('karmyogi.writing.penDownZ', 0)
  const [feed, setFeed] = usePersistentState('karmyogi.writing.feed', 1500)

  // Carve-in / Relief milling params (persisted). Only used for the pocket modes.
  const [carveTool, setCarveTool] = usePersistentState('karmyogi.writing.carveTool', 3)
  const [carveDepth, setCarveDepth] = usePersistentState('karmyogi.writing.carveDepth', 1)
  const [carveStepdown, setCarveStepdown] = usePersistentState('karmyogi.writing.carveStepdown', 0.5)
  const [carveStepover, setCarveStepover] = usePersistentState('karmyogi.writing.carveStepover', 40)
  const [carveFeed, setCarveFeed] = usePersistentState('karmyogi.writing.carveFeed', 600)
  const [carvePlunge, setCarvePlunge] = usePersistentState('karmyogi.writing.carvePlunge', 200)
  const [carveRpm, setCarveRpm] = usePersistentState('karmyogi.writing.carveRpm', 10000)
  const [carveSafeZ, setCarveSafeZ] = usePersistentState('karmyogi.writing.carveSafeZ', 5)
  const [carveStrokeWidth, setCarveStrokeWidth] = usePersistentState('karmyogi.writing.strokeWidth', 1.5)
  const [carveMargin, setCarveMargin] = usePersistentState('karmyogi.writing.margin', 4)

  // Styling (persisted).
  const [bold, setBold] = usePersistentState('karmyogi.writing.bold', false)
  const [italic, setItalic] = usePersistentState('karmyogi.writing.italic', false)
  const [underline, setUnderline] = usePersistentState('karmyogi.writing.underline', false)

  // Font selection + generation mode (persisted). The mode is auto-set to a
  // sensible default for the font kind on selection, but the user can override.
  const [fontId, setFontId] = usePersistentState('karmyogi.writing.fontId', BUILTIN_ENTRY.id)
  const [genMode, setGenMode] = usePersistentState<GenMode>('karmyogi.writing.genMode', 'stroke')

  // The font catalog (built-in + bundled library), populated on mount.
  const [catalog, setCatalog] = useState<FontCatalogEntry[]>([BUILTIN_ENTRY])
  // Enumerated local (client system) fonts via the Local Font Access API. Loaded
  // on demand (a user gesture is required) — empty until the user clicks "Load
  // system fonts". Kept separate from `catalog` so the catalog-load effect (which
  // re-fetches catalog ids) never touches these; they hold live FontData handles.
  const [localFonts, setLocalFonts] = useState<FontCatalogEntry[]>([])
  const [loadingSystem, setLoadingSystem] = useState(false)
  // The currently-loaded, ready-to-use font (built-in by default).
  const [loaded, setLoaded] = useState<LoadedFont>(() => ({ kind: 'stroke', font: StrokeFont.builtin() }))
  const [fontName, setFontName] = useState(BUILTIN_ENTRY.name)
  // Kind of the active font (drives default mode + which modes make sense).
  const [fontKind, setFontKind] = useState<FontKind>('stroke')
  // The last fontId we applied a default gen-mode for, so we only reset the
  // user's chosen mode when the FONT actually changes — not when the catalog
  // finishes loading async (which previously re-ran the effect and flickered).
  const lastModeFontIdRef = useRef<string | null>(null)

  const [info, setInfo] = useState(() =>
    t('writing.info.autoRegen', 'Type text — G-code regenerates automatically.'),
  )
  const fileRef = useRef<HTMLInputElement>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The font object used for layout (stroke or outline share a .layout API).
  const layoutFont = loaded.font
  // Built-in stroke font reused as the centerline fallback when an outline font
  // is active but Stroke mode is selected (outline fonts have no centerlines).
  const builtinStroke = useMemo(() => StrokeFont.builtin(), [])

  // Populate the catalog from the bundled manifest once on mount.
  useEffect(() => {
    const ac = new AbortController()
    void (async () => {
      const { entries, note } = await loadFontCatalog(ac.signal)
      if (ac.signal.aborted) return
      setCatalog(entries)
      if (note) {
        setInfo(
          t('writing.info.libraryNote', 'Font library: {note}. Built-in font available.', {
            note: noteText(t, note),
          }),
        )
      }
    })()
    return () => ac.abort()
  }, [t])

  // When the selected font id changes, load it. Uploads ('upload:...') are loaded
  // directly in the upload handler, so skip them here. A 'local:...' id is an
  // enumerated system font: find its live FontData handle and load via .blob().
  // Everything else is a bundled catalog entry fetched over the network.
  useEffect(() => {
    if (fontId.startsWith('upload:')) return
    const isLocal = fontId.startsWith('local:')
    const entry = isLocal
      ? localFonts.find((e) => e.id === fontId)
      : catalog.find((e) => e.id === fontId) ?? BUILTIN_ENTRY
    // A local id with no matching handle (e.g. restored from a stale persisted
    // value before the user reloaded system fonts) — leave the current font and
    // hint the user, rather than crash.
    if (!entry) {
      if (isLocal) {
        // A persisted system-font id can't be used until the user re-grants
        // local-font access. Fall back to the built-in stroke font cleanly so the
        // status doesn't flip between this hint and an "outline fell back" note.
        setFontKind('stroke')
        setInfo(
          t('writing.info.localStale', 'Reload system fonts to use this font (using built-in for now).'),
        )
      }
      return
    }
    const ac = new AbortController()
    void (async () => {
      try {
        const lf = isLocal ? await loadLocalFont(entry) : await loadCatalogFont(entry, ac.signal)
        if (ac.signal.aborted) return
        setLoaded(lf)
        setFontName(entry.name)
        setFontKind(lf.kind)
        // Set the natural default mode ONLY when the FONT actually changed — not
        // when the catalog merely finished loading (which would reset the user's
        // chosen mode and flicker the status line). Pocket modes (carveIn/relief)
        // work for BOTH font kinds, so PRESERVE them across a font change; only
        // pen modes need snapping to the font's natural default.
        if (lastModeFontIdRef.current !== fontId) {
          setGenMode((prev) =>
            prev === 'carveIn' || prev === 'relief'
              ? prev
              : lf.kind === 'outline'
                ? 'outline'
                : 'stroke',
          )
          lastModeFontIdRef.current = fontId
        }
      } catch (e) {
        if (ac.signal.aborted) return
        setInfo(
          t('writing.info.fontFailed', 'Failed to load font: {error}', {
            error: (e as Error).message,
          }),
        )
      }
    })()
    return () => ac.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontId, catalog, localFonts])

  // Keep the generation mode VALID for the active font: a stroke-only font can't
  // produce outlines, so snap a stale/persisted `outline` mode back to `stroke`.
  // This prevents the confusing "(font has no outline data — fell back)" status
  // (and the flicker it caused) when the built-in/stroke font is active.
  useEffect(() => {
    if (fontKind !== 'outline' && genMode === 'outline') setGenMode('stroke')
  }, [fontKind, genMode, setGenMode])

  // Distinct characters in the text that the active font cannot render.
  const missing = useMemo(() => layoutFont.missingGlyphs(text), [layoutFont, text])

  const generate = useCallback((): string => {
    if (text.trim().length === 0) {
      // Nothing to draw — REMOVE the stale Writing section (pushing '' to a name
      // removes it) so the Program tab / Visualizer don't keep showing the last
      // text after the field is cleared.
      setProgram(WRITING_SECTION, '')
      setInfo(t('writing.info.enterText', 'Enter some text first.'))
      return ''
    }
    const layoutOpts: LayoutOptions = {
      charHeightMm: charHeight,
      lineSpacingFactor: lineSpacing,
      letterSpacingMm: letterSpacing,
      align,
    }

    const lineCount = text.split('\n').length

    // ---- Pocket modes (Carve in / Relief) — MILLING area-clear -------------
    if (isPocketMode(genMode)) {
      let gcode = ''
      let paths = 0
      try {
        // Build the CLOSED glyph FILL contours. Outline fonts already return
        // closed contours; stroke fonts return open centerlines we thicken.
        const rawFill =
          loaded.kind === 'outline'
            ? loaded.font.layout(text, layoutOpts)
            : bufferStrokesToContours(loaded.font.layout(text, layoutOpts), carveStrokeWidth)

        if (rawFill.length === 0) {
          setProgram(WRITING_SECTION, '')
          setInfo(t('writing.info.nothingToDraw', 'Nothing to draw (no renderable glyphs).'))
          return ''
        }

        // Apply the SAME styling + origin offset as the pen modes. Style first
        // (operates on the closed contours), then offset by origin.
        const styled = applyTextStyle(
          rawFill,
          { bold, italic, underline, charHeightMm: charHeight },
          charHeight * (lineSpacing > 0 ? lineSpacing : 1.5),
        )
        const fillContours = styled.map((pl) => {
          const c = pl.clone()
          c.closed = true
          for (const p of c.points) {
            p.x += originX
            p.y += originY
          }
          return c
        })

        const cp: CarveParams = {
          toolDiameter: carveTool,
          cutDepth: carveDepth,
          stepdown: carveStepdown,
          stepoverPct: carveStepover,
          feedXY: carveFeed,
          feedZ: carvePlunge,
          spindleRPM: carveRpm,
          safeZ: carveSafeZ,
          strokeWidth: carveStrokeWidth,
          margin: carveMargin,
        }
        const pocketMode = genMode === 'relief' ? 'relief' : 'carveIn'
        const res = pocketToGcode(pocketMode, fillContours, cp)
        gcode = res.gcode
        paths = res.paths
      } catch {
        setProgram(WRITING_SECTION, '')
        setInfo(t('writing.info.pocketEmpty', 'Pocket produced no cuts — try a smaller tool ⌀ or larger text.'))
        return ''
      }
      if (!gcode) {
        setProgram(WRITING_SECTION, '')
        setInfo(t('writing.info.pocketEmpty', 'Pocket produced no cuts — try a smaller tool ⌀ or larger text.'))
        return ''
      }
      setProgram(WRITING_SECTION, gcode)
      const modeLabel =
        genMode === 'relief'
          ? t('writing.mode.relief', 'Relief')
          : t('writing.mode.carveIn', 'Carve in')
      let msg = t(
        'writing.info.generatedMode',
        '{mode}: {strokes} path(s), {lines} line(s) → Visualizer.',
        { mode: modeLabel, strokes: paths, lines: lineCount },
      )
      if (missing.length > 0)
        msg += ' ' + t('writing.info.missingChars', '{count} character(s) missing from "{font}".', {
          count: missing.length,
          font: fontName,
        })
      setInfo(msg)
      return gcode
    }

    // ---- Pen modes (Stroke / Outline) — unchanged --------------------------
    // Stroke mode draws single-stroke centerlines. For a stroke font those are
    // the font's own centerlines; for an OUTLINE font (no centerlines) we DERIVE
    // them from the glyph fill via medial-axis skeletonization, so Stroke mode
    // follows the SELECTED font's real shapes (not the built-in Hershey font).
    // Outline mode requires an outline font; a stroke font falls back to stroke.
    let strokes: Polyline[]
    let effectiveMode: GenMode = genMode
    let centerlineFromOutline = false
    if (genMode === 'outline' && loaded.kind === 'outline') {
      strokes = loaded.font.layout(text, layoutOpts)
    } else if (genMode === 'outline' && loaded.kind === 'stroke') {
      // Stroke font has no contours — fall back to its centerline strokes.
      effectiveMode = 'stroke'
      strokes = loaded.font.layout(text, layoutOpts)
    } else if (genMode === 'stroke' && loaded.kind === 'outline') {
      // Outline font: skeletonize its filled glyph contours into centerlines so
      // the chosen font is drawn as single strokes (stroke width averaged out).
      const contours = loaded.font.layout(text, layoutOpts)
      const center = outlineContoursToCenterlines(contours, { charHeightMm: charHeight })
      if (center.length > 0) {
        strokes = center
        centerlineFromOutline = true
      } else {
        // Skeleton failed (degenerate) — fall back to the built-in stroke font.
        strokes = builtinStroke.layout(text, layoutOpts)
      }
    } else {
      strokes = loaded.font.layout(text, layoutOpts)
    }

    if (strokes.length === 0) {
      setInfo(t('writing.info.nothingToDraw', 'Nothing to draw (no renderable glyphs).'))
      return ''
    }

    // Apply bold / italic / underline styling to the laid-out polylines.
    const styled = applyTextStyle(
      strokes,
      { bold, italic, underline, charHeightMm: charHeight },
      charHeight * (lineSpacing > 0 ? lineSpacing : 1.5),
    )

    const gcode = strokesToGcode(
      styled,
      { x: originX, y: originY },
      { penUpZ, penDownZ, feedXY: feed },
    )
    setProgram(WRITING_SECTION, gcode)

    const modeLabel =
      effectiveMode === 'outline'
        ? t('writing.mode.outline', 'Outline')
        : t('writing.mode.stroke', 'Stroke')
    let msg = t(
      'writing.info.generatedMode',
      '{mode}: {strokes} path(s), {lines} line(s) → Visualizer.',
      { mode: modeLabel, strokes: styled.length, lines: lineCount },
    )
    if (centerlineFromOutline)
      msg += ' ' + t('writing.info.centerline', '(centerline derived from the font outline)')
    if (effectiveMode !== genMode)
      msg += ' ' + t('writing.info.modeFallback', '(font has no {wanted} data — fell back)', {
        // Localize the inserted token too (it previously leaked English).
        wanted:
          genMode === 'outline'
            ? t('writing.mode.outline', 'Outline')
            : t('writing.mode.stroke', 'Stroke'),
      })
    if (missing.length > 0)
      msg +=
        ' ' +
        t('writing.info.missingChars', '{count} character(s) missing from "{font}".', {
          count: missing.length,
          font: fontName,
        })
    setInfo(msg)
    return gcode
  }, [
    t, text, loaded, genMode, charHeight, lineSpacing, letterSpacing, align,
    bold, italic, underline, originX, originY, penUpZ, penDownZ, feed, missing,
    fontName, setProgram, builtinStroke,
    carveTool, carveDepth, carveStepdown, carveStepover, carveFeed, carvePlunge,
    carveRpm, carveSafeZ, carveStrokeWidth, carveMargin,
  ])

  // Live G-code: always regenerate ~300ms after the last change and push to the
  // program store so the Visualizer updates without a manual Generate step. When
  // the text is empty, clear the section right away (no debounce) so stale
  // output doesn't linger — but never reset an active stream.
  useEffect(() => {
    const textChanged = prevTextRef.current !== null && prevTextRef.current !== text
    prevTextRef.current = text
    const owner = useProgramOwner.getState().owner
    if (text.trim().length === 0) {
      if (liveTimer.current) clearTimeout(liveTimer.current)
      if (!useProgram.getState().streaming) {
        setProgram(WRITING_SECTION, '')
        setInfo(t('writing.info.enterText', 'Enter some text first.'))
      }
      useProgramOwner.getState().release('writing')
      return
    }
    // Publish/own only when WE already own, OR the user just edited the text here.
    // (Dropping the `owner === null` case means the default text is NOT auto-loaded
    // into the program on page load — nothing loads until the operator types.)
    if (!(owner === 'writing' || textChanged)) return
    useProgramOwner.getState().claim('writing')
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
  }, [generate, text, setProgram, t])

  // Yield: when another CAM panel claims the program, drop our Writing section
  // (unless a stream is running) so it never lingers over another job.
  useEffect(() => {
    if (programOwner && programOwner !== 'writing') {
      if (!useProgram.getState().streaming) removeSection(WRITING_SECTION)
    }
  }, [programOwner, removeSection])

  // Upload a custom font file: JSON single-stroke, or TTF/OTF outline.
  const loadUpload = useCallback(
    async (file: File) => {
      const kind = detectKindByName(file.name)
      try {
        if (kind === 'outline') {
          const buf = await file.arrayBuffer()
          const f = OutlineFont.fromArrayBuffer(buf, file.name)
          setLoaded({ kind: 'outline', font: f })
          setFontName(f.name())
          setFontKind('outline')
          setGenMode('outline')
          setFontId('upload:' + file.name)
          setInfo(
            t('writing.info.fontUploadedTtf', 'Loaded outline font "{name}" ({count} glyphs).', {
              name: f.name(),
              count: f.glyphCount(),
            }),
          )
        } else {
          const json = await file.text()
          const f = StrokeFont.fromJson(json)
          setLoaded({ kind: 'stroke', font: f })
          setFontName(f.name())
          setFontKind('stroke')
          setGenMode('stroke')
          setFontId('upload:' + file.name)
          setInfo(
            t('writing.info.fontLoaded', 'Loaded custom font "{name}" ({count} glyphs).', {
              name: f.name(),
              count: f.glyphCount(),
            }),
          )
        }
      } catch (e) {
        setInfo(
          t('writing.info.fontFailed', 'Failed to load font: {error}', {
            error: (e as Error).message,
          }),
        )
      }
    },
    [t, setFontId, setGenMode],
  )

  // Translate a system-fonts status note (stable code + params) for display.
  const systemNoteText = useCallback(
    (note: StatusNote): string => {
      const p = note.params
      switch (note.code) {
        case 'unsupported':
          return t('writing.sysNote.unsupported', 'System fonts need a Chromium browser (Chrome/Edge) over HTTPS or localhost.')
        case 'denied':
          return t('writing.sysNote.denied', 'System-font access was denied. Allow the "Fonts" permission and try again.')
        case 'error':
          return t('writing.sysNote.error', 'Could not read system fonts: {message}.', { message: p?.message ?? '' })
        case 'loaded':
          return t('writing.sysNote.loaded', 'Loaded {count} system font(s).', { count: p?.count ?? 0 })
        case 'empty':
          return t('writing.sysNote.empty', 'No system fonts were returned.')
        default:
          return ''
      }
    },
    [t],
  )

  // Enumerate the user's local (client) system fonts via the Local Font Access
  // API. Must run from a user gesture (the button click). Degrades gracefully:
  // on an unsupported browser or denied permission it shows a friendly note and
  // leaves the bundled catalog untouched. NOTE: a static SPA cannot read the
  // *server* PC's fonts — this reads the visitor's own installed fonts, the
  // correct supported approach.
  const loadSystem = useCallback(async () => {
    if (loadingSystem) return
    setLoadingSystem(true)
    setInfo(t('writing.info.loadingSystem', 'Requesting access to your system fonts…'))
    try {
      const { entries, ok, note } = await loadSystemFonts()
      if (ok && entries.length > 0) setLocalFonts(entries)
      setInfo(systemNoteText(note))
    } finally {
      setLoadingSystem(false)
    }
  }, [loadingSystem, t, systemNoteText])

  // Whether the active font supports each mode (for disabling/coloring toggles).
  const canOutline = fontKind === 'outline'
  const canStroke = fontKind === 'stroke' // outline fonts derive a centerline (skeleton)

  // The current state as a save document (.kwrite).
  const doc: WritingDoc = {
    text, charHeight, lineSpacing, letterSpacing, originX, originY, align,
    penUpZ, penDownZ, feed, bold, italic, underline, fontId, genMode,
  }

  // Apply a loaded document. `data` is untrusted: validate every field and keep
  // the current value for anything missing or of the wrong type. An uploaded
  // font id can't be restored (the file isn't embedded), so fall back to built-in.
  const loadDoc = useCallback(
    (data: unknown) => {
      if (!isObj(data)) {
        setInfo(t('writing.info.loadInvalid', 'Could not load — file is not a valid writing document.'))
        return
      }
      if (typeof data.text === 'string') setText(data.text)
      if (isNum(data.charHeight)) setCharHeight(data.charHeight)
      if (isNum(data.lineSpacing)) setLineSpacing(data.lineSpacing)
      if (isNum(data.letterSpacing)) setLetterSpacing(data.letterSpacing)
      if (isNum(data.originX)) setOriginX(data.originX)
      if (isNum(data.originY)) setOriginY(data.originY)
      if (data.align === TextAlign.Left || data.align === TextAlign.Center || data.align === TextAlign.Right)
        setAlign(data.align)
      if (isNum(data.penUpZ)) setPenUpZ(data.penUpZ)
      if (isNum(data.penDownZ)) setPenDownZ(data.penDownZ)
      if (isNum(data.feed)) setFeed(data.feed)
      if (typeof data.bold === 'boolean') setBold(data.bold)
      if (typeof data.italic === 'boolean') setItalic(data.italic)
      if (typeof data.underline === 'boolean') setUnderline(data.underline)
      if (
        data.genMode === 'stroke' ||
        data.genMode === 'outline' ||
        data.genMode === 'carveIn' ||
        data.genMode === 'relief'
      )
        setGenMode(data.genMode)
      // An uploaded or local system font cannot be embedded in the saved doc —
      // fall back to the built-in font for those ids.
      if (typeof data.fontId === 'string')
        setFontId(
          data.fontId.startsWith('upload:') || data.fontId.startsWith('local:')
            ? BUILTIN_ENTRY.id
            : data.fontId,
        )
      setInfo(t('writing.info.loaded', 'Loaded writing document — preview updated.'))
    },
    [t, setText, setCharHeight, setLineSpacing, setLetterSpacing, setOriginX, setOriginY,
      setAlign, setPenUpZ, setPenDownZ, setFeed, setBold, setItalic, setUnderline,
      setGenMode, setFontId],
  )

  // ---- color-coded setting PRESETS (text / font / layout) -------------------
  // Snapshot the full writing document; apply via the same validated loadDoc so
  // a corrupt persisted slot is coerced field-by-field (and uploaded/local font
  // ids fall back to the built-in font, just like a loaded .kwrite file).
  const presets = usePresets<WritingDoc>({
    storageKey: 'karmyogi.writing.presets',
    capture: () => doc,
    onApply: loadDoc,
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('writing.presets.aria', 'Writing setting presets')}
      />
    <div className="wr-panel">
      <div className="wr-scroll">
        <p className="wr-intro">
          {t(
            'writing.intro',
            'Type text → it previews live in the Visualizer and auto-syncs to the Program tab for streaming. Choose a font, style it, and pick Stroke (centerlines) or Outline (glyph contours) — output is safe pen-plotter G-code (Z = pen up / down).',
          )}
        </p>
        <p className="wr-status" role="status">{info}</p>

        <div className="wr-cards">
        {/* ---- Text (spans full width) ---- */}
        <section className="wr-card wr-span">
          <h3 className="wr-card-head">
            <span>
              <span className="cam-card-ico wr-glyph" aria-hidden>T</span>
              {t('writing.text.title', 'Text')}
            </span>
            <SaveLoadButtons
              value={doc}
              onLoad={loadDoc}
              fileBase="karmyogi-writing"
              ext="kwrite"
              saveDisabled={text.trim().length === 0}
              saveTitle={t('writing.save', 'Save writing document')}
              loadTitle={t('writing.load', 'Load writing document')}
              onError={setInfo}
              parseErrorMessage={(name) =>
                t('writing.info.parseError', 'Could not read {name} — expected a .kwrite (JSON) writing document.', { name })
              }
            />
          </h3>
          <div className="wr-card-body">
            <textarea
              className="wr-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('writing.text.placeholder', 'Type here. Use Enter for a new line.')}
              title={t('writing.text.title.tip', 'Text to plot. Press Enter for a new line.')}
              rows={2}
              spellCheck={false}
            />
          </div>
        </section>

        {/* ---- Font & Style: sleek dense toolbar — font picker + source icons +
             Stroke/Outline mode on one line, then Style (B/I/U) + Align on one ---- */}
        <section className="wr-card wr-span">
          <h3>
            <span className="cam-card-ico wr-glyph" aria-hidden>F</span>
            {t('writing.font.title', 'Font & Style')}
          </h3>
          <div className="wr-card-body wr-fs">
            {/* row 1: font select + source icons + Stroke/Outline mode, packed tight */}
            <div className="wr-font-row">
              <label className="wr-font-pick" title={t('writing.font.pickTip', 'Choose a font: built-in Hershey (offline), a bundled font, an uploaded file, or one of your loaded system fonts.')}>
                <select value={fontId} onChange={(e) => setFontId(e.target.value)} aria-label={t('writing.font.pick', 'Font')}>
                  <optgroup label={t('writing.font.group.bundled', 'Bundled')}>
                    {catalog.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}{e.kind === 'outline' ? ' · TTF' : ''}
                      </option>
                    ))}
                  </optgroup>
                  {localFonts.length > 0 && (
                    <optgroup label={t('writing.font.group.system', 'System ({count})', { count: localFonts.length })}>
                      {localFonts.map((e) => (
                        <option key={e.id} value={e.id}>{e.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {fontId.startsWith('upload:') && (
                    <optgroup label={t('writing.font.group.uploaded', 'Uploaded')}>
                      <option value={fontId}>{fontName}</option>
                    </optgroup>
                  )}
                </select>
              </label>
              <div className="wr-font-tools" role="toolbar" aria-label={t('writing.font.tools', 'Font sources')}>
                <IconButton
                  className="wr-icon"
                  iconName="upload"
                  iconSize={15}
                  label={t('writing.font.uploadTip', 'Upload a custom font: single-stroke JSON, or a TrueType/OpenType .ttf/.otf for outline mode.')}
                  onClick={() => fileRef.current?.click()}
                />
                <IconButton
                  className="wr-icon"
                  iconName="home"
                  iconSize={15}
                  label={t('writing.font.builtinTip', 'Use the built-in Hershey single-stroke font (always available, works offline).')}
                  onClick={() => setFontId(BUILTIN_ENTRY.id)}
                />
                <IconButton
                  className={'wr-icon' + (loadingSystem ? ' is-busy' : '')}
                  iconName="download"
                  iconSize={15}
                  label={
                    systemFontsSupported()
                      ? t('writing.font.systemTip', 'Load all fonts installed on this computer (asks for the browser "Fonts" permission).')
                      : t('writing.font.systemNa', 'System fonts need a Chromium browser (Chrome/Edge) over HTTPS or localhost.')
                  }
                  disabled={loadingSystem || !systemFontsSupported()}
                  onClick={() => void loadSystem()}
                />
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json,.ttf,.otf,.woff,font/ttf,font/otf"
                className="wr-file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void loadUpload(f)
                  if (fileRef.current) fileRef.current.value = ''
                }}
              />
            </div>

            {/* row 1b: G-code mode — compact 4-way segmented control */}
            <div className="wr-modebar" role="group" aria-label={t('writing.mode.label', 'G-code mode')}>
              <button
                type="button"
                className={'wr-modeseg' + (genMode === 'stroke' ? ' is-active' : '')}
                aria-pressed={genMode === 'stroke'}
                onClick={() => setGenMode('stroke')}
                title={t('writing.mode.strokeTip', 'Draw single strokes (centerlines). Stroke/JSON fonts use their own centerlines; outline (TTF/OTF) fonts are skeletonized into centerlines that follow the chosen font.')}
              >
                <ModeIcon mode="stroke" />
                <span className="wr-modeseg-lbl">{t('writing.mode.stroke', 'Stroke')}</span>
                {!canStroke && <span className="wr-seg-note">·{t('writing.mode.skeleton', 'auto')}</span>}
              </button>
              <button
                type="button"
                className={'wr-modeseg' + (genMode === 'outline' ? ' is-active' : '')}
                aria-pressed={genMode === 'outline'}
                onClick={() => setGenMode('outline')}
                disabled={!canOutline}
                title={
                  canOutline
                    ? t('writing.mode.outlineTip', 'Trace each glyph contour. Best for TTF/OTF fonts.')
                    : t('writing.mode.outlineNa', 'Outline mode needs a TTF/OTF font. Pick or upload one.')
                }
              >
                <ModeIcon mode="outline" />
                <span className="wr-modeseg-lbl">{t('writing.mode.outline', 'Outline')}</span>
              </button>
              <button
                type="button"
                className={'wr-modeseg' + (genMode === 'carveIn' ? ' is-active' : '')}
                aria-pressed={genMode === 'carveIn'}
                onClick={() => setGenMode('carveIn')}
                title={t('writing.mode.carveInTip', 'Mill a pocket INSIDE each letter → recessed/engraved text. Uses spindle Z.')}
              >
                <ModeIcon mode="carveIn" />
                <span className="wr-modeseg-lbl">{t('writing.mode.carveIn', 'Carve in')}</span>
              </button>
              <button
                type="button"
                className={'wr-modeseg' + (genMode === 'relief' ? ' is-active' : '')}
                aria-pressed={genMode === 'relief'}
                onClick={() => setGenMode('relief')}
                title={t('writing.mode.reliefTip', 'Mill a pocket AROUND the letters → raised (relief) text; letters left standing. Uses spindle Z.')}
              >
                <ModeIcon mode="relief" />
                <span className="wr-modeseg-lbl">{t('writing.mode.relief', 'Relief')}</span>
              </button>
            </div>

            {/* row 2: Style (B/I/U) + Align (left/center/right) packed on ONE tight row */}
            <div className="wr-styleline">
              <div className="wr-style-toggles" role="group" aria-label={t('writing.style.label', 'Text style')}>
                <button
                  type="button"
                  className={'wr-tgl wr-tgl-b' + (bold ? ' is-active' : '')}
                  aria-pressed={bold}
                  onClick={() => setBold(!bold)}
                  title={t('writing.style.bold', 'Bold — thicken strokes with extra parallel passes.')}
                >B</button>
                <button
                  type="button"
                  className={'wr-tgl wr-tgl-i' + (italic ? ' is-active' : '')}
                  aria-pressed={italic}
                  onClick={() => setItalic(!italic)}
                  title={t('writing.style.italic', 'Italic — slant the text.')}
                >I</button>
                <button
                  type="button"
                  className={'wr-tgl wr-tgl-u' + (underline ? ' is-active' : '')}
                  aria-pressed={underline}
                  onClick={() => setUnderline(!underline)}
                  title={t('writing.style.underline', 'Underline — add a line under each row of text.')}
                >U</button>
              </div>
              <span className="wr-vsep" aria-hidden="true" />
              <div
                className="wr-align"
                role="group"
                aria-label={t('writing.alignment', 'Alignment')}
                title={t('writing.alignment.tip', 'Horizontal alignment of each line of text.')}
              >
                {ALIGN_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    className={'wr-tgl' + (align === o.value ? ' is-active' : '')}
                    aria-pressed={align === o.value}
                    onClick={() => setAlign(o.value)}
                    title={t(o.key, o.label)}
                    aria-label={t(o.key, o.label)}
                  ><AlignGlyph align={o.align} /></button>
                ))}
              </div>
            </div>

            {missing.length > 0 && (
              <p className="wr-warn" role="status">
                {t('writing.missingGlyphs', 'Missing glyph(s): {glyphs} — rendered as blank space.', {
                  glyphs: missing.map((c) => (c === ' ' ? '␣' : c)).join(' '),
                })}
              </p>
            )}
          </div>
        </section>

        {/* ---- Size & spacing — slider rows (size, line + letter spacing) ---- */}
        <section className="wr-card">
          <h3>
            <span className="cam-card-ico wr-glyph" aria-hidden>↔</span>
            {t('writing.sizeSpacing.title', 'Size & Spacing')}
          </h3>
          <div className="wr-card-body wr-sliders">
            <WrSlider
              icon={<span className="wr-glyph">A</span>}
              label={t('writing.size', 'Size')}
              htmlFor="wr-size"
              unit="mm"
              min={0.5}
              max={100}
              step={0.5}
              value={charHeight}
              onChange={setCharHeight}
              title={t('writing.charHeight.tip', 'Cap height of the text in millimetres (font size).')}
            />
            <WrSlider
              icon={<span className="wr-glyph">≡</span>}
              label={t('writing.lineSpacing', 'Line spacing')}
              htmlFor="wr-line"
              unit="×"
              min={0.5}
              max={4}
              step={0.1}
              value={lineSpacing}
              onChange={setLineSpacing}
              title={t('writing.lineSpacing.tip', 'Baseline-to-baseline distance as a multiple of char height.')}
            />
            <WrSlider
              icon={<span className="wr-glyph">A·A</span>}
              label={t('writing.letterSpacing', 'Letter spacing')}
              htmlFor="wr-letter"
              unit="mm"
              min={0}
              max={20}
              step={0.5}
              value={letterSpacing}
              onChange={setLetterSpacing}
              title={t('writing.letterSpacing.tip', 'Extra gap added after each character, in millimetres.')}
            />
          </div>
        </section>

        {/* ---- Carve (Carve-in / Relief milling params) — shown only for pocket modes ---- */}
        {isPocketMode(genMode) && (
        <section className="wr-card wr-span">
          <h3>
            <span className="cam-card-ico" aria-hidden><ModeIcon mode={genMode} /></span>
            {t('writing.carve.title', 'Carve (milling)')}
          </h3>
          <div className="wr-card-body wr-sliders wr-carve">
            <WrSlider
              icon={<span className="wr-glyph">⌀</span>}
              label={t('writing.carve.tool', 'Tool ⌀')}
              htmlFor="wr-carve-tool"
              unit="mm"
              min={0.1}
              max={12}
              step={0.1}
              value={carveTool}
              onChange={setCarveTool}
              title={t('writing.carve.tool.tip', 'Cutter diameter (mm). Drives stepover pitch and the edge inset so the tool stays inside the region.')}
            />
            <WrSlider
              icon={<Icon name="download" size={14} />}
              label={t('writing.carve.depth', 'Cut depth')}
              htmlFor="wr-carve-depth"
              unit="mm"
              min={0.1}
              max={20}
              step={0.1}
              value={carveDepth}
              onChange={setCarveDepth}
              title={t('writing.carve.depth.tip', 'Total depth to remove below the surface (mm).')}
            />
            <WrSlider
              icon={<span className="wr-glyph">↓</span>}
              label={t('writing.carve.stepdown', 'Step-down')}
              htmlFor="wr-carve-stepdown"
              unit="mm"
              min={0.05}
              max={10}
              step={0.05}
              value={carveStepdown}
              onChange={setCarveStepdown}
              title={t('writing.carve.stepdown.tip', 'Depth removed per pass (mm). Smaller = more passes, gentler cut.')}
            />
            <WrSlider
              icon={<span className="wr-glyph">↔</span>}
              label={t('writing.carve.stepover', 'Step-over')}
              htmlFor="wr-carve-stepover"
              unit="%"
              min={5}
              max={90}
              step={1}
              value={carveStepover}
              onChange={setCarveStepover}
              title={t('writing.carve.stepover.tip', 'Sideways pitch between fill passes, as a percent of tool ⌀.')}
            />
            <WrSlider
              icon={<span className="wr-glyph">F</span>}
              label={t('writing.carve.feed', 'Feed')}
              htmlFor="wr-carve-feed"
              unit="mm/min"
              min={1}
              max={6000}
              step={50}
              value={carveFeed}
              onChange={setCarveFeed}
              title={t('writing.carve.feed.tip', 'Cutting feed rate in XY (mm/min).')}
            />
            <WrSlider
              icon={<span className="wr-glyph">↧</span>}
              label={t('writing.carve.plunge', 'Plunge feed')}
              htmlFor="wr-carve-plunge"
              unit="mm/min"
              min={1}
              max={3000}
              step={25}
              value={carvePlunge}
              onChange={setCarvePlunge}
              title={t('writing.carve.plunge.tip', 'Vertical plunge feed rate when entering the material (mm/min).')}
            />
            <WrSlider
              icon={<span className="wr-glyph">◎</span>}
              label={t('writing.carve.rpm', 'Spindle RPM')}
              htmlFor="wr-carve-rpm"
              unit="rpm"
              min={0}
              max={30000}
              step={500}
              value={carveRpm}
              onChange={setCarveRpm}
              title={t('writing.carve.rpm.tip', 'Spindle speed emitted as M3 S… (rpm).')}
            />
            <WrSlider
              icon={<Icon name="upload" size={14} />}
              label={t('writing.carve.safeZ', 'Safe-Z')}
              htmlFor="wr-carve-safez"
              unit="mm"
              min={0.5}
              max={50}
              step={0.5}
              value={carveSafeZ}
              onChange={setCarveSafeZ}
              title={t('writing.carve.safeZ.tip', 'Retract height above the surface for rapid travel (mm).')}
            />
            {fontKind === 'stroke' && (
              <WrSlider
                icon={<span className="wr-glyph">≣</span>}
                label={t('writing.carve.strokeWidth', 'Stroke width')}
                htmlFor="wr-carve-strokew"
                unit="mm"
                min={0.2}
                max={20}
                step={0.1}
                value={carveStrokeWidth}
                onChange={setCarveStrokeWidth}
                title={t('writing.carve.strokeWidth.tip', 'Thickness given to single-stroke font centerlines before pocketing (mm).')}
              />
            )}
            {genMode === 'relief' && (
              <WrSlider
                icon={<span className="wr-glyph">▣</span>}
                label={t('writing.carve.margin', 'Margin')}
                htmlFor="wr-carve-margin"
                unit="mm"
                min={0}
                max={50}
                step={0.5}
                value={carveMargin}
                onChange={setCarveMargin}
                title={t('writing.carve.margin.tip', 'Border around the text for the relief pocket rectangle (mm).')}
              />
            )}
          </div>
        </section>
        )}

        {/* ---- Pen Z & feed — slider rows ---- */}
        <section className="wr-card">
          <h3>
            <span className="cam-card-ico"><Icon name="download" size={14} /></span>
            {t('writing.penZ.title', 'Pen Z & Feed')}
          </h3>
          <div className="wr-card-body wr-sliders">
            <WrSlider
              icon={<Icon name="upload" size={14} />}
              label={t('writing.penUpZ', 'Pen up Z')}
              htmlFor="wr-penup"
              unit="mm"
              min={-10}
              max={50}
              step={0.5}
              value={penUpZ}
              onChange={setPenUpZ}
              title={t('writing.penUpZ.tip', 'Pen-up Z — height the pen lifts to for travel moves (safe-Z), in mm.')}
            />
            <WrSlider
              icon={<Icon name="download" size={14} />}
              label={t('writing.penDownZ', 'Pen down Z')}
              htmlFor="wr-pendown"
              unit="mm"
              min={-10}
              max={50}
              step={0.5}
              value={penDownZ}
              onChange={setPenDownZ}
              title={t('writing.penDownZ.tip', 'Pen-down Z — height the pen drops to while drawing, in mm.')}
            />
            <WrSlider
              icon={<span className="wr-glyph">{t('writing.feed.glyph', 'F')}</span>}
              label={t('writing.feed', 'Feed')}
              htmlFor="wr-feed"
              unit="mm/min"
              min={1}
              max={6000}
              step={50}
              value={feed}
              onChange={setFeed}
              title={t('writing.feed.tip', 'Feed — drawing (pen-down) feed rate, in mm per minute.')}
            />

            {/* SAFETY: pen-down must sit BELOW pen-up (which is the safe-Z). If it
                doesn't, the pen never lifts for travel and drags across the work. */}
            {penDownZ >= penUpZ && (
              <p className="wr-warn" role="alert">
                <Icon name="warning" size={13} />{' '}
                {t(
                  'writing.warn.penZ',
                  'Pen-down Z ({down}) is not below pen-up Z ({up}) — the pen will not lift for travel.',
                  { down: penDownZ, up: penUpZ },
                )}
              </p>
            )}
          </div>
        </section>

        {/* ---- Placement — origin sliders ---- */}
        <section className="wr-card">
          <h3>
            <span className="cam-card-ico wr-glyph" aria-hidden>+</span>
            {t('writing.placement.title', 'Placement')}
          </h3>
          <div className="wr-card-body wr-sliders">
            <WrSlider
              icon={<span className="wr-glyph">X</span>}
              label={t('writing.originX', 'Origin X')}
              htmlFor="wr-originx"
              unit="mm"
              min={-300}
              max={300}
              step={1}
              value={originX}
              onChange={setOriginX}
              title={t('writing.originX.tip', 'Shift the whole text block along X, in millimetres.')}
            />
            <WrSlider
              icon={<span className="wr-glyph">Y</span>}
              label={t('writing.originY', 'Origin Y')}
              htmlFor="wr-originy"
              unit="mm"
              min={-300}
              max={300}
              step={1}
              value={originY}
              onChange={setOriginY}
              title={t('writing.originY.tip', 'Shift the whole text block along Y, in millimetres.')}
            />
          </div>
        </section>

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
            value={doc}
            onLoad={loadDoc}
            fileBase="writing-settings"
            ext="kwrite"
            saveTitle={t('writing.settings.save', 'Save writing settings')}
            loadTitle={t('writing.settings.load', 'Load writing settings')}
            onError={setInfo}
            parseErrorMessage={(name) =>
              t('writing.info.parseError', 'Could not read {name} — expected a .kwrite (JSON) writing document.', { name })
            }
          />
        }
      />
    </div>
  )
}
