import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useTabCommands } from '../machine/tabCommands'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { CamEmpty, CamStatus } from '../components/cam/CamUI'
import { SegControl } from '../components/ui/SegControl'
import { SliderField } from '../components/ui/SliderField'
import { StrokeFont } from '../core/strokeFont'
import { importVectorFile, VECTOR_ACCEPT, type ImportedPath } from '../core/vectorImport'
import '../styles/cam.css'
import '../styles/embroidery.css'

/* ═══════════════════════════════════════════════════════════════════════════
   PURE CORE — no React/DOM. Mirrors the app's pattern of keeping CAM/geometry
   maths as small pure functions so it stays portable and easy to reason about.
   The Embroidery model: the operator builds a LIST of decorative OBJECTS (line,
   rectangle, circle/ellipse, polygon/star, single-stroke TEXT, or an IMPORTED
   SVG/DXF path). Each object is turned into an ordered set of STITCH POINTS.
   XY-ONLY output: the real embroidery machine drives the NEEDLE up/down on its
   OWN Z motor, synced to the fabric feed, so karmyogi outputs ONLY the hoop/
   fabric XY positioning — one G1 move per stitch point, G0 rapids to jump
   (needle-up) between runs and objects. No Z words, no spindle, no M3/M5.
   ══════════════════════════════════════════════════════════════════════════ */

/** A 2D stitch coordinate in bed (work) space, millimetres. */
interface XY {
  x: number
  y: number
}

/** The needle stitch strategy for an object. */
type StitchMode = 'running' | 'satin'

/** Discriminated shape kinds an operator can stitch. */
type EmbKind = 'line' | 'rect' | 'circle' | 'polygon' | 'text' | 'imported'

/** Fields common to every embroidery object. */
interface EmbCommon {
  id: string
  /** Anchor X in bed space (mm). Rotation pivots about this point. */
  x: number
  /** Anchor Y in bed space (mm). */
  y: number
  /** Rotation about the anchor, degrees CCW. */
  rotation: number
  /** Running (outline) or Satin/fill (solid). Text ignores this (always running). */
  mode: StitchMode
}

interface EmbLine extends EmbCommon {
  kind: 'line'
  /** Length along the local +X axis (mm). Anchor is the line's centre. */
  length: number
  /** Column width used ONLY by satin (zig-zag amplitude across the line). */
  width: number
}
interface EmbRect extends EmbCommon {
  kind: 'rect'
  width: number
  height: number
}
interface EmbCircle extends EmbCommon {
  kind: 'circle'
  /** X radius (mm). Equal rx/ry = a circle; unequal = an ellipse. */
  rx: number
  ry: number
}
interface EmbPolygon extends EmbCommon {
  kind: 'polygon'
  /** Number of points/sides (≥3). */
  sides: number
  /** Circumradius (mm). */
  radius: number
  /** When true, alternate vertices pull in to `radius * innerRatio` → a star. */
  star: boolean
  innerRatio: number
}
interface EmbText extends EmbCommon {
  kind: 'text'
  text: string
  /** Cap height (mm) of the single-stroke lettering. */
  charHeight: number
}
interface EmbImported extends EmbCommon {
  kind: 'imported'
  /** Raw path points (mm), centred about their own bbox so scale/rotate pivot cleanly. */
  points: XY[]
  /** True if the source path was closed (its outline can be running-stitched or filled). */
  closed: boolean
  /** Uniform scale applied to the raw points before placement. */
  scale: number
  /** Source filename, shown on the card. */
  name?: string
}

type EmbObject = EmbLine | EmbRect | EmbCircle | EmbPolygon | EmbText | EmbImported

/** A loose patch accepted by updateObject — every field optional, never `kind`. */
interface EmbPatch {
  x?: number
  y?: number
  rotation?: number
  mode?: StitchMode
  length?: number
  width?: number
  height?: number
  rx?: number
  ry?: number
  sides?: number
  radius?: number
  star?: boolean
  innerRatio?: number
  text?: string
  charHeight?: number
  scale?: number
}

/** Global stitch/machine parameters shared by every object. XY-only — no Z. */
interface EmbParams {
  /** Spacing between stitches along a path (mm). */
  stitchLength: number
  /** Satin/fill row spacing = density (mm). */
  rowSpacing: number
  /** Feed used to advance the hoop between stitch points, G1 (mm/min). */
  punchFeed: number
  /** Feed reference for needle-up jumps between objects & across long gaps (mm/min). */
  travelFeed: number
  /** Moves longer than this jump (G0, needle-up) instead of stitching (mm). */
  jumpThreshold: number
  /** Tie-in / tie-off locking stitches at each run's start & end. */
  tieCount: number
  /** Return the hoop to the work origin (G0 X0 Y0) at program end. */
  returnToOrigin: boolean
  /** Decimal places in emitted coordinates (0–6). */
  decimals: number
}

let embSeq = 0
function newEmbId(): string {
  embSeq += 1
  return `emb_${Date.now().toString(36)}_${embSeq}`
}

function defaultParams(): EmbParams {
  return {
    stitchLength: 2.5,
    rowSpacing: 1.6,
    punchFeed: 1200,
    travelFeed: 3000,
    jumpThreshold: 8,
    tieCount: 2,
    returnToOrigin: true,
    decimals: 3,
  }
}

function defaultLine(): EmbLine {
  return { id: newEmbId(), kind: 'line', x: 0, y: 0, rotation: 0, mode: 'running', length: 40, width: 3 }
}
function defaultRect(): EmbRect {
  return { id: newEmbId(), kind: 'rect', x: 0, y: 0, rotation: 0, mode: 'running', width: 40, height: 25 }
}
function defaultCircle(): EmbCircle {
  return { id: newEmbId(), kind: 'circle', x: 0, y: 0, rotation: 0, mode: 'running', rx: 20, ry: 20 }
}
function defaultPolygon(): EmbPolygon {
  return { id: newEmbId(), kind: 'polygon', x: 0, y: 0, rotation: 0, mode: 'running', sides: 5, radius: 20, star: false, innerRatio: 0.5 }
}
function defaultText(): EmbText {
  return { id: newEmbId(), kind: 'text', x: -20, y: 0, rotation: 0, mode: 'running', text: 'ABC', charHeight: 12 }
}
function defaultImported(): EmbImported {
  return {
    id: newEmbId(), kind: 'imported', x: 0, y: 0, rotation: 0, mode: 'running',
    points: [{ x: -10, y: 0 }, { x: 10, y: 0 }], closed: false, scale: 1,
  }
}
function defaultOf(kind: EmbKind): EmbObject {
  switch (kind) {
    case 'line': return defaultLine()
    case 'rect': return defaultRect()
    case 'circle': return defaultCircle()
    case 'polygon': return defaultPolygon()
    case 'text': return defaultText()
    case 'imported': return defaultImported()
  }
}

