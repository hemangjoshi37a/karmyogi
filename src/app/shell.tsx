import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DockviewReact,
  DockviewDefaultTab,
  type DockviewReadyEvent,
  type DockviewApi,
  type IDockviewPanelHeaderProps,
  type SerializedDockview,
} from 'dockview'
import { panelComponents, availablePanels, type PanelSpec } from './panelRegistry'
import { PanelIcon } from './panelIcons'
import { useSettings, useLayout } from '../store'
import { useIsMobile } from './useIsMobile'
import { MobileShell } from './MobileShell'
import { IconButton } from '../components/IconButton'
import { NotificationBell } from '../components/NotificationBell'
import { PanelLauncher } from '../components/PanelLauncher'
import { LanguageSwitcher } from '../components/LanguageSwitcher'
import { ConnectionControl } from '../components/ConnectionControl'
import { UserChip } from '../auth/UserChip'
import { StorageGuard } from '../components/StorageGuard'
import { setActiveTab } from '../track/activity'
import { registerTabNav } from '../track/tabNav'
import { AboutModal } from '../components/AboutModal'
import { Icon } from '../components/Icons'
import { useMachine } from '../store'
import { useT } from '../i18n'
import { localizedTabTitles } from '../i18n/tabTitles'
import { Modal } from '../components/Modal'
import { MotionPanel } from '../panels/MotionPanel'
// Probe is rendered in a modal here AND still registered as a dock tab in
// panelRegistry.ts (the tab can be removed later — kept for now so Probe is
// reachable both ways). Do not remove the registry entry yet.
import { ProbePanel } from '../panels/ProbePanel'
import { PwaManager } from '../pwa/PwaManager'
import { BackGuard } from './BackGuard'
import '../styles/topbar.css'
import '../styles/shell-extra.css'

/**
 * Local inline-SVG glyphs for the TOP BAR only (the ones the shared `Icon` set
 * doesn't cover). Each is a 24×24, `currentColor`, stroke-based mark so it
 * recolors with the theme and stays crisp at any zoom — replacing the old emoji
 * glyphs (↺ − + ☀ ☾ ⋯ ✦ ⓘ) that rendered inconsistently across platforms.
 * Decorative: the wrapping button carries the title + aria-label.
 */
type GlyphProps = { size?: number }
const svgBase = (size: number) =>
  ({
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: 'false' as const,
  })

/** Reset layout — counter-clockwise refresh arrow. */
function ResetGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v4h4" />
    </svg>
  )
}
/** Zoom out — minus. */
function MinusGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M5 12h14" />
    </svg>
  )
}
/** Zoom in — plus. */
function PlusGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  )
}
/** Light theme — sun. */
function SunGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  )
}
/** Dark theme — moon. */
function MoonGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.6 6.6 0 0 0 21 12.8z" />
    </svg>
  )
}
/** Theme glyph by mode — sun when dark (switch to light), moon when light. */
function ThemeGlyph({ theme, size = 16 }: GlyphProps & { theme: 'dark' | 'light' }) {
  return theme === 'dark' ? <SunGlyph size={size} /> : <MoonGlyph size={size} />
}
/** Overflow "more" — horizontal dots. */
function MoreGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}
/** AI assistant — sparkle. */
function SparkleGlyph({ size = 16 }: GlyphProps) {
  return (
    <svg {...svgBase(size)}>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    </svg>
  )
}

// CAM-mode + utility panels that share the left group as tabs by default.
const LEFT_TABS = [
  { id: 'cadcam', title: '2D/3D Carving' },
  { id: 'writing', title: 'Writing' },
  { id: 'soldering', title: 'Soldering' },
  { id: 'screwfitting', title: 'Screw Fitting' },
  { id: 'drilling', title: 'Bore / Drill / Hole' },
  { id: 'pcb', title: 'PCB' },
  { id: 'glue', title: 'Glue Dispense' },
  { id: 'pnp', title: 'Pick & Place' },
  { id: 'signature', title: 'Signature' },
  { id: 'print', title: '3D Printing' },
  { id: 'laser', title: 'Laser Cutting' },
  { id: 'welding', title: 'Welding' },
  { id: 'camera', title: 'Camera' },
  { id: 'springcoiling', title: 'Spring Coiling' },
]

