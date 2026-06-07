import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import { useT } from '../i18n'

/**
 * Reliability hardening for a public, high-traffic launch.
 *
 * A single thrown error inside React's render tree unmounts the WHOLE tree and
 * leaves a blank white page. With ~18 CAM panels — many of which parse
 * user-supplied, untrusted files (DXF / STL / Gerber / Excellon) or spin up
 * WebGL + the OCCT WASM — one bad input must NOT take the entire SPA down.
 *
 * We therefore use TWO layers of this boundary:
 *   1. top-level around <App/> (in main.tsx) — last-resort catch so the page
 *      offers a reload instead of a white screen, and
 *   2. one per panel (in panelRegistry.ts) — so a crash is CONTAINED to the
 *      offending panel; every other panel keeps working and the user can simply
 *      reload just that one panel.
 *
 * The fallback UI is localized via `useT()`. Because a class component can't
 * call hooks, the visible fallback is a small functional sub-component
 * (`ErrorFallback`) that the class renders.
 */

interface ErrorFallbackProps {
  /** Short scope label, e.g. a panel title, shown in the heading when present. */
  scope?: string
  /** The caught error (its message is shown in a small <details>). */
  error: Error | null
  /** Remount just this boundary's subtree (e.g. reload one panel). */
  onReset: () => void
}

/**
 * The visible fallback. Kept deliberately tiny + dependency-light so it renders
 * even when the failure was something heavy (WebGL/WASM). Uses `t()` with inline
 * English fallbacks so it shows the right language without needing locale files
 * for the new keys yet.
 */
function ErrorFallback({ scope, error, onReset }: ErrorFallbackProps) {
  const t = useT()
  const reloadApp = () => {
    if (typeof window !== 'undefined') window.location.reload()
  }
  return (
    <div role="alert" style={S.root}>
      <div style={S.card}>
        <div aria-hidden="true" style={S.icon}>
          ⚠
        </div>
        <h3 style={S.title}>
          {scope
            ? t('err.panelTitle', '{scope} hit an error', { scope })
            : t('err.appTitle', 'Something went wrong')}
        </h3>
        <p style={S.msg}>
          {t(
            'err.body',
            'This part of karmyogi ran into a problem. Your machine connection and other panels are unaffected. You can reload just this panel, or reload the whole app.',
          )}
        </p>
        {error?.message ? (
          <details style={S.details}>
            <summary style={S.summary}>{t('err.details', 'Technical details')}</summary>
            <pre style={S.pre}>{error.message}</pre>
          </details>
        ) : null}
        <div style={S.actions}>
          <button type="button" style={{ ...S.btn, ...S.btnPrimary }} onClick={onReset}>
            {scope ? t('err.reloadPanel', 'Reload panel') : t('err.tryAgain', 'Try again')}
          </button>
          <button type="button" style={S.btn} onClick={reloadApp}>
            {t('err.reloadApp', 'Reload app')}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Inline styles (no external CSS dependency — the boundary must render even if a
 * stylesheet failed to load). Uses the app's CSS custom properties when present
 * with safe fallbacks, so it matches the active theme.
 */
const S: Record<string, CSSProperties> = {
  root: {
    height: '100%',
    width: '100%',
    minHeight: 120,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    boxSizing: 'border-box',
    overflow: 'auto',
    background: 'var(--bg, #14181c)',
    color: 'var(--fg, #e6e6e6)',
  },
  card: {
    maxWidth: 420,
    width: '100%',
    textAlign: 'center',
    background: 'var(--bg-elev, rgba(255,255,255,0.04))',
    border: '1px solid var(--border, rgba(255,255,255,0.12))',
    borderRadius: 10,
    padding: '20px 18px',
  },
  icon: { fontSize: 30, lineHeight: 1, marginBottom: 8, color: 'var(--warn, #e2b007)' },
  title: { margin: '0 0 8px', fontSize: 16, fontWeight: 600 },
  msg: { margin: '0 0 14px', fontSize: 13, lineHeight: 1.5, color: 'var(--fg-muted, #9aa0a6)' },
  details: { textAlign: 'left', margin: '0 0 14px', fontSize: 12 },
  summary: { cursor: 'pointer', color: 'var(--fg-muted, #9aa0a6)' },
  pre: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    margin: '8px 0 0',
    padding: 8,
    borderRadius: 6,
    background: 'rgba(0,0,0,0.25)',
    fontSize: 11,
    maxHeight: 160,
    overflow: 'auto',
  },
  actions: { display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' },
  btn: {
    appearance: 'none',
    border: '1px solid var(--border, rgba(255,255,255,0.18))',
    background: 'transparent',
    color: 'inherit',
    borderRadius: 6,
    padding: '8px 14px',
    fontSize: 13,
    cursor: 'pointer',
    minHeight: 36,
  },
  btnPrimary: {
    background: 'var(--accent, #0e7c66)',
    borderColor: 'var(--accent, #0e7c66)',
    color: '#fff',
  },
}

interface ErrorBoundaryProps {
  /** Subtree to protect. Optional only so `createElement(EB, { scope }, child)`
   * typechecks (children arrive as the third createElement arg). */
  children?: ReactNode
  /** Optional scope label (e.g. panel title) shown in the fallback heading. */
  scope?: string
  /** Optional override for the fallback UI. */
  fallback?: (error: Error | null, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Surface to the console for diagnostics; the dev-logs overlay / monitoring
    // already capture console errors, so we don't add another transport here.
    // eslint-disable-next-line no-console
    console.error(
      `[karmyogi] ErrorBoundary${this.props.scope ? ` (${this.props.scope})` : ''} caught:`,
      error,
      info.componentStack,
    )
  }

  reset = (): void => {
    this.setState({ hasError: false, error: null })
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback(this.state.error, this.reset)
      return <ErrorFallback scope={this.props.scope} error={this.state.error} onReset={this.reset} />
    }
    return this.props.children
  }
}
