import { create } from 'zustand'

// Platform-wide undo/redo.
//
// This is a small, store-agnostic history engine. Any zustand store (or other
// stateful module) can opt in by REGISTERING a pair of hooks:
//
//   const unregister = registerHistorySource('program', {
//     snapshot: () => useProgram.getState().historySnapshot(),
//     restore: (snap) => useProgram.getState().historyRestore(snap),
//   })
//
// `snapshot()` returns an opaque, plain-data value describing everything that
// source wants undo/redo to cover; `restore(snap)` puts that value back. The
// engine never inspects the snapshot — sources own their own shape.
//
// To make a mutation undoable, a source calls `recordHistory()` BEFORE it
// mutates. That captures a snapshot from EVERY registered source (so undo
// restores a coherent cross-store moment), pushes it on the undo stack, and
// clears the redo stack (the usual "new edit invalidates redo" behaviour).
//
// `undo()` / `redo()` move one step: they snapshot the CURRENT state onto the
// opposite stack, then restore the popped snapshot across all sources. An
// undo/redo on an empty stack is a silent no-op (never throws).
//
// Program is the first wired consumer; presets and other stores can register
// later through the exact same entry point with no changes here.

/** Opaque per-source snapshot value. Sources define their own shape. */
export type HistorySnapshotValue = unknown

/** One registered undoable source (a store opting into platform undo/redo). */
export interface HistorySource {
  /** Capture this source's current undoable state as plain data. */
  snapshot: () => HistorySnapshotValue
  /** Restore this source from a value previously returned by `snapshot()`. */
  restore: (value: HistorySnapshotValue) => void
}

/** A captured cross-source moment: one snapshot value per registered source. */
type HistoryFrame = Map<string, HistorySnapshotValue>

/** Max retained undo (and redo) steps; oldest are dropped past this. */
const MAX_DEPTH = 100

// Registered sources live at module scope (not in the store state) so that
// registering/unregistering a source never triggers a store re-render and the
// engine can read sources synchronously from inside record/undo/redo.
const sources = new Map<string, HistorySource>()

/**
 * Register an undoable source under a stable `key`. Returns an unregister
 * function. Registering the same key again replaces the previous source.
 */
export function registerHistorySource(key: string, source: HistorySource): () => void {
  sources.set(key, source)
  return () => {
    // Only remove if it's still the same source we registered (guards against a
    // stale cleanup clobbering a newer registration of the same key).
    if (sources.get(key) === source) sources.delete(key)
  }
}

/** Capture a frame across every currently-registered source. */
function captureFrame(): HistoryFrame {
  const frame: HistoryFrame = new Map()
  for (const [key, src] of sources) frame.set(key, src.snapshot())
  return frame
}

/** Restore every source present in `frame` (sources not in the frame are left alone). */
function restoreFrame(frame: HistoryFrame): void {
  for (const [key, value] of frame) {
    const src = sources.get(key)
    if (src) src.restore(value)
  }
}

interface HistoryStore {
  /** Number of undo steps available (drives "can undo" UI). */
  undoDepth: number
  /** Number of redo steps available (drives "can redo" UI). */
  redoDepth: number
  /**
   * Capture the current cross-source state and push it on the undo stack.
   * Call this BEFORE a mutating action. Clears the redo stack. No-op when no
   * sources are registered yet.
   */
  record: () => void
  /** Undo one step (no-op on an empty undo stack). */
  undo: () => void
  /** Redo one step (no-op on an empty redo stack). */
  redo: () => void
  /** Drop all history (e.g. after a hard reset). */
  clearHistory: () => void
}

// The actual frame stacks are kept at module scope; the store only mirrors their
// depths so React consumers (toolbar buttons, etc.) can react to availability.
const undoStack: HistoryFrame[] = []
const redoStack: HistoryFrame[] = []

export const useHistory = create<HistoryStore>((set) => {
  const syncDepths = () => set({ undoDepth: undoStack.length, redoDepth: redoStack.length })

  return {
    undoDepth: 0,
    redoDepth: 0,
    record: () => {
      if (sources.size === 0) return
      undoStack.push(captureFrame())
      if (undoStack.length > MAX_DEPTH) undoStack.splice(0, undoStack.length - MAX_DEPTH)
      // A fresh edit invalidates the redo history.
      if (redoStack.length) redoStack.length = 0
      syncDepths()
    },
    undo: () => {
      const frame = undoStack.pop()
      if (!frame) return // empty stack → silent no-op
      // Save the present onto the redo stack before restoring the past.
      redoStack.push(captureFrame())
      if (redoStack.length > MAX_DEPTH) redoStack.splice(0, redoStack.length - MAX_DEPTH)
      restoreFrame(frame)
      syncDepths()
    },
    redo: () => {
      const frame = redoStack.pop()
      if (!frame) return // empty stack → silent no-op
      undoStack.push(captureFrame())
      if (undoStack.length > MAX_DEPTH) undoStack.splice(0, undoStack.length - MAX_DEPTH)
      restoreFrame(frame)
      syncDepths()
    },
    clearHistory: () => {
      undoStack.length = 0
      redoStack.length = 0
      syncDepths()
    },
  }
})

/**
 * Imperative helper for non-React callers (zustand action bodies). Captures an
 * undo frame BEFORE a mutation; equivalent to `useHistory.getState().record()`.
 */
export function recordHistory(): void {
  useHistory.getState().record()
}
