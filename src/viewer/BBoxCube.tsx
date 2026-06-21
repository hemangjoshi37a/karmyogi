import { useMemo } from 'react'
import * as THREE from 'three'

/**
 * A translucent-fill + bright-edge wireframe box hugging an axis-aligned bounding
 * box (min → max, all three axes). Reused by the 3D Visualizer to draw ONE cube
 * per carve job, tightly around that job's PLACED mesh bbox (its true position /
 * size on the bed) — NOT the combined G-code extent, which would span the work
 * origin → the model. Matches the existing JobBox/StockBlock presentation: a
 * faint volume fill plus crisp edges, theme-aware.
 *
 * Degenerate (zero-volume in XY) boxes are skipped to avoid z-fighting noise.
 */
export interface BBoxCubeProps {
  min: [number, number, number]
  max: [number, number, number]
  dark: boolean
  /** Highlight (e.g. the selected job) — brighter edges + a touch more fill. */
  active?: boolean
}

export function BBoxCube({ min, max, dark, active = false }: BBoxCubeProps) {
  const { size, center, edges, valid } = useMemo(() => {
    const [x0, y0, z0] = min
    const [x1, y1, z1] = max
    const ok = x1 - x0 > 1e-6 || y1 - y0 > 1e-6
    // Give a perfectly flat part a sliver of height so its box is still visible.
    const sx = Math.max(x1 - x0, 0.01)
    const sy = Math.max(y1 - y0, 0.01)
    const sz = Math.max(z1 - z0, 0.5)
    const geo = new THREE.BoxGeometry(sx, sy, sz)
    const eg = new THREE.EdgesGeometry(geo)
    geo.dispose()
    return {
      size: [sx, sy, sz] as [number, number, number],
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] as [number, number, number],
      edges: eg,
      valid: ok,
    }
  }, [min, max])

  if (!valid) return null
  const edgeColor = active ? (dark ? '#f59e0b' : '#b45309') : dark ? '#5eead4' : '#0e7c66'
  const fillColor = active ? (dark ? '#f59e0b' : '#b45309') : dark ? '#5eead4' : '#0e7c66'

  return (
    <group position={center}>
      {/* Translucent volume fill. */}
      <mesh>
        <boxGeometry args={size} />
        <meshBasicMaterial
          color={fillColor}
          transparent
          opacity={active ? 0.1 : 0.05}
          depthWrite={false}
        />
      </mesh>
      {/* Bright edges (box outline, no diagonals). */}
      <lineSegments geometry={edges}>
        <lineBasicMaterial color={edgeColor} transparent opacity={active ? 0.95 : 0.7} />
      </lineSegments>
    </group>
  )
}
