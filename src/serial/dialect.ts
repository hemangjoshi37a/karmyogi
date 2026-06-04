// Firmware-dialect adaptation for the serial transport.
//
// karmyogi started GRBL-only; this module captures the small set of protocol
// differences between the firmwares we support so the controller service can
// adapt WITHOUT rewriting the (working) GRBL path. The GRBL family resolves to
// the exact previous behaviour — every deviation is opt-in via a profile's
// `dialect` (see src/machine/controllers.ts).
//
// Pure module: no React/DOM/zustand imports, no I/O. It only describes "what to
// send" and "how to parse"; the controller performs the actual writes.

import type { Dialect, StatusDialect } from '../machine/types'
import type { StatusReport, Vec3 } from './status'
import { parseStatusReport } from './status'

/** Fully-resolved dialect — GRBL-shaped defaults filled in for any omitted field. */
export interface ResolvedDialect {
  status: StatusDialect
  realtimeBytes: boolean
  lineEnding: '\n' | '\r\n'
  jogCommand: 'grbl-$J' | 'g91-move'
  dollarSettings: boolean
  reset: 'grbl-0x18' | 'marlin-m112' | 'none'
}

/** The GRBL baseline. Any profile without a `dialect` behaves exactly like this. */
export const GRBL_DIALECT: ResolvedDialect = {
  status: 'grbl',
  realtimeBytes: true,
  lineEnding: '\n',
  jogCommand: 'grbl-$J',
  dollarSettings: true,
  reset: 'grbl-0x18',
}

/** Resolve a profile's (possibly partial) dialect against the GRBL defaults. */
export function resolveDialect(d?: Dialect): ResolvedDialect {
  if (!d) return GRBL_DIALECT
  return {
    status: d.status ?? GRBL_DIALECT.status,
    realtimeBytes: d.realtimeBytes ?? GRBL_DIALECT.realtimeBytes,
    lineEnding: d.lineEnding ?? GRBL_DIALECT.lineEnding,
    jogCommand: d.jogCommand ?? GRBL_DIALECT.jogCommand,
    dollarSettings: d.dollarSettings ?? GRBL_DIALECT.dollarSettings,
    reset: d.reset ?? GRBL_DIALECT.reset,
  }
}

/**
 * The status-query command for a dialect, if it is line-based (not a realtime
 * byte). GRBL uses the `?` realtime byte (handled separately), so it returns
 * null here. Marlin/RepRap/Smoothie poll `M114` (position). `none` has no query.
 */
export function statusQueryLine(d: ResolvedDialect): string | null {
  return d.status === 'marlin' ? 'M114' : null
}

/**
 * Build a relative jog as a plain G-code move for firmwares without GRBL `$J=`.
 * Mirrors the `$J=` semantics (G91 relative, G21 mm) but uses `G1 … F…` so it
 * works on Marlin / Smoothie. The controller wraps this with a `G90` restore.
 */
export function g91JogLines(p: { x?: number; y?: number; z?: number; feed: number }): string[] {
  const move = ['G91', 'G21', 'G1']
  if (p.x) move.push(`X${p.x}`)
  if (p.y) move.push(`Y${p.y}`)
  if (p.z) move.push(`Z${p.z}`)
  move.push(`F${p.feed}`)
  // Restore absolute mode afterwards so subsequent commands aren't surprised.
  return [move.join(' '), 'G90']
}

// --- Marlin / RepRap status-line parsing ----------------------------------
//
// Marlin has no `<...>` GRBL report. `M114` replies with a position line like:
//   X:0.00 Y:0.00 Z:0.00 E:0.00 Count X:0 Y:0 Z:0
// `M105` replies with temperatures (also auto-pushed during heating):
//   ok T:24.6 /0.0 B:23.1 /0.0 @:0 B@:0
// We surface the position as a StatusReport so the existing machine store wiring
// (which expects StatusReport) just works. There is no "state" word, so we mark
// such firmware as Idle unless we know better.

const MARLIN_POS_RE = /(^|\s)X:\s*(-?\d+(?:\.\d+)?)\s+Y:\s*(-?\d+(?:\.\d+)?)\s+Z:\s*(-?\d+(?:\.\d+)?)/i

/** True if a line looks like a Marlin/RepRap `M114` position report. */
export function isMarlinPositionLine(line: string): boolean {
  return MARLIN_POS_RE.test(line)
}

/**
 * Parse a Marlin/RepRap `M114` position reply into a StatusReport (machine pos).
 * Returns undefined if the line isn't a position report. State defaults to Idle
 * because Marlin doesn't carry a GRBL-style machine state in M114.
 */
export function parseMarlinStatus(line: string): StatusReport | undefined {
  const m = MARLIN_POS_RE.exec(line)
  if (!m) return undefined
  const mpos: Vec3 = {
    x: parseFloat(m[2]),
    y: parseFloat(m[3]),
    z: parseFloat(m[4]),
  }
  return { state: 'Idle', mpos, wpos: mpos }
}

/**
 * Dialect-aware status-line parser. For GRBL it delegates to the existing
 * `<...>` parser (unchanged); for Marlin/RepRap it understands `M114` position
 * lines. Returns undefined if the line is not a status report in this dialect.
 */
export function parseStatusForDialect(
  d: ResolvedDialect,
  line: string,
  prevWco?: Vec3,
): StatusReport | undefined {
  if (d.status === 'marlin') return parseMarlinStatus(line)
  if (d.status === 'none') return undefined
  return parseStatusReport(line, prevWco)
}
