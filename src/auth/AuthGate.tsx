import { useEffect, useState, type ReactNode } from 'react'
import { useAuth } from './authStore'
import { authRequired } from './firebase'
import { useT } from '../i18n'
import { AuthBackground } from './AuthBackground'
import { POLICIES, PoliciesModal, type Policy } from '../components/policies'
import { getFirstSeenAt, graceActive } from './graceGate'
import '../styles/auth.css'

/**
 * Wraps the whole app. Graceful degradation:
 *  - status 'disabled' (Firebase NOT configured) → render children (fully open,
 *    exactly as today). This is the live-app default until the user adds config.
 *  - status 'signedIn' → render children.
 *  - status 'loading'  → a small splash (only ever shown when configured).
 *  - status 'signedOut' → the branded Google sign-in screen.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuth((s) => s.status)
  const init = useAuth((s) => s.init)

  useEffect(() => {
    init()
    // Record the first-visit timestamp the moment the app first loads — even if
    // the visitor never signs in — so the free-explore window starts now.
    getFirstSeenAt()
  }, [init])

  if (status === 'disabled' || status === 'signedIn') return <>{children}</>
  // Optional mode (configured but VITE_AUTH_REQUIRED=false): keep the app open
  // even when signed out / still loading — sign-in is offered in the top bar.
  if (!authRequired()) return <>{children}</>
  // Free-explore grace window: a first-time visitor uses the WHOLE app (no
  // login) for the first few days. No banner — sign-in is offered as a small
  // icon button in the top bar (see UserChip).
  if (graceActive()) return <>{children}</>
  if (status === 'loading') return <AuthSplash />
  return <SignInScreen graceExpired />
}

function AuthSplash() {
  const t = useT()
  return (
    <div className="auth-gate auth-gate--splash">
      <AuthBackground />
      <div className="auth-splash-card">
        <div className="auth-brand auth-brand--lg">
          <img src="/icon-mark.png" width={36} height={36} alt="karmyogi logo" />
          <span className="auth-brand-word">
            karm<span className="accent">yogi</span>
          </span>
        </div>
        <div className="auth-spinner" role="status" aria-live="polite">
          <span className="auth-spinner-ring" />
          <span className="auth-sub">{t('auth.loading', 'Loading…')}</span>
        </div>
      </div>
    </div>
  )
}

/** Capabilities showcase — icon + short label + one line. */
function useFeatures() {
  const t = useT()
  return [
    {
      icon: <IconCube />,
      title: t('auth.feat.cadcam', '2D / 3D CAD/CAM'),
      desc: t(
        'auth.feat.cadcamDesc',
        'DXF · STL · STEP · OBJ → engrave, profile, pocket & 3D relief.',
      ),
    },
    {
      icon: <IconUsb />,
      title: t('auth.feat.serial', 'Web Serial control'),
      desc: t('auth.feat.serialDesc', 'Drive 3-axis GRBL over USB — no install, no server.'),
    },
    {
      icon: <IconLayers />,
      title: t('auth.feat.viz', 'Live 3D visualizer'),
      desc: t('auth.feat.vizDesc', 'Real-time toolpath & machine bed in 3D.'),
    },
    {
      icon: <IconBolt />,
      title: t('auth.feat.modes', 'Every fabrication mode'),
      desc: t(
        'auth.feat.modesDesc',
        'Carve, laser, plot, solder, PCB route, weld & 3D-print.',
      ),
    },
    {
      icon: <IconGrid />,
      title: t('auth.feat.firmware', 'Multi-firmware'),
      desc: t('auth.feat.firmwareDesc', 'GRBL, FluidNC, grblHAL, Marlin, Masso, Ruida.'),
    },
    {
      icon: <IconDock />,
      title: t('auth.feat.ui', 'Dockable & offline'),
      desc: t('auth.feat.uiDesc', 'Floatable panels, mobile-ready, installable PWA.'),
    },
  ]
}

