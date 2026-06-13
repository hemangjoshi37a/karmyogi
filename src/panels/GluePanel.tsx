import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useT } from '../i18n'
import { useProgram, usePersistentState, useNotifications } from '../store'
import { IconButton } from '../components/IconButton'
import { Icon } from '../components/Icons'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
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

/**
 * Themed slider + number-input + unit row for the dispenser/motion parameters,
 * mirroring the 2D/3D Carving "Position & Size" rows and the Controller jog
 * "Feed" control. A full-width row: leading glyph + label, a themed draggable
 * `.glue-slider` (accent fill via the inline `--mc-pct` var), a small typable
 * `.glue-slider-num` inside a bordered frame, and an inline unit suffix.
 *
 * The slider clamps to [min, max]; the number input commits the EXACT typed
 * value (so out-of-slider-range entry still works). All colours come from theme
 * CSS variables so it follows light/dark like the rest of the app.
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
  invalid,
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
  invalid?: boolean
  title?: string
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the accent fill (read as --mc-pct by the
  // WebKit/Blink track gradient; Firefox fills via ::-moz-range-progress). Uses
  // the CLAMPED value so an out-of-range typed value doesn't overflow the fill.
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="glue-sfield" title={title}>
      <label className="glue-sfield-lbl" htmlFor={htmlFor}>
        <span className="glue-sfield-ico" aria-hidden>
          {icon}
        </span>
        <span className="glue-sfield-txt">{label}</span>
      </label>
      <input
        type="range"
        className="glue-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--mc-pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className={invalid ? 'glue-sfield-num glue-sfield-num-bad' : 'glue-sfield-num'}>
        <input
          id={htmlFor}
          type="number"
          className="glue-slider-num"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          aria-invalid={invalid ? 'true' : undefined}
          aria-label={label}
          onChange={(e) => {
            // Allow EXACT entry (don't clamp the typed number) — only blank/NaN
            // is rejected (caller keeps the previous value).
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <span className="glue-sfield-unit">{unit}</span> : null}
      </span>
    </div>
  )
}

/** Bed size in mm (bottom-left = machine origin [0,0]). */
const BED = { w: 300, h: 200 }
/** SVG padding (px) around the bed so the border/grid is visible. */
const PAD = 6

type Tool = 'select' | 'line' | 'triangle' | 'circle' | 'rect'

/**
 * Crisp inline-SVG glyphs for the drawing tools. The shared {@link Icon} set has
 * no line/triangle/circle/rect shapes, so these live here — but they follow the
 * same contract: 24×24 viewBox, 2px stroke, `currentColor`, round caps/joins, so
 * they recolor with the theme exactly like the shared icons (no flat Unicode/
 * emoji glyphs, which render inconsistently across platforms).
 */
function ToolGlyph({ tool }: { tool: Tool }) {
  return (
    <svg
      className="gp-tool-svg"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {tool === 'select' && <path d="M5 4l6 16 2.5-6.5L20 11z" />}
      {tool === 'line' && <path d="M5 19L19 5" />}
      {tool === 'triangle' && <path d="M12 5l7 14H5z" />}
      {tool === 'circle' && <circle cx="12" cy="12" r="7.5" />}
      {tool === 'rect' && <rect x="5" y="6" width="14" height="12" rx="1" />}
    </svg>
  )
}

/** Inline "undo" (counter-clockwise arrow) glyph — no shared-icon equivalent. */
function UndoGlyph() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 9h11a5 5 0 0 1 0 10h-7" />
      <path d="M8 5L4 9l4 4" />
    </svg>
  )
}

/**
 * Tool buttons: id + label, in the order they appear in the toolbar. The
 * label/hint strings are the English fallbacks; `key` is the i18n key suffix so
 * render sites can translate (this array is module-level, outside any hook). The
 * glyph is rendered from {@link ToolGlyph} keyed by `id`.
 */
