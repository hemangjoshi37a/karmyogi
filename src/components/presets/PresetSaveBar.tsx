import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { useT } from '../../i18n'
import type { PresetSlot } from './usePresets'
import '../../styles/presets.css'

/** Floppy-disk glyph for the preset Save button. */
function SaveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"
      />
    </svg>
  )
}

/** Recycle-bin glyph for the preset Delete button. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM8.5 9.5h1.5v8H8.5v-8zm5.5 0h1.5v8H14v-8zM15.5 4l-1-1h-5l-1 1H5v2h14V4h-3.5z"
      />
    </svg>
  )
}

/**
 * Sticky footer save-bar: an optional name field, a color dropdown that picks
 * the target slot (in sync with the rail), and a Save button that writes the
 * CURRENT settings into the selected color. A Clear button removes a stored
 * preset. Kept compact + glassy for an enterprise feel.
 *
 * Generic over the preset shape `S` — it only reads each slot's colour/name/fill.
 */
export function PresetSaveBar<S>({
  slots,
  selected,
  onSelect,
  onSave,
  onClear,
  onRename,
  extra,
}: {
  slots: PresetSlot<S>[]
  selected: number
  onSelect: (i: number) => void
  onSave: (i: number) => void
  onClear: (i: number) => void
  onRename: (i: number, name: string) => void
  /** Extra controls rendered at the start of the bar (e.g. carve Save/Load). */
  extra?: ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [flash, setFlash] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const cur = slots[selected] ?? slots[0]

  // Dismiss the color popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const slotLabel = (i: number) => slots[i].name || t('presets.slotN', 'Preset {n}', { n: i + 1 })

  const doSave = () => {
    onSave(selected)
    setFlash(true)
    window.setTimeout(() => setFlash(false), 1300)
  }

  return (
    <div className="cc-presets-bar">
      {extra && (
        <>
          <span className="cc-presets-extra">{extra}</span>
          <span className="cc-presets-sep" aria-hidden="true" />
        </>
      )}
      <input
        className="cc-presets-name"
        value={cur.name}
        placeholder={t('presets.namePh', 'Preset name')}
        onChange={(e) => onRename(selected, e.target.value)}
        aria-label={t('presets.nameAria', 'Preset name')}
      />
      <div className="cc-presets-dd" ref={wrapRef}>
        <button
          type="button"
          className="cc-presets-dd-btn"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          title={t('presets.pickColor', 'Choose which colour slot to save into')}
        >
          <span className="cc-presets-dot" style={{ background: cur.color }} />
          <span className="cc-presets-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {open && (
          <div className="cc-presets-grid" role="listbox" aria-label={t('presets.pickColor', 'Choose colour slot')}>
            {slots.map((s, i) => (
              <button
                key={i}
                type="button"
                role="option"
                aria-selected={i === selected}
                title={s.preset ? slotLabel(i) : t('presets.slotEmpty', 'Slot {n} (empty)', { n: i + 1 })}
                className={
                  'cc-presets-cell' +
                  (i === selected ? ' is-sel' : '') +
                  (s.preset ? ' is-filled' : ' is-empty')
                }
                style={{ ['--slot' as string]: s.color } as CSSProperties}
                onClick={() => {
                  onSelect(i)
                  setOpen(false)
                }}
              >
                {i === selected && (
                  <span className="cc-presets-cell-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      <button
        type="button"
        className={'cc-presets-iconbtn cc-presets-save' + (flash ? ' is-ok' : '')}
        onClick={doSave}
        title={t('presets.saveTip', 'Save the current settings into this colour')}
        aria-label={t('presets.saveBtn', 'Save preset')}
      >
        {flash ? (
          <span className="cc-presets-ok" aria-hidden="true">
            ✓
          </span>
        ) : (
          <SaveIcon />
        )}
      </button>
      {cur.preset && (
        <button
          type="button"
          className="cc-presets-iconbtn cc-presets-clearbtn"
          title={t('presets.clearTip', 'Delete this preset slot')}
          aria-label={t('presets.clearAria', 'Delete preset {n}', { n: selected + 1 })}
          onClick={() => onClear(selected)}
        >
          <TrashIcon />
        </button>
      )}
    </div>
  )
}
