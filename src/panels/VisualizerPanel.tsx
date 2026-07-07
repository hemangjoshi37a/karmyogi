import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Viewer, type ViewerHandle } from '../viewer/Viewer'
import { gcodeToPolylines, type Segment } from '../viewer/gcodeToPolylines'
import { heatColor } from '../viewer/Toolpath'
import { useGcodeSelection } from '../viewer/gcodeSelection'
import { reemitSafe, inferEmitOptions } from '../core/toolpathEdit'
import { useProgram, useMachine, useCameraCalib, usePersistentState, useSettings } from '../store'
import { useBed } from '../store/bed'
import { useCarveJobs, type CarveJob } from '../store/carveJobs'
import { buildTimeline } from '../core/simulation'
import { usePlayback } from '../store/playback'
import { useHeightmap } from '../store/heightmap'
import { isComplete } from '../core/heightmap'
import { grbl } from '../serial/controller'
import { PlaybackTimeline } from '../components/PlaybackTimeline'
import { useT } from '../i18n'
import {
  applyJobPlacement,
  isIdentityJob,
  quaternionToEulerDeg,
  type JobPlacement,
} from '../core/transform'

import { sectionColor } from '../viewer/sectionColors'
import { useViewportShapes, type ShapeKind } from '../store/viewportShapes'
import { useSolderViz } from '../store/solderViz'
import { useHover } from '../store/hover'
import { useSpringViz } from '../store/springViz'
import { getActiveTab, subscribeActiveTab } from '../track/activity'
import { useTabCommands } from '../machine/tabCommands'
import { Icon } from '../components/Icons'

/**
 * Tiny inline-SVG wrapper for the viewport toolbar/menu glyphs. Replaces the
 * per-OS-inconsistent emoji/Unicode glyphs with crisp 24×24 line icons that
 * inherit `currentColor` (so they recolor with the theme + active states for
 * free). Decorative — the parent button carries the title/aria-label.
 */
