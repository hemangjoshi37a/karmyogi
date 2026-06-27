import { create } from 'zustand'

/**
 * Soldering-visualization channel: the SolderingPanel writes to it and the 3D
 * Viewer's <SolderScene> reads it. Two jobs:
 *   1. Publish the full solder-point list (+ whether they came from a DRILL file)
 *      so the Viewer can draw a lightweight 3D PCB stand-in — a board slab sized
 *      to the points, with a copper PAD (or a drilled HOLE) at every point — so
 *      the operator can see where each point sits on the real board.
 *   2. Track the SELECTED point so the Viewer can park a highlight cone above it
 *      (clicking a table row shows that point's location in 3D space).
 *
 * Pure data (no React/DOM/three). Not persisted — it's live, panel-driven UI
 * state, meaningless without the mounted Soldering panel.
 */

/** One point for the 3D stand-in (machine mm; matches a SolderPoint's fields). */
export interface SolderVizPoint {
  x: number
  y: number
  /** Raised (travel) height — where the highlight cone sits above the pad. */
  freeZ: number
  /** Touch-down height where the iron meets the pad. */
  touchZ: number
}

/**
 * A camera-DETECTED candidate pad, mapped to bed-mm (Z comes from the Z-datum,
 * so only XY + a radius are carried). The Viewer draws these as faint ＋ ring
 * markers the operator can review before adding them as real solder points.
 */
export interface DetectedPadViz {
  /** Bed X (mm). */
  x: number
  /** Bed Y (mm). */
  y: number
  /** Pad radius (mm) for sizing the marker; 0 if unknown. */
  rMm: number
}

interface SolderVizState {
  /** Whether a soldering preview is active (gates the scene). */
  active: boolean
  /** All solder points, in current order. */
  points: SolderVizPoint[]
  /** Index of the PINNED highlighted point (set on row CLICK), or -1 for none. */
  selected: number
  /** Index of the point under the cursor (row HOVER), or -1. Transient; takes
   * visual precedence over `selected`, so hovering a row previews that point and
   * the pinned `selected` stays put when the hover ends. */
  hovered: number
  /**
   * Index of the point the machine is CURRENTLY executing (the sim playhead /
   * live stream is at/near it), or -1 for none. Distinct from `selected`: the
   * Viewer SHIMMERS this one (animated, reduced-motion-aware) while keeping the
   * static click-selected highlight separate. Driven by the Viewer from the
   * live/sim tool position, so the SolderingPanel doesn't need to track it.
   */
  activeIndex: number
  /** True when the points came from a drill file (render holes vs surface pads). */
  fromDrill: boolean
  /**
   * Whether to render the FR-4 / copper BOARD slab in the scene. Gates ONLY the
   * board geometry — the solder PADS/points (and their highlights) always render,
   * so turning this off reveals the pads sitting in free space. A live DISPLAY
   * preference (default ON), so `clear()` leaves it untouched.
   */
  showPcb: boolean
  /** Camera-detected candidate pads (bed-mm), shown as reviewable ＋ markers. */
  detected: DetectedPadViz[]
  /** Publish the current point list (+ source kind). Preserves the selection. */
  set: (points: SolderVizPoint[], fromDrill: boolean) => void
  /** PIN the highlight on one point (or -1 to clear). Set on row CLICK. */
  select: (index: number) => void
  /** Preview-highlight a point on row HOVER (or -1 to clear the hover). */
  setHovered: (index: number) => void
  /** Set the currently-executing (shimmering) point index (or -1 to clear). */
  setActiveIndex: (index: number) => void
  /** Toggle/set whether the board slab renders (updater mirrors a React setState). */
  setShowPcb: (updater: (v: boolean) => boolean) => void
  /** Publish (or clear) the camera-detected candidate pads. */
  setDetected: (pads: DetectedPadViz[]) => void
  /** Clear everything (panel unmounted). */
  clear: () => void
}

export const useSolderViz = create<SolderVizState>((set) => ({
  active: false,
  points: [],
  selected: -1,
  hovered: -1,
  activeIndex: -1,
  fromDrill: false,
  showPcb: true,
  detected: [],
  set: (points, fromDrill) => set({ active: true, points, fromDrill }),
  select: (index) => set({ selected: index }),
  setHovered: (index) =>
    // Cheap no-op when unchanged — hover fires rapidly across rows.
    set((s) => (s.hovered === index ? s : { hovered: index })),
  setActiveIndex: (index) =>
    // Avoid a needless re-render when the active point hasn't changed (this is
    // driven from a 60fps playhead effect, so cheap-no-op matters).
    set((s) => (s.activeIndex === index ? s : { activeIndex: index })),
  setDetected: (detected) => set({ detected }),
  // Board visibility is a display preference, not point data — keep it across a
  // panel unmount (clear() does not touch it).
  setShowPcb: (updater) => set((s) => ({ showPcb: updater(s.showPcb) })),
  clear: () =>
    set({ active: false, points: [], selected: -1, hovered: -1, activeIndex: -1, fromDrill: false, detected: [] }),
}))
