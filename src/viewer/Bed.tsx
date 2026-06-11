import { useState } from 'react'
import { Grid, Line, Html } from '@react-three/drei'
import { useSettings } from '../store'
import { useBed } from '../store/bed'

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
}

/**
 * Machine bed: a major/minor grid on the XY plane, a small origin gizmo, the bed
 * VOLUME (4 corner verticals + a top rectangle up to the Z size), and editable
 * X/Y/Z size labels at the bed edges (click a number to edit the bed size on the
 * spot). The grid is centred on the work origin, so the volume spans
 * [-W/2..W/2] × [-D/2..D/2] × [0..H].
 */
export function Bed({ width = 300, depth = 200, height = 100, showLabels = true }: BedProps) {
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
      <OriginGizmo />
    </group>
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
