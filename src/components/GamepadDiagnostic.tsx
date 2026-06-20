import { memo } from 'react'
import { useSyncExternalStore } from 'react'
import { Activity, AlertTriangle } from 'lucide-react'
import { useT } from '../i18n'
import { triggerValue, controlGlyph, buttonToken, axisToken, type ControlToken, type PadFamily } from '../store/gamepadMap'
import { useGamepadLabels, getLabel, baseToken, STD_CONTROL_NAMES } from '../store/gamepadLabels'
import type { RawSnapshot } from '../machine/useGamepad'

/** Sentinel option values for the per-row name picker (cleared → auto). */
const AUTO_VAL = '__auto__'
const CLEAR_VAL = '__clear__'

/** Standard role name for a stick axis index (LX/LY/RX/RY); empty otherwise. */
function axisRole(i: number): string {
  switch (i) {
    case 0:
      return 'LX'
    case 1:
      return 'LY'
    case 2:
      return 'RX'
    case 3:
      return 'RY'
    default:
      return ''
  }
}

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
export const GamepadDiagnostic = memo(
  function GamepadDiagnostic({
    subscribeRaw,
    getRawSnapshot,
    family,
    padKey,
  }: {
    subscribeRaw: (cb: () => void) => () => void
    getRawSnapshot: () => RawSnapshot | null
    family: PadFamily
    padKey: string
  }) {
    const raw = useSyncExternalStore(subscribeRaw, getRawSnapshot, getRawSnapshot)
    return <DiagnosticView raw={raw} family={family} padKey={padKey} />
  },
  (a, b) => a.subscribeRaw === b.subscribeRaw && a.getRawSnapshot === b.getRawSnapshot && a.family === b.family && a.padKey === b.padKey,
)

/**
 * Compact per-row name picker: lets the operator assign the REAL physical name
 * to whatever raw input lit up. Subscribes to the labels store so an edit shows
 * immediately on the row + on every bound-control chip. Pure display layer — it
 * never touches input/binding logic. `base` is the physical control's baseToken.
 */
function NameSelect({ padKey, base }: { padKey: string; base: string }) {
  const t = useT()
  const current = useGamepadLabels((s) => getLabel(s, padKey, base)) ?? ''
  const setLabel = useGamepadLabels((s) => s.setLabel)
  return (
    <select
      className="gp-diag-namesel mc-select"
      value={current || AUTO_VAL}
      onChange={(e) => {
        const v = e.target.value
        setLabel(padKey, base, v === AUTO_VAL || v === CLEAR_VAL ? '' : v)
      }}
      aria-label={t('gp.diag.label.aria', 'Real name for this control')}
      title={t('gp.diag.label.title', 'Pick this control’s real name (fixes mislabelled non-standard pads)')}
    >
      <option value={AUTO_VAL}>{t('gp.diag.label.auto', '— auto —')}</option>
      {STD_CONTROL_NAMES.map((n) => (
        <option key={n} value={n}>
          {n}
        </option>
      ))}
      {current && !STD_CONTROL_NAMES.includes(current) && (
        <option value={current}>{current}</option>
      )}
      <option value={CLEAR_VAL}>{t('gp.diag.label.clear', '— clear —')}</option>
    </select>
  )
}

/** The saved label for a token's base control (or undefined) — store-subscribed. */
function useRowLabel(padKey: string, token: ControlToken): string | undefined {
  return useGamepadLabels((s) => getLabel(s, padKey, baseToken(token)))
}

