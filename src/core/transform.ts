/**
 * Pure G-code placement transform.
 *
 * NO React / DOM / three / zustand imports — portable, testable core (mirrors the
 * Qt `cadcam` lib separation). Lets the 3D "place the job" gizmo move / rotate /
 * scale a loaded program in the XY plane and BAKE that placement back into the
 * G-code text, so the displayed toolpath, the playback simulation, and the
 * streamed program all derive from the same baked output and can never disagree.
 *
 * A {@link Placement} is an XY translate (mm), a Z-rotation (degrees, about the
 * design's own XY-bbox centre), and a uniform XY scale. Z and feed/spindle words
 * pass through untouched. The rewriter is modal: it tracks G90/G91 distance mode,
 * the current position, and the motion mode, so relative moves and modal lines
 * are handled correctly. Arc I/J offsets are rotated/scaled as vectors and the R
 * radius word is scaled.
 *
 * Transform order for an absolute XY point:
 *   1. translate to pivot (subtract pivot)
 *   2. scale (uniform)
 *   3. rotate by rotDeg about origin
 *   4. translate back (add pivot)
 *   5. add (dx, dy)
 */

export interface Placement {
  /** XY translation, mm. */
  dx: number
  dy: number
  /** Rotation about Z (degrees), pivoting on the design's XY-bbox centre. */
  rotDeg: number
  /** Uniform XY scale (1 = no change). */
  scale: number
}

export const IDENTITY_PLACEMENT: Placement = { dx: 0, dy: 0, rotDeg: 0, scale: 1 }

/** True when `p` is (within float tolerance) the identity placement. */
export function isIdentity(p: Placement): boolean {
  return (
    Math.abs(p.dx) < 1e-9 &&
    Math.abs(p.dy) < 1e-9 &&
    Math.abs(p.rotDeg) < 1e-9 &&
    Math.abs(p.scale - 1) < 1e-9
  )
}

interface Pos {
  x: number
  y: number
  z: number
}

interface Word {
  letter: string
  value: number
  /** Raw matched substring (lets us replace exactly what we parsed). */
  raw: string
  /** Index in the line where `raw` starts. */
  start: number
  /** Index in the line just past `raw`. */
  end: number
}

/** Match a letter + signed/decimal number, capturing positions for in-place rewrite. */
const WORD_RE = /([A-Za-z])\s*([-+]?(?:\d*\.\d+|\d+\.?\d*))/g

/** Strip `;` and `( ... )` comments, returning the code-only portion of a line. */
function codePortion(line: string): string {
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

/** Tokenize the code portion of a line into positioned words. */
function tokenize(code: string): Word[] {
  const words: Word[] = []
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(code)) !== null) {
    const value = parseFloat(m[2])
    if (!Number.isFinite(value)) continue
    words.push({
      letter: m[1].toUpperCase(),
      value,
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    })
  }
  return words
}

/**
 * Format a number for re-emission: up to 4 decimals, trailing zeros trimmed, and
 * never `-0` (matches the safe-G-code convention used by the emitter).
 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  let s = n.toFixed(4)
  // Trim trailing zeros and a trailing dot.
  if (s.indexOf('.') >= 0) {
    s = s.replace(/0+$/, '').replace(/\.$/, '')
  }
  if (s === '-0') s = '0'
  return s
}

/** Compute the XY bbox centre of the RAW program (pivot for rotation/scale). */
export function programXYBounds(
  gcode: string,
): { min: [number, number]; max: [number, number] } | null {
  if (typeof gcode !== 'string' || gcode.trim() === '') return null

  const pos: Pos = { x: 0, y: 0, z: 0 }
  let absolute = true
  let any = false
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  const acc = (x: number, y: number) => {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    any = true
  }

  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine)
    if (code.trim() === '') continue
    const words = tokenize(code)
    if (words.length === 0) continue

    let nx: number | undefined
    let ny: number | undefined
    let nz: number | undefined
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true
        else if (w.value === 91) absolute = false
      } else if (w.letter === 'X') nx = w.value
      else if (w.letter === 'Y') ny = w.value
      else if (w.letter === 'Z') nz = w.value
    }

    if (nx === undefined && ny === undefined && nz === undefined) continue

    const tx = nx === undefined ? pos.x : absolute ? nx : pos.x + nx
    const ty = ny === undefined ? pos.y : absolute ? ny : pos.y + ny
    const tz = nz === undefined ? pos.z : absolute ? nz : pos.z + nz

    // Only XY-bearing moves contribute to the placement footprint.
    if (nx !== undefined || ny !== undefined) acc(tx, ty)
    pos.x = tx
    pos.y = ty
    pos.z = tz
  }

  if (!any || !Number.isFinite(minX)) return null
  return { min: [minX, minY], max: [maxX, maxY] }
}

