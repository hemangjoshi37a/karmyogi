import { create } from 'zustand'

export type NotificationLevel = 'info' | 'success' | 'warn' | 'error'

export interface NotificationEntry {
  id: number
  level: NotificationLevel
  text: string
  ts: number
}

const MAX_ENTRIES = 200

interface NotificationStore {
  entries: NotificationEntry[]
  /** Count of entries newer than the last `markAllRead()`. */
  unreadCount: number
  notify: (level: NotificationLevel, text: string) => void
  markAllRead: () => void
  clear: () => void
}

let nextId = 1

export const useNotifications = create<NotificationStore>((set) => ({
  entries: [],
  unreadCount: 0,
  notify: (level, text) =>
    set((s) => {
      const entries = [{ id: nextId++, level, text, ts: Date.now() }, ...s.entries]
      if (entries.length > MAX_ENTRIES) entries.length = MAX_ENTRIES
      return { entries, unreadCount: s.unreadCount + 1 }
    }),
  markAllRead: () => set({ unreadCount: 0 }),
  clear: () => set({ entries: [], unreadCount: 0 }),
}))
