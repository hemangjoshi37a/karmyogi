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

// ─────────────────────── PP1: Parts → Packages → Footprints ───────────────────────
//
// The OpenPnP-style data backbone. A FOOTPRINT is the physical body geometry
// (size + height) shared by many parts; a PACKAGE pairs a footprint with the
// nozzle tip that handles it; a PART is a specific component (a value) using a
// package. Pure data — the generator only needs the package's body height + the
// part's pick rotation, but the full hierarchy is modelled so the UI library is
// real and re-exportable.

/** PP1 — a physical body footprint (e.g. 0805, SOT-23, QFP-32). */
export interface PnpFootprint {
  id: string;
  name: string;
  /** Body length × width (mm) — for vision/centering + collision sanity. */
  bodyLength: number;
  bodyWidth: number;
  /** Body height (mm) above the board — sets the pick Z relative to the surface. */
  bodyHeight: number;
}

/** PP1 — a package: a footprint + the nozzle tip id that handles it. */
export interface PnpPackage {
  id: string;
  name: string;
  footprintId: string;
  /** Nozzle-tip id (see PnpNozzleTip) suited to this package; '' = any. */
  nozzleTipId: string;
}

/** PP1 — a part: a specific component value mapped to a package. */
export interface PnpPart {
  id: string;
  name: string;
  packageId: string;
  /** Component value / MPN (e.g. "10k", "100nF"). */
  value?: string;
}

// ─────────────────────── PP5: Nozzle-tip library ───────────────────────

/** PP5 — a nozzle tip + its calibration offset from the head reference. */
export interface PnpNozzleTip {
  id: string;
  name: string;
  /** Outer ⌀ (mm) of the suction tip — sanity vs the part body. */
  diameter: number;
  /** Calibration X/Y/Z offset (mm) from the head reference to this tip. */
  offsetX: number;
  offsetY: number;
  offsetZ: number;
}

// ─────────────────────── PP2: Feeder library ───────────────────────

/** PP2 — feeder kinds. */
export type PnpFeederType = 'tape' | 'tube' | 'tray';

/**
 * PP2 — a feeder that presents parts at a known location. TAPE feeders advance
 * by `pitch` each pick along a direction; TUBE feeders present the next part at
 * the same spot; TRAY feeders index a rows×cols grid. The generator reads
 * `pickX/pickY/pickZ/pickRot` + `count` to source parts; the pitch/advance is
 * carried for documentation + the UI library (a real machine advances the strip
 * with its own actuator, emitted here as a comment).
 */
export interface PnpFeeder {
  id: string;
  name: string;
  type: PnpFeederType;
  /** Part id this feeder is loaded with (PP1 link); '' = unassigned. */
  partId: string;
  /** Pick location of the FIRST part (mm, absolute). */
  pickX: number;
  pickY: number;
  /** Pick-down Z at the feeder (mm, absolute). */
  pickZ: number;
  /** Part orientation as presented by the feeder (deg). */
  pickRot: number;
  /** Parts remaining in the feeder. */
  count: number;
  /** TAPE: tape pitch (mm) between parts (2/4/8/12…). */
  tapePitch: number;
  /** TAPE: advance direction (deg) the strip indexes along. */
  tapeAngle: number;
  /** TRAY: grid rows × cols and per-step spacing (mm). */
  trayRows: number;
  trayCols: number;
  traySpacingX: number;
  traySpacingY: number;
}

