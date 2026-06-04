import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/**
 * Viewport-drawn shapes: simple 2D primitives the user drops onto the bed plane
 * (XY at Z=0) by right-clicking in the 3D viewport, then moves / resizes /
 * rotates with an inline gizmo. Persisted to localStorage so a sketch survives a
 * reload, exactly like the stock + bed stores.
 *
 * Coordinate model matches the viewer (mm, Z-up, work zero at the origin). A
 * shape stores a CENTER position (x, y in mm), a uniform-ish size (`size` = the
 * defining radius/half-extent in mm), and a Z-rotation in radians. The concrete
 * outline (polyline) is derived in core/viewportShapeGcode.ts so the store stays
 * a pure data model with no geometry/G-code logic.
 */

const KEY = 'karmyogi.viewportShapes'

export type ShapeKind = 'circle' | 'rectangle' | 'triangle' | 'line'

export interface ViewportShape {
  /** Stable unique id (React key + selection + delete). */
  id: string
  kind: ShapeKind
  /** Center position on the bed plane (mm). */
  x: number
  y: number
  /**
   * Defining size (mm). For a circle this is the radius; for a rectangle/triangle
   * it is the half-extent (so width = 2*size); for a line it is the half-length.
   */
  size: number
  /** Z-axis rotation in radians (rotation in the bed plane). */
  rot: number
}

interface ViewportShapesState {
  shapes: ViewportShape[]
  /** Id of the currently selected shape (shows the inline gizmo), or null. */
  selectedId: string | null
  /** Add a primitive centered at (x, y); returns the new shape's id. */
  addShape: (kind: ShapeKind, x: number, y: number) => string
  /** Merge a partial update into the shape with `id`. */
  updateShape: (id: string, patch: Partial<Omit<ViewportShape, 'id' | 'kind'>>) => void
  removeShape: (id: string) => void
  select: (id: string | null) => void
  clear: () => void
}

let seq = 0
function nextId(): string {
  seq += 1
  return `shp-${Date.now().toString(36)}-${seq}`
}

/** Default defining size (mm) for a freshly added shape. */
const DEFAULT_SIZE = 20
const MIN_SIZE = 0.5

export const useViewportShapes = create<ViewportShapesState>()(
  persist(
    (set) => ({
      shapes: [],
      selectedId: null,
      addShape: (kind, x, y) => {
        const id = nextId()
        const shape: ViewportShape = {
          id,
          kind,
          x: Number.isFinite(x) ? x : 0,
          y: Number.isFinite(y) ? y : 0,
          size: DEFAULT_SIZE,
          rot: 0,
        }
        set((s) => ({ shapes: [...s.shapes, shape], selectedId: id }))
        return id
      },
      updateShape: (id, patch) =>
        set((s) => ({
          shapes: s.shapes.map((sh) => {
            if (sh.id !== id) return sh
            const next = { ...sh, ...patch }
            if (patch.size !== undefined) {
              next.size = Number.isFinite(patch.size)
                ? Math.max(MIN_SIZE, patch.size)
                : sh.size
            }
            return next
          }),
        })),
      removeShape: (id) =>
        set((s) => ({
          shapes: s.shapes.filter((sh) => sh.id !== id),
          selectedId: s.selectedId === id ? null : s.selectedId,
        })),
      select: (id) => set({ selectedId: id }),
      clear: () => set({ shapes: [], selectedId: null }),
    }),
    {
      name: KEY,
      // Don't persist transient selection — only the shapes themselves.
      partialize: (s) => ({ shapes: s.shapes }),
    },
  ),
)
