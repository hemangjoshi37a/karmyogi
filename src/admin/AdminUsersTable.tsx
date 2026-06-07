import { useMemo, useState } from 'react'
import { useT } from '../i18n'
import { isOnline, type AdminUser } from './adminData'
import { Avatar } from './Avatar'
import { dateTime, timeAgo, userLabel } from './format'

type SortKey = 'name' | 'lastSeen' | 'firstSeen' | 'online'

export function AdminUsersTable({
  users,
  onOpenUser,
}: {
  users: AdminUser[]
  onOpenUser: (uid: string) => void
}) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<SortKey>('lastSeen')
  const now = Date.now()

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? users.filter(
          (u) =>
            (u.email ?? '').toLowerCase().includes(q) ||
            (u.displayName ?? '').toLowerCase().includes(q) ||
            u.uid.toLowerCase().includes(q),
        )
      : users
    const sorted = [...filtered]
    sorted.sort((a, b) => {
      switch (sort) {
        case 'name':
          return userLabel(a).localeCompare(userLabel(b))
        case 'firstSeen':
          return (b.firstSeenMs ?? 0) - (a.firstSeenMs ?? 0)
        case 'online':
          return Number(isOnline(b, now)) - Number(isOnline(a, now))
        case 'lastSeen':
        default:
          return (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0)
      }
    })
    return sorted
  }, [users, search, sort, now])

  return (
    <section className="admin-section">
      <div className="admin-toolbar">
        <input
          className="admin-search"
          type="search"
          placeholder={t('admin.users.search', 'Search name, email, uid…')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="admin-sortbox">
          {t('admin.users.sort', 'Sort')}
          <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="lastSeen">{t('admin.users.col.lastSeen', 'Last seen')}</option>
            <option value="online">{t('admin.users.online', 'Online')}</option>
            <option value="name">{t('admin.users.col.name', 'Name')}</option>
            <option value="firstSeen">{t('admin.users.col.firstSeen', 'First seen')}</option>
          </select>
        </label>
      </div>

      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead>
            <tr>
              <th>{t('admin.users.col.user', 'User')}</th>
              <th>{t('admin.users.col.status', 'Status')}</th>
              <th>{t('admin.users.col.lastSeen', 'Last seen')}</th>
              <th>{t('admin.users.col.firstSeen', 'First seen')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => {
              const online = isOnline(u, now)
              return (
                <tr key={u.uid} className="admin-row" onClick={() => onOpenUser(u.uid)}>
                  <td>
                    <div className="admin-usercell">
                      <Avatar user={u} />
                      <div className="admin-usercell-text">
                        <span className="admin-username">{userLabel(u)}</span>
                        <span className="admin-useremail">{u.email ?? u.uid}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`admin-badge ${online ? 'online' : 'offline'}`}>
                      {online ? t('admin.users.online', 'Online') : t('admin.users.offline', 'Offline')}
                    </span>
                  </td>
                  <td title={dateTime(u.lastSeenMs)}>{timeAgo(u.lastSeenMs, now)}</td>
                  <td>{dateTime(u.firstSeenMs)}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="admin-empty">
                  {t('admin.users.none', 'No users yet.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
