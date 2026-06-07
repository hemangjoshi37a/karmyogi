// Enriched GRBL `$`-settings metadata for the Motion panel (W11).
//
// Builds ON TOP of `GRBL_SETTING_META` (label + units) from `../serial/settings`
// — we do NOT duplicate labels here. This table adds, per setting:
//   - `group`: which UI section it belongs to,
//   - `description`: what it does + a typical/default value,
//   - `min` / `max`: a SANE validation range so the panel can flag corrupted
//     EEPROM values (the motivating incident: $100=2147483.648,
//     $130=-2147483.648, rates/accels stuck at 0 -> error:15 on every jog).
//
// Ranges are intentionally generous (cover hobby through small-industrial GRBL
// machines) — the goal is to catch *garbage* (negative, zero where impossible,
// or the int32 overflow sentinel), not to second-guess a valid config.

import { GRBL_SETTING_META, type GrblSettingMeta } from '../serial/settings'

/** Logical grouping for the settings table sections. */
export type GrblSettingGroup =
  | 'stepper'
  | 'limits'
  | 'spindle'
  | 'steps'
  | 'maxrate'
  | 'accel'
  | 'maxtravel'
  | 'other'

export interface GrblGroupInfo {
  id: GrblSettingGroup
  title: string
  /** i18n key for `title` (English `title` stays the inline fallback). */
  titleKey: string
  /** Order the section appears in. */
  order: number
}

/** Section definitions, in display order. */
export const GRBL_GROUPS: GrblGroupInfo[] = [
  { id: 'stepper', title: 'Stepper & ports', titleKey: 'motion.group.stepper', order: 0 },
  { id: 'limits', title: 'Limits & homing', titleKey: 'motion.group.limits', order: 1 },
  { id: 'spindle', title: 'Spindle / laser', titleKey: 'motion.group.spindle', order: 2 },
  { id: 'steps', title: 'Steps per mm', titleKey: 'motion.group.steps', order: 3 },
  { id: 'maxrate', title: 'Max rate', titleKey: 'motion.group.maxrate', order: 4 },
  { id: 'accel', title: 'Acceleration', titleKey: 'motion.group.accel', order: 5 },
  { id: 'maxtravel', title: 'Max travel', titleKey: 'motion.group.maxtravel', order: 6 },
  { id: 'other', title: 'Other', titleKey: 'motion.group.other', order: 7 },
]

/**
 * The int32-microvalue overflow sentinel GRBL prints when a setting word wraps:
 * 2147483648 / 1000 = 2147483.648. Either sign is a sure sign of corruption.
 */
export const INT32_SENTINEL = 2147483.648

export interface GrblSettingRichMeta {
  group: GrblSettingGroup
  description: string
  /** i18n key for `description` (English `description` stays the inline fallback). */
  descKey: string
  /** Inclusive sane minimum, or undefined if effectively unbounded below. */
  min?: number
  /** Inclusive sane maximum, or undefined if effectively unbounded above. */
  max?: number
  /** True when zero/negative is physically invalid (must be strictly > 0). */
  mustBePositive?: boolean
}

/**
 * Per-setting enrichment. Keyed by GRBL setting number. Label + units come from
 * `GRBL_SETTING_META`; this only adds group/description/range.
 */
