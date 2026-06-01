import type { ButtonHTMLAttributes, ReactNode } from 'react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** The icon/glyph (or any node) shown inside the button. */
  icon: ReactNode
  /** Accessible label + hover tooltip text. REQUIRED — every icon button names its action. */
  label: string
}

/**
 * A compact button that shows ONLY an icon, with a native hover tooltip (`title`)
 * and an accessible name (`aria-label`) so the action is always discoverable.
 */
export function IconButton({ icon, label, className, ...rest }: IconButtonProps) {
  return (
    <button
      {...rest}
      className={className ? `icon-btn ${className}` : 'icon-btn'}
      title={label}
      aria-label={label}
    >
      <span className="icon-btn-glyph" aria-hidden="true">
        {icon}
      </span>
    </button>
  )
}
