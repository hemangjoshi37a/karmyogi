import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { GrblSetting } from '../serial/settings'
import { useMachine } from './machine'

// Parsed GRBL `$`-settings captured from the `$$` dump. The controller feeds
// `$N=val` lines into here; the Motion/Settings panel (W11) renders + edits them.

/**
 * Watchdog timeout for a `$$` read. The controller sets `loading` true when it
 * sends `$$` and only clears it on the terminating `ok`. If that `ok` never
 * arrives (an error mid-dump, a disconnect, or a controller that wedges), the
 * flag would stay true forever and permanently disable the Sync button. This
 * timeout is the backstop: if a read hasn't completed within this window, clear
 * `loading` so Sync is usable again. Generous enough to cover a slow `$$` dump.
 */
const READ_TIMEOUT_MS = 15000

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

// A single shared watchdog timer for the in-progress read (module scope so it
// survives re-renders and can be cancelled from any action).
let readTimer: ReturnType<typeof setTimeout> | null = null
function clearReadTimer() {
  if (readTimer !== null) {
    clearTimeout(readTimer)
    readTimer = null
  }
}

export const useGrblSettings = create<GrblSettingsStore>()(
  persist(
    (set) => ({
      values: {},
      loading: false,
      lastReadAt: null,
      setOne: (s) => set((st) => ({ values: { ...st.values, [s.number]: s } })),
      setLoading: (loading) => {
        clearReadTimer()
        if (loading) {
          // Arm the watchdog: if the read never completes (error/disconnect/wedge),
          // clear `loading` so Sync can never get permanently stuck.
          readTimer = setTimeout(() => {
            readTimer = null
            // Only clear if we're still loading (a normal completion already cleared it).
            if (useGrblSettings.getState().loading) set({ loading: false })
          }, READ_TIMEOUT_MS)
        }
        set({ loading })
      },
      markRead: () => {
        clearReadTimer()
        set({ loading: false, lastReadAt: Date.now() })
      },
      clear: () => {
        clearReadTimer()
        set({ values: {}, lastReadAt: null, loading: false })
      },
    }),
    {
      name: 'karmyogi.grblSettings',
      // Persist the last-known values so the table shows them after a refresh
      // (before a reconnect/sync). `loading` is always transient.
      partialize: (s) => ({ values: s.values, lastReadAt: s.lastReadAt }),
    },
  ),
)

// Stuck-Sync backstop #2 (independent of the timeout above): the moment the
// machine link drops, abandon any in-progress `$$` read. The controller resets
// machine state on disconnect but does NOT touch this store, so a disconnect
// mid-dump would otherwise leave `loading` stuck true forever. Subscribing here
// (rather than in the panel) means it works even if the Motion panel isn't
// mounted. We intentionally do NOT edit controller.ts — the reset is driven from
// the store side per the workstream's ownership boundary.
let prevConnection = useMachine.getState().connection
useMachine.subscribe((state) => {
  const conn = state.connection
  if (conn !== prevConnection) {
    prevConnection = conn
    if (conn === 'disconnected' && useGrblSettings.getState().loading) {
      clearReadTimer()
      useGrblSettings.setState({ loading: false })
    }
  }
})
