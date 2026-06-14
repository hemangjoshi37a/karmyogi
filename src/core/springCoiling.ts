// Spring-coiling G-code generator — UI-independent (no React/DOM imports).
//
// Machine model: a 2-axis automatic spring coiler (a DIFFERENT machine type from
// the 3-axis GRBL modes). A stepper/servo rotates a CHUCK; a mandrel/shaft is
// fitted in the chuck and the wire is fixed to the chuck-end of the mandrel.
// Rotating the chuck winds the wire around the mandrel — that is the coil. The
// number of chuck revolutions IS the number of spring turns. A second LINEAR axis
// (a carriage / wire-guide) moves along the spring axis at a speed SYNCED to the
// rotation to set the PITCH (axial advance per revolution). The carriage moves
// ONLY along that one linear axis — it never moves in 3D. The helix shape is the
// RESULTING WORKPIECE wound on the mandrel, NOT a path any head traces through
// space. Motion is therefore fully coordinated and TWO-axis only: each revolution
// = 360° on the rotary axis while the linear axis advances by the current pitch.
//
//   - ROTARY axis (default 'A', degrees): cumulative chuck angle. turns × 360°.
//   - LINEAR axis (default 'X', mm): cumulative axial advance (Σ pitch/rev) =
//     the carriage position along the spring axis. Defaulting to X makes the
//     simulation playhead's X coordinate track the carriage directly.
//
// CLOSING (dead) turns: at EACH end the user can request N closed turns where the
// pitch ≈ the wire diameter (the coils touch) — for squared compression-spring
// ends. Body turns use the set pitch. Spring TYPE drives the default body pitch +
// which closing options apply:
//   - compression: closed ends + open body pitch (the only type using closing).
//   - extension:   closed/tight coils throughout (pitch ≈ wire dia); hooks manual.
//   - torsion:     closed coils throughout (pitch ≈ wire dia); legs manual.
//
// This module emits ONE program from the params:
//   - generateSpringMachineGcode() — the real 2-axis MACHINE program: coordinated
//     `G1 <ROT><deg> <LIN><mm> F<feed>` moves, subdividing each rev into
//     segmentsPerRev so the synced motion is smooth. This is the ONLY thing
//     streamed/downloaded — there is no XYZ-helix program (a coiler is not a
//     3-axis head and an XYZ helix would be a meaningless 3-axis path).
//
// For the 3D visualization the module also exposes a PURE helper,
// `springHelixPoints()`, returning the wound coil's helix POINTS (axis along +X,
// circle in the Y–Z plane, lifted so it rests on the bed). Those points describe
// the WORKPIECE the scene draws — they are NOT a program and are never streamed.
//
// Safety behaviour mirrors the rest of the CAM core: a G21/G90/G94 header,
// conservative derived feeds, and number formatting that never emits "-0.000".

/** The spring family being wound; drives default body pitch + closing options. */
export type SpringType = 'compression' | 'extension' | 'torsion';

/** Winding direction of the chuck (sign of the rotary-axis advance). */
export type SpringDirection = 'cw' | 'ccw';

/** Generator policy for a spring-coiling run. */
export interface SpringCoilingParams {
  /** Wire diameter (mm). Closed/dead turns use this as the pitch (coils touch). */
  wireDiameter: number;
  /**
   * MEAN coil diameter (mm) — the diameter of the helix the wire CENTRE traces
   * (≈ mandrel diameter + wire diameter). The 3D helix radius is coilDiameter/2.
   */
  coilDiameter: number;
  /** Number of body (active) turns wound at the set body pitch. */
  bodyTurns: number;
  /** Body pitch: axial advance per revolution (mm). Compression only; others use wireDiameter. */
  pitch: number;
  /** Which spring family — sets the default body pitch + which closing applies. */
  springType: SpringType;
  /** Closed (dead) turns at the START end (pitch ≈ wire dia). Compression ends. */
  closeTurnsStart: number;
  /** Closed (dead) turns at the END end (pitch ≈ wire dia). Compression ends. */
  closeTurnsEnd: number;
  /**
   * Release turns: AFTER the coil is fully wound, reverse-rotate the chuck this
   * many turns with the carriage HELD in place, to relieve the wind-up tension so
   * the finished spring slips off the mandrel. 0 = none (default ~0.5).
   */
  releaseTurns: number;
  /** Chuck rotational speed (rev/min); the linear feed is derived from this + pitch. */
  chuckRpm: number;
  /** Winding direction of the chuck. */
  direction: SpringDirection;
  /** Subdivisions per revolution for the coordinated moves (smoothness). */
  segmentsPerRev: number;
  /** Rotary-axis letter (default 'A'); cumulative chuck angle in degrees. */
  rotaryAxis: string;
  /** Linear-axis letter (default 'X'); cumulative axial advance in mm (the carriage). */
  linearAxis: string;
  /** Decimal places in emitted coordinates (0..6). */
  decimals: number;
  programName: string;
}

