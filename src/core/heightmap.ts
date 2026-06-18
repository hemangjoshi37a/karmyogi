// Auto-leveling / heightmap math — UI-independent, pure.
//
// Implements roadmap bet O1/P1 (PCB auto-leveling): probe a grid of Z-touch
// points over the board, build a height map Z(x,y), and WARP generated G-code so
// every cutting move's Z follows the board's tilt/warp instead of a single flat
// plane. This is the unlock for reliable PCB isolation — copper is only ~35 µm,
// so a board that is even slightly bowed or non-parallel to the spindle cannot
// be isolated at a constant Z.
//
// The pipeline:
//   1. probeGrid()         — derive a grid of XY points over a bounding area.
//   2. (operator probes)   — the panel runs a G38.2 cycle per point and records
//                            the touched Z, filling a HeightMap.
//   3. sampleHeight()      — BILINEAR interpolation of the surface at any (x,y).
//   4. warpGcode()         — rewrite a G-code program so each move's Z is offset
//                            by the local surface height; long G1 segments are
//                            SPLIT so Z tracks the surface, and G2/G3 arcs are
//                            LINEARIZED first (an arc can't carry a per-point Z).
//
// No DOM / React / store imports — this mirrors the Qt cadcam lib structure and
// stays unit-testable in isolation.

/** A probed grid point: planned XY plus the measured surface Z (work coords). */
export interface ProbePoint {
  /** Grid column index (0-based, increasing +X). */
  ix: number
  /** Grid row index (0-based, increasing +Y). */
  iy: number
  /** Planned probe X (work coords, mm). */
  x: number
  /** Planned probe Y (work coords, mm). */
  y: number
  /** Measured surface Z (work coords, mm). undefined until probed. */
  z?: number
}

/** Rectangular XY area to probe (work coordinates, mm). */
export interface ProbeArea {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/** Grid configuration: explicit point counts in each axis (>= 2). */
export interface GridConfig {
  /** Number of probe points along X (columns), >= 2. */
  nx: number
  /** Number of probe points along Y (rows), >= 2. */
  ny: number
}

/**
 * A completed (or in-progress) height map. `points` is row-major
 * (`iy * nx + ix`). `z` is undefined for not-yet-probed points; `complete`
 * reports whether every point has a measured Z.
 */
export interface HeightMap {
  area: ProbeArea
  nx: number
  ny: number
  /** Row-major grid of points (length nx*ny). */
  points: ProbePoint[]
  /** Step between columns (mm). */
  dx: number
  /** Step between rows (mm). */
  dy: number
}

const EPS = 1e-9

/** Clamp a value to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Choose grid point counts from a target spacing (mm). Returns the smallest
 * counts (>= 2) such that the step does not exceed `spacing`. A degenerate
 * (zero-extent) axis collapses to 2 points.
 */
export function gridForSpacing(area: ProbeArea, spacing: number): GridConfig {
  const w = Math.max(0, area.maxX - area.minX)
  const h = Math.max(0, area.maxY - area.minY)
  const s = spacing > EPS ? spacing : 10
  const nx = Math.max(2, Math.ceil(w / s) + 1)
  const ny = Math.max(2, Math.ceil(h / s) + 1)
  return { nx, ny }
}

/**
 * A sensible default spacing for an area — roughly dimension/10, clamped to a
 * practical 5–20 mm so a tiny board doesn't probe a needlessly dense grid and a
 * big one doesn't probe an impractically sparse one.
 */
export function defaultSpacing(area: ProbeArea): number {
  const maxDim = Math.max(area.maxX - area.minX, area.maxY - area.minY, 0)
  return clamp(maxDim / 10, 5, 20)
}

/**
 * Expand an area by a uniform margin on every side (mm). A negative margin
 * shrinks; the result is normalized so min <= max.
 */
export function expandArea(area: ProbeArea, margin: number): ProbeArea {
  const out: ProbeArea = {
    minX: area.minX - margin,
    minY: area.minY - margin,
    maxX: area.maxX + margin,
    maxY: area.maxY + margin,
  }
  if (out.maxX < out.minX) {
    const m = (out.minX + out.maxX) / 2
    out.minX = out.maxX = m
  }
  if (out.maxY < out.minY) {
    const m = (out.minY + out.maxY) / 2
    out.minY = out.maxY = m
  }
  return out
}

/**
 * Build an (unprobed) height-map grid for an area + config. Points are evenly
 * spaced inclusive of both edges, row-major, snake order left to the caller.
 */
export function probeGrid(area: ProbeArea, cfg: GridConfig): HeightMap {
  const nx = Math.max(2, Math.floor(cfg.nx))
  const ny = Math.max(2, Math.floor(cfg.ny))
  const dx = (area.maxX - area.minX) / (nx - 1)
  const dy = (area.maxY - area.minY) / (ny - 1)
  const points: ProbePoint[] = []
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      points.push({
        ix,
        iy,
        x: area.minX + ix * dx,
        y: area.minY + iy * dy,
      })
    }
  }
  return { area, nx, ny, points, dx, dy }
}

