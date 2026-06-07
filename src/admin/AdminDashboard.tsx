import { useEffect, useMemo, useState } from 'react'
import { useT } from '../i18n'
import {
  isOnline,
  loadRecentEventsAllUsers,
  subscribeOnlineMachines,
  type AdminEvent,
  type AdminUser,
  type LiveState,
} from './adminData'
import { dur, timeAgo } from './format'

type RecentEvent = AdminEvent & { uid: string }
type OnlineMachine = LiveState & { uid: string }

export function AdminDashboard({
  users,
  onOpenUser,
}: {
  users: AdminUser[]
  onOpenUser: (uid: string) => void
}) {
  const t = useT()
  const [events, setEvents] = useState<RecentEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadRecentEventsAllUsers(1000).then((evs) => {
      if (alive) {
        setEvents(evs)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [tick])

  // Single efficient collectionGroup subscription to all connected machines.
  const [machines, setMachines] = useState<OnlineMachine[]>([])
  useEffect(() => {
    let unsub = () => {}
    let alive = true
    void subscribeOnlineMachines((m) => {
      if (alive) setMachines(m)
    }).then((fn) => (alive ? (unsub = fn) : fn()))
    return () => {
      alive = false
      unsub()
    }
  }, [])

  const now = Date.now()
  const onlineCount = users.filter((u) => isOnline(u, now)).length
  const userName = useMemo(() => {
    const m = new Map<string, string>()
    for (const u of users) m.set(u.uid, u.displayName || u.email || u.uid.slice(0, 8))
    return m
  }, [users])

  const startOfToday = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.getTime()
  }, [])

  const stats = useMemo(() => {
    const eventsToday = events.filter((e) => e.ts >= startOfToday).length
    const tabDwell = new Map<string, number>()
    const actions = new Map<string, number>()
    const recentErrors: RecentEvent[] = []
    const recentUploads: RecentEvent[] = []
    for (const e of events) {
      if (e.type === 'tab_dwell') {
        const tab = String(e.payload.tab ?? e.tab ?? '?')
        const secs = Number(e.payload.seconds ?? 0)
        if (secs > 0) tabDwell.set(tab, (tabDwell.get(tab) ?? 0) + secs)
      } else if (e.type === 'click') {
        const label = String(e.payload.label ?? e.payload.tag ?? 'click').slice(0, 40) || 'click'
        // `count` reflects coalesced identical consecutive clicks (>=1).
        actions.set(label, (actions.get(label) ?? 0) + e.count)
      }
      if ((e.type === 'error' || e.type === 'unhandled_rejection') && recentErrors.length < 15)
        recentErrors.push(e)
      if (e.type === 'file_upload' && recentUploads.length < 15) recentUploads.push(e)
    }
    const topTabs = [...tabDwell.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    const topActions = [...actions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    return { eventsToday, topTabs, topActions, recentErrors, recentUploads }
  }, [events, startOfToday])

  return (
    <section className="admin-section">
      <div className="admin-toolbar">
        <h2 className="admin-h2">{t('admin.dash.title', 'Dashboard')}</h2>
        <button className="admin-btn ghost" onClick={() => setTick((n) => n + 1)}>
          {t('admin.refresh', 'Refresh')}
        </button>
      </div>

      <div className="admin-cards">
        <Stat label={t('admin.dash.totalUsers', 'Total users')} value={users.length} />
        <Stat label={t('admin.dash.onlineNow', 'Online now')} value={onlineCount} accent />
        <Stat
          label={t('admin.dash.machinesOnline', 'Machines connected')}
          value={machines.length}
          accent
        />
        <Stat
          label={t('admin.dash.eventsToday', 'Events today')}
          value={loading ? '…' : stats.eventsToday}
        />
        <Stat
          label={t('admin.dash.recentEvents', 'Recent events (sample)')}
          value={loading ? '…' : events.length}
        />
      </div>

      <Panel title={t('admin.dash.onlineMachines', 'Online machines')}>
        {machines.length === 0 ? (
          <Empty t={t} />
        ) : (
          <ul className="admin-list">
            {machines.map((m) => (
              <li
                key={m.uid}
                onClick={() => onOpenUser(m.uid)}
                className="admin-list-clickable admin-machine-li"
              >
                <span className="admin-machine-li-main">
                  <span className={`admin-badge online`}>{m.machineState || 'online'}</span>
                  <span className="admin-mono">
                    {userName.get(m.uid) ?? m.uid.slice(0, 8)}
                  </span>
                  {m.allowRemote && (
                    <span className="admin-cmd-status pending">
                      {t('admin.dash.remoteOn', 'remote assist')}
                    </span>
                  )}
                </span>
                <span className="admin-list-meta">
                  {m.activeTab ? `${m.activeTab} · ` : ''}
                  {m.programName ? `${m.programName} · ` : ''}
                  {m.firmware || 'GRBL'} · {timeAgo(m.ts, now)} ·{' '}
                  {t('admin.dash.openLive', 'open live view →')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <div className="admin-grid2">
        <Panel title={t('admin.dash.topTabs', 'Top tabs by dwell time')}>
          {stats.topTabs.length === 0 ? (
            <Empty t={t} />
          ) : (
            <ul className="admin-bars">
              {stats.topTabs.map(([tab, secs]) => (
                <li key={tab}>
                  <span className="admin-bar-label">{tab}</span>
                  <Bar value={secs} max={stats.topTabs[0][1]} />
                  <span className="admin-bar-num">{dur(secs)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t('admin.dash.topActions', 'Top actions / clicks')}>
          {stats.topActions.length === 0 ? (
            <Empty t={t} />
          ) : (
            <ul className="admin-bars">
              {stats.topActions.map(([label, n]) => (
                <li key={label}>
                  <span className="admin-bar-label">{label}</span>
                  <Bar value={n} max={stats.topActions[0][1]} />
                  <span className="admin-bar-num">{n}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t('admin.dash.recentErrors', 'Recent errors')}>
          {stats.recentErrors.length === 0 ? (
            <Empty t={t} />
          ) : (
            <ul className="admin-list">
              {stats.recentErrors.map((e) => (
                <li key={e.id} onClick={() => onOpenUser(e.uid)} className="admin-list-clickable">
                  <span className="admin-mono">{String(e.payload.message ?? 'error')}</span>
                  <span className="admin-list-meta">
                    {userName.get(e.uid) ?? e.uid.slice(0, 8)} · {timeAgo(e.ts, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title={t('admin.dash.recentUploads', 'Recent uploads')}>
          {stats.recentUploads.length === 0 ? (
            <Empty t={t} />
          ) : (
            <ul className="admin-list">
              {stats.recentUploads.map((e) => (
                <li key={e.id} onClick={() => onOpenUser(e.uid)} className="admin-list-clickable">
                  <span className="admin-mono">{String(e.payload.filename ?? 'file')}</span>
                  <span className="admin-list-meta">
                    {userName.get(e.uid) ?? e.uid.slice(0, 8)} · {timeAgo(e.ts, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </section>
  )
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string
  value: number | string
  accent?: boolean
}) {
  return (
    <div className={`admin-stat ${accent ? 'accent' : ''}`}>
      <div className="admin-stat-value">{value}</div>
      <div className="admin-stat-label">{label}</div>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="admin-panel">
      <h3 className="admin-panel-title">{title}</h3>
      {children}
    </div>
  )
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return (
    <span className="admin-bar">
      <span className="admin-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  )
}

function Empty({ t }: { t: (k: string, e: string) => string }) {
  return <p className="admin-empty">{t('admin.dash.noData', 'No data yet.')}</p>
}
