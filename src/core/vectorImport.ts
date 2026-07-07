// Unified vector-graphics importer → flat polylines, for the stitch/embroidery
// and house-print panels. Dispatches by extension/content to the DXF importer or
// a self-contained SVG parser and returns simple {x,y} point paths in a Y-UP CNC
// coordinate frame (SVG's Y-down is flipped), decoupled from the CAD Entity/Drawing
// classes so any panel can consume it. Pure — no React/DOM-render dependency
// (uses DOMParser only to read SVG XML, which is available in the browser).

import { importDxfString } from './dxf'

export interface ImportedPath {
  points: { x: number; y: number }[]
  closed: boolean
}

export interface VectorImportResult {
  ok: boolean
  paths: ImportedPath[]
  warnings: string[]
  error?: string
  /** Combined bounds of all paths (post-normalisation), for fit/scale. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number } | null
}

/** File-picker `accept` string for the formats we can import. */
export const VECTOR_ACCEPT = '.svg,.dxf'

const EMPTY_BOUNDS = null

function computeBounds(paths: ImportedPath[]): VectorImportResult['bounds'] {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const p of paths) {
    for (const pt of p.points) {
      if (pt.x < minX) minX = pt.x
      if (pt.y < minY) minY = pt.y
      if (pt.x > maxX) maxX = pt.x
      if (pt.y > maxY) maxY = pt.y
    }
  }
  if (!Number.isFinite(minX)) return EMPTY_BOUNDS
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
}

/** Parse a vector file's text into flattened polylines. Never throws. */
export function importVectorFile(name: string, text: string): VectorImportResult {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  try {
    let paths: ImportedPath[]
    let warnings: string[] = []
    if (ext === 'svg' || (/[<][\s]*svg[\s>]/i.test(text) && ext !== 'dxf')) {
      const r = parseSvg(text)
      paths = r.paths
      warnings = r.warnings
    } else if (ext === 'dxf' || /^\s*0\s*[\r\n]+\s*SECTION/i.test(text) || /\bENTITIES\b/.test(text)) {
      const r = importDxfString(text)
      if (!r.ok) return { ok: false, paths: [], warnings: r.warnings ?? [], error: r.error, bounds: null }
      paths = drawingToPaths(r.drawing)
      warnings = r.warnings ?? []
    } else {
      return { ok: false, paths: [], warnings: [], error: `Unsupported vector file (.${ext}). Use SVG or DXF.`, bounds: null }
    }
    paths = paths.filter((p) => p.points.length >= 2)
    if (paths.length === 0) {
      return { ok: false, paths: [], warnings, error: 'No usable paths found in the file.', bounds: null }
    }
    return { ok: true, paths, warnings, bounds: computeBounds(paths) }
  } catch (e) {
    return { ok: false, paths: [], warnings: [], error: e instanceof Error ? e.message : String(e), bounds: null }
  }
}

// ── DXF → paths (reuse the CAD importer + Entity.flatten) ──────────────────
function drawingToPaths(drawing: { entities: { flatten: () => { points: { x: number; y: number }[]; closed: boolean } }[] }): ImportedPath[] {
  const out: ImportedPath[] = []
  for (const e of drawing.entities) {
    const pl = e.flatten()
    if (pl.points.length >= 2) out.push({ points: pl.points.map((p) => ({ x: p.x, y: p.y })), closed: pl.closed })
  }
  return out
}

// ── SVG parser ─────────────────────────────────────────────────────────────
// Handles <path> (M/L/H/V/C/S/Q/T/A/Z, abs+rel), <line>, <polyline>, <polygon>,
// <rect>, <circle>, <ellipse>, with `transform` (translate/scale/rotate/matrix/
// skewX/skewY) accumulated up the tree. Curves + arcs are flattened. Y is flipped
// so the design sits upright on a Y-up bed.

