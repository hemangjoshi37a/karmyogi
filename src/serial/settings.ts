// GRBL `$`-settings (NOT app settings).
//
// `$$` makes GRBL dump every setting as `$<n>=<val>` lines, e.g.:
//   $0=10
//   $100=250.000
//   $120=10.000
// Writing a setting is `$<n>=<val>` (GRBL replies `ok`). This module parses the
// echoed lines and builds the `$<n>=<val>` write commands; it also carries a
// human-readable label/units table for the common GRBL v1.1 settings so the
// Motion panel can render them.

export interface GrblSetting {
  /** Setting number, e.g. 120 for X acceleration. */
  number: number
  /** Raw value as reported (string preserves precision/format). */
  value: string
  /** Parsed numeric value (NaN if non-numeric). */
  numeric: number
}

export interface GrblSettingMeta {
  /** English label (source-of-truth + i18n fallback). */
  label: string
  /** i18n key for {@link label}, resolved with `t(labelKey, label)` at the UI boundary. */
  labelKey: string
  /** Unit string, e.g. "mm/min". English fallback. */
  units?: string
  /**
   * i18n key for {@link units}. Many GRBL units are universal symbols (mm, ms,
   * rpm, µs) that don't translate, but mm/min / step/mm / mm/sec² do, so each
   * carries a key the UI resolves with `t(unitsKey, units)`.
   */
  unitsKey?: string
}

/**
 * A subset of the well-known GRBL v1.1 settings for UI labels.
 *
 * Each entry carries both the English `label`/`units` (source-of-truth + the
 * i18n fallback) and a `labelKey`/`unitsKey` so the Motion panel resolves the
 * translated string via `t(labelKey, label)` at the UI boundary — this module
 * stays pure (no React/i18n imports) and portable, mirroring the Qt `cadcam` lib.
 */
export const GRBL_SETTING_META: Record<number, GrblSettingMeta> = {
  0: { label: 'Step pulse', labelKey: 'set.0.label', units: 'µs' },
  1: { label: 'Step idle delay', labelKey: 'set.1.label', units: 'ms' },
  2: { label: 'Step port invert mask', labelKey: 'set.2.label' },
  3: { label: 'Direction port invert mask', labelKey: 'set.3.label' },
  4: { label: 'Step enable invert', labelKey: 'set.4.label' },
  5: { label: 'Limit pins invert', labelKey: 'set.5.label' },
  6: { label: 'Probe pin invert', labelKey: 'set.6.label' },
  10: { label: 'Status report mask', labelKey: 'set.10.label' },
  11: { label: 'Junction deviation', labelKey: 'set.11.label', units: 'mm' },
  12: { label: 'Arc tolerance', labelKey: 'set.12.label', units: 'mm' },
  13: { label: 'Report in inches', labelKey: 'set.13.label' },
  20: { label: 'Soft limits enable', labelKey: 'set.20.label' },
  21: { label: 'Hard limits enable', labelKey: 'set.21.label' },
  22: { label: 'Homing cycle enable', labelKey: 'set.22.label' },
  23: { label: 'Homing dir invert mask', labelKey: 'set.23.label' },
  24: { label: 'Homing feed', labelKey: 'set.24.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  25: { label: 'Homing seek', labelKey: 'set.25.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  26: { label: 'Homing debounce', labelKey: 'set.26.label', units: 'ms' },
  27: { label: 'Homing pull-off', labelKey: 'set.27.label', units: 'mm' },
  30: { label: 'Max spindle speed', labelKey: 'set.30.label', units: 'rpm' },
  31: { label: 'Min spindle speed', labelKey: 'set.31.label', units: 'rpm' },
  32: { label: 'Laser mode enable', labelKey: 'set.32.label' },
  100: { label: 'X steps/mm', labelKey: 'set.100.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  101: { label: 'Y steps/mm', labelKey: 'set.101.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  102: { label: 'Z steps/mm', labelKey: 'set.102.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  110: { label: 'X max rate', labelKey: 'set.110.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  111: { label: 'Y max rate', labelKey: 'set.111.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  112: { label: 'Z max rate', labelKey: 'set.112.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  120: { label: 'X acceleration', labelKey: 'set.120.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  121: { label: 'Y acceleration', labelKey: 'set.121.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  122: { label: 'Z acceleration', labelKey: 'set.122.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  130: { label: 'X max travel', labelKey: 'set.130.label', units: 'mm' },
  131: { label: 'Y max travel', labelKey: 'set.131.label', units: 'mm' },
  132: { label: 'Z max travel', labelKey: 'set.132.label', units: 'mm' },
}

const SETTING_RE = /^\$(\d+)\s*=\s*(.+?)\s*$/

/** Parse a single `$<n>=<val>` line; returns undefined if it isn't one. */
export function parseSettingLine(line: string): GrblSetting | undefined {
  const m = SETTING_RE.exec(line.trim())
  if (!m) return undefined
  const number = parseInt(m[1], 10)
  const value = m[2]
  return { number, value, numeric: parseFloat(value) }
}

/**
 * Parse a block of `$$` output into a map keyed by setting number. Non-setting
 * lines (`ok`, status reports, blanks) are ignored.
 */
export function parseSettingsBlock(
  text: string | string[],
): Map<number, GrblSetting> {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/)
  const out = new Map<number, GrblSetting>()
  for (const line of lines) {
    const s = parseSettingLine(line)
    if (s) out.set(s.number, s)
  }
  return out
}

/** Build the command that requests all settings. */
export function readSettingsCommand(): string {
  return '$$'
}

/** Build a `$<n>=<val>` write command for the given setting. */
export function writeSettingCommand(
  number: number,
  value: number | string,
): string {
  return `$${number}=${value}`
}

/** Get a human label for a setting number. */
export function settingLabel(number: number): string {
  return GRBL_SETTING_META[number]?.label ?? `Setting $${number}`
}
