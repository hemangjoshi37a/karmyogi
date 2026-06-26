// Pure helpers for the Program panel: windowed-list math and streaming progress.
// No React/DOM imports here so it can be unit-tested in isolation.

export interface WindowRange {
  /** First line index to render (inclusive). */
  start: number
  /** One past the last line index to render (exclusive). */
  end: number
}

/**
 * Compute the slice of line indices to render for a virtualized list.
 *
 * @param scrollTop   current scroll offset in px
 * @param viewportH   visible height in px
 * @param rowH        height of a single row in px
 * @param total       total number of lines
 * @param overscan    extra rows rendered above/below the viewport
 */
export function computeWindow(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan = 8,
): WindowRange {
  if (total <= 0 || rowH <= 0 || viewportH <= 0) {
    return { start: 0, end: 0 }
  }
  const first = Math.floor(scrollTop / rowH) - overscan
  const visibleCount = Math.ceil(viewportH / rowH) + overscan * 2
  const start = Math.max(0, first)
  const end = Math.min(total, start + visibleCount)
  return { start, end }
}

/** Pixel offset of a given row index (for absolute-positioned windowing). */
export function rowOffset(index: number, rowH: number): number {
  return index * rowH
}

/** Total scrollable height of the list. */
export function listHeight(total: number, rowH: number): number {
  return total * rowH
}

export interface Progress {
  /** Lines completed (0-based cursor + 1, clamped). */
  done: number
  total: number
  /** Fraction in [0, 1]. */
  fraction: number
  /** Whole-number percentage in [0, 100]. */
  percent: number
}

/**
 * Derive progress from the streaming cursor and total line count.
 * `cursor` is the index of the line currently being sent (-1 when idle).
 */
export function computeProgress(cursor: number, total: number): Progress {
  if (total <= 0) {
    return { done: 0, total: 0, fraction: 0, percent: 0 }
  }
  // cursor === -1 (idle) -> 0 done; otherwise cursor lines have been sent up to+including.
  const done = cursor < 0 ? 0 : Math.min(cursor + 1, total)
  const fraction = done / total
  return { done, total, fraction, percent: Math.round(fraction * 100) }
}

/**
 * Whether a row should be auto-scrolled into view: true when the cursor row
 * sits outside the currently rendered window.
 */
export function needsScrollIntoView(cursor: number, win: WindowRange): boolean {
  if (cursor < 0) return false
  return cursor < win.start || cursor >= win.end
}

/** GRBL state values that mean controls for pause/abort should be live. */
export function isRunningState(state: string): boolean {
  return state === 'Run' || state === 'Hold' || state === 'Jog'
}

// --- accel-aware job-time estimation ------------------------------------------

/** Default cutting feed (mm/min) used before any explicit F word is seen. */
const DEFAULT_FEED = 600

/**
 * Per-axis motion limits used by the trapezoidal time model. These mirror the
 * GRBL `$`-settings the planner cares about:
 *   - `maxRate` → `$110/$111/$112` (max feed per axis, mm/min)
 *   - `accel`   → `$120/$121/$122` (acceleration per axis, mm/sec²)
 *
 * Kept as a plain value object so this module stays **pure** — no store/React
 * import. The caller may pass live machine settings; when omitted, sensible
 * desktop-GRBL defaults are used so the estimate is still acceleration-aware.
 */
export interface MachineLimits {
  /** Max feed rate per axis, mm/min ($110–$112). */
  maxRate: { x: number; y: number; z: number }
  /** Acceleration per axis, mm/sec² ($120–$122). */
  accel: { x: number; y: number; z: number }
}

/** Conservative desktop-GRBL defaults used when no live settings are supplied. */
export const DEFAULT_LIMITS: MachineLimits = {
  maxRate: { x: 3000, y: 3000, z: 1000 },
  accel: { x: 500, y: 500, z: 400 },
}

interface Seg {
  /** Path length (mm). */
  len: number
  /** Unit direction components (|u| = 1). */
  ux: number
  uy: number
  uz: number
  /** Cruise speed cap for this move (mm/sec) — min(programmed feed, axis caps). */
  vCruise: number
  /** Acceleration along the move direction (mm/sec²). */
  accel: number
}

const EPS = 1e-9

