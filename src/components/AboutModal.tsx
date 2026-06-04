import { Modal } from './Modal'
import { useT } from '../i18n'

interface AboutModalProps {
  open: boolean
  onClose: () => void
  /** Canonical GitHub repo URL. */
  repoUrl: string
  /** "New issue" URL (bug report). */
  issuesUrl: string
}

/** GitHub mark (inherits the surrounding text color via currentColor). */
function GitHubGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  )
}

/** Bug glyph for "report an issue". */
function BugGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2l1.5 2.5M16 2l-1.5 2.5" />
      <rect x="8" y="6" width="8" height="12" rx="4" />
      <path d="M12 6v12M3 9h3M3 14h3M3 19l3-2M18 9h3M18 14h3M18 19l-3-2M5 5l3 2.5M19 5l-3 2.5" />
    </svg>
  )
}

/**
 * About / credits dialog. Houses the project credit + link to hjLabs.in and the
 * GitHub source + bug-report links that used to live as standalone icons in the
 * appbar (consolidated here to free up top-bar space).
 */
export function AboutModal({ open, onClose, repoUrl, issuesUrl }: AboutModalProps) {
  const t = useT()
  return (
    <Modal open={open} title={t('about.title', 'About karmyogi')} onClose={onClose} width={460}>
      <div className="km-about">
        <div className="km-about-brand">
          <img className="km-about-mark" src="/icon-mark.png" width={40} height={40} alt="karmyogi" />
          <div>
            <div className="km-about-name">
              karm<span className="accent">yogi</span>
            </div>
            <div className="km-about-tag">{t('about.tag', 'Browser CAD/CAM workbench')}</div>
          </div>
        </div>

        <p className="km-about-desc">
          {t(
            'about.desc',
            'A browser-based multipurpose control + CAD/CAM workbench for hobby/desktop CNC machines (GRBL, grblHAL, FluidNC, Marlin and more) — CNC carving, engraving, pen-plotting, auto-soldering, PCB isolation routing, laser cutting and welding.',
          )}
        </p>

        <p className="km-about-by">
          {t('about.by', 'Made by')}{' '}
          <a href="https://hjLabs.in" target="_blank" rel="noopener noreferrer">
            hjLabs.in
          </a>
          {' · '}
          <a href={`${repoUrl}/blob/main/LICENSE`} target="_blank" rel="noopener noreferrer">
            {t('about.license', 'MIT License')}
          </a>
        </p>

        <div className="km-about-links">
          <a className="km-about-link" href={repoUrl} target="_blank" rel="noopener noreferrer">
            <GitHubGlyph /> {t('about.source', 'View source on GitHub')}
          </a>
          <a className="km-about-link" href={issuesUrl} target="_blank" rel="noopener noreferrer">
            <BugGlyph /> {t('about.report', 'Report a bug')}
          </a>
        </div>
      </div>
    </Modal>
  )
}
