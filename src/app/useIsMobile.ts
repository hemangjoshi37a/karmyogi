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
