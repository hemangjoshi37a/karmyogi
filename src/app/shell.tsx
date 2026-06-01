import { useCallback, useRef, useState } from 'react'
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewApi,
  type SerializedDockview,
} from 'dockview'
import { panelComponents, availablePanels, type PanelSpec } from './panelRegistry'
import { useSettings, useLayout } from '../store'
import { useIsMobile } from './useIsMobile'
import { MobileShell } from './MobileShell'
import { IconButton } from '../components/IconButton'
import { NotificationBell } from '../components/NotificationBell'
import { PanelLauncher } from '../components/PanelLauncher'
import { ConnectionControl } from '../components/ConnectionControl'
import { Modal } from '../components/Modal'
import { MotionPanel } from '../panels/MotionPanel'
import '../styles/topbar.css'
import '../styles/shell-extra.css'

// CAM-mode + utility panels that share the left group as tabs by default.
const LEFT_TABS = [
  { id: 'cadcam', title: '3D Carving' },
  { id: 'writing', title: 'Writing' },
  { id: 'soldering', title: 'Soldering' },
  { id: 'pcb', title: 'PCB' },
  { id: 'glue', title: 'Glue Dispense' },
  { id: 'pnp', title: 'Pick & Place' },
  { id: 'signature', title: 'Signature' },
  { id: 'print', title: '3D Printing' },
  { id: 'probe', title: 'Probe & Limits' },
  { id: 'camera', title: 'Camera' },
]

// Project links (the live app + its source). Used by the top-bar icon buttons
// and shared as the canonical repo URL.
const REPO_URL = 'https://github.com/hemangjoshi37a/karmyogi'
const ISSUES_URL = `${REPO_URL}/issues/new`
const openExternal = (url: string) => window.open(url, '_blank', 'noopener,noreferrer')

/** GitHub mark (inherits the button's text color via currentColor). */
function GitHubGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** Bug glyph for "report an issue". */
function BugGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2l1.5 2.5M16 2l-1.5 2.5" />
      <rect x="8" y="6" width="8" height="12" rx="4" />
      <path d="M12 6v12M3 9h3M3 14h3M3 19l3-2M18 9h3M18 14h3M18 19l-3-2M5 5l3 2.5M19 5l-3 2.5" />
    </svg>
  )
}

// Hand-tuned canonical workspace: LEFT column (Coordinates + all CAM/utility
// tabs), CENTER column split vertically (Visualizer on top, Program + Console
// below), RIGHT column (Controller). The `size` values encode the proportions;
// dockview scales them to fit any window, so the ratios — not the pixels — are
// what matter. This is what first-run AND the "Reset layout" button produce.
const DEFAULT_LAYOUT: SerializedDockview = {
  grid: {
    root: {
      type: 'branch',
      data: [
        {
          type: 'leaf',
          data: {
            views: ['coords', 'cadcam', 'writing', 'soldering', 'pcb', 'glue', 'pnp', 'signature', 'print', 'probe', 'camera'],
            activeView: 'coords',
            id: '1',
          },
          size: 323,
        },
        {
          type: 'branch',
          data: [
            { type: 'leaf', data: { views: ['visualizer'], activeView: 'visualizer', id: '2' }, size: 304 },
            {
              type: 'branch',
              data: [
                { type: 'leaf', data: { views: ['program'], activeView: 'program', id: '4' }, size: 390 },
                { type: 'leaf', data: { views: ['console'], activeView: 'console', id: '5' }, size: 315 },
              ],
              size: 305,
            },
          ],
          size: 705,
        },
        { type: 'leaf', data: { views: ['controller'], activeView: 'controller', id: '3' }, size: 338 },
      ],
      size: 609,
    },
    width: 1366,
    height: 609,
    orientation: 'HORIZONTAL' as SerializedDockview['grid']['orientation'],
  },
  panels: Object.fromEntries(
    availablePanels
      .filter((p) => p.id !== 'placeholder')
      .map((p) => [p.id, { id: p.id, contentComponent: p.component, title: p.title }]),
  ),
  activeGroup: '1',
}

function buildDefaultLayout(api: DockviewApi) {
  try {
    api.fromJSON(DEFAULT_LAYOUT)
    return
  } catch {
    // Fall back to a programmatic build if the serialized template ever fails
    // to deserialize (e.g. a panel id was renamed/removed).
    api.clear()
  }
  // Left group base: Coordinates.
  const coords = api.addPanel({ id: 'coords', component: 'coords', title: 'Coordinates' })
  // Center: Visualizer (right of the left group).
  const visualizer = api.addPanel({
    id: 'visualizer',
    component: 'visualizer',
    title: 'Visualizer',
    position: { referencePanel: coords.id, direction: 'right' },
  })
  // Right column: Controller (right of the Visualizer → far-right full-height column).
  api.addPanel({
    id: 'controller',
    component: 'controller',
    title: 'Controller',
    position: { referencePanel: visualizer.id, direction: 'right' },
  })
  // Center-bottom: Program below the Visualizer, Console to its right.
  const program = api.addPanel({
    id: 'program',
    component: 'program',
    title: 'Program',
    position: { referencePanel: visualizer.id, direction: 'below' },
  })
  api.addPanel({
    id: 'console',
    component: 'console',
    title: 'Console',
    position: { referencePanel: program.id, direction: 'right' },
  })
  // CAM/utility tabs join the left (Coordinates) group as tabs.
  for (const t of LEFT_TABS) {
    api.addPanel({
      id: t.id,
      component: t.id,
      title: t.title,
      position: { referencePanel: coords.id, direction: 'within' },
    })
  }
  coords.api.setActive()
}

