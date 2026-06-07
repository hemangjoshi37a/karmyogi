import { userLabel } from './format'

/** Round avatar: photo when available, else initials on a colored chip. */
export function Avatar({
  user,
  size = 32,
}: {
  user: { displayName: string | null; email: string | null; photoURL: string | null; uid: string }
  size?: number
}) {
  const label = userLabel(user)
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
  // Deterministic hue from uid.
  let h = 0
  for (const c of user.uid) h = (h * 31 + c.charCodeAt(0)) % 360
  if (user.photoURL) {
    return (
      <img
        className="admin-avatar"
        src={user.photoURL}
        width={size}
        height={size}
        alt={label}
        referrerPolicy="no-referrer"
      />
    )
  }
  return (
    <span
      className="admin-avatar admin-avatar-fallback"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `hsl(${h} 45% 30%)`,
      }}
      aria-label={label}
    >
      {initials || '?'}
    </span>
  )
}
