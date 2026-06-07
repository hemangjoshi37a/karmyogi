import { Billboard, Text } from '@react-three/drei'

/**
 * A small RED SPHERE at the loaded program's START point (the first move's XYZ)
 * — i.e. where work-zero / "Zero all" sets the origin — with a tiny billboarded
 * "0" label so the operator can immediately see where the job begins.
 *
 * Tracks the loaded program (the caller passes the first segment's `from`).
 * Pure presentation; the radius is fixed in mm so it reads as a consistent
 * physical marker in the scene.
 */

export interface ToolpathStartMarkerProps {
  /** First toolpath point [x, y, z] (mm). */
  start: [number, number, number]
  dark: boolean
}

const RADIUS = 2 // mm

export function ToolpathStartMarker({ start, dark }: ToolpathStartMarkerProps) {
  const labelColor = dark ? '#fecaca' : '#7f1d1d'
  const labelOutline = dark ? '#15181c' : '#e7ecf1'

  return (
    <group position={start}>
      <mesh renderOrder={5}>
        <sphereGeometry args={[RADIUS, 20, 20]} />
        <meshStandardMaterial
          color="#ef4444"
          emissive="#b91c1c"
          emissiveIntensity={0.5}
          roughness={0.4}
          depthTest={false}
        />
      </mesh>
      <Billboard position={[0, 0, RADIUS * 2.4]}>
        <Text
          fontSize={RADIUS * 1.8}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          outlineWidth={RADIUS * 0.18}
          outlineColor={labelOutline}
          depthOffset={-4}
        >
          0
        </Text>
      </Billboard>
    </group>
  )
}
