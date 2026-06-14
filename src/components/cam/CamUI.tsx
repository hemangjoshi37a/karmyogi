import type { ReactNode } from 'react'
import '../../styles/cam.css'

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
        <span className="cam-status-sync" title="Auto-synced to the Program tab">
          → Program
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
