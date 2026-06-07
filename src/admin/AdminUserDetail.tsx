import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../auth/authStore'
import { useT } from '../i18n'
import {
  deleteUserEvents,
  getFileDownloadUrl,
  isOnline,
  listUserFiles,
  loadUserEvents,
  sendCommand,
  subscribeCommands,
  subscribeLiveProgram,
  subscribeLiveState,
  type AdminCommand,
  type AdminEvent,
  type AdminUser,
  type FileMeta,
  type LiveProgram,
  type LiveState,
} from './adminData'
import { buildTimeline } from '../core/simulation'
import { Avatar } from './Avatar'
import { dateTime, dur, timeAgo, userLabel } from './format'

const EVENT_LIMIT = 500

export function AdminUserDetail({ user, onBack }: { user: AdminUser; onBack: () => void }) {
  const t = useT()
  const [events, setEvents] = useState<AdminEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [reloadTick, setReloadTick] = useState(0)
  const now = Date.now()

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadUserEvents(user.uid, EVENT_LIMIT).then((evs) => {
      if (alive) {
        setEvents(evs)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [user.uid, reloadTick])

  const types = useMemo(() => {
    const s = new Set<string>()
    for (const e of events) s.add(e.type)
    return ['all', ...[...s].sort()]
  }, [events])

  const filtered = useMemo(
    () => (filter === 'all' ? events : events.filter((e) => e.type === filter)),
    [events, filter],
  )

  const tabTotals = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of events) {
      if (e.type === 'tab_dwell') {
        const tab = String(e.payload.tab ?? e.tab ?? '?')
        const secs = Number(e.payload.seconds ?? 0)
        if (secs > 0) m.set(tab, (m.get(tab) ?? 0) + secs)
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [events])

  const uploads = useMemo(() => events.filter((e) => e.type === 'file_upload'), [events])
  const errors = useMemo(
    () => events.filter((e) => e.type === 'error' || e.type === 'unhandled_rejection'),
    [events],
  )

  async function doDelete() {
    setBusy(true)
    try {
      await deleteUserEvents(user.uid)
      setConfirmDelete(false)
      setReloadTick((n) => n + 1)
    } catch {
      /* ignore — rules may forbid; surfaced as no change */
    } finally {
      setBusy(false)
    }
  }

  const online = isOnline(user, now)

  return (
    <section className="admin-section">
      <div className="admin-toolbar">
        <button className="admin-btn ghost" onClick={onBack}>
          {t('admin.detail.back', '← Users')}
        </button>
        <button className="admin-btn ghost" onClick={() => setReloadTick((n) => n + 1)}>
          {t('admin.refresh', 'Refresh')}
        </button>
        <button className="admin-btn danger" onClick={() => setConfirmDelete(true)}>
          {t('admin.detail.delete', 'Delete activity')}
        </button>
      </div>

      <div className="admin-userhead">
        <Avatar user={user} size={56} />
        <div>
          <h2 className="admin-h2">{userLabel(user)}</h2>
          <div className="admin-userhead-sub">
            <span className={`admin-badge ${online ? 'online' : 'offline'}`}>
              {online ? t('admin.users.online', 'Online') : t('admin.users.offline', 'Offline')}
            </span>
            <span>{user.email ?? user.uid}</span>
          </div>
          <div className="admin-userhead-meta">
            {t('admin.detail.firstSeen', 'First seen')}: {dateTime(user.firstSeenMs)} ·{' '}
            {t('admin.detail.lastSeen', 'Last seen')}: {timeAgo(user.lastSeenMs, now)} ·{' '}
            {t('admin.detail.events', 'Events')}: {loading ? '…' : events.length}
            {events.length >= EVENT_LIMIT ? '+' : ''}
          </div>
        </div>
      </div>

      <MachineSection uid={user.uid} />

      <FilesSection uid={user.uid} />

      <div className="admin-grid2">
        <div className="admin-panel">
          <h3 className="admin-panel-title">{t('admin.detail.tabTotals', 'Time per tab')}</h3>
          {tabTotals.length === 0 ? (
            <p className="admin-empty">{t('admin.dash.noData', 'No data yet.')}</p>
          ) : (
            <ul className="admin-bars">
              {tabTotals.map(([tab, secs]) => (
                <li key={tab}>
                  <span className="admin-bar-label">{tab}</span>
                  <span className="admin-bar">
                    <span
                      className="admin-bar-fill"
                      style={{ width: `${Math.round((secs / tabTotals[0][1]) * 100)}%` }}
                    />
                  </span>
                  <span className="admin-bar-num">{dur(secs)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="admin-panel">
          <h3 className="admin-panel-title">
            {t('admin.detail.uploads', 'Uploads')} ({uploads.length})
          </h3>
          {uploads.length === 0 ? (
            <p className="admin-empty">{t('admin.dash.noData', 'No data yet.')}</p>
          ) : (
            <ul className="admin-list">
              {uploads.slice(0, 30).map((e) => (
                <li key={e.id}>
                  <span className="admin-mono">{String(e.payload.filename ?? 'file')}</span>
                  <span className="admin-list-meta">
                    {String(e.payload.mime ?? '')} · {fmtSize(Number(e.payload.size ?? 0))} ·{' '}
                    {timeAgo(e.ts, now)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="admin-panel">
          <h3 className="admin-panel-title">
            {t('admin.detail.errors', 'Errors')} ({errors.length})
          </h3>
          <ul className="admin-list">
            {errors.slice(0, 30).map((e) => (
              <li key={e.id}>
                <span className="admin-mono">{String(e.payload.message ?? 'error')}</span>
                <span className="admin-list-meta">{timeAgo(e.ts, now)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="admin-panel">
        <div className="admin-toolbar">
          <h3 className="admin-panel-title">
            {t('admin.detail.timeline', 'Activity timeline')}
          </h3>
          <label className="admin-sortbox">
            {t('admin.detail.filter', 'Type')}
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              {types.map((ty) => (
                <option key={ty} value={ty}>
                  {ty}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading ? (
          <p className="admin-empty">{t('admin.loading', 'Loading…')}</p>
        ) : filtered.length === 0 ? (
          <p className="admin-empty">{t('admin.dash.noData', 'No data yet.')}</p>
        ) : (
          <ul className="admin-timeline">
            {filtered.map((e) => (
              <li key={e.id}>
                <span className="admin-tl-time" title={dateTime(e.ts)}>
                  {timeAgo(e.ts, now)}
                </span>
                <span className="admin-tl-type">
                  {e.type}
                  {e.count > 1 ? ` ×${e.count}` : ''}
                </span>
                {e.tab && <span className="admin-tl-tab">{e.tab}</span>}
                <span className="admin-tl-payload admin-mono">{summarize(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmDelete && (
        <div className="admin-modal-backdrop" onClick={() => !busy && setConfirmDelete(false)}>
          <div className="admin-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('admin.detail.deleteTitle', 'Delete this user’s activity?')}</h3>
            <p>
              {t(
                'admin.detail.deleteBody',
                'This permanently deletes all stored events for {name}. The profile/presence doc is kept. This cannot be undone.',
                { name: userLabel(user) },
              )}
            </p>
            <div className="admin-modal-actions">
              <button
                className="admin-btn ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(false)}
              >
                {t('admin.cancel', 'Cancel')}
              </button>
              <button className="admin-btn danger" disabled={busy} onClick={() => void doDelete()}>
                {busy ? t('admin.deleting', 'Deleting…') : t('admin.detail.delete', 'Delete activity')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Live machine readout + (opt-in) remote control. Subscribes to the user's
 * live/state and commands docs only while this detail view is mounted, and
 * tears the listeners down on unmount (no chatty polling).
 */
function MachineSection({ uid }: { uid: string }) {
  const t = useT()
  const adminEmail = useAuth((s) => s.user?.email ?? null)
  const [live, setLive] = useState<LiveState | null>(null)
  const [liveLoaded, setLiveLoaded] = useState(false)
  const [program, setProgram] = useState<LiveProgram | null>(null)
  const [commands, setCommands] = useState<AdminCommand[]>([])
  const [step, setStep] = useState(1)
  const [mdi, setMdi] = useState('')
  const [sending, setSending] = useState(false)
  const now = Date.now()

  useEffect(() => {
    let unsub = () => {}
    let alive = true
    setLive(null)
    setLiveLoaded(false)
    void subscribeLiveState(
      uid,
      (s) => {
        if (alive) {
          setLive(s)
          setLiveLoaded(true)
        }
      },
      () => {
        if (alive) setLiveLoaded(true)
      },
    ).then((fn) => (alive ? (unsub = fn) : fn()))
    return () => {
      alive = false
      unsub()
    }
  }, [uid])

  useEffect(() => {
    let unsub = () => {}
    let alive = true
    setProgram(null)
    void subscribeLiveProgram(uid, (p) => {
      if (alive) setProgram(p)
    }).then((fn) => (alive ? (unsub = fn) : fn()))
    return () => {
      alive = false
      unsub()
    }
  }, [uid])

  useEffect(() => {
    let unsub = () => {}
    let alive = true
    setCommands([])
    void subscribeCommands(uid, (c) => {
      if (alive) setCommands(c)
    }).then((fn) => (alive ? (unsub = fn) : fn()))
    return () => {
      alive = false
      unsub()
    }
  }, [uid])

  async function send(kind: AdminCommand['kind'], data: string) {
    if (!adminEmail || sending) return
    setSending(true)
    try {
      await sendCommand(uid, kind, data, adminEmail)
    } catch {
      /* surfaced via the command list staying unchanged */
    } finally {
      setSending(false)
    }
  }

  const allowRemote = live?.allowRemote === true
  const connected = live?.connected === true

  return (
    <div className="admin-panel">
      <div className="admin-toolbar" style={{ marginBottom: 8 }}>
        <h3 className="admin-panel-title" style={{ marginBottom: 0 }}>
          {t('admin.machine.title', 'Machine')}
        </h3>
        <span className={`admin-badge ${connected ? 'online' : 'offline'}`}>
          {connected
            ? t('admin.machine.connected', 'Connected')
            : t('admin.machine.disconnected', 'Disconnected')}
        </span>
      </div>

      {!liveLoaded ? (
        <p className="admin-empty">{t('admin.loading', 'Loading…')}</p>
      ) : !live ? (
        <p className="admin-empty">
          {t('admin.machine.noState', 'No live machine data reported by this user.')}
        </p>
      ) : (
        <>
          <div className="admin-machine-grid">
            <Readout label={t('admin.machine.state', 'State')} value={live.machineState || '—'} />
            <Readout label={t('admin.machine.firmware', 'Firmware')} value={live.firmware || '—'} />
            <Readout label={t('admin.machine.tab', 'Active tab')} value={live.activeTab || '—'} />
            <Readout
              label={t('admin.machine.program', 'Program')}
              value={live.programName || '—'}
            />
            <Readout label={t('admin.machine.feed', 'Feed')} value={String(live.feed)} />
            <Readout
              label={t('admin.machine.spindle', 'Spindle RPM')}
              value={String(live.spindleRpm)}
            />
            <Readout
              label={t('admin.machine.wpos', 'Work pos (X Y Z)')}
              value={fmtPos(live.wpos)}
            />
            <Readout
              label={t('admin.machine.mpos', 'Machine pos (X Y Z)')}
              value={fmtPos(live.mpos)}
            />
          </div>
          <div className="admin-list-meta" style={{ marginTop: 6 }}>
            {t('admin.machine.updated', 'Updated')}: {timeAgo(live.ts, now)}
          </div>

          <LiveView t={t} live={live} program={program} />

          {allowRemote ? (
            <div className="admin-remote">
              <div className="admin-remote-warn">
                {t(
                  'admin.machine.warn',
                  '⚠ These controls move this user’s PHYSICAL machine in real time.',
                )}
              </div>

              <div className="admin-remote-row">
                <span className="admin-remote-label">{t('admin.machine.step', 'Step (mm)')}</span>
                {[0.1, 1, 10, 50].map((s) => (
                  <button
                    key={s}
                    className={`admin-btn ${step === s ? 'primary' : 'ghost'}`}
                    onClick={() => setStep(s)}
                  >
                    {s}
                  </button>
                ))}
              </div>

              <div className="admin-jogpad">
                <JogBtn t={t} ax="Y" dir={+1} step={step} send={send} disabled={sending} />
                <JogBtn t={t} ax="Z" dir={+1} step={step} send={send} disabled={sending} />
                <JogBtn t={t} ax="X" dir={-1} step={step} send={send} disabled={sending} />
                <JogBtn t={t} ax="X" dir={+1} step={step} send={send} disabled={sending} />
                <JogBtn t={t} ax="Y" dir={-1} step={step} send={send} disabled={sending} />
                <JogBtn t={t} ax="Z" dir={-1} step={step} send={send} disabled={sending} />
              </div>

              <div className="admin-remote-row">
                <button
                  className="admin-btn"
                  disabled={sending}
                  onClick={() => void send('realtime', '!')}
                >
                  {t('admin.machine.hold', 'Feed hold')}
                </button>
                <button
                  className="admin-btn"
                  disabled={sending}
                  onClick={() => void send('realtime', '~')}
                >
                  {t('admin.machine.resume', 'Resume')}
                </button>
                <button
                  className="admin-btn"
                  disabled={sending}
                  onClick={() => void send('realtime', '?')}
                >
                  {t('admin.machine.status', 'Status')}
                </button>
                <button
                  className="admin-btn danger"
                  disabled={sending}
                  onClick={() => void send('realtime', '\x18')}
                >
                  {t('admin.machine.reset', 'Soft reset')}
                </button>
              </div>

              <form
                className="admin-remote-row"
                onSubmit={(e) => {
                  e.preventDefault()
                  const line = mdi.trim()
                  if (line) {
                    void send('gcode', line)
                    setMdi('')
                  }
                }}
              >
                <input
                  className="admin-search"
                  placeholder={t('admin.machine.mdi', 'Send G-code line (e.g. G0 X0 Y0)')}
                  value={mdi}
                  onChange={(e) => setMdi(e.target.value)}
                />
                <button className="admin-btn primary" type="submit" disabled={sending || !mdi.trim()}>
                  {t('admin.machine.send', 'Send')}
                </button>
              </form>
            </div>
          ) : (
            <p className="admin-empty admin-remote-off">
              {t('admin.machine.noRemote', 'User has not enabled remote assist.')}
            </p>
          )}

          {commands.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4 className="admin-panel-title" style={{ fontSize: 12 }}>
                {t('admin.machine.recentCmds', 'Recent commands')}
              </h4>
              <ul className="admin-list">
                {commands.map((c) => (
                  <li key={c.id}>
                    <span className="admin-mono">
                      [{c.kind}] {c.data === '\x18' ? '0x18' : c.data}
                    </span>
                    <span className="admin-list-meta">
                      <span className={`admin-cmd-status ${c.status}`}>{c.status}</span>
                      {c.result ? ` · ${c.result}` : ''} · {timeAgo(c.ts, now)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-readout">
      <div className="admin-readout-label">{label}</div>
      <div className="admin-readout-value admin-mono">{value}</div>
    </div>
  )
}

/**
 * Live mirror of WHAT THE USER SEES: their active tab + the currently-loaded
 * program rendered as a top-down 2D toolpath preview (rapids dim, cuts bright),
 * with the machine's current XY position marked. Re-renders live as the user's
 * program / position change (no pixel screen-share needed). Reuses the pure
 * `buildTimeline` G-code parser from the core so this stays cheap.
 */
function LiveView({
  t,
  live,
  program,
}: {
  t: (k: string, e: string) => string
  live: LiveState
  program: LiveProgram | null
}) {
  return (
    <div className="admin-liveview">
      <div className="admin-liveview-head">
        <h4 className="admin-panel-title" style={{ fontSize: 12, marginBottom: 0 }}>
          {t('admin.live.title', 'Live view (as the user sees it)')}
        </h4>
        <span className="admin-list-meta">
          {live.activeTab ? `${live.activeTab}` : t('admin.live.noTab', 'no tab')}
          {program?.name ? ` · ${program.name}` : ''}
          {program ? ` · ${program.lines} ${t('admin.live.lines', 'lines')}` : ''}
          {program?.truncated ? ` · ${t('admin.live.truncated', 'truncated')}` : ''}
        </span>
      </div>
      {program && program.gcode.trim() ? (
        <ToolpathCanvas
          gcode={program.gcode}
          pos={[live.wpos.x, live.wpos.y]}
        />
      ) : (
        <p className="admin-empty" style={{ marginTop: 6 }}>
          {t('admin.live.noProgram', 'No program loaded on the user’s screen.')}
        </p>
      )}
    </div>
  )
}

/**
 * Cheap 2D top-down toolpath plot drawn onto a canvas. Parses the G-code via the
 * shared `buildTimeline` (pure core) into XY segments, auto-fits them to the
 * canvas, and draws rapids dim / cuts bright, plus a marker at the user's current
 * XY work position. Redraws whenever the gcode or position changes.
 */
function ToolpathCanvas({ gcode, pos }: { gcode: string; pos: [number, number] }) {
  const ref = useRef<HTMLCanvasElement | null>(null)

  // Parse once per program (not per position tick).
  const segments = useMemo(() => buildTimeline(gcode).segments, [gcode])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const W = canvas.width
    const H = canvas.height
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(0, 0, W, H)

    // Bounds over all segment endpoints (and the current position).
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const consider = (x: number, y: number) => {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    for (const s of segments) {
      consider(s.from[0], s.from[1])
      consider(s.to[0], s.to[1])
    }
    if (Number.isFinite(pos[0]) && Number.isFinite(pos[1])) consider(pos[0], pos[1])
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 1
      maxY = 1
    }

    const pad = 10
    const spanX = Math.max(maxX - minX, 1e-6)
    const spanY = Math.max(maxY - minY, 1e-6)
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY)
    // Map model (Y-up) → canvas (Y-down), centred.
    const offX = (W - spanX * scale) / 2
    const offY = (H - spanY * scale) / 2
    const tx = (x: number) => offX + (x - minX) * scale
    const ty = (y: number) => H - (offY + (y - minY) * scale)

    // Rapids first (dim), then cuts on top (bright).
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(120,160,200,0.35)'
    ctx.beginPath()
    for (const s of segments) {
      if (s.kind !== 'rapid') continue
      ctx.moveTo(tx(s.from[0]), ty(s.from[1]))
      ctx.lineTo(tx(s.to[0]), ty(s.to[1]))
    }
    ctx.stroke()

    ctx.lineWidth = 1.5
    ctx.strokeStyle = '#7dd3fc'
    ctx.beginPath()
    for (const s of segments) {
      if (s.kind !== 'cut') continue
      ctx.moveTo(tx(s.from[0]), ty(s.from[1]))
      ctx.lineTo(tx(s.to[0]), ty(s.to[1]))
    }
    ctx.stroke()

    // Current position marker.
    if (Number.isFinite(pos[0]) && Number.isFinite(pos[1])) {
      const px = tx(pos[0])
      const py = ty(pos[1])
      ctx.fillStyle = '#f87171'
      ctx.beginPath()
      ctx.arc(px, py, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.strokeStyle = 'rgba(248,113,113,0.5)'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(px - 8, py)
      ctx.lineTo(px + 8, py)
      ctx.moveTo(px, py - 8)
      ctx.lineTo(px, py + 8)
      ctx.stroke()
    }
  }, [segments, pos])

  return (
    <canvas
      ref={ref}
      width={320}
      height={220}
      className="admin-toolpath-canvas"
    />
  )
}

function JogBtn({
  t,
  ax,
  dir,
  step,
  send,
  disabled,
}: {
  t: (k: string, e: string) => string
  ax: 'X' | 'Y' | 'Z'
  dir: 1 | -1
  step: number
  send: (kind: AdminCommand['kind'], data: string) => void
  disabled: boolean
}) {
  const dist = (dir * step).toString()
  // GRBL jog command; the user-side executor sends it as a $J= jog.
  const data = `$J=G91 G21 ${ax}${dist} F1000`
  return (
    <button
      className="admin-btn admin-jog-btn"
      disabled={disabled}
      onClick={() => send('jog', data)}
      title={t('admin.machine.jog', 'Jog')}
    >
      {ax}
      {dir > 0 ? '+' : '−'}
    </button>
  )
}

/** Uploaded-file list with a download button per file (resolved on click). */
function FilesSection({ uid }: { uid: string }) {
  const t = useT()
  const [files, setFiles] = useState<FileMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const now = Date.now()

  useEffect(() => {
    let alive = true
    setLoading(true)
    void listUserFiles(uid).then((f) => {
      if (alive) {
        setFiles(f)
        setLoading(false)
      }
    })
    return () => {
      alive = false
    }
  }, [uid])

  async function download(f: FileMeta) {
    if (!f.storagePath || busyId) return
    setBusyId(f.id)
    try {
      const url = await getFileDownloadUrl(f.storagePath)
      window.open(url, '_blank', 'noopener')
    } catch {
      /* unresolved download — leave UI unchanged */
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="admin-panel">
      <h3 className="admin-panel-title">
        {t('admin.files.title', 'Files')} ({loading ? '…' : files.length})
      </h3>
      {loading ? (
        <p className="admin-empty">{t('admin.loading', 'Loading…')}</p>
      ) : files.length === 0 ? (
        <p className="admin-empty">{t('admin.files.none', 'No uploaded files.')}</p>
      ) : (
        <ul className="admin-list">
          {files.map((f) => (
            <li key={f.id} className="admin-file-row">
              <div className="admin-file-info">
                <span className="admin-mono">{f.name}</span>
                <span className="admin-list-meta">
                  {f.type || 'file'} · {fmtSize(f.size)}
                  {f.context ? ` · ${f.context}` : ''} · {timeAgo(f.ts, now)}
                </span>
              </div>
              <button
                className="admin-btn ghost"
                disabled={!f.storagePath || busyId === f.id}
                onClick={() => void download(f)}
              >
                {busyId === f.id
                  ? t('admin.files.opening', 'Opening…')
                  : t('admin.files.download', 'Download')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function fmtPos(p: { x: number; y: number; z: number }): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '0.000')
  return `${f(p.x)}  ${f(p.y)}  ${f(p.z)}`
}

function fmtSize(bytes: number): string {
  if (!bytes) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}

/** One-line summary of an event's payload for the timeline. */
function summarize(e: AdminEvent): string {
  const p = e.payload
  switch (e.type) {
    case 'click':
      return String(p.label ?? p.selector ?? p.tag ?? '')
    case 'tab_dwell':
      return `${p.tab ?? ''} · ${dur(Number(p.seconds ?? 0))}`
    case 'tab_enter':
      return String(p.tab ?? '')
    case 'file_upload':
      return `${p.filename ?? ''} (${fmtSize(Number(p.size ?? 0))})`
    case 'program_generated':
      return `${p.sectionCount ?? 0} sections, ${p.lineCount ?? 0} lines`
    case 'error':
    case 'unhandled_rejection':
      return String(p.message ?? '')
    default: {
      const keys = Object.keys(p)
      if (keys.length === 0) return ''
      return keys
        .slice(0, 4)
        .map((k) => `${k}=${String(p[k]).slice(0, 30)}`)
        .join(' ')
    }
  }
}
