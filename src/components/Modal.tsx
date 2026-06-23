import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { useT } from '../i18n'
import { Icon } from './Icons'

/** Canonical modal width scale (§2.8 Modal row). */
export type ModalSize = 'sm' | 'md' | 'lg' | 'xl'

/** size enum → max-width in px (§2.8: 460 / 620 / 780 / 960). */
const SIZE_PX: Record<ModalSize, number> = {
  sm: 460,
  md: 620,
  lg: 780,
  xl: 960,
}

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /**
   * Canonical size step (§2.8). Prefer this over `width`.
   * Defaults to `lg` (780px) so existing callers that relied on the old 780px
   * default are unaffected.
   */
  size?: ModalSize
  /**
   * Explicit max width in px. Backward-compatible escape hatch — when given it
   * overrides `size`, so every existing `width={…}` caller keeps its exact width.
   */
  width?: number
  /**
   * Small eyebrow/overline above the title (e.g. a context label). Optional.
   */
  eyebrow?: ReactNode
  /**
   * Sticky footer content. Per §2.8 the footer aligns secondary/ghost actions to
   * the LEFT and the primary action to the RIGHT. Pass the buttons in DOM order;
   * a `<span className="km-modal-foot-gap" />` (or the auto gap) separates the
   * left cluster from the right. When omitted, no footer renders.
   */
  footer?: ReactNode
  /**
   * Remove the default body padding (`--sp-5`) for panels that supply their own
   * gutters (e.g. an embedded full-bleed panel). Maps to the `--flush` modifier.
   */
  flushBody?: boolean
  /**
   * Explicit element to receive focus on open (W-N e). When the dialog's first
   * focusable control is DESTRUCTIVE (e.g. a Delete/Disconnect button), pass a
   * ref to a non-destructive target — typically the dialog title/body or a
   * benign control — so a keyboard/screen-reader user doesn't land on the
   * destructive action. When omitted (the default) focus moves to the first
   * focusable element as before, so existing callers are unchanged.
   */
  initialFocusRef?: RefObject<HTMLElement | null>
}

/**
 * Live `prefers-reduced-motion: reduce` flag. Used to disable the modal's inline
 * enter-transition styles (which would otherwise override the CSS reduced-motion
 * gate, since inline styles win on specificity).
 */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduce(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduce
}

/**
 * Footer spacer — drop this between the left (secondary/ghost) and right
 * (primary) clusters of a Modal `footer` to push the primary action to the
 * right edge (§2.8: secondary LEFT, primary RIGHT). Pure layout, no chrome.
 */
export function ModalFootSpacer() {
  return <span className="km-modal-foot-spacer" style={{ flex: '1 1 auto' }} aria-hidden="true" />
}

/** Selector for the tabbable elements we trap focus among. */
const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Generic centered modal/dialog with overlay.
 *
 * Chrome (§2.8 Modal row):
 *  • size scale sm/md/lg/xl (460/620/780/960) via `size`; `width` still overrides.
 *  • body padding `--sp-5` (a `flushBody` modifier removes it for self-padded panels).
 *  • title at `--fs-title` with an optional `eyebrow` slot above it.
 *  • optional sticky FOOTER (secondary/ghost LEFT, primary RIGHT, gap `--sp-3`).
 *  • 28px square icon close button.
 *  • enter transition (scrim fade + panel scale .98→1) behind the reduced-motion
 *    gate in globals.css (keyed on `.km-modal-scrim` / `.km-modal[data-enter]`).
 *
 * Accessibility (launch defect fixes — preserved):
 *  • Escape-to-close (keydown captured on the dialog, not the window, so a
 *    nested popup can stopPropagation if it needs Esc first).
 *  • Focus trap — Tab / Shift+Tab cycle ONLY within the dialog while open.
 *  • Initial focus moves into the dialog on open; focus RETURNS to the element
 *    that had it before opening, when the dialog closes (so keyboard users don't
 *    get dumped at the top of the page).
 */
