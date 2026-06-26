import { useEffect, useState } from 'react'

/** Mobile breakpoint (px). Below this the shell switches to the stacked layout. */
export const MOBILE_BREAKPOINT = 768

/**
 * True when the viewport is at/below the mobile breakpoint. Drives the
 * desktop(dockview) ⇄ mobile(stacked tabs) switch in the app shell.
 */
export function useIsMobile(breakpoint = MOBILE_BREAKPOINT): boolean {
  const query = `(max-width: ${breakpoint}px)`
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [query])

  return isMobile
}

/**
 * X6 — low-end / data-saver heuristic for the lightweight render path.
 *
 * Returns true when the device looks resource-constrained, so heavy consumers
 * (the three.js Visualizer, the slicer/toolpath preview) can opt into a cheaper
 * path: skip antialiasing/shadows, clamp the device-pixel-ratio, prefer the
 * 2D/SVG toolpath fallback over a full WebGL scene, and avoid eager prefetch of
 * the big viewer/slicer chunks. This is a *hint*, not a guarantee — consumers
 * decide what to downgrade.
 *
 * Signals (all best-effort; absent fields are simply ignored):
 *  - `navigator.connection.saveData` — the user explicitly asked to save data;
 *  - `navigator.deviceMemory ≤ 4` (GiB) — low-RAM phones / tablets;
 *  - `navigator.hardwareConcurrency ≤ 4` — few logical cores;
 *  - a coarse pointer at a phone-class width (mobile form factor).
 *
 * Computed once at mount: these capabilities don't change during a session, so
 * there's no listener to keep wired (save-data toggling mid-session is rare and
 * a reload re-evaluates it).
 */
interface NavigatorWithCaps extends Navigator {
  deviceMemory?: number
  connection?: { saveData?: boolean; effectiveType?: string }
}

export function detectLowEndDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const nav = navigator as NavigatorWithCaps
  if (nav.connection?.saveData) return true
  // 2G/slow-2G connections are a strong low-end signal.
  const eff = nav.connection?.effectiveType
  if (eff === 'slow-2g' || eff === '2g') return true
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory <= 4) {
    return true
  }
  if (
    typeof nav.hardwareConcurrency === 'number' &&
    nav.hardwareConcurrency > 0 &&
    nav.hardwareConcurrency <= 4
  ) {
    return true
  }
  // Coarse pointer (touch) at a phone-class width — treat as constrained.
  if (
    typeof window !== 'undefined' &&
    window.matchMedia('(pointer: coarse)').matches &&
    window.matchMedia('(max-width: 768px)').matches
  ) {
    return true
  }
  return false
}

/** React hook wrapper around {@link detectLowEndDevice}, evaluated once. */
export function useLowEndDevice(): boolean {
  const [low] = useState(detectLowEndDevice)
  return low
}