/** Apply scale+rotation (about origin) to a vector (no translation). */
function rotScaleVec(
  vx: number,
  vy: number,
  s: number,
  cos: number,
  sin: number,
): [number, number] {
  const sx = vx * s
  const sy = vy * s
  return [sx * cos - sy * sin, sx * sin + sy * cos]
}

/**
 * Rewrite a G-code program applying `placement` to X/Y (and arc I/J as vectors,
 * R by scale). Z and feed/spindle words pass through untouched.
 *
 * Robust on empty / non-string / garbage input: returns the input unchanged when
 * there is nothing to transform or the placement is the identity.
 */
export function applyPlacement(gcode: string, p: Placement): string {
  if (typeof gcode !== 'string' || gcode === '') return gcode
  if (isIdentity(p)) return gcode

  const bounds = programXYBounds(gcode)
  // No XY geometry → nothing meaningful to place; pass through unchanged.
  if (!bounds) return gcode

  const pivotX = (bounds.min[0] + bounds.max[0]) / 2
  const pivotY = (bounds.min[1] + bounds.max[1]) / 2
  const s = p.scale
  const rad = (p.rotDeg * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)

  /** Map an ABSOLUTE XY point through the full placement. */
  const mapPoint = (x: number, y: number): [number, number] => {
    const [rx, ry] = rotScaleVec(x - pivotX, y - pivotY, s, cos, sin)
    return [rx + pivotX + p.dx, ry + pivotY + p.dy]
  }

  const pos: Pos = { x: 0, y: 0, z: 0 }
  let absolute = true

  const outLines: string[] = []

  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine)
    if (code.trim() === '') {
      outLines.push(rawLine)
      continue
    }
    const words = tokenize(code)
    if (words.length === 0) {
      outLines.push(rawLine)
      continue
    }

    // Distance-mode update (applies to this and later lines).
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true
        else if (w.value === 91) absolute = false
      }
    }

    const xW = words.find((w) => w.letter === 'X')
    const yW = words.find((w) => w.letter === 'Y')
    const iW = words.find((w) => w.letter === 'I')
    const jW = words.find((w) => w.letter === 'J')
    const rW = words.find((w) => w.letter === 'R')
    const zW = words.find((w) => w.letter === 'Z')

    // Resolve target absolute position (needed both for bbox-correct mapping and
    // to advance the modal position regardless of whether we rewrite).
    const tx = xW === undefined ? pos.x : absolute ? xW.value : pos.x + xW.value
    const ty = yW === undefined ? pos.y : absolute ? yW.value : pos.y + yW.value
    const tz = zW === undefined ? pos.z : absolute ? zW.value : pos.z + zW.value

    // Build a list of (word, newValue) replacements for this line.
    const repl: { w: Word; value: number }[] = []

    if (xW !== undefined || yW !== undefined) {
      if (absolute) {
        const [mx, my] = mapPoint(tx, ty)
        if (xW !== undefined) repl.push({ w: xW, value: mx })
        if (yW !== undefined) repl.push({ w: yW, value: my })
      } else {
        // Relative: the move delta is a vector — rotate+scale it (no translate).
        const dx = xW?.value ?? 0
        const dy = yW?.value ?? 0
        const [mdx, mdy] = rotScaleVec(dx, dy, s, cos, sin)
        if (xW !== undefined) repl.push({ w: xW, value: mdx })
        if (yW !== undefined) repl.push({ w: yW, value: mdy })
      }
    }

    // Arc I/J are centre-offset VECTORS in both abs/rel arc modes → rotate+scale.
    if (iW !== undefined || jW !== undefined) {
      const i = iW?.value ?? 0
      const j = jW?.value ?? 0
      const [mi, mj] = rotScaleVec(i, j, s, cos, sin)
      if (iW !== undefined) repl.push({ w: iW, value: mi })
      if (jW !== undefined) repl.push({ w: jW, value: mj })
    }

    // R-form arc radius scales (magnitude); sign (minor/major selector) kept.
    if (rW !== undefined) {
      repl.push({ w: rW, value: rW.value * s })
    }

    // Splice replacements into the original line, preserving comments and the
    // exact non-code formatting around each word.
    if (repl.length > 0) {
      repl.sort((a, b) => a.w.start - b.w.start)
      let out = ''
      let cursor = 0
      for (const r of repl) {
        out += rawLine.slice(cursor, r.w.start)
        out += r.w.letter + fmt(r.value)
        cursor = r.w.end
      }
      out += rawLine.slice(cursor)
      outLines.push(out)
    } else {
      outLines.push(rawLine)
    }

    pos.x = tx
    pos.y = ty
    pos.z = tz
  }

  return outLines.join('\n')
}

