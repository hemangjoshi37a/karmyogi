import { create } from 'zustand'

// NOTE: Phase-0 stub. Workstream W5 (program panel + streaming) owns and expands
// this slice: load .nc, streaming progress, feed-from-line, pause/abort.

interface ProgramStore {
  name: string | null
  lines: string[]
  /** Index of the line currently being sent, or -1 when idle. */
  cursor: number
  /** True while the program is actively streaming to the controller. */
  streaming: boolean
  setProgram: (name: string, gcode: string) => void
  setCursor: (i: number) => void
  setStreaming: (s: boolean) => void
  clear: () => void
}

export const useProgram = create<ProgramStore>((set) => ({
  name: null,
  lines: [],
  cursor: -1,
  streaming: false,
  setProgram: (name, gcode) =>
    set({ name, lines: gcode.split(/\r?\n/), cursor: -1, streaming: false }),
  setCursor: (cursor) => set({ cursor }),
  setStreaming: (streaming) => set({ streaming }),
  clear: () => set({ name: null, lines: [], cursor: -1, streaming: false }),
}))