// Per-tab hover tooltips shown on the dock TAB name. The 2D/3D Carving tab
// carries the explainer that used to live as an InfoTip in the panel heading.
// Tabs without an entry fall back to their plain title.
const TAB_TOOLTIPS: Record<string, { key: string; en: string }> = {
  cadcam: {
    key: 'cc.introMulti',
    en: 'Import one or more STL models — each becomes a job that auto-nests on the bed and carves in a single combined program. DXF / vector files do 2D engrave · profile · pocket.',
  },
  pnp: {
    key: 'pnp.intro.tab',
    en: 'Move parts from a pick point to a place point — the head grabs with the spindle output (M3 on / M5 off). Build the operations; the program auto-syncs to the Visualizer and Program tab for streaming.',
  },
}

/** Dock tab = the default dockview tab + a native hover tooltip (per-panel explainer). */
function DockTab(props: IDockviewPanelHeaderProps) {
  const t = useT()
  // The panel's own title is kept localized via `setTitle(t('tab.'+id, …))`
  // (see the layout-ready / language-change effects below). `localizedTabTitles`
  // is wired in here so the static `tab.*` call sites in `TAB_TITLE_KEYS` stay
  // referenced (and thus extractable) — and it supplies the hover tooltip title
  // when a panel has no custom explainer.
  const titles = localizedTabTitles(t)
  const localizedTitle = titles[props.api.id] ?? props.api.title ?? ''
  const spec = TAB_TOOLTIPS[props.api.id]
  const tip = spec ? t(spec.key, spec.en) : localizedTitle
  return (
    <div className="dv-tab-tip" title={tip}>
      <PanelIcon id={props.api.id} size={13} className="dv-tab-ico" />
      <DockviewDefaultTab {...props} />
    </div>
  )
}

/**
 * Re-show the floating AI assistant bubble (it persists `closed` when the user
 * dismisses it). The bubble (mounted globally in App.tsx) listens for this
 * window event and clears its closed state — keeping the shell decoupled from
 * the bubble's internal store.
 */
