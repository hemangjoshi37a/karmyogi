// 3-axis welding G-code generator — UI-independent (pure TS, no React/DOM).
//
// Machine model: a 3-axis GRBL gantry carries a welding torch. The controller's
// spindle on/off output is repurposed as the WELDER / ARC on-off — turning the
// "spindle" on (M3 S<power>, or plain M3) strikes/energises the arc; M5 stops
// it. Optional gas pre-flow / post-flow dwells (G4 P<seconds>) bracket the arc
// so shielding gas is flowing before the arc strikes and keeps flowing after it
// stops.
//
// The operator defines one or more weld OBJECTS, each either:
//   • a LINE  — a true 3D segment from start {x,y,z} to end {x,y,z} (any angle
//     in space), or
//   • a CIRCLE — a full 360° perimeter traced about a centre {x,y,z} with a
//     radius, in the bed (XY) plane (circle normal = world +Z).
//
// Each object carries its OWN motion + weave parameters: a travel/peripheral
// feed (mm/min along the path), a weave pattern, a weave amplitude (mm), and a
// separate PATTERN SPEED (mm/min). The weave density is governed by the RATIO
// of pattern-speed to travel-speed: as the torch walks arc-length s along the
// path at travelSpeed, the weave phase advances at patternSpeed, so the number
// of oscillation cycles per unit length is proportional to
// patternSpeed/travelSpeed. A higher pattern speed (relative to travel) packs
// more cycles per mm → a DENSER weave; lower → a stretched/scattered weave.
//
// The woven path is emitted as G1 feed moves at the travel/peripheral feed.
// Safety matches the rest of the CAM core: G21/G90/G94/G17 header, a guaranteed
// safe-Z retract before any XY travel and at program end, M30 footer, and number
// formatting that never emits "-0.000".

/** Transverse oscillation pattern superimposed along the weld path. */
export enum WeavePattern {
  /** No weave — a single straight bead from start to end / plain perimeter. */
  Straight = 'Straight',
  /** Triangular zigzag: linear ramps side-to-side across the bead. */
  Zigzag = 'Zigzag',
  /** Circular loops: combines two perpendicular oscillations to loop the axis. */
  Circular = 'Circular',
  /** Smooth sinusoidal weave. */
  Sine = 'Sine',
}

/** A point in 3D machine work coordinates (mm). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** Common per-object weave fields shared by both object kinds. */
export interface WeaveSpec {
  /** Transverse weave pattern for this object. */
  pattern: WeavePattern;
  /** Weave half-width (mm). Bead width ≈ 2× amplitude. */
  amplitude: number;
  /**
   * Pattern speed (mm/min) — the SECOND, independent speed that sets how fast
   * the weave oscillates. Density = cycles-per-mm ∝ patternSpeed / travelSpeed:
   * one full weave cycle is completed per (travelSpeed / patternSpeed) mm of
   * forward travel. Higher pattern speed ⇒ denser weave.
   */
  patternSpeed: number;
}

/** A true 3D weld line (start → end, any angle in space). */
export interface WeldLine extends WeaveSpec {
  id: string;
  kind: 'line';
  start: Vec3;
  end: Vec3;
  /** Feed (mm/min) the torch travels ALONG start→end for this line. */
  travelFeed: number;
}

/** A full-perimeter circular weld (centre + radius, traced in the XY plane). */
export interface WeldCircle extends WeaveSpec {
  id: string;
  kind: 'circle';
  center: Vec3;
  radius: number;
  /** Feed (mm/min) the torch travels AROUND the perimeter for this circle. */
  peripheralFeed: number;
}

/** A single weld object — a discriminated union over kind. */
export type WeldObject = WeldLine | WeldCircle;

let idSeq = 0;
/** Generate a reasonably-unique id for a fresh object. */
export function newWeldId(): string {
  idSeq += 1;
  return `w${Date.now().toString(36)}_${idSeq.toString(36)}`;
}

