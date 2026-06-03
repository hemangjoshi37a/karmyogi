import { useEffect, type ReactNode } from 'react'
import { useT } from '../i18n'

interface ModalProps {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  /** Max width in px. */
  width?: number
}

/** Generic centered modal/dialog with overlay + Esc-to-close. */
export function Modal({ open, title, onClose, children, width = 780 }: ModalProps) {
  const t = useT()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="km-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="km-modal" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <header className="km-modal-head">
          <span className="km-modal-title">{title}</span>
          <button
            className="km-modal-close"
            onClick={onClose}
            aria-label={t('ui.close', 'Close')}
            title={t('ui.close.esc', 'Close (Esc)')}
          >
            ✕
          </button>
        </header>
        <div className="km-modal-body">{children}</div>
      </div>
    </div>
  )
}
