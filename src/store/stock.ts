import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { StockDims, XYOrigin, ZRef } from '../core/stock'

/**
 * Stock = the raw workpiece block (NOT the machine bed — see store/bed.ts).
 * Holds the user's block dimensions, the chosen material, and where work-zero
 * sits on the block (XY origin + Z reference face). Persisted to localStorage
 * so the workpiece setup survives reloads.
 *
 * Coordinate model matches the 3D viewer and core/stock.ts: work zero at the
 * origin, Z-up. See stockBounds() for the resulting box extents.
 */

const KEY = 'karmyogi.stock'

// Sane envelope for a hobby desktop GRBL workpiece (mm). Keeps the inputs and
// the persisted value from going to nonsense (0, negative, absurdly large).
const MIN = 1
const MAX = 5000

const clampDim = (v: number, fallback: number) =>
  Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : fallback

interface StockState extends StockDims {
  /** Material library id (literal default 'softwood' matches the lib's default). */
  materialId: string
  /** Where work X0/Y0 sits in the XY footprint. */
  xyOrigin: XYOrigin
  /** Whether work Z0 is the stock top or bottom face. */
  zRef: ZRef
  setWidth: (v: number) => void
  setDepth: (v: number) => void
  setHeight: (v: number) => void
  setDims: (d: Partial<StockDims>) => void
  setMaterial: (id: string) => void
  setXYOrigin: (o: XYOrigin) => void
  setZRef: (z: ZRef) => void
}

export const useStock = create<StockState>()(
  persist(
    (set, get) => ({
      width: 100,
      depth: 100,
      height: 20,
      materialId: 'softwood',
      xyOrigin: 'center',
      zRef: 'top',
      setWidth: (v) => set({ width: clampDim(v, get().width) }),
      setDepth: (v) => set({ depth: clampDim(v, get().depth) }),
      setHeight: (v) => set({ height: clampDim(v, get().height) }),
      setDims: ({ width, depth, height }) =>
        set((s) => ({
          width: width === undefined ? s.width : clampDim(width, s.width),
          depth: depth === undefined ? s.depth : clampDim(depth, s.depth),
          height: height === undefined ? s.height : clampDim(height, s.height),
        })),
      setMaterial: (id) => set({ materialId: id }),
      setXYOrigin: (o) => set({ xyOrigin: o }),
      setZRef: (z) => set({ zRef: z }),
    }),
    {
      name: KEY,
      partialize: (s) => ({
        width: s.width,
        depth: s.depth,
        height: s.height,
        materialId: s.materialId,
        xyOrigin: s.xyOrigin,
        zRef: s.zRef,
      }),
    },
  ),
)
