import type { Vec3 } from '../store'
import { InfoTip } from './InfoTip'
import { useT } from '../i18n'

const AXES: Array<keyof Vec3> = ['x', 'y', 'z']

interface DroReadoutProps {
  wpos: Vec3
  mpos: Vec3
  /** Decimal places (mm: 3, inch: 4 typical). */
  decimals?: number
  /** Unit suffix for the header, e.g. 'mm'. */
  unit?: string
}

/** Formats a number with fixed decimals, normalizing -0 to 0. */
export function formatDro(value: number, decimals: number): string {
  const v = Object.is(value, -0) ? 0 : value
  // Avoid a "-0.000" rendering when value rounds to zero.
  const s = v.toFixed(decimals)
  return s === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : s
}

/**
 * Digital Read-Out: per-axis Work and Machine position, monospaced, fixed
 * decimals. Pure presentational component (W4-owned).
 */
export function DroReadout({ wpos, mpos, decimals = 3, unit = 'mm' }: DroReadoutProps) {
  const t = useT()
  return (
    <div className="dro" role="table" aria-label={t('ctrl.dro.aria', 'Digital read-out')}>
      <span className="dro-head axis-head">{t('ctrl.dro.axis', 'Axis')}</span>
      <span className="dro-head">
        {t('ctrl.dro.work', 'Work ({unit})', { unit })}
        <InfoTip topic="workZero" />
      </span>
      <span className="dro-head">{t('ctrl.dro.machine', 'Machine ({unit})', { unit })}</span>
      {AXES.map((axis) => (
        <div key={axis} style={{ display: 'contents' }}>
          <span className="dro-axis">{axis.toUpperCase()}</span>
          <span className="dro-val work" data-axis={axis} data-kind="work">
            {formatDro(wpos[axis], decimals)}
          </span>
          <span className="dro-val machine" data-axis={axis} data-kind="machine">
            {formatDro(mpos[axis], decimals)}
          </span>
        </div>
      ))}
    </div>
  )
}