/**
 * Order grid points into a boustrophedon (snake) probe sequence — left→right on
 * even rows, right→left on odd rows — so the head travels the shortest path
 * between consecutive probes instead of rapiding back to the start of each row.
 */
export function snakeOrder(map: HeightMap): ProbePoint[] {
  const out: ProbePoint[] = []
  for (let iy = 0; iy < map.ny; iy++) {
    const row: ProbePoint[] = []
    for (let ix = 0; ix < map.nx; ix++) row.push(map.points[iy * map.nx + ix])
    if (iy % 2 === 1) row.reverse()
    out.push(...row)
  }
  return out
}

/** True when every grid point has a measured Z. */
export function isComplete(map: HeightMap): boolean {
  return map.points.every((p) => p.z != null && Number.isFinite(p.z))
}

/** Number of probed points so far. */
export function probedCount(map: HeightMap): number {
  return map.points.filter((p) => p.z != null && Number.isFinite(p.z)).length
}

/** Min/max measured Z over the probed points ({0,0} when none). */
export function zExtent(map: HeightMap): { min: number; max: number } {
  let min = Infinity
  let max = -Infinity
  for (const p of map.points) {
    if (p.z == null || !Number.isFinite(p.z)) continue
    if (p.z < min) min = p.z
    if (p.z > max) max = p.z
  }
  if (!Number.isFinite(min)) return { min: 0, max: 0 }
  return { min, max }
}

/** Z at a grid node, falling back to 0 for an unprobed node. */
function nodeZ(map: HeightMap, ix: number, iy: number): number {
  const p = map.points[iy * map.nx + ix]
  return p && p.z != null && Number.isFinite(p.z) ? p.z : 0
}

/**
 * BILINEAR-interpolate the surface height at an arbitrary (x, y). The point is
 * clamped to the grid extents (so a move slightly outside the probed area uses
 * the nearest edge's surface rather than extrapolating wildly). Interpolates
 * between the 4 surrounding grid nodes.
 */
export function sampleHeight(map: HeightMap, x: number, y: number): number {
  const { area, nx, ny } = map
  if (nx < 2 || ny < 2) return nodeZ(map, 0, 0)
  // Fractional grid coordinates, clamped into [0, n-1].
  const fx = clamp(((x - area.minX) / (area.maxX - area.minX)) * (nx - 1), 0, nx - 1)
  const fy = clamp(((y - area.minY) / (area.maxY - area.minY)) * (ny - 1), 0, ny - 1)
  const ix0 = Math.min(Math.floor(fx), nx - 2)
  const iy0 = Math.min(Math.floor(fy), ny - 2)
  const tx = fx - ix0
  const ty = fy - iy0
  const z00 = nodeZ(map, ix0, iy0)
  const z10 = nodeZ(map, ix0 + 1, iy0)
  const z01 = nodeZ(map, ix0, iy0 + 1)
  const z11 = nodeZ(map, ix0 + 1, iy0 + 1)
  const a = z00 * (1 - tx) + z10 * tx
  const b = z01 * (1 - tx) + z11 * tx
  return a * (1 - ty) + b * ty
}

// ---------------------------------------------------------------------------
// G-code warp
// ---------------------------------------------------------------------------

/** A parsed motion command we care about for warping. */
type Motion = 'G0' | 'G1' | 'G2' | 'G3'

