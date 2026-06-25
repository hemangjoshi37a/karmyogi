// Glue-dispense G-code generator — UI-independent.
//
// Machine model: a glue dispenser is mounted at the head and is wired to the
// controller's spindle on/off output. Turning the "spindle" on (M3 S..) starts
// the dispenser; M5 stops it. The user draws simple shapes — line, triangle,
// circle, rectangle — on the bed; the machine traces each shape's outline with
// the dispenser running, lifting Z to travel between shapes (exactly like the
// pen-plot / soldering modes: Z is travel-up vs dispense-down only, XY traces
// the shape).
//
// Safety behaviour matches the rest of the CAM core: G21/G90/G94/G17 header, a
// guaranteed safe-Z retract before any XY travel and at program end, number
// formatting that never emits "-0.000", and Z never moving in the same line as
// XY.
//
// Pure TypeScript: no React/DOM imports.

import { Polyline, makeCircle, makeRect, pt, type Point } from './geometry';
import { insetRings } from './offset';

// ---- Shape model ----------------------------------------------------------

/**
 * Per-shape OVERRIDES that any shape may carry (G4 + G1-area). All optional so
 * existing shapes / saved docs stay valid.
 * - `dispenseZ` (G4): a per-shape touch-down Z, overriding the global one — for
 *   beads on a stepped/uneven workpiece (mirrors the soldering per-point Touch-Z).
 * - `fill` (G1 area): for CLOSED shapes (triangle / circle / rect), flood the
 *   interior with concentric offset rings (a "bead area" / potting fill) instead
 *   of tracing only the outline.
 */
export interface ShapeOverrides {
  /** G4 — per-shape touch-down Z (mm, absolute). Overrides GlueParams.dispenseZ. */
  dispenseZ?: number;
  /** G1 — flood a closed shape's interior with concentric rings (area dispense). */
  fill?: boolean;
}

/** A single glue DOT (G1): touch down at (x,y), dwell, lift. Volume-controlled. */
export interface DotShape extends ShapeOverrides {
  kind: 'dot';
  x: number;
  y: number;
}