export function defaultSpringCoilingParams(
  overrides: Partial<SpringCoilingParams> = {},
): SpringCoilingParams {
  return {
    wireDiameter: 1.0,
    coilDiameter: 10.0,
    bodyTurns: 8,
    pitch: 3.0,
    springType: 'compression',
    closeTurnsStart: 1.5,
    closeTurnsEnd: 1.5,
    releaseTurns: 0.5,
    chuckRpm: 30,
    direction: 'cw',
    segmentsPerRev: 48,
    rotaryAxis: 'A',
    linearAxis: 'X',
    decimals: 3,
    programName: 'hjLabs Spring Coiling',
    ...overrides,
  };
}

/**
 * Clamp a decimals value into the range `toFixed()` accepts (0..6). An
 * out-of-range value passed to `toFixed()` throws a RangeError which — reached
 * from a render-phase useMemo — white-screens the panel. Defence-in-depth.
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

/** A single axis letter, upper-cased, falling back to a default if blank/invalid. */
function axisLetter(raw: string, fallback: string): string {
  const c = (raw ?? '').trim().toUpperCase().charAt(0);
  return /[A-Z]/.test(c) ? c : fallback;
}

/**
 * Resolve params into the values the generators actually consume: non-negative
 * dimensions, a body pitch forced to the wire diameter for tight (extension /
 * torsion) springs, a sane segments-per-rev, and clamped decimals. Shared by both
 * generators AND `springInfo` so the panel's derived facts match the G-code.
 */
function resolve(params: SpringCoilingParams) {
  const wireDiameter = Math.max(0.01, params.wireDiameter);
  const coilDiameter = Math.max(0.01, params.coilDiameter);
  const bodyTurns = Math.max(0, params.bodyTurns);
  // Tight springs (extension / torsion) are wound with touching coils throughout,
  // so the body pitch is the wire diameter — the panel disables the pitch slider
  // and the user makes hooks/legs manually. Compression uses the set body pitch
  // (never below the wire diameter, which would force coils to overlap).
  const tight = params.springType !== 'compression';
  const bodyPitch = tight
    ? wireDiameter
    : Math.max(wireDiameter, params.pitch);
  // Closing (dead) turns only apply to compression springs (squared ends); the
  // tight types are closed everywhere already so closing turns are folded away.
  const closeStart = tight ? 0 : Math.max(0, params.closeTurnsStart);
  const closeEnd = tight ? 0 : Math.max(0, params.closeTurnsEnd);
  const closePitch = wireDiameter; // closed turns: coils touch
  const segmentsPerRev = Math.max(4, Math.min(360, Math.floor(params.segmentsPerRev) || 48));
  const chuckRpm = Math.max(0.1, params.chuckRpm);
  const sign = params.direction === 'ccw' ? -1 : 1;
  const releaseTurns = Math.max(0, params.releaseTurns);
  const d = clampDecimals(params.decimals);
  return {
    wireDiameter,
    coilDiameter,
    bodyTurns,
    bodyPitch,
    closeStart,
    closeEnd,
    closePitch,
    segmentsPerRev,
    chuckRpm,
    sign,
    releaseTurns,
    d,
    tight,
    totalTurns: closeStart + bodyTurns + closeEnd,
  };
}

/** Derived, human-readable facts about the planned spring (for the panel). */
export interface SpringInfo {
  /** closeStart + bodyTurns + closeEnd. */
  totalTurns: number;
  /** Body (active) turns. */
  bodyTurns: number;
  /** Closed (dead) turns at each end (start, end). */
  closeStart: number;
  closeEnd: number;
  /** Effective body pitch used (mm) — wire dia for tight springs. */
  bodyPitch: number;
  /** Free length: total axial advance over all turns (mm). */
  freeLength: number;
  /** Approximate wire length consumed (mm): Σ √((πD)² + pitch²) per rev. */
  wireLength: number;
  /** Mean coil diameter (mm). */
  coilDiameter: number;
  /** Whether this is a tight-wound type (extension / torsion). */
  tight: boolean;
}

