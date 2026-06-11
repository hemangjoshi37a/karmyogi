// Bore / Drill / Hole G-code generator — UI-independent (no React/DOM imports).
//
// Drills a set of holes (pilot/clearance/bore) on a 3-axis GRBL machine, with an
// optional counterbore (a flat-bottomed wider bore for a screw head) or
// countersink (a true conical seat for a flat/tapered head). Each hole is drilled
// with a standard peck cycle (repeated plunge + partial retract to clear chips).
// A counterbore is milled as concentric circular passes at one flat depth out to
// the head diameter; a countersink is milled as stepped concentric passes that
// follow the head's included angle, increasing in diameter while decreasing in
// depth so the wall slopes from the hole at the bottom to the head at the surface.
//
// Safety behaviour matches the rest of the CAM core: a G21/G90/G94/G17 header, a
// guaranteed safe-Z retract before any XY travel and at program end, conservative
// default feeds, and number formatting that never emits "-0.000".

/** A hole-size preset → the diameters/angles used to plan its holes. */
export interface ScrewPreset {
  /** Display label, e.g. "M3". */
  label: string;
  /** Pilot (tapping) hole diameter (mm) — used when a screw threads into the part. */
  pilotDia: number;
  /** Clearance (through) hole diameter (mm) — the screw shank passes freely. */
  clearanceDia: number;
  /** HEAD diameter (mm) — the counterbore/countersink widens out to this. */
  headDia: number;
  /** Included countersink angle (degrees) — informational seat angle for flat heads. */
  countersinkAngle: number;
}

/** Which hole diameter to drill at each point. */
export type HoleKind = 'pilot' | 'clearance';

/** How the head recess (if enabled) is cut. */
export type RecessKind = 'counterbore' | 'countersink';

/**
 * The five common metric machine-screw sizes, keyed by their label. Diameters
 * are practical desktop-machine values (pilot ≈ tap-drill, clearance ≈ close-fit,
 * head ≈ socket-cap head). Countersink angle is the standard 90° included angle.
 */
export const SCREW_PRESETS: Record<string, ScrewPreset> = {
  M2: { label: 'M2', pilotDia: 1.6, clearanceDia: 2.4, headDia: 3.8, countersinkAngle: 90 },
  M2_5: { label: 'M2.5', pilotDia: 2.05, clearanceDia: 2.9, headDia: 4.5, countersinkAngle: 90 },
  M3: { label: 'M3', pilotDia: 2.5, clearanceDia: 3.4, headDia: 5.5, countersinkAngle: 90 },
  M4: { label: 'M4', pilotDia: 3.3, clearanceDia: 4.5, headDia: 7.0, countersinkAngle: 90 },
  M5: { label: 'M5', pilotDia: 4.2, clearanceDia: 5.5, headDia: 8.5, countersinkAngle: 90 },
};

/** Ordered preset keys for building UI selects (kept in size order). */
export const SCREW_PRESET_KEYS = ['M2', 'M2_5', 'M3', 'M4', 'M5'] as const;
export type ScrewPresetKey = (typeof SCREW_PRESET_KEYS)[number];

/** One hole location at an absolute machine XY. */
export interface ScrewPoint {
  x: number;
  y: number;
}

/** Build a fresh hole point (defaults to the origin). */
export function defaultScrewPoint(overrides: Partial<ScrewPoint> = {}): ScrewPoint {
  return { x: 0, y: 0, ...overrides };
}

/** Global generator policy for a drilling run. */
export interface DrillingParams {
  metric: boolean; // G21 vs G20
  /** Which preset's diameters to use. */
  preset: ScrewPresetKey;
  /** Pilot vs clearance hole at every point. */
  hole: HoleKind;
  /** Full hole depth below the work surface (mm, positive value drills DOWN to -depth). */
  holeDepth: number;
  /** Peck increment per plunge (mm); <= 0 disables pecking (single straight plunge). */
  peck: number;
  /** Enable a head recess (counterbore/countersink) above the hole. */
  recess: boolean;
  /** Recess type when enabled. */
  recessKind: RecessKind;
  /** Recess depth below the work surface (mm, positive). */
  recessDepth: number;
  /** Cutting-tool (end-mill) diameter used to widen the recess (mm). */
  toolDia: number;
  /** Horizontal feed for recess passes (mm/min). */
  feed: number;
  /** Plunge feed for drilling / Z descents (mm/min). */
  plunge: number;
  /** Guaranteed retract height before any XY travel and at program end (mm). */
  safeZ: number;
  /** Decimal places in emitted coordinates (0..6). */
  decimals: number;
  programName: string;
}

