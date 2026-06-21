// 3D surface PREVIEW + picker — the per-surface analogue of FeatureViewer.
// ----------------------------------------------------------------------------
// Renders an STL mesh with each segmented near-coplanar REGION tinted a distinct
// colour. Left-click a region to select it; right-click opens a quick-add menu
// (portaled to <body> so it's never clipped) to drop a preset onto that
// surface's operations. Selected/hovered regions are highlighted. All CAM logic
// lives in the pure core (`core/meshSegment.ts`) + the parent panel; this is a
// thin presentational component.
//
// Surface keys are `${fileId}#s${regionId}` (see featureCam.surfaceKey) so they
// never collide with 2D loop keys.

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import * as THREE from 'three'
import type { StlMesh } from '../../core/slicer'
import { STL_STRIDE } from '../../core/slicer'
import type { SurfaceRegion } from '../../core/meshSegment'
import { surfaceKey, type FeatureOpMap, type FeaturePreset } from '../../core/featureCam'
import { useT } from '../../i18n'
import '../../styles/featureViewer.css'

interface Props {
  fileId: string
  mesh: StlMesh
  regions: SurfaceRegion[]
  opMap: FeatureOpMap
  presets: FeaturePreset[]
  onQuickAdd: (key: string, preset: FeaturePreset) => void
  selected: string | null
  setSelected: (key: string | null) => void
  t: ReturnType<typeof useT>
}

// Distinct, deterministic region palette (by sorted region id).
const REGION_COLORS = [
  '#38bdf8', '#f472b6', '#a3e635', '#fbbf24', '#c084fc', '#fb7185',
  '#34d399', '#60a5fa', '#facc15', '#f87171', '#2dd4bf', '#e879f9',
  '#bef264', '#fdba74', '#7dd3fc', '#fca5a5', '#86efac', '#93c5fd',
]
function regionColor(id: number): string {
  return REGION_COLORS[id % REGION_COLORS.length]
}

