import {
  DragEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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
import { useProgram, usePersistentState } from '../store'
import { IconButton } from '../components/IconButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import '../styles/signature.css'

/** Split G-code into non-empty lines (used for the raw line count). */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/** Decoded image pixels handed to the pure tracer. */
interface Raster {
  data: Uint8ClampedArray
  width: number
  height: number
  name: string
}

/** A freehand stroke captured in surface-pixel coordinates (screen y-down). */
interface ScreenStroke {
  points: Point[]
}

/** Authoring mode for the panel. */
type Mode = 'draw' | 'image'

/**
 * The serializable Signature document saved to / loaded from a `.ksig` file
 * (plain JSON): the freehand strokes (surface-pixel space) plus the draw-size,
 * pen, origin and feed params. Image-trace state is not saved (the source image
 * isn't embedded); only the freehand drawing is portable.
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

/** Narrow an arbitrary value to a ScreenStroke ({ points: {x,y}[] }). */
function parseStroke(v: unknown): ScreenStroke | null {
  if (!isObj(v) || !Array.isArray(v.points)) return null
  const points: Point[] = []
  for (const p of v.points) {
    if (isObj(p) && isNum(p.x) && isNum(p.y)) points.push({ x: p.x, y: p.y })
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
 * Convert captured freehand strokes (surface-pixel space, y-down) into mm-space
 * polylines anchored at the origin. The signature is scaled to fit the target
 * `drawW × drawH` mm box and the Y axis is flipped (screen +Y is down, machine
 * +Y is up) so it plots the right way up.
 */
function strokesToPolylines(
  strokes: ScreenStroke[],
  surface: { w: number; h: number },
  draw: { w: number; h: number },
): Polyline[] {
  const sx = surface.w > 0 ? draw.w / surface.w : 0
  const sy = surface.h > 0 ? draw.h / surface.h : 0
  const polys: Polyline[] = []
  for (const s of strokes) {
    if (s.points.length < 2) continue
    const pl = new Polyline()
    for (const p of s.points) {
      // Scale into the mm box and flip Y so up-on-screen is up-on-machine.
      pl.add({ x: p.x * sx, y: draw.h - p.y * sy })
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
      setInfo(t('sig.info.loaded', 'Loaded "{name}" ({w}×{h}px). Adjust threshold and size below.', { name: file.name, w, h }))
    } catch (e) {
      setInfo(t('sig.info.loadFailed', 'Failed to load image: {msg}', { msg: (e as Error).message }))
    }
  }, [t])

  // Build mm-space polylines for the active mode, then emit pen G-code and push
  // it to the store. Returns the polylines (empty if there's nothing to plot).
  const buildPolys = useCallback((): Polyline[] => {
    if (mode === 'draw') {
      const surface = drawSurfaceRef.current
      const w = surface?.clientWidth ?? 1
      const h = surface?.clientHeight ?? 1
      return strokesToPolylines(strokes, { w, h }, { w: drawW, h: drawH })
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

  // Generate G-code for the current state and push it to the store.
  const generate = useCallback((): string => {
    const polys = buildPolys()
    if (polys.length === 0) {
      setProgram('signature — pen', '')
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
    setProgram('signature — pen', gcode)
    setPreview(gcode)
    setPreviewPolys(polys)

    const pts = countPoints(polys)
    const b = polysBounds(polys)
    setInfo(
      t('sig.info.result', '{strokes} stroke(s), {points} point(s) — {w}×{h} mm → Visualizer.', {
        strokes: polys.length,
        points: pts,
        w: b.w.toFixed(1),
        h: b.h.toFixed(1),
      }),
    )
    return gcode
  }, [
    buildPolys, mode, raster, originX, originY, penUpZ, penDownZ, feed, setProgram, t,
  ])

  // Live G-code: regenerate ~300ms after the last change and push to the store
  // so the Visualizer updates without a manual step.
  useEffect(() => {
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
  }, [generate])

  // ---- Freehand pointer handlers (mouse + stylus + touch via Pointer Events) ----
  const localPoint = useCallback((e: ReactPointerEvent<SVGSVGElement>): Point => {
    const el = drawSurfaceRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
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

  // Committed + in-progress strokes as SVG paths in surface-pixel space (y-down,
  // no flip — this is the live drawing canvas, not the machine preview).
  const drawPaths = useMemo(() => {
    void liveStrokeTick // re-render while a stroke is in progress
    const toPath = (points: Point[]): string =>
      points.length < 2
        ? ''
        : points
            .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
            .join(' ')
    const committed = strokes.map((s) => toPath(s.points)).filter(Boolean)
    const live = liveStroke.current ? toPath(liveStroke.current) : ''
    return { committed, live }
  }, [strokes, liveStrokeTick])

  const rawLineCount = useMemo(
    () => (preview.length > 0 ? gcodeLines(preview).length : 0),
    [preview],
  )

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
    setInfo(t('sig.info.loaded', 'Loaded signature document — preview updated.'))
  }

  // Nothing to save when there are no committed freehand strokes.
  const saveDisabled = strokes.length === 0

  return (
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
          ✎ {t('sig.mode.draw', 'Draw')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'image'}
          className={'sig-mode' + (mode === 'image' ? ' active' : '')}
          onClick={() => setMode('image')}
        >
          🖼 {t('sig.mode.image', 'From image')}
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
                    icon="⎌"
                    label={t('sig.draw.undo', 'Undo last stroke')}
                    onClick={undoStroke}
                    disabled={strokes.length === 0}
                  />
                  <IconButton
                    type="button"
                    icon="✕"
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
                  />
                </div>
              </div>
              <svg
                ref={drawSurfaceRef}
                className="sig-draw-surface"
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
              <div className="sig-fields">
                <label className="sig-field">
                  <span>{t('sig.drawW', 'Draw area width')}</span>
                  <span className="sig-input">
                    <input type="number" inputMode="decimal" min={1} step={1} value={drawW}
                      onChange={(e) => setDrawW(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="sig-field">
                  <span>{t('sig.drawH', 'Draw area height')}</span>
                  <span className="sig-input">
                    <input type="number" inputMode="decimal" min={1} step={1} value={drawH}
                      onChange={(e) => setDrawH(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
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
              <label className="sig-field sig-field-range">
                <span>{t('sig.threshold', 'Threshold ({n})', { n: threshold })}</span>
                <input
                  type="range"
                  min={0}
                  max={255}
                  step={1}
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                />
              </label>
              <div className="sig-fields">
                <label className="sig-field">
                  <span>{t('sig.targetW', 'Target width')}</span>
                  <span className="sig-input">
                    <input type="number" inputMode="decimal" min={1} step={1} value={targetW}
                      onChange={(e) => setTargetW(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
                <label className="sig-field">
                  <span>{t('sig.targetH', 'Target height')}</span>
                  <span className="sig-input">
                    <input type="number" inputMode="decimal" min={1} step={1} value={targetH}
                      disabled={lockAspect}
                      onChange={(e) => setTargetH(Number(e.target.value))} />
                    <em>mm</em>
                  </span>
                </label>
              </div>
              <div className="sig-checks">
                <label className="sig-field sig-check">
                  <input
                    type="checkbox"
                    checked={invert}
                    onChange={(e) => setInvert(e.target.checked)}
                  />
                  <span>{t('sig.invert', 'Invert (dark background)')}</span>
                </label>
                <label className="sig-field sig-check">
                  <input
                    type="checkbox"
                    checked={lockAspect}
                    onChange={(e) => setLockAspect(e.target.checked)}
                  />
                  <span>{t('sig.lockAspect', 'Lock aspect (fit to width)')}</span>
                </label>
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
            <span className="sig-caret">{showAdvanced ? '▾' : '▸'}</span> {t('sig.advanced', 'Advanced')}
          </button>
          {showAdvanced && (
            <div className="sig-fields sig-advanced">
              {mode === 'image' && (
                <label className="sig-field">
                  <span>{t('sig.tolerance', 'Simplify tolerance')}</span>
                  <span className="sig-input">
                    <input type="number" inputMode="decimal" min={0} step={0.5} value={tolerance}
                      onChange={(e) => setTolerance(Number(e.target.value))} />
                    <em>px</em>
                  </span>
                </label>
              )}
              <label className="sig-field">
                <span>{t('sig.originX', 'Origin X')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" step={1} value={originX}
                    onChange={(e) => setOriginX(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="sig-field">
                <span>{t('sig.originY', 'Origin Y')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" step={1} value={originY}
                    onChange={(e) => setOriginY(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="sig-field">
                <span>{t('sig.penUpZ', 'Pen up Z')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penUpZ}
                    onChange={(e) => setPenUpZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="sig-field">
                <span>{t('sig.penDownZ', 'Pen down Z')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" step={0.5} value={penDownZ}
                    onChange={(e) => setPenDownZ(Number(e.target.value))} />
                  <em>mm</em>
                </span>
              </label>
              <label className="sig-field">
                <span>{t('sig.feed', 'Feed')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" min={1} step={50} value={feed}
                    onChange={(e) => setFeed(Number(e.target.value))} />
                  <em>mm/min</em>
                </span>
              </label>
            </div>
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
            <span className="sig-caret">{showRaw ? '▾' : '▸'}</span>{' '}
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
  )
}
