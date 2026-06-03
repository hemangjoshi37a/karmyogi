import {
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useT } from '../i18n'
import { Polyline } from '../core/geometry'
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
import '../styles/signature.css'

/** Split G-code into non-empty lines for streaming to the controller. */
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
 * Signature panel. Upload (or drag-drop) a signature image, vectorize it by
 * tracing the ink contours, scale it to a target mm box, and emit pen-plotter
 * G-code (Z = pen up/down) that is pushed to the program store for 3D preview
 * and streaming to the machine.
 */
export function SignaturePanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const connected = useMachine((s) => s.connection === 'connected')

  // Essential controls.
  const [threshold, setThreshold] = usePersistentState('karmyogi.sig.threshold', 128)
  const [invert, setInvert] = usePersistentState('karmyogi.sig.invert', false)
  const [targetW, setTargetW] = usePersistentState('karmyogi.sig.targetW', 60)
  const [targetH, setTargetH] = usePersistentState('karmyogi.sig.targetH', 30)
  const [lockAspect, setLockAspect] = usePersistentState('karmyogi.sig.lockAspect', true)
  // Advanced controls.
  const [tolerance, setTolerance] = usePersistentState('karmyogi.sig.tolerance', 1.5)
  const [originX, setOriginX] = usePersistentState('karmyogi.sig.originX', 0)
  const [originY, setOriginY] = usePersistentState('karmyogi.sig.originY', 0)
  const [penUpZ, setPenUpZ] = usePersistentState('karmyogi.sig.penUpZ', 5)
  const [penDownZ, setPenDownZ] = usePersistentState('karmyogi.sig.penDownZ', 0)
  const [feed, setFeed] = usePersistentState('karmyogi.sig.feed', 1500)
  const [showAdvanced, setShowAdvanced] = usePersistentState('karmyogi.sig.showAdvanced', false)
  const [showRaw, setShowRaw] = usePersistentState('karmyogi.sig.showRaw', false)

  const [raster, setRaster] = useState<Raster | null>(null)
  const [info, setInfo] = useState(() => t('sig.info.start', 'Upload a signature image to begin.'))
  const [preview, setPreview] = useState('')
  const [previewPolys, setPreviewPolys] = useState<Polyline[]>([])
  const [dragOver, setDragOver] = useState(false)

  const previewRef = useRef('')
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

  // Trace + simplify + fit, then emit pen G-code and push it to the store.
  const generate = useCallback((): string => {
    if (!raster) {
      setPreview('')
      setPreviewPolys([])
      previewRef.current = ''
      return ''
    }
    const contours = traceBitmap(raster.data, raster.width, raster.height, {
      threshold,
      invert,
    })
    if (contours.length === 0) {
      setInfo(t('sig.info.noInk', 'No ink detected — try adjusting the threshold or toggling Invert.'))
      setPreview('')
      setPreviewPolys([])
      previewRef.current = ''
      return ''
    }

    // Simplify in PIXEL space (tolerance is in px), then scale to mm.
    const simplified = contours.map((c) => simplifyPolyline(c, tolerance))
    // When aspect is locked, fitPolylinesToSize already preserves aspect; pass a
    // generous height so width is the binding dimension.
    const fitH = lockAspect ? targetW * 1000 : targetH
    const mm = fitPolylinesToSize(simplified, targetW, fitH, true)

    const gcode = polylinesToGcode(
      mm,
      { x: originX, y: originY },
      { penUpZ, penDownZ, feedXY: feed },
    )
    setProgram('signature — pen', gcode)
    setPreview(gcode)
    setPreviewPolys(mm)
    previewRef.current = gcode

    const pts = countPoints(mm)
    const b = polysBounds(mm)
    setInfo(
      t('sig.info.result', '{strokes} stroke(s), {points} point(s) — {w}×{h} mm → Visualizer.', {
        strokes: mm.length,
        points: pts,
        w: b.w.toFixed(1),
        h: b.h.toFixed(1),
      }),
    )
    return gcode
  }, [
    raster, threshold, invert, tolerance, targetW, targetH, lockAspect,
    originX, originY, penUpZ, penDownZ, feed, setProgram, t,
  ])

  // Live G-code: regenerate ~300ms after the last change and push to the store
  // so the Visualizer updates without a manual step.
  useEffect(() => {
    if (!raster) return
    if (liveTimer.current) clearTimeout(liveTimer.current)
    liveTimer.current = setTimeout(() => generate(), 300)
    return () => {
      if (liveTimer.current) clearTimeout(liveTimer.current)
    }
  }, [generate, raster])

  // Stream the freshly-generated program to the machine.
  const play = useCallback(() => {
    const gcode = previewRef.current || generate()
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected) return
    grbl.startProgram(lines)
  }, [generate, connected])

  // SVG preview viewBox + path data for the traced mm-space polylines.
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

  return (
    <div className="sig-panel">
      <div className="sig-layout">
      {/* ============ Preview (centerpiece) — top on narrow, right on wide ============ */}
      <div className="sig-preview-col">
        <section className="sig-card sig-preview-card">
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
      </div>

      {/* ============ Controls — bottom on narrow, left on wide ============ */}
      <div className="sig-controls-col">
        <p className="sig-intro">
          {t('sig.intro.pre', 'Upload a signature image — it is traced to vector outlines live, then sent as pen-plotter G-code. Best with a clean, high-contrast signature on white. This traces ink')}{' '}
          <strong>{t('sig.intro.outlines', 'outlines')}</strong>{' '}
          {t('sig.intro.post', '(the contour of each stroke), not its centreline.')}
        </p>

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
          <div className="sig-grid">
            <label className="sig-field sig-field-wide">
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
            <label className="sig-field sig-check">
              <input
                type="checkbox"
                checked={invert}
                onChange={(e) => setInvert(e.target.checked)}
              />
              <span>{t('sig.invert', 'Invert (dark background)')}</span>
            </label>
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
            <label className="sig-field sig-check sig-field-wide">
              <input
                type="checkbox"
                checked={lockAspect}
                onChange={(e) => setLockAspect(e.target.checked)}
              />
              <span>{t('sig.lockAspect', 'Lock aspect (fit to width)')}</span>
            </label>
          </div>
        </section>

        {/* ---- Advanced (collapsed) ---- */}
        <section className="sig-card">
          <button
            type="button"
            className="sig-disclosure"
            onClick={() => setShowAdvanced(!showAdvanced)}
            aria-expanded={showAdvanced}
          >
            <span className="sig-caret">{showAdvanced ? '▾' : '▸'}</span> {t('sig.advanced', 'Advanced')}
          </button>
          {showAdvanced && (
            <div className="sig-grid sig-advanced">
              <label className="sig-field">
                <span>{t('sig.tolerance', 'Simplify tolerance')}</span>
                <span className="sig-input">
                  <input type="number" inputMode="decimal" min={0} step={0.5} value={tolerance}
                    onChange={(e) => setTolerance(Number(e.target.value))} />
                  <em>px</em>
                </span>
              </label>
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

        {/* ---- Step 3: Send ---- */}
        <section className="sig-card">
          <div className="sig-actions">
            <button
              type="button"
              className="sig-btn primary sig-play"
              onClick={play}
              disabled={!connected || preview.length === 0}
              title={connected ? t('sig.send.title.on', 'Stream this program to the machine') : t('sig.send.title.off', 'Connect to a machine to send')}
            >
              {t('sig.send', '▶ Send to machine')}
            </button>
            <button
              type="button"
              className="sig-btn sig-regen"
              onClick={generate}
              disabled={!raster}
              title={t('sig.regen.title', 'Regenerate now')}
            >
              ↻
            </button>
          </div>
          {!connected && preview.length > 0 && (
            <p className="sig-info">{t('sig.send.live', 'Preview is live; connect a machine to send.')}</p>
          )}
        </section>

        {/* ---- Raw G-code (collapsed by default) ---- */}
        <section className="sig-card">
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
    </div>
  )
}
