/**
 * MachineIcons — small, reusable inline-SVG glyphs for the Controller (Machine
 * card) and Coordinates panels.
 *
 * Theme-correctness: every icon is monochrome and inherits the button's text
 * color via `stroke="currentColor"` / `fill="currentColor"`. Because they take
 * the host button's `color` (which the theme sets), they render correctly in
 * BOTH the dark and light themes with no baked-in color — and they stay crisp
 * at any size/DPI (unlike a raster PNG). Geometry is adapted from the Qt
 * reference icons in `hjLabs.in_Candle/src/candle/images/` (home/restart/run/
 * axis_zero/origin) and drawn cleanly here for the simple ones (pause, padlock).
 */

type IconProps = {
  /** Pixel size of the square viewBox-mapped glyph (default 18). */
  size?: number
  className?: string
}

/** Shared SVG wrapper so all icons share sizing / a11y defaults. */
function Svg({ size = 18, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

/* ---------------- Controller — Machine card ---------------- */

/** Home — a house (adapted from home.svg). */
export function HomeIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M3 11.2 12 4l9 7.2" />
      <path d="M5.5 10v9.5h13V10" />
      <path d="M10 19.5v-5.5h4v5.5" />
    </Svg>
  )
}

/** Unlock — an open padlock (reference is PNG only; drawn clean here). */
export function UnlockIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="4.5" y="11" width="15" height="9.5" rx="1.8" />
      {/* Open shackle: hinged on the right, swung open to the left. */}
      <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
      <circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** Reset — a restart / refresh loop (adapted from restart.svg). */
export function ResetIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M18 3.2V7h-3.8" />
    </Svg>
  )
}

/** Hold — a pause glyph, two vertical bars (reference is PNG only). */
export function PauseIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="9" y1="5" x2="9" y2="19" />
      <line x1="15" y1="5" x2="15" y2="19" />
    </Svg>
  )
}

/** Resume — a play triangle (adapted from run.svg). */
export function PlayIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 5.2 19 12 7 18.8Z" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/* ---------------- Controller — Spindle card ---------------- */

/**
 * SpindleCw — a clockwise circular arrow. Used for the spindle CW (M3)
 * direction toggle. Drawn as a near-full circle broken at the top-right with
 * an arrowhead pointing clockwise.
 */
export function SpindleCwIcon(p: IconProps) {
  return (
    <Svg {...p}>
      {/* Arc sweeping clockwise, open at the top. */}
      <path d="M12 4.5a7.5 7.5 0 1 0 6.9 4.6" />
      {/* Arrowhead at the open (top-right) end, pointing clockwise. */}
      <path d="M18.9 9.1 19.6 4.4M18.9 9.1l-4.7.8" />
    </Svg>
  )
}

/**
 * SpindleCcw — a counter-clockwise circular arrow. Used for the spindle CCW
 * (M4) direction toggle. Mirror of SpindleCwIcon, open at the top-left.
 */
export function SpindleCcwIcon(p: IconProps) {
  return (
    <Svg {...p}>
      {/* Arc sweeping counter-clockwise, open at the top. */}
      <path d="M12 4.5a7.5 7.5 0 1 1-6.9 4.6" />
      {/* Arrowhead at the open (top-left) end, pointing counter-clockwise. */}
      <path d="M5.1 9.1 4.4 4.4M5.1 9.1l4.7.8" />
    </Svg>
  )
}

/* ---------------- Controller — Overrides ---------------- */

/** Plus — increase an override by a step. */
export function PlusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  )
}

/** Minus — decrease an override by a step. */
export function MinusIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </Svg>
  )
}

/**
 * Reset-to-100% — a small circular arrow (reuse of the restart loop, smaller)
 * for the "back to 100%" override buttons. Pairs visually with Plus/Minus.
 */
export function OvResetIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M19 12a7 7 0 1 1-2-4.9" />
      <path d="M17.5 3.5V7.2h-3.7" />
    </Svg>
  )
}

/* ---------------- Coordinates panel ---------------- */

/**
 * AxisZero — a crosshair-to-zero glyph (adapted from axis_zero.svg / zero_z.svg):
 * a target crosshair with a small "0" centre. Used for the Zero buttons.
 */
export function AxisZeroIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4.2" />
      <line x1="12" y1="2.5" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="21.5" />
      <line x1="2.5" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="21.5" y2="12" />
    </Svg>
  )
}

/**
 * GoToZero — return-to-origin (adapted from origin.svg / axis_return.svg):
 * an arrow curving back into a target origin dot.
 */
export function GoToZeroIcon(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="6.5" />
      {/* Inbound arrow from the top-left into the origin. */}
      <path d="M4 4h4.5" />
      <path d="M4 4v4.5" />
      <path d="M4 4 9.6 9.6" />
    </Svg>
  )
}
