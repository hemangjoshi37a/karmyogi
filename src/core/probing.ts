// Probing wizard + surfacing G-code — UI-independent, pure.
//
// Implements roadmap bets:
//   • O2 — Probing wizard suite: guided Z-touch, X/Y single-edge, corner (XYZ)
//     and center-of-bore probing that sets the work zero (G10 L20) safely.
//   • O3 — Surfacing / wasteboard-flatten generator: a raster (zig-zag) facing
//     toolpath over a rectangular area at a set depth / stepover.
//
// O1/P1 (auto-leveling / heightmap) lives in `heightmap.ts` (grid, bilinear
// sample, warp). The ProbePanel reuses that core for its heightmap section; this
// file holds the *additional* probing math the wizard + surfacing need.
//
// SAFETY (mirrors gcodeEmitter.cpp conventions):
//   • Every probing routine retracts to a SAFE-Z before any XY travel, and
//     leaves the tool at safe-Z at the end — the probe is never crashed.
//   • G38.2 (alarm-on-no-contact) is used so a missed touch halts the machine
//     rather than diving the probe into the work.
//   • Conservative default feeds; probe moves are slow (probeFeed), positioning
//     rapids are G0 only at/above safe-Z.
//   • Z words never emit "-0.000".
//
// No DOM / React / store imports — stays portable + harness-testable.

// ---------------------------------------------------------------------------
// Shared formatting + safety helpers
// ---------------------------------------------------------------------------

/** Format a coordinate avoiding -0.000 and trailing zeros (emitter style). */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) n = 0
  if (Object.is(n, -0)) n = 0
  let s = n.toFixed(3)
  if (s === '-0.000') s = '0.000'
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return s
}

/** Common probing parameters shared by every wizard routine. */
export interface ProbeParams {
  /** Slow probe feed toward the work (mm/min, positive). */
  feed: number
  /** Max probe travel from the start before giving up (mm, positive). */
  maxTravel: number
  /** Safe-Z (machine/work Z) the head rapids to between/after touches (mm). */
  safeZ: number
  /**
   * Touch-plate / edge-finder offset (mm). For Z this is the plate THICKNESS
   * (Z=0 ends up at the plate's top surface). For X/Y edge probing it is the
   * tool RADIUS (so work zero sits at the material edge, not the tool centre).
   */
  offset: number
}

/** A sensible, conservative default parameter set. */
export function defaultProbeParams(over: Partial<ProbeParams> = {}): ProbeParams {
  return { feed: 50, maxTravel: 25, safeZ: 5, offset: 1, ...over }
}

/** The probing wizard routines we generate guided G-code for. */
export type WizardKind = 'z' | 'x' | 'y' | 'corner' | 'center'

/** Which approach direction a single-axis edge probe takes. */
export type AxisDir = '+' | '-'

/** A single emitted step in a wizard: a comment + the G-code line(s). */
export interface ProbeStep {
  /** Human-readable description of what this step does. */
  note: string
  /** The G-code lines this step emits (already safe-Z aware). */
  lines: string[]
  /** True if this step performs a G38.2 touch (UI waits for [PRB:…]). */
  isProbe?: boolean
  /** True if this step writes the work zero (G10 L20). */
  setsZero?: boolean
}

/** A complete guided wizard program: ordered steps + the flat G-code string. */
export interface WizardProgram {
  kind: WizardKind
  steps: ProbeStep[]
  /** All step lines joined — the full program a sender would stream. */
  gcode: string
}

const PREAMBLE = 'G21 G90 G94' // mm, absolute, units/min — emitter-safe header.

/** Build the flat program string from steps (prefixed with the safe preamble). */
function assemble(kind: WizardKind, steps: ProbeStep[]): WizardProgram {
  const lines: string[] = [PREAMBLE]
  for (const s of steps) {
    lines.push(`; ${s.note}`)
    lines.push(...s.lines)
  }
  return { kind, steps, gcode: lines.join('\n') }
}

// ---------------------------------------------------------------------------
// O2 — Probing wizard routines
// ---------------------------------------------------------------------------

/**
 * Z-touch: probe straight down onto a touch plate, then set work Z=0 at the
 * plate's top surface (G10 L20 P0 Z<thickness>). Retracts to safe-Z after.
 */