type Mat = [number, number, number, number, number, number] // a b c d e f
const IDENT: Mat = [1, 0, 0, 1, 0, 0]
function matMul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ]
}
function apply(m: Mat, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] }
}
function parseTransform(str: string | null): Mat {
  if (!str) return IDENT
  let m: Mat = IDENT
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(str))) {
    const n = mm[2].split(/[\s,]+/).map(Number).filter((v) => !Number.isNaN(v))
    let t: Mat = IDENT
    switch (mm[1]) {
      case 'matrix':
        if (n.length === 6) t = [n[0], n[1], n[2], n[3], n[4], n[5]]
        break
      case 'translate':
        t = [1, 0, 0, 1, n[0] || 0, n[1] || 0]
        break
      case 'scale':
        t = [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]
        break
      case 'rotate': {
        const a = ((n[0] || 0) * Math.PI) / 180
        const cos = Math.cos(a)
        const sin = Math.sin(a)
        const rot: Mat = [cos, sin, -sin, cos, 0, 0]
        if (n.length >= 3) {
          t = matMul(matMul([1, 0, 0, 1, n[1], n[2]], rot), [1, 0, 0, 1, -n[1], -n[2]])
        } else t = rot
        break
      }
      case 'skewX':
        t = [1, 0, Math.tan(((n[0] || 0) * Math.PI) / 180), 1, 0, 0]
        break
      case 'skewY':
        t = [1, Math.tan(((n[0] || 0) * Math.PI) / 180), 0, 1, 0, 0]
        break
    }
    m = matMul(m, t)
  }
  return m
}
function elementMatrix(el: Element): Mat {
  // Compose transforms from the SVG root down to this element.
  const chain: Element[] = []
  let cur: Element | null = el
  while (cur && cur.nodeType === 1) {
    chain.push(cur)
    cur = cur.parentElement
    if (cur && cur.tagName.toLowerCase() === 'svg') {
      chain.push(cur)
      break
    }
  }
  let m: Mat = IDENT
  for (let i = chain.length - 1; i >= 0; i--) {
    m = matMul(m, parseTransform(chain[i].getAttribute('transform')))
  }
  return m
}

const CURVE_STEPS = 24
function cubic(p0: number[], p1: number[], p2: number[], p3: number[], out: number[][]): void {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS
    const u = 1 - t
    const x = u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0]
    const y = u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    out.push([x, y])
  }
}
function quad(p0: number[], p1: number[], p2: number[], out: number[][]): void {
  for (let i = 1; i <= CURVE_STEPS; i++) {
    const t = i / CURVE_STEPS
    const u = 1 - t
    out.push([u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0], u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]])
  }
}
function arc(x1: number, y1: number, rx: number, ry: number, phi: number, large: number, sweep: number, x2: number, y2: number, out: number[][]): void {
  if (rx === 0 || ry === 0) {
    out.push([x2, y2])
    return
  }
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  const rad = (phi * Math.PI) / 180
  const cosP = Math.cos(rad)
  const sinP = Math.sin(rad)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  let lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
    lam = 1
  }
  const sign = large === sweep ? -1 : 1
  const num = Math.max(rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p, 0)
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const co = sign * Math.sqrt(num / (den || 1))
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy)) || 1
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  if (sweep && dth < 0) dth += 2 * Math.PI
  const steps = Math.max(2, Math.ceil((Math.abs(dth) / (Math.PI / 2)) * CURVE_STEPS))
  for (let i = 1; i <= steps; i++) {
    const th = th1 + (dth * i) / steps
    const xe = cosP * rx * Math.cos(th) - sinP * ry * Math.sin(th) + cx
    const ye = sinP * rx * Math.cos(th) + cosP * ry * Math.sin(th) + cy
    out.push([xe, ye])
  }
}

/** Parse an SVG path `d` string into subpaths of raw points. */
function parsePathD(d: string): { pts: number[][]; closed: boolean }[] {
  const toks = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  const subs: { pts: number[][]; closed: boolean }[] = []
  let pts: number[][] = []
  let cx = 0,
    cy = 0,
    startX = 0,
    startY = 0
  let i = 0
  let cmd = ''
  let prevCtrl: number[] | null = null
  let prevCmd = ''
  const num = () => parseFloat(toks[i++])
  const flush = (closed: boolean) => {
    if (pts.length >= 1) subs.push({ pts, closed })
    pts = []
  }
  while (i < toks.length) {
    if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    switch (C) {
      case 'M': {
        if (pts.length) flush(false)
        let x = num(),
          y = num()
        if (rel) {
          x += cx
          y += cy
        }
        cx = startX = x
        cy = startY = y
        pts = [[cx, cy]]
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        let x = num(),
          y = num()
        if (rel) {
          x += cx
          y += cy
        }
        cx = x
        cy = y
        pts.push([cx, cy])
        break
      }
      case 'H': {
        let x = num()
        if (rel) x += cx
        cx = x
        pts.push([cx, cy])
        break
      }
      case 'V': {
        let y = num()
        if (rel) y += cy
        cy = y
        pts.push([cx, cy])
        break
      }
      case 'C': {
        let x1 = num(),
          y1 = num(),
          x2 = num(),
          y2 = num(),
          x = num(),
          y = num()
        if (rel) {
          x1 += cx
          y1 += cy
          x2 += cx
          y2 += cy
          x += cx
          y += cy
        }
        cubic([cx, cy], [x1, y1], [x2, y2], [x, y], pts)
        prevCtrl = [x2, y2]
        cx = x
        cy = y
        break
      }
      case 'S': {
        let x2 = num(),
          y2 = num(),
          x = num(),
          y = num()
        if (rel) {
          x2 += cx
          y2 += cy
          x += cx
          y += cy
        }
        const c1 = prevCtrl && 'CS'.includes(prevCmd) ? [2 * cx - prevCtrl[0], 2 * cy - prevCtrl[1]] : [cx, cy]
        cubic([cx, cy], c1, [x2, y2], [x, y], pts)
        prevCtrl = [x2, y2]
        cx = x
        cy = y
        break
      }
      case 'Q': {
        let x1 = num(),
          y1 = num(),
          x = num(),
          y = num()
        if (rel) {
          x1 += cx
          y1 += cy
          x += cx
          y += cy
        }
        quad([cx, cy], [x1, y1], [x, y], pts)
        prevCtrl = [x1, y1]
        cx = x
        cy = y
        break
      }
      case 'T': {
        let x = num(),
          y = num()
        if (rel) {
          x += cx
          y += cy
        }
        const c1: number[] = prevCtrl && 'QT'.includes(prevCmd) ? [2 * cx - prevCtrl[0], 2 * cy - prevCtrl[1]] : [cx, cy]
        quad([cx, cy], c1, [x, y], pts)
        prevCtrl = c1
        cx = x
        cy = y
        break
      }
      case 'A': {
        const rx = num(),
          ry = num(),
          rot = num(),
          large = num(),
          sweep = num()
        let x = num(),
          y = num()
        if (rel) {
          x += cx
          y += cy
        }
        arc(cx, cy, rx, ry, rot, large, sweep, x, y, pts)
        cx = x
        cy = y
        break
      }
      case 'Z': {
        pts.push([startX, startY])
        cx = startX
        cy = startY
        flush(true)
        break
      }
      default:
        i++ // unknown token — skip defensively
    }
    prevCmd = C
    if (C !== 'C' && C !== 'S' && C !== 'Q' && C !== 'T') prevCtrl = null
  }
  if (pts.length) flush(false)
  return subs
}