/** A straight glue bead from (x1,y1) to (x2,y2). Open trajectory. */
export interface LineShape extends ShapeOverrides {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A glue bead tracing the closed outline through three vertices. */
export interface TriangleShape extends ShapeOverrides {
  kind: 'triangle';
  points: [Point, Point, Point];
}

/** A glue bead tracing a circle of radius r centred at (cx,cy). */
export interface CircleShape extends ShapeOverrides {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

/** A glue bead tracing the closed outline of a rectangle (corner + size). */
export interface RectShape extends ShapeOverrides {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GlueShape = DotShape | LineShape | TriangleShape | CircleShape | RectShape;

/** True for the closed shapes that support an area (concentric-ring) fill. */
export function isClosedShape(s: GlueShape): boolean {
  return s.kind === 'triangle' || s.kind === 'circle' || s.kind === 'rect';
}

/** Generator policy for a glue-dispense program. */
export interface GlueParams {
  metric: boolean; // G21 vs G20
  /** Raised travel/retract height between shapes (mm, absolute). */
  travelZ: number;
  /** Touch-down height where glue is dispensed (bead height, mm, absolute). */
  dispenseZ: number;
  /** Trace feed rate while dispensing (mm/min). */
  feed: number;
  /** Plunge feed used when lowering to the dispense height (mm/min). */
  plungeFeed: number;
  /** Spindle S value driving the dispenser. */
  dispenseRate: number;
  /** Dwell (ms) after the dispenser turns on, before tracing, so glue starts cleanly. 0 = none. */
  settleMs: number;
  /** Dwell (ms) after tracing, before the dispenser stops, so the bead ends cleanly. 0 = none. */
  postDwellMs: number;
  /**
   * G2 — LEAD-IN length (mm): for OPEN beads (line), start the dispenser this far
   * BEFORE the bead start (along the bead direction) so the glue is already
   * flowing by the first real point (anti-starve). 0 = start exactly at the
   * bead. Ignored for closed shapes (their start = end, so no lead is needed).
   */
  leadInMm: number;
  /**
   * G2 — LEAD-OUT length (mm): keep tracing this far PAST the bead end (along the
   * exit direction) AFTER the dispenser stops, so the residual pressure tail is
   * laid down off the joint instead of blobbing at the end (anti-tail). 0 = stop
   * at the bead end.
   */
  leadOutMm: number;
  /**
   * G3 — VOLUME MODEL, dot: target glue volume per DOT (mm³). With a dispenser
   * output of `dispenseRate` volume-units/s this drives the per-dot ON dwell
   * (= volPerDot / dispenseRate). 0 = use `dotMs` directly instead.
   */
  volPerDotMm3: number;
  /**
   * G3 — VOLUME MODEL, bead: target glue cross-section per mm of bead (mm³/mm =
   * mm² section). Used only for the cycle-time / volume ESTIMATE (a traced bead's
   * flow is feed-rate-governed, not dwell-governed). 0 = no bead-volume estimate.
   */
  volPerMmMm3: number;
  /** Fallback DOT ON dwell (ms) when no volume model is set (volPerDotMm3 = 0). */
  dotMs: number;
  decimals: number;
  programName: string;
}

export function defaultGlueParams(overrides: Partial<GlueParams> = {}): GlueParams {
  return {
    metric: true,
    travelZ: 5.0,
    dispenseZ: -0.5,
    feed: 600.0,
    plungeFeed: 120.0,
    dispenseRate: 1000.0,
    settleMs: 150,
    postDwellMs: 100,
    leadInMm: 0,
    leadOutMm: 0,
    volPerDotMm3: 0,
    volPerMmMm3: 0,
    dotMs: 200,
    decimals: 3,
    programName: 'hjLabs Glue Dispense',
    ...overrides,
  };
}

// ---- Shape → trajectory ----------------------------------------------------

/**
 * Convert a shape into its `Polyline` trajectory. Lines are open; triangles and
 * rectangles are closed outlines; circles are flattened via `makeCircle`.
 */
export function shapeToPolyline(shape: GlueShape): Polyline {
  switch (shape.kind) {
    case 'dot': {
      // A dot is a single point — represented as a degenerate one-vertex open
      // polyline so callers (e.g. the SVG preview) can render it as a marker.
      const pl = new Polyline();
      pl.add(pt(shape.x, shape.y));
      pl.closed = false;
      return pl;
    }
    case 'line': {
      const pl = new Polyline();
      pl.add(pt(shape.x1, shape.y1));
      pl.add(pt(shape.x2, shape.y2));
      pl.closed = false;
      return pl;
    }
    case 'triangle': {
      const pl = new Polyline();
      for (const p of shape.points) pl.add(pt(p.x, p.y));
      pl.closed = true;
      return pl;
    }
    case 'circle':
      return makeCircle(pt(shape.cx, shape.cy), shape.r);
    case 'rect':
      return makeRect(pt(shape.x, shape.y), shape.w, shape.h);
  }
}

/**
 * The ordered list of XY points the head should trace for a shape, including
 * the closing return to the start vertex for closed shapes.
 */
function trajectoryPoints(shape: GlueShape): Point[] {
  const pl = shapeToPolyline(shape);
  const pts = pl.points.map((p) => ({ x: p.x, y: p.y }));
  if (pl.closed && pts.length > 1) pts.push({ x: pts[0].x, y: pts[0].y });
  return pts;
}

// ---- Formatting ------------------------------------------------------------

/** Formatted number, never "-0.000" — mirrors the soldering/emitter fmt(). */
function fmt(value: number, decimals: number): string {
  // Defensive clamp: a corrupt/loaded `decimals` (negative or >100) would make
  // Number.toFixed throw a RangeError inside the render-phase useMemo and
  // white-screen the panel. The UI offers 0–6; clamp to an integer in [0,8].
  const d = Number.isFinite(decimals) ? Math.max(0, Math.min(8, Math.floor(decimals))) : 3;
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(d);
}

/** Convert a dwell in milliseconds to a G4 P<seconds> word. */
function dwellSeconds(ms: number, decimals: number): string {
  return fmt(Math.max(0, ms) / 1000, decimals);
}

// ---- Volume model (G3) -----------------------------------------------------

/**
 * The DOT dispense ON-time (ms) for one dot. When a volume target is set
 * (`volPerDotMm3` > 0) it's converted via the dispenser output rate
 * (`dispenseRate` volume-units/s, here treated as mm³/s) to a dwell; otherwise
 * the explicit `dotMs` is used. Pure; always ≥ 0.
 */
export function dotDwellMs(p: GlueParams): number {
  if (p.volPerDotMm3 > 0 && p.dispenseRate > 0) {
    return Math.max(0, (p.volPerDotMm3 / p.dispenseRate) * 1000);
  }
  return Math.max(0, p.dotMs);
}

/**
 * G3 — estimate the total glue VOLUME (mm³) a program will lay down: every dot
 * contributes `volPerDotMm3`, every traced bead contributes its trajectory
 * length × `volPerMmMm3` (the per-mm cross-section). Area fills count their full
 * ring length. Returns 0 when no volume model is configured. Pure.
 */
export function estimateGlueVolume(shapes: GlueShape[], params: Partial<GlueParams> = {}): number {
  const p = defaultGlueParams(params);
  let vol = 0;
  for (const s of shapes) {
    if (s.kind === 'dot') {
      vol += Math.max(0, p.volPerDotMm3);
      continue;
    }
    if (p.volPerMmMm3 <= 0) continue;
    for (const poly of shapeTracePolylines(s)) vol += polylineLength(poly) * p.volPerMmMm3;
  }
  return vol;
}

/** Summed segment length of an (already-flattened) polyline trajectory. */
function polylineLength(pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

/**
 * The full set of trace trajectories for a NON-dot shape: just the outline by
 * default, or the outline PLUS concentric inset rings when the shape is closed
 * and its `fill` flag is set (G1 area dispense). Each trajectory is a list of XY
 * points (closed shapes include the closing return to the start). The fill rings
 * are spaced by the bead width derived from the dispense rate is NOT available
 * here, so a fixed sensible stepover is used (see `fillStep`).
 */
function shapeTracePolylines(shape: GlueShape): Point[][] {
  if (shape.kind === 'dot') return [];
  const out: Point[][] = [trajectoryPoints(shape)];
  if (shape.fill && isClosedShape(shape)) {
    const boundary = shapeToPolyline(shape);
    const step = fillStep(shape);
    for (const ring of insetRings(boundary, step, step)) {
      const pts = ring.points.map((q) => ({ x: q.x, y: q.y }));
      if (pts.length > 1) {
        pts.push({ x: pts[0].x, y: pts[0].y }); // close each ring
        out.push(pts);
      }
    }
  }
  return out;
}

/** Concentric-fill ring spacing (mm) for a closed shape: ~8% of its min span,
 * clamped to a sensible bead-width range so fills aren't absurdly dense/sparse. */
function fillStep(shape: GlueShape): number {
  const pl = shapeToPolyline(shape);
  const bb = pl.bounds();
  const span = Math.max(0.1, Math.min(bb.width(), bb.height()));
  return Math.min(8, Math.max(1, span * 0.08));
}

// ---- Generator -------------------------------------------------------------

/**
 * A point `dist` mm beyond `from`, going AWAY from `to` (i.e. along the ray
 * to→from, extended past `from`). Used for lead-in (a point before a bead's
 * start, away from its second point) and lead-out (a point past a bead's end,
 * away from its previous point). Returns `from` for a zero `dist` / degenerate
 * direction.
 */
function extend(from: Point, to: Point, dist: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9 || dist <= 0) return { x: from.x, y: from.y };
  return { x: from.x - (dx / len) * dist, y: from.y - (dy / len) * dist };
}

/**
 * Produce a complete, safe glue-dispense G-code program for the given shapes.
 *
 * Per bead shape: rapid XY to the (optional lead-in) start at travelZ → lower to
 * the dispense Z (per-shape override, else global; plunge feed) → dispenser ON
 * (M3 S<rate>) + optional settle dwell → feed along the trajectory (plus any
 * area-fill rings) at the dispense feed → optional post-dwell → dispenser OFF
 * (M5) → optional lead-out tail → retract to travelZ. A DOT shape touches down,
 * dwells for the volume/explicit time, then retracts. Z and XY never change
 * within the same move; a guaranteed travel-Z retract precedes every XY move.
 */
export function generateGlue(shapes: GlueShape[], params: Partial<GlueParams> = {}): string {
  const p = defaultGlueParams(params);
  const d = p.decimals;
  const o: string[] = [];

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi.hjLabs.in Glue Dispense)');
  o.push(p.metric ? 'G21' : 'G20');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5'); // dispenser off to start
  o.push(`G0 Z${fmt(p.travelZ, d)}`); // safe height first

