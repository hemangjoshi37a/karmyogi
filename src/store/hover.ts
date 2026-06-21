import { create } from 'zustand'

/**
 * Tiny, ephemeral cross-panel HOVER link for the carving workflow.
 *
 * `hoveredOpId` is the id of the operation the user is currently hovering in
 * EITHER the carving Operations list (`.cc-oprow` in CadCamPanel) OR the
 * Program-tab per-operation rows (`.pp-op` in ProgramPanel). The 3D Visualizer
 * reads it to SHIMMER that operation's toolpath, and each panel highlights the
 * matching row — so the user can see which line in the viewer corresponds to
 * which operation, from both directions.
 *
 * KEY LINKAGE: a carving `FeatureOp.id` flows unchanged into the emitted
 * `ProgramOperation.id` (CadCamPanel: `ComposedOperation.opId === FeatureOp.id`)
 * and then into the viewer's per-op id (VisualizerPanel `sectionData`). So a
 * single id matches the carving row, the Program-tab row, AND the viewer line.
 *
 * Kept OUT of the program store on purpose: hover is transient view state, not
 * undoable program content — it must never be captured by the history snapshot
 * or trigger a program re-bake.
 */
interface HoverStore {
  /** Id of the operation currently hovered, or null. */
  hoveredOpId: string | null
  /** Set the hovered op (pass null to clear). No-op if unchanged. */
  setHoveredOp: (id: string | null) => void
}

export const useHover = create<HoverStore>((set, get) => ({
  hoveredOpId: null,
  setHoveredOp: (id) => {
    if (get().hoveredOpId === id) return
    set({ hoveredOpId: id })
  },
}))
