// Shared per-section toolpath colours, used by BOTH the Visualizer (to draw each
// program section's lines) and the Program panel (to show/edit a section's
// colour swatch). A section may carry an explicit `color` override; otherwise it
// falls back to this automatic, index-based palette — tuned for legibility on
// each theme's background (brighter on dark, deeper on light).

export const SECTION_COLORS_DARK = [
  '#38bdf8', '#fbbf24', '#a78bfa', '#34d399', '#fb7185',
  '#22d3ee', '#f472b6', '#a3e635', '#fb923c', '#e879f9',
]
export const SECTION_COLORS_LIGHT = [
  '#0284c7', '#b45309', '#6d28d9', '#047857', '#be123c',
  '#0e7490', '#a21caf', '#4d7c0f', '#c2410c', '#9333ea',
]

/**
 * The effective toolpath colour for a section: its explicit `override` when set,
 * else the automatic palette entry for its index (theme-aware).
 */
export function sectionColor(index: number, dark: boolean, override?: string): string {
  if (override) return override
  const p = dark ? SECTION_COLORS_DARK : SECTION_COLORS_LIGHT
  return p[index % p.length]
}
