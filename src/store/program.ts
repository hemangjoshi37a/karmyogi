import { create } from 'zustand'
import {
  applyPlacement,
  IDENTITY_PLACEMENT,
  isIdentity,
  type Placement,
} from '../core/transform'

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

export type { Placement }

/** One named program section (the output of a single source/tab). */
export interface ProgramSection {
  /** Stable unique id (for React keys + delete). */
  id: string
  /** Section name (== the `setProgram` name; the tab's source identifier). */
  name: string
  /** The raw, untransformed G-code lines for this section. */
  rawLines: string[]
}

interface ProgramStore {
  /** Summary label of the program (section names joined, or null when empty). */
  name: string | null
  /** Per-source sections, in insertion order. */
  sections: ProgramSection[]
  /** The placed (baked) combined program — displayed, simulated, and streamed. */
  lines: string[]
  /** The raw, untransformed combined program. `lines` = rawLines + placement. */
  rawLines: string[]
  /** Current placement applied to `rawLines` to produce `lines`. */
  placement: Placement
  /** Index of the line currently being sent, or -1 when idle. */
  cursor: number
  /** True while the program is actively streaming to the controller. */
  streaming: boolean
  /** Upsert a section keyed by `name` (replace its body, or append if new). */
  setProgram: (name: string, gcode: string) => void
  /**
   * Replace the ENTIRE program with a single edited section (used by the
   * combined-text editor). Collapses all sections into one named `name`.
   */
  setCombined: (name: string, gcode: string) => void
  /** Remove a single section by id and recompute the combined program. */
  removeSection: (id: string) => void
  /** Merge a partial placement and re-bake `lines`. */
  setPlacement: (p: Partial<Placement>) => void
  /** Reset placement to identity (`lines` reverts to `rawLines`). */
  resetPlacement: () => void
  setCursor: (i: number) => void
  setStreaming: (s: boolean) => void
  clear: () => void
}

/** Bake a placement into raw lines, returning the placed `lines` array. */
function bake(rawLines: string[], placement: Placement): string[] {
  if (isIdentity(placement)) return rawLines
  return applyPlacement(rawLines.join('\n'), placement).split(/\r?\n/)
}

/** Separator comment emitted before each section in the combined program. */
function sectionSeparator(name: string): string {
  // Strip parens from the name so the comment stays well-formed G-code.
  const safe = name.replace(/[()]/g, '')
  return `(— ${safe} —)`
}

/** Concatenate all sections into a single combined rawLines array. */
function combineSections(sections: ProgramSection[]): string[] {
  const out: string[] = []
  for (const s of sections) {
    out.push(sectionSeparator(s.name))
    for (const l of s.rawLines) out.push(l)
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

/** Recompute the derived combined fields from a section list + placement. */
function deriveFrom(sections: ProgramSection[], placement: Placement) {
  const rawLines = combineSections(sections)
  return {
    sections,
    name: summaryName(sections),
    rawLines,
    lines: bake(rawLines, placement),
  }
}

export const useProgram = create<ProgramStore>((set, get) => ({
  name: null,
  sections: [],
  lines: [],
  rawLines: [],
  placement: { ...IDENTITY_PLACEMENT },
  cursor: -1,
  streaming: false,
  setProgram: (name, gcode) => {
    const { sections, placement } = get()
    const idx = sections.findIndex((s) => s.name === name)
    const unchanged = lastGcodeByName.get(name) === gcode

    // Two true no-op cases (early-return BEFORE any state change so streaming,
    // cursor and lines are untouched and no re-render is triggered):
    //  1. The name was user-dismissed and the tab is re-pushing the SAME gcode
    //     → don't resurrect the deleted section.
    //  2. The section still exists and the gcode is identical → nothing to do
    //     (avoids needless re-renders / stream resets during streaming).
    if (unchanged && (dismissedNames.has(name) || idx >= 0)) return

    // Genuine push (new name, or gcode changed): record it + un-dismiss so a
    // real edit in a previously-deleted tab brings the section back.
    lastGcodeByName.set(name, gcode)
    dismissedNames.delete(name)

    const rawLines = gcode.split(/\r?\n/)
    let next: ProgramSection[]
    if (idx >= 0) {
      // Replace this named section's body in place (keep its id + position).
      next = sections.slice()
      next[idx] = { ...next[idx], rawLines }
    } else {
      // New source → append a section.
      next = [...sections, { id: nextSectionId(), name, rawLines }]
    }
    set({
      ...deriveFrom(next, placement),
      cursor: -1,
      streaming: false,
    })
  },
  setCombined: (name, gcode) => {
    const { placement } = get()
    const rawLines = gcode.split(/\r?\n/)
    const next: ProgramSection[] = [{ id: nextSectionId(), name, rawLines }]
    set({
      ...deriveFrom(next, placement),
      cursor: -1,
      streaming: false,
    })
  },
  removeSection: (id) => {
    const { sections, placement } = get()
    const removed = sections.find((s) => s.id === id)
    const next = sections.filter((s) => s.id !== id)
    if (next.length === sections.length) return
    // Mark the section's name as user-dismissed so the owning tab's next
    // (identical) re-push can't resurrect it. `lastGcodeByName` is retained so
    // the dismiss check has the content to compare against; a genuinely
    // changed push later will clear the dismissal.
    if (removed) dismissedNames.add(removed.name)
    set({
      ...deriveFrom(next, placement),
      cursor: -1,
      streaming: false,
    })
  },
  setPlacement: (p) => {
    const { rawLines, placement } = get()
    const next = { ...placement, ...p }
    set({ placement: next, lines: bake(rawLines, next) })
  },
  resetPlacement: () => {
    const { rawLines } = get()
    set({ placement: { ...IDENTITY_PLACEMENT }, lines: rawLines })
  },
  setCursor: (cursor) => set({ cursor }),
  setStreaming: (streaming) => set({ streaming }),
  clear: () => {
    // Reset the dismissed-section + last-gcode tracking alongside the store so
    // a fresh program starts with a clean slate (no stale dismissals).
    dismissedNames.clear()
    lastGcodeByName.clear()
    set({
      name: null,
      sections: [],
      lines: [],
      rawLines: [],
      placement: { ...IDENTITY_PLACEMENT },
      cursor: -1,
      streaming: false,
    })
  },
}))
