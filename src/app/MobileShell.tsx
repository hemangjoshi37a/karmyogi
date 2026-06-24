import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { panelComponents, availablePanels } from './panelRegistry'
import { PanelIcon } from './panelIcons'
import { useT } from '../i18n'
import { usePersistentState } from '../store'

/**
 * Mobile / narrow-viewport layout: the SAME panel components as the desktop
 * dockview layout, presented as a single full-height panel with a tab strip to
 * switch between them. Same content + controls as desktop → minimal learning
 * curve between the two form factors (see CLAUDE.md "Responsive UI").
 *
 * The tab list is derived from `availablePanels` in the registry, so every
 * registered panel (Controller, Console, …, Screw Fitting, PCB, …) appears here
 * automatically — there is no hand-maintained mobile-only list to keep in sync.
 *
 * Parity with the desktop dock shell:
 *  - each tab has a close ✕ that HIDES it from the strip (persisted), mirroring
 *    dockview's tab-close affordance;
 *  - a "Panels" button opens a sheet listing ALL registered panels with their
 *    shown/hidden state — the mobile equivalent of the desktop PanelLauncher,
 *    built inline (no desktop import).
 *
 * Tab labels are translated with the SAME contract as the desktop dock tabs:
 * `t('tab.' + p.id, p.title)`, so the mobile strip is localized exactly like
 * the desktop one.
 *
 * Accessibility: the strip is an ARIA tablist with roving-tabindex arrow-key
 * navigation (Left/Right/Home/End), and the content area is the matching
 * `role="tabpanel"` wired via `aria-controls`/`aria-labelledby`. The Panels
 * sheet is a `role="dialog" aria-modal` with Esc-to-close, backdrop dismiss and
 * focus restored to the opener on close.
 */