// ===========================================================================
// Full-3D job placement (the interactive Visualizer toolpath gizmo).
//
// The 2.5D `Placement` above (XY translate / Z-rotate / uniform scale) stays the
// canonical type for the 3D-carve mesh jobs (carve3d / carveJobs / nesting). The
// in-canvas toolpath gizmo, by contrast, offers MOVE / ROTATE / SCALE on ALL
// THREE axes, so it needs a richer description. {@link JobPlacement} stores a
// translation (mm), a ROTATION QUATERNION (about the program's 3D bbox centre),
// and a PER-AXIS scale. A quaternion (not Euler angles) is used so the bake
// matches the gizmo's decomposed matrix exactly with no Euler-order ambiguity.
//
// Baking is exact for the common "in-plane similarity" case (rotation about Z +
// uniform XY scale) — arcs survive as G2/G3 exactly as before. For any
// out-of-plane rotation or non-uniform XY scale (which would turn a circular arc
// into an out-of-plane curve or an ellipse — not representable as a single
// G2/G3), affected arcs are LINEARISED into short G1 segments so the streamed +
// simulated G-code is always geometrically correct on a 3-axis machine.
// ===========================================================================

/** A full-3D placement for the interactive toolpath gizmo. */
export interface JobPlacement {
  /** Translation, mm. */
  dx: number
  dy: number
  dz: number
  /** Rotation quaternion (about the program's 3D bbox centre). */
  qx: number
  qy: number
  qz: number
  qw: number
  /** Per-axis scale (1 = no change). */
  sx: number
  sy: number
  sz: number
}

export const IDENTITY_JOB_PLACEMENT: JobPlacement = {
  dx: 0,
  dy: 0,
  dz: 0,
  qx: 0,
  qy: 0,
  qz: 0,
  qw: 1,
  sx: 1,
  sy: 1,
  sz: 1,
}

/** True when `p` is (within float tolerance) the identity job placement. */
export function isIdentityJob(p: JobPlacement): boolean {
  return (
    Math.abs(p.dx) < 1e-9 &&
    Math.abs(p.dy) < 1e-9 &&
    Math.abs(p.dz) < 1e-9 &&
    Math.abs(p.sx - 1) < 1e-9 &&
    Math.abs(p.sy - 1) < 1e-9 &&
    Math.abs(p.sz - 1) < 1e-9 &&
    p.qx * p.qx + p.qy * p.qy + p.qz * p.qz < 1e-18
  )
}

