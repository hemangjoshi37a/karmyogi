import { Grid } from '@react-three/drei'
import { useSettings } from '../store'

interface BedProps {
  /** Bed size in mm (X, Y). */
  width?: number
  depth?: number
}

/** Machine bed: a major/minor grid on the XY plane plus a small origin gizmo. */
export function Bed({ width = 300, depth = 200 }: BedProps) {
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
      <OriginGizmo />
    </group>
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
