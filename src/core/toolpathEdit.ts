// Toolpath editing — delete a subset of moves and RE-EMIT a guaranteed-safe
// program. Pure TS (no DOM/React/three); used by the 3D viewer's lasso-delete.
//
// The viewer parses the displayed program into {from,to,kind} Segments
// (gcodeToPolylines), the user lassoes some to remove, and this rebuilds a SAFE
// program from the segments that REMAIN: wherever a deletion (or an original
// gap) breaks continuity, the tool RETRACTS to safe-Z, rapids over the gap at
// safe height, and only then plunges back to the cut — so the spindle never
// travels through the part at cutting depth. The standard GcodeEmitter writes
// the G21/G90/G94/G17 header, spindle handling, and the final safe-Z retract.

import { GcodeEmitter, ZMode } from './gcodeEmitter'
import { Toolpath } from './toolpath'

export interface EditSegment {
  from: [number, number, number]
  to: [number, number, number]
  kind: 'rapid' | 'cut'
}

export interface SafeReemitOptions {
  safeZ: number
  feedXY: number
  feedZ: number
  spindleRPM: number
  zMode: ZMode
  programName: string
}

/** Infer sensible emit options (safe-Z, feeds, spindle) from an existing program. */
export function inferEmitOptions(gcode: string): Omit<SafeReemitOptions, 'programName'> {
  const lines = gcode.split(/\r?\n/)
  let maxZ = -Infinity
  let feedXY = 0
  let spindle = 0
  let usesM3 = false
  for (const l of lines) {
    const s = l.trim()
    const z = s.match(/Z(-?\d*\.?\d+)/i)
    if (z) maxZ = Math.max(maxZ, parseFloat(z[1]))
    const f = s.match(/F(\d*\.?\d+)/i)
    if (f && !feedXY) feedXY = parseFloat(f[1])
    const sm = s.match(/S(\d*\.?\d+)/i)
    if (sm && !spindle) spindle = parseFloat(sm[1])
    if (/\bM0?3\b|\bM0?4\b/.test(s)) usesM3 = true
  }
  // safeZ = the program's highest Z (its retract plane); fall back to 5mm.
  const safeZ = Number.isFinite(maxZ) && maxZ > 0 ? maxZ : 5
  return {
    safeZ,
    feedXY: feedXY > 0 ? feedXY : 600,
    feedZ: feedXY > 0 ? Math.max(60, Math.round(feedXY / 3)) : 200,
    spindleRPM: spindle > 0 ? spindle : 10000,
    // If the source never turned a spindle on it's a pen/laser-style job → Pen Z.
    zMode: usesM3 ? ZMode.Spindle : ZMode.Pen,
  }
}

/**
 * Map a SELECTION of segment indices to the segments that should be KEPT (the
 * complement, in program order). Both the lasso and the individual "pick"
 * selection feed their result through this so the selection→delete→re-emit
 * model is identical: whatever is selected is removed, and `reemitSafe` rebuilds
 * a safe program from the remainder.
 */
export function keptFromSelection<T>(segments: T[], selected: Set<number>): T[] {
  return segments.filter((_, i) => !selected.has(i))
}

const EPS = 1e-4

/**
 * Rebuild a SAFE G-code program from the KEPT segments (in program order). Any
 * discontinuity (a kept segment whose start ≠ the previous kept segment's end —
 * i.e. a deletion happened between them) is bridged with a retract→travel→plunge
 * at safe-Z so no cut move ever crosses the deleted region at depth.
 */
export function reemitSafe(kept: EditSegment[], opts: SafeReemitOptions): string {
  const tp = new Toolpath()
  tp.name = opts.programName
  const { safeZ } = opts
  let cur: [number, number, number] | null = null

  const near = (a: [number, number, number], b: [number, number, number]) =>
    Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS && Math.abs(a[2] - b[2]) < EPS

  for (const seg of kept) {
    if (cur === null || !near(cur, seg.from)) {
      // Discontinuity → safe bridge: lift to safe-Z, rapid over the gap, descend.
      if (cur !== null) tp.rapid({ x: cur[0], y: cur[1], z: safeZ })
      tp.rapid({ x: seg.from[0], y: seg.from[1], z: safeZ })
      if (seg.kind === 'cut') tp.plunge({ x: seg.from[0], y: seg.from[1], z: seg.from[2] })
      else tp.rapid({ x: seg.from[0], y: seg.from[1], z: seg.from[2] })
    }
    if (seg.kind === 'cut') tp.feed({ x: seg.to[0], y: seg.to[1], z: seg.to[2] })
    else tp.rapid({ x: seg.to[0], y: seg.to[1], z: seg.to[2] })
    cur = seg.to
  }
  // Final guaranteed safe-Z retract.
  if (cur !== null) tp.rapid({ x: cur[0], y: cur[1], z: safeZ })

  const emitter = new GcodeEmitter({
    programName: opts.programName,
    safeZ,
    feedXY: opts.feedXY,
    feedZ: opts.feedZ,
    travelFeed: Math.max(opts.feedXY, 1200),
    zMode: opts.zMode,
    useSpindle: opts.zMode === ZMode.Spindle,
    spindleRPM: opts.spindleRPM,
  })
  return emitter.emitProgram(tp)
}