function VIcon({
  children,
  size = 16,
  fill = false,
}: {
  children: React.ReactNode
  size?: number
  fill?: boolean
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// --- Viewport toolbar / menu glyphs (inline SVG, theme-recoloring) -----------
// Fit-to-view: arrows pulling toward a centered frame (4 corner brackets +
// inward chevrons).
const IconFit = (
  <VIcon>
    <path d="M4 9V5a1 1 0 0 1 1-1h4" />
    <path d="M20 9V5a1 1 0 0 0-1-1h-4" />
    <path d="M4 15v4a1 1 0 0 0 1 1h4" />
    <path d="M20 15v4a1 1 0 0 1-1 1h-4" />
    <path d="M9.5 9.5l-3-3M14.5 9.5l3-3M9.5 14.5l-3 3M14.5 14.5l3 3" />
  </VIcon>
)
// Isometric view: a 3D cube drawn in iso projection.
const IconIso = (
  <VIcon>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M12 3v9M12 12l8-4.5M12 12l-8-4.5" />
  </VIcon>
)
// Top view: looking straight down onto a square (plan).
const IconViewTop = (
  <VIcon>
    <rect x="5" y="5" width="14" height="14" rx="1" />
    <path d="M5 9.5h14M9.5 5v14" opacity="0.55" />
  </VIcon>
)
// Front view: an elevation — a face-on rectangle with a ground line.
const IconViewFront = (
  <VIcon>
    <rect x="5" y="6" width="14" height="10" rx="1" />
    <path d="M3 20h18" />
  </VIcon>
)
// Right view: an elevation seen edge-on (a thin profile + depth hint).
const IconViewRight = (
  <VIcon>
    <path d="M9 6h6l3 3v7a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V6z" />
    <path d="M15 6v3h3" />
  </VIcon>
)
// Run-outline / footprint: a dashed bounding rectangle on a baseline (the bed).
const IconRunOutline = (
  <VIcon>
    <path d="M4 7h3M9 7h3M14 7h3M19 7v3M19 12v3M17 17h-3M12 17H9M7 17H4M4 15v-3M4 10V7" />
  </VIcon>
)
// Bed size: a ruler / measure frame.
const IconBed = (
  <VIcon>
    <rect x="3" y="8" width="18" height="8" rx="1" />
    <path d="M7 8v3M11 8v4M15 8v3M19 8v4" />
  </VIcon>
)
// More / overflow: horizontal ellipsis.
const IconMore = (
  <VIcon fill>
    <circle cx="5" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="19" cy="12" r="1.6" />
  </VIcon>
)
// Place job: a 4-way move cross with a centre node (move/rotate/scale gizmo).
const IconPlace = (
  <VIcon>
    <path d="M12 3v18M3 12h18" />
    <path d="M12 3l-2 2.5M12 3l2 2.5M12 21l-2-2.5M12 21l2-2.5" />
    <path d="M3 12l2.5-2M3 12l2.5 2M21 12l-2.5-2M21 12l-2.5 2" />
    <circle cx="12" cy="12" r="2.2" />
  </VIcon>
)
// Reset placement: a circular refresh arrow.
const IconReset = (
  <VIcon>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4h-4" />
  </VIcon>
)
// Lasso delete: scissors.
const IconLasso = (
  <VIcon>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M8 8l12 8M8 16L20 8" />
  </VIcon>
)
// Pick delete: a pointer/cursor selecting a node.
const IconPick = (
  <VIcon>
    <path d="M5 4l6 16 2.2-6.2L19 11.5z" />
  </VIcon>
)
// --- Overflow-menu glyphs (add shape + display toggles) ---
const IconLine = (
  <VIcon>
    <path d="M5 19L19 5" />
  </VIcon>
)
const IconCircle = (
  <VIcon>
    <circle cx="12" cy="12" r="8" />
  </VIcon>
)
const IconRect = (
  <VIcon>
    <rect x="4" y="6" width="16" height="12" rx="1" />
  </VIcon>
)
const IconTriangle = (
  <VIcon>
    <path d="M12 4l9 16H3z" />
  </VIcon>
)
const IconDimensions = (
  <VIcon>
    <path d="M4 18V6M4 12h16M20 6v12" />
    <path d="M4 6l2 2M4 6l-2 2M20 6l2 2M20 6l-2 2" />
  </VIcon>
)
const IconJobBox = (
  <VIcon>
    <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
  </VIcon>
)
const IconStock = (
  <VIcon>
    <path d="M3 8l9-4 9 4-9 4z" />
    <path d="M3 8v8l9 4 9-4V8" />
    <path d="M12 12v8" />
  </VIcon>
)
const IconCarve = (
  <VIcon>
    <path d="M3 16h18" />
    <path d="M7 16l3-9 2 5 2-3 3 7" />
  </VIcon>
)
// PCB board: a rectangular board with two copper pads and a connecting trace.
const IconPcb = (
  <VIcon>
    <rect x="3" y="4" width="18" height="16" rx="1.5" />
    <circle cx="8" cy="9" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="16" cy="15" r="1.4" fill="currentColor" stroke="none" />
    <path d="M8 9h4v6h4" />
  </VIcon>
)
const IconCone = (
  <VIcon fill>
    <path d="M12 18L7 7h10z" />
  </VIcon>
)
// Auto-stock: a block with a small "A" wand / auto cue (sparkle on a slab).
const IconAutoStock = (
  <VIcon>
    <path d="M4 9l8-4 8 4-8 4z" />
    <path d="M4 9v6l8 4 8-4V9" />
    <path d="M17 3l.7 1.6L19.5 5l-1.8.4L17 7l-.7-1.6L14.5 5l1.8-.4z" />
  </VIcon>
)
// Hide processed: a crossed-out eye (already-cut lines vanish during the reveal).
const IconHideProcessed = (
  <VIcon>
    <path d="M3 3l18 18" />
    <path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 9 7a11 11 0 0 1-2.2 3" />
    <path d="M6.6 6.6A11 11 0 0 0 3 12c0 2.5 4 7 9 7a9.6 9.6 0 0 0 3.4-.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
  </VIcon>
)
const IconCamera = (
  <VIcon>
    <path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L18 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </VIcon>
)
// V8 jog-to-point: a target crosshair with a small move pointer.
const IconJogTo = (
  <VIcon>
    <circle cx="12" cy="12" r="6" />
    <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
  </VIcon>
)
// V10 live readout HUD: a small gauge / dashboard panel.
const IconHud = (
  <VIcon>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M7 15a5 5 0 0 1 10 0" />
    <path d="M12 15l3-3" />
  </VIcon>
)
// V9 heightmap surface: stacked contour lines (terrain relief).
const IconHeightmap = (
  <VIcon>
    <path d="M3 16c3 0 4-3 7-3s4 3 7 3" />
    <path d="M3 12c3 0 4-3 7-3s4 3 7 3" />
    <path d="M3 8c3 0 4-3 7-3s4 3 7 3" />
  </VIcon>
)
// V6 lightweight / SVG render mode: a flat 2D-layers / stacked-rectangles glyph.
const IconSvg = (
  <VIcon>
    <rect x="3" y="4" width="18" height="7" rx="1" />
    <path d="M3 15h18M3 19h12" />
  </VIcon>
)
// L10 power heat-map: a gradient bar with a flame cue.
const IconPower = (
  <VIcon>
    <path d="M12 3c2 3 4 4.5 4 8a4 4 0 0 1-8 0c0-1.5.6-2.6 1.4-3.6C10 9 12 7 12 3z" />
  </VIcon>
)
// V11 soft-limit box: a dashed bounding rectangle with a corner-origin tick.
const IconSoftLimit = (
  <VIcon>
    <path d="M4 6h4M10 6h4M16 6h4M20 8v4M20 14v4M16 18h-4M10 18H6M4 18v-4M4 12V6" />
    <path d="M4 18l3-3" />
  </VIcon>
)
// Work coordinate origins (G54–G59): an axes origin with a small second cross,
// hinting at multiple coordinate systems on the bed.
const IconWcs = (
  <VIcon>
    <path d="M5 19V5M5 19h14" />
    <path d="M5 5l-1.6 2.2M5 5l1.6 2.2M19 19l-2.2-1.6M19 19l-2.2 1.6" />
    <path d="M14 7h4M16 5v4" />
  </VIcon>
)

/**
 * Visualizer panel: hosts the 3D viewport and feeds it the loaded G-code program
 * (from the program store) and the live tool position (from the machine store).
 * A small toolbar exposes W3's imperative fit/iso/top/front view controls plus a
 * compact bed-size editor, and a corner overlay reports the loaded program's
 * size and bed-fit status.
 *
 * Coordinate model: the drawn bed grid (drei <Grid>) is CENTERED on the work
 * origin, so it spans [-W/2..+W/2] x [-D/2..+D/2]. The fit-check below uses that
 * SAME centered rectangle, so "fits / outside / exceeds" always matches the grid
 * the user sees. The bed size comes from the persisted bed store so the grid,
 * bounds box, and fit-check all react live to edits.
 */

/**
 * Axis-aligned bounding box of a carve job's mesh AFTER its placement is applied
 * (the job's TRUE position / size on the bed). Mirrors `placeToolpath` (carve3d):
 *   XY → translate to the mesh XY-bbox centre, uniform scale, rotate by rotDeg,
 *        translate back, add (dx, dy); take the rotated rectangle's extent.
 *   Z  → untouched (carve depth is independent of XY placement).
 * Returns min/max in work-mm, ready to feed a per-job bounding cube.
 */
function placedJobBounds(job: CarveJob): {
  min: [number, number, number]
  max: [number, number, number]
} {
  const b = job.mesh.bbox
  const p = job.placement
  const s = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1
  const rad = ((p.rotDeg || 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const cx = (b.min[0] + b.max[0]) / 2
  const cy = (b.min[1] + b.max[1]) / 2
  const corners: [number, number][] = [
    [b.min[0], b.min[1]],
    [b.max[0], b.min[1]],
    [b.max[0], b.max[1]],
    [b.min[0], b.max[1]],
  ]
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [px, py] of corners) {
    const vx = (px - cx) * s
    const vy = (py - cy) * s
    const rx = vx * cos - vy * sin + cx + p.dx
    const ry = vx * sin + vy * cos + cy + p.dy
    if (rx < minX) minX = rx
    if (ry < minY) minY = ry
    if (rx > maxX) maxX = rx
    if (ry > maxY) maxY = ry
  }
  return {
    min: [minX, minY, b.min[2]],
    max: [maxX, maxY, b.max[2]],
  }
}

export function VisualizerPanel() {
  const t = useT()
  const ref = useRef<ViewerHandle>(null)
  const lines = useProgram((s) => s.lines)
  // Cross-panel hover link: the carving / Program-tab op rows publish the hovered
  // op id; the viewer shimmers that op's toolpath line.
  const hoveredOpId = useHover((s) => s.hoveredOpId)
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)
  // For a spring program the in-scene SpringScene shows spring-specialized
  // dimensions (wire ⌀, coil ⌀, pitch, free length, turns), so suppress the
  // generic width×depth / "fits bed" readout here — it's meaningless for a coil.
  const springActive = useSpringViz((s) => s.active)
  // Auto-frame the coil whenever the user opens the Spring Coiling tab — its tiny
  // coil is otherwise lost on the full bed, and the spring program's degree-valued
  // bounds can't be framed (the Viewer overrides controlBounds to the coil box for
  // spring programs). Triggering on tab-activation is reliable; the delay lets the
  // panel publish the program + spring params so the coil box is ready at fit time.
  useEffect(() => {
    const fitIfSpring = (tab: string | undefined) => {
      if (tab === 'springcoiling') {
        window.setTimeout(() => ref.current?.fit(), 380)
      }
    }
    fitIfSpring(getActiveTab())
    return subscribeActiveTab(fitIfSpring)
  }, [])

  // All display toggles below are PERSISTED (usePersistentState) so the ⋯-menu /
  // toolbar layout the operator sets survives a page refresh.
  const [showStock, setShowStock] = usePersistentState(
    'karmyogi.viewer.showStock',
    true,
  )
  // PCB board (FR-4 + copper) visibility for the soldering scene. Lives in the
  // solderViz store (the channel SolderScene reads), so the toggle here reaches
  // the scene without threading a prop through the Viewer. Default ON; the pads
  // never hide — only the board slab does. The store persists it across refresh.
  const showPcb = useSolderViz((s) => s.showPcb)
  const setShowPcb = useSolderViz((s) => s.setShowPcb)
  // Independent show/hide for the two spindle cones (actual machine vs simulation).
  const [showActualTool, setShowActualTool] = usePersistentState(
    'karmyogi.viewer.showActualTool',
    true,
  )
  const [showSimTool, setShowSimTool] = usePersistentState(
    'karmyogi.viewer.showSimTool',
    true,
  )
  // Material-removal simulation: progressively carve the stock surface as the
  // toolpath reveals. On by default so the operator sees stock → finished part.
  const [carveSim, setCarveSim] = usePersistentState(
    'karmyogi.viewer.carveSim',
    true,
  )
  // Auto-stock: derive the carve block from the toolpath extents + a thickness
  // (so ANY loaded program can be simulated without a configured stock block).
  // Persisted so the operator's preference survives reloads. Opt-in (off by
  // default — the configured stock store block is used unless this is on).
  const [autoStock, setAutoStock] = usePersistentState(
    'karmyogi.viewer.carve.autoStock',
    false,
  )
  const [autoStockThickness, setAutoStockThickness] = usePersistentState(
    'karmyogi.viewer.carve.autoStockThickness',
    12,
  )
  // V3 "hide processed": during a reveal, fully HIDE the already-cut lines
  // (leaving only the remaining work) instead of dimming them. Persisted.
  const [hideProcessed, setHideProcessed] = usePersistentState(
    'karmyogi.viewer.hideProcessed',
    false,
  )
  // Engineering-style 3D dimension annotations (X/Y/Z) around the program bbox.
  // Persisted so the operator's preference survives reloads.
  const [showDimensions, setShowDimensions] = usePersistentState(
    'karmyogi.viewer.showDimensions',
    true,
  )
  // O6 run-outline / bounds preview: draw the program's XY footprint on the bed
  // (colour-coded by bed-fit) so the operator sees placement before running.
  // Persisted so the operator's preference survives reloads.
  const [showRunOutline, setShowRunOutline] = usePersistentState(
    'karmyogi.viewer.showRunOutline',
    false,
  )

  // Add a viewport primitive at the bed centre (0,0); it auto-selects so its
  // inline transform gizmo appears immediately (replaces the old right-click).
  const addShape = useViewportShapes((s) => s.addShape)
  const onAddShape = (kind: ShapeKind) => addShape(kind, 0, 0)

  // Live camera → 3D bed overlay (persisted in the camera-calib store, so the
  // toggle survives refresh). The overlay components self-gate on `enabled`.
  const camOverlay = useCameraCalib((s) => s.enabled)
  const toggleCamOverlay = useCameraCalib((s) => s.toggleEnabled)

  // Placement gizmo: toggle the in-scene all-in-one move/rotate/scale handles
  // (also turns on when the user clicks a toolpath in the 3D view). Placement is
  // PER-SECTION: the gizmo edits whichever section is selected.
  const [gizmoOn, setGizmoOn] = useState(false)
  const sections = useProgram((s) => s.sections)
  const selectedSectionId = useProgram((s) => s.selectedSectionId)
  const selectSection = useProgram((s) => s.selectSection)
  const selectedSection =
    sections.find((s) => s.id === selectedSectionId) ?? null
  const placement = selectedSection?.placement ?? null
  const hasProgram = lines.some((l) => l.trim() !== '')

  // Per-section baked geometry: segments (for distinctly-coloured rendering and
  // independent live-drag groups) + bounds (for click-to-select hit regions). A
  // theme-aware palette keeps every toolpath legible on dark AND light.
  const theme = useSettings((s) => s.theme)
  const sectionData = useMemo(() => {
    return sections.map((s, i) => {
      const identity = isIdentityJob(s.placement)
      const bake = (raw: string) => (identity ? raw : applyJobPlacement(raw, s.placement))
      const raw = s.rawLines.join('\n')
      const parsed = gcodeToPolylines(bake(raw))
      // Per-operation breakdown (carving ops linked to presets): parse + bake
      // each op's OWN gcode so it can render in its preset colour. Only kicks in
      // when at least one op carries an explicit preset `color`; ops without one
      // fall back to the section colour. If no op has a colour, leave
      // `operations` undefined so the single section-coloured path is drawn (the
      // legacy look, unchanged for every non-carving tab).
      const ops = s.operations
      let operations:
        | { id: string; segments: Segment[]; color: string }[]
        | undefined
      if (ops && ops.length > 0 && ops.some((o) => !!o.color)) {
        const sectionFallback = sectionColor(i, theme === 'dark', s.color)
        operations = ops.map((o) => ({
          id: o.id,
          segments: gcodeToPolylines(bake(o.gcode)).segments,
          color: o.color || sectionFallback,
        }))
      }
      return {
        id: s.id,
        segments: parsed.segments,
        bounds: parsed.bounds,
        // Preset-coloured carving section → the section's representative colour
        // (used by the Layers swatch + as the per-op fallback) is the preset
        // colour, so the legend matches the rendered lines + the Program tab.
        // Otherwise: explicit per-section colour (Program-tab picker) wins, else auto.
        color: operations ? operations[0].color : sectionColor(i, theme === 'dark', s.color),
        operations,
      }
    })
  }, [sections, theme])

  const sectionBoxes = useMemo(
    () =>
      sectionData.flatMap((d) =>
        d.bounds ? [{ id: d.id, bounds: { min: d.bounds.min, max: d.bounds.max } }] : [],
      ),
    [sectionData],
  )
  const sectionPaths = useMemo(
    () =>
      sectionData.flatMap((d) =>
        d.segments.length
          ? [{ id: d.id, segments: d.segments, color: d.color, operations: d.operations }]
          : [],
      ),
    [sectionData],
  )

  // 3D-carving per-job bounding cubes. For a 3D carve job the combined program is
  // ONE gcode section whose extent (and the old sectionBox) spans the work origin
  // → the model — the wrong box. Instead compute ONE tight cube PER carve job from
  // its MESH bbox transformed by its PLACEMENT (the same XY-translate / Z-rotation-
  // about-the-XY-bbox-centre / uniform-XY-scale the carve bakes in placeToolpath),
  // giving each model its own axis-aligned box at its true position/size on the
  // bed. Z is left untouched by the placement (carve depth is independent of XY
  // placement), so the cube spans the mesh's real minZ→maxZ — a flat-bottom part
  // sits from its true bottom, not from 0. Only enabled jobs contribute.
  const carveJobs = useCarveJobs((s) => s.jobs)
  const jobBoxes = useMemo(
    () =>
      carveJobs.flatMap((j) => (j.enabled ? [{ id: j.id, ...placedJobBounds(j) }] : [])),
    [carveJobs],
  )

  // Turning the gizmo on with nothing selected picks the first section so the
  // handles appear immediately.
  const toggleGizmo = () => {
    const next = !gizmoOn
    setGizmoOn(next)
    if (next) {
      setLassoMode(false)
      setPickMode(false)
      if (!selectedSectionId && sections.length > 0) selectSection(sections[0].id)
    }
  }

  // Lasso-delete mode (mutually exclusive with the placement gizmo + pick mode).
  const [lassoMode, setLassoMode] = useState(false)
  // Pick mode: click individual toolpath lines to select (mutually exclusive with
  // lasso + gizmo). Shares the SAME selection→reemit deletion pipeline as lasso.
  const [pickMode, setPickMode] = useState(false)
  const toggleLasso = () => {
    const next = !lassoMode
    setLassoMode(next)
    if (next) {
      setGizmoOn(false)
      setPickMode(false)
    }
  }
  const togglePick = () => {
    const next = !pickMode
    setPickMode(next)
    if (next) {
      setGizmoOn(false)
      setLassoMode(false)
    }
  }
  const toggleJogTo = () => {
    const next = !jogToMode
    setJogToMode(next)
    if (next) {
      setGizmoOn(false)
      setLassoMode(false)
      setPickMode(false)
    }
  }
  // V8 — right-click-to-jog: lift to a safe Z first (so the bit clears the work
  // on the way), then jog X/Y to the clicked work coordinate. Relative deltas are
  // computed from the live work position so this rides the existing jog flow
  // control (no raw G-code). Requires an Idle machine connection.
  const onJogTo = (x: number, y: number) => {
    if (!connected) return
    const m = useMachine.getState()
    if (m.state !== 'Idle' && m.state !== 'Jog') return
    const w = m.wpos
    const safeZ = Math.max(bedH, 5)
    const dz = safeZ - w.z
    const feedZ = 800
    const feedXY = 2400
    // Safe-Z retract first (only if we're below it), then the XY move.
    if (dz > 0.01) void grbl.jog({ z: dz, feed: feedZ })
    void grbl.jog({ x: x - w.x, y: y - w.y, feed: feedXY })
  }
  // ESC always exits lasso mode (previously you were stuck until you deleted
  // something). Turning the mode off cascades into the Viewer, which clears any
  // pending selection/polygon. (Pick mode handles its own Escape inside the
  // Viewer: clears the selection first, then calls onPickExit to leave the mode.)
  useEffect(() => {
    if (!lassoMode) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setLassoMode(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lassoMode])

  // Show/hide the faint colored per-program toolpath "cubes" (the click-to-select
  // bounding boxes). Persisted so the operator's preference survives reloads.
  const [showJobBoxes, setShowJobBoxes] = usePersistentState(
    'karmyogi.viewer.showJobBoxes',
    true,
  )

  // V10 — live DRO/state HUD overlay inside the viewport (work pos + state +
  // feed/spindle), handy in fullscreen / on a phone. Persisted; off by default.
  const [showHud, setShowHud] = usePersistentState('karmyogi.viewer.hud', false)
  // V9 — overlay the probed auto-leveling surface as a colored relief mesh.
  const [showHeightmap, setShowHeightmap] = usePersistentState(
    'karmyogi.viewer.heightmap',
    true,
  )
  // V8 — right-click-to-jog mode: a right-click on the bed jogs the head there
  // (safe-Z first). Off by default so right-click stays OrbitControls pan/orbit.
  const [jogToMode, setJogToMode] = useState(false)
  // V6 — lightweight 2D/SVG render mode: swaps the WebGL viewport for a top-view
  // SVG render (genuinely lighter for huge files / weak devices). Persisted.
  const [svgMode, setSvgMode] = usePersistentState('karmyogi.viewer.svgMode', false)
  // V11 — soft-limit travel box + machine-origin marker (only appears once the
  // GRBL settings are synced). Persisted; on by default.
  const [showSoftLimits, setShowSoftLimits] = usePersistentState(
    'karmyogi.viewer.softLimits',
    true,
  )
  // Work-coordinate origin markers (G55–G59) — each at its GRBL `$#` offset.
  // Persisted; on by default so every DEFINED work origin is visible at a glance.
  const [showWcsOrigins, setShowWcsOrigins] = usePersistentState(
    'karmyogi.viewer.wcsOrigins',
    true,
  )
  // L10 — colour the toolpath by laser power (S-value). Persisted; on by default
  // so a laser job shows its heat-map immediately (the toggle only appears when
  // the loaded program actually modulates power).
  const [powerHeat, setPowerHeat] = usePersistentState('karmyogi.viewer.powerHeat', true)
  // The probed surface (read-only from the auto-leveling store). Only overlaid
  // when complete so a half-probed grid never misrepresents the relief.
  const heightmap = useHeightmap((s) => s.map)
  const heightmapReady = useMemo(
    () => (heightmap && isComplete(heightmap) ? heightmap : null),
    [heightmap],
  )

  // --- Layers tree (lives inside the ⋯ overflow menu → Display section) ------
  // Each toggle drives the corresponding three.js object's visibility via the
  // props below, and all state is persisted (same usePersistentState pattern
  // used across the app). The UI now renders inside OverflowMenu's "Layers"
  // group rather than as a standalone on-canvas overlay.
  const [showAllToolpaths, setShowAllToolpaths] = usePersistentState(
    'karmyogi.viewer.layers.toolpaths',
    true,
  )
  const [showModel, setShowModel] = usePersistentState(
    'karmyogi.viewer.layers.model',
    true,
  )
  const [showBed, setShowBed] = usePersistentState(
    'karmyogi.viewer.layers.bed',
    true,
  )
  // Per-section visibility, keyed by section id. Absent / non-false = shown.
  const [hiddenSections, setHiddenSections] = usePersistentState<
    Record<string, boolean>
  >('karmyogi.viewer.layers.hiddenSections', {})
  const sectionVisibility = useMemo(() => {
    const m: Record<string, boolean> = {}
    for (const id of Object.keys(hiddenSections)) {
      if (hiddenSections[id]) m[id] = false
    }
    return m
  }, [hiddenSections])
  const toggleSection = (id: string) =>
    setHiddenSections((prev) => ({ ...prev, [id]: !prev[id] }))

  // Legend rows: id + name + swatch colour for every program section (the
  // per-section colour source is reused from `sectionData`, so swatches match
  // the lines on screen).
  const legendSections = useMemo(
    () =>
      sections.map((s, i) => ({
        id: s.id,
        name: s.name,
        color: sectionData[i]?.color ?? sectionColor(i, theme === 'dark', s.color),
      })),
    [sections, sectionData, theme],
  )
  // Apply a deletion (from EITHER the lasso or the individual-pick selection):
  // rebuild a SAFE program from the kept segments and replace the program with it
  // (collapsed into one edited section). Both selection tools funnel through this
  // single re-emit pipeline so safe-Z retracts + program structure stay correct.
  const applyKeptSegments = (kept: Segment[]) => {
    const out = reemitSafe(
      kept.map((s) => ({ from: s.from, to: s.to, kind: s.kind })),
      { ...inferEmitOptions(gcode), programName: 'edited toolpath' },
    )
    useProgram.getState().setCombined('edited toolpath', out)
  }
  const onLassoDelete = (kept: Segment[]) => {
    setLassoMode(false)
    applyKeptSegments(kept)
  }
  const onPickDelete = (kept: Segment[]) => {
    setPickMode(false)
    applyKeptSegments(kept)
  }

  // The gcode the VISUALIZER simulates/draws. Normally the full combined program.
  // BUT for a spring program, simulate ONLY the spring section: a spring is a
  // 2-axis machine and its playhead must not be polluted by any OTHER section
  // (e.g. a stray "text — pen" from the Writing tab), whose back-and-forth X moves
  // would otherwise drive the coil's carriage forward/back — the "coiling then
  // de-coiling" artifact. (Streaming still uses the full program via the store.)
  const gcode = useMemo(() => {
    if (springActive) {
      const spring = sections.find((s) => s.name.includes('Spring coil'))
      if (spring) return spring.rawLines.join('\n')
    }
    return lines.join('\n')
  }, [lines, springActive, sections])

  // V13 + L10 — parse the WHOLE combined program ONCE (memoized on the text) to
  // get line-tagged segments (for the editor⇄3D link) AND the power summary (for
  // the laser heat-map). The displayed/simulated geometry comes from the timeline
  // (no line/power info), so this is a separate, cheap, change-only parse.
  const parsedForLink = useMemo(
    () => (gcode.trim() !== '' ? gcodeToPolylines(gcode) : null),
    [gcode],
  )
  const lineSegments = parsedForLink?.segments
  // Laser power heat-map is OFFERED only when the program actually modulates S
  // (a constant-S spindle job has `varied:false` → no heat-map). Range feeds the
  // shared normalisation so colours are comparable across sections.
  const laserPower = parsedForLink?.power?.varied ? parsedForLink.power : null
  const powerRange = useMemo<[number, number] | null>(
    () => (laserPower ? [laserPower.min, laserPower.max] : null),
    [laserPower],
  )
  const heatOn = !!laserPower && powerHeat

  // V13 — selected combined-program line (shared with the Program editor). Clear
  // it whenever the program text changes so a stale index never highlights.
  const setSelectedLine = useGcodeSelection((s) => s.setSelectedLine)
  useEffect(() => {
    setSelectedLine(null)
  }, [gcode, setSelectedLine])

  // Cutter radius for the material-removal sim. Read live from the carve store's
  // GLOBAL tool diameter (the single bit that cuts all jobs, set in the 3D
  // Carving panel) instead of re-parsing localStorage — the store IS the source
  // of truth and this reacts to bit changes immediately. Falls back to a sane
  // default when nothing has been configured yet.
  const toolDiameter = useCarveJobs((s) => s.global.toolDiameter)
  const toolRadius = useMemo(
    () => Math.max(0.1, (toolDiameter > 0 ? toolDiameter : 3.175) / 2),
    [toolDiameter],
  )
  // Cutter PROFILE for the carve sim, from the same global bit (ball-nose vs
  // flat endmill). 'ball' carves a rounded groove, 'flat' a flat floor — so the
  // simulated surface matches the actual bit. (carve3d's ToolType is 'ball'|'flat'.)
  const carveToolTypeRaw = useCarveJobs((s) => s.global.toolType)
  const carveToolType: 'flat' | 'ball' = carveToolTypeRaw === 'ball' ? 'ball' : 'flat'

  // Build a time-parameterised simulation timeline from the loaded program and
  // install it in the playback store. Rebuilds only when the gcode text changes.
  const timeline = useMemo(
    () => (gcode.trim() !== '' ? buildTimeline(gcode) : null),
    [gcode],
  )
  useEffect(() => {
    usePlayback.getState().setTimeline(timeline)
  }, [timeline])

  // The DRAWN geometry must equal the SIMULATED geometry so reveal indices line
  // up exactly: feed the Viewer the timeline's segments (same {from,to,kind}
  // shape). Memoized on `timeline` only — NOT on the 60fps playhead time.
  const simSegments: Segment[] | undefined = useMemo(() => {
    if (!timeline) return undefined
    return timeline.segments.map((s) => ({
      from: s.from,
      to: s.to,
      kind: s.kind,
    }))
  }, [timeline])

  // Subscribe to the playhead. Recomputing only the marker + reveal (cheap) on
  // each tick keeps the heavy geometry stable.
  const time = usePlayback((s) => s.time)
  const isPlaying = usePlayback((s) => s.isPlaying)
  const pbTimeline = usePlayback((s) => s.timeline)

  const simActive = !!pbTimeline && pbTimeline.duration > 0
  const simulating = simActive && (isPlaying || time > 0)

  // SPACEBAR toggles the simulation play/pause (like a media player). Ignored when
  // the user is typing in a field or focused on a button (Space activates buttons),
  // and only acts when a timeline is loaded — so it never hijacks Space elsewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return
      const el = e.target as HTMLElement | null
      const tag = el?.tagName
      if (
        el?.isContentEditable ||
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        tag === 'BUTTON' ||
        tag === 'A'
      )
        return
      if (!usePlayback.getState().timeline) return
      e.preventDefault()
      usePlayback.getState().toggle()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Actual (live machine) cone — ALWAYS follows the controller when connected,
  // independent of the simulation, so streaming a program shows real motion in
  // the 3D view. (Previously the single marker switched to the sim once scrubbed,
  // which hid live streaming — that regression is fixed by drawing both cones.)
  const actualPosition: [number, number, number] | null = connected
    ? [wpos.x, wpos.y, wpos.z]
    : null
  // Simulation cone + progressive path reveal — driven by the playback timeline
  // while the user plays or scrubs the preview.
  let simPosition: [number, number, number] | null = null
  let revealIndex: number | undefined
  let revealPoint: [number, number, number] | null = null
  if (simulating && pbTimeline) {
    simPosition = pbTimeline.positionAt(time)
    revealIndex = pbTimeline.activeIndexAt(time)
    revealPoint = simPosition
  }

  // Bounding box of the loaded program (mm). The viewer scene is always mm
  // (the emitter outputs G21), so we report mm regardless of UI unit setting.
  //
  // Derived from the ALREADY-BUILT timeline segments (same geometry the viewer
  // draws) rather than a second `gcodeToPolylines` parse — one parse, and the
  // reported bounds can never disagree with what's on screen. Memoized on
  // `simSegments` (rebuilt only when the program changes), not the 60fps playhead.
  const dims = useMemo(() => {
    const bounds = boundsOfSegments(simSegments)
    if (!bounds) return null
    const w = bounds.max[0] - bounds.min[0]
    const h = bounds.max[1] - bounds.min[1]
    const d = bounds.max[2] - bounds.min[2]
    if (!isFinite(w) || !isFinite(h) || !isFinite(d)) return null

    // Fit check vs the machine work area. The grid is drawn CENTERED on the
    // work origin, so the usable area is [-W/2..+W/2] x [-D/2..+D/2]. A program
    // bigger than W x D is "oversized"; one whose bbox pokes past the centered
    // rectangle edges is "off bed". This matches exactly what the user sees.
    const halfW = bedW / 2
    const halfD = bedD / 2
    const oversized = w > bedW || h > bedD
    const offBed =
      bounds.min[0] < -halfW ||
      bounds.min[1] < -halfD ||
      bounds.max[0] > halfW ||
      bounds.max[1] > halfD
    const fit: 'ok' | 'warn' | 'danger' = oversized
      ? 'danger'
      : offBed
        ? 'warn'
        : 'ok'

    return {
      w,
      h,
      d,
      min: bounds.min,
      max: bounds.max,
      area: w * h, // mm²
      fit,
      offBed,
      oversized,
    }
  }, [simSegments, bedW, bedD])

  // ── Gamepad command bus: sim transport + camera views + hide-processed. ──
  // Sim transport reuses the global playback store; views drive the imperative
  // Viewer handle; hide-processed toggles the local persisted flag. All guarded.
  useTabCommands('visualizer', {
    simPlayPause: () => {
      if (usePlayback.getState().timeline) usePlayback.getState().toggle()
    },
    simStart: () => {
      if (usePlayback.getState().timeline) usePlayback.getState().seek(0)
    },
    simPrevSeg: () => {
      if (usePlayback.getState().timeline) usePlayback.getState().stepSeg(-1)
    },
    simNextSeg: () => {
      if (usePlayback.getState().timeline) usePlayback.getState().stepSeg(1)
    },
    viewFit: () => ref.current?.fit(),
    viewIso: () => ref.current?.setView('iso'),
    viewTop: () => ref.current?.setView('top'),
    hideProcessed: () => setHideProcessed((s) => !s),
  })

  return (
    <div className="vz-root">
      <style>{OVERLAY_CSS}</style>
      <div className="vz-stage">
        {/* Toolbar (top-right): controls are organised into translucent "glass"
            CLUSTERS — Render · View · Edit · Display — instead of one long run.
            Generous gap separates clusters; buttons sit ghost inside a capsule
            and only fill on hover/open/latched-on, so they don't fight the 3D
            scene. The whole row wraps (flex-wrap) and clusters reflow as units
            on narrow/mobile widths; secondary display options stay in the ⋯
            menu so the visible set never collides with the orientation cube. */}
        <div className="vz-toolbar">
          {/* ── Render-mode cluster: 2D/SVG fast view + laser power heat-map. */}
          <div
            className="vz-tbgroup"
            role="group"
            aria-label={t('vz.group.render', 'Render mode')}
          >
            {/* V6 — lightweight 2D/SVG render mode toggle (always available). */}
            <button
              className={svgMode ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
              onClick={() => setSvgMode((s) => !s)}
              title={t(
                'vz.svgMode',
                'Lightweight view — fast 2D top-view render for huge files / weak devices',
              )}
              aria-label={t('vz.svgMode', 'Lightweight view')}
              aria-pressed={svgMode}
            >
              {IconSvg}
            </button>
            {/* L10 — laser power heat-map toggle (only when the program varies S). */}
            {laserPower && (
              <button
                className={powerHeat ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
                onClick={() => setPowerHeat((s) => !s)}
                title={t(
                  'vz.powerHeat',
                  'Power heat-map — colour the toolpath by laser power (S-value)',
                )}
                aria-label={t('vz.powerHeat', 'Power heat-map')}
                aria-pressed={powerHeat}
              >
                {IconPower}
              </button>
            )}
          </div>

          {/* ── Camera-view cluster: fit + Top/Front/Right/Iso presets. These
              snap the camera (smooth, reduced-motion-gated) and drive the same
              OrbitControls/camera as the orientation cube below this corner. */}
          {!svgMode && (
            <div
              className="vz-tbgroup"
              role="group"
              aria-label={t('vz.group.view', 'Camera views')}
            >
              <button
                className="vz-toolbar-btn"
                onClick={() => ref.current?.fit()}
                title={t('vz.fit', 'Fit to toolpath')}
                aria-label={t('vz.fit', 'Fit to toolpath')}
              >
                {IconFit}
              </button>
              <button
                className="vz-toolbar-btn"
                onClick={() => ref.current?.setView('top')}
                title={t('vz.top', 'Top view')}
                aria-label={t('vz.top', 'Top view')}
              >
                {IconViewTop}
              </button>
              <button
                className="vz-toolbar-btn"
                onClick={() => ref.current?.setView('front')}
                title={t('vz.front', 'Front view')}
                aria-label={t('vz.front', 'Front view')}
              >
                {IconViewFront}
              </button>
              <button
                className="vz-toolbar-btn"
                onClick={() => ref.current?.setView('right')}
                title={t('vz.right', 'Right view')}
                aria-label={t('vz.right', 'Right view')}
              >
                {IconViewRight}
              </button>
              <button
                className="vz-toolbar-btn"
                onClick={() => ref.current?.setView('iso')}
                title={t('vz.iso', 'Isometric view')}
                aria-label={t('vz.iso', 'Isometric view')}
              >
                {IconIso}
              </button>
            </div>
          )}

          {/* ── Edit / selection-tools cluster: place · reset · lasso · pick ·
              jog-to. Grouped so the destructive/interaction tools read as one
              distinct palette separate from the (non-mutating) view buttons. */}
          {!svgMode && (
            <div
              className="vz-tbgroup"
              role="group"
              aria-label={t('vz.group.tools', 'Edit tools')}
            >
              <button
                className={
                  gizmoOn ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
                }
                onClick={toggleGizmo}
                disabled={!hasProgram}
                title={t('vz.place', 'Place job — move / rotate / scale on all 3 axes (or click a toolpath)')}
                aria-label={t('vz.place', 'Place job')}
                aria-pressed={gizmoOn}
              >
                {IconPlace}
              </button>
              {gizmoOn && selectedSectionId && (
                <button
                  className="vz-toolbar-btn"
                  onClick={() =>
                    useProgram.getState().resetSectionPlacement(selectedSectionId)
                  }
                  title={t('vz.resetPlacement', 'Reset placement')}
                  aria-label={t('vz.resetPlacement', 'Reset placement')}
                >
                  {IconReset}
                </button>
              )}
              <button
                className={lassoMode ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
                onClick={toggleLasso}
                disabled={!hasProgram}
                title={t('vz.lasso', 'Lasso-delete: drag a region over the toolpath to remove moves (safe-Z kept)')}
                aria-label={t('vz.lasso', 'Lasso delete')}
                aria-pressed={lassoMode}
              >
                {IconLasso}
              </button>
              <button
                className={pickMode ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
                onClick={togglePick}
                disabled={!hasProgram}
                title={t(
                  'vz.pick',
                  'Pick-delete: click a toolpath line to select it (Shift/Ctrl-click for more), then Delete (safe-Z kept)',
                )}
                aria-label={t('vz.pick', 'Pick delete')}
                aria-pressed={pickMode}
              >
                {IconPick}
              </button>
              {/* V8 right-click-to-jog: arm jog-to-point mode (needs a connection). */}
              <button
                className={jogToMode ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
                onClick={toggleJogTo}
                disabled={!connected}
                title={t(
                  'vz.jogTo',
                  'Jog to point — right-click anywhere on the bed to move the head there (retracts to safe-Z first)',
                )}
                aria-label={t('vz.jogTo', 'Jog to point')}
                aria-pressed={jogToMode}
              >
                {IconJogTo}
              </button>
            </div>
          )}

          {/* ── Scene / display cluster: run-outline · bed-size · ⋯ more (add
              shapes + display options) · live HUD · surface heightmap. The ⋯
              menu absorbs the secondary toggles so this cluster stays compact. */}
          <div
            className="vz-tbgroup"
            role="group"
            aria-label={t('vz.group.display', 'Scene & display')}
          >
            {/* O6 run-outline: latch the program-footprint preview on the bed. */}
            {!svgMode && (
              <button
                className={
                  showRunOutline ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
                }
                onClick={() => setShowRunOutline((s) => !s)}
                disabled={!hasProgram}
                title={t(
                  'vz.runOutline',
                  'Run outline — show the program footprint on the bed before running',
                )}
                aria-label={t('vz.runOutline', 'Run outline')}
                aria-pressed={showRunOutline}
              >
                {IconRunOutline}
              </button>
            )}
            <BedSizeControl />
            {/* Overflow menu for the secondary controls. */}
            <OverflowMenu
              t={t}
              onAddShape={onAddShape}
              showAllToolpaths={showAllToolpaths}
              setShowAllToolpaths={setShowAllToolpaths}
              layerSections={legendSections}
              hiddenSections={hiddenSections}
              onToggleSection={toggleSection}
              showModel={showModel}
              setShowModel={setShowModel}
              showBed={showBed}
              setShowBed={setShowBed}
              showDimensions={showDimensions}
              setShowDimensions={setShowDimensions}
              showStock={showStock}
              setShowStock={setShowStock}
              showPcb={showPcb}
              setShowPcb={setShowPcb}
              carveSim={carveSim}
              setCarveSim={setCarveSim}
              autoStock={autoStock}
              setAutoStock={setAutoStock}
              autoStockThickness={autoStockThickness}
              setAutoStockThickness={setAutoStockThickness}
              hideProcessed={hideProcessed}
              setHideProcessed={setHideProcessed}
              showActualTool={showActualTool}
              setShowActualTool={setShowActualTool}
              showSimTool={showSimTool}
              setShowSimTool={setShowSimTool}
              showJobBoxes={showJobBoxes}
              setShowJobBoxes={setShowJobBoxes}
              showSoftLimits={showSoftLimits}
              setShowSoftLimits={setShowSoftLimits}
              showWcsOrigins={showWcsOrigins}
              setShowWcsOrigins={setShowWcsOrigins}
              camOverlay={camOverlay}
              toggleCamOverlay={toggleCamOverlay}
            />
            {/* V10 live DRO/state HUD overlay toggle. */}
            <button
              className={showHud ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
              onClick={() => setShowHud((s) => !s)}
              title={t('vz.hud', 'Live readout — show machine state, position, feed & spindle in the viewport')}
              aria-label={t('vz.hud', 'Live readout overlay')}
              aria-pressed={showHud}
            >
              {IconHud}
            </button>
            {/* V9 heightmap overlay toggle — only meaningful once a surface is probed. */}
            {!svgMode && heightmapReady && (
              <button
                className={showHeightmap ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
                onClick={() => setShowHeightmap((s) => !s)}
                title={t('vz.heightmap', 'Surface map — overlay the probed auto-leveling relief (low blue → high red)')}
                aria-label={t('vz.heightmap', 'Surface map overlay')}
                aria-pressed={showHeightmap}
              >
                {IconHeightmap}
              </button>
            )}
          </div>
        </div>
        {svgMode ? (
          <SvgViewport
            segments={lineSegments ?? []}
            bedW={bedW}
            bedD={bedD}
            dark={theme === 'dark'}
            colorByPower={heatOn}
            powerRange={powerRange}
            t={t}
          />
        ) : (
        <Viewer
          ref={ref}
          gcode={gcode}
          segments={simSegments}
          toolPosition={actualPosition}
          simPosition={simPosition}
          showActualTool={showActualTool}
          showSimTool={showSimTool}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
          hideProcessed={hideProcessed}
          carveSim={carveSim && simulating}
          toolRadius={toolRadius}
          carveToolType={carveToolType}
          carveAutoThickness={autoStock ? autoStockThickness : null}
          showStock={showStock}
          bedWidth={bedW}
          bedDepth={bedD}
          bedHeight={bedH}
          gizmo={gizmoOn && hasProgram && !!selectedSectionId}
          onGizmoChange={setGizmoOn}
          sectionBoxes={sectionBoxes}
          jobBoxes={jobBoxes}
          sectionPaths={sectionPaths}
          hoveredOpId={hoveredOpId}
          selectedSectionId={selectedSectionId}
          onSelectSection={selectSection}
          showJobBoxes={showJobBoxes}
          lasso={lassoMode && hasProgram}
          onLassoDelete={onLassoDelete}
          onLassoExit={() => setLassoMode(false)}
          pick={pickMode && hasProgram}
          onPickDelete={onPickDelete}
          onPickExit={() => setPickMode(false)}
          showDimensions={showDimensions}
          showToolpaths={showAllToolpaths}
          sectionVisibility={sectionVisibility}
          showShapes={showModel}
          showBed={showBed}
          showRunOutline={showRunOutline}
          runOutlineBounds={dims ? { min: dims.min, max: dims.max } : null}
          runOutlineFit={dims?.fit ?? 'ok'}
          heightmap={showHeightmap ? heightmapReady : null}
          jogTo={jogToMode && connected}
          onJogTo={onJogTo}
          showSoftLimits={showSoftLimits}
          showWcsOrigins={showWcsOrigins}
          colorByPower={heatOn}
          powerRange={powerRange}
          lineSegments={lineSegments}
          lineLink={hasProgram && !gizmoOn && !lassoMode && !pickMode && !jogToMode}
        />
        )}
        {/* V6 — suggest the lightweight view for very large programs. */}
        {!svgMode && (lineSegments?.length ?? 0) > SVG_SUGGEST_SEGMENTS && (
          <SvgSuggestion
            segs={lineSegments?.length ?? 0}
            onAccept={() => setSvgMode(true)}
            t={t}
          />
        )}
        {/* L10 — power scale legend (shown in both render modes when active). */}
        {heatOn && powerRange && <PowerLegend range={powerRange} t={t} />}
        {!svgMode && gizmoOn && placement && (
          <PlacementReadout
            placement={placement}
            name={selectedSection?.name}
            sectionId={selectedSectionId ?? ''}
            t={t}
          />
        )}
        {!springActive && (
          <DimensionsOverlay
            dims={dims}
            bedW={bedW}
            bedD={bedD}
            runTime={timeline?.duration ?? null}
          />
        )}
        {!svgMode && (
          <ToolConeLegend
            showActualTool={showActualTool}
            showSimTool={showSimTool}
            t={t}
          />
        )}
        {showHud && <ViewportHud t={t} />}
      </div>
      <ToolTimeline timeline={timeline} t={t} />
      <PlaybackTimeline />
    </div>
  )
}

type TFn = (
  key: string,
  english: string,
  vars?: Record<string, string | number>,
) => string
type Toggle = (updater: (v: boolean) => boolean) => void

/** Amber = actual (live machine) cone; cyan = simulation cone. */
const ACTUAL_TOOL_COLOR = '#f59e0b'
const SIM_TOOL_COLOR = '#22d3ee'

/**
 * Overflow ("⋯") menu holding the SECONDARY toolbar controls (add-shape +
 * display toggles + camera overlay). Keeping these off the always-visible row
 * means ~18 controls never collide or overflow on a phone. Each menu row is
 * labeled, so the add-shape glyphs (incl. ▭ for rectangle) read unambiguously
 * even though they overlap the view-button glyphs. Dismisses on outside-click /
 * Escape.
 */
function OverflowMenu({
  t,
  onAddShape,
  showAllToolpaths,
  setShowAllToolpaths,
  layerSections,
  hiddenSections,
  onToggleSection,
  showModel,
  setShowModel,
  showBed,
  setShowBed,
  showDimensions,
  setShowDimensions,
  showStock,
  setShowStock,
  showPcb,
  setShowPcb,
  carveSim,
  setCarveSim,
  autoStock,
  setAutoStock,
  autoStockThickness,
  setAutoStockThickness,
  hideProcessed,
  setHideProcessed,
  showActualTool,
  setShowActualTool,
  showSimTool,
  setShowSimTool,
  showJobBoxes,
  setShowJobBoxes,
  showSoftLimits,
  setShowSoftLimits,
  showWcsOrigins,
  setShowWcsOrigins,
  camOverlay,
  toggleCamOverlay,
}: {
  t: TFn
  onAddShape: (kind: ShapeKind) => void
  showAllToolpaths: boolean
  setShowAllToolpaths: Toggle
  layerSections: LegendSection[]
  hiddenSections: Record<string, boolean>
  onToggleSection: (id: string) => void
  showModel: boolean
  setShowModel: Toggle
  showBed: boolean
  setShowBed: Toggle
  showDimensions: boolean
  setShowDimensions: Toggle
  showStock: boolean
  setShowStock: Toggle
  showPcb: boolean
  setShowPcb: Toggle
  carveSim: boolean
  setCarveSim: Toggle
  autoStock: boolean
  setAutoStock: Toggle
  autoStockThickness: number
  setAutoStockThickness: (v: number) => void
  hideProcessed: boolean
  setHideProcessed: Toggle
  showActualTool: boolean
  setShowActualTool: Toggle
  showSimTool: boolean
  setShowSimTool: Toggle
  showJobBoxes: boolean
  setShowJobBoxes: Toggle
  showSoftLimits: boolean
  setShowSoftLimits: Toggle
  showWcsOrigins: boolean
  setShowWcsOrigins: Toggle
  camOverlay: boolean
  toggleCamOverlay: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // The menu is PORTALED to <body> (fixed coords) so a sibling dockview panel's
  // overflow/stacking can never clip its lower items. JS supplies the position.
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)

  const reposition = () => {
    const btn = btnRef.current
    const menu = menuRef.current
    if (!btn) return
    const margin = 8
    const br = btn.getBoundingClientRect()
    const mw = menu?.offsetWidth ?? 190
    let left = br.right - mw // right-aligned to the trigger
    left = Math.max(margin, Math.min(left, window.innerWidth - margin - mw))
    setCoords({ top: br.bottom + 6, left })
  }

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    reposition()
    const onScrollResize = () => reposition()
    window.addEventListener('scroll', onScrollResize, true)
    window.addEventListener('resize', onScrollResize)
    return () => {
      window.removeEventListener('scroll', onScrollResize, true)
      window.removeEventListener('resize', onScrollResize)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      // "Inside" now spans the trigger wrapper AND the portaled menu.
      if (
        (wrapRef.current && wrapRef.current.contains(target)) ||
        (menuRef.current && menuRef.current.contains(target))
      )
        return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const item = (
    glyph: React.ReactNode,
    label: string,
    onClick: () => void,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      className={'vz-menu-item' + (pressed ? ' vz-menu-item--on' : '')}
      onClick={onClick}
      aria-pressed={pressed}
    >
      <span className="vz-menu-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span className="vz-menu-label">{label}</span>
    </button>
  )

  // One eye/eye-off layer row (master "All toolpaths", per-section, model, bed).
  // Reuses the layers-tree row styling so the look is identical to the old
  // on-canvas overlay — just hosted inside this menu now.
  const layerRow = (
    visible: boolean,
    label: React.ReactNode,
    onToggle: () => void,
    opts?: { indent?: boolean; swatch?: string; key?: string },
  ) => (
    <button
      key={opts?.key}
      type="button"
      className={
        'vz-layer-row' +
        (opts?.indent ? ' vz-layer-row--child' : '') +
        (visible ? '' : ' vz-layer-row--off')
      }
      onClick={onToggle}
      aria-pressed={visible}
    >
      <span className="vz-layer-eye" aria-hidden="true">
        <Icon name={visible ? 'eye' : 'eye-off'} size={15} />
      </span>
      {opts?.swatch !== undefined && (
        <span
          className="vz-layer-swatch"
          style={{ background: opts.swatch }}
          aria-hidden="true"
        />
      )}
      <span className="vz-layer-label">{label}</span>
    </button>
  )

  return (
    <div className="vz-bed-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className="vz-toolbar-btn"
        onClick={() => setOpen((o) => !o)}
        title={t('vz.more', 'More tools (add shapes, display options)')}
        aria-label={t('vz.more', 'More tools')}
        aria-expanded={open}
      >
        {IconMore}
      </button>
      {open &&
        createPortal(
        <div
          ref={menuRef}
          className="vz-menu vz-menu--portal"
          role="menu"
          aria-label={t('vz.more', 'More tools')}
          style={{
            top: coords ? `${coords.top}px` : undefined,
            left: coords ? `${coords.left}px` : undefined,
            visibility: coords ? 'visible' : 'hidden',
          }}
        >
          <div className="vz-menu-group">
            {t('vz.menu.add', 'Add shape')}
          </div>
          {item(IconLine, t('vp.add.line', 'Add line'), () => onAddShape('line'))}
          {item(IconCircle, t('vp.add.circle', 'Add circle'), () =>
            onAddShape('circle'),
          )}
          {item(IconRect, t('vp.add.rectangle', 'Add rectangle'), () =>
            onAddShape('rectangle'),
          )}
          {item(IconTriangle, t('vp.add.triangle', 'Add triangle'), () =>
            onAddShape('triangle'),
          )}
          <div className="vz-menu-group">
            {t('vz.menu.display', 'Display')}
          </div>
          {item(
            IconDimensions,
            t('vz.dimensions', 'Show toolpath dimensions (X/Y/Z)'),
            () => setShowDimensions((s) => !s),
            showDimensions,
          )}
          {item(
            IconJobBox,
            t('vz.jobBoxes', 'Show toolpath cubes (colored boxes)'),
            () => setShowJobBoxes((s) => !s),
            showJobBoxes,
          )}
          {item(
            IconSoftLimit,
            t('vz.softLimits', 'Show soft-limit box + machine origin'),
            () => setShowSoftLimits((s) => !s),
            showSoftLimits,
          )}
          {item(
            IconWcs,
            t('vz.wcsOrigins', 'Show work coordinate origins (G54–G59)'),
            () => setShowWcsOrigins((s) => !s),
            showWcsOrigins,
          )}
          {item(
            IconStock,
            t('vz.showStock', 'Show stock'),
            () => setShowStock((s) => !s),
            showStock,
          )}
          {item(
            IconPcb,
            t('vz.display.pcb', 'PCB board — show the soldering FR-4/copper board (pads always shown)'),
            () => setShowPcb((s) => !s),
            showPcb,
          )}
          {item(
            IconCarve,
            t('vz.carveSim', 'Material removal simulation'),
            () => setCarveSim((s) => !s),
            carveSim,
          )}
          {/* Layers tree (relocated from the old on-canvas overlay): show/hide
              the toolpaths (master + per-section, with colour swatches), the
              model/drawing, and the machine bed. The per-section list scrolls
              when long so the rest of the menu stays reachable. */}
          <div className="vz-menu-group">
            {t('vz.layers.label', 'Layers')}
          </div>
          <div className="vz-layer-group">
            {t('vz.layers.toolpaths', 'Toolpaths')}
          </div>
          {layerRow(
            showAllToolpaths,
            t('vz.layers.allToolpaths', 'All toolpaths'),
            () => setShowAllToolpaths((v) => !v),
          )}
          {layerSections.length === 0 ? (
            <div className="vz-layer-empty">
              {t('vz.layers.none', 'No toolpaths loaded')}
            </div>
          ) : (
            <div className="vz-menu-layers">
              {layerSections.map((s) =>
                layerRow(
                  showAllToolpaths && hiddenSections[s.id] !== true,
                  s.name,
                  () => onToggleSection(s.id),
                  { indent: true, swatch: s.color, key: s.id },
                ),
              )}
            </div>
          )}
          <div className="vz-layer-group">{t('vz.layers.scene', 'Scene')}</div>
          {layerRow(showModel, t('vz.layers.model', 'Model / drawing'), () =>
            setShowModel((v) => !v),
          )}
          {layerRow(showBed, t('vz.layers.bed', 'Machine bed'), () =>
            setShowBed((v) => !v),
          )}
          <div className="vz-menu-group">
            {t('sim.menu.stock', 'Stock simulation')}
          </div>
          {item(
            IconAutoStock,
            t('sim.autoStock', 'Auto stock from toolpath'),
            () => setAutoStock((s) => !s),
            autoStock,
          )}
          {autoStock && (
            <label
              className="vz-menu-item vz-menu-num"
              title={t(
                'sim.autoStockThickness.title',
                'Stock thickness below the deepest cut (mm) for the auto-derived block',
              )}
            >
              <span className="vz-menu-glyph" aria-hidden="true">
                {IconStock}
              </span>
              <span className="vz-menu-label">
                {t('sim.autoStockThickness', 'Thickness')}
              </span>
              <input
                type="number"
                className="vz-menu-input"
                min={0.5}
                step={0.5}
                value={autoStockThickness}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const v = e.target.valueAsNumber
                  if (Number.isFinite(v) && v > 0) setAutoStockThickness(v)
                }}
              />
              <span className="vz-menu-unit">{t('common.mm', 'mm')}</span>
            </label>
          )}
          {item(
            IconHideProcessed,
            t('sim.hideProcessed', 'Hide processed cuts'),
            () => setHideProcessed((s) => !s),
            hideProcessed,
          )}
          {item(
            <span style={{ color: ACTUAL_TOOL_COLOR }}>{IconCone}</span>,
            t('vz.showActualTool', 'Show actual machine tool (live)'),
            () => setShowActualTool((s) => !s),
            showActualTool,
          )}
          {item(
            <span style={{ color: SIM_TOOL_COLOR }}>{IconCone}</span>,
            t('vz.showSimTool', 'Show simulation tool'),
            () => setShowSimTool((s) => !s),
            showSimTool,
          )}
          {item(
            IconCamera,
            t('vz.cameraOverlay', 'Show live camera 3D'),
            toggleCamOverlay,
            camOverlay,
          )}
        </div>,
          document.body,
        )}
    </div>
  )
}

interface LegendSection {
  id: string
  name: string
  color: string
}

/**
 * Tiny tool-cone legend (bottom-right) clarifying the two coloured cones: amber
 * is the ACTUAL live machine position, cyan is the SIMULATION playhead. Only
 * shows the rows for cones that are currently enabled; hides entirely when both
 * are off.
 */
function ToolConeLegend({
  showActualTool,
  showSimTool,
  t,
}: {
  showActualTool: boolean
  showSimTool: boolean
  t: TFn
}) {
  if (!showActualTool && !showSimTool) return null
  return (
    <div
      className="vz-legend"
      role="note"
      aria-label={t('vz.legend.aria', 'Tool cone legend')}
    >
      {showActualTool && (
        <span className="vz-legend-row">
          <span
            className="vz-legend-cone"
            style={{ color: ACTUAL_TOOL_COLOR }}
            aria-hidden="true"
          >
            {IconCone}
          </span>
          {t('vz.legend.actual', 'Machine (live)')}
        </span>
      )}
      {showSimTool && (
        <span className="vz-legend-row">
          <span
            className="vz-legend-cone"
            style={{ color: SIM_TOOL_COLOR }}
            aria-hidden="true"
          >
            {IconCone}
          </span>
          {t('vz.legend.sim', 'Simulation')}
        </span>
      )}
    </div>
  )
}

/**
 * Tiny bed-size editor: an icon button in the view toolbar that toggles a
 * compact popover with three axis-coloured number inputs (X/Y/Z, mm). Edits go
 * straight to the persisted bed store, so the grid + bounds box + fit-check all
 * update live.
 */
function BedSizeControl() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const width = useBed((s) => s.width)
  const depth = useBed((s) => s.depth)
  const height = useBed((s) => s.height)
  const setWidth = useBed((s) => s.setWidth)
  const setDepth = useBed((s) => s.setDepth)
  const setHeight = useBed((s) => s.setHeight)

  // Dismiss on outside-click or Escape, like a native popover.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="vz-bed-wrap" ref={wrapRef}>
      <button
        className="vz-toolbar-btn"
        onClick={() => setOpen((o) => !o)}
        title={t('vz.bedSize.title', 'Bed size (work area)')}
        aria-label={t('vz.bedSize.aria', 'Bed size')}
        aria-expanded={open}
      >
        {IconBed}
      </button>
      {open && (
        <div
          className="vz-bed-pop"
          role="dialog"
          aria-label={t('vz.bedSize.dialog', 'Bed size (mm)')}
        >
          <BedField
            label="X"
            color="#ef4444"
            value={width}
            onChange={setWidth}
            title={t('vz.bedSize.x', 'Work area width — X axis (mm)')}
          />
          <BedField
            label="Y"
            color="#22c55e"
            value={depth}
            onChange={setDepth}
            title={t('vz.bedSize.y', 'Work area depth — Y axis (mm)')}
          />
          <BedField
            label="Z"
            color="#3b82f6"
            value={height}
            onChange={setHeight}
            title={t('vz.bedSize.z', 'Work area height — Z axis (mm)')}
          />
        </div>
      )}
    </div>
  )
}

function BedField({
  label,
  color,
  value,
  onChange,
  title,
}: {
  label: string
  color: string
  value: number
  onChange: (v: number) => void
  title: string
}) {
  return (
    <label className="vz-bed-field" title={title}>
      <span className="vz-bed-axis" style={{ color }}>
        {label}
      </span>
      <input
        type="number"
        className="vz-bed-input"
        value={value}
        min={1}
        step={1}
        onChange={(e) => {
          const v = e.target.valueAsNumber
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </label>
  )
}

/** Format a placement value for an editable cell (≤2 decimals, no trailing noise). */
function fmtCell(v: number): string {
  return String(Math.round(v * 100) / 100)
}

/**
 * One editable axis cell (label + number input) for the placement readout.
 *
 * MUST be a module-level component (not defined inside PlacementReadout): a
 * component declared inside another renders as a brand-new type on every parent
 * render, so React unmounts/remounts its <input> — which steals focus after the
 * first keystroke (you type "1", the store updates, the cell remounts, the field
 * blurs). Hoisting it fixes that. It also holds LOCAL text state while focused so
 * the rounded/derived value doesn't fight what you're typing (e.g. "1.", "-",
 * "12.5"); it commits a parsed number on each valid keystroke and re-syncs from
 * the prop (gizmo drags, reset) only when not being edited.
 */
function NumberCell({
  axis,
  value,
  onCommit,
}: {
  axis: string
  value: number
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(() => fmtCell(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setText(fmtCell(value))
  }, [value, editing])
  return (
    <>
      <span className="vz-place-k">{axis}</span>
      <input
        className="vz-place-input"
        type="number"
        value={text}
        onFocus={() => setEditing(true)}
        onBlur={() => {
          setEditing(false)
          setText(fmtCell(value))
        }}
        onChange={(e) => {
          setText(e.target.value)
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onCommit(v)
        }}
      />
    </>
  )
}

/**
 * Compact top-left readout of the current placement (XY offset in mm, Z rotation
 * in degrees, uniform scale as a percentage). Sits opposite the toolbar so the
 * user always sees exactly how the job has been moved while the gizmo is active.
 */
function PlacementReadout({
  placement,
  name,
  sectionId,
  t,
}: {
  placement: JobPlacement
  name?: string
  sectionId: string
  t: (key: string, english: string) => string
}) {
  const [rx, ry, rz] = quaternionToEulerDeg(
    placement.qx,
    placement.qy,
    placement.qz,
    placement.qw,
  )
  const patch = (p: Partial<JobPlacement>) => {
    if (sectionId) useProgram.getState().setSectionPlacement(sectionId, p)
  }
  return (
    <div className="vz-place" role="status" aria-label={t('vz.placement', 'Placement')}>
      {name && (
        <span className="vz-place-pair vz-place-name" title={t('vz.placeSection', 'Selected toolpath')}>
          {name}
        </span>
      )}
      <span className="vz-place-pair" title={t('vz.move', 'Move (editable — type X/Y/Z in mm)')}>
        <NumberCell axis={t('common.axisX', 'X')} value={placement.dx} onCommit={(v) => patch({ dx: v })} />
        <NumberCell axis={t('common.axisY', 'Y')} value={placement.dy} onCommit={(v) => patch({ dy: v })} />
        <NumberCell axis={t('common.axisZ', 'Z')} value={placement.dz} onCommit={(v) => patch({ dz: v })} />
        <span className="vz-place-unit">{t('common.mm', 'mm')}</span>
      </span>
      <span className="vz-place-pair" title={t('vz.rotate', 'Rotate (drag the gizmo arcs)')}>
        <span className="vz-place-k">{t('common.axisX', 'X')}</span>
        <span className="vz-place-v">{mm(rx)}</span>
        <span className="vz-place-k">{t('common.axisY', 'Y')}</span>
        <span className="vz-place-v">{mm(ry)}</span>
        <span className="vz-place-k">{t('common.axisZ', 'Z')}</span>
        <span className="vz-place-v">{mm(rz)}</span>
        <span className="vz-place-unit">{t('common.deg', '°')}</span>
      </span>
      <span className="vz-place-pair" title={t('vz.scale', 'Scale % (editable — reliable per-axis incl. Z)')}>
        <NumberCell
          axis={t('common.axisX', 'X')}
          value={placement.sx * 100}
          onCommit={(v) => patch({ sx: Math.max(0.01, v / 100) })}
        />
        <NumberCell
          axis={t('common.axisY', 'Y')}
          value={placement.sy * 100}
          onCommit={(v) => patch({ sy: Math.max(0.01, v / 100) })}
        />
        <NumberCell
          axis={t('common.axisZ', 'Z')}
          value={placement.sz * 100}
          onCommit={(v) => patch({ sz: Math.max(0.01, v / 100) })}
        />
        <span className="vz-place-unit">{t('common.percent', '%')}</span>
      </span>
    </div>
  )
}

interface Dims {
  w: number
  h: number
  d: number
  min: [number, number, number]
  max: [number, number, number]
  area: number
  fit: 'ok' | 'warn' | 'danger'
  offBed: boolean
  oversized: boolean
}

/**
 * Axis-aligned bounds of a set of segments (the SAME geometry the viewer draws),
 * or null when there is nothing to bound. Replaces a second gcodeToPolylines
 * parse so the reported size always matches what's on screen.
 */
function boundsOfSegments(
  segments: Segment[] | undefined,
): { min: [number, number, number]; max: [number, number, number] } | null {
  if (!segments || segments.length === 0) return null
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  const grow = (p: [number, number, number]) => {
    for (let i = 0; i < 3; i++) {
      if (p[i] < min[i]) min[i] = p[i]
      if (p[i] > max[i]) max[i] = p[i]
    }
  }
  for (const s of segments) {
    grow(s.from)
    grow(s.to)
  }
  if (!isFinite(min[0]) || !isFinite(max[0])) return null
  return { min, max }
}

/** Format a length in mm with at most 1 decimal, trimming trailing zeros. */
function mm(v: number): string {
  return (Math.round(v * 10) / 10).toString()
}

/** Area in cm² (>=1cm²) or mm², human-friendly (units wrapped for i18n). */
function fmtArea(mm2: number, t: TFn): string {
  if (mm2 >= 100) {
    return t('vz.area.cm2', '{v} cm²', {
      v: (Math.round((mm2 / 100) * 10) / 10).toString(),
    })
  }
  return t('vz.area.mm2', '{v} mm²', { v: Math.round(mm2) })
}

/** Human-friendly duration: `1h 4m`, `4m 12s`, or `38s`. */
function fmtDuration(sec: number, t: TFn): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const total = Math.round(sec)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return t('vz.dur.hm', '{h}h {m}m', { h, m })
  if (m > 0) return t('vz.dur.ms', '{m}m {s}s', { m, s })
  return t('vz.dur.s', '{s}s', { s })
}

/**
 * V10 — live DRO / machine-state HUD overlaid in the viewport (top-left, below
 * the axis triad). Shows the work position, machine state, feed and spindle so a
 * fullscreen / phone operator never has to leave the 3D view to read the DRO.
 *
 * Subscribes narrowly to the machine store (only the fields it renders), so a
 * status poll re-renders just this tiny overlay — never the 3D scene. No WebGL,
 * no per-frame work: it's a plain DOM panel, so it can't affect viewport FPS.
 */
function ViewportHud({ t }: { t: TFn }) {
  const connected = useMachine((s) => s.connection === 'connected')
  const state = useMachine((s) => s.state)
  const wpos = useMachine((s) => s.wpos)
  const feed = useMachine((s) => s.feed)
  const spindle = useMachine((s) => s.spindle)

  const stateKey = `ctrl.state.${state.toLowerCase()}`
  const stateLabel = connected ? t(stateKey, state) : t('vz.hud.offline', 'Offline')
  const fmt = (v: number) => (Math.round(v * 1000) / 1000).toFixed(3)

  return (
    <div
      className="vz-hud"
      role="status"
      aria-label={t('vz.hud.aria', 'Live machine readout')}
      data-state={connected ? state : 'Offline'}
    >
      <div className="vz-hud-state" data-state={connected ? state : 'Offline'}>
        <span className="vz-hud-dot" aria-hidden="true" />
        {stateLabel}
      </div>
      <div className="vz-hud-dro">
        {(['X', 'Y', 'Z'] as const).map((ax) => (
          <div className="vz-hud-axis" key={ax}>
            <span className="vz-hud-axislbl">{ax}</span>
            <span className="vz-hud-axisval">
              {fmt(ax === 'X' ? wpos.x : ax === 'Y' ? wpos.y : wpos.z)}
            </span>
          </div>
        ))}
      </div>
      <div className="vz-hud-meta">
        <span title={t('vz.hud.feed', 'Feed rate (mm/min)')}>
          {t('vz.hud.feedVal', 'F {v}', { v: Math.round(feed) })}
        </span>
        <span title={t('vz.hud.spindle', 'Spindle speed (rpm)')}>
          {t('vz.hud.spindleVal', 'S {v}', { v: Math.round(spindle) })}
        </span>
      </div>
    </div>
  )
}

/**
 * V14 — tool-timeline strip. A thin horizontal bar under the viewport showing
 * WHERE along the job each tool change (M6 / T) happens, positioned by program
 * time. Clicking a marker scrubs the playback to that change. Hidden when the
 * program is single-tool (no changes) so it never adds empty chrome.
 *
 * Cheap: derived once per timeline (the markers are precomputed in the core), a
 * handful of absolutely-positioned DOM nodes, no per-frame work.
 */
function ToolTimeline({
  timeline,
  t,
}: {
  timeline: ReturnType<typeof buildTimeline> | null
  t: TFn
}) {
  const time = usePlayback((s) => s.time)
  const seek = usePlayback((s) => s.seek)
  const changes = timeline?.toolChanges ?? []
  const duration = timeline?.duration ?? 0
  if (!timeline || duration <= 0 || changes.length === 0) return null
  const pct = (time / duration) * 100

  return (
    <div
      className="vz-tooltl"
      role="group"
      aria-label={t('vz.toolTimeline', 'Tool change timeline')}
    >
      <span className="vz-tooltl-lbl" aria-hidden="true">
        {t('vz.toolTimeline.short', 'Tools')}
      </span>
      <div className="vz-tooltl-track">
        {/* Progress fill mirrors the playhead so the strip reads with the transport. */}
        <span className="vz-tooltl-fill" style={{ width: `${pct}%` }} aria-hidden="true" />
        {changes.map((c, i) => {
          const left = (c.t / duration) * 100
          return (
            <button
              key={`${c.line}-${i}`}
              type="button"
              className="vz-tooltl-mark"
              style={{ left: `${left}%` }}
              title={t('vz.toolTimeline.mark', 'Tool {tool} change · line {line} · {time}', {
                tool: c.tool,
                line: c.line,
                time: fmtDuration(c.t, t),
              })}
              aria-label={t('vz.toolTimeline.markAria', 'Jump to tool {tool} change', {
                tool: c.tool,
              })}
              onClick={() => seek(c.t)}
            >
              <span className="vz-tooltl-pin" aria-hidden="true" />
              <span className="vz-tooltl-num">{c.tool}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** Compact bottom-left overlay reporting program size + bed-fit status. */
function DimensionsOverlay({
  dims,
  bedW,
  bedD,
  runTime,
}: {
  dims: Dims | null
  bedW: number
  bedD: number
  /** Estimated program run time (seconds) from the playback timeline, or null. */
  runTime: number | null
}) {
  const t = useT()
  if (!dims) {
    return (
      <div className="vz-dims" data-empty="true" aria-hidden="true">
        <span className="vz-dims-dash">{t('common.emDash', '—')}</span>
      </div>
    )
  }

  const bedLabel = t('vz.bedLabel', '{w}×{d}', { w: mm(bedW), d: mm(bedD) })
  const fitLabel =
    dims.fit === 'danger'
      ? t('vz.fit.exceeds', 'exceeds bed {bed}', { bed: bedLabel })
      : dims.fit === 'warn'
        ? t('vz.fit.outside', 'outside bed {bed}', { bed: bedLabel })
        : t('vz.fit.fits', 'fits bed {bed}', { bed: bedLabel })

  return (
    <div className="vz-dims" role="status" aria-label={t('vz.programDims.aria', 'Program dimensions')}>
      <div
        className="vz-dims-row vz-dims-size"
        title={t(
          'vz.size.title',
          "Width (X) × Depth (Y) of the loaded program's bounding box, in mm",
        )}
      >
        <span className="vz-dims-val">{mm(dims.w)}</span>
        <span className="vz-dims-x">{t('common.times', '×')}</span>
        <span className="vz-dims-val">{mm(dims.h)}</span>
        <span className="vz-dims-unit">{t('common.mm', 'mm')}</span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title={t('vz.zrange.title', 'Z range (top→bottom) and total cut depth, in mm')}
      >
        <span>
          {t('vz.zrange', 'Z {min}…{max} ({depth})', {
            min: mm(dims.min[2]),
            max: mm(dims.max[2]),
            depth: mm(dims.d),
          })}
        </span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title={t('vz.footprint.title', 'Footprint area covered by the toolpath')}
      >
        <span>{fmtArea(dims.area, t)}</span>
      </div>
      {/* V7 — estimated run time from the simulation timeline (feed-based). */}
      {runTime != null && runTime > 0 && (
        <div
          className="vz-dims-row vz-dims-meta"
          title={t(
            'vz.runTime.title',
            'Estimated run time at programmed feeds (rapids + cuts; before overrides)',
          )}
        >
          <span>{t('vz.runTime', '~{time} run', { time: fmtDuration(runTime, t) })}</span>
        </div>
      )}
      <div
        className="vz-dims-row vz-dims-fit"
        data-fit={dims.fit}
        title={t(
          'vz.fit.title',
          'Whether the program fits within the machine work area (bed {bed} mm)',
          { bed: bedLabel },
        )}
      >
        <span className="vz-dims-dot" data-fit={dims.fit} />
        <span>{fitLabel}</span>
      </div>
    </div>
  )
}

// V6 — past this many parsed moves we suggest the lightweight 2D view.
const SVG_SUGGEST_SEGMENTS = 45000
// L10 — number of discrete colour bands the SVG heat-map buckets power into.
const POWER_BUCKETS = 10

/** [r,g,b] in 0..1 → a CSS rgb() string. */
function rgbStr([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}
/** Representative colour for power bucket i (matches the 3D heat-map). */
function bucketColor(i: number): string {
  return rgbStr(heatColor((i + 0.5) / POWER_BUCKETS))
}
/** CSS linear-gradient mirroring {@link heatColor} for the power legend bar. */
function heatGradientCss(): string {
  const parts: string[] = []
  const n = 6
  for (let i = 0; i <= n; i++) {
    const t = i / n
    parts.push(`${rgbStr(heatColor(t))} ${Math.round(t * 100)}%`)
  }
  return `linear-gradient(to right, ${parts.join(', ')})`
}

/**
 * V6 — lightweight 2D (SVG) top-view of the toolpath. A genuinely lighter render
 * path than WebGL: the whole program collapses into a handful of `<path>`
 * elements (one for rapids, one per power bucket or one for cuts, one for the
 * selected-line highlight), built once per change with `non-scaling-stroke` so
 * pan/zoom stays crisp. No GPU context, no per-frame work — ideal for huge files
 * on a Pi / phone. Y is flipped (world +Y up → SVG up) by negating the y coord.
 */
function SvgViewport({
  segments,
  bedW,
  bedD,
  dark,
  colorByPower,
  powerRange,
  t,
}: {
  segments: Segment[]
  bedW: number
  bedD: number
  dark: boolean
  colorByPower: boolean
  powerRange: [number, number] | null
  t: TFn
}) {
  const selectedLine = useGcodeSelection((s) => s.selectedLine)
  // Live tool position (work coords) — drawn as a crosshair that tracks jogs and
  // streaming. wpos is replaced with a fresh object on each status report, so this
  // selector re-renders the (cheap) marker live without recomputing the path memo.
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')
  // Soldering points of interest — mirror the 3D SolderScene's pads + highlights.
  const solderActive = useSolderViz((s) => s.active)
  const solderPts = useSolderViz((s) => s.points)
  const solSelected = useSolderViz((s) => s.selected)
  const solHovered = useSolderViz((s) => s.hovered)
  const solActive = useSolderViz((s) => s.activeIndex)
  const solFromDrill = useSolderViz((s) => s.fromDrill)
  // Hover previews a point; otherwise the pinned click-selection shows (as in 3D).
  const solHighlight = solHovered >= 0 ? solHovered : solSelected
  const hasSolder = solderActive && solderPts.length > 0

  const view = useMemo(() => {
    let minX = -bedW / 2
    let maxX = bedW / 2
    let minY = -bedD / 2
    let maxY = bedD / 2
    for (const s of segments) {
      minX = Math.min(minX, s.from[0], s.to[0])
      maxX = Math.max(maxX, s.from[0], s.to[0])
      minY = Math.min(minY, s.from[1], s.to[1])
      maxY = Math.max(maxY, s.from[1], s.to[1])
    }
    // Keep solder pads in frame (a points-only soldering job has no segments).
    for (const p of solderPts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y)
      maxY = Math.max(maxY, p.y)
    }
    const pad = Math.max(maxX - minX, maxY - minY) * 0.04 + 2
    minX -= pad
    maxX += pad
    minY -= pad
    maxY += pad
    const w = Math.max(maxX - minX, 1)
    const h = Math.max(maxY - minY, 1)
    // Marker radius in mm, scaled to the view so pads/crosshair read at any zoom.
    const markerR = Math.max(Math.min(w, h) * 0.012, 0.6)

    const rapid: string[] = []
    const cut: string[] = []
    const buckets: string[][] =
      colorByPower && powerRange ? Array.from({ length: POWER_BUCKETS }, () => []) : []
    const sel: string[] = []
    const [lo, hi] = powerRange ?? [0, 1]
    const span = hi - lo || 1
    for (const s of segments) {
      const d = `M${s.from[0].toFixed(2)} ${(-s.from[1]).toFixed(2)}L${s.to[0].toFixed(2)} ${(-s.to[1]).toFixed(2)}`
      if (selectedLine != null && s.line === selectedLine) sel.push(d)
      if (s.kind === 'rapid') {
        rapid.push(d)
        continue
      }
      if (colorByPower && powerRange) {
        const bi = Math.max(
          0,
          Math.min(POWER_BUCKETS - 1, Math.floor((((s.power ?? lo) - lo) / span) * POWER_BUCKETS)),
        )
        buckets[bi].push(d)
      } else {
        cut.push(d)
      }
    }
    return {
      viewBox: `${minX.toFixed(2)} ${(-maxY).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)}`,
      rapidD: rapid.join(''),
      cutD: cut.join(''),
      bucketD: buckets.map((b) => b.join('')),
      selD: sel.join(''),
      markerR,
    }
  }, [segments, solderPts, bedW, bedD, colorByPower, powerRange, selectedLine])

  const bg = dark ? '#15181c' : '#e7ecf1'
  const bedStroke = dark ? '#515c6e' : '#aab4c0'
  const cutColor = dark ? '#38bdf8' : '#0369a1'
  const rapidColor = dark ? '#6b7280' : '#94a3b8'
  // POI / live-marker palette (mirrors the 3D scene: copper pad, cyan highlight,
  // amber active/live so the 2D view reads the same as the 3D one).
  const padColor = dark ? '#ffd98a' : '#c8951a'
  const hiColor = dark ? '#34e3f5' : '#0891b2'
  const liveColor = dark ? '#ffb454' : '#ea7a17'
  const r = view.markerR

  return (
    <div className="vz-svgwrap" style={{ background: bg }}>
      <svg
        className="vz-svg"
        viewBox={view.viewBox}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t('vz.svgMode.aria', 'Lightweight 2D toolpath view (top)')}
      >
        {/* Bed footprint (centred on the work origin). */}
        <rect
          x={-bedW / 2}
          y={-bedD / 2}
          width={bedW}
          height={bedD}
          fill="none"
          stroke={bedStroke}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
          opacity={0.7}
        />
        {/* G54 work origin cross. */}
        <line x1={-6} y1={0} x2={6} y2={0} stroke="#ef4444" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <line x1={0} y1={-6} x2={0} y2={6} stroke="#22c55e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        {view.rapidD && (
          <path
            d={view.rapidD}
            fill="none"
            stroke={rapidColor}
            strokeWidth={0.8}
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
            opacity={0.7}
          />
        )}
        {colorByPower && powerRange
          ? view.bucketD.map(
              (d, i) =>
                d && (
                  <path
                    key={i}
                    d={d}
                    fill="none"
                    stroke={bucketColor(i)}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ),
            )
          : view.cutD && (
              <path d={view.cutD} fill="none" stroke={cutColor} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            )}
        {view.selD && (
          <path d={view.selD} fill="none" stroke="#f43f5e" strokeWidth={2.4} vectorEffect="non-scaling-stroke" />
        )}
        {/* Soldering points of interest: a marker per pad, echoing the 3D scene's
            hover/pin highlight (cyan) and the streaming active point (amber). Drill
            points read as hollow rings; surface pads as filled discs. */}
        {hasSolder &&
          solderPts.map((p, i) => {
            const isHi = i === solHighlight
            const isAct = i === solActive
            const c = isHi ? hiColor : isAct ? liveColor : padColor
            const rr = isHi || isAct ? r * 1.5 : r
            return solFromDrill ? (
              <circle
                key={i}
                cx={p.x}
                cy={-p.y}
                r={rr}
                fill="none"
                stroke={c}
                strokeWidth={isHi || isAct ? 1.8 : 1.2}
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <circle
                key={i}
                cx={p.x}
                cy={-p.y}
                r={rr}
                fill={c}
                fillOpacity={isHi || isAct ? 0.95 : 0.7}
                stroke={c}
                strokeWidth={isHi || isAct ? 1.4 : 0.6}
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        {/* Live tool marker: a crosshair + dot at the machine's current work
            position, tracking jogs and streaming. Only while connected. */}
        {connected && Number.isFinite(wpos.x) && Number.isFinite(wpos.y) && (
          <g>
            <line
              x1={wpos.x - r * 2.4}
              y1={-wpos.y}
              x2={wpos.x + r * 2.4}
              y2={-wpos.y}
              stroke={liveColor}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={wpos.x}
              y1={-wpos.y - r * 2.4}
              x2={wpos.x}
              y2={-wpos.y + r * 2.4}
              stroke={liveColor}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={wpos.x}
              cy={-wpos.y}
              r={r * 0.9}
              fill="none"
              stroke={liveColor}
              strokeWidth={1.6}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>
      <div className="vz-svg-badge" aria-hidden="true">
        {t('vz.svgMode.badge', 'Lightweight 2D')}
      </div>
    </div>
  )
}

/** V6 — dismissible chip suggesting the lightweight view for very large programs. */
function SvgSuggestion({
  segs,
  onAccept,
  t,
}: {
  segs: number
  onAccept: () => void
  t: TFn
}) {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <div className="vz-svg-suggest" role="status">
      <span>
        {t(
          'vz.svgSuggest',
          'Large program ({n} moves) — switch to the lightweight view for smoother performance?',
          { n: segs },
        )}
      </span>
      <button type="button" className="vz-svg-suggest-go" onClick={onAccept}>
        {t('vz.svgSuggest.go', 'Use lightweight')}
      </button>
      <button
        type="button"
        className="vz-svg-suggest-x"
        onClick={() => setDismissed(true)}
        aria-label={t('common.dismiss', 'Dismiss')}
      >
        ×
      </button>
    </div>
  )
}

/** L10 — compact gradient legend mapping colour → laser power (S-value). */
function PowerLegend({ range, t }: { range: [number, number]; t: TFn }) {
  const [lo, hi] = range
  return (
    <div className="vz-powerlegend" role="note" aria-label={t('vz.powerLegend.aria', 'Laser power scale')}>
      <span className="vz-powerlegend-title">{t('vz.powerLegend', 'Power (S)')}</span>
      <div className="vz-powerlegend-bar" style={{ background: heatGradientCss() }} aria-hidden="true" />
      <div className="vz-powerlegend-scale">
        <span>{Math.round(lo)}</span>
        <span>{Math.round(hi)}</span>
      </div>
    </div>
  )
}

// Inline (panel-local) styles — globals.css is owned by another agent.
// Theme-aware via CSS vars. The view toolbar lives top-right (icon buttons);
// the dimensions overlay lives bottom-left so the two never collide.
// Touch-friendly sizing on coarse pointers.
const OVERLAY_CSS = `
.vz-root {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vz-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.vz-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: flex-start;
  /* Generous gap BETWEEN clusters; spacing WITHIN a cluster is tighter (set on
     .vz-tbgroup) so each capsule reads as one cohesive group. */
  gap: 8px;
  /* Cap the width so the row WRAPS instead of overlapping the scene; leave a
     left gutter so it never collides with the placement readout (top-left). */
  max-width: calc(100% - 16px);
  pointer-events: auto;
}
/* A cluster of related controls — a translucent "glass" capsule that groups
   buttons (render · view · edit · display) so the overlay reads as a few tidy
   clusters instead of one long crowded run. Buttons inside go "ghost" (below)
   so the capsule itself carries the surface; only hover/open/latched-on fills. */
.vz-tbgroup {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: calc(var(--radius) + 4px);
  border: 1px solid color-mix(in srgb, var(--border) 75%, transparent);
  background: color-mix(in srgb, var(--bg-elev) 68%, transparent);
  backdrop-filter: blur(9px) saturate(1.12);
  box-shadow: var(--shadow-1);
}
.vz-tbgroup .vz-toolbar-btn {
  background: transparent;
  border-color: transparent;
  backdrop-filter: none;
  box-shadow: none;
}
.vz-tbgroup .vz-toolbar-btn:hover {
  background: color-mix(in srgb, var(--fg) 12%, transparent);
  border-color: transparent;
  color: var(--fg);
}
.vz-tbgroup .vz-toolbar-btn[aria-expanded='true'] {
  /* Open popover trigger (Bed / More): subtle accent tint, no border so it
     stays flush inside the capsule. */
  border-color: transparent;
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  color: var(--accent);
}
.vz-tbgroup .vz-toolbar-btn--on,
.vz-tbgroup .vz-toolbar-btn--on:hover {
  /* Latched mode (place / lasso / pick / jog / run-outline / heat-map): a solid
     accent fill stands out unmistakably against the translucent capsule. */
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}
.vz-tbgroup .vz-toolbar-btn:disabled,
.vz-tbgroup .vz-toolbar-btn:disabled:hover {
  background: transparent;
  border-color: transparent;
  color: var(--fg-muted);
}
/* Icon button (§2.8): --icon-btn square, neutral resting border, accent only on
   hover/active/focus. The translucent glass fill stays (these float over the 3D
   scene) but the border no longer reads as a persistent "selected" state. */
.vz-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--icon-btn);
  height: var(--icon-btn);
  padding: 0;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  color: var(--fg-muted);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.vz-toolbar-btn svg { display: block; }
.vz-toolbar-btn:hover {
  background: color-mix(in srgb, var(--bg-elev) 95%, transparent);
  border-color: var(--accent);
  color: var(--fg);
}
.vz-toolbar-btn:active {
  transform: translateY(1px);
}
.vz-toolbar-btn[aria-expanded='true'] {
  /* Open popover trigger (More / Layers / Bed): a subtle accent tint — distinct
     from a *latched mode* button, which fills solid (below). */
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
}
.vz-toolbar-btn--on {
  /* Active TOGGLE mode (place / lasso / pick): a solid accent FILL so a latched
     mode is unmistakable vs the momentary view buttons (which never fill). */
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-fg);
}
.vz-toolbar-btn--on:hover {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg);
  filter: brightness(1.08);
}
.vz-toolbar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* Cluster divider between functional groups of toolbar controls (view │ scene │
   edit). One hairline token, matched to the topbar separator rhythm. */
.vz-toolbar-sep {
  width: 1px;
  align-self: stretch;
  margin: 3px var(--sp-1);
  background: var(--border);
  flex: 0 0 auto;
}
.vz-place {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  pointer-events: none;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  box-shadow: var(--shadow-1);
  color: var(--fg);
  font-size: 11px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.vz-place-pair { display: inline-flex; align-items: baseline; gap: 3px; }
.vz-place-name {
  font-weight: 700;
  color: var(--accent, var(--fg));
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vz-place-k { color: var(--fg-muted); font-weight: 600; }
.vz-place-v { font-weight: 600; }
.vz-place-input {
  width: 46px;
  font: 600 12px/1 inherit;
  color: var(--fg);
  background: var(--bg-input, var(--bg-elev));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 1px 3px;
  text-align: right;
  -moz-appearance: textfield;
  /* The readout panel is pointer-events:none (so its empty area never blocks
     orbiting), but the inputs MUST be clickable/typeable — re-enable here. */
  pointer-events: auto;
}
.vz-place-input::-webkit-outer-spin-button,
.vz-place-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.vz-place-input:focus { outline: none; border-color: var(--accent); }
.vz-place-unit { color: var(--fg-muted); font-size: 10px; }
.vz-bed-wrap { position: relative; display: inline-flex; }
.vz-bed-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 94%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-2);
}
.vz-bed-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.vz-bed-axis {
  width: 12px;
  text-align: center;
  font-weight: 700;
  font-size: 11px;
  flex: 0 0 auto;
}
.vz-bed-input {
  width: 64px;
  max-width: 64px;
  height: 24px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.vz-bed-input:focus {
  outline: none;
  border-color: var(--accent, var(--fg-muted));
}
/* --- overflow ("more") menu --- */
.vz-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 190px;
  max-height: min(60vh, 360px);
  overflow-y: auto;
  padding: 5px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-2);
}
/* Portaled to <body>: fixed to the viewport (JS supplies top/left) so it floats
   above every panel instead of being clipped/stacked under the one below. */
.vz-menu--portal {
  position: fixed;
  top: 0;
  left: 0;
  right: auto;
  z-index: 2147483000;
}
.vz-menu-group {
  padding: 5px 8px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.vz-menu-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.vz-menu-item:hover { background: color-mix(in srgb, var(--accent, var(--fg)) 14%, transparent); }
.vz-menu-item--on {
  /* Selected/on: bright ACCENT text on a subtle accent tint — readable in both
     themes. (Was the near-black on-solid-accent text over a dark translucent
     tint, so text almost matched the background — unreadable.) */
  border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-weight: 600;
}
.vz-menu-glyph {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  font-size: 14px;
  line-height: 1;
}
.vz-menu-glyph svg { display: block; }
/* A numeric row inside the menu (e.g. auto-stock thickness): keep the label
   flexible and pin a compact right-aligned number field + unit. cursor:default
   so it doesn't read as a toggle button. */
.vz-menu-num { cursor: default; }
.vz-menu-num .vz-menu-label { flex: 1 1 auto; }
.vz-menu-input {
  width: 56px;
  flex: 0 0 auto;
  height: 24px;
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--bg, var(--bg-elev));
  color: var(--fg);
  font: 600 12px/1 inherit;
  text-align: right;
  font-variant-numeric: tabular-nums;
  -moz-appearance: textfield;
}
.vz-menu-input::-webkit-outer-spin-button,
.vz-menu-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.vz-menu-input:focus { outline: none; border-color: var(--accent); }
.vz-menu-unit { flex: 0 0 auto; color: var(--fg-muted); font-size: 10px; }
.vz-legend-cone svg { display: block; }
.vz-menu-label { flex: 1 1 auto; min-width: 0; }
/* --- layers tree (hosted inside the ⋯ overflow menu → Display section) --- */
/* The per-section list scrolls on its own so a program with many sections never
   makes the menu unwieldy; the model/bed rows + other menu controls stay put. */
.vz-menu-layers {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: min(34vh, 200px);
  overflow-y: auto;
}
.vz-layer-group {
  padding: 5px 6px 2px;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--fg-muted);
}
.vz-layer-empty {
  padding: 3px 8px 5px 28px;
  font-size: 11px;
  color: var(--fg-muted);
}
.vz-layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--fg);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.vz-layer-row:hover { background: color-mix(in srgb, var(--accent, var(--fg)) 14%, transparent); }
.vz-layer-row--child { padding-left: 20px; }
.vz-layer-row--off { color: var(--fg-muted); opacity: 0.7; }
.vz-layer-eye {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
}
.vz-layer-swatch {
  flex: 0 0 auto;
  width: 11px;
  height: 11px;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--fg) 30%, transparent);
}
.vz-layer-row--off .vz-layer-swatch { opacity: 0.45; }
.vz-layer-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* --- tool-cone legend (bottom-right) --- */
.vz-legend {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
  pointer-events: none;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  box-shadow: var(--shadow-1);
  color: var(--fg);
  font-size: 10px;
  line-height: 1.3;
}
.vz-legend-row { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
.vz-legend-cone { font-size: 12px; line-height: 1; }
.vz-dims {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 2;
  pointer-events: auto;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  box-shadow: var(--shadow-1);
  color: var(--fg);
  font-size: 11px;
  line-height: 1.3;
  max-width: min(60%, 240px);
}
.vz-dims[data-empty='true'] {
  color: var(--fg-muted);
  font-size: 13px;
  padding: 4px 8px;
}
.vz-dims-row { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.vz-dims-size { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
.vz-dims-x { color: var(--fg-muted); font-weight: 400; }
.vz-dims-unit { color: var(--fg-muted); font-size: 10px; font-weight: 400; }
.vz-dims-meta { color: var(--fg-muted); font-size: 10px; }
.vz-dims-fit { font-size: 10px; align-items: center; }
.vz-dims-fit[data-fit='ok'] { color: var(--fg-muted); }
.vz-dims-fit[data-fit='warn'] { color: var(--warn); font-weight: 600; }
.vz-dims-fit[data-fit='danger'] { color: var(--danger); font-weight: 600; }
.vz-dims-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  display: inline-block;
}
.vz-dims-dot[data-fit='ok'] { background: var(--ok); }
.vz-dims-dot[data-fit='warn'] { background: var(--warn); }
.vz-dims-dot[data-fit='danger'] { background: var(--danger); }

/* V10 — live DRO/state HUD (top-left, under the axis triad). */
.vz-hud {
  position: absolute;
  left: 8px;
  top: 96px;
  z-index: 3;
  pointer-events: none;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 10px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 84%, transparent);
  backdrop-filter: blur(4px);
  box-shadow: var(--shadow-1);
  color: var(--fg);
  min-width: 128px;
}
.vz-hud-state {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase;
}
.vz-hud-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg-muted); flex: 0 0 auto; }
.vz-hud-state[data-state='Idle'] .vz-hud-dot { background: var(--ok); }
.vz-hud-state[data-state='Run'] .vz-hud-dot,
.vz-hud-state[data-state='Jog'] .vz-hud-dot,
.vz-hud-state[data-state='Home'] .vz-hud-dot { background: var(--accent); }
.vz-hud-state[data-state='Hold'] .vz-hud-dot,
.vz-hud-state[data-state='Door'] .vz-hud-dot { background: var(--warn); }
.vz-hud-state[data-state='Alarm'] .vz-hud-dot { background: var(--danger); }
.vz-hud-dro { display: flex; flex-direction: column; gap: 2px; }
.vz-hud-axis { display: flex; align-items: baseline; gap: 6px; font-variant-numeric: tabular-nums; }
.vz-hud-axislbl { width: 12px; color: var(--accent); font-weight: 700; font-size: 11px; }
.vz-hud-axisval { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
.vz-hud-meta {
  display: flex; gap: 10px; font-size: 10px; color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

/* V14 — tool-change timeline strip (between the viewport and the transport). */
.vz-tooltl {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 10px 6px;
  background: var(--bg);
}
.vz-tooltl-lbl { font-size: 10px; color: var(--fg-muted); text-transform: uppercase; letter-spacing: 0.4px; flex: 0 0 auto; }
.vz-tooltl-track {
  position: relative; flex: 1 1 auto; height: 10px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--fg) 12%, transparent);
}
.vz-tooltl-fill {
  position: absolute; left: 0; top: 0; bottom: 0;
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 38%, transparent);
}
.vz-tooltl-mark {
  position: absolute; top: 50%; transform: translate(-50%, -50%);
  display: inline-flex; flex-direction: column; align-items: center; gap: 1px;
  padding: 0; border: none; background: none; cursor: pointer; line-height: 1;
}
.vz-tooltl-pin {
  width: 3px; height: 16px; border-radius: 2px;
  background: var(--accent);
  box-shadow: 0 0 0 1px var(--bg);
}
.vz-tooltl-num {
  font-size: 9px; font-weight: 700; color: var(--accent);
  background: var(--bg); border-radius: 3px; padding: 0 2px;
}
.vz-tooltl-mark:hover .vz-tooltl-pin { background: var(--fg); }

@media (pointer: coarse), (max-width: 768px) {
  .vz-hud { top: 88px; min-width: 116px; padding: 8px 11px; }
  .vz-hud-axisval { font-size: 15px; }
  .vz-tooltl-pin { height: 18px; width: 4px; }
  .vz-tooltl-mark { min-width: 16px; }
  .vz-toolbar { gap: 8px; }
  .vz-tbgroup { gap: 3px; padding: 4px; }
  .vz-toolbar-btn { width: 36px; height: 36px; font-size: 18px; }
  .vz-layer-row { min-height: 40px; font-size: 13px; }
  .vz-layer-group { font-size: 11px; }
  .vz-layer-empty { font-size: 12px; }
  .vz-menu-item { min-height: 40px; font-size: 13px; }
  .vz-menu-glyph { font-size: 16px; }
  .vz-menu-input { height: 34px; font-size: 14px; width: 64px; }
  .vz-legend { font-size: 11px; padding: 7px 11px; }
  .vz-bed-field { gap: 8px; font-size: 13px; }
  .vz-bed-axis { width: 14px; font-size: 13px; }
  .vz-bed-input { height: 36px; font-size: 14px; }
  .vz-dims { font-size: 12px; padding: 8px 11px; gap: 3px; }
  .vz-dims-size { font-size: 16px; }
  .vz-dims-meta, .vz-dims-fit, .vz-dims-unit, .vz-dims-x { font-size: 11px; }
  .vz-place { font-size: 12px; padding: 6px 10px; gap: 12px; }
  .vz-place-unit { font-size: 11px; }
}

/* V6 — lightweight 2D / SVG render mode. */
.vz-svgwrap {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.vz-svg { width: 100%; height: 100%; display: block; }
.vz-svg-badge {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 84%, transparent);
  backdrop-filter: blur(4px);
  color: var(--fg-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.3px;
  text-transform: uppercase;
  pointer-events: none;
}
.vz-svg-suggest {
  position: absolute;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: calc(100% - 24px);
  padding: 7px 8px 7px 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-2);
  color: var(--fg);
  font-size: 12px;
  line-height: 1.3;
}
.vz-svg-suggest-go {
  flex: 0 0 auto;
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  border: none;
  background: var(--accent);
  color: var(--accent-fg);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.vz-svg-suggest-go:hover { filter: brightness(1.08); }
.vz-svg-suggest-x {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  border: 1px solid transparent;
  background: transparent;
  color: var(--fg-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.vz-svg-suggest-x:hover { background: color-mix(in srgb, var(--fg) 12%, transparent); color: var(--fg); }

/* L10 — laser power heat-map legend (top-centre, clear of toolbar/layers). */
.vz-powerlegend {
  position: absolute;
  top: 8px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 5px 9px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 84%, transparent);
  backdrop-filter: blur(4px);
  box-shadow: var(--shadow-1);
  color: var(--fg);
  pointer-events: none;
  user-select: none;
}
.vz-powerlegend-title {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.4px;
  text-transform: uppercase;
  color: var(--fg-muted);
  text-align: center;
}
.vz-powerlegend-bar {
  width: 132px;
  height: 9px;
  border-radius: 3px;
  border: 1px solid color-mix(in srgb, var(--fg) 22%, transparent);
}
.vz-powerlegend-scale {
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
@media (pointer: coarse), (max-width: 768px) {
  .vz-svg-suggest { font-size: 13px; }
  .vz-powerlegend-bar { width: 110px; height: 11px; }
}
`