export function defaultDrillingParams(
  overrides: Partial<DrillingParams> = {},
): DrillingParams {
  return {
    metric: true,
    preset: 'M3',
    hole: 'clearance',
    holeDepth: 5.0,
    peck: 1.0,
    recess: false,
    recessKind: 'counterbore',
    recessDepth: 2.0,
    toolDia: 1.0,
    feed: 200.0,
    plunge: 100.0,
    safeZ: 5.0,
    decimals: 3,
    programName: 'hjLabs Bore/Drill/Hole',
    ...overrides,
  };
}

/**
 * Resolve the preset for a params object, falling back to M3 if an unknown key
 * is supplied (defensive — a stale persisted key can never crash generation).
 */
export function resolvePreset(key: string): ScrewPreset {
  return SCREW_PRESETS[key] ?? SCREW_PRESETS.M3;
}

/** The hole diameter the run will drill (pilot vs clearance), per the params. */
export function holeDiameter(params: DrillingParams): number {
  const preset = resolvePreset(params.preset);
  return params.hole === 'pilot' ? preset.pilotDia : preset.clearanceDia;
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
 * Emit a peck-drill cycle at (x,y): repeated plunge by `peck`, partial retract to
 * clear chips, advancing until the full `depth` (below the surface) is reached.
 * Pushes the moves onto `o`. A `peck <= 0` collapses to a single straight plunge.
 * Z descends to negative depth; every level uses the plunge feed. After the final
 * cut the tool is left at the bottom (the caller lifts to Free/Safe-Z next).
 */
function emitPeck(
  o: string[],
  depth: number,
  peck: number,
  plungeF: string,
  retractZ: number,
  d: number,
): void {
  const target = -Math.abs(depth);
  if (depth <= 0) return; // nothing to drill
  const step = peck > 0 ? Math.abs(peck) : Math.abs(depth);
  const full = Math.abs(depth);
  let reached = 0; // how far below surface we have cut (positive)
  let prev = 0; // previous cut depth (positive) for the partial retract
  // Cap the iteration count defensively so a tiny step can never spin forever.
  const maxLevels = Math.max(1, Math.ceil(full / step)) + 2;
  for (let i = 0; i < maxLevels && reached < full - 1e-6; i++) {
    reached = Math.min(full, reached + step);
    o.push(`G1 Z${fmt(-reached, d)} F${plungeF}`);
    if (reached < full - 1e-6) {
      // Partial retract back up a little to break/clear the chip, then continue.
      // Retract to just above the previous level (or the work surface for the
      // first peck) — bounded by the configured retract height.
      const back = Math.min(retractZ, -prev + Math.min(step, retractZ));
      o.push(`G0 Z${fmt(back, d)}`);
      prev = reached;
    }
  }
  // Only emit a final guard cut if the loop rounded short of the full depth —
  // otherwise the last loop cut is already exactly the target and a guard line
  // would be a redundant duplicate G1 Z move.
  if (reached < full - 1e-6) {
    o.push(`G1 Z${fmt(target, d)} F${plungeF}`);
  }
}

/**
 * Cut a single full circle of radius `r` centred on (cx,cy) at height `z`: rapid-
 * free entry is the caller's job; this moves to the ring start along +X at the
 * given Z (a feed move so the helical descent into the cone is controlled) and
 * then cuts the circle as two G3 semicircles (CCW) so there is no I/J ambiguity.
 * Pure; pushes onto `o`.
 */
function emitCircle(
  o: string[],
  cx: number,
  cy: number,
  r: number,
  z: number,
  feedF: string,
  d: number,
): void {
  o.push(`G1 X${fmt(cx + r, d)} Y${fmt(cy, d)} Z${fmt(z, d)} F${feedF}`);
  o.push(`G3 X${fmt(cx - r, d)} Y${fmt(cy, d)} I${fmt(-r, d)} J0 F${feedF}`);
  o.push(`G3 X${fmt(cx + r, d)} Y${fmt(cy, d)} I${fmt(r, d)} J0 F${feedF}`);
}

/**
 * Build the increasing radii (tool-CENTER) for stepping a recess out from the
 * first stepover to `maxR`, always ending exactly on `maxR`. Returns an empty
 * list when the head is not wider than the tool (`maxR <= 0`).
 */
function recessRadii(maxR: number, toolR: number): number[] {
  if (maxR <= 1e-6) return [];
  const stepover = Math.max(0.05, toolR * 0.8); // conservative radial stepover
  const radii: number[] = [];
  for (let r = stepover; r < maxR - 1e-6; r += stepover) radii.push(r);
  radii.push(maxR);
  return radii;
}

/**
 * Emit a flat-bottomed COUNTERBORE centred on (x,y): concentric full-circle
 * passes spiralling OUT from the first stepover to (headDia/2 − toolRadius), all
 * at the single flat depth `z`. This mills the cylindrical, vertical-wall bore a
 * socket-cap head drops into. Assumes the tool is already plunged to `z`. Pure.
 */
function emitCounterbore(
  o: string[],
  cx: number,
  cy: number,
  headDia: number,
  toolDia: number,
  z: number,
  feedF: string,
  d: number,
): void {
  const toolR = Math.max(0.01, toolDia / 2);
  // Largest radius the tool CENTER travels so the cut edge reaches headDia/2.
  const maxR = headDia / 2 - toolR;
  for (const r of recessRadii(maxR, toolR)) {
    emitCircle(o, cx, cy, r, z, feedF, d);
  }
}

/**
 * Emit a conical COUNTERSINK seat centred on (x,y): a sequence of concentric
 * circular passes that follow the cone surface. The cone has its WIDE rim
 * (radius = headDia/2) at the work surface (z=0) and narrows down toward the
 * hole at the bottom. With an included angle θ the wall makes a half-angle θ/2
 * with the Z axis, so at a given cut-edge radius `r` the depth below the surface
 * is
 *
 *     depth(r) = (headRadius − r) / tan(θ/2)
 *
 * i.e. z = −depth(r), with z = 0 at r = headDia/2 (the top rim) and increasing
 * depth as r shrinks toward the hole — the deepest pass is the innermost ring.
 * We approximate the slanted wall by stepping the tool CENTER radius outward by
 * the tool stepover and, for each pass, dropping Z to the cone depth at the
 * corresponding cut-edge radius (centre radius + tool radius). Passes run
 * deepest-first (innermost) so each ring climbs the cone, and the cut is bounded
 * by both the configured recess depth and the cone geometry. Assumes the tool
 * starts plunged at the centre. Pure; pushes onto `o`.
 */
function emitCountersink(
  o: string[],
  cx: number,
  cy: number,
  headDia: number,
  holeDia: number,
  toolDia: number,
  angleDeg: number,
  maxDepth: number,
  plungeF: string,
  feedF: string,
  d: number,
): void {
  const toolR = Math.max(0.01, toolDia / 2);
  const headR = headDia / 2;
  // Cut-edge radius reaches headR at the rim; tool CENTER travels to headR-toolR.
  const maxCenterR = headR - toolR;
  if (maxCenterR <= 1e-6) return; // head not wider than the tool — nothing to cut

  // Half of the included angle; clamp to a sane open cone so tan() stays finite
  // and positive (a degenerate 0/180 angle would divide by ~0).
  const half = Math.min(89, Math.max(1, angleDeg / 2));
  const tanHalf = Math.tan((half * Math.PI) / 180);
  const holeR = Math.max(0, holeDia / 2);

  // Cone depth (positive, below surface) at a given cut-edge radius: zero at the
  // head rim (edgeR = headR) and deepening as the radius shrinks toward the hole.
  // Bounded below by the rim (never above the surface).
  const depthAt = (edgeR: number): number =>
    Math.max(0, (headR - edgeR) / tanHalf);

  // Walk cut-EDGE radii along the cone wall from the bottom (the hole rim) up to
  // the head rim, stepping by the tool stepover. The deepest ring is at the hole
  // edge; each subsequent ring is wider and shallower, climbing the cone wall.
  // Converting an edge radius to the tool CENTER radius (edgeR − toolR, clamped
  // ≥ 0) is what the machine actually traces.
  const stepover = Math.max(0.05, toolR * 0.8);
  const edgeRadii: number[] = [];
  for (let er = holeR; er < headR - 1e-6; er += stepover) edgeRadii.push(er);
  edgeRadii.push(headR); // always finish flush with the head rim at z=0
  if (edgeRadii.length === 0) return;

  let first = true;
  // Deepest (smallest edge radius) first so each ring climbs toward the surface.
  for (const edgeR of edgeRadii) {
    const cr = Math.max(0, edgeR - toolR); // tool CENTER radius for this pass
    // Cone depth at this edge, never exceeding the configured recess depth.
    const z = -Math.min(maxDepth, depthAt(edgeR));
    if (first) {
      // Plunge straight down at the centre to the deepest ring's Z first.
      o.push(`G1 X${fmt(cx, d)} Y${fmt(cy, d)} Z${fmt(z, d)} F${plungeF}`);
      first = false;
    }
    if (cr <= 1e-6) {
      // Degenerate ring (edge within the tool radius of centre): the centre
      // plunge already cut it — skip the zero-radius "circle".
      continue;
    }
    emitCircle(o, cx, cy, cr, z, feedF, d);
  }
}

/**
 * Produce a complete, safe G-code program drilling/boring every hole point.
 * Header → for each point: rapid to safe-Z, rapid XY, (optional recess pocket),
 * peck-drill the hole, retract to safe-Z → footer (retract + program end).
 */
export function generateDrilling(
  points: ScrewPoint[],
  params: Partial<DrillingParams> = {},
): string {
  const p = defaultDrillingParams(params);
  const d = clampDecimals(p.decimals);
  const o: string[] = [];

  const preset = resolvePreset(p.preset);
  const holeDia = holeDiameter(p);
  const plungeF = fmt(Math.max(1, p.plunge), d); // F0 stalls GRBL
  const feedF = fmt(Math.max(1, p.feed), d);
  const safeZ = Math.max(0, p.safeZ);
  const holeDepth = Math.max(0, p.holeDepth);
  const recessDepth = Math.max(0, p.recessDepth);
  const peck = Math.max(0, p.peck);

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by hjLabs Candle Bore/Drill/Hole)');
  o.push(
    `(${preset.label} ${p.hole} hole D${fmt(holeDia, 2)} depth ${fmt(holeDepth, 2)} mm` +
      `${p.recess ? `, ${p.recessKind} D${fmt(preset.headDia, 2)} depth ${fmt(recessDepth, 2)} mm` : ''})`,
  );
  o.push(p.metric ? 'G21' : 'G20');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push(`G0 Z${fmt(safeZ, d)}`); // guaranteed safe height first

  // ---- Per-point sequences ----------------------------------------------
  let n = 0;
  for (const pt of points) {
    ++n;
    o.push(
      `(Hole ${n}: X${fmt(pt.x, d)} Y${fmt(pt.y, d)}` +
        `${p.recess ? `, ${p.recessKind}` : ''})`,
    );
    o.push(`G0 Z${fmt(safeZ, d)}`); // ensure clear before XY travel
    o.push(`G0 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}`); // rapid to the point

    // Optional head recess FIRST (widen the top so the head seats), milled as
    // concentric circular passes. A COUNTERBORE is a flat-bottomed cylindrical
    // pocket at the recess depth (plunge at centre, then spiral out). A
    // COUNTERSINK is a conical seat following the head's included angle, widening
    // from the hole at the bottom up to the head diameter at the surface. Only
    // emitted when it actually removes material.
    if (p.recess && recessDepth > 0 && preset.headDia / 2 - Math.max(0.01, p.toolDia / 2) > 1e-6) {
      if (p.recessKind === 'countersink') {
        emitCountersink(
          o,
          pt.x,
          pt.y,
          preset.headDia,
          holeDia,
          p.toolDia,
          preset.countersinkAngle,
          recessDepth,
          plungeF,
          feedF,
          d,
        );
      } else {
        o.push(`G1 Z${fmt(-recessDepth, d)} F${plungeF}`); // plunge at centre
        emitCounterbore(o, pt.x, pt.y, preset.headDia, p.toolDia, -recessDepth, feedF, d);
      }
      o.push(`G0 Z${fmt(safeZ, d)}`); // retract before re-centering for the drill
      o.push(`G0 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}`);
    }

    // Drill the hole with a peck cycle down to the full hole depth.
    if (holeDepth > 0) {
      emitPeck(o, holeDepth, peck, plungeF, safeZ, d);
    }

    o.push(`G0 Z${fmt(safeZ, d)}`); // retract to safe height after the hole
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(safeZ, d)}`);
  o.push('M30');

  return o.join('\n') + '\n';
}
