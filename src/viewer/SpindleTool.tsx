import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useSettings } from '../store'

/**
 * Variant tints the metalwork: `actual` = the live machine spindle (warm steel),
 * `sim` = the simulation playhead (cool steel). Both read clearly on dark+light.
 */
export type SpindleVariant = 'actual' | 'sim'

interface SpindleToolProps {
  /** Tool-tip position [x, y, z] in machine mm (Z-up). The bit tip sits here. */
  position: [number, number, number]
  /** Active cutter DIAMETER in mm. Drives the bit ⌀ and (loosely) its length. */
  toolDiameter?: number
  /** Visible? Default true. */
  visible?: boolean
  /** Warm (actual) vs cool (sim) steel tint. Default 'actual'. */
  variant?: SpindleVariant
  /** Spin the bit/spindle (job running or scrubbing). Default false. */
  spinning?: boolean
}

/**
 * A believable router spindle + ER collet + tool bit, positioned so the BIT TIP
 * lands exactly on `position` (the live/sim tool point), with the body rising up
 * the +Z axis above the work. The bit diameter tracks the active tool ⌀, so a
 * 1mm engraver reads thin and a 6mm endmill reads chunky.
 *
 * Built from a few cheap primitives (cylinders / a hex prism / a cone) sharing
 * three cached materials — no per-frame allocation, so it never tanks the
 * framerate on big toolpaths. The OPTIONAL spin is a single quaternion-free
 * rotation on one group, gated on `spinning` AND the user's reduced-motion
 * preference. Pure presentation: driven entirely by props, no business logic.
 *
 * The whole thing is a clean, importable unit — the stock-removal sim (V12) can
 * reuse `position` + `toolDiameter` to size its sweep brush identically.
 */
