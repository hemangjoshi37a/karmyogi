import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { Icon } from '../components/Icons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { CamEmpty, CamStatus } from '../components/cam/CamUI'
import { SegControl } from '../components/ui/SegControl'
import { importVectorFile, VECTOR_ACCEPT, type ImportedPath } from '../core/vectorImport'
import '../styles/cam.css'
import '../styles/stitching.css'

// ════════════════════════════════════════════════════════════════════════════
//  PURE geometry + G-code core (NO React / DOM below this line, up to the panel)
//  ---------------------------------------------------------------------------
//  A clothes-stitching (sewing) planner. The sewing machine drives the NEEDLE
//  up/down on its OWN Z motor as the fabric feeds, so karmyogi outputs ONLY XY
//  motion — the fabric/seam positioning. Each stitch is a single XY move
//  (G1 X.. Y.. F<feed>) along the seam, spaced by the stitch length; travel
//  between separate seams is a G0 rapid (needle up). There is NO Z output and NO
//  spindle / M3 / M5 for the needle. Backstitch reinforcement is XY re-runs of
//  the first/last stitch intervals in reverse. The mist/aux output (M8/M9) can
//  OPTIONALLY drive a PRESSER-FOOT solenoid and an optional thread-trim M-code
//  may fire per seam — both default OFF (the requirement is "handle only XY").
//  Header is G21/G90/G94 (no G17, no Z, no safe-Z); the program optionally ends
//  by returning to origin (G0 X0 Y0). Number formatting never emits "-0.000".
// ════════════════════════════════════════════════════════════════════════════

/** A point in the bed (XY) plane, mm. Stitching is a flat-fabric operation. */
export interface Pt {
  x: number
  y: number
}

/** Stitch style for a seam. */
export type StitchType = 'lock' | 'zigzag' | 'basting'

/** Seam path kind (discriminator). */
export type SeamKind = 'segment' | 'rect' | 'polyline'

/** Fields shared by every seam kind. */
interface SeamCommon {
  id: string
  /** Nominal stitch length (mm) along the seam for lock/basting styles. */
  stitchLen: number
  /** Stitch style. */
  type: StitchType
  /** Zig-zag full width (mm) — used only when type === 'zigzag'. */
  zigWidth: number
  /** Zig-zag pitch (mm along the seam between successive side swings). */
  zigPitch: number
}

/** A straight seam between two points. */
export interface SeamSegment extends SeamCommon {
  kind: 'segment'
  start: Pt
  end: Pt
}

/** A rectangular hem — all four sides sewn as a closed loop. */
export interface SeamRect extends SeamCommon {
  kind: 'rect'
  x: number
  y: number
  w: number
  h: number
}

/** An ordered polyline seam (path through the listed points; may be a closed ring). */
export interface SeamPoly extends SeamCommon {
  kind: 'polyline'
  points: Pt[]
  /** Closed ring — the seam rejoins its first point when sewn (imported shapes). */
  closed?: boolean
}

/** A single seam object — a discriminated union over `kind`. */
export type Seam = SeamSegment | SeamRect | SeamPoly

/** Global sewing policy (everything NOT per-seam). XY-only — no Z / no needle. */
export interface StitchParams {
  /** XY sewing feed along the seam (mm/min). */
  feed: number
  /** Travel (rapid) feed between separate seams (mm/min) — used for estimates. */
  travelFeed: number
  /** Stitch length (mm) used when creating a new seam. */
  defaultStitchLen: number
  /** Reverse lock stitches sewn at the start AND end of every seam (XY re-runs). */
  backstitch: number
  /** Basting stitch-length multiplier (basting = long stitches). */
  bastingMult: number
  /** Return to origin (G0 X0 Y0) at program end. */
  returnToOrigin: boolean
  /** Actuate the presser-foot solenoid (M8 down / M9 up) around each seam. */
  presserFoot: boolean
  /** Emit a thread-trim command at the end of each seam. */
  trimEnabled: boolean
  /** Thread-trim M-code number (emitted as M<code>). */
  trimCode: number
  /** Dwell (s) held after the thread-trim command. */
  trimDwell: number
  /** Emitted-coordinate decimal places (0..6). */
  decimals: number
}

let idSeq = 0
/** Generate a reasonably-unique id for a fresh seam. */
export function newSeamId(): string {
  idSeq += 1
  return `s${Date.now().toString(36)}_${idSeq.toString(36)}`
}

/** Default global params. */
export function defaultStitchParams(): StitchParams {
  return {
    feed: 800,
    travelFeed: 3000,
    defaultStitchLen: 2.5,
    backstitch: 3,
    bastingMult: 3,
    returnToOrigin: false,
    presserFoot: false,
    trimEnabled: false,
    trimCode: 63,
    trimDwell: 0.3,
    decimals: 3,
  }
}

/** Default per-seam stitch fields, seeded from the global params. */
function seamDefaults(p: StitchParams): Pick<SeamCommon, 'stitchLen' | 'type' | 'zigWidth' | 'zigPitch'> {
  return { stitchLen: p.defaultStitchLen, type: 'lock', zigWidth: 3, zigPitch: 1.5 }
}

/** A fresh straight seam. */
export function defaultSeamSegment(p: StitchParams): SeamSegment {
  return { id: newSeamId(), kind: 'segment', start: { x: 0, y: 0 }, end: { x: 60, y: 0 }, ...seamDefaults(p) }
}

/** A fresh rectangular hem. */
export function defaultSeamRect(p: StitchParams): SeamRect {
  return { id: newSeamId(), kind: 'rect', x: 0, y: 0, w: 60, h: 40, ...seamDefaults(p) }
}

/** A fresh polyline seam (two starter points). */
export function defaultSeamPoly(p: StitchParams): SeamPoly {
  return {
    id: newSeamId(),
    kind: 'polyline',
    points: [
      { x: 0, y: 0 },
      { x: 40, y: 20 },
      { x: 80, y: 0 },
    ],
    ...seamDefaults(p),
  }
}

// ─────────────────────────── vector helpers ───────────────────────────

const dist = (a: Pt, b: Pt): number => Math.hypot(b.x - a.x, b.y - a.y)

/** Total length (mm) of an open polyline. */
export function polylineLength(v: Pt[]): number {
  let L = 0
  for (let i = 1; i < v.length; i++) L += dist(v[i - 1], v[i])
  return L
}

/** The raw path vertices of a seam (rect returned CLOSED, back to its origin). */
export function seamVertices(seam: Seam): Pt[] {
  switch (seam.kind) {
    case 'segment':
      return [{ ...seam.start }, { ...seam.end }]
    case 'rect': {
      const { x, y, w, h } = seam
      return [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
        { x, y },
      ]
    }
    case 'polyline': {
      const pts = seam.points.map((p) => ({ ...p }))
      // A closed ring rejoins its first point so the whole loop is sewn.
      if (seam.closed && pts.length >= 2) pts.push({ ...pts[0] })
      return pts
    }
  }
}

/** Seam centreline length (mm). */
export function seamLength(seam: Seam): number {
  return polylineLength(seamVertices(seam))
}

/** Is this seam degenerate (fewer than 2 points, or zero total length)? */
export function isDegenerateSeam(seam: Seam): boolean {
  const v = seamVertices(seam)
  if (v.length < 2) return true
  return polylineLength(v) < 1e-9
}