function DiagnosticView({ raw, family, padKey }: { raw: RawSnapshot | null; family: PadFamily; padKey: string }) {
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
            {raw.buttons.map((pressed, i) => (
              <ButtonRow key={i} i={i} pressed={pressed} value={raw.buttonValues[i] ?? 0} family={family} padKey={padKey} />
            ))}
            {raw.buttons.length === 0 && <div className="gp-diag-na">{t('gp.diag.na', 'none reported')}</div>}
          </div>
        </div>

        {/* Axes */}
        <div className="gp-diag-section">
          <div className="gp-diag-subhead">{t('gp.diag.axes', 'Axes')}</div>
          <div className="gp-diag-rows">
            {raw.axes.map((val, i) => (
              <AxisRow key={i} i={i} val={val} padKey={padKey} />
            ))}
            {raw.axes.length === 0 && <div className="gp-diag-na">{t('gp.diag.na', 'none reported')}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

/** One button row: live press state + name (saved label or auto) + name picker. */
function ButtonRow({
  i,
  pressed,
  value,
  family,
  padKey,
}: {
  i: number
  pressed: boolean
  value: number
  family: PadFamily
  padKey: string
}) {
  const tok = buttonToken(i)
  const label = useRowLabel(padKey, tok)
  const name = label ?? controlGlyph(tok, family)
  return (
    <div className={`gp-diag-row${pressed ? ' is-active' : ''}`}>
      <span className="gp-diag-label">
        <span className="gp-diag-name">{name}</span>
        <span className="gp-diag-idx">{i}</span>
      </span>
      <span className="gp-diag-bar" aria-hidden="true">
        <span className="gp-diag-fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }} />
      </span>
      <span className="gp-diag-dot" aria-hidden="true" data-on={pressed} />
      <NameSelect padKey={padKey} base={baseToken(tok)} />
    </div>
  )
}

/** One axis row: live bipolar bar + name (saved label or auto role) + name picker. */
function AxisRow({ i, val, padKey }: { i: number; val: number; padKey: string }) {
  const t = useT()
  // A bipolar axis carries TWO controls (e.g. the D-pad on a hat axis: − and +).
  // Label each direction separately so D-pad ←/→ (or ↑/↓) are distinct.
  const tokPlus = axisToken(i, 1)
  const tokMinus = axisToken(i, -1)
  const labelPlus = useRowLabel(padKey, tokPlus)
  const labelMinus = useRowLabel(padKey, tokMinus)
  const norm = Number.isFinite(val) ? Math.max(-1, Math.min(1, val)) : 0
  // Bipolar bar: 0 at center, fills left (negative) or right (positive).
  const pct = ((norm + 1) / 2) * 100
  const trig = triggerValue(norm)
  const active = Math.abs(norm) > 0.2
  // Show the deflected direction's label when pushed, else the axis role.
  const activeLabel = norm > 0.2 ? labelPlus : norm < -0.2 ? labelMinus : undefined
  const name = activeLabel ?? (axisRole(i) || t('gp.diag.axisN', 'Axis {i}', { i }))
  return (
    <div
      className={`gp-diag-row${active ? ' is-active' : ''}`}
      title={t('gp.diag.axis.title', 'Axis {i}: {v} (as trigger {t})', { i, v: norm.toFixed(2), t: trig.toFixed(2) })}
    >
      <span className="gp-diag-label">
        <span className="gp-diag-name">{name}</span>
        <span className="gp-diag-idx">{i}</span>
      </span>
      <span className="gp-diag-bar gp-diag-bar--bi" aria-hidden="true">
        <span className="gp-diag-center" />
        <span
          className="gp-diag-fill gp-diag-fill--bi"
          style={norm >= 0 ? { left: '50%', width: `${pct - 50}%` } : { left: `${pct}%`, width: `${50 - pct}%` }}
        />
      </span>
      <span className="gp-diag-axval" aria-hidden="true">
        {norm.toFixed(2)}
      </span>
      {/* One name picker per direction: − (left/up) and + (right/down). */}
      <span className="gp-diag-axsel">
        <span className="gp-diag-axsel-dir" title={t('gp.diag.axis.neg', 'Negative direction (left / up)')}>−</span>
        <NameSelect padKey={padKey} base={baseToken(tokMinus)} />
        <span className="gp-diag-axsel-dir" title={t('gp.diag.axis.pos', 'Positive direction (right / down)')}>+</span>
        <NameSelect padKey={padKey} base={baseToken(tokPlus)} />
      </span>
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