/**
 * Derived facts for the panel readout. The free length is the total axial advance
 * (Σ pitch over every revolution); the wire length sums each revolution's helical
 * arc length √((π·D)² + pitch²) for the pitch active over that revolution.
 */
export function springInfo(params: SpringCoilingParams): SpringInfo {
  const r = resolve(params);
  const circumference = Math.PI * r.coilDiameter;
  // Per-rev helical arc length for a given pitch.
  const arcPerRev = (pitch: number): number => Math.hypot(circumference, pitch);
  const freeLength =
    r.closeStart * r.closePitch + r.bodyTurns * r.bodyPitch + r.closeEnd * r.closePitch;
  const wireLength =
    r.closeStart * arcPerRev(r.closePitch) +
    r.bodyTurns * arcPerRev(r.bodyPitch) +
    r.closeEnd * arcPerRev(r.closePitch);
  return {
    totalTurns: r.totalTurns,
    bodyTurns: r.bodyTurns,
    closeStart: r.closeStart,
    closeEnd: r.closeEnd,
    bodyPitch: r.bodyPitch,
    freeLength,
    wireLength,
    coilDiameter: r.coilDiameter,
    tight: r.tight,
  };
}

/**
 * One contiguous span of turns wound at a single pitch (a closing-start span, the
 * body span, or a closing-end span). Used internally to walk the whole spring.
 */
interface TurnSpan {
  turns: number;
  pitch: number;
  label: string;
}

/** The ordered spans (start-close → body → end-close), dropping empty spans. */
function turnSpans(r: ReturnType<typeof resolve>): TurnSpan[] {
  const spans: TurnSpan[] = [];
  if (r.closeStart > 0) spans.push({ turns: r.closeStart, pitch: r.closePitch, label: 'close-start' });
  if (r.bodyTurns > 0) spans.push({ turns: r.bodyTurns, pitch: r.bodyPitch, label: 'body' });
  if (r.closeEnd > 0) spans.push({ turns: r.closeEnd, pitch: r.closePitch, label: 'close-end' });
  return spans;
}

/**
 * Walk every subdivision step of the whole spring, calling `step` with the
 * cumulative chuck ANGLE (degrees, signed by direction) and cumulative LINEAR
 * advance (mm) at each subdivision point. The very first call is the start point
 * (angle 0, linear 0); subsequent calls advance by one segment. Pure helper
 * shared by both the machine and helix generators so they trace identical motion.
 */
function walkSpring(
  r: ReturnType<typeof resolve>,
  step: (cumAngleDeg: number, cumLinearMm: number, spanLabel: string, isStart: boolean) => void,
): void {
  let cumAngle = 0; // signed degrees
  let cumLinear = 0; // mm
  const spans = turnSpans(r);
  // Emit the start point once.
  step(cumAngle, cumLinear, spans[0]?.label ?? 'body', true);
  for (const span of spans) {
    const steps = Math.max(1, Math.round(span.turns * r.segmentsPerRev));
    const dAngle = (span.turns * 360 * r.sign) / steps; // signed degrees per step
    const dLinear = (span.turns * span.pitch) / steps; // mm per step
    for (let i = 0; i < steps; i++) {
      cumAngle += dAngle;
      cumLinear += dLinear;
      step(cumAngle, cumLinear, span.label, false);
    }
  }
}

/**
 * Coordinated feed (units/min) for the wind moves. CRITICAL: the rotary axis is
 * emitted in DEGREES and dominates each move's vector (ΔdegΔ ≫ Δmm), and GRBL
 * applies F to the whole vector magnitude — so F effectively governs the CHUCK
 * speed, not the carriage. At `chuckRpm` rev/min the chuck turns chuckRpm × 360
 * deg/min, so that's the feed. The carriage's linear advance (pitch × rpm) then
 * falls out of the coordinated motion automatically.
 *
 * (The previous `chuckRpm × pitch` was a small LINEAR feed; applied to the
 * degree-dominated vector it spun the chuck ~360/pitch times too slow and made
 * the carriage creep at a fraction of a mm/min — which looked like one axis
 * "not moving" and produced absurd ~45-min run times.)
 */
function coilFeed(r: ReturnType<typeof resolve>): number {
  return Math.max(1, r.chuckRpm * 360);
}

