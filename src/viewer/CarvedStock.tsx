import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStock } from '../store/stock'
import { stockBounds } from '../core/stock'
import {
  getMaterial,
  DEFAULT_MATERIAL_ID,
  type MaterialCategory,
} from '../core/materials'
import {
  createRemovalHeightmap,
  sweepRemoval,
  type RemovalHeightmap,
  type SimSegmentLike,
} from '../core/simulation'
import { useSettings } from '../store'
import type { Segment } from './gcodeToPolylines'

interface CarvedStockProps {
  /** Parsed/sim segments (same {from,to,kind} the toolpath uses). */
  segments: Segment[]
  /** Index of the active segment (segments before it are fully done). */
  revealIndex: number
  /** Reveal point on the active segment (partial sweep), or null. */
  revealPoint?: [number, number, number] | null
  /** Cutter radius (mm) used to thicken each swept move. */
  toolRadius: number
  /** Visible? Default true. */
  visible?: boolean
}

/**
 * Material-removal simulation surface. The stock is a heightmap mesh that starts
 * flat at the stock top and is progressively carved down by the CUT moves up to
 * the playback reveal point — so the already-machined region shows its cut
 * surface while the rest stays raw stock. Sits inside the translucent
 * {@link StockBlock} wireframe.
 *
 * Performance: the grid + geometry are kept in refs and updated INCREMENTALLY —
 * forward playback only sweeps newly-completed segments (O(total segments) over a
 * whole run, not O(segments²)); a full rebuild happens only when the program,
 * stock, or tool changes, or when the user scrubs backward. The math is pure
 * (core/simulation); this component just maps the grid to a three.js surface.
 */
export function CarvedStock({
  segments,
  revealIndex,
  revealPoint,
  toolRadius,
  visible = true,
}: CarvedStockProps) {
  const theme = useSettings((s) => s.theme)
  const width = useStock((s) => s.width)
  const depth = useStock((s) => s.depth)
  const height = useStock((s) => s.height)
  const xyOrigin = useStock((s) => s.xyOrigin)
  const zRef = useStock((s) => s.zRef)
  const materialId = useStock((s) => s.materialId)

  // Stock box in work coordinates (Z-up). The top face is the carve start height.
  const box = useMemo(() => {
    const { min, max } = stockBounds({ dims: { width, depth, height }, xyOrigin, zRef })
    const ok = max[0] - min[0] > 1e-6 && max[1] - min[1] > 1e-6 && max[2] - min[2] > 1e-6
    return ok ? { min, max } : null
  }, [width, depth, height, xyOrigin, zRef])

  // Geometry + grid persist across reveal updates; we only rewrite Z in place.
  const geomRef = useRef<THREE.BufferGeometry | null>(null)
  const hmRef = useRef<RemovalHeightmap | null>(null)
  // How many segments have already been swept into the current grid.
  const appliedRef = useRef(0)
  // Last partial reveal point we meshed (to throttle sub-cell updates).
  const lastRpRef = useRef<[number, number, number] | null>(null)

  // (Re)build the flat heightmap + plane geometry when the program/stock/tool
  // changes. The grid starts uncut (flat at the stock top).
  const geom = useMemo(() => {
    if (!visible || !box || segments.length === 0) return null
    const hm = createRemovalHeightmap({
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      topZ: box.max[2],
      floorZ: box.min[2],
      toolRadius,
    })
    hmRef.current = hm
    appliedRef.current = 0
    lastRpRef.current = null

    const { nx, ny, x0, y0, dx, dy, z } = hm
    const positions = new Float32Array(nx * ny * 3)
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix
        positions[i * 3] = x0 + ix * dx
        positions[i * 3 + 1] = y0 + iy * dy
        positions[i * 3 + 2] = z[i]
      }
    }
    const indices: number[] = []
    for (let iy = 0; iy < ny - 1; iy++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iy * nx + ix
        const b = a + 1
        const c = a + nx
        const d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    geomRef.current = g
    return g
  }, [visible, box, toolRadius, segments])

  // Apply the carve up to the current reveal. Forward progress sweeps only the
  // newly-finished segments; a backward scrub rebuilds the grid from scratch.
  useEffect(() => {
    const hm = hmRef.current
    const g = geomRef.current
    if (!hm || !g) return

    // Throttle remeshing: skip when neither a new segment completed nor the
    // partial reveal point moved at least ~half a cell (avoids 60fps remesh on
    // sub-pixel tool advance). Always run on a backward scrub.
    const idxChanged = revealIndex !== appliedRef.current
    const movedEnough =
      !lastRpRef.current ||
      !revealPoint ||
      Math.hypot(
        revealPoint[0] - lastRpRef.current[0],
        revealPoint[1] - lastRpRef.current[1],
      ) >=
        Math.min(hm.dx, hm.dy) * 0.5
    if (revealIndex >= appliedRef.current && !idxChanged && !movedEnough) return

    // Backward scrub (or a fresh build) → reset the grid to flat, re-apply 0..idx.
    if (revealIndex < appliedRef.current) {
      hm.z.fill(hm.topZ)
      appliedRef.current = 0
    }

    sweepRemoval(
      hm,
      segments as SimSegmentLike[],
      appliedRef.current,
      revealIndex,
      toolRadius,
      revealPoint ?? null,
    )
    appliedRef.current = revealIndex
    lastRpRef.current = revealPoint ?? null

    // Rewrite only the Z component of each vertex from the (possibly updated) grid.
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const z = hm.z
    for (let i = 0; i < z.length; i++) arr[i * 3 + 2] = z[i]
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }, [revealIndex, revealPoint, segments, toolRadius, geom])

  // Dispose the geometry when it is replaced / on unmount.
  useEffect(() => {
    return () => {
      geom?.dispose()
    }
  }, [geom])

  if (!geom || !box) return null

  const mat = getMaterial(materialId) ?? getMaterial(DEFAULT_MATERIAL_ID)!
  const color = materialColor(mat.category, theme === 'dark')

  return (
    <mesh geometry={geom}>
      <meshStandardMaterial
        color={color}
        roughness={0.85}
        metalness={0.05}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

/** Plausible solid-surface colour per material family (dark/light tuned). */
function materialColor(category: MaterialCategory, dark: boolean): string {
  switch (category) {
    case 'wood':
      return dark ? '#b5894f' : '#c89b6a'
    case 'plastic':
      return dark ? '#5b8fb0' : '#7fb3d0'
    case 'pcb':
      return dark ? '#2f8f5b' : '#3aa86c'
    case 'metal':
      return dark ? '#9aa3ad' : '#b3bcc6'
    case 'foam':
      return dark ? '#c8b06a' : '#ddc888'
    default:
      return dark ? '#9a8c78' : '#b6a890'
  }
}
