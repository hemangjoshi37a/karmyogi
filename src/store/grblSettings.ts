import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GrblSetting } from '../serial/settings'

// Parsed GRBL `$`-settings captured from the `$$` dump. The controller feeds
// `$N=val` lines into here; the Motion/Settings panel (W11) renders + edits them.

interface GrblSettingsStore {
  /** Setting number → parsed value. */
  values: Record<number, GrblSetting>
  /** True while a `$$` read is in progress (set by the controller). */
  loading: boolean
  /** Timestamp (ms) of the last full read, or null. */
  lastReadAt: number | null
  setOne: (s: GrblSetting) => void
  setLoading: (loading: boolean) => void
  markRead: () => void
  clear: () => void
}

export const useGrblSettings = create<GrblSettingsStore>()(
  persist(
    (set) => ({
      values: {},
      loading: false,
      lastReadAt: null,
      setOne: (s) => set((st) => ({ values: { ...st.values, [s.number]: s } })),
      setLoading: (loading) => set({ loading }),
      markRead: () => set({ loading: false, lastReadAt: Date.now() }),
      clear: () => set({ values: {}, lastReadAt: null }),
    }),
    {
      name: 'karmyogi.grblSettings',
      // Persist the last-known values so the table shows them after a refresh
      // (before a reconnect/sync). `loading` is always transient.
      partialize: (s) => ({ values: s.values, lastReadAt: s.lastReadAt }),
    },
  ),
)