/**
 * Walk a polyline placing a point every `spacing` mm of arc-length, starting at
 * the first vertex and always finishing exactly on the last vertex. Returns at
 * least [first, last]. Pure — the heart of turning a seam into stitch points.
 */
export function resamplePolyline(v: Pt[], spacing: number): Pt[] {
  if (v.length === 0) return []
  if (v.length === 1) return [{ ...v[0] }]
  const step = Math.max(0.05, spacing)
  const out: Pt[] = [{ ...v[0] }]
  let carry = 0 // distance already covered past the last placed point
  for (let s = 1; s < v.length; s++) {
    const a = v[s - 1]
    const b = v[s]
    const segLen = dist(a, b)
    if (segLen < 1e-9) continue
    const dx = (b.x - a.x) / segLen
    const dy = (b.y - a.y) / segLen
    let along = step - carry
    while (along <= segLen + 1e-9) {
      out.push({ x: a.x + dx * along, y: a.y + dy * along })
      along += step
    }
    carry = segLen - (along - step)
  }
  const last = v[v.length - 1]
  if (dist(out[out.length - 1], last) > 1e-6) out.push({ ...last })
  return out
}

/**
 * Resample a seam into a ZIG-ZAG stitch line: sample the centreline at `pitch`,
 * then offset each sample alternately ±(width/2) PERPENDICULAR to the local seam
 * direction. Endpoints stay on the centreline for a clean start/end lock.
 */
export function zigzagResample(v: Pt[], pitch: number, width: number): Pt[] {
  const center = resamplePolyline(v, Math.max(0.05, pitch))
  if (center.length < 2) return center
  const half = Math.abs(width) / 2
  const out: Pt[] = []
  for (let i = 0; i < center.length; i++) {
    const a = center[Math.max(0, i - 1)]
    const b = center[Math.min(center.length - 1, i + 1)]
    let tx = b.x - a.x
    let ty = b.y - a.y
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    // perpendicular (left normal)
    const px = -ty
    const py = tx
    const sign = i === 0 || i === center.length - 1 ? 0 : i % 2 === 1 ? 1 : -1
    out.push({ x: center[i].x + px * half * sign, y: center[i].y + py * half * sign })
  }
  return out
}

/** Effective along-seam spacing for a seam's stitch style. */
export function seamSpacing(seam: Seam, p: StitchParams): number {
  if (seam.type === 'basting') return seam.stitchLen * Math.max(1, p.bastingMult)
  if (seam.type === 'zigzag') return seam.zigPitch
  return seam.stitchLen
}

/**
 * The nominal stitch points for a seam (before backstitch reinforcement). For
 * zig-zag these already carry the alternating lateral offset; for lock/basting
 * they lie on the centreline spaced by the effective stitch length.
 */
export function stitchCenterPoints(seam: Seam, p: StitchParams): Pt[] {
  const v = seamVertices(seam)
  if (seam.type === 'zigzag') return zigzagResample(v, Math.max(0.05, seam.zigPitch), seam.zigWidth)
  return resamplePolyline(v, seamSpacing(seam, p))
}

/**
 * Insert BACKSTITCH reinforcement: re-run the first `b` stitch intervals in
 * reverse then forward again to lock the seam start, sew the whole seam, then
 * re-run the last `b` intervals in reverse+forward to lock the end. Returns the
 * FULL ordered list of needle points (with the lock repeats spliced in).
 */
export function withBackstitch(P: Pt[], b: number): Pt[] {
  const n = P.length - 1
  if (n < 1) return P.map((p) => ({ ...p }))
  const bb = Math.max(0, Math.min(Math.floor(b), n))
  const out: Pt[] = [{ ...P[0] }]
  if (bb > 0) {
    for (let i = 1; i <= bb; i++) out.push({ ...P[i] }) // forward b
    for (let i = bb - 1; i >= 0; i--) out.push({ ...P[i] }) // back to start
  }
  for (let i = 1; i <= n; i++) out.push({ ...P[i] }) // forward to the end
  if (bb > 0) {
    for (let i = n - 1; i >= n - bb; i--) out.push({ ...P[i] }) // back b at the end
    for (let i = n - bb + 1; i <= n; i++) out.push({ ...P[i] }) // forward b to finish on the end
  }
  return out
}

/** The final ordered needle points for a seam (stitch points + backstitch). */
export function orderedStitchPoints(seam: Seam, p: StitchParams): Pt[] {
  return withBackstitch(stitchCenterPoints(seam, p), p.backstitch)
}

// ─────────────────────────── G-code ───────────────────────────

/** Clamp decimals into the range toFixed() accepts (0..6). */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Formatted number, never "-0.000". */
function fmt(value: number, decimals: number): string {
  const d = clampDecimals(decimals)
  const snap = 0.5 * Math.pow(10, -d)
  let v = value
  if (Math.abs(v) < snap) v = 0
  if (v === 0) v = 0 // collapse a residual signed zero
  return v.toFixed(d)
}

/**
 * Produce a complete XY-only sewing program for the given seams. The needle
 * rides its OWN Z motor synced to the fabric feed, so this emitter outputs only
 * XY motion — no Z, no spindle / M3 / M5.
 *
 * Header: G21/G90/G94 (mm, absolute, feed/min). Per non-degenerate seam:
 *   1. G0 rapid (needle up) to the seam START.
 *   2. Optional presser-foot solenoid down (M8).
 *   3. One G1 X.. Y.. F<feed> per stitch point along the seam (backstitch
 *      re-runs are already spliced into the ordered points, reversed — no Z).
 *   4. Optional presser-foot up (M9) + optional thread-trim M-code (+ dwell).
 * Footer: optional return to origin (G0 X0 Y0), M30.
 */
export function generateStitching(seams: Seam[], params: Partial<StitchParams> = {}): string {
  const p = { ...defaultStitchParams(), ...params }
  const d = clampDecimals(p.decimals)
  const F = (v: number) => fmt(v, d)
  const o: string[] = []

  // ---- Header (XY only — the needle rides its own Z motor) --------------
  o.push('(karmyogi Clothes Stitching)')
  o.push('(Generated by karmyogi.hjLabs.in Stitching — XY only)')
  o.push('G21') // mm
  o.push('G90') // absolute
  o.push('G94') // feed per minute

  let n = 0
  for (const seam of seams) {
    ++n
    if (isDegenerateSeam(seam)) {
      o.push(`(Seam ${n}: skipped — zero-length ${seam.kind})`)
      continue
    }
    const pts = orderedStitchPoints(seam, p)
    if (pts.length < 2) continue
    const nStitch = stitchCenterPoints(seam, p).length
    o.push(`(Seam ${n}: ${seam.kind} ${seam.type}, ${F(seamLength(seam))}mm, ${nStitch} stitches)`)

    const p0 = pts[0]
    o.push(`G0 X${F(p0.x)} Y${F(p0.y)}`) // rapid (needle up) to the seam start
    if (p.presserFoot) o.push('M8') // presser-foot solenoid down

    // Sew: one XY feed move per stitch point along the seam.
    let feedWritten = false
    for (let i = 1; i < pts.length; i++) {
      const pt = pts[i]
      const feedWord = feedWritten ? '' : ` F${F(p.feed)}`
      o.push(`G1 X${F(pt.x)} Y${F(pt.y)}${feedWord}`)
      feedWritten = true
    }

    if (p.presserFoot) o.push('M9') // presser-foot solenoid up
    if (p.trimEnabled) {
      o.push('(thread trim)')
      o.push(`M${Math.max(0, Math.floor(p.trimCode))}`)
      if (p.trimDwell > 0) o.push(`G4 P${F(p.trimDwell)}`)
    }
  }

  // ---- Footer -----------------------------------------------------------
  if (p.returnToOrigin) o.push('G0 X0 Y0')
  o.push('M30')
  return o.join('\n') + '\n'
}

