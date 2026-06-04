import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCameraCalib, useCameraLive, useSettings } from '../store'
import { useBed } from '../store/bed'
import { invertMat3 } from '../core/cameraCalib'

/**
 * Live overhead-camera overlay, rectified onto the bed plane.
 *
 * Reads the persisted calibration (`useCameraCalib`) and the transient live
 * <video> bus (`useCameraLive`). When the primary camera (slot 0) is both
 * streaming and calibrated, we draw a thin horizontal plane just above the bed
 * grid and texture it with a `THREE.VideoTexture` sampled through the
 * image←world homography, so the live frame appears geometrically aligned with
 * the work coordinate system (work zero centred, Z-up, mm).
 *
 * The plane geometry is centred at the origin and sized to the bed (W×D), so
 * the geometry's local (x, y) ARE the world (x, y) and can be fed straight into
 * the homography in the shader. Sampling math lives entirely in the GPU; the
 * only CPU work per-calibration is composing the texture-normalisation matrix.
 *
 * Falls back to a faint placeholder plane when enabled but not yet usable
 * (no calibration or no live video) so the toggle always has a visible effect.
 *
 * No business logic — purely a display driven by the two camera stores.
 */
export function CameraBedPlane() {
  const theme = useSettings((s) => s.theme)

  const enabled = useCameraCalib((s) => s.enabled)
  const overlayOpacity = useCameraCalib((s) => s.overlayOpacity)
  const H = useCameraCalib((s) => s.cameras[0].H)
  const frameW = useCameraCalib((s) => s.cameras[0].frameW)
  const frameH = useCameraCalib((s) => s.cameras[0].frameH)

  const video = useCameraLive((s) => s.videoEls[0])
  const epoch = useCameraLive((s) => s.epoch)

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)

  // --- world(x,y,1) -> texture(u*w, v*w, w) matrix --------------------------
  // cameras[0].H maps IMAGE px -> world mm, so world -> image = inverse(H).
  // Pre-multiply by diag(1/frameW, 1/frameH, 1) to land in [0..1] texture space.
  // Row-major Mat3 (length 9) -> THREE.Matrix3 (column-major .set takes rows).
  const uMat = useMemo(() => {
    if (!H || H.length !== 9 || !(frameW > 0) || !(frameH > 0)) return null
    const world2img = invertMat3(H)
    if (!world2img) return null
    const sx = 1 / frameW
    const sy = 1 / frameH
    // S * world2img, S = diag(sx, sy, 1) scales rows 0 and 1.
    const m = [
      sx * world2img[0], sx * world2img[1], sx * world2img[2],
      sy * world2img[3], sy * world2img[4], sy * world2img[5],
      world2img[6], world2img[7], world2img[8],
    ]
    const mat = new THREE.Matrix3()
    // Matrix3.set takes ROW-major arguments — matches our row-major layout.
    mat.set(
      m[0], m[1], m[2],
      m[3], m[4], m[5],
      m[6], m[7], m[8],
    )
    return mat
  }, [H, frameW, frameH])

  // --- live video texture, rebuilt whenever the stream (epoch) or el changes -
  const texture = useMemo(() => {
    if (!video) return null
    const tex = new THREE.VideoTexture(video)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.colorSpace = THREE.SRGBColorSpace
    // We handle vertical orientation explicitly in the fragment shader, so keep
    // the raw sampling space predictable.
    tex.flipY = false
    return tex
    // epoch is intentionally a dep so a restarted stream rebuilds the texture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, epoch])

  useEffect(() => {
    return () => {
      texture?.dispose()
    }
  }, [texture])

  // Keep the texture's video playing whenever it is mounted.
  useEffect(() => {
    if (!video) return
    // play() can reject if not yet allowed; ignore — the panel owns the stream.
    void video.play().catch(() => {})
  }, [video, epoch])

  const overlayReady = !!uMat && !!texture

  // --- shader material (only when we can actually sample the overlay) --------
  const material = useMemo(() => {
    if (!overlayReady) return null
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uVideo: { value: texture },
        uMat: { value: uMat },
        uOpacity: { value: overlayOpacity },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() {
          // Plane is centred at the origin and sized to the bed, so the local
          // x,y equal the world x,y (mm). Pass them straight to the fragment.
          vWorld = position.xy;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uVideo;
        uniform mat3 uMat;
        uniform float uOpacity;
        varying vec2 vWorld;
        void main() {
          vec3 q = uMat * vec3(vWorld, 1.0);
          if (abs(q.z) < 1e-8) discard;
          vec2 uv = q.xy / q.z;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          // Texture has flipY=false; flip vertically so the bed reads upright.
          vec3 rgb = texture2D(uVideo, vec2(uv.x, 1.0 - uv.y)).rgb;
          gl_FragColor = vec4(rgb, uOpacity);
        }
      `,
    })
    // overlayOpacity is pushed live in useFrame, not a rebuild dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayReady, texture, uMat])

  useEffect(() => {
    return () => {
      material?.dispose()
    }
  }, [material])

  // Push the latest opacity from the store every frame (cheap; avoids rebuild).
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  matRef.current = material
  useFrame(() => {
    const m = matRef.current
    if (m) m.uniforms.uOpacity.value = overlayOpacity
  })

  if (!enabled) return null

  // The plane already lies in the XY plane (PlaneGeometry is built in XY with
  // +Z normal), which is exactly the bed plane in this Z-up scene — no rotation
  // needed. Lift it just above the grid to avoid z-fighting.
  if (overlayReady && material) {
    return (
      <mesh position={[0, 0, 0.02]} material={material}>
        <planeGeometry args={[bedW, bedD]} />
      </mesh>
    )
  }

  // Enabled but not usable yet: faint placeholder so the toggle is visible and
  // the user can see where the bed-plane overlay will land.
  const accent = theme === 'dark' ? '#38bdf8' : '#0284c7'
  return (
    <mesh position={[0, 0, 0.02]}>
      <planeGeometry args={[bedW, bedD]} />
      <meshBasicMaterial
        color={accent}
        transparent
        opacity={0.12}
        depthWrite={false}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}