export function Shell() {
  const apiRef = useRef<DockviewApi | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMobile = useIsMobile()
  const theme = useSettings((s) => s.theme)
  const toggleTheme = useSettings((s) => s.toggleTheme)
  const uiScale = useSettings((s) => s.uiScale)
  const zoomIn = useSettings((s) => s.zoomIn)
  const zoomOut = useSettings((s) => s.zoomOut)
  const resetZoom = useSettings((s) => s.resetZoom)
  const saveLayout = useLayout((s) => s.save)
  const resetLayout = useLayout((s) => s.reset)
  const [showMotion, setShowMotion] = useState(false)

  // Persist the dock layout automatically (debounced) on every change, so it
  // survives reloads AND browser close/open without a manual "save".
  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      if (apiRef.current) saveLayout(apiRef.current.toJSON())
    }, 500)
  }, [saveLayout])

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api
      const saved = useLayout.getState().load()
      let restored = false
      if (saved) {
        try {
          event.api.fromJSON(saved)
          restored = true
        } catch {
          /* incompatible saved layout → rebuild default */
        }
      }
      if (!restored) buildDefaultLayout(event.api)
      // Keep tab titles in sync with the registry, so renames (e.g. CAD/CAM →
      // 3D Carving) apply even to a restored saved layout.
      for (const spec of availablePanels) {
        event.api.getPanel(spec.id)?.api.setTitle(spec.title)
      }
      event.api.onDidLayoutChange(scheduleSave)
    },
    [scheduleSave],
  )

  const onReset = useCallback(() => {
    resetLayout()
    const api = apiRef.current
    if (!api) return
    api.clear()
    buildDefaultLayout(api)
  }, [resetLayout])

  const isPanelOpen = useCallback((id: string) => !!apiRef.current?.getPanel(id), [])

  const onOpenPanel = useCallback((panel: PanelSpec) => {
    const api = apiRef.current
    if (!api) return
    const existing = api.getPanel(panel.id)
    if (existing) {
      existing.api.setActive()
      return
    }
    api.addPanel({ id: panel.id, component: panel.component, title: panel.title, params: panel.params })
  }, [])

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          karm<span className="accent">yogi</span>
        </span>
        <span style={{ color: 'var(--fg-muted)' }}>GRBL workbench</span>
        <span className="brand-by">
          by <a href="https://hjLabs.in" target="_blank" rel="noopener noreferrer">hjLabs.in</a>
        </span>
        <span className="spacer" />
        <ConnectionControl />
        <span className="topbar-actions">
          <PanelLauncher onOpenPanel={onOpenPanel} isPanelOpen={isPanelOpen} />
          <IconButton icon="⚙" label="Motion / GRBL settings" onClick={() => setShowMotion(true)} />
          {!isMobile && <IconButton icon="↺" label="Reset dock layout to default" onClick={onReset} />}
          <span className="zoom-group" title="UI zoom">
            <IconButton icon="−" label="Zoom out" onClick={zoomOut} />
            <button onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom to 100%">
              {Math.round(uiScale * 100)}%
            </button>
            <IconButton icon="+" label="Zoom in" onClick={zoomIn} />
          </span>
          <NotificationBell />
          <IconButton
            icon={<GitHubGlyph />}
            label="View source on GitHub"
            onClick={() => openExternal(REPO_URL)}
          />
          <IconButton
            icon={<BugGlyph />}
            label="Report a bug (GitHub issues)"
            onClick={() => openExternal(ISSUES_URL)}
          />
          <IconButton
            icon={theme === 'dark' ? '☀' : '☾'}
            label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            onClick={toggleTheme}
          />
        </span>
      </header>
      {isMobile ? (
        <MobileShell />
      ) : (
        <div className="dock-host">
          <DockviewReact
            className="dockview-theme-karmyogi"
            components={panelComponents}
            onReady={onReady}
          />
        </div>
      )}
      <Modal open={showMotion} title="Motion / GRBL Settings" onClose={() => setShowMotion(false)}>
        <div style={{ height: '72vh' }}>
          <MotionPanel />
        </div>
      </Modal>
    </div>
  )
}
