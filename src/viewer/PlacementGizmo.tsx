import { useEffect, useMemo, useRef } from 'react'
import { PivotControls, Html } from '@react-three/drei'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { useProgram } from '../store/program'
import { programBounds3, type JobPlacement } from '../core/transform'

/**
 * In-Canvas placement gizmo for the SELECTED toolpath section. Each program
 * section carries its own placement, so this edits only the section the user
 * picked (clicked in the 3D view or via the program list); other sections are
 * untouched. It MOVES / ROTATES / SCALES on all three axes and bakes the result
 * into that section's placement on the program store, which re-derives the
 * displayed + simulated + streamed G-code (what you see is what gets cut).
 *
 * Handles use drei's {@link PivotControls} (the same all-in-one gizmo the
 * viewport shapes use) which renders reliably across GPUs (integrated Intel/AMD
 * included) — drag an axis ARROW to move, an axis end SPHERE to scale that axis,
 * a quarter-circle ARC to rotate. A separate white centre DOT (HTML, drag it)
 * scales uniformly on all axes at once.
 */

export interface PlacementGizmoProps {
  /** Render + enable the gizmo. Default true. */
  visible?: boolean
  /** Allow interaction. Default true. */
  enabled?: boolean
  /** Fired with true while dragging, false when released (wire to OrbitControls). */
  onDraggingChanged?: (dragging: boolean) => void
  /**
   * The toolpath display group. During a drag we transform THIS group's matrix
   * imperatively (60fps, no G-code re-bake) for a smooth preview, then bake the
   * placement into the program ONCE on release. Without it we fall back to a
   * throttled live re-bake.
   */
  liveGroupRef?: React.RefObject<THREE.Group | null>
}

const MIN_SCALE = 1e-3
/** Screen-space handle size (px) for the placement gizmo. */
const GIZMO_SCALE = 59

export function PlacementGizmo({
  visible = true,
  enabled = true,
  onDraggingChanged,
  liveGroupRef,
}: PlacementGizmoProps) {
  const sections = useProgram((s) => s.sections)
  const selectedId = useProgram((s) => s.selectedSectionId)
  const section = useMemo(
    () => sections.find((s) => s.id === selectedId) ?? null,
    [sections, selectedId],
  )
  const placement = section?.placement ?? null

  // Pivot: XY-bbox centre, Z = work zero. Same pivot the baking transform uses;
  // Z=0 keeps safe-Z retracts safe under Z-scaling.
  const pivot = useMemo<THREE.Vector3 | null>(() => {
    if (!section) return null
    const b = programBounds3(section.rawLines.join('\n'))
    if (!b) return null
    return new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0)
  }, [section])

  const draggingRef = useRef(false)
  const matrix = useMemo(() => new THREE.Matrix4(), [])
  // Inverse of the section's committed-placement matrix at drag start. The live
  // preview transform applied to the (already-baked) toolpath group is
  //   liveDelta = Mnew · M0⁻¹
  // which maps each baked vertex to where the NEW placement would put it — no
  // G-code re-bake until the drag ends.
  const m0Inv = useRef(new THREE.Matrix4())

  // Keep the controlled matrix synced from the section placement when NOT
  // dragging, and (in the same render as a freshly-baked toolpath) reset the
  // live preview group back to identity so there's no flash on release.
  useEffect(() => {
    if (!pivot || !placement || draggingRef.current) return
    matrix.copy(matrixFromPlacement(placement, pivot))
    const g = liveGroupRef?.current
    if (g) {
      g.matrix.identity()
      g.matrixWorldNeedsUpdate = true
    }
  }, [matrix, placement, pivot, liveGroupRef])

  if (!pivot || !section || !placement || !(visible && enabled)) return null
  const sectionId = section.id
  const onScale = (p: Partial<JobPlacement>) =>
    useProgram.getState().setSectionPlacement(sectionId, p)

  const commit = (mL: THREE.Matrix4) => {
    useProgram.getState().setSectionPlacement(sectionId, placementFromMatrix(mL, pivot))
  }

  const setDragging = (d: boolean) => {
    draggingRef.current = d
    onDraggingChanged?.(d)
  }

  return (
    <>
      <PivotControls
        matrix={matrix}
        autoTransform
        // No `anchor`: with no children PivotControls' anchor offset is NaN
        // (empty bbox) and the handles vanish. Without it the gizmo sits at the
        // matrix translation (the section pivot), which is what we want.
        activeAxes={[true, true, true]}
        // drei's per-axis ScalingSphere is broken (it scales the wrong WORLD axis
        // for any non-Y handle — see the carve bug-hunt), so the X/Z scale spheres
        // mis-scale and Z never changes. Disable them; per-axis scale is done via
        // the (correct) numeric Scale fields in the readout, and uniform scale via
        // the centre dot. Translate arrows + rotate arcs stay.
        disableScaling
        depthTest={false}
        fixed
        scale={GIZMO_SCALE}
        // Fatter lines → fatter invisible hit-cylinders on the move arrows and
        // rotate arcs (drei sizes the grab geometry from lineWidth), so the
        // handles are easy to grab and don't fall through to OrbitControls.
        lineWidth={4.5}
        onDragStart={() => {
          setDragging(true)
          m0Inv.current.copy(matrix).invert()
        }}
        onDrag={(mL) => {
          matrix.copy(mL)
          // Smooth, re-bake-free preview: transform the toolpath group only.
          const g = liveGroupRef?.current
          if (g) {
            g.matrix.copy(mL).multiply(m0Inv.current)
            g.matrixWorldNeedsUpdate = true
          } else {
            // Fallback (no group): commit live (heavier).
            commit(mL)
          }
        }}
        onDragEnd={() => {
          // Bake the final placement ONCE; the placement-sync effect resets the
          // preview group to identity in the same render as the new geometry.
          commit(matrix)
          setDragging(false)
        }}
      />
      {/* Scale handles: a white centre dot (uniform) + per-axis dots (X red / Y
          green / Z blue) sitting at the TIPS of the gizmo arrows — a constant
          screen-space offset from the centre, tracked per-frame so they never
          scatter. drei's own scale spheres are disabled (buggy); these custom
          dots ARE the per-axis scale. */}
      <ScaleHandles
        matrix={matrix}
        placement={placement}
        onScale={onScale}
        onDraggingChanged={setDragging}
      />
    </>
  )
}