const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: 'select', key: 'select', label: 'Select', hint: 'Select / move a shape' },
  { id: 'line', key: 'line', label: 'Line', hint: 'Draw a straight bead' },
  { id: 'triangle', key: 'triangle', label: 'Triangle', hint: 'Draw a triangle outline' },
  { id: 'circle', key: 'circle', label: 'Circle', hint: 'Draw a circle' },
  { id: 'rect', key: 'rect', label: 'Rect', hint: 'Draw a rectangle' },
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
  /** Shift held at the latest pointer event → constrain (straight / square). */
  shift: boolean
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

/** Snap-to-grid step (mm). Pointer positions snap to this grid while drawing. */
const SNAP_MM = 5

/** Round a value to the nearest `SNAP_MM` grid line. */
function snap(v: number): number {
  return Math.round(v / SNAP_MM) * SNAP_MM
}

/** Snap a point to the grid (used for drawing/placement, not free-text edits). */
function snapPt(p: Pt): Pt {
  return { x: snap(p.x), y: snap(p.y) }
}

/**
 * With Shift held, constrain the drag end `b` relative to start `a` so lines run
 * along the nearest 45° axis and boxes stay square (equal width/height, sign
 * preserved). Returns `b` unchanged when `shift` is false.
 */
function constrainDrag(tool: Exclude<Tool, 'select'>, a: Pt, b: Pt, shift: boolean): Pt {
  if (!shift) return b
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (tool === 'line') {
    // Snap the bead to the nearest 45° direction, keeping its length.
    const len = Math.hypot(dx, dy)
    if (len === 0) return b
    const ang = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len }
  }
  if (tool === 'circle') return b // circle is already radius-symmetric
  // rect / triangle → square the bounding box (equal magnitude, keep sign).
  const s = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: a.x + Math.sign(dx || 1) * s, y: a.y + Math.sign(dy || 1) * s }
}

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
 *
 * With `shift` held the drag is constrained (lines snap to 45°, rect/triangle
 * become square); both endpoints are then snapped to the grid so drawn shapes
 * land on clean coordinates.
 */
