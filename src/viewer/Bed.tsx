import { useMemo, useState } from 'react'
import { Grid, Line, Html } from '@react-three/drei'
import { useSettings } from '../store'
import { useBed } from '../store/bed'
import { useGrblSettings } from '../store/grblSettings'
import { useMachine } from '../store/machine'

interface BedProps {
  /** Bed size in mm (X, Y, Z). */
  width?: number
  depth?: number
  height?: number
  /**
   * Render the editable X/Y/Z size labels. They are drei <Html> overlays, which
   * IGNORE three.js group visibility — so the Layers "Machine bed" toggle has to
   * gate them explicitly (hiding the bed must also hide its size numbers).
   */
  showLabels?: boolean
  /**
   * V11 — draw the soft-limit travel box (from GRBL $130/$131/$132 max travel)
   * and the distinct machine (G53) origin marker. Self-gates on the GRBL
   * settings being present, so it only appears once the controller is synced.
   * Default true.
   */
  showSoftLimits?: boolean
}

/**
 * Machine bed: a major/minor grid on the XY plane, a small origin gizmo, the bed
 * VOLUME (4 corner verticals + a top rectangle up to the Z size), and editable
 * X/Y/Z size labels at the bed edges (click a number to edit the bed size on the
 * spot). The grid is centred on the work origin, so the volume spans
 * [-W/2..W/2] × [-D/2..D/2] × [0..H].
 */
export function Bed({
  width = 300,
  depth = 200,
  height = 100,
  showLabels = true,
  showSoftLimits = true,
}: BedProps) {
  const theme = useSettings((s) => s.theme)
  const minor = theme === 'dark' ? '#3a4250' : '#d4dae1'
  const major = theme === 'dark' ? '#515c6e' : '#aab4c0'

  return (
    <group>
      {/* Grid lies in XZ by default; rotate so it sits on the XY machine plane. */}
      <Grid
        args={[width, depth]}
        cellSize={10}
        cellThickness={0.6}
        cellColor={minor}
        sectionSize={50}
        sectionThickness={1.1}
        sectionColor={major}
        rotation={[Math.PI / 2, 0, 0]}
        infiniteGrid={false}
        fadeDistance={Math.max(width, depth) * 3}
        fadeStrength={1}
      />
      <BedVolume width={width} depth={depth} height={height} dark={theme === 'dark'} />
      {showLabels && (
        <BedDimensions width={width} depth={depth} height={height} dark={theme === 'dark'} />
      )}
      {/* G54 work origin: the bright RGB triad, now labelled to contrast it with
          the machine (G53) origin drawn by SoftLimits. */}
      <OriginGizmo />
      {showLabels && <OriginLabel position={[0, 0, 0]} text="G54" dark={theme === 'dark'} />}
      {showSoftLimits && <SoftLimits dark={theme === 'dark'} showLabels={showLabels} />}
    </group>
  )
}

/**
 * V11 — soft-limit travel box + machine (G53) origin.
 *
 * GRBL constrains machine motion to the box [$130]×[$131]×[$132] anchored at the
 * homing corner (machine zero). The homing-direction-invert mask ($23) sets, per
 * axis, whether travel runs negative (default: machine 0 at the positive corner,
 * working area negative) or positive. We convert that machine-space box into the
 * scene's WORK space by subtracting the work-coordinate offset (WCO = mpos −
 * wpos, reported by the controller): machine coord m maps to work coord m − WCO,
 * so machine zero sits at −WCO. The bed grid is centred on the work origin, so
 * this places the travel box exactly where the head can actually reach.
 *
 * Read-only: it only reads the GRBL-settings + machine stores; it never mutates
 * them. Static geometry (drei <Line>, built once via useMemo) — no per-frame work.
 */
