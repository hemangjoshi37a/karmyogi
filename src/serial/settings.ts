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
//
// FluidNC: for sender compatibility FluidNC KEEPS GRBL's NUMBERED `$$` dump, but
// only for the SUBSET of settings that carry a `grblName` (firmware:
// ProcessSettings.cpp `report_normal_settings` → `show_settings(out, GRBL)`). So a
// FluidNC `$$` looks like a (small) classic GRBL dump:
//   $10=1
//   $20=0            ← read-only proxy (derived from the YAML config)
//   $100=80.000      ← writable (writes the live config field, persists config.yaml)
//   $110=1000.000
// FluidNC's deeper, NAMED settings (`$axes/x/steps_per_mm=80.000`, `$Firmware/Build=…`)
// come from `$S` / `$<name>` — NOT `$$`. This module parses BOTH styles: numeric
// lines feed `useGrblSettings`; named lines are captured into `useNamedSettings`
// (a small persisted snapshot store mirroring src/store/grblSettings.ts). The
// capture rides on `parseSettingLine`, which the controller already calls on every
// received line, so no controller change is needed. The numeric GRBL path is
// byte-for-byte unchanged. See FLUIDNC_NUMBERS / fluidncSettingSupport below for
// exactly which numbered settings FluidNC exposes and which are writable.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
// No runtime cycle: grblSettings.ts only imports a TYPE from this module.
import { useGrblSettings } from '../store/grblSettings'

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
  // Extra axes (A/B/C — the 4th/5th/6th). GRBL is 3-axis, but FluidNC / grblHAL
  // expose these for rotary/extended machines, continuing the $1NN axis pattern.
  103: { label: 'A steps/mm', labelKey: 'set.103.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  104: { label: 'B steps/mm', labelKey: 'set.104.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  105: { label: 'C steps/mm', labelKey: 'set.105.label', units: 'step/mm', unitsKey: 'set.units.stepPerMm' },
  113: { label: 'A max rate', labelKey: 'set.113.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  114: { label: 'B max rate', labelKey: 'set.114.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  115: { label: 'C max rate', labelKey: 'set.115.label', units: 'mm/min', unitsKey: 'set.units.mmPerMin' },
  123: { label: 'A acceleration', labelKey: 'set.123.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  124: { label: 'B acceleration', labelKey: 'set.124.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  125: { label: 'C acceleration', labelKey: 'set.125.label', units: 'mm/sec²', unitsKey: 'set.units.mmPerSec2' },
  133: { label: 'A max travel', labelKey: 'set.133.label', units: 'mm' },
  134: { label: 'B max travel', labelKey: 'set.134.label', units: 'mm' },
  135: { label: 'C max travel', labelKey: 'set.135.label', units: 'mm' },
}

// --- FluidNC numbered `$`-settings support -----------------------------------
//
// FluidNC keeps GRBL's NUMBERED settings for sender compatibility, but ONLY the
// subset its firmware registers with a `grblName`. From the FluidNC source
// (SettingsDefinitions.cpp `make_settings()` + `make_proxies()`,
// Settings.cpp `FloatProxySetting`/`IntProxySetting`):
//
//   WRITABLE via `$N=value` — a write updates the live MachineConfig field and
//   persists config.yaml (FloatProxySetting), or is a real NVS IntSetting:
//     $10            status report mask
//     $100..$10x     steps/mm        (one per axis)
//     $110..$11x     max rate        (one per axis)
//     $120..$12x     acceleration    (one per axis)
//     $130..$13x     max travel      (one per axis)
//
//   READ-ONLY — these IntProxySettings appear in `$$` but their setStringValue
//   returns Error::ReadOnlySetting; they are DERIVED from the YAML config and can
//   only be changed by editing the YAML (e.g. `$axes/x/soft_limits=true`):
//     $20 soft limits  $21 hard limits  $22 homing enable  $23 homing dir mask
//     $30 max spindle speed            $32 laser mode
//
// Every OTHER classic GRBL number ($0,$1,$2..$6,$11,$12,$13,$24..$27,$31) is NOT a
// numbered setting on FluidNC: it never appears in `$$` and `$N=` is rejected
// (those live in the YAML config, or — like $13 — are commands). The Motion panel
// uses this so it shows ONLY what FluidNC actually exposes (instead of fabricated
// GRBL defaults that silently "fail to sync") and marks the read-only rows.

/** FluidNC numbered settings that appear in `$$` but reject `$N=` (YAML-managed). */
export const FLUIDNC_READONLY_NUMBERS: ReadonlySet<number> = new Set<number>([
  20, 21, 22, 23, 30, 32,
])

/**
 * All numbered settings FluidNC exposes via the GRBL-compatible `$$` dump (covering
 * up to six axes for the steps/rate/accel/travel proxies). A live FluidNC reports
 * only the axes it actually has; the Motion panel unions this with whatever `$$`
 * returned, so extra/fewer axes are handled gracefully.
 */
export const FLUIDNC_NUMBERS: ReadonlySet<number> = new Set<number>([
  10, 20, 21, 22, 23, 30, 32,
  100, 101, 102, 103, 104, 105,
  110, 111, 112, 113, 114, 115,
  120, 121, 122, 123, 124, 125,
  130, 131, 132, 133, 134, 135,
])

/** Whether/how FluidNC supports a given GRBL setting number. */
export type FluidncSupport = 'writable' | 'readonly' | 'unsupported'

/**
 * Classify a GRBL setting number for FluidNC:
 *  - `writable`    — exposed in `$$` and `$N=value` is accepted + persisted.
 *  - `readonly`    — exposed in `$$` but `$N=` is rejected (configure via YAML).
 *  - `unsupported` — FluidNC never exposes this number at all.
 */
export function fluidncSettingSupport(number: number): FluidncSupport {
  if (FLUIDNC_READONLY_NUMBERS.has(number)) return 'readonly'
  if (FLUIDNC_NUMBERS.has(number)) return 'writable'
  return 'unsupported'
}

const SETTING_RE = /^\$(\d+)\s*=\s*(.+?)\s*$/

/** Pure numeric `$<n>=<val>` matcher (no side effects — used by block parsing). */
function matchNumericSetting(line: string): GrblSetting | undefined {
  const m = SETTING_RE.exec(line.trim())
  if (!m) return undefined
  const number = parseInt(m[1], 10)
  const value = m[2]
  return { number, value, numeric: parseFloat(value) }
}

/**
 * Parse a single `$<n>=<val>` line; returns undefined if it isn't one.
 *
 * This is the controller's per-received-line settings hook (src/serial/
 * controller.ts feeds every line here), so it doubles as the CAPTURE point for
 * FluidNC NAMED `$path/name=value` lines: those are recorded into
 * `useNamedSettings` as a side channel and still return undefined, which keeps
 * the controller's numeric store, console echo and ack accounting exactly as
 * before (a named line is treated like any other informational line).
 */
export function parseSettingLine(line: string): GrblSetting | undefined {
  const numeric = matchNumericSetting(line)
  if (numeric) return numeric
  const named = parseNamedSettingLine(line)
  if (named) recordNamedSetting(named)
  return undefined
}

/**
 * Parse a block of `$$` output into a map keyed by setting number. Non-setting
 * lines (`ok`, status reports, blanks, FluidNC named lines) are ignored.
 * Side-effect-free (safe for the Motion panel's import/paste dialog).
 */
export function parseSettingsBlock(
  text: string | string[],
): Map<number, GrblSetting> {
  const lines = Array.isArray(text) ? text : text.split(/\r?\n/)
  const out = new Map<number, GrblSetting>()
  for (const line of lines) {
    const s = matchNumericSetting(line)
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

// --- FluidNC NAMED `$`-settings ---------------------------------------------
//
// FluidNC's `$$` dumps `$path/name=value` lines (slash-separated names, not
// numbers). The numeric parsing/writing above is untouched; everything below is
// the named-style channel.

/** One FluidNC named setting as reported by `$$` / `$<name>`. */
export interface NamedSetting {
  /** Full setting path WITHOUT the leading `$`, e.g. 'axes/x/steps_per_mm'. */
  name: string
  /** Raw value text as reported (string preserves precision/format; may be empty). */
  value: string
}

// A named-setting line: `$axes/x/steps_per_mm=80.000`, `$Firmware/Build=…`,
// `$Hostname=fluidnc`. The name is letter-led path segments ([A-Za-z0-9_.-],
// '/'-separated). A minimum name length of 2 is enforced in code so a stray
// single-letter `$X=` / `$J=`-shaped token can never be mistaken for a setting;
// numeric `$N=` ids never reach this matcher (they are tried first).
const NAMED_SETTING_RE = /^\$([A-Za-z][A-Za-z0-9_.\-]*(?:\/[A-Za-z0-9_.\-]+)*)\s*=\s*(.*)$/

/** Parse a single FluidNC `$name=value` line; undefined if it isn't one. Pure. */
export function parseNamedSettingLine(line: string): NamedSetting | undefined {
  const m = NAMED_SETTING_RE.exec(line.trim())
  if (!m || m[1].length < 2) return undefined
  return { name: m[1], value: m[2].trim() }
}

/** Build a FluidNC `$<name>=<value>` write command. */
export function writeNamedSettingCommand(name: string, value: string | number): string {
  return `$${name}=${value}`
}

/** Build a FluidNC `$<name>` single-setting read command (replies `$name=value`). */
export function readNamedSettingCommand(name: string): string {
  return `$${name}`
}

// --- Named-settings snapshot store -------------------------------------------
//
// Mirror of src/store/grblSettings.ts for the NAMED style. It lives here (not in
// src/store/) because the capture hook is `parseSettingLine` above — the one
// settings entry point the controller already calls — and this workstream owns
// this file. The `$$` read lifecycle (loading flag, lastReadAt) is SHARED with
// `useGrblSettings`: the controller arms `loading` when it sends `$$` and calls
// `markRead()` on the terminating `ok` regardless of which line style came back,
// so the Motion panel reads loading/lastReadAt from there for both styles.

interface NamedSettingsStore {
  /** Setting name → raw value, as last reported. */
  values: Record<string, string>
  /** Replace/insert one captured setting. */
  setOne: (s: NamedSetting) => void
  clear: () => void
}

export const useNamedSettings = create<NamedSettingsStore>()(
  persist(
    (set) => ({
      values: {},
      setOne: (s) => set((st) => ({ values: { ...st.values, [s.name]: s.value } })),
      clear: () => set({ values: {} }),
    }),
    {
      name: 'karmyogi.namedSettings',
      // Persist the last-known snapshot so the table shows it after a refresh
      // (before a reconnect/sync), same as the numeric store.
      partialize: (s) => ({ values: s.values }),
    },
  ),
)

// Replace-on-dump semantics: when a `$$` read starts (useGrblSettings.loading
// goes false→true — armed by the controller for BOTH styles), the FIRST named
// line captured afterwards replaces the whole snapshot instead of upserting.
// That way a fresh dump drops settings that no longer exist (firmware update,
// different board) instead of accreting stale rows forever.
let freshDump = false
let prevLoading = useGrblSettings.getState().loading
useGrblSettings.subscribe((st) => {
  if (st.loading !== prevLoading) {
    prevLoading = st.loading
    if (st.loading) freshDump = true
  }
})

function recordNamedSetting(s: NamedSetting): void {
  if (freshDump) {
    freshDump = false
    useNamedSettings.setState({ values: { [s.name]: s.value } })
    return
  }
  const st = useNamedSettings.getState()
  if (st.values[s.name] === s.value) return // unchanged — avoid render churn
  st.setOne(s)
}