let pnpIdSeq = 0;
/** A collision-free id for any PnP library entity. */
export function newPnpId(prefix = 'id'): string {
  pnpIdSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${pnpIdSeq.toString(36)}`;
}

/** Defaults for a fresh footprint. */
export function defaultFootprint(o: Partial<PnpFootprint> = {}): PnpFootprint {
  return { id: newPnpId('fp'), name: 'Footprint', bodyLength: 2, bodyWidth: 1.25, bodyHeight: 0.5, ...o };
}
/** Defaults for a fresh package. */
export function defaultPackage(o: Partial<PnpPackage> = {}): PnpPackage {
  return { id: newPnpId('pkg'), name: 'Package', footprintId: '', nozzleTipId: '', ...o };
}
/** Defaults for a fresh part. */
export function defaultPart(o: Partial<PnpPart> = {}): PnpPart {
  return { id: newPnpId('part'), name: 'Part', packageId: '', value: '', ...o };
}
/** Defaults for a fresh nozzle tip. */
export function defaultNozzleTip(o: Partial<PnpNozzleTip> = {}): PnpNozzleTip {
  return { id: newPnpId('noz'), name: 'Nozzle', diameter: 0.7, offsetX: 0, offsetY: 0, offsetZ: 0, ...o };
}
/** Defaults for a fresh feeder. */
export function defaultFeeder(o: Partial<PnpFeeder> = {}): PnpFeeder {
  return {
    id: newPnpId('fdr'),
    name: 'Feeder',
    type: 'tape',
    partId: '',
    pickX: 0,
    pickY: 0,
    pickZ: -1,
    pickRot: 0,
    count: 0,
    tapePitch: 4,
    tapeAngle: 0,
    trayRows: 1,
    trayCols: 1,
    traySpacingX: 0,
    traySpacingY: 0,
    ...o,
  };
}

/** One pick→place operation in absolute machine coordinates (mm). */
export interface PnpOp {
  /**
   * Stable per-op identity used only as a React list key in the UI; it keeps the
   * key tied to the row's data (not its array index) so reordering / deletion
   * don't reuse keys and remount the wrong input mid-edit. Ignored by the
   * generator. Optional so older saved docs (without it) still load.
   */
  id?: string;
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

/** Monotonic counter + random suffix → a collision-free per-op id. */
let pnpOpSeq = 0;
export function newPnpOpId(): string {
  pnpOpSeq += 1;
  return `op-${Date.now().toString(36)}-${pnpOpSeq.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

/** Defaults for a fresh pick&place operation. */
export function defaultPnpOp(overrides: Partial<PnpOp> = {}): PnpOp {
  return {
    id: newPnpOpId(),
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

  // ---- PP6: vacuum control + part-present sensing + blow-off ---------------
  /**
   * After releasing at the place point, BLOW OFF the part (a short positive-air
   * pulse) so it does not stick to the nozzle. Emitted as M8 (aux/coolant on) →
   * dwell → M9, after the M5 release. Off by default.
   */
  blowOff: boolean;
  /** Blow-off pulse duration (ms). */
  blowOffMs: number;
  /**
   * After picking, PROBE down a touch (G38.4 — probe expecting NO contact) to
   * confirm a part is actually held on the nozzle (part-present sensing). The
   * controller halts if the expected state isn't met. Off by default (needs a
   * probe/vacuum-sense input).
   */
  partPresentCheck: boolean;

  // ---- PP8: park + discard locations --------------------------------------
  /** Park the head at a safe location at program end (after the last place). */
  parkAtEnd: boolean;
  parkX: number;
  parkY: number;
  /** A discard/reject location to drop a failed/unrecognised part (documentary). */
  discardX: number;
  discardY: number;

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
    blowOff: false,
    blowOffMs: 150,
    partPresentCheck: false,
    parkAtEnd: false,
    parkX: 0,
    parkY: 0,
    discardX: 0,
    discardY: 0,
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
  o.push(`(Generated by karmyogi.hjLabs.in Pick & Place — head: ${p.headType})`);
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
    // PP6: confirm a part is actually held — probe expecting NO contact below the
    // pick height; the controller halts if the part is missing (part-present).
    if (p.partPresentCheck) {
      o.push('(part-present check — halts if no part on the nozzle)');
      o.push(`G38.4 Z${fmt(p.pickZ, d)} F${fmt(p.feedZ, d)}`);
    }
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // lift to safe Z with part held

    // --- place ---
    o.push(`(Op ${n}: ${drop} place (${fmt(op.placeX, d)}, ${fmt(op.placeY, d)}))`);
    o.push(`G1 X${fmt(op.placeX, d)} Y${fmt(op.placeY, d)} F${fmt(p.feedXY, d)}`); // travel above place at safe Z
    o.push(`G1 Z${fmt(p.placeZ, d)} F${fmt(p.feedZ, d)}`); // lower to place height
    o.push('M5'); // release / open
    if (p.placeDwellMs > 0) o.push(`G4 P${dwellSeconds(p.placeDwellMs, d)}`);
    // PP6: blow-off — a short positive-air pulse so the part doesn't cling.
    if (p.blowOff && p.headType === 'vacuum') {
      o.push('M8'); // aux/air on
      o.push(`G4 P${dwellSeconds(p.blowOffMs, d)}`);
      o.push('M9'); // aux/air off
    }
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // lift to safe Z
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(p.travelZ, d)}`);
  o.push('M5');
  // PP8: park the head at a safe location at program end.
  if (p.parkAtEnd) {
    o.push(`(park)`);
    o.push(`G0 X${fmt(p.parkX, d)} Y${fmt(p.parkY, d)}`);
  }
  o.push('M30');

  return o.join('\n') + '\n';
}
