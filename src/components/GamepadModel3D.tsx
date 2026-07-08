import { Suspense, useEffect, useMemo, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbitControls, Html } from '@react-three/drei'
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import * as THREE from 'three'
import { useT } from '../i18n'

/**
 * Interactive 3D controller carousel for the gamepad modal (Xbox; PlayStation
 * "Pikachu" DualSense), with their real per-face colors.
 *
 * PERF: the controllers are pre-tessellated at build time (scripts/bake-controllers.mjs
 * turns the original 6 MB STEP CAD files into compact ~1 MB mesh JSON under
 * public/controllers_3d/*.json). The runtime just fetches that JSON and builds a
 * BufferGeometry — a few milliseconds — instead of running OpenCASCADE (occt-import-js)
 * to tessellate B-rep CAD ON THE MAIN THREAD, which froze the whole page for many
 * seconds. Meshes are normalized in-geometry (centered, scaled to unit) so a fixed
 * camera frames either consistently.
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

// Pre-baked mesh JSON (positions/indices/color per mesh) — see the file header.
type MeshPart = { geo: THREE.BufferGeometry; color: number[] | null }
type BakedMesh = { position: number[]; index: number[] | null; color: number[] | null }
const meshCache = new Map<string, MeshPart[]>()

/** A controller loaded from pre-tessellated mesh JSON (no OCCT at runtime). */
function StepModel({ url, t }: { url: string; t: ReturnType<typeof useT> }) {
  const [geos, setGeos] = useState<MeshPart[] | null>(() => meshCache.get(url) ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (meshCache.has(url)) {
      setGeos(meshCache.get(url)!)
      return
    }
    let alive = true
    ;(async () => {
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error('model fetch failed')
        const data = (await res.json()) as { meshes: BakedMesh[] }
        const out: MeshPart[] = []
        for (const m of data.meshes) {
          const g = new THREE.BufferGeometry()
          g.setAttribute('position', new THREE.Float32BufferAttribute(Float32Array.from(m.position), 3))
          if (m.index) g.setIndex(m.index)
          out.push({ geo: g, color: m.color ?? null })
        }
        fitGroup(out.map((o) => o.geo))
        meshCache.set(url, out)
        if (alive) setGeos(out)
      } catch (e) {
        console.error('[GamepadModel3D] model load failed', e)
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
      { id: 'playstation', name: t('gp.model.ps', 'PlayStation'), url: '/controllers_3d/ps5.json' },
      { id: 'xbox', name: t('gp.model.xbox', 'Xbox'), url: '/controllers_3d/xbox.json' },
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
        <Canvas frameloop="demand" camera={{ position: [0, 0.95, 2.1], fov: 42 }} dpr={[1, 2]}>
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
