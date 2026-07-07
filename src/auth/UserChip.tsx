import { useState, useEffect } from 'react'
import { useT } from '../i18n'
import { useAuth } from './authStore'
import { firebaseConfigured } from './firebase'
import { useNotifications } from '../store/notifications'
import '../styles/auth.css'

/**
 * Compact signed-in user affordance for the top bar: avatar + email with a
 * sign-out button. Renders NOTHING unless a user is actually signed in (so the
 * unconfigured / open app shows no chip), keeping the appbar untouched.
 */
export function UserChip() {
  const t = useT()
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const signOut = useAuth((s) => s.signOut)
  const signIn = useAuth((s) => s.signInWithGoogle)
  const prewarmSignIn = useAuth((s) => s.prewarmSignIn)
  const notify = useNotifications((s) => s.notify)
  // Google profile photos sometimes 403 (referrer) or otherwise fail to load;
  // track that so the avatar falls back to the initial instead of a broken-image
  // icon. Reset on a new photo URL (e.g. a different account signs in).
  const [avatarFailed, setAvatarFailed] = useState(false)
  useEffect(() => setAvatarFailed(false), [user?.photoURL])
  // In flight while the Google popup/redirect runs — disables the button so a
  // double-click can't cancel its own popup (auth/cancelled-popup-request).
  const [pending, setPending] = useState(false)
  // Warm the popup sign-in deps while the login button is showing, so the click
  // opens the popup within the user gesture (no cold firebase/auth import on click).
  useEffect(() => {
    if (firebaseConfigured() && (status === 'signedOut' || status === 'loading')) prewarmSignIn()
  }, [status, prewarmSignIn])
  // Sign-in click. When Firebase is configured, run the Google flow; when it's
  // NOT configured (status 'disabled'), the store's signIn is a no-op, so explain
  // how to enable it instead of leaving a dead button.
  const onLogin = async () => {
    if (!firebaseConfigured()) {
      notify(
        'info',
        t(
          'auth.notConfigured',
          "Sign-in isn't set up yet. Add your Firebase keys to .env.local (copy .env.example) and restart the dev server.",
        ),
      )
      return
    }
    if (pending) return
    setPending(true)
    try {
      await signIn()
    } finally {
      setPending(false)
    }
  }

  // Show the login button whenever the user is NOT signed in — including when
  // Firebase auth is UNCONFIGURED ('disabled'), so the affordance is always
  // visible in the app bar. (Previously 'disabled' hid it entirely.) When
  // unconfigured, clicking explains how to turn sign-in on; otherwise it runs the
  // Google flow.
  if (status === 'signedOut' || status === 'disabled') {
    return (
      <span className="km-userchip">
        <button
          type="button"
          className="km-userchip-avatarbtn km-userchip-login"
          onClick={onLogin}
          title={t('auth.google', 'Sign in with Google')}
          aria-label={t('auth.google', 'Sign in with Google')}
        >
          <svg
            width={18}
            height={18}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
        </button>
      </span>
    )
  }

  // Restoring the cached session: show a small circular spinner in the same
  // slot so the chip resolves in-place to the login button / avatar with no
  // layout shift / pop-in (matches the avatar/login footprint).
  if (status === 'loading' && firebaseConfigured()) {
    return (
      <span className="km-userchip">
        <span
          className="km-userchip-spinner"
          role="status"
          aria-label={t('auth.checking', 'Checking sign-in…')}
          aria-busy="true"
        />
      </span>
    )
  }

  if (status !== 'signedIn' || !user) return null

  const name = user.displayName || user.email || t('auth.user', 'Account')
  const avatar = user.photoURL && !avatarFailed ? (
    <img
      className="km-userchip-avatar"
      src={user.photoURL}
      alt=""
      width={26}
      height={26}
      // Google (lh3.googleusercontent.com) profile photos 403 when a referrer is
      // sent — drop it so they load; fall back to the initial if they still fail.
      referrerPolicy="no-referrer"
      onError={() => setAvatarFailed(true)}
    />
  ) : (
    <span className="km-userchip-avatar km-userchip-fallback" aria-hidden="true">
      {(name[0] ?? '?').toUpperCase()}
    </span>
  )

  // Compact circular avatar; hovering / focusing reveals a small popover with the
  // account identity and a sign-out button. Keeps the top bar tight (just a
  // circle) so nothing overflows the right edge.
  return (
    <span className="km-userchip">
      <button
        type="button"
        className="km-userchip-avatarbtn"
        aria-haspopup="menu"
        title={user.email ?? name}
        aria-label={name}
      >
        {avatar}
      </button>
      <div className="km-userchip-pop" role="menu">
        <div className="km-userchip-pop-id">
          {avatar}
          <span className="km-userchip-pop-text">
            <span className="km-userchip-pop-name">{name}</span>
            {user.email && user.email !== name && (
              <span className="km-userchip-pop-email">{user.email}</span>
            )}
          </span>
        </div>
        <button
          type="button"
          className="km-userchip-signout"
          onClick={() => void signOut()}
          title={t('auth.signOut', 'Sign out')}
        >
          <span aria-hidden="true">⎋</span> {t('auth.signOut', 'Sign out')}
        </button>
      </div>
    </span>
  )
}
