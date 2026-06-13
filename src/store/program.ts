import { create } from 'zustand'
import {
  applyJobPlacement,
  IDENTITY_JOB_PLACEMENT,
  isIdentityJob,
  type JobPlacement,
} from '../core/transform'
import { recordHistory, registerHistorySource } from './history'

// NOTE: Phase-0 stub. Workstream W5 (program panel + streaming) owns and expands
// this slice: load .nc, streaming progress, feed-from-line, pause/abort.
//
// Placement: the 3D "place the job" gizmo writes a Placement (XY move / Z-rotate
// / uniform scale). The INVARIANT is that the displayed toolpath, the playback
// simulation, and the streamed G-code ALL derive from `lines`. `rawLines` is the
// untransformed program; `lines` is ALWAYS the placement baked into `rawLines`
// (when the placement is identity, `lines === rawLines`). So they can never
// disagree and there is no double-transform — consumers just read `lines`.
//
// SECTIONS: `setProgram(name, gcode)` UPSERTS a section keyed by `name` — each
// feature tab (soldering, glue, pick-place, writing, CAD/CAM, AI, …) generates
// with a distinct name and keeps its OWN section. Regenerating from a tab updates
// that section in place; a new name appends a new section. The combined program
// (`rawLines`) is the concatenation of all sections in insertion order, each
// prefixed with a `(— <name> —)` separator comment, and `lines` is the placement
// baked into the combined `rawLines`. Consumers keep reading `lines`/`rawLines`
// exactly as before.

export type { JobPlacement }
// Back-compat alias: the program/visualizer "placement" is now a full-3D JobPlacement.
export type { JobPlacement as Placement }

/** One named program section (the output of a single source/tab). */
export interface ProgramSection {
  /** Stable unique id (for React keys + delete). */
  id: string
  /** Section name (== the `setProgram` name; the tab's source identifier). */
  name: string
  /** The raw, untransformed G-code lines for this section. */
  rawLines: string[]
  /**
   * Per-section placement (move / rotate / scale, all 3 axes). Each toolpath
   * carries its OWN placement so several jobs (a 2D carve, a PCB, a welding
   * path…) can be positioned independently. `lines` bakes each section with its
   * own placement; the gizmo edits the selected section only.
   */
  placement: JobPlacement
  /**
   * Optional per-section toolpath LINE colour in the 3D viewer. When unset the
   * Visualizer falls back to its automatic per-index palette. Lets the operator
   * tell different program toolpaths apart at a glance.
   */
  color?: string
}

interface ProgramStore {
  /** Summary label of the program (section names joined, or null when empty). */
  name: string | null
  /** Per-source sections, in insertion order. */
  sections: ProgramSection[]
  /** The placed (baked) combined program — displayed, simulated, and streamed. */
  lines: string[]
  /** The raw, untransformed combined program. `lines` = per-section placements baked in. */
  rawLines: string[]
  /** The section currently selected for placement editing (gizmo target), or null. */
  selectedSectionId: string | null
  /** Index of the line currently being sent, or -1 when idle. */
  cursor: number
  /** True while the program is actively streaming to the controller. */
  streaming: boolean
  /**
   * True while a feature tab is computing a toolpath in the background (e.g. the
   * 3D carve worker or a heavy model import). Drives a "Generating…" indicator in
   * the Program panel so the user knows the app is working.
   */
  generating: boolean
  /** Set the background-generation indicator. */
  setGenerating: (b: boolean) => void
  /** Upsert a section keyed by `name` (replace its body, or append if new). */
  setProgram: (name: string, gcode: string) => void
  /**
   * Replace the ENTIRE program with a single edited section (used by the
   * combined-text editor). Collapses all sections into one named `name`.
   */
  setCombined: (name: string, gcode: string) => void
  /**
   * Remove a single section and recompute the combined program.
   *
   * CONTRACT (cross-workstream): callers identify a section by its `name` —
   * feature tabs (soldering, glue, pick-place, writing, CAD/CAM, AI, …) call
   * `removeSection(name)` to drop their own section without tracking its id.
   * For backwards-compat with callers that already hold a section `id`, the
   * argument is matched against the section NAME first, then falls back to the
   * `id`, so passing either works. (Names and generated ids never collide.)
   */
  removeSection: (nameOrId: string) => void
  /** Select a section for placement editing (or null to clear). */
  selectSection: (id: string | null) => void
  /** Merge a partial placement into ONE section and re-bake `lines`. */
  setSectionPlacement: (id: string, p: Partial<JobPlacement>) => void
  /** Reset ONE section's placement to identity. */
  resetSectionPlacement: (id: string) => void
  /** Set ONE section's toolpath line colour (for the 3D viewer); '' clears it. */
  setSectionColor: (id: string, color: string) => void
  setCursor: (i: number) => void
  setStreaming: (s: boolean) => void
  clear: () => void
  /**
   * Capture an opaque snapshot of the undoable program state (sections + the
   * module-scope dismissed/last-gcode tracking). Consumed by the platform
   * history engine; the value shape is private to this store.
   */
  historySnapshot: () => ProgramHistorySnapshot
  /** Restore a snapshot produced by `historySnapshot()`. */
  historyRestore: (snap: ProgramHistorySnapshot) => void
}

