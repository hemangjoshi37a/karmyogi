import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useEffect,
  useCallback,
} from 'react'
import { Canvas, useThree, useFrame } from '@react-three/fiber'
import { OrbitControls, GizmoHelper, GizmoViewcube, Environment, Lightformer } from '@react-three/drei'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import * as THREE from 'three'
import { Bed } from './Bed'
import { Toolpath } from './Toolpath'
import { SpindleTool } from './SpindleTool'
import { StockBlock } from './StockBlock'
import { CarvedStock } from './CarvedStock'
import { PlacementGizmo } from './PlacementGizmo'
import { CameraBedPlane } from './CameraBedPlane'
import { JobBox } from './JobBox'
import { BBoxCube } from './BBoxCube'
import { ViewportShapes } from './ViewportShapes'
import { Dimensions, type PerFileDimension } from './Dimensions'
import { SpringScene } from './SpringScene'
import { useSpringViz } from '../store/springViz'
import { SolderScene } from './SolderScene'
import { useSolderViz } from '../store/solderViz'
import { ToolpathStartMarker } from './ToolpathStartMarker'
import { CameraQuatReporter, AxisOverlay } from './AxisOverlay'
import { RunOutline } from './RunOutline'
import { prefersReducedMotion } from './reducedMotion'
import { useViewportShapes } from '../store/viewportShapes'
import { shapesToGcode } from '../core/viewportShapeGcode'
import { useProgram } from '../store/program'
import { usePlayback } from '../store/playback'
import { useT } from '../i18n'
import { gcodeToPolylines, type Segment, type Bounds } from './gcodeToPolylines'
import {
  frameBounds,
  fitToBounds,
  boundsCenter,
  boundsRadius,
  fitDistance,
  type Bounds3,
  type ViewName,
} from './viewControls'

/**
 * Preset camera views exposed by the toolbar (V5). A superset of viewControls'
 * `ViewName` — `right` is computed locally here (looking along -X onto the YZ
 * plane) so the pure helper module stays unchanged.
 */
export type PresetView = ViewName | 'right'
import { useSettings } from '../store'
import { useBed } from '../store/bed'

// --- Orientation CUBE (the clickable view gizmo) ---
// drei renders only ONE GizmoHelper at a time, so this helper holds JUST the cube;
// the colored XYZ axis triad is a SEPARATE independent overlay (see AxisOverlay).
function OrientationGizmo({ theme }: { theme: string }) {
  return (
    <GizmoHelper alignment="top-right" margin={[72, 116]}>
      {/* Cube — centred + enlarged so the face names are readable. */}
      <group scale={0.78}>
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
  )
}

