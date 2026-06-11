import { Canvas, useFrame } from '@react-three/fiber'
import { Billboard, Text } from '@react-three/drei'
import { cameraQuat } from './axisGizmoSync'

/**
 * Independent colored XYZ axis-arrow indicator, rendered in its OWN small canvas
 * (NOT a drei GizmoHelper — two of those break each other, and a GizmoHelper won't
 * render arbitrary arrow meshes). It mirrors the main viewer camera's orientation
 * each frame via the shared {@link cameraQuat}, so the triad turns exactly with the
 * scene — a clean companion to the orientation cube, with real arrows and the
 * labels OUTSIDE the arrowheads.
 */

// Lives INSIDE the main Canvas: publishes the live camera orientation each frame.
export function CameraQuatReporter() {
  useFrame(({ camera }) => {
    cameraQuat.copy(camera.quaternion)
  })
  return null
}

// The overlay's own (orthographic) camera copies the main camera's orientation so
// the world axes are seen from the same angle. Distance is irrelevant under ortho.
function MirrorCam() {
  useFrame(({ camera }) => {
    camera.quaternion.copy(cameraQuat)
    camera.position.set(0, 0, 1).applyQuaternion(cameraQuat).multiplyScalar(6)
  })
  return null
}

const AXIS_LEN = 1.15
const HEAD = 0.42
/** A thick arrow (cylinder shaft + cone head) along +X / +Y / +Z, unlit so it
 *  reads at any angle. */
function Arrow({ axis, color }: { axis: 'x' | 'y' | 'z'; color: string }) {
  const rot: [number, number, number] =
    axis === 'x' ? [0, 0, -Math.PI / 2] : axis === 'z' ? [Math.PI / 2, 0, 0] : [0, 0, 0]
  return (
    <group rotation={rot}>
      <mesh position={[0, AXIS_LEN / 2, 0]}>
        <cylinderGeometry args={[0.06, 0.06, AXIS_LEN, 14]} />
        <meshBasicMaterial color={color} />
      </mesh>
      <mesh position={[0, AXIS_LEN + HEAD / 2, 0]}>
        <coneGeometry args={[0.2, HEAD, 18]} />
        <meshBasicMaterial color={color} />
      </mesh>
    </group>
  )
}

export function AxisOverlay({ theme }: { theme: string }) {
  const outline = theme === 'dark' ? '#0b0e12' : '#e9eef3'
  const lbl = (pos: [number, number, number], color: string, text: string) => (
    <Billboard position={pos}>
      <Text fontSize={0.6} color={color} outlineWidth={0.08} outlineColor={outline} anchorX="center" anchorY="middle">
        {text}
      </Text>
    </Billboard>
  )
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 10,
        top: 56,
        width: 90,
        height: 90,
        pointerEvents: 'none',
        zIndex: 5,
      }}
    >
      <Canvas
        orthographic
        camera={{ position: [0, 0, 6], zoom: 26, near: 0.1, far: 100 }}
        dpr={[1, 2]}
        gl={{ alpha: true, antialias: true }}
        style={{ background: 'transparent' }}
      >
        <MirrorCam />
        <Arrow axis="x" color="#ff6b6b" />
        <Arrow axis="y" color="#51cf66" />
        <Arrow axis="z" color="#4dabf7" />
        {lbl([1.85, 0, 0], '#ff6b6b', 'X')}
        {lbl([0, 1.85, 0], '#51cf66', 'Y')}
        {lbl([0, 0, 1.85], '#4dabf7', 'Z')}
      </Canvas>
    </div>
  )
}
