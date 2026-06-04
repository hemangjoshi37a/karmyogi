// Viewport-shape G-code — UI-independent (no React/DOM imports).
//
// Turns the user's viewport-drawn primitives (circle / rectangle / triangle /
// line) into a single safe G-code program by emitting each shape's outline as a
// closed (or open, for a line) polyline at a fixed cut depth. Reuses the CAD/CAM
// `Toolpath` + `GcodeEmitter` so the SAME safety conventions apply: G21/G90/G94/
// G17 header, a guaranteed safe-Z retract before any XY travel and at program
// end, modal axis/feed words, and no "-0.000".

import { Toolpath, vec3 } from './toolpath'
import { GcodeEmitter } from './gcodeEmitter'

/** Minimal shape description this module needs (mirrors the store's shape). */
export interface ShapeSpec {
  kind: 'circle' | 'rectangle' | 'triangle' | 'line'
  /** Center on the bed plane (mm). */
  x: number
  y: number
  /** Defining size (mm): circle radius / rect+triangle half-extent / line half-length. */
  size: number
  /** Z-rotation (radians). */
  rot: number
}

export interface ShapeGcodeOptions {
  /** Cut depth (mm, negative = into stock). Default -1. */
  cutZ?: number
  /** Safe-Z retract height (mm). Default 5. */
  safeZ?: number
  /** XY cutting feed (mm/min). Default 600. */
  feedXY?: number
  /** Plunge feed (mm/min). Default 200. */
  feedZ?: number
  /** Segments used to approximate a circle. Default 64. */
  circleSegments?: number
}

/** A unit (size = 1, centered at origin, unrotated) outline for each kind. */
function unitOutline(
  kind: ShapeSpec['kind'],
  circleSegments: number,
): { pts: [number, number][]; closed: boolean } {
  switch (kind) {
    case 'rectangle': {
      // Half-extent square footprint (size = half-width).
      return {
        pts: [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ],
        closed: true,
      }
    }
    case 'triangle': {
      // Equilateral-ish triangle inscribed in radius=1, apex up (+Y).
      const pts: [number, number][] = []
      for (let i = 0; i < 3; i++) {
        const a = Math.PI / 2 + (i * 2 * Math.PI) / 3
        pts.push([Math.cos(a), Math.sin(a)])
      }
      return { pts, closed: true }
    }
    case 'line': {
      // Horizontal segment from -1 to +1 along X (size = half-length).
      return { pts: [[-1, 0], [1, 0]], closed: false }
    }
    case 'circle':
    default: {
      const n = Math.max(8, Math.floor(circleSegments))
      const pts: [number, number][] = []
      for (let i = 0; i < n; i++) {
        const a = (i / n) * 2 * Math.PI
        pts.push([Math.cos(a), Math.sin(a)])
      }
      return { pts, closed: true }
    }
  }
}

/** Place a unit outline into world space: scale by size, rotate by rot, offset to (x,y). */
function placedOutline(shape: ShapeSpec, circleSegments: number): {
  pts: [number, number][]
  closed: boolean
} {
  const { pts, closed } = unitOutline(shape.kind, circleSegments)
  const c = Math.cos(shape.rot)
  const s = Math.sin(shape.rot)
  const out: [number, number][] = pts.map(([ux, uy]) => {
    const px = ux * shape.size
    const py = uy * shape.size
    return [shape.x + (px * c - py * s), shape.y + (px * s + py * c)]
  })
  return { pts: out, closed }
}

/** Build one Toolpath for a single shape outline at `cutZ`, retracting to `safeZ`. */
function shapeToolpath(
  shape: ShapeSpec,
  cutZ: number,
  safeZ: number,
  circleSegments: number,
): Toolpath {
  const tp = new Toolpath()
  tp.name = shape.kind
  const { pts, closed } = placedOutline(shape, circleSegments)
  if (pts.length < 2) return tp

  const [sx, sy] = pts[0]
  // Rapid to the start above the work, plunge, cut the outline, retract.
  tp.rapid(vec3(sx, sy, safeZ))
  tp.plunge(vec3(sx, sy, cutZ))
  for (let i = 1; i < pts.length; i++) {
    tp.feed(vec3(pts[i][0], pts[i][1], cutZ))
  }
  if (closed) tp.feed(vec3(sx, sy, cutZ))
  tp.rapid(vec3(pts[pts.length - 1][0], pts[pts.length - 1][1], safeZ))
  return tp
}

/**
 * Generate one safe G-code program for all viewport shapes. Returns '' when the
 * list is empty so callers can clear their program section cleanly.
 */
export function shapesToGcode(
  shapes: ShapeSpec[],
  options: ShapeGcodeOptions = {},
): string {
  if (!shapes || shapes.length === 0) return ''
  const cutZ = options.cutZ ?? -1
  const safeZ = options.safeZ ?? 5
  const circleSegments = options.circleSegments ?? 64

  const paths = shapes
    .map((sh) => shapeToolpath(sh, cutZ, safeZ, circleSegments))
    .filter((tp) => !tp.isEmpty())
  if (paths.length === 0) return ''

  const emitter = new GcodeEmitter({
    programName: 'Viewport shapes',
    safeZ,
    feedXY: options.feedXY ?? 600,
    feedZ: options.feedZ ?? 200,
    comments: true,
  })
  return emitter.emitProgram(paths)
}
