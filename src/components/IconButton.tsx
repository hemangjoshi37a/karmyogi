import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from './Icons'

interface IconButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible label + hover tooltip text. REQUIRED — every icon button names its action. */
  label: string
  /** Pixel size for the rendered icon when `iconName` is used. Default 16. */
  iconSize?: number
}

/**
 * Either pass an explicit node via `icon` (legacy / custom content) OR a shared
 * icon name via `iconName` (preferred — uses the one shared SVG set in Icons.tsx
 * so glyphs are consistent + theme-colored). Exactly one is expected.
 */
type IconButtonProps = IconButtonBaseProps &
  (
    | { icon: ReactNode; iconName?: never }
    | { iconName: IconName; icon?: never }
  )

/**
 * A compact button that shows ONLY an icon, with a native hover tooltip (`title`)
 * and an accessible name (`aria-label`) so the action is always discoverable.
 *
 * Prefer `iconName` (the shared SVG set) over a raw `icon` node so the app's
 * glyphs stay consistent and recolor with the theme.
 */
export function IconButton(props: IconButtonProps) {
  const { label, className, icon, iconName, iconSize = 16, ...rest } = props
  return (
    <button
      {...rest}
      className={className ? `icon-btn ${className}` : 'icon-btn'}
      title={label}
      aria-label={label}
    >
      <span className="icon-btn-glyph" aria-hidden="true">
        {iconName ? <Icon name={iconName} size={iconSize} /> : icon}
      </span>
    </button>
  )
}