/** Clamp decimals to toFixed()'s legal 0..6 range (guards a render-phase throw). */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Format a coordinate, zeroing a rounded "-0.000" to "0.000" (never emit -0). */
function fmt(n: number, dec: number): string {
  if (!Number.isFinite(n)) n = 0
  let s = n.toFixed(dec)
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1)
  return s
}

const dist = (a: XY, b: XY): number => Math.hypot(b.x - a.x, b.y - a.y)

/** Rotate local point about the origin then translate to the object's anchor. */
function placeXY(pt: XY, obj: EmbObject): XY {
  const a = (obj.rotation * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: pt.x * c - pt.y * s + obj.x, y: pt.x * s + pt.y * c + obj.y }
}

/**
 * Sample points evenly (every `spacing` mm) along a polyline, always keeping the
 * first and last vertices. A closed path re-appends its first vertex. This is
 * the running-stitch generator.
 */
function sampleAlong(path: XY[], spacing: number, closed: boolean): XY[] {
  const pts = closed && path.length > 1 ? [...path, path[0]] : path
  const out: XY[] = []
  if (pts.length === 0) return out
  const step = Math.max(0.1, spacing)
  out.push(pts[0])
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const segLen = dist(a, b)
    if (segLen < 1e-9) continue
    let d = step - carry
    while (d <= segLen + 1e-9) {
      const t = Math.min(1, d / segLen)
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
      d += step
    }
    carry = segLen - (d - step)
  }
  const last = pts[pts.length - 1]
  const lo = out[out.length - 1]
  if (dist(last, lo) > 1e-6) out.push(last)
  return out
}

/**
 * Boustrophedon (back-and-forth) scanline fill of a closed polygon → satin/fill
 * stitch points. Horizontal rows every `rowSpacing`; each row is stitched at
 * `stitchLen` spacing, alternating direction so the needle path is continuous.
 */
function scanlineFill(poly: XY[], rowSpacing: number, stitchLen: number): XY[] {
  const n = poly.length
  if (n < 3) return []
  const ys = poly.map((p) => p.y)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const rs = Math.max(0.1, rowSpacing)
  const out: XY[] = []
  let flip = false
  for (let y = minY + rs * 0.5; y < maxY; y += rs) {
    const xs: number[] = []
    for (let i = 0; i < n; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % n]
      const y0 = a.y
      const y1 = b.y
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        const t = (y - y0) / (y1 - y0)
        xs.push(a.x + t * (b.x - a.x))
      }
    }
    if (xs.length < 2) continue
    xs.sort((p, q) => p - q)
    const spans: [number, number][] = []
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]])
    const ordered = flip ? spans.slice().reverse() : spans
    for (const [sx, ex] of ordered) {
      const x0 = flip ? ex : sx
      const x1 = flip ? sx : ex
      const spanLen = Math.abs(x1 - x0)
      const steps = Math.max(1, Math.round(spanLen / Math.max(0.1, stitchLen)))
      for (let s = 0; s <= steps; s++) {
        const t = s / steps
        out.push({ x: x0 + (x1 - x0) * t, y })
      }
    }
    flip = !flip
  }
  return out
}

/** A satin COLUMN across a line: zig-zag between the two edges of a band. */
function satinColumn(len: number, width: number, stitchLen: number): XY[] {
  const out: XY[] = []
  const steps = Math.max(1, Math.round(len / Math.max(0.1, stitchLen)))
  const w = Math.max(0.1, width) / 2
  for (let s = 0; s <= steps; s++) {
    const x = -len / 2 + len * (s / steps)
    out.push({ x, y: s % 2 === 0 ? -w : w })
  }
  return out
}

/** Local (unrotated, origin-centred) closed outline for area shapes; null else. */
function localOutline(obj: EmbObject): XY[] | null {
  if (obj.kind === 'rect') {
    const w = obj.width / 2
    const h = obj.height / 2
    return [
      { x: -w, y: -h },
      { x: w, y: -h },
      { x: w, y: h },
      { x: -w, y: h },
    ]
  }
  if (obj.kind === 'circle') {
    const seg = 96
    const o: XY[] = []
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * 2 * Math.PI
      o.push({ x: Math.cos(a) * obj.rx, y: Math.sin(a) * obj.ry })
    }
    return o
  }
  if (obj.kind === 'polygon') {
    const N = Math.max(3, Math.floor(obj.sides))
    const total = obj.star ? N * 2 : N
    const o: XY[] = []
    for (let i = 0; i < total; i++) {
      const a = (i / total) * 2 * Math.PI - Math.PI / 2
      const r = obj.star && i % 2 === 1 ? obj.radius * obj.innerRatio : obj.radius
      o.push({ x: Math.cos(a) * r, y: Math.sin(a) * r })
    }
    return o
  }
  return null
}

// One built-in single-stroke font instance, reused for all TEXT objects.
let sharedFont: StrokeFont | null = null
function embFont(): StrokeFont {
  if (!sharedFont) sharedFont = StrokeFont.builtin()
  return sharedFont
}

/**
 * Turn one object into an ordered list of stitch RUNS (each run is a continuous
 * needle path; the machine jumps needle-up between runs). Most shapes are a
 * single run; TEXT yields one run per stroke polyline. All points are placed
 * into bed space (rotation + anchor applied).
 */