interface Bounds3 {
  min: [number, number, number]
  max: [number, number, number]
}

/** Full 3D bbox of a program (every axis-bearing move contributes). */
export function programBounds3(gcode: string): Bounds3 | null {
  if (typeof gcode !== 'string' || gcode.trim() === '') return null
  const pos: Pos = { x: 0, y: 0, z: 0 }
  let absolute = true
  let any = false
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const acc = (x: number, y: number, z: number) => {
    if (x < min[0]) min[0] = x
    if (y < min[1]) min[1] = y
    if (z < min[2]) min[2] = z
    if (x > max[0]) max[0] = x
    if (y > max[1]) max[1] = y
    if (z > max[2]) max[2] = z
    any = true
  }

  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine)
    if (code.trim() === '') continue
    const words = tokenize(code)
    if (words.length === 0) continue
    let nx: number | undefined
    let ny: number | undefined
    let nz: number | undefined
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true
        else if (w.value === 91) absolute = false
      } else if (w.letter === 'X') nx = w.value
      else if (w.letter === 'Y') ny = w.value
      else if (w.letter === 'Z') nz = w.value
    }
    if (nx === undefined && ny === undefined && nz === undefined) continue
    const tx = nx === undefined ? pos.x : absolute ? nx : pos.x + nx
    const ty = ny === undefined ? pos.y : absolute ? ny : pos.y + ny
    const tz = nz === undefined ? pos.z : absolute ? nz : pos.z + nz
    acc(tx, ty, tz)
    pos.x = tx
    pos.y = ty
    pos.z = tz
  }

  if (!any || !Number.isFinite(min[0])) return null
  return { min, max }
}

/** Rotate a vector by a quaternion (pure math, no three.js). */
function qRot(
  q: { x: number; y: number; z: number; w: number },
  vx: number,
  vy: number,
  vz: number,
): [number, number, number] {
  const { x, y, z, w } = q
  const tx = 2 * (y * vz - z * vy)
  const ty = 2 * (z * vx - x * vz)
  const tz = 2 * (x * vy - y * vx)
  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ]
}

/** Convert a (normalised) quaternion to XYZ-order Euler angles in DEGREES (for UI readout). */
export function quaternionToEulerDeg(
  qx: number,
  qy: number,
  qz: number,
  qw: number,
): [number, number, number] {
  // Rotation-matrix elements (matches three.js' makeRotationFromQuaternion).
  const m11 = 1 - 2 * (qy * qy + qz * qz)
  const m12 = 2 * (qx * qy - qz * qw)
  const m13 = 2 * (qx * qz + qy * qw)
  const m22 = 1 - 2 * (qx * qx + qz * qz)
  const m23 = 2 * (qy * qz - qx * qw)
  const m32 = 2 * (qy * qz + qx * qw)
  const m33 = 1 - 2 * (qx * qx + qy * qy)
  const clamp = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v)
  const ry = Math.asin(clamp(m13))
  let rx: number
  let rz: number
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-m23, m33)
    rz = Math.atan2(-m12, m11)
  } else {
    rx = Math.atan2(m32, m22)
    rz = 0
  }
  return [rx * (180 / Math.PI), ry * (180 / Math.PI), rz * (180 / Math.PI)]
}

/** Strip everything from the first depth-0 `;` comment onward; returns [code, comment]. */
function splitComment(line: string): [string, string] {
  const i = line.indexOf(';')
  if (i < 0) return [line, '']
  return [line.slice(0, i), line.slice(i)]
}

/** Axis + arc-offset words (used to rebuild a coordinate line under a 3D transform). */
const AXIS_RE = /[XYZIJKR]\s*[-+]?(?:\d*\.\d+|\d+\.?\d*)/gi

