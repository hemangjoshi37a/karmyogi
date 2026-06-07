/**
 * Free-explore grace period before the login wall.
 *
 * A first-time visitor may use the WHOLE app without signing in for the first
 * GRACE_DAYS days, counted from their first visit (stored in localStorage).
 * After that the Google sign-in screen becomes required.
 *
 * Pure module — no React/DOM framework imports — and safe when localStorage is
 * unavailable (private mode / SSR): it degrades to "first seen = now" without
 * persisting, so the grace period simply restarts rather than throwing.
 */
export const GRACE_DAYS = 5
export const FIRST_SEEN_KEY = 'karmyogi.firstSeenAt'

const DAY_MS = 86_400_000

/**
 * The timestamp (ms epoch) of the visitor's first load. Reads the stored value;
 * if absent, records `Date.now()` and returns it. If storage is unavailable,
 * returns `Date.now()` without persisting.
 */
export function getFirstSeenAt(): number {
  const now = Date.now()
  try {
    if (typeof localStorage === 'undefined') return now
    const raw = localStorage.getItem(FIRST_SEEN_KEY)
    if (raw != null) {
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) return n
    }
    localStorage.setItem(FIRST_SEEN_KEY, String(now))
    return now
  } catch {
    return now
  }
}

/** Whole days of grace remaining, rounded up, clamped to [0, GRACE_DAYS]. */
export function graceDaysLeft(): number {
  const elapsed = (Date.now() - getFirstSeenAt()) / DAY_MS
  const left = Math.ceil(GRACE_DAYS - elapsed)
  return Math.min(GRACE_DAYS, Math.max(0, left))
}

/** True while the free-explore period is still active. */
export function graceActive(): boolean {
  return graceDaysLeft() > 0
}
