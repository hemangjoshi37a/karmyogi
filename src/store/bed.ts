import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Machine work-area (bed) size in mm. Shared by the 3D viewer (grid + bounds
 * box) and the bed-fit check so the drawn bed and the inside/outside flag stay
 * in lockstep. Persisted to localStorage so the user's bed size survives reloads.
 *
 * Coordinate model: the grid is drawn CENTERED on the work origin, so the usable
 * area is [-W/2..+W/2] x [-D/2..+D/2] x [0..H]. The fit-check in VisualizerPanel
 * uses the same centered rectangle.
 */

const KEY = 'karmyogi.bed'

// Sane envelope for a hobby desktop GRBL machine (mm). Keeps the inputs and
// the persisted value from going to nonsense (0, negative, absurdly large).
const MIN = 1
const MAX = 5000

const clampDim = (v: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : fallback

/** Which machine axes physically MOVE THE BED (vs. moving the head). On a
 *  moving-bed machine, jogging these axes shifts the bed under a head-mounted
 *  camera while the frame/structure stays put — used to segment the bed by motion. */
export interface BedMotionAxes {
  x: boolean
  y: boolean
  z: boolean
}

interface BedState {
  /** Work area width — X axis (mm). */
  width: number
  /** Work area depth — Y axis (mm). */
  depth: number
  /** Work area height — Z axis (mm). */
  height: number
  /** Axes that move the bed (default: Y — typical bed-slinger). */
  motionAxes: BedMotionAxes
  setWidth: (w: number) => void
  setDepth: (d: number) => void
  setHeight: (h: number) => void
  setSize: (size: { width?: number; depth?: number; height?: number }) => void
  setMotionAxis: (axis: keyof BedMotionAxes, on: boolean) => void
}

export const useBed = create<BedState>()(
  persist(
    (set, get) => ({
      width: 300,
      depth: 200,
      height: 100,
      motionAxes: { x: false, y: true, z: false },
      setWidth: (w) => set({ width: clampDim(w, get().width) }),
      setDepth: (d) => set({ depth: clampDim(d, get().depth) }),
      setHeight: (h) => set({ height: clampDim(h, get().height) }),
      setSize: ({ width, depth, height }) =>
        set((s) => ({
          width: width === undefined ? s.width : clampDim(width, s.width),
          depth: depth === undefined ? s.depth : clampDim(depth, s.depth),
          height: height === undefined ? s.height : clampDim(height, s.height),
        })),
      setMotionAxis: (axis, on) => set((s) => ({ motionAxes: { ...s.motionAxes, [axis]: on } })),
    }),
    {
      name: KEY,
      partialize: (s) => ({ width: s.width, depth: s.depth, height: s.height, motionAxes: s.motionAxes }),
    },
  ),
)
