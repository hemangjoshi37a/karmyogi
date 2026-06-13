import {
  DragEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  MoveHorizontal,
  MoveVertical,
  Contrast,
  Spline,
  ArrowUpToLine,
  ArrowDownToLine,
  Gauge,
} from 'lucide-react'
import { useT } from '../i18n'
import { Point, Polyline } from '../core/geometry'
import {
  countPoints,
  fitPolylinesToSize,
  simplifyPolyline,
  traceBitmap,
} from '../core/vectorize'
import { Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import { IconButton } from '../components/IconButton'
import { Icon } from '../components/Icons'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import '../styles/signature.css'

/** Named program section this panel owns in the combined program. */
const SECTION = 'signature — pen'

/** Split G-code into non-empty lines (used for the raw line count). */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/**
 * Parse a numeric input value, clamping to [min,max] and falling back to
 * `fallback` for any non-finite result. P0 SAFETY: a NaN must never reach the
 * emitter (it would print literal 'F NaN' / 'Z NaN' into the streamed G-code).
 */
function clampNum(v: string, fallback: number, min: number, max: number): number {
  const n = parseFloat(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

/**
 * Small inline "undo" glyph (curved arrow). Local because the shared Icon set
 * has no undo glyph; uses currentColor so it recolors with the theme like the
 * rest, unlike the old ⎌ emoji.
 */
function UndoGlyph() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M9 7L4 12l5 5" />
      <path d="M4 12h11a5 5 0 0 1 0 10h-1" />
    </svg>
  )
}

/**
 * Sleek slider + number-input + unit row, mirroring CadCamPanel's `SliderField`
 * (one-line: leading glyph + label, themed draggable `.sig-slider` with an accent
 * fill driven by the inline `--pct` var, a small typable `.sig-slider-num` and an
 * inline unit). Local copy so signature.css/tsx own their own widget; the styling
 * mirrors `.cc-slider` and is themed entirely through CSS vars (light + dark).
 *
 * `onChange` carries the field's existing wiring untouched — only the input WIDGET
 * changes (number box → slider + input). The slider is clamped to [min, max] for
 * dragging, but the number box accepts exact entry (caller's clampNum guards NaN).
 */
function SliderField({
  icon,
  label,
  htmlFor,
  unit,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
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
  disabled?: boolean
  title?: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the accent fill (read as --pct by the WebKit/Blink
  // track gradient; Firefox fills via ::-moz-range-progress). Uses the CLAMPED value
  // so an out-of-range typed value never overflows the fill.
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="sig-sfield" title={title}>
      <label className="sig-sfield-lbl" htmlFor={htmlFor}>
        <span className="sig-sfield-ico" aria-hidden>
          {icon}
        </span>
        <span className="sig-sfield-txt">{label}</span>
      </label>
      <input
        type="range"
        className="sig-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        disabled={disabled}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="sig-sfield-num">
        <input
          id={htmlFor}
          type="number"
          inputMode="decimal"
          className="sig-slider-num"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => {
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <span className="sig-sfield-unit">{unit}</span> : null}
      </span>
    </div>
  )
}

/** Decoded image pixels handed to the pure tracer. */
interface Raster {
  data: Uint8ClampedArray
  width: number
  height: number
  name: string
}

/**
 * A freehand stroke captured in NORMALIZED 0..1 surface coordinates (x right,
 * y down). Normalizing at capture (dividing by the live surface size the moment
 * each point lands) makes a saved `.ksig` resolution-independent AND fixes the
 * "signature zeroes out" bug: if the panel is hidden/resized the surface can
 * report width/height 0, so dividing LATER (at generate time) produced NaN/0 —
 * here every stored point is already a stable fraction.
 */
interface ScreenStroke {
  points: Point[]
}

/** Authoring mode for the panel. */
type Mode = 'draw' | 'image'

/**
 * The serializable Signature document saved to / loaded from a `.ksig` file
 * (plain JSON): the freehand strokes (NORMALIZED 0..1 space, so the file is
 * resolution-independent) plus the draw-size, pen, origin and feed params.
 * Image-trace state is not saved (the source image isn't embedded); only the
 * freehand drawing is portable.
 */
interface SignatureDoc {
  mode: Mode
  drawW: number
  drawH: number
  originX: number
  originY: number
  penUpZ: number
  penDownZ: number
  feed: number
  strokes: ScreenStroke[]
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Coerce an (untrusted) value to a finite number, else the fallback. */
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

/**
 * A reusable SIGNATURE setting preset: the size, image-trace and pen/placement
 * PARAMS that drive generation — NOT the freehand strokes or the loaded image
 * (those are the operator's actual work, saved separately to a .ksig). Scoped to
 * its own persistence key, independent of the carving / soldering / writing
 * presets.
 */
interface SignatureSettings {
  mode: Mode
  drawW: number
  drawH: number
  threshold: number
  invert: boolean
  targetW: number
  targetH: number
  lockAspect: boolean
  tolerance: number
  originX: number
  originY: number
  penUpZ: number
  penDownZ: number
  feed: number
}

/**
 * Narrow an arbitrary value to a ScreenStroke ({ points: {x,y}[] }). Points are
 * NORMALIZED 0..1; clamp to that range so a hand-edited or out-of-range file
 * can't push the drawing off-box (and a stray NaN coordinate is dropped).
 */
function parseStroke(v: unknown): ScreenStroke | null {
  if (!isObj(v) || !Array.isArray(v.points)) return null
  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1)
  const points: Point[] = []
  for (const p of v.points) {
    if (isObj(p) && isNum(p.x) && isNum(p.y)) points.push({ x: clamp01(p.x), y: clamp01(p.y) })
  }
  return points.length >= 2 ? { points } : null
}

/**
 * Build pen-mode G-code from mm-space polylines. Each polyline becomes a rapid
 * (pen up) to its start, then feed moves (pen down) along its points. In
 * ZMode.Pen the emitter maps Rapid→penUpZ and Feed→penDownZ, so the Z values
 * here are placeholders (0) — only XY matters. `origin` offsets the whole
 * drawing in machine XY.
 */
function polylinesToGcode(
  polys: Polyline[],
  origin: { x: number; y: number },
  pen: { penUpZ: number; penDownZ: number; feedXY: number },
): string {
  const tp = new Toolpath()
  tp.name = 'Signature'
  for (const pl of polys) {
    if (pl.points.length < 2) continue
    const first = pl.points[0]
    tp.rapid({ x: first.x + origin.x, y: first.y + origin.y, z: 0 })
    for (let i = 1; i < pl.points.length; i++) {
      const p = pl.points[i]
      tp.feed({ x: p.x + origin.x, y: p.y + origin.y, z: 0 })
    }
    // Close the contour back to its start so outlines render closed.
    if (pl.closed) {
      tp.feed({ x: first.x + origin.x, y: first.y + origin.y, z: 0 })
    }
  }

  const emitter = new GcodeEmitter({
    programName: 'Signature',
    zMode: ZMode.Pen,
    penUpZ: pen.penUpZ,
    penDownZ: pen.penDownZ,
    safeZ: pen.penUpZ,
    useSpindle: false,
    feedXY: pen.feedXY,
  })
  return emitter.emitProgram(tp)
}

/** Bounds of mm-space polylines (assumes they rest on/near origin). */
function polysBounds(polys: Polyline[]): { w: number; h: number } {
  let maxX = 0
  let maxY = 0
  for (const pl of polys) {
    for (const p of pl.points) {
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  }
  return { w: maxX, h: maxY }
}

/**
 * Convert captured freehand strokes (NORMALIZED 0..1 space, y-down) into mm-space
 * polylines anchored at the origin. The signature is scaled to fit the target
 * `drawW × drawH` mm box and the Y axis is flipped (screen +Y is down, machine
 * +Y is up) so it plots the right way up. Because the input is already 0..1, the
 * conversion no longer depends on the live surface pixel size (which can be 0 if
 * the panel is hidden/resized) — eliminating the "signature collapses to 0" bug.
 */
function strokesToPolylines(strokes: ScreenStroke[], draw: { w: number; h: number }): Polyline[] {
  const polys: Polyline[] = []
  for (const s of strokes) {
    if (s.points.length < 2) continue
    const pl = new Polyline()
    for (const p of s.points) {
      // Scale the 0..1 fraction into the mm box and flip Y (screen-down → up).
      pl.add({ x: p.x * draw.w, y: draw.h - p.y * draw.h })
    }
    polys.push(pl)
  }
  return polys
}

/**
 * Signature panel — two authoring modes that share one pen-plotter pipeline:
 *  • Draw: sign freehand with mouse / stylus / touch on the canvas.
 *  • From image: upload a signature image and trace its ink contours.
 * Both produce mm-space polylines that are fed through Toolpath + GcodeEmitter
 * (ZMode.Pen) and pushed live to the program store for 3D preview + streaming.
 */
export function SignaturePanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  // Subscribe so the live-push effect re-runs (and pushes the latest) the moment
  // a stream ends, and so the Send button enables/disables with connection.
  const streaming = useProgram((s) => s.streaming)
  const connected = useMachine((s) => s.connection === 'connected')

  // ---- Mode ----
  const [mode, setMode] = usePersistentState<Mode>('karmyogi.sig.mode', 'draw')

  // ---- Freehand draw state ----
  const [drawW, setDrawW] = usePersistentState('karmyogi.sig.drawW', 60)
  const [drawH, setDrawH] = usePersistentState('karmyogi.sig.drawH', 30)
  const [strokes, setStrokes] = useState<ScreenStroke[]>([])
  // Strokes captured this gesture; committed to `strokes` on pointer-up.
  const liveStroke = useRef<Point[] | null>(null)
  const [liveStrokeTick, setLiveStrokeTick] = useState(0)
  const drawSurfaceRef = useRef<SVGSVGElement>(null)

  // ---- Image (vectorize) controls ----
  const [threshold, setThreshold] = usePersistentState('karmyogi.sig.threshold', 128)
  const [invert, setInvert] = usePersistentState('karmyogi.sig.invert', false)
  const [targetW, setTargetW] = usePersistentState('karmyogi.sig.targetW', 60)
  const [targetH, setTargetH] = usePersistentState('karmyogi.sig.targetH', 30)
  const [lockAspect, setLockAspect] = usePersistentState('karmyogi.sig.lockAspect', true)
  const [tolerance, setTolerance] = usePersistentState('karmyogi.sig.tolerance', 1.5)
  // ---- Shared pen / placement controls ----
  const [originX, setOriginX] = usePersistentState('karmyogi.sig.originX', 0)
  const [originY, setOriginY] = usePersistentState('karmyogi.sig.originY', 0)
  const [penUpZ, setPenUpZ] = usePersistentState('karmyogi.sig.penUpZ', 5)
  const [penDownZ, setPenDownZ] = usePersistentState('karmyogi.sig.penDownZ', 0)
  const [feed, setFeed] = usePersistentState('karmyogi.sig.feed', 1500)
  const [showAdvanced, setShowAdvanced] = usePersistentState('karmyogi.sig.showAdvanced', false)
  const [showRaw, setShowRaw] = usePersistentState('karmyogi.sig.showRaw', false)

  const [raster, setRaster] = useState<Raster | null>(null)
  const [info, setInfo] = useState(() => t('sig.info.draw', 'Sign in the box above with your mouse, stylus, or finger.'))
  const [preview, setPreview] = useState('')
  const [previewPolys, setPreviewPolys] = useState<Polyline[]>([])
  const [dragOver, setDragOver] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Decode an image File into RGBA pixels via an offscreen canvas. The pure
  // tracer only ever sees the resulting pixel array (no DOM in core).
  const loadImage = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setInfo(t('sig.info.notImage', 'Please choose an image file.'))
      return
    }
    try {
      const url = URL.createObjectURL(file)
      const img = new Image()
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error(t('sig.err.decode', 'Could not decode image')))
        img.src = url
      })
      // Cap the working resolution so tracing stays fast on huge photos.
      const maxDim = 1000
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * scale))
      const h = Math.max(1, Math.round(img.height * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error(t('sig.err.canvas', 'Canvas 2D unavailable'))
      ctx.drawImage(img, 0, 0, w, h)
      const imageData = ctx.getImageData(0, 0, w, h)
      URL.revokeObjectURL(url)
      setRaster({ data: imageData.data, width: w, height: h, name: file.name })
      // Distinct key from the document-load message — the two collided on the
      // shared `sig.info.loaded` key (image text vs. "document loaded").
      setInfo(t('sig.info.imgLoaded', 'Loaded "{name}" ({w}×{h}px). Adjust threshold and size below.', { name: file.name, w, h }))
    } catch (e) {
      setInfo(t('sig.info.loadFailed', 'Failed to load image: {msg}', { msg: (e as Error).message }))
    }
  }, [t])

  // Build mm-space polylines for the active mode, then emit pen G-code and push
  // it to the store. Returns the polylines (empty if there's nothing to plot).
  const buildPolys = useCallback((): Polyline[] => {
    if (mode === 'draw') {
      // Strokes are already normalized 0..1, so the mm conversion no longer
      // reads the (possibly-zero) live surface size — just scales into the box.
      return strokesToPolylines(strokes, { w: drawW, h: drawH })
    }
    if (!raster) return []
    const contours = traceBitmap(raster.data, raster.width, raster.height, {
      threshold,
      invert,
    })
    if (contours.length === 0) return []
    // Simplify in PIXEL space (tolerance is in px), then scale to mm.
    const simplified = contours.map((c) => simplifyPolyline(c, tolerance))
    // When aspect is locked, fitPolylinesToSize already preserves aspect; pass a
    // generous height so width is the binding dimension.
    const fitH = lockAspect ? targetW * 1000 : targetH
    return fitPolylinesToSize(simplified, targetW, fitH, true)
  }, [
    mode, strokes, drawW, drawH,
    raster, threshold, invert, tolerance, targetW, targetH, lockAspect,
  ])

  // Generate G-code for the current state. Local preview state (the SVG + raw
  // text) always updates; the SHARED program store is only written when `push`
  // is true AND no stream is running — a live debounce must never reset an
  // active stream (setProgram resets cursor/streaming) nor push '' (which would
  // remove the running section out from under the streamer).
  const generate = useCallback(
    (push: boolean): string => {
      const streaming = useProgram.getState().streaming
      const polys = buildPolys()
      if (polys.length === 0) {
        // Only clear the shared section when nothing is streaming; never yank a
        // section the machine is actively running.
        if (push && !streaming) setProgram(SECTION, '')
        setPreview('')
        setPreviewPolys([])
        if (mode === 'draw') {
          setInfo(t('sig.info.draw', 'Sign in the box above with your mouse, stylus, or finger.'))
        } else if (raster) {
          setInfo(t('sig.info.noInk', 'No ink detected — try adjusting the threshold or toggling Invert.'))
        }
        return ''
      }

      const gcode = polylinesToGcode(
        polys,
        { x: originX, y: originY },
        { penUpZ, penDownZ, feedXY: feed },
      )
      if (push && !streaming) setProgram(SECTION, gcode)
      setPreview(gcode)
      setPreviewPolys(polys)

      const pts = countPoints(polys)
      const b = polysBounds(polys)
      setInfo(
        streaming
          ? t('sig.info.streaming', 'Streaming — edits apply after the current run.')
          : t('sig.info.result', '{strokes} stroke(s), {points} point(s) — {w}×{h} mm → Visualizer.', {
              strokes: polys.length,
              points: pts,
              w: b.w.toFixed(1),
              h: b.h.toFixed(1),
            }),
      )
      return gcode
    },
    [buildPolys, mode, raster, originX, originY, penUpZ, penDownZ, feed, setProgram, t],
  )

  // Live G-code: regenerate ~300ms after the last change and push to the store
  // so the Visualizer updates without a manual step (skipped while streaming).
  useEffect(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(true), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
    // `streaming` is in the deps so when a run finishes the latest edit is pushed.
  }, [generate, streaming])

  // ---- Freehand pointer handlers (mouse + stylus + touch via Pointer Events) ----
  // Capture each point as a NORMALIZED 0..1 fraction of the surface (clamped, so
  // a point captured just outside the box during a drag stays in range). This is
  // the fix for the resize/hidden-tab zeroing AND makes a saved .ksig
  // resolution-independent.
  const localPoint = useCallback((e: ReactPointerEvent<SVGSVGElement>): Point => {
    const el = drawSurfaceRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return { x: 0, y: 0 }
    const nx = (e.clientX - r.left) / r.width
    const ny = (e.clientY - r.top) / r.height
    return {
      x: Math.min(Math.max(nx, 0), 1),
      y: Math.min(Math.max(ny, 0), 1),
    }
  }, [])

  const onDrawPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (mode !== 'draw') return
    e.preventDefault()
    // Keep tracking even if the pointer leaves the surface mid-stroke.
    e.currentTarget.setPointerCapture(e.pointerId)
    liveStroke.current = [localPoint(e)]
    setLiveStrokeTick((n) => n + 1)
  }, [mode, localPoint])

  const onDrawPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!liveStroke.current) return
    e.preventDefault()
    liveStroke.current.push(localPoint(e))
    setLiveStrokeTick((n) => n + 1)
  }, [localPoint])

  const onDrawPointerUp = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const pts = liveStroke.current
    liveStroke.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    setLiveStrokeTick((n) => n + 1)
    if (pts && pts.length >= 2) {
      setStrokes((prev) => [...prev, { points: pts }])
    }
  }, [])

  const clearStrokes = useCallback(() => {
    liveStroke.current = null
    setStrokes([])
  }, [])
  const undoStroke = useCallback(() => {
    setStrokes((prev) => prev.slice(0, -1))
  }, [])

  // SVG preview viewBox + path data for the generated mm-space polylines.
  const svg = useMemo(() => {
    if (previewPolys.length === 0) return null
    const b = polysBounds(previewPolys)
    const w = Math.max(b.w, 1)
    const h = Math.max(b.h, 1)
    const pad = Math.max(w, h) * 0.04
    const paths = previewPolys
      .map((pl) => {
        if (pl.points.length < 2) return ''
        // SVG y is down; our mm polys are y-up, so flip within the viewBox.
        const d = pl.points
          .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)} ${(h - p.y).toFixed(2)}`)
          .join(' ')
        return pl.closed ? d + ' Z' : d
      })
      .filter(Boolean)
    return {
      viewBox: `${-pad} ${-pad} ${w + pad * 2} ${h + pad * 2}`,
      paths,
    }
  }, [previewPolys])

  // Committed + in-progress strokes as SVG paths in a fixed 0..100 viewBox (the
  // stored points are NORMALIZED 0..1, multiplied by 100 here; y-down, no flip —
  // this is the live drawing canvas, not the machine preview). A fixed viewBox +
  // non-scaling stroke means the drawing maps to the box at any pixel size, so a
  // resize / hidden tab can never collapse it (the old pixel-space render did).
  const drawPaths = useMemo(() => {
    void liveStrokeTick // re-render while a stroke is in progress
    const toPath = (points: Point[]): string =>
      points.length < 2
        ? ''
        : points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`)
            .join(' ')
    const committed = strokes.map((s) => toPath(s.points)).filter(Boolean)
    const live = liveStroke.current ? toPath(liveStroke.current) : ''
    return { committed, live }
  }, [strokes, liveStrokeTick])

  const rawLineCount = useMemo(
    () => (preview.length > 0 ? gcodeLines(preview).length : 0),
    [preview],
  )

  // Send the generated program to the machine. Regenerate fresh (no stale
  // closure), push it to the shared program store so the Visualizer also shows
  // it, then stream from the controller. No-op (with a hint) when disconnected
  // or there's nothing to plot.
  const onSend = useCallback(() => {
    const gcode = generate(true)
    if (!gcode) return
    if (!connected) {
      setInfo(t('sig.send.live', 'Preview is live; connect a machine to send.'))
      return
    }
    grbl.startProgram(gcodeLines(gcode))
  }, [generate, connected, t])

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void loadImage(file)
    e.target.value = '' // allow re-picking the same file
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void loadImage(file)
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }
  function onDragLeave() {
    setDragOver(false)
  }

  // Current state as a save document (.ksig).
  const doc: SignatureDoc = {
    mode, drawW, drawH, originX, originY, penUpZ, penDownZ, feed, strokes,
  }

  // Apply a loaded document. `data` is untrusted: validate each field and keep
  // the current value for anything missing/invalid. Strokes are validated
  // point-by-point; invalid strokes are dropped rather than throwing.
  function loadDoc(data: unknown) {
    if (!isObj(data)) {
      setInfo(t('sig.info.loadInvalid', 'Could not load — file is not a valid signature document.'))
      return
    }
    if (data.mode === 'draw' || data.mode === 'image') setMode(data.mode)
    if (isNum(data.drawW)) setDrawW(data.drawW)
    if (isNum(data.drawH)) setDrawH(data.drawH)
    if (isNum(data.originX)) setOriginX(data.originX)
    if (isNum(data.originY)) setOriginY(data.originY)
    if (isNum(data.penUpZ)) setPenUpZ(data.penUpZ)
    if (isNum(data.penDownZ)) setPenDownZ(data.penDownZ)
    if (isNum(data.feed)) setFeed(data.feed)
    if (Array.isArray(data.strokes)) {
      const loaded: ScreenStroke[] = []
      for (const s of data.strokes) {
        const stroke = parseStroke(s)
        if (stroke) loaded.push(stroke)
      }
      liveStroke.current = null
      setStrokes(loaded)
    }
    setInfo(t('sig.info.docLoaded', 'Loaded signature document — preview updated.'))
  }

  // Nothing to save when there are no committed freehand strokes.
  const saveDisabled = strokes.length === 0

  // ---- color-coded setting PRESETS (size / trace / pen params, NOT strokes) ----
  // Snapshot the current generation PARAMS (no strokes, no image).
  const captureSettings = (): SignatureSettings => ({
    mode, drawW, drawH,
    threshold, invert, targetW, targetH, lockAspect, tolerance,
    originX, originY, penUpZ, penDownZ, feed,
  })
  // Restore a captured/loaded settings snapshot, coercing each field from the
  // (untrusted) source so a corrupt slot or hand-edited file can never feed a
  // NaN into the emitter. The strokes / loaded image are left untouched.
  const applySettings = (s: SignatureSettings) => {
    const o = (s ?? {}) as unknown as Record<string, unknown>
    if (o.mode === 'draw' || o.mode === 'image') setMode(o.mode)
    setDrawW((prev) => numOr(o.drawW, prev))
    setDrawH((prev) => numOr(o.drawH, prev))
    setThreshold((prev) => numOr(o.threshold, prev))
    if (typeof o.invert === 'boolean') setInvert(o.invert)
    setTargetW((prev) => numOr(o.targetW, prev))
    setTargetH((prev) => numOr(o.targetH, prev))
    if (typeof o.lockAspect === 'boolean') setLockAspect(o.lockAspect)
    setTolerance((prev) => numOr(o.tolerance, prev))
    setOriginX((prev) => numOr(o.originX, prev))
    setOriginY((prev) => numOr(o.originY, prev))
    setPenUpZ((prev) => numOr(o.penUpZ, prev))
    setPenDownZ((prev) => numOr(o.penDownZ, prev))
    setFeed((prev) => numOr(o.feed, prev))
  }
  const presets = usePresets<SignatureSettings>({
    storageKey: 'karmyogi.signature.presets',
    capture: captureSettings,
    onApply: applySettings,
  })
  // The same settings object the presets capture, also offered as a portable
  // settings-only file in the preset bar (distinct from the strokes+params
  // .ksig save in the draw toolbar above).
  const settings = captureSettings()
  // Validate a loaded settings file before applying (must be a JSON object).
  const loadSettings = (data: unknown) => {
    if (!isObj(data)) {
      setInfo(t('sig.info.settingsInvalid', 'Could not load — file is not valid signature settings.'))
      return
    }
    applySettings(data as unknown as SignatureSettings)
    setInfo(t('sig.info.settingsLoaded', 'Loaded signature settings — preview updated.'))
  }

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('sig.presets.aria', 'Signature setting presets')}
      />
    <div className="sig-panel">
      <p className="sig-intro">
        {mode === 'draw' ? (
          t('sig.intro.draw', 'Sign freehand with your mouse, stylus, or finger — your strokes become pen-plotter G-code live. Each pen-down stroke plots in order, with a safe-Z hop between strokes.')
        ) : (
          <>
            {t('sig.intro.pre', 'Upload a signature image — it is traced to vector outlines live, then sent as pen-plotter G-code. Best with a clean, high-contrast signature on white. This traces ink')}{' '}
            <strong>{t('sig.intro.outlines', 'outlines')}</strong>{' '}
            {t('sig.intro.post', '(the contour of each stroke), not its centreline.')}
          </>
        )}
      </p>

      {/* ---- Mode toggle ---- */}
      <div className="sig-modes" role="tablist" aria-label={t('sig.mode.aria', 'Signature input mode')}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'draw'}
          className={'sig-mode' + (mode === 'draw' ? ' active' : '')}
          onClick={() => setMode('draw')}
        >
          {t('sig.mode.draw', 'Draw')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'image'}
          className={'sig-mode' + (mode === 'image' ? ' active' : '')}
          onClick={() => setMode('image')}
        >
          <Icon name="camera" size={14} /> {t('sig.mode.image', 'From image')}
        </button>
      </div>

      <div className="sig-cards">
        {mode === 'draw' ? (
          <>
            {/* ============ Freehand draw surface (centerpiece) ============ */}
            <section className="sig-card sig-card-wide">
              <div className="sig-card-head">
                <h4>{t('sig.draw.title', 'Sign here')}</h4>
                <div className="sig-draw-tools">
                  <IconButton
                    type="button"
                    icon={<UndoGlyph />}
                    label={t('sig.draw.undo', 'Undo last stroke')}
                    onClick={undoStroke}
                    disabled={strokes.length === 0}
                  />
                  <IconButton
                    type="button"
                    iconName="trash"
                    iconSize={15}
                    label={t('sig.draw.clear', 'Clear all strokes')}
                    onClick={clearStrokes}
                    disabled={strokes.length === 0 && !liveStroke.current}
                  />
                  <SaveLoadButtons
                    value={doc}
                    onLoad={loadDoc}
                    fileBase="karmyogi-signature"
                    ext="ksig"
                    saveDisabled={saveDisabled}
                    saveTitle={t('sig.save', 'Save signature')}
                    loadTitle={t('sig.load', 'Load signature')}
                    onError={setInfo}
                    parseErrorMessage={(name) =>
                      t('sig.info.parseError', 'Could not read {name} — expected a .ksig (JSON) signature.', { name })
                    }
                  />
                </div>
              </div>
              <svg
                ref={drawSurfaceRef}
                className="sig-draw-surface"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                role="application"
                aria-label={t('sig.draw.aria', 'Freehand signature drawing area')}
                onPointerDown={onDrawPointerDown}
                onPointerMove={onDrawPointerMove}
                onPointerUp={onDrawPointerUp}
                onPointerCancel={onDrawPointerUp}
              >
                {drawPaths.committed.map((d, i) => (
                  <path key={i} d={d} />
                ))}
                {drawPaths.live && <path className="sig-draw-live" d={drawPaths.live} />}
                {strokes.length === 0 && !drawPaths.live && (
                  <text
                    className="sig-draw-placeholder"
                    x="50%"
                    y="50%"
                    textAnchor="middle"
                    dominantBaseline="middle"
                  >
                    {t('sig.draw.placeholder', 'Sign here with mouse / stylus / touch')}
                  </text>
                )}
              </svg>
              <div className="sig-sgrid">
                <SliderField
                  icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                  label={t('sig.drawW', 'Draw area width')}
                  htmlFor="sig-draw-w"
                  unit="mm"
                  min={1}
                  max={300}
                  step={1}
                  value={drawW}
                  onChange={(n) => setDrawW(clampNum(String(n), drawW, 1, 100000))}
                />
                <SliderField
                  icon={<MoveVertical size={14} strokeWidth={1.8} />}
                  label={t('sig.drawH', 'Draw area height')}
                  htmlFor="sig-draw-h"
                  unit="mm"
                  min={1}
                  max={300}
                  step={1}
                  value={drawH}
                  onChange={(n) => setDrawH(clampNum(String(n), drawH, 1, 100000))}
                />
              </div>
              <p className="sig-info">{info}</p>
            </section>
          </>
        ) : (
          <>
            {/* ============ Traced preview (centerpiece) ============ */}
            <section className="sig-card sig-preview-card sig-card-wide">
              <div className="sig-card-head">
                <h4>{t('sig.preview.title', 'Traced preview')}</h4>
                {previewPolys.length > 0 && (
                  <span className="sig-badge">{t('sig.preview.strokes', '{n} stroke(s)', { n: previewPolys.length })}</span>
                )}
              </div>
              <div className="sig-preview-box">
                {svg ? (
                  <svg
                    className="sig-svg"
                    viewBox={svg.viewBox}
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={t('sig.preview.aria', 'Traced signature preview')}
                  >
                    {svg.paths.map((d, i) => (
                      <path key={i} d={d} />
                    ))}
                  </svg>
                ) : (
                  <span className="sig-preview-empty">
                    {raster
                      ? t('sig.preview.noVectors', 'No vectors yet — adjust the threshold.')
                      : t('sig.preview.upload', 'Upload an image to see the live trace here.')}
                  </span>
                )}
              </div>
              <p className="sig-info">{info}</p>
            </section>

            {/* ---- Step 1: Upload ---- */}
            <section className="sig-card">
              <div className="sig-card-head">
                <h4><span className="sig-step">1</span> {t('sig.step1', 'Upload signature')}</h4>
              </div>
              <div
                className={'sig-drop' + (dragOver ? ' over' : '')}
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onClick={() => fileRef.current?.click()}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click()
                }}
              >
                {raster ? (
                  <span className="sig-drop-name" title={raster.name}>
                    {t('sig.drop.name', '{name} — {w}×{h}px', { name: raster.name, w: raster.width, h: raster.height })}
                  </span>
                ) : (
                  <span className="sig-drop-hint">
                    {t('sig.drop.hint', 'Click to choose an image, or drag & drop here')}
                  </span>
                )}
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  className="sig-file"
                  onChange={onFileChange}
                />
              </div>
            </section>

            {/* ---- Step 2: Trace + size ---- */}
            <section className="sig-card">
              <div className="sig-card-head">
                <h4><span className="sig-step">2</span> {t('sig.step2', 'Adjust')}</h4>
              </div>
              <div className="sig-sgrid">
                <SliderField
                  icon={<Contrast size={14} strokeWidth={1.8} />}
                  label={t('sig.thresholdLbl', 'Threshold')}
                  htmlFor="sig-threshold"
                  min={0}
                  max={255}
                  step={1}
                  value={threshold}
                  onChange={(n) => setThreshold(clampNum(String(n), threshold, 0, 255))}
                  title={t('sig.thresholdTip', 'Ink/background split point (0–255).')}
                />
                <SliderField
                  icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                  label={t('sig.targetW', 'Target width')}
                  htmlFor="sig-target-w"
                  unit="mm"
                  min={1}
                  max={300}
                  step={1}
                  value={targetW}
                  onChange={(n) => setTargetW(clampNum(String(n), targetW, 1, 100000))}
                />
                <SliderField
                  icon={<MoveVertical size={14} strokeWidth={1.8} />}
                  label={t('sig.targetH', 'Target height')}
                  htmlFor="sig-target-h"
                  unit="mm"
                  min={1}
                  max={300}
                  step={1}
                  value={targetH}
                  disabled={lockAspect}
                  onChange={(n) => setTargetH(clampNum(String(n), targetH, 1, 100000))}
                />
              </div>
              <div className="sig-toggles">
                <button
                  type="button"
                  className={'sig-toggle' + (invert ? ' active' : '')}
                  aria-pressed={invert}
                  onClick={() => setInvert(!invert)}
                >
                  {t('sig.invert', 'Invert (dark background)')}
                </button>
                <button
                  type="button"
                  className={'sig-toggle' + (lockAspect ? ' active' : '')}
                  aria-pressed={lockAspect}
                  onClick={() => setLockAspect(!lockAspect)}
                >
                  {t('sig.lockAspect', 'Lock aspect (fit to width)')}
                </button>
              </div>
            </section>
          </>
        )}

        {/* ---- Advanced (collapsed) — shared pen / placement params ---- */}
        <section className="sig-card sig-card-wide">
          <button
            type="button"
            className="sig-disclosure"
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
          >
            <span className="sig-caret">
              <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={12} />
            </span> {t('sig.advanced', 'Advanced')}
          </button>
          {showAdvanced && (
            <div className="sig-sgrid sig-advanced">
              {mode === 'image' && (
                <SliderField
                  icon={<Spline size={14} strokeWidth={1.8} />}
                  label={t('sig.tolerance', 'Simplify tolerance')}
                  htmlFor="sig-tolerance"
                  unit="px"
                  min={0}
                  max={20}
                  step={0.5}
                  value={tolerance}
                  onChange={(n) => setTolerance(clampNum(String(n), tolerance, 0, 1000))}
                />
              )}
              <SliderField
                icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                label={t('sig.originX', 'Origin X')}
                htmlFor="sig-origin-x"
                unit="mm"
                min={-300}
                max={300}
                step={1}
                value={originX}
                onChange={(n) => setOriginX(clampNum(String(n), originX, -100000, 100000))}
              />
              <SliderField
                icon={<MoveVertical size={14} strokeWidth={1.8} />}
                label={t('sig.originY', 'Origin Y')}
                htmlFor="sig-origin-y"
                unit="mm"
                min={-300}
                max={300}
                step={1}
                value={originY}
                onChange={(n) => setOriginY(clampNum(String(n), originY, -100000, 100000))}
              />
              <SliderField
                icon={<ArrowUpToLine size={14} strokeWidth={1.8} />}
                label={t('sig.penUpZ', 'Pen up Z')}
                htmlFor="sig-pen-up"
                unit="mm"
                min={-20}
                max={50}
                step={0.5}
                value={penUpZ}
                onChange={(n) => setPenUpZ(clampNum(String(n), penUpZ, -1000, 1000))}
              />
              <SliderField
                icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                label={t('sig.penDownZ', 'Pen down Z')}
                htmlFor="sig-pen-down"
                unit="mm"
                min={-20}
                max={50}
                step={0.5}
                value={penDownZ}
                onChange={(n) => setPenDownZ(clampNum(String(n), penDownZ, -1000, 1000))}
              />
              <SliderField
                icon={<Gauge size={14} strokeWidth={1.8} />}
                label={t('sig.feed', 'Feed')}
                htmlFor="sig-feed"
                unit="mm/min"
                min={1}
                max={10000}
                step={50}
                value={feed}
                onChange={(n) => setFeed(clampNum(String(n), feed, 1, 100000))}
              />
              {/* SAFETY: pen-down must sit BELOW pen-up (the safe-Z) or the pen
                  never lifts for travel and drags across the work. */}
              {penDownZ >= penUpZ && (
                <p className="sig-warn" role="alert">
                  <Icon name="warning" size={13} />{' '}
                  {t(
                    'sig.warn.penZ',
                    'Pen-down Z ({down}) is not below pen-up Z ({up}) — the pen will not lift for travel.',
                    { down: penDownZ, up: penUpZ },
                  )}
                </p>
              )}
            </div>
          )}
        </section>

        {/* ---- Send action bar (Send to machine / Open in Visualizer) ---- */}
        <section className="sig-card sig-card-wide">
          <div className="sig-actions">
            <button
              type="button"
              className="sig-btn primary sig-play"
              onClick={onSend}
              disabled={rawLineCount === 0 || streaming}
              title={
                connected
                  ? t('sig.send.title.on', 'Stream this program to the machine')
                  : t('sig.send.title.off', 'Connect to a machine to send')
              }
            >
              <Icon name="play" size={14} /> {t('sig.send', 'Send to machine')}
            </button>
          </div>
          {!connected && rawLineCount > 0 && (
            <p className="sig-info">{t('sig.send.live', 'Preview is live; connect a machine to send.')}</p>
          )}
        </section>

        {/* ---- Raw G-code (collapsed by default, full width) ---- */}
        <section className="sig-card sig-card-wide">
          <button
            type="button"
            className="sig-disclosure"
            onClick={() => setShowRaw(!showRaw)}
            aria-expanded={showRaw}
          >
            <span className="sig-caret">
              <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={12} />
            </span>{' '}
            {rawLineCount > 0
              ? t('sig.raw.count', 'Raw G-code ({n} lines)', { n: rawLineCount })
              : t('sig.raw', 'Raw G-code')}
          </button>
          {showRaw && (
            <textarea
              className="sig-preview-text"
              readOnly
              value={preview}
              placeholder={t('sig.raw.placeholder', 'Generated G-code will appear here.')}
              spellCheck={false}
            />
          )}
        </section>
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
            value={settings}
            onLoad={loadSettings}
            fileBase="signature-settings"
            ext="ksigset"
            saveTitle={t('sig.settings.save', 'Save signature settings')}
            loadTitle={t('sig.settings.load', 'Load signature settings')}
            onError={setInfo}
            parseErrorMessage={(name) =>
              t('sig.info.settingsParseError', 'Could not read {name} — expected .ksigset (JSON) settings.', { name })
            }
          />
        }
      />
    </div>
  )
}
