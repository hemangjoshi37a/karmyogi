import type { IDockviewPanelProps } from 'dockview'

interface PlaceholderParams {
  title?: string
  note?: string
}

/**
 * Generic stand-in panel used in Phase 0 to prove docking/floating/resizing.
 * Real panels (Controller, Console, Program, CAD/CAM, …) replace these as the
 * corresponding workstreams land.
 */
export function PlaceholderPanel(props: IDockviewPanelProps<PlaceholderParams>) {
  const { title, note } = props.params ?? {}
  return (
    <div className="panel-body">
      <h3>{title ?? props.api?.title ?? 'Panel'}</h3>
      <p style={{ color: 'var(--fg-muted)' }}>
        {note ?? 'Placeholder panel — drag the tab, drag the border to resize, or float it.'}
      </p>
    </div>
  )
}
