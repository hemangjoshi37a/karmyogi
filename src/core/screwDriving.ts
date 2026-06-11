// Screw-driving G-code generator — UI-independent (no React/DOM imports).
//
// Machine model: an electric screwdriver with a MAGNETIC bit is mounted in the
// spindle slot. The controller's spindle output (M3/M5) turns the screwdriver:
// M3 S<rpm> spins it to DRIVE a screw in, M5 stops it. Picking a screw from the
// loader is purely mechanical — the magnetic bit grabs the screw by descending
// onto it and dwelling, with the driver NOT spinning (so the screw is not flung
// off or driven into the loader).
//
// Cycle per target point:
//   1. ensure safe-Z, rapid to the loader (pickupX/pickupY)
//   2. feed down to pickZ, dwell (G4) so the magnet grabs the screw, retract
//   3. rapid to the target XY
//   4. M3 S<rpm> to spin the driver, feed down to the target depth (push+drive)
//   5. dwell to seat, M5 to stop, retract to safe-Z
//
// Safety behaviour matches the rest of the CAM core: a G21/G90/G94/G17 header, a
// guaranteed safe-Z retract before EVERY XY travel and at program end, M5 + M30
// at the end, conservative default feeds, and number formatting that never emits
// "-0.000".

/** One screw-driving target at an absolute machine XY with a per-point depth. */
export interface ScrewDrivePoint {
  x: number;
  y: number;
  /** Per-point screwing depth (mm, negative = driven INTO the work). */
  depth: number;
}

/** Build a fresh screw-driving point (defaults to the origin at depth 0). */
export function defaultScrewDrivePoint(overrides: Partial<ScrewDrivePoint> = {}): ScrewDrivePoint {
  return { x: 0, y: 0, depth: 0, ...overrides };
}

/** Global generator policy for a screw-driving run. */
export interface ScrewDrivingParams {
  metric: boolean; // G21 vs G20
  /** Loader X where a screw is picked from. */
  pickupX: number;
  /** Loader Y where a screw is picked from. */
  pickupY: number;
  /** Z descended to at the loader to grab a screw with the magnetic bit (mm, absolute). */
  pickZ: number;
  /** Dwell at the loader so the magnet grabs the screw (seconds). */
  pickDwellSec: number;
  /** Guaranteed travel/retract height (mm, positive). */
  safeZ: number;
  /** Spindle speed word (S) that spins the electric screwdriver while driving. */
  driverRPM: number;
  /** Z plunge feed while driving the screw in — the "speed of pushing" (mm/min). */
  pushFeed: number;
  /** Feed for the descent onto the loader to pick a screw (mm/min). */
  approachFeed: number;
  /** Dwell at the final depth so the screw seats (seconds). */
  seatDwellSec: number;
  /** Default per-point screwing depth (mm, negative = into the work). */
  defaultDepth: number;
  /** Decimal places in emitted coordinates (0..6). */
  decimals: number;
  programName: string;
}

export function defaultScrewDrivingParams(
  overrides: Partial<ScrewDrivingParams> = {},
): ScrewDrivingParams {
  return {
    metric: true,
    pickupX: 0.0,
    pickupY: 0.0,
    pickZ: -8.0,
    pickDwellSec: 0.5,
    safeZ: 10.0,
    driverRPM: 800.0,
    pushFeed: 80.0,
    approachFeed: 200.0,
    seatDwellSec: 0.3,
    defaultDepth: -6.0,
    decimals: 3,
    programName: 'hjLabs Screw-Driving',
    ...overrides,
  };
}

/**
 * Clamp a decimals value into the range `toFixed()` accepts (0..6). An
 * out-of-range value passed to `toFixed()` throws a RangeError, which — reached
 * from a render-phase useMemo — white-screens the panel. Defence-in-depth
 * alongside the UI guards.
 */
function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 3;
  return Math.min(6, Math.max(0, Math.floor(decimals)));
}

/** Formatted number, never "-0.000" — mirrors the rest of the CAM emitter. */
function fmt(value: number, decimals: number): string {
  const d = clampDecimals(decimals);
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(d);
}

/**
 * Produce a complete, safe G-code program that drives every screw point. For
 * each point: pick a screw from the loader (descend, magnet-grab dwell, retract),
 * travel to the target, spin the driver (M3) and push the screw to its depth,
 * seat-dwell, stop the driver (M5), and retract to safe-Z. Header sets the safe
 * modal state and lifts to safe-Z first; the footer stops the driver and ends.
 */
export function generateScrewDriving(
  points: ScrewDrivePoint[],
  params: Partial<ScrewDrivingParams> = {},
): string {
  const p = defaultScrewDrivingParams(params);
  const d = clampDecimals(p.decimals);
  const o: string[] = [];

  const safeZ = Math.max(0, p.safeZ);
  const pushF = fmt(Math.max(1, p.pushFeed), d); // F0 stalls GRBL
  const approachF = fmt(Math.max(1, p.approachFeed), d);
  const driverS = fmt(Math.max(0, p.driverRPM), d);
  const pickDwell = fmt(Math.max(0, p.pickDwellSec), d);
  const seatDwell = fmt(Math.max(0, p.seatDwellSec), d);
  const safeZStr = `G0 Z${fmt(safeZ, d)}`;

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by hjLabs Candle Screw-Driving)');
  o.push(
    `(Magnetic bit picks screws at X${fmt(p.pickupX, 2)} Y${fmt(p.pickupY, 2)};` +
      ` spindle output = electric screwdriver, M3 drives, M5 stops)`,
  );
  o.push(p.metric ? 'G21' : 'G20');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5'); // driver off to start
  o.push(safeZStr); // guaranteed safe height first

  // ---- Per-point sequences ----------------------------------------------
  let n = 0;
  for (const pt of points) {
    ++n;
    // Resolve the per-point depth, falling back to the default when blank/NaN.
    const depth = Number.isFinite(pt.depth) ? pt.depth : p.defaultDepth;
    o.push(
      `(Screw ${n}: drive to depth ${fmt(depth, 2)} at X${fmt(pt.x, d)} Y${fmt(pt.y, d)})`,
    );

    // --- Pick a screw from the loader (driver NOT spinning) ---
    o.push(safeZStr); // ensure clear before XY travel to the loader
    o.push(`G0 X${fmt(p.pickupX, d)} Y${fmt(p.pickupY, d)}`); // rapid to the loader
    o.push(`G1 Z${fmt(p.pickZ, d)} F${approachF}`); // descend to grab the screw
    o.push(`G4 P${pickDwell}`); // dwell so the magnet grabs
    o.push(safeZStr); // retract WITH the screw on the bit

    // --- Drive the screw at the target ---
    o.push(`G0 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}`); // rapid to the target XY
    o.push(`M3 S${driverS}`); // spin the screwdriver to DRIVE the screw in
    o.push(`G1 Z${fmt(depth, d)} F${pushF}`); // push + drive to depth
    o.push(`G4 P${seatDwell}`); // dwell so the screw seats
    o.push('M5'); // stop the driver
    o.push(safeZStr); // retract to safe height
  }

  // ---- Footer -----------------------------------------------------------
  o.push('M5');
  o.push(safeZStr);
  o.push('M30');

  return o.join('\n') + '\n';
}
