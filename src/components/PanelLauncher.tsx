import { useEffect, useRef, useState } from 'react'
import { availablePanels, type PanelSpec } from '../app/panelRegistry'
import { IconButton } from './IconButton'

interface PanelLauncherProps {
  /**
   * Open (or focus, if already open) the given panel. Implemented in the shell
   * against the live dockview API. Returns nothing — the shell decides add vs
   * focus based on whether the panel id is currently present.
   */
  onOpenPanel: (panel: PanelSpec) => void
  /** Predicate: is this panel id currently present in the dock? */
  isPanelOpen: (id: string) => boolean
}

/**
 * A "grid / + Panels" menu that lists every available panel. Picking one
 * reopens a closed dock (or focuses it if it's already open) via the shell's
 * dockview API handlers — this is how a user brings back a panel they closed.
 */
export function PanelLauncher({ onOpenPanel, isPanelOpen }: PanelLauncherProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="launcher" ref={wrapRef}>
      <IconButton
        icon="▦"
        label="Open / reopen panels"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="launcher-popover" role="menu" aria-label="Panels">
          <div className="launcher-head">Panels</div>
          <div className="launcher-list">
            {availablePanels.map((p) => {
              const isOpen = isPanelOpen(p.id)
              return (
                <button
                  key={p.id}
                  role="menuitem"
                  className="launcher-item"
                  onClick={() => {
                    onOpenPanel(p)
                    setOpen(false)
                  }}
                  title={isOpen ? `Focus ${p.title}` : `Open ${p.title}`}
                >
                  <span className="launcher-item-title">{p.title}</span>
                  <span className={isOpen ? 'launcher-dot open' : 'launcher-dot'} aria-hidden="true" />
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
