import { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../i18n'
import { useProgram, usePersistentState } from '../store'
import { IconButton } from '../components/IconButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import {
  defaultGlueParams,
  generateGlue,
  shapeToPolyline,
  type GlueParams,
  type GlueShape,
} from '../core/glue'
import '../styles/glue.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** Bed size in mm (bottom-left = machine origin [0,0]). */
const BED = { w: 300, h: 200 }
/** SVG padding (px) around the bed so the border/grid is visible. */
const PAD = 6

type Tool = 'select' | 'line' | 'triangle' | 'circle' | 'rect'

/**
 * Tool buttons: glyph + label, in the order they appear in the toolbar. The
 * label/hint strings are the English fallbacks; `key` is the i18n key suffix so
 * render sites can translate (this array is module-level, outside any hook).
 */
const TOOLS: { id: Tool; glyph: string; key: string; label: string; hint: string }[] = [
  { id: 'select', glyph: '↖', key: 'select', label: 'Select', hint: 'Select / move a shape' },
  { id: 'line', glyph: '╱', key: 'line', label: 'Line', hint: 'Draw a straight bead' },
  { id: 'triangle', glyph: '△', key: 'triangle', label: 'Triangle', hint: 'Draw a triangle outline' },
  { id: 'circle', glyph: '◯', key: 'circle', label: 'Circle', hint: 'Draw a circle' },
  { id: 'rect', glyph: '▭', key: 'rect', label: 'Rect', hint: 'Draw a rectangle' },
]

/** A point in machine (bed) coordinates: X right, Y up, origin bottom-left. */
interface Pt {
  x: number
  y: number
}

/** In-progress drag from pointer-down to the current pointer position. */
interface Drag {
  tool: Exclude<Tool, 'select'>
  start: Pt
  current: Pt
}

/**
 * In-progress move of an existing shape (Select tool). We snapshot the shape as
 * it was at pointer-down (`orig`) so deltas are always applied to the original
 * geometry, never to already-moved (stale) state.
 */
interface MoveDrag {
  id: string
  start: Pt
  orig: GlueShape
}

/** The defaults used when a shape has zero drag distance (a plain click). */
const MIN_SIZE = 8

let shapeSeq = 0
function nextId(): string {
  return `g${Date.now().toString(36)}_${(shapeSeq++).toString(36)}`
}

/** A shape plus a stable id for selection/keys. */
interface IdShape {
  id: string
  shape: GlueShape
}

/**
 * Build a shape from a drag (down → up) for the given drawing tool. The triangle
 * default is an isoceles triangle inscribed in the drag bounding-box.
 */
function shapeFromDrag(tool: Exclude<Tool, 'select'>, a: Pt, b: Pt): GlueShape | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy)
  switch (tool) {
    case 'line': {
      if (dist < MIN_SIZE) return null
      return { kind: 'line', x1: a.x, y1: a.y, x2: b.x, y2: b.y }
    }
    case 'circle': {
      const r = dist < MIN_SIZE ? MIN_SIZE : dist // drag = centre→edge radius
      return { kind: 'circle', cx: a.x, cy: a.y, r }
    }
    case 'rect': {
      const x = Math.min(a.x, b.x)
      const y = Math.min(a.y, b.y)
      const w = Math.abs(dx) < MIN_SIZE ? MIN_SIZE : Math.abs(dx)
      const h = Math.abs(dy) < MIN_SIZE ? MIN_SIZE : Math.abs(dy)
      return { kind: 'rect', x, y, w, h }
    }
    case 'triangle': {
      const x0 = Math.min(a.x, b.x)
      const y0 = Math.min(a.y, b.y)
      const w = Math.abs(dx) < MIN_SIZE ? MIN_SIZE : Math.abs(dx)
      const h = Math.abs(dy) < MIN_SIZE ? MIN_SIZE : Math.abs(dy)
      // Apex centred at top of the bbox, base along the bottom.
      return {
        kind: 'triangle',
        points: [
          { x: x0 + w / 2, y: y0 + h },
          { x: x0, y: y0 },
          { x: x0 + w, y: y0 },
        ],
      }
    }
  }
}