function SoftLimits({ dark, showLabels }: { dark: boolean; showLabels: boolean }) {
  const values = useGrblSettings((s) => s.values)
  const wco = useMachine((s) => s.wco)

  const box = useMemo(() => {
    const max = [values[130]?.numeric, values[131]?.numeric, values[132]?.numeric]
    // Need at least X & Y travel to draw a meaningful box.
    if (!(Number(max[0]) > 0) || !(Number(max[1]) > 0)) return null
    const dirMask = Math.round(values[23]?.numeric ?? 0)
    const w = [wco.x, wco.y, wco.z]
    const lo: [number, number, number] = [0, 0, 0]
    const hi: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < 3; i++) {
      const m = Number(max[i])
      const travel = Number.isFinite(m) && m > 0 ? m : 0
      const positive = ((dirMask >> i) & 1) === 1 // homed negative ⇒ travel positive
      const mLo = positive ? 0 : -travel
      const mHi = positive ? travel : 0
      lo[i] = mLo - w[i]
      hi[i] = mHi - w[i]
    }
    return { lo, hi }
  }, [values, wco])

  // Machine origin (G53 / machine zero) in work coordinates is −WCO.
  const machineZero: [number, number, number] = [-wco.x, -wco.y, -wco.z]
  const offset = Math.hypot(wco.x, wco.y, wco.z)

  if (!box) return null
  const { lo, hi } = box
  const z = Math.max(lo[2], 0.0) // draw the box footprint at/above the bed floor
  const color = dark ? '#f59e0b' : '#b45309' // amber — distinct from the bed wireframe

  // 12 edges of the travel box.
  const c: [number, number, number][] = [
    [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [lo[0], hi[1], lo[2]],
    [lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]],
  ]
  const bottom: [number, number, number][] = [c[0], c[1], c[2], c[3], c[0]]
  const top: [number, number, number][] = [c[4], c[5], c[6], c[7], c[4]]
  const verticals: [number, number, number][][] = [
    [c[0], c[4]], [c[1], c[5]], [c[2], c[6]], [c[3], c[7]],
  ]

  return (
    <group>
      <Line points={bottom} color={color} lineWidth={1.4} dashed dashSize={6} gapSize={4} transparent opacity={0.85} />
      {hi[2] - lo[2] > 1e-6 && (
        <>
          <Line points={top} color={color} lineWidth={1} dashed dashSize={6} gapSize={4} transparent opacity={0.5} />
          {verticals.map((v, i) => (
            <Line key={i} points={v} color={color} lineWidth={1} dashed dashSize={6} gapSize={4} transparent opacity={0.5} />
          ))}
        </>
      )}
      {showLabels && (
        <Html
          position={[lo[0], lo[1], z]}
          center
          zIndexRange={[39, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <span
            style={{
              font: '600 10px system-ui, sans-serif',
              whiteSpace: 'nowrap',
              color: dark ? '#f8c97a' : '#7c4a07',
              background: dark ? 'rgba(21,24,28,0.85)' : 'rgba(231,236,241,0.9)',
              border: `1px solid ${color}`,
              borderRadius: 4,
              padding: '1px 4px',
            }}
          >
            Soft limit
          </span>
        </Html>
      )}
      {/* Machine (G53) origin — only when it does NOT coincide with the work
          origin (otherwise it would just stack on the G54 label). A small amber
          marker keeps it visually distinct from the bright RGB G54 triad. */}
      {offset > 1e-6 && (
        <group position={machineZero}>
          <MachineOriginMarker dark={dark} />
          {showLabels && <OriginLabel position={[0, 0, 0]} text="G53 · M0" dark={dark} accent={color} />}
        </group>
      )}
    </group>
  )
}

/** Small amber crosshair marking the machine (G53) origin. */
function MachineOriginMarker({ dark }: { dark: boolean }) {
  const color = dark ? '#f59e0b' : '#b45309'
  const s = 10
  return (
    <group>
      <Line points={[[-s, 0, 0], [s, 0, 0]]} color={color} lineWidth={1.5} />
      <Line points={[[0, -s, 0], [0, s, 0]]} color={color} lineWidth={1.5} />
      <Line points={[[0, 0, 0], [0, 0, s]]} color={color} lineWidth={1.5} />
    </group>
  )
}

/** A tiny pinned text label for an origin (G54 work / G53 machine). */
function OriginLabel({
  position,
  text,
  dark,
  accent,
}: {
  position: [number, number, number]
  text: string
  dark: boolean
  accent?: string
}) {
  const border = accent ?? (dark ? '#5eead4' : '#0e7c66')
  const fg = accent ?? (dark ? '#5eead4' : '#0e7c66')
  return (
    <Html position={position} center zIndexRange={[39, 0]} style={{ pointerEvents: 'none' }}>
      <span
        style={{
          font: '700 10px system-ui, sans-serif',
          whiteSpace: 'nowrap',
          color: fg,
          background: dark ? 'rgba(21,24,28,0.82)' : 'rgba(231,236,241,0.9)',
          border: `1px solid ${border}`,
          borderRadius: 4,
          padding: '0 4px',
          transform: 'translate(10px, -10px)',
        }}
      >
        {text}
      </span>
    </Html>
  )
}

/**
 * Bed volume wireframe: the 4 corner verticals rising from the XY plane to the
 * Z size, joined by a rectangle on top (and a faint one on the bottom for
 * definition). Lets the operator see the full machine envelope, not just the
 * floor.
 */
function BedVolume({
  width,
  depth,
  height,
  dark,
}: {
  width: number
  depth: number
  height: number
  dark: boolean
}) {
  if (!(height > 1e-6)) return null
  const hw = width / 2
  const hd = depth / 2
  const h = height
  const color = dark ? '#5b6878' : '#9aa6b4'
  const topColor = dark ? '#6b7a8c' : '#7c8a99'

  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ]
  const top: [number, number, number][] = [
    ...corners.map((c) => [c[0], c[1], h] as [number, number, number]),
    [corners[0][0], corners[0][1], h],
  ]
  const bottom: [number, number, number][] = [
    ...corners.map((c) => [c[0], c[1], 0] as [number, number, number]),
    [corners[0][0], corners[0][1], 0],
  ]

  return (
    <group>
      {corners.map((c, i) => (
        <Line
          key={`v-${i}`}
          points={[
            [c[0], c[1], 0],
            [c[0], c[1], h],
          ]}
          color={color}
          lineWidth={1}
          transparent
          opacity={0.55}
        />
      ))}
      <Line points={top} color={topColor} lineWidth={1.4} transparent opacity={0.7} />
      <Line points={bottom} color={color} lineWidth={1} transparent opacity={0.35} />
    </group>
  )
}

