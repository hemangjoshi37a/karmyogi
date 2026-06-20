// Automatic-soldering G-code generator — UI-independent.
// Ported from the Qt/C++ reference cadcam/soldering.{h,cpp}.
//
// Machine model: a soldering iron is mounted at the head and the controller's
// spindle on/off output drives a solder-wire FEEDER motor. Turning the
// "spindle" on (M3 S..) runs the feeder; M5 stops it. The amount of wire fed is
// controlled by how long the feeder runs — a dwell (G4 P<seconds>) between M3
// and M5.
//
// Safety behaviour matches the rest of the CAM core: G21/G90/G94/G17 header, a
// guaranteed safe-Z retract before any XY travel and at program end, and number
// formatting that never emits "-0.000".

/** When the solder wire is fed relative to the touch-down. */
export enum SolderFeedType {
  /**
   * Feed wire onto the iron tip while raised, THEN touch the pad to deposit the
   * pre-melted blob.
   */
  PreSolder = 'PreSolder',
  /** Touch the pad FIRST, then feed wire while the tip is in contact. */
  TouchDown = 'TouchDown',
}

/**
 * How the tip makes its FINAL descent onto a point's touch location.
 * - 'plunge'      : straight vertical drop from Free-Z down to Touch-Z at the
 *                   point's exact XY (the original, default behaviour).
 * - 'angle-front' : 45° approach IN from the −Y side (start offset in −Y).
 * - 'angle-back'  : 45° approach IN from the +Y side (start offset in +Y).
 * - 'angle-right' : 45° approach IN from the +X side (start offset in +X).
 * - 'angle-left'  : 45° approach IN from the −X side (start offset in −X).
 *
 * For every directional 45° variant the descent START sits at Free-Z, offset
 * from the pad along the chosen axis by the horizontal run (= |FreeZ−TouchZ|, so
 * the diagonal is a true 45°). The tip then moves diagonally INTO the pad —
 * driving the offset axis to the pad coord WHILE descending Z to Touch-Z; the
 * other axis stays at the pad coord throughout. The retract mirrors the descent
 * (back out along the same 45° line).
 */
export type SolderApproach =
  | 'plunge'
  | 'angle-front'
  | 'angle-right'
  | 'angle-left'
  | 'angle-back';

/** One soldering action at an absolute machine location. */
export interface SolderPoint {
  x: number;
  y: number;
  /** Raised travel/retract height (mm, absolute). */
  freeZ: number;
  /** Touch-down height where soldering happens (mm, absolute). */
  touchZ: number;
  /** Feed ordering relative to touch-down. */
  type: SolderFeedType;
  /** Feeder ON time (seconds). */
  feedSeconds: number;
  /** Final-descent geometry: straight plunge or 45° angle of attack. */
  approach: SolderApproach;
}

/** Defaults for a fresh soldering point. */
export function defaultSolderPoint(overrides: Partial<SolderPoint> = {}): SolderPoint {
  return {
    x: 0,
    y: 0,
    freeZ: 5.0,
    touchZ: -1.0,
    type: SolderFeedType.TouchDown,
    feedSeconds: 0.5,
    approach: 'plunge',
    ...overrides,
  };
}

/** Global generator policy (mirrors C++ SolderingParams). */
export interface SolderingParams {
  metric: boolean; // G21 vs G20
  safeZ: number; // travel/retract height between points (mm)
  feederRPM: number; // emitted as the S word when the feeder runs
  plungeFeed: number; // touch-down feed rate (mm/min)
  settleSeconds: number; // dwell after feeding, before retract (s); 0 = none
  decimals: number;
  programName: string;
}

export function defaultSolderingParams(overrides: Partial<SolderingParams> = {}): SolderingParams {
  return {
    metric: true,
    safeZ: 5.0,
    feederRPM: 1000.0,
    plungeFeed: 1000.0,
    settleSeconds: 0.0,
    decimals: 3,
    programName: 'hjLabs Auto-Soldering',
    ...overrides,
  };
}

