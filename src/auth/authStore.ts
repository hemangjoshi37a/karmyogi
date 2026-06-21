import { create } from 'zustand'
import { firebaseConfigured, getFirebaseAuth, maybeStartAnalytics } from './firebase'
import { initAdsTag, reportLogin } from '../track/adsConversion'

/**
 * Auth state for the (optional) Google sign-in gate.
 *
 * Graceful degradation: when Firebase is NOT configured, `status` is permanently
 * `'disabled'` — the AuthGate treats that as fully-open access and renders the
 * app exactly as today. The gate + sign-in UI only appear once real config is
 * present (status flips between 'loading' → 'signedOut' / 'signedIn').
 */

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'disabled'

/** Minimal, serializable view of the signed-in user (no Firebase types leak out). */
export interface AuthUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
}

/**
 * A localizable sign-in error: a stable i18n `key` plus the inline English
 * `message` used as the fallback. The store can't call the React `useT` hook,
 * so it stores BOTH and the UI localizes via `useT(error.key, error.message)` —
 * matching the project's English-fallback translation contract.
 */
export interface AuthError {
  key: string
  message: string
}

interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  /** Last sign-in error (e.g. popup blocked / storage disabled), if any. */
  error: AuthError | null
  /** Start listening to auth changes. Idempotent; no-op when unconfigured. */
  init: () => void
  /**
   * Primary sign-in: a Google account-chooser POPUP, which authenticates in a
   * FIRST-PARTY context — so it works in incognito and without third-party
   * cookies (unlike redirect, which relies on a cross-site iframe on the
   * firebaseapp.com auth domain). Automatically FALLS BACK to a full-page
   * redirect when popups are blocked / unsupported by the environment.
   */
  signInWithGoogle: () => Promise<void>
  /**
   * Primary sign-in: exchange a Google Identity Services (One Tap / FedCM) ID
   * token for a Firebase session — no popup, no redirect, no page leave.
   */
  signInWithGoogleCredential: (idToken: string) => Promise<void>
  signOut: () => Promise<void>
}

let initialized = false
// The uid we last reported a `login` for, so onAuthStateChanged re-firing on
// reload/refresh doesn't log a duplicate login per page load.
let reportedLoginUid: string | null = null

/** Pull Firebase's `auth/...` error code off an unknown thrown value, if present. */
function authErrorCode(e: unknown): string | undefined {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code
    if (typeof c === 'string') return c
  }
  return undefined
}

/**
 * Map a sign-in failure to a localizable {key, message}. Storage / third-party
 * cookie failures (common in incognito or with cookies disabled) get a clear,
 * actionable message; everything else falls back to a generic message keyed for
 * translation, with the raw text appended for debugging.
 */
function describeAuthError(e: unknown): AuthError {
  const code = authErrorCode(e)
  if (
    code === 'auth/web-storage-unsupported' ||
    code === 'auth/operation-not-supported-in-this-environment'
  ) {
    return {
      key: 'auth.error.storage',
      message:
        'Sign-in needs cookies and site data. Enable them for this site (or use a normal, non-incognito window) and try again.',
    }
  }
  if (code === 'auth/network-request-failed') {
    return {
      key: 'auth.error.network',
      message: 'Network error during sign-in. Check your connection and try again.',
    }
  }
  if (code === 'auth/unauthorized-domain') {
    return {
      key: 'auth.error.domain',
      message: 'This domain is not authorized for sign-in. Please contact the site owner.',
    }
  }
  const raw = e instanceof Error ? e.message : String(e)
  return {
    key: 'auth.error.generic',
    message: `Could not sign in. Please try again. (${raw})`,
  }
}

