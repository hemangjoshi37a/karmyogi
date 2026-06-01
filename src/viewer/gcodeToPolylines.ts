/**
 * Pure G-code → polyline parser for the 3D viewer.
 *
 * NO three.js / DOM imports — this is unit-testable in isolation.
 *
 * Parses a robust subset of GRBL-flavoured G-code into line segments, each
 * tagged as a `rapid` (G0) or `cut` (G1/G2/G3) move so the renderer can colour
 * them differently. Arcs (G2 CW / G3 CCW) are flattened into many short
 * segments. The parser is modal: the active motion mode (G0..G3), the
 * distance mode (G90 absolute / G91 relative) and the arc-distance mode
 * (G91.1 incremental IJK — the GRBL default) all persist across lines, and
 * unspecified axis words keep their previous value.
 *
 * Coordinates are emitted in machine space: X, Y, Z with Z-up (GRBL/this app's
 * convention). Units are taken as-is (we do not convert G20/G21 — the emitter
 * always outputs G21/mm and the viewer scene is in mm).
 */

export type MoveKind = 'rapid' | 'cut'

/** A single straight segment between two 3D points. */
export interface Segment {
  /** Start point [x, y, z]. */
  from: [number, number, number]
  /** End point [x, y, z]. */
  to: [number, number, number]
  /** rapid = G0 (travel), cut = G1/G2/G3 (working move). */
  kind: MoveKind
}

export interface ParseOptions {
  /**
   * Maximum chord length (mm) used when flattening arcs. Smaller = smoother.
   * Default 0.5mm.
   */
  arcTolerance?: number
  /** Minimum number of segments an arc is split into. Default 4. */
  minArcSegments?: number
}

export interface ParseResult {
  segments: Segment[]
  /** Axis-aligned bounds of all visited points, or null if no moves. */
  bounds: Bounds | null
}

export interface Bounds {
  min: [number, number, number]
  max: [number, number, number]
}

interface Pos {
  x: number
  y: number
  z: number
}

const TWO_PI = Math.PI * 2

/**
 * Parse a block of G-code text into tagged line segments.
 *
 * Recognises: G0/G1/G2/G3 motion (modal), G90/G91 distance mode (modal),
 * G90.1/G91.1 arc-IJK distance mode (modal, default incremental), comments
 * (`;...`, `(...)`), and line numbers. Words may be on the same line in any
 * order. R-form arcs (radius word) and IJK-form arcs are both supported.
 */
export function gcodeToPolylines(text: string, opts: ParseOptions = {}): ParseResult {
  const arcTolerance = opts.arcTolerance ?? 0.5
  const minArcSegments = opts.minArcSegments ?? 4

  const segments: Segment[] = []
  const pos: Pos = { x: 0, y: 0, z: 0 }
  let motion = 0 // 0,1,2,3
  let absolute = true // G90
  let absoluteArc = false // G90.1 ; default incremental IJK (G91.1)

  let min: [number, number, number] = [Infinity, Infinity, Infinity]
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let any = false

  const expand = (p: Pos) => {
    if (p.x < min[0]) min[0] = p.x
    if (p.y < min[1]) min[1] = p.y
    if (p.z < min[2]) min[2] = p.z
    if (p.x > max[0]) max[0] = p.x
    if (p.y > max[1]) max[1] = p.y
    if (p.z > max[2]) max[2] = p.z
    any = true
  }
  expand(pos) // include the start point in bounds

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComments(rawLine).trim()
    if (line === '') continue

    const words = tokenize(line)
    if (words.length === 0) continue

    // Apply modal commands (G-words) first; capture motion/coords.
    let lineMotion = motion
    let motionSeenThisLine = false
    const axis: Partial<Record<'x' | 'y' | 'z' | 'i' | 'j' | 'k' | 'r', number>> = {}

    for (const w of words) {
      const letter = w.letter
      const value = w.value
      switch (letter) {
        case 'G': {
          if (value === 0 || value === 1 || value === 2 || value === 3) {
            lineMotion = value
            motionSeenThisLine = true
          } else if (value === 90) {
            absolute = true
          } else if (value === 91) {
            absolute = false
          } else if (value === 90.1) {
            absoluteArc = true
          } else if (value === 91.1) {
            absoluteArc = false
          }
          break
        }
        case 'X':
          axis.x = value
          break
        case 'Y':
          axis.y = value
          break
        case 'Z':
          axis.z = value
          break
        case 'I':
          axis.i = value
          break
        case 'J':
          axis.j = value
          break
        case 'K':
          axis.k = value
          break
        case 'R':
          axis.r = value
          break
        default:
          break // M-words, F, S, T, line numbers, etc. ignored for geometry
      }
    }

    motion = lineMotion

    const hasAxisWord =
      axis.x !== undefined || axis.y !== undefined || axis.z !== undefined
    const hasArcWord =
      axis.i !== undefined ||
      axis.j !== undefined ||
      axis.k !== undefined ||
      axis.r !== undefined

    // A line with no motion target produces no segment (e.g. a bare G90, or
    // an M-code line). But a modal motion mode with axis words does move.
    if (!hasAxisWord && !hasArcWord && !motionSeenThisLine) continue
    if (!hasAxisWord && !hasArcWord) continue

    // Resolve target position.
    const target: Pos = { ...pos }
    const resolve = (cur: number, v: number | undefined): number => {
      if (v === undefined) return cur
      return absolute ? v : cur + v
    }
    target.x = resolve(pos.x, axis.x)
    target.y = resolve(pos.y, axis.y)
    target.z = resolve(pos.z, axis.z)

    if (motion === 2 || motion === 3) {
      // Arc move. Flatten to segments.
      const arcSegs = flattenArc(
        pos,
        target,
        axis,
        motion === 2, // clockwise
        absoluteArc,
        arcTolerance,
        minArcSegments,
      )
      for (const s of arcSegs) {
        segments.push({ from: [s.from.x, s.from.y, s.from.z], to: [s.to.x, s.to.y, s.to.z], kind: 'cut' })
        expand(s.to)
      }
      pos.x = target.x
      pos.y = target.y
      pos.z = target.z
    } else {
      const kind: MoveKind = motion === 0 ? 'rapid' : 'cut'
      // Skip zero-length moves (no visible segment, but still update pos).
      if (target.x !== pos.x || target.y !== pos.y || target.z !== pos.z) {
        segments.push({
          from: [pos.x, pos.y, pos.z],
          to: [target.x, target.y, target.z],
          kind,
        })
        expand(target)
      }
      pos.x = target.x
      pos.y = target.y
      pos.z = target.z
    }
  }

  const bounds: Bounds | null = any ? { min, max } : null
  return { segments, bounds }
}