/**
 * Produce the 2-axis MACHINE program: coordinated rotary + linear moves that wind
 * the coil. Header (G21/G90/G94) → for each subdivision a single
 * `G1 <ROT><cumAngleDeg> <LIN><cumLinearMm> F<feed>` so the chuck rotation and
 * carriage advance stay synced → footer (M30). The feed is derived from the chuck
 * RPM and body pitch. Pure; never emits "-0.000".
 */
export function generateSpringMachineGcode(params: Partial<SpringCoilingParams> = {}): string {
  const p = defaultSpringCoilingParams(params);
  const r = resolve(p);
  const d = r.d;
  const rot = axisLetter(p.rotaryAxis, 'A');
  let lin = axisLetter(p.linearAxis, 'X');
  if (lin === rot) lin = rot === 'X' ? 'Z' : 'X'; // never collide the two axes
  const o: string[] = [];
  const feedF = fmt(coilFeed(r), d);

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi.hjLabs.in Spring Coiling)');
  o.push(
    `(${p.springType} spring: wire D${fmt(r.wireDiameter, 2)} coil D${fmt(r.coilDiameter, 2)} ` +
      `turns ${fmt(r.totalTurns, 2)} [close ${fmt(r.closeStart, 2)}/${fmt(r.closeEnd, 2)}, ` +
      `body ${fmt(r.bodyTurns, 2)} @ pitch ${fmt(r.bodyPitch, 2)}] ${p.direction})`,
  );
  o.push(`(Rotary axis ${rot} = chuck angle deg; Linear axis ${lin} = axial mm)`);
  o.push('G21'); // mm
  o.push('G90'); // absolute
  o.push('G94'); // units/min feed
  o.push(`G92 ${rot}0 ${lin}0`); // zero both axes at the wire-fixed start
  o.push('M3 S0'); // enable the chuck drive (idle) — start of a wind

  // ---- Coordinated coiling moves ----------------------------------------
  let lastLabel = '';
  let finalAngle = 0; // last cumulative chuck angle (signed deg)
  let finalLinear = 0; // last cumulative carriage position (mm)
  walkSpring(r, (angle, linear, label, isStart) => {
    finalAngle = angle;
    finalLinear = linear;
    if (isStart) return; // the G92 above already placed us at angle 0 / linear 0
    if (label !== lastLabel) {
      o.push(`(${label})`);
      lastLabel = label;
    }
    o.push(`G1 ${rot}${fmt(angle, d)} ${lin}${fmt(linear, d)} F${feedF}`);
  });

  // ---- Release turns: reverse-rotate (carriage HELD) to relieve the wind-up
  // tension so the finished spring slips off the mandrel. Rotation is OPPOSITE
  // the coil direction (−sign); the linear axis stays fixed at finalLinear.
  if (r.releaseTurns > 0) {
    o.push('(release turns — reverse-rotate to relieve tension for removal)');
    const steps = Math.max(1, Math.round(r.releaseTurns * r.segmentsPerRev));
    const dAngle = -(r.releaseTurns * 360 * r.sign) / steps;
    let a = finalAngle;
    for (let i = 0; i < steps; i++) {
      a += dAngle;
      o.push(`G1 ${rot}${fmt(a, d)} ${lin}${fmt(finalLinear, d)} F${feedF}`);
    }
  }

  // ---- Footer -----------------------------------------------------------
  o.push('M5'); // stop the chuck drive
  o.push('M30');

  return o.join('\n') + '\n';
}

/**
 * Pure helper returning the wound coil's helix POINTS for the 3D VISUALIZATION
 * only — NOT a program and never streamed. Each point is the centre line of the
 * wire as it lies on the finished spring: the spring AXIS runs along +X (the coil
 * grows left→right), the coil circle lies in the Y–Z plane, and the helix is
 * lifted by R (= coilDiameter/2) so the bottom of the coil rests on the bed
 * (Z=0). For each subdivision θ = cumulative chuck angle and axial = cumulative
 * linear advance, giving (axial, R·cosθ, R + R·sinθ). The points trace the SAME
 * coordinated rotary+linear motion the machine program emits, so the drawn
 * workpiece matches what the 2-axis program actually winds.
 */
export function springHelixPoints(
  params: Partial<SpringCoilingParams> = {},
): [number, number, number][] {
  const p = defaultSpringCoilingParams(params);
  const r = resolve(p);
  const radius = r.coilDiameter / 2;
  const pts: [number, number, number][] = [];
  walkSpring(r, (angleDeg, axial) => {
    const theta = (angleDeg * Math.PI) / 180;
    pts.push([axial, radius * Math.cos(theta), radius + radius * Math.sin(theta)]);
  });
  return pts;
}