export function Modal({
  open,
  title,
  onClose,
  children,
  size = 'lg',
  width,
  eyebrow,
  footer,
  flushBody = false,
  initialFocusRef,
}: ModalProps) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element focused right before the dialog opened — restored on close.
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()
  // Drives the enter transition: false on the first painted frame, flipped true
  // on the next frame so the scrim fades + the panel scales .98→1.
  const [entered, setEntered] = useState(false)
  // Honor prefers-reduced-motion: when set we skip the scale/opacity easing
  // entirely (the inline transition styles would otherwise out-specify the
  // globals.css reduced-motion gate). Tracked live so a mid-session OS change
  // is respected on the next open.
  const reduceMotion = useReducedMotion()

  const maxWidth = width ?? SIZE_PX[size]

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    // Remember where focus was so we can return it on close.
    restoreRef.current = (document.activeElement as HTMLElement) ?? null

    // Move focus into the dialog: an explicit initial-focus target if given
    // (W-N e — used when the first focusable control is destructive, so we
    // don't auto-focus it), else the first focusable element, else the dialog.
    const focusables = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    const explicit = initialFocusRef?.current
    if (explicit && dialog?.contains(explicit)) {
      explicit.focus()
    } else {
      const first = focusables()[0]
      ;(first ?? dialog)?.focus()
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab') return
      // Focus trap: keep Tab cycling inside the dialog.
      const items = focusables()
      if (items.length === 0) {
        e.preventDefault()
        dialog?.focus()
        return
      }
      const firstEl = items[0]
      const lastEl = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey) {
        if (active === firstEl || !dialog?.contains(active)) {
          e.preventDefault()
          lastEl.focus()
        }
      } else {
        if (active === lastEl || !dialog?.contains(active)) {
          e.preventDefault()
          firstEl.focus()
        }
      }
    }

    dialog?.addEventListener('keydown', onKey)
    return () => {
      dialog?.removeEventListener('keydown', onKey)
      // Return focus to the opener (if it's still in the DOM and focusable).
      const el = restoreRef.current
      if (el && document.contains(el)) {
        try {
          el.focus()
        } catch {
          /* element may no longer be focusable — ignore */
        }
      }
    }
  }, [open, onClose, initialFocusRef])

  // Run the enter transition once per open: paint at the "from" state, then flip
  // to the "to" state on the next frame. Reset when the dialog closes.
  useEffect(() => {
    if (!open) {
      setEntered(false)
      return
    }
    const raf = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(raf)
  }, [open])

  if (!open) return null

  // Inline enter-transition styles. The modal chrome stylesheet is owned
  // elsewhere, so the scrim-fade + panel scale(.98→1) live here as tokenized
  // inline rules. Under prefers-reduced-motion we render straight at the final
  // state with NO transition (inline styles out-specify the globals.css gate, so
  // we must gate them in JS too).
  const animate = entered || reduceMotion
  const scrimStyle: CSSProperties = {
    opacity: animate ? 1 : 0,
    transition: reduceMotion ? 'none' : 'opacity var(--dur-mid) var(--ease)',
  }
  const panelStyle: CSSProperties = {
    maxWidth,
    opacity: animate ? 1 : 0,
    transform: animate ? 'scale(1)' : 'scale(0.98)',
    transition: reduceMotion
      ? 'none'
      : 'transform var(--dur-mid) var(--ease), opacity var(--dur-mid) var(--ease)',
  }
  const bodyStyle: CSSProperties = flushBody ? {} : { padding: 'var(--sp-5)' }
  // Sticky footer: a single row that aligns secondary/ghost actions LEFT and the
  // primary action RIGHT (§2.8). Callers pass buttons in DOM order; wrapping the
  // children in a flex row with `justify-content: flex-end` plus an auto-margin
  // separator handled by the caller (or simply: primary last). We use a flex row
  // with `gap` and let callers rely on a `.km-modal-foot-spacer` to split sides.
  const footStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 'var(--sp-3)',
    flexWrap: 'wrap',
    padding: 'var(--sp-4) var(--sp-5)',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg-elev)',
    position: 'sticky',
    bottom: 0,
    zIndex: 1,
  }

  return (
    <div
      className="km-modal-overlay km-modal-scrim"
      onClick={onClose}
      role="presentation"
      style={scrimStyle}
    >
      <div
        ref={dialogRef}
        className="km-modal"
        style={panelStyle}
        data-enter={entered ? '' : undefined}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="km-modal-head">
          <div
            className="km-modal-titlewrap"
            style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}
          >
            {eyebrow != null && (
              <span
                className="km-modal-eyebrow"
                style={{
                  fontSize: 'var(--fs-section)',
                  fontWeight: 'var(--fw-label)',
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                  color: 'var(--fg-muted)',
                  lineHeight: 'var(--lh-tight)',
                }}
              >
                {eyebrow}
              </span>
            )}
            <span className="km-modal-title" id={titleId}>
              {title}
            </span>
          </div>
          <button
            className="km-modal-close"
            onClick={onClose}
            aria-label={t('ui.close', 'Close')}
            title={t('ui.close.esc', 'Close (Esc)')}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className={`km-modal-body${flushBody ? ' km-modal-body--flush' : ''}`} style={bodyStyle}>
          {children}
        </div>
        {footer != null && (
          <footer className="km-modal-foot" style={footStyle}>
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}