/** Mutable modal machine state while scanning the program. */
interface ModalState {
  x: number
  y: number
  z: number
  motion: Motion | null
  /** Last feed word seen (so split/linearized segments re-state F when needed). */
  feed: number | null
  /** true = absolute (G90), false = incremental (G91). */
  absolute: boolean
  /** true = plane XY (G17). Arc warping only supports the XY plane. */
  planeXY: boolean
}

export interface WarpOptions {
  /**
   * Maximum XY length of a G1 cut segment before it is SPLIT into shorter
   * segments so Z can follow the surface between the endpoints (mm). Smaller =
   * smoother Z tracking, more lines. Default 1 mm.
   */
  maxSegment?: number
  /**
   * Maximum chord length when LINEARIZING a G2/G3 arc into G1 segments (mm).
   * Default = maxSegment.
   */
  arcSegment?: number
  /**
   * Z offset (mm) applied on top of the sampled surface — typically the work
   * Z=0 reference is the surface itself, so 0; use this only if the probe datum
   * differs from the cut datum. Default 0.
   */
  zOffset?: number
  /**
   * If true, the warp only adjusts Z for moves at or below this cut ceiling —
   * rapids/retracts above it keep their original (safe) Z so the head still
   * clears the work. Default: warp every move's Z (the surface offset is small).
   * When set, moves with original Z greater than `cutCeiling` are left untouched.
   */
  cutCeiling?: number
}

const NUM = '([+-]?\\d*\\.?\\d+)'

function readWord(line: string, letter: string): number | null {
  const re = new RegExp(letter + NUM, 'i')
  const m = re.exec(line)
  return m ? parseFloat(m[1]) : null
}

/** Strip a trailing `;` comment, returning the code part (for word scanning). */
function splitComment(line: string): { code: string } {
  const semi = line.indexOf(';')
  return { code: semi >= 0 ? line.slice(0, semi) : line }
}

/** Format a Z word avoiding -0.000 and trailing zeros (matches the emitter style). */
function fmt(n: number): string {
  if (Object.is(n, -0)) n = 0
  let s = n.toFixed(3)
  // Avoid "-0.000".
  if (s === '-0.000') s = '0.000'
  // Trim trailing zeros but keep at least one decimal place removed cleanly.
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return s
}

/**
 * Warp a G-code program so each motion's Z follows the probed surface.
 *
 * Behaviour:
 *  - G0/G1 with X/Y/Z: the target Z becomes `Z_orig + sampleHeight(x,y) + zOffset`.
 *  - Long G1 cuts are SPLIT so intermediate points get their own surface Z.
 *  - G2/G3 arcs are LINEARIZED into short G1 chords first (an arc word can't carry
 *    per-point Z), each chord then warped.
 *  - Non-motion lines (comments, M-codes, $-words, modal-only lines) pass through
 *    unchanged, while the scanner still tracks modal state (G90/G91, G17, F, last
 *    position) so warping stays correct.
 *  - Incremental (G91) moves are passed through UNWARPED (we can't know the
 *    absolute XY to sample) — PCB programs are absolute (G90); a defensive guard.
 *
 * This is a PURE text transform: it never mutates `map` and is safe to call once
 * per program. The caller is responsible for the apply-once guard (warping an
 * already-warped program would double-offset Z and ruin the board).
 */
