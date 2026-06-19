import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Tool-occlusion mask for the head-mounted camera (bed-mosaic exclusion).
 *
 * The camera is bolted to the spindle/head, so the soldering iron / tool sits at
 * a FIXED region of EVERY camera frame (it pans WITH the head — the bed scrolls
 * underneath, but the tool stays put in the image). When we stitch frames into a
 * clean bed mosaic we must EXCLUDE that fixed region, otherwise the tool smears
 * across the whole mosaic.
 *
 * This store holds that region as a single axis-aligned rectangle in NORMALIZED
 * frame UV [0..1] (origin top-left, +x right, +y down — matching DOM/canvas and
 * a typical sampled-texture convention). A rectangle is the simplest robust
 * shape; the tool patch is convex and a tight box is enough to keep it out of
 * the mosaic. The {@link ToolMaskEditor} component lets the operator drag/resize
 * this box over the live view; the mosaic shader reads it via {@link maskRectArray}.
 *
 * Persistence: the rect + enabled flag survive reload (one camera rig, so the
 * tool stays in the same place between sessions). localStorage key follows the
 * app convention.
 */

const KEY = 'karmyogi.toolMask'

/** Axis-aligned rectangle in normalized frame UV [0..1] (top-left origin). */
export interface MaskRect {
  /** Left edge, 0..1. */
  x: number
  /** Top edge, 0..1. */
  y: number
  /** Width, 0..1 (x + w should stay ≤ 1). */
  w: number
  /** Height, 0..1 (y + h should stay ≤ 1). */
  h: number
}

export interface ToolMaskState {
  /** Whether the mask is active (excluded from the mosaic). */
  enabled: boolean
  /** The masked region in normalized frame UV. */
  rect: MaskRect
  setEnabled: (v: boolean) => void
  /** Replace the rect (values are clamped into [0..1] and kept in-bounds). */
  setRect: (r: MaskRect) => void
  /** Restore the default center-bottom guess and disable the mask. */
  reset: () => void
}

/**
 * Sensible default: a center-bottom box. A head camera mounted above/behind the
 * tool typically sees the iron entering from the bottom-centre of the frame, so
 * this is a reasonable first guess the operator then nudges to fit.
 */
const DEFAULT_RECT: MaskRect = { x: 0.4, y: 0.55, w: 0.2, h: 0.45 }

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** Clamp a rect into [0..1] with a tiny minimum size and keep it in-bounds. */
function sanitizeRect(r: MaskRect): MaskRect {
  const MIN = 0.02
  let w = Math.min(1, Math.max(MIN, clamp01(r.w)))
  let h = Math.min(1, Math.max(MIN, clamp01(r.h)))
  const x = Math.min(1 - w, clamp01(r.x))
  const y = Math.min(1 - h, clamp01(r.y))
  return { x, y, w, h }
}

export const useToolMask = create<ToolMaskState>()(
  persist(
    (set) => ({
      enabled: false,
      rect: { ...DEFAULT_RECT },
      setEnabled: (v) => set({ enabled: v }),
      setRect: (r) => set({ rect: sanitizeRect(r) }),
      reset: () => set({ enabled: false, rect: { ...DEFAULT_RECT } }),
    }),
    {
      name: KEY,
      version: 1,
    },
  ),
)

/**
 * Mosaic-shader helper: the masked rect as a flat `[x, y, w, h]` array (all in
 * normalized frame UV [0..1]) when the mask is ENABLED, else `null`.
 *
 * Feed this straight into a shader uniform (e.g. `vec4 uToolMask`); a `null`
 * means "no mask — keep every pixel". Inside the fragment shader, a sample at uv
 * is inside the tool region (and should be discarded from the mosaic) when:
 *
 *   uv.x >= r.x && uv.x < r.x + r.z && uv.y >= r.y && uv.y < r.y + r.w
 *
 * @example
 *   const m = maskRectArray(useToolMask.getState())
 *   if (m) material.uniforms.uToolMask.value.set(...m)
 */
export function maskRectArray(s: ToolMaskState): [number, number, number, number] | null {
  if (!s.enabled) return null
  const { x, y, w, h } = s.rect
  return [x, y, w, h]
}
