import { useEffect, useMemo, useRef, useState } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
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

/** Tool buttons: glyph + label, in the order they appear in the toolbar. */
const TOOLS: { id: Tool; glyph: string; label: string; hint: string }[] = [
  { id: 'select', glyph: '↖', label: 'Select', hint: 'Select / move a shape' },
  { id: 'line', glyph: '╱', label: 'Line', hint: 'Draw a straight bead' },
  { id: 'triangle', glyph: '△', label: 'Triangle', hint: 'Draw a triangle outline' },
  { id: 'circle', glyph: '◯', label: 'Circle', hint: 'Draw a circle' },
  { id: 'rect', glyph: '▭', label: 'Rect', hint: 'Draw a rectangle' },
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

/** Short human label for a shape kind, for the shape list. */
function shapeSummary(shape: GlueShape): string {
  switch (shape.kind) {
    case 'line':
      return `Line · ${Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1).toFixed(0)} mm`
    case 'circle':
      return `Circle · r ${shape.r.toFixed(0)} mm`
    case 'rect':
      return `Rect · ${shape.w.toFixed(0)} × ${shape.h.toFixed(0)} mm`
    case 'triangle':
      return 'Triangle'
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
  const connected = useMachine((s) => s.connection === 'connected')
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
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
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

  // --- pointer drawing ---
  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    // Only react to the drawing surface, not the shape hit-targets (which
    // stopPropagation for selection in select mode).
    const p = screenToBed(e.clientX, e.clientY)
    if (tool === 'select') {
      setSelected(null) // click on empty canvas clears selection
      return
    }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDrag({ tool, start: p, current: p })
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return
    setDrag({ ...drag, current: screenToBed(e.clientX, e.clientY) })
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return
    const s = shapeFromDrag(drag.tool, drag.start, screenToBed(e.clientX, e.clientY))
    setDrag(null)
    if (s) addShape(s)
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

  function play() {
    const lines = gcodeLines(gcode)
    if (lines.length === 0 || !connected) return
    setProgram('glue', gcode)
    grbl.startProgram(lines)
  }

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
  const hint =
    tool === 'select'
      ? 'Tap a shape to select it · Delete removes it'
      : tool === 'circle'
        ? 'Drag from the centre outwards to set the radius'
        : tool === 'line'
          ? 'Drag from one end of the bead to the other'
          : 'Drag a bounding box on the bed'

  return (
    <div className="gp-panel">
      {/* One-line intro / flow */}
      <p className="gp-intro">
        Pick a shape, draw it on the bed, then <b>Send ▶</b>. The dispenser traces each outline.
      </p>

      <div className="gp-body">
        {/* === Canvas column (the centerpiece) === */}
        <div className="gp-stage">
          {/* Shape-tool icon toolbar */}
          <div className="gp-toolbar" role="toolbar" aria-label="Drawing tools">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? 'gp-tool gp-tool-on' : 'gp-tool'}
                onClick={() => setTool(t.id)}
                aria-pressed={tool === t.id}
                title={t.hint}
              >
                <span className="gp-tool-glyph" aria-hidden="true">
                  {t.glyph}
                </span>
                <span className="gp-tool-label">{t.label}</span>
              </button>
            ))}
            <span className="gp-spacer" />
            <button
              className="gp-clear"
              onClick={() => setShapes([])}
              disabled={shapes.length === 0}
              title="Remove all shapes"
            >
              Clear
            </button>
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
              onPointerCancel={() => setDrag(null)}
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

              {/* Existing shapes */}
              {shapes.map(({ id, shape }) => (
                <path
                  key={id}
                  className={id === selected ? 'gp-shape gp-shape-sel' : 'gp-shape'}
                  d={shapePath(shape)}
                  onPointerDown={(e) => {
                    if (tool === 'select') {
                      e.stopPropagation()
                      setSelected(id)
                    }
                  }}
                />
              ))}

              {/* In-progress drag preview */}
              {dragShape && <path className="gp-shape gp-shape-draft" d={shapePath(dragShape)} />}
            </svg>
            <div className="gp-hint">
              <span>{hint}</span>
              <span className="gp-meta">
                {shapes.length} shape{shapes.length === 1 ? '' : 's'}
              </span>
            </div>
          </div>
        </div>

        {/* === Controls column (vertical scroll only) === */}
        <div className="gp-controls">
          {/* Shape list */}
          <section className="gp-card">
            <h3 className="gp-card-title">Shapes</h3>
            {shapes.length === 0 ? (
              <p className="gp-empty">No shapes yet — draw one on the bed.</p>
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
                      title="Select this shape"
                    >
                      <span className="gp-list-glyph" aria-hidden="true">
                        {TOOLS.find((t) => t.id === shape.kind)?.glyph ?? '•'}
                      </span>
                      {shapeSummary(shape)}
                    </button>
                    <button
                      className="gp-del"
                      title="Delete shape"
                      onClick={() => deleteShape(id)}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {/* Inline numeric editor for the selected shape */}
            {selectedShape && (
              <div className="gp-edit">
                <span className="gp-edit-label">Edit · {selectedShape.shape.kind} (mm)</span>
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
            <h3 className="gp-card-title">Dispenser &amp; motion</h3>
            <div className="gp-fields">
              <label title="Z height (mm) at which the dispenser touches down to lay a bead">
                Dispense Z
                <input
                  type="number"
                  step="0.1"
                  value={params.dispenseZ}
                  onChange={(e) => setParams({ ...params, dispenseZ: num(e.target.value, params.dispenseZ) })}
                />
              </label>
              <label title="Safe Z height (mm) for rapid travel between shapes">
                Travel Z
                <input
                  type="number"
                  step="0.1"
                  value={params.travelZ}
                  onChange={(e) => setParams({ ...params, travelZ: num(e.target.value, params.travelZ) })}
                />
              </label>
              <label title="Trace feed rate (mm/min) while dispensing along an outline">
                Feed
                <input
                  type="number"
                  step="10"
                  min="0"
                  value={params.feed}
                  onChange={(e) => setParams({ ...params, feed: num(e.target.value, params.feed) })}
                />
              </label>
              <label title="Dispenser output rate (drives the spindle/feeder S-word)">
                Dispense rate
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
              title="Plunge feed, dwell times and G-code decimals"
            >
              {showAdvanced ? '▾' : '▸'} Advanced
            </button>
            {showAdvanced && (
              <div className="gp-fields gp-adv">
                <label>
                  Plunge feed
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
                  Settle (ms)
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
                  Post dwell (ms)
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
                  Decimals
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

          {/* Generate / send */}
          <section className="gp-card gp-send">
            <button
              className="primary gp-play"
              onClick={play}
              disabled={shapes.length === 0 || lineCount === 0 || !connected}
              title={connected ? 'Stream this program to the machine' : 'Connect to a machine to send'}
            >
              ▶ Send to machine
            </button>
            <p className="gp-meta gp-send-note">
              Live preview · <b>{lineCount}</b> lines → Visualizer
              {!connected && shapes.length > 0 ? ' · connect to send' : ''}
            </p>

            {/* Raw G-code (collapsed by default) */}
            <button
              className="gp-raw-toggle"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw}
              title="Show the generated G-code text"
            >
              {showRaw ? '▾' : '▸'} Raw G-code ({lineCount} lines)
            </button>
            {showRaw && <pre className="gp-preview">{gcode}</pre>}
          </section>
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