type ScaleAxis = 'sx' | 'sy' | 'sz'

/** Pixel distance from the gizmo centre to each per-axis scale dot (≈ the arrow tip). */
const HANDLE_PX = GIZMO_SCALE * 0.92

interface DotSpec {
  key: 'u' | 'x' | 'y' | 'z'
  color: string
  axes: ScaleAxis[]
  title: string
  /** Local axis the dot/arrow points along (null = the uniform centre dot). */
  dir: THREE.Vector3 | null
}

const DOTS: DotSpec[] = [
  { key: 'u', color: '#ffffff', axes: ['sx', 'sy', 'sz'], title: 'Scale uniformly (all axes)', dir: null },
  { key: 'x', color: '#ef4444', axes: ['sx'], title: 'Scale X — drag outward to grow', dir: new THREE.Vector3(1, 0, 0) },
  { key: 'y', color: '#22c55e', axes: ['sy'], title: 'Scale Y — drag outward to grow', dir: new THREE.Vector3(0, 1, 0) },
  { key: 'z', color: '#3b82f6', axes: ['sz'], title: 'Scale Z — drag outward to grow', dir: new THREE.Vector3(0, 0, 1) },
]

/**
 * Scale handles for the placement gizmo: a white centre dot (uniform) plus one
 * dot per axis (X/Y/Z), drawn from a single <Html> wrapped in a group that tracks
 * the gizmo's LIVE centre (so the dots follow when the job is MOVED). Each axis
 * dot is offset in screen space along its axis's PROJECTED direction by a fixed
 * pixel distance (≈ the arrow tip) every frame, so the dots sit on the arrow tips
 * at any zoom/camera angle and never scatter. Dragging a dot OUTWARD (away from
 * the centre, along its axis) grows that axis; inward shrinks — computed from the
 * pointer projected onto the live axis direction, so it is NEVER inverted when
 * the view is rotated. The centre dot scales all axes uniformly (drag out = grow).
 * drei's own scale spheres are disabled (they scale the wrong world axis).
 */