export interface ViewerHandle {
  /** Fit the toolpath to the viewport, keeping the current angle. */
  fit: () => void
  /** Snap to a named preset view (iso / top / front / right), reframed to bounds. */
  setView: (view: PresetView) => void
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
   * During a reveal, fully HIDE the already-processed cut lines (leaving only the
   * remaining work) instead of dimming them. Default false. Exposed so the panel
   * / orchestrator can offer the "hide processed" toggle from V3.
   */
  hideProcessed?: boolean
  /**
   * Material-removal simulation: when true AND a reveal is active, render the
   * stock as a heightmap surface that is progressively carved by the done cut
   * moves (the already-machined region reveals its cut surface). Default false.
   */
  carveSim?: boolean
  /** Cutter radius (mm) for the material-removal sim. Default 1.5. */
  toolRadius?: number
  /**
   * Cutter profile for the material-removal sim (flat endmill / ball-nose /
   * V-bit). Shapes the carved floor (a ball mill leaves a rounded groove).
   * Default 'flat'.
   */
  carveToolType?: 'flat' | 'ball' | 'vee'
  /**
   * Auto-derive a stock block from the toolpath for the carve sim when the stock
   * store has no usable block — this many mm of material below the deepest cut.
   * Lets ANY loaded program be simulated without a configured stock. Default off.
   */
  carveAutoThickness?: number | null
  /**
   * Spin the spindle/bit (job running or being scrubbed). Drives the subtle
   * tool-mesh whirr; gated internally on the user's reduced-motion preference.
   * Default false.
   */
  spinning?: boolean
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
   * 3D-carving job boxes: ONE tight bounding cube PER carve job, computed from
   * each job's MESH bbox transformed by its PLACEMENT (its true position/size on
   * the bed). When provided AND non-empty, these REPLACE the single combined
   * gcode-bounds box (which wrongly spans the work origin → the model) — each job
   * gets its own cube hugging its actual min→max extent on all three axes.
   * Respects the same `showJobBoxes` visibility toggle as the section boxes.
   */
  jobBoxes?: { id: string; min: [number, number, number]; max: [number, number, number] }[]
  /**
   * Per-section parsed segments + colour. When provided (and not simulating),
   * each toolpath renders in its OWN colour and its OWN group, so distinct jobs
   * are visually separable and the placement gizmo can live-drag ONLY the
   * selected section (not every toolpath).
   *
   * `operations` (optional) carries the section's per-operation breakdown: each
   * carving op's OWN parsed segments + preset colour. When present, the section
   * draws one coloured line group PER operation (so a profile, a pocket, an
   * engrave from different presets each show in their preset's colour) instead
   * of a single section-coloured path. The whole section still lives in one
   * group (so placement / visibility / live-drag stay per-section).
   */
  sectionPaths?: {
    id: string
    segments: Segment[]
    color: string
    operations?: { id: string; segments: Segment[]; color: string }[]
  }[]
  /**
   * Id of the operation currently hovered in the carving Operations list or the
   * Program-tab per-op rows. The matching per-op toolpath SHIMMERS (an animated
   * highlight) so the user can see which line corresponds to which operation.
   * Null = nothing hovered (every op renders normally).
   */
  hoveredOpId?: string | null
  /** The currently selected section id (its box reads as active). */
  selectedSectionId?: string | null
  /** Called with a section id when its toolpath box is clicked. */
  onSelectSection?: (id: string) => void
  /** Lasso-delete mode: drag a freeform region over the toolpath to select moves. */
  lasso?: boolean
  /** Called with the KEPT segments after the user confirms a lasso deletion. */
  onLassoDelete?: (kept: Segment[]) => void
  /** Called to EXIT lasso mode (Cancel button / Escape) without deleting. */
  onLassoExit?: () => void
  /**
   * Pick mode: click a single toolpath line/segment to select it; Shift/Ctrl-
   * click adds/removes from a multi-selection. Distinct from lasso (only one
   * active at a time). Reuses the SAME selection→re-emit pipeline as the lasso.
   */
  pick?: boolean
  /** Called with the KEPT segments after the user confirms a pick deletion. */
  onPickDelete?: (kept: Segment[]) => void
  /** Called to EXIT pick mode (Cancel button / Escape) without deleting. */
  onPickExit?: () => void
  /**
   * Show the faint colored per-section selection boxes (the "toolpath cubes"
   * that double as click-to-select-gizmo hit regions). Default true.
   */
  showJobBoxes?: boolean
  /**
   * Show the engineering-style 3D dimension annotations (X/Y/Z extension +
   * dimension lines with arrowheads and the measurement in mm) around the
   * loaded program's bounding box. Default false.
   */
  showDimensions?: boolean
  /**
   * Layers overlay: master show/hide for ALL toolpaths (per-section paths AND
   * the combined/reveal path). Default true.
   */
  showToolpaths?: boolean
  /**
   * Layers overlay: per-section visibility, keyed by section id. A section
   * missing from the map (or mapped to a non-false value) is shown. Lets the
   * legend tree hide individual toolpaths. Default: all visible.
   */
  sectionVisibility?: Record<string, boolean>
  /**
   * Layers overlay: show the model / drawing preview (the viewport-drawn 2D/3D
   * shapes). Default true.
   */
  showShapes?: boolean
  /**
   * Layers overlay: show the machine bed (grid + dimensions + bed wireframe
   * cube). Default true.
   */
  showBed?: boolean
  /**
   * O6 run-outline / bounds preview: draw the loaded program's XY bounding
   * rectangle flat on the bed so the operator sees the footprint (and whether it
   * fits the bed) BEFORE running. Default false. The panel supplies the already-
   * computed program bounds (`runOutlineBounds`) so the viewer never re-parses.
   */
  showRunOutline?: boolean
  /** Program XY bounds for the run-outline (panel-computed; reused, not re-parsed). */
  runOutlineBounds?: { min: [number, number, number]; max: [number, number, number] } | null
  /** Bed-fit verdict from the panel — colours the outline (ok / warn / danger). */
  runOutlineFit?: 'ok' | 'warn' | 'danger'
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
    hideProcessed = false,
    carveSim = false,
    toolRadius = 1.5,
    carveToolType = 'flat',
    carveAutoThickness = null,
    spinning: spinningProp,
    gizmo = false,
    onGizmoChange,
    sectionBoxes,
    jobBoxes,
    sectionPaths,
    hoveredOpId = null,
    selectedSectionId,
    onSelectSection,
    lasso = false,
    onLassoDelete,
    onLassoExit,
    pick = false,
    onPickDelete,
    onPickExit,
    showJobBoxes = true,
    showDimensions = false,
    showToolpaths = true,
    sectionVisibility,
    showShapes = true,
    showBed = true,
    showRunOutline = false,
    runOutlineBounds = null,
    runOutlineFit = 'ok',
  },
  ref,
) {
  const theme = useSettings((s) => s.theme)
  const uiScale = useSettings((s) => s.uiScale)
  const t = useT()
  const bg = theme === 'dark' ? '#15181c' : '#e7ecf1'

  // Spin the spindle/bit while the simulation is playing (or whenever the caller
  // explicitly asks). When the prop is omitted we self-derive it from the
  // playback store so a running preview whirs without the panel wiring anything.
  // Reading the store here is fine — we never MUTATE it (that stays the panel's
  // job); the SpindleTool gates the actual motion on reduced-motion.
  const isPlaying = usePlayback((s) => s.isPlaying)
  const spinning = spinningProp ?? isPlaying

  // Spring-coiling preview channel: when the Spring panel owns the program (its
  // 3D-coil-preview output mode), it publishes the spring dimensions here. We then
  // swap the generic Δx/Δy/Δz dimension overlay for the spring-specialized scene.
  // Gated additionally on the active program actually being a "Spring coil"
  // section so the spring annotations can never bleed over a non-spring program.
  const springActive = useSpringViz((s) => s.active)
  const programSummaryName = useProgram((s) => s.name)
  const isSpringProgram =
    springActive && !!programSummaryName && programSummaryName.includes('Spring coil')
  // Soldering: a 3D PCB stand-in (board + pads/holes) + selected-point highlight,
  // shown alongside the streamed toolpath whenever the Soldering panel publishes.
  const solderActive = useSolderViz((s) => s.active)

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
  const springParams = useSpringViz((s) => s.params)
  // For a spring program, the parsed program's Y axis carries the chuck angle in
  // DEGREES (cumulative, up to turns×360) — so `parsed.bounds` is a giant, mostly
  // empty box and framing/fit would lose the little coil. Frame the actual COIL
  // geometry instead (axis +X 0→freeLength, radius R lifted to rest on the bed),
  // with a little room for the chuck/annotations.
  const controlBounds: Bounds3 | null = useMemo(() => {
    if (isSpringProgram && springParams) {
      const R = Math.max(0.5, springParams.coilDiameter / 2)
      const L = Math.max(R, springParams.freeLength)
      return {
        min: [-R * 1.8, -R * 1.4, 0] as [number, number, number],
        max: [L + R * 0.6, R * 1.4, 2 * R * 1.1] as [number, number, number],
      }
    }
    // Frame the toolpath's ACTUAL extent (from segment endpoints), NOT
    // `parsed.bounds` — that seeds the work origin (0,0,0) into the box, so a job
    // sitting away from origin (e.g. a small PCB at X55–85) gets an inflated box
    // spanning origin→job and ends up tiny in a corner after Fit. The segment
    // extent frames just the job, so small jobs fill the view. Falls back to
    // parsed.bounds (then the bed) when there are no segments.
    const seg = boundsOf(parsed.segments)
    if (seg) return { min: seg.min, max: seg.max }
    return parsed.bounds ? { min: parsed.bounds.min, max: parsed.bounds.max } : null
  }, [isSpringProgram, springParams, parsed.bounds, parsed.segments])

  // ---- Dimension extents -----------------------------------------------------
  // The dimension overlay measures the toolpath's ACTUAL size (Δx, Δy, Δz). We
  // compute it from the segment endpoints (the real moves), NOT from
  // `parsed.bounds` — that bound seeds the work origin (0,0,0) into the box, so a
  // job sitting away from zero would otherwise read its distance-from-origin
  // instead of its own width/depth/height.
  const programSections = useProgram((s) => s.sections)
  // Per-file extents: when multiple files/models are loaded, derive each one's
  // own extent from its section's segments (preferring the per-section paths the
  // panel already parses; falling back to the program-store section names).
  const isRevealing = revealIndex !== undefined && revealIndex >= 0
  const perFileDims = useMemo<PerFileDimension[] | undefined>(() => {
    if (isRevealing || !sectionPaths || sectionPaths.length === 0) return undefined
    const nameById = new Map(programSections.map((s) => [s.id, s.name]))
    const out: PerFileDimension[] = []
    for (const sp of sectionPaths) {
      const b = boundsOf(sp.segments)
      if (b) out.push({ id: sp.id, name: nameById.get(sp.id) ?? sp.id, bounds: b })
    }
    return out.length > 0 ? out : undefined
  }, [sectionPaths, programSections, isRevealing])
  // Combined extent for the 3D arrow annotation: the union of the per-file
  // extents when available, else the extent of the single parsed program.
  const dimExtent = useMemo<Bounds | null>(() => {
    if (perFileDims && perFileDims.length > 0) return unionBounds(perFileDims.map((f) => f.bounds))
    return boundsOf(parsed.segments)
  }, [perFileDims, parsed.segments])

  const apiRef = useRef<ViewerHandle>({ fit: () => {}, setView: () => {} })
  useImperativeHandle(ref, () => ({
    fit: () => apiRef.current.fit(),
    setView: (v: PresetView) => apiRef.current.setView(v),
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
  const revealing = isRevealing
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

  // DEV: publish 3D health to the dev-bridge state mirror so an agent on the
  // server can SEE whether the WebGL context is alive (vs lost/blank) without
  // needing the rendered frame. Written by the parent Viewer, which stays mounted
  // even when the <Canvas> children unmount on context loss. A `forceRebuild`
  // remount can also be triggered remotely via the 'rebuildGl' app command.
  const forceRebuild = useCallback(() => {
    setGlLost(false)
    setGlEpoch((n) => n + 1)
  }, [])
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __viewerHealth?: unknown }).__viewerHealth = {
      glLost,
      glEpoch,
      t: Date.now(),
    }
    const onApp = (e: Event) => {
      const action = String((e as CustomEvent).detail || '')
      if (action === 'rebuildGl') return forceRebuild()
      // Remote camera framing so an agent can inspect the twin from a known angle
      // (top-down is needed to judge the 1:1 mapping). view:top|iso|front | fit.
      if (action === 'view:top') return apiRef.current.setView('top')
      if (action === 'view:iso') return apiRef.current.setView('iso')
      if (action === 'view:front') return apiRef.current.setView('front')
      if (action === 'fit') return apiRef.current.fit()
    }
    window.addEventListener('karmyogi:app', onApp as EventListener)
    return () => window.removeEventListener('karmyogi:app', onApp as EventListener)
  }, [glLost, glEpoch, forceRebuild, apiRef])

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

  // ---- Pick (individual segment) selection -----------------------------------
  // A click on a toolpath line in pick mode toggles that segment in this set
  // (plain click = single-select; Shift/Ctrl-click = add/remove). The set indexes
  // into `parsed.segments`, the SAME array the lasso selects from — so deletion
  // can reuse the exact selection→re-emit pipeline.
  const [pickSel, setPickSel] = useState<Set<number>>(new Set())
  // Leaving pick mode (or a fresh program) clears the selection.
  useEffect(() => {
    if (!pick) setPickSel(new Set())
  }, [pick])
  // A new program (different segment array) invalidates stale indices.
  useEffect(() => {
    setPickSel(new Set())
  }, [parsed.segments])

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

  // Pick-mode keyboard: Delete/Backspace removes the current individual selection
  // (via the SAME re-emit pipeline as the lasso); Escape clears the selection, or
  // exits pick mode when nothing is selected — mirroring the lasso's Escape.
  useEffect(() => {
    if (!pick) return
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable))
        return
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (pickSel.size === 0) return
        const el = containerRef.current
        const scoped = hoverRef.current || !!(el && el.contains(document.activeElement))
        if (!scoped) return
        e.preventDefault()
        const kept = parsed.segments.filter((_, i) => !pickSel.has(i))
        onPickDelete?.(kept)
        setPickSel(new Set())
      } else if (e.key === 'Escape') {
        e.preventDefault()
        if (pickSel.size > 0) setPickSel(new Set())
        else onPickExit?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pick, pickSel, parsed.segments, onPickDelete, onPickExit])

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
        gl={{
          antialias: false,
          failIfMajorPerformanceCaveat: false,
          powerPreference: 'default',
          // DEV: lets us snapshot the 3D canvas (toBlob) and POST it to the bridge
          // so an agent can SEE the rendered overlay/twin, not just the camera feed.
          preserveDrawingBuffer: import.meta.env.DEV,
        }}
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
        {/* Lighting rig tuned for the metallic spindle: a soft ambient base, a
            key directional from the front-top, a cooler fill from behind, and a
            tight rim that puts a crisp specular streak on the steel body. The
            studio Environment supplies image-based reflections so the metalwork
            reads premium (not flat-grey) in both themes. */}
        <ambientLight intensity={theme === 'dark' ? 0.9 : 1.05} />
        <directionalLight position={[120, -120, 320]} intensity={0.9} />
        <directionalLight position={[-140, 120, 180]} intensity={0.5} />
        <directionalLight position={[0, 40, 260]} intensity={0.5} />
        {/* Self-contained studio Environment (no remote HDR fetch — offline-safe):
            a few Lightformer panels generate image-based reflections so the
            metallic spindle reads premium instead of flat. */}
        <Environment resolution={64} environmentIntensity={theme === 'dark' ? 0.7 : 0.9}>
          <Lightformer intensity={2.2} position={[0, 0, 60]} scale={[140, 140, 1]} color="#ffffff" />
          <Lightformer intensity={1.4} position={[80, 40, 40]} scale={[50, 90, 1]} color="#e6edf5" />
          <Lightformer intensity={1} position={[-80, -40, 30]} scale={[50, 70, 1]} color="#c2ccd8" />
        </Environment>

        <group visible={showBed}>
          <Bed width={width} depth={depth} height={height} showLabels={showBed} />
        </group>
        <group visible={showShapes}>
          <ViewportShapes onDraggingChanged={onGizmoDragging} />
        </group>
        <StockBlock visible={showStock && !isSpringProgram} />
      {carveSim && revealIndex !== undefined && revealIndex >= 0 && (
        <CarvedStock
          segments={parsed.segments}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
          toolRadius={toolRadius}
          toolType={carveToolType}
          autoThickness={carveAutoThickness}
        />
      )}
      {/* Toolpaths. During SIMULATION (reveal) we draw the combined path with the
          traveled/upcoming split. Otherwise we draw EACH section in its own colour
          and its own group, so distinct jobs are separable and the placement
          gizmo can live-drag ONLY the selected section's group (matrixAutoUpdate
          off on that one; the gizmo writes its matrix imperatively at 60fps and
          resets to identity once the new placement is baked). */}
      {/* Layers overlay master toggle: hide ALL toolpath geometry at once. For a
          Spring-coiling program the streamed G-code is the 2-axis rotary+linear
          program (NOT a 3D path) — drawing it as a polyline would be a meaningless
          flat line, so the generic toolpath is hidden and only <SpringScene> draws
          the wound coil. */}
      <group visible={showToolpaths && !isSpringProgram}>
        {revealing ? (
          parsed.segments.length > 0 && (
            <Toolpath
              segments={parsed.segments}
              revealIndex={revealIndex}
              revealPoint={revealPoint}
              hideProcessed={hideProcessed}
            />
          )
        ) : sectionPaths && sectionPaths.length > 0 ? (
          sectionPaths.map((sp) => {
            const isLive = sp.id === liveSectionId
            // Per-section visibility from the layers tree (absent / non-false = shown).
            const visible = sectionVisibility?.[sp.id] !== false
            return (
              <group
                key={sp.id}
                ref={isLive ? liveGroupRef : undefined}
                matrixAutoUpdate={!isLive}
                visible={visible}
              >
                {/* When the section carries a per-operation breakdown (carving
                    ops linked to presets), draw EACH op in its own preset
                    colour; otherwise fall back to the single section-coloured
                    path. Either way it's one group, so placement / live-drag /
                    visibility stay per-section. */}
                {sp.operations && sp.operations.length > 0 ? (
                  sp.operations.map((op) => {
                    const isHovered = hoveredOpId === op.id
                    // While SOME op is hovered, dim the others a touch so the
                    // shimmering one pops; nothing hovered → all normal.
                    const dimmed = hoveredOpId !== null && !isHovered
                    return (
                      <Toolpath
                        key={op.id}
                        segments={op.segments}
                        cutColor={op.color}
                        highlight={isHovered}
                        dim={dimmed}
                      />
                    )
                  })
                ) : (
                  <Toolpath segments={sp.segments} cutColor={sp.color} />
                )}
              </group>
            )
          })
        ) : (
          parsed.segments.length > 0 && <Toolpath segments={parsed.segments} />
        )}
      </group>
      {/* Soldering: the 3D PCB stand-in (board + pads/holes + selected-point
          highlight cone) drawn alongside the streamed toolpath. */}
      {solderActive && <SolderScene dark={theme === 'dark'} />}
      {/* For a Spring-coiling preview we render the spring-specialized scene
          (wire ⌀ / coil ⌀ / pitch / free length / turns + chuck + carriage) and
          SKIP the generic bounding box + Δx/Δy/Δz dimension overlay. */}
      {isSpringProgram ? (
        <SpringScene dark={theme === 'dark'} simPosition={simPosition} />
      ) : (
        <>
          {/* In 3D-carving mode (per-job mesh boxes provided) the combined
              gcode-bounds box is WRONG — it spans the work origin → the model.
              Suppress it and let the per-job cubes (below) bound each model. */}
          {parsed.bounds && !(jobBoxes && jobBoxes.length > 0) && (
            <BoundsBox bounds={parsed.bounds} dark={theme === 'dark'} />
          )}
          {/* Engineering-style 3D dimension annotations (toggleable from the toolbar).
              Measures the toolpath's actual EXTENT (Δx, Δy, Δz from segment endpoints),
              NOT the origin→extent distance: `gcodeToPolylines` seeds its bounds with
              the work origin (0,0,0), which would otherwise inflate the size of any
              job not starting at zero — so we recompute from the moves themselves. */}
          {showDimensions && dimExtent && (
            <Dimensions bounds={dimExtent} dark={theme === 'dark'} />
          )}
          {/* O6 run-outline: the program's XY footprint drawn flat on the bed,
              colour-coded by bed-fit, so the operator can judge placement before
              running. Bounds + verdict come pre-computed from the panel. */}
          {showRunOutline && runOutlineBounds && (
            <RunOutline bounds={runOutlineBounds} fit={runOutlineFit} dark={theme === 'dark'} />
          )}
        </>
      )}
      {/* Red sphere marking the toolpath START (where work-zero / "Zero all" sits).
          Hidden for a spring program — its 2-axis start point isn't a 3D location. */}
      {!isSpringProgram && parsed.segments.length > 0 && (
        <ToolpathStartMarker start={parsed.segments[0].from} dark={theme === 'dark'} />
      )}
      {/* Spindle cones are hidden for a spring program: its position is (X linear,
          Y=chuck-degrees, 0), so a generic cone would fly off along Y. The
          SpringScene's carriage (which tracks the X/linear position) is the tool
          indicator instead. */}
      {/* Actual (live machine) spindle — warm steel, amber tip. */}
      {showActualTool && toolPosition && !isSpringProgram && (
        <SpindleTool
          position={toolPosition}
          toolDiameter={toolRadius * 2}
          variant="actual"
          spinning={spinning}
        />
      )}
      {/* Simulation spindle — cool steel, cyan tip, so it reads distinct. */}
      {showSimTool && simPosition && !isSpringProgram && (
        <SpindleTool
          position={simPosition}
          toolDiameter={toolRadius * 2}
          variant="sim"
          spinning={spinning}
        />
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
        showJobBoxes &&
        /* In pick mode the clickable job boxes would swallow segment clicks
           (their stopPropagation wins the raycast), so suppress them while
           picking individual toolpath lines. */
        !pick &&
        /* For a Spring-coiling program the section bounds are computed from the
           raw 2-axis G-code, whose rotary axis holds cumulative DEGREES (e.g.
           ~3960 for 11 turns). A job box around that spans the whole spring length
           in X but ~4000 mm in Y — the faint "white strip running off to infinity
           in Y" the operator sees. The coil isn't a selectable 3D job anyway, so
           suppress the job boxes entirely for spring programs. */
        !isSpringProgram &&
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
      {/* 3D-carving per-job bounding cubes: ONE tight cube per carve job, around
          its PLACED mesh bbox (true position/size on the bed) — all three axes, so
          a flat-bottom part's box sits from its real minZ to maxZ, NOT from the
          work origin. Respects the same show-job-boxes visibility toggle; hidden
          for a spring program (no 3D job boxes there). The selected section's cube
          is highlighted so it lines up with the placement gizmo. */}
      {showJobBoxes &&
        !isSpringProgram &&
        jobBoxes?.map((jb) => (
          <BBoxCube
            key={jb.id}
            min={jb.min}
            max={jb.max}
            dark={theme === 'dark'}
            active={jb.id === selectedSectionId}
          />
        ))}
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
      {/* Pick mode: invisible raycast lines that map a click to a segment index. */}
      {pick && parsed.segments.length > 0 && (
        <PickSegments
          segments={parsed.segments}
          onPick={(i, additive) => {
            setPickSel((prev) => {
              const next = new Set(additive ? prev : [])
              if (additive && prev.has(i)) next.delete(i)
              else next.add(i)
              return next
            })
          }}
        />
      )}
      {/* Red highlight of the individually-picked moves, pending Delete/Cancel. */}
      {pick && pickSel.size > 0 && (
        <SelectedSegments segments={parsed.segments} indices={pickSel} />
      )}
      {/* Live camera → 3D overlay (self-gated on the camera-calib store's `enabled`). */}
      <CameraBedPlane />
      <ViewerBridge />
      <JobBox />
      <CameraQuatReporter />
      <OrbitControls ref={orbitRef} makeDefault enableDamping dampingFactor={0.1} />
      {/* SolidWorks/FreeCAD-style orientation cube (upper-right). Clicking a
          face/edge/corner tweens the camera to that view. It drives the default
          OrbitControls, so it stays in sync with manual orbiting. */}
      {/* Orientation CUBE (clickable faces), top-right. The colored XYZ axis triad
          is a SEPARATE overlay (AxisOverlay, below) — drei renders only one gizmo
          helper, so the axis can't share this one. */}
      <OrientationGizmo theme={theme} />
      <ViewController bounds={controlBounds} bedSize={bedSize} apiRef={apiRef} />
      </Canvas>
      {/* Colored XYZ axis indicator (top-left). Pure SVG overlay driven by the
          shared camera quaternion — NOT a second WebGL canvas — so it can't
          flicker/blank from context thrashing the way a 2nd <Canvas> did. */}
      <AxisOverlay theme={theme} />
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
            onClick={() => {
              setLassoSel(null)
              onLassoExit?.()
            }}
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
      {/* Confirm bar once an individual pick selection exists (mirrors the lasso). */}
      {pick && pickSel.size > 0 && (
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
            {t('vz.pickSelected', 'Delete {n} selected move(s)? Safe-Z is kept around the gap.', {
              n: String(pickSel.size),
            })}
          </span>
          <button
            type="button"
            onClick={() => {
              const kept = parsed.segments.filter((_, i) => !pickSel.has(i))
              onPickDelete?.(kept)
              setPickSel(new Set())
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
            onClick={() => setPickSel(new Set())}
            style={{
              padding: '5px 12px',
              borderRadius: 6,
              border: '1px solid var(--border, #3a4048)',
              background: 'transparent',
              color: 'var(--fg, #cfd6dd)',
              cursor: 'pointer',
            }}
          >
            {t('vz.pickClear', 'Clear')}
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
 * DEV-ONLY: periodically snapshot the 3D canvas and POST it to the bridge
 * (`/__camera_frame?name=viewer3d` → `.camera-frames/viewer3d.jpg`), so an agent
 * on the server can SEE the rendered scene/overlay/twin — not just the raw camera
 * feed — and verify changes visually. No-op (and stripped) in production.
 */
function ViewerBridge() {
  const busy = useRef(false)
  // Wall-clock (ms) of the last useFrame tick — so the timer below can tell when
  // requestAnimationFrame has been PAUSED (tab backgrounded) and fall back to a
  // manual render. r3f's clock stalls with rAF, so we use Date.now() here.
  const lastFrameAt = useRef(0)
  const lastCapAt = useRef(0)
  // r3f imperative getter — lets the setInterval read the CURRENT gl/scene/camera
  // outside the render loop so it can render + capture even when rAF is paused.
  const get = useThree((s) => s.get)

  const capture = (gl: THREE.WebGLRenderer) => {
    if (busy.current) return
    try {
      gl.domElement.toBlob(
        (blob) => {
          if (!blob) return
          busy.current = true
          fetch('/__camera_frame?name=viewer3d', {
            method: 'POST',
            headers: { 'content-type': 'image/jpeg' },
            body: blob,
          })
            .catch(() => {})
            .finally(() => {
              busy.current = false
            })
        },
        'image/jpeg',
        0.85,
      )
    } catch {
      /* ignore */
    }
  }

  // FOREGROUND path: capture inside the render loop (drawing buffer is fresh),
  // throttled to ~1.5s. Also records that rAF is alive.
  useFrame((state) => {
    if (!import.meta.env.DEV) return
    const now = Date.now()
    lastFrameAt.current = now
    if (now - lastCapAt.current < 1500) return
    lastCapAt.current = now
    capture(state.gl)
  })

  // BACKGROUND path: setInterval survives tab-backgrounding (rAF does not). If no
  // useFrame tick has happened recently (rAF paused), MANUALLY render the scene to
  // refresh the drawing buffer, then capture. This keeps the twin observable to an
  // agent on the server regardless of whether the tab is focused/visible.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const id = setInterval(() => {
      const now = Date.now()
      // Telemetry so the server-side agent can see WHY a hidden-tab capture
      // succeeds/fails (read via /__app_state → viewerDebug). Diagnostic only.
      const dbg: Record<string, unknown> = {
        t: now,
        hidden: typeof document !== 'undefined' ? document.hidden : null,
        frameAgeMs: now - lastFrameAt.current,
      }
      try {
        // rAF is alive → the useFrame path is handling capture; don't double up.
        if (now - lastFrameAt.current < 1200) {
          dbg.path = 'raf-alive'
          return
        }
        if (now - lastCapAt.current < 1500) {
          dbg.path = 'throttle'
          return
        }
        lastCapAt.current = now
        const { gl, scene, camera } = get()
        const el = gl.domElement
        dbg.canvas = `${el.width}x${el.height}`
        gl.render(scene, camera) // refresh the preserved drawing buffer off-rAF
        dbg.path = 'rendered'
        capture(gl)
      } catch (e) {
        dbg.path = 'error'
        dbg.err = String((e as Error)?.message || e)
      } finally {
        ;(window as unknown as { __viewerDebug?: unknown }).__viewerDebug = dbg
      }
    }, 1000)
    return () => clearInterval(id)
  }, [get])
  return null
}

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

  // V5 smooth view transition. A handler stashes the destination camera pose
  // here; useFrame eases toward it (position + orbit target). Gated on
  // prefers-reduced-motion — when set, we snap instantly (anim left null).
  const anim = useRef<{
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTgt: THREE.Vector3
    toTgt: THREE.Vector3
    t: number
    dur: number
  } | null>(null)

  useEffect(() => {
    const snap = (pos: [number, number, number], target: [number, number, number]) => {
      anim.current = null
      camera.position.set(pos[0], pos[1], pos[2])
      camera.up.set(0, 0, 1)
      if (controls) {
        controls.target.set(target[0], target[1], target[2])
        controls.update()
      } else {
        camera.lookAt(new THREE.Vector3(target[0], target[1], target[2]))
      }
    }

    // Animate toward the pose unless the user prefers reduced motion (snap).
    const apply = (pos: [number, number, number], target: [number, number, number]) => {
      if (prefersReducedMotion()) {
        snap(pos, target)
        return
      }
      camera.up.set(0, 0, 1)
      const curTgt = controls
        ? controls.target.clone()
        : new THREE.Vector3(0, 0, 0)
      anim.current = {
        fromPos: camera.position.clone(),
        toPos: new THREE.Vector3(pos[0], pos[1], pos[2]),
        fromTgt: curTgt,
        toTgt: new THREE.Vector3(target[0], target[1], target[2]),
        t: 0,
        dur: 0.45,
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

    apiRef.current.setView = (view: PresetView) => {
      // `right` isn't in the pure helper's ViewName set, so frame it locally
      // (looking along -X onto the YZ plane, Z up) using the shared math.
      if (view === 'right') {
        const b: Bounds3 =
          boundsRef.current ?? {
            min: [0, 0, 0],
            max: [bedSize[0], bedSize[1], bedSize[2]],
          }
        const target = boundsCenter(b)
        const dist = fitDistance(boundsRadius(b), FOV)
        apply([target[0] + dist, target[1], target[2]], target)
        return
      }
      const v = frameBounds(boundsRef.current, view, FOV, bedSize)
      apply(v.position, v.target)
    }
  }, [camera, controls, apiRef, bedSize])

  // Ease the camera toward the stashed destination (smootherstep). Updating the
  // OrbitControls target each frame keeps orbiting in sync after the transition.
  useFrame((_, delta) => {
    const a = anim.current
    if (!a) return
    a.t = Math.min(1, a.t + delta / a.dur)
    const x = a.t
    const e = x * x * x * (x * (x * 6 - 15) + 10) // smootherstep
    camera.position.lerpVectors(a.fromPos, a.toPos, e)
    if (controls) {
      controls.target.lerpVectors(a.fromTgt, a.toTgt, e)
      controls.update()
    } else {
      const tg = a.fromTgt.clone().lerp(a.toTgt, e)
      camera.lookAt(tg)
    }
    if (a.t >= 1) anim.current = null
  })

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

/**
 * Pick mode hit layer: one invisible(ish) wide-threshold LineSegments built from
 * ALL segments, so a click maps deterministically to a segment index. The
 * geometry is non-indexed (segment i uses vertices 2i / 2i+1), so the raycast
 * hit's vertex index → `floor(index / 2)` is the segment index. A bumped
 * per-object raycast threshold makes a thin toolpath line forgiving to click.
 * Renders nothing visible (the highlight is drawn by SelectedSegments).
 */
function PickSegments({
  segments,
  onPick,
}: {
  segments: Segment[]
  onPick: (index: number, additive: boolean) => void
}) {
  const geom = useMemo(() => {
    const pts: number[] = []
    for (const s of segments) {
      pts.push(s.from[0], s.from[1], s.from[2], s.to[0], s.to[1], s.to[2])
    }
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    return g
  }, [segments])
  useEffect(() => () => geom.dispose(), [geom])

  // Widen the hit corridor: the default Line raycast threshold (~1) is fussy for
  // a thin mm-scale toolpath. Patch this object's raycast to use a generous
  // threshold, restoring the shared canvas raycaster's value afterwards so it
  // never leaks to other pickables.
  const lineRef = useRef<THREE.LineSegments | null>(null)
  const setLineRef = (line: THREE.LineSegments | null) => {
    lineRef.current = line
    if (!line) return
    const base = THREE.LineSegments.prototype.raycast
    line.raycast = (raycaster, intersects) => {
      const params = raycaster.params.Line
      const prev = params ? params.threshold : 1
      if (params) params.threshold = 3
      base.call(line, raycaster, intersects)
      if (params) params.threshold = prev
    }
  }

  return (
    <lineSegments
      ref={setLineRef}
      geometry={geom}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        if (e.index === undefined) return
        e.stopPropagation()
        const segIndex = Math.floor(e.index / 2)
        if (segIndex < 0 || segIndex >= segments.length) return
        const additive = !!(e.shiftKey || e.ctrlKey || e.metaKey)
        onPick(segIndex, additive)
      }}
    >
      {/* Invisible material: the path is already drawn by <Toolpath>; this layer
          exists purely as a forgiving click target mapped to a segment index. */}
      <lineBasicMaterial transparent opacity={0} depthWrite={false} />
    </lineSegments>
  )
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

/** Union of several axis-aligned bounds (skips nulls); null if none given. */
function unionBounds(list: Bounds[]): Bounds | null {
  if (list.length === 0) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const b of list) {
    for (let i = 0; i < 3; i++) {
      if (b.min[i] < min[i]) min[i] = b.min[i]
      if (b.max[i] > max[i]) max[i] = b.max[i]
    }
  }
  return { min, max }
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