function num(el: Element, attr: string, dflt = 0): number {
  const v = parseFloat(el.getAttribute(attr) ?? '')
  return Number.isFinite(v) ? v : dflt
}
function pointsAttr(el: Element): number[][] {
  const nums = (el.getAttribute('points') ?? '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) ?? []
  const out: number[][] = []
  for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]])
  return out
}

function parseSvg(text: string): { paths: ImportedPath[]; warnings: string[] } {
  const warnings: string[] = []
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  if (doc.querySelector('parsererror')) throw new Error('Invalid SVG file.')
  const raw: ImportedPath[] = []
  const push = (el: Element, pts: number[][], closed: boolean) => {
    if (pts.length < 2) return
    const m = elementMatrix(el)
    raw.push({ points: pts.map(([x, y]) => apply(m, x, y)), closed })
  }
  doc.querySelectorAll('path').forEach((el) => {
    for (const s of parsePathD(el.getAttribute('d') ?? '')) push(el, s.pts, s.closed)
  })
  doc.querySelectorAll('line').forEach((el) =>
    push(el, [[num(el, 'x1'), num(el, 'y1')], [num(el, 'x2'), num(el, 'y2')]], false),
  )
  doc.querySelectorAll('polyline').forEach((el) => push(el, pointsAttr(el), false))
  doc.querySelectorAll('polygon').forEach((el) => push(el, pointsAttr(el), true))
  doc.querySelectorAll('rect').forEach((el) => {
    const x = num(el, 'x'),
      y = num(el, 'y'),
      w = num(el, 'width'),
      h = num(el, 'height')
    if (w > 0 && h > 0) push(el, [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], true)
  })
  const ellipse = (el: Element, rx: number, ry: number, cx: number, cy: number) => {
    if (rx <= 0 || ry <= 0) return
    const pts: number[][] = []
    const steps = Math.max(24, CURVE_STEPS)
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2
      pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry])
    }
    push(el, pts, true)
  }
  doc.querySelectorAll('circle').forEach((el) => ellipse(el, num(el, 'r'), num(el, 'r'), num(el, 'cx'), num(el, 'cy')))
  doc.querySelectorAll('ellipse').forEach((el) => ellipse(el, num(el, 'rx'), num(el, 'ry'), num(el, 'cx'), num(el, 'cy')))

  if (raw.length === 0) return { paths: [], warnings }
  // Flip Y (SVG is Y-down) about the content bounds so the design is upright + positive.
  let minY = Infinity,
    maxY = -Infinity
  for (const p of raw) for (const pt of p.points) {
    if (pt.y < minY) minY = pt.y
    if (pt.y > maxY) maxY = pt.y
  }
  const sum = minY + maxY
  const paths = raw.map((p) => ({ closed: p.closed, points: p.points.map((pt) => ({ x: pt.x, y: sum - pt.y })) }))
  return { paths, warnings }
}