export function MobileShell() {
  const t = useT()
  const [activeId, setActiveId] = useState(availablePanels[0]?.id ?? '')
  // Persisted set of HIDDEN tab ids. Stored as an array (JSON-friendly) and
  // looked up via a Set for cheap membership tests.
  const [hiddenTabs, setHiddenTabs] = usePersistentState<string[]>(
    'karmyogi.mobile.hiddenTabs',
    [],
  )
  const [sheetOpen, setSheetOpen] = useState(false)

  const hidden = useMemo(() => new Set(hiddenTabs), [hiddenTabs])
  const visiblePanels = useMemo(
    () => availablePanels.filter((p) => !hidden.has(p.id)),
    [hidden],
  )

  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const tabsRef = useRef<HTMLElement | null>(null)
  const panelsBtnRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)

  // If the active tab gets hidden (or was never visible), fall back to the first
  // still-visible tab so the panel area never goes blank.
  useEffect(() => {
    if (visiblePanels.length === 0) return
    if (!visiblePanels.some((p) => p.id === activeId)) {
      setActiveId(visiblePanels[0].id)
    }
  }, [visiblePanels, activeId])

  const active =
    visiblePanels.find((p) => p.id === activeId) ??
    visiblePanels[0] ??
    availablePanels[0]
  const Component = active ? panelComponents[active.component] : undefined

  // Minimal props shim so panel components render outside dockview. Panels read
  // `props.params` and optionally `props.api?.title`.
  const shimProps = {
    params: active?.params ?? {},
    api: { title: active?.title },
  } as unknown as IDockviewPanelProps

  const tabId = (id: string) => `mobile-tab-${id}`
  const panelDomId = 'mobile-tabpanel'

  // Keep the active tab centered in the (horizontally-scrolling) strip so a tab
  // selected beyond the visible edge is brought into view — pairing with the
  // edge-fade affordance in shell-extra.css (W-K). `inline:'center'` scrolls only
  // the strip, never the page; `block:'nearest'` avoids vertical jumps.
  useEffect(() => {
    const el = tabRefs.current[active?.id ?? '']
    el?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
  }, [active?.id])

  // Roving-tabindex arrow-key navigation across the VISIBLE tab strip. Moving
  // focus also activates the tab (automatic activation) so the panel below
  // follows along.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const list = visiblePanels
      if (list.length === 0) return
      const idx = list.findIndex((p) => p.id === active?.id)
      if (idx < 0) return
      let next = idx
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          next = (idx + 1) % list.length
          break
        case 'ArrowLeft':
        case 'ArrowUp':
          next = (idx - 1 + list.length) % list.length
          break
        case 'Home':
          next = 0
          break
        case 'End':
          next = list.length - 1
          break
        default:
          return
      }
      e.preventDefault()
      const nextId = list[next].id
      setActiveId(nextId)
      tabRefs.current[nextId]?.focus()
    },
    [visiblePanels, active?.id],
  )

  // Hide a tab. Never allow hiding the LAST visible tab — keep ≥1 so the strip
  // and panel area are never empty.
  const hideTab = useCallback(
    (id: string) => {
      if (visiblePanels.length <= 1) return
      setHiddenTabs((prev) => (prev.includes(id) ? prev : [...prev, id]))
    },
    [visiblePanels.length, setHiddenTabs],
  )

  const showTab = useCallback(
    (id: string) => setHiddenTabs((prev) => prev.filter((h) => h !== id)),
    [setHiddenTabs],
  )

  // ── Panels sheet ──────────────────────────────────────────────────────────
  const closeSheet = useCallback(() => {
    setSheetOpen(false)
    // Restore focus to the opener (a11y).
    panelsBtnRef.current?.focus()
  }, [])

  // Esc-to-close + initial focus into the sheet when it opens.
  useEffect(() => {
    if (!sheetOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSheet()
      }
    }
    document.addEventListener('keydown', onKey)
    // Move focus into the sheet so keyboard users land inside it.
    sheetRef.current?.focus()
    return () => document.removeEventListener('keydown', onKey)
  }, [sheetOpen, closeSheet])

  // Tapping a panel in the sheet: un-hide it (if hidden), activate it, close.
  const openPanel = useCallback(
    (id: string) => {
      showTab(id)
      setActiveId(id)
      closeSheet()
    },
    [showTab, closeSheet],
  )

  return (
    <div className="mobile-shell">
      <div className="mobile-tabbar">
        <button
          ref={panelsBtnRef}
          type="button"
          className="mobile-panels-btn"
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          aria-label={t('mobile.allPanels', 'All panels')}
          title={t('mobile.allPanels', 'All panels')}
          onClick={() => setSheetOpen(true)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <rect
              x="3"
              y="3"
              width="7"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <rect
              x="14"
              y="3"
              width="7"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <rect
              x="3"
              y="14"
              width="7"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <rect
              x="14"
              y="14"
              width="7"
              height="7"
              rx="1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
          </svg>
        </button>
        <nav
          ref={tabsRef}
          className="mobile-tabs"
          role="tablist"
          aria-label={t('mobile.panels', 'Panels')}
          aria-orientation="horizontal"
          onKeyDown={onKeyDown}
        >
          {visiblePanels.map((p) => {
            const selected = p.id === active?.id
            const label = t('tab.' + p.id, p.title)
            const canClose = visiblePanels.length > 1
            return (
              <div
                key={p.id}
                className={selected ? 'mobile-tab active' : 'mobile-tab'}
              >
                <button
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
                  className="mobile-tab-activate"
                  onClick={() => setActiveId(p.id)}
                >
                  <PanelIcon id={p.id} size={15} className="mobile-tab-ico" />
                  <span className="mobile-tab-label">{label}</span>
                </button>
                {canClose ? (
                  <button
                    type="button"
                    className="mobile-tab-close"
                    aria-label={t('mobile.hideTab', 'Hide {name}', { name: label })}
                    title={t('mobile.hideTab', 'Hide {name}', { name: label })}
                    tabIndex={selected ? 0 : -1}
                    onClick={(e) => {
                      // Don't activate the tab when closing it.
                      e.stopPropagation()
                      hideTab(p.id)
                    }}
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                    >
                      <path
                        d="M6 6l12 12M18 6L6 18"
                        stroke="currentColor"
                        strokeWidth="2.4"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                ) : null}
              </div>
            )
          })}
        </nav>
      </div>
      <div
        className="mobile-panel"
        id={panelDomId}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={active ? tabId(active.id) : undefined}
      >
        {Component ? <Component {...shimProps} /> : null}
      </div>

      {sheetOpen ? (
        <div
          className="mobile-sheet-overlay"
          onClick={(e) => {
            // Dismiss only when the backdrop itself (not the sheet) is tapped.
            if (e.target === e.currentTarget) closeSheet()
          }}
        >
          <div
            ref={sheetRef}
            className="mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-label={t('mobile.allPanels', 'All panels')}
            tabIndex={-1}
          >
            <div className="mobile-sheet-head">
              <span className="mobile-sheet-title">
                {t('mobile.allPanels', 'All panels')}
              </span>
              <button
                type="button"
                className="mobile-sheet-close"
                aria-label={t('common.close', 'Close')}
                title={t('common.close', 'Close')}
                onClick={closeSheet}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M6 6l12 12M18 6L6 18"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
            <ul className="mobile-sheet-list">
              {availablePanels.map((p) => {
                const label = t('tab.' + p.id, p.title)
                const isHidden = hidden.has(p.id)
                const isActive = p.id === active?.id
                const lastVisible = !isHidden && visiblePanels.length <= 1
                return (
                  <li key={p.id} className="mobile-sheet-row">
                    <button
                      type="button"
                      className={
                        isActive
                          ? 'mobile-sheet-item active'
                          : 'mobile-sheet-item'
                      }
                      aria-current={isActive ? 'true' : undefined}
                      onClick={() => openPanel(p.id)}
                    >
                      <PanelIcon
                        id={p.id}
                        size={18}
                        className="mobile-sheet-ico"
                      />
                      <span className="mobile-sheet-name">{label}</span>
                      {isHidden ? (
                        <span className="mobile-sheet-state">
                          {t('mobile.hidden', 'Hidden')}
                        </span>
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="mobile-sheet-toggle"
                      aria-pressed={!isHidden}
                      disabled={lastVisible}
                      aria-label={
                        isHidden
                          ? t('mobile.showTab', 'Show {name}', { name: label })
                          : t('mobile.hideTab', 'Hide {name}', { name: label })
                      }
                      title={
                        lastVisible
                          ? t('mobile.lastPanel', 'At least one panel must stay visible')
                          : isHidden
                            ? t('mobile.showTab', 'Show {name}', { name: label })
                            : t('mobile.hideTab', 'Hide {name}', { name: label })
                      }
                      onClick={() => (isHidden ? showTab(p.id) : hideTab(p.id))}
                    >
                      {isHidden ? (
                        // eye-off
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.4 5.2A9.3 9.3 0 0112 5c5 0 9 4.5 9 7 0 1-.7 2.3-1.9 3.5M6.1 6.1C3.7 7.6 3 9.6 3 12c0 .7 4 7 9 7 1.5 0 2.9-.4 4-1"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          />
                        </svg>
                      ) : (
                        // eye
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          aria-hidden="true"
                        >
                          <path
                            d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                          <circle
                            cx="12"
                            cy="12"
                            r="2.6"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          />
                        </svg>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}
