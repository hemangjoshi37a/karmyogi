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
  /**
   * Simulation reveal: index of the segment currently being executed. When
   * provided (>= 0), segments before it render as "traveled" (bright), the
   * active segment is split at `revealPoint`, and later segments render as
   * "upcoming" (dim). Omit (or pass < 0) for the static, full-path look.
   */
  revealIndex?: number
  /** Point on the active segment the tool has reached, for the split. */
  revealPoint?: [number, number, number] | null
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
 * When `revealIndex` is provided it splits the path into traveled / active /
 * upcoming portions for the playback simulation (bright = already run, dim =
 * still to come); otherwise it renders the full path uniformly as before.
 *
 * Contains no business logic — it only turns already-parsed geometry into a
 * scene. Theme colours come from the settings store.
 */
export function Toolpath({
  segments,
  cutColor,
  rapidColor,
  revealIndex,
  revealPoint,
}: ToolpathProps) {
  const theme = useSettings((s) => s.theme)

  const cut = cutColor ?? (theme === 'dark' ? '#38bdf8' : '#0369a1')
  const rapid = rapidColor ?? (theme === 'dark' ? '#6b7280' : '#94a3b8')

  const revealing = revealIndex !== undefined && revealIndex >= 0

  // Split each segment list into "done" (traveled) and "todo" (upcoming) parts.
  // The active segment is split at `revealPoint` so the line grows smoothly.
  const split = useMemo(() => {
    if (!revealing) return null
    const ri = Math.min(revealIndex, segments.length - 1)
    const rp = revealPoint
    const done: Segment[] = []
    const todo: Segment[] = []
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]
      if (i < ri) {
        done.push(s)
      } else if (i > ri) {
        todo.push(s)
      } else {
        // Active segment: split at the reveal point (fall back to whole-done).
        if (rp) {
          done.push({ from: s.from, to: [rp[0], rp[1], rp[2]], kind: s.kind })
          todo.push({ from: [rp[0], rp[1], rp[2]], to: s.to, kind: s.kind })
        } else {
          done.push(s)
        }
      }
    }
    return { done, todo }
  }, [revealing, revealIndex, revealPoint, segments])

  // --- Static path geometries (used when not revealing). -------------------
  const cutGeom = useMemo(
    () => (revealing ? null : buildGeometry(segments, 'cut')),
    [revealing, segments],
  )
  const rapidGeom = useMemo(
    () => (revealing ? null : buildGeometry(segments, 'rapid')),
    [revealing, segments],
  )

  // --- Reveal geometries (used when revealing). ----------------------------
  const doneCutGeom = useMemo(
    () => (split ? buildGeometry(split.done, 'cut') : null),
    [split],
  )
  const doneRapidGeom = useMemo(
    () => (split ? buildGeometry(split.done, 'rapid') : null),
    [split],
  )
  const todoCutGeom = useMemo(
    () => (split ? buildGeometry(split.todo, 'cut') : null),
    [split],
  )
  const todoRapidGeom = useMemo(
    () => (split ? buildGeometry(split.todo, 'rapid') : null),
    [split],
  )

  // Dispose old geometries when they change / on unmount.
  useMemo(() => {
    return () => {
      cutGeom?.dispose()
      rapidGeom?.dispose()
      doneCutGeom?.dispose()
      doneRapidGeom?.dispose()
      todoCutGeom?.dispose()
      todoRapidGeom?.dispose()
    }
  }, [cutGeom, rapidGeom, doneCutGeom, doneRapidGeom, todoCutGeom, todoRapidGeom])

  if (revealing) {
    return (
      <group>
        {/* Upcoming (dim) drawn first so traveled lines sit visually on top. */}
        {todoCutGeom && (
          <lineSegments geometry={todoCutGeom}>
            <lineBasicMaterial color={cut} transparent opacity={0.22} />
          </lineSegments>
        )}
        {todoRapidGeom && (
          <RapidLines geometry={todoRapidGeom} color={rapid} opacity={0.18} />
        )}
        {/* Traveled (bright). */}
        {doneCutGeom && (
          <lineSegments geometry={doneCutGeom}>
            <lineBasicMaterial color={cut} />
          </lineSegments>
        )}
        {doneRapidGeom && (
          <RapidLines geometry={doneRapidGeom} color={rapid} opacity={0.85} />
        )}
      </group>
    )
  }

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
function RapidLines({
  geometry,
  color,
  opacity = 0.85,
}: {
  geometry: THREE.BufferGeometry
  color: string
  opacity?: number
}) {
  const lines = useMemo(() => {
    const mat = new THREE.LineDashedMaterial({
      color: new THREE.Color(color),
      dashSize: 3,
      gapSize: 2,
      transparent: true,
      opacity,
    })
    const obj = new THREE.LineSegments(geometry, mat)
    obj.computeLineDistances()
    return obj
  }, [geometry, color, opacity])

  useMemo(() => {
    return () => {
      ;(lines.material as THREE.Material).dispose()
    }
  }, [lines])

  return <primitive object={lines} />
}