/** Strip `;` line comments and `( ... )` inline comments. */
function stripComments(line: string): string {
  let out = ''
  let depth = 0
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === ';' && depth === 0) break
    if (c === '(') {
      depth++
      continue
    }
    if (c === ')') {
      if (depth > 0) depth--
      continue
    }
    if (depth === 0) out += c
  }
  return out
}

interface Word {
  letter: string
  value: number
}

/** Split a comment-free line into letter/number words. */
function tokenize(line: string): Word[] {
  const words: Word[] = []
  const re = /([A-Za-z])\s*([-+]?\d*\.?\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    words.push({ letter: m[1].toUpperCase(), value: parseFloat(m[2]) })
  }
  return words
}

interface FlatSeg {
  from: Pos
  to: Pos
}

/**
 * Flatten a G2/G3 arc from `start` to `end` into short chord segments.
 * Supports IJK centre offsets (default incremental) and R radius form.
 * Linear interpolation of Z (helix) is applied across the arc.
 */
function flattenArc(
  start: Pos,
  end: Pos,
  axis: { i?: number; j?: number; k?: number; r?: number },
  clockwise: boolean,
  absoluteArc: boolean,
  tolerance: number,
  minSegments: number,
): FlatSeg[] {
  // Determine arc centre in the XY plane (G17, the only plane we support).
  let cx: number
  let cy: number

  if (axis.r !== undefined) {
    const center = centerFromRadius(start, end, axis.r, clockwise)
    if (!center) {
      // Degenerate radius — fall back to a straight line.
      return [{ from: { ...start }, to: { ...end } }]
    }
    cx = center.cx
    cy = center.cy
  } else {
    const i = axis.i ?? 0
    const j = axis.j ?? 0
    if (absoluteArc) {
      cx = i
      cy = j
    } else {
      cx = start.x + i
      cy = start.y + j
    }
  }

  const r = Math.hypot(start.x - cx, start.y - cy)
  if (r === 0 || !isFinite(r)) {
    return [{ from: { ...start }, to: { ...end } }]
  }

  let startAngle = Math.atan2(start.y - cy, start.x - cx)
  let endAngle = Math.atan2(end.y - cy, end.x - cx)

  // Sweep angle, signed by direction. In a Z-up right-handed frame G2 is CW
  // (negative sweep) and G3 is CCW (positive sweep).
  let sweep = endAngle - startAngle
  if (clockwise) {
    // CW: sweep must be negative.
    while (sweep > 0) sweep -= TWO_PI
    if (sweep === 0) sweep = -TWO_PI // full circle
  } else {
    // CCW: sweep must be positive.
    while (sweep < 0) sweep += TWO_PI
    if (sweep === 0) sweep = TWO_PI // full circle
  }

  const arcLen = Math.abs(sweep) * r
  // Number of segments from chord tolerance: chord error ≈ r(1 - cos(Δ/2)).
  let nFromTol: number
  if (tolerance > 0 && tolerance < r) {
    const maxAngle = 2 * Math.acos(1 - tolerance / r)
    nFromTol = Math.ceil(Math.abs(sweep) / maxAngle)
  } else {
    nFromTol = Math.ceil(arcLen / Math.max(tolerance, 0.1))
  }
  const n = Math.max(minSegments, nFromTol, 1)

  const segs: FlatSeg[] = []
  let prev: Pos = { ...start }
  for (let s = 1; s <= n; s++) {
    const t = s / n
    const a = startAngle + sweep * t
    const p: Pos = {
      x: cx + r * Math.cos(a),
      y: cy + r * Math.sin(a),
      z: start.z + (end.z - start.z) * t,
    }
    // Pin the final point exactly to the commanded end (avoid float drift).
    if (s === n) {
      p.x = end.x
      p.y = end.y
      p.z = end.z
    }
    segs.push({ from: prev, to: p })
    prev = p
  }
  return segs
}

/** Compute arc centre from R form. Positive R = minor arc, negative R = major arc. */
function centerFromRadius(
  start: Pos,
  end: Pos,
  r: number,
  clockwise: boolean,
): { cx: number; cy: number } | null {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const d = Math.hypot(dx, dy)
  if (d === 0 || d > Math.abs(r) * 2) return null

  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)))
  // Unit perpendicular to the chord.
  const ux = -dy / d
  const uy = dx / d

  // Choose the side. The sign convention picks the correct centre for the
  // given direction and minor/major selection (encoded in sign of r).
  const sign = clockwise === r > 0 ? -1 : 1
  return { cx: mx + sign * h * ux, cy: my + sign * h * uy }
}
