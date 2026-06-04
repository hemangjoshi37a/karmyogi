import { useEffect, useMemo, useRef } from 'react'
import { PivotControls } from '@react-three/drei'
import * as THREE from 'three'
import {
  useViewportShapes,
  type ViewportShape,
} from '../store/viewportShapes'

/**
 * In-Canvas rendering of the user's viewport-drawn shapes (circle / rectangle /
 * triangle / line) on the bed plane (XY at Z=0), plus an ALL-IN-ONE inline
 * transform gizmo on the selected shape.
 *
 * The inline gizmo is drei's {@link PivotControls}: it provides exactly the
 * pivot behaviour the user described — drag an axis ARROW to MOVE along that
 * axis, drag an axis end SPHERE to RESIZE/SCALE, and drag a quarter-circle ARC
 * to ROTATE. For a flat 3-axis job we constrain it to the bed plane: translation
 * on X/Y only and rotation about the bed-normal (Z) only.
 *
 * PivotControls runs in CONTROLLED mode here: we own a {@link THREE.Matrix4} per
 * shape (composed from the store's {x, y, rot} + a live scale). On each drag we
 * decompose the gizmo's local matrix `mL` back into the shape's fields and write
 * them to the store (which persists + regenerates G-code live elsewhere). The
 * controlled matrix means external edits / reloads / deletes all reflect.
 */

export interface ViewportShapesProps {
  /** Fired true while a gizmo handle is dragging (so the Viewer can lock OrbitControls). */
  onDraggingChanged?: (dragging: boolean) => void
}

export function ViewportShapes({ onDraggingChanged }: ViewportShapesProps) {
  const shapes = useViewportShapes((s) => s.shapes)
  const selectedId = useViewportShapes((s) => s.selectedId)

  return (
    <group>
      {shapes.map((shape) => (
        <ShapeNode
          key={shape.id}
          shape={shape}
          selected={shape.id === selectedId}
          onDraggingChanged={onDraggingChanged}
        />
      ))}
    </group>
  )
}

const QUARTER = Math.PI / 2

/** Local outline points (XY), centered at the origin, scaled only by `size`. */
function outlinePoints(kind: ViewportShape['kind'], size: number): THREE.Vector3[] {
  const local: [number, number][] = []
  if (kind === 'rectangle') {
    local.push([-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1])
  } else if (kind === 'triangle') {
    for (let i = 0; i < 3; i++) {
      const a = QUARTER + (i * 2 * Math.PI) / 3
      local.push([Math.cos(a), Math.sin(a)])
    }
    local.push(local[0])
  } else if (kind === 'line') {
    local.push([-1, 0], [1, 0])
  } else {
    const n = 64
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI
      local.push([Math.cos(a), Math.sin(a)])
    }
  }
  return local.map(([ux, uy]) => new THREE.Vector3(ux * size, uy * size, 0))
}