/** Total seam (centreline) length (mm) across all seams. */
export function totalSeamLength(seams: Seam[]): number {
  let total = 0
  for (const s of seams) total += seamLength(s)
  return total
}

/** Total nominal stitch count across all non-degenerate seams. */
export function totalStitchCount(seams: Seam[], p: StitchParams): number {
  let n = 0
  for (const s of seams) if (!isDegenerateSeam(s)) n += stitchCenterPoints(s, p).length
  return n
}

/**
 * Rough cycle-time estimate (seconds): per non-degenerate seam, the ordered-path
 * sewing time (arc-length ÷ feed) plus the rapid travel from the previous seam's
 * end to this seam's start (÷ travel feed), plus any thread-trim dwell.
 */
export function estimateStitchingSeconds(seams: Seam[], p: StitchParams): number {
  let sec = 0
  const feed = Math.max(1e-6, p.feed)
  const travel = Math.max(1e-6, p.travelFeed)
  let prevEnd: Pt | null = null
  for (const seam of seams) {
    if (isDegenerateSeam(seam)) continue
    const pts = orderedStitchPoints(seam, p)
    if (pts.length === 0) continue
    if (prevEnd) sec += (dist(prevEnd, pts[0]) / travel) * 60 // rapid jump to seam start
    let L = 0
    for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i])
    sec += (L / feed) * 60
    if (p.trimEnabled) sec += Math.max(0, p.trimDwell)
    prevEnd = pts[pts.length - 1]
  }
  return sec
}

// ════════════════════════════════════════════════════════════════════════════
//  React panel
// ════════════════════════════════════════════════════════════════════════════

/** Split G-code into non-empty lines for the operator's line count. */
function gcodeLineCount(gcode: string): number {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0).length
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

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
const intNum = (v: string, fallback: number): number => {
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}

// ---- persisted-doc validation --------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const numOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)
const boolOr = (v: unknown, fb: boolean): boolean => (typeof v === 'boolean' ? v : fb)

const TYPE_VALUES: StitchType[] = ['lock', 'zigzag', 'basting']
const typeOr = (v: unknown, fb: StitchType): StitchType =>
  TYPE_VALUES.includes(v as StitchType) ? (v as StitchType) : fb

function parsePt(v: unknown, base: Pt): Pt {
  if (!isRecord(v)) return { ...base }
  return { x: numOr(v.x, base.x), y: numOr(v.y, base.y) }
}

/** Narrow one unknown entry into a valid Seam (or null). Never throws. */
function parseSeam(v: unknown, params: StitchParams): Seam | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' && v.id.length > 0 ? v.id : newSeamId()
  const common: SeamCommon = {
    id,
    stitchLen: Math.max(0.1, numOr(v.stitchLen, params.defaultStitchLen)),
    type: typeOr(v.type, 'lock'),
    zigWidth: Math.max(0, numOr(v.zigWidth, 3)),
    zigPitch: Math.max(0.1, numOr(v.zigPitch, 1.5)),
  }
  if (v.kind === 'rect') {
    return { ...common, kind: 'rect', x: numOr(v.x, 0), y: numOr(v.y, 0), w: numOr(v.w, 60), h: numOr(v.h, 40) }
  }
  if (v.kind === 'polyline') {
    const raw = Array.isArray(v.points) ? v.points : []
    const points = raw.map((r) => parsePt(r, { x: 0, y: 0 }))
    return {
      ...common,
      kind: 'polyline',
      points: points.length ? points : [{ x: 0, y: 0 }, { x: 40, y: 0 }],
      closed: boolOr(v.closed, false),
    }
  }
  return {
    ...common,
    kind: 'segment',
    start: parsePt(v.start, { x: 0, y: 0 }),
    end: parsePt(v.end, { x: 60, y: 0 }),
  }
}

/** Narrow unknown params into valid StitchParams (per-field fallback). */
function parseParams(v: unknown, base: StitchParams): StitchParams {
  if (!isRecord(v)) return { ...base, decimals: clampDecimals(base.decimals) }
  return {
    feed: Math.max(1, numOr(v.feed, base.feed)),
    travelFeed: Math.max(1, numOr(v.travelFeed, base.travelFeed)),
    defaultStitchLen: Math.max(0.1, numOr(v.defaultStitchLen, base.defaultStitchLen)),
    backstitch: Math.max(0, Math.floor(numOr(v.backstitch, base.backstitch))),
    bastingMult: Math.max(1, numOr(v.bastingMult, base.bastingMult)),
    returnToOrigin: boolOr(v.returnToOrigin, base.returnToOrigin),
    presserFoot: boolOr(v.presserFoot, base.presserFoot),
    trimEnabled: boolOr(v.trimEnabled, base.trimEnabled),
    trimCode: Math.max(0, Math.floor(numOr(v.trimCode, base.trimCode))),
    trimDwell: Math.max(0, numOr(v.trimDwell, base.trimDwell)),
    decimals: clampDecimals(numOr(v.decimals, base.decimals)),
  }
}

/** The serializable Stitching document written by Save / read by Load. */
interface StitchingDoc {
  kind: 'karmyogi.stitching'
  version: 1
  seams: Seam[]
  params: StitchParams
}

const KIND_OPTIONS: { value: SeamKind; key: string; label: string; glyph: string }[] = [
  { value: 'segment', key: 'st.kind.segment', label: 'Segment', glyph: '╱' },
  { value: 'rect', key: 'st.kind.rect', label: 'Rect', glyph: '▭' },
  { value: 'polyline', key: 'st.kind.poly', label: 'Polyline', glyph: '∿' },
]

const TYPE_OPTIONS: { value: StitchType; key: string; label: string }[] = [
  { value: 'lock', key: 'st.type.lock', label: 'Lock' },
  { value: 'zigzag', key: 'st.type.zigzag', label: 'Zig-zag' },
  { value: 'basting', key: 'st.type.basting', label: 'Basting' },
]

/** A slim square icon button for the header toolbar. */
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
      className={`st-ico${className ? ' ' + className : ''}`}
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

/** Sleek slider + number-input + unit row (mirrors the welding/carving field). */
function SliderField(props: {
  label: string
  value: number
  unit?: string
  min: number
  max: number
  step: number
  onChange: (n: number) => void
  parse?: (v: string, fallback: number) => number
  info?: { title: string; body: string }
}) {
  const { label, value, unit, min, max, step, onChange, parse = num, info } = props
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  const pct = max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="st-sfield">
      <span className="st-sfield-lbl">
        <span className="st-sfield-txt">{label}</span>
        {info && <InfoTip topic="stField" title={info.title} body={info.body} />}
      </span>
      <input
        type="range"
        className="st-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        style={{ '--pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="st-sfield-num">
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(parse(e.target.value, value))}
        />
        {unit && <i>{unit}</i>}
      </span>
    </div>
  )
}

