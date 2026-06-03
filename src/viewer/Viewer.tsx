import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useEffect,
} from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { Bed } from './Bed'
import { Toolpath } from './Toolpath'
import { ToolMarker } from './ToolMarker'
import { StockBlock } from './StockBlock'
import { CarvedStock } from './CarvedStock'
import { PlacementGizmo } from './PlacementGizmo'
import { gcodeToPolylines, type Segment, type Bounds } from './gcodeToPolylines'
import {
  frameBounds,
  fitToBounds,
  type Bounds3,
  type ViewName,
} from './viewControls'
import { useSettings } from '../store'
import { useBed } from '../store/bed'

export interface ViewerHandle {
  /** Fit the toolpath to the viewport, keeping the current angle. */
  fit: () => void
  /** Jump to a named view (isometric / top / front), reframed to bounds. */
  setView: (view: ViewName) => void
}

export interface ViewerProps {
  /** G-code program text. Parsed to polylines internally. Optional. */
  gcode?: string
  /**
   * Pre-parsed segments. If given, takes precedence over `gcode` (lets the
   * Program panel parse once and share). Optional.
   */
  segments?: Segment[]
  /**
   * Live/actual machine tool position [x, y, z] in mm (from the controller).
   * Shows the ACTUAL spindle cone (amber) when set. Independent of the sim cone.
   */
  toolPosition?: [number, number, number] | null
  /**
   * Simulation tool position [x, y, z] in mm (from the playback timeline). Shows
   * the SIMULATION spindle cone (cyan) when set — drawn alongside the actual
   * cone, not instead of it, so a live job and a preview can be watched together.
   */
  simPosition?: [number, number, number] | null
  /** Show the actual (live machine) spindle cone. Default true. */
  showActualTool?: boolean
  /** Show the simulation spindle cone. Default true. */
  showSimTool?: boolean
  /** Bed size in mm [X, Y, Z]. Defaults to the bed store when omitted. */
  bedWidth?: number
  bedDepth?: number
  bedHeight?: number
  /** Show the translucent stock/workpiece block (from the stock store). Default true. */
  showStock?: boolean
  /**
   * Playback reveal: index of the segment currently being executed. When >= 0,
   * the toolpath is split into traveled (bright) / upcoming (dim) for the
   * simulation. Omit / pass < 0 for the static full-path look (default).
   */
  revealIndex?: number
  /** Point on the active segment the tool has reached (for the reveal split). */
  revealPoint?: [number, number, number] | null
  /**
   * Material-removal simulation: when true AND a reveal is active, render the
   * stock as a heightmap surface that is progressively carved by the done cut
   * moves (the already-machined region reveals its cut surface). Default false.
   */
  carveSim?: boolean
  /** Cutter radius (mm) for the material-removal sim. Default 1.5. */
  toolRadius?: number
  /**
   * Show the in-scene placement gizmo (move / rotate / scale the loaded job).
   * The gizmo writes a placement to the program store, which bakes it into the
   * displayed + simulated + streamed G-code — no separate visual transform.
   * Default false (off).
   */
  gizmo?: boolean
  /** Which gizmo handles to show when `gizmo` is on. Default 'translate'. */
  gizmoMode?: 'translate' | 'rotate' | 'scale'
}

const FOV = 45

/**
 * 3D viewport. Renders the bed grid, the parsed G-code toolpath (rapids vs
 * cuts coloured differently), and a tool-position marker. Exposes imperative
 * view controls (fit / iso / top / front) through a ref.
 *
 * Theme-aware (background + line colours follow the settings store) and free of
 * business logic — it only parses G-code coordinates for display.
 */
