/**
 * Whether the user has asked the OS to minimise non-essential motion
 * (`prefers-reduced-motion: reduce`). Viewer animations (the hover SHIMMER,
 * spindle whirr, …) check this and fall back to a static treatment so we never
 * animate against the user's accessibility preference.
 *
 * Read synchronously at call time (cheap; `matchMedia` is memoised by the
 * browser) and guarded for non-DOM/SSR contexts.
 */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  )
}