/**
 * Clothes-stitching panel — a sewing-seam planner. The operator builds a LIST of
 * SEAM objects (straight segment, rectangular hem, ordered polyline, or imported
 * SVG/DXF paths). Each seam carries its own stitch length and stitch TYPE (lock /
 * zig-zag / basting). Global settings hold the sewing feed, travel feed,
 * backstitch lock count, and optional presser-foot / thread-trim / return-to-
 * origin behaviour. karmyogi outputs XY motion only — the needle rides its own Z
 * motor — so the pure `generateStitching` core emits an XY-only program;
 * generation is live — every edit pushes a fresh program into the shared store
 * (Visualizer renders / Program streams) under the `'stitching'` section.
 */
export function StitchingPanel() {
  const t = useT()
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)

  const [seams, setSeams] = usePersistentState<Seam[]>('karmyogi.stitching.seams', [])
  const [selected, setSelected] = usePersistentState<string>('karmyogi.stitching.selectedId', '')
  const [defaultsOpen, setDefaultsOpen] = usePersistentState<boolean | null>('karmyogi.stitching.defaultsOpen', null)
  const [params, setParams] = usePersistentState<StitchParams>('karmyogi.stitching.params', defaultStitchParams())
  const [loadError, setLoadError] = useState<string>('')
  const [importInfo, setImportInfo] = useState<string>('')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Sanitize PERSISTED decimals once on mount (a restored value bypasses the
  // input/load guards and could reach toFixed()).
  useEffect(() => {
    if (clampDecimals(params.decimals) !== params.decimals) {
      setParams((p) => ({ ...p, decimals: clampDecimals(p.decimals) }))
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── seam CRUD ──
  function addSeam(kind: SeamKind) {
    const seam =
      kind === 'rect' ? defaultSeamRect(params) : kind === 'polyline' ? defaultSeamPoly(params) : defaultSeamSegment(params)
    setSeams((s) => [...s, seam])
    setSelected(seam.id)
  }

  // ── vector-file import (SVG / DXF → one polyline seam per path) ──
  /** Parse a picked SVG/DXF file and append one polyline seam per imported path. */
  async function importVector(file: File) {
    setImportInfo('')
    setLoadError('')
    let text: string
    try {
      text = await file.text()
    } catch {
      setLoadError(t('st.import.readErr', 'Could not read that file.'))
      return
    }
    const r = importVectorFile(file.name, text)
    if (!r.ok) {
      setLoadError(r.error ?? t('st.import.failed', 'Could not import that vector file.'))
      return
    }
    const base = seamDefaults(params)
    const imported: SeamPoly[] = r.paths.map((path: ImportedPath) => ({
      id: newSeamId(),
      kind: 'polyline',
      points: path.points.map((pt) => ({ x: pt.x, y: pt.y })),
      closed: path.closed,
      ...base,
    }))
    if (imported.length === 0) {
      setLoadError(t('st.import.empty', 'No usable paths found in that file.'))
      return
    }
    setSeams((s) => [...s, ...imported])
    setSelected(imported[imported.length - 1].id)
    const notes: string[] = [
      t('st.import.added', 'Imported {n} seam(s) from {name}.', { n: imported.length, name: file.name }),
    ]
    if (r.bounds) {
      notes.push(t('st.import.bounds', 'Fits {w}×{h} mm.', { w: r.bounds.w.toFixed(1), h: r.bounds.h.toFixed(1) }))
    }
    if (r.warnings.length) notes.push(...r.warnings)
    setImportInfo(notes.join(' '))
  }

  function onVectorFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // reset so the same file can be re-picked
    if (file) void importVector(file)
  }

  function deleteSeam(id: string) {
    setSeams((s) => s.filter((o) => o.id !== id))
    setSelected((sel) => (sel === id ? '' : sel))
  }

  function clearAll() {
    if (seams.length === 0) return
    if (!window.confirm(t('st.clearConfirm', 'Remove all {n} seam(s)?', { n: seams.length }))) return
    setSeams([])
    setSelected('')
  }

  function duplicateSeam(id: string) {
    setSeams((s) => {
      const i = s.findIndex((o) => o.id === id)
      if (i < 0) return s
      const src = s[i]
      let copy: Seam
      if (src.kind === 'segment') copy = { ...src, id: newSeamId(), start: { ...src.start }, end: { ...src.end } }
      else if (src.kind === 'rect') copy = { ...src, id: newSeamId() }
      else copy = { ...src, id: newSeamId(), points: src.points.map((p) => ({ ...p })) }
      const next = [...s]
      next.splice(i + 1, 0, copy)
      setSelected(copy.id)
      return next
    })
  }

  function moveSeam(id: string, dir: -1 | 1) {
    setSeams((s) => {
      const i = s.findIndex((o) => o.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= s.length) return s
      const next = [...s]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  function updateSeam(id: string, patch: Partial<SeamSegment> & Partial<SeamRect> & Partial<SeamPoly>) {
    setSeams((s) => s.map((o) => (o.id === id ? ({ ...o, ...patch } as Seam) : o)))
  }

  /** Convert a seam between kinds, preserving stitch settings + an anchor point. */
  function setKind(id: string, kind: SeamKind) {
    setSeams((s) =>
      s.map((o) => {
        if (o.id !== id || o.kind === kind) return o
        const common: SeamCommon = {
          id: o.id,
          stitchLen: o.stitchLen,
          type: o.type,
          zigWidth: o.zigWidth,
          zigPitch: o.zigPitch,
        }
        const v = seamVertices(o)
        const a = v[0] ?? { x: 0, y: 0 }
        const b = v[v.length - 1] ?? { x: a.x + 60, y: a.y }
        if (kind === 'segment') return { ...common, kind: 'segment', start: { ...a }, end: { ...b } }
        if (kind === 'rect')
          return { ...common, kind: 'rect', x: a.x, y: a.y, w: Math.max(10, Math.abs(b.x - a.x) || 60), h: 40 }
        return { ...common, kind: 'polyline', points: v.map((p) => ({ ...p })) }
      }),
    )
  }

  // ── polyline point editing ──
  function updatePolyPoint(id: string, idx: number, patch: Partial<Pt>) {
    setSeams((s) =>
      s.map((o) =>
        o.id === id && o.kind === 'polyline'
          ? { ...o, points: o.points.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }
          : o,
      ),
    )
  }
  function addPolyPoint(id: string, p: Pt) {
    setSeams((s) => s.map((o) => (o.id === id && o.kind === 'polyline' ? { ...o, points: [...o.points, p] } : o)))
  }
  function deletePolyPoint(id: string, idx: number) {
    setSeams((s) =>
      s.map((o) => (o.id === id && o.kind === 'polyline' ? { ...o, points: o.points.filter((_, i) => i !== idx) } : o)),
    )
  }

  // Live G-code + readouts.
  const safeParams = useMemo(() => ({ ...params, decimals: clampDecimals(params.decimals) }), [params])
  const gcode = useMemo(() => generateStitching(seams, safeParams), [seams, safeParams])
  const lineCount = useMemo(() => gcodeLineCount(gcode), [gcode])
  const effectiveLines = seams.length === 0 ? 0 : lineCount
  const seamLen = useMemo(() => totalSeamLength(seams), [seams])
  const stitchCount = useMemo(() => totalStitchCount(seams, safeParams), [seams, safeParams])
  const estSeconds = useMemo(() => estimateStitchingSeconds(seams, safeParams), [seams, safeParams])

  // Live generation → shared store (debounced), dropping the section when empty.
  useEffect(() => {
    if (streaming) return
    if (!seams.length) {
      removeSection('stitching')
      return
    }
    const id = window.setTimeout(() => setProgram('stitching', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, seams.length, setProgram, removeSection, streaming])

  // ---- Save / Load document -----------------------------------------------
  const doc: StitchingDoc = { kind: 'karmyogi.stitching', version: 1, seams, params }
  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('st.load.bad', 'Could not load — not a valid stitching file.'))
      return
    }
    const nextParams = parseParams(data.params, params)
    if (Array.isArray(data.seams)) {
      const next: Seam[] = []
      for (const raw of data.seams) {
        const parsed = parseSeam(raw, nextParams)
        if (parsed) next.push(parsed)
      }
      setSeams(next)
      setSelected(next.length > 0 ? next[0].id : '')
    }
    setParams(nextParams)
    setLoadError('')
  }

  // ---- color-coded setting PRESETS (global params only) -------------------
  const presets = usePresets<StitchParams>({
    storageKey: 'karmyogi.stitching.presets',
    capture: () => ({ ...params }),
    onApply: (pp) => setParams((prev) => parseParams(pp, prev)),
  })

  const defaultsEffectiveOpen = defaultsOpen ?? seams.length === 0
  const toggleDefaults = () => setDefaultsOpen(!defaultsEffectiveOpen)

  const wposXY: Pt = { x: wpos.x, y: wpos.y }

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('st.presets.aria', 'Stitching setting presets')}
      />
      <div className="st-panel">
        {/* Slim header: title + icon toolbar. */}
        <header className="st-head">
          <div className="st-head-title">
            <span className="st-head-name">{t('st.title', 'Clothes Stitching')}</span>
            <InfoTip
              topic="stMode"
              title={t('st.title', 'Clothes Stitching')}
              body={t(
                'st.intro',
                'Sews SEAMS that join fabric: straight segments, rectangular hems, polylines and imported SVG/DXF paths. Each seam has its own stitch length and type (lock / zig-zag / basting). karmyogi outputs XY motion only — the needle rides its own Z motor. Backstitch locks each seam end. The program auto-syncs to the Program tab.',
              )}
            />
          </div>
          <div className="st-tools">
            <ToolButton
              className="st-ico-primary"
              glyph="╱"
              onClick={() => addSeam('segment')}
              title={t('st.toolbar.addSegment', 'Add straight seam')}
              body={t('st.toolbar.addSegment.body', 'Append a straight seam (start → end) you can edit or record from the machine.')}
            />
            <ToolButton
              className="st-ico-primary"
              glyph="▭"
              onClick={() => addSeam('rect')}
              title={t('st.toolbar.addRect', 'Add rectangular hem')}
              body={t('st.toolbar.addRect.body', 'Append a rectangular hem — all four sides sewn as one closed loop.')}
            />
            <ToolButton
              className="st-ico-primary"
              glyph="∿"
              onClick={() => addSeam('polyline')}
              title={t('st.toolbar.addPoly', 'Add polyline seam')}
              body={t('st.toolbar.addPoly.body', 'Append a polyline seam — an ordered list of points forming a curved/segmented path.')}
            />
            <ToolButton
              glyph={<Icon name="upload" />}
              onClick={() => fileInputRef.current?.click()}
              title={t('st.toolbar.import', 'Load vector file')}
              body={t('st.toolbar.import.body', 'Import seam paths from an SVG or DXF file — each path becomes a polyline seam sewn at the default stitch length and type.')}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept={VECTOR_ACCEPT}
              className="st-file-input"
              onChange={onVectorFileChange}
              aria-hidden="true"
              tabIndex={-1}
            />
            <span className="st-tools-sep" aria-hidden="true" />
            <ToolButton
              className={defaultsEffectiveOpen ? 'is-active' : ''}
              glyph={<Icon name="settings" />}
              onClick={toggleDefaults}
              ariaExpanded={defaultsEffectiveOpen}
              title={t('st.toolbar.settings', 'Settings')}
              body={t('st.toolbar.settings.body', 'Global sewing feed, travel feed, backstitch, presser foot, return-to-origin and thread trim. Per-seam stitch length and type live on each card.')}
            />
            <span className="st-tools-sep" aria-hidden="true" />
            <SaveLoadButtons
              value={doc}
              onLoad={loadDoc}
              onError={setLoadError}
              fileBase="karmyogi-stitching"
              ext="kstitch"
              saveDisabled={seams.length === 0}
              saveTitle={t('st.toolbar.save', 'Save seams + settings')}
              loadTitle={t('st.toolbar.load', 'Load seams + settings')}
            />
            <span className="st-tools-sep" aria-hidden="true" />
            <ToolButton
              className="st-ico-danger"
              glyph={<Icon name="trash" />}
              onClick={clearAll}
              disabled={seams.length === 0}
              title={t('st.toolbar.clear', 'Clear all')}
              body={t('st.toolbar.clear.body', 'Remove every seam and start over.')}
            />
          </div>
        </header>

        {/* Live status strip. */}
        <div className="st-status">
          <CamStatus
            items={[
              { value: seams.length, unit: t('st.status.seams', 'seams') },
              { value: seamLen.toFixed(1), unit: t('st.status.mm', 'mm seam') },
              {
                value: stitchCount,
                unit: t('st.status.stitches', 'stitches'),
                title: t('st.status.stitches.title', 'Total nominal stitch penetrations (excludes backstitch repeats).'),
              },
              { value: effectiveLines, unit: t('st.status.gcode', 'G-code lines') },
              {
                value: fmtDuration(estSeconds, t),
                unit: t('st.status.est', 'est.'),
                title: t('st.status.est.title', 'Estimated sewing time (seam feed travel + rapid jumps between seams + trim dwell).'),
              },
            ]}
          />
        </div>

        {loadError && <p className="st-warn">{loadError}</p>}
        {importInfo && <p className="st-info">{importInfo}</p>}

        {!connected && seams.length > 0 && (
          <p className="st-warn">
            {t('st.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
          </p>
        )}

        {/* Defaults disclosure. */}
        <button
          type="button"
          className="st-defaults-toggle"
          data-open={defaultsEffectiveOpen}
          aria-expanded={defaultsEffectiveOpen}
          onClick={toggleDefaults}
        >
          <Icon name="settings" size={14} className="st-defaults-ico" />
          <span className="st-defaults-word">{t('st.defaults.disclosure', 'Defaults')}</span>
          <span className="ui-caret" aria-hidden="true">
            <Icon name="chevron-right" size={14} />
          </span>
        </button>

        {defaultsEffectiveOpen && (
          <section className="st-settings">
            {/* Stitch & feed */}
            <div className="st-card">
              <div className="st-card-head">
                <h4>
                  <Icon name="jog" size={14} className="cam-card-ico" /> {t('st.stitch.title', 'Stitch & feed')}
                </h4>
                <InfoTip
                  topic="stStitch"
                  title={t('st.stitch.title', 'Stitch & feed')}
                  body={t('st.stitch.body', 'Default stitch length for new seams, the sewing feed along the seam, backstitch lock count and the basting multiplier (basting = long stitches).')}
                />
              </div>
              <div className="st-fields st-sfields">
                <SliderField
                  label={t('st.field.defLen', 'Stitch len')}
                  unit={t('unit.mm', 'mm')}
                  min={0.5}
                  max={10}
                  step={0.1}
                  value={params.defaultStitchLen}
                  onChange={(n) => setParams((p) => ({ ...p, defaultStitchLen: n }))}
                  info={{
                    title: t('st.field.defLen', 'Default stitch length'),
                    body: t('st.field.defLen.body', 'Stitch length (mm) applied to newly-added seams. Each seam can be tuned on its own card.'),
                  }}
                />
                <SliderField
                  label={t('st.field.feed', 'Feed')}
                  unit={t('unit.mmPerMin', 'mm/min')}
                  min={10}
                  max={5000}
                  step={10}
                  value={params.feed}
                  onChange={(n) => setParams((p) => ({ ...p, feed: n }))}
                  info={{
                    title: t('st.field.feed', 'Sewing feed'),
                    body: t('st.field.feed.body', 'Feed rate the fabric advances along the seam (mm/min) — emitted on each G1 stitch move.'),
                  }}
                />
                <SliderField
                  label={t('st.field.travelFeed', 'Travel')}
                  unit={t('unit.mmPerMin', 'mm/min')}
                  min={100}
                  max={8000}
                  step={100}
                  value={params.travelFeed}
                  onChange={(n) => setParams((p) => ({ ...p, travelFeed: Math.max(1, n) }))}
                  info={{
                    title: t('st.field.travelFeed', 'Travel feed'),
                    body: t('st.field.travelFeed.body', 'Rapid (needle-up) travel speed between separate seams. Used for the time estimate; travel moves are emitted as G0.'),
                  }}
                />
                <SliderField
                  label={t('st.field.backstitch', 'Backstitch')}
                  min={0}
                  max={8}
                  step={1}
                  value={params.backstitch}
                  parse={intNum}
                  onChange={(n) => setParams((p) => ({ ...p, backstitch: Math.max(0, Math.floor(n)) }))}
                  info={{
                    title: t('st.field.backstitch', 'Backstitch'),
                    body: t('st.field.backstitch.body', 'Reverse lock stitches sewn at the start AND end of every seam to keep the thread from unravelling. 0 = none.'),
                  }}
                />
                <SliderField
                  label={t('st.field.basting', 'Basting ×')}
                  min={1}
                  max={8}
                  step={0.5}
                  value={params.bastingMult}
                  onChange={(n) => setParams((p) => ({ ...p, bastingMult: Math.max(1, n) }))}
                  info={{
                    title: t('st.field.basting', 'Basting multiplier'),
                    body: t('st.field.basting.body', 'A basting seam uses this multiple of its stitch length, giving long, easily-removed temporary stitches.'),
                  }}
                />
                <SliderField
                  label={t('st.field.decimals', 'Decimals')}
                  min={0}
                  max={6}
                  step={1}
                  value={params.decimals}
                  parse={(v, fb) => clampDecimals(intNum(v, fb))}
                  onChange={(n) => setParams((p) => ({ ...p, decimals: clampDecimals(n) }))}
                  info={{
                    title: t('st.field.decimals', 'Decimals'),
                    body: t('st.field.decimals.body', 'Number of decimal places in the emitted coordinates (0–6).'),
                  }}
                />
              </div>
            </div>

            {/* Foot & finish (XY-only — the needle rides its own Z motor) */}
            <div className="st-card">
              <div className="st-card-head">
                <h4>
                  <Icon name="home" size={14} className="cam-card-ico" /> {t('st.foot.title', 'Foot & finish')}
                </h4>
                <InfoTip
                  topic="stFoot"
                  title={t('st.foot.title', 'Foot & finish')}
                  body={t('st.foot.body', 'karmyogi outputs XY motion only — the needle has its own Z motor. Optionally pulse a presser-foot solenoid (M8/M9) around each seam via the aux/mist output, and optionally return to origin (G0 X0 Y0) when the program ends. Both default OFF.')}
                />
              </div>
              <div className="st-fields st-sfields">
                <div className="st-sfield st-sfield-toggle">
                  <span className="st-sfield-lbl">
                    <span className="st-sfield-txt">{t('st.field.presser', 'Presser foot')}</span>
                    <InfoTip
                      topic="stPresser"
                      title={t('st.field.presser', 'Presser foot')}
                      body={t('st.field.presser.body', 'Actuate a presser-foot solenoid (M8 down / M9 up) around each seam via the aux/mist output. Optional — defaults OFF (XY only).')}
                    />
                  </span>
                  <SegControl<'on' | 'off'>
                    options={[
                      { value: 'on', label: t('st.on', 'On') },
                      { value: 'off', label: t('st.off', 'Off') },
                    ]}
                    value={params.presserFoot ? 'on' : 'off'}
                    onChange={(v) => setParams((p) => ({ ...p, presserFoot: v === 'on' }))}
                    ariaLabel={t('st.field.presser', 'Presser foot')}
                    variant="tonal"
                    size="sm"
                  />
                </div>
                <div className="st-sfield st-sfield-toggle">
                  <span className="st-sfield-lbl">
                    <span className="st-sfield-txt">{t('st.field.returnOrigin', 'Return to 0')}</span>
                    <InfoTip
                      topic="stReturn"
                      title={t('st.field.returnOrigin', 'Return to origin')}
                      body={t('st.field.returnOrigin.body', 'Emit a final G0 X0 Y0 so the head parks at the work origin when the program ends.')}
                    />
                  </span>
                  <SegControl<'on' | 'off'>
                    options={[
                      { value: 'on', label: t('st.on', 'On') },
                      { value: 'off', label: t('st.off', 'Off') },
                    ]}
                    value={params.returnToOrigin ? 'on' : 'off'}
                    onChange={(v) => setParams((p) => ({ ...p, returnToOrigin: v === 'on' }))}
                    ariaLabel={t('st.field.returnOrigin', 'Return to origin')}
                    variant="tonal"
                    size="sm"
                  />
                </div>
              </div>
            </div>

            {/* Thread trim */}
            <div className="st-card">
              <div className="st-card-head">
                <h4>
                  <Icon name="frame" size={14} className="cam-card-ico" /> {t('st.trim.title', 'Thread trim')}
                </h4>
                <InfoTip
                  topic="stTrim"
                  title={t('st.trim.title', 'Thread trim')}
                  body={t('st.trim.body', 'Emit a thread-trim M-code (and optional dwell) at the end of each seam, after the presser foot lifts — for machines with an automatic trimmer.')}
                />
              </div>
              <div className="st-fields st-sfields">
                <div className="st-sfield st-sfield-toggle">
                  <span className="st-sfield-lbl">
                    <span className="st-sfield-txt">{t('st.field.trimEn', 'Trim')}</span>
                  </span>
                  <SegControl<'on' | 'off'>
                    options={[
                      { value: 'on', label: t('st.on', 'On') },
                      { value: 'off', label: t('st.off', 'Off') },
                    ]}
                    value={params.trimEnabled ? 'on' : 'off'}
                    onChange={(v) => setParams((p) => ({ ...p, trimEnabled: v === 'on' }))}
                    ariaLabel={t('st.field.trimEn', 'Thread trim')}
                    variant="tonal"
                    size="sm"
                  />
                </div>
                <SliderField
                  label={t('st.field.trimCode', 'M-code')}
                  min={0}
                  max={200}
                  step={1}
                  value={params.trimCode}
                  parse={intNum}
                  onChange={(n) => setParams((p) => ({ ...p, trimCode: Math.max(0, Math.floor(n)) }))}
                  info={{
                    title: t('st.field.trimCode', 'Trim M-code'),
                    body: t('st.field.trimCode.body', 'The custom M-code that fires the thread trimmer (emitted as M<code>). Match your controller.'),
                  }}
                />
                <SliderField
                  label={t('st.field.trimDwell', 'Trim dwell')}
                  unit={t('unit.s', 's')}
                  min={0}
                  max={5}
                  step={0.1}
                  value={params.trimDwell}
                  onChange={(n) => setParams((p) => ({ ...p, trimDwell: Math.max(0, n) }))}
                  info={{
                    title: t('st.field.trimDwell', 'Trim dwell'),
                    body: t('st.field.trimDwell.body', 'A pause (G4 P) after the trim command so the cutter completes before the next seam.'),
                  }}
                />
              </div>
            </div>
          </section>
        )}

        {/* Seam objects. */}
        <div className="st-card st-objects">
          <div className="st-card-head">
            <h4>
              <Icon name="frame" size={14} className="cam-card-ico" /> {t('st.objects.title', 'Seams')}
            </h4>
            <span className="st-card-count">{seams.length}</span>
          </div>
          <div className="st-obj-list">
            {seams.length === 0 && (
              <CamEmpty
                icon={<Icon name="frame" size={22} />}
                title={t('st.empty.title', 'No seams yet')}
                hint={t('st.empty.hint', 'Add a straight seam, a rectangular hem or a polyline, then set its stitch length and type.')}
                action={
                  <button type="button" className="cam-primary" onClick={() => addSeam('segment')}>
                    <Icon name="add" size={14} /> {t('st.empty.add', 'Add straight seam')}
                  </button>
                }
              />
            )}
            {seams.map((seam, i) => (
              <SeamCard
                key={seam.id}
                seam={seam}
                index={i}
                isFirst={i === 0}
                isLast={i === seams.length - 1}
                selected={seam.id === selected}
                connected={connected}
                wpos={wposXY}
                t={t}
                onSelect={() => setSelected(seam.id)}
                onSetKind={(k) => setKind(seam.id, k)}
                onUpdate={(patch) => updateSeam(seam.id, patch)}
                onUpdatePolyPoint={(idx, patch) => updatePolyPoint(seam.id, idx, patch)}
                onAddPolyPoint={(p) => addPolyPoint(seam.id, p)}
                onDeletePolyPoint={(idx) => deletePolyPoint(seam.id, idx)}
                onMove={(dir) => moveSeam(seam.id, dir)}
                onDuplicate={() => duplicateSeam(seam.id)}
                onDelete={() => deleteSeam(seam.id)}
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
            fileBase="stitching-settings"
            ext="kstitchset"
            saveTitle={t('st.presets.saveSettings', 'Save stitching settings to file')}
            loadTitle={t('st.presets.loadSettings', 'Load stitching settings from file')}
          />
        }
      />
    </div>
  )
}

/** One seam object as an editable card. */
function SeamCard(props: {
  seam: Seam
  index: number
  isFirst: boolean
  isLast: boolean
  selected: boolean
  connected: boolean
  wpos: Pt
  t: ReturnType<typeof useT>
  onSelect: () => void
  onSetKind: (k: SeamKind) => void
  onUpdate: (patch: Partial<SeamSegment> & Partial<SeamRect> & Partial<SeamPoly>) => void
  onUpdatePolyPoint: (idx: number, patch: Partial<Pt>) => void
  onAddPolyPoint: (p: Pt) => void
  onDeletePolyPoint: (idx: number) => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const {
    seam,
    index,
    isFirst,
    isLast,
    selected,
    connected,
    wpos,
    t,
    onSelect,
    onSetKind,
    onUpdate,
    onUpdatePolyPoint,
    onAddPolyPoint,
    onDeletePolyPoint,
    onMove,
    onDuplicate,
    onDelete,
  } = props
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const degenerate = isDegenerateSeam(seam)

  /** A compact "record from machine" button that fills a point from live wpos. */
  const recBtn = (apply: (p: Pt) => void) => (
    <button
      type="button"
      className="st-rec"
      disabled={!connected}
      onClick={(e) => {
        stop(e)
        if (connected) apply({ x: wpos.x, y: wpos.y })
      }}
      title={
        connected
          ? t('st.rec.body', 'Set this point from the live machine position.')
          : t('st.rec.connect', 'Connect to a machine to capture its live position.')
      }
      aria-label={t('st.rec', 'Record position')}
    >
      <Icon name="probe" size={13} />
    </button>
  )

  /** An X/Y pair editor with an optional record button. */
  const ptRow = (label: string, p: Pt, onX: (n: number) => void, onY: (n: number) => void, apply?: (p: Pt) => void) => (
    <div className="st-vec">
      <span className="st-vec-label">{label}</span>
      <label className="st-mini">
        <span>{t('st.axis.x', 'X')}</span>
        <input type="number" step="0.1" value={p.x} onClick={stop} onChange={(e) => onX(num(e.target.value, p.x))} />
      </label>
      <label className="st-mini">
        <span>{t('st.axis.y', 'Y')}</span>
        <input type="number" step="0.1" value={p.y} onClick={stop} onChange={(e) => onY(num(e.target.value, p.y))} />
      </label>
      {apply && recBtn(apply)}
    </div>
  )

  const kindLabel =
    seam.kind === 'segment'
      ? t('st.kind.segment', 'Segment')
      : seam.kind === 'rect'
        ? t('st.kind.rect', 'Rect')
        : t('st.kind.poly', 'Polyline')

  return (
    <div className={`st-ocard${selected ? ' is-selected' : ''}`} onClick={onSelect}>
      <div className="st-ocard-head">
        <span className="st-ocard-idx">
          {kindLabel} {index + 1}
        </span>
        <div className="st-kind-toggle" onClick={stop} role="group" aria-label={t('st.card.kind', 'Kind')}>
          {KIND_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`st-kind-btn${seam.kind === opt.value ? ' is-on' : ''}`}
              onClick={() => onSetKind(opt.value)}
              title={t(opt.key, opt.label)}
            >
              {t(opt.key, opt.label)}
            </button>
          ))}
        </div>
        <div className="st-ocard-actions">
          <button
            className="st-row-ico"
            title={t('st.row.moveUp', 'Move up')}
            aria-label={t('st.row.moveUp', 'Move up')}
            onClick={(e) => {
              stop(e)
              onMove(-1)
            }}
            disabled={isFirst}
          >
            ↑
          </button>
          <button
            className="st-row-ico"
            title={t('st.row.moveDown', 'Move down')}
            aria-label={t('st.row.moveDown', 'Move down')}
            onClick={(e) => {
              stop(e)
              onMove(1)
            }}
            disabled={isLast}
          >
            ↓
          </button>
          <button
            className="st-row-ico"
            title={t('st.row.duplicate', 'Duplicate')}
            aria-label={t('st.row.duplicate', 'Duplicate')}
            onClick={(e) => {
              stop(e)
              onDuplicate()
            }}
          >
            <Icon name="duplicate" size={14} />
          </button>
          <button
            className="st-row-ico st-del"
            title={t('st.row.delete', 'Delete')}
            aria-label={t('st.row.delete', 'Delete')}
            onClick={(e) => {
              stop(e)
              onDelete()
            }}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>

      {degenerate && (
        <div className="st-ocard-warns" role="alert">
          <span className="st-warn-badge">
            <Icon name="warning" size={13} />
            <span>{t('st.warn.degenerate', 'Zero-length seam — add distinct points; nothing is sewn.')}</span>
          </span>
        </div>
      )}

      <div className="st-ocard-geom">
        {seam.kind === 'segment' && (
          <>
            {ptRow(
              t('st.geom.start', 'Start'),
              seam.start,
              (n) => onUpdate({ start: { ...seam.start, x: n } }),
              (n) => onUpdate({ start: { ...seam.start, y: n } }),
              (p) => onUpdate({ start: p }),
            )}
            {ptRow(
              t('st.geom.end', 'End'),
              seam.end,
              (n) => onUpdate({ end: { ...seam.end, x: n } }),
              (n) => onUpdate({ end: { ...seam.end, y: n } }),
              (p) => onUpdate({ end: p }),
            )}
          </>
        )}
        {seam.kind === 'rect' && (
          <>
            {ptRow(
              t('st.geom.origin', 'Origin'),
              { x: seam.x, y: seam.y },
              (n) => onUpdate({ x: n }),
              (n) => onUpdate({ y: n }),
              (p) => onUpdate({ x: p.x, y: p.y }),
            )}
            <div className="st-vec">
              <span className="st-vec-label">{t('st.geom.size', 'Size')}</span>
              <label className="st-mini">
                <span>{t('st.geom.w', 'W')}</span>
                <input
                  type="number"
                  step="0.1"
                  value={seam.w}
                  onClick={stop}
                  onChange={(e) => onUpdate({ w: num(e.target.value, seam.w) })}
                />
              </label>
              <label className="st-mini">
                <span>{t('st.geom.h', 'H')}</span>
                <input
                  type="number"
                  step="0.1"
                  value={seam.h}
                  onClick={stop}
                  onChange={(e) => onUpdate({ h: num(e.target.value, seam.h) })}
                />
              </label>
            </div>
          </>
        )}
        {seam.kind === 'polyline' && (
          <div className="st-poly" onClick={stop}>
            {seam.points.map((p, i) => (
              <div className="st-poly-row" key={i}>
                <span className="st-poly-idx">{i + 1}</span>
                <label className="st-mini">
                  <span>{t('st.axis.x', 'X')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={p.x}
                    onChange={(e) => onUpdatePolyPoint(i, { x: num(e.target.value, p.x) })}
                  />
                </label>
                <label className="st-mini">
                  <span>{t('st.axis.y', 'Y')}</span>
                  <input
                    type="number"
                    step="0.1"
                    value={p.y}
                    onChange={(e) => onUpdatePolyPoint(i, { y: num(e.target.value, p.y) })}
                  />
                </label>
                {recBtn((np) => onUpdatePolyPoint(i, np))}
                <button
                  type="button"
                  className="st-row-ico st-del"
                  title={t('st.poly.delPoint', 'Delete point')}
                  aria-label={t('st.poly.delPoint', 'Delete point')}
                  disabled={seam.points.length <= 2}
                  onClick={() => onDeletePolyPoint(i)}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
            <div className="st-poly-add">
              <button
                type="button"
                className="st-poly-addbtn"
                onClick={() => {
                  const last = seam.points[seam.points.length - 1] ?? { x: 0, y: 0 }
                  onAddPolyPoint({ x: last.x + 20, y: last.y })
                }}
              >
                <Icon name="add" size={13} /> {t('st.poly.addPoint', 'Add point')}
              </button>
              <button
                type="button"
                className="st-poly-addbtn"
                disabled={!connected}
                title={
                  connected
                    ? t('st.poly.addMachine.body', 'Append the live machine position as a new point.')
                    : t('st.rec.connect', 'Connect to a machine to capture its live position.')
                }
                onClick={() => connected && onAddPolyPoint({ x: wpos.x, y: wpos.y })}
              >
                <Icon name="probe" size={13} /> {t('st.poly.addMachine', 'From machine')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="st-ocard-stitch" onClick={stop}>
        <div className="st-type-row">
          <span className="st-sfield-lbl">
            <span className="st-sfield-txt">{t('st.stitch.type', 'Stitch type')}</span>
          </span>
          <SegControl<StitchType>
            options={TYPE_OPTIONS.map((opt) => ({
              value: opt.value,
              label: t(opt.key, opt.label),
              title: t(opt.key, opt.label),
            }))}
            value={seam.type}
            onChange={(v) => onUpdate({ type: v })}
            ariaLabel={t('st.stitch.type', 'Stitch type')}
            variant="tonal"
            size="sm"
            className="st-seg-type"
          />
        </div>
        <SliderField
          label={t('st.stitch.len', 'Stitch len')}
          unit={t('unit.mm', 'mm')}
          min={0.5}
          max={10}
          step={0.1}
          value={seam.stitchLen}
          onChange={(n) => onUpdate({ stitchLen: Math.max(0.1, n) })}
          info={{
            title: t('st.stitch.len', 'Stitch length'),
            body: t('st.stitch.len.body', 'Distance between successive stitches along this seam. Basting multiplies this; zig-zag uses its own pitch.'),
          }}
        />
        {seam.type === 'zigzag' && (
          <>
            <SliderField
              label={t('st.stitch.zigW', 'Zig width')}
              unit={t('unit.mm', 'mm')}
              min={0.5}
              max={20}
              step={0.1}
              value={seam.zigWidth}
              onChange={(n) => onUpdate({ zigWidth: Math.max(0, n) })}
              info={{
                title: t('st.stitch.zigW', 'Zig-zag width'),
                body: t('st.stitch.zigW.body', 'Full side-to-side width of the zig-zag: stitch points swing ±half this perpendicular to the seam.'),
              }}
            />
            <SliderField
              label={t('st.stitch.zigP', 'Zig pitch')}
              unit={t('unit.mm', 'mm')}
              min={0.3}
              max={10}
              step={0.1}
              value={seam.zigPitch}
              onChange={(n) => onUpdate({ zigPitch: Math.max(0.1, n) })}
              info={{
                title: t('st.stitch.zigP', 'Zig-zag pitch'),
                body: t('st.stitch.zigP.body', 'Along-seam distance between successive side swings. Smaller = tighter, denser zig-zag.'),
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
