import { useCallback, useEffect, useRef, useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { useProgram } from '../store'
import { useT } from '../i18n'
import { Icon } from '../components/Icons'
import { fetchBuildInfo, formatBytes, type BuildInfo } from './buildInfo'
import '../styles/pwa.css'

/** The non-standard `beforeinstallprompt` event (Chromium only). */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

const INSTALL_DISMISS_KEY = 'km.pwa.installDismissedAt'
// Re-offer install this long after the user dismisses the reminder (7 days).
const INSTALL_SNOOZE_MS = 7 * 24 * 60 * 60 * 1000
// Re-check the server for a newer build on this cadence while the tab is open.
const UPDATE_POLL_MS = 30 * 60 * 1000

// `?pwademo` forces both cards to render (with fake progress) so the otherwise
// hard-to-trigger install/update UIs can be inspected in a browser. It NEVER
// reloads or registers anything — purely cosmetic — so it's harmless in prod.
const DEMO =
  typeof location !== 'undefined' && new URLSearchParams(location.search).has('pwademo')

function isStandalone(): boolean {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    // iOS Safari
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'waiting'

/**
 * Drives the two PWA UX flows, rendered once at the app root:
 *
 *  1. Install reminder — when the browser fires `beforeinstallprompt` and the app
 *     isn't already installed, a small dismissable card offers Install / Not now.
 *
 *  2. Forced auto-update — the SW is registered in 'prompt' mode (see
 *     vite.config.ts), so a new version waits instead of silently taking over.
 *     On every load (and periodically) we ask the SW to check the server; when a
 *     newer build is found we stream-download its chunks with a real %/MB bar and
 *     then reload onto it. SAFETY: if a job is actively streaming to the machine
 *     we hold the reload until it's idle, so an update never interrupts a cut.
 */
export function PwaManager() {
  const t = useT()
  const streaming = useProgram((s) => s.streaming)

  // ---- update state ----
  const [phase, setPhase] = useState<UpdatePhase>(DEMO ? 'downloading' : 'idle')
  const [received, setReceived] = useState(DEMO ? 1.34 * 1024 * 1024 : 0)
  const [total, setTotal] = useState(DEMO ? 2.23 * 1024 * 1024 : 0)
  const [updateHidden, setUpdateHidden] = useState(false)
  const startedRef = useRef(false)
  const updateFnRef = useRef<((reload?: boolean) => Promise<void>) | null>(null)
  const appliedRef = useRef(false)

  // Download the new build's chunks for a real progress bar, then mark ready.
  const beginUpdate = useCallback(async () => {
    if (startedRef.current) return
    startedRef.current = true
    setUpdateHidden(false)
    setPhase('downloading')

    let info: BuildInfo | null = null
    try {
      info = await fetchBuildInfo()
    } catch {
      info = null
    }

    if (info && info.files.length && info.bytes > 0) {
      setTotal(info.bytes)
      let got = 0
      for (const f of info.files) {
        try {
          // A new hashed URL is a cache miss → real network fetch, which also
          // warms the runtime cache the next load reads from.
          const res = await fetch(f.url, { cache: 'reload' })
          if (res.body) {
            const reader = res.body.getReader()
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              got += value?.length ?? 0
              setReceived(got)
            }
          } else {
            got += f.bytes
            setReceived(got)
          }
        } catch {
          got += f.bytes
          setReceived(got)
        }
      }
      setReceived(info.bytes) // snap to 100% (compression makes raw bytes differ)
    } else {
      // Dev / no build-info: skip the measured download, just apply.
      setTotal(0)
    }

    setPhase('ready')
  }, [])

  const { updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, reg) {
      if (!reg) return
      reg.update().catch(() => {})
      // Slow poll + a check whenever the tab is refocused, so a long-lived tab
      // still picks up new deploys. (The tab reloads on update, so these
      // listeners don't need teardown.)
      window.setInterval(() => reg.update().catch(() => {}), UPDATE_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {})
      })
    },
    onNeedRefresh() {
      void beginUpdate()
    },
  })
  updateFnRef.current = updateServiceWorker

  // Apply (skipWaiting + reload) as soon as the download is ready AND the machine
  // is idle. While a job streams we sit in 'waiting' and re-check when it ends.
  useEffect(() => {
    if (DEMO || appliedRef.current) return
    if (phase !== 'ready' && phase !== 'waiting') return
    if (streaming) {
      setPhase('waiting')
      return
    }
    appliedRef.current = true
    const fn = updateFnRef.current
    if (fn) void fn(true)
    else window.location.reload()
  }, [phase, streaming])

  // ---- install reminder state ----
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null)
  const [installed, setInstalled] = useState(isStandalone())
  const [installDismissed, setInstallDismissed] = useState(() => {
    const at = Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0)
    return at > 0 && Date.now() - at < INSTALL_SNOOZE_MS
  })

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const onInstall = useCallback(async () => {
    if (!deferred) return
    try {
      await deferred.prompt()
      await deferred.userChoice
    } catch {
      /* user closed the native sheet — nothing to do */
    }
    setDeferred(null)
  }, [deferred])

  const onDismissInstall = useCallback(() => {
    localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now()))
    setInstallDismissed(true)
  }, [])

  const showInstall = DEMO ? true : !!deferred && !installed && !installDismissed
  const showUpdate = phase !== 'idle' && !updateHidden
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0

  if (!showInstall && !showUpdate) return null

  const updateTitle =
    phase === 'waiting'
      ? t('pwa.update.waiting', 'Update ready')
      : phase === 'ready'
        ? t('pwa.update.ready', 'Finishing update…')
        : t('pwa.update.downloading', 'Updating karmyogi')

  return (
    <div className="km-pwa-stack" aria-live="polite">
      {showUpdate && (
        <div className="km-pwa-card km-pwa-update" role="status">
          <div className="km-pwa-row">
            <span className="km-pwa-chip km-pwa-chip-accent" aria-hidden="true">
              <Icon name="download" size={16} />
            </span>
            <div className="km-pwa-titles">
              <strong>{updateTitle}</strong>
              <span className="km-pwa-sub">
                {phase === 'waiting'
                  ? t('pwa.update.heldForJob', 'Will apply when the machine is idle')
                  : t('pwa.update.subtitle', 'Getting the newest version')}
              </span>
            </div>
            <button
              className="km-pwa-x"
              aria-label={t('pwa.hide', 'Hide')}
              title={t('pwa.hide', 'Hide')}
              onClick={() => setUpdateHidden(true)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="km-pwa-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div
              className={'km-pwa-bar-fill' + (total > 0 ? '' : ' km-pwa-bar-indet')}
              style={total > 0 ? { width: `${pct}%` } : undefined}
            />
          </div>
          <div className="km-pwa-meta">
            <span className="km-pwa-pct">{total > 0 ? `${pct}%` : t('pwa.update.preparing', 'Preparing…')}</span>
            {total > 0 && (
              <span className="km-pwa-bytes">
                {formatBytes(received)} / {formatBytes(total)}
              </span>
            )}
          </div>
        </div>
      )}

      {showInstall && (
        <div
          className="km-pwa-card km-pwa-install"
          role="dialog"
          aria-label={t('pwa.install.title', 'Install karmyogi')}
        >
          <div className="km-pwa-row">
            <span className="km-pwa-chip" aria-hidden="true">
              <img src="/icon-mark.png" width={24} height={24} alt="" />
            </span>
            <div className="km-pwa-titles">
              <strong>{t('pwa.install.title', 'Install karmyogi')}</strong>
              <span className="km-pwa-sub">
                {t('pwa.install.body', 'Full-screen app, faster launch, works offline.')}
              </span>
            </div>
            <button
              className="km-pwa-x"
              aria-label={t('pwa.install.dismiss', 'Not now')}
              title={t('pwa.install.dismiss', 'Not now')}
              onClick={onDismissInstall}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          <div className="km-pwa-actions">
            <button className="km-pwa-btn km-pwa-btn-primary" onClick={onInstall}>
              <Icon name="download" size={15} />
              {t('pwa.install.ok', 'Install')}
            </button>
            <button className="km-pwa-btn" onClick={onDismissInstall}>
              {t('pwa.install.cancel', 'Not now')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