/** Return a copy of `shape` translated by (dx, dy) in machine mm. */
function translateShape(shape: GlueShape, dx: number, dy: number): GlueShape {
  switch (shape.kind) {
    case 'line':
      return { ...shape, x1: shape.x1 + dx, y1: shape.y1 + dy, x2: shape.x2 + dx, y2: shape.y2 + dy }
    case 'circle':
      return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy }
    case 'rect':
      return { ...shape, x: shape.x + dx, y: shape.y + dy }
    case 'triangle':
      return {
        ...shape,
        points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) as [Pt, Pt, Pt],
      }
  }
}

/** Round-to-int mm string used by the tiny in-canvas dimension labels. */
const mm = (v: number): string => Math.round(v).toString()

/**
 * Tiny in-canvas dimension annotation for a shape: a short text plus the anchor
 * point (machine coords) at which to draw it. Mirrors the shape-list summary but
 * lives on the bed near the shape so the geometry reads at a glance.
 *   line → `L 53`, circle → `r 12`, rect → `40 × 25`, triangle → `△ 40`.
 */
interface DimLabel {
  text: string
  /** Anchor in machine coords (X right, Y up). */
  x: number
  y: number
}

function shapeDim(shape: GlueShape): DimLabel {
  switch (shape.kind) {
    case 'line': {
      const len = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1)
      return { text: `L ${mm(len)}`, x: (shape.x1 + shape.x2) / 2, y: (shape.y1 + shape.y2) / 2 }
    }
    case 'circle':
      return { text: `r ${mm(shape.r)}`, x: shape.cx, y: shape.cy + shape.r }
    case 'rect':
      return { text: `${mm(shape.w)} × ${mm(shape.h)}`, x: shape.x + shape.w / 2, y: shape.y + shape.h }
    case 'triangle': {
      const xs = shape.points.map((p) => p.x)
      const ys = shape.points.map((p) => p.y)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const maxY = Math.max(...ys)
      return { text: `△ ${mm(maxX - minX)}`, x: (minX + maxX) / 2, y: maxY }
    }
  }
}

/** Bottom-left (X,Y) origin of a shape, for the selected-shape readout. */
function shapeOrigin(shape: GlueShape): Pt {
  switch (shape.kind) {
    case 'line':
      return { x: Math.min(shape.x1, shape.x2), y: Math.min(shape.y1, shape.y2) }
    case 'circle':
      return { x: shape.cx - shape.r, y: shape.cy - shape.r }
    case 'rect':
      return { x: shape.x, y: shape.y }
    case 'triangle':
      return { x: Math.min(...shape.points.map((p) => p.x)), y: Math.min(...shape.points.map((p) => p.y)) }
  }
}

type GlueDocParams = Partial<Omit<GlueParams, 'programName' | 'metric'>>

/**
 * The serializable Glue document saved to / loaded from a `.kglue` file (plain
 * JSON): the drawn shapes plus the dispenser/motion params.
 */
