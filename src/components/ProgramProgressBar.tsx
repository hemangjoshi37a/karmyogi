import type { Progress } from './programWindow'
import { useT } from '../i18n'

interface Props {
  progress: Progress
  /** Optional accent colour override (e.g. warn while held). */
  color?: string
}

/**
 * Slim progress bar + "done / total (pct%)" label for the Program panel.
 * Pure presentational; styling via program.css + theme CSS variables.
 */
export function ProgramProgressBar({ progress, color }: Props) {
  const t = useT()
  const { done, total, percent } = progress
  return (
    <div className="pp-progress" aria-label={t('prog.progress', 'Program progress')}>
      <div className="pp-progress-track">
        <div
          className="pp-progress-fill"
          style={{ width: `${percent}%`, background: color ?? 'var(--accent)' }}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        />
      </div>
      <span className="pp-progress-label">
        {t('prog.progressLabel', '{done} / {total} ({percent}%)', {
          done,
          total,
          percent,
        })}
      </span>
    </div>
  )
}
