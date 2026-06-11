import { Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import * as THREE from 'three'
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url'
import { useT } from '../i18n'

/**
 * Interactive 3D controller carousel for the gamepad modal. Both controllers are
 * the ORIGINAL STEP CAD files, tessellated in-browser by occt-import-js
 * (OpenCASCADE WASM) — so they render at full quality with their real per-face
 * colors (Xbox; PlayStation "Pikachu" DualSense). STEP is B-rep CAD and must be
 * tessellated to render in WebGL; occt does that client-side. Each download is
 * CacheFirst-cached by the service worker (vite.config) so the MBs are fetched
 * once and served from cache afterwards. Meshes are normalized in-geometry
 * (centered, scaled to unit) so a fixed camera frames either consistently.
 */

const FALLBACK_COLOR = '#cdd2dc'

/** Normalize a group of geometries together (center + scale to unit, smooth). */
function fitGroup(geos: THREE.BufferGeometry[]) {
  const box = new THREE.Box3()
  for (const g of geos) {
    g.computeVertexNormals()
    g.computeBoundingBox()
    if (g.boundingBox) box.union(g.boundingBox)
  }
  if (box.isEmpty()) return geos
  const c = new THREE.Vector3()
  const sz = new THREE.Vector3()
  box.getCenter(c)
  box.getSize(sz)
  const s = 1 / Math.max(sz.x, sz.y, sz.z, 1e-6)
  for (const g of geos) {
    g.translate(-c.x, -c.y, -c.z)
    g.scale(s, s, s)
  }
  return geos
}

/** Centered spinner shown (inside the canvas) while a model loads. */
function Loading3D({ label }: { label: string }) {
  return (
    <Html center>
      <div className="gp3d-loading">
        <Loader2 size={22} className="gp3d-spin" aria-hidden="true" />
        <span>{label}</span>
      </div>
    </Html>
  )
}

// occt-import-js is heavy (WASM) — load it lazily and cache parsed geometry.
type StepPart = { geo: THREE.BufferGeometry; color: number[] | null }
const stepCache = new Map<string, StepPart[]>()

/** A STEP controller tessellated in-browser by OpenCASCADE (occt-import-js). */
function StepModel({ url, t }: { url: string; t: ReturnType<typeof useT> }) {
  const [geos, setGeos] = useState<StepPart[] | null>(() => stepCache.get(url) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (stepCache.has(url)) {
      setGeos(stepCache.get(url)!)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const factory = (await import('occt-import-js')).default as (
          opts?: { locateFile?: (p: string) => string },
        ) => Promise<{
          ReadStepFile: (
            content: Uint8Array,
            params: unknown,
          ) => {
            success: boolean
            meshes: Array<{
              attributes: { position: { array: ArrayLike<number> } }
              index?: { array: ArrayLike<number> }
              color?: number[]
            }>
          }
        }>
        const occt = await factory({ locateFile: () => occtWasmUrl })
        const buf = new Uint8Array(await (await fetch(url)).arrayBuffer())
        const result = occt.ReadStepFile(buf, null)
        if (!result?.success) throw new Error('STEP parse failed')
        const out: StepPart[] = []
        for (const m of result.meshes) {
          const g = new THREE.BufferGeometry()
          g.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(Float32Array.from(m.attributes.position.array), 3),
          )
          if (m.index?.array) g.setIndex(Array.from(m.index.array))
          out.push({ geo: g, color: m.color ?? null })
        }
        fitGroup(out.map((o) => o.geo))
        stepCache.set(url, out)
        if (alive) setGeos(out)
      } catch (e) {
        console.error('[GamepadModel3D] STEP load failed', e)
        if (alive) setFailed(true)
      }
    })()
    return () => {
      alive = false
    }
  }, [url])

  if (failed) {
    return (
      <Html center>
        <div className="gp3d-loading">{t('gp3d.loadErr', 'Could not load model')}</div>
      </Html>
    )
  }
  if (!geos) return <Loading3D label={t('gp3d.loading', 'Loading model…')} />
  return (
    <group>
      {geos.map(({ geo, color }, i) => (
        <mesh key={i} geometry={geo}>
          <meshStandardMaterial
            color={color ? new THREE.Color(color[0], color[1], color[2]) : FALLBACK_COLOR}
            metalness={0.2}
            roughness={0.5}
          />
        </mesh>
      ))}
    </group>
  )
}

interface ControllerDef {
  id: 'playstation' | 'xbox'
  name: string
  url: string
}

export function GamepadModel3D({ detectedType }: { detectedType?: string | null }) {
  const t = useT()
  const controllers = useMemo<ControllerDef[]>(
    () => [
      { id: 'playstation', name: t('gp.model.ps', 'PlayStation'), url: '/controllers_3d/ps5.step' },
      { id: 'xbox', name: t('gp.model.xbox', 'Xbox'), url: '/controllers_3d/xbox.step' },
    ],
    [t],
  )

  const [index, setIndex] = useState(() => {
    const i = controllers.findIndex((c) => c.id === detectedType)
    return i >= 0 ? i : 0
  })
  const [dir, setDir] = useState<1 | -1>(1)
  const go = (d: 1 | -1) => {
    setDir(d)
    setIndex((i) => (i + d + controllers.length) % controllers.length)
  }
  const cur = controllers[index]

  return (
    <div className="gp3d">
      <button
        type="button"
        className="gp3d-arrow gp3d-arrow--l"
        onClick={() => go(-1)}
        aria-label={t('gp3d.prev', 'Previous controller')}
        title={t('gp3d.prev', 'Previous controller')}
      >
        <ChevronLeft size={20} />
      </button>

      <div className="gp3d-stage" key={cur.id} data-dir={dir > 0 ? 'r' : 'l'}>
        <Canvas camera={{ position: [0, 0.95, 2.1], fov: 42 }} dpr={[1, 2]}>
          <ambientLight intensity={0.8} />
          <directionalLight position={[3, 4, 5]} intensity={1.2} />
          <directionalLight position={[-3, 2, -4]} intensity={0.5} />
          <Suspense fallback={<Loading3D label={t('gp3d.loading', 'Loading model…')} />}>
            <StepModel url={cur.url} t={t} />
          </Suspense>
          <OrbitControls
            autoRotate
            autoRotateSpeed={1.1}
            enablePan={false}
            enableZoom
            target={[0, 0, 0]}
            minDistance={1.2}
            maxDistance={6}
          />
        </Canvas>
        <span className="gp3d-name">{cur.name}</span>
      </div>

      <button
        type="button"
        className="gp3d-arrow gp3d-arrow--r"
        onClick={() => go(1)}
        aria-label={t('gp3d.next', 'Next controller')}
        title={t('gp3d.next', 'Next controller')}
      >
        <ChevronRight size={20} />
      </button>
    </div>
  )
}
