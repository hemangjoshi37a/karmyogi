import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Viewer, type ViewerHandle } from '../viewer/Viewer'
import { gcodeToPolylines, type Segment } from '../viewer/gcodeToPolylines'
import { reemitSafe, inferEmitOptions } from '../core/toolpathEdit'
import { useProgram, useMachine, useCameraCalib, usePersistentState, useSettings } from '../store'
import { useBed } from '../store/bed'
import { useCarveJobs, type CarveJob } from '../store/carveJobs'
import { buildTimeline } from '../core/simulation'
import { usePlayback } from '../store/playback'
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

  const [showStock, setShowStock] = useState(true)
  // Independent show/hide for the two spindle cones (actual machine vs simulation).
  const [showActualTool, setShowActualTool] = useState(true)
  const [showSimTool, setShowSimTool] = useState(true)
  // Material-removal simulation: progressively carve the stock surface as the
  // toolpath reveals. On by default so the operator sees stock → finished part.
  const [carveSim, setCarveSim] = useState(true)
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

  // --- Layers / legend overlay (upper-left) ---------------------------------
  // Collapsed by default so it never clutters the viewport. Each toggle drives
  // the corresponding three.js object's visibility via the props below, and all
  // state is persisted (same usePersistentState pattern used across the app).
  const [legendOpen, setLegendOpen] = usePersistentState(
    'karmyogi.viewer.legendOpen',
    false,
  )
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
        {/* Toolbar: PRIMARY buttons stay always-visible and the row wraps
            (flex-wrap + capped max-width) so it can never overlap the scene on a
            phone; SECONDARY actions (add-shape + display toggles + camera) live
            in an overflow "⋯" menu so ~18 controls never collide. Each glyph is
            unique across the always-visible set (front-view ▭ vs add-rect — the
            latter is now labeled in the menu; fit ⤢ vs scale ⤡). */}
        <div className="vz-toolbar">
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
            onClick={() => ref.current?.setView('iso')}
            title={t('vz.iso', 'Isometric view')}
            aria-label={t('vz.iso', 'Isometric view')}
          >
            {IconIso}
          </button>
          {/* Top/front view buttons removed — the orientation cube (upper-right)
              now covers all named views (faces/edges/corners). */}
          <span className="vz-toolbar-sep" aria-hidden="true" />
          <BedSizeControl />
          {/* Overflow menu for the secondary controls. */}
          <OverflowMenu
            t={t}
            onAddShape={onAddShape}
            showDimensions={showDimensions}
            setShowDimensions={setShowDimensions}
            showStock={showStock}
            setShowStock={setShowStock}
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
            camOverlay={camOverlay}
            toggleCamOverlay={toggleCamOverlay}
          />
          <span className="vz-toolbar-sep" aria-hidden="true" />
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
        </div>
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
        />
        <LegendPanel
          t={t}
          open={legendOpen}
          setOpen={setLegendOpen}
          showAllToolpaths={showAllToolpaths}
          setShowAllToolpaths={setShowAllToolpaths}
          sections={legendSections}
          hiddenSections={hiddenSections}
          onToggleSection={toggleSection}
          showModel={showModel}
          setShowModel={setShowModel}
          showBed={showBed}
          setShowBed={setShowBed}
          shifted={gizmoOn && !!placement}
        />
        {gizmoOn && placement && (
          <PlacementReadout
            placement={placement}
            name={selectedSection?.name}
            sectionId={selectedSectionId ?? ''}
            t={t}
          />
        )}
        {!springActive && <DimensionsOverlay dims={dims} bedW={bedW} bedD={bedD} />}
        <ToolConeLegend
          showActualTool={showActualTool}
          showSimTool={showSimTool}
          t={t}
        />
      </div>
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
  showDimensions,
  setShowDimensions,
  showStock,
  setShowStock,
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
  camOverlay,
  toggleCamOverlay,
}: {
  t: TFn
  onAddShape: (kind: ShapeKind) => void
  showDimensions: boolean
  setShowDimensions: Toggle
  showStock: boolean
  setShowStock: Toggle
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

  return (
    <div className="vz-bed-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className={open ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'}
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
            IconStock,
            t('vz.showStock', 'Show stock'),
            () => setShowStock((s) => !s),
            showStock,
          )}
          {item(
            IconCarve,
            t('vz.carveSim', 'Material removal simulation'),
            () => setCarveSim((s) => !s),
            carveSim,
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
 * Collapsible LAYERS / legend overlay (upper-left). Collapsed by default it is
 * just a small layers button, so it never clutters the viewport; expanding
 * reveals a tree of eye/eye-off show-hide toggles for the toolpaths (an "All"
 * master plus one row per program section, each with its colour swatch), the
 * model / drawing preview, and the machine bed. Each toggle drives the matching
 * three.js object's `.visible` through props passed to the Viewer.
 *
 * Sits opposite the toolbar (top-LEFT vs the toolbar's top-RIGHT) so it never
 * overlaps the lasso/pick tools or the ⋯ menu; when the placement readout is
 * showing (also top-left) it shifts down (`shifted`) so the two never collide.
 */
function LegendPanel({
  t,
  open,
  setOpen,
  showAllToolpaths,
  setShowAllToolpaths,
  sections,
  hiddenSections,
  onToggleSection,
  showModel,
  setShowModel,
  showBed,
  setShowBed,
  shifted,
}: {
  t: TFn
  open: boolean
  setOpen: (updater: (v: boolean) => boolean) => void
  showAllToolpaths: boolean
  setShowAllToolpaths: Toggle
  sections: LegendSection[]
  hiddenSections: Record<string, boolean>
  onToggleSection: (id: string) => void
  showModel: boolean
  setShowModel: Toggle
  showBed: boolean
  setShowBed: Toggle
  shifted: boolean
}) {
  const eyeRow = (
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
    <div
      className={'vz-layers' + (shifted ? ' vz-layers--shifted' : '')}
      role="group"
      aria-label={t('vz.layers.aria', 'Layers')}
    >
      <button
        type="button"
        className={
          open ? 'vz-toolbar-btn vz-layers-btn vz-toolbar-btn--on' : 'vz-toolbar-btn vz-layers-btn'
        }
        onClick={() => setOpen((o) => !o)}
        title={t('vz.layers.title', 'Layers — show / hide toolpaths, model, bed')}
        aria-label={t('vz.layers.title', 'Layers')}
        aria-expanded={open}
      >
        <span className="vz-layers-glyph" aria-hidden="true">
          {open ? (
            <VIcon size={14}>
              <path d="M6 9l6 6 6-6" />
            </VIcon>
          ) : (
            <VIcon size={14}>
              <path d="M12 5v14M5 12h14" />
            </VIcon>
          )}
        </span>
        <span className="vz-layers-btn-label">{t('vz.layers.label', 'Layers')}</span>
      </button>
      {open && (
        <div className="vz-layers-tree">
          <div className="vz-layer-group">{t('vz.layers.toolpaths', 'Toolpaths')}</div>
          {eyeRow(
            showAllToolpaths,
            t('vz.layers.allToolpaths', 'All toolpaths'),
            () => setShowAllToolpaths((v) => !v),
          )}
          {sections.length === 0 && (
            <div className="vz-layer-empty">{t('vz.layers.none', 'No toolpaths loaded')}</div>
          )}
          {sections.map((s) =>
            eyeRow(
              showAllToolpaths && hiddenSections[s.id] !== true,
              s.name,
              () => onToggleSection(s.id),
              { indent: true, swatch: s.color, key: s.id },
            ),
          )}
          <div className="vz-layer-group">{t('vz.layers.scene', 'Scene')}</div>
          {eyeRow(showModel, t('vz.layers.model', 'Model / drawing'), () =>
            setShowModel((v) => !v),
          )}
          {eyeRow(showBed, t('vz.layers.bed', 'Machine bed'), () =>
            setShowBed((v) => !v),
          )}
        </div>
      )}
    </div>
  )
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

/** Compact bottom-left overlay reporting program size + bed-fit status. */
function DimensionsOverlay({
  dims,
  bedW,
  bedD,
}: {
  dims: Dims | null
  bedW: number
  bedD: number
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
  align-items: center;
  gap: 3px;
  /* Cap the width so the row WRAPS instead of overlapping the scene; leave a
     left gutter so it never collides with the placement readout (top-left). */
  max-width: calc(100% - 16px);
  pointer-events: auto;
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
.vz-toolbar-btn[aria-expanded='true'],
.vz-toolbar-btn--on {
  /* Active toggle: bright accent on a subtle tint (readable in both themes). */
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent);
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
.vz-layers-glyph { display: inline-flex; align-items: center; justify-content: center; }
.vz-legend-cone svg { display: block; }
.vz-menu-label { flex: 1 1 auto; min-width: 0; }
/* --- layers / legend overlay (top-left, collapsible) --- */
.vz-layers {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 4;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  /* Cap so the tree wraps/scrolls instead of covering the scene on a phone. */
  max-width: min(70%, 230px);
  pointer-events: auto;
}
/* When the placement readout occupies the top-left, drop below it. */
.vz-layers--shifted { top: 44px; }
.vz-layers-btn {
  width: auto;
  min-width: 28px;
  gap: 5px;
  padding: 0 9px;
}
.vz-layers-glyph { font-size: 13px; line-height: 1; }
.vz-layers-btn-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.3px;
}
.vz-layers-tree {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: max-content;
  max-width: 100%;
  max-height: min(60vh, 360px);
  overflow-y: auto;
  padding: 5px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 88%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: var(--shadow-2);
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

@media (pointer: coarse), (max-width: 768px) {
  .vz-toolbar { gap: 6px; }
  .vz-toolbar-btn { width: 36px; height: 36px; font-size: 18px; }
  .vz-layers-btn { width: auto; }
  .vz-layers--shifted { top: 52px; }
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
`
