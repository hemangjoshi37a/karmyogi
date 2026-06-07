// Tiny presentation helpers for the admin console (no deps).

/** Relative "time ago" string (e.g. "3m ago"), or "—" when null. */
export function timeAgo(ms: number | null, now = Date.now()): string {
  if (ms == null) return '—'
  const d = Math.max(0, now - ms)
  const s = Math.round(d / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.round(h / 24)
  return `${days}d ago`
}

/** Absolute local date-time, or "—" when null. */
export function dateTime(ms: number | null): string {
  if (ms == null) return '—'
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return '—'
  }
}

/** Compact duration from seconds (e.g. "1h 4m", "45s"). */
export function dur(seconds: number): string {
  if (!seconds || seconds < 1) return '0s'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s}s`
  return `${s}s`
}

/** First non-empty of name / email / short uid. */
export function userLabel(u: {
  displayName: string | null
  email: string | null
  uid: string
}): string {
  return u.displayName || u.email || u.uid.slice(0, 8)
}
