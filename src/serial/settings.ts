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
  label: string
  units?: string
}

/** A subset of the well-known GRBL v1.1 settings for UI labels. */
export const GRBL_SETTING_META: Record<number, GrblSettingMeta> = {
  0: { label: 'Step pulse', units: 'µs' },
  1: { label: 'Step idle delay', units: 'ms' },
  2: { label: 'Step port invert mask' },
  3: { label: 'Direction port invert mask' },
  4: { label: 'Step enable invert' },
  5: { label: 'Limit pins invert' },
  6: { label: 'Probe pin invert' },
  10: { label: 'Status report mask' },
  11: { label: 'Junction deviation', units: 'mm' },
  12: { label: 'Arc tolerance', units: 'mm' },
  13: { label: 'Report in inches' },
  20: { label: 'Soft limits enable' },
  21: { label: 'Hard limits enable' },
  22: { label: 'Homing cycle enable' },
  23: { label: 'Homing dir invert mask' },
  24: { label: 'Homing feed', units: 'mm/min' },
  25: { label: 'Homing seek', units: 'mm/min' },
  26: { label: 'Homing debounce', units: 'ms' },
  27: { label: 'Homing pull-off', units: 'mm' },
  30: { label: 'Max spindle speed', units: 'rpm' },
  31: { label: 'Min spindle speed', units: 'rpm' },
  32: { label: 'Laser mode enable' },
  100: { label: 'X steps/mm', units: 'step/mm' },
  101: { label: 'Y steps/mm', units: 'step/mm' },
  102: { label: 'Z steps/mm', units: 'step/mm' },
  110: { label: 'X max rate', units: 'mm/min' },
  111: { label: 'Y max rate', units: 'mm/min' },
  112: { label: 'Z max rate', units: 'mm/min' },
  120: { label: 'X acceleration', units: 'mm/sec²' },
  121: { label: 'Y acceleration', units: 'mm/sec²' },
  122: { label: 'Z acceleration', units: 'mm/sec²' },
  130: { label: 'X max travel', units: 'mm' },
  131: { label: 'Y max travel', units: 'mm' },
  132: { label: 'Z max travel', units: 'mm' },
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
