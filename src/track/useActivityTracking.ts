import { useEffect } from 'react'
import { useAuth } from '../auth/authStore'
import { useProgram } from '../store'
import { flush, getActiveTab, getSessionId, setTrackingUser, track } from './activity'

/**
 * Installs ALL activity tracking centrally — mounted ONCE near the app root. It
 * captures clicks, file uploads, errors, program generation, session lifecycle
 * and (via the shell calling `setActiveTab`) per-tab dwell time, all through
 * GLOBAL listeners so no feature panel needs instrumentation.
 *
 * Everything no-ops when Firebase is unconfigured or no user is signed in (the
 * `track()` calls short-circuit), so the unconfigured live app is unaffected.
 */
export function useActivityTracking(): void {
  const status = useAuth((s) => s.status)
  const uid = useAuth((s) => s.user?.uid ?? null)
  const email = useAuth((s) => s.user?.email ?? null)
  const displayName = useAuth((s) => s.user?.displayName ?? null)
  const photoURL = useAuth((s) => s.user?.photoURL ?? null)

  // Bind/unbind the Firestore writer to the current signed-in user.
  useEffect(() => {
    // Treat 'disabled' (unconfigured) as no user → tracking stays a no-op.
    setTrackingUser(
      status === 'signedIn' ? uid : null,
      status === 'signedIn' ? { email, displayName, photoURL } : undefined,
    )
    if (status === 'signedIn') {
      track('session_start', {
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        userAgent: navigator.userAgent.slice(0, 200),
        language: navigator.language,
        sessionId: getSessionId(),
      })
    }
  }, [status, uid, email, displayName, photoURL])

  // Global DOM + window listeners (installed once; track() self-gates).
  useEffect(() => {
    // --- Element-level UI clicks: WHICH control did the user activate? ----
    // A single delegated listener resolves a stable, meaningful identifier for
    // the activated control so the product team / an analyst can later aggregate
    // "most-used controls" by (label + tab). track() coalesces identical
    // consecutive clicks (same label+kind+tab) into a single counted entry, so a
    // heavy clicker still costs only the normal ~few batched writes/min.
    //
    // NOTE: we never capture input VALUES / field contents (privacy). Typing in
    // free-text inputs and scrolls are ignored as noise.
    const onClick = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target || typeof target.closest !== 'function') return

      // Find the nearest actionable control; fall back to the raw target.
      const el =
        target.closest(
          'button,a,[role="button"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="switch"],[role="option"],[data-track],summary,select,input,label',
        ) ?? target

      const kind = elementKind(el)
      // Ignore noise: clicks that land in free-text fields are about typing, not
      // activating a control. Buttons/checkboxes/etc. are still meaningful.
      if (kind === 'text-input') return

      track('ui_click', {
        id: controlId(el),
        kind,
        tab: getActiveTab() ?? 'none',
      })
    }

    // --- File uploads: metadata only (never contents) --------------------
    const onChange = (e: Event) => {
      const input = e.target as HTMLInputElement | null
      if (!input || input.tagName !== 'INPUT' || input.type !== 'file') return
      const files = Array.from(input.files ?? [])
      for (const f of files) {
        track('file_upload', {
          filename: f.name.slice(0, 160),
          size: f.size,
          mime: f.type || 'unknown',
          accept: (input.getAttribute('accept') ?? '').slice(0, 120),
        })
      }
    }

    // --- Errors ----------------------------------------------------------
    const onError = (e: ErrorEvent) => {
      track('error', {
        message: String(e.message).slice(0, 300),
        source: `${e.filename ?? ''}:${e.lineno ?? 0}:${e.colno ?? 0}`.slice(0, 200),
        stack: (e.error?.stack ? String(e.error.stack) : '').slice(0, 600),
      })
    }
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason
      track('unhandled_rejection', {
        message: (r instanceof Error ? r.message : String(r)).slice(0, 300),
        stack: (r instanceof Error && r.stack ? r.stack : '').slice(0, 600),
      })
    }

    // --- Page visibility -------------------------------------------------
    const onVisibility = () => {
      track('visibility', { state: document.visibilityState })
    }

    document.addEventListener('click', onClick, { capture: true })
    document.addEventListener('change', onChange, { capture: true })
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('click', onClick, { capture: true })
      document.removeEventListener('change', onChange, { capture: true })
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  // --- Program generation: subscribe to the program store --------------
  // Logs whenever the combined program changes (a tab generated/edited G-code),
  // capturing the section names + total line count (no G-code body).
  useEffect(() => {
    let prevSig = ''
    const unsub = useProgram.subscribe((s) => {
      const sig = s.sections.map((sec) => `${sec.name}:${sec.rawLines.length}`).join('|')
      if (sig === prevSig) return
      prevSig = sig
      if (s.sections.length === 0) return
      track('program_generated', {
        sections: s.sections.map((sec) => sec.name).slice(0, 20),
        sectionCount: s.sections.length,
        lineCount: s.lines.length,
      })
    })
    return unsub
  }, [])

  // Final flush on unmount (e.g. sign-out / app teardown).
  useEffect(() => () => void flush(), [])
}