function ShapeNode({
  shape,
  selected,
  onDraggingChanged,
}: {
  shape: ViewportShape
  selected: boolean
  onDraggingChanged?: (dragging: boolean) => void
}) {
  const select = useViewportShapes((s) => s.select)
  const updateShape = useViewportShapes((s) => s.updateShape)

  const draggingRef = useRef(false)
  const lastWrite = useRef(0)
  // Latest local matrix from the gizmo during a drag, so onDragEnd can bake the
  // accumulated SCALE (which we don't apply live, to avoid a geometry rebuild
  // fighting the gizmo) from the real gizmo transform rather than our matrix.
  const lastDragLocal = useRef<THREE.Matrix4 | null>(null)

  // Controlled matrix for PivotControls: position (x,y) + Z-rotation. Scale is
  // applied live during a resize drag and baked into the geometry's `size` on
  // release, so the matrix scale returns to 1 between drags.
  const matrix = useMemo(() => new THREE.Matrix4(), [shape.id])

  // Keep the controlled matrix in sync from the store when NOT mid-drag.
  useEffect(() => {
    if (draggingRef.current) return
    matrix.compose(
      new THREE.Vector3(shape.x, shape.y, 0),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, shape.rot)),
      new THREE.Vector3(1, 1, 1),
    )
  }, [matrix, shape.x, shape.y, shape.rot])

  // The visible outline (a THREE.Line so closed loops draw correctly).
  const lineObj = useMemo(() => {
    const g = new THREE.BufferGeometry().setFromPoints(
      outlinePoints(shape.kind, shape.size),
    )
    const color = selected ? 0xf59e0b : shape.kind === 'line' ? 0x22d3ee : 0x5eead4
    const mat = new THREE.LineBasicMaterial({ color })
    return new THREE.Line(g, mat)
  }, [shape.kind, shape.size, selected])

  useEffect(
    () => () => {
      lineObj.geometry.dispose()
      ;(lineObj.material as THREE.Material).dispose()
    },
    [lineObj],
  )

  // Invisible-ish fill mesh so the shape is easy to click-select.
  const hitGeom = useMemo(() => {
    if (shape.kind === 'line') {
      return new THREE.PlaneGeometry(shape.size * 2, Math.max(2, shape.size * 0.2))
    }
    const pts2d = outlinePoints(shape.kind, shape.size).map(
      (v) => new THREE.Vector2(v.x, v.y),
    )
    return new THREE.ShapeGeometry(new THREE.Shape(pts2d))
  }, [shape.kind, shape.size])

  useEffect(() => () => hitGeom.dispose(), [hitGeom])

  const fillColor = selected ? '#f59e0b' : '#5eead4'

  const commit = (mL: THREE.Matrix4, bakeScale: boolean) => {
    const pos = new THREE.Vector3()
    const quat = new THREE.Quaternion()
    const scl = new THREE.Vector3()
    mL.decompose(pos, quat, scl)
    const e = new THREE.Euler().setFromQuaternion(quat, 'XYZ')
    const patch: Partial<ViewportShape> = { x: pos.x, y: pos.y, rot: e.z }
    if (bakeScale) {
      const factor = (Math.abs(scl.x) + Math.abs(scl.y)) / 2 || 1
      patch.size = shape.size * factor
    }
    updateShape(shape.id, patch)
  }

  return (
    <PivotControls
      matrix={matrix}
      autoTransform
      anchor={[0, 0, 0]}
      activeAxes={[true, true, false]}
      disableAxes={!selected}
      disableSliders={!selected}
      disableRotations={!selected}
      disableScaling={!selected}
      depthTest={false}
      // Fixed (screen-space) sizing keeps the whole gizmo — arrows, rotation
      // arcs, AND the scale spheres — a constant, comfortably-large size on
      // screen regardless of zoom, so the small resize spheres stay easy to
      // grab (they shrink to a near-unhittable point in world-scaled mode).
      fixed
      scale={140}
      lineWidth={3}
      visible={selected}
      onDragStart={() => {
        draggingRef.current = true
        onDraggingChanged?.(true)
      }}
      onDrag={(mL) => {
        // Always remember the freshest gizmo-local matrix (carries the live
        // scale) so the release can bake it exactly. Copy it into the controlled
        // matrix too so move / rotate / SCALE all animate live (the scale lives
        // in the matrix during the drag, then bakes into `size` on release).
        lastDragLocal.current = mL.clone()
        matrix.copy(mL)
        const now = performance.now()
        if (now - lastWrite.current < 40) return
        lastWrite.current = now
        // Follow move/rotate live in the store; scale is baked on release so the
        // geometry rebuild doesn't fight the live gizmo scale.
        commit(mL, false)
      }}
      onDragEnd={() => {
        const mL = lastDragLocal.current ?? matrix
        commit(mL, true)
        lastDragLocal.current = null
        draggingRef.current = false
        onDraggingChanged?.(false)
      }}
    >
      <primitive object={lineObj} />
      <mesh
        geometry={hitGeom}
        onPointerDown={(e) => {
          e.stopPropagation()
          select(shape.id)
        }}
      >
        <meshBasicMaterial
          transparent
          opacity={selected ? 0.14 : 0.05}
          color={fillColor}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </PivotControls>
  )
}
