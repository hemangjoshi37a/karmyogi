import { useEffect } from 'react'

/**
 * Absorbs "back" navigation so an accidental Back press can't unload the
 * karmyogi SPA mid-session.
 *
 * Why this exists: on Android, a gamepad's **B button is mapped to the system
 * BACK key**, so pressing it (or the browser/edge-swipe Back) navigates the page
 * back and the whole app disappears — very undesirable while operating a machine.
 *
 * How it works: we seed ONE sentinel history entry on mount; whenever a Back pops
 * it, we (1) dispatch a `karmyogi:back` event so an open modal/overlay can choose
 * to close on Back, then (2) re-seed the sentinel — so the user always stays in
 * the app. Renders nothing. (A user who truly wants to leave can close the tab.)
 */
export function BackGuard() {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.history) return
    const seed = () => {
      try {
        window.history.pushState({ kmBackGuard: true }, '')
      } catch {
        /* pushState can throw in sandboxed/file: contexts — best-effort */
      }
    }
    seed()
    const onPop = () => {
      // Give anything dismissible (modals, popovers, capture mode) first refusal.
      try {
        window.dispatchEvent(new Event('karmyogi:back'))
      } catch {
        /* ignore */
      }
      // Re-seed so the NEXT Back is also absorbed → the app never unloads.
      seed()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return null
}
