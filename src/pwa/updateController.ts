// Shared, UI-agnostic bridge to the live service-worker update machinery.
//
// PwaManager (mounted once at the app root) owns the actual
// `ServiceWorkerRegistration` and the `updateServiceWorker` function returned by
// `useRegisterSW`. It pushes both into this module so other parts of the UI —
// notably the About modal's "Check for update" control — can trigger a real,
// version-based update check without re-registering anything or duplicating the
// onNeedRefresh/download/reload flow.

import { RUNNING_VERSION, fetchBuildInfo } from './buildInfo'

let registration: ServiceWorkerRegistration | null = null
let updater: ((reload?: boolean) => Promise<void>) | null = null

/** Called by PwaManager once the SW registers. */
export function setRegistration(reg: ServiceWorkerRegistration | undefined): void {
  registration = reg ?? null
}

/** Called by PwaManager with the `updateServiceWorker` fn from useRegisterSW. */
export function setUpdater(fn: (reload?: boolean) => Promise<void>): void {
  updater = fn
}

export type UpdateCheckResult = 'checking' | 'available' | 'latest' | 'unsupported'

/**
 * Ask the server whether a newer build exists.
 *
 *  • 'unsupported' — no SW support / dev build (nothing to update against).
 *  • 'available'   — the server's deployed version differs from this running
 *                    bundle. We've already nudged the SW to re-check; when its
 *                    new worker installs, PwaManager's onNeedRefresh() drives the
 *                    measured download + reload automatically.
 *  • 'latest'      — we're already on the freshest deployed build.
 *
 * Never throws — any failure resolves to a sane state.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  // Dev builds have no service worker and no build-info.json to compare against.
  if (import.meta.env.DEV || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
    return 'unsupported'
  }

  try {
    // Nudge the SW to re-fetch its manifest from the server. If a new worker is
    // found this eventually fires onNeedRefresh() in PwaManager.
    await registration?.update().catch(() => {})

    const info = await fetchBuildInfo()
    if (info && info.version !== RUNNING_VERSION) {
      return 'available'
    }
    return 'latest'
  } catch {
    return 'latest'
  }
}

/** Whether an updater fn has been wired up (mostly for diagnostics). */
export function hasUpdater(): boolean {
  return !!updater
}
