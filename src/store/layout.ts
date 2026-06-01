import { create } from 'zustand'
import type { SerializedDockview } from 'dockview'

const STORAGE_KEY = 'karmyogi.layout.v3'

interface LayoutState {
  saved: SerializedDockview | null
  save: (layout: SerializedDockview) => void
  load: () => SerializedDockview | null
  reset: () => void
}

function readStorage(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SerializedDockview) : null
  } catch {
    return null
  }
}

export const useLayout = create<LayoutState>((set) => ({
  saved: readStorage(),
  save: (layout) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(layout))
    } catch {
      /* ignore quota errors */
    }
    set({ saved: layout })
  },
  load: () => readStorage(),
  reset: () => {
    localStorage.removeItem(STORAGE_KEY)
    set({ saved: null })
  },
}))