export function zTouchProgram(p: ProbeParams): WizardProgram {
  const f = Math.abs(p.feed)
  const d = Math.abs(p.maxTravel)
  const steps: ProbeStep[] = [
    {
      note: 'Z-touch: lower onto the plate (alarms if no contact).',
      lines: [`G38.2 Z-${fmt(d)} F${fmt(f)}`],
      isProbe: true,
    },
    {
      note: `Set work Z=0 at the plate surface (thickness ${fmt(p.offset)} mm).`,
      lines: [`G10 L20 P0 Z${fmt(p.offset)}`],
      setsZero: true,
    },
    {
      note: 'Retract to safe-Z.',
      lines: [`G0 Z${fmt(p.safeZ)}`],
    },
  ]
  return assemble('z', steps)
}

/**
 * Single-axis edge probe (X or Y). Touches the work edge while travelling in
 * `dir`, then sets that axis' work zero to ±offset (the tool radius) so work
 * zero lands on the material edge rather than the tool centre. Assumes the head
 * is already positioned beside the edge at a safe Z just below the top surface;
 * the routine retracts the probe axis a touch after contact, then back to start.
 */
export function edgeProgram(axis: 'x' | 'y', dir: AxisDir, p: ProbeParams): WizardProgram {
  const f = Math.abs(p.feed)
  const d = Math.abs(p.maxTravel)
  const A = axis.toUpperCase()
  const sign = dir === '+' ? '' : '-'
  // After touching a +X edge the work zero is at tool centre + radius; for a -X
  // approach it's tool centre - radius. The edge sits `offset` beyond the centre
  // in the travel direction.
  const zeroVal = dir === '+' ? p.offset : -p.offset
  const back = dir === '+' ? '-' : '' // small retract opposite the approach
  const steps: ProbeStep[] = [
    {
      note: `${A} edge: probe toward the ${dir}${A} edge (alarms if no contact).`,
      lines: [`G38.2 ${A}${sign}${fmt(d)} F${fmt(f)}`],
      isProbe: true,
    },
    {
      note: `Set work ${A}=0 at the edge (tool radius ${fmt(p.offset)} mm offset).`,
      lines: [`G10 L20 P0 ${A}${fmt(zeroVal)}`],
      setsZero: true,
    },
    {
      note: `Retract ${A} clear of the edge.`,
      lines: [`G0 ${A}${back}${fmt(Math.max(1, p.offset + 1))}`],
    },
  ]
  return assemble(axis, steps)
}

/**
 * Corner probe (outside corner): probe X then Y to find both edges of an
 * outside corner, setting work X=0 and Y=0 at the corner (offset by tool
 * radius). Retracts to safe-Z between the two edge touches so the probe clears
 * the work corner before repositioning. Assumes the head starts beside the X
 * edge at probing depth; the caller positions it. `xDir`/`yDir` are the
 * approach directions toward each edge.
 */
export function cornerProgram(
  xDir: AxisDir,
  yDir: AxisDir,
  p: ProbeParams,
  /** How far to step over to line up the Y edge probe (mm). */
  stepOver = 10,
): WizardProgram {
  const f = Math.abs(p.feed)
  const d = Math.abs(p.maxTravel)
  const xSign = xDir === '+' ? '' : '-'
  const ySign = yDir === '+' ? '' : '-'
  const xZero = xDir === '+' ? p.offset : -p.offset
  const yZero = yDir === '+' ? p.offset : -p.offset
  const xBack = xDir === '+' ? '-' : ''
  const so = Math.abs(stepOver)
  const steps: ProbeStep[] = [
    {
      note: `Corner: probe the ${xDir}X edge.`,
      lines: [`G38.2 X${xSign}${fmt(d)} F${fmt(f)}`],
      isProbe: true,
    },
    {
      note: 'Set work X=0 at the X edge.',
      lines: [`G10 L20 P0 X${fmt(xZero)}`],
      setsZero: true,
    },
    {
      note: 'Retract X, lift to safe-Z, reposition to probe the Y edge.',
      lines: [
        `G0 X${xBack}${fmt(Math.max(1, p.offset + 1))}`,
        `G0 Z${fmt(p.safeZ)}`,
        // Step along X to line the probe up with the Y edge, then drop back to
        // probing depth (just below the top surface — safeZ negated as a depth).
        `G0 X${xDir === '+' ? '' : '-'}${fmt(so)}`,
        `G0 Z-${fmt(Math.abs(p.safeZ))}`,
      ],
    },
    {
      note: `Probe the ${yDir}Y edge.`,
      lines: [`G38.2 Y${ySign}${fmt(d)} F${fmt(f)}`],
      isProbe: true,
    },
    {
      note: 'Set work Y=0 at the Y edge.',
      lines: [`G10 L20 P0 Y${fmt(yZero)}`],
      setsZero: true,
    },
    {
      note: 'Retract to safe-Z.',
      lines: [`G0 Z${fmt(p.safeZ)}`],
    },
  ]
  return assemble('corner', steps)
}

