import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { useT } from '../i18n'
import { usePolicies } from './policies'
import {
  RUNNING_VERSION,
  RUNNING_BUILD_TIME,
  fetchBuildInfo,
  formatBytes,
  formatBuildTime,
} from '../pwa/buildInfo'
import { checkForUpdate, type UpdateCheckResult } from '../pwa/updateController'
import '../styles/about.css'

interface AboutModalProps {
  open: boolean
  onClose: () => void
  /** Canonical GitHub repo URL. */
  repoUrl: string
  /** "New issue" URL (bug report). */
  issuesUrl: string
}

/** Live hosted instance of the app. */
const LIVE_URL = 'https://karmyogi.hjlabs.in'

/** GitHub mark (inherits the surrounding text color via currentColor). */
function GitHubGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** Bug glyph for "report an issue". */
function BugGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2l1.5 2.5M16 2l-1.5 2.5" />
      <rect x="8" y="6" width="8" height="12" rx="4" />
      <path d="M12 6v12M3 9h3M3 14h3M3 19l3-2M18 9h3M18 14h3M18 19l-3-2M5 5l3 2.5M19 5l-3 2.5" />
    </svg>
  )
}

/** "Open in new window" glyph for the live-app button. */
function ExternalGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14L21 3" />
    </svg>
  )
}

/** Check / success glyph. */
function CheckGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

/** Refresh / update glyph. */
function RefreshGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  )
}

/**
 * About / credits dialog. A single-sheet, enterprise-grade summary of the app:
 * hero + capability chips, primary action links, a build card with a working
 * "Check for update" control, the legal-policy list, and a footer credit.
 */
export function AboutModal({ open, onClose, repoUrl, issuesUrl }: AboutModalProps) {
  const t = useT()
  const policies = usePolicies()

  // Build size comes from the server's build-info.json (the running build's own
  // descriptor); version + timestamp are baked into the bundle so they're always
  // available even in dev / offline.
  const [sizeLabel, setSizeLabel] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    let alive = true
    void fetchBuildInfo().then((info) => {
      if (alive && info) setSizeLabel(formatBytes(info.bytes))
    })
    return () => {
      alive = false
    }
  }, [open])

  // Check-for-update state machine.
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)

  // Reset the transient update state whenever the modal reopens.
  useEffect(() => {
    if (!open) {
      setChecking(false)
      setResult(null)
    }
  }, [open])

  async function onCheckUpdate() {
    if (checking) return
    setChecking(true)
    setResult('checking')
    const r = await checkForUpdate()
    setResult(r)
    setChecking(false)
    // When an update exists, PwaManager's onNeedRefresh() takes over with its
    // progress card and reloads — close the modal so it's visible.
    if (r === 'available') {
      window.setTimeout(() => onClose(), 1200)
    }
  }

  const versionLabel = `v${RUNNING_VERSION}`

  return (
    <>
      <Modal open={open} title={t('about.title', 'About karmyogi')} onClose={onClose} width={500}>
        <div className="km-about2">
          {/* Hero */}
          <div className="km-about2-hero">
            <img className="km-about2-mark" src="/icon-mark.png" width={48} height={48} alt="karmyogi" />
            <div className="km-about2-heroText">
              <div className="km-about2-nameRow">
                <span className="km-about2-name">
                  karm<span className="accent">yogi</span>
                </span>
                <span className="km-about2-vchip">{versionLabel}</span>
              </div>
              <span className="km-about2-tag">{t('about.tag', 'Browser CAD/CAM workbench')}</span>
            </div>
          </div>

          {/* Description */}
          <p className="km-about2-desc">
            {t(
              'about.desc',
              'A browser-based multipurpose control + CAD/CAM workbench for hobby/desktop CNC machines (GRBL, grblHAL, FluidNC, Marlin and more) — CNC carving, engraving, pen-plotting, auto-soldering, PCB isolation routing, laser cutting and welding.',
            )}
          </p>

          {/* Capability chips */}
          <div className="km-about2-chips">
            <span className="km-about2-chip">{t('about.chip.languages', '53 languages')}</span>
            <span className="km-about2-chip">{t('about.chip.modes', '14+ modes')}</span>
            <span className="km-about2-chip">{t('about.chip.pwa', 'PWA · offline')}</span>
            <span className="km-about2-chip">{t('about.chip.license', 'MIT')}</span>
          </div>

          {/* Primary actions */}
          <div className="km-about2-actions">
            <a
              className="km-about2-btn km-about2-btn-primary"
              href={LIVE_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalGlyph /> {t('about.live', 'Open live app')}
            </a>
            <a className="km-about2-btn" href={repoUrl} target="_blank" rel="noopener noreferrer">
              <GitHubGlyph /> {t('about.source.short', 'View source')}
            </a>
            <a className="km-about2-btn" href={issuesUrl} target="_blank" rel="noopener noreferrer">
              <BugGlyph /> {t('about.report', 'Report a bug')}
            </a>
          </div>

          {/* Build card + update control */}
          <div className="km-about2-card">
            <dl className="km-about2-build">
              <div className="km-about2-kv">
                <dt>{t('about.version', 'Version')}</dt>
                <dd>{RUNNING_VERSION}</dd>
              </div>
              <div className="km-about2-kv">
                <dt>{t('about.built', 'Built')}</dt>
                <dd>{formatBuildTime(RUNNING_BUILD_TIME)}</dd>
              </div>
              {sizeLabel && (
                <div className="km-about2-kv">
                  <dt>{t('about.size', 'Build size')}</dt>
                  <dd>{sizeLabel}</dd>
                </div>
              )}
            </dl>

            <div className="km-about2-update">
              {result === 'unsupported' ? (
                <span className="km-about2-update-note">
                  {t('update.auto', 'Updates apply automatically')}
                </span>
              ) : (
                <>
                  <span
                    className={
                      'km-about2-update-status' +
                      (result === 'latest' ? ' is-latest' : '') +
                      (result === 'available' ? ' is-available' : '')
                    }
                  >
                    {result === 'latest' && (
                      <>
                        <CheckGlyph /> {t('update.latest', "You're on the latest version")}
                      </>
                    )}
                    {result === 'available' && (
                      <>
                        <RefreshGlyph /> {t('update.available', 'Update available — installing…')}
                      </>
                    )}
                    {(result === null || result === 'checking') && (
                      <>{t('update.label', 'Keep karmyogi up to date')}</>
                    )}
                  </span>
                  <button
                    type="button"
                    className="km-about2-update-btn"
                    onClick={onCheckUpdate}
                    disabled={checking || result === 'available'}
                  >
                    {checking ? (
                      <>
                        <span className="km-about2-spin" aria-hidden="true" />
                        {t('update.checking', 'Checking…')}
                      </>
                    ) : (
                      <>
                        <RefreshGlyph /> {t('update.check', 'Check for update')}
                      </>
                    )}
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Legal policies */}
          {policies.list}

          {/* Footer credit */}
          <p className="km-about2-footer">
            {t('about.by', 'Made by')}{' '}
            <a href="https://hjLabs.in" target="_blank" rel="noopener noreferrer">
              hjLabs.in
            </a>
            {' · '}
            <a href={`${repoUrl}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
              {t('about.license', 'MIT License')}
            </a>
          </p>
        </div>
      </Modal>
      {policies.modal}
    </>
  )
}
