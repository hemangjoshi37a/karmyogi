import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useEffect,
} from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewcube } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { Bed } from './Bed'
import { Toolpath } from './Toolpath'
import { ToolMarker } from './ToolMarker'
import { StockBlock } from './StockBlock'
import { CarvedStock } from './CarvedStock'
import { PlacementGizmo } from './PlacementGizmo'
import { CameraBedPlane } from './CameraBedPlane'
import { JobBox } from './JobBox'
import { ViewportShapes } from './ViewportShapes'
import { Dimensions } from './Dimensions'
import { ToolpathStartMarker } from './ToolpathStartMarker'
import { useViewportShapes } from '../store/viewportShapes'
import { shapesToGcode } from '../core/viewportShapeGcode'
import { useProgram } from '../store/program'
import { useT } from '../i18n'
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
   * Show the in-scene placement gizmo (move / rotate / scale the loaded job on
   * all 3 axes). The gizmo writes a placement to the program store, which bakes
   * it into the displayed + simulated + streamed G-code — no separate visual
   * transform. Default false (off).
   */
  gizmo?: boolean
  /**
   * Called to turn the placement gizmo on/off from inside the scene: left-click
   * on a toolpath turns it ON; a click on empty space turns it OFF.
   */
  onGizmoChange?: (on: boolean) => void
  /**
   * Per-section bounding boxes (baked) used as click-to-select hit regions, so
   * each toolpath can be picked independently for placement editing.
   */
  sectionBoxes?: { id: string; bounds: Bounds }[]
  /**
   * Per-section parsed segments + colour. When provided (and not simulating),
   * each toolpath renders in its OWN colour and its OWN group, so distinct jobs
   * are visually separable and the placement gizmo can live-drag ONLY the
   * selected section (not every toolpath).
   */
  sectionPaths?: { id: string; segments: Segment[]; color: string }[]
  /** The currently selected section id (its box reads as active). */
  selectedSectionId?: string | null
  /** Called with a section id when its toolpath box is clicked. */
  onSelectSection?: (id: string) => void
  /** Lasso-delete mode: drag a freeform region over the toolpath to select moves. */
  lasso?: boolean
  /** Called with the KEPT segments after the user confirms a lasso deletion. */
  onLassoDelete?: (kept: Segment[]) => void
  /**
   * Show the engineering-style 3D dimension annotations (X/Y/Z extension +
   * dimension lines with arrowheads and the measurement in mm) around the
   * loaded program's bounding box. Default false.
   */
  showDimensions?: boolean
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
    onGizmoChange,
    sectionBoxes,
    sectionPaths,
    selectedSectionId,
    onSelectSection,
    lasso = false,
    onLassoDelete,
    showDimensions = false,
  },
  ref,
) {
  const theme = useSettings((s) => s.theme)
  const uiScale = useSettings((s) => s.uiScale)
  const t = useT()
  const bg = theme === 'dark' ? '#15181c' : '#e7ecf1'

  // The global UI zoom (CSS `zoom` on <html>) changes the panel's rendered size
  // without firing a ResizeObserver entry on some Chromium versions. r3f's
  // measure hook always listens to window 'resize', so nudge it after each zoom
  // change (next frame, so layout has settled) to keep the canvas filling the
  // panel.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
    return () => cancelAnimationFrame(id)
  }, [uiScale])

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
  // Group wrapping the SELECTED section's toolpath — the placement gizmo drives
  // its matrix imperatively during a drag for a smooth, re-bake-free preview.
  const liveGroupRef = useRef<THREE.Group>(null)
  const revealing = revealIndex !== undefined && revealIndex >= 0
  // Only the selected section is "live" (gizmo-transformable) while the gizmo is on.
  const liveSectionId = gizmo ? selectedSectionId ?? null : null

  // ---- Viewport shapes (added via the viewport toolbar; inline gizmo to
  // transform). Right-click is left free for OrbitControls pan/orbit. ---------
  const containerRef = useRef<HTMLDivElement>(null)
  // WebGL context-loss state: some GPUs/drivers (e.g. AMD/Mesa via ANGLE on Linux)
  // drop the context and Chrome's `exit_on_context_lost` workaround prevents JS
  // recovery. Rather than leave a blank-white canvas, we AUTO-REBUILD (bump
  // `glEpoch` → remount the <Canvas> = fresh context) shortly after a loss so the
  // user never has to click; a manual button stays as a fallback.
  const [glLost, setGlLost] = useState(false)
  const [glEpoch, setGlEpoch] = useState(0)

  // ---- Lasso-delete state ----------------------------------------------------
  // While drawing: polygon points in CANVAS px. On release the polygon is handed
  // to an in-Canvas projector (LassoApply) which selects enclosed segments; the
  // result becomes `lassoSel` (red-highlighted) awaiting Delete/Cancel.
  const [lassoPoly, setLassoPoly] = useState<[number, number][]>([])
  const lassoDrawing = useRef(false)
  const [lassoApplyPoly, setLassoApplyPoly] = useState<[number, number][] | null>(null)
  const [lassoSel, setLassoSel] = useState<{ idx: Set<number>; kept: Segment[] } | null>(null)
  // Leaving lasso mode (or a fresh program) clears any pending selection.
  useEffect(() => {
    if (!lasso) {
      setLassoPoly([])
      setLassoApplyPoly(null)
      setLassoSel(null)
    }
  }, [lasso])

  // Auto-recover: if the context is still lost ~1.2s after the event (i.e. the
  // browser did not fire `webglcontextrestored` on its own), remount the Canvas.
  useEffect(() => {
    if (!glLost) return
    const id = setTimeout(() => {
      setGlLost(false)
      setGlEpoch((n) => n + 1)
    }, 1200)
    return () => clearTimeout(id)
  }, [glLost])
  const shapes = useViewportShapes((s) => s.shapes)
  const selectShape = useViewportShapes((s) => s.select)
  const removeShape = useViewportShapes((s) => s.removeShape)

  // Delete the selected shape with Delete/Backspace — but ONLY when the viewport
  // is the focus of attention (pointer over it, or it contains the focused
  // element). Otherwise a Delete/Backspace pressed anywhere else in the app would
  // silently destroy the selected shape.
  const hoverRef = useRef(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))
        return
      const el = containerRef.current
      const scoped = hoverRef.current || !!(el && el.contains(document.activeElement))
      if (!scoped) return
      const id = useViewportShapes.getState().selectedId
      if (id) {
        e.preventDefault()
        removeShape(id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [removeShape])

  // Live G-code: shapes → safe G-code → program store section "viewport shapes".
  // Debounced so dragging the gizmo doesn't thrash the program/visualizer.
  useEffect(() => {
    const handle = setTimeout(() => {
      const gcodeOut = shapesToGcode(shapes)
      const prog = useProgram.getState()
      const existing = prog.sections.find((s) => s.name === 'viewport shapes')
      if (gcodeOut.trim() === '') {
        // No shapes left → drop our section if one exists.
        if (existing) prog.removeSection(existing.id)
      } else {
        prog.setProgram('viewport shapes', gcodeOut)
      }
    }, 200)
    return () => clearTimeout(handle)
  }, [shapes])

  return (
    <div
      ref={containerRef}
      style={{ position: 'relative', height: '100%', width: '100%' }}
      onPointerEnter={() => (hoverRef.current = true)}
      onPointerLeave={() => (hoverRef.current = false)}
    >
      <Canvas
        key={glEpoch}
        style={{ height: '100%', width: '100%', background: bg }}
        // Measure with offsetWidth/Height (layout px), NOT getBoundingClientRect.
        // The app's global UI zoom uses CSS `zoom` on <html>; getBoundingClientRect
        // returns ZOOMED dimensions, which r3f would then size the canvas to —
        // and the canvas (inside the zoomed tree) gets scaled AGAIN, leaving blank
        // space on zoom-out. offsetSize avoids that double-scaling so the 3D view
        // always fills the panel at any zoom.
        resize={{ offsetSize: true }}
        camera={{ position: [200, -260, 220], up: [0, 0, 1], fov: FOV, near: 0.1, far: 5000 }}
        // Conservative renderer settings so weak/buggy integrated GPUs (e.g. AMD
        // Vega + Mesa via ANGLE on Linux) are far less likely to drop the WebGL
        // context: no MSAA buffers, don't fail on a perf caveat, and cap the device
        // pixel ratio so the framebuffer never balloons on a HiDPI display.
        gl={{ antialias: false, failIfMajorPerformanceCaveat: false, powerPreference: 'default' }}
        dpr={[1, 1.5]}
        // WebGL CONTEXT-LOSS handling: a driver can drop the context (GPU OOM,
        // power-switch, tab backgrounding). preventDefault() asks the browser to
        // restore it; on restore we re-render. On drivers where Chrome applies
        // `exit_on_context_lost` (no JS recovery), we instead show a fallback with a
        // one-click rebuild (see glLost overlay below).
        onCreated={(state) => {
          const canvas = state.gl.domElement
          canvas.addEventListener(
            'webglcontextlost',
            (e) => {
              e.preventDefault()
              setGlLost(true)
            },
            false,
          )
          canvas.addEventListener(
            'webglcontextrestored',
            () => {
              setGlLost(false)
              try {
                state.invalidate()
              } catch {
                /* best-effort repaint after restore */
              }
            },
            false,
          )
        }}
        // Canvas-level miss: a left-click that hits NO object (truly empty space,
        // not a gizmo handle or a shape) clears the selection. Using the
        // Canvas-level hook — rather than a deselect handler on the bed catcher —
        // means clicking a gizmo handle (which IS an object) never deselects, so
        // the inline gizmo's resize/rotate handles stay grabbable.
        onPointerMissed={(e) => {
          if ((e as MouseEvent).button === 0) {
            selectShape(null)
            // A left-click in truly empty space dismisses the placement gizmo.
            onGizmoChange?.(false)
          }
        }}
      >
        <ambientLight intensity={0.8} />
        <directionalLight position={[100, -100, 300]} intensity={0.6} />
        <Bed width={width} depth={depth} height={height} />
        <ViewportShapes onDraggingChanged={onGizmoDragging} />
        <StockBlock visible={showStock} />
      {carveSim && revealIndex !== undefined && revealIndex >= 0 && (
        <CarvedStock
          segments={parsed.segments}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
          toolRadius={toolRadius}
        />
      )}
      {/* Toolpaths. During SIMULATION (reveal) we draw the combined path with the
          traveled/upcoming split. Otherwise we draw EACH section in its own colour
          and its own group, so distinct jobs are separable and the placement
          gizmo can live-drag ONLY the selected section's group (matrixAutoUpdate
          off on that one; the gizmo writes its matrix imperatively at 60fps and
          resets to identity once the new placement is baked). */}
      {revealing ? (
        parsed.segments.length > 0 && (
          <Toolpath
            segments={parsed.segments}
            revealIndex={revealIndex}
            revealPoint={revealPoint}
          />
        )
      ) : sectionPaths && sectionPaths.length > 0 ? (
        sectionPaths.map((sp) => {
          const isLive = sp.id === liveSectionId
          return (
            <group
              key={sp.id}
              ref={isLive ? liveGroupRef : undefined}
              matrixAutoUpdate={!isLive}
            >
              <Toolpath segments={sp.segments} cutColor={sp.color} />
            </group>
          )
        })
      ) : (
        parsed.segments.length > 0 && <Toolpath segments={parsed.segments} />
      )}
      {parsed.bounds && <BoundsBox bounds={parsed.bounds} dark={theme === 'dark'} />}
      {/* Engineering-style 3D dimension annotations (toggleable from the toolbar). */}
      {showDimensions && parsed.bounds && (
        <Dimensions bounds={parsed.bounds} dark={theme === 'dark'} />
      )}
      {/* Red sphere marking the toolpath START (where work-zero / "Zero all" sits). */}
      {parsed.segments.length > 0 && (
        <ToolpathStartMarker start={parsed.segments[0].from} dark={theme === 'dark'} />
      )}
      {/* Actual (live machine) spindle cone — amber. */}
      {showActualTool && toolPosition && <ToolMarker position={toolPosition} />}
      {/* Simulation spindle cone — cyan, so it reads distinct from the live one. */}
      {showSimTool && simPosition && (
        <ToolMarker position={simPosition} color={theme === 'dark' ? '#22d3ee' : '#0891b2'} />
      )}
      {gizmo && (
        <PlacementGizmo onDraggingChanged={onGizmoDragging} liveGroupRef={liveGroupRef} />
      )}
      {/* Per-section click-to-select affordances: each toolpath gets a faint,
          clickable bounding box. Clicking one selects THAT section and turns the
          placement gizmo on. The boxes stay mounted EVEN for the selected section
          while the gizmo is on — if the selected box unmounted on click, the same
          gesture's pointer-up would land on no object, fire `onPointerMissed`, and
          immediately hide the gizmo (the "flashes then disappears" bug). Keeping
          it mounted means the gesture always hits an object, so the gizmo stays.
          Gizmo handles render on top with stopPropagation, so they stay grabbable;
          clicking the box (re-selecting the same section) is an idempotent no-op. */}
      {onSelectSection &&
        sectionBoxes?.map((sb) => {
          const isSelected = sb.id === selectedSectionId
          return (
            <JobSelectAffordance
              key={sb.id}
              bounds={sb.bounds}
              dark={theme === 'dark'}
              active={isSelected}
              onSelect={() => {
                onSelectSection(sb.id)
                onGizmoChange?.(true)
              }}
            />
          )
        })}
      {/* Lasso: project segments enclosed by the drawn polygon → selection. */}
      {lasso && lassoApplyPoly && parsed.segments.length > 0 && (
        <LassoApply
          polygon={lassoApplyPoly}
          segments={parsed.segments}
          onResult={(idx, kept) => {
            setLassoApplyPoly(null)
            setLassoSel(idx.size > 0 ? { idx, kept } : null)
          }}
        />
      )}
      {/* Red highlight of the lasso-selected moves, pending Delete/Cancel. */}
      {lasso && lassoSel && (
        <SelectedSegments segments={parsed.segments} indices={lassoSel.idx} />
      )}
      {/* Live camera → 3D overlay (self-gated on the camera-calib store's `enabled`). */}
      <CameraBedPlane />
      <JobBox />
      <OrbitControls ref={orbitRef} makeDefault enableDamping dampingFactor={0.1} />
      {/* SolidWorks/FreeCAD-style orientation cube (upper-right). Clicking a
          face/edge/corner tweens the camera to that view. It drives the default
          OrbitControls, so it stays in sync with manual orbiting. */}
      {/* Pushed down (marginY) so the toolbar buttons don't overlap it, and
          scaled to ~80% via an inner group (GizmoHelper has no size prop). */}
      <GizmoHelper alignment="top-right" margin={[60, 108]}>
        <group scale={0.8}>
          <GizmoViewcube
            // Relabel for our Z-up world (drei's cube assumes Y-up). Material order
            // is [+X, -X, +Y, -Y, +Z, -Z]: +Z is Top, -Z Bottom, +Y Back, -Y Front.
            faces={['Right', 'Left', 'Back', 'Front', 'Top', 'Bottom']}
            color={theme === 'dark' ? '#2a2f37' : '#dfe6ee'}
            textColor={theme === 'dark' ? '#cfd6dd' : '#1c2128'}
            strokeColor={theme === 'dark' ? '#5eead4' : '#0e7c66'}
            hoverColor={theme === 'dark' ? '#5eead4' : '#0e7c66'}
          />
        </group>
      </GizmoHelper>
      <ViewController bounds={controlBounds} bedSize={bedSize} apiRef={apiRef} />
      </Canvas>
      {/* Lasso DRAW surface (HTML, captures the freeform polygon in canvas px).
          Shown only while in lasso mode with no pending selection. */}
      {lasso && !lassoSel && (
        <div
          style={{ position: 'absolute', inset: 0, cursor: 'crosshair', zIndex: 6, touchAction: 'none' }}
          onPointerDown={(e) => {
            lassoDrawing.current = true
            const r = e.currentTarget.getBoundingClientRect()
            setLassoPoly([[e.clientX - r.left, e.clientY - r.top]])
            try {
              e.currentTarget.setPointerCapture(e.pointerId)
            } catch {
              /* best-effort */
            }
          }}
          onPointerMove={(e) => {
            if (!lassoDrawing.current) return
            const r = e.currentTarget.getBoundingClientRect()
            setLassoPoly((p) => [...p, [e.clientX - r.left, e.clientY - r.top]])
          }}
          onPointerUp={() => {
            lassoDrawing.current = false
            setLassoPoly((p) => {
              if (p.length >= 3) setLassoApplyPoly(p)
              return []
            })
          }}
        >
          {lassoPoly.length > 1 && (
            <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
              <polygon
                points={lassoPoly.map((p) => `${p[0]},${p[1]}`).join(' ')}
                fill="rgba(94,234,212,0.15)"
                stroke="#5eead4"
                strokeWidth={1.5}
              />
            </svg>
          )}
        </div>
      )}
      {/* Confirm bar once a lasso selection exists. */}
      {lasso && lassoSel && (
        <div
          style={{
            position: 'absolute',
            left: '50%',
            bottom: 14,
            transform: 'translateX(-50%)',
            zIndex: 7,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '8px 12px',
            borderRadius: 8,
            background: 'var(--bg-elev, #1b1f24)',
            border: '1px solid var(--border, #3a4048)',
            boxShadow: '0 6px 22px rgba(0,0,0,0.4)',
            font: '12px/1.3 system-ui, sans-serif',
            color: 'var(--fg, #cfd6dd)',
          }}
        >
          <span>
            {t('vz.lassoSelected', 'Delete {n} selected move(s)? Safe-Z is kept around the gap.', {
              n: String(lassoSel.idx.size),
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              onLassoDelete?.(lassoSel.kept)
              setLassoSel(null)
            }}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: 'none',
              background: 'var(--danger, #e5484d)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {t('vz.lassoDelete', 'Delete')}
          </button>
          <button
            type="button"
            onClick={() => setLassoSel(null)}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid var(--border, #3a4048)',
              background: 'transparent',
              color: 'var(--fg, #cfd6dd)',
              cursor: 'pointer',
            }}
          >
            {t('common.cancel', 'Cancel')}
          </button>
        </div>
      )}
      {glLost && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            padding: 24,
            textAlign: 'center',
            background: bg,
            color: 'var(--fg, #cfd6dd)',
            font: '13px/1.5 system-ui, sans-serif',
          }}
        >
          <div style={{ fontSize: 26 }} aria-hidden="true">⚠</div>
          <div style={{ maxWidth: 340 }}>
            {t(
              'vz.glLostAuto',
              'The 3D view lost the GPU (WebGL) context — usually a graphics-driver hiccup. Reloading automatically… the rest of the app is unaffected.',
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setGlLost(false)
              setGlEpoch((n) => n + 1)
            }}
            style={{
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid var(--border, #3a4048)',
              background: 'var(--accent, #0e7c66)',
              color: '#fff',
              cursor: 'pointer',
            }}
          >
            {t('vz.glReload', 'Reload 3D view')}
          </button>
        </div>
      )}
    </div>
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