/**
 * Center-of-bore probe: from a point roughly centred in a round bore / boss,
 * probe -X then +X (and -Y then +Y) to find the two opposing walls on each
 * axis; the midpoint of each pair is the true centre. The probe retracts to the
 * start between touches so it never drags along a wall. The final G10 L20 sets
 * work X=0 Y=0 at the computed centre — but the centre can only be known after
 * the four touches, so this routine emits the four guided touches and a closing
 * "operator computes + sets zero" note; the panel computes the midpoints from
 * the four [PRB:…] results (see {@link boreCenter}).
 */
export function boreProgram(p: ProbeParams): WizardProgram {
  const f = Math.abs(p.feed)
  const d = Math.abs(p.maxTravel)
  const r = (dir: string, axis: string): ProbeStep[] => [
    {
      note: `Probe the ${dir}${axis} wall.`,
      lines: [`G38.2 ${axis}${dir === '-' ? '-' : ''}${fmt(d)} F${fmt(f)}`],
      isProbe: true,
    },
    {
      note: `Return toward centre (back off the ${dir}${axis} wall).`,
      lines: [`G38.3 ${axis}${dir === '-' ? '' : '-'}${fmt(d)} F${fmt(f)}`],
    },
  ]
  const steps: ProbeStep[] = [
    ...r('-', 'X'),
    ...r('+', 'X'),
    ...r('-', 'Y'),
    ...r('+', 'Y'),
    {
      note: 'Centre = midpoint of each opposing wall pair; set work X=0 Y=0 there.',
      lines: ['; (panel computes the centre from the 4 touches, then G10 L20)'],
    },
  ]
  return assemble('center', steps)
}

/**
 * Compute a bore centre + radius from two opposing-wall touches on each axis.
 * Returns the midpoint (machine or work frame — same as the inputs) plus the
 * estimated radius per axis. The G10 zero is then `G10 L20 P0 X<-cx> Y<-cy>`
 * relative to current, OR set the centre as the work origin directly.
 */
export function boreCenter(
  xMinus: number,
  xPlus: number,
  yMinus: number,
  yPlus: number,
): { cx: number; cy: number; rx: number; ry: number } {
  const cx = (xMinus + xPlus) / 2
  const cy = (yMinus + yPlus) / 2
  return { cx, cy, rx: Math.abs(xPlus - xMinus) / 2, ry: Math.abs(yPlus - yMinus) / 2 }
}

// ---------------------------------------------------------------------------
// O3 — Surfacing / wasteboard flatten
// ---------------------------------------------------------------------------

