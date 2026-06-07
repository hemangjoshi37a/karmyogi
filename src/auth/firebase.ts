// Lazy, env-driven Firebase bootstrap.
//
// CRITICAL — graceful degradation: this module NEVER initializes Firebase (and
// never throws) unless real config is present in `import.meta.env.VITE_FIREBASE_*`.
// The user runs the live app with NO Firebase config, so when the keys are
// ABSENT or still placeholders, `firebaseConfigured()` returns false and the
// whole auth/tracking stack treats the app as fully open + no-ops silently.
//
// Everything here is imported dynamically inside the init helpers so the heavy
// `firebase/*` SDK is only pulled in (and only network-touched) when configured.

import type { FirebaseApp } from 'firebase/app'
import type { Auth } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'
import type { Analytics } from 'firebase/analytics'

export interface FirebaseConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket: string
  messagingSenderId: string
  appId: string
  measurementId?: string
}

/** A value counts as "set" only if it is non-empty and not an obvious placeholder. */
function realValue(v: string | undefined): string | undefined {
  if (!v) return undefined
  const s = v.trim()
  if (!s) return undefined
  // Reject the placeholders shipped in `.env.example` (e.g. "your-api-key",
  // "REPLACE_ME", "xxx", "TODO", "changeme", values wrapped in <> or {}).
  if (/^(your[-_]|replace|todo|changeme|placeholder|xxx)/i.test(s)) return undefined
  if (/^[<{].*[>}]$/.test(s)) return undefined
  return s
}

/** Read + validate the Firebase config from Vite env vars. Returns null if not fully configured. */
function readConfig(): FirebaseConfig | null {
  const env = import.meta.env
  const apiKey = realValue(env.VITE_FIREBASE_API_KEY)
  const authDomain = realValue(env.VITE_FIREBASE_AUTH_DOMAIN)
  const projectId = realValue(env.VITE_FIREBASE_PROJECT_ID)
  const appId = realValue(env.VITE_FIREBASE_APP_ID)
  // The minimum needed for Auth (Google popup) + Firestore is apiKey, authDomain,
  // projectId and appId. The rest are recommended but not strictly required.
  if (!apiKey || !authDomain || !projectId || !appId) return null
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: realValue(env.VITE_FIREBASE_STORAGE_BUCKET) ?? '',
    messagingSenderId: realValue(env.VITE_FIREBASE_MESSAGING_SENDER_ID) ?? '',
    measurementId: realValue(env.VITE_FIREBASE_MEASUREMENT_ID),
  }
}

const CONFIG = readConfig()

/**
 * True only when REAL Firebase config is present. Every gate/tracking decision
 * branches on this — when false the app is fully open and tracking no-ops.
 */
export function firebaseConfigured(): boolean {
  return CONFIG !== null
}

/**
 * The single super-admin email allowed to view the `/admin` console. Overridable
 * via `VITE_ADMIN_EMAIL`, defaulting to the owner. NOTE: this is only the client
 * UX gate — the REAL enforcement is the hardcoded admin email in `firestore.rules`
 * (rules can't read env). Keep the two in sync.
 */
export function adminEmail(): string {
  return realValue(import.meta.env.VITE_ADMIN_EMAIL) ?? 'hemangjoshi37a@gmail.com'
}

/** Whether the given user (or email) is the super-admin. Case-insensitive. */
export function isAdmin(user: { email?: string | null } | string | null | undefined): boolean {
  const email = typeof user === 'string' ? user : user?.email
  if (!email) return false
  return email.trim().toLowerCase() === adminEmail().trim().toLowerCase()
}

/**
 * Whether sign-in is REQUIRED (the app is gated behind Google login). True when
 * Firebase is configured UNLESS `VITE_AUTH_REQUIRED=false` is set — a safety
 * switch so the hard gate can be turned off (e.g. if Google sign-in misbehaves
 * on a LAN IP) without removing config: tracking still runs once a user opts to
 * sign in, but the app stays open. Default = gated (per the product decision).
 */
