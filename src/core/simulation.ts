/**
 * Pure G-code → time-parameterised motion timeline for the playback transport.
 *
 * NO React / DOM / three / zustand imports — this is portable, testable core.
 *
 * `buildTimeline` parses a robust subset of GRBL-flavoured G-code (the same
 * modal model as the viewer's `gcodeToPolylines`, kept self-contained here on
 * purpose) and turns each motion into one or more straight segments with a
 * cumulative start/end *time* in seconds. Time is derived from move distance
 * and the active feed: rapids (G0) use `rapidFeed`, cutting moves (G1/G2/G3)
 * use the modal F word (falling back to `defaultFeed`), all clamped to at
 * least `minFeed`. Feeds are in mm/min and converted to mm/sec via `/60`.
 *
 * The resulting `Timeline` lets a renderer ask "where is the tool at time t?"
 * (`positionAt`) and "which segment is currently being executed?"
 * (`activeIndexAt`) so it can animate a moving cutter tip and progressively
 * reveal the toolpath.
 *
 * Coordinates are machine space X/Y/Z (Z-up, mm), matching the viewer scene.
 */

export type SimKind = 'rapid' | 'cut'

/** A single straight segment with a cumulative time range. */
export interface SimSegment {
  /** Start point [x, y, z]. */
  from: [number, number, number]
  /** End point [x, y, z]. */
  to: [number, number, number]
  /** rapid = G0 (travel), cut = G1/G2/G3 (working move). */
  kind: SimKind
  /** Cumulative start time of this segment, in seconds. */
  tStart: number
  /** Cumulative end time of this segment, in seconds. */
  tEnd: number
}

export interface Timeline {
  segments: SimSegment[]
  /** Total program time in seconds (0 if empty). */
  duration: number
  /** Total path distance in mm. */
  totalDistance: number
  /** Tool position at time `t` (clamped to [0,duration]); [0,0,0] if empty. */
  positionAt(t: number): [number, number, number]
  /** Index of the segment in progress at time `t`; -1 if empty. */
  activeIndexAt(t: number): number
}

export interface BuildTimelineOptions {
  /** Feed for rapid (G0) moves, mm/min. Default 3000. */
  rapidFeed?: number
  /** Fallback feed for cutting moves when no F has been seen, mm/min. Default 600. */
  defaultFeed?: number
  /** Lower clamp for any feed, mm/min. Default 30. */
  minFeed?: number
}

const TWO_PI = Math.PI * 2
/** Arc flattening: max chord length / smoothing (mirrors the viewer defaults). */
const ARC_TOLERANCE = 0.5
const MIN_ARC_SEGMENTS = 4

interface Pos {
  x: number
  y: number
  z: number
}

function dist(a: Pos, b: Pos): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/**
 * Parse G-code into a time-parameterised {@link Timeline}.
 *
 * Robust against empty/garbage input: anything it can't interpret as motion is
 * ignored, and a program with no moves yields an empty timeline whose methods
 * are safe to call (duration 0, position [0,0,0], active index -1).
 */
