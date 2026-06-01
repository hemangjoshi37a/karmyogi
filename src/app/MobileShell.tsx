import { useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { panelComponents, availablePanels } from './panelRegistry'

/**
 * Mobile / narrow-viewport layout: the SAME panel components as the desktop
 * dockview layout, presented as a single full-height panel with a tab strip to
 * switch between them. Same content + controls as desktop → minimal learning
 * curve between the two form factors (see CLAUDE.md "Responsive UI").
 */
export function MobileShell() {
  const [activeId, setActiveId] = useState(availablePanels[0]?.id ?? '')
  const active = availablePanels.find((p) => p.id === activeId) ?? availablePanels[0]
  const Component = active ? panelComponents[active.component] : undefined

  // Minimal props shim so panel components render outside dockview. Panels read
  // `props.params` and optionally `props.api?.title`.
  const shimProps = {
    params: active?.params ?? {},
    api: { title: active?.title },
  } as unknown as IDockviewPanelProps

  return (
    <div className="mobile-shell">
      <nav className="mobile-tabs" role="tablist" aria-label="Panels">
        {availablePanels.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={p.id === activeId}
            className={p.id === activeId ? 'mobile-tab active' : 'mobile-tab'}
            onClick={() => setActiveId(p.id)}
          >
            {p.title}
          </button>
        ))}
      </nav>
      <div className="mobile-panel">{Component ? <Component {...shimProps} /> : null}</div>
    </div>
  )
}