/**
 * Clamp a decimals value into the range `toFixed()` accepts (0..6 here, well
 * within the spec's 0..100). An out-of-range value passed to `toFixed()` throws
 * a RangeError, which — reached from a render-phase useMemo — white-screens the
 * panel. Clamping here is defence-in-depth alongside the UI input/load guards.
 */
function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 3;
  return Math.min(6, Math.max(0, Math.floor(decimals)));
}

/** Formatted number, never "-0.000" — mirrors the C++ fmt() and the emitter. */
function fmt(value: number, decimals: number): string {
  const d = clampDecimals(decimals);
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(d);
}

/**
 * Rough cycle-time estimate (seconds) for a soldering run. Sums the per-point
 * plunge time (Free-Z → Touch-Z at the plunge feed), the feeder ON dwell, and
 * the optional settle dwell. Rapids/XY travel are ignored (negligible vs the
 * dwells on a desktop machine); the result is a conservative lower bound the
 * operator can use to gauge run length. Pure (no rounding side effects).
 */
export function estimateSolderingSeconds(
  points: SolderPoint[],
  params: Partial<SolderingParams> = {},
): number {
  const p = defaultSolderingParams(params);
  const plungeFeed = Math.max(0, p.plungeFeed); // mm/min
  const settle = Math.max(0, p.settleSeconds);
  let seconds = 0;
  for (const pt of points) {
    const drop = Math.abs(pt.freeZ - pt.touchZ); // mm lowered + raised
    if (plungeFeed > 1e-9) seconds += (drop / plungeFeed) * 60; // plunge (down)
    seconds += Math.max(0, pt.feedSeconds); // feeder ON
    seconds += settle; // settle dwell
  }
  return seconds;
}

/**
 * Total XY (free-travel) path length over `points` in their current order. When
 * `start` is given it's the machine's pre-travel position (work origin), so the
 * first leg start→points[0] is counted; otherwise the path starts at points[0].
 * Z moves are ignored — this measures only the rapid XY travel between points,
 * which is exactly what the ordering optimizer minimizes.
 */
export function solderTravelDistance(
  points: { x: number; y: number }[],
  start?: { x: number; y: number },
): number {
  if (points.length === 0) return 0;
  let total = 0;
  let prev = start ?? points[0];
  for (let i = start ? 0 : 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - prev.x, points[i].y - prev.y);
    prev = points[i];
  }
  return total;
}

/** Index of the nearest still-unused point to `ref` (squared distance). −1 if none. */
function nearestUnused(
  points: { x: number; y: number }[],
  ref: { x: number; y: number },
  used: boolean[],
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (used[i]) continue;
    const dx = points[i].x - ref.x;
    const dy = points[i].y - ref.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 2-opt refinement of an OPEN path (anchored at `start`): repeatedly reverse a
 * sub-segment whenever doing so shortens the total path, until no improvement or
 * a pass cap is hit. Mutates `order` in place. O(passes·n²) — the caller gates it
 * on n so it stays snappy.
 */
function twoOptImprove(
  order: number[],
  points: { x: number; y: number }[],
  start: { x: number; y: number },
): void {
  const n = order.length;
  const D = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);
  const at = (idx: number) => points[order[idx]];
  let improved = true;
  let passes = 0;
  const MAX_PASSES = 30;
  while (improved && passes++ < MAX_PASSES) {
    improved = false;
    for (let i = 0; i < n - 1; i++) {
      const aPrev = i === 0 ? start : at(i - 1);
      const a = at(i);
      for (let j = i + 1; j < n; j++) {
        const b = at(j);
        const bNext = j === n - 1 ? null : at(j + 1);
        // Reversing order[i..j] swaps edges (aPrev→a)+(b→bNext) for (aPrev→b)+(a→bNext).
        const before = D(aPrev, a) + (bNext ? D(b, bNext) : 0);
        const after = D(aPrev, b) + (bNext ? D(a, bNext) : 0);
        if (after + 1e-9 < before) {
          let lo = i;
          let hi = j;
          while (lo < hi) {
            const tmp = order[lo];
            order[lo] = order[hi];
            order[hi] = tmp;
            lo++;
            hi--;
          }
          improved = true;
        }
      }
    }
  }
}

