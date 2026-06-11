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

import type { ControllerKind, Dialect, StatusDialect } from '../machine/types'
import type { StatusReport, Vec3 } from './status'
import { parseStatusReport } from './status'

/**
 * How a firmware ADDRESSES its host-editable `$`-settings over the wire:
 *  - `numeric` — classic GRBL numbered ids: `$$` dumps `$N=value` lines and a
 *                write is `$N=value` (GRBL, grblHAL).
 *  - `named`   — FluidNC replaced the numbered table with a YAML config + NAMED
 *                settings: `$$` dumps `$path/name=value` lines (slash-separated
 *                names, e.g. `$axes/x/steps_per_mm=80.000`), a write is
 *                `$<name>=<value>` and a read of one is `$<name>`. The numeric
 *                GRBL ids mostly do NOT apply. The full machine config lives in
 *                the YAML file (`$Config/Dump` prints it).
 *  - `none`    — no `$`-settings channel at all (Marlin/Smoothie keep settings
 *                in EEPROM/config-file via their own commands; Masso/lasers have
 *                nothing host-editable).
 * Note this is orthogonal to `dollarSettings` (does `$$` exist as a dump
 * command?): FluidNC keeps `$$` — only the LINE FORMAT of the reply and the way
 * writes are addressed differ.
 */
export type SettingsStyle = 'numeric' | 'named' | 'none'

/** Fully-resolved dialect — GRBL-shaped defaults filled in for any omitted field. */
export interface ResolvedDialect {
  status: StatusDialect
  realtimeBytes: boolean
  lineEnding: '\n' | '\r\n'
  jogCommand: 'grbl-$J' | 'g91-move'
  dollarSettings: boolean
  reset: 'grbl-0x18' | 'marlin-m112' | 'none'
  /** How `$`-settings are addressed (numeric GRBL ids vs FluidNC named paths). */
  settingsStyle: SettingsStyle
  /**
   * Derived capability flags the rest of the app (UI / controller) can branch on
   * without re-deriving the GRBL-vs-Marlin-vs-FluidNC distinction. They are
   * computed from the primitive dialect fields above so they always stay
   * consistent:
   *  - `supportsGrblSettings`     — has the classic NUMERIC `$$`/`$N=` settings
   *                                  channel (drives whether the Motion panel's
   *                                  numeric GRBL editor applies). FluidNC is
   *                                  FALSE here — its settings are named.
   *  - `supportsNamedSettings`    — has FluidNC-style NAMED settings: `$$` dumps
   *                                  `$path/name=value` lines, written back as
   *                                  `$<name>=<value>` (drives the Motion panel's
   *                                  named-settings editor).
   *  - `supportsRealtimeStatus`   — uses GRBL's `?` realtime status byte that pushes
   *                                  `<...>` reports for free (so we can poll it even
   *                                  mid-stream). When false (Marlin/Smoothie) status
   *                                  is a buffered `M114` LINE command and must NOT be
   *                                  injected into an active char-counting stream.
   *  - `statusIsLineCommand`      — status is obtained via a buffered line command
   *                                  (M114), whose `ok` would otherwise be miscounted
   *                                  by the streamer; the controller gates polling
   *                                  while streaming because of this.
   */
  supportsGrblSettings: boolean
  supportsNamedSettings: boolean
  supportsRealtimeStatus: boolean
  statusIsLineCommand: boolean
}

/**
 * Fill in the derived capability flags from the primitive dialect fields. Kept in
 * one place so GRBL-vs-Marlin-vs-FluidNC capability questions have a single
 * source of truth.
 */
function withCapabilities(
  d: Omit<
    ResolvedDialect,
    | 'supportsGrblSettings'
    | 'supportsNamedSettings'
    | 'supportsRealtimeStatus'
    | 'statusIsLineCommand'
  >,
): ResolvedDialect {
  return {
    ...d,
    supportsGrblSettings: d.dollarSettings && d.settingsStyle === 'numeric',
    supportsNamedSettings: d.dollarSettings && d.settingsStyle === 'named',
    supportsRealtimeStatus: d.status === 'grbl',
    statusIsLineCommand: statusQueryLine(d) !== null,
  }
}

/** The GRBL baseline. Any profile without a `dialect` behaves exactly like this. */
export const GRBL_DIALECT: ResolvedDialect = withCapabilities({
  status: 'grbl',
  realtimeBytes: true,
  lineEnding: '\n',
  jogCommand: 'grbl-$J',
  dollarSettings: true,
  reset: 'grbl-0x18',
  settingsStyle: 'numeric',
})