export function authRequired(): boolean {
  if (CONFIG === null) return false
  return String(import.meta.env.VITE_AUTH_REQUIRED ?? 'true').toLowerCase() !== 'false'
}

// Cached singletons — created at most once, only when configured.
let appPromise: Promise<FirebaseApp> | null = null
let authPromise: Promise<Auth> | null = null
let dbPromise: Promise<Firestore> | null = null
let analyticsStarted = false

async function getApp(): Promise<FirebaseApp> {
  if (!CONFIG) throw new Error('Firebase is not configured')
  if (!appPromise) {
    appPromise = (async () => {
      const { initializeApp, getApps, getApp: getExisting } = await import('firebase/app')
      const app = getApps().length ? getExisting() : initializeApp(CONFIG)
      // Firebase App Check — the primary abuse/cost guard: it attests requests
      // come from THIS real app (via reCAPTCHA v3) so bots/scripts can't pound
      // Firestore/Storage/Auth and inflate the bill. Gated behind a public site
      // key, so it stays a NO-OP until you configure VITE_RECAPTCHA_SITE_KEY +
      // enable enforcement in the Firebase console (never breaks local dev).
      const siteKey = realValue(import.meta.env.VITE_RECAPTCHA_SITE_KEY)
      if (siteKey) {
        try {
          if (import.meta.env.DEV) {
            // Lets localhost / Playwright obtain a debug token (register it in
            // the App Check console) instead of solving a real reCAPTCHA.
            ;(self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN =
              true
          }
          const { initializeAppCheck, ReCaptchaV3Provider } = await import('firebase/app-check')
          initializeAppCheck(app, {
            provider: new ReCaptchaV3Provider(siteKey),
            isTokenAutoRefreshEnabled: true,
          })
        } catch {
          /* App Check is best-effort; never let it break app startup. */
        }
      }
      return app
    })()
  }
  return appPromise
}

/** Lazily init + return the Auth instance (null when unconfigured). */
export async function getFirebaseAuth(): Promise<Auth | null> {
  if (!CONFIG) return null
  if (!authPromise) {
    authPromise = (async () => {
      const app = await getApp()
      const {
        initializeAuth,
        getAuth,
        indexedDBLocalPersistence,
        browserLocalPersistence,
        browserPopupRedirectResolver,
      } = await import('firebase/auth')
      // Use initializeAuth with an explicit persistence chain so the session is
      // restored on reload RELIABLY — `getAuth()` picks a default that can fall
      // back to in-memory (forgetting the user on refresh) if storage probing
      // races. IndexedDB first (survives more aggressive cookie clearing), then
      // localStorage. Falls back to getAuth() if auth was already initialized.
      try {
        return initializeAuth(app, {
          persistence: [indexedDBLocalPersistence, browserLocalPersistence],
          popupRedirectResolver: browserPopupRedirectResolver,
        })
      } catch {
        return getAuth(app)
      }
    })()
  }
  return authPromise
}

/** Lazily init + return the Firestore instance (null when unconfigured). */
export async function getDb(): Promise<Firestore | null> {
  if (!CONFIG) return null
  if (!dbPromise) {
    dbPromise = (async () => {
      const app = await getApp()
      const { getFirestore } = await import('firebase/firestore')
      return getFirestore(app)
    })()
  }
  return dbPromise
}

/** Init Analytics once, only if a measurementId is configured + supported. */
export async function maybeStartAnalytics(): Promise<Analytics | null> {
  if (!CONFIG || !CONFIG.measurementId || analyticsStarted) return null
  analyticsStarted = true
  try {
    const app = await getApp()
    const { getAnalytics, isSupported } = await import('firebase/analytics')
    if (await isSupported()) return getAnalytics(app)
  } catch {
    /* analytics is best-effort; never let it break the app */
  }
  return null
}
