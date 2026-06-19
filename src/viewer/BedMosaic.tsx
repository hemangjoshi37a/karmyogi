import { useEffect, useMemo, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useBed } from '../store/bed'
import { useBedMosaic } from '../store/bedMosaic'

/**
 * BedMosaic — a PERSISTENT top-down "mosaic" of the whole bed that accumulates
 * the moving head-camera's view over time. As the head pans, each live patch is
 * stamped into a render-target at its real bed location; areas currently out of
 * frame stay visible from when they were last seen, so the buffer fills in to a
 * complete picture of the bed.
 *
 * ── How it works ────────────────────────────────────────────────────────────
 * We keep a PERSISTENT pair of WebGLRenderTargets (ping-pong) sized
 * resolutionPx × resolutionPx·aspect, each pixel mapping linearly to a bed-mm
 * coordinate (the whole [-W/2..+W/2] × [-D/2..+D/2] rectangle). The buffer is
 * NOT cleared per frame. Each frame, when a live source is present, we render
 * `read` (previous mosaic) PLUS the freshly-sampled camera patch into `write`,
 * then swap read↔write — so prior content survives and only the newly-seen area
 * is updated. The accumulation is wiped only when the store's `clearSignal`
 * changes. The accumulated `read` texture is then displayed on a plane covering
 * the bed, sitting just below the live overlay (z = 0.015).
 *
 * The compositor fragment shader maps each mosaic pixel → bed-mm → world-mm
 * (adding `worldOffset`, the live head XY) → camera uv via `imageToBedMat`
 * (world→texture uv, the SAME convention as CameraBedPlane's `uMat`). Pixels
 * whose world point falls inside the live frame take the camera colour;
 * everything else keeps the previous mosaic. An optional `maskRect` (normalized
 * uv) carves out a region of the camera frame (e.g. a fixed tool/nozzle that is
 * always in view) so it is never painted into the mosaic.
 *
 * ── Interface (props — supplied by the mounting code) ───────────────────────
 *   videoTexture : THREE.Texture | null
 *       The live camera frame as a texture (e.g. a THREE.VideoTexture with
 *       flipY=false, like CameraBedPlane builds). null ⇒ nothing to accumulate.
 *   imageToBedMat : THREE.Matrix3 | null
 *       world(x,y) → texture uv homography (row-major 3×3), SAME convention as
 *       CameraBedPlane's `uMat`: uv = (M·[wx,wy,1]).xy / .z, then the shader
 *       samples texture at (uv.x, 1-uv.y). null ⇒ no valid mapping, render the
 *       existing mosaic only (no new paint).
 *   worldOffset : [number, number]
 *       Live head XY (mm) added to the bed-mm coordinate before mapping through
 *       imageToBedMat. For a head camera whose homography is expressed in
 *       head-local coordinates, pass the live machine XY (+lens offset). For a
 *       fixed full-bed camera whose homography is already in world-mm, pass
 *       [0,0].
 *   maskRect? : [x, y, w, h] | null
 *       Optional rect in normalized camera uv (0..1, origin top-left to match
 *       the sampled (uv.x,1-uv.y)). Pixels sampling INSIDE this rect are skipped
 *       (left as previous mosaic) — use it to exclude a fixed tool region.
 *
 * Store (`useBedMosaic`): `enabled`, `resolutionPx`, `opacity`, `clearSignal`.
 * Bed size from `useBed` (width=X, depth=Y). SSR-safe (all GL work happens in
 * R3F effects/frames); disposes all GL resources on unmount.
 */

export interface BedMosaicProps {
  videoTexture?: THREE.Texture | null
  imageToBedMat?: THREE.Matrix3 | null
  worldOffset?: [number, number]
  /** Region of the camera frame (normalized uv, top-left origin) to NOT paint. */
  maskRect?: [number, number, number, number] | null
}

// Full-screen-triangle vertex shader for the compositor pass (NDC quad).
const COMPOSITE_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Composites the previous mosaic with the current camera patch. vUv runs 0..1
// across the bed; we turn it into bed-mm, add the live world offset, map to the
// camera uv, and keep the previous colour wherever the camera doesn't see.
const COMPOSITE_FRAG = /* glsl */ `
  precision highp float;
  uniform sampler2D uPrev;     // previous accumulated mosaic
  uniform sampler2D uVideo;    // live camera frame
  uniform mat3 uMat;           // world(x,y) -> texture uv
  uniform vec2 uBed;           // bed size (W, D) in mm
  uniform vec2 uOffset;        // live head world offset (mm)
  uniform float uHasVideo;     // 1.0 if a live patch should be painted
  uniform vec4 uMaskRect;      // (x,y,w,h) normalized uv; w<=0 => disabled
  varying vec2 vUv;

  void main() {
    vec3 prev = texture2D(uPrev, vUv).rgb;

    if (uHasVideo < 0.5) {
      gl_FragColor = vec4(prev, 1.0);
      return;
    }

    // mosaic pixel -> bed-mm (centered) -> world-mm
    vec2 bedmm = (vUv - 0.5) * uBed;
    vec2 world = bedmm + uOffset;

    vec3 q = uMat * vec3(world, 1.0);
    if (abs(q.z) < 1e-8) { gl_FragColor = vec4(prev, 1.0); return; }
    vec2 uv = q.xy / q.z;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
      gl_FragColor = vec4(prev, 1.0);
      return;
    }

    // Sampled coordinate (matches CameraBedPlane: texture at (uv.x, 1-uv.y)).
    vec2 samp = vec2(uv.x, 1.0 - uv.y);

    // Optional tool-region mask: skip painting inside the rect.
    if (uMaskRect.z > 0.0) {
      if (samp.x >= uMaskRect.x && samp.x <= uMaskRect.x + uMaskRect.z &&
          samp.y >= uMaskRect.y && samp.y <= uMaskRect.y + uMaskRect.w) {
        gl_FragColor = vec4(prev, 1.0);
        return;
      }
    }

    vec3 cam = texture2D(uVideo, samp).rgb;
    gl_FragColor = vec4(cam, 1.0);
  }
`

