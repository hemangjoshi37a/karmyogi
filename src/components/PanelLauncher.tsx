import { useEffect, useRef, useState } from 'react'
import { availablePanels, type PanelSpec } from '../app/panelRegistry'
import { PanelIcon } from '../app/panelIcons'
import { IconButton } from './IconButton'
import { useT } from '../i18n'

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
  const t = useT()
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
        label={t('launch.label', 'Open / reopen panels')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="launcher-popover" role="menu" aria-label={t('launch.title', 'Panels')}>
          <div className="launcher-head">{t('launch.title', 'Panels')}</div>
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
                  title={
                    isOpen
                      ? t('launch.focus', 'Focus {title}', { title: p.title })
                      : t('launch.open', 'Open {title}', { title: p.title })
                  }
                >
                  <PanelIcon id={p.id} size={15} className="launcher-item-ico" />
                  <span className="launcher-item-title">{p.title}</span>
                  <span className={isOpen ? 'launcher-dot open' : 'launcher-dot'} aria-hidden="true" />
                </button>
              )
            })}
            {/* The AI assistant is a floating bubble, not a dock panel — picking it
                just reveals the bubble. Listed here so it's reachable like a panel. */}
            <button
              role="menuitem"
              className="launcher-item launcher-item-ai"
              onClick={() => {
                window.dispatchEvent(new Event('karmyogi:openAiBubble'))
                setOpen(false)
              }}
              title={t('launch.openAi', 'Open the floating AI G-code assistant')}
            >
              <PanelIcon id="aigcode" size={15} className="launcher-item-ico" />
              <span className="launcher-item-title">{t('ai.bubble.menuItem', 'AI assistant')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