/** Max length for a stored control label/id — keep entries small for the batch. */
const LABEL_MAX = 60

/**
 * Classify an element into a coarse, aggregation-friendly "kind". `text-input`
 * is special-cased so the click listener can ignore typing-into-a-field noise.
 */
function elementKind(el: Element): string {
  const tag = el.tagName.toLowerCase()
  const role = el.getAttribute('role')
  if (role === 'tab') return 'tab'
  if (tag === 'select' || role === 'option' || role === 'listbox') return 'select'
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
    if (type === 'checkbox' || role === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'range') return 'slider'
    if (type === 'button' || type === 'submit' || type === 'reset') return 'button'
    if (type === 'color') return 'color'
    if (type === 'file') return 'file'
    // text, search, number, password, email, url, tel, textarea-like → free-text
    return 'text-input'
  }
  if (tag === 'textarea') return 'text-input'
  if (role === 'checkbox' || role === 'switch') return 'checkbox'
  if (tag === 'button' || role === 'button') return 'button'
  if (tag === 'a') return 'link'
  if (tag === 'summary') return 'disclosure'
  if (role === 'menuitem') return 'menuitem'
  return role ?? tag
}

/**
 * Resolve a STABLE, MEANINGFUL identifier for a control, preferring (in order):
 *   1. explicit `data-track` attribute (intentional, hand-picked id)
 *   2. `aria-label`
 *   3. visible button/title text (textContent or `title`)
 *   4. `name` / `id` attribute
 *   5. ARIA `role`
 *   6. a short CSS-path fallback (tag + first class, up the tree)
 * Never includes input values / field contents. Truncated to LABEL_MAX.
 */
function controlId(el: Element): string {
  const dataTrack = el.getAttribute('data-track')
  if (dataTrack) return clip(dataTrack)

  const aria = el.getAttribute('aria-label')
  if (aria) return clip(aria)

  const title = el.getAttribute('title')
  if (title) return clip(title)

  // Visible text — but NOT for free-text fields (we never read their value, and
  // textContent there is empty anyway). Skip absurdly long text (likely a region).
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
  if (text && text.length <= 120) return clip(text)

  const name = el.getAttribute('name') ?? el.id
  if (name) return clip(name)

  const role = el.getAttribute('role')
  if (role) return clip(role)

  return clip(cssPath(el))
}

function clip(s: string): string {
  return s.slice(0, LABEL_MAX)
}

/** A short, reasonably-stable CSS-ish path: tag(+first class) up to 4 levels. */
function cssPath(el: Element): string {
  const parts: string[] = []
  let cur: Element | null = el
  let depth = 0
  while (cur && depth < 4) {
    let part = cur.tagName.toLowerCase()
    if (cur.id) {
      part += `#${cur.id}`
      parts.unshift(part)
      break
    }
    const cls = (cur.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean)[0]
    if (cls) part += `.${cls}`
    parts.unshift(part)
    cur = cur.parentElement
    depth++
  }
  return parts.join('>')
}