const ARC_TOL = 0.02 // mm chord deviation when linearising
const ARC_MIN_SEG = 2
const ARC_MAX_SEG = 1440

/** GRBL R-form → arc centre (ports GRBL's gcode.c computation). */
function centerFromR(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  R: number,
  cw: boolean,
): { cx: number; cy: number } | null {
  const x = x1 - x0
  const y = y1 - y0
  const dsq = x * x + y * y
  if (dsq < 1e-12) return null
  let r = R
  let val = 4 * r * r - dsq
  if (val < 0) val = 0
  let h = -Math.sqrt(val) / Math.sqrt(dsq)
  if (!cw) h = -h // G3 (CCW)
  if (r < 0) {
    h = -h
    r = -r
  }
  const i = 0.5 * (x - y * h)
  const j = 0.5 * (y + x * h)
  return { cx: x0 + i, cy: y0 + j }
}

/** Sample a planar (XY) arc into absolute points (excluding the start, ending exactly at the end). */
function arcPoints(
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
  cx: number,
  cy: number,
  cw: boolean,
): { x: number; y: number; z: number }[] {
  const r = Math.hypot(x0 - cx, y0 - cy)
  const a0 = Math.atan2(y0 - cy, x0 - cx)
  const a1 = Math.atan2(y1 - cy, x1 - cx)
  let sweep = a1 - a0
  if (cw) {
    if (sweep >= 0) sweep -= 2 * Math.PI
  } else {
    if (sweep <= 0) sweep += 2 * Math.PI
  }
  const abs = Math.abs(sweep)
  let n = ARC_MIN_SEG
  if (r > ARC_TOL) {
    const step = 2 * Math.acos(Math.max(-1, 1 - ARC_TOL / r))
    if (step > 1e-9) n = Math.ceil(abs / step)
  }
  n = Math.max(ARC_MIN_SEG, Math.min(ARC_MAX_SEG, n))
  const pts: { x: number; y: number; z: number }[] = []
  for (let k = 1; k <= n; k++) {
    const f = k / n
    const a = a0 + sweep * f
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: z0 + (z1 - z0) * f })
  }
  // Pin the last point to the exact commanded end (avoids float drift).
  pts[pts.length - 1] = { x: x1, y: y1, z: z1 }
  return pts
}

/**
 * Rewrite a G-code program applying a full-3D {@link JobPlacement}. Robust on
 * empty / garbage input and an identity placement (returns the input unchanged).
 */