export const GRBL_SETTING_RICH: Record<number, GrblSettingRichMeta> = {
  // --- Stepper & ports ($0–$6, $10–$13) ---
  0: {
    group: 'stepper',
    description: 'Step pulse width sent to the stepper drivers. Default 10 µs; most drivers want 3–10 µs.',
    descKey: 'motion.set.0.desc',
    min: 1,
    max: 255,
  },
  1: {
    group: 'stepper',
    description: 'Idle delay before steppers are disabled. Default 25 ms; 255 keeps them always on.',
    descKey: 'motion.set.1.desc',
    min: 0,
    max: 255,
  },
  2: {
    group: 'stepper',
    description: 'Bitmask inverting the step pulse signal per axis. Default 0 (no inversion).',
    descKey: 'motion.set.2.desc',
    min: 0,
    max: 7,
  },
  3: {
    group: 'stepper',
    description: 'Bitmask inverting the direction signal per axis (flip an axis that runs backwards). Default 0.',
    descKey: 'motion.set.3.desc',
    min: 0,
    max: 7,
  },
  4: {
    group: 'stepper',
    description: 'Invert the stepper-enable pin (some drivers are active-high). Default 0 (off).',
    descKey: 'motion.set.4.desc',
    min: 0,
    max: 1,
  },
  5: {
    group: 'stepper',
    description: 'Invert the limit-switch pins (NC vs NO wiring). Default 0 (off).',
    descKey: 'motion.set.5.desc',
    min: 0,
    max: 1,
  },
  6: {
    group: 'stepper',
    description: 'Invert the probe pin. Default 0 (off).',
    descKey: 'motion.set.6.desc',
    min: 0,
    max: 1,
  },
  10: {
    group: 'stepper',
    description: 'Status report content bitmask (which fields `?` returns). Default 1 (MPos + buffer).',
    descKey: 'motion.set.10.desc',
    min: 0,
    max: 255,
  },
  11: {
    group: 'stepper',
    description: 'Junction deviation — cornering aggressiveness. Default 0.010 mm; smaller = slower, smoother corners.',
    descKey: 'motion.set.11.desc',
    min: 0,
    max: 10,
  },
  12: {
    group: 'stepper',
    description: 'Arc chord tolerance for G2/G3 segmentation. Default 0.002 mm.',
    descKey: 'motion.set.12.desc',
    min: 0,
    max: 10,
  },
  13: {
    group: 'stepper',
    description: 'Report positions in inches instead of mm. Default 0 (mm).',
    descKey: 'motion.set.13.desc',
    min: 0,
    max: 1,
  },

  // --- Limits & homing ($20–$27) ---
  20: {
    group: 'limits',
    description: 'Soft limits: refuse moves beyond max travel ($130–$132). Default 0. Needs homing enabled. Corrupt $130–$132 + this on = error:15 on every jog.',
    descKey: 'motion.set.20.desc',
    min: 0,
    max: 1,
  },
  21: {
    group: 'limits',
    description: 'Hard limits: trip an alarm when a limit switch closes. Default 0 (off).',
    descKey: 'motion.set.21.desc',
    min: 0,
    max: 1,
  },
  22: {
    group: 'limits',
    description: 'Enable the homing cycle ($H). Default 0 (off) on many hobby setups.',
    descKey: 'motion.set.22.desc',
    min: 0,
    max: 1,
  },
  23: {
    group: 'limits',
    description: 'Homing direction invert bitmask (which corner to home to). Default 0.',
    descKey: 'motion.set.23.desc',
    min: 0,
    max: 7,
  },
  24: {
    group: 'limits',
    description: 'Slow homing feed used to precisely locate switches. Default 25 mm/min.',
    descKey: 'motion.set.24.desc',
    min: 1,
    max: 10000,
  },
  25: {
    group: 'limits',
    description: 'Fast homing seek rate to find switches initially. Default 500 mm/min.',
    descKey: 'motion.set.25.desc',
    min: 1,
    max: 30000,
  },
  26: {
    group: 'limits',
    description: 'Homing switch debounce delay. Default 250 ms.',
    descKey: 'motion.set.26.desc',
    min: 0,
    max: 1000,
  },
  27: {
    group: 'limits',
    description: 'Pull-off distance reversed after homing so switches release. Default 1.000 mm.',
    descKey: 'motion.set.27.desc',
    min: 0,
    max: 100,
  },

  // --- Spindle / laser ($30–$32) ---
  30: {
    group: 'spindle',
    description: 'Spindle RPM at maximum PWM (S value for 100%). Default 1000.',
    descKey: 'motion.set.30.desc',
    min: 0,
    max: 100000,
  },
  31: {
    group: 'spindle',
    description: 'Spindle RPM at minimum PWM. Default 0.',
    descKey: 'motion.set.31.desc',
    min: 0,
    max: 100000,
  },
  32: {
    group: 'spindle',
    description: 'Laser mode: dynamic power with motion (M4), no spin-up dwell. Default 0 (off). Turn ON for laser, OFF for a real spindle.',
    descKey: 'motion.set.32.desc',
    min: 0,
    max: 1,
  },

  // --- Steps per mm ($100–$102) — must be > 0 ---
  100: {
    group: 'steps',
    description: 'X axis resolution in steps per mm (motor steps × microstepping ÷ travel per rev). Typical 80–800. Must be > 0.',
    descKey: 'motion.set.100.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  101: {
    group: 'steps',
    description: 'Y axis steps per mm. Typical 80–800. Must be > 0.',
    descKey: 'motion.set.101.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  102: {
    group: 'steps',
    description: 'Z axis steps per mm (leadscrews are often much higher). Typical 80–4000. Must be > 0.',
    descKey: 'motion.set.102.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },

  // --- Max rate ($110–$112) — must be > 0 ---
  110: {
    group: 'maxrate',
    description: 'X maximum feed rate (rapid speed cap). Typical 500–10000 mm/min. Must be > 0 or the axis never moves.',
    descKey: 'motion.set.110.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  111: {
    group: 'maxrate',
    description: 'Y maximum feed rate. Typical 500–10000 mm/min. Must be > 0.',
    descKey: 'motion.set.111.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  112: {
    group: 'maxrate',
    description: 'Z maximum feed rate (usually slower than X/Y). Typical 100–3000 mm/min. Must be > 0.',
    descKey: 'motion.set.112.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },

  // --- Acceleration ($120–$122) — must be > 0. GRBL is LINEAR accel only. ---
  120: {
    group: 'accel',
    description: 'X acceleration (linear ramp — GRBL has no S-curve). Typical 10–1000 mm/sec². Must be > 0.',
    descKey: 'motion.set.120.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  121: {
    group: 'accel',
    description: 'Y acceleration (linear ramp). Typical 10–1000 mm/sec². Must be > 0.',
    descKey: 'motion.set.121.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  122: {
    group: 'accel',
    description: 'Z acceleration (linear ramp, usually lower). Typical 10–500 mm/sec². Must be > 0.',
    descKey: 'motion.set.122.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },

  // --- Max travel ($130–$132) — must be > 0 when soft limits used ---
  130: {
    group: 'maxtravel',
    description: 'X axis usable travel, used by soft limits. Must match your machine. Bad values (0, negative, or the int32 sentinel) trigger error:15.',
    descKey: 'motion.set.130.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  131: {
    group: 'maxtravel',
    description: 'Y axis usable travel for soft limits. Must be > 0 when $20=1.',
    descKey: 'motion.set.131.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
  132: {
    group: 'maxtravel',
    description: 'Z axis usable travel for soft limits. Must be > 0 when $20=1.',
    descKey: 'motion.set.132.desc',
    min: 1,
    max: 100000,
    mustBePositive: true,
  },
}

/** Resolve a setting's group, falling back to 'other' for unknown numbers. */
export function settingGroup(number: number): GrblSettingGroup {
  return GRBL_SETTING_RICH[number]?.group ?? 'other'
}

/** Combined label+units (from serial) for a number, with a raw fallback. */
export function settingMeta(number: number): GrblSettingMeta {
  return GRBL_SETTING_META[number] ?? { label: `$${number}`, labelKey: `set.${number}.label` }
}

/**
 * GRBL v1.1 generic firmware defaults — used by the per-setting "reset" button
 * so a user can change one value, test, and safely put it back to a known-good
 * default. (These are the stock `defaults.h` GENERIC values.)
 */
export const GRBL_DEFAULTS: Record<number, string> = {
  0: '10', 1: '25', 2: '0', 3: '0', 4: '0', 5: '0', 6: '0',
  10: '1', 11: '0.010', 12: '0.002', 13: '0',
  20: '0', 21: '0', 22: '0', 23: '0', 24: '25.000', 25: '500.000', 26: '250', 27: '1.000',
  30: '1000', 31: '0', 32: '0',
  100: '250.000', 101: '250.000', 102: '250.000',
  110: '500.000', 111: '500.000', 112: '500.000',
  120: '10.000', 121: '10.000', 122: '10.000',
  130: '200.000', 131: '200.000', 132: '200.000',
}

/** Firmware default value for a setting (string), or undefined if unknown. */
export function settingDefault(number: number): string | undefined {
  return GRBL_DEFAULTS[number]
}

/**
 * Machine-specific known-good default profile (from the user's controller spec
 * sheet). The Motion panel's "Restore defaults" writes these exact `$N=value`
 * settings so a corrupted/unknown board is set to a correct configuration
 * (steps/mm 1600, max rate 1000, accel 30, travel 200, etc.) rather than relying
 * on whatever the firmware's generic defaults happen to be.
 */
export const MACHINE_DEFAULT_PROFILE: Record<number, string> = {
  0: '10', 1: '26', 2: '0', 3: '0', 4: '0', 5: '0', 6: '0',
  10: '1', 11: '0.010', 12: '0.002', 13: '0',
  20: '0', 21: '0', 22: '0', 23: '0', 24: '25.000', 25: '500.000', 26: '250', 27: '1.000',
  30: '1000', 31: '0', 32: '0',
  100: '1600.000', 101: '1600.000', 102: '1600.000',
  110: '1000.000', 111: '1000.000', 112: '1000.000',
  120: '30.000', 121: '30.000', 122: '30.000',
  130: '200.000', 131: '200.000', 132: '200.000',
}

/**
 * Human "typical range" text for a setting, e.g. "1–255 µs" or "≥ 1 mm/min".
 * Returns undefined for settings without a known range.
 */
export function settingRangeText(number: number): string | undefined {
  const m = GRBL_SETTING_RICH[number]
  if (!m || (m.min === undefined && m.max === undefined)) return undefined
  const units = GRBL_SETTING_META[number]?.units
  const u = units ? ` ${units}` : ''
  if (m.min !== undefined && m.max !== undefined) return `${m.min}–${m.max}${u}`
  if (m.min !== undefined) return `≥ ${m.min}${u}`
  return `≤ ${m.max}${u}`
}

export interface SettingValidation {
  /** True if the value looks corrupt / out of sane range. */
  bad: boolean
  /** Worst-case severity for styling. */
  severity: 'ok' | 'warn' | 'danger'
  /**
   * English hint shown next to the field when bad — also the i18n fallback. This
   * module stays pure (no React/i18n imports); the panel resolves the translated
   * string via `t(hintKey, hint, hintParams)` at the UI boundary.
   */
  hint?: string
  /** i18n key for {@link hint}. */
  hintKey?: string
  /** Interpolation params for the i18n hint (e.g. the sane min/max). */
  hintParams?: Record<string, string | number>
}

/**
 * Validate a numeric setting value against its sane range + corruption rules.
 * `danger` = almost-certainly-corrupt (sentinel / impossible). `warn` =
 * out of the sane range but not obviously garbage.
 *
 * Hints are returned as English text + an i18n key (and optional params) so the
 * panel can translate them with `t()` without this pure module importing React.
 */
export function validateSetting(number: number, numeric: number): SettingValidation {
  // Non-numeric / NaN -> can't be trusted.
  if (!Number.isFinite(numeric)) {
    return {
      bad: true,
      severity: 'danger',
      hint: 'not a number — looks corrupted, consider factory reset',
      hintKey: 'motion.validate.nan',
    }
  }

  // The int32 overflow sentinel (either sign) — unambiguous corruption.
  if (Math.abs(Math.abs(numeric) - INT32_SENTINEL) < 1e-6) {
    return {
      bad: true,
      severity: 'danger',
      hint: 'int32 overflow value — EEPROM corrupted, consider factory reset ($RST=$)',
      hintKey: 'motion.validate.sentinel',
    }
  }

  const meta = GRBL_SETTING_RICH[number]
  if (!meta) {
    // Unknown setting: only flag the obviously-broken (sentinel handled above).
    return { bad: false, severity: 'ok' }
  }

  // Physically must be > 0 (steps/mm, max rate, accel, max travel).
  if (meta.mustBePositive && numeric <= 0) {
    return numeric === 0
      ? {
          bad: true,
          severity: 'danger',
          hint: 'zero is invalid here — axis cannot move; looks corrupted, consider factory reset',
          hintKey: 'motion.validate.zero',
        }
      : {
          bad: true,
          severity: 'danger',
          hint: 'negative is invalid here — looks corrupted, consider factory reset',
          hintKey: 'motion.validate.negative',
        }
  }

  // Generic sane-range check.
  if (meta.min !== undefined && numeric < meta.min) {
    return {
      bad: true,
      severity: 'warn',
      hint: `below sane minimum (${meta.min})`,
      hintKey: 'motion.validate.belowMin',
      hintParams: { min: meta.min },
    }
  }
  if (meta.max !== undefined && numeric > meta.max) {
    return {
      bad: true,
      severity: 'warn',
      hint: `above sane maximum (${meta.max})`,
      hintKey: 'motion.validate.aboveMax',
      hintParams: { max: meta.max },
    }
  }

  return { bad: false, severity: 'ok' }
}