/**
 * Roughly estimate how long a G-code program will take to run, in **seconds**,
 * using a **trapezoidal / acceleration-aware** model rather than a naive
 * distance ÷ feed sum.
 *
 * Pure parser, no machine state: walks the lines tracking modal G0/G1/G2/G3
 * motion, the modal feed `F`, absolute/relative mode (G90/G91), and XYZ
 * position. Each move becomes a segment with a cruise-speed cap (the lesser of
 * the programmed feed and the per-axis max rate projected onto the move
 * direction) and a direction-projected acceleration. A simplified look-ahead
 * planner (junction-speed limit by corner angle + backward/forward passes, like
 * GRBL's own planner) then assigns each move an entry/exit speed and integrates
 * the trapezoidal (or triangular, for short moves that never reach cruise)
 * velocity profile. Dwells (`G4 P<sec>`) are added. Arcs (G2/G3) are
 * approximated by their chord length.
 *
 * Compared with the old constant-velocity sum this correctly accounts for
 * accel/decel ramps and for short moves that never reach the commanded feed
 * (engraving / many tiny segments), where the constant-velocity model badly
 * under-estimated.
 *
 * `limits` is optional so the export signature stays `(lines) => number`; the
 * Program panel keeps calling it with one argument and transparently gets the
 * accel-aware figure (using {@link DEFAULT_LIMITS}). Pass live `$110–$122`
 * values for a machine-accurate ETA.
 */
export function estimateProgramSeconds(
  lines: string[],
  limits: MachineLimits = DEFAULT_LIMITS,
): number {
  const maxX = limits.maxRate.x > 0 ? limits.maxRate.x : DEFAULT_LIMITS.maxRate.x
  const maxY = limits.maxRate.y > 0 ? limits.maxRate.y : DEFAULT_LIMITS.maxRate.y
  const maxZ = limits.maxRate.z > 0 ? limits.maxRate.z : DEFAULT_LIMITS.maxRate.z
  const accX = limits.accel.x > 0 ? limits.accel.x : DEFAULT_LIMITS.accel.x
  const accY = limits.accel.y > 0 ? limits.accel.y : DEFAULT_LIMITS.accel.y
  const accZ = limits.accel.z > 0 ? limits.accel.z : DEFAULT_LIMITS.accel.z

  const segs: Seg[] = []
  let dwellSeconds = 0

  let feed = DEFAULT_FEED // mm/min
  let rapid = false // current modal motion is G0 (rapid)
  let motion = false // current modal motion is a linear/arc move (G0/1/2/3)
  let relative = false // G91 relative-distance mode (else G90 absolute)
  let x = 0
  let y = 0
  let z = 0
  let havePos = false

  for (const raw of lines) {
    // Strip comments: ; to end-of-line and ( ... ) parentheticals.
    const line = raw.replace(/;.*$/, '').replace(/\([^)]*\)/g, '')
    if (!line.trim()) continue

    let nx = x
    let ny = y
    let nz = z
    let sawCoord = false
    let lineMotion: boolean = motion // modal — persists across lines
    let dwellP = NaN // G4 P value seen on this line, if any

    const re = /([A-Za-z])\s*(-?\d*\.?\d+)/g
    let m: RegExpExecArray | null
    let sawG4 = false
    while ((m = re.exec(line))) {
      const letter = m[1].toUpperCase()
      const value = parseFloat(m[2])
      if (Number.isNaN(value)) continue
      switch (letter) {
        case 'G': {
          const g = Math.round(value)
          if (g === 0) {
            rapid = true
            lineMotion = true
          } else if (g === 1 || g === 2 || g === 3) {
            rapid = false
            lineMotion = true
          } else if (g === 4) {
            sawG4 = true
          } else if (g === 90) {
            relative = false
          } else if (g === 91) {
            relative = true
          }
          break
        }
        case 'F':
          if (value > 0) feed = value
          break
        case 'P':
          dwellP = value
          break
        case 'X':
          nx = relative ? x + value : value
          sawCoord = true
          break
        case 'Y':
          ny = relative ? y + value : value
          sawCoord = true
          break
        case 'Z':
          nz = relative ? z + value : value
          sawCoord = true
          break
        default:
          break
      }
    }

    // G4 dwell: GRBL takes P in seconds. Add it; it isn't a motion line.
    if (sawG4 && Number.isFinite(dwellP) && dwellP > 0) {
      dwellSeconds += dwellP
      continue
    }

    motion = lineMotion

    if (sawCoord && motion) {
      if (havePos) {
        const dx = nx - x
        const dy = ny - y
        const dz = nz - z
        const len = Math.hypot(dx, dy, dz)
        if (len > EPS) {
          const ux = dx / len
          const uy = dy / len
          const uz = dz / len
          // Axis-projected cruise cap (mm/min): a move along `u` at speed v drives
          // axis i at v·|u_i|, which must stay ≤ that axis's max rate.
          let cap = Infinity
          if (Math.abs(ux) > EPS) cap = Math.min(cap, maxX / Math.abs(ux))
          if (Math.abs(uy) > EPS) cap = Math.min(cap, maxY / Math.abs(uy))
          if (Math.abs(uz) > EPS) cap = Math.min(cap, maxZ / Math.abs(uz))
          const cruiseMmMin = rapid ? cap : Math.min(feed > 0 ? feed : DEFAULT_FEED, cap)
          // Direction-projected acceleration (mm/sec²): a·|u_i| ≤ accel_i.
          let accel = Infinity
          if (Math.abs(ux) > EPS) accel = Math.min(accel, accX / Math.abs(ux))
          if (Math.abs(uy) > EPS) accel = Math.min(accel, accY / Math.abs(uy))
          if (Math.abs(uz) > EPS) accel = Math.min(accel, accZ / Math.abs(uz))
          if (!Number.isFinite(accel) || accel <= 0) accel = DEFAULT_LIMITS.accel.x
          segs.push({
            len,
            ux,
            uy,
            uz,
            vCruise: (Number.isFinite(cruiseMmMin) ? cruiseMmMin : DEFAULT_FEED) / 60,
            accel,
          })
        }
      }
      x = nx
      y = ny
      z = nz
      havePos = true
    }
  }

  return planSeconds(segs) + dwellSeconds
}

