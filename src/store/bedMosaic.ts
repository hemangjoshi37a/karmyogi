import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Bed "mosaic" accumulator state (see `src/viewer/BedMosaic.tsx`).
 *
 * The mosaic is a PERSISTENT top-down image of the whole bed that the moving
 * head-camera paints into over time: as the head pans, each live patch is
 * stamped into a render-target at its real bed location, and areas currently
 * out of frame stay visible from when they were last seen.
 *
 * What persists across reloads: only the lightweight user preferences below
 * (`enabled`, `resolutionPx`, `opacity`). The accumulated pixels live in a GPU
 * render-target and are intentionally transient — a reload starts a fresh,
 * empty mosaic. localStorage key follows the app convention (`karmyogi.*`).
 */

const KEY = 'karmyogi.bedMosaic'

const clampRes = (v: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(4096, Math.max(64, Math.round(v))) : fallback

const clamp01 = (v: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback

interface BedMosaicState {
  /** Master on/off for the accumulating bed mosaic overlay. */
  enabled: boolean
  /** Render-target width in pixels (height = width × bed aspect). Default 1024. */
  resolutionPx: number
  /** Display opacity of the mosaic plane in the 3D viewer (0..1). */
  opacity: number
  /**
   * Monotonic counter bumped by `clear()`. The renderer watches this and wipes
   * the accumulation buffer when it changes (it is NOT cleared per frame).
   */
  clearSignal: number
  setEnabled: (v: boolean) => void
  toggle: () => void
  setResolution: (px: number) => void
  setOpacity: (o: number) => void
  /** Wipe the accumulated mosaic (bumps `clearSignal`). */
  clear: () => void
}

export const useBedMosaic = create<BedMosaicState>()(
  persist(
    (set, get) => ({
      enabled: false,
      resolutionPx: 1024,
      opacity: 1,
      clearSignal: 0,
      setEnabled: (v) => set({ enabled: !!v }),
      toggle: () => set({ enabled: !get().enabled }),
      setResolution: (px) => set({ resolutionPx: clampRes(px, get().resolutionPx) }),
      setOpacity: (o) => set({ opacity: clamp01(o, get().opacity) }),
      clear: () => set((s) => ({ clearSignal: s.clearSignal + 1 })),
    }),
    {
      name: KEY,
      // Only the preferences persist — the accumulated pixels are transient.
      partialize: (s) => ({ enabled: s.enabled, resolutionPx: s.resolutionPx, opacity: s.opacity }),
    },
  ),
)
