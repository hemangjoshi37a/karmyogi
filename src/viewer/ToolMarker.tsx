import { useSettings } from '../store'

interface ToolMarkerProps {
  /** Current tool tip position [x, y, z] in machine mm. */
  position: [number, number, number]
  /** Visible? Hide when there is no live position. Default true. */
  visible?: boolean
  /** Marker scale in mm. Default 6. */
  size?: number
  /** Override marker colour. */
  color?: string
}

/**
 * A marker at the current tool position: a small cone whose tip sits exactly at
 * the position (pointing down toward the work, Z-up frame) over a flat disc.
 * Driven purely by the `position` prop — no business logic.
 */
export function ToolMarker({ position, visible = true, size = 6, color }: ToolMarkerProps) {
  const theme = useSettings((s) => s.theme)
  const c = color ?? (theme === 'dark' ? '#f59e0b' : '#d97706')

  if (!visible) return null

  const [x, y, z] = position

  // coneGeometry's axis is +Y (apex at +Y/2, base at -Y/2). Rotating -90° about
  // X maps +Y -> -Z, so the apex points straight down (-Z) and the body rises
  // up (+Z). After the rotation the apex sits at local z = -height/2; offset the
  // mesh up by +height/2 so the tip lands exactly on the group origin (the red
  // contact dot), with the cone body extending upward above it.
  const height = size * 1.6

  return (
    <group position={[x, y, z]}>
      {/* Cone points down (-Z) with its tip at the origin of this group. */}
      <mesh position={[0, 0, height / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[size * 0.5, height, 16]} />
        <meshStandardMaterial color={c} emissive={c} emissiveIntensity={0.25} />
      </mesh>
      {/* Contact-point dot on the work surface. */}
      <mesh>
        <sphereGeometry args={[size * 0.25, 12, 12]} />
        <meshStandardMaterial color={c} />
      </mesh>
    </group>
  )
}
