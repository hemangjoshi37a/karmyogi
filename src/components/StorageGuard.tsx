import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../i18n'
import {
  clearTrackingCaches,
  estimateStorage,
  formatBytes,
  isNearFull,
  type StorageInfo,
} from '../track/cacheCleanup'
import '../styles/storageGuard.css'

/**
 * A top-bar affordance that APPEARS ONLY when the browser's local storage for
 * this origin is near-full — the situation that crashes low-RAM machines with an
 * out-of-memory error. It offers a one-click "free space" that clears the
 * disposable tracking/recording caches (usage telemetry + auto-recorded camera
 * clips) while preserving every bit of user-owned data (settings, presets, dock
 * layout, GRBL config, saved machines, 3D carve jobs).
 *
 * When storage is healthy this renders nothing, so it never adds top-bar clutter.
 */
export function StorageGuard() {
  const t = useT()
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [freed, setFreed] = useState<number | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async () => {
    setInfo(await estimateStorage())
  }, [])

  // Poll on mount, when the tab regains focus, and on a slow interval. Storage
  // pressure changes slowly, so a 60s cadence is plenty and near-zero cost.
  useEffect(() => {
    void refresh()
    const id = window.setInterval(() => void refresh(), 60_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (ev: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(ev.target as Node)) setOpen(false)
    }
    const onKey = (ev: KeyboardEvent) => ev.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const onClear = useCallback(async () => {
    setBusy(true)
    setFreed(null)
    try {
      const res = await clearTrackingCaches()
      setFreed(res.freed)
    } finally {
      setBusy(false)
      await refresh()
    }
  }, [refresh])

  // Render nothing while storage is healthy (unless the popover is open mid-clean
  // so the "freed N MB" result stays visible until the user dismisses it).
  if (!open && !isNearFull(info)) return null

  const used = info ? formatBytes(info.usage) : '—'
  const total = info && info.quota > 0 ? formatBytes(info.quota) : '—'
  const pct = info ? Math.round(info.pct * 100) : 0

  return (
    <div className="storage-guard" ref={wrapRef}>
      <button
        type="button"
        className="storage-guard-btn"
        title={t('storage.full.title', 'Local storage is almost full — free space to avoid a crash')}
        aria-label={t('storage.full.title', 'Local storage is almost full — free space to avoid a crash')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <WarnGlyph />
        <span className="storage-guard-label">{t('storage.full.label', 'Storage full')}</span>
      </button>
      {open && (
        <div className="storage-guard-pop" role="dialog" aria-label={t('storage.full.label', 'Storage full')}>
          <div className="storage-guard-head">{t('storage.full.heading', 'Free up space')}</div>
          {info && info.quota > 0 && (
            <div className="storage-guard-meter" aria-hidden="true">
              <span className="storage-guard-meter-fill" style={{ width: `${Math.min(100, pct)}%` }} />
            </div>
          )}
          <p className="storage-guard-usage">
            {t('storage.usage', '{used} of {total} used', { used, total })}
          </p>
          <p className="storage-guard-desc">
            {t(
              'storage.clear.desc',
              'Clears auto-recorded camera clips and anonymous usage data. Your settings, presets, layout and saved jobs are kept.',
            )}
          </p>
          {freed != null ? (
            <p className="storage-guard-done" role="status">
              {t('storage.clear.done', 'Freed {amount}', { amount: formatBytes(freed) })}
            </p>
          ) : null}
          <button type="button" className="storage-guard-cta" onClick={() => void onClear()} disabled={busy}>
            {busy
              ? t('storage.clear.busy', 'Freeing…')
              : t('storage.clear.cta', 'Free space now')}
          </button>
        </div>
      )}
    </div>
  )
}

function WarnGlyph() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.3 3.2 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}