/**
 * Editable X / Y / Z bed-size labels pinned to the bed edges. Click a number to
 * edit that axis's bed size in place; Enter / blur commits, Esc cancels.
 */
function BedDimensions({
  width,
  depth,
  height,
  dark,
}: {
  width: number
  depth: number
  height: number
  dark: boolean
}) {
  const setWidth = useBed((s) => s.setWidth)
  const setDepth = useBed((s) => s.setDepth)
  const setHeight = useBed((s) => s.setHeight)

  const hw = width / 2
  const hd = depth / 2
  const off = Math.max(Math.max(width, depth) * 0.06, 8)

  return (
    <group>
      <BedDimLabel
        position={[0, -hd - off, 0]}
        axis="X"
        value={width}
        onCommit={setWidth}
        dark={dark}
      />
      <BedDimLabel
        position={[-hw - off, 0, 0]}
        axis="Y"
        value={depth}
        onCommit={setDepth}
        dark={dark}
      />
      <BedDimLabel
        position={[-hw - off, -hd, Math.max(height / 2, 1)]}
        axis="Z"
        value={height}
        onCommit={setHeight}
        dark={dark}
      />
    </group>
  )
}

function BedDimLabel({
  position,
  axis,
  value,
  onCommit,
  dark,
}: {
  position: [number, number, number]
  axis: 'X' | 'Y' | 'Z'
  value: number
  onCommit: (v: number) => void
  dark: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const rounded = Math.round(value * 10) / 10

  const commit = () => {
    const v = parseFloat(draft)
    if (Number.isFinite(v)) onCommit(v)
    setEditing(false)
  }

  const bg = dark ? 'rgba(21,24,28,0.92)' : 'rgba(231,236,241,0.95)'
  const fg = dark ? '#e2e8f0' : '#1e293b'
  const border = dark ? '#3a4048' : '#aab4c0'
  const accent = dark ? '#5eead4' : '#0e7c66'

  return (
    <Html position={position} center zIndexRange={[40, 0]} style={{ pointerEvents: 'none' }}>
      {editing ? (
        <input
          autoFocus
          type="number"
          defaultValue={String(rounded)}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            else if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
          style={{
            pointerEvents: 'auto',
            width: 64,
            font: '600 11px system-ui, sans-serif',
            color: fg,
            background: bg,
            border: `1px solid ${accent}`,
            borderRadius: 5,
            padding: '2px 5px',
            textAlign: 'center',
            outline: 'none',
          }}
        />
      ) : (
        <button
          type="button"
          title={`Bed ${axis} size (mm) — click to edit`}
          onPointerDown={(e) => {
            e.stopPropagation()
            setDraft(String(rounded))
            setEditing(true)
          }}
          style={{
            pointerEvents: 'auto',
            cursor: 'text',
            font: '600 11px system-ui, sans-serif',
            whiteSpace: 'nowrap',
            color: fg,
            background: bg,
            border: `1px solid ${border}`,
            borderRadius: 5,
            padding: '2px 6px',
          }}
        >
          <span style={{ color: accent, marginRight: 4 }}>{axis}</span>
          {rounded}
          <span style={{ opacity: 0.6, marginLeft: 2 }}>mm</span>
        </button>
      )}
    </Html>
  )
}

/** X (red), Y (green), Z (blue) axes at the work origin. */
function OriginGizmo({ size = 25 }: { size?: number }) {
  return (
    <group>
      <Axis dir={[1, 0, 0]} color="#ef4444" length={size} />
      <Axis dir={[0, 1, 0]} color="#22c55e" length={size} />
      <Axis dir={[0, 0, 1]} color="#3b82f6" length={size} />
    </group>
  )
}

function Axis({ dir, color, length }: { dir: [number, number, number]; color: string; length: number }) {
  const end: [number, number, number] = [dir[0] * length, dir[1] * length, dir[2] * length]
  return (
    <line>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          args={[new Float32Array([0, 0, 0, ...end]), 3]}
        />
      </bufferGeometry>
      <lineBasicMaterial color={color} />
    </line>
  )
}