function objectRuns(obj: EmbObject, p: EmbParams): XY[][] {
  const runs: XY[][] = []
  const place = (pt: XY) => placeXY(pt, obj)

  if (obj.kind === 'text') {
    const strokes = embFont().layout(obj.text, { charHeightMm: Math.max(0.5, obj.charHeight) })
    for (const pl of strokes) {
      if (pl.points.length < 1) continue
      // The font grows +Y downward; flip so lettering reads upright on the bed.
      const local = pl.points.map((q) => ({ x: q.x, y: -q.y }))
      const sampled = local.length >= 2 ? sampleAlong(local, p.stitchLength, false) : local
      if (sampled.length) runs.push(sampled.map(place))
    }
    return runs
  }

  if (obj.kind === 'imported') {
    const scaled = obj.points.map((q) => ({ x: q.x * obj.scale, y: q.y * obj.scale }))
    if (scaled.length < 2) return runs
    if (obj.mode === 'satin' && obj.closed && scaled.length >= 3) {
      const pts = scanlineFill(scaled, p.rowSpacing, p.stitchLength)
      if (pts.length) runs.push(pts.map(place))
    } else {
      const sampled = sampleAlong(scaled, p.stitchLength, obj.closed)
      if (sampled.length) runs.push(sampled.map(place))
    }
    return runs
  }

  if (obj.kind === 'line') {
    if (obj.mode === 'satin') {
      runs.push(satinColumn(obj.length, obj.width, p.stitchLength).map(place))
    } else {
      const a = { x: -obj.length / 2, y: 0 }
      const b = { x: obj.length / 2, y: 0 }
      runs.push(sampleAlong([a, b], p.stitchLength, false).map(place))
    }
    return runs
  }

  const outline = localOutline(obj)
  if (!outline) return runs
  if (obj.mode === 'satin') {
    const pts = scanlineFill(outline, p.rowSpacing, p.stitchLength)
    if (pts.length) runs.push(pts.map(place))
  } else {
    runs.push(sampleAlong(outline, p.stitchLength, true).map(place))
  }
  return runs
}

/** Aggregate stitch count, stitched length (mm) and jump length (mm). */
function stitchStats(objects: EmbObject[], p: EmbParams): { stitches: number; stitchLen: number; jumpLen: number } {
  let stitches = 0
  let stitchLen = 0
  let jumpLen = 0
  for (const obj of objects) {
    for (const run of objectRuns(obj, p)) {
      if (run.length === 0) continue
      for (let i = 0; i < run.length; i++) {
        stitches += 1
        if (i > 0) {
          const g = dist(run[i - 1], run[i])
          if (g > p.jumpThreshold) jumpLen += g
          else stitchLen += g
        }
      }
      stitches += 2 * Math.max(0, Math.floor(p.tieCount))
    }
  }
  return { stitches, stitchLen, jumpLen }
}

/** Rough cycle-time estimate (s): hoop stitch travel + needle-up jumps + per-stitch settle. */
function estimateSeconds(objects: EmbObject[], p: EmbParams): number {
  const { stitches, stitchLen, jumpLen } = stitchStats(objects, p)
  const move = (stitchLen / Math.max(1, p.punchFeed)) * 60
  const jump = (jumpLen / Math.max(1, p.travelFeed)) * 60
  const perStitch = 0.05
  return move + jump + stitches * perStitch
}

/**
 * Emit an XY-ONLY embroidery program. The needle is driven by the machine on its
 * own Z motor (synced to the fabric feed), so karmyogi outputs ONLY the hoop XY
 * positioning: one `G1 X Y F<stitchFeed>` per stitch point, `G0 X Y` rapids to
 * jump (needle-up) between runs and across long gaps. Header is `G21 G90 G94`
 * (mm / absolute / units-per-min) — no G17, no Z, no spindle, no M3/M5. The
 * program optionally returns the hoop to the work origin at the end.
 */
function generateEmbroidery(objects: EmbObject[], p: EmbParams): string {
  const dec = clampDecimals(p.decimals)
  const f = (n: number) => fmt(n, dec)
  const L: string[] = []
  L.push('(karmyogi embroidery — XY hoop motion only)')
  L.push('(needle is machine-driven, synced to fabric feed; no Z / spindle output)')
  L.push('G21 G90 G94')

  let lastFeed = -1
  // A stitch = a single XY feed move; the machine punches at every hoop stop.
  const stitchTo = (x: number, y: number) => {
    if (p.punchFeed !== lastFeed) {
      L.push(`G1 X${f(x)} Y${f(y)} F${f(p.punchFeed)}`)
      lastFeed = p.punchFeed
    } else {
      L.push(`G1 X${f(x)} Y${f(y)}`)
    }
  }
  // A jump = a needle-up rapid reposition (F persists modally across G0).
  const jumpTo = (x: number, y: number) => {
    L.push(`G0 X${f(x)} Y${f(y)}`)
  }

  const ties = Math.max(0, Math.floor(p.tieCount))
  objects.forEach((obj, oi) => {
    const runs = objectRuns(obj, p)
    if (runs.every((r) => r.length === 0)) return
    const modeLbl = obj.kind === 'text' ? 'running' : obj.kind === 'imported' ? (obj.closed ? obj.mode : 'running') : obj.mode
    L.push(`(obj ${oi + 1}: ${obj.kind} ${modeLbl})`)
    for (const run of runs) {
      if (run.length === 0) continue
      // Needle-up rapid to the run start, then lock with tie-in stitches.
      jumpTo(run[0].x, run[0].y)
      for (let i = 0; i < ties; i++) stitchTo(run[0].x, run[0].y)
      let prev = run[0]
      for (let i = 1; i < run.length; i++) {
        const q = run[i]
        if (dist(prev, q) > p.jumpThreshold) {
          // Long gap → needle-up jump (no stitch across it).
          jumpTo(q.x, q.y)
        } else {
          stitchTo(q.x, q.y)
        }
        prev = q
      }
      // Tie-off: lock stitches at the run end.
      const last = run[run.length - 1]
      for (let i = 0; i < ties; i++) stitchTo(last.x, last.y)
    }
  })

  if (p.returnToOrigin) L.push('G0 X0 Y0')
  L.push('M30')
  return L.join('\n') + '\n'
}

/* ═══════════════════════════════════════════════════════════════════════════
   Load / persist validation (untrusted JSON & restored localStorage)
   ══════════════════════════════════════════════════════════════════════════ */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const numOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
const boolOr = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb)
const modeOr = (v: unknown, fb: StitchMode): StitchMode => (v === 'running' || v === 'satin' ? v : fb)

