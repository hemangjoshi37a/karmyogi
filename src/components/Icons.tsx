// Shared SVG icon set for karmyogi.
//
// ONE source of truth for every glyph in the app, replacing the ad-hoc emoji /
// Unicode glyphs scattered across panels (which render inconsistently across
// platforms and don't recolor with the theme). Panels import { Icon } and pass
// a `name` from the IconName union; later waves swap their emoji for <Icon/>.
//
// Design rules (keep these — other workstreams rely on them):
//  • currentColor — every path uses `currentColor` (stroke or fill) so an icon
//    inherits the surrounding text color and recolors with the theme for free.
//  • tree-shakeable — icons live in a plain object map of render functions; an
//    unused icon is dead code the bundler can drop. No side effects at module load.
//  • 24×24 viewBox, 2px stroke, round caps/joins — a single consistent grid so
//    icons line up optically across panels regardless of `size`.
//  • no React/DOM state — pure presentational SVG.

import type { JSX } from 'react'

/**
 * Every icon the app exposes. Keep this union the single registry of valid
 * names; adding an icon = add a name here + an entry in PATHS below. The set
 * below covers the cross-workstream contract (plus a few common extras).
 */
export type IconName =
  | 'trash'
  | 'close'
  | 'add'
  | 'duplicate'
  | 'download'
  | 'upload'
  | 'play'
  | 'pause'
  | 'stop'
  | 'settings'
  | 'zero'
  | 'home'
  | 'jog'
  | 'frame'
  | 'copy'
  | 'chevron-down'
  | 'chevron-right'
  | 'eye'
  | 'eye-off'
  | 'info'
  | 'connect'
  | 'disconnect'
  | 'spindle'
  | 'probe'
  | 'camera'
  | 'laser'
  | 'warning'

/**
 * Per-icon SVG body (the inner elements only — the wrapping <svg> with sizing,
 * stroke + currentColor is added by {@link Icon}). Stored as a render-function
 * map so unused icons can be tree-shaken and there is no module-load cost.
 */
const PATHS: Record<IconName, () => JSX.Element> = {
  trash: () => (
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13" />
      <path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </>
  ),
  close: () => (
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6L6 18" />
    </>
  ),
  add: () => (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  duplicate: () => (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  download: () => (
    <>
      <path d="M12 4v11" />
      <path d="M8 11l4 4 4-4" />
      <path d="M5 20h14" />
    </>
  ),
  upload: () => (
    <>
      <path d="M12 20V9" />
      <path d="M8 13l4-4 4 4" />
      <path d="M5 4h14" />
    </>
  ),
  play: () => <path d="M8 5.5v13l11-6.5z" />,
  pause: () => (
    <>
      <path d="M9 5v14" />
      <path d="M15 5v14" />
    </>
  ),
  stop: () => <rect x="6" y="6" width="12" height="12" rx="1.5" />,
  settings: () => (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
    </>
  ),
  // A small "0" target — set work zero / go to zero.
  zero: () => (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  home: () => (
    <>
      <path d="M4 11l8-7 8 7" />
      <path d="M6 10v9a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-9" />
    </>
  ),
  // Four-way arrows — jog pad.
  jog: () => (
    <>
      <path d="M12 3v18M3 12h18" />
      <path d="M12 3l-2.5 3M12 3l2.5 3" />
      <path d="M12 21l-2.5-3M12 21l2.5-3" />
      <path d="M3 12l3-2.5M3 12l3 2.5" />
      <path d="M21 12l-3-2.5M21 12l-3 2.5" />
    </>
  ),
  frame: () => (
    <>
      <path d="M4 8V5a1 1 0 0 1 1-1h3" />
      <path d="M16 4h3a1 1 0 0 1 1 1v3" />
      <path d="M20 16v3a1 1 0 0 1-1 1h-3" />
      <path d="M8 20H5a1 1 0 0 1-1-1v-3" />
    </>
  ),
  copy: () => (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  'chevron-down': () => <path d="M6 9l6 6 6-6" />,
  'chevron-right': () => <path d="M9 6l6 6-6 6" />,
  eye: () => (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  'eye-off': () => (
    <>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.2A9.6 9.6 0 0 1 12 6.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.5" />
      <path d="M6.3 7.8A16 16 0 0 0 2.5 13S6 19.5 12 19.5a9.4 9.4 0 0 0 3.4-.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </>
  ),
  info: () => (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.75v.01" />
    </>
  ),
  // Plug — connect.
  connect: () => (
    <>
      <path d="M9 2v6M15 2v6" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v6" />
    </>
  ),
  // Plug with a slash — disconnect.
  disconnect: () => (
    <>
      <path d="M9 2v6M15 2v6" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v6" />
      <path d="M3 3l18 18" />
    </>
  ),
  // Spindle / rotation.
  spindle: () => (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 8 8" />
      <circle cx="12" cy="12" r="1.5" />
    </>
  ),
  // Probe — downward arrow into a surface.
  probe: () => (
    <>
      <path d="M12 3v11" />
      <path d="M9 11l3 3 3-3" />
      <path d="M4 20h16" />
    </>
  ),
  camera: () => (
    <>
      <path d="M4 8a2 2 0 0 1 2-2h2l1.5-2h5L18 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
      <circle cx="12" cy="13" r="3.5" />
    </>
  ),
  laser: () => (
    <>
      <path d="M12 2v6" />
      <path d="M8 8h8l-2 5h-4z" />
      <path d="M12 13v9" />
    </>
  ),
  warning: () => (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17v.01" />
    </>
  ),
}

export interface IconProps {
  /** Which icon to render (see {@link IconName}). */
  name: IconName
  /** Square size in px (width === height). Default 16. */
  size?: number
  /** Extra class on the <svg> (for panel-specific sizing/spacing). */
  className?: string
  /**
   * Accessible title. When provided, the SVG gets role="img" + <title>; when
   * omitted, the SVG is aria-hidden (decorative — pair it with a visible/aria
   * label on the parent control instead).
   */
  title?: string
}

/**
 * Render one shared icon. Uses `currentColor` for stroke (and fill on the few
 * solid glyphs) so it inherits the surrounding text color automatically.
 */
export function Icon({ name, size = 16, className, title }: IconProps): JSX.Element {
  const Body = PATHS[name]
  // Solid (filled) glyphs vs. stroked outlines — these read better filled.
  const filled = name === 'play' || name === 'stop'
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <Body />
    </svg>
  )
}