export function buildTimeline(gcode: string, opts: BuildTimelineOptions = {}): Timeline {
  const rapidFeed = opts.rapidFeed ?? 3000
  const defaultFeed = opts.defaultFeed ?? 600
  const minFeed = opts.minFeed ?? 30

  const segments: SimSegment[] = []
  let cumTime = 0
  let totalDistance = 0

  const pos: Pos = { x: 0, y: 0, z: 0 }
  let motion = 0 // 0,1,2,3
  let absolute = true // G90
  let absoluteArc = false // default incremental IJK (G91.1)
  let feed = 0 // modal F (mm/min); 0 = not yet set

  /** Push one straight segment, advancing cumulative time + distance. */
  const pushSeg = (from: Pos, to: Pos, kind: SimKind, feedMmMin: number) => {
    const d = dist(from, to)
    if (d <= 0) return
    const clampedFeed = Math.max(minFeed, feedMmMin)
    const mmPerSec = clampedFeed / 60
    const dt = mmPerSec > 0 ? d / mmPerSec : 0
    const tStart = cumTime
    const tEnd = cumTime + dt
    segments.push({
      from: [from.x, from.y, from.z],
      to: [to.x, to.y, to.z],
      kind,
      tStart,
      tEnd,
    })
    cumTime = tEnd
    totalDistance += d
  }

  for (const rawLine of gcode.split(/\r?\n/)) {
    const line = stripComments(rawLine).trim()
    if (line === '') continue

    const words = tokenize(line)
    if (words.length === 0) continue

    let lineMotion = motion
    const axis: Partial<Record<'x' | 'y' | 'z' | 'i' | 'j' | 'k' | 'r' | 'f', number>> = {}

    for (const w of words) {
      switch (w.letter) {
        case 'G': {
          const v = w.value
          if (v === 0 || v === 1 || v === 2 || v === 3) {
            lineMotion = v
          } else if (v === 90) {
            absolute = true
          } else if (v === 91) {
            absolute = false
          } else if (v === 90.1) {
            absoluteArc = true
          } else if (v === 91.1) {
            absoluteArc = false
          }
          break
        }
        case 'X':
          axis.x = w.value
          break
        case 'Y':
          axis.y = w.value
          break
        case 'Z':
          axis.z = w.value
          break
        case 'I':
          axis.i = w.value
          break
        case 'J':
          axis.j = w.value
          break
        case 'K':
          axis.k = w.value
          break
        case 'R':
          axis.r = w.value
          break
        case 'F':
          axis.f = w.value
          break
        default:
          break // M-words, S, T, line numbers, etc. ignored for geometry
      }
    }

    motion = lineMotion

    // Modal feed update: an F word sets the cutting feed for this and later moves.
    if (axis.f !== undefined && axis.f > 0) feed = axis.f

    const hasAxisWord =
      axis.x !== undefined || axis.y !== undefined || axis.z !== undefined
    const hasArcWord =
      axis.i !== undefined ||
      axis.j !== undefined ||
      axis.k !== undefined ||
      axis.r !== undefined

    if (!hasAxisWord && !hasArcWord) continue

    const target: Pos = { ...pos }
    const resolve = (cur: number, v: number | undefined): number =>
      v === undefined ? cur : absolute ? v : cur + v
    target.x = resolve(pos.x, axis.x)
    target.y = resolve(pos.y, axis.y)
    target.z = resolve(pos.z, axis.z)

    if (motion === 2 || motion === 3) {
      const cutFeed = feed > 0 ? feed : defaultFeed
      const arcSegs = flattenArc(pos, target, axis, motion === 2, absoluteArc)
      for (const s of arcSegs) {
        pushSeg(s.from, s.to, 'cut', cutFeed)
      }
      pos.x = target.x
      pos.y = target.y
      pos.z = target.z
    } else {
      const kind: SimKind = motion === 0 ? 'rapid' : 'cut'
      const feedMmMin = motion === 0 ? rapidFeed : feed > 0 ? feed : defaultFeed
      pushSeg(pos, target, kind, feedMmMin)
      pos.x = target.x
      pos.y = target.y
      pos.z = target.z
    }
  }

  const duration = segments.length > 0 ? segments[segments.length - 1].tEnd : 0

  const empty = segments.length === 0

  const activeIndexAt = (t: number): number => {
    if (empty) return -1
    if (t <= 0) return 0
    if (t >= duration) return segments.length - 1
    // Binary search for the segment whose [tStart, tEnd) contains t.
    let lo = 0
    let hi = segments.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const seg = segments[mid]
      if (t < seg.tStart) hi = mid - 1
      else if (t >= seg.tEnd) lo = mid + 1
      else return mid
    }
    // Fall back to the nearest valid index (handles zero-length time gaps).
    return Math.min(segments.length - 1, Math.max(0, lo))
  }

  const positionAt = (t: number): [number, number, number] => {
    if (empty) return [0, 0, 0]
    const clamped = t < 0 ? 0 : t > duration ? duration : t
    const i = activeIndexAt(clamped)
    const seg = segments[i]
    const span = seg.tEnd - seg.tStart
    const f = span > 0 ? (clamped - seg.tStart) / span : 1
    const fc = f < 0 ? 0 : f > 1 ? 1 : f
    return [
      seg.from[0] + (seg.to[0] - seg.from[0]) * fc,
      seg.from[1] + (seg.to[1] - seg.from[1]) * fc,
      seg.from[2] + (seg.to[2] - seg.from[2]) * fc,
    ]
  }

  return { segments, duration, totalDistance, positionAt, activeIndexAt }
}

