import { useT } from '../i18n'
import { useAuth } from './authStore'
import { authRequired, firebaseConfigured } from './firebase'
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

  // Optional mode (configured but sign-in not required): offer a compact
  // "Sign in" button in the bar when signed out, so tracking can be enabled.
  if (status === 'signedOut' && firebaseConfigured() && !authRequired()) {
    return (
      <button className="km-userchip-out km-userchip-signin" onClick={() => void signIn()}>
        {t('auth.signIn', 'Sign in')}
      </button>
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