export function SurfaceViewer({
  fileId,
  mesh,
  regions,
  opMap,
  presets,
  onQuickAdd,
  selected,
  setSelected,
  t,
}: Props) {
  const [menu, setMenu] = useState<{ regionId: number; x: number; y: number } | null>(null)
  const [hovered, setHovered] = useState<number | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Map each ORIGINAL triangle index → its region id (for raycast → region).
  // Unassigned triangles (specks/sloped leftovers below the cap) map to -1 and
  // stay on the whole-mesh relief fallback.
  const triToRegion = useMemo(() => {
    const map = new Map<number, number>()
    for (const r of regions) for (const ti of r.triIndices) map.set(ti, r.id)
    return map
  }, [regions])

  // Build a geometry whose per-vertex colour encodes the region. We render
  // triangles in their ORIGINAL order so faceIndex maps directly to triangle idx.
  const geom = useMemo(() => {
    const triCount = mesh.triangleCount
    const positions = new Float32Array(triCount * 9)
    const colors = new Float32Array(triCount * 9)
    const tmp = new THREE.Color()
    let p = 0
    for (let t = 0; t < triCount; t++) {
      const rid = triToRegion.get(t)
      if (rid != null) tmp.set(regionColor(rid))
      else tmp.set('#3a4250') // unassigned → neutral
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * STL_STRIDE
        positions[p] = mesh.triangles[o]
        positions[p + 1] = mesh.triangles[o + 1]
        positions[p + 2] = mesh.triangles[o + 2]
        colors[p] = tmp.r
        colors[p + 1] = tmp.g
        colors[p + 2] = tmp.b
        p += 3
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    g.computeVertexNormals()
    g.computeBoundingSphere()
    return g
  }, [mesh, triToRegion])

  // Highlight overlay geometry for the selected + hovered region (drawn brighter
  // and slightly offset toward the camera via polygonOffset so it reads on top).
  const selRegionId = useMemo(() => {
    if (!selected) return null
    const r = regions.find((rg) => surfaceKey(fileId, rg.id) === selected)
    return r ? r.id : null
  }, [selected, regions, fileId])

  const highlightGeom = useMemo(() => {
    const id = hovered ?? selRegionId
    if (id == null) return null
    const r = regions.find((rg) => rg.id === id)
    if (!r) return null
    const positions = new Float32Array(r.triIndices.length * 9)
    let p = 0
    for (const t of r.triIndices) {
      for (let k = 0; k < 3; k++) {
        const o = (t * 3 + k) * STL_STRIDE
        positions[p++] = mesh.triangles[o]
        positions[p++] = mesh.triangles[o + 1]
        positions[p++] = mesh.triangles[o + 2]
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.computeVertexNormals()
    return g
  }, [hovered, selRegionId, regions, mesh])

  const highlightColor = useMemo(() => {
    const id = hovered ?? selRegionId
    return id == null ? '#ffffff' : regionColor(id)
  }, [hovered, selRegionId])

  const { center, radius } = useMemo(() => {
    const c: [number, number, number] = [
      (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2,
      (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2,
      (mesh.bbox.min[2] + mesh.bbox.max[2]) / 2,
    ]
    const r = Math.max(
      mesh.bbox.max[0] - mesh.bbox.min[0],
      mesh.bbox.max[1] - mesh.bbox.min[1],
      mesh.bbox.max[2] - mesh.bbox.min[2],
      1,
    )
    return { center: c, radius: r }
  }, [mesh])

  // Close the quick-add menu on outside click / Escape.
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!bodyRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  function regionFromEvent(e: ThreeEvent<MouseEvent>): number | null {
    if (e.faceIndex == null) return null
    const rid = triToRegion.get(e.faceIndex)
    return rid == null ? null : rid
  }

  function onMeshClick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation()
    const rid = regionFromEvent(e)
    if (rid == null) return
    const key = surfaceKey(fileId, rid)
    setSelected(selected === key ? null : key)
  }

  function onMeshContextMenu(e: ThreeEvent<MouseEvent>) {
    e.nativeEvent.preventDefault()
    e.stopPropagation()
    const rid = regionFromEvent(e)
    if (rid == null) return
    setSelected(surfaceKey(fileId, rid))
    const mw = 220
    const mh = 40 + presets.length * 30
    const x = Math.min(e.nativeEvent.clientX, window.innerWidth - mw - 8)
    const y = Math.min(e.nativeEvent.clientY, window.innerHeight - mh - 8)
    setMenu({ regionId: rid, x: Math.max(8, x), y: Math.max(8, y) })
  }

  if (regions.length === 0) {
    return (
      <div className="fv-body sv-body">
        <div className="sv-empty">{t('sv.none', 'No surfaces detected — use whole-model relief carving.')}</div>
      </div>
    )
  }

  return (
    <div className="fv-body sv-body" ref={bodyRef}>
      <div className="sv-canvas">
        <Canvas
          style={{ height: '100%', width: '100%' }}
          camera={{
            position: [center[0] + radius * 1.6, center[1] - radius * 1.6, center[2] + radius * 1.4],
            up: [0, 0, 1],
            fov: 45,
            near: 0.1,
            far: radius * 100 + 1000,
          }}
          onCreated={({ camera }) => camera.lookAt(center[0], center[1], center[2])}
        >
          <color attach="background" args={['#15181c']} />
          <ambientLight intensity={0.75} />
          <directionalLight position={[radius, -radius, radius * 2]} intensity={0.7} />
          <directionalLight position={[-radius, radius, radius]} intensity={0.35} />
          <mesh
            geometry={geom}
            onClick={onMeshClick}
            onContextMenu={onMeshContextMenu}
            onPointerMove={(e) => {
              e.stopPropagation()
              setHovered(regionFromEvent(e))
            }}
            onPointerOut={() => setHovered(null)}
          >
            <meshStandardMaterial vertexColors metalness={0.05} roughness={0.85} flatShading />
          </mesh>
          {highlightGeom && (
            <mesh geometry={highlightGeom}>
              <meshStandardMaterial
                color={highlightColor}
                emissive={highlightColor}
                emissiveIntensity={0.55}
                metalness={0.1}
                roughness={0.5}
                flatShading
                polygonOffset
                polygonOffsetFactor={-2}
                polygonOffsetUnits={-2}
              />
            </mesh>
          )}
          <OrbitControls
            makeDefault
            enableDamping
            dampingFactor={0.12}
            target={center}
          />
        </Canvas>
      </div>

      {/* Region chips (also pickable; mirror the 3D selection). */}
      <div className="fv-chips" role="listbox" aria-label={t('sv.surfacesAria', 'Surfaces')}>
        {regions.map((r) => {
          const key = surfaceKey(fileId, r.id)
          const ops = opMap[key]
          const isSel = key === selected
          return (
            <button
              key={r.id}
              type="button"
              role="option"
              aria-selected={isSel}
              className={'fv-chip' + (isSel ? ' sel' : '')}
              onClick={() => setSelected(isSel ? null : key)}
              onMouseEnter={() => setHovered(r.id)}
              onMouseLeave={() => setHovered(null)}
              title={
                r.planar
                  ? t('sv.flatAt', 'Flat surface @ Z{z}', { z: r.z.toFixed(1) })
                  : t('sv.sloped', 'Sloped/curved surface')
              }
            >
              <span className="fv-chip-dot" style={{ background: regionColor(r.id) }} />
              <span className="fv-chip-lbl">#{r.id + 1}</span>
              {ops && ops.length > 0 && <span className="fv-chip-badge">{ops.length}</span>}
            </button>
          )
        })}
      </div>

      {/* Right-click quick-add menu (portaled to <body>). */}
      {menu && createPortal(
        <div
          ref={menuRef}
          className="fv-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}
          role="menu"
          aria-label={t('sv.quickAdd', 'Add preset to surface')}
        >
          <div className="fv-menu-head">
            {t('sv.addToSurface', 'Add to Surface {n}', { n: menu.regionId + 1 })}
          </div>
          {presets.map((p) => {
            const region = regions.find((r) => r.id === menu.regionId)
            // Area ops (Pocket/Profile/Cutout) need a roughly flat region to build
            // a usable XY outline; Engrave is allowed anywhere (it rides the line).
            const incompatible = p.op !== 'Engrave' && !(region?.planar ?? false)
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="fv-menu-item"
                disabled={incompatible}
                onClick={() => {
                  onQuickAdd(surfaceKey(fileId, menu.regionId), p)
                  setMenu(null)
                }}
                title={
                  incompatible
                    ? t('sv.needFlat', '{name} needs a flat surface', { name: p.name })
                    : t('fv.addPreset', 'Add “{name}” to this surface', { name: p.name })
                }
              >
                <span className="fv-menu-sw" style={{ background: p.color }} />
                <span className="fv-menu-lbl">{p.name}</span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