function openAiBubble() {
  window.dispatchEvent(new Event('karmyogi:openAiBubble'))
}

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
            views: ['cadcam', 'writing', 'soldering', 'screwfitting', 'drilling', 'pcb', 'glue', 'pnp', 'signature', 'print', 'laser', 'welding', 'camera', 'springcoiling'],
            activeView: 'cadcam',
            id: '1',
          },
          // The 2D/3D Carving panel is the most content-dense (preset rail + two
          // split sections + param cards), so it gets a wider default column.
          size: 430,
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
          size: 598,
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
  // Left group base: the first CAM/utility tab (2D/3D Carving).
  const [first, ...rest] = LEFT_TABS
  const base = api.addPanel({ id: first.id, component: first.id, title: first.title })
  // Center: Visualizer (right of the left group).
  const visualizer = api.addPanel({
    id: 'visualizer',
    component: 'visualizer',
    title: 'Visualizer',
    position: { referencePanel: base.id, direction: 'right' },
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
  // The remaining CAM/utility tabs join the left group as tabs.
  for (const t of rest) {
    api.addPanel({
      id: t.id,
      component: t.id,
      title: t.title,
      position: { referencePanel: base.id, direction: 'within' },
    })
  }
  base.api.setActive()
}

// Force the panel that is ACTIVE immediately after a layout is applied to mount
// right away. dockview's default 'onlyWhenVisible' renderer mounts a panel on an
// activation CHANGE — but the panel that is active straight after fromJSON()/build
// (default: 2D/3D Carving) never received a change event, so it renders BLANK until
// the user switches to another tab and back. Switching it to the 'always' renderer
// mounts it unconditionally (same mechanism the camera panel uses), and as a bonus
// preserves that tab's state across later tab switches. Best-effort: older dockview
// without per-panel renderers simply keeps the old behavior.
function forceActivePanelMount(api: DockviewApi) {
  try {
    api.activePanel?.api.setRenderer?.('always')
  } catch {
    /* older dockview — no per-panel renderer */
  }
}

export function Shell() {
  const apiRef = useRef<DockviewApi | null>(null)
  const dockHostRef = useRef<HTMLDivElement | null>(null)
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
        // Auto-open a LEFT tab that is missing from the restored layout ONLY when
        // it is genuinely NEW in this app version — never one the user closed on
        // purpose. `seen` is the registry the user was last shown: a missing tab
        // whose id is in `seen` was closed deliberately (leave it closed); one not
        // in `seen` shipped since their last visit (surface it once). When there's
        // no record yet (null — a layout saved before this feature), trust the
        // restored layout as-is so we don't re-open everything on the first load.
        const seen = useLayout.getState().loadSeen()
        if (seen !== null) {
          const seenSet = new Set(seen)
          const anchor = event.api.getPanel(
            LEFT_TABS.find((tt) => event.api.getPanel(tt.id))?.id ?? '',
          )
          for (const tab of LEFT_TABS) {
            if (event.api.getPanel(tab.id)) continue // already open
            if (seenSet.has(tab.id)) continue // user closed it on purpose → keep closed
            event.api.addPanel({
              id: tab.id,
              component: tab.id,
              title: tab.title,
              ...(anchor ? { position: { referencePanel: anchor.id, direction: 'within' as const } } : {}),
            })
          }
        }
      }
      // Record the full current registry as "seen" so closes stick from here on
      // and only genuinely-new tabs auto-open next time (covers both the restored
      // and the fresh-default path).
      useLayout.getState().saveSeen(availablePanels.map((p) => p.id))
      // Keep tab titles in sync with the registry AND translate them: each tab's
      // title comes from `t('tab.<id>', <English default>)`, so renames and the
      // active language both apply even to a restored saved layout.
      for (const spec of availablePanels) {
        event.api.getPanel(spec.id)?.api.setTitle(t('tab.' + spec.id, spec.title))
      }
      // Keep the CAMERA panel MOUNTED even when its tab isn't the active one, so a
      // running camera stream (and the <video> the 3D Visualizer textures the bed
      // from) survives switching to another tab. Otherwise dockview unmounts the
      // panel, the stream stops, and the live feed in the Visualizer goes dark.
      // The camera panel is lightweight (a video element + controls), so always-
      // mounting it is cheap — unlike the heavy 3D Visualizer, which stays
      // 'onlyWhenVisible'. Applied in all environments (the feed should persist
      // for everyone, not just dev). Best-effort: ignore if dockview rejects it.
      try {
        event.api.getPanel('camera')?.api.setRenderer?.('always')
      } catch {
        /* older dockview without per-panel renderer — feed just won't persist */
      }
      // Mount the initially-active tab (default: 2D/3D Carving) so it isn't blank
      // until the user switches away and back. See forceActivePanelMount above.
      forceActivePanelMount(event.api)
      event.api.onDidLayoutChange(scheduleSave)
      // Report the active tab to the activity tracker for per-tab dwell time.
      // (No-ops unless tracking is live.)
      setActiveTab(event.api.activePanel?.id)
      event.api.onDidActivePanelChange((panel) => setActiveTab(panel?.id))
      // Expose programmatic tab navigation (used by the gamepad's tab-switch
      // mode): focus a panel by id, and list the OPEN tabs in registry order so
      // cycling is stable regardless of the docked arrangement.
      registerTabNav({
        focus: (id) => event.api.getPanel(id)?.api.setActive(),
        list: () =>
          availablePanels.map((p) => p.id).filter((id) => !!event.api.getPanel(id)),
      })
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
    // The default build opens the canonical set — record it as "seen" so the
    // reconcile never re-opens these tabs after the user closes one post-reset.
    useLayout.getState().saveSeen(availablePanels.map((p) => p.id))
    // Re-mount the default-active tab + keep the camera feed alive after a reset
    // (onReady's setup only runs once, not on a manual reset).
    try {
      api.getPanel('camera')?.api.setRenderer?.('always')
    } catch {
      /* older dockview */
    }
    forceActivePanelMount(api)
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
      <header className="topbar" data-mobile={isMobile ? 'true' : undefined}>
        {/* Brand — clicking the logo/title opens the About modal (this replaces a
            separate ⓘ button, freeing app-bar space). The "by hjLabs.in · MIT
            License" credit is the hover tooltip; the clickable links live inside. */}
        <button
          type="button"
          className="brand brand-btn"
          title="About karmyogi — by hjLabs.in · MIT License"
          aria-label="About karmyogi (source, license, report a bug)"
          onClick={() => setShowAbout(true)}
        >
          <img
            className="brand-mark"
            src="/icon-mark.png"
            width={22}
            height={22}
            alt="karmyogi — meditating yogi mark"
          />
          <span className="brand-word">karm<span className="accent">yogi</span></span>
        </button>
        <span className="spacer" />
        {isMobile ? (
          /* Mobile: a tight, single-row action strip — notifications, one compact
             connection control (opens a sheet with the full ConnectionControl), and
             a "⋯" menu for everything secondary. Nothing wraps to a second row. */
          <span className="topbar-actions topbar-actions--mobile">
            <StorageGuard />
            <NotificationBell />
            <MobileConnectSheet
              onOpenSettings={() => setShowMotion(true)}
              onOpenProbe={() => setShowProbe(true)}
            />
            <MobileMore
              moreLabel={t('topbar.more', 'More')}
              zoomLabel={t('topbar.zoom', 'UI zoom')}
              themeLabel={
                theme === 'dark'
                  ? t('topbar.theme.light', 'Light theme')
                  : t('topbar.theme.dark', 'Dark theme')
              }
              aboutLabel={t('topbar.about', 'About karmyogi')}
              aiLabel={t('ai.bubble.reopen', 'Open the AI assistant')}
              theme={theme}
              uiScale={uiScale}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onResetZoom={resetZoom}
              onToggleTheme={toggleTheme}
              onAbout={() => setShowAbout(true)}
            />
          </span>
        ) : (
          <>
            <ConnectionControl
              onOpenSettings={() => setShowMotion(true)}
              onOpenProbe={() => setShowProbe(true)}
            />
            <span className="topbar-sep" aria-hidden="true" />
            {/* Action area, grouped into clusters separated by hairline dividers
                so the bar reads as information-architected, not a flat run of
                controls (W-G): [layout + zoom] │ [language + theme] │
                [status + account]. */}
            <span className="topbar-actions">
              <span className="topbar-group">
                <PanelLauncher onOpenPanel={onOpenPanel} isPanelOpen={isPanelOpen} />
                <IconButton icon={<ResetGlyph />} label="Reset dock layout to default" onClick={onReset} />
                <span className="zoom-group" title="UI zoom">
                  <IconButton icon={<MinusGlyph />} label="Zoom out" onClick={zoomOut} />
                  <button onClick={resetZoom} aria-label="Reset zoom" title="Reset zoom to 100%">
                    {Math.round(uiScale * 100)}%
                  </button>
                  <IconButton icon={<PlusGlyph />} label="Zoom in" onClick={zoomIn} />
                </span>
              </span>
              <span className="topbar-sep" aria-hidden="true" />
              <span className="topbar-group">
                <LanguageSwitcher />
                <IconButton
                  icon={<ThemeGlyph theme={theme} />}
                  label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                  onClick={toggleTheme}
                />
              </span>
              <span className="topbar-sep" aria-hidden="true" />
              {/* Storage-pressure guard (only appears when near-full), then the
                  notification bell, then the user profile last. */}
              <span className="topbar-group">
                <StorageGuard />
                <NotificationBell />
                <UserChip />
              </span>
            </span>
          </>
        )}
      </header>
      {isMobile ? (
        <MobileShell />
      ) : (
        <div className="dock-host" ref={dockHostRef}>
          <DockviewReact
            className="dockview-theme-karmyogi"
            components={panelComponents}
            defaultTabComponent={DockTab}
            onReady={onReady}
          />
        </div>
      )}
      <Modal
        open={showMotion}
        title="Motion Settings"
        onClose={() => setShowMotion(false)}
        size="lg"
        flushBody
      >
        {/* embedded → MotionPanel drops its own <h4> + sticky-toolbar treatment so
            the Modal's title is the ONLY title row (W-E double-header fix). The
            panel self-pads, so the Modal body runs flush. */}
        <div className="km-modal-pane">
          <MotionPanel embedded />
        </div>
      </Modal>
      <Modal open={showProbe} title="Probe & Limits" onClose={() => setShowProbe(false)}>
        <div className="km-modal-pane">
          <ProbePanel />
        </div>
      </Modal>
      <AboutModal
        open={showAbout}
        onClose={() => setShowAbout(false)}
        repoUrl={REPO_URL}
        issuesUrl={ISSUES_URL}
      />
      <PwaManager />
      <BackGuard />
    </div>
  )
}