/**
 * Reorder soldering points to MINIMIZE the free (XY) travel between them — so the
 * iron visits neighbouring pads in sequence instead of darting across the board
 * and back. A greedy nearest-neighbour tour (seeded from the point closest to the
 * machine start / work origin) gives a good route; a 2-opt pass then untangles
 * the long crossings nearest-neighbour leaves behind. Optimizes XY only and
 * preserves every point's data (Free-Z / Touch-Z / feed / approach …); returns a
 * NEW array (pure). For very large lists the 2-opt pass is skipped to stay fast.
 */
export function orderSolderPointsForTravel<T extends { x: number; y: number }>(
  points: T[],
  opts: { start?: { x: number; y: number }; twoOpt?: boolean } = {},
): T[] {
  const n = points.length;
  if (n <= 2) return points.slice();
  const start = opts.start ?? { x: 0, y: 0 };
  const used = new Array<boolean>(n).fill(false);
  const order: number[] = [];
  // Greedy nearest-neighbour from the point closest to the machine start.
  let cur = nearestUnused(points, start, used);
  if (cur < 0) return points.slice();
  used[cur] = true;
  order.push(cur);
  for (let k = 1; k < n; k++) {
    const next = nearestUnused(points, points[cur], used);
    if (next < 0) break;
    used[next] = true;
    order.push(next);
    cur = next;
  }
  // 2-opt untangles crossings; gate on size so big boards stay interactive.
  if (opts.twoOpt ?? n <= 800) twoOptImprove(order, points, start);
  return order.map((i) => points[i]);
}

/**
 * Produce a complete, safe G-code program for the given soldering points.
 * Faithful port of cadcam::SolderingGenerator::generate.
 */