export function applyJobPlacement(gcode: string, p: JobPlacement): string {
  if (typeof gcode !== 'string' || gcode === '') return gcode
  if (isIdentityJob(p)) return gcode
  const bounds = programBounds3(gcode)
  if (!bounds) return gcode

  const cx = (bounds.min[0] + bounds.max[0]) / 2
  const cy = (bounds.min[1] + bounds.max[1]) / 2
  // Z pivot is the WORK ZERO (stock top), NOT the bbox centre. Scaling Z about the
  // bbox centre pulled the positive safe-Z retract DOWN into the stock (e.g. a
  // ×0.25 Z-scale put a +5mm retract at −1.9mm — a crash). Pivoting Z at 0 keeps
  // every retract (Z>0) positive for any positive Z-scale and scales the relief
  // (Z<0) about the surface, which is also the intuitive CNC behaviour.
  const cz = 0
  const q = { x: p.qx, y: p.qy, z: p.qz, w: p.qw }
  // Guard against a zero/degenerate axis scale silently collapsing the program
  // onto a plane/line (a near-zero Z-scale was the real cause of the reported
  // "rotate → everything goes flat"). Clamp magnitude to a sane minimum, keep sign.
  const clampScale = (s: number): number => {
    if (!Number.isFinite(s) || s === 0) return 1
    const a = Math.abs(s)
    return a < 0.01 ? (s < 0 ? -0.01 : 0.01) : s
  }
  const sx = clampScale(p.sx)
  const sy = clampScale(p.sy)
  const sz = clampScale(p.sz)
  const { dx, dy, dz } = p

  // In-plane similarity: rotation purely about Z AND uniform XY scale. Then a
  // planar arc stays a planar circular arc → keep G2/G3 exactly (no linearise).
  const inPlane =
    Math.abs(q.x) < 1e-6 &&
    Math.abs(q.y) < 1e-6 &&
    Math.abs(sx - sy) < 1e-6 * Math.max(1, Math.abs(sx))

  /** Map an ABSOLUTE point through scale → rotate(about pivot) → translate. */
  const mapPoint = (x: number, y: number, z: number): [number, number, number] => {
    const [rx, ry, rz] = qRot(q, (x - cx) * sx, (y - cy) * sy, (z - cz) * sz)
    return [rx + cx + dx, ry + cy + dy, rz + cz + dz]
  }
  /** Map a relative move DELTA (linear part only: scale then rotate). */
  const mapVec = (vx: number, vy: number, vz: number): [number, number, number] =>
    qRot(q, vx * sx, vy * sy, vz * sz)

  const pos: Pos = { x: 0, y: 0, z: 0 }
  let absolute = true
  let motion = 0
  let plane = 17
  const out: string[] = []

  for (const rawLine of gcode.split(/\r?\n/)) {
    const code = codePortion(rawLine)
    if (code.trim() === '') {
      out.push(rawLine)
      continue
    }
    const words = tokenize(code)
    if (words.length === 0) {
      out.push(rawLine)
      continue
    }

    // Modal updates (apply to this + later lines). Track an explicit per-line
    // motion word too, so a modal arc continuation is still detected as an arc.
    let lineMotion = motion
    for (const w of words) {
      if (w.letter === 'G') {
        if (w.value === 90) absolute = true
        else if (w.value === 91) absolute = false
        else if (w.value === 17) plane = 17
        else if (w.value === 18) plane = 18
        else if (w.value === 19) plane = 19
        else if (w.value === 0 || w.value === 1 || w.value === 2 || w.value === 3) {
          motion = w.value
          lineMotion = w.value
        }
      }
    }

    const xW = words.find((w) => w.letter === 'X')
    const yW = words.find((w) => w.letter === 'Y')
    const zW = words.find((w) => w.letter === 'Z')
    const iW = words.find((w) => w.letter === 'I')
    const jW = words.find((w) => w.letter === 'J')
    const kW = words.find((w) => w.letter === 'K')
    const rW = words.find((w) => w.letter === 'R')
    const fW = words.find((w) => w.letter === 'F')
    const hasCoord = xW !== undefined || yW !== undefined || zW !== undefined
    const isArc =
      (lineMotion === 2 || lineMotion === 3) &&
      (hasCoord || iW !== undefined || jW !== undefined || rW !== undefined)

    const tx = xW === undefined ? pos.x : absolute ? xW.value : pos.x + xW.value
    const ty = yW === undefined ? pos.y : absolute ? yW.value : pos.y + yW.value
    const tz = zW === undefined ? pos.z : absolute ? zW.value : pos.z + zW.value

    // --- Out-of-plane / non-uniform arc → LINEARISE to G1 segments ----------
    if (isArc && plane === 17 && !inPlane) {
      const cw = lineMotion === 2
      let center: { cx: number; cy: number } | null = null
      if (iW !== undefined || jW !== undefined) {
        center = { cx: pos.x + (iW?.value ?? 0), cy: pos.y + (jW?.value ?? 0) }
      } else if (rW !== undefined) {
        center = centerFromR(pos.x, pos.y, tx, ty, rW.value, cw)
      }
      if (center) {
        const pts = arcPoints(pos.x, pos.y, pos.z, tx, ty, tz, center.cx, center.cy, cw)
        let prevX = pos.x
        let prevY = pos.y
        let prevZ = pos.z
        for (let k = 0; k < pts.length; k++) {
          const pt = pts[k]
          let line: string
          if (absolute) {
            const [mx, my, mz] = mapPoint(pt.x, pt.y, pt.z)
            line = `G1 X${fmt(mx)} Y${fmt(my)} Z${fmt(mz)}`
          } else {
            const [mvx, mvy, mvz] = mapVec(pt.x - prevX, pt.y - prevY, pt.z - prevZ)
            line = `G1 X${fmt(mvx)} Y${fmt(mvy)} Z${fmt(mvz)}`
          }
          if (k === 0 && fW !== undefined) line += ` F${fmt(fW.value)}`
          out.push(line)
          prevX = pt.x
          prevY = pt.y
          prevZ = pt.z
        }
        pos.x = tx
        pos.y = ty
        pos.z = tz
        continue
      }
      // Fall through to the linear rebuild if no valid centre was derivable.
    }

    // --- General (out-of-plane / non-uniform) linear / rapid move -----------
    // Rotation couples axes, so a transformed coordinate move must emit X Y Z
    // together (the unwritten axes also shift). We never reach this for arcs.
    if (!inPlane && hasCoord) {
      const [codePart, comment] = splitComment(rawLine)
      const stripped = codePart.replace(AXIS_RE, '').replace(/\s+/g, ' ').trimEnd()
      let coords: string
      if (absolute) {
        const [mx, my, mz] = mapPoint(tx, ty, tz)
        coords = `X${fmt(mx)} Y${fmt(my)} Z${fmt(mz)}`
      } else {
        const [mvx, mvy, mvz] = mapVec(xW?.value ?? 0, yW?.value ?? 0, zW?.value ?? 0)
        coords = `X${fmt(mvx)} Y${fmt(mvy)} Z${fmt(mvz)}`
      }
      let res = stripped ? `${stripped} ${coords}` : coords
      if (comment) res += ` ${comment}`
      out.push(res)
      pos.x = tx
      pos.y = ty
      pos.z = tz
      continue
    }

    // --- In-plane similarity (or non-coordinate line): minimal in-place splice
    const repl: { w: Word; value: number }[] = []
    if (hasCoord) {
      if (absolute) {
        const [mx, my, mz] = mapPoint(tx, ty, tz)
        if (xW !== undefined) repl.push({ w: xW, value: mx })
        if (yW !== undefined) repl.push({ w: yW, value: my })
        if (zW !== undefined) repl.push({ w: zW, value: mz })
      } else {
        const [mvx, mvy, mvz] = mapVec(xW?.value ?? 0, yW?.value ?? 0, zW?.value ?? 0)
        if (xW !== undefined) repl.push({ w: xW, value: mvx })
        if (yW !== undefined) repl.push({ w: yW, value: mvy })
        if (zW !== undefined) repl.push({ w: zW, value: mvz })
      }
    }
    // Arc centre offsets: I/J rotate+scale in-plane; K (G18/19) scales with Z.
    if (iW !== undefined || jW !== undefined) {
      const [mi, mj] = mapVec(iW?.value ?? 0, jW?.value ?? 0, 0)
      if (iW !== undefined) repl.push({ w: iW, value: mi })
      if (jW !== undefined) repl.push({ w: jW, value: mj })
    }
    if (kW !== undefined) repl.push({ w: kW, value: kW.value * sz })
    // R-form radius scales by the (uniform) in-plane scale.
    if (rW !== undefined) repl.push({ w: rW, value: rW.value * sx })

    if (repl.length > 0) {
      repl.sort((a, b) => a.w.start - b.w.start)
      let res = ''
      let cursor = 0
      for (const r of repl) {
        res += rawLine.slice(cursor, r.w.start)
        res += r.w.letter + fmt(r.value)
        cursor = r.w.end
      }
      res += rawLine.slice(cursor)
      out.push(res)
    } else {
      out.push(rawLine)
    }

    pos.x = tx
    pos.y = ty
    pos.z = tz
  }

  return out.join('\n')
}
