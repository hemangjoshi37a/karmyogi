import { useMemo } from 'react'

/**
 * O6 — Run-outline / bounds preview.
 *
 * Draws the loaded program's XY bounding RECTANGLE flat on the bed (at z=0) so
 * the operator sees the job's footprint — and whether it fits the stock/bed —
 * BEFORE running. This is the static "where will it cut" preview that pairs with
 * the machine's framing/dry-run move (it traces the same rectangle in real life).
 *
 * The outline is colour-coded by bed-fit so it doubles as a go/no-go cue:
 *   - ok      → accent (green-ish): the footprint sits inside the work area.
 *   - warn    → amber: pokes past the centred bed rectangle (off-bed).
 *   - danger  → red: larger than the whole bed (W×D) — cannot fit at all.
 *
 * Pure presentational: it takes already-computed program bounds (the panel
 * derives them once from the same segments the viewer draws) and the fit verdict,
 * so it never re-parses G-code. Z-up world (bed = XY plane).
 */
export interface RunOutlineBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export function RunOutline({
  bounds,
  fit = 'ok',
  dark,
}: {
  bounds: RunOutlineBounds | null
  /** Bed-fit verdict from the panel (drives the outline colour). */
  fit?: 'ok' | 'warn' | 'danger'
  dark: boolean
}) {
  const { positions, corners, valid } = useMemo(() => {
    if (!bounds) return { positions: null, corners: null, valid: false }
    const [x0, y0] = bounds.min
    const [x1, y1] = bounds.max
    const w = x1 - x0
    const d = y1 - y0
    // Need a real XY footprint to be worth drawing.
    if (!(w > 1e-6) || !(d > 1e-6)) return { positions: null, corners: null, valid: false }
    // Rectangle on the bed plane (z=0) as 4 edge segments (24 floats), matching
    // the lineSegments idiom used elsewhere in the viewer.
    const z = 0
    const c: [number, number, number][] = [
      [x0, y0, z],
      [x1, y0, z],
      [x1, y1, z],
      [x0, y1, z],
    ]
    const edges: [number, number][] = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
    ]
    const pts: number[] = []
    for (const [a, b] of edges) pts.push(...c[a], ...c[b])
    return {
      positions: new Float32Array(pts),
      corners: c,
      valid: true,
    }
  }, [bounds])

  if (!valid || !positions || !corners) return null

  const color =
    fit === 'danger'
      ? dark
        ? '#f87171'
        : '#dc2626'
      : fit === 'warn'
        ? dark
          ? '#fbbf24'
          : '#d97706'
        : dark
          ? '#5eead4'
          : '#0e7c66'

  return (
    <group>
      {/* The footprint rectangle — a bright loop drawn just above the bed so it
          reads clearly against the grid without z-fighting. */}
      <lineSegments position={[0, 0, 0.02]}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        </bufferGeometry>
        <lineBasicMaterial color={color} transparent opacity={0.95} depthTest={false} />
      </lineSegments>
      {/* Small corner markers so the extent of the footprint is unambiguous. */}
      {corners.map((c, i) => (
        <mesh key={i} position={[c[0], c[1], 0.02]} rotation={[Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.8, 1.8, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.9} depthTest={false} side={2} />
        </mesh>
      ))}
    </group>
  )
}