function ScaleHandles({
  matrix,
  placement,
  onScale,
  onDraggingChanged,
}: {
  matrix: THREE.Matrix4
  placement: JobPlacement
  onScale: (p: Partial<JobPlacement>) => void
  onDraggingChanged: (d: boolean) => void
}) {
  const { camera, size } = useThree()
  const grp = useRef<THREE.Group>(null)
  const dotRefs = useRef<Record<string, HTMLDivElement | null>>({})
  // Per-dot current screen-space unit direction (centre → dot), captured at drag.
  const screenDirs = useRef<Record<string, { x: number; y: number }>>({})
  const start = useRef<{ x: number; y: number; dir: { x: number; y: number }; s: Record<ScaleAxis, number> } | null>(null)

  const decomp = useRef({ pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scl: new THREE.Vector3() })
  const tmp = new THREE.Vector3()
  const tmpDir = new THREE.Vector3()
  const worldDir = new THREE.Vector3()
  const camFwd = new THREE.Vector3()

  useFrame(() => {
    const { pos, quat } = decomp.current
    matrix.decompose(pos, quat, decomp.current.scl)
    // Keep the whole handle cluster on the gizmo's live centre (follows MOVE).
    if (grp.current) {
      grp.current.position.copy(pos)
      grp.current.updateMatrixWorld()
    }
    const pScreen = tmp.copy(pos).project(camera)
    const px = pScreen.x
    const py = pScreen.y
    // Direction the camera looks (its -Z in world space).
    camFwd.set(0, 0, -1).applyQuaternion(camera.quaternion)
    for (const d of DOTS) {
      const el = dotRefs.current[d.key]
      if (!el) continue
      if (!d.dir) {
        el.style.transform = 'translate(-50%, -50%)'
        el.style.opacity = '1'
        screenDirs.current[d.key] = { x: 0.7071, y: -0.7071 } // uniform: up-right grows
        continue
      }
      // Rotated world axis direction.
      worldDir.copy(d.dir).applyQuaternion(quat)
      // Depth cue: a dot whose axis points the SAME way the camera looks is on the
      // BACK side of the gizmo — fade it (like a 3D handle going behind) instead of
      // forcing it opaque on top. (worldDir·cameraForward > 0 ⇒ pointing away.)
      el.style.opacity = worldDir.dot(camFwd) > 0.2 ? '0.25' : '1'
      // Project the axis tip to a screen-space unit direction for placement.
      tmpDir.copy(pos).add(worldDir).project(camera)
      let sx = (tmpDir.x - px) * 0.5 * size.width
      let sy = -(tmpDir.y - py) * 0.5 * size.height
      const len = Math.hypot(sx, sy)
      if (len < 1e-3) {
        sx = 0
        sy = -1
      } else {
        sx /= len
        sy /= len
      }
      screenDirs.current[d.key] = { x: sx, y: sy }
      el.style.transform = `translate(-50%, -50%) translate(${sx * HANDLE_PX}px, ${sy * HANDLE_PX}px)`
    }
  })

  const onDown = (d: DotSpec) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    try {
      ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
    } catch {
      /* best-effort */
    }
    start.current = {
      x: e.clientX,
      y: e.clientY,
      dir: screenDirs.current[d.key] ?? { x: 0.7071, y: -0.7071 },
      s: { sx: placement.sx, sy: placement.sy, sz: placement.sz },
    }
    ;(e.currentTarget as HTMLDivElement).dataset.axes = d.axes.join(',')
    onDraggingChanged(true)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const st = start.current
    if (!st) return
    const axes = ((e.currentTarget as HTMLDivElement).dataset.axes || '').split(',') as ScaleAxis[]
    // Project the pointer travel onto the dot's OUTWARD screen direction: dragging
    // away from the centre (along the axis) grows; toward the centre shrinks. Using
    // the live projected direction makes this correct at every camera angle.
    const along = (e.clientX - st.x) * st.dir.x + (e.clientY - st.y) * st.dir.y
    const factor = Math.exp(along / 180) // ~180px ≈ ×e
    const clamp = (s: number) => Math.min(1000, Math.max(0.05, s))
    const patch: Partial<JobPlacement> = {}
    for (const a of axes) patch[a] = clamp(st.s[a] * factor)
    onScale(patch)
  }
  const onUp = (e: React.PointerEvent<HTMLDivElement>) => {
    try {
      ;(e.target as HTMLElement).releasePointerCapture?.(e.pointerId)
    } catch {
      /* no-op */
    }
    start.current = null
    onDraggingChanged(false)
  }

  return (
    <group ref={grp}>
      <Html position={[0, 0, 0]} center zIndexRange={[60, 0]} style={{ pointerEvents: 'none' }}>
        <div style={{ position: 'relative', width: 0, height: 0 }}>
          {DOTS.map((d) => (
            <div
              key={d.key}
              ref={(el) => {
                dotRefs.current[d.key] = el
              }}
              title={d.title}
              onPointerDown={onDown(d)}
              onPointerMove={onMove}
              onPointerUp={onUp}
              style={{
                position: 'absolute',
                left: 0,
                top: 0,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: d.color,
                border: '2px solid rgba(0,0,0,0.55)',
                boxShadow: '0 0 0 1px rgba(255,255,255,0.6)',
                cursor: 'nwse-resize',
                pointerEvents: 'auto',
                touchAction: 'none',
              }}
            />
          ))}
        </div>
      </Html>
    </group>
  )
}

/** Compose the gizmo matrix from a placement about `pivot`. */
function matrixFromPlacement(p: JobPlacement, pivot: THREE.Vector3): THREE.Matrix4 {
  const pos = new THREE.Vector3(pivot.x + p.dx, pivot.y + p.dy, pivot.z + p.dz)
  const quat = new THREE.Quaternion(p.qx, p.qy, p.qz, p.qw)
  const scl = new THREE.Vector3(p.sx, p.sy, p.sz)
  return new THREE.Matrix4().compose(pos, quat, scl)
}

/** Decompose a gizmo matrix back into a JobPlacement (about `pivot`). */
function placementFromMatrix(m: THREE.Matrix4, pivot: THREE.Vector3): JobPlacement {
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  m.decompose(pos, quat, scl)
  const clamp = (s: number) => {
    if (!Number.isFinite(s)) return 1
    const a = Math.abs(s)
    return a < MIN_SCALE ? (s < 0 ? -MIN_SCALE : MIN_SCALE) : s
  }
  return {
    dx: pos.x - pivot.x,
    dy: pos.y - pivot.y,
    dz: pos.z - pivot.z,
    qx: quat.x,
    qy: quat.y,
    qz: quat.z,
    qw: quat.w,
    sx: clamp(scl.x),
    sy: clamp(scl.y),
    sz: clamp(scl.z),
  }
}
