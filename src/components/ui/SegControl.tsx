import { useRef } from 'react'
import type { ReactNode } from 'react'

/**
 * One option in a {@link SegControl}. `value` is the discriminator returned to
 * `onChange`; `label` is what renders inside the segment.
 */
export interface SegOption<T extends string | number> {
  value: T
  label: ReactNode
  /** Native tooltip / a11y hint for this segment. */
  title?: string
  disabled?: boolean
}

export interface SegControlProps<T extends string | number> {
  /** The selectable segments, left → right. */
  options: SegOption<T>[]
  /** Currently-selected value. */
  value: T
  onChange: (value: T) => void
  /** Required: names the group for screen readers (it has no visible label). */
  ariaLabel: string
  /**
   * `tonal` (default) = a muted `--accent-soft` fill on the active segment, for
   * MODE switches (so only true primary CTAs are full-accent). `accent` = solid
   * `--accent`/`--accent-fg`, for a primary segmented choice.
   */
  variant?: 'tonal' | 'accent'
  /** `sm` uses the small control height. Default `md`. */
  size?: 'sm' | 'md'
  className?: string
}

/**
 * THE canonical segmented control (plan §2.8 / W-C). One definition app-wide,
 * replacing `.mc-seg`, `.pt-speed`, `.cc-opseg`, `.laser-seg`, `.pcb-zmode`,
 * `.cam-seg-btn`, `.wr-seg`, `.sig-mode`, `.pr-seg-btn`, …
 *
 * Accessibility (the reason this is a shared component, not just CSS):
 * - `role="radiogroup"` wrapper + `role="radio"` real `<button>` children.
 * - **Roving tabindex**: the selected segment is the only tab stop (`tabIndex 0`),
 *   the rest are `-1`; Tab enters/leaves the group as a unit.
 * - **Arrow keys**: Left/Up → previous, Right/Down → next, Home/End → ends;
 *   **selection follows focus** (moving focus selects), matching native radios.
 * - Disabled segments are skipped by the arrow navigation.
 *
 * Pure presentation: no business logic, driven entirely by props.
 */
export function SegControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  variant = 'tonal',
  size = 'md',
  className,
}: SegControlProps<T>) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([])

  /** Move selection+focus to the next non-disabled option from `start` in `dir`. */
  const step = (start: number, dir: 1 | -1) => {
    const n = options.length
    for (let i = 1; i <= n; i++) {
      const j = (start + dir * i + n * i) % n
      if (!options[j]?.disabled) {
        onChange(options[j].value)
        btnRefs.current[j]?.focus()
        return
      }
    }
  }

  const edge = (dir: 1 | -1) => {
    const order = dir === 1 ? [...options.keys()] : [...options.keys()].reverse()
    for (const j of order) {
      if (!options[j]?.disabled) {
        onChange(options[j].value)
        btnRefs.current[j]?.focus()
        return
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault()
        step(idx, 1)
        break
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault()
        step(idx, -1)
        break
      case 'Home':
        e.preventDefault()
        edge(1)
        break
      case 'End':
        e.preventDefault()
        edge(-1)
        break
      default:
        break
    }
  }

  const cls = [
    'ui-seg',
    variant === 'accent' ? 'ui-seg--accent' : 'ui-seg--tonal',
    size === 'sm' ? 'ui-seg--sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} role="radiogroup" aria-label={ariaLabel}>
      {options.map((o, idx) => {
        const selected = o.value === value
        return (
          <button
            key={String(o.value)}
            ref={(el) => {
              btnRefs.current[idx] = el
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            title={o.title}
            className="ui-seg-btn"
            onClick={() => !o.disabled && onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, idx)}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
