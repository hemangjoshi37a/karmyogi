import { type CSSProperties } from 'react'
import { useT } from '../../i18n'
import type { PresetSlot } from './usePresets'
import '../../styles/presets.css'

/** Thin pencil glyph for the per-slot edit affordance. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
      />
    </svg>
  )
}

/**
 * Floating, translucent color-swatch rail stuck to the LEFT edge of a tab. Each
 * swatch is one preset slot: clicking a FILLED swatch loads its settings;
 * hovering reveals an edit (pencil) button that also loads it (the explicit
 * "tweak this one" affordance). Empty slots show a faint "+"; clicking one just
 * selects it as the save target (use the footer to store settings into it). The
 * selected slot is ringed and stays in sync with the footer dropdown.
 *
 * Generic over the preset shape `S` — it only reads each slot's colour/name/fill.
 */
export function PresetRail<S>({
  slots,
  selected,
  onLoad,
  onSelect,
  ariaLabel,
}: {
  slots: PresetSlot<S>[]
  selected: number
  onLoad: (i: number) => void
  onSelect: (i: number) => void
  /** Toolbar aria-label naming the kind of presets (e.g. "Carving setting presets"). */
  ariaLabel?: string
}) {
  const t = useT()
  return (
    <div
      className="cc-presets-rail"
      role="toolbar"
      aria-label={ariaLabel ?? t('presets.aria', 'Setting presets')}
    >
      <span className="cc-presets-cap" aria-hidden="true">
        {t('presets.tag', 'PRESETS')}
      </span>
      {slots.map((s, i) => {
        const filled = !!s.preset
        const label = s.name || t('presets.slotN', 'Preset {n}', { n: i + 1 })
        return (
          <div className="cc-preset-slotwrap" key={i}>
            <button
              type="button"
              className={
                'cc-preset-slot' +
                (filled ? ' is-filled' : ' is-empty') +
                (i === selected ? ' is-sel' : '')
              }
              style={{ ['--slot' as string]: s.color } as CSSProperties}
              aria-pressed={i === selected}
              aria-label={
                filled
                  ? t('presets.loadAria', 'Load preset {n}: {name}', { n: i + 1, name: label })
                  : t('presets.emptyAria', 'Empty preset slot {n}', { n: i + 1 })
              }
              onClick={() => (filled ? onLoad(i) : onSelect(i))}
            >
              {!filled && (
                <span className="cc-preset-plus" aria-hidden="true">
                  +
                </span>
              )}
            </button>
            {/* Hover (or always, on touch) flyout: shows the preset NAME, plus an
                edit button for filled slots that loads it for tweaking. */}
            <div className="cc-preset-flyout" role="presentation">
              <span className="cc-preset-flyout-name">
                {filled ? label : t('presets.emptyName', 'Empty · {name}', { name: label })}
              </span>
              {filled && (
                <button
                  type="button"
                  className="cc-preset-edit"
                  title={t('presets.editTip', 'Edit “{name}” — load to tweak, then Save', { name: label })}
                  aria-label={t('presets.editAria', 'Edit preset {n}', { n: i + 1 })}
                  onClick={(e) => {
                    e.stopPropagation()
                    onLoad(i)
                  }}
                >
                  <PencilIcon />
                </button>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
