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

// --- rough job-time estimation ------------------------------------------------

/** Default cutting feed (mm/min) used before any explicit F word is seen. */
const DEFAULT_FEED = 600
/** Assumed rapid (G0) traverse rate (mm/min) — a sensible desktop-GRBL default. */
const RAPID_FEED = 3000

/**
 * Roughly estimate how long a G-code program will take to run, in **seconds**.
 *
 * Pure parser, no machine state: walks the lines tracking modal G0/G1 motion,
 * the modal feed `F`, and absolute XYZ position, summing each segment's
 * (distance / feed). Rapids (G0) use a high {@link RAPID_FEED}; feed moves use
 * the current modal F (falling back to {@link DEFAULT_FEED} until one is seen).
 * Arcs (G2/G3) are approximated by their chord length — good enough for a rough
 * ETA. Non-motion lines (comments, M-codes, settings) contribute nothing.
 *
 * This is intentionally approximate: it ignores acceleration, dwell (G4), and
 * tool-change pauses, so it under-estimates slightly — but it gives the user a
 * useful order-of-magnitude figure for the progress bar.
 */
export function estimateProgramSeconds(lines: string[]): number {
  let seconds = 0
  let feed = DEFAULT_FEED // mm/min
  let rapid = false // current modal motion is G0 (rapid)
  let motion: boolean = false // current modal motion is a linear move (G0/G1)
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
    // Did this line set/keep a motion mode? (modal — persists across lines)
    let lineMotion: boolean = motion

    const re = /([A-Za-z])\s*(-?\d*\.?\d+)/g
    let m: RegExpExecArray | null
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
          }
          break
        }
        case 'F':
          if (value > 0) feed = value
          break
        case 'X':
          nx = value
          sawCoord = true
          break
        case 'Y':
          ny = value
          sawCoord = true
          break
        case 'Z':
          nz = value
          sawCoord = true
          break
        default:
          break
      }
    }

    motion = lineMotion

    if (sawCoord && motion) {
      if (havePos) {
        const dist = Math.hypot(nx - x, ny - y, nz - z)
        const rate = rapid ? RAPID_FEED : feed > 0 ? feed : DEFAULT_FEED
        if (dist > 0 && rate > 0) seconds += (dist / rate) * 60
      }
      x = nx
      y = ny
      z = nz
      havePos = true
    }
  }

  return seconds
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
