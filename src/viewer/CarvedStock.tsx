import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { useStock } from '../store/stock'
import { stockBounds } from '../core/stock'
import {
  getMaterial,
  DEFAULT_MATERIAL_ID,
  type MaterialCategory,
} from '../core/materials'
import {
  createRemovalHeightmap,
  sweepRemoval,
  type SimSegmentLike,
} from '../core/simulation'
import { useSettings } from '../store'
import type { Segment } from './gcodeToPolylines'

interface CarvedStockProps {
  /** Parsed/sim segments (same {from,to,kind} the toolpath uses). */
  segments: Segment[]
  /** Index of the active segment (segments before it are fully done). */
  revealIndex: number
  /** Reveal point on the active segment (partial sweep), or null. */
  revealPoint?: [number, number, number] | null
  /** Cutter radius (mm) used to thicken each swept move. */
  toolRadius: number
  /** Visible? Default true. */
  visible?: boolean
}

/**
 * Material-removal simulation surface. The stock is a heightmap mesh that starts
 * flat at the stock top and is progressively carved down by the CUT moves up to
 * the playback reveal point — so the already-machined region shows its cut
 * surface while the rest stays raw stock. Sits inside the translucent
 * {@link StockBlock} wireframe.
 *
 * Performance: the grid + geometry are kept in refs and updated INCREMENTALLY —
 * forward playback only sweeps newly-completed segments (O(total segments) over a
 * whole run, not O(segments²)); a full rebuild happens only when the program,
 * stock, or tool changes, or when the user scrubs backward. The math is pure
 * (core/simulation); this component just maps the grid to a three.js surface.
 */
