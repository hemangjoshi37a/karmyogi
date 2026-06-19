import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { useCameraCalib, useCameraLive, useSettings, useMachine } from '../store'
import { useBed } from '../store/bed'
import { invertMat3 } from '../core/cameraCalib'
import { BedMosaic } from './BedMosaic'
import { useBedMosaic } from '../store/bedMosaic'
import { useToolMask, maskRectArray } from '../store/toolMask'

/**
 * Live-camera overlay rectified onto the bed plane, for BOTH mount types:
 *
 *  • `fixed`  — overhead/stationary camera that sees the whole bed. The live
 *    frame is sampled through the image←world homography so it appears pinned to
 *    the work coordinate system.
 *
 *  • `head`   — camera bolted to the spindle, CLOSE to the bed. We draw a small
 *    quad whose 4 corners are the image corners mapped to bed-mm via `headMap`
 *    (the motion-calibrated pixel→bed 2×2 linear map: scale + rotation + shear +
 *    handedness), translated to the LIVE machine XY each frame. So a fixed bed
 *    feature stays anchored at its real place while the patch pans with the head,
 *    in the correct direction (no inversion/mirror) and de-skewed. Falls back to
 *    a pxPerMm+rotation map when only the single-QR measure was done.
 *
 * A radial lens-distortion correction (`distortK`) straightens a wide-angle view.
 */

const UNDISTORT_GLSL = /* glsl */ `
  vec2 kmUndistort(vec2 uv, float k) {
    vec2 c = vec2(0.5);
    vec2 d = uv - c;
    float r2 = dot(d, d);
    return c + d * (1.0 + k * r2);
  }
`

