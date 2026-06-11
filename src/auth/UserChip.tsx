import { useT } from '../i18n'
import { useAuth } from './authStore'
import { firebaseConfigured } from './firebase'
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

  // Signed out (grace window OR optional mode): show a small circular login
  // icon button in the profile slot — sign-in is one tap away, no banner needed.
  if (status === 'signedOut' && firebaseConfigured()) {
    return (
      <span className="km-userchip">
        <button
          type="button"
          className="km-userchip-avatarbtn km-userchip-login"
          onClick={() => void signIn()}
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

  if (status !== 'signedIn' || !user) return null

  const name = user.displayName || user.email || t('auth.user', 'Account')
  const avatar = user.photoURL ? (
    <img className="km-userchip-avatar" src={user.photoURL} alt="" width={26} height={26} />
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