  // ---- Per-shape trajectories ------------------------------------------
  let n = 0;
  for (const shape of shapes) {
    ++n;
    // G4 — per-shape touch-down Z overrides the global dispense height.
    const dispZ =
      typeof shape.dispenseZ === 'number' && Number.isFinite(shape.dispenseZ)
        ? shape.dispenseZ
        : p.dispenseZ;

    // ── DOT (G1): touch down, dwell (volume- or time-controlled), lift. ──
    if (shape.kind === 'dot') {
      o.push(`(Shape ${n}: dot)`);
      o.push(`G0 Z${fmt(p.travelZ, d)}`); // ensure raised before XY travel
      o.push(`G0 X${fmt(shape.x, d)} Y${fmt(shape.y, d)}`); // travel above the dot
      o.push(`G1 Z${fmt(dispZ, d)} F${fmt(p.plungeFeed, d)}`); // lower to dot height
      o.push(`M3 S${fmt(p.dispenseRate, d)}`); // dispenser on
      o.push(`G4 P${dwellSeconds(dotDwellMs(p), d)}`); // dwell = the dot volume/time
      o.push('M5'); // dispenser off
      o.push(`G0 Z${fmt(p.travelZ, d)}`); // retract
      continue;
    }

    const trajs = shapeTracePolylines(shape);
    const traj = trajs[0];
    if (!traj || traj.length < 2) continue; // nothing to trace

    // G2 — lead-in: for OPEN beads only (closed shapes return to their own
    // start, so a lead is meaningless). Begin the descent/flow a little before
    // the bead, along the entry direction, so glue is flowing at the first point.
    const open = !shape.fill && shape.kind === 'line';
    const start = traj[0];
    const entry = open && p.leadInMm > 0 ? extend(start, traj[1], p.leadInMm) : start;

    o.push(`(Shape ${n}: ${shape.kind}${shape.fill && isClosedShape(shape) ? ' fill' : ''})`);
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // ensure raised before XY travel
    o.push(`G0 X${fmt(entry.x, d)} Y${fmt(entry.y, d)}`); // travel above start (+lead-in)
    o.push(`G1 Z${fmt(dispZ, d)} F${fmt(p.plungeFeed, d)}`); // lower to bead height
    o.push(`M3 S${fmt(p.dispenseRate, d)}`); // dispenser on
    if (p.settleMs > 0) o.push(`G4 P${dwellSeconds(p.settleMs, d)}`);
    if (entry !== start) o.push(`G1 X${fmt(start.x, d)} Y${fmt(start.y, d)} F${fmt(p.feed, d)}`); // lead-in run

    // Trace the outline (and any fill rings). The first trajectory's start is
    // already the current XY; for each subsequent ring move to its start first.
    for (let ti = 0; ti < trajs.length; ti++) {
      const path = trajs[ti];
      if (path.length < 2) continue;
      let from = 1;
      if (ti > 0) {
        o.push(`G1 X${fmt(path[0].x, d)} Y${fmt(path[0].y, d)} F${fmt(p.feed, d)}`); // step to next ring
        from = 1;
      }
      for (let i = from; i < path.length; ++i) {
        o.push(`G1 X${fmt(path[i].x, d)} Y${fmt(path[i].y, d)} F${fmt(p.feed, d)}`);
      }
    }

    if (p.postDwellMs > 0) o.push(`G4 P${dwellSeconds(p.postDwellMs, d)}`);
    o.push('M5'); // dispenser off
    // G2 — lead-out: after the dispenser stops, drag the residual-pressure tail
    // a little past the bead end (open beads only) so it doesn't blob on the joint.
    if (open && p.leadOutMm > 0 && traj.length >= 2) {
      const last = traj[traj.length - 1];
      const prev = traj[traj.length - 2];
      const tail = extend(last, prev, p.leadOutMm);
      o.push(`G1 X${fmt(tail.x, d)} Y${fmt(tail.y, d)} F${fmt(p.feed, d)}`); // lead-out tail
    }
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // retract to travel height
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(p.travelZ, d)}`);
  o.push('M5');
  o.push('M30');

  return o.join('\n') + '\n';
}