function SignInScreen({ graceExpired }: { graceExpired?: boolean }) {
  const t = useT()
  const signIn = useAuth((s) => s.signInWithGoogle)
  const error = useAuth((s) => s.error)
  const features = useFeatures()
  // Policy acceptance is REQUIRED to sign in: the box is checked by default, and
  // unchecking it disables the sign-in button so the user can go no further. The
  // acceptance timestamp + policy version are recorded in Firestore on first
  // sign-in (see recordPolicyConsent in track/activity.ts) as legal evidence.
  const [accepted, setAccepted] = useState(true)
  const [openPolicy, setOpenPolicy] = useState<Policy | null>(null)
  return (
    <div className="auth-gate auth-gate--landing">
      <AuthBackground />
      <main className="auth-hero">
        {/* Left: the pitch + feature showcase */}
        <section className="auth-pitch">
          <header className="auth-lockup">
            <div className="auth-brand auth-brand--lg">
              <img src="/icon-mark.png" width={40} height={40} alt="karmyogi logo" />
              <span className="auth-brand-word">
                karm<span className="accent">yogi</span>
              </span>
            </div>
            <p className="auth-eyebrow">
              <span className="auth-eyebrow-dot" aria-hidden="true" />
              {t('auth.eyebrow', 'Browser-native CNC + CAD/CAM workbench')}
            </p>
          </header>
          <h1 className="auth-headline">
            {t('auth.headline', 'Your whole workshop, in one browser tab.')}
          </h1>
          <p className="auth-lede">
            {t(
              'auth.lede',
              'Design, simulate and run any 3-axis GRBL machine over USB — carving, laser, PCB, plotting, soldering and more. Nothing to install. Nothing to set up.',
            )}
          </p>
        </section>

        {/* Capability showcase — its own hero child so the layout can place it
            UNDER the pitch on desktop, but AFTER the sign-in card on mobile (so a
            returning user isn't forced to scroll past every feature to sign in). */}
        <ul className="auth-features">
          {features.map((f) => (
            <li className="auth-feature" key={f.title}>
              <span className="auth-feature-icon" aria-hidden="true">
                {f.icon}
              </span>
              <span className="auth-feature-text">
                <span className="auth-feature-title">{f.title}</span>
                <span className="auth-feature-desc">{f.desc}</span>
              </span>
            </li>
          ))}
        </ul>

        {/* Right: the sign-in card */}
        <section className="auth-card" aria-label={t('auth.title', 'Sign in to karmyogi')}>
          <div className="auth-card-glow" aria-hidden="true" />
          <h2 className="auth-title">{t('auth.title', 'Sign in to karmyogi')}</h2>
          <p className="auth-sub">
            {t('auth.subtitle', 'Sign in with Google to start making.')}
          </p>
          {graceExpired && (
            <p className="auth-grace-expired" role="status">
              {t('grace.expired', 'Your 5-day free trial has ended — sign in to continue.')}
            </p>
          )}
          <div className="auth-consent">
            <label className="auth-consent-check">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
                aria-label={t('auth.consent.label', 'I accept the policies')}
              />
              <span>
                {t(
                  'auth.consent.label',
                  'I have read and accept the policies below. Signing in records my acceptance.',
                )}
              </span>
            </label>
            <p className="auth-consent-links">
              {POLICIES.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && <span aria-hidden="true"> · </span>}
                  <button
                    type="button"
                    className="auth-policy-link"
                    onClick={() => setOpenPolicy(p)}
                  >
                    {t(p.titleKey, p.titleFallback)}
                  </button>
                </span>
              ))}
            </p>
          </div>
          <button
            className="auth-google-btn"
            onClick={() => {
              if (accepted) void signIn()
            }}
            disabled={!accepted}
            aria-label={t('auth.google', 'Sign in with Google')}
          >
            <GoogleG />
            <span>{t('auth.google', 'Sign in with Google')}</span>
          </button>
          {!accepted && (
            <p className="auth-consent-hint" role="status">
              {t('auth.consent.required', 'Accept the policies to continue.')}
            </p>
          )}
          {error && (
            <p className="auth-error" role="alert">
              {error}
            </p>
          )}
          <ul className="auth-trust">
            <li>
              <IconCheck /> {t('auth.trust.free', 'Free to use')}
            </li>
            <li>
              <IconCheck /> {t('auth.trust.noInstall', 'No download')}
            </li>
            <li>
              <IconCheck /> {t('auth.trust.private', 'Files stay on-device')}
            </li>
          </ul>
          <p className="auth-fineprint">
            {t(
              'auth.fineprint',
              'We record anonymous usage to improve karmyogi. No file contents are stored.',
            )}
          </p>
        </section>
      </main>
      {openPolicy && <PoliciesModal policy={openPolicy} onClose={() => setOpenPolicy(null)} />}
    </div>
  )
}

/* ---- Feature icons (inline, stroke-based, currentColor) ---- */
function IconCube() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 21 7v10l-9 5-9-5V7z" />
      <path d="M12 22V12M21 7l-9 5L3 7" />
    </svg>
  )
}
function IconUsb() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 21V4" />
      <path d="m8 7 4-4 4 4" />
      <path d="M12 14 7.5 11.5V9M12 11l4.5-2.5V6" />
      <circle cx="7.5" cy="8.5" r="1.4" />
      <rect x="14.6" y="4.4" width="3.6" height="3.6" rx="0.6" />
    </svg>
  )
}
function IconLayers() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3 9 5-9 5-9-5z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  )
}
function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2 4 14h7l-1 8 9-12h-7z" />
    </svg>
  )
}
function IconGrid() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  )
}
function IconDock() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M9 9h12" />
    </svg>
  )
}
function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m20 6-11 11-5-5" />
    </svg>
  )
}

/** The Google "G" mark (inline SVG so no asset dependency). */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  )
}