/**
 * Opaque undo/redo snapshot of the program. Captures the section list plus the
 * module-scope dismissed-section / last-gcode tracking so undo restores a fully
 * coherent moment (otherwise a deleted section could re-appear, or a content
 * re-push could be wrongly ignored, right after an undo).
 */
export interface ProgramHistorySnapshot {
  sections: ProgramSection[]
  selectedSectionId: string | null
  dismissed: string[]
  lastGcode: [string, string][]
}

/** Bake a placement into raw lines, returning the placed `lines` array. */
function bake(rawLines: string[], placement: JobPlacement): string[] {
  if (isIdentityJob(placement)) return rawLines
  return applyJobPlacement(rawLines.join('\n'), placement).split(/\r?\n/)
}

/** Separator comment emitted before each section in the combined program. */
function sectionSeparator(name: string): string {
  // Strip parens from the name so the comment stays well-formed G-code.
  const safe = name.replace(/[()]/g, '')
  return `(— ${safe} —)`
}

/** Concatenate all sections' RAW lines into a single combined array. */
function combineSections(sections: ProgramSection[]): string[] {
  const out: string[] = []
  for (const s of sections) {
    out.push(sectionSeparator(s.name))
    for (const l of s.rawLines) out.push(l)
  }
  return out
}

/** Concatenate all sections, each baked with ITS OWN placement → the streamed program. */
function combineBaked(sections: ProgramSection[]): string[] {
  const out: string[] = []
  for (const s of sections) {
    out.push(sectionSeparator(s.name))
    for (const l of bake(s.rawLines, s.placement)) out.push(l)
  }
  return out
}

/** Build the summary `name` field from the section list. */
function summaryName(sections: ProgramSection[]): string | null {
  if (sections.length === 0) return null
  if (sections.length === 1) return sections[0].name
  return sections.map((s) => s.name).join(' + ')
}

let sectionSeq = 0
function nextSectionId(): string {
  sectionSeq += 1
  return `sec-${Date.now().toString(36)}-${sectionSeq}`
}

// --- Dismissed-section tracking (fixes "deleted section reappears") ---------
//
// Feature tabs stay MOUNTED in dockview and keep re-pushing their gcode via
// `setProgram(name, gcode)` on a debounce. Without this, deleting a section in
// the Program tab is instantly undone by the owning tab's next (identical)
// push. We keep this state at module scope (not in the zustand store) so that
// an IGNORED re-push is a true no-op — it never calls `set(...)`, so it can't
// trigger re-renders or reset a running stream.
//
// `dismissedNames`  — section NAMES the user explicitly deleted; a re-push of
//                     the SAME gcode for a dismissed name is ignored.
// `lastGcodeByName` — the last gcode pushed per name, RETAINED even after the
//                     section is removed, so we can tell "same content re-push"
//                     (ignore) from "genuinely changed" (re-add + un-dismiss).
const dismissedNames = new Set<string>()
const lastGcodeByName = new Map<string, string>()