interface GlueDoc {
  shapes: IdShape[]
  params: GlueDocParams
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Validate one stored point ({x,y} numbers). */
function isPt(v: unknown): v is Pt {
  return isObj(v) && isNum(v.x) && isNum(v.y)
}

/** Narrow an arbitrary value to a valid GlueShape, or null if malformed. */
function parseShape(v: unknown): GlueShape | null {
  if (!isObj(v)) return null
  switch (v.kind) {
    case 'line':
      return isNum(v.x1) && isNum(v.y1) && isNum(v.x2) && isNum(v.y2)
        ? { kind: 'line', x1: v.x1, y1: v.y1, x2: v.x2, y2: v.y2 }
        : null
    case 'circle':
      return isNum(v.cx) && isNum(v.cy) && isNum(v.r)
        ? { kind: 'circle', cx: v.cx, cy: v.cy, r: v.r }
        : null
    case 'rect':
      return isNum(v.x) && isNum(v.y) && isNum(v.w) && isNum(v.h)
        ? { kind: 'rect', x: v.x, y: v.y, w: v.w, h: v.h }
        : null
    case 'triangle':
      return Array.isArray(v.points) && v.points.length === 3 && v.points.every(isPt)
        ? { kind: 'triangle', points: [v.points[0], v.points[1], v.points[2]] as [Pt, Pt, Pt] }
        : null
    default:
      return null
  }
}

/** Validate the params object, keeping only finite numeric known fields. */
function parseGlueParams(v: unknown): GlueDocParams {
  const out: GlueDocParams = {}
  if (!isObj(v)) return out
  const keys = [
    'travelZ', 'dispenseZ', 'feed', 'plungeFeed', 'dispenseRate', 'settleMs',
    'postDwellMs', 'decimals',
  ] as const
  for (const k of keys) if (isNum(v[k])) out[k] = v[k]
  return out
}

/** Short human label for a shape kind, for the shape list. */
function shapeSummary(shape: GlueShape, t: ReturnType<typeof useT>): string {
  switch (shape.kind) {
    case 'line':
      return t('glue.summary.line', 'Line · {len} mm', {
        len: Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1).toFixed(0),
      })
    case 'circle':
      return t('glue.summary.circle', 'Circle · r {r} mm', { r: shape.r.toFixed(0) })
    case 'rect':
      return t('glue.summary.rect', 'Rect · {w} × {h} mm', {
        w: shape.w.toFixed(0),
        h: shape.h.toFixed(0),
      })
    case 'triangle':
      return t('glue.summary.triangle', 'Triangle')
  }
}

/**
 * Glue-Dispense panel. An interactive SVG canvas (the bed) lets the user draw
 * line / triangle / circle / rectangle trajectories; the pure `generateGlue`
 * core turns each shape's outline into a safe program where the spindle output
 * drives the glue dispenser (M3 = on, M5 = off). The program is pushed live to
 * the shared program store so the 3D Visualizer previews the trajectories.
 */
