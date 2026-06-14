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

interface SolderVizState {
  /** Whether a soldering preview is active (gates the scene). */
  active: boolean
  /** All solder points, in current order. */
  points: SolderVizPoint[]
  /** Index of the selected/highlighted point, or -1 for none. */
  selected: number
  /** True when the points came from a drill file (render holes vs surface pads). */
  fromDrill: boolean
  /** Publish the current point list (+ source kind). Preserves the selection. */
  set: (points: SolderVizPoint[], fromDrill: boolean) => void
  /** Highlight one point (or -1 to clear the highlight). */
  select: (index: number) => void
  /** Clear everything (panel unmounted). */
  clear: () => void
}

export const useSolderViz = create<SolderVizState>((set) => ({
  active: false,
  points: [],
  selected: -1,
  fromDrill: false,
  set: (points, fromDrill) => set({ active: true, points, fromDrill }),
  select: (index) => set({ selected: index }),
  clear: () => set({ active: false, points: [], selected: -1, fromDrill: false }),
}))
