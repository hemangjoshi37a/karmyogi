import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/theme.css'
import './styles/globals.css'
import './styles/ui-kit.css'
import './styles/ui-seg.css'
import './styles/slider-row.css'
import 'dockview/dist/styles/dockview.css'

// Silence ONE known-benign upstream deprecation: @react-three/fiber constructs
// `THREE.Clock` internally (three.js r0.184 deprecated Clock in favour of Timer),
// so r3f logs this on every Canvas mount. Our code never uses THREE.Clock — there
// is nothing to fix here; the warning disappears when r3f migrates to Timer. We
// match ONLY this exact message so every other warning still surfaces. Remove once
// @react-three/fiber drops its THREE.Clock usage.
{
  const nativeWarn = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    const first = args[0]
    if (typeof first === 'string' && first.includes('THREE.Clock') && first.includes('deprecated')) return
    nativeWarn(...args)
  }
}

// PROD self-heal for a stale app shell.
//
// Panels are lazy-imported. After a deploy, a client still running the previous
// shell asks for chunk URLs from that older build; if any of them cannot be
// loaded as a module the panel dies with "Failed to fetch dynamically imported
// module" and the tab is simply broken until the user clears the site data —
// which no operator should have to know how to do. Vite fires `vite:preloadError`
// for exactly this, so reload once to pick up the current shell (and its correct
// chunk names). The sessionStorage guard makes it strictly one attempt, so a
// genuinely missing chunk can never become a reload loop.
if (!import.meta.env.DEV) {
  const RELOAD_FLAG = 'km-chunk-reload'
  window.addEventListener('vite:preloadError', (e) => {
    if (sessionStorage.getItem(RELOAD_FLAG)) return // already tried — let it surface
    e.preventDefault() // we are handling it: reload instead of an unhandled rejection
    sessionStorage.setItem(RELOAD_FLAG, '1')
    console.warn('[karmyogi] stale chunk after a deploy — reloading once to update')
    window.location.reload()
  })
  // A clean load means the shell is current; allow one future attempt again.
  window.addEventListener('load', () => {
    setTimeout(() => sessionStorage.removeItem(RELOAD_FLAG), 5000)
  })
}

// DEV: kill any stale service worker (e.g. left over from a previous built/preview
// load) so the dev server's latest code is never shadowed by a cached app shell.
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
  navigator.serviceWorker
    .getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => {})
}

// Top-level ErrorBoundary: a last-resort catch so an unexpected render error
// shows a friendly, localized "reload" card instead of a blank white page.
// Per-panel boundaries (see panelRegistry.ts) contain most failures before they
// ever reach here.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
