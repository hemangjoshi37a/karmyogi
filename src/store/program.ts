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

export type { Placement }

interface ProgramStore {
  name: string | null
  /** The placed (baked) program — what gets displayed, simulated, and streamed. */
  lines: string[]
  /** The raw, untransformed program as loaded. `lines` = rawLines + placement. */
  rawLines: string[]
  /** Current placement applied to `rawLines` to produce `lines`. */
  placement: Placement
  /** Index of the line currently being sent, or -1 when idle. */
  cursor: number
  /** True while the program is actively streaming to the controller. */
  streaming: boolean
  setProgram: (name: string, gcode: string) => void
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

export const useProgram = create<ProgramStore>((set, get) => ({
  name: null,
  lines: [],
  rawLines: [],
  placement: { ...IDENTITY_PLACEMENT },
  cursor: -1,
  streaming: false,
  setProgram: (name, gcode) => {
    const rawLines = gcode.split(/\r?\n/)
    set({
      name,
      rawLines,
      lines: rawLines, // fresh load resets placement → lines === rawLines
      placement: { ...IDENTITY_PLACEMENT },
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
  clear: () =>
    set({
      name: null,
      lines: [],
      rawLines: [],
      placement: { ...IDENTITY_PLACEMENT },
      cursor: -1,
      streaming: false,
    }),
}))
