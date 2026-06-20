import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { controlGlyph, parseToken, type ControlToken, type PadFamily } from './gamepadMap'

/**
 * Per-pad, user-editable HID control LABEL layer (a pure DISPLAY-name layer).
 *
 * The browser's "standard" gamepad mapping mislabels controls on many
 * non-standard HID pads (e.g. a physical LB reports as button index 6 so it
 * draws as "LT", Y draws as "LB", Start draws as "R3", …). `controlGlyph()`
 * always assumes the STANDARD layout, so its names are wrong for those pads.
 *
 * This store lets the operator CORRECT a control's display name without
 * touching INPUT logic: bindings stay token-based, jog/tokenPressed are
 * unchanged. The user just picks the real-world name for whatever raw input
 * lights up in the live diagnostic, and that name then renders on every
 * bound-control chip too. Saved per pad in localStorage.
 *
 * UI-INDEPENDENT-ish: it imports `controlGlyph` only for the auto fallback in
 * `labelFor`; no React/DOM. Mirrors the persist pattern of `gamepadMap.ts`.
 */

/**
 * Identify the PHYSICAL control for labelling. A bipolar axis HALF keeps its
 * DIRECTION, because a hat/stick axis carries TWO distinct controls (e.g. the
 * HID reports the D-pad as axes: axis = left(−)/right(+) or up(−)/down(+)) — they
 * must be labelled separately, not collapsed. A trigger axis is unidirectional,
 * so it collapses to one key; buttons are 1:1.
 *   - `a6+` → `a6+`, `a6-` → `a6-`  (D-pad → vs ←, ↑ vs ↓ — DISTINCT)
 *   - `t4`  → `t4`                  (one trigger)
 *   - `b6`  → `b6`
 * Returns the original token if it can't be parsed (defensive; never throws).
 */
export function baseToken(token: ControlToken): string {
  const p = parseToken(token)
  if (!p) return token
  if (p.kind === 'button') return `b${p.index}`
  if (p.trigger) return `t${p.index}`
  return `a${p.index}${p.dir > 0 ? '+' : '-'}`
}

interface GamepadLabelsStore {
  /** labels[padKey][baseToken] = user display name (non-empty). */
  labels: Record<string, Record<string, string>>

  /** Set (or, with an empty string, clear) the label for a pad's base control. */
  setLabel: (padKey: string, base: string, label: string) => void
  /** Clear the label for a pad's base control. */
  clearLabel: (padKey: string, base: string) => void
  /** Drop every custom label for a pad. */
  resetPad: (padKey: string) => void
}

export const useGamepadLabels = create<GamepadLabelsStore>()(
  persist(
    (set) => ({
      labels: {},

      setLabel: (padKey, base, label) =>
        set((s) => {
          const pad = { ...(s.labels[padKey] ?? {}) }
          const v = label.trim()
          if (!v) delete pad[base]
          else pad[base] = v
          return { labels: { ...s.labels, [padKey]: pad } }
        }),

      clearLabel: (padKey, base) =>
        set((s) => {
          const pad = s.labels[padKey]
          if (!pad || !(base in pad)) return s
          const next = { ...pad }
          delete next[base]
          return { labels: { ...s.labels, [padKey]: next } }
        }),

      resetPad: (padKey) =>
        set((s) => {
          if (!s.labels[padKey]) return s
          const { [padKey]: _drop, ...rest } = s.labels
          return { labels: rest }
        }),
    }),
    {
      name: 'karmyogi.gamepadLabels',
      version: 1,
      // Persist only the data.
      partialize: (s) => ({ labels: s.labels }),
    },
  ),
)

/** Read the saved label for a pad's base control from a snapshot (or undefined). */
export function getLabel(
  state: Pick<GamepadLabelsStore, 'labels'>,
  padKey: string,
  base: string,
): string | undefined {
  const v = state.labels[padKey]?.[base]
  return v && v.length > 0 ? v : undefined
}

/**
 * The display name for a token: the user's label for its base control if set,
 * else the auto glyph from `controlGlyph` (the standard-layout assumption).
 */
export function labelFor(
  padKey: string,
  token: ControlToken,
  family: PadFamily,
  labels: Record<string, Record<string, string>>,
): string {
  const custom = labels[padKey]?.[baseToken(token)]
  if (custom && custom.length > 0) return custom
  return controlGlyph(token, family)
}

/**
 * Names offered in the "what is this really?" picker — the common physical
 * controls on a typical pad, in roughly standard order.
 */
export const STD_CONTROL_NAMES: string[] = [
  'A',
  'B',
  'X',
  'Y',
  'LB',
  'RB',
  'LT',
  'RT',
  'Back/Select',
  'Start',
  'L3',
  'R3',
  'D-pad ↑',
  'D-pad ↓',
  'D-pad ←',
  'D-pad →',
  'ML',
  'MR',
  'Home',
]