/** Defaults for a fresh weld LINE. */
export function defaultWeldLine(overrides: Partial<WeldLine> = {}): WeldLine {
  return {
    id: newWeldId(),
    kind: 'line',
    start: { x: 0, y: 0, z: 0 },
    end: { x: 50, y: 0, z: 0 },
    travelFeed: 300,
    pattern: WeavePattern.Zigzag,
    amplitude: 2.0,
    patternSpeed: 600,
    ...overrides,
  };
}

/** Defaults for a fresh weld CIRCLE. */
export function defaultWeldCircle(overrides: Partial<WeldCircle> = {}): WeldCircle {
  return {
    id: newWeldId(),
    kind: 'circle',
    center: { x: 0, y: 0, z: 0 },
    radius: 20,
    peripheralFeed: 300,
    pattern: WeavePattern.Zigzag,
    amplitude: 2.0,
    patternSpeed: 600,
    ...overrides,
  };
}

/** Global welding generator policy (everything NOT per-object). */
export interface WeldingParams {
  metric: boolean; // G21 (mm) vs G20 (inch)

  /** Guaranteed retract height before any XY travel and at program end (mm). */
  safeZ: number;
  /** Plunge feed used to lower from safe-Z to the weld Z (mm/min). */
  plungeFeed: number;
  /** Sampling resolution: emitted points per weave cycle (smoother curves). */
  segmentsPerCycle: number;

  /** Welder/arc output. */
  useArc: boolean; // emit M3/M5 around each object
  /** Arc power emitted as the S word (M3 S<power>); ≤0 ⇒ plain M3. */
  arcPower: number;
  /** Gas pre-flow dwell before the arc strikes (s); 0 = none. */
  preFlowSeconds: number;
  /** Gas post-flow dwell after the arc stops (s); 0 = none. */
  postFlowSeconds: number;

  decimals: number;
  programName: string;
}

export function defaultWeldingParams(overrides: Partial<WeldingParams> = {}): WeldingParams {
  return {
    metric: true,
    safeZ: 5.0,
    plungeFeed: 150.0,
    segmentsPerCycle: 16,
    useArc: true,
    arcPower: 0.0,
    preFlowSeconds: 0.5,
    postFlowSeconds: 1.0,
    decimals: 3,
    programName: 'hjLabs Welding',
    ...overrides,
  };
}