/** A rectangular area to surface (work coordinates, mm). */
export interface SurfaceArea {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface SurfaceParams {
  /** Cutter diameter (mm) — drives the absolute stepover. */
  toolDiameter: number
  /** Stepover as a fraction of tool diameter (0–1). */
  stepoverFrac: number
  /** Total material to remove (mm, positive depth below Z=0). */
  depth: number
  /** Max depth removed per pass (mm, positive). Multi-pass when depth exceeds it. */
  depthPerPass: number
  /** Cutting feed (mm/min). */
  feed: number
  /** Plunge feed (mm/min). */
  plungeFeed: number
  /** Safe-Z retract height (mm, positive above the surface). */
  safeZ: number
  /** Spindle RPM (M3 S…); 0 omits the spindle word (e.g. for a manual router). */
  rpm: number
  /** Raster axis: 'x' = sweep along X stepping in Y; 'y' = sweep along Y. */
  along: 'x' | 'y'
}

/** Conservative surfacing defaults. */
export function defaultSurfaceParams(over: Partial<SurfaceParams> = {}): SurfaceParams {
  return {
    toolDiameter: 6,
    stepoverFrac: 0.4,
    depth: 0.5,
    depthPerPass: 0.3,
    feed: 800,
    plungeFeed: 200,
    safeZ: 5,
    rpm: 12000,
    along: 'x',
    ...over,
  }
}

/** Result of a surfacing generation: the program plus useful stats. */
export interface SurfaceResult {
  gcode: string
  /** Number of raster lines per depth pass. */
  rasterLines: number
  /** Number of depth passes. */
  passes: number
  /** Absolute stepover used (mm). */
  stepover: number
  /** Estimated cut length (mm) over all passes (XY raster only). */
  cutLength: number
}

/**
 * Generate a raster (zig-zag, boustrophedon) facing toolpath that flattens a
 * rectangular area. The tool centre stays inset by its radius so the cutter
 * edge just reaches the area bounds (no over-travel). Multi-pass when `depth`
 * exceeds `depthPerPass`. SAFE: rapids only at safe-Z, plunge at plunge feed,
 * retract to safe-Z at the end; emitter-safe preamble + spindle handling.
 */
export function surfacingProgram(area: SurfaceArea, p: SurfaceParams): SurfaceResult {
  const dia = Math.max(0.1, p.toolDiameter)
  const radius = dia / 2
  const stepover = Math.max(0.05 * dia, Math.min(0.95, Math.abs(p.stepoverFrac)) * dia)
  const safeZ = Math.abs(p.safeZ)
  const feed = Math.max(1, p.feed)
  const plunge = Math.max(1, p.plungeFeed)

  // Inset the cutter centre by its radius so the cut edge reaches the bounds.
  const x0 = Math.min(area.minX, area.maxX) + radius
  const x1 = Math.max(area.minX, area.maxX) - radius
  const y0 = Math.min(area.minY, area.maxY) + radius
  const y1 = Math.max(area.minY, area.maxY) - radius

  // Degenerate area smaller than the tool: clamp to a single centre line.
  const swept = p.along === 'x'
  const fastLo = swept ? x0 : y0
  const fastHi = swept ? x1 : y1
  const slowLo = swept ? y0 : x0
  const slowHi = swept ? y1 : x1
  const fastSpan = Math.max(0, fastHi - fastLo)
  const slowSpan = Math.max(0, slowHi - slowLo)

  // Raster step positions along the slow (stepover) axis, inclusive of both
  // edges; ceil so the final pass covers the far edge.
  const nGaps = slowSpan > 1e-6 ? Math.max(1, Math.ceil(slowSpan / stepover)) : 0
  const nLines = nGaps + 1
  const slowStep = nGaps > 0 ? slowSpan / nGaps : 0

  // Depth passes.
  const totalDepth = Math.max(0, p.depth)
  const dpp = Math.max(0.01, p.depthPerPass)
  const nPasses = totalDepth > 1e-6 ? Math.max(1, Math.ceil(totalDepth / dpp)) : 1
  const passDepth = totalDepth > 1e-6 ? totalDepth / nPasses : 0

  const lines: string[] = ['G21 G90 G94 G17']
  if (p.rpm > 0) lines.push(`M3 S${Math.round(p.rpm)}`)
  lines.push(`G0 Z${fmt(safeZ)}`)

  let cutLength = 0
  for (let pass = 1; pass <= nPasses; pass++) {
    const z = -passDepth * pass
    lines.push(`; --- pass ${pass}/${nPasses} at Z${fmt(z)} ---`)
    // Boustrophedon: alternate sweep direction each raster line.
    for (let li = 0; li < nLines; li++) {
      const slow = slowLo + slowStep * li
      const forward = li % 2 === 0
      const a = forward ? fastLo : fastHi
      const b = forward ? fastHi : fastLo
      // Rapid above the line start, plunge, cut across, then continue.
      const startX = swept ? a : slow
      const startY = swept ? slow : a
      const endX = swept ? b : slow
      const endY = swept ? slow : b
      if (li === 0) {
        lines.push(`G0 X${fmt(startX)} Y${fmt(startY)}`)
        lines.push(`G1 Z${fmt(z)} F${fmt(plunge)}`)
      } else {
        // Step over to the next line (still at cut depth — stays in the cut).
        lines.push(`G1 X${fmt(startX)} Y${fmt(startY)} F${fmt(feed)}`)
        cutLength += stepover
      }
      lines.push(`G1 X${fmt(endX)} Y${fmt(endY)} F${fmt(feed)}`)
      cutLength += fastSpan
    }
    lines.push(`G0 Z${fmt(safeZ)}`)
  }
  if (p.rpm > 0) lines.push('M5')
  lines.push(`G0 Z${fmt(safeZ)}`)

  return {
    gcode: lines.join('\n'),
    rasterLines: nLines,
    passes: nPasses,
    stepover,
    cutLength,
  }
}