function shapeFromDrag(
  tool: Exclude<Tool, 'select'>,
  rawA: Pt,
  rawB: Pt,
  shift = false,
): GlueShape | null {
  const a = snapPt(rawA)
  const b = snapPt(constrainDrag(tool, rawA, rawB, shift))
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

function shapeDim(shape: GlueShape, t: ReturnType<typeof useT>): DimLabel {
  switch (shape.kind) {
    case 'line': {
      const len = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1)
      return {
        text: t('glue.dim.line', 'L {v}', { v: mm(len) }),
        x: (shape.x1 + shape.x2) / 2,
        y: (shape.y1 + shape.y2) / 2,
      }
    }
    case 'circle':
      return { text: t('glue.dim.circle', 'r {v}', { v: mm(shape.r) }), x: shape.cx, y: shape.cy + shape.r }
    case 'rect':
      return {
        text: t('glue.dim.rect', '{w} × {h}', { w: mm(shape.w), h: mm(shape.h) }),
        x: shape.x + shape.w / 2,
        y: shape.y + shape.h,
      }
    case 'triangle': {
      const xs = shape.points.map((p) => p.x)
      const ys = shape.points.map((p) => p.y)
      const minX = Math.min(...xs)
      const maxX = Math.max(...xs)
      const maxY = Math.max(...ys)
      return { text: t('glue.dim.triangle', '△ {v}', { v: mm(maxX - minX) }), x: (minX + maxX) / 2, y: maxY }
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
 * The fully-resolved Glue dispenser/motion SETTINGS (every field present) — this
 * is what a colour PRESET snapshots and restores. It is the parametric config
 * only, NOT the drawn shapes (those are the operator's actual work).
 */
type GlueSettings = Omit<GlueParams, 'programName' | 'metric'>

/** Coerce an (untrusted) value to a finite number, else the fallback. */
const numOr = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback

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
  const streaming = useProgram((s) => s.streaming)
  const notify = useNotifications((s) => s.notify)

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

  // ---- colour-coded setting PRESETS (dispenser/motion params, NOT shapes) ----
  // Snapshot the current resolved settings into a serializable preset.
  const captureSettings = (): GlueSettings => ({ ...params })
  // Restore a settings snapshot, coercing each field from the (untrusted)
  // persisted value so a corrupt slot can never feed a NaN to the emitter.
  // Decimals is additionally clamped to the 0–5 range the field accepts.
  const applySettings = (s: GlueSettings) => {
    const v = (s ?? {}) as Record<string, unknown>
    setParams((prev) => ({
      ...prev,
      travelZ: numOr(v.travelZ, prev.travelZ ?? params.travelZ),
      dispenseZ: numOr(v.dispenseZ, prev.dispenseZ ?? params.dispenseZ),
      feed: Math.max(0, numOr(v.feed, prev.feed ?? params.feed)),
      plungeFeed: Math.max(0, numOr(v.plungeFeed, prev.plungeFeed ?? params.plungeFeed)),
      dispenseRate: Math.max(0, numOr(v.dispenseRate, prev.dispenseRate ?? params.dispenseRate)),
      settleMs: Math.max(0, numOr(v.settleMs, prev.settleMs ?? params.settleMs)),
      postDwellMs: Math.max(0, numOr(v.postDwellMs, prev.postDwellMs ?? params.postDwellMs)),
      decimals: Math.max(0, Math.min(5, Math.round(numOr(v.decimals, prev.decimals ?? params.decimals)))),
    }))
  }
  const presets = usePresets<GlueSettings>({
    storageKey: 'karmyogi.glue.presets',
    capture: captureSettings,
    onApply: applySettings,
  })

  const [tool, setTool] = useState<Tool>('rect')
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [moveDrag, setMoveDrag] = useState<MoveDrag | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  // Snapshot of the shapes that existed before the last Clear / Load, so a single
  // Undo button can restore them. `null` once nothing is undoable.
  const [undoShapes, setUndoShapes] = useState<IdShape[] | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  // Auto-dismiss the load error after a few seconds so a transient bad file
  // doesn't leave a sticky red banner once the user has moved on.
  useEffect(() => {
    if (!loadError) return
    const id = window.setTimeout(() => setLoadError(null), 6000)
    return () => window.clearTimeout(id)
  }, [loadError])

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
    setDrag({ tool, start: p, current: p, shift: e.shiftKey })
  }
  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = screenToBed(e.clientX, e.clientY)
    if (moveDrag) {
      // Snap the move delta to the grid so a dragged shape lands on clean
      // coordinates (matches the snap applied when drawing).
      const dx = snap(p.x - moveDrag.start.x)
      const dy = snap(p.y - moveDrag.start.y)
      // Apply the delta to the snapshot taken at pointer-down, never to the
      // (already-translated) live shape — avoids drift/stale-state bugs.
      updateShape(moveDrag.id, translateShape(moveDrag.orig, dx, dy))
      return
    }
    if (drag) setDrag({ ...drag, current: p, shift: e.shiftKey })
  }
  function onPointerUp(e: React.PointerEvent<SVGSVGElement>) {
    svgRef.current?.releasePointerCapture?.(e.pointerId)
    if (moveDrag) {
      setMoveDrag(null)
      return
    }
    if (!drag) return
    const s = shapeFromDrag(drag.tool, drag.start, screenToBed(e.clientX, e.clientY), e.shiftKey)
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

  // Preview path for the in-progress drag (with the same snap/constrain applied).
  const dragShape = useMemo(
    () => (drag ? shapeFromDrag(drag.tool, drag.start, drag.current, drag.shift) : null),
    [drag],
  )

  // --- live G-code generation + store push (debounced) ---
  const gcode = useMemo(
    () => generateGlue(shapes.map((s) => s.shape), { ...params }),
    [shapes, params],
  )
  const lineCount = useMemo(() => gcodeLines(gcode).length, [gcode])
  // What the store actually receives: an empty bed pushes '' (clear-on-empty),
  // so the visible counters must say 0 — not the preamble-only lines the
  // emitter still produces for zero shapes.
  const liveLines = shapes.length === 0 ? 0 : lineCount

  // Degenerate dispense: with Dispense-Z at or above Travel-Z the head never
  // descends below travel height, so no real bead is laid down.
  const degenerateZ = params.dispenseZ >= params.travelZ

  // Live generation: push the freshly-computed program to the store (debounced)
  // so the Visualizer + Program tab pick it up without a manual step. When the
  // bed is cleared, DROP the section (push '' → clear-on-empty) instead of
  // early-returning, so a stale glue toolpath doesn't linger in the Visualizer /
  // Program tab. While a job is streaming we skip the sync entirely so a fresh
  // setProgram can't reset the running program/cursor mid-dispense.
  useEffect(() => {
    if (streaming) return
    if (shapes.length === 0) {
      setProgram('glue', '')
      return
    }
    const id = window.setTimeout(() => setProgram('glue', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, shapes.length, setProgram, streaming])

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
  // unique regardless of what the file contained. Before replacing a non-empty
  // drawing we confirm, snapshot the current shapes for Undo, and toast the
  // loaded count.
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
    if (
      shapes.length > 0 &&
      !window.confirm(
        t('glue.load.replaceConfirm', 'Replace the current {n} shape(s) with {m} from the file?', {
          n: shapes.length,
          m: loaded.length,
        }),
      )
    ) {
      return
    }
    setUndoShapes(shapes) // snapshot for Undo
    setShapes(loaded)
    setParams(parseGlueParams(data.params))
    setSelected(null)
    setLoadError(null)
    notify('success', t('glue.load.loaded', 'Loaded {n} shape(s).', { n: loaded.length }))
  }

  // Clear the bed. Confirms first when there is work to lose, snapshots the
  // current shapes so the action is undoable, and toasts the result. The
  // live-sync effect drops the synced section once shapes is empty.
  function clearAll() {
    if (shapes.length === 0) return
    if (!window.confirm(t('glue.clearConfirm', 'Remove all {n} shape(s)?', { n: shapes.length })))
      return
    setUndoShapes(shapes)
    setShapes([])
    setSelected(null)
    notify('info', t('glue.cleared', 'Cleared the bed.'))
  }

  // Restore the shapes snapshotted by the last Clear / Load.
  function undoLast() {
    if (!undoShapes) return
    setShapes(undoShapes)
    setUndoShapes(null)
    setSelected(null)
    notify('success', t('glue.undone', 'Restored {n} shape(s).', { n: undoShapes.length }))
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
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('glue.presets.aria', 'Glue dispenser setting presets')}
      />
    <div className="gp-panel">
      {/* Slim header: title + InfoTip, with undo/clear + drawing save/load on
          the right so the drawing toolbar holds only the shape tools. */}
      <header className="gp-head">
        <div className="gp-head-title">
          <span className="gp-head-name">{t('glue.title', 'Glue dispense')}</span>
          <InfoTip
            topic="glueMode"
            title={t('glue.title', 'Glue dispense')}
            body={`${t('glue.intro.pre', 'Pick a shape and draw it on the bed.')} ${t(
              'glue.intro.post',
              'The G-code updates live in the Program tab — run it from there.',
            )} ${t('glue.intro.viz', 'The 3D Visualizer previews the trajectories as you draw.')}`}
          />
        </div>
        <div className="gp-head-tools">
          <IconButton
            className="gp-undo"
            icon={<UndoGlyph />}
            label={`${t('glue.undo', 'Undo')} — ${t('glue.undo.body', 'restores the shapes removed by the last Clear or Load')}`}
            onClick={undoLast}
            disabled={!undoShapes}
          />
          <IconButton
            className="gp-clear"
            iconName="trash"
            label={`${t('glue.clear', 'Clear')} — ${t('glue.clear.title', 'Remove all shapes')}`}
            onClick={clearAll}
            disabled={shapes.length === 0}
          />
          <span className="gp-tools-sep" aria-hidden="true" />
          <SaveLoadButtons
            value={doc}
            onLoad={loadDoc}
            fileBase="karmyogi-glue"
            ext="kglue"
            saveDisabled={shapes.length === 0}
            saveTitle={`${t('glue.save', 'Save drawing')} — ${t('glue.save.body', 'shapes + dispenser parameters')}`}
            loadTitle={`${t('glue.load', 'Load drawing')} — ${t('glue.load.body', 'replaces the current shapes')}`}
            onError={setLoadError}
          />
        </div>
      </header>

      {/* Live status strip: shape + line counts, auto-synced to the Program tab. */}
      <div className="gp-status">
        <span className="gp-status-pill">
          <b>{shapes.length}</b>{' '}
          {shapes.length === 1 ? t('glue.status.shape', 'shape') : t('glue.status.shapes', 'shapes')}
        </span>
        <span className="gp-status-sep" aria-hidden="true">·</span>
        <span className="gp-status-pill">
          <b>{liveLines}</b> {t('glue.status.lines', 'G-code lines')}
        </span>
        <span
          className="gp-status-sync"
          title={t('glue.live.title', 'Lines auto-synced to the Program tab')}
        >
          → {t('glue.status.program', 'Program')}
        </span>
      </div>
      {loadError && (
        <p className="gp-banner gp-banner-error" role="alert">
          <Icon name="warning" size={14} />
          {loadError}
        </p>
      )}
      {degenerateZ && shapes.length > 0 && (
        <p className="gp-banner gp-banner-warn" role="alert">
          <Icon name="warning" size={14} />
          {t(
            'glue.warn.degenerateZ',
            'Dispense Z ({dz}) ≥ Travel Z ({tz}) — the head never descends, so no bead is dispensed. Lower Dispense Z below Travel Z.',
            { dz: params.dispenseZ, tz: params.travelZ },
          )}
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
                  title={`${label} — ${hint}`}
                >
                  <span className="gp-tool-glyph" aria-hidden="true">
                    <ToolGlyph tool={tl.id} />
                  </span>
                </button>
              )
            })}
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

              {/* In-place empty-state prompt; gone the moment a drag starts. */}
              {shapes.length === 0 && !drag && (
                <text
                  className="gp-canvas-empty"
                  x={BED.w / 2}
                  y={sy(BED.h / 2)}
                  textAnchor="middle"
                  pointerEvents="none"
                >
                  {t('glue.canvas.empty', 'Pick a tool and drag here to draw')}
                </text>
              )}

              {/* Existing shapes. In select mode the path itself starts a
                  move-drag (and is a fat invisible hit-target for easy grabbing). */}
              {shapes.map(({ id, shape }) => {
                const isSel = id === selected
                const dim = shapeDim(shape, t)
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
                    const dim = shapeDim(dragShape, t)
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
                        <ToolGlyph tool={shape.kind} />
                      </span>
                      {shapeSummary(shape, t)}
                    </button>
                    <IconButton
                      className="gp-del"
                      iconName="close"
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
                  const dim = shapeDim(selectedShape.shape, t)
                  return (
                    <span className="gp-dim-readout">
                      <span className="gp-dim-xy">
                        {t('glue.readout.xy', 'X {x} · Y {y}', { x: mm(o.x), y: mm(o.y) })}
                      </span>
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
            <div className="glue-sfields">
              <SliderField
                icon={<Icon name="probe" size={14} />}
                label={t('glue.field.dispenseZ', 'Dispense Z')}
                htmlFor="glue-dispenseZ"
                unit={t('unit.mm', 'mm')}
                value={params.dispenseZ}
                min={-10}
                max={50}
                step={0.1}
                invalid={degenerateZ}
                title={t('glue.field.dispenseZ.title', 'Z height (mm) at which the dispenser touches down to lay a bead')}
                onChange={(v) => setParams({ ...params, dispenseZ: v })}
              />
              <SliderField
                icon={<Icon name="home" size={14} />}
                label={t('glue.field.travelZ', 'Travel Z')}
                htmlFor="glue-travelZ"
                unit={t('unit.mm', 'mm')}
                value={params.travelZ}
                min={0}
                max={60}
                step={0.1}
                invalid={degenerateZ}
                title={t('glue.field.travelZ.title', 'Safe Z height (mm) for rapid travel between shapes')}
                onChange={(v) => setParams({ ...params, travelZ: v })}
              />
              <SliderField
                icon={<Icon name="jog" size={14} />}
                label={t('glue.field.feed', 'Feed')}
                htmlFor="glue-feed"
                unit={t('unit.mmPerMin', 'mm/min')}
                value={params.feed}
                min={0}
                max={3000}
                step={10}
                title={t('glue.field.feed.title', 'Trace feed rate (mm/min) while dispensing along an outline')}
                onChange={(v) => setParams({ ...params, feed: Math.max(0, v) })}
              />
              <SliderField
                icon={<Icon name="spindle" size={14} />}
                label={t('glue.field.dispenseRate', 'Dispense rate')}
                htmlFor="glue-dispenseRate"
                unit={t('unit.sWord', 'S')}
                value={params.dispenseRate}
                min={0}
                max={2000}
                step={50}
                title={t('glue.field.dispenseRate.title', 'Dispenser output rate (drives the spindle/feeder S-word)')}
                onChange={(v) => setParams({ ...params, dispenseRate: Math.max(0, v) })}
              />
            </div>

            {/* Advanced (collapsed) */}
            <button
              className="gp-adv-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              title={t('glue.adv.title', 'Plunge feed, dwell times and G-code decimals')}
            >
              <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />
              {t('glue.adv', 'Advanced')}
            </button>
            {showAdvanced && (
              <div className="glue-sfields gp-adv">
                <SliderField
                  icon={<Icon name="jog" size={14} />}
                  label={t('glue.field.plungeFeed', 'Plunge feed')}
                  htmlFor="glue-plungeFeed"
                  unit={t('unit.mmPerMin', 'mm/min')}
                  value={params.plungeFeed}
                  min={0}
                  max={1500}
                  step={10}
                  title={t('glue.field.plungeFeed.title', 'Feed rate (mm/min) for the descent from Travel Z to Dispense Z')}
                  onChange={(v) => setParams({ ...params, plungeFeed: Math.max(0, v) })}
                />
                <SliderField
                  icon={<Icon name="pause" size={14} />}
                  label={t('glue.field.settle', 'Settle')}
                  htmlFor="glue-settle"
                  unit={t('unit.ms', 'ms')}
                  value={params.settleMs}
                  min={0}
                  max={2000}
                  step={50}
                  title={t('glue.field.settle.title', 'Dwell (ms) after touch-down before moving, so the bead starts cleanly')}
                  onChange={(v) => setParams({ ...params, settleMs: Math.max(0, v) })}
                />
                <SliderField
                  icon={<Icon name="pause" size={14} />}
                  label={t('glue.field.postDwell', 'Post dwell')}
                  htmlFor="glue-postDwell"
                  unit={t('unit.ms', 'ms')}
                  value={params.postDwellMs}
                  min={0}
                  max={2000}
                  step={50}
                  title={t('glue.field.postDwell.title', 'Dwell (ms) after the dispenser stops, before retracting')}
                  onChange={(v) => setParams({ ...params, postDwellMs: Math.max(0, v) })}
                />
                <SliderField
                  icon={<Icon name="settings" size={14} />}
                  label={t('glue.field.decimals', 'Decimals')}
                  htmlFor="glue-decimals"
                  value={params.decimals}
                  min={0}
                  max={5}
                  step={1}
                  title={t('glue.field.decimals.title', 'Coordinate decimal places in the emitted G-code (0–5)')}
                  onChange={(v) =>
                    setParams({
                      ...params,
                      decimals: Math.max(0, Math.min(5, Math.round(v))),
                    })
                  }
                />
              </div>
            )}
          </section>

          {/* Generated program — auto-synced live to the Program tab / Visualizer.
              Streaming itself happens from the Program tab. */}
          <section className="gp-card gp-card-wide gp-send">
            <p className="gp-meta gp-send-note">
              {shapes.length === 0
                ? t('glue.send.empty', 'No program yet — draw a shape on the bed.')
                : t('glue.send.live', 'Live · {n} lines → Program', { n: lineCount })}
            </p>

            {/* Raw G-code (collapsed by default; disabled until a shape exists,
                matching the empty program the store actually receives) */}
            <button
              className="gp-raw-toggle"
              onClick={() => setShowRaw((v) => !v)}
              aria-expanded={showRaw && shapes.length > 0}
              disabled={shapes.length === 0}
              title={t('glue.raw.title', 'Show the generated G-code text')}
            >
              <Icon name={showRaw && shapes.length > 0 ? 'chevron-down' : 'chevron-right'} size={14} />
              {t('glue.raw', 'Raw G-code ({n} lines)', { n: liveLines })}
            </button>
            {showRaw && shapes.length > 0 && <pre className="gp-preview">{gcode}</pre>}
          </section>
          </div>
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
            value={params}
            onLoad={(data) => {
              if (isObj(data)) applySettings(data as unknown as GlueSettings)
              else
                setLoadError(
                  t('glue.settings.load.invalid', 'Could not load — file is not valid glue settings.'),
                )
            }}
            fileBase="glue-settings"
            ext="kgluecfg"
            saveTitle={`${t('glue.settings.save', 'Save dispenser settings')} — ${t('glue.settings.save.body', 'parameters only, no shapes')}`}
            loadTitle={`${t('glue.settings.load', 'Load dispenser settings')} — ${t('glue.settings.load.body', 'replaces the current parameters')}`}
            onError={setLoadError}
          />
        }
      />
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
  const t = useT()
  // `key` is a stable identity for React; `label` is the (localized) visible
  // text. Field labels (X1/Y1/Cx/Cy/R/W/H…) are translated with an i18n key and
  // the single-letter English fallback.
  const field = (
    key: string,
    label: string,
    value: number,
    set: (v: number) => void,
    step = 0.5,
  ) => (
    <label key={key}>
      {label}
      <input
        type="number"
        step={step}
        value={Number(value.toFixed(3))}
        onChange={(e) => set(num(e.target.value, value))}
      />
    </label>
  )
  /** Translate a field label, e.g. tl('x1','X1') or tl('xn','X{n}',{n:1}). */
  const tl = (k: string, fallback: string, vars?: Record<string, string | number>) =>
    t(`glue.field.${k}`, fallback, vars)

  switch (shape.kind) {
    case 'line':
      return (
        <>
          {field('x1', tl('x1', 'X1'), shape.x1, (v) => onChange({ ...shape, x1: clampX(v) }))}
          {field('y1', tl('y1', 'Y1'), shape.y1, (v) => onChange({ ...shape, y1: clampY(v) }))}
          {field('x2', tl('x2', 'X2'), shape.x2, (v) => onChange({ ...shape, x2: clampX(v) }))}
          {field('y2', tl('y2', 'Y2'), shape.y2, (v) => onChange({ ...shape, y2: clampY(v) }))}
        </>
      )
    case 'circle':
      return (
        <>
          {field('cx', tl('cx', 'Cx'), shape.cx, (v) => onChange({ ...shape, cx: clampX(v) }))}
          {field('cy', tl('cy', 'Cy'), shape.cy, (v) => onChange({ ...shape, cy: clampY(v) }))}
          {field('r', tl('r', 'R'), shape.r, (v) => onChange({ ...shape, r: Math.max(0.1, v) }))}
        </>
      )
    case 'rect':
      return (
        <>
          {field('x', tl('x', 'X'), shape.x, (v) => onChange({ ...shape, x: clampX(v) }))}
          {field('y', tl('y', 'Y'), shape.y, (v) => onChange({ ...shape, y: clampY(v) }))}
          {field('w', tl('w', 'W'), shape.w, (v) => onChange({ ...shape, w: Math.max(0.1, v) }))}
          {field('h', tl('h', 'H'), shape.h, (v) => onChange({ ...shape, h: Math.max(0.1, v) }))}
        </>
      )
    case 'triangle':
      return (
        <>
          {shape.points.map((p, i) => (
            <span className="gp-tri-pt" key={i}>
              {field(`x${i + 1}`, tl('xn', 'X{n}', { n: i + 1 }), p.x, (v) =>
                onChange({
                  ...shape,
                  points: shape.points.map((q, j) =>
                    j === i ? { ...q, x: clampX(v) } : q,
                  ) as [typeof p, typeof p, typeof p],
                }),
              )}
              {field(`y${i + 1}`, tl('yn', 'Y{n}', { n: i + 1 }), p.y, (v) =>
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