/**
 * A faint, clickable box around the loaded program's bounds. It is the
 * "grab the job" affordance: clicking it turns on the placement gizmo. Kept
 * subtle (low opacity, no depth-write) so it never competes with the toolpath,
 * and given a minimum thickness so a perfectly flat job is still easy to click.
 *
 * CRITICAL for the gizmo: when this box is the SELECTED one (the gizmo is on),
 * its material is rendered BACK-side only. The gizmo's move/rotate handles sit at
 * the section centre — IN FRONT of the box's far (back) faces but BEHIND its near
 * (front) faces. r3f sorts ray hits near→far and the first handler that calls
 * stopPropagation wins. With a DoubleSide box the NEAR face is closer than the
 * handles, so the box swallowed every click and OrbitControls rotated the view
 * instead of the handle grabbing (the "I click the arrow but it just rotates"
 * bug). BackSide removes the near face from raycasting, so a handle is always the
 * nearest hit and grabs first — while clicking the bare job body still lands on
 * the far face (a hit, so the gizmo isn't dismissed).
 */
function JobSelectAffordance({
  bounds,
  dark,
  onSelect,
  active = false,
}: {
  bounds: Bounds
  dark: boolean
  onSelect: () => void
  active?: boolean
}) {
  const { size, center, valid } = useMemo(() => {
    const [x0, y0, z0] = bounds.min
    const [x1, y1, z1] = bounds.max
    const sx = Math.max(x1 - x0, 1)
    const sy = Math.max(y1 - y0, 1)
    const sz = Math.max(z1 - z0, 2)
    const ok = x1 - x0 > 1e-6 || y1 - y0 > 1e-6
    return {
      size: [sx, sy, sz] as [number, number, number],
      center: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2] as [number, number, number],
      valid: ok,
    }
  }, [bounds])

  if (!valid) return null
  const color = active ? (dark ? '#f59e0b' : '#b45309') : dark ? '#5eead4' : '#0e7c66'

  return (
    <mesh
      position={center}
      onPointerDown={(e) => {
        if ((e as unknown as { button: number }).button !== 0) return
        e.stopPropagation()
        onSelect()
      }}
    >
      <boxGeometry args={size} />
      <meshBasicMaterial
        color={color}
        transparent
        opacity={active ? 0.12 : 0.06}
        depthWrite={false}
        // Selected → BackSide so the gizmo handles (nearer than the far faces)
        // always win the click; unselected → DoubleSide for easy selection.
        side={active ? THREE.BackSide : THREE.DoubleSide}
      />
    </mesh>
  )
}

