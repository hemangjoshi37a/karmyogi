// dev-logs (@hemangjoshi37a/dev-logs) embed.
//
// dev-logs is a standalone server (`npx @hemangjoshi37a/dev-logs`, default
// http://localhost:4445) that serves an injectable `overlay.js`. The documented
// embed API is to load that one script — it then renders the floating purple bug
// button (toggle with Ctrl+D) and POSTs submissions to `<origin>/api/requests`.
//
// IMPORTANT — how the overlay finds its backend: at execution time it reads
// `document.currentScript.src` and uses that URL's ORIGIN as the API base. If it
// can't read `currentScript` (e.g. the <script> was injected with `async`, which
// nulls `document.currentScript`), it falls back to a hardcoded dev default —
// historically `http://localhost:4445` / `http://localhost:3334`. In a deployed
// build that produced an `ERR_CONNECTION_REFUSED` console error. We therefore:
//   1. NEVER inject anything when `VITE_DEVLOGS_ENDPOINT` is blank/unset — the
//      overlay simply doesn't exist (clean no-op, no localhost fetch, no error).
//   2. When an endpoint IS set, inject the script NON-async so the overlay's
//      `document.currentScript` resolves to our tag and its origin points at the
//      configured backend (never the localhost default).
//
// The configured endpoint should be the dev-logs backend ORIGIN (e.g. the
// deployed Cloudflare Worker at https://karmyogi-devlogs.<acct>.workers.dev, or a
// locally-run `http://localhost:4445`). We load `<endpoint>/overlay.js` from it.
//
// User attribution: the overlay has no documented hook for custom fields, so we
// publish the signed-in user + active tab on `window.__karmyogiContext`. The
// overlay already captures page context; this global is the additional
// attribution surface our Firestore tracking also covers.

import { firebaseConfigured } from '../auth/firebase'

let installed = false

declare global {
  interface Window {
    __karmyogiContext?: Record<string, unknown>
  }
}

/**
 * Resolve the configured dev-logs backend origin, or `null` when nothing is
 * configured. We deliberately do NOT fall back to any localhost default: a blank
 * endpoint must be a clean no-op in every environment (dev, preview, prod), so
 * there is never a stray fetch to localhost:4445 / :3334 and never a console
 * `ERR_CONNECTION_REFUSED`.
 */
function resolveEndpoint(): string | null {
  const configured = (import.meta.env.VITE_DEVLOGS_ENDPOINT ?? '').trim()
  if (!configured) return null
  return configured.replace(/\/+$/, '')
}

/**
 * Inject the dev-logs overlay once. Returns true if the script was injected.
 * No-throw: any failure (missing endpoint, server down, blocked) degrades to
 * nothing and never breaks the host app.
 */
export function initDevLogs(): boolean {
  if (installed || typeof document === 'undefined') return false
  const endpoint = resolveEndpoint()
  if (!endpoint) return false // no endpoint configured → stay hidden, no fetch
  installed = true
  try {
    const s = document.createElement('script')
    s.src = `${endpoint}/overlay.js`
    // NOT async: the overlay reads `document.currentScript.src` to derive its API
    // origin. An async script nulls `currentScript`, which makes the overlay fall
    // back to its hardcoded localhost default. Loading it synchronously (deferred
    // via `defer`) keeps `currentScript` valid AND avoids blocking parse.
    s.defer = true
    // If the backend isn't reachable, the script load fails silently — the rest
    // of the app is unaffected (the floating button just won't appear).
    s.onerror = () => {
      /* backend unreachable — ignore */
    }
    document.head.appendChild(s)
    return true
  } catch {
    return false
  }
}

/**
 * Publish the current user + active tab to a global the overlay (and any
 * context-aware integration) can read, so problem reports are attributable.
 */
export function setDevLogsContext(ctx: {
  uid?: string | null
  email?: string | null
  tab?: string | null
}): void {
  if (typeof window === 'undefined') return
  window.__karmyogiContext = {
    ...(ctx.uid ? { uid: ctx.uid } : {}),
    ...(ctx.email ? { email: ctx.email } : {}),
    ...(ctx.tab ? { tab: ctx.tab } : {}),
    firebaseConfigured: firebaseConfigured(),
  }
}
