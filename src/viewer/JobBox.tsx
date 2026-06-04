import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useCameraCalib, useSettings } from '../store'

/**
 * The detected job footprint, drawn as a box sitting on the bed.
 *
 * Reads `useCameraCalib` (`jobRect` in bed-mm, `jobHeightMm`). When the camera
 * overlay is enabled and a job footprint has been detected (silhouette/visual
 * hull or operator entry), this renders a translucent box spanning the rect from
 * z=0 up to the job height, with a bright wireframe outline so it reads as a
 * physical object on the bed — same WORK frame as the bed grid and toolpaths
 * (work zero centred, Z-up, mm). Mirrors `StockBlock`'s fill+edge presentation.
 *
 * No business logic — purely a display of the detected job extents.
 */
export function JobBox() {
  const theme = useSettings((s) => s.theme)

  const enabled = useCameraCalib((s) => s.enabled)
  const jobRect = useCameraCalib((s) => s.jobRect)
  const jobHeightMm = useCameraCalib((s) => s.jobHeightMm)

  const geom = useMemo(() => {
    if (!jobRect) return null
    const sx = jobRect.maxX - jobRect.minX
    const sy = jobRect.maxY - jobRect.minY
    // A flat plane defaults to 1mm tall so the box is still visible.
    const sz = jobHeightMm && jobHeightMm > 0 ? jobHeightMm : 1
    // Degenerate footprint (zero/negative extent) is not worth drawing.
    if (!(sx > 1e-6) || !(sy > 1e-6)) return null
    const cx = (jobRect.minX + jobRect.maxX) / 2
    const cy = (jobRect.minY + jobRect.maxY) / 2
    const cz = sz / 2 // box sits on the bed: base at z=0, top at z=sz
    const box = new THREE.BoxGeometry(sx, sy, sz)
    const edges = new THREE.EdgesGeometry(box)
    return { box, edges, center: [cx, cy, cz] as [number, number, number] }
  }, [jobRect, jobHeightMm])

  // Dispose geometries when they change / on unmount.
  useEffect(() => {
    return () => {
      geom?.box.dispose()
      geom?.edges.dispose()
    }
  }, [geom])

  if (!enabled || !geom) return null

  // Accent-ish fill with a bright wire, mirroring StockBlock's dark/light split.
  const fill = theme === 'dark' ? '#38bdf8' : '#0284c7'
  const edge = theme === 'dark' ? '#bae6fd' : '#0369a1'

  return (
    <group position={geom.center}>
      <mesh geometry={geom.box}>
        <meshStandardMaterial
          color={fill}
          transparent
          opacity={0.25}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={geom.edges}>
        <lineBasicMaterial color={edge} transparent opacity={0.9} />
      </lineSegments>
    </group>
  )
}
