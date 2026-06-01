// GRBL status report parsing.
//
// A status report looks like:
//   <Idle|MPos:0.000,0.000,0.000|FS:0,0>
//   <Run|WPos:1.000,2.000,3.000|Ov:100,100,100>
//   <Hold:0|MPos:0.000,0.000,0.000|Bf:15,128|FS:0,0|WCO:0.000,0.000,0.000>
//   <Alarm|MPos:...|Pn:XYZ>
//
// GRBL v1.1 reports EITHER MPos OR WPos in a given report, never both. The
// missing pair is derived from the Work Coordinate Offset (WCO), which GRBL
// sends periodically. We cache the last-seen WCO so every report yields both
// machine and work positions.

export type GrblState =
  | 'Idle'
  | 'Run'
  | 'Hold'
  | 'Jog'
  | 'Alarm'
  | 'Door'
  | 'Check'
  | 'Home'
  | 'Sleep'
  | 'Unknown'

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** Feed / spindle overrides (percent). */
export interface Overrides {
  feed: number
  rapid: number
  spindle: number
}

export interface StatusReport {
  /** Top-level machine state, e.g. Idle, Run, Hold. */
  state: GrblState
  /** Optional sub-state code (e.g. Hold:0, Door:1). */
  subState?: number
  /** Machine position (absolute). */
  mpos?: Vec3
  /** Work position (mpos minus WCO). */
  wpos?: Vec3
  /** Work coordinate offset, if present in this report. */
  wco?: Vec3
  /** Realtime feed rate (mm/min). */
  feed?: number
  /** Realtime spindle speed (rpm). */
  spindle?: number
  /** Override percentages: feed, rapid, spindle. */
  overrides?: Overrides
  /** Planner buffer / RX buffer availability from Bf:<plan>,<rx>. */
  buffer?: { plan: number; rx: number }
  /** Active input pins from Pn:..., e.g. ['X','Z','P']. */
  pins?: string[]
  /** Line number being executed, from Ln:<n>. */
  line?: number
}

const STATE_NAMES: Record<string, GrblState> = {
  Idle: 'Idle',
  Run: 'Run',
  Hold: 'Hold',
  Jog: 'Jog',
  Alarm: 'Alarm',
  Door: 'Door',
  Check: 'Check',
  Home: 'Home',
  Sleep: 'Sleep',
}

function toVec3(csv: string): Vec3 | undefined {
  const parts = csv.split(',').map((s) => parseFloat(s))
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) {
    return undefined
  }
  return { x: parts[0], y: parts[1], z: parts[2] }
}

/** Returns true if the line is a GRBL status report (`<...>`). */
export function isStatusReport(line: string): boolean {
  const t = line.trim()
  return t.startsWith('<') && t.endsWith('>')
}

/**
 * Parse a single GRBL status report line. Returns undefined if the line is not
 * a `<...>` report. A caller-supplied previous WCO is used to fill the missing
 * mpos/wpos pair (GRBL reports only one of them per message).
 */
export function parseStatusReport(
  raw: string,
  prevWco?: Vec3,
): StatusReport | undefined {
  const line = raw.trim()
  if (!isStatusReport(line)) return undefined

  const inner = line.slice(1, -1)
  const fields = inner.split('|')
  if (fields.length === 0) return undefined

  // First field: state, optionally with sub-state "Hold:0".
  const [stateName, subRaw] = fields[0].split(':')
  const state: GrblState = STATE_NAMES[stateName] ?? 'Unknown'
  const report: StatusReport = { state }
  if (subRaw !== undefined) {
    const sub = parseInt(subRaw, 10)
    if (!Number.isNaN(sub)) report.subState = sub
  }

  let wco: Vec3 | undefined = prevWco

  for (let i = 1; i < fields.length; i++) {
    const f = fields[i]
    const colon = f.indexOf(':')
    if (colon < 0) continue
    const key = f.slice(0, colon)
    const val = f.slice(colon + 1)

    switch (key) {
      case 'MPos':
        report.mpos = toVec3(val)
        break
      case 'WPos':
        report.wpos = toVec3(val)
        break
      case 'WCO': {
        const v = toVec3(val)
        if (v) {
          report.wco = v
          wco = v
        }
        break
      }
      case 'FS': {
        const [f0, s0] = val.split(',').map((s) => parseFloat(s))
        if (!Number.isNaN(f0)) report.feed = f0
        if (!Number.isNaN(s0)) report.spindle = s0
        break
      }
      case 'F': {
        // Some builds emit only feed (no spindle).
        const f0 = parseFloat(val)
        if (!Number.isNaN(f0)) report.feed = f0
        break
      }
      case 'Ov': {
        const [feed, rapid, spindle] = val
          .split(',')
          .map((s) => parseFloat(s))
        if (![feed, rapid, spindle].some((n) => Number.isNaN(n))) {
          report.overrides = { feed, rapid, spindle }
        }
        break
      }
      case 'Bf': {
        const [plan, rx] = val.split(',').map((s) => parseInt(s, 10))
        if (!Number.isNaN(plan) && !Number.isNaN(rx)) {
          report.buffer = { plan, rx }
        }
        break
      }
      case 'Pn':
        report.pins = val.split('').filter((c) => c.trim().length > 0)
        break
      case 'Ln': {
        const n = parseInt(val, 10)
        if (!Number.isNaN(n)) report.line = n
        break
      }
      default:
        break
    }
  }

  // Derive the missing position from WCO (work = machine - wco).
  if (wco) {
    if (report.mpos && !report.wpos) {
      report.wpos = {
        x: report.mpos.x - wco.x,
        y: report.mpos.y - wco.y,
        z: report.mpos.z - wco.z,
      }
    } else if (report.wpos && !report.mpos) {
      report.mpos = {
        x: report.wpos.x + wco.x,
        y: report.wpos.y + wco.y,
        z: report.wpos.z + wco.z,
      }
    }
  }

  return report
}
