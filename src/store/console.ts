import { create } from 'zustand'

export type ConsoleDir = 'send' | 'recv' | 'info' | 'error'

export interface ConsoleEntry {
  id: number
  dir: ConsoleDir
  text: string
  /** Epoch ms when the message was sent/received. */
  ts: number
}

const MAX_ENTRIES = 1000

interface ConsoleStore {
  entries: ConsoleEntry[]
  push: (dir: ConsoleDir, text: string) => void
  clear: () => void
}

let nextId = 1

export const useConsole = create<ConsoleStore>((set) => ({
  entries: [],
  push: (dir, text) =>
    set((s) => {
      const entries = [...s.entries, { id: nextId++, dir, text, ts: Date.now() }]
      if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
      return { entries }
    }),
  clear: () => set({ entries: [] }),
}))
