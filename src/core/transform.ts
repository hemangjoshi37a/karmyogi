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
