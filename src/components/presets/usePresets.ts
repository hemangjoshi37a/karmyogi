import { useMemo, useState } from 'react'
import { usePersistentState } from '../../store'

// ============================================================================
// Generic, color-coded SETTING PRESETS
// ----------------------------------------------------------------------------
// A small, reusable preset system extracted from the 2D/3D Carving tab so any
// parametric tab can offer the SAME UI: a floating left rail of colour swatches
// (load a slot) + a footer save-bar (write the CURRENT settings into a slot).
//
// A preset is an arbitrary, JSON-serializable settings snapshot `S` captured by
// the caller's `capture()` and restored by the caller's `onApply()`. The hook
// only owns the NAMED LIST of slots + which slot is selected, persisted under a
// per-tab `storageKey` (so carving / soldering / writing are independent).
// ============================================================================

/** Ten fixed, well-spaced hues — each is one preset SLOT (by position). */
export const PRESET_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#22c55e', '#10b981',
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899',
] as const

/** One slot: a fixed colour (by position), an optional name, and a snapshot. */
export interface PresetSlot<S> {
  /** Fixed by position (PRESET_COLORS[i]); persisted for forward-compat. */
  color: string
  /** Optional human label shown in tooltips + the save-bar. */
  name: string
  /** The captured settings, or null for an empty slot. */
  preset: S | null
}

/** Default slot array: 10 empty slots with the canonical colours. */
function defaultSlots<S>(): PresetSlot<S>[] {
  return PRESET_COLORS.map((color) => ({ color, name: '', preset: null }))
}

/**
 * Coerce a persisted (possibly older / shorter / colour-drifted) slot array into
 * exactly 10 slots with the canonical colours, preserving any saved name/preset
 * by position. Guards the UI from schema drift in localStorage.
 */
function normalizeSlots<S>(raw: unknown): PresetSlot<S>[] {
  const arr = Array.isArray(raw) ? raw : []
  return PRESET_COLORS.map((color, i) => {
    const s = arr[i] as Partial<PresetSlot<S>> | undefined
    return {
      color,
      name: typeof s?.name === 'string' ? s.name : '',
      preset: s && typeof s.preset === 'object' && s.preset !== null ? (s.preset as S) : null,
    }
  })
}

export interface UsePresetsOptions<S> {
  /** localStorage key the named slot list persists under (per tab). */
  storageKey: string
  /** Snapshot the CURRENT settings into a serializable preset. */
  capture: () => S
  /** Restore a captured preset into the live settings. */
  onApply: (preset: S) => void
}

/** Everything a PresetRail + PresetSaveBar need to render + drive a tab. */
export interface UsePresetsResult<S> {
  slots: PresetSlot<S>[]
  selected: number
  /** Load slot `i` (applies its preset when filled) and make it the target. */
  load: (i: number) => void
  /** Capture the current settings into slot `i` and make it the target. */
  save: (i: number) => void
  /** Empty slot `i` (clears its preset + name). */
  clear: (i: number) => void
  /** Rename slot `i`. */
  rename: (i: number, name: string) => void
  /** Select slot `i` as the save/highlight target without loading it. */
  select: (i: number) => void
}

/**
 * Persist a NAMED LIST of preset slots for one tab and expose the handlers the
 * generic PresetRail / PresetSaveBar consume. The settings shape `S` is opaque
 * here — `capture()` produces it and `onApply()` restores it.
 */
export function usePresets<S>({
  storageKey,
  capture,
  onApply,
}: UsePresetsOptions<S>): UsePresetsResult<S> {
  const [raw, setRaw] = usePersistentState<PresetSlot<S>[]>(storageKey, defaultSlots<S>())
  const slots = useMemo(() => normalizeSlots<S>(raw), [raw])
  // The slot the save-bar targets + the rail highlights (kept in sync between them).
  const [selected, setSelected] = useState(0)

  const load = (i: number) => {
    setSelected(i)
    const s = slots[i]
    if (s?.preset) onApply(s.preset)
  }
  const save = (i: number) => {
    const snap = capture()
    setRaw(slots.map((s, idx) => (idx === i ? { ...s, preset: snap } : s)))
    setSelected(i)
  }
  const clear = (i: number) =>
    setRaw(slots.map((s, idx) => (idx === i ? { ...s, preset: null, name: '' } : s)))
  const rename = (i: number, name: string) =>
    setRaw(slots.map((s, idx) => (idx === i ? { ...s, name } : s)))

  return { slots, selected, load, save, clear, rename, select: setSelected }
}
