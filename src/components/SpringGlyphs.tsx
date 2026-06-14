import type { CSSProperties } from 'react'

/**
 * Small inline SVG glyphs specific to the Spring-Coiling panel — the shared
 * `Icon` set has no coil / rotation / spring-section marks, so these live here.
 * All are 24×24, `stroke="currentColor"`, no fill, so they inherit the button's
 * colour and tint with the accent on the active segment. Pure presentation.
 */

type GlyphProps = { size?: number; className?: string; style?: CSSProperties }

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  }
}

/** A compression spring: a few WIDELY-spaced coils (open body pitch). */
export function CompressionSpringGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M3 12q2.4-6 4.8 0t4.8 0 4.8 0 4.8 0" />
      <path d="M3 9v6M21 9v6" />
    </svg>
  )
}

/** An extension spring: TIGHT coils + a hook at each end. */
export function ExtensionSpringGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M6 12q1.2-5 2.4 0t2.4 0 2.4 0 2.4 0 2.4 0" />
      <path d="M6 12a2 2 0 0 1-4 0M18 12a2 2 0 0 0 4 0" />
    </svg>
  )
}

/** A torsion spring: a coil (loop) with two straight legs. */
export function TorsionSpringGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <circle cx="12" cy="11" r="4" />
      <path d="M12 7V3M15 13l4 3" />
    </svg>
  )
}

/** Clockwise rotation arrow (right-hand winding). */
export function CwGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M19 3v4h-4" />
    </svg>
  )
}

/** Counter-clockwise rotation arrow (left-hand winding). */
export function CcwGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M4 12a8 8 0 1 0 2.3-5.6" />
      <path d="M5 3v4h4" />
    </svg>
  )
}

/** Geometry / diameter caliper mark. */
export function GeometryGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <circle cx="12" cy="12" r="7" />
      <path d="M5 12h14M7 10v4M17 10v4" />
    </svg>
  )
}

/** Closing (dead) turns: two square brackets pressed together. */
export function ClosingGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M9 5H6v14h3M15 5h3v14h-3" />
      <path d="M11.5 9v6M13 9v6" />
    </svg>
  )
}

/** Motion / speed gauge. */
export function MotionGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M4 17a8 8 0 0 1 16 0" />
      <path d="M12 17l4-5" />
      <path d="M4 17h2M18 17h2M12 9V7" />
    </svg>
  )
}

/** A coil seen end-on (concentric rings) — the spring-type section mark. */
export function CoilGlyph({ size = 18, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size)} className={className} style={style}>
      <path d="M3 12q2.4-6 4.8 0t4.8 0 4.8 0 4.8 0" />
    </svg>
  )
}