export function CameraBedPlane() {
  const theme = useSettings((s) => s.theme)

  const enabled = useCameraCalib((s) => s.enabled)
  const overlayOpacity = useCameraCalib((s) => s.overlayOpacity)
  const mount = useCameraCalib((s) => s.cameras[0].mount)
  const H = useCameraCalib((s) => s.cameras[0].H)
  const frameW = useCameraCalib((s) => s.cameras[0].frameW)
  const frameH = useCameraCalib((s) => s.cameras[0].frameH)
  const pxPerMm = useCameraCalib((s) => s.cameras[0].pxPerMm)
  const rotationDeg = useCameraCalib((s) => s.cameras[0].rotationDeg)
  const headMap = useCameraCalib((s) => s.cameras[0].headMap)
  const headHomography = useCameraCalib((s) => s.cameras[0].headHomography)
  const headRefMm = useCameraCalib((s) => s.cameras[0].headRefMm)
  const headRotateQuarters = useCameraCalib((s) => s.cameras[0].headRotateQuarters)
  const headFlipH = useCameraCalib((s) => s.cameras[0].headFlipH)
  const headFlipV = useCameraCalib((s) => s.cameras[0].headFlipV)
  const offsetMm = useCameraCalib((s) => s.cameras[0].offsetMm)
  const distortK = useCameraCalib((s) => s.cameras[0].distortK)

  const video = useCameraLive((s) => s.videoEls[0])
  const epoch = useCameraLive((s) => s.epoch)

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)

  const isHead = mount === 'head'

  // Effective head map (pixel-offset → bed-mm-offset). Prefer the motion-solved
  // map; else build a scale+rotation map from the single-QR measure.
  const effHeadMap = useMemo<number[] | null>(() => {
    if (!isHead) return null
    let base: number[] | null = null
    if (headMap && headMap.length === 4) base = headMap
    else if (pxPerMm && pxPerMm > 0) {
      const r = (rotationDeg * Math.PI) / 180
      const s = 1 / pxPerMm
      base = [s * Math.cos(r), -s * Math.sin(r), s * Math.sin(r), s * Math.cos(r)]
    }
    if (!base) return null
    // Compose the manual quarter-turn override: effMap = R(q·90°) · base, which
    // rotates the displayed patch about its centre (fixes a rotated mount).
    const q = ((headRotateQuarters % 4) + 4) % 4
    let m = base
    if (q !== 0) {
      const ang = (q * Math.PI) / 2
      const cs = Math.cos(ang)
      const sn = Math.sin(ang)
      const [a, b, c, d] = m
      m = [cs * a - sn * c, cs * b - sn * d, sn * a + cs * c, sn * b + cs * d]
    }
    // Flips mirror the IMAGE: feed (∓du, ∓dv) to the map → negate the matching
    // column. H = mirror left↔right (negate col 0), V = mirror top↔bottom (col 1).
    if (headFlipH) m = [-m[0], m[1], -m[2], m[3]]
    if (headFlipV) m = [m[0], -m[1], m[2], -m[3]]
    return m
  }, [isHead, headMap, pxPerMm, rotationDeg, headRotateQuarters, headFlipH, headFlipV])

  // --- world→texture matrix (FIXED mount only) -------------------------------
  const uMat = useMemo(() => {
    if (isHead || !H || H.length !== 9 || !(frameW > 0) || !(frameH > 0)) return null
    const world2img = invertMat3(H)
    if (!world2img) return null
    const sx = 1 / frameW
    const sy = 1 / frameH
    const m = [
      sx * world2img[0], sx * world2img[1], sx * world2img[2],
      sy * world2img[3], sy * world2img[4], sy * world2img[5],
      world2img[6], world2img[7], world2img[8],
    ]
    const mat = new THREE.Matrix3()
    mat.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8])
    return mat
  }, [isHead, H, frameW, frameH])

  // Head PERSPECTIVE homography → world→texture-uv (same convention as `uMat`).
  // When present, the head overlay rectifies the bed to TRUE top-down (corrects
  // the camera tilt / parallax), not just affine scale+rotation. Absolute
  // placement adds the live (wpos − refHead) offset (see uWorldOffset below).
  const headHomoUMat = useMemo<THREE.Matrix3 | null>(() => {
    if (!isHead || !headHomography || headHomography.length !== 9 || !(frameW > 0) || !(frameH > 0)) return null
    const w2i = invertMat3(headHomography)
    if (!w2i) return null
    const sx = 1 / frameW
    const sy = 1 / frameH
    const mat = new THREE.Matrix3()
    mat.set(
      sx * w2i[0], sx * w2i[1], sx * w2i[2],
      sy * w2i[3], sy * w2i[4], sy * w2i[5],
      w2i[6], w2i[7], w2i[8],
    )
    return mat
  }, [isHead, headHomography, frameW, frameH])

  // --- live video texture ----------------------------------------------------
  const texture = useMemo(() => {
    if (!video) return null
    const tex = new THREE.VideoTexture(video)
    tex.minFilter = THREE.LinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = false
    tex.colorSpace = THREE.SRGBColorSpace
    tex.flipY = false
    return tex
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [video, epoch])

  useEffect(() => () => texture?.dispose(), [texture])
  useEffect(() => {
    if (!video) return
    void video.play().catch(() => {})
  }, [video, epoch])

  // Prefer the perspective homography for the head overlay (true top-down); fall
  // back to the affine quad only when no homography has been solved (Quick-scale).
  const usingHeadHomo = isHead && !!headHomoUMat && !!texture
  const headReady = isHead && !usingHeadHomo && !!effHeadMap && frameW > 0 && frameH > 0 && !!texture
  const fixedReady = !isHead && !!uMat && !!texture
  const overlayReady = headReady || fixedReady || usingHeadHomo

  // Image corners as pixel offsets from the frame centre, paired with the texture
  // uv that matches each (flipY=false → texture(0,0)=image top-left). Order builds
  // two triangles: TL, TR, BR, BL.
  const headCorners = useMemo(() => {
    const hw = frameW / 2
    const hh = frameH / 2
    return [
      { off: [-hw, -hh], uv: [0, 0] }, // TL
      { off: [hw, -hh], uv: [1, 0] }, // TR
      { off: [hw, hh], uv: [1, 1] }, // BR
      { off: [-hw, hh], uv: [0, 1] }, // BL
    ]
  }, [frameW, frameH])

  // Head-mount geometry: 4 dynamic vertices (positions recomputed each frame from
  // the live machine XY + headMap), static uv, two triangles.
  const headGeom = useMemo(() => {
    if (!headReady) return null
    const g = new THREE.BufferGeometry()
    const pos = new Float32Array(12) // 4 verts × xyz
    const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    g.setIndex([0, 1, 2, 0, 2, 3])
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headReady])
  useEffect(() => () => headGeom?.dispose(), [headGeom])

  // --- materials -------------------------------------------------------------
  const fixedMaterial = useMemo(() => {
    if (!fixedReady || !uMat || !texture) return null
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uVideo: { value: texture }, uMat: { value: uMat }, uOpacity: { value: overlayOpacity }, uK: { value: distortK } },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() { vWorld = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uVideo; uniform mat3 uMat; uniform float uOpacity; uniform float uK;
        varying vec2 vWorld;
        ${UNDISTORT_GLSL}
        void main() {
          vec3 q = uMat * vec3(vWorld, 1.0);
          if (abs(q.z) < 1e-8) discard;
          vec2 uv = kmUndistort(q.xy / q.z, uK);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          gl_FragColor = vec4(texture2D(uVideo, vec2(uv.x, 1.0 - uv.y)).rgb, uOpacity);
        }
      `,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixedReady, texture, uMat])

  const headMaterial = useMemo(() => {
    if (!headReady || !texture) return null
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { uVideo: { value: texture }, uOpacity: { value: overlayOpacity }, uK: { value: distortK } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uVideo; uniform float uOpacity; uniform float uK;
        varying vec2 vUv;
        ${UNDISTORT_GLSL}
        void main() {
          vec2 uv = kmUndistort(vUv, uK);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          gl_FragColor = vec4(texture2D(uVideo, uv).rgb, uOpacity);
        }
      `,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headReady, texture])

  // Head PERSPECTIVE-homography material: the fixed homography shader + a live
  // `uWorldOffset` (wpos − refHead + lensOffset) subtracted from the world coord,
  // so the rectified top-down patch follows the head. Updated each frame.
  const headHomoMaterial = useMemo(() => {
    if (!usingHeadHomo || !headHomoUMat || !texture) return null
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: {
        uVideo: { value: texture },
        uMat: { value: headHomoUMat },
        uOpacity: { value: overlayOpacity },
        uK: { value: distortK },
        uWorldOffset: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: /* glsl */ `
        varying vec2 vWorld;
        void main() { vWorld = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        uniform sampler2D uVideo; uniform mat3 uMat; uniform float uOpacity; uniform float uK; uniform vec2 uWorldOffset;
        varying vec2 vWorld;
        ${UNDISTORT_GLSL}
        void main() {
          vec3 q = uMat * vec3(vWorld - uWorldOffset, 1.0);
          if (abs(q.z) < 1e-8) discard;
          vec2 uv = kmUndistort(q.xy / q.z, uK);
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
          gl_FragColor = vec4(texture2D(uVideo, vec2(uv.x, 1.0 - uv.y)).rgb, uOpacity);
        }
      `,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usingHeadHomo, headHomoUMat, texture])

  const material = usingHeadHomo ? headHomoMaterial : isHead ? headMaterial : fixedMaterial
  useEffect(() => () => material?.dispose(), [material])

  // ── persistent bed mosaic (opt-in) ─────────────────────────────────────────
  const mosaicEnabled = useBedMosaic((s) => s.enabled)
  const toolMaskState = useToolMask()
  const maskRect = useMemo(() => maskRectArray(toolMaskState), [toolMaskState])
  const worldOffsetRef = useRef<[number, number]>([0, 0])
  // world→texture-uv matrix in BedMosaic's convention. FIXED: the absolute uMat.
  // HEAD: maps a bed-offset-from-camera → uv (v-row negated to match BedMosaic's
  // (uv.x, 1-uv.y) sampling vs. the head overlay's direct-uv quad); the live head
  // position is supplied separately via worldOffset (negated).
  const mosaicMat = useMemo<THREE.Matrix3 | null>(() => {
    if (!isHead) return uMat
    // Head + perspective homography: the same world→uv matrix the overlay uses.
    if (headHomoUMat) return headHomoUMat
    if (!effHeadMap || !(frameW > 0) || !(frameH > 0)) return null
    const [a, b, c, d] = effHeadMap
    const det = a * d - b * c
    if (Math.abs(det) < 1e-12) return null
    const i00 = d / det
    const i01 = -b / det
    const i10 = -c / det
    const i11 = a / det
    const m = new THREE.Matrix3()
    m.set(i00 / frameW, i01 / frameW, 0.5, -i10 / frameH, -i11 / frameH, 0.5, 0, 0, 1)
    return m
  }, [isHead, uMat, headHomoUMat, effHeadMap, frameW, frameH])

  // Per-frame: push opacity + distortion, and (head) recompute the patch corners
  // from the live machine XY so it pans with the head, anchored on the bed.
  const headMeshRef = useRef<THREE.Mesh | null>(null)
  const matRef = useRef<THREE.ShaderMaterial | null>(null)
  matRef.current = material
  useFrame(() => {
    const m = matRef.current
    if (m) {
      m.uniforms.uOpacity.value = overlayOpacity
      m.uniforms.uK.value = distortK
    }
    const { x: wx, y: wy } = useMachine.getState().wpos
    if (usingHeadHomo) {
      // Perspective top-down: world offset = (wpos − refHead) + lensOffset.
      const ox = wx - headRefMm[0] + offsetMm[0]
      const oy = wy - headRefMm[1] + offsetMm[1]
      const u = matRef.current?.uniforms?.uWorldOffset?.value as THREE.Vector2 | undefined
      if (u) u.set(ox, oy)
      // Mosaic samples bed-offset-from-camera → feed −offset.
      worldOffsetRef.current[0] = -ox
      worldOffsetRef.current[1] = -oy
    } else if (isHead && headGeom && effHeadMap && headMeshRef.current) {
      const ox = wx + offsetMm[0]
      const oy = wy + offsetMm[1]
      const [a, b, c, d] = effHeadMap
      const posAttr = headGeom.getAttribute('position') as THREE.BufferAttribute
      for (let i = 0; i < headCorners.length; i++) {
        const [du, dv] = headCorners[i].off
        // bed-mm offset = headMap · (du,dv); world = machine XY + offset + that.
        posAttr.setXYZ(i, ox + a * du + b * dv, oy + c * du + d * dv, 0.02)
      }
      posAttr.needsUpdate = true
      headGeom.computeBoundingSphere()
      worldOffsetRef.current[0] = -ox
      worldOffsetRef.current[1] = -oy
    }
    // Fixed camera: mosaic maps absolute world → uv, no offset.
    if (!isHead) {
      worldOffsetRef.current[0] = 0
      worldOffsetRef.current[1] = 0
    }
  })

  if (!enabled && !mosaicEnabled) return null

  // The persistent mosaic layer (self-gates on its own `enabled`); sits just below
  // the live overlay. Sharing the live video + the same image→bed mapping.
  const mosaic = (
    <BedMosaic
      videoTexture={texture}
      imageToBedMat={mosaicMat}
      worldOffset={worldOffsetRef.current}
      maskRect={maskRect}
    />
  )

  const overlay = (() => {
    if (!enabled) return null
    if (overlayReady && material) {
      if (isHead && headGeom) {
        return <mesh ref={headMeshRef} geometry={headGeom} material={material} />
      }
      return (
        <mesh position={[0, 0, 0.02]} material={material}>
          <planeGeometry args={[bedW, bedD]} />
        </mesh>
      )
    }
    // Enabled but not usable yet: faint placeholder so the toggle is visible.
    const accent = theme === 'dark' ? '#38bdf8' : '#0284c7'
    return (
      <mesh position={[0, 0, 0.02]}>
        <planeGeometry args={[bedW, bedD]} />
        <meshBasicMaterial color={accent} transparent opacity={0.12} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
    )
  })()

  return (
    <>
      {mosaic}
      {overlay}
    </>
  )
}
