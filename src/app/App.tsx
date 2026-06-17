import { useEffect, useState } from 'react'
import { Shell } from './shell'
import { grbl } from '../serial/controller'
import { usePersistentState, useMachines } from '../store'
import { useMachineBridge } from '../machine/machineBridge'
import { AuthGate } from '../auth/AuthGate'
import { useActivityTracking } from '../track/useActivityTracking'
import { useAuth } from '../auth/authStore'
import { initDevLogs, setDevLogsContext } from '../integrations/devlogs'
import { AdminPage } from '../admin/AdminPage'
import { useLiveSync } from '../machine/liveSync'
import { useT, LANGUAGES } from '../i18n'
import { UndoRedoHotkeys } from '../components/UndoRedoHotkeys'
import { AiBubble } from '../components/AiBubble'

/** Shipped locale codes (English lives at the root, not under a prefix). */
const LOCALE_CODES = new Set(LANGUAGES.map((l) => l.code).filter((c) => c !== 'en'))

/**
 * Strip a leading per-locale URL prefix so route checks are language-agnostic:
 * `/hi/` → `/`, `/ar/admin` → `/admin`. These `/<code>/` prefixes are the
 * international-SEO landing URLs generated at build (see vite-i18n-seo.mjs);
 * the app renders the SAME workbench/admin at them, just in that language.
 */
function stripLocalePrefix(pathname: string): string {
  const m = /^\/([a-z]{2,4})(\/.*|)$/i.exec(pathname)
  if (m && LOCALE_CODES.has(m[1].toLowerCase())) return m[2] || '/'
  return pathname
}

/** True when the current path is the admin console (`/admin` or `/admin/...`). */
function isAdminPath(pathname: string): boolean {
  const p = stripLocalePrefix(pathname)
  return p === '/admin' || p.startsWith('/admin/')
}

/**
 * The app SPA serves exactly two client routes: the workbench at the root, and
 * the admin console at `/admin`. The production host (`public/_redirects`)
 * rewrites every path to `index.html`, so without this guard a bogus deep-link
 * like `/totally-made-up` would silently render the full app under a wrong URL
 * (bad for users AND for SEO — search engines would index duplicate pages). We
 * treat the root variants as valid and render a deliberate 404 for anything
 * else that isn't an `/admin` path.
 */
function isAppRoot(pathname: string): boolean {
  const p = stripLocalePrefix(pathname)
  return p === '/' || p === '' || p === '/index.html'
}

/** Localized "page not found" with a link back to the app. */
function NotFound() {
  const t = useT()
  return (
    <div
      role="main"
      style={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        textAlign: 'center',
        background: 'var(--bg, #14181c)',
        color: 'var(--fg, #e6e6e6)',
      }}
    >
      <div style={{ fontSize: 44, fontWeight: 700, color: 'var(--accent, #0e7c66)' }}>404</div>
      <h1 style={{ margin: 0, fontSize: 18 }}>{t('nf.title', 'Page not found')}</h1>
      <p style={{ margin: 0, maxWidth: 360, color: 'var(--fg-muted, #9aa0a6)', fontSize: 14 }}>
        {t('nf.body', 'The page you’re looking for doesn’t exist on karmyogi.')}
      </p>
      <a
        href="/"
        style={{
          marginTop: 6,
          padding: '8px 16px',
          borderRadius: 6,
          background: 'var(--accent, #0e7c66)',
          color: '#fff',
          textDecoration: 'none',
          fontSize: 14,
        }}
      >
        {t('nf.home', 'Go to karmyogi')}
      </a>
    </div>
  )
}

/**
 * Minimal client-side router (no router lib): tracks `location.pathname` and
 * re-renders on `popstate`. `navigate()` uses `history.pushState` + dispatches a
 * synthetic popstate so listeners stay in sync. Production SPA deep-links to
 * `/admin` work via the `/* /index.html 200` fallback in `public/_redirects`.
 */
export function navigate(path: string): void {
  if (typeof window === 'undefined' || window.location.pathname === path) return
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function usePathname(): string {
  const [path, setPath] = useState(
    typeof window !== 'undefined' ? window.location.pathname : '/',
  )
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  return path
}

export function App() {
  // Silently reconnect to a previously-authorized GRBL device on load
  // (Web Serial remembers granted ports — no user gesture needed). When the
  // Machine Farm has a last-active machine, prefer reconnecting to EXACTLY that
  // saved machine (by USB vendor/product) and carry its id/label so the link
  // re-binds to the same farm entry. The farm store is persisted + rehydrated at
  // import time, so its activeId is available synchronously here. We never show
  // the USB chooser — if nothing already-granted matches, autoConnect is a no-op.
  useEffect(() => {
    const { activeId, machines } = useMachines.getState()
    const active = activeId ? machines.find((m) => m.id === activeId) : undefined
    // Only serial farm entries are silently reconnectable by USB ids. (Mock isn't
    // a real device; WebSocket reconnect is handled by the farm/bridge; BLE needs
    // a fresh gesture.) For anything else, fall back to the plain auto-connect.
    const hint =
      active && active.kind === 'serial' && active.usbVendorId != null
        ? {
            usbVendorId: active.usbVendorId,
            usbProductId: active.usbProductId,
            machineId: active.id,
            label: active.label,
          }
        : undefined
    grbl.autoConnect(hint).catch(() => {})
  }, [])

  // Server bridge: opt-in (persisted, default OFF). Mounted at the shell level so
  // the relay runs regardless of which panel is open. The hook itself only
  // relays while enabled AND the machine is connected.
  const [bridgeEnabled] = usePersistentState('karmyogi.machineBridge.enabled', false)
  useMachineBridge(bridgeEnabled)

  // Central activity tracking (no-ops unless Firebase is configured + signed in).
  useActivityTracking()

  // dev-logs floating bug-report overlay (Ctrl+D). Injects only when an endpoint
  // is configured / available; hides gracefully otherwise. Publishes the current
  // user + lets reports be attributable.
  const user = useAuth((s) => s.user)
  useEffect(() => {
    initDevLogs()
  }, [])
  useEffect(() => {
    setDevLogsContext({ uid: user?.uid, email: user?.email })
  }, [user])

  // Live state sync + admin remote-assist executor (no-op unless configured +
  // signed in). It publishes throttled live machine + app state and runs the
  // admin command executor. Monitoring is DISCLOSED in the Terms of Service;
  // there is intentionally no on-screen per-session indicator.
  useLiveSync()

  const pathname = usePathname()

  // The /admin console is rendered OUTSIDE AuthGate's optional-open behavior so it
  // can always require sign-in (admin must be authenticated). AdminPage handles its
  // own sign-in / not-authorized / unconfigured states. Non-admin paths render the
  // normal gated Shell exactly as today.
  if (isAdminPath(pathname)) return <AdminPage />

  // Unknown path (not the app root, not /admin) → deliberate 404 instead of
  // silently rendering the full workbench under a wrong URL. Rendered OUTSIDE
  // AuthGate so it doesn't gate behind sign-in (a 404 should be public).
  if (!isAppRoot(pathname)) return <NotFound />

  // AuthGate wraps the whole UI. When Firebase is unconfigured its status is
  // 'disabled' → it renders the app fully open, exactly as today.
  return (
    <AuthGate>
      <UndoRedoHotkeys />
      <Shell />
      {/* Floating AI chat assistant — the AI G-code surface (replaces the old
          dock tab). Mounted globally so it floats over every panel. */}
      <AiBubble />
    </AuthGate>
  )
}
