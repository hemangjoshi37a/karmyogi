import { useMemo } from 'react'
import { Line, Text, Billboard } from '@react-three/drei'
import * as THREE from 'three'
import type { Bounds } from './gcodeToPolylines'

/**
 * Engineering-drawing-style 3D dimension annotations for the loaded program's
 * bounding box.
 *
 * For each measured axis (overall X width, Y depth, Z height) we draw, civil /
 * mechanical-drawing fashion:
 *   - two short EXTENSION lines projecting outward from the box at each end,
 *   - one DIMENSION line running between them, parallel to the measured axis,
 *   - an ARROWHEAD at both ends of the dimension line pointing OUTWARD, and
 *   - the measurement NUMBER (mm) billboarded at the midpoint so it always
 *     faces the camera and stays legible.
 *
 * The X and Y dimensions are laid out on the bed plane (Z at the box bottom),
 * offset outward past the box edges; the Z dimension runs vertically off one
 * front corner. Pure presentation — no business logic.
 */

export interface DimensionsProps {
  bounds: Bounds
  dark: boolean
}

/** Format a length in mm with at most 1 decimal, trimming trailing zeros. */
function fmt(v: number): string {
  return `${(Math.round(v * 10) / 10).toString()} mm`
}

export function Dimensions({ bounds, dark }: DimensionsProps) {
  const data = useMemo(() => buildDimensions(bounds), [bounds])
  if (!data) return null

  const lineColor = dark ? '#9fb3c8' : '#475569'
  const textColor = dark ? '#e2e8f0' : '#1e293b'
  const textOutline = dark ? '#15181c' : '#e7ecf1'

  return (
    <group>
      {data.map((d) => (
        <group key={d.key}>
          {/* Extension lines (box edge → dimension line). */}
          {d.extensions.map((seg, i) => (
            <Line
              key={`${d.key}-ext-${i}`}
              points={seg}
              color={lineColor}
              lineWidth={1}
              transparent
              opacity={0.7}
              depthTest={false}
            />
          ))}
          {/* Dimension line. */}
          <Line
            points={d.dimLine}
            color={lineColor}
            lineWidth={1.5}
            depthTest={false}
          />
          {/* Outward-pointing arrowheads at both ends. */}
          {d.arrows.map((tri, i) => (
            <Line
              key={`${d.key}-arr-${i}`}
              points={tri}
              color={lineColor}
              lineWidth={1.5}
              depthTest={false}
            />
          ))}
          {/* Measurement number, billboarded so it always faces the camera. */}
          <Billboard position={d.labelPos}>
            <Text
              fontSize={d.fontSize}
              color={textColor}
              anchorX="center"
              anchorY="middle"
              outlineWidth={d.fontSize * 0.08}
              outlineColor={textOutline}
              depthOffset={-4}
            >
              {fmt(d.value)}
            </Text>
          </Billboard>
        </group>
      ))}
    </group>
  )
}

type V3 = [number, number, number]

interface DimSpec {
  key: string
  value: number
  /** Extension-line segment endpoint pairs. */
  extensions: V3[][]
  /** The dimension line endpoints. */
  dimLine: V3[]
  /** Arrowhead polylines (each a small 3-point chevron). */
  arrows: V3[][]
  /** Billboarded label position. */
  labelPos: V3
  fontSize: number
}

/**
 * Compute the X/Y/Z dimension geometry for a bounding box. Returns null for a
 * degenerate (zero-size) box. Offsets and arrowheads scale with the box so the
 * annotations stay proportionate on tiny and huge jobs alike.
 */
function buildDimensions(bounds: Bounds): DimSpec[] | null {
  const [x0, y0, z0] = bounds.min
  const [x1, y1, z1] = bounds.max
  const w = x1 - x0
  const d = y1 - y0
  const h = z1 - z0
  if (!(w > 1e-6) && !(d > 1e-6) && !(h > 1e-6)) return null

  const span = Math.max(w, d, h, 1)
  const off = Math.max(span * 0.08, 4) // how far dimension lines sit off the box
  const ext = off * 0.35 // extension overshoot past the dimension line
  const ah = Math.max(span * 0.025, 1.2) // arrowhead size
  const fontSize = Math.max(span * 0.05, 2.5)
  const labelLift = fontSize * 0.7

  const specs: DimSpec[] = []

  // ---- X width: along +X, placed in front of the box (−Y side), at z0. ------
  if (w > 1e-6) {
    const yd = y0 - off
    specs.push({
      key: 'x',
      value: w,
      extensions: [
        [[x0, y0, z0], [x0, yd - ext, z0]],
        [[x1, y0, z0], [x1, yd - ext, z0]],
      ],
      dimLine: [[x0, yd, z0], [x1, yd, z0]],
      arrows: [
        chevron([x0, yd, z0], [1, 0, 0], [0, 1, 0], ah),
        chevron([x1, yd, z0], [-1, 0, 0], [0, 1, 0], ah),
      ],
      labelPos: [(x0 + x1) / 2, yd - labelLift, z0],
      fontSize,
    })
  }

  // ---- Y depth: along +Y, placed left of the box (−X side), at z0. ----------
  if (d > 1e-6) {
    const xd = x0 - off
    specs.push({
      key: 'y',
      value: d,
      extensions: [
        [[x0, y0, z0], [xd - ext, y0, z0]],
        [[x0, y1, z0], [xd - ext, y1, z0]],
      ],
      dimLine: [[xd, y0, z0], [xd, y1, z0]],
      arrows: [
        chevron([xd, y0, z0], [0, 1, 0], [1, 0, 0], ah),
        chevron([xd, y1, z0], [0, -1, 0], [1, 0, 0], ah),
      ],
      labelPos: [xd - labelLift, (y0 + y1) / 2, z0],
      fontSize,
    })
  }

  // ---- Z height: along +Z, off the front-left vertical edge (x0, y0). -------
  if (h > 1e-6) {
    const xd = x0 - off
    specs.push({
      key: 'z',
      value: h,
      extensions: [
        [[x0, y0, z0], [xd - ext, y0, z0]],
        [[x0, y0, z1], [xd - ext, y0, z1]],
      ],
      dimLine: [[xd, y0, z0], [xd, y0, z1]],
      arrows: [
        chevron([xd, y0, z0], [0, 0, 1], [1, 0, 0], ah),
        chevron([xd, y0, z1], [0, 0, -1], [1, 0, 0], ah),
      ],
      labelPos: [xd - labelLift, y0, (z0 + z1) / 2],
      fontSize,
    })
  }

  return specs
}

/**
 * Build a small arrowhead chevron at `tip`, opening along `dir` (the direction
 * the arrow points, e.g. outward), with the two barbs spread along `side`.
 * Returned as a 3-point polyline (barb → tip → barb).
 */
function chevron(tip: V3, dir: V3, side: V3, size: number): V3[] {
  const t = new THREE.Vector3(tip[0], tip[1], tip[2])
  const dv = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize()
  const sv = new THREE.Vector3(side[0], side[1], side[2]).normalize()
  // Barbs sit back along -dir from the tip, spread ±size along side.
  const back = dv.clone().multiplyScalar(-size * 1.6)
  const half = sv.clone().multiplyScalar(size * 0.7)
  const b1 = t.clone().add(back).add(half)
  const b2 = t.clone().add(back).sub(half)
  return [
    [b1.x, b1.y, b1.z],
    [t.x, t.y, t.z],
    [b2.x, b2.y, b2.z],
  ]
}
