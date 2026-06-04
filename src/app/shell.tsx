import { useCallback, useEffect, useRef, useState } from 'react'
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
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { ConnectionControl } from '../components/ConnectionControl'
import { AboutModal } from '../components/AboutModal'
import { useT } from '../i18n'
import { Modal } from '../components/Modal'
import { MotionPanel } from '../panels/MotionPanel'
// Probe is rendered in a modal here AND still registered as a dock tab in
// panelRegistry.ts (the tab can be removed later — kept for now so Probe is
// reachable both ways). Do not remove the registry entry yet.
import { ProbePanel } from '../panels/ProbePanel'
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
  { id: 'laser', title: 'Laser Cutting' },
  { id: 'welding', title: 'Welding' },
  { id: 'camera', title: 'Camera' },
]

// Project links (the live app + its source). Used by the top-bar icon buttons
// and shared as the canonical repo URL.
const REPO_URL = 'https://github.com/hemangjoshi37a/karmyogi'
const ISSUES_URL = `${REPO_URL}/issues/new`

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
            views: ['coords', 'cadcam', 'writing', 'soldering', 'pcb', 'glue', 'pnp', 'signature', 'print', 'laser', 'welding', 'camera'],
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
  const t = useT()
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
  const [showProbe, setShowProbe] = useState(false)
  const [showAbout, setShowAbout] = useState(false)

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
      // Reconcile a RESTORED layout against the current registry so the app can
      // gain/lose tabs across versions without the user having to "Reset layout"
      // (and lose their arrangement): drop panels whose id is no longer
      // registered (e.g. the removed Probe tab), and add newly-registered CAM
      // tabs (e.g. Laser/Welding) into the left group. A fresh default already
      // has the right set, so this only runs for a restored layout.
      if (restored) {
        const validIds = new Set(availablePanels.map((p) => p.id))
        for (const panel of [...event.api.panels]) {
          if (!validIds.has(panel.id)) event.api.removePanel(panel)
        }
        // Anchor new tabs to the left group (Coordinates), like the default build.
        const anchor =
          event.api.getPanel('coords') ??
          event.api.getPanel(LEFT_TABS.find((tt) => event.api.getPanel(tt.id))?.id ?? '')
        for (const tab of LEFT_TABS) {
          if (event.api.getPanel(tab.id)) continue
          event.api.addPanel({
            id: tab.id,
            component: tab.id,
            title: tab.title,
            ...(anchor ? { position: { referencePanel: anchor.id, direction: 'within' as const } } : {}),
          })
        }
      }
      // Keep tab titles in sync with the registry AND translate them: each tab's
      // title comes from `t('tab.<id>', <English default>)`, so renames and the
      // active language both apply even to a restored saved layout.
      for (const spec of availablePanels) {
        event.api.getPanel(spec.id)?.api.setTitle(t('tab.' + spec.id, spec.title))
      }
      event.api.onDidLayoutChange(scheduleSave)
      // Persist the reconciled layout so the add/remove sticks immediately.
      if (restored) scheduleSave()
    },
    [scheduleSave, t],
  )

  // Re-translate every open tab's title when the language changes (the `t`
  // identity changes with the active language, re-running this effect).
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    for (const spec of availablePanels) {
      api.getPanel(spec.id)?.api.setTitle(t('tab.' + spec.id, spec.title))
    }
  }, [t])

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
    api.addPanel({
      id: panel.id,
      component: panel.component,
      title: t('tab.' + panel.id, panel.title),
      params: panel.params,
    })
  }, [t])

  return (
    <div className="app-shell">
      <header className="topbar">
        <span className="brand">
          <img
            className="brand-mark"
            src="/icon-mark.png"
            width={22}
            height={22}
            alt="karmyogi — meditating yogi mark"
            title="karmyogi"
          />
          <span className="brand-word">karm<span className="accent">yogi</span></span>
        </span>
        <span style={{ color: 'var(--fg-muted)' }}>{t('app.subtitle', 'CAD/CAM workbench')}</span>
        <span className="brand-by">
          by <a href="https://hjLabs.in" target="_blank" rel="noopener noreferrer">hjLabs.in</a>
          {' · '}
          <a
            href={`${REPO_URL}/blob/main/LICENSE`}
            target="_blank"
            rel="noopener noreferrer"
            title="karmyogi is open source under the MIT License — view LICENSE on GitHub"
          >
            MIT
          </a>
        </span>
        <span className="spacer" />
        <ConnectionControl
          onOpenSettings={() => setShowMotion(true)}
          onOpenProbe={() => setShowProbe(true)}
        />
        <span className="topbar-actions">
          <PanelLauncher onOpenPanel={onOpenPanel} isPanelOpen={isPanelOpen} />
          {!isMobile && <IconButton icon="↺" label="Reset dock layout to default" onClick={onReset} />}
          <span className="zoom-group" title="UI zoom">
            <IconButton icon="−" label="Zoom out" onClick={zoomOut} />
            <button onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom to 100%">
              {Math.round(uiScale * 100)}%
            </button>
            <IconButton icon="+" label="Zoom in" onClick={zoomIn} />
          </span>
          <NotificationBell />
          <LanguageSwitcher />
          <IconButton
            icon="ⓘ"
            label="About karmyogi (source, license, report a bug)"
            onClick={() => setShowAbout(true)}
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
      <Modal open={showProbe} title="Probe & Limits" onClose={() => setShowProbe(false)}>
        <div style={{ height: '72vh' }}>
          <ProbePanel />
        </div>
      </Modal>
      <AboutModal
        open={showAbout}
        onClose={() => setShowAbout(false)}
        repoUrl={REPO_URL}
        issuesUrl={ISSUES_URL}
      />
    </div>
  )
}