export function BedMosaic(props: BedMosaicProps) {
  const { videoTexture = null, imageToBedMat = null, worldOffset = [0, 0], maskRect = null } = props

  const enabled = useBedMosaic((s) => s.enabled)
  const resolutionPx = useBedMosaic((s) => s.resolutionPx)
  const opacity = useBedMosaic((s) => s.opacity)
  const clearSignal = useBedMosaic((s) => s.clearSignal)

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)

  const gl = useThree((s) => s.gl)

  // Target buffer dimensions: width = resolutionPx, height scaled by bed aspect.
  const rtW = Math.max(1, Math.round(resolutionPx))
  const rtH = Math.max(1, Math.round(resolutionPx * (bedD / Math.max(1e-6, bedW))))

  // ── persistent ping-pong render targets ────────────────────────────────────
  // Re-created when the buffer size changes; otherwise kept (so they accumulate).
  const targets = useMemo(() => {
    const make = () =>
      new THREE.WebGLRenderTarget(rtW, rtH, {
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer: false,
        stencilBuffer: false,
        colorSpace: THREE.SRGBColorSpace,
      })
    return { read: make(), write: make(), inited: false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rtW, rtH])

  useEffect(() => {
    return () => {
      targets.read.dispose()
      targets.write.dispose()
    }
  }, [targets])

  // ── offscreen compositor scene (full-screen triangle) ───────────────────────
  const composite = useMemo(() => {
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    const material = new THREE.ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uPrev: { value: null as THREE.Texture | null },
        uVideo: { value: null as THREE.Texture | null },
        uMat: { value: new THREE.Matrix3() },
        uBed: { value: new THREE.Vector2(bedW, bedD) },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uHasVideo: { value: 0 },
        uMaskRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
      vertexShader: COMPOSITE_VERT,
      fragmentShader: COMPOSITE_FRAG,
    })
    // Full-screen triangle (covers NDC, uv 0..2 → 0..1 across the screen).
    const geom = new THREE.BufferGeometry()
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3))
    geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
    const mesh = new THREE.Mesh(geom, material)
    mesh.frustumCulled = false
    scene.add(mesh)
    return { scene, camera, material, geom }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Keep the bed-size uniform in sync (cheap; runs on bed resize).
  useEffect(() => {
    composite.material.uniforms.uBed.value.set(bedW, bedD)
  }, [composite, bedW, bedD])

  useEffect(() => {
    return () => {
      composite.material.dispose()
      composite.geom.dispose()
    }
  }, [composite])

  // ── display material: shows the accumulated mosaic on the bed plane ─────────
  const displayMaterial = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        map: targets.read.texture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        opacity,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [targets],
  )
  useEffect(() => () => displayMaterial.dispose(), [displayMaterial])

  // Track when we last wiped so a clearSignal change forces a re-init.
  const lastClearRef = useRef(clearSignal)
  // Force a wipe whenever the buffers are (re)created too.
  useEffect(() => {
    targets.inited = false
  }, [targets])

  const displayMatRef = useRef(displayMaterial)
  displayMatRef.current = displayMaterial

  useFrame(() => {
    if (!enabled) return

    const { material } = composite
    const u = material.uniforms

    // Keep display opacity live.
    displayMatRef.current.opacity = opacity

    // Wipe both buffers on first use or when clearSignal changes.
    const needWipe = !targets.inited || lastClearRef.current !== clearSignal
    if (needWipe) {
      const prevRT = gl.getRenderTarget()
      const prevClear = new THREE.Color()
      gl.getClearColor(prevClear)
      const prevAlpha = gl.getClearAlpha()
      gl.setClearColor(0x000000, 0)
      gl.setRenderTarget(targets.read)
      gl.clear(true, false, false)
      gl.setRenderTarget(targets.write)
      gl.clear(true, false, false)
      gl.setRenderTarget(prevRT)
      gl.setClearColor(prevClear, prevAlpha)
      targets.inited = true
      lastClearRef.current = clearSignal
    }

    // Decide whether we have a live patch to paint this frame.
    const hasVideo = !!videoTexture && !!imageToBedMat
    u.uHasVideo.value = hasVideo ? 1 : 0
    u.uPrev.value = targets.read.texture
    if (hasVideo) {
      u.uVideo.value = videoTexture
      u.uMat.value.copy(imageToBedMat as THREE.Matrix3)
      u.uOffset.value.set(worldOffset[0], worldOffset[1])
      if (maskRect) u.uMaskRect.value.set(maskRect[0], maskRect[1], maskRect[2], maskRect[3])
      else u.uMaskRect.value.set(0, 0, 0, 0)
    }

    // If nothing to paint AND nothing was wiped, the read buffer already holds
    // the right pixels — skip the composite pass to save GPU.
    if (!hasVideo && !needWipe) return

    // Composite read+patch → write, then swap so `read` is the newest mosaic.
    const prevRT = gl.getRenderTarget()
    gl.setRenderTarget(targets.write)
    gl.render(composite.scene, composite.camera)
    gl.setRenderTarget(prevRT)

    const tmp = targets.read
    targets.read = targets.write
    targets.write = tmp
    displayMatRef.current.map = targets.read.texture
    displayMatRef.current.needsUpdate = true
  })

  if (!enabled) return null

  return (
    <mesh position={[0, 0, 0.015]} material={displayMaterial}>
      <planeGeometry args={[bedW, bedD]} />
    </mesh>
  )
}

export default BedMosaic