/** Even-odd ray-cast point-in-polygon (poly in the same px space as x,y). */
function pointInPolygon(x: number, y: number, poly: [number, number][]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0]
    const yi = poly[i][1]
    const xj = poly[j][0]
    const yj = poly[j][1]
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

/**
 * In-Canvas: project each segment's endpoints to canvas px and select the ones
 * whose BOTH ends lie inside the lasso polygon (so partial passes aren't half
 * cut). Runs once when a polygon arrives; reports the selected indices + the
 * segments to KEEP. Renders nothing.
 */
function LassoApply({
  polygon,
  segments,
  onResult,
}: {
  polygon: [number, number][]
  segments: Segment[]
  onResult: (selected: Set<number>, kept: Segment[]) => void
}) {
  const camera = useThree((s) => s.camera)
  const size = useThree((s) => s.size)
  useEffect(() => {
    const v = new THREE.Vector3()
    const toPx = (p: [number, number, number]): [number, number] => {
      v.set(p[0], p[1], p[2]).project(camera)
      return [(v.x * 0.5 + 0.5) * size.width, (-v.y * 0.5 + 0.5) * size.height]
    }
    const sel = new Set<number>()
    segments.forEach((s, i) => {
      const a = toPx(s.from)
      const b = toPx(s.to)
      if (pointInPolygon(a[0], a[1], polygon) && pointInPolygon(b[0], b[1], polygon)) sel.add(i)
    })
    const kept = segments.filter((_, i) => !sel.has(i))
    onResult(sel, kept)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polygon])
  return null
}

/** Draw the lasso-selected segments as bright red lines (the about-to-delete set). */
function SelectedSegments({ segments, indices }: { segments: Segment[]; indices: Set<number> }) {
  const geom = useMemo(() => {
    const pts: number[] = []
    indices.forEach((i) => {
      const s = segments[i]
      if (!s) return
      pts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
    })
    if (pts.length === 0) return null
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [segments, indices])
  useEffect(() => () => geom?.dispose(), [geom])
  if (!geom) return null
  return (
    <lineSegments geometry={geom}>
      <lineBasicMaterial color="#ef4444" depthTest={false} transparent opacity={0.95} />
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
