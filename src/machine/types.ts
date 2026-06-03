// Machine-abstraction layer — types (plan.md §8.5).
//
// Pure type/interface definitions for the pluggable controller + machine-type
// abstraction. No React/DOM/serial imports — this stays portable and mirrors the
// "capabilities-driven" design from plan.md §8.2–§8.4. Panels can read the active
// `Capabilities` to hide/adapt controls (e.g. no Z-probe UI on a laser) without a
// hard-coded GRBL assumption.

/** Firmware backend a profile targets. */
export type ControllerKind =
  | 'grbl'
  | 'fluidnc'
  | 'grblhal'
  | 'marlin'
  | 'smoothieware'
  | 'ruida'
  | 'ezcad'
  | 'fscut'

/**
 * Physical machine kind. Drives the UI + CAM:
 *  - `cnc3`   — 3-axis router/mill/plotter/solder/PCB (depth-pass CAM). The default.
 *  - `laser2d`— CO2 laser cutter/engraver: XY + power/PWM, "Z" is focus not depth.
 *  - `galvo`  — galvanometer fiber/UV marker (EzCAD/BJJCZ): no XY stages, the beam
 *               is steered by mirrors; XY is the scan field, "Z" is focus height.
 *  - `cnc4` / `cnc5` — rotary / full multi-axis (future).
 */
export type MachineType = 'cnc3' | 'laser2d' | 'galvo' | 'cnc4' | 'cnc5'

/** A controller axis letter (logical CAM axes map onto these). */
export type Axis = 'X' | 'Y' | 'Z' | 'A' | 'B' | 'C'

/** How well karmyogi can actually drive a controller today. */
export type SupportLevel = 'full' | 'experimental'

/** Transport used to reach the controller. Web Serial only, for now. */
export type Transport = 'webserial'

/**
 * How a controller stores/exposes its host-editable machine settings. Drives the
 * Motion panel: it must stop assuming every controller speaks GRBL `$`-settings.
 *  - `grbl`     — classic GRBL `$N=value` numbered settings (read via `$$`).
 *  - `grblhal`  — GRBL-compatible `$`-settings, an extended superset (same editor).
 *  - `marlin`   — settings live in EEPROM, managed via M-codes (M503 report, M500 save).
 *  - `smoothie` — settings live in the `config` file (`config-get` / `config-set`).
 *  - `none`     — no host-editable machine settings over this connection (lasers).
 */
export type SettingsModel = 'grbl' | 'grblhal' | 'marlin' | 'smoothie' | 'none'

/**
 * Capability flags the rest of the app branches on instead of hard-coding GRBL.
 * Mirrors the `capabilities` object sketched in plan.md §8.2.
 */
export interface Capabilities {
  axes: Axis[]
  hasSpindle: boolean
  hasLaser: boolean
  hasHoming: boolean
  hasProbe: boolean
}

/**
 * A controller profile: identity + machine type + capabilities + honesty flags.
 * `grblCompatible` means it speaks the GRBL streaming/realtime/status dialect, so
 * the existing `src/serial/*` transport drives it unchanged.
 */
export interface ControllerProfile {
  kind: ControllerKind
  /** Human-facing name (proper noun — not translated). */
  label: string
  machineType: MachineType
  /** Default serial baud rate for this controller. */
  baud: number
  capabilities: Capabilities
  /** Does this firmware speak the GRBL dialect (so our streaming path works)? */
  grblCompatible: boolean
  /** How well we actually support it today. */
  supported: SupportLevel
  transport: Transport
  /**
   * How this controller stores/exposes host-editable machine settings — drives
   * which editor the Motion panel renders (GRBL `$`-table vs. an honest M-code /
   * config-file view vs. "no settings over this connection").
   */
  settingsModel: SettingsModel
  /** Short note shown in the UI / tooltip. */
  notes: string
}
