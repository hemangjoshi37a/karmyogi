import { useEffect, useRef, useState } from 'react'
import { useConsole, type ConsoleEntry } from '../store'
import { useNotifications, type NotificationLevel } from '../store/notifications'
import { IconButton } from './IconButton'

/**
 * Bridge the existing console store into the notification store. Mirrors console
 * `error` entries (→ 'error') and `info` entries (→ 'info'), de-duped by the
 * console entry id so repeated subscribe fires never double-insert. We do NOT
 * touch the serial layer — notifications are a read-only mirror of the console.
 *
 * Installed once at module scope so it captures entries even before the bell
 * UI mounts.
 */
const seen = new Set<number>()

function ingest(entries: ConsoleEntry[]) {
  const notify = useNotifications.getState().notify
  for (const e of entries) {
    if (e.dir !== 'error' && e.dir !== 'info') continue
    if (seen.has(e.id)) continue
    seen.add(e.id)
    const level: NotificationLevel = e.dir === 'error' ? 'error' : 'info'
    notify(level, e.text)
  }
}

// Seed from anything already in the console, then keep mirroring. The mirror is
// deferred to a microtask so `notify()` (a store setState) never runs during
// another component's render (which React forbids).
ingest(useConsole.getState().entries)
useConsole.subscribe((state) => queueMicrotask(() => ingest(state.entries)))

const LEVEL_GLYPH: Record<NotificationLevel, string> = {
  info: 'ℹ',
  success: '✓',
  warn: '⚠',
  error: '✕',
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const entries = useNotifications((s) => s.entries)
  const unreadCount = useNotifications((s) => s.unreadCount)
  const markAllRead = useNotifications((s) => s.markAllRead)
  const clear = useNotifications((s) => s.clear)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    setOpen((wasOpen) => {
      const next = !wasOpen
      if (next) markAllRead()
      return next
    })
  }

  return (
    <div className="notif" ref={wrapRef}>
      <IconButton
        icon={
          <>
            🔔
            {unreadCount > 0 && (
              <span className="notif-badge" aria-hidden="true">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </>
        }
        label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'}
        aria-expanded={open}
        onClick={toggle}
      />
      {open && (
        <div className="notif-popover" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <span>Notifications</span>
            <button className="notif-clear" onClick={clear} disabled={entries.length === 0}>
              Clear
            </button>
          </div>
          <div className="notif-list">
            {entries.length === 0 ? (
              <div className="notif-empty">No notifications</div>
            ) : (
              entries.map((e) => (
                <div key={e.id} className={`notif-item level-${e.level}`}>
                  <span className="notif-glyph" aria-hidden="true">
                    {LEVEL_GLYPH[e.level]}
                  </span>
                  <span className="notif-text">{e.text}</span>
                  <span className="notif-time">{formatTime(e.ts)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