function parseObject(v: unknown): EmbObject | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' && v.id.length > 0 ? v.id : newEmbId()
  const x = numOr(v.x, 0)
  const y = numOr(v.y, 0)
  const rotation = numOr(v.rotation, 0)
  const mode = modeOr(v.mode, 'running')
  switch (v.kind) {
    case 'line': {
      const d = defaultLine()
      return { ...d, id, x, y, rotation, mode, length: numOr(v.length, d.length), width: numOr(v.width, d.width) }
    }
    case 'rect': {
      const d = defaultRect()
      return { ...d, id, x, y, rotation, mode, width: numOr(v.width, d.width), height: numOr(v.height, d.height) }
    }
    case 'circle': {
      const d = defaultCircle()
      return { ...d, id, x, y, rotation, mode, rx: numOr(v.rx, d.rx), ry: numOr(v.ry, d.ry) }
    }
    case 'polygon': {
      const d = defaultPolygon()
      return {
        ...d, id, x, y, rotation, mode,
        sides: Math.max(3, Math.floor(numOr(v.sides, d.sides))),
        radius: numOr(v.radius, d.radius),
        star: boolOr(v.star, d.star),
        innerRatio: numOr(v.innerRatio, d.innerRatio),
      }
    }
    case 'text': {
      const d = defaultText()
      return {
        ...d, id, x, y, rotation, mode,
        text: typeof v.text === 'string' ? v.text : d.text,
        charHeight: numOr(v.charHeight, d.charHeight),
      }
    }
    case 'imported': {
      const d = defaultImported()
      const pts: XY[] = []
      if (Array.isArray(v.points)) {
        for (const rp of v.points) {
          if (isRecord(rp)) pts.push({ x: numOr(rp.x, 0), y: numOr(rp.y, 0) })
        }
      }
      return {
        ...d, id, x, y, rotation, mode,
        points: pts.length >= 2 ? pts : d.points,
        closed: boolOr(v.closed, d.closed),
        scale: Math.max(0.01, numOr(v.scale, d.scale)),
        name: typeof v.name === 'string' ? v.name : undefined,
      }
    }
    default:
      return null
  }
}

function parseParams(v: unknown, base: EmbParams): EmbParams {
  if (!isRecord(v)) return { ...base, decimals: clampDecimals(base.decimals) }
  return {
    stitchLength: Math.max(0.1, numOr(v.stitchLength, base.stitchLength)),
    rowSpacing: Math.max(0.1, numOr(v.rowSpacing, base.rowSpacing)),
    punchFeed: numOr(v.punchFeed, base.punchFeed),
    travelFeed: numOr(v.travelFeed, base.travelFeed),
    jumpThreshold: Math.max(0, numOr(v.jumpThreshold, base.jumpThreshold)),
    tieCount: Math.max(0, Math.floor(numOr(v.tieCount, base.tieCount))),
    returnToOrigin: boolOr(v.returnToOrigin, base.returnToOrigin),
    decimals: clampDecimals(numOr(v.decimals, base.decimals)),
  }
}

/** The serializable Embroidery document written by Save / read by Load. */
interface EmbroideryDoc {
  kind: 'karmyogi.embroidery'
  version: 1
  objects: EmbObject[]
  params: EmbParams
}

/** Human-readable duration from seconds. */
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

const numInput = (v: string, fb: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fb
}

/* ═══════════════════════════════════════════════════════════════════════════
   UI
   ══════════════════════════════════════════════════════════════════════════ */

/** A slim square icon button for the header toolbar (self-documenting tooltip). */
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
      className={`emb-ico${className ? ' ' + className : ''}`}
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

const KIND_ADDERS: { kind: EmbKind; glyph: string; key: string; label: string; body: string }[] = [
  { kind: 'line', glyph: '╱', key: 'emb.add.line', label: 'Add line', body: 'A straight stitch line — running along it, or a satin column.' },
  { kind: 'rect', glyph: '▭', key: 'emb.add.rect', label: 'Add rectangle', body: 'A rectangle outline (running) or a solid satin/fill.' },
  { kind: 'circle', glyph: '◯', key: 'emb.add.circle', label: 'Add circle', body: 'A circle / ellipse outline or fill.' },
  { kind: 'polygon', glyph: '⬠', key: 'emb.add.polygon', label: 'Add polygon', body: 'An N-point polygon or star, outline or fill.' },
  { kind: 'text', glyph: 'T', key: 'emb.add.text', label: 'Add text', body: 'Single-stroke lettering stitched along its strokes.' },
]

/**
 * Embroidery panel — a needle-embroidery planner. Build a LIST of decorative
 * OBJECTS (line, rectangle, circle/ellipse, polygon/star, single-stroke TEXT),
 * each positioned/rotated/sized with a stitch MODE (running outline or satin/
 * fill). The pure core turns every object into ordered STITCH POINTS; the hoop
 * moves in XY between punches and the needle punches at each point (Z-plunge or
 * spindle-pulse). Generation is live — every edit pushes a fresh, safe program
 * into the shared store (Visualizer renders it / Program tab streams it).
 */
