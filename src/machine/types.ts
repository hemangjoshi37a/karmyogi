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
  | 'masso'
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
 *  - `masso`    — settings live entirely on the controller's own touchscreen; the
 *                 host has no editable-settings channel at all (offline/export target).
 *  - `none`     — no host-editable machine settings over this connection (lasers).
 */
export type SettingsModel = 'grbl' | 'grblhal' | 'marlin' | 'smoothie' | 'masso' | 'none'

/**
 * How a controller reports live machine status (state + position) so the serial
 * layer stops assuming everyone speaks GRBL's `<...>` realtime report.
 *  - `grbl`   — `?` realtime byte → `<Idle|MPos:…>` report (GRBL family).
 *  - `marlin` — no GRBL `?`; poll `M114` for position (and `M105` for temps); the
 *               reply is an `ok`-terminated `X:.. Y:.. Z:..` line, not `<...>`.
 *  - `none`   — no host status channel (proprietary controllers / Masso).
 */
export type StatusDialect = 'grbl' | 'marlin' | 'none'

/**
 * The concrete protocol differences the serial transport branches on, captured as
 * DATA so the GRBL path stays the default and other firmwares opt in to deviations
 * via a profile's `dialect`. Everything is optional with GRBL-shaped defaults
 * (see `resolveDialect` in src/serial/dialect.ts) so existing profiles are unchanged.
 */
export interface Dialect {
  /** How live status/position is queried + parsed. Defaults to `grbl`. */
  status?: StatusDialect
  /**
   * Does the controller honour GRBL single-byte realtime commands (`?`, `!`, `~`,
   * `0x18`, overrides)? GRBL/grblHAL/FluidNC: true. Marlin/Smoothie: false — they
   * have no realtime byte channel, so we must NOT spray those bytes at them.
   * Defaults to true.
   */
  realtimeBytes?: boolean
  /**
   * Line terminator for streamed commands. GRBL is tolerant of `\n`; Marlin and
   * Smoothie are happiest with `\n` too, but we keep this explicit. Defaults to `\n`.
   */
  lineEnding?: '\n' | '\r\n'
  /**
   * Does it support GRBL `$J=` jog? GRBL family: true. Others: false → we fall back
   * to a relative `G91 G0/G1` move (no cancellable jog). Defaults to true.
   */
  jogCommand?: 'grbl-$J' | 'g91-move'
  /**
   * Does the firmware expose host-pushed/queryable GRBL `$`-settings (`$$`)? Drives
   * whether the controller auto-syncs settings on connect. Defaults to true.
   */
  dollarSettings?: boolean
  /**
   * Soft-reset/stop strategy. GRBL: a `0x18` realtime byte. Marlin/Smoothie: emit an
   * `M112` emergency-stop line (no realtime reset byte). `none`: nothing safe to send.
   * Defaults to `grbl-0x18`.
   */
  reset?: 'grbl-0x18' | 'marlin-m112' | 'none'
}

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
  /**
   * Firmware extras beyond the GRBL baseline, surfaced so the UI can advertise
   * them honestly. All optional; absent === not advertised. e.g. grblHAL/FluidNC
   * support more realtime overrides, FluidNC has WiFi/WebSocket + a YAML config,
   * Marlin reports tool/bed temperatures via `M105`.
   */
  extendedOverrides?: boolean
  /** Has a WebSocket/network endpoint (FluidNC, ESP3D, grblHAL-ws). */
  network?: boolean
  /** Reports tool/bed temperatures (Marlin / RepRap printers via `M105`). */
  temperature?: boolean
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
  /**
   * Protocol deviations from the GRBL baseline the serial transport branches on.
   * Omit entirely for pure GRBL behaviour (the default). See `Dialect`.
   */
  dialect?: Dialect
  /** Short note shown in the UI / tooltip. */
  notes: string
}
