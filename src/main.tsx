import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './app/App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/theme.css'
import './styles/globals.css'
import 'dockview/dist/styles/dockview.css'

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
