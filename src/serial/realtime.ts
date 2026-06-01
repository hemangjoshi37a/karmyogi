// GRBL realtime command bytes. These bypass the line buffer and are acted on
// immediately by the controller — they are written as single bytes and are
// NOT followed by a newline and do NOT consume RX-buffer space (GRBL strips
// them before buffering).

export const RealtimeByte = {
  /** `?` — request a status report. */
  StatusReport: 0x3f,
  /** `~` — cycle start / resume. */
  CycleStart: 0x7e,
  /** `!` — feed hold. */
  FeedHold: 0x21,
  /** `0x18` (Ctrl-X) — soft reset. */
  SoftReset: 0x18,

  // --- Feed rate overrides ---
  /** Set feed override to 100%. */
  FeedOvReset: 0x90,
  /** Feed override +10%. */
  FeedOvPlus10: 0x91,
  /** Feed override -10%. */
  FeedOvMinus10: 0x92,
  /** Feed override +1%. */
  FeedOvPlus1: 0x93,
  /** Feed override -1%. */
  FeedOvMinus1: 0x94,

  // --- Rapid overrides ---
  /** Rapid override to 100% (full). */
  RapidOvReset: 0x95,
  /** Rapid override to 50%. */
  RapidOv50: 0x96,
  /** Rapid override to 25%. */
  RapidOv25: 0x97,

  // --- Spindle speed overrides ---
  /** Spindle override to 100%. */
  SpindleOvReset: 0x99,
  /** Spindle override +10%. */
  SpindleOvPlus10: 0x9a,
  /** Spindle override -10%. */
  SpindleOvMinus10: 0x9b,
  /** Spindle override +1%. */
  SpindleOvPlus1: 0x9c,
  /** Spindle override -1%. */
  SpindleOvMinus1: 0x9d,

  // --- Toggles ---
  /** Toggle spindle stop (only while in Hold). */
  ToggleSpindleStop: 0x9e,
  /** Toggle flood coolant. */
  ToggleFloodCoolant: 0xa0,
  /** Toggle mist coolant. */
  ToggleMistCoolant: 0xa1,
  /** Safety door. */
  SafetyDoor: 0x84,
} as const

export type RealtimeByteName = keyof typeof RealtimeByte

/** All realtime byte values, useful for tests / classification. */
export const REALTIME_BYTE_VALUES: ReadonlySet<number> = new Set(
  Object.values(RealtimeByte),
)

/** True if a byte is a GRBL realtime command (bypasses the line buffer). */
export function isRealtimeByte(byte: number): boolean {
  return REALTIME_BYTE_VALUES.has(byte)
}