export const useAuth = create<AuthState>((set) => ({
  status: firebaseConfigured() ? 'loading' : 'disabled',
  user: null,
  error: null,

  init: () => {
    if (initialized) return
    initialized = true
    // Load the Google Ads gtag on every real-domain page load (gated by
    // analyticsAllowed() inside) so the ad click's gclid is captured for
    // attribution — independent of whether Firebase auth is configured.
    initAdsTag()
    if (!firebaseConfigured()) {
      set({ status: 'disabled' })
      return
    }
    void (async () => {
      const auth = await getFirebaseAuth()
      if (!auth) {
        set({ status: 'disabled' })
        return
      }
      void maybeStartAnalytics()
      const { onAuthStateChanged, setPersistence, browserLocalPersistence } = await import(
        'firebase/auth'
      )
      // Keep the user signed in across page reloads AND closing/reopening the
      // browser — they only re-authenticate when the session genuinely expires.
      // This is Firebase's web default; set explicitly so it can never silently
      // fall back to session-only persistence.
      try {
        await setPersistence(auth, browserLocalPersistence)
      } catch {
        /* persistence unsupported (rare) — fall through; onAuthStateChanged still restores */
      }
      // Complete a pending redirect sign-in (the fallback flow): when the user
      // comes back from Google's full-page redirect, this resolves the result.
      // onAuthStateChanged below flips status → 'signedIn'; we only need this to
      // surface any redirect error and to drive the resolver. Best-effort.
      try {
        const { getRedirectResult } = await import('firebase/auth')
        await getRedirectResult(auth)
      } catch (e) {
        set({ error: describeAuthError(e) })
      }
      onAuthStateChanged(auth, (fbUser) => {
        if (fbUser) {
          set({
            status: 'signedIn',
            user: {
              uid: fbUser.uid,
              email: fbUser.email,
              displayName: fbUser.displayName,
              photoURL: fbUser.photoURL,
            },
            error: null,
          })
          // Tag the signed-in user in GA4 (setUserId + `login` event) once per
          // uid, so authenticated users form a segmentable audience. Best-effort.
          if (reportedLoginUid !== fbUser.uid) {
            reportedLoginUid = fbUser.uid
            reportLogin(fbUser.uid)
          }
        } else {
          set({ status: 'signedOut', user: null })
        }
      })
    })()
  },

  signInWithGoogle: async () => {
    if (!firebaseConfigured()) return
    set({ error: null })
    try {
      const auth = await getFirebaseAuth()
      if (!auth) return
      const {
        GoogleAuthProvider,
        signInWithPopup,
        signInWithRedirect,
        browserPopupRedirectResolver,
      } = await import('firebase/auth')
      const provider = new GoogleAuthProvider()
      // Always prompt account selection so a logged-out user can pick/add an
      // account, instead of silently reusing a stale session.
      provider.setCustomParameters({ prompt: 'select_account' })
      // PRIMARY: a popup. It authenticates in a FIRST-PARTY context, so it works
      // in incognito and survives the third-party-cookie phase-out (unlike
      // signInWithRedirect, whose cross-site iframe on firebaseapp.com is blocked
      // there, bouncing the user back unauthenticated). Pass the configured
      // resolver explicitly so it never re-probes the environment.
      try {
        await signInWithPopup(auth, provider, browserPopupRedirectResolver)
        // onAuthStateChanged flips status → 'signedIn'.
        return
      } catch (e) {
        const code = authErrorCode(e)
        // User simply dismissed the popup (closed it, or a second popup raced
        // and cancelled the first) — not an error worth showing.
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
          return
        }
        // Popup couldn't open (blocker) or the environment can't host one — fall
        // back to a FULL-PAGE redirect. getRedirectResult() (on init) +
        // onAuthStateChanged complete it on return. Storage/3rd-party-cookie
        // failures are surfaced (redirect can't fix those) rather than retried.
        if (
          code === 'auth/popup-blocked' ||
          code === 'auth/operation-not-supported-in-this-environment' ||
          code === 'auth/missing-or-invalid-nonce'
        ) {
          await signInWithRedirect(auth, provider, browserPopupRedirectResolver)
          return
        }
        throw e
      }
    } catch (e) {
      set({ error: describeAuthError(e) })
    }
  },

  signInWithGoogleCredential: async (idToken: string) => {
    if (!firebaseConfigured()) return
    set({ error: null })
    try {
      const auth = await getFirebaseAuth()
      if (!auth) return
      const { GoogleAuthProvider, signInWithCredential } = await import('firebase/auth')
      // The One Tap / FedCM callback hands us a Google ID token (JWT). Exchange
      // it for a Firebase session in-place — no popup, no redirect (a fully
      // first-party flow that also works in incognito).
      const cred = GoogleAuthProvider.credential(idToken)
      await signInWithCredential(auth, cred)
      // onAuthStateChanged flips status → 'signedIn'.
    } catch (e) {
      set({ error: describeAuthError(e) })
    }
  },

  signOut: async () => {
    if (!firebaseConfigured()) return
    try {
      const auth = await getFirebaseAuth()
      if (!auth) return
      // Stop One Tap from auto-selecting the just-removed account on next load.
      const { disableOneTapAutoSelect } = await import('./googleOneTap')
      disableOneTapAutoSelect()
      const { signOut } = await import('firebase/auth')
      await signOut(auth)
    } catch {
      /* ignore */
    }
  },
}))
