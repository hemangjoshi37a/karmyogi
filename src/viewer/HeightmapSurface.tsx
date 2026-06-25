import { useMemo } from 'react'
import * as THREE from 'three'
import type { HeightMap } from '../core/heightmap'
import { zExtent } from '../core/heightmap'

/**
 * V9 — Heightmap overlay.
 *
 * Renders a PROBED surface (the PCB / stock auto-leveling grid from
 * `useHeightmap`) as a colored mesh laid over the bed, so the operator can SEE
 * the measured Z relief that the warp will compensate for. Low points read cool
 * (blue), high points warm (red), midline green — a familiar terrain ramp.
 *
 * Performance: the mesh is built ONCE per heightmap (useMemo on the map ref) as a
 * single indexed `BufferGeometry` with baked vertex colors — there is no
 * per-frame work, no per-cell mesh, and the grid is naturally tiny (a probe grid
 * is rarely more than ~15×15 points). It therefore costs one draw call and never
 * touches the render loop, so it cannot regress FPS even on weak devices.
 *
 * Pure presentation: it only reads the immutable HeightMap passed in; all probing
 * logic lives in the (read-only) heightmap core + store.
 */
export function HeightmapSurface({
  map,
  opacity = 0.66,
  visible = true,
}: {
  map: HeightMap | null
  /** Surface opacity (0..1). Default 0.66 so the toolpath stays readable through it. */
  opacity?: number
  visible?: boolean
}) {
  const built = useMemo(() => {
    if (!map || map.nx < 2 || map.ny < 2) return null
    const { nx, ny, points } = map
    // Every grid point needs a measured Z; bail if any are still un-probed (we
    // never want to draw a half-measured surface that misrepresents the relief).
    for (const p of points) {
      if (p.z === undefined || !Number.isFinite(p.z)) return null
    }
    const ext = zExtent(map)
    const span = ext.max - ext.min
    const inv = span > 1e-9 ? 1 / span : 0

    const count = nx * ny
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const color = new THREE.Color()

    for (let i = 0; i < count; i++) {
      const p = points[i]
      const z = p.z as number
      positions[i * 3] = p.x
      positions[i * 3 + 1] = p.y
      // Lift the surface a hair so it sits just above the bed plane / origin.
      positions[i * 3 + 2] = z + 0.01
      // Terrain ramp: low → blue (h≈0.66), mid → green (0.33), high → red (0).
      const tnorm = (z - ext.min) * inv // 0 low … 1 high
      const hue = (1 - tnorm) * 0.66
      color.setHSL(hue, 0.85, 0.5)
      colors[i * 3] = color.r
      colors[i * 3 + 1] = color.g
      colors[i * 3 + 2] = color.b
    }

    // Two triangles per cell, row-major (iy*nx + ix).
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

    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    geom.setIndex(indices)
    geom.computeVertexNormals()
    return geom
  }, [map])

  if (!visible || !built) return null

  return (
    <mesh geometry={built}>
      <meshStandardMaterial
        vertexColors
        transparent
        opacity={opacity}
        roughness={0.85}
        metalness={0.0}
        side={THREE.DoubleSide}
        flatShading={false}
        depthWrite={false}
      />
    </mesh>
  )
}