export const Viewer = forwardRef<ViewerHandle, ViewerProps>(function Viewer(
  {
    gcode,
    segments: segmentsProp,
    toolPosition,
    simPosition,
    showActualTool = true,
    showSimTool = true,
    bedWidth,
    bedDepth,
    bedHeight,
    showStock = true,
    revealIndex,
    revealPoint,
    carveSim = false,
    toolRadius = 1.5,
    gizmo = false,
    gizmoMode = 'translate',
  },
  ref,
) {
  const theme = useSettings((s) => s.theme)
  const bg = theme === 'dark' ? '#15181c' : '#e7ecf1'

  // Bed size: explicit props win; otherwise fall back to the persisted bed store
  // so the grid + view framing react live to bed-size edits.
  const storeW = useBed((s) => s.width)
  const storeD = useBed((s) => s.depth)
  const storeH = useBed((s) => s.height)
  const width = bedWidth ?? storeW
  const depth = bedDepth ?? storeD
  const height = bedHeight ?? storeH

  // Parse once per gcode string (unless caller supplies parsed segments).
  const parsed = useMemo(() => {
    if (segmentsProp) {
      return { segments: segmentsProp, bounds: boundsOf(segmentsProp) }
    }
    if (gcode && gcode.trim() !== '') {
      return gcodeToPolylines(gcode)
    }
    return { segments: [] as Segment[], bounds: null as Bounds | null }
  }, [gcode, segmentsProp])

  const bedSize: [number, number, number] = [width, depth, height]
  const controlBounds: Bounds3 | null = parsed.bounds
    ? { min: parsed.bounds.min, max: parsed.bounds.max }
    : null

  const apiRef = useRef<ViewerHandle>({ fit: () => {}, setView: () => {} })
  useImperativeHandle(ref, () => ({
    fit: () => apiRef.current.fit(),
    setView: (v) => apiRef.current.setView(v),
  }))

  // Orbit controls ref so the placement gizmo can disable orbiting while it
  // drags (drei's TransformControls and OrbitControls otherwise fight).
  const orbitRef = useRef<OrbitControlsImpl | null>(null)
  const onGizmoDragging = (dragging: boolean) => {
    if (orbitRef.current) orbitRef.current.enabled = !dragging
  }

  return (
    <Canvas
      style={{ height: '100%', width: '100%', background: bg }}
      camera={{ position: [200, -260, 220], up: [0, 0, 1], fov: FOV, near: 0.1, far: 5000 }}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[100, -100, 300]} intensity={0.6} />
      <Bed width={width} depth={depth} />
      <StockBlock visible={showStock} />
      {carveSim && revealIndex !== undefined && revealIndex >= 0 && (
        <CarvedStock
          segments={parsed.segments}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
          toolRadius={toolRadius}
        />
      )}
      {parsed.segments.length > 0 && (
        <Toolpath
          segments={parsed.segments}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
        />
      )}
      {parsed.bounds && <BoundsBox bounds={parsed.bounds} dark={theme === 'dark'} />}
      {/* Actual (live machine) spindle cone — amber. */}
      {showActualTool && toolPosition && <ToolMarker position={toolPosition} />}
      {/* Simulation spindle cone — cyan, so it reads distinct from the live one. */}
      {showSimTool && simPosition && (
        <ToolMarker position={simPosition} color={theme === 'dark' ? '#22d3ee' : '#0891b2'} />
      )}
      {gizmo && (
        <PlacementGizmo mode={gizmoMode} onDraggingChanged={onGizmoDragging} />
      )}
      <OrbitControls ref={orbitRef} makeDefault enableDamping dampingFactor={0.1} />
      <ViewController bounds={controlBounds} bedSize={bedSize} apiRef={apiRef} />
    </Canvas>
  )
})

/**
 * Inside-Canvas helper that wires the imperative view controls to the live
 * camera + OrbitControls. It writes the camera/target computed by the pure
 * viewControls helpers.
 */
function ViewController({
  bounds,
  bedSize,
  apiRef,
}: {
  bounds: Bounds3 | null
  bedSize: [number, number, number]
  apiRef: React.MutableRefObject<ViewerHandle>
}) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null

  // Keep latest bounds in a ref so the imperative handlers always see current data.
  const boundsRef = useRef(bounds)
  boundsRef.current = bounds

  useEffect(() => {
    const apply = (pos: [number, number, number], target: [number, number, number]) => {
      camera.position.set(pos[0], pos[1], pos[2])
      camera.up.set(0, 0, 1)
      if (controls) {
        controls.target.set(target[0], target[1], target[2])
        controls.update()
      } else {
        camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]))
      }
    }

    apiRef.current.fit = () => {
      const cur: [number, number, number] = [camera.position.x, camera.position.y, camera.position.z]
      const tgt: [number, number, number] = controls
        ? [controls.target.x, controls.target.y, controls.target.z]
        : [0, 0, 0]
      const v = fitToBounds(boundsRef.current, cur, tgt, FOV, bedSize)
      apply(v.position, v.target)
    }

    apiRef.current.setView = (view: ViewName) => {
      const v = frameBounds(boundsRef.current, view, FOV, bedSize)
      apply(v.position, v.target)
    }
  }, [camera, controls, apiRef, bedSize])

  return null
}

/**
 * Subtle wireframe around the program's bounding box — a tasteful 3D dimension
 * cue that complements the HTML size overlay. Drawn as a thin, dashed-feel edge
 * box (theme-aware, low opacity so it never competes with the toolpath).
 * Skipped for degenerate (zero-volume) boxes to avoid z-fighting noise.
 */
function BoundsBox({ bounds, dark }: { bounds: Bounds; dark: boolean }) {
  const { positions, valid } = useMemo(() => {
    const [x0, y0, z0] = bounds.min
    const [x1, y1, z1] = bounds.max
    const w = x1 - x0
    const d = y1 - y0
    // Need a non-degenerate XY footprint to be worth drawing.
    if (!(w > 1e-6) || !(d > 1e-6)) return { positions: null, valid: false }

    // 12 edges of the box as line-segment endpoint pairs (24 points).
    const c: [number, number, number][] = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], // bottom
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], // top
    ]
    const edges: [number, number][] = [
      [0, 1], [1, 2], [2, 3], [3, 0], // bottom rect
      [4, 5], [5, 6], [6, 7], [7, 4], // top rect
      [0, 4], [1, 5], [2, 6], [3, 7], // verticals
    ]
    const pts: number[] = []
    for (const [a, b] of edges) {
      pts.push(...c[a], ...c[b])
    }
    return { positions: new Float32Array(pts), valid: true }
  }, [bounds])

  if (!valid || !positions) return null
  const color = dark ? '#5eead4' : '#0e7c66'

  return (
    <lineSegments>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <lineBasicMaterial color={color} transparent opacity={0.35} />
    </lineSegments>
  )
}

/** Axis-aligned bounds of pre-parsed segments (when caller supplies segments). */
function boundsOf(segments: Segment[]): Bounds | null {
  if (segments.length === 0) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const acc = (p: [number, number, number]) => {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
  for (const s of segments) {
    acc(s.from)
    acc(s.to)
  }
  return { min, max }
}
