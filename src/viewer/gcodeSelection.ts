import { create } from 'zustand'

/**
 * V13 — G-code editor ⇄ 3D link.
 *
 * A tiny shared channel holding the currently-selected COMBINED-program line
 * (1-based, matching the Program panel's editor line numbers and the `line`
 * field stamped on each parsed {@link Segment}). The Program panel's editor and
 * the 3D Visualizer both read/write it:
 *   • click a line in the editor  → highlights the matching move(s) in 3D
 *   • click a move in 3D          → selects (and scrolls to) the editor line
 *
 * Kept as its own minimal store (no React/DOM) so the two independent dockview
 * panels can sync without a parent. Mirrors the `useHover` store pattern.
 */
interface GcodeSelectionStore {
  /** Selected 1-based combined-program line, or null when nothing is selected. */
  selectedLine: number | null
  /** Set (or clear) the selected line. */
  setSelectedLine: (line: number | null) => void
}

export const useGcodeSelection = create<GcodeSelectionStore>((set) => ({
  selectedLine: null,
  setSelectedLine: (line) => set({ selectedLine: line }),
}))