// ----------------------------------------------------------------------------
// Material-removal heightmap simulation
// ----------------------------------------------------------------------------
//
// A simple, robust "milling simulation": a Z-heightmap over the stock footprint
// starts flat at the stock top, and every CUT move (up to a reveal point) lowers
// the cells the tool sweeps to the move's Z. This lets the viewer show the stock
// progressively turning into the finished surface as the toolpath runs — the
// already-cut region reveals its cut surface, the rest stays raw stock.
//
// Pure: no React/DOM/three. The renderer turns the returned grid into a mesh.

/** Hard cap on heightmap grid cells so a huge stock can never hang the UI. */
export const MAX_SIM_GRID_CELLS = 90_000 // ≈ 300×300

/** A material-removal heightmap result the renderer turns into a surface mesh. */
export interface RemovalHeightmap {
  nx: number
  ny: number
  /** World min corner of the footprint (mm). */
  x0: number
  y0: number
  /** Cell pitch (mm). */
  dx: number
  dy: number
  /** Per-cell surface Z (mm). Length nx*ny. Starts at `topZ`, lowered by cuts. */
  z: Float32Array
  /** Stock top / floor Z (mm). */
  topZ: number
  floorZ: number
}

export interface SimSegmentLike {
  from: [number, number, number]
  to: [number, number, number]
  kind: SimKind
}

export interface BuildRemovalOptions {
  /** Footprint min/max corner XY (mm) — usually the stock bounds. */
  min: [number, number]
  max: [number, number]
  /** Stock top surface Z (mm). Cells start here. */
  topZ: number
  /** Floor Z (mm); cuts never lower a cell below this. */
  floorZ: number
  /** Cutter radius (mm) used to thicken each swept move. */
  toolRadius: number
}

/**
 * Allocate a flat (uncut) material-removal heightmap over a footprint. The grid
 * resolution targets ~ the tool radius and is capped by {@link MAX_SIM_GRID_CELLS}
 * so a huge stock can never hang the UI. All cells start at the stock top; sweep
 * cut moves into it with {@link sweepRemoval} to carve material away.
 */
export function createRemovalHeightmap(opts: BuildRemovalOptions): RemovalHeightmap {
  const minX = opts.min[0]
  const minY = opts.min[1]
  const spanX = Math.max(opts.max[0] - minX, 1e-6)
  const spanY = Math.max(opts.max[1] - minY, 1e-6)
  const topZ = opts.topZ
  const floorZ = Math.min(opts.floorZ, topZ)
  const r = Math.max(opts.toolRadius, 1e-3)

  // Resolution: aim for ~ tool-radius pitch, capped by the cell budget. A finer
  // grid than the tool gains nothing, a coarser one loses detail.
  const targetPitch = Math.max(r * 0.6, Math.max(spanX, spanY) / 280, 0.2)
  let nx = Math.max(2, Math.ceil(spanX / targetPitch) + 1)
  let ny = Math.max(2, Math.ceil(spanY / targetPitch) + 1)
  if (nx * ny > MAX_SIM_GRID_CELLS) {
    const scale = Math.sqrt(MAX_SIM_GRID_CELLS / (nx * ny))
    nx = Math.max(2, Math.floor(nx * scale))
    ny = Math.max(2, Math.floor(ny * scale))
  }
  const dx = spanX / (nx - 1)
  const dy = spanY / (ny - 1)

  const z = new Float32Array(nx * ny)
  z.fill(topZ)

  return { nx, ny, x0: minX, y0: minY, dx, dy, z, topZ, floorZ }
}

/**
 * Carve the CUT segments in `segments[from..count)` into `hm`, plus an optional
 * partial active segment ending at `partialTo`. Each swept move lowers every grid
 * cell within `toolRadius` of the move to the interpolated cut Z (clamped to the
 * floor). Rapids never remove material.
 *
 * This MUTATES `hm.z` in place and is INCREMENTAL — pass `from = lastAppliedCount`
 * to apply only newly-completed segments, so forward playback stays O(total
 * segments) rather than O(segments²). Returns true if any cell changed.
 */