export function GluePanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)

  const [shapes, setShapes] = usePersistentState<IdShape[]>('karmyogi.glue.shapes', [])
  const [storedParams, setParams] = usePersistentState<
    Partial<Omit<GlueParams, 'programName' | 'metric'>>
  >('karmyogi.glue.params', (() => {
    const d = defaultGlueParams()
    return {
      travelZ: d.travelZ,
      dispenseZ: d.dispenseZ,
      feed: d.feed,
      plungeFeed: d.plungeFeed,
      dispenseRate: d.dispenseRate,
      settleMs: d.settleMs,
      postDwellMs: d.postDwellMs,
      decimals: d.decimals,
    }
  })())
  // Merge over the core defaults so params persisted before a field existed
  // (e.g. `decimals`) still resolve to a real number rather than `undefined`.
  const params = useMemo(() => {
    const d = defaultGlueParams()
    return {
      travelZ: storedParams.travelZ ?? d.travelZ,
      dispenseZ: storedParams.dispenseZ ?? d.dispenseZ,
      feed: storedParams.feed ?? d.feed,
      plungeFeed: storedParams.plungeFeed ?? d.plungeFeed,
      dispenseRate: storedParams.dispenseRate ?? d.dispenseRate,
      settleMs: storedParams.settleMs ?? d.settleMs,
      postDwellMs: storedParams.postDwellMs ?? d.postDwellMs,
      decimals: storedParams.decimals ?? d.decimals,
    }
  }, [storedParams])

  const [tool, setTool] = useState<Tool>('rect')
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [moveDrag, setMoveDrag] = useState<MoveDrag | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // --- coordinate conversion (screen px ⇄ machine mm) ---
  // SVG viewBox is in mm with screen-down Y; we flip Y so bed [0,0] is bottom-left.
  function screenToBed(clientX: number, clientY: number): Pt {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    // viewBox spans (-PAD .. BED.w+PAD) wide and (-PAD .. BED.h+PAD) tall in mm.
    const vbW = BED.w + PAD * 2
    const vbH = BED.h + PAD * 2
    const mmX = (clientX - rect.left) / rect.width * vbW - PAD
    const mmYDown = (clientY - rect.top) / rect.height * vbH - PAD
    return { x: clampX(mmX), y: clampY(BED.h - mmYDown) }
  }
  const clampX = (x: number) => Math.max(0, Math.min(BED.w, x))
  const clampY = (y: number) => Math.max(0, Math.min(BED.h, y))
  /** Machine-Y (up) → SVG-Y (down). */
  const sy = (y: number) => BED.h - y

  // --- shape CRUD ---
  function addShape(s: GlueShape) {
    const id = nextId()
    setShapes((prev) => [...prev, { id, shape: s }])
    setSelected(id)
  }
  function deleteShape(id: string) {
    setShapes((prev) => prev.filter((s) => s.id !== id))
    setSelected((s) => (s === id ? null : s))
  }
  function updateShape(id: string, shape: GlueShape) {
    setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, shape } : s)))
  }

  // --- pointer interaction ---
  // All pointer events for both drawing and moving are captured on the SVG so
  // the gesture keeps tracking even when the cursor leaves the shape/canvas.
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    const p = screenToBed(e.clientX, e.clientY)
    svgRef.current?.setPointerCapture?.(e.pointerId)
    if (tool === 'select') {
      // A down on empty canvas (not on a shape, which begins a move via
      // beginMove + stopPropagation) clears the current selection.
      setSelected(null)
      return
    }
    setDrag({ tool, start: p, current: p })
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = screenToBed(e.clientX, e.clientY)
    if (moveDrag) {
      const dx = p.x - moveDrag.start.x
      const dy = p.y - moveDrag.start.y
      // Apply the delta to the snapshot taken at pointer-down, never to the
      // (already-translated) live shape — avoids drift/stale-state bugs.
      updateShape(moveDrag.id, translateShape(moveDrag.orig, dx, dy))
      return
    }
    if (drag) setDrag({ ...drag, current: p })
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    svgRef.current?.releasePointerCapture?.(e.pointerId)
    if (moveDrag) {
      setMoveDrag(null)
      return
    }
    if (!drag) return
    const s = shapeFromDrag(drag.tool, drag.start, screenToBed(e.clientX, e.clientY))
    setDrag(null)
    if (s) addShape(s)
  }
  // Begin moving an existing shape (select tool). Snapshots the shape so move
  // deltas are applied to its original geometry.
  function beginMove(e: React.PointerEvent<SVGPathElement>, id: string, shape: GlueShape) {
    e.stopPropagation()
    setSelected(id)
    setTool('select')
    svgRef.current?.setPointerCapture?.(e.pointerId)
    setMoveDrag({ id, start: screenToBed(e.clientX, e.clientY), orig: shape })
  }

  // --- render helpers: a shape's SVG path (in screen coords) ---
  function shapePath(shape: GlueShape): string {
    const pl = shapeToPolyline(shape)
    if (pl.points.length === 0) return ''
    const segs = pl.points.map((pp, i) => `${i === 0 ? 'M' : 'L'}${pp.x} ${sy(pp.y)}`)
    return segs.join(' ') + (pl.closed ? ' Z' : '')
  }

  // Preview path for the in-progress drag.
  const dragShape = useMemo(
    () => (drag ? shapeFromDrag(drag.tool, drag.start, drag.current) : null),
    [drag],
  )

  // --- live G-code generation + store push (debounced) ---
  const gcode = useMemo(
    () => generateGlue(shapes.map((s) => s.shape), { ...params }),
    [shapes, params],
  )
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])

  useEffect(() => {
    if (shapes.length === 0) return
    const id = window.setTimeout(() => setProgram('glue', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, shapes.length, setProgram])

  // Keyboard delete for the selected shape.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected) {
        const el = document.activeElement
        if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA'))
          return
        deleteShape(selected)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  const selectedShape = shapes.find((s) => s.id === selected) ?? null

  // Current state as a save document (.kglue).
  const doc: GlueDoc = { shapes, params }

  // Apply a loaded document. `data` is untrusted: validate the shapes array and
  // params, dropping anything malformed. Fresh ids are assigned so keys stay
  // unique regardless of what the file contained.
  function loadDoc(data: unknown) {
    if (!isObj(data) || !Array.isArray(data.shapes)) {
      setLoadError(t('glue.load.invalid', 'Could not load — file is not a valid glue document.'))
      return
    }
    const loaded: IdShape[] = []
    for (const raw of data.shapes) {
      const shape = parseShape(isObj(raw) && 'shape' in raw ? raw.shape : raw)
      if (shape) loaded.push({ id: nextId(), shape })
    }
    setShapes(loaded)
    setParams(parseGlueParams(data.params))
    setSelected(null)
    setLoadError(null)
  }

  const hint =
    tool === 'select'
      ? t('glue.hint.select', 'Drag a shape to move it · Delete removes the selected one')
      : tool === 'circle'
        ? t('glue.hint.circle', 'Drag from the centre outwards to set the radius')
        : tool === 'line'
          ? t('glue.hint.line', 'Drag from one end of the bead to the other')
          : t('glue.hint.box', 'Drag a bounding box on the bed')

  return (
    <div className="gp-panel">
      {/* One-line intro / flow */}
      <p className="gp-intro">
        {t('glue.intro.pre', 'Pick a shape and draw it on the bed.')}{' '}
        {t('glue.intro.post', 'The G-code updates live in the Program tab — run it from there.')}
      </p>
      {loadError && (
        <p className="gp-intro" role="alert">
          {loadError}
        </p>
      )}

      <div className="gp-body">
        {/* === Canvas column (the centerpiece) === */}
        <div className="gp-stage">
          {/* Shape-tool icon toolbar */}
          <div className="gp-toolbar" role="toolbar" aria-label={t('glue.toolbar.aria', 'Drawing tools')}>
            {TOOLS.map((tl) => {
              const label = t(`glue.tool.${tl.key}.label`, tl.label)
              const hint = t(`glue.tool.${tl.key}.hint`, tl.hint)
              return (
                <button
                  key={tl.id}
                  className={tool === tl.id ? 'gp-tool gp-tool-on' : 'gp-tool'}
                  onClick={() => setTool(tl.id)}
                  aria-pressed={tool === tl.id}
                  aria-label={label}
                  title={`${label} · ${hint}`}
                >
                  <span className="gp-tool-glyph" aria-hidden="true">
                    {tl.glyph}
                  </span>
                </button>
              )
            })}
            <span className="gp-spacer" />
            <IconButton
              className="gp-clear"
              icon="🗑"
              label={`${t('glue.clear', 'Clear')} · ${t('glue.clear.title', 'Remove all shapes')}`}
              onClick={() => setShapes([])}
              disabled={shapes.length === 0}
            />
            <SaveLoadButtons
              value={doc}
              onLoad={loadDoc}
              fileBase="karmyogi-glue"
              ext="kglue"
              saveDisabled={shapes.length === 0}
              saveTitle={t('glue.save', 'Save glue drawing')}
              loadTitle={t('glue.load', 'Load glue drawing')}
              onError={setLoadError}
            />
          </div>

          {/* Drawing canvas (the bed) */}
          <div className="gp-canvas-wrap">
            <svg
              ref={svgRef}
              className={`gp-canvas gp-tool-${tool}`}
              viewBox={`${-PAD} ${-PAD} ${BED.w + PAD * 2} ${BED.h + PAD * 2}`}
              preserveAspectRatio="xMidYMid meet"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                setDrag(null)
                setMoveDrag(null)
              }}
            >
              {/* Bed border */}
              <rect className="gp-bed" x={0} y={0} width={BED.w} height={BED.h} />
              {/* Grid every 20mm */}
              {Array.from({ length: Math.floor(BED.w / 20) + 1 }, (_, i) => i * 20).map((gx) => (
                <line key={`vx${gx}`} className="gp-grid" x1={gx} y1={0} x2={gx} y2={BED.h} />
              ))}
              {Array.from({ length: Math.floor(BED.h / 20) + 1 }, (_, i) => i * 20).map((gy) => (
                <line key={`hy${gy}`} className="gp-grid" x1={0} y1={sy(gy)} x2={BED.w} y2={sy(gy)} />
              ))}
              {/* Origin marker (bottom-left = machine [0,0]) */}
              <circle className="gp-origin" cx={0} cy={sy(0)} r={2.5} />

              {/* Existing shapes. In select mode the path itself starts a
                  move-drag (and is a fat invisible hit-target for easy grabbing). */}
              {shapes.map(({ id, shape }) => {
                const isSel = id === selected
                const dim = shapeDim(shape)
                return (
                  <g key={id}>
                    {/* Wide transparent hit area so thin lines are easy to grab. */}
                    <path
                      className={tool === 'select' ? 'gp-hit gp-hit-grab' : 'gp-hit'}
                      d={shapePath(shape)}
                      onPointerDown={(e) => {
                        if (tool === 'select') beginMove(e, id, shape)
                      }}
                    />
                    <path
                      className={isSel ? 'gp-shape gp-shape-sel' : 'gp-shape'}
                      d={shapePath(shape)}
                      pointerEvents="none"
                    />
                    {/* Tiny live size annotation (brighter for the selected shape). */}
                    <text
                      className={isSel ? 'gp-dim gp-dim-sel' : 'gp-dim'}
                      x={dim.x}
                      y={sy(dim.y) - 2}
                      textAnchor="middle"
                      pointerEvents="none"
                    >
                      {dim.text}
                    </text>
                  </g>
                )
              })}

              {/* In-progress drag preview */}
              {dragShape && (
                <>
                  <path className="gp-shape gp-shape-draft" d={shapePath(dragShape)} />
                  {(() => {
                    const dim = shapeDim(dragShape)
                    return (
                      <text className="gp-dim gp-dim-sel" x={dim.x} y={sy(dim.y) - 2} textAnchor="middle">
                        {dim.text}
                      </text>
                    )
                  })()}
                </>
              )}
            </svg>
            <div className="gp-hint">
              <span>{hint}</span>
              <span className="gp-meta">
                {shapes.length === 1
                  ? t('glue.count.one', '{n} shape', { n: shapes.length })
                  : t('glue.count.many', '{n} shapes', { n: shapes.length })}
              </span>
            </div>
          </div>
        </div>

        {/* === Controls column (vertical scroll only) === */}
        <div className="gp-controls">
          {/* Control / param cards tile to fill width at wide container sizes,
             collapsing to a single column when the panel is narrow. */}
          <div className="gp-cards">
          {/* Shape list */}
          <section className="gp-card gp-card-wide">
            <h3 className="gp-card-title">{t('glue.shapes.title', 'Shapes')}</h3>
            {shapes.length === 0 ? (
              <p className="gp-empty">{t('glue.shapes.empty', 'No shapes yet — draw one on the bed.')}</p>
            ) : (
              <ul className="gp-list">
                {shapes.map(({ id, shape }) => (
                  <li
                    key={id}
                    className={id === selected ? 'gp-list-item gp-list-sel' : 'gp-list-item'}
                  >
                    <button
                      className="gp-list-pick"
                      onClick={() => {
                        setTool('select')
                        setSelected(id)
                      }}
                      title={t('glue.list.pick.title', 'Select this shape')}
                    >
                      <span className="gp-list-glyph" aria-hidden="true">
                        {TOOLS.find((tl) => tl.id === shape.kind)?.glyph ?? '•'}
                      </span>
                      {shapeSummary(shape, t)}
                    </button>
                    <IconButton
                      className="gp-del"
                      icon="✕"
                      label={t('glue.list.delete.title', 'Delete shape')}
                      onClick={() => deleteShape(id)}
                    />
                  </li>
                ))}
              </ul>
            )}

            {/* Inline numeric editor for the selected shape */}
            {selectedShape && (
              <div className="gp-edit">
                <span className="gp-edit-label">
                  {t('glue.edit.label', 'Edit · {kind} (mm)', {
                    kind: t(`glue.kind.${selectedShape.shape.kind}`, selectedShape.shape.kind),
                  })}
                </span>
                {/* Compact dimension readout for the selected shape. */}
                {(() => {
                  const o = shapeOrigin(selectedShape.shape)
                  const dim = shapeDim(selectedShape.shape)
                  return (
                    <span className="gp-dim-readout">
                      <span className="gp-dim-xy">X {mm(o.x)} · Y {mm(o.y)}</span>
                      <span className="gp-dim-size">{dim.text}</span>
                    </span>
                  )
                })()}
                <div className="gp-fields">
                  <ShapeEditor
                    shape={selectedShape.shape}
                    onChange={(s) => updateShape(selectedShape.id, s)}
                    clampX={clampX}
                    clampY={clampY}
                  />
                </div>
              </div>
            )}
          </section>

          {/* Dispenser & motion (essentials) */}
          <section className="gp-card">
            <h3 className="gp-card-title">{t('glue.motion.title', 'Dispenser & motion')}</h3>
            <div className="gp-fields">
              <label title={t('glue.field.dispenseZ.title', 'Z height (mm) at which the dispenser touches down to lay a bead')}>
                {t('glue.field.dispenseZ', 'Dispense Z')}
                <input
                  type="number"
                  step="0.1"
                  value={params.dispenseZ}
                  onChange={(e) => setParams({ ...params, dispenseZ: num(e.target.value, params.dispenseZ) })}
                />
              </label>
              <label title={t('glue.field.travelZ.title', 'Safe Z height (mm) for rapid travel between shapes')}>
                {t('glue.field.travelZ', 'Travel Z')}
                <input
                  type="number"
                  step="0.1"
                  value={params.travelZ}
                  onChange={(e) => setParams({ ...params, travelZ: num(e.target.value, params.travelZ) })}
                />
              </label>
              <label title={t('glue.field.feed.title', 'Trace feed rate (mm/min) while dispensing along an outline')}>
                {t('glue.field.feed', 'Feed')}
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={params.feed}
                  onChange={(e) => setParams({ ...params, feed: num(e.target.value, params.feed) })}
                />
              </label>
              <label title={t('glue.field.dispenseRate.title', 'Dispenser output rate (drives the spindle/feeder S-word)')}>
                {t('glue.field.dispenseRate', 'Dispense rate')}
                <input
                  type="number"
                  step="100"
                  min="0"
                  value={params.dispenseRate}
                  onChange={(e) =>
                    setParams({ ...params, dispenseRate: num(e.target.value, params.dispenseRate) })
                  }
                />
              </label>
            </div>

            {/* Advanced (collapsed) */}
            <button
              className="gp-adv-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              title={t('glue.adv.title', 'Plunge feed, dwell times and G-code decimals')}
            >
              {showAdvanced ? '▾' : '▸'} {t('glue.adv', 'Advanced')}
            </button>
            {showAdvanced && (
              <div className="gp-fields gp-adv">
                <label>
                  {t('glue.field.plungeFeed', 'Plunge feed')}
                  <input
                    type="number"
                    step="10"
                    min="0"
                    value={params.plungeFeed}
                    onChange={(e) =>
                      setParams({ ...params, plungeFeed: num(e.target.value, params.plungeFeed) })
                    }
                  />
                </label>
                <label>
                  {t('glue.field.settle', 'Settle (ms)')}
                  <input
                    type="number"
                    step="50"
                    min="0"
                    value={params.settleMs}
                    onChange={(e) =>
                      setParams({ ...params, settleMs: num(e.target.value, params.settleMs) })
                    }
                  />
                </label>
                <label>
                  {t('glue.field.postDwell', 'Post dwell (ms)')}
                  <input
                    type="number"
                    step="50"
                    min="0"
                    value={params.postDwellMs}
                    onChange={(e) =>
                      setParams({ ...params, postDwellMs: num(e.target.value, params.postDwellMs) })
                    }
                  />
                </label>
                <label>
                  {t('glue.field.decimals', 'Decimals')}
                  <input
                    type="number"
                    step="1"
                    min="0"
                    max="5"
                    value={params.decimals}
                    onChange={(e) =>
                      setParams({
                        ...params,
                        decimals: Math.max(0, Math.min(5, Math.round(num(e.target.value, params.decimals)))),
                      })
                    }
                  />
                </label>
              </div>
            )}
          </section>

          {/* Generated program — auto-synced live to the Program tab / Visualizer.
              Streaming to the machine happens from the Program tab, not here. */}
          <section className="gp-card gp-card-wide gp-send">
            <p className="gp-meta gp-send-note">
              {t('glue.send.meta', 'Live preview · {n} lines → Visualizer', { n: lineCount })}
            </p>

            {/* Raw G-code (collapsed by default) */}
            <button
              className="gp-raw-toggle"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw}
              title={t('glue.raw.title', 'Show the generated G-code text')}
            >
              {showRaw ? '▾' : '▸'} {t('glue.raw', 'Raw G-code ({n} lines)', { n: lineCount })}
            </button>
            {showRaw && <pre className="gp-preview">{gcode}</pre>}
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Numeric editor for the currently-selected shape (machine coordinates). */
function ShapeEditor(props: {
  shape: GlueShape
  onChange: (s: GlueShape) => void
  clampX: (x: number) => number
  clampY: (y: number) => number
}) {
  const { shape, onChange, clampX, clampY } = props
  const field = (label: string, value: number, set: (v: number) => void, step = 0.5) => (
    <label key={label}>
      {label}
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(e) => set(num(e.target.value, value))}
      />
    </label>
  )

  switch (shape.kind) {
    case 'line':
      return (
        <>
          {field('X1', shape.x1, (v) => onChange({ ...shape, x1: clampX(v) }))}
          {field('Y1', shape.y1, (v) => onChange({ ...shape, y1: clampY(v) }))}
          {field('X2', shape.x2, (v) => onChange({ ...shape, x2: clampX(v) }))}
          {field('Y2', shape.y2, (v) => onChange({ ...shape, y2: clampY(v) }))}
        </>
      )
    case 'circle':
      return (
        <>
          {field('Cx', shape.cx, (v) => onChange({ ...shape, cx: clampX(v) }))}
          {field('Cy', shape.cy, (v) => onChange({ ...shape, cy: clampY(v) }))}
          {field('R', shape.r, (v) => onChange({ ...shape, r: Math.max(0.1, v) }))}
        </>
      )
    case 'rect':
      return (
        <>
          {field('X', shape.x, (v) => onChange({ ...shape, x: clampX(v) }))}
          {field('Y', shape.y, (v) => onChange({ ...shape, y: clampY(v) }))}
          {field('W', shape.w, (v) => onChange({ ...shape, w: Math.max(0.1, v) }))}
          {field('H', shape.h, (v) => onChange({ ...shape, h: Math.max(0.1, v) }))}
        </>
      )
    case 'triangle':
      return (
        <>
          {shape.points.map((p, i) => (
            <span className="gp-tri-pt" key={i}>
              {field(`X${i + 1}`, p.x, (v) =>
                onChange({
                  ...shape,
                  points: shape.points.map((q, j) =>
                    j === i ? { ...q, x: clampX(v) } : q,
                  ) as [typeof p, typeof p, typeof p],
                }),
              )}
              {field(`Y${i + 1}`, p.y, (v) =>
                onChange({
                  ...shape,
                  points: shape.points.map((q, j) =>
                    j === i ? { ...q, y: clampY(v) } : q,
                  ) as [typeof p, typeof p, typeof p],
                }),
              )}
            </span>
          ))}
        </>
      )
  }
}
