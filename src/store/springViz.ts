import { create } from 'zustand'

/**
 * Spring-visualization channel: a tiny shared store the SpringCoilingPanel writes
 * to and the 3D Viewer's <SpringScene> reads. The shared PROGRAM is the 2-axis
 * rotary+linear coiler program, which is NOT a 3D path — so this store is the
 * side-channel that tells the scene "the active program IS a spring, and here are
 * its real dimensions (wire ⌀, coil ⌀, pitch, free length, turns)". From those
 * dimensions the scene draws the WOUND COIL (the workpiece on the mandrel), the
 * spinning chuck, and the carriage that slides along the single linear axis.
 *
 * The panel sets `active=true` + the current params whenever it owns/regenerates
 * the program, and clears it (`active=false`) on unmount or while streaming (so
 * the Viewer shows the generic streamed toolpath instead). The Viewer gates on
 * `active` so the spring-specialized scene never bleeds over a non-spring program.
 *
 * Pure data model — no React/DOM/three imports. Not persisted (it is live,
 * panel-driven UI state, meaningless without the matching mounted panel).
 */

/** The spring dimensions the 3D scene annotates (mirrors the resolved core facts). */
export interface SpringVizParams {
  /** Wire diameter (mm). */
  wireDiameter: number
  /** Mean coil diameter D (mm) — the helix diameter (radius = D/2). */
  coilDiameter: number
  /** Effective body pitch: axial advance per body revolution (mm). */
  pitch: number
  /** Free length: total axial advance over every turn (mm), along +X. */
  freeLength: number
  /** Total turns (close-start + body + close-end). */
  totalTurns: number
  /**
   * Winding direction (chuck rotation sign). Drives which side of the shaft the
   * wire-feed nozzle sits on in the 3D scene: a right-hand ('cw') coil feeds over
   * the TOP of the mandrel, a left-hand ('ccw') coil feeds under the BOTTOM.
   */
  direction: 'cw' | 'ccw'
}

interface SpringVizState {
  /** Whether the active program is the spring preview (gates the scene). */
  active: boolean
  /** Current spring dimensions, or null when inactive. */
  params: SpringVizParams | null
  /** Publish: the spring preview is active with these dimensions. */
  set: (params: SpringVizParams) => void
  /** Clear: no spring preview active (panel unmounted / switched output). */
  clear: () => void
}

export const useSpringViz = create<SpringVizState>((set) => ({
  active: false,
  params: null,
  set: (params) => set({ active: true, params }),
  clear: () => set({ active: false, params: null }),
}))
