// Google Ads conversion tracking (client-only, best-effort).
//
// karmyogi has NO backend, so the "Serial Connected" activation conversion must
// be fired from the browser. This module:
//   1. loads the Google Ads gtag.js at startup (so the ad click's gclid is
//      captured for attribution), and
//   2. fires the conversion + a GA4 event the first time a serial port connects.
//
// EVERYTHING here is best-effort: it must NEVER throw, and must NEVER block or
// delay an actual machine connection. Every external call is wrapped in
// try/catch and feature-detected. It is also GATED OFF on localhost / dev /
// preview / Playwright so those loads never pollute Ads or GA4.

import { logAnalyticsEvent, setAnalyticsUser } from '../auth/firebase'

// --- exact known values (do not change) ---
const ADS_TAG_ID = 'AW-958945159'
const CONVERSION_SEND_TO = 'AW-958945159/4lGgCN3E2LwcEIevockD'

// gtag is a variadic command queue: gtag('js', Date), gtag('config', id),
// gtag('event', name, params). Type it without `any` to satisfy strict.
type GtagFn = (...args: unknown[]) => void

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: GtagFn
  }
}

/**
 * True only on the REAL deployed domain. Returns false on localhost / loopback /
 * file: pages and whenever Vite's DEV flag is set — so the Ads tag + conversions
 * never run (and never inflate Ads/GA4) during dev, preview, or Playwright runs.
 */
export function analyticsAllowed(): boolean {
  try {
    if (import.meta.env.DEV) return false
    if (typeof location === 'undefined') return false
    const proto = location.protocol
    if (proto === 'file:') return false
    const host = location.hostname.toLowerCase()
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host === '::1' ||
      host === '[::1]' ||
      host.endsWith('.localhost')
    ) {
      return false
    }
    return true
  } catch {
    return false
  }
}

// Load the Ads tag at most once per page.
let started = false
// Fire the activation conversion at most once per session (page lifetime).
let serialConnectedReported = false

/**
 * Inject the Google Ads gtag.js once and run the standard bootstrap
 * (`gtag('js', …)` + `gtag('config', …)`). Loading this at app startup is what
 * lets the ad click's gclid get captured/attributed. Idempotent and best-effort;
 * no-op off the real domain.
 */
export function initAdsTag(): void {
  if (started) return
  started = true
  if (!analyticsAllowed()) return
  try {
    if (typeof document === 'undefined' || typeof window === 'undefined') return
    // Set up the dataLayer + gtag shim BEFORE the script loads (gtag.js expects
    // these to already exist so queued commands replay once it initializes).
    window.dataLayer = window.dataLayer || []
    if (typeof window.gtag !== 'function') {
      window.gtag = function gtag(...args: unknown[]): void {
        // gtag.js requires the literal `arguments` object pushed (not a copy).
        window.dataLayer!.push(args)
      }
    }
    window.gtag('js', new Date())
    window.gtag('config', ADS_TAG_ID)
    // Inject the loader script once (guard against a duplicate if something else
    // already added it).
    const src = `https://www.googletagmanager.com/gtag/js?id=${ADS_TAG_ID}`
    const already = document.querySelector(`script[src="${src}"]`)
    if (!already) {
      const s = document.createElement('script')
      s.async = true
      s.src = src
      document.head.appendChild(s)
    }
  } catch {
    /* best-effort — never let tag loading break the app */
  }
}

/**
 * Fire the "Serial Connected" activation conversion + a GA4 `serial_connected`
 * event. At most ONCE per session. No-op off the real domain. The two reports
 * are independent — a failure of one never blocks the other.
 */
export function reportSerialConnected(): void {
  if (serialConnectedReported) return
  serialConnectedReported = true
  if (!analyticsAllowed()) return
  // Google Ads conversion.
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', 'conversion', { send_to: CONVERSION_SEND_TO })
    }
  } catch {
    /* best-effort */
  }
  // GA4 event (Firebase Analytics) — separate try so it fires even if the Ads
  // conversion above threw.
  try {
    logAnalyticsEvent('serial_connected')
  } catch {
    /* best-effort */
  }
}

/**
 * Mark the signed-in user in GA4: set the user id + log a `login` event so
 * authenticated users become a segmentable audience (authenticated DAU).
 * Best-effort; no-op off the real domain.
 */
export function reportLogin(uid: string): void {
  if (!analyticsAllowed()) return
  try {
    setAnalyticsUser(uid)
  } catch {
    /* best-effort */
  }
  try {
    logAnalyticsEvent('login', { method: 'google' })
  } catch {
    /* best-effort */
  }
}