export function warpGcode(gcode: string, map: HeightMap, opts: WarpOptions = {}): string {
  const maxSeg = Math.max(0.1, opts.maxSegment ?? 1)
  const arcSeg = Math.max(0.1, opts.arcSegment ?? maxSeg)
  const zOff = opts.zOffset ?? 0
  const ceiling = opts.cutCeiling

  const st: ModalState = {
    x: 0,
    y: 0,
    z: 0,
    motion: null,
    feed: null,
    absolute: true,
    planeXY: true,
  }

  const surfaceZ = (x: number, y: number, origZ: number): number => {
    // Above the cut ceiling (a rapid/retract): keep the original Z.
    if (ceiling != null && origZ > ceiling) return origZ
    return origZ + sampleHeight(map, x, y) + zOff
  }

  const out: string[] = []
  const lines = gcode.split(/\r?\n/)

  for (const raw of lines) {
    const { code } = splitComment(raw)
    const trimmed = code.trim()
    if (trimmed === '') {
      out.push(raw)
      continue
    }
    const upper = trimmed.toUpperCase()

    // Track modal distance / plane modes (these may share a line with motion).
    if (/\bG90\b/.test(upper)) st.absolute = true
    if (/\bG91\b/.test(upper)) st.absolute = false
    if (/\bG17\b/.test(upper)) st.planeXY = true
    if (/\bG1[89]\b/.test(upper)) st.planeXY = false
    const f = readWord(code, 'F')
    if (f != null) st.feed = f

    // Determine the motion code on this line (modal: reuse the last if only
    // coordinates are present).
    let motion: Motion | null = null
    const gm = /\bG0?([0123])\b/.exec(upper)
    if (gm) motion = ('G' + parseInt(gm[1], 10)) as Motion
    const hasCoord = /[XYZ]/i.test(code)
    if (!motion && hasCoord && st.motion) motion = st.motion
    if (motion) st.motion = motion

    // Non-motion line (no G0–G3 and no modal motion target): pass through, but
    // keep position words updated if any slipped through (rare).
    if (!motion || !hasCoord) {
      out.push(raw)
      continue
    }

    const nx = readWord(code, 'X')
    const ny = readWord(code, 'Y')
    const nz = readWord(code, 'Z')

    // Incremental moves can't be sampled (no absolute XY) — pass through and
    // best-effort track position.
    if (!st.absolute) {
      out.push(raw)
      if (nx != null) st.x += nx
      if (ny != null) st.y += ny
      if (nz != null) st.z += nz
      continue
    }

    const x0 = st.x
    const y0 = st.y
    const z0 = st.z
    const x1 = nx != null ? nx : x0
    const y1 = ny != null ? ny : y0
    const z1 = nz != null ? nz : z0

    if (motion === 'G2' || motion === 'G3') {
      // Linearize the arc into chords, each warped. Only the XY plane is
      // supported; otherwise pass the arc through unwarped (defensive).
      const i = readWord(code, 'I')
      const j = readWord(code, 'J')
      const r = readWord(code, 'R')
      const chords = st.planeXY
        ? arcToChords(x0, y0, x1, y1, z0, z1, motion === 'G2', i, j, r, arcSeg)
        : null
      if (!chords) {
        // Can't linearize — emit unchanged, but warp the endpoint Z if present.
        out.push(raw)
        st.x = x1
        st.y = y1
        st.z = z1
        continue
      }
      // First emitted chord re-states F (the arc carried the feed); subsequent
      // ones are modal G1 + the per-point warped Z.
      let first = true
      for (const c of chords) {
        const wz = surfaceZ(c.x, c.y, c.z)
        const parts = ['G1', `X${fmt(c.x)}`, `Y${fmt(c.y)}`, `Z${fmt(wz)}`]
        if (first && st.feed != null) parts.push(`F${fmt(st.feed)}`)
        out.push(parts.join(' '))
        first = false
      }
      st.x = x1
      st.y = y1
      st.z = z1
      continue
    }

    // G0 / G1 straight move.
    const dx = x1 - x0
    const dy = y1 - y0
    const xyLen = Math.hypot(dx, dy)

    // Split a long G1 cut so Z follows the surface. Rapids (G0) and short moves
    // are emitted as a single warped move (a rapid is above material; its Z is
    // warped only if below the ceiling, otherwise kept).
    const doSplit = motion === 'G1' && xyLen > maxSeg
    if (!doSplit) {
      const wz = surfaceZ(x1, y1, z1)
      out.push(rebuildMove(motion, nx, ny, wz, st.feed, f != null))
      st.x = x1
      st.y = y1
      st.z = z1
      continue
    }

    const nSeg = Math.ceil(xyLen / maxSeg)
    for (let k = 1; k <= nSeg; k++) {
      const tt = k / nSeg
      const px = x0 + dx * tt
      const py = y0 + dy * tt
      const pz = z0 + (z1 - z0) * tt
      const wz = surfaceZ(px, py, pz)
      const parts = ['G1', `X${fmt(px)}`, `Y${fmt(py)}`, `Z${fmt(wz)}`]
      // Re-state F on the first sub-segment if this line carried a feed word.
      if (k === 1 && f != null && st.feed != null) parts.push(`F${fmt(st.feed)}`)
      out.push(parts.join(' '))
    }
    st.x = x1
    st.y = y1
    st.z = z1
  }

  return out.join('\n')
}

