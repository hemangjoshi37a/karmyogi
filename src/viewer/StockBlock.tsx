import { useMemo } from 'react'
import * as THREE from 'three'
import { useStock } from '../store/stock'
import { stockBounds } from '../core/stock'
import { useSettings } from '../store'

interface StockBlockProps {
  /** Visible? Hide to declutter the scene. Default true. */
  visible?: boolean
}

/**
 * The raw workpiece block, drawn from the stock store as a translucent box with
 * a brighter edge outline so the toolpath reads clearly against (and inside) it.
 *
 * Reads `useStock` (dims + origin/Z reference) and `stockBounds()` to compute the
 * box extents in WORK coordinates (work zero at origin, Z-up — same frame as the
 * bed grid and toolpath). Theme-aware colours mirror Bed/ToolMarker. No business
 * logic — purely a display of the configured stock.
 */
export function StockBlock({ visible = true }: StockBlockProps) {
  const theme = useSettings((s) => s.theme)

  const width = useStock((s) => s.width)
  const depth = useStock((s) => s.depth)
  const height = useStock((s) => s.height)
  const xyOrigin = useStock((s) => s.xyOrigin)
  const zRef = useStock((s) => s.zRef)

  const geom = useMemo(() => {
    const { min, max } = stockBounds({
      dims: { width, depth, height },
      xyOrigin,
      zRef,
    })
    const sx = max[0] - min[0]
    const sy = max[1] - min[1]
    const sz = max[2] - min[2]
    // Degenerate stock (any zero extent) is not worth drawing.
    if (!(sx > 1e-6) || !(sy > 1e-6) || !(sz > 1e-6)) return null
    const cx = (min[0] + max[0]) / 2
    const cy = (min[1] + max[1]) / 2
    const cz = (min[2] + max[2]) / 2
    const box = new THREE.BoxGeometry(sx, sy, sz)
    const edges = new THREE.EdgesGeometry(box)
    return { box, edges, center: [cx, cy, cz] as [number, number, number] }
  }, [width, depth, height, xyOrigin, zRef])

  // Dispose geometries when they change / on unmount.
  useMemo(() => {
    return () => {
      geom?.box.dispose()
      geom?.edges.dispose()
    }
  }, [geom])

  if (!visible || !geom) return null

  // Theme-aware: a faint fill plus a brighter wire, both restrained so the
  // toolpath stays the focus. Mirrors Bed.tsx's dark/light split.
  const fill = theme === 'dark' ? '#8aa0b8' : '#6b7c92'
  const edge = theme === 'dark' ? '#cbd5e1' : '#475569'

  return (
    <group position={geom.center}>
      <mesh geometry={geom.box}>
        <meshStandardMaterial
          color={fill}
          transparent
          opacity={0.12}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={geom.edges}>
        <lineBasicMaterial color={edge} transparent opacity={0.55} />
      </lineSegments>
    </group>
  )
}
