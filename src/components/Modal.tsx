import { useEffect, useId, useRef, type ReactNode } from 'react'
import { useT } from '../i18n'
import { Icon } from './Icons'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Max width in px. */
  width?: number
}

/** Selector for the tabbable elements we trap focus among. */
const FOCUSABLE =
  'a[href],area[href],button:not([disabled]),input:not([disabled]),' +
  'select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Generic centered modal/dialog with overlay.
 *
 * Accessibility (launch defect fixes):
 *  • Escape-to-close (keydown captured on the dialog, not the window, so a
 *    nested popup can stopPropagation if it needs Esc first).
 *  • Focus trap — Tab / Shift+Tab cycle ONLY within the dialog while open.
 *  • Initial focus moves into the dialog on open; focus RETURNS to the element
 *    that had it before opening, when the dialog closes (so keyboard users don't
 *    get dumped at the top of the page).
 */
export function Modal({ open, title, onClose, children, width = 780 }: ModalProps) {
  const t = useT()
  const dialogRef = useRef<HTMLDivElement>(null)
  // The element focused right before the dialog opened — restored on close.
  const restoreRef = useRef<HTMLElement | null>(null)
  const titleId = useId()

  useEffect(() => {
    if (!open) return
    const dialog = dialogRef.current
    // Remember where focus was so we can return it on close.
    restoreRef.current = (document.activeElement as HTMLElement) ?? null

    // Move focus into the dialog: first focusable element, else the dialog itself.
    const focusables = () =>
      Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      )
    const first = focusables()[0]
    ;(first ?? dialog)?.focus()

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
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="km-modal-overlay"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={dialogRef}
        className="km-modal"
        style={{ maxWidth: width }}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="km-modal-head">
          <span className="km-modal-title" id={titleId}>
            {title}
          </span>
          <button
            className="km-modal-close"
            onClick={onClose}
            aria-label={t('ui.close', 'Close')}
            title={t('ui.close.esc', 'Close (Esc)')}
          >
            <Icon name="close" size={15} />
          </button>
        </header>
        <div className="km-modal-body">{children}</div>
      </div>
    </div>
  )
}
