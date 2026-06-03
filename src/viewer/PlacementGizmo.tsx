import { useEffect, useMemo, useRef, useState } from 'react'
import { TransformControls } from '@react-three/drei'
import type { TransformControls as TransformControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { useProgram } from '../store/program'
import { programXYBounds, type Placement } from '../core/transform'

/**
 * In-Canvas placement gizmo. Lets the user move (XY), rotate (Z), or uniformly
 * scale the loaded job directly in the 3D view; the result is written as a
 * {@link Placement} on the program store, which bakes it into the streamed +
 * simulated G-code. There is NO separate visual transform on the toolpath — the
 * gizmo only edits placement, so what you see is exactly what gets cut.
 *
 * Implementation: a small invisible proxy object is attached to drei's
 * TransformControls. The proxy is kept CONTROLLED from the current placement
 * (positioned at the design's bbox centre + translation, rotated by rotDeg,
 * scaled). On user drag we read the proxy back into a Placement and push it to
 * the store, throttled to ~30fps so a 10k+ line program stays smooth. While the
 * gizmo is dragging we forward `dragging-changed` so the Viewer can disable
 * OrbitControls and the two don't fight.
 */

export interface PlacementGizmoProps {
  /** Which handle set to show. */
  mode: 'translate' | 'rotate' | 'scale'
  /** Render + enable the gizmo. Default true. */
  visible?: boolean
  /** Allow interaction. Default true. */
  enabled?: boolean
  /** Fired with true while dragging, false when released (wire to OrbitControls). */
  onDraggingChanged?: (dragging: boolean) => void
}

const RAD = Math.PI / 180
const DEG = 180 / Math.PI

export function PlacementGizmo({
  mode,
  visible = true,
  enabled = true,
  onDraggingChanged,
}: PlacementGizmoProps) {
  const rawLines = useProgram((s) => s.rawLines)
  const placement = useProgram((s) => s.placement)

  // Design XY-bbox centre (pivot) from the RAW program — the same pivot the
  // baking transform uses, so the gizmo rotates/scales about the right point.
  const rawGcode = useMemo(() => rawLines.join('\n'), [rawLines])
  const pivot = useMemo<[number, number] | null>(() => {
    const b = programXYBounds(rawGcode)
    if (!b) return null
    return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2]
  }, [rawGcode])

  // The proxy object3D the controls manipulate. Held in state (not just a ref)
  // so TransformControls' `object` prop is set once the object has mounted.
  const [proxy, setProxy] = useState<THREE.Object3D | null>(null)
  const controlsRef = useRef<TransformControlsImpl | null>(null)
  const draggingRef = useRef(false)
  const lastWriteRef = useRef(0)

  // Keep the proxy CONTROLLED from the current placement whenever we're NOT
  // mid-drag (external resets, numeric edits, or a fresh program all reflect).
  useEffect(() => {
    if (!proxy || !pivot) return
    if (draggingRef.current) return
    syncProxyFromPlacement(proxy, pivot, placement)
    controlsRef.current?.update?.()
  }, [proxy, pivot, placement, mode, visible])

  // Wire drag start/stop → orbit lock, and read proxy → placement on change.
  useEffect(() => {
    const controls = controlsRef.current
    if (!controls || !proxy || !pivot) return

    const commit = () => {
      const next = placementFromProxy(proxy, pivot)
      useProgram.getState().setPlacement(next)
    }

    const onDragChange = (e: { value?: unknown }) => {
      const dragging = !!e.value
      draggingRef.current = dragging
      onDraggingChanged?.(dragging)
      if (!dragging) {
        // Final commit on release (unthrottled) so the end state is exact, then
        // re-sync the proxy to the canonical placement.
        commit()
        syncProxyFromPlacement(proxy, pivot, useProgram.getState().placement)
      }
    }

    const onObjectChange = () => {
      if (!draggingRef.current) return
      const now = performance.now()
      if (now - lastWriteRef.current < 33) return // ~30fps gate
      lastWriteRef.current = now
      commit()
    }

    // three-stdlib TransformControls is an EventDispatcher; its strict Object3D
    // event-map typing doesn't cover the 'dragging-changed'/'objectChange'
    // signals, so register through a loosely-typed view.
    const ev = controls as unknown as {
      addEventListener: (type: string, fn: (e: { value?: unknown }) => void) => void
      removeEventListener: (type: string, fn: (e: { value?: unknown }) => void) => void
    }
    ev.addEventListener('dragging-changed', onDragChange)
    ev.addEventListener('objectChange', onObjectChange)
    return () => {
      ev.removeEventListener('dragging-changed', onDragChange)
      ev.removeEventListener('objectChange', onObjectChange)
    }
  }, [proxy, pivot, onDraggingChanged])

  if (!pivot) return null

  // Constrain axes per mode: translate XY only, rotate Z only, scale uniform.
  const showX = mode === 'translate' || mode === 'scale'
  const showY = mode === 'translate' || mode === 'scale'
  const showZ = mode === 'rotate' || mode === 'scale'

  const active = visible && enabled

  return (
    <>
      {/* The controlled proxy. Always present so its transform persists across
          mode switches; the gizmo handles themselves toggle with `active`. */}
      <object3D ref={setProxy as never} />
      {proxy && active && (
        <TransformControls
          ref={controlsRef as never}
          object={proxy}
          mode={mode}
          space="world"
          showX={showX}
          showY={showY}
          showZ={showZ}
          size={0.9}
        />
      )}
    </>
  )
}

/** Position/rotate/scale the proxy object to represent `placement`. */
function syncProxyFromPlacement(
  obj: THREE.Object3D,
  pivot: [number, number],
  placement: Placement,
) {
  obj.position.set(pivot[0] + placement.dx, pivot[1] + placement.dy, 0)
  obj.rotation.set(0, 0, placement.rotDeg * RAD)
  obj.scale.set(placement.scale, placement.scale, 1)
  obj.updateMatrixWorld()
}

/** Read a proxy object's transform back into a Placement (about `pivot`). */
function placementFromProxy(obj: THREE.Object3D, pivot: [number, number]): Placement {
  const dx = obj.position.x - pivot[0]
  const dy = obj.position.y - pivot[1]
  const rotDeg = obj.rotation.z * DEG
  // Uniform scale: average X/Y, clamp to a sane positive range.
  const sx = obj.scale.x
  const sy = obj.scale.y
  let scale = (Math.abs(sx) + Math.abs(sy)) / 2
  if (!Number.isFinite(scale) || scale < 1e-3) scale = 1e-3
  return { dx, dy, rotDeg, scale }
}
