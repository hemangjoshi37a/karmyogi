import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Polyline } from '../core/geometry'
import { Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { StrokeFont, TextAlign, type LayoutOptions } from '../core/strokeFont'
import { OutlineFont } from '../core/outlineFont'
import { applyTextStyle } from '../core/textStyle'
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
import { useT } from '../i18n'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { IconButton } from '../components/IconButton'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import type { StatusNote } from '../core/fontLibrary'
import '../styles/writing.css'

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

/** G-code generation mode. Stroke = centerlines; Outline = glyph contours. */
type GenMode = 'stroke' | 'outline'

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

/**
 * Writing / Pen-plotter panel. Type text, pick a font (built-in Hershey,
 * bundled library fonts, or an uploaded JSON / TTF / OTF), style it (bold /
 * italic / underline, size, alignment), choose Stroke vs Outline G-code mode,
 * and it previews live in the Visualizer + auto-syncs to the Program tab.
 */
export function WritingPanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)

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
        // chosen mode and flicker the status line).
        if (lastModeFontIdRef.current !== fontId) {
          setGenMode(lf.kind === 'outline' ? 'outline' : 'stroke')
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
      // Nothing to draw — REMOVE the stale 'text — pen' section (pushing '' to a
      // name removes it) so the Program tab / Visualizer don't keep showing the
      // last text after the field is cleared.
      setProgram('text — pen', '')
      setInfo(t('writing.info.enterText', 'Enter some text first.'))
      return ''
    }
    const layoutOpts: LayoutOptions = {
      charHeightMm: charHeight,
      lineSpacingFactor: lineSpacing,
      letterSpacingMm: letterSpacing,
      align,
    }
    // Stroke mode always uses a stroke font (the built-in if the active font is
    // an outline font, which has no centerlines). Outline mode requires an
    // outline font; if the active font is a stroke font we fall back to stroke.
    let strokes: Polyline[]
    let effectiveMode: GenMode = genMode
    if (genMode === 'outline' && loaded.kind === 'outline') {
      strokes = loaded.font.layout(text, layoutOpts)
    } else if (genMode === 'outline' && loaded.kind === 'stroke') {
      // Stroke font has no contours — fall back to its centerline strokes.
      effectiveMode = 'stroke'
      strokes = loaded.font.layout(text, layoutOpts)
    } else if (genMode === 'stroke' && loaded.kind === 'outline') {
      // Outline font has no centerlines — render with the built-in stroke font.
      effectiveMode = 'stroke'
      strokes = builtinStroke.layout(text, layoutOpts)
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
    setProgram('text — pen', gcode)

    const lineCount = text.split('\n').length
    const modeLabel =
      effectiveMode === 'outline'
        ? t('writing.mode.outline', 'Outline')
        : t('writing.mode.stroke', 'Stroke')
    let msg = t(
      'writing.info.generatedMode',
      '{mode}: {strokes} path(s), {lines} line(s) → Visualizer.',
      { mode: modeLabel, strokes: styled.length, lines: lineCount },
    )
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
  ])

  // Live G-code: always regenerate ~300ms after the last change and push to the
  // program store so the Visualizer updates without a manual Generate step. When
  // the text is empty, clear the section right away (no debounce) so stale
  // output doesn't linger — but never reset an active stream.
  useEffect(() => {
    if (text.trim().length === 0) {
      if (liveTimer.current) clearTimeout(liveTimer.current)
      if (!useProgram.getState().streaming) {
        setProgram('text — pen', '')
        setInfo(t('writing.info.enterText', 'Enter some text first.'))
      }
      return
    }
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
  }, [generate, text, setProgram, t])

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
  const canStroke = fontKind === 'stroke' // outline fonts fall back to built-in stroke

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
      if (data.genMode === 'stroke' || data.genMode === 'outline') setGenMode(data.genMode)
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
            <span>{t('writing.text.title', 'Text')}</span>
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
          <h3>{t('writing.font.title', 'Font & Style')}</h3>
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
              {/* Stroke / Outline segmented mode toggle — sits inline on the font row */}
              <div className="wr-mode" role="group" aria-label={t('writing.mode.label', 'G-code mode')}>
                <button
                  type="button"
                  className={'wr-seg' + (genMode === 'stroke' ? ' is-active' : '')}
                  aria-pressed={genMode === 'stroke'}
                  onClick={() => setGenMode('stroke')}
                  title={t('writing.mode.strokeTip', 'Follow the font centerlines (single-stroke). Best for Hershey/JSON fonts; outline fonts use the built-in stroke font.')}
                >
                  {t('writing.mode.stroke', 'Stroke')}
                  {!canStroke && <span className="wr-seg-note">·{t('writing.mode.builtin', 'built-in')}</span>}
                </button>
                <button
                  type="button"
                  className={'wr-seg' + (genMode === 'outline' ? ' is-active' : '')}
                  aria-pressed={genMode === 'outline'}
                  onClick={() => setGenMode('outline')}
                  disabled={!canOutline}
                  title={
                    canOutline
                      ? t('writing.mode.outlineTip', 'Engrave around each glyph contour. Best for TTF/OTF fonts.')
                      : t('writing.mode.outlineNa', 'Outline mode needs a TTF/OTF font. Pick or upload one.')
                  }
                >
                  {t('writing.mode.outline', 'Outline')}
                </button>
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
          <h3>{t('writing.sizeSpacing.title', 'Size & Spacing')}</h3>
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

        {/* ---- Pen Z & feed — slider rows ---- */}
        <section className="wr-card">
          <h3>{t('writing.penZ.title', 'Pen Z & Feed')}</h3>
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
          <h3>{t('writing.placement.title', 'Placement')}</h3>
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
