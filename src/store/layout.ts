import { create } from 'zustand'
import type { SerializedDockview } from 'dockview'

const STORAGE_KEY = 'karmyogi.layout.v3'
// Registry tab ids the user has ALREADY been shown. Lets onReady tell a tab the
// user deliberately CLOSED (id in this set, absent from the layout → leave it
// closed) apart from a tab that is genuinely NEW in a newer app version (id not
// in this set → auto-open it once). Without it, every closed tab reappears on
// refresh. `null` = no record yet (pre-feature user / first run).
const SEEN_KEY = 'karmyogi.layout.seen.v1'

interface LayoutState {
  saved: SerializedDockview | null
  save: (layout: SerializedDockview) => void
  load: () => SerializedDockview | null
  reset: () => void
  /** Tab ids the user has already seen, or null if never recorded. */
  loadSeen: () => string[] | null
  /** Record the full set of currently-registered tab ids as "seen". */
  saveSeen: (ids: string[]) => void
}

function readStorage(): SerializedDockview | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as SerializedDockview) : null
  } catch {
    return null
  }
}

function readSeen(): string[] | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return raw ? (JSON.parse(raw) as string[]) : null
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
    // Forget the seen-set too, so the rebuilt default layout re-seeds it cleanly.
    localStorage.removeItem(SEEN_KEY)
    set({ saved: null })
  },
  loadSeen: () => readSeen(),
  saveSeen: (ids) => {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(ids))
    } catch {
      /* ignore quota errors */
    }
  },
}))