/**
 * Small hook: close `open` on outside-click / Escape. Shared by the mobile
 * connect sheet and the "⋯" menu so they behave like the other top-bar popovers.
 */
function useDismissable(open: boolean, close: () => void) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) close()
    }
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
  return wrapRef
}

interface MobileConnectSheetProps {
  onOpenSettings: () => void
  onOpenProbe: () => void
}

/**
 * Mobile connection control: a compact pill (status dot + connection word + caret)
 * that opens a dropdown SHEET holding the full `ConnectionControl` stacked
 * vertically. This keeps the whole connect/firmware/Mock/Machines/Probe/Settings
 * feature set reachable on a phone WITHOUT spilling a row of buttons across the
 * top bar (the old layout wrapped onto 2–3 lines). Desktop is unaffected — it
 * still renders `ConnectionControl` inline.
 */
function MobileConnectSheet({ onOpenSettings, onOpenProbe }: MobileConnectSheetProps) {
  const t = useT()
  const connection = useMachine((s) => s.connection)
  const [open, setOpen] = useState(false)
  const wrapRef = useDismissable(open, useCallback(() => setOpen(false), []))

  return (
    <div className="km-mconn" ref={wrapRef}>
      <button
        className="km-mconn-trigger"
        data-conn={connection}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
        title={t('conn.connect.menu', 'Connect to the controller — USB, Wi-Fi, or Bluetooth')}
      >
        <span className="km-conn-dot" data-conn={connection} />
        <span className="km-mconn-label">{t(`conn.status.${connection}`, connection)}</span>
        <span className="km-mconn-caret" aria-hidden="true">
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {open && (
        <div className="km-mconn-sheet" role="dialog" aria-label={t('conn.connect.how', 'Connect to machine')}>
          <ConnectionControl onOpenSettings={onOpenSettings} onOpenProbe={onOpenProbe} />
        </div>
      )}
    </div>
  )
}