export function EmbroideryPanel() {
  const t = useT()
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)

  const [objects, setObjects] = usePersistentState<EmbObject[]>('karmyogi.embroidery.objects', [])
  const [selected, setSelected] = usePersistentState<string>('karmyogi.embroidery.selectedId', '')
  const [defaultsOpen, setDefaultsOpen] = usePersistentState<boolean | null>('karmyogi.embroidery.defaultsOpen', null)
  const [params, setParams] = usePersistentState<EmbParams>('karmyogi.embroidery.params', defaultParams())
  const [loadError, setLoadError] = useState('')
  const [importWarnings, setImportWarnings] = useState<string[]>([])
  const vectorInputRef = useRef<HTMLInputElement>(null)

  // Sanitize a possibly-corrupt persisted `decimals` once on mount so it can
  // never reach toFixed() out of range and white-screen the render-phase useMemo.
  useEffect(() => {
    if (clampDecimals(params.decimals) !== params.decimals) {
      setParams((p) => ({ ...p, decimals: clampDecimals(p.decimals) }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addObject(kind: EmbKind) {
    const obj = defaultOf(kind)
    setObjects((s) => [...s, obj])
    setSelected(obj.id)
  }
  function deleteObject(id: string) {
    setObjects((s) => s.filter((o) => o.id !== id))
    setSelected((sel) => (sel === id ? '' : sel))
  }
  function clearAll() {
    if (objects.length === 0) return
    if (!window.confirm(t('emb.clearConfirm', 'Remove all {n} pattern object(s)?', { n: objects.length }))) return
    setObjects([])
    setSelected('')
  }
  function duplicateObject(id: string) {
    setObjects((s) => {
      const i = s.findIndex((o) => o.id === id)
      if (i < 0) return s
      const copy = { ...s[i], id: newEmbId() } as EmbObject
      const next = [...s]
      next.splice(i + 1, 0, copy)
      setSelected(copy.id)
      return next
    })
  }
  function moveObject(id: string, dir: -1 | 1) {
    setObjects((s) => {
      const i = s.findIndex((o) => o.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= s.length) return s
      const next = [...s]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }
  function updateObject(id: string, patch: EmbPatch) {
    setObjects((s) => s.map((o) => (o.id === id ? ({ ...o, ...patch } as EmbObject) : o)))
  }
  /** Swap an object to a new kind, preserving shared anchor/rotation/mode. */
  function convertKind(id: string, kind: EmbKind) {
    setObjects((s) =>
      s.map((o) => {
        if (o.id !== id || o.kind === kind) return o
        const base = defaultOf(kind)
        return { ...base, id: o.id, x: o.x, y: o.y, rotation: o.rotation, mode: o.mode }
      }),
    )
  }

  /** Turn imported SVG/DXF polylines into one embroidery object per path. Each
      path's points are centred about their own bbox so its anchor sits at the
      path's native centre (rotate/scale then pivot cleanly about it). */
  function addImportedPaths(paths: ImportedPath[], sourceName: string) {
    const created: EmbImported[] = []
    for (const path of paths) {
      if (path.points.length < 2) continue
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
      for (const pt of path.points) {
        if (pt.x < minX) minX = pt.x
        if (pt.y < minY) minY = pt.y
        if (pt.x > maxX) maxX = pt.x
        if (pt.y > maxY) maxY = pt.y
      }
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      created.push({
        id: newEmbId(),
        kind: 'imported',
        x: cx,
        y: cy,
        rotation: 0,
        mode: 'running',
        points: path.points.map((pt) => ({ x: pt.x - cx, y: pt.y - cy })),
        closed: path.closed,
        scale: 1,
        name: sourceName,
      })
    }
    if (created.length === 0) {
      setLoadError(t('emb.import.empty', 'No usable paths in that file.'))
      return
    }
    setObjects((s) => [...s, ...created])
    setSelected(created[created.length - 1].id)
  }

  function pickVectorFile() {
    setLoadError('')
    setImportWarnings([])
    vectorInputRef.current?.click()
  }
  async function onVectorFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setLoadError('')
    setImportWarnings([])
    try {
      const text = await file.text()
      const r = importVectorFile(file.name, text)
      if (!r.ok) {
        setLoadError(r.error ?? t('emb.import.failed', 'Could not import that vector file.'))
        return
      }
      addImportedPaths(r.paths, file.name)
      if (r.warnings.length) setImportWarnings(r.warnings)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  const safeParams = useMemo(() => ({ ...params, decimals: clampDecimals(params.decimals) }), [params])
  const gcode = useMemo(() => generateEmbroidery(objects, safeParams), [objects, safeParams])
  const stats = useMemo(() => stitchStats(objects, safeParams), [objects, safeParams])
  const estSeconds = useMemo(() => estimateSeconds(objects, safeParams), [objects, safeParams])
  const gLineCount = useMemo(() => gcode.split('\n').filter((l) => l.trim().length > 0).length, [gcode])
  const effectiveLines = objects.length === 0 ? 0 : gLineCount

  // Live generation: push the freshly-computed program (debounced) so the
  // Visualizer + Program tab pick it up without a manual Generate step. Empty
  // list → DROP the section. Never reset an active stream.
  useEffect(() => {
    if (streaming) return
    if (!objects.length) {
      removeSection('embroidery')
      return
    }
    const id = window.setTimeout(() => setProgram('embroidery', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, objects.length, setProgram, removeSection, streaming])

  // ---- Save / Load document ------------------------------------------------
  const doc: EmbroideryDoc = { kind: 'karmyogi.embroidery', version: 1, objects, params }
  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('emb.load.bad', 'Could not load — not a valid embroidery file.'))
      return
    }
    if (Array.isArray(data.objects)) {
      const next: EmbObject[] = []
      for (const raw of data.objects) {
        const o = parseObject(raw)
        if (o) next.push(o)
      }
      setObjects(next)
      setSelected(next.length > 0 ? next[0].id : '')
    }
    setParams((p) => parseParams(data.params, p))
    setLoadError('')
  }

  // ---- Setting PRESETS (global params only) --------------------------------
  const presets = usePresets<EmbParams>({
    storageKey: 'karmyogi.embroidery.presets',
    capture: () => ({ ...params }),
    onApply: (pp) => setParams((prev) => parseParams(pp, prev)),
  })

  // Gamepad command bus: navigate / delete objects.
  const stepSel = (dir: -1 | 1) => {
    if (objects.length === 0) return
    const cur = objects.findIndex((o) => o.id === selected)
    const base = cur < 0 ? (dir === 1 ? -1 : 0) : cur
    const next = objects[(base + dir + objects.length) % objects.length]
    if (next) setSelected(next.id)
  }
  useTabCommands('embroidery', {
    nextPoint: () => stepSel(1),
    prevPoint: () => stepSel(-1),
    deletePoint: () => {
      if (selected) deleteObject(selected)
    },
  })

  const defaultsEffectiveOpen = defaultsOpen ?? objects.length === 0
  const toggleDefaults = () => setDefaultsOpen(!defaultsEffectiveOpen)

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('emb.presets.aria', 'Embroidery setting presets')}
      />
      <div className="emb-panel">
        {/* Slim header: title + icon toolbar. */}
        <header className="emb-head">
          <div className="emb-head-title">
            <span className="emb-head-name">{t('emb.title', 'Embroidery')}</span>
            <InfoTip
              topic="embMode"
              title={t('emb.title', 'Embroidery')}
              body={t(
                'emb.intro',
                'Build a list of decorative objects — line, rectangle, circle/ellipse, polygon/star, single-stroke text, or an imported SVG/DXF path — each with a position, size, rotation and a stitch mode (running outline or satin/fill). karmyogi outputs ONLY the hoop XY motion (one move per stitch); the machine drives the needle on its own Z, synced to the fabric feed. The program auto-syncs to the Program tab.',
              )}
            />
          </div>
          <div className="emb-tools">
            {KIND_ADDERS.map((a) => (
              <ToolButton
                key={a.kind}
                className="emb-ico-primary"
                glyph={a.glyph}
                onClick={() => addObject(a.kind)}
                title={t(a.key, a.label)}
                body={t(`${a.key}.body`, a.body)}
              />
            ))}
            <span className="emb-tools-sep" aria-hidden="true" />
            <input
              ref={vectorInputRef}
              type="file"
              accept={VECTOR_ACCEPT}
              className="emb-file-hidden"
              onChange={onVectorFile}
              tabIndex={-1}
              aria-hidden="true"
            />
            <ToolButton
              glyph={<Icon name="upload" />}
              onClick={pickVectorFile}
              title={t('emb.toolbar.loadVector', 'Load vector file')}
              body={t('emb.toolbar.loadVector.body', 'Import an SVG or DXF drawing — each path becomes a running-stitch (or fill) object you can position, scale and rotate.')}
            />
            <span className="emb-tools-sep" aria-hidden="true" />
            <ToolButton
              className={defaultsEffectiveOpen ? 'is-active' : ''}
              glyph={<Icon name="settings" />}
              onClick={toggleDefaults}
              ariaExpanded={defaultsEffectiveOpen}
              title={t('emb.toolbar.settings', 'Settings')}
              body={t('emb.toolbar.settings.body', 'Global stitch length, fill density, stitch/travel feeds, jump threshold, tie stitches and return-to-origin.')}
            />
            <span className="emb-tools-sep" aria-hidden="true" />
            <SaveLoadButtons
              value={doc}
              onLoad={loadDoc}
              onError={setLoadError}
              fileBase="karmyogi-embroidery"
              ext="kemb"
              saveDisabled={objects.length === 0}
              saveTitle={t('emb.toolbar.save', 'Save objects + settings')}
              loadTitle={t('emb.toolbar.load', 'Load objects + settings')}
            />
            <span className="emb-tools-sep" aria-hidden="true" />
            <ToolButton
              className="emb-ico-danger"
              glyph={<Icon name="trash" />}
              onClick={clearAll}
              disabled={objects.length === 0}
              title={t('emb.toolbar.clear', 'Clear all')}
              body={t('emb.toolbar.clear.body', 'Remove every object and start over.')}
            />
          </div>
        </header>

        {/* Live status strip: object + stitch counts, length, est. time. */}
        <div className="emb-status">
          <CamStatus
            items={[
              { value: objects.length, unit: t('emb.status.objects', 'objects') },
              {
                value: stats.stitches,
                unit: t('emb.status.stitches', 'stitches'),
                title: t('emb.status.stitches.title', 'Total needle punches (including tie-in/tie-off stitches).'),
              },
              { value: stats.stitchLen.toFixed(0), unit: t('emb.status.mm', 'mm stitched') },
              { value: effectiveLines, unit: t('emb.status.gcode', 'G-code lines') },
              {
                value: fmtDuration(estSeconds, t),
                unit: t('emb.status.est', 'est.'),
                title: t('emb.status.est.title', 'Estimated cycle time (stitch travel + jumps + per-punch dwell).'),
              },
            ]}
          />
        </div>

        {loadError && <p className="emb-warn">{loadError}</p>}
        {importWarnings.length > 0 && (
          <p className="emb-warn">
            {t('emb.import.warnings', 'Import notes:')} {importWarnings.join(' · ')}
          </p>
        )}
        {!connected && objects.length > 0 && (
          <p className="emb-warn">
            {t('emb.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
          </p>
        )}

        {/* Defaults disclosure (worded trigger + rotating caret). */}
        <button
          type="button"
          className="emb-defaults-toggle"
          data-open={defaultsEffectiveOpen}
          aria-expanded={defaultsEffectiveOpen}
          onClick={toggleDefaults}
        >
          <Icon name="settings" size={14} className="emb-defaults-ico" />
          <span className="emb-defaults-word">{t('emb.defaults.disclosure', 'Defaults')}</span>
          <span className="ui-caret" aria-hidden="true">
            <Icon name="chevron-right" size={14} />
          </span>
        </button>

        {defaultsEffectiveOpen && (
          <section className="emb-settings">
            <div className="emb-card">
              <div className="emb-card-head">
                <h4>
                  <Icon name="jog" size={14} className="cam-card-ico" /> {t('emb.stitch.title', 'Stitch & density')}
                </h4>
                <InfoTip
                  topic="embStitch"
                  title={t('emb.stitch.title', 'Stitch & density')}
                  body={t('emb.stitch.body', 'Stitch length is the spacing between punches along a path. Fill density is the row spacing of the satin/fill boustrophedon. Jump threshold decides when a long move travels needle-up instead of stitching across.')}
                />
              </div>
              <div className="emb-fields">
                <SliderField
                  label={t('emb.field.stitchLength', 'Stitch length')}
                  unit={t('unit.mm', 'mm')}
                  min={0.5}
                  max={6}
                  step={0.1}
                  value={params.stitchLength}
                  onChange={(n) => setParams((p) => ({ ...p, stitchLength: Math.max(0.1, n) }))}
                  title={t('emb.field.stitchLength.tip', 'Distance between consecutive stitches along a path.')}
                />
                <SliderField
                  label={t('emb.field.rowSpacing', 'Fill density')}
                  unit={t('unit.mm', 'mm')}
                  min={0.4}
                  max={5}
                  step={0.1}
                  value={params.rowSpacing}
                  onChange={(n) => setParams((p) => ({ ...p, rowSpacing: Math.max(0.1, n) }))}
                  title={t('emb.field.rowSpacing.tip', 'Row spacing for satin/fill — smaller = denser stitching.')}
                />
                <SliderField
                  label={t('emb.field.jump', 'Jump threshold')}
                  unit={t('unit.mm', 'mm')}
                  min={1}
                  max={50}
                  step={1}
                  value={params.jumpThreshold}
                  onChange={(n) => setParams((p) => ({ ...p, jumpThreshold: Math.max(0, n) }))}
                  title={t('emb.field.jump.tip', 'Moves longer than this travel needle-up instead of stitching.')}
                />
                <SliderField
                  label={t('emb.field.tie', 'Tie stitches')}
                  min={0}
                  max={8}
                  step={1}
                  value={params.tieCount}
                  onChange={(n) => setParams((p) => ({ ...p, tieCount: Math.max(0, Math.floor(n)) }))}
                  title={t('emb.field.tie.tip', 'Locking punches at each run start & end to anchor the thread.')}
                />
              </div>
            </div>

            <div className="emb-card">
              <div className="emb-card-head">
                <h4>
                  <Icon name="jog" size={14} className="cam-card-ico" /> {t('emb.feeds.title', 'Feeds & output')}
                </h4>
                <InfoTip
                  topic="embFeeds"
                  title={t('emb.feeds.title', 'Feeds & output')}
                  body={t('emb.feeds.body', 'Stitch feed advances the hoop between stitch points (G1); travel feed is the needle-up jump speed reference. Output is XY-only — the machine drives the needle. Optionally return the hoop to the work origin (G0 X0 Y0) at program end.')}
                />
              </div>
              <div className="emb-fields">
                <SliderField
                  label={t('emb.field.punchFeed', 'Stitch feed')}
                  unit={t('unit.mmPerMin', 'mm/min')}
                  min={50}
                  max={5000}
                  step={50}
                  value={params.punchFeed}
                  onChange={(n) => setParams((p) => ({ ...p, punchFeed: n }))}
                  title={t('emb.field.punchFeed.tip', 'Feed used to advance the hoop from stitch point to stitch point (G1).')}
                />
                <SliderField
                  label={t('emb.field.travelFeed', 'Travel feed')}
                  unit={t('unit.mmPerMin', 'mm/min')}
                  min={100}
                  max={8000}
                  step={100}
                  value={params.travelFeed}
                  onChange={(n) => setParams((p) => ({ ...p, travelFeed: n }))}
                  title={t('emb.field.travelFeed.tip', 'Reference speed for needle-up jumps between objects (jumps emit G0 rapids).')}
                />
                <SliderField
                  label={t('emb.field.decimals', 'Decimals')}
                  min={0}
                  max={6}
                  step={1}
                  value={params.decimals}
                  onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                  title={t('emb.field.decimals.tip', 'Number of decimal places in emitted coordinates (0–6).')}
                />
                <div className="emb-seg-row">
                  <span className="emb-seg-lbl">{t('emb.field.returnOrigin', 'End at origin')}</span>
                  <SegControl<'yes' | 'no'>
                    options={[
                      { value: 'yes', label: t('emb.returnOrigin.on', 'Yes') },
                      { value: 'no', label: t('emb.returnOrigin.off', 'No') },
                    ]}
                    value={params.returnToOrigin ? 'yes' : 'no'}
                    onChange={(v) => setParams((p) => ({ ...p, returnToOrigin: v === 'yes' }))}
                    ariaLabel={t('emb.field.returnOrigin', 'Return to origin at program end')}
                    variant="tonal"
                    size="sm"
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* Pattern objects — one editable card each. */}
        <div className="emb-card emb-objects">
          <div className="emb-card-head">
            <h4>
              <Icon name="frame" size={14} className="cam-card-ico" /> {t('emb.objects.title', 'Pattern objects')}
            </h4>
            <span className="emb-card-count">{objects.length}</span>
          </div>
          <div className="emb-obj-list">
            {objects.length === 0 && (
              <CamEmpty
                icon={<Icon name="frame" size={22} />}
                title={t('emb.empty.title', 'Add your first pattern')}
                hint={t('emb.empty.hint', 'Add a line, rectangle, circle, polygon/star or text, then set its position, size and stitch mode.')}
                action={
                  <button type="button" className="cam-primary" onClick={() => addObject('rect')}>
                    <Icon name="add" size={14} /> {t('emb.empty.add', 'Add pattern')}
                  </button>
                }
              />
            )}
            {objects.map((obj, i) => (
              <ObjectCard
                key={obj.id}
                obj={obj}
                index={i}
                isFirst={i === 0}
                isLast={i === objects.length - 1}
                selected={obj.id === selected}
                t={t}
                onSelect={() => setSelected(obj.id)}
                onConvert={(k) => convertKind(obj.id, k)}
                onUpdate={(patch) => updateObject(obj.id, patch)}
                onMove={(dir) => moveObject(obj.id, dir)}
                onDuplicate={() => duplicateObject(obj.id)}
                onDelete={() => deleteObject(obj.id)}
              />
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
            value={params}
            onLoad={(data) => setParams((p) => parseParams(data, p))}
            onError={setLoadError}
            fileBase="embroidery-settings"
            ext="kembset"
            saveTitle={t('emb.presets.saveSettings', 'Save embroidery settings to file')}
            loadTitle={t('emb.presets.loadSettings', 'Load embroidery settings from file')}
          />
        }
      />
    </div>
  )
}

const KIND_LABELS: { kind: EmbKind; key: string; label: string }[] = [
  { kind: 'line', key: 'emb.kind.line', label: 'Line' },
  { kind: 'rect', key: 'emb.kind.rect', label: 'Rect' },
  { kind: 'circle', key: 'emb.kind.circle', label: 'Circle' },
  { kind: 'polygon', key: 'emb.kind.polygon', label: 'Polygon' },
  { kind: 'text', key: 'emb.kind.text', label: 'Text' },
]

/** One embroidery object as an editable card. */
function ObjectCard(props: {
  obj: EmbObject
  index: number
  isFirst: boolean
  isLast: boolean
  selected: boolean
  t: ReturnType<typeof useT>
  onSelect: () => void
  onConvert: (k: EmbKind) => void
  onUpdate: (patch: EmbPatch) => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { obj, index, isFirst, isLast, selected, t, onSelect, onConvert, onUpdate, onMove, onDuplicate, onDelete } = props
  const stop = (e: React.MouseEvent) => e.stopPropagation()

  const mini = (label: string, value: number, onChange: (n: number) => void, step = 0.5) => (
    <label className="emb-mini">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onClick={stop}
        onChange={(e) => onChange(numInput(e.target.value, value))}
      />
    </label>
  )

  return (
    <div className={`emb-ocard${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <div className="emb-ocard-head">
        <span className="emb-ocard-idx">
          {obj.kind === 'imported'
            ? t('emb.kind.imported', 'Imported')
            : t(KIND_LABELS.find((k) => k.kind === obj.kind)?.key ?? 'emb.kind.rect', 'Shape')}{' '}
          {index + 1}
        </span>
        {obj.kind === 'imported' ? (
          obj.name && (
            <span className="emb-imported-name" title={obj.name}>
              {obj.name}
            </span>
          )
        ) : (
          <div className="emb-kind-toggle" onClick={stop} role="group" aria-label={t('emb.card.kind', 'Kind')}>
            {KIND_LABELS.map((k) => (
              <button
                key={k.kind}
                type="button"
                className={`emb-kind-btn${obj.kind === k.kind ? ' is-on' : ''}`}
                onClick={() => onConvert(k.kind)}
                title={t(k.key, k.label)}
              >
                {t(k.key, k.label)}
              </button>
            ))}
          </div>
        )}
        <div className="emb-ocard-actions">
          <button className="emb-row-ico" title={t('emb.row.moveUp', 'Move up')} aria-label={t('emb.row.moveUp', 'Move up')}
            onClick={(e) => { stop(e); onMove(-1) }} disabled={isFirst}>↑</button>
          <button className="emb-row-ico" title={t('emb.row.moveDown', 'Move down')} aria-label={t('emb.row.moveDown', 'Move down')}
            onClick={(e) => { stop(e); onMove(1) }} disabled={isLast}>↓</button>
          <button className="emb-row-ico" title={t('emb.row.duplicate', 'Duplicate')} aria-label={t('emb.row.duplicate', 'Duplicate')}
            onClick={(e) => { stop(e); onDuplicate() }}>
            <Icon name="duplicate" size={14} />
          </button>
          <button className="emb-row-ico emb-del" title={t('emb.row.delete', 'Delete')} aria-label={t('emb.row.delete', 'Delete')}
            onClick={(e) => { stop(e); onDelete() }}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {/* Placement: anchor X/Y + rotation. */}
      <div className="emb-vec">
        <span className="emb-vec-label">{t('emb.geom.pos', 'Pos')}</span>
        {mini(t('emb.axis.x', 'X'), obj.x, (n) => onUpdate({ x: n }))}
        {mini(t('emb.axis.y', 'Y'), obj.y, (n) => onUpdate({ y: n }))}
        {mini(t('emb.geom.rot', 'Rot°'), obj.rotation, (n) => onUpdate({ rotation: n }), 5)}
      </div>

      {/* Per-kind size fields. */}
      <div className="emb-vec">
        <span className="emb-vec-label">{t('emb.geom.size', 'Size')}</span>
        {obj.kind === 'line' && (
          <>
            {mini(t('emb.geom.length', 'Len'), obj.length, (n) => onUpdate({ length: n }))}
            {obj.mode === 'satin' && mini(t('emb.geom.width', 'Wid'), obj.width, (n) => onUpdate({ width: n }))}
          </>
        )}
        {obj.kind === 'rect' && (
          <>
            {mini(t('emb.geom.width', 'W'), obj.width, (n) => onUpdate({ width: n }))}
            {mini(t('emb.geom.height', 'H'), obj.height, (n) => onUpdate({ height: n }))}
          </>
        )}
        {obj.kind === 'circle' && (
          <>
            {mini(t('emb.geom.rx', 'Rx'), obj.rx, (n) => onUpdate({ rx: n }))}
            {mini(t('emb.geom.ry', 'Ry'), obj.ry, (n) => onUpdate({ ry: n }))}
          </>
        )}
        {obj.kind === 'polygon' && (
          <>
            {mini(t('emb.geom.sides', 'Pts'), obj.sides, (n) => onUpdate({ sides: Math.max(3, Math.round(n)) }), 1)}
            {mini(t('emb.geom.radius', 'R'), obj.radius, (n) => onUpdate({ radius: n }))}
          </>
        )}
        {obj.kind === 'text' && mini(t('emb.geom.charH', 'Size'), obj.charHeight, (n) => onUpdate({ charHeight: Math.max(0.5, n) }))}
        {obj.kind === 'imported' && (
          <>
            {mini(t('emb.geom.scale', 'Scale'), obj.scale, (n) => onUpdate({ scale: Math.max(0.01, n) }), 0.05)}
            <span className="emb-imported-meta">
              {t('emb.geom.points', '{n} pts', { n: obj.points.length })}
              {obj.closed ? ' · ' + t('emb.geom.closed', 'closed') : ''}
            </span>
          </>
        )}
      </div>

      {/* Text content + star options. */}
      {obj.kind === 'text' && (
        <label className="emb-textrow" onClick={stop}>
          <span>{t('emb.geom.text', 'Text')}</span>
          <input
            type="text"
            value={obj.text}
            spellCheck={false}
            onChange={(e) => onUpdate({ text: e.target.value })}
            placeholder={t('emb.geom.text.ph', 'Type letters…')}
          />
        </label>
      )}
      {obj.kind === 'polygon' && (
        <div className="emb-vec emb-star-row" onClick={stop}>
          <span className="emb-vec-label">{t('emb.geom.star', 'Star')}</span>
          <SegControl<'poly' | 'star'>
            options={[
              { value: 'poly', label: t('emb.geom.polyOpt', 'Polygon') },
              { value: 'star', label: t('emb.geom.starOpt', 'Star') },
            ]}
            value={obj.star ? 'star' : 'poly'}
            onChange={(v) => onUpdate({ star: v === 'star' })}
            ariaLabel={t('emb.geom.star', 'Polygon or star')}
            variant="tonal"
            size="sm"
          />
          {obj.star && mini(t('emb.geom.inner', 'Inner'), obj.innerRatio, (n) => onUpdate({ innerRatio: Math.max(0.05, Math.min(1, n)) }), 0.05)}
        </div>
      )}

      {/* Stitch mode — text is always running along its strokes. */}
      <div className="emb-mode-row" onClick={stop}>
        <span className="emb-seg-lbl">{t('emb.card.mode', 'Stitch')}</span>
        {obj.kind === 'text' ? (
          <span className="emb-mode-note">{t('emb.card.textRunning', 'Running (along strokes)')}</span>
        ) : (
          <SegControl<StitchMode>
            options={[
              { value: 'running', label: t('emb.mode.running', 'Running'), title: t('emb.mode.running.tip', 'Evenly-spaced stitches along the outline.') },
              { value: 'satin', label: t('emb.mode.satin', 'Satin/fill'), title: t('emb.mode.satin.tip', 'Back-and-forth zig-zag fill for a solid area.') },
            ]}
            value={obj.mode}
            onChange={(v) => onUpdate({ mode: v })}
            ariaLabel={t('emb.card.mode', 'Stitch mode')}
            variant="tonal"
            size="sm"
            className="emb-seg-mode"
          />
        )}
      </div>
    </div>
  )
}
