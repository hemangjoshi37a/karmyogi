import type { ReactNode } from 'react'
import { useT } from '../../i18n'
import '../../styles/cam.css'
import '../../styles/ui-kit.css'

/**
 * Shared CAM-panel UI primitives — one consistent look across every workbench
 * tab. Use these instead of bespoke per-panel markup so the status strip, empty
 * state, and section header read identically everywhere.
 */

/** One status pill: a value with an optional unit and leading label. */
export interface StatusItem {
  /** Leading muted label (optional), e.g. "free L". */
  label?: string
  /** The emphasized value, e.g. "27.0". */
  value: ReactNode
  /** Trailing unit/word (optional), e.g. "mm" / "points". */
  unit?: string
  /** Hover tooltip for the pill (optional). */
  title?: string
}

/**
 * The live status strip shown under a panel header: a row of pills plus an
 * optional "→ Program" synced badge. Mirrors the Spring/Soldering strip.
 */
export function CamStatus({ items, synced = true }: { items: StatusItem[]; synced?: boolean }) {
  const t = useT()
  return (
    <div className="cam-status">
      {items.map((it, i) => (
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && (
            <span className="cam-status-sep" aria-hidden="true">
              ·
            </span>
          )}
          <span className="cam-status-pill" title={it.title}>
            {it.label && <span>{it.label}</span>}
            <b>{it.value}</b>
            {it.unit && <span>{it.unit}</span>}
          </span>
        </span>
      ))}
      {synced && (
        <span
          className="cam-status-sync"
          title={t('cam.status.syncedTip', 'Auto-synced to the Program tab')}
        >
          → {t('cam.status.program', 'Program')}
        </span>
      )}
    </div>
  )
}

/**
 * A friendly empty state: a circular accent icon, a title, a one-line hint, and
 * an optional primary action. Replaces plain "nothing here yet" text.
 */
export function CamEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="cam-empty">
      <span className="cam-empty-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="cam-empty-title">{title}</span>
      {hint && <span className="cam-empty-hint">{hint}</span>}
      {action && <span className="cam-empty-action">{action}</span>}
    </div>
  )
}

/**
 * In-flight / busy state: a small accent spinner and a one-line label, for work
 * like a DXF/Gerber parse, a lens solve, or a stream start. The container is
 * marked `aria-busy` so assistive tech announces the wait. Mirrors the
 * <CamEmpty> rhythm so static-empty and busy states read as one kit.
 */
export function CamBusy({ label }: { label?: ReactNode }) {
  const t = useT()
  const text = label ?? t('cam.busy.label', 'Working…')
  return (
    <div className="cam-busy" aria-busy="true" role="status" aria-live="polite">
      <span className="cam-busy-spinner" aria-hidden="true" />
      <span className="cam-busy-label">{text}</span>
    </div>
  )
}

/**
 * Error state: a <CamEmpty> variant with a danger-tinted glyph, a message, and
 * an optional retry CTA. Use for a failed parse, a dropped serial connection
 * mid-stream, or a lost controller — anywhere a step failed and the user can
 * try again.
 */
export function CamError({
  icon,
  title,
  message,
  onRetry,
  retryLabel,
  action,
}: {
  /** Leading danger glyph (optional — falls back to "!"). */
  icon?: ReactNode
  title: string
  /** One-line explanation of what failed. */
  message?: string
  /** When provided, renders a built-in retry button wired to this handler. */
  onRetry?: () => void
  /** Label for the built-in retry button (default localized "Retry"). */
  retryLabel?: string
  /** A fully custom CTA, used instead of the built-in retry button. */
  action?: ReactNode
}) {
  const t = useT()
  return (
    <div className="cam-empty cam-error" role="alert">
      <span className="cam-empty-ico" aria-hidden="true">
        {icon ?? '!'}
      </span>
      <span className="cam-empty-title">{title}</span>
      {message && <span className="cam-empty-hint">{message}</span>}
      {action ? (
        <span className="cam-empty-action cam-error-retry">{action}</span>
      ) : onRetry ? (
        <span className="cam-empty-action cam-error-retry">
          <button type="button" onClick={onRetry}>
            {retryLabel ?? t('cam.error.retry', 'Retry')}
          </button>
        </span>
      ) : null}
    </div>
  )
}
