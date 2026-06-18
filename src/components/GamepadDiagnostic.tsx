import { memo } from 'react'
import { useSyncExternalStore } from 'react'
import { Activity, AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import { triggerValue, type PadFamily } from '../store/gamepadMap'
import type { RawSnapshot } from '../machine/useGamepad'

/**
 * Live "raw inputs" diagnostic — the direct cure for "ML/MR / triggers not
 * detected". Reads the ACTIVE pad's live raw snapshot (from the gamepad hook,
 * which already polls `navigator.getGamepads()` every frame) and shows:
 *   - id, mapping (flagged when non-standard), parsed vendor/product, family,
 *     button + axis counts;
 *   - one row per button (index + pressed + value bar, highlighted when active),
 *   - one row per axis (index + live value bar; trigger axes show 0..1).
 *
 * The operator presses the macro/ML/MR/trigger control and SEES which raw index
 * or axis lights up, then binds THAT in the rebind UI. Purely presentational —
 * no machine interaction, no rebinding here. Compact + theme-aware.
 */
/**
 * Public wrapper: subscribes to the high-frequency raw snapshot via
 * `useSyncExternalStore` so THIS component (and nothing else in the modal) is
 * what re-renders every animation frame. The parent modal — and crucially its
 * native `<select>` dropdowns — never re-render on pad input, so an open menu
 * stays open. Memoised on `family`/subscribe identity (both stable).
 */
export const GamepadDiagnostic = memo(function GamepadDiagnostic({
  subscribeRaw,
  getRawSnapshot,
  family,
}: {
  subscribeRaw: (cb: () => void) => () => void
  getRawSnapshot: () => RawSnapshot | null
  family: PadFamily
}) {
  const raw = useSyncExternalStore(subscribeRaw, getRawSnapshot, getRawSnapshot)
  return <DiagnosticView raw={raw} family={family} />
})

function DiagnosticView({ raw, family }: { raw: RawSnapshot | null; family: PadFamily }) {
  const t = useT()

  if (!raw) {
    return (
      <div className="gp-diag gp-diag--empty" role="status">
        <Activity size={14} aria-hidden="true" />
        <span>{t('gp.diag.none', 'Press any control on your gamepad to see its live inputs here.')}</span>
      </div>
    )
  }

  return (
    <div className="gp-diag" role="group" aria-label={t('gp.diag.aria', 'Live raw controller inputs')}>
      <div className="gp-diag-head">
        <Activity size={14} aria-hidden="true" className="gp-diag-ico" />
        <span className="gp-diag-title">{t('gp.diag.title', 'Live raw inputs')}</span>
        <span className="gp-diag-spacer" />
        <span className="gp-diag-badge" title={t('gp.diag.family.title', 'Detected glyph family')}>
          {familyLabel(family, t)}
        </span>
        {raw.nonStandard ? (
          <span
            className="gp-diag-badge gp-diag-badge--warn"
            title={t(
              'gp.diag.nonstd.title',
              'Non-standard mapping: triggers/D-pad may be axes and buttons may be at shifted indices. Bind controls by what lights up below.',
            )}
          >
            <AlertTriangle size={11} aria-hidden="true" />
            {t('gp.diag.nonstd', 'Non-standard')}
          </span>
        ) : (
          <span className="gp-diag-badge gp-diag-badge--ok" title={t('gp.diag.std.title', 'Standard Gamepad mapping')}>
            {t('gp.diag.std', 'Standard')}
          </span>
        )}
      </div>

      <div className="gp-diag-meta" title={raw.id}>
        <span className="gp-diag-id">{raw.id}</span>
        <span className="gp-diag-vp">
          {t('gp.diag.vp', 'vendor {v} · product {p}', {
            v: raw.vendor ?? '—',
            p: raw.product ?? '—',
          })}
          {' · '}
          {t('gp.diag.counts', '{b} buttons · {a} axes', { b: raw.buttons.length, a: raw.axes.length })}
        </span>
      </div>

      <div className="gp-diag-cols">
        {/* Buttons */}
        <div className="gp-diag-section">
          <div className="gp-diag-subhead">{t('gp.diag.buttons', 'Buttons')}</div>
          <div className="gp-diag-rows">
            {raw.buttons.map((pressed, i) => {
              const v = raw.buttonValues[i] ?? 0
              return (
                <div key={i} className={`gp-diag-row${pressed ? ' is-active' : ''}`}>
                  <span className="gp-diag-idx">{i}</span>
                  <span className="gp-diag-bar" aria-hidden="true">
                    <span className="gp-diag-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%` }} />
                  </span>
                  <span className="gp-diag-dot" aria-hidden="true" data-on={pressed} />
                </div>
              )
            })}
            {raw.buttons.length === 0 && <div className="gp-diag-na">{t('gp.diag.na', 'none reported')}</div>}
          </div>
        </div>

        {/* Axes */}
        <div className="gp-diag-section">
          <div className="gp-diag-subhead">{t('gp.diag.axes', 'Axes')}</div>
          <div className="gp-diag-rows">
            {raw.axes.map((val, i) => {
              const norm = Number.isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0
              // Bipolar bar: 0 at center, fills left (negative) or right (positive).
              const pct = ((norm + 1) / 2) * 100
              const trig = triggerValue(norm)
              const active = Math.abs(norm) > 0.2
              return (
                <div key={i} className={`gp-diag-row${active ? ' is-active' : ''}`} title={t('gp.diag.axis.title', 'Axis {i}: {v} (as trigger {t})', { i, v: norm.toFixed(2), t: trig.toFixed(2) })}>
                  <span className="gp-diag-idx">{i}</span>
                  <span className="gp-diag-bar gp-diag-bar--bi" aria-hidden="true">
                    <span className="gp-diag-center" />
                    <span
                      className="gp-diag-fill gp-diag-fill--bi"
                      style={
                        norm >= 0
                          ? { left: '50%', width: `${(pct - 50)}%` }
                          : { left: `${pct}%`, width: `${50 - pct}%` }
                      }
                    />
                  </span>
                  <span className="gp-diag-axval" aria-hidden="true">{norm.toFixed(2)}</span>
                </div>
              )
            })}
            {raw.axes.length === 0 && <div className="gp-diag-na">{t('gp.diag.na', 'none reported')}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

function familyLabel(family: PadFamily, t: ReturnType<typeof useT>): string {
  switch (family) {
    case 'playstation':
      return t('gp.fam.ps', 'PlayStation')
    case 'nintendo':
      return t('gp.fam.nin', 'Nintendo')
    case 'xbox':
      return t('gp.fam.xbox', 'Xbox-style')
    default:
      return t('gp.fam.generic', 'Generic')
  }
}