/** Deep-clone a section so a captured snapshot can't be mutated by later edits. */
function cloneSection(s: ProgramSection): ProgramSection {
  return {
    id: s.id,
    name: s.name,
    rawLines: s.rawLines.slice(),
    placement: { ...s.placement },
    color: s.color,
  }
}

/** Recompute the derived combined fields from a section list (per-section placement). */
function deriveFrom(sections: ProgramSection[]) {
  return {
    sections,
    name: summaryName(sections),
    rawLines: combineSections(sections),
    lines: combineBaked(sections),
  }
}

export const useProgram = create<ProgramStore>((set, get) => ({
  name: null,
  sections: [],
  lines: [],
  rawLines: [],
  selectedSectionId: null,
  cursor: -1,
  streaming: false,
  generating: false,
  setGenerating: (generating) => set({ generating }),
  setProgram: (name, gcode) => {
    const { sections, selectedSectionId } = get()
    const idx = sections.findIndex((s) => s.name === name)

    // CLEAR-ON-EMPTY (cross-workstream contract): pushing an empty/whitespace-
    // only program for a name REMOVES that section. Feature tabs re-push on a
    // debounce; when a tab has nothing to emit it pushes '' and its section
    // disappears instead of lingering as a stale, empty card. This is a true
    // no-op when the section already doesn't exist.
    if (gcode.trim() === '') {
      if (idx < 0) {
        lastGcodeByName.delete(name)
        return
      }
      recordHistory()
      lastGcodeByName.delete(name)
      const removedId = sections[idx].id
      const next = sections.filter((s) => s.name !== name)
      set({
        ...deriveFrom(next),
        selectedSectionId: selectedSectionId === removedId ? null : selectedSectionId,
        cursor: -1,
        streaming: false,
      })
      return
    }

    const unchanged = lastGcodeByName.get(name) === gcode

    // Two true no-op cases (early-return BEFORE any state change so streaming,
    // cursor and lines are untouched and no re-render is triggered):
    //  1. The name was user-dismissed and the tab is re-pushing the SAME gcode
    //     → don't resurrect the deleted section.
    //  2. The section still exists and the gcode is identical → nothing to do
    //     (avoids needless re-renders / stream resets during streaming).
    if (unchanged && (dismissedNames.has(name) || idx >= 0)) return

    // Genuine load/edit → snapshot BEFORE mutating any tracking or sections.
    recordHistory()
    // Genuine push (new name, or gcode changed): record it + un-dismiss so a
    // real edit in a previously-deleted tab brings the section back.
    lastGcodeByName.set(name, gcode)
    dismissedNames.delete(name)

    const rawLines = gcode.split(/\r?\n/)
    let next: ProgramSection[]
    if (idx >= 0) {
      // Replace this named section's body in place (keep its id, position AND
      // its current placement — regenerating a tab must not move the job).
      next = sections.slice()
      next[idx] = { ...next[idx], rawLines }
    } else {
      // New source → append a section with an identity placement.
      next = [...sections, { id: nextSectionId(), name, rawLines, placement: { ...IDENTITY_JOB_PLACEMENT } }]
    }
    set({
      ...deriveFrom(next),
      cursor: -1,
      streaming: false,
    })
  },
  setCombined: (name, gcode) => {
    recordHistory()
    const rawLines = gcode.split(/\r?\n/)
    const next: ProgramSection[] = [
      { id: nextSectionId(), name, rawLines, placement: { ...IDENTITY_JOB_PLACEMENT } },
    ]
    set({
      ...deriveFrom(next),
      selectedSectionId: null,
      cursor: -1,
      streaming: false,
    })
  },
  removeSection: (nameOrId) => {
    const { sections, selectedSectionId } = get()
    // Match by NAME first (the documented contract), then fall back to id so
    // legacy callers that hold a section id keep working. Names and generated
    // ids never collide, so the resolution is unambiguous.
    const removed =
      sections.find((s) => s.name === nameOrId) ??
      sections.find((s) => s.id === nameOrId)
    if (!removed) return
    const next = sections.filter((s) => s.id !== removed.id)
    if (next.length === sections.length) return
    recordHistory()
    // Mark the section's name as user-dismissed so the owning tab's next
    // (identical) re-push can't resurrect it. `lastGcodeByName` is retained so
    // the dismiss check has the content to compare against; a genuinely
    // changed push later will clear the dismissal.
    dismissedNames.add(removed.name)
    set({
      ...deriveFrom(next),
      selectedSectionId: selectedSectionId === removed.id ? null : selectedSectionId,
      cursor: -1,
      streaming: false,
    })
  },
  selectSection: (id) => {
    if (id === null) {
      set({ selectedSectionId: null })
      return
    }
    // Ignore selection of a non-existent section.
    if (!get().sections.some((s) => s.id === id)) return
    set({ selectedSectionId: id })
  },
  setSectionPlacement: (id, p) => {
    const { sections } = get()
    const idx = sections.findIndex((s) => s.id === id)
    if (idx < 0) return
    recordHistory()
    const next = sections.slice()
    next[idx] = { ...next[idx], placement: { ...next[idx].placement, ...p } }
    set(deriveFrom(next))
  },
  setSectionColor: (id, color) => {
    const { sections } = get()
    const idx = sections.findIndex((s) => s.id === id)
    if (idx < 0) return
    recordHistory()
    const next = sections.slice()
    // Colour is display-only metadata — it doesn't affect rawLines/lines, so we
    // update the section array without re-baking the combined program.
    next[idx] = { ...next[idx], color: color || undefined }
    set({ sections: next })
  },
  resetSectionPlacement: (id) => {
    const { sections } = get()
    const idx = sections.findIndex((s) => s.id === id)
    if (idx < 0) return
    recordHistory()
    const next = sections.slice()
    next[idx] = { ...next[idx], placement: { ...IDENTITY_JOB_PLACEMENT } }
    set(deriveFrom(next))
  },
  setCursor: (cursor) => set({ cursor }),
  setStreaming: (streaming) => set({ streaming }),
  clear: () => {
    // Snapshot the program BEFORE wiping anything so clear is undoable.
    if (get().sections.length > 0) recordHistory()
    // Reset the dismissed-section + last-gcode tracking alongside the store so
    // a fresh program starts with a clean slate (no stale dismissals).
    dismissedNames.clear()
    lastGcodeByName.clear()
    set({
      name: null,
      sections: [],
      lines: [],
      rawLines: [],
      selectedSectionId: null,
      cursor: -1,
      streaming: false,
    })
  },
  historySnapshot: () => {
    const { sections, selectedSectionId } = get()
    return {
      sections: sections.map(cloneSection),
      selectedSectionId,
      dismissed: [...dismissedNames],
      lastGcode: [...lastGcodeByName.entries()],
    }
  },
  historyRestore: (snap) => {
    const sections = snap.sections.map(cloneSection)
    // Restore the module-scope tracking alongside the store so a deleted section
    // stays deleted (and an undone delete is un-dismissed) consistently with the
    // restored section list.
    dismissedNames.clear()
    for (const n of snap.dismissed) dismissedNames.add(n)
    lastGcodeByName.clear()
    for (const [n, g] of snap.lastGcode) lastGcodeByName.set(n, g)
    set({
      ...deriveFrom(sections),
      selectedSectionId: snap.selectedSectionId,
      // Don't carry a stale cursor/stream across an undo of program content.
      cursor: -1,
      streaming: false,
    })
  },
}))

// Register the program store as the first platform-undo source. This module is
// imported eagerly (the store is created on import), so the source is available
// before any user edit. The returned unregister is intentionally unused — the
// program store lives for the whole app session.
registerHistorySource('program', {
  snapshot: () => useProgram.getState().historySnapshot(),
  restore: (value) => useProgram.getState().historyRestore(value as ProgramHistorySnapshot),
})