export function sweepRemoval(
  hm: RemovalHeightmap,
  segments: SimSegmentLike[],
  from: number,
  count: number,
  toolRadius: number,
  partialTo: [number, number, number] | null,
): boolean {
  const { nx, ny, x0, y0, dx, dy, z, topZ, floorZ } = hm
  const r = Math.max(toolRadius, 1e-3)
  const rxCells = Math.max(0, Math.ceil(r / dx))
  const ryCells = Math.max(0, Math.ceil(r / dy))
  const r2 = r * r
  let changed = false

  const stamp = (px: number, py: number, cutZ: number) => {
    if (cutZ >= topZ) return // not cutting into the stock
    const cz = cutZ < floorZ ? floorZ : cutZ
    const cix = Math.round((px - x0) / dx)
    const ciy = Math.round((py - y0) / dy)
    for (let oy = -ryCells; oy <= ryCells; oy++) {
      const jy = ciy + oy
      if (jy < 0 || jy >= ny) continue
      const wy = oy * dy
      for (let ox = -rxCells; ox <= rxCells; ox++) {
        const jx = cix + ox
        if (jx < 0 || jx >= nx) continue
        const wx = ox * dx
        if (wx * wx + wy * wy > r2) continue
        const idx = jy * nx + jx
        if (cz < z[idx]) {
          z[idx] = cz
          changed = true
        }
      }
    }
  }

  const sweep = (a: [number, number, number], b: [number, number, number]) => {
    const d = Math.hypot(b[0] - a[0], b[1] - a[1])
    const stepLen = Math.max(Math.min(dx, dy) * 0.5, 1e-3)
    const n = Math.max(1, Math.ceil(d / stepLen))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      stamp(
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
      )
    }
  }

  const last = Math.min(count, segments.length)
  for (let i = Math.max(0, from); i < last; i++) {
    const s = segments[i]
    if (s.kind === 'cut') sweep(s.from, s.to)
  }
  if (partialTo && last < segments.length) {
    const s = segments[last]
    if (s.kind === 'cut') sweep(s.from, partialTo)
  }
  return changed
}

/**
 * Convenience: allocate a heightmap and carve `segments[0..count)` into it in one
 * call (full, non-incremental build). Used for one-shot scrubs; the renderer uses
 * the incremental {@link createRemovalHeightmap} + {@link sweepRemoval} during
 * forward playback.
 */
export function buildRemovalHeightmap(
  segments: SimSegmentLike[],
  count: number,
  partialTo: [number, number, number] | null,
  opts: BuildRemovalOptions,
): RemovalHeightmap {
  const hm = createRemovalHeightmap(opts)
  sweepRemoval(hm, segments, 0, count, opts.toolRadius, partialTo)
  return hm
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
 * Supports IJK centre offsets (default incremental) and R radius form, with
 * linear Z interpolation (helix). Adapted from the viewer's arc flattener,
 * kept self-contained here.
 */
function flattenArc(
  start: Pos,
  end: Pos,
  axis: { i?: number; j?: number; k?: number; r?: number },
  clockwise: boolean,
  absoluteArc: boolean,
): FlatSeg[] {
  let cx: number
  let cy: number

  if (axis.r !== undefined) {
    const center = centerFromRadius(start, end, axis.r, clockwise)
    if (!center) return [{ from: { ...start }, to: { ...end } }]
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
  if (r === 0 || !isFinite(r)) return [{ from: { ...start }, to: { ...end } }]

  const startAngle = Math.atan2(start.y - cy, start.x - cx)
  const endAngle = Math.atan2(end.y - cy, end.x - cx)

  let sweep = endAngle - startAngle
  if (clockwise) {
    while (sweep > 0) sweep -= TWO_PI
    if (sweep === 0) sweep = -TWO_PI
  } else {
    while (sweep < 0) sweep += TWO_PI
    if (sweep === 0) sweep = TWO_PI
  }

  const arcLen = Math.abs(sweep) * r
  let nFromTol: number
  if (ARC_TOLERANCE > 0 && ARC_TOLERANCE < r) {
    const maxAngle = 2 * Math.acos(1 - ARC_TOLERANCE / r)
    nFromTol = Math.ceil(Math.abs(sweep) / maxAngle)
  } else {
    nFromTol = Math.ceil(arcLen / Math.max(ARC_TOLERANCE, 0.1))
  }
  const n = Math.max(MIN_ARC_SEGMENTS, nFromTol, 1)

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
  const ux = -dy / d
  const uy = dx / d

  const sign = clockwise === r > 0 ? -1 : 1
  return { cx: mx + sign * h * ux, cy: my + sign * h * uy }
}