export function generateSoldering(points: SolderPoint[], params: Partial<SolderingParams> = {}): string {
  const p = defaultSolderingParams(params);
  const d = p.decimals;
  const o: string[] = [];

  // Z DATUM: the FIRST point's touch-down Z is the job's zero. Every absolute Z
  // emitted below is expressed RELATIVE to it (subtract `zOrigin`), so point 1
  // touches at Z0 and all other heights keep their relative offsets. The operator
  // therefore sets work-Z-zero at the first pad's touch-down and the whole job
  // references that single datum. (No-op when there are no points.)
  const zOrigin = points.length > 0 ? points[0].touchZ : 0;
  const zr = (v: number): number => v - zOrigin;

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi.hjLabs.in Auto-Soldering)');
  o.push('(Z0 = first point touch-down — set work Z zero at the first pad)');
  o.push(p.metric ? 'G21' : 'G20');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5'); // feeder off to start
  o.push(`G0 Z${fmt(zr(p.safeZ), d)}`); // safe height first (relative to datum)

  // ---- Per-point sequences ----------------------------------------------
  let n = 0;
  for (const pt of points) {
    ++n;
    // Pre-travel raise must clear the SAFE height: travel XY at max(freeZ,safeZ)
    // so a per-point freeZ set BELOW safeZ never drags the tip across the board
    // under the guaranteed-clear height. freeZ stays the post-solder retract.
    const travelZ = Math.max(pt.freeZ, p.safeZ);
    const feedOn = `M3 S${fmt(p.feederRPM, d)}`;
    const feed = `G4 P${fmt(pt.feedSeconds, d)}`;
    const feedF = fmt(Math.max(1, p.plungeFeed), d); // F0 stalls GRBL
    const preRaise = `G0 Z${fmt(zr(travelZ), d)}`;
    const raise = `G0 Z${fmt(zr(pt.freeZ), d)}`;

    // Where the tip arrives before the final descent, the moves that make it
    // touch down, and the symmetric retract back out — all approach-aware.
    //
    // For a straight plunge the tip sits directly above the pad, drops
    // vertically to Touch-Z, and (after touching/feeding) lifts straight back to
    // Free-Z via `raise`.
    //
    // For a directional 45° approach the tip starts at Free-Z offset from the
    // pad along ONE axis by the horizontal run (= |FreeZ−TouchZ|, so the
    // diagonal is a true 45°), with the other axis at the pad coord. It then
    // moves diagonally INTO the pad (offset axis → pad coord WHILE Z → Touch-Z),
    // and on retract reverses the SAME diagonal (offset axis back out WHILE Z →
    // Free-Z) before the normal safe-Z handling. Direction = the side the tip
    // comes IN from: front = −Y, back = +Y, right = +X, left = −X.
    const approach: SolderApproach = pt.approach ?? 'plunge';
    let xy: string; // rapid to the start-of-descent XY at Free-Z
    const touch: string[] = []; // moves that bring the tip onto the pad
    // Diagonal retract that mirrors the descent (empty for a straight plunge —
    // the plain vertical `raise` is used instead).
    const angleRetract: string[] = [];
    if (approach === 'plunge') {
      // Straight plunge: above the pad, then a vertical descent.
      xy = `G0 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}`;
      touch.push(`G1 Z${fmt(zr(pt.touchZ), d)} F${feedF}`);
    } else {
      const off = Math.abs(pt.freeZ - pt.touchZ); // horizontal run = vertical drop
      // Per-direction signed offset of the descent START from the pad. The tip
      // comes IN from this side, so it starts on that side and moves toward the
      // pad. front = from −Y, back = from +Y, right = from +X, left = from −X.
      let startX = pt.x;
      let startY = pt.y;
      switch (approach) {
        case 'angle-front':
          startY = pt.y - off; // start on the −Y side, move in +Y into the pad
          break;
        case 'angle-back':
          startY = pt.y + off; // start on the +Y side, move in −Y into the pad
          break;
        case 'angle-right':
          startX = pt.x + off; // start on the +X side, move in −X into the pad
          break;
        case 'angle-left':
          startX = pt.x - off; // start on the −X side, move in +X into the pad
          break;
      }
      // Start above the offset point at Free-Z, descend diagonally onto the pad,
      // and (on retract) reverse the diagonal back out to the offset point.
      xy = `G0 X${fmt(startX, d)} Y${fmt(startY, d)}`;
      touch.push(`G1 X${fmt(pt.x, d)} Y${fmt(pt.y, d)} Z${fmt(zr(pt.touchZ), d)} F${feedF}`);
      angleRetract.push(`G1 X${fmt(startX, d)} Y${fmt(startY, d)} Z${fmt(zr(pt.freeZ), d)} F${feedF}`);
    }

    if (pt.type === SolderFeedType.PreSolder) {
      o.push(`(Point ${n}: pre-solder, ${approach}, feed ${fmt(pt.feedSeconds, d)}s)`);
      o.push(preRaise); // ensure raised to a safe travel height (>= safeZ)
      o.push(xy); // move above pad (or its 45° start) at free Z
      o.push(feedOn); // pre-feed wire onto tip
      o.push(feed);
      o.push('M5'); // stop feeder
      o.push(...touch); // touch pad to deposit (straight or 45°)
      if (p.settleSeconds > 0.0) o.push(`G4 P${fmt(p.settleSeconds, d)}`);
      // Retract: diagonal back out along the 45° approach, else straight up.
      if (angleRetract.length > 0) o.push(...angleRetract);
      else o.push(raise);
    } else {
      // TouchDown
      o.push(`(Point ${n}: touch-down, ${approach}, feed ${fmt(pt.feedSeconds, d)}s)`);
      o.push(preRaise); // ensure raised to a safe travel height (>= safeZ)
      o.push(xy); // move above pad (or its 45° start) at free Z
      o.push(...touch); // touch pad first (straight or 45°)
      o.push(feedOn); // feed wire while in contact
      o.push(feed);
      o.push('M5'); // stop feeder
      if (p.settleSeconds > 0.0) o.push(`G4 P${fmt(p.settleSeconds, d)}`);
      // Retract: diagonal back out along the 45° approach, else straight up.
      if (angleRetract.length > 0) o.push(...angleRetract);
      else o.push(raise);
    }
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(zr(p.safeZ), d)}`);
  o.push('M5');
  o.push('M30');

  return o.join('\n') + '\n';
}
