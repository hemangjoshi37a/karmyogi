import { useEffect, useMemo } from 'react'
import { Html } from '@react-three/drei'
import type { ThreeEvent } from '@react-three/fiber'
import * as THREE from 'three'
import { useStock } from '../store/stock'
import { stockBounds } from '../core/stock'
import { useSettings } from '../store'
import { useT } from '../i18n'

interface StockBlockProps {
  /** Visible? Hide to declutter the scene. Default true. */
  visible?: boolean
}

/**
 * The raw workpiece block, drawn from the stock store as a translucent box with
 * a brighter edge outline so the toolpath reads clearly against (and inside) it.
 *
 * Reads `useStock` (dims + origin/Z reference) and `stockBounds()` to compute the
 * box extents in WORK coordinates (work zero at origin, Z-up — same frame as the
 * bed grid and toolpath). Theme-aware colours mirror Bed/ToolMarker.
 *
 * C4 — VISUAL WORK-ORIGIN PICKER: when `pickingOrigin` is set (toggled from the
 * CAD/CAM panel), the box also renders clickable handles. Clicking the centre or
 * the front-left corner sets the XY origin; clicking the top or bottom face sets
 * the Z reference. The handles drive the stock store directly, so the whole
 * placement model stays in one place and the box/grid/toolpath reframe live.
 */
export function StockBlock({ visible = true }: StockBlockProps) {
  const theme = useSettings((s) => s.theme)

  const width = useStock((s) => s.width)
  const depth = useStock((s) => s.depth)
  const height = useStock((s) => s.height)
  const xyOrigin = useStock((s) => s.xyOrigin)
  const zRef = useStock((s) => s.zRef)
  const picking = useStock((s) => s.pickingOrigin)

  const geom = useMemo(() => {
    const { min, max } = stockBounds({
      dims: { width, depth, height },
      xyOrigin,
      zRef,
    })
    const sx = max[0] - min[0]
    const sy = max[1] - min[1]
    const sz = max[2] - min[2]
    // Degenerate stock (any zero extent) is not worth drawing.
    if (!(sx > 1e-6) || !(sy > 1e-6) || !(sz > 1e-6)) return null
    const cx = (min[0] + max[0]) / 2
    const cy = (min[1] + max[1]) / 2
    const cz = (min[2] + max[2]) / 2
    const box = new THREE.BoxGeometry(sx, sy, sz)
    const edges = new THREE.EdgesGeometry(box)
    return {
      box,
      edges,
      center: [cx, cy, cz] as [number, number, number],
      min,
      max,
    }
  }, [width, depth, height, xyOrigin, zRef])

  // Dispose geometries when they change / on unmount. MUST be useEffect — a
  // useMemo never runs its returned cleanup, so the box/edges would leak.
  useEffect(() => {
    return () => {
      geom?.box.dispose()
      geom?.edges.dispose()
    }
  }, [geom])

  // Render when the block is shown OR while the operator is picking the origin
  // (so toggling "Pick origin" reveals the handles even if the box was hidden).
  if ((!visible && !picking) || !geom) return null

  // Theme-aware: a faint fill plus a brighter wire, both restrained so the
  // toolpath stays the focus. Mirrors Bed.tsx's dark/light split.
  const fill = theme === 'dark' ? '#8aa0b8' : '#6b7c92'
  const edge = theme === 'dark' ? '#cbd5e1' : '#475569'

  return (
    <group position={geom.center}>
      <mesh geometry={geom.box}>
        <meshStandardMaterial
          color={fill}
          transparent
          opacity={picking ? 0.18 : 0.12}
          depthWrite={false}
        />
      </mesh>
      <lineSegments geometry={geom.edges}>
        <lineBasicMaterial color={edge} transparent opacity={picking ? 0.85 : 0.55} />
      </lineSegments>
      {picking && (
        <OriginPicker
          min={geom.min}
          max={geom.max}
          center={geom.center}
          xyOrigin={xyOrigin}
          zRef={zRef}
        />
      )}
    </group>
  )
}

