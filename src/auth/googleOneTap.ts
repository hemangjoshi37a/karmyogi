// Google Identity Services (GIS) — One Tap / FedCM helper.
//
// This is the PRIMARY, popup-free sign-in surface: when the visitor is already
// signed into a Google account, Google renders an inline "Continue as …" card
// (mediated by FedCM — no popup, no third-party cookies, no page leave). The
// returned ID token is exchanged for a Firebase session by the caller.
//
// When One Tap CANNOT be shown (no Google session, FedCM unsupported, user
// dismissed it, or cooldown), the caller falls back to a full-page redirect.
// Everything here is best-effort and never throws into the UI.

/** The subset of the GIS `google.accounts.id` API we use. */
interface GsiPromptNotification {
  isNotDisplayed: () => boolean
  isSkippedMoment: () => boolean
  isDismissedMoment: () => boolean
  getNotDisplayedReason: () => string
  getSkippedReason: () => string
  getDismissedReason: () => string
}
interface GsiCredentialResponse {
  credential: string
  select_by?: string
}
interface GsiIdApi {
  initialize: (cfg: {
    client_id: string
    callback: (resp: GsiCredentialResponse) => void
    auto_select?: boolean
    cancel_on_tap_outside?: boolean
    use_fedcm_for_prompt?: boolean
    context?: 'signin' | 'signup' | 'use'
    itp_support?: boolean
  }) => void
  prompt: (listener?: (n: GsiPromptNotification) => void) => void
  cancel: () => void
  disableAutoSelect: () => void
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GsiIdApi } }
  }
}

const GSI_SRC = 'https://accounts.google.com/gsi/client'
let gsiPromise: Promise<GsiIdApi | null> | null = null

/** Inject the GIS client script once; resolve with the `id` API (or null on failure). */
export function loadGsi(): Promise<GsiIdApi | null> {
  if (gsiPromise) return gsiPromise
  gsiPromise = new Promise<GsiIdApi | null>((resolve) => {
    if (typeof document === 'undefined') return resolve(null)
    const ready = () => resolve(window.google?.accounts?.id ?? null)
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    if (existing) {
      if (window.google?.accounts?.id) return ready()
      existing.addEventListener('load', ready, { once: true })
      existing.addEventListener('error', () => resolve(null), { once: true })
      return
    }
    const s = document.createElement('script')
    s.src = GSI_SRC
    s.async = true
    s.defer = true
    s.addEventListener('load', ready, { once: true })
    s.addEventListener('error', () => resolve(null), { once: true })
    document.head.appendChild(s)
  })
  return gsiPromise
}

let initializedFor: string | null = null

/**
 * Show the One Tap / FedCM prompt. Loads GIS, initializes it for `clientId`
 * (once), and prompts. `onCredential` receives the Google ID token. `onUnavailable`
 * fires when One Tap could not be displayed (so the caller can reveal the
 * full-page-redirect fallback). Returns a cancel function.
 */
export async function showOneTap(opts: {
  clientId: string
  onCredential: (idToken: string) => void
  onUnavailable?: (reason: string) => void
}): Promise<() => void> {
  const api = await loadGsi()
  if (!api) {
    opts.onUnavailable?.('gsi-load-failed')
    return () => {}
  }
  if (initializedFor !== opts.clientId) {
    api.initialize({
      client_id: opts.clientId,
      callback: (resp) => {
        if (resp?.credential) opts.onCredential(resp.credential)
      },
      auto_select: false,
      cancel_on_tap_outside: false,
      use_fedcm_for_prompt: true,
      context: 'signin',
      itp_support: true,
    })
    initializedFor = opts.clientId
  }
  api.prompt((n) => {
    if (n.isNotDisplayed()) opts.onUnavailable?.(n.getNotDisplayedReason() || 'not-displayed')
    else if (n.isSkippedMoment()) opts.onUnavailable?.(n.getSkippedReason() || 'skipped')
  })
  return () => {
    try {
      api.cancel()
    } catch {
      /* ignore */
    }
  }
}

/** Stop auto-selecting on sign-out so the next visit re-prompts cleanly. */
export function disableOneTapAutoSelect(): void {
  try {
    window.google?.accounts?.id?.disableAutoSelect()
  } catch {
    /* ignore */
  }
}
