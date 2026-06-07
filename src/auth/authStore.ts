import { create } from 'zustand'
import { firebaseConfigured, getFirebaseAuth, maybeStartAnalytics } from './firebase'

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

interface AuthState {
  status: AuthStatus
  user: AuthUser | null
  /** Last sign-in error message (e.g. popup blocked / closed), if any. */
  error: string | null
  /** Start listening to auth changes. Idempotent; no-op when unconfigured. */
  init: () => void
  signInWithGoogle: () => Promise<void>
  signOut: () => Promise<void>
}

let initialized = false

export const useAuth = create<AuthState>((set) => ({
  status: firebaseConfigured() ? 'loading' : 'disabled',
  user: null,
  error: null,

  init: () => {
    if (initialized) return
    initialized = true
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
      const { GoogleAuthProvider, signInWithPopup } = await import('firebase/auth')
      const provider = new GoogleAuthProvider()
      await signInWithPopup(auth, provider)
      // onAuthStateChanged flips status → 'signedIn'.
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ error: msg })
    }
  },

  signOut: async () => {
    if (!firebaseConfigured()) return
    try {
      const auth = await getFirebaseAuth()
      if (!auth) return
      const { signOut } = await import('firebase/auth')
      await signOut(auth)
    } catch {
      /* ignore */
    }
  },
}))
