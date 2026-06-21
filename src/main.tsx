import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/theme.css'
import './styles/globals.css'
import './styles/ui-kit.css'
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
