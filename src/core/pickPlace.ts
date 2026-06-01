// Pick & Place G-code generator — UI-independent.
//
// Machine model: instead of a spindle, the head carries a vacuum suction cup or
// a mechanical gripper wired to the controller's spindle on/off output. Turning
// the "spindle" on (M3 S..) grips / applies vacuum (picks the part); M5 releases
// it. The user defines pick→place operations; for each the machine travels at a
// safe Z, lowers to the pick height, grips, lifts back to safe Z, travels to the
// place location, lowers to the place height, releases, and lifts again.
//
// Exactly like the pen-plot / soldering / glue modes: Z is travel-up vs down
// ONLY — it never moves in the same line as XY.
//
// Safety behaviour matches the rest of the CAM core: G21/G90/G94/G17 header, a
// guaranteed safe-Z retract before any XY travel and at program end, number
// formatting that never emits "-0.000", and conservative explicit M5 release.
//
// Pure TypeScript: no React/DOM imports.

import { pt, type Point } from './geometry';

// re-export Point/pt so consumers of the model can use them without a second
// import path (the panel imports from here).
export { pt };
export type { Point };

/** What is mounted at the head to grab the part. */
export type PnpHeadType = 'vacuum' | 'gripper';

/** One pick→place operation in absolute machine coordinates (mm). */
export interface PnpOp {
  /** Where to pick the part up. */
  pickX: number;
  pickY: number;
  /** Where to set the part down. */
  placeX: number;
  placeY: number;
  /**
   * Optional part rotation in degrees. With no rotary axis it is emitted only as
   * a comment; see `rotaryAxis` in `PnpParams` to drive an A axis instead.
   */
  rotation?: number;
}

/** Defaults for a fresh pick&place operation. */
export function defaultPnpOp(overrides: Partial<PnpOp> = {}): PnpOp {
  return {
    pickX: 0,
    pickY: 0,
    placeX: 0,
    placeY: 0,
    ...overrides,
  };
}

/** Generator policy for a pick&place program. */
export interface PnpParams {
  /** Vacuum suction cup or mechanical gripper (affects only comment wording). */
  headType: PnpHeadType;
  metric: boolean; // G21 vs G20
  /** Raised travel/clearance height between pick and place (mm, absolute). */
  travelZ: number;
  /** Down height at which the part is picked up (mm, absolute). */
  pickZ: number;
  /** Down height at which the part is placed (mm, absolute). */
  placeZ: number;
  /** Rapid/travel feed for XY moves (mm/min). */
  feedXY: number;
  /** Plunge feed used when lowering to pick/place height (mm/min). */
  feedZ: number;
  /** Spindle S value = vacuum / grip strength. */
  gripRpm: number;
  /** Dwell (ms) after gripping at the pick point, so the grip is secure. 0 = none. */
  pickDwellMs: number;
  /** Dwell (ms) after releasing at the place point, so the part settles. 0 = none. */
  placeDwellMs: number;
  /**
   * Emit per-op rotation as a real A-axis word (G0 A<deg>) instead of a comment.
   * Off by default — most 3-axis GRBL machines have no rotary axis.
   */
  rotaryAxis: boolean;
  decimals: number;
  programName: string;
}

export function defaultPnpParams(overrides: Partial<PnpParams> = {}): PnpParams {
  return {
    headType: 'vacuum',
    metric: true,
    travelZ: 5.0,
    pickZ: -1.0,
    placeZ: -1.0,
    feedXY: 1500.0,
    feedZ: 200.0,
    gripRpm: 1000.0,
    pickDwellMs: 250,
    placeDwellMs: 250,
    rotaryAxis: false,
    decimals: 3,
    programName: 'hjLabs Pick & Place',
    ...overrides,
  };
}

// ---- Formatting ------------------------------------------------------------

/** Formatted number, never "-0.000" — mirrors the soldering/glue/emitter fmt(). */
function fmt(value: number, decimals: number): string {
  const snap = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(decimals);
}

/** Convert a dwell in milliseconds to a G4 P<seconds> word. */
function dwellSeconds(ms: number, decimals: number): string {
  return fmt(Math.max(0, ms) / 1000, decimals);
}

// ---- Generator -------------------------------------------------------------

/**
 * Produce a complete, safe pick&place G-code program for the given operations.
 *
 * Per op: rapid XY to the pick point at travelZ → lower to pickZ (plunge feed) →
 * grip ON (M3 S<gripRpm>) + optional pick dwell → lift to travelZ → rapid XY to
 * the place point at travelZ → lower to placeZ (plunge feed) → release (M5) +
 * optional place dwell → lift to travelZ. Z and XY never change in the same
 * move. Footer raises to travelZ, releases (M5) and ends the program (M30).
 */
export function generatePickPlace(ops: PnpOp[], params: Partial<PnpParams> = {}): string {
  const p = defaultPnpParams(params);
  const d = p.decimals;
  const o: string[] = [];
  const grab = p.headType === 'gripper' ? 'grip' : 'vacuum';
  const drop = p.headType === 'gripper' ? 'open' : 'release';

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push(`(Generated by hjLabs Candle Pick & Place — head: ${p.headType})`);
  o.push(p.metric ? 'G21' : 'G20');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5'); // grip/vacuum off to start
  o.push(`G0 Z${fmt(p.travelZ, d)}`); // safe height first

  // ---- Per-op pick → place sequences -----------------------------------
  let n = 0;
  for (const op of ops) {
    ++n;
    const rot = op.rotation;
    const rotNote = rot != null && rot !== 0 ? `, rot ${fmt(rot, d)} deg` : '';

    // --- pick ---
    o.push(`(Op ${n}: ${grab} pick (${fmt(op.pickX, d)}, ${fmt(op.pickY, d)})${rotNote})`);
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // ensure raised before XY travel
    o.push(`G1 X${fmt(op.pickX, d)} Y${fmt(op.pickY, d)} F${fmt(p.feedXY, d)}`); // travel above pick at safe Z
    if (p.rotaryAxis && rot != null) o.push(`G0 A${fmt(rot, d)}`); // orient at safe Z (own line)
    o.push(`G1 Z${fmt(p.pickZ, d)} F${fmt(p.feedZ, d)}`); // lower to pick height
    o.push(`M3 S${fmt(p.gripRpm, d)}`); // grip / vacuum on
    if (p.pickDwellMs > 0) o.push(`G4 P${dwellSeconds(p.pickDwellMs, d)}`);
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // lift to safe Z with part held

    // --- place ---
    o.push(`(Op ${n}: ${drop} place (${fmt(op.placeX, d)}, ${fmt(op.placeY, d)}))`);
    o.push(`G1 X${fmt(op.placeX, d)} Y${fmt(op.placeY, d)} F${fmt(p.feedXY, d)}`); // travel above place at safe Z
    o.push(`G1 Z${fmt(p.placeZ, d)} F${fmt(p.feedZ, d)}`); // lower to place height
    o.push('M5'); // release / open
    if (p.placeDwellMs > 0) o.push(`G4 P${dwellSeconds(p.placeDwellMs, d)}`);
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // lift to safe Z
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(p.travelZ, d)}`);
  o.push('M5');
  o.push('M30');

  return o.join('\n') + '\n';
}