/**
 * The C4 picker handles, drawn in the stock-box LOCAL frame (the parent group is
 * already translated to the box centre, so handle positions are offsets from it).
 * Two XY handles (centre / front-left corner) drive the XY origin; two Z handles
 * (top / bottom face) drive the Z reference. The active choice is highlighted.
 */
function OriginPicker({
  min,
  max,
  center,
  xyOrigin,
  zRef,
}: {
  min: [number, number, number]
  max: [number, number, number]
  center: [number, number, number]
  xyOrigin: 'center' | 'frontLeft'
  zRef: 'top' | 'bottom'
}) {
  const t = useT()
  const setXYOrigin = useStock((s) => s.setXYOrigin)
  const setZRef = useStock((s) => s.setZRef)

  // Local offsets (relative to the box centre group).
  const local = (x: number, y: number, z: number): [number, number, number] => [
    x - center[0],
    y - center[1],
    z - center[2],
  ]

  // Handle radius scales with the smaller footprint side so it reads at any size.
  const r = Math.max(1.2, Math.min(4, Math.min(max[0] - min[0], max[1] - min[1]) * 0.04))
  const topZ = max[2]
  const botZ = min[2]
  const cx = (min[0] + max[0]) / 2
  const cy = (min[1] + max[1]) / 2

  const onPick = (fn: () => void) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    fn()
  }
  const cursor = (on: boolean) => () => {
    document.body.style.cursor = on ? 'pointer' : 'auto'
  }

  return (
    <group>
      {/* XY origin — centre handle */}
      <Handle
        position={local(cx, cy, topZ)}
        r={r}
        active={xyOrigin === 'center'}
        color="#22c55e"
        onPick={onPick(() => setXYOrigin('center'))}
        onOver={cursor(true)}
        onOut={cursor(false)}
        label={t('cc.origin.center', 'Centre')}
      />
      {/* XY origin — front-left corner handle (min X, min Y) */}
      <Handle
        position={local(min[0], min[1], topZ)}
        r={r}
        active={xyOrigin === 'frontLeft'}
        color="#3b82f6"
        onPick={onPick(() => setXYOrigin('frontLeft'))}
        onOver={cursor(true)}
        onOut={cursor(false)}
        label={t('cc.origin.frontLeft', 'Front-left')}
      />
      {/* Z reference — top face handle */}
      <Handle
        position={local(max[0], cy, topZ)}
        r={r}
        active={zRef === 'top'}
        color="#f59e0b"
        onPick={onPick(() => setZRef('top'))}
        onOver={cursor(true)}
        onOut={cursor(false)}
        label={t('cc.origin.top', 'Top Z0')}
      />
      {/* Z reference — bottom face handle */}
      <Handle
        position={local(max[0], cy, botZ)}
        r={r}
        active={zRef === 'bottom'}
        color="#ef4444"
        onPick={onPick(() => setZRef('bottom'))}
        onOver={cursor(true)}
        onOut={cursor(false)}
        label={t('cc.origin.bottom', 'Bottom Z0')}
      />
    </group>
  )
}

function Handle({
  position,
  r,
  active,
  color,
  onPick,
  onOver,
  onOut,
  label,
}: {
  position: [number, number, number]
  r: number
  active: boolean
  color: string
  onPick: (e: ThreeEvent<PointerEvent>) => void
  onOver: () => void
  onOut: () => void
  label: string
}) {
  return (
    <group position={position}>
      <mesh
        onPointerDown={onPick}
        onPointerOver={onOver}
        onPointerOut={onOut}
        renderOrder={999}
      >
        <sphereGeometry args={[active ? r * 1.25 : r, 18, 18]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={active ? 0.8 : 0.25}
          transparent
          opacity={active ? 1 : 0.7}
          depthTest={false}
        />
      </mesh>
      {active && (
        <Html center distanceFactor={120} style={{ pointerEvents: 'none' }} zIndexRange={[50, 0]}>
          <div
            style={{
              transform: 'translateY(-1.6em)',
              padding: '1px 6px',
              borderRadius: 5,
              fontSize: 12,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              color: '#fff',
              background: 'rgba(15,23,42,0.85)',
              border: `1px solid ${color}`,
            }}
          >
            {label}
          </div>
        </Html>
      )}
    </group>
  )
}