export function CarvedStock({
  segments,
  revealIndex,
  revealPoint,
  toolRadius,
  visible = true,
}: CarvedStockProps) {
  const theme = useSettings((s) => s.theme)
  const width = useStock((s) => s.width)
  const depth = useStock((s) => s.depth)
  const height = useStock((s) => s.height)
  const xyOrigin = useStock((s) => s.xyOrigin)
  const zRef = useStock((s) => s.zRef)
  const materialId = useStock((s) => s.materialId)

  // Stock box in work coordinates (Z-up). The top face is the carve start height.
  //
  // Alignment: the heightmap's XY footprint must cover wherever the toolpath
  // actually runs, otherwise the carved surface sits offset from (or misses) the
  // toolpath — e.g. when the configured stock is centred on the work origin but
  // the generated job lives in a corner (frontLeft-style coordinates), or when
  // the toolpath simply pokes past the stock edge. So we UNION the configured
  // stock footprint with the toolpath's cut XY extent. Z still references the
  // stock faces (stock top = the program's Z0 reference) so the surface starts
  // exactly at Z0 and carves downward in step with the toolpath's Z.
  const box = useMemo(() => {
    const { min, max } = stockBounds({ dims: { width, depth, height }, xyOrigin, zRef })
    const okStock =
      max[0] - min[0] > 1e-6 && max[1] - min[1] > 1e-6 && max[2] - min[2] > 1e-6

    // Toolpath XY bounds from the CUT moves (rapids don't remove material).
    let tx0 = Infinity
    let ty0 = Infinity
    let tx1 = -Infinity
    let ty1 = -Infinity
    let anyCut = false
    for (const s of segments) {
      if (s.kind !== 'cut') continue
      anyCut = true
      tx0 = Math.min(tx0, s.from[0], s.to[0])
      ty0 = Math.min(ty0, s.from[1], s.to[1])
      tx1 = Math.max(tx1, s.from[0], s.to[0])
      ty1 = Math.max(ty1, s.from[1], s.to[1])
    }

    if (!okStock) {
      // No usable stock: fall back to the toolpath footprint alone so a carve
      // surface still appears aligned under the cuts.
      if (!anyCut) return null
      const pad = toolRadius * 2
      return {
        min: [tx0 - pad, ty0 - pad, min[2]] as [number, number, number],
        max: [tx1 + pad, ty1 + pad, max[2]] as [number, number, number],
      }
    }

    if (!anyCut) return { min, max }

    // Union the stock footprint with the toolpath extent (padded by the cutter
    // radius so edge cuts are fully represented), keeping the stock's Z range.
    const pad = toolRadius
    return {
      min: [
        Math.min(min[0], tx0 - pad),
        Math.min(min[1], ty0 - pad),
        min[2],
      ] as [number, number, number],
      max: [
        Math.max(max[0], tx1 + pad),
        Math.max(max[1], ty1 + pad),
        max[2],
      ] as [number, number, number],
    }
  }, [width, depth, height, xyOrigin, zRef, segments, toolRadius])

  // Build the flat heightmap grid + plane geometry when the program/stock/tool
  // changes. This is a PURE computation (no ref writes / side effects during
  // render): it returns a freshly-allocated heightmap (uncut, flat at the stock
  // top) and a matching plane geometry. The carve is applied separately in the
  // layout effect below, so the grid the geometry was built from is always the
  // exact grid we sweep — no render-phase desync (which previously left the
  // surface flat or out of sync with the committed mesh under StrictMode /
  // concurrent rendering).
  const built = useMemo(() => {
    if (!visible || !box || segments.length === 0) return null
    const hm = createRemovalHeightmap({
      min: [box.min[0], box.min[1]],
      max: [box.max[0], box.max[1]],
      topZ: box.max[2],
      floorZ: box.min[2],
      toolRadius,
    })

    const { nx, ny, x0, y0, dx, dy, z } = hm
    if (!isFinite(x0) || !isFinite(y0) || !isFinite(dx) || !isFinite(dy)) {
      return null // degenerate footprint → no surface (fail flat, no crash)
    }
    const positions = new Float32Array(nx * ny * 3)
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const i = iy * nx + ix
        positions[i * 3] = x0 + ix * dx
        positions[i * 3 + 1] = y0 + iy * dy
        positions[i * 3 + 2] = z[i]
      }
    }
    const indices: number[] = []
    for (let iy = 0; iy < ny - 1; iy++) {
      for (let ix = 0; ix < nx - 1; ix++) {
        const a = iy * nx + ix
        const b = a + 1
        const c = a + nx
        const d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    g.setIndex(indices)
    g.computeVertexNormals()
    return { hm, geometry: g }
  }, [visible, box, toolRadius, segments])

  const geom = built?.geometry ?? null

  // How many segments have already been swept into the CURRENT grid (`built`).
  const appliedRef = useRef(0)
  // Last partial reveal point we meshed (to throttle sub-cell updates).
  const lastRpRef = useRef<[number, number, number] | null>(null)
  // Which `built` instance the counters above belong to. When `built` changes
  // (new program/stock/tool) the new grid is uncut, so we reset and re-apply.
  const builtRef = useRef<typeof built>(null)

  // Apply the carve up to the current reveal, and push the updated Z into the
  // mesh. Runs on every reveal tick AND whenever `built` changes (new program /
  // stock / tool): a fresh `built` arrives uncut, so we reset the applied
  // counter and carve 0..revealIndex from scratch in this same commit — the
  // surface is therefore never shown flat for a frame after a rebuild.
  //
  // Forward progress sweeps only newly-completed segments (O(total segments)
  // over a run, never O(segments²)); a backward scrub re-flattens and re-applies
  // 0..revealIndex. A layout effect (not a passive effect) so the carved Z is in
  // place before the browser paints the committed mesh.
  useLayoutEffect(() => {
    if (!built) return
    const { hm, geometry: g } = built

    // Fresh grid? A new `built` arrives uncut, so reset the incremental sweep
    // counter to 0 before applying. (Done here — not in a separate effect —
    // so it can't be ordered AFTER the sweep on a rebuild commit.)
    if (builtRef.current !== built) {
      builtRef.current = built
      appliedRef.current = 0
      lastRpRef.current = null
    }

    const idx = Math.max(0, Math.min(revealIndex, segments.length))

    // Throttle remeshing: when the grid is unchanged, no new segment completed,
    // and the partial reveal point barely moved, skip the (sub-pixel) rebuild.
    const idxChanged = idx !== appliedRef.current
    const movedEnough =
      !lastRpRef.current ||
      !revealPoint ||
      Math.hypot(
        revealPoint[0] - lastRpRef.current[0],
        revealPoint[1] - lastRpRef.current[1],
      ) >=
        Math.min(hm.dx, hm.dy) * 0.5
    if (idx >= appliedRef.current && !idxChanged && !movedEnough) return

    // Backward scrub → re-flatten and re-apply from the start of THIS grid.
    if (idx < appliedRef.current) {
      hm.z.fill(hm.topZ)
      appliedRef.current = 0
    }

    sweepRemoval(
      hm,
      segments as SimSegmentLike[],
      appliedRef.current,
      idx,
      toolRadius,
      revealPoint ?? null,
    )
    appliedRef.current = idx
    lastRpRef.current = revealPoint ?? null

    // Rewrite only the Z component of each vertex from the (updated) grid.
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const arr = pos.array as Float32Array
    const z = hm.z
    for (let i = 0; i < z.length; i++) arr[i * 3 + 2] = z[i]
    pos.needsUpdate = true
    g.computeVertexNormals()
    g.computeBoundingSphere()
  }, [built, revealIndex, revealPoint, segments, toolRadius])

  // Dispose the geometry when it is replaced / on unmount.
  useLayoutEffect(() => {
    return () => {
      built?.geometry.dispose()
    }
  }, [built])

  if (!geom || !box) return null

  const mat = getMaterial(materialId) ?? getMaterial(DEFAULT_MATERIAL_ID)!
  const color = materialColor(mat.category, theme === 'dark')

  return (
    <mesh geometry={geom}>
      <meshStandardMaterial
        color={color}
        roughness={0.85}
        metalness={0.05}
        side={THREE.DoubleSide}
      />
    </mesh>
  )
}

/** Plausible solid-surface colour per material family (dark/light tuned). */
function materialColor(category: MaterialCategory, dark: boolean): string {
  switch (category) {
    case 'wood':
      return dark ? '#b5894f' : '#c89b6a'
    case 'plastic':
      return dark ? '#5b8fb0' : '#7fb3d0'
    case 'pcb':
      return dark ? '#2f8f5b' : '#3aa86c'
    case 'metal':
      return dark ? '#9aa3ad' : '#b3bcc6'
    case 'foam':
      return dark ? '#c8b06a' : '#ddc888'
    default:
      return dark ? '#9a8c78' : '#b6a890'
  }
}
