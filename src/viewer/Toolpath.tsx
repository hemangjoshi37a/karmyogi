import { useMemo } from 'react'
import * as THREE from 'three'
import type { Segment } from './gcodeToPolylines'
import { useSettings } from '../store'

interface ToolpathProps {
  /** Parsed segments (from gcodeToPolylines). */
  segments: Segment[]
  /** Override cut colour (defaults to a theme accent). */
  cutColor?: string
  /** Override rapid colour (defaults to a theme-muted tone). */
  rapidColor?: string
}

/** Build a non-indexed LineSegments geometry from segments of one kind. */
function buildGeometry(segments: Segment[], kind: Segment['kind']): THREE.BufferGeometry | null {
  const pts: number[] = []
  for (const s of segments) {
    if (s.kind !== kind) continue
    pts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
  }
  if (pts.length === 0) return null
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  return geom
}

/**
 * Renders parsed G-code segments as coloured three.js line segments.
 * Cuts (G1/G2/G3) use the accent colour as solid lines; rapids (G0) use a
 * muted dashed line so travel moves read as secondary.
 *
 * Contains no business logic — it only turns already-parsed geometry into a
 * scene. Theme colours come from the settings store.
 */
export function Toolpath({ segments, cutColor, rapidColor }: ToolpathProps) {
  const theme = useSettings((s) => s.theme)

  const cut = cutColor ?? (theme === 'dark' ? '#38bdf8' : '#0369a1')
  const rapid = rapidColor ?? (theme === 'dark' ? '#6b7280' : '#94a3b8')

  const cutGeom = useMemo(() => buildGeometry(segments, 'cut'), [segments])
  const rapidGeom = useMemo(() => buildGeometry(segments, 'rapid'), [segments])

  // Dispose old geometries when they change / on unmount.
  useMemo(() => {
    return () => {
      cutGeom?.dispose()
      rapidGeom?.dispose()
    }
  }, [cutGeom, rapidGeom])

  return (
    <group>
      {cutGeom && (
        <lineSegments geometry={cutGeom}>
          <lineBasicMaterial color={cut} />
        </lineSegments>
      )}
      {rapidGeom && (
        <RapidLines geometry={rapidGeom} color={rapid} />
      )}
    </group>
  )
}

/** Dashed rapid lines — dashes require computed line distances. */
function RapidLines({ geometry, color }: { geometry: THREE.BufferGeometry; color: string }) {
  const lines = useMemo(() => {
    const mat = new THREE.LineDashedMaterial({
      color: new THREE.Color(color),
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity: 0.85,
    })
    const obj = new THREE.LineSegments(geometry, mat)
    obj.computeLineDistances()
    return obj
  }, [geometry, color])

  useMemo(() => {
    return () => {
      ;(lines.material as THREE.Material).dispose()
    }
  }, [lines])

  return <primitive object={lines} />
}