// ─────────────────────────── 3D vector helpers ───────────────────────────

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len3 = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
function normalize(v: Vec3): Vec3 {
  const l = len3(v);
  if (l < 1e-12) return { x: 0, y: 0, z: 0 };
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * Build a stable orthonormal frame {tangent, transverse, binormal} for a path
 * tangent. `transverse = normalize(cross(tangent, worldUp))` with
 * worldUp = (0,0,1); if the tangent is ~parallel to worldUp we fall back to
 * worldX = (1,0,0) so the frame never degenerates. `binormal =
 * cross(tangent, transverse)` completes a right-handed basis. Used so the weave
 * offset is always perpendicular to the seam in 3D.
 */
export function pathFrame(tangent: Vec3): { transverse: Vec3; binormal: Vec3 } {
  const worldUp: Vec3 = { x: 0, y: 0, z: 1 };
  let transverse = cross(tangent, worldUp);
  if (len3(transverse) < 1e-6) {
    // Tangent ~parallel to world up — fall back to world X.
    transverse = cross(tangent, { x: 1, y: 0, z: 0 });
  }
  transverse = normalize(transverse);
  const binormal = normalize(cross(tangent, transverse));
  return { transverse, binormal };
}

// ─────────────────────────── weave offsets ───────────────────────────

/** Triangle wave in [-1, 1], period 2π, value 0 at phase 0, peaking at π/2. */
function tri(ph: number): number {
  let p = ph % (2 * Math.PI);
  if (p < 0) p += 2 * Math.PI;
  const u = p / (2 * Math.PI);
  if (u < 0.25) return u / 0.25;
  if (u < 0.75) return 1 - (u - 0.25) / 0.25;
  return -1 + (u - 0.75) / 0.25;
}

/**
 * Compute the weave offset for a given phase, returned as scalar multipliers of
 * the {transverse, binormal} frame vectors (already scaled by amplitude).
 *  - Straight : no offset.
 *  - Sine     : transverse = amp·sin(phase).
 *  - Zigzag   : transverse = amp·tri(phase).
 *  - Circular : transverse = amp·cos(phase), binormal = amp·sin(phase) → the
 *               torch loops around the seam axis (a helix when advancing).
 */
function weaveOffset(
  pattern: WeavePattern,
  amp: number,
  phase: number,
): { transverse: number; binormal: number } {
  switch (pattern) {
    case WeavePattern.Sine:
      return { transverse: amp * Math.sin(phase), binormal: 0 };
    case WeavePattern.Zigzag:
      return { transverse: amp * tri(phase), binormal: 0 };
    case WeavePattern.Circular:
      return { transverse: amp * Math.cos(phase), binormal: amp * Math.sin(phase) };
    case WeavePattern.Straight:
    default:
      return { transverse: 0, binormal: 0 };
  }
}

/**
 * Number of weave cycles completed over a path of total length `L`. The phase
 * advances at `patternSpeed` while the torch travels at `travelSpeed`, so one
 * full cycle (2π) is completed per (travelSpeed / patternSpeed) mm of travel,
 * i.e. cyclesPerMm = patternSpeed / travelSpeed. Density ∝ patternSpeed/travel.
 */
function cyclesOverLength(L: number, travelSpeed: number, patternSpeed: number): number {
  if (travelSpeed <= 1e-9 || patternSpeed <= 1e-9) return 0;
  const cyclesPerMm = patternSpeed / travelSpeed;
  return cyclesPerMm * L;
}

/** A sampled woven path point (absolute mm, 3D). Used internally + previews. */
export type WeldPathPoint = Vec3;

// ─────────────────────────── line sampling ───────────────────────────

/** Straight-line length (mm) of a weld line. */
export function lineLength(line: WeldLine): number {
  return len3(sub(line.end, line.start));
}

/**
 * Sample the woven torch path for a 3D weld line.
 *
 * Walk arc-length s ∈ [0, L] along the seam. The phase advances so that the
 * total number of cycles over L equals (patternSpeed/travelSpeed)·L, giving the
 * density-via-two-speeds behaviour. At each s the point is:
 *   P(s) = A + s·t̂ + offT·transverse + offB·binormal
 * where t̂ is the unit tangent and {transverse, binormal} is the stable frame.
 */
export function sampleLinePath(line: WeldLine, params: WeldingParams): WeldPathPoint[] {
  const A = line.start;
  const L = lineLength(line);
  if (L < 1e-9) return [{ ...A }];

  const tangent = normalize(sub(line.end, line.start));

  if (
    line.pattern === WeavePattern.Straight ||
    line.amplitude <= 0 ||
    line.patternSpeed <= 1e-9 ||
    line.travelFeed <= 1e-9
  ) {
    return [{ ...line.start }, { ...line.end }];
  }

  const { transverse, binormal } = pathFrame(tangent);
  const cycles = cyclesOverLength(L, line.travelFeed, line.patternSpeed);
  const k = (2 * Math.PI * cycles) / L; // phase advance per mm
  const spc = Math.max(2, Math.floor(params.segmentsPerCycle));
  // total samples ≈ cycles · segmentsPerCycle, at least spc, capped for sanity.
  const nSamples = Math.min(20000, Math.max(spc, Math.ceil(cycles * spc)));
  const amp = line.amplitude;

  const pts: WeldPathPoint[] = [];
  for (let i = 0; i <= nSamples; i++) {
    const s = (L * i) / nSamples;
    const phase = k * s;
    const off = weaveOffset(line.pattern, amp, phase);
    pts.push({
      x: A.x + s * tangent.x + off.transverse * transverse.x + off.binormal * binormal.x,
      y: A.y + s * tangent.y + off.transverse * transverse.y + off.binormal * binormal.y,
      z: A.z + s * tangent.z + off.transverse * transverse.z + off.binormal * binormal.z,
    });
  }
  // Always finish exactly on the seam end with no weave offset.
  const last = pts[pts.length - 1];
  if (!last || len3(sub(last, line.end)) > 1e-6) pts.push({ ...line.end });
  return pts;
}

// ─────────────────────────── circle sampling ───────────────────────────

/** Perimeter length (mm) of a weld circle. */
export function circleLength(circle: WeldCircle): number {
  return 2 * Math.PI * Math.abs(circle.radius);
}

/**
 * Sample the woven torch path for a circular weld. The base perimeter is traced
 * in the XY plane about the centre C with radius R (circle normal = world +Z):
 *   base(θ) = C + R·(cosθ, sinθ, 0).
 * The local tangent is (−sinθ, cosθ, 0); the stable frame gives `transverse`
 * (radial, in-plane) and `binormal` (≈ ±world Z). The weave offset is applied
 * along that frame exactly as for a line, so Zigzag/Sine oscillate radially
 * in/out and Circular loops around the perimeter axis.
 *
 * Phase advances with arc-length s = R·θ at the same density law
 * (cycles over the full perimeter = (patternSpeed/peripheralFeed)·L). The loop
 * is closed: the last point returns to the perimeter start.
 */
export function sampleCirclePath(circle: WeldCircle, params: WeldingParams): WeldPathPoint[] {
  const C = circle.center;
  const R = Math.abs(circle.radius);
  if (R < 1e-9) return [{ ...C }];

  const L = circleLength(circle);
  const spc = Math.max(2, Math.floor(params.segmentsPerCycle));

  const weaving =
    circle.pattern !== WeavePattern.Straight &&
    circle.amplitude > 0 &&
    circle.patternSpeed > 1e-9 &&
    circle.peripheralFeed > 1e-9;

  const cycles = weaving ? cyclesOverLength(L, circle.peripheralFeed, circle.patternSpeed) : 0;
  // Enough samples to resolve both the circle itself and the weave.
  const baseSamples = Math.max(spc, 48);
  const nSamples = weaving
    ? Math.min(40000, Math.max(baseSamples, Math.ceil(cycles * spc)))
    : baseSamples;
  const amp = circle.amplitude;
  const k = L > 1e-9 ? (2 * Math.PI * cycles) / L : 0; // phase advance per mm

  const pts: WeldPathPoint[] = [];
  for (let i = 0; i <= nSamples; i++) {
    const theta = (2 * Math.PI * i) / nSamples;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const bx = C.x + R * cos;
    const by = C.y + R * sin;
    const bz = C.z;
    if (!weaving) {
      pts.push({ x: bx, y: by, z: bz });
      continue;
    }
    const tangent: Vec3 = { x: -sin, y: cos, z: 0 };
    const { transverse, binormal } = pathFrame(tangent);
    const s = R * theta;
    const off = weaveOffset(circle.pattern, amp, k * s);
    pts.push({
      x: bx + off.transverse * transverse.x + off.binormal * binormal.x,
      y: by + off.transverse * transverse.y + off.binormal * binormal.y,
      z: bz + off.transverse * transverse.z + off.binormal * binormal.z,
    });
  }
  return pts;
}

/** The weld Z standoff (start point Z) used when lowering for an object. */
export function weldZ(obj: WeldObject): number {
  return obj.kind === 'line' ? obj.start.z : obj.center.z;
}

/** The travel/peripheral feed for an object. */
export function objectFeed(obj: WeldObject): number {
  return obj.kind === 'line' ? obj.travelFeed : obj.peripheralFeed;
}

/** Centreline length (mm) of an object (seam length / full perimeter). */
export function objectLength(obj: WeldObject): number {
  return obj.kind === 'line' ? lineLength(obj) : circleLength(obj);
}

/** Sample the woven path for any object. */
export function sampleObjectPath(obj: WeldObject, params: WeldingParams): WeldPathPoint[] {
  return obj.kind === 'line' ? sampleLinePath(obj, params) : sampleCirclePath(obj, params);
}

/** Is this object degenerate (zero-length line / zero-radius circle)? */
export function isDegenerate(obj: WeldObject): boolean {
  return obj.kind === 'line' ? lineLength(obj) < 1e-9 : Math.abs(obj.radius) < 1e-9;
}

// ─────────────────────────── G-code ───────────────────────────

/**
 * Clamp a decimals value into the range `toFixed()` accepts (0..6 here, well
 * within the spec's 0..100). An out-of-range value reaching `toFixed()` throws
 * a RangeError; when that happens inside a render-phase useMemo it white-screens
 * the panel. Clamping here is defence-in-depth alongside the UI input/load guards.
 */
function clampDecimals(decimals: number): number {
  if (!Number.isFinite(decimals)) return 3;
  return Math.min(6, Math.max(0, Math.floor(decimals)));
}

/** Formatted number, never "-0.000" — mirrors the emitter's fmt(). */
function fmt(value: number, decimals: number): string {
  const d = clampDecimals(decimals);
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(d);
}

/**
 * Produce a complete, safe G-code program for the given weld objects.
 *
 * Per-object motion sequence (safe by construction):
 *   1. Retract to safe-Z (G0 Z<safeZ>) — guaranteed before any XY travel.
 *   2. Rapid (G0) to the path START (line start / perimeter start) at safe-Z.
 *   3. Plunge (G1 Z<weldZ> F<plungeFeed>) down to the weld standoff.
 *   4. Gas PRE-FLOW dwell (G4 P<pre>), then arc ON (M3 S<power> / M3).
 *   5. Weave (G1 F<feed>) through every sampled point to the end / around loop.
 *   6. Arc OFF (M5), then gas POST-FLOW dwell (G4 P<post>).
 *   7. Retract to safe-Z (G0 Z<safeZ>).
 * After all objects: retract to safe-Z, M5 (belt-and-braces), M30.
 */
export function generateWelding(
  objects: WeldObject[],
  params: Partial<WeldingParams> = {},
): string {
  const p = defaultWeldingParams(params);
  const d = p.decimals;
  const o: string[] = [];
  const arcOn = p.arcPower > 0 ? `M3 S${fmt(p.arcPower, d)}` : 'M3';

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi.hjLabs.in Welding)');
  o.push(p.metric ? 'G21' : 'G20'); // units
  o.push('G90'); // absolute distance
  o.push('G94'); // feed per minute
  o.push('G17'); // XY plane
  o.push('M5'); // arc off to start
  o.push(`G0 Z${fmt(p.safeZ, d)}`); // safe height before any XY travel

  // ---- Per-object sequences ---------------------------------------------
  let n = 0;
  for (const obj of objects) {
    ++n;
    if (isDegenerate(obj)) {
      o.push(
        obj.kind === 'line'
          ? `(Object ${n}: skipped — zero-length line)`
          : `(Object ${n}: skipped — zero-radius circle)`,
      );
      continue;
    }
    const path = sampleObjectPath(obj, p);
    const z = weldZ(obj);
    const feed = objectFeed(obj);
    const start = path[0];
    o.push(
      obj.kind === 'line'
        ? `(Object ${n}: line ${obj.pattern} weave, ${fmt(lineLength(obj), d)}mm)`
        : `(Object ${n}: circle r${fmt(Math.abs(obj.radius), d)} ${obj.pattern} weave, ${fmt(circleLength(obj), d)}mm)`,
    );

    o.push(`G0 Z${fmt(p.safeZ, d)}`); // ensure raised
    o.push(`G0 X${fmt(start.x, d)} Y${fmt(start.y, d)}`); // rapid to start at safe-Z
    o.push(`G1 Z${fmt(z, d)} F${fmt(p.plungeFeed, d)}`); // lower to weld Z

    if (p.useArc) {
      if (p.preFlowSeconds > 0) o.push(`G4 P${fmt(p.preFlowSeconds, d)}`); // gas pre-flow
      o.push(arcOn); // strike arc
    }

    // Weave through the path. The first point coincides with current XY/Z, so
    // begin from index 1. Emit Z whenever it changes (true 3D moves). The first
    // feed move carries the feed word.
    let feedWritten = false;
    let prevZ = start.z;
    for (let i = 1; i < path.length; ++i) {
      const pt = path[i];
      const feedWord = feedWritten ? '' : ` F${fmt(feed, d)}`;
      const zChanged = Math.abs(pt.z - prevZ) > 0.5 * Math.pow(10, -d);
      const zWord = zChanged ? ` Z${fmt(pt.z, d)}` : '';
      o.push(`G1 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}${zWord}${feedWord}`);
      feedWritten = true;
      prevZ = pt.z;
    }

    if (p.useArc) {
      o.push('M5'); // stop arc
      if (p.postFlowSeconds > 0) o.push(`G4 P${fmt(p.postFlowSeconds, d)}`); // gas post-flow
    }
    o.push(`G0 Z${fmt(p.safeZ, d)}`); // retract
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(p.safeZ, d)}`);
  o.push('M5');
  o.push('M30');

  return o.join('\n') + '\n';
}

/** Total weld (centreline) length across all objects (mm). */
export function totalWeldLength(objects: WeldObject[]): number {
  let total = 0;
  for (const obj of objects) total += objectLength(obj);
  return total;
}

/** Count of line objects (for the status strip). */
export function countLines(objects: WeldObject[]): number {
  let n = 0;
  for (const obj of objects) if (obj.kind === 'line') n += 1;
  return n;
}

/**
 * Total welded arc-length (mm) of the SAMPLED woven path across all objects —
 * i.e. the real distance the torch travels (longer than the centreline when a
 * weave is applied). Skips degenerate objects.
 */
export function totalWovenLength(objects: WeldObject[], params: Partial<WeldingParams> = {}): number {
  const p = defaultWeldingParams(params);
  let total = 0;
  for (const obj of objects) {
    if (isDegenerate(obj)) continue;
    const path = sampleObjectPath(obj, p);
    for (let i = 1; i < path.length; i++) total += len3(sub(path[i], path[i - 1]));
  }
  return total;
}

/**
 * Rough cycle-time estimate (seconds) for a welding run. Sums, per non-degenerate
 * object: the woven-path travel time (sampled arc-length ÷ travel/peripheral
 * feed) plus the gas pre/post-flow dwells (when the arc is enabled). Rapids and
 * the plunge are ignored (small vs the weave travel); the result is a
 * conservative estimate the operator can use to gauge run length.
 */
export function estimateWeldingSeconds(
  objects: WeldObject[],
  params: Partial<WeldingParams> = {},
): number {
  const p = defaultWeldingParams(params);
  let seconds = 0;
  for (const obj of objects) {
    if (isDegenerate(obj)) continue;
    const path = sampleObjectPath(obj, p);
    let len = 0;
    for (let i = 1; i < path.length; i++) len += len3(sub(path[i], path[i - 1]));
    const feed = Math.max(0, objectFeed(obj)); // mm/min
    if (feed > 1e-9) seconds += (len / feed) * 60;
    if (p.useArc) {
      seconds += Math.max(0, p.preFlowSeconds);
      seconds += Math.max(0, p.postFlowSeconds);
    }
  }
  return seconds;
}