/**
 * Run a simplified GRBL-style look-ahead planner over the parsed segments and
 * return the total motion time in seconds. Junction speeds are limited by the
 * corner angle (full speed when collinear, a stop on a full reversal); a
 * backward pass enforces "must be able to stop", a forward pass enforces "must
 * be able to reach", and each move's trapezoidal/triangular profile is
 * integrated for its time.
 */
function planSeconds(segs: Seg[]): number {
  const n = segs.length
  if (n === 0) return 0

  // Junction speed caps at each boundary 0..n. Start and end are at rest.
  const jc = new Array<number>(n + 1).fill(0)
  for (let i = 1; i < n; i++) {
    const a = segs[i - 1]
    const b = segs[i]
    // cos(turn angle) between consecutive unit directions.
    const dot = clamp(a.ux * b.ux + a.uy * b.uy + a.uz * b.uz, -1, 1)
    // Allowed corner speed = min cruise · cos(turn/2); cos(turn/2)=√((1+cosθ)/2).
    const cornerFactor = Math.sqrt((1 + dot) / 2)
    jc[i] = Math.min(a.vCruise, b.vCruise) * cornerFactor
  }

  // Backward pass: each junction entry must allow decel to the next junction.
  for (let i = n - 1; i >= 1; i--) {
    const s = segs[i]
    const reachable = Math.sqrt(jc[i + 1] * jc[i + 1] + 2 * s.accel * s.len)
    jc[i] = Math.min(jc[i], reachable, s.vCruise)
  }

  // Forward pass + integrate each move's time.
  let seconds = 0
  for (let i = 0; i < n; i++) {
    const s = segs[i]
    const vEntry = Math.min(jc[i], s.vCruise)
    const reachableExit = Math.sqrt(vEntry * vEntry + 2 * s.accel * s.len)
    const vExit = Math.min(jc[i + 1], reachableExit, s.vCruise)
    seconds += moveTime(s.len, vEntry, vExit, s.vCruise, s.accel)
  }
  return seconds
}

/**
 * Time (seconds) to travel `len` mm with the given entry/exit speeds, cruise
 * cap and acceleration, following a trapezoidal profile — or a triangular one
 * when the move is too short to reach the cruise speed.
 */
function moveTime(
  len: number,
  vEntry: number,
  vExit: number,
  vCruise: number,
  accel: number,
): number {
  if (len <= EPS) return 0
  if (accel <= EPS || vCruise <= EPS) {
    // Degenerate: fall back to constant speed at the higher of entry/cruise.
    const v = Math.max(vCruise, vEntry, 1e-3)
    return len / v
  }
  const vIn = Math.min(vEntry, vCruise)
  const vOut = Math.min(vExit, vCruise)
  // Distance to ramp up to cruise and back down to the exit speed.
  const dAcc = (vCruise * vCruise - vIn * vIn) / (2 * accel)
  const dDec = (vCruise * vCruise - vOut * vOut) / (2 * accel)
  if (dAcc + dDec <= len) {
    // Trapezoid: accelerate, cruise, decelerate.
    const dCruise = len - dAcc - dDec
    return (vCruise - vIn) / accel + dCruise / vCruise + (vCruise - vOut) / accel
  }
  // Triangle: peak speed below cruise. Solve for the apex velocity.
  const vPeakSq = (2 * accel * len + vIn * vIn + vOut * vOut) / 2
  const vPeak = Math.sqrt(Math.max(vPeakSq, Math.max(vIn, vOut) ** 2))
  return (vPeak - vIn) / accel + (vPeak - vOut) / accel
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/**
 * Format a duration (seconds) compactly for display:
 *   - `< 60s`            → `42s`
 *   - `< 1h`             → `7m 30s`
 *   - `>= 1h`            → `1:23:45`
 */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '0s'
  const s = Math.round(totalSeconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}