/**
 * Rebuild a single (un-split) move line preserving its original X/Y words and
 * substituting the warped Z. Only the words present in the source are emitted
 * (so a Z-only or XY-only move stays minimal), plus the warped Z is always
 * stated (the whole point of the warp). The original comment is dropped here —
 * callers that need comments use the simple pass-through path.
 */
function rebuildMove(
  motion: Motion,
  nx: number | null,
  ny: number | null,
  warpedZ: number,
  feed: number | null,
  hadFeed: boolean,
): string {
  const parts: string[] = [motion]
  if (nx != null) parts.push(`X${fmt(nx)}`)
  if (ny != null) parts.push(`Y${fmt(ny)}`)
  parts.push(`Z${fmt(warpedZ)}`)
  if (hadFeed && feed != null) parts.push(`F${fmt(feed)}`)
  return parts.join(' ')
}

/** One linearized arc chord endpoint. */
interface Chord {
  x: number
  y: number
  z: number
}

/**
 * Linearize a circular arc (XY plane) from (x0,y0) to (x1,y1) into chord
 * endpoints, interpolating Z linearly along the swept angle (helical arc). `cw`
 * is true for G2 (clockwise). Center is derived from I/J (relative offsets) or
 * from R (radius). Returns null if the arc is degenerate / center can't be
 * resolved. The start point is NOT included (the head is already there); each
 * returned chord is a successive endpoint up to and including (x1,y1).
 */
export function arcToChords(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  z0: number,
  z1: number,
  cw: boolean,
  i: number | null,
  j: number | null,
  r: number | null,
  chordLen: number,
): Chord[] | null {
  let cx: number
  let cy: number
  if (i != null || j != null) {
    cx = x0 + (i ?? 0)
    cy = y0 + (j ?? 0)
  } else if (r != null && Math.abs(r) > EPS) {
    // Center from radius: midpoint + perpendicular offset.
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    const dx = x1 - x0
    const dy = y1 - y0
    const d = Math.hypot(dx, dy)
    if (d < EPS || d > 2 * Math.abs(r) + EPS) return null
    const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4))
    // Perpendicular unit vector.
    const ux = -dy / d
    const uy = dx / d
    // Sign selects which of the two centers; mirror GRBL's R-arc convention:
    // positive R => minor arc, negative R => major arc, combined with direction.
    const sign = (r < 0 ? 1 : -1) * (cw ? 1 : -1)
    cx = mx + sign * h * ux
    cy = my + sign * h * uy
  } else {
    return null
  }

  const rad = Math.hypot(x0 - cx, y0 - cy)
  if (rad < EPS) return null
  let a0 = Math.atan2(y0 - cy, x0 - cx)
  let a1 = Math.atan2(y1 - cy, x1 - cx)
  // Sweep direction: GRBL G2 is clockwise (decreasing angle), G3 ccw.
  if (cw) {
    if (a1 >= a0) a1 -= 2 * Math.PI
  } else {
    if (a1 <= a0) a1 += 2 * Math.PI
  }
  let sweep = a1 - a0
  // Full circle (start == end): treat as a complete revolution.
  if (Math.abs(sweep) < EPS && Math.hypot(x1 - x0, y1 - y0) < EPS) {
    sweep = cw ? -2 * Math.PI : 2 * Math.PI
  }
  const arcLen = Math.abs(sweep) * rad
  const n = Math.max(1, Math.ceil(arcLen / Math.max(EPS, chordLen)))
  const chords: Chord[] = []
  for (let k = 1; k <= n; k++) {
    const tt = k / n
    const a = a0 + sweep * tt
    chords.push({
      x: cx + rad * Math.cos(a),
      y: cy + rad * Math.sin(a),
      z: z0 + (z1 - z0) * tt,
    })
  }
  // Snap the final chord exactly onto the commanded endpoint (kill float drift).
  const last = chords[chords.length - 1]
  last.x = x1
  last.y = y1
  last.z = z1
  return chords
}
