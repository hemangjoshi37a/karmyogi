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

// ---- Shape model ----------------------------------------------------------

/** A straight glue bead from (x1,y1) to (x2,y2). Open trajectory. */
export interface LineShape {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A glue bead tracing the closed outline through three vertices. */
export interface TriangleShape {
  kind: 'triangle';
  points: [Point, Point, Point];
}

/** A glue bead tracing a circle of radius r centred at (cx,cy). */
export interface CircleShape {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
}

/** A glue bead tracing the closed outline of a rectangle (corner + size). */
export interface RectShape {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GlueShape = LineShape | TriangleShape | CircleShape | RectShape;

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

// ---- Generator -------------------------------------------------------------

/**
 * Produce a complete, safe glue-dispense G-code program for the given shapes.
 *
 * Per shape: rapid XY to the start at travelZ → lower to dispenseZ (plunge feed)
 * → dispenser ON (M3 S<rate>) + optional settle dwell → feed along the
 * trajectory points → optional post-dwell → dispenser OFF (M5) → retract to
 * travelZ. Z and XY never change within the same move.
 */
export function generateGlue(shapes: GlueShape[], params: Partial<GlueParams> = {}): string {
  const p = defaultGlueParams(params);
  const d = p.decimals;
  const o: string[] = [];

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by hjLabs Candle Glue Dispense)');
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
    const traj = trajectoryPoints(shape);
    if (traj.length < 2) continue; // nothing to trace

    const start = traj[0];
    o.push(`(Shape ${n}: ${shape.kind})`);
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // ensure raised before XY travel
    o.push(`G0 X${fmt(start.x, d)} Y${fmt(start.y, d)}`); // travel above start
    o.push(`G1 Z${fmt(p.dispenseZ, d)} F${fmt(p.plungeFeed, d)}`); // lower to bead height
    o.push(`M3 S${fmt(p.dispenseRate, d)}`); // dispenser on
    if (p.settleMs > 0) o.push(`G4 P${dwellSeconds(p.settleMs, d)}`);

    // Trace the trajectory at the dispense feed (skip the start, already there).
    for (let i = 1; i < traj.length; ++i) {
      const q = traj[i];
      o.push(`G1 X${fmt(q.x, d)} Y${fmt(q.y, d)} F${fmt(p.feed, d)}`);
    }

    if (p.postDwellMs > 0) o.push(`G4 P${dwellSeconds(p.postDwellMs, d)}`);
    o.push('M5'); // dispenser off
    o.push(`G0 Z${fmt(p.travelZ, d)}`); // retract to travel height
  }

  // ---- Footer -----------------------------------------------------------
  o.push(`G0 Z${fmt(p.travelZ, d)}`);
  o.push('M5');
  o.push('M30');

  return o.join('\n') + '\n';
}
