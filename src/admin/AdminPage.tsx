import { useEffect, useState } from 'react'
import { useAuth } from '../auth/authStore'
import { firebaseConfigured, isAdmin, adminEmail } from '../auth/firebase'
import { useT } from '../i18n'
import { navigate } from '../app/App'
import { subscribeUsers, type AdminUser } from './adminData'
import { AdminDashboard } from './AdminDashboard'
import { AdminUsersTable } from './AdminUsersTable'
import { AdminUserDetail } from './AdminUserDetail'
import '../styles/admin.css'

type Tab = 'dashboard' | 'users'

/**
 * The /admin super-admin console. Self-contained gate:
 *  - Firebase unconfigured → "Configure Firebase first".
 *  - signed out → sign-in prompt.
 *  - signed in but not the admin email → "Not authorized".
 *  - admin → the console (real enforcement is firestore.rules).
 */
export function AdminPage() {
  const t = useT()
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.user)
  const signIn = useAuth((s) => s.signInWithGoogle)
  const init = useAuth((s) => s.init)
  const error = useAuth((s) => s.error)

  useEffect(() => {
    init()
  }, [init])

  if (!firebaseConfigured()) {
    return (
      <AdminShell>
        <Notice
          title={t('admin.unconfigured.title', 'Configure Firebase first')}
          body={t(
            'admin.unconfigured.body',
            'The admin console needs Firebase + Firestore configured (see .env). It is unavailable on the open, unconfigured build.',
          )}
        />
      </AdminShell>
    )
  }

  if (status === 'loading') {
    return (
      <AdminShell>
        <Notice title={t('admin.loading', 'Loading…')} body="" />
      </AdminShell>
    )
  }

  if (status !== 'signedIn' || !user) {
    return (
      <AdminShell>
        <div className="admin-notice">
          <h2>{t('admin.signin.title', 'Admin sign-in required')}</h2>
          <p>{t('admin.signin.body', 'Sign in with the admin Google account to continue.')}</p>
          <button className="admin-btn primary" onClick={() => void signIn()}>
            {t('auth.google', 'Sign in with Google')}
          </button>
          {error && <p className="admin-error">{error}</p>}
        </div>
      </AdminShell>
    )
  }

  if (!isAdmin(user)) {
    return (
      <AdminShell email={user.email}>
        <Notice
          title={t('admin.forbidden.title', 'Not authorized')}
          body={t(
            'admin.forbidden.body',
            'This account does not have admin access. Sign in as {email}.',
            { email: adminEmail() },
          )}
        />
      </AdminShell>
    )
  }

  return <AdminConsole adminUserEmail={user.email} />
}

function AdminConsole({ adminUserEmail }: { adminUserEmail: string | null }) {
  const t = useT()
  const [tab, setTab] = useState<Tab>('dashboard')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [dataError, setDataError] = useState<string | null>(null)
  const [selectedUid, setSelectedUid] = useState<string | null>(null)

  // Live subscription to the users collection (drives online status everywhere).
  useEffect(() => {
    let unsub = () => {}
    let alive = true
    void subscribeUsers(
      (list) => {
        if (alive) {
          setUsers(list)
          setDataError(null)
        }
      },
      (e) => {
        if (alive) setDataError(e.message === 'unconfigured' ? 'unconfigured' : e.message)
      },
    ).then((fn) => {
      if (alive) unsub = fn
      else fn()
    })
    return () => {
      alive = false
      unsub()
    }
  }, [])

  const selectedUser = users.find((u) => u.uid === selectedUid) ?? null

  return (
    <AdminShell email={adminUserEmail}>
      <nav className="admin-tabs">
        <button
          className={tab === 'dashboard' ? 'active' : ''}
          onClick={() => {
            setTab('dashboard')
            setSelectedUid(null)
          }}
        >
          {t('admin.tab.dashboard', 'Dashboard')}
        </button>
        <button
          className={tab === 'users' ? 'active' : ''}
          onClick={() => {
            setTab('users')
            setSelectedUid(null)
          }}
        >
          {t('admin.tab.users', 'Users')} <span className="admin-count">{users.length}</span>
        </button>
      </nav>

      {dataError === 'unconfigured' && (
        <Notice title={t('admin.unconfigured.title', 'Configure Firebase first')} body="" />
      )}
      {dataError && dataError !== 'unconfigured' && (
        <p className="admin-error">
          {t('admin.dataError', 'Could not load data: {msg}', { msg: dataError })}
        </p>
      )}

      {!dataError && selectedUser && (
        <AdminUserDetail user={selectedUser} onBack={() => setSelectedUid(null)} />
      )}
      {!dataError && !selectedUser && tab === 'dashboard' && (
        <AdminDashboard users={users} onOpenUser={(uid) => setSelectedUid(uid)} />
      )}
      {!dataError && !selectedUser && tab === 'users' && (
        <AdminUsersTable users={users} onOpenUser={(uid) => setSelectedUid(uid)} />
      )}
    </AdminShell>
  )
}

/** Shared chrome: branded header with a "back to app" link. */
function AdminShell({ children, email }: { children: React.ReactNode; email?: string | null }) {
  const t = useT()
  return (
    <div className="admin-root">
      <header className="admin-header">
        <div className="admin-brand">
          <img src="/icon-mark.png" width={24} height={24} alt="karmyogi" />
          <span className="admin-brand-word">
            karm<span className="accent">yogi</span> <span className="admin-tag">admin</span>
          </span>
        </div>
        <div className="admin-header-right">
          {email && <span className="admin-whoami">{email}</span>}
          <button className="admin-btn ghost" onClick={() => navigate('/')}>
            {t('admin.backToApp', 'Back to app')}
          </button>
        </div>
      </header>
      <main className="admin-main">{children}</main>
    </div>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="admin-notice">
      <h2>{title}</h2>
      {body && <p>{body}</p>}
    </div>
  )
}