export function SpindleTool({
  position,
  toolDiameter = 3.175,
  visible = true,
  variant = 'actual',
  spinning = false,
}: SpindleToolProps) {
  const theme = useSettings((s) => s.theme)
  const dark = theme === 'dark'
  const spinRef = useRef<THREE.Group>(null)

  // Honour reduced-motion: never auto-spin if the user asked for less motion.
  const reduceMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    [],
  )

  // --- Sizing -------------------------------------------------------------
  // Clamp the bit ⌀ to a sane, visible range, then derive the rest of the body
  // proportionally so a tiny engraver still reads and a big endmill isn't huge.
  const dims = useMemo(() => {
    const dia = Math.min(12, Math.max(0.4, toolDiameter || 3.175))
    const bitR = dia / 2
    // Flute (cutting) length scales gently with ⌀; shank is the standard 3.175.
    const fluteLen = Math.max(6, dia * 3)
    const shankR = Math.max(bitR, 1.5875) // 1/8" collet shank floor
    const shankLen = Math.max(8, dia * 2)
    // Collet nut + nose + spindle body are sized to read as a real router, but
    // capped so they never dominate a tiny job. Bed-relative, in mm.
    const nutR = Math.max(5, shankR * 2.4)
    const nutLen = Math.max(7, shankR * 3)
    const noseR = nutR * 0.8
    const noseLen = nutLen * 0.7
    const bodyR = nutR * 1.18
    const bodyLen = Math.max(26, bodyR * 2.4)
    return {
      bitR,
      fluteLen,
      shankR,
      shankLen,
      nutR,
      nutLen,
      noseR,
      noseLen,
      bodyR,
      bodyLen,
    }
  }, [toolDiameter])

  // --- Materials (cached; shared across primitives) -----------------------
  const mats = useMemo(() => {
    // Tip accent: amber for the live machine, cyan for the simulation, so the two
    // cutters stay instantly distinguishable (matches the panel's cone legend).
    const accent =
      variant === 'sim'
        ? dark
          ? '#22d3ee'
          : '#0891b2'
        : dark
          ? '#f59e0b'
          : '#d97706'
    // Steel body — bright brushed-aluminium tone so it reads as metal (not a
    // flat black cylinder) in BOTH themes. Low metalness keeps a strong diffuse
    // term (so it stays light even under a dim env); low-ish roughness still
    // gives a crisp specular streak from the key/rim lights.
    const steel = variant === 'sim' ? '#cdd9e6' : '#dfe3e8'
    const steelDark = variant === 'sim' ? '#aebccd' : '#c2c8d0'

    const body = new THREE.MeshStandardMaterial({
      color: dark ? steelDark : steel,
      metalness: 0.18,
      roughness: 0.42,
      // A hint of self-illumination keeps the unlit sides reading as light steel
      // rather than going to black under the dim in-scene environment.
      emissive: new THREE.Color(dark ? '#2c3440' : '#cdd3db'),
      emissiveIntensity: dark ? 0.18 : 0.35,
    })
    const nut = new THREE.MeshStandardMaterial({
      color: dark ? '#9aa6b5' : '#b6bcc6',
      metalness: 0.25,
      roughness: 0.5,
      emissive: new THREE.Color(dark ? '#262d36' : '#aab1bb'),
      emissiveIntensity: dark ? 0.15 : 0.3,
    })
    const bit = new THREE.MeshStandardMaterial({
      color: accent,
      metalness: 0.6,
      roughness: 0.25,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 0.25,
    })
    return { body, nut, bit, accent }
  }, [dark, variant])

  // Dispose cached materials on change / unmount (GPU buffers leak otherwise).
  // (useMemo cleanup never runs, so do it imperatively via a ref-less effect.)
  const matsRef = useRef(mats)
  if (matsRef.current !== mats) {
    matsRef.current.body.dispose()
    matsRef.current.nut.dispose()
    matsRef.current.bit.dispose()
    matsRef.current = mats
  }

  // Gentle spin while running/scrubbing. Allocation-free; reads the live ref.
  useFrame((_, delta) => {
    if (spinRef.current && spinning && !reduceMotion) {
      spinRef.current.rotation.y += delta * 22 // rad/s — a believable idle whirr
    }
  })

  if (!visible) return null

  const [x, y, z] = position
  const d = dims

  // Stack everything along +Z from the tip (z=0 local) upward. coneGeometry's
  // axis is +Y; rotating -90° about X maps +Y → +Z so cones point along Z.
  const fluteCenter = d.fluteLen / 2
  const shankCenter = d.fluteLen + d.shankLen / 2
  const collarBase = d.fluteLen + d.shankLen
  const noseCenter = collarBase + d.noseLen / 2
  const nutCenter = collarBase + d.noseLen + d.nutLen / 2
  const bodyBase = collarBase + d.noseLen + d.nutLen
  const bodyCenter = bodyBase + d.bodyLen / 2

  return (
    <group position={[x, y, z]}>
      {/* Spinning assembly: bit + shank (+ a faint motion ring while running). */}
      <group ref={spinRef}>
        {/* Tool BIT — a tapered cone whose point sits exactly at the tip (z=0). */}
        <mesh
          position={[0, 0, fluteCenter]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={mats.bit}
        >
          <coneGeometry args={[d.bitR, d.fluteLen, 24]} />
        </mesh>
        {/* Shank above the flutes. */}
        <mesh
          position={[0, 0, shankCenter]}
          rotation={[-Math.PI / 2, 0, 0]}
          material={mats.body}
        >
          <cylinderGeometry args={[d.shankR, d.shankR, d.shankLen, 24]} />
        </mesh>
      </group>

      {/* Collet NOSE — the tapered front of the collet nut. */}
      <mesh
        position={[0, 0, noseCenter]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={mats.nut}
      >
        <cylinderGeometry args={[d.noseR, d.nutR * 0.95, d.noseLen, 28]} />
      </mesh>
      {/* Collet NUT — a hex prism (6-sided cylinder) for the wrench flats. */}
      <mesh
        position={[0, 0, nutCenter]}
        rotation={[-Math.PI / 2, Math.PI / 6, 0]}
        material={mats.nut}
      >
        <cylinderGeometry args={[d.nutR, d.nutR, d.nutLen, 6]} />
      </mesh>
      {/* Spindle BODY — the router motor barrel. */}
      <mesh
        position={[0, 0, bodyCenter]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={mats.body}
      >
        <cylinderGeometry args={[d.bodyR, d.bodyR, d.bodyLen, 32]} />
      </mesh>
      {/* A subtle contact halo on the work plane, tinted to the variant accent,
          so the exact XY tip is readable even when the body occludes it. */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[d.bitR * 0.9, d.bitR * 1.5 + 0.4, 32]} />
        <meshBasicMaterial
          color={mats.accent}
          transparent
          opacity={0.55}
          side={THREE.DoubleSide}
          depthWrite={false}
        />
      </mesh>
    </group>
  )
}