/**
 * FluidNC (ESP32 GRBL successor) — first-class dialect entry. Its protocol CORE
 * is GRBL-compatible (`?` realtime status `<Idle|MPos:…>`, `!`/`~`/0x18/0x85 and
 * override realtime bytes, `ok`/`error:N` acks, `$H`/`$X`/`$J=`, the same G-code
 * modal set), so every primitive matches GRBL — including `dollarSettings: true`
 * because `$$` IS the settings-dump command. The single real divergence is
 * `settingsStyle: 'named'`: the dump lines are `$path/name=value`, writes are
 * `$<name>=<value>`, and the full machine config is YAML (`$Config/Dump`).
 * FluidNC's extra `[MSG:…]` chatter is already safe for ack accounting — the
 * streamer only counts standalone `ok` / `error[:N]` tokens.
 *
 * NOTE: the shared `Dialect` profile type (src/machine/types.ts, owned by the
 * machine layer) has no `settingsStyle` field yet, so `resolveDialect` derives
 * the named style from the controller KIND ('fluidnc') instead.
 */
export const FLUIDNC_DIALECT: ResolvedDialect = withCapabilities({
  status: 'grbl',
  realtimeBytes: true,
  lineEnding: '\n',
  jogCommand: 'grbl-$J',
  dollarSettings: true,
  reset: 'grbl-0x18',
  settingsStyle: 'named',
})

/**
 * Resolve a profile's (possibly partial) dialect against the GRBL defaults.
 * Pass the controller `kind` where known so FluidNC resolves to its named-
 * settings dialect; without it (legacy call sites) everything keeps resolving
 * exactly as before — GRBL-shaped, numeric `$`-settings.
 */
export function resolveDialect(d?: Dialect, kind?: ControllerKind | string): ResolvedDialect {
  const base = kind === 'fluidnc' ? FLUIDNC_DIALECT : GRBL_DIALECT
  if (!d) return base
  const dollarSettings = d.dollarSettings ?? base.dollarSettings
  return withCapabilities({
    status: d.status ?? base.status,
    realtimeBytes: d.realtimeBytes ?? base.realtimeBytes,
    lineEnding: d.lineEnding ?? base.lineEnding,
    jogCommand: d.jogCommand ?? base.jogCommand,
    dollarSettings,
    reset: d.reset ?? base.reset,
    // Named style comes from the kind (FluidNC); otherwise the style follows the
    // `$$` channel: present → classic numeric ids, absent → no `$`-settings.
    settingsStyle: base.settingsStyle === 'named' ? 'named' : dollarSettings ? 'numeric' : 'none',
  })
}

/**
 * The status-query command for a dialect, if it is line-based (not a realtime
 * byte). GRBL uses the `?` realtime byte (handled separately), so it returns
 * null here. Marlin/RepRap/Smoothie poll `M114` (position). `none` has no query.
 */
export function statusQueryLine(d: Pick<ResolvedDialect, 'status'>): string | null {
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

// Marlin/RepRap "chatter" the firmware emits unprompted or alongside acks, which
// is NOT an `ok`/`error` acknowledgement and must never be mistaken for one nor
// treated as an error:
//   echo:busy: processing        (heartbeat while executing a long move)
//   busy: processing
//   echo:Unknown command: …      (informational echoes)
//   T:24.6 /0.0 B:23.1 /0.0 …    (auto-pushed temperature reports, M105 replies)
//   start                        (boot/reset banner)
// The streamer already only counts a bare `ok` / `error[:n]`, so these never
// corrupt the char-counting window; this predicate lets the controller classify
// them explicitly (e.g. to avoid surfacing a temperature line as a fake position
// or spamming the operator). A leading `ok ` is stripped before testing so an
// `ok T:..`-style combined reply is recognised as chatter too.
const MARLIN_CHATTER_RE = /^(echo:|busy:|\/\/|start\b|T:|B:|@:)/i

/**
 * True if a line is Marlin/RepRap chatter (echo / busy heartbeat / temperature /
 * boot banner) rather than a position report or an `ok`/`error` ack. The active
 * dialect must be the Marlin family; for GRBL it is always false.
 */
export function isMarlinChatter(d: ResolvedDialect, line: string): boolean {
  if (d.status !== 'marlin') return false
  if (isMarlinPositionLine(line)) return false
  const t = line.trim().replace(/^ok\s+/i, '')
  return MARLIN_CHATTER_RE.test(t)
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