interface MobileMoreProps {
  moreLabel: string
  zoomLabel: string
  themeLabel: string
  aboutLabel: string
  aiLabel: string
  theme: 'dark' | 'light'
  uiScale: number
  onZoomIn: () => void
  onZoomOut: () => void
  onResetZoom: () => void
  onToggleTheme: () => void
  onAbout: () => void
}

/**
 * Mobile "⋯" menu for SECONDARY top-bar actions — language, account, theme,
 * About, and UI-zoom — as clear labelled rows. Keeping these in one menu lets the
 * mobile bar stay a tight 3-control strip (bell · connect · ⋯) that never wraps.
 * Closes on outside-click / Escape.
 */
function MobileMore({
  moreLabel,
  zoomLabel,
  themeLabel,
  aboutLabel,
  aiLabel,
  theme,
  uiScale,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onToggleTheme,
  onAbout,
}: MobileMoreProps) {
  const [open, setOpen] = useState(false)
  const wrapRef = useDismissable(open, useCallback(() => setOpen(false), []))

  return (
    <div className="topbar-overflow" ref={wrapRef}>
      <IconButton
        icon={<MoreGlyph />}
        label={moreLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <div className="topbar-more-pop" role="menu" aria-label={moreLabel}>
          <div className="topbar-more-row">
            <LanguageSwitcher />
          </div>
          {/* UserChip renders nothing when signed out on the gated app. */}
          <div className="topbar-more-user">
            <UserChip />
          </div>
          <button
            className="topbar-more-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              openAiBubble()
            }}
          >
            <span className="topbar-more-ico"><SparkleGlyph size={18} /></span>
            <span>{aiLabel}</span>
          </button>
          <button className="topbar-more-item" role="menuitem" onClick={onToggleTheme}>
            <span className="topbar-more-ico"><ThemeGlyph theme={theme} size={18} /></span>
            <span>{themeLabel}</span>
          </button>
          <button
            className="topbar-more-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              onAbout()
            }}
          >
            <span className="topbar-more-ico"><Icon name="info" size={18} /></span>
            <span>{aboutLabel}</span>
          </button>
          <div className="topbar-more-sep" />
          <div className="topbar-overflow-head">{zoomLabel}</div>
          <div className="topbar-overflow-zoom zoom-group">
            <IconButton icon={<MinusGlyph />} label="Zoom out" onClick={onZoomOut} />
            <button onClick={onResetZoom} aria-label="Reset zoom" title="Reset zoom to 100%">
              {Math.round(uiScale * 100)}%
            </button>
            <IconButton icon={<PlusGlyph />} label="Zoom in" onClick={onZoomIn} />
          </div>
        </div>
      )}
    </div>
  )
}
