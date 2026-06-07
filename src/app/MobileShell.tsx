import { useCallback, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { panelComponents, availablePanels } from './panelRegistry'
import { useT } from '../i18n'

/**
 * Mobile / narrow-viewport layout: the SAME panel components as the desktop
 * dockview layout, presented as a single full-height panel with a tab strip to
 * switch between them. Same content + controls as desktop → minimal learning
 * curve between the two form factors (see CLAUDE.md "Responsive UI").
 *
 * Tab labels are translated with the SAME contract as the desktop dock tabs:
 * `t('tab.' + p.id, p.title)`, so the mobile strip is localized exactly like
 * the desktop one (previously it rendered the raw English `p.title`).
 *
 * Accessibility: the strip is an ARIA tablist with roving-tabindex arrow-key
 * navigation (Left/Right/Home/End), and the content area is the matching
 * `role="tabpanel"` wired via `aria-controls`/`aria-labelledby`.
 */
export function MobileShell() {
  const t = useT()
  const [activeId, setActiveId] = useState(availablePanels[0]?.id ?? '')
  const active = availablePanels.find((p) => p.id === activeId) ?? availablePanels[0]
  const Component = active ? panelComponents[active.component] : undefined
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  // Minimal props shim so panel components render outside dockview. Panels read
  // `props.params` and optionally `props.api?.title`.
  const shimProps = {
    params: active?.params ?? {},
    api: { title: active?.title },
  } as unknown as IDockviewPanelProps

  const tabId = (id: string) => `mobile-tab-${id}`
  const panelDomId = 'mobile-tabpanel'

  // Roving-tabindex arrow-key navigation across the tab strip. Moving focus also
  // activates the tab (automatic activation) so the panel below follows along.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = availablePanels.findIndex((p) => p.id === activeId)
      if (idx < 0) return
      let next = idx
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (idx + 1) % availablePanels.length
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (idx - 1 + availablePanels.length) % availablePanels.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = availablePanels.length - 1
          break
        default:
          return
      }
      e.preventDefault()
      const nextId = availablePanels[next].id
      setActiveId(nextId)
      tabRefs.current[nextId]?.focus()
    },
    [activeId],
  )

  return (
    <div className="mobile-shell">
      <nav
        className="mobile-tabs"
        role="tablist"
        aria-label={t('mobile.panels', 'Panels')}
        aria-orientation="horizontal"
        onKeyDown={onKeyDown}
      >
        {availablePanels.map((p) => {
          const selected = p.id === activeId
          return (
            <button
              key={p.id}
              id={tabId(p.id)}
              ref={(el) => {
                tabRefs.current[p.id] = el
              }}
              role="tab"
              type="button"
              aria-selected={selected}
              aria-controls={panelDomId}
              // Roving tabindex: only the active tab is in the tab order; the
              // rest are reached via arrow keys.
              tabIndex={selected ? 0 : -1}
              className={selected ? 'mobile-tab active' : 'mobile-tab'}
              onClick={() => setActiveId(p.id)}
            >
              {t('tab.' + p.id, p.title)}
            </button>
          )
        })}
      </nav>
      <div
        className="mobile-panel"
        id={panelDomId}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={active ? tabId(active.id) : undefined}
      >
        {Component ? <Component {...shimProps} /> : null}
      </div>
    </div>
  )
}
