// Laser-cutting CAM + G-code generator — UI-independent, pure TypeScript.
// No React / DOM / three.js / zustand imports here (mirrors the cadcam lib split).
//
// Handles BOTH CO2 and Fiber laser cutting in ONE code path: a `mode` field on
// the params object gates the few differences (piercing, focus-Z defaults). The
// emitter follows the same safety conventions as the rest of the CAM core
// (G21/G90/G94/G17 header, guaranteed laser-OFF travel, M30 footer, never
// "-0.000").
//
// GRBL laser safety scheme (the critical part):
//   * The machine is assumed to run in GRBL laser mode ($32=1) so S changes take
//     effect with motion and the laser is gated to feed moves.
//   * ALL travel/positioning is done with G0 while the laser is OFF — we emit an
//     explicit `S0` (and rely on G0 not firing the beam) so the head can move
//     dark. M5 is asserted at the start and the very end.
//   * The beam is turned ON only for the cut itself: `M3`/`M4 S<power>` is issued
//     immediately before the G1 cutting feed, and `S0` is written right after the
//     contour finishes, before the next travel.
//   * Z is used ONLY as a focus height (move Z to focus at program start / per
//     part). It is NEVER used as the on/off mechanism — the laser is gated by
//     S/M3/M4/M5, not by plunging.

import { BBox, Point, Polyline, distance, kDefaultArcTolerance } from './geometry';
import { Drawing } from './entity';

/** Which laser source the job targets. Shares one code path; gates a few opts. */
export enum LaserMode {
  CO2 = 'CO2',
  Fiber = 'Fiber',
}

/** Power-mode of the GRBL laser output for the CUT moves. */
export enum LaserPowerMode {
  /** M3 — constant power; S is fixed regardless of feed speed. */
  Constant = 'M3',
  /** M4 — dynamic power; GRBL scales S with actual feed (default for cutting). */
  Dynamic = 'M4',
}

/**
 * Combined laser-cutting parameters. CO2 and Fiber share every field; the
 * mode-specific behaviour is gated on `mode` plus the fiber/CO2 toggle fields.
 */
export interface LaserParams {
  /** CO2 vs Fiber — selects defaults + gates pierce/focus behaviour. */
  mode: LaserMode;

  // ---- Common cut parameters ----------------------------------------------
  /** Cutting feed / speed (mm/min). */
  cutFeed: number;
  /** Travel (rapid) feed for G0 link moves (mm/min); informational for G0. */
  travelFeed: number;
  /**
   * Laser power as an S value (0..sMax). The UI may present this as a percentage
   * and map it via `powerFromPercent`. Emitted verbatim as the S word.
   */
  power: number;
  /** Maximum S value the controller maps to 100% ($30 in GRBL). */
  sMax: number;
  /** Number of cut passes over each contour. */
  passes: number;
  /** Constant (M3) vs dynamic (M4) laser power mode for cuts. */
  powerMode: LaserPowerMode;

  // ---- Focus (Z) ----------------------------------------------------------
  /**
   * Apply a focus-Z move at program start. For Fiber this is the autofocus/focus
   * offset height; for CO2 it is the (often fixed/manual) focus height. When
   * false, Z is left untouched (the operator focuses manually).
   */
  useFocusZ: boolean;
  /** Focus-Z height (mm, absolute) moved to at program start when enabled. */
  focusZ: number;

  // ---- Piercing -----------------------------------------------------------
  /**
   * Pierce (dwell at the contour start with pierce power) BEFORE each closed/open
   * cut. Default OFF for CO2, ON for Fiber. The single code path honours this
   * flag regardless of mode.
   */
  pierce: boolean;
  /** Pierce power as an S value (typically higher than cut power). */
  piercePower: number;
  /** Pierce dwell time (seconds), emitted as G4 P<sec>. */
  pierceTime: number;

  // ---- Output formatting --------------------------------------------------
  decimals: number;
  programName: string;
}

/** Sensible defaults for a given mode. CO2 = no pierce; Fiber = pierce on. */
export function defaultLaserParams(mode: LaserMode = LaserMode.CO2, overrides: Partial<LaserParams> = {}): LaserParams {
  const fiber = mode === LaserMode.Fiber;
  return {
    mode,
    cutFeed: fiber ? 800 : 1200,
    travelFeed: 3000,
    power: fiber ? 800 : 600,
    sMax: 1000,
    passes: 1,
    powerMode: LaserPowerMode.Dynamic,
    useFocusZ: fiber, // fiber usually drives a focus-Z; CO2 often manual/fixed
    focusZ: 0,
    pierce: fiber, // CO2 usually no pierce; fiber pierces before each contour
    piercePower: fiber ? 1000 : 700,
    pierceTime: fiber ? 0.3 : 0.2,
    decimals: 3,
    programName: 'hjLabs Laser Cutting',
    ...overrides,
  };
}

/** Map a 0..100 percentage to an S value given sMax. */
export function powerFromPercent(percent: number, sMax: number): number {
  const p = Math.max(0, Math.min(100, percent));
  return Math.round((p / 100) * sMax);
}

/** Map an S value back to a 0..100 percentage given sMax. */
export function percentFromPower(power: number, sMax: number): number {
  if (sMax <= 0) return 0;
  return Math.round((power / sMax) * 100);
}

/** Formatted number, never "-0.000" — mirrors the emitter's fmt(). */
function fmt(value: number, decimals: number): string {
  const snap = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(decimals);
}

/** A single contour to cut, in placed (post-nesting) work coordinates. */
export interface LaserContour {
  /** Flattened polyline (closed => cut loop; open => cut line). */
  poly: Polyline;
  /** True if the source entity is a closed loop. */
  closed: boolean;
}

/** A laser part: one or more contours sharing a footprint, plus copy count. */
export interface LaserPart {
  id: string;
  /** Source contours in the part's own local coordinate frame. */
  contours: LaserContour[];
  /** Footprint bounds of the part (mm). */
  bounds: BBox;
  /** Number of copies to lay out / cut. */
  quantity: number;
}

/**
 * Flatten an imported Drawing into laser contours. Closed entities become cut
 * loops, open entities become cut lines. Empty polylines are dropped.
 */
export function drawingToContours(drawing: Drawing, tol = kDefaultArcTolerance): LaserContour[] {
  const out: LaserContour[] = [];
  for (const e of drawing.entities) {
    const poly = e.flatten(tol);
    if (poly.points.length < 2) continue;
    out.push({ poly, closed: e.isClosed() || poly.closed });
  }
  return out;
}

/** Bounds across a list of contours. */
export function contoursBounds(contours: LaserContour[]): BBox {
  const b = new BBox();
  for (const c of contours) b.expand(c.poly.bounds());
  return b;
}

/** Count closed vs open contours for the UI status. */
export function countContours(contours: LaserContour[]): { closed: number; open: number } {
  let closed = 0;
  let open = 0;
  for (const c of contours) {
    if (c.closed) ++closed;
    else ++open;
  }
  return { closed, open };
}

/** A placed contour ready for emission (offset already applied). */
export interface PlacedContour {
  /** Points in absolute work coordinates. */
  points: Point[];
  closed: boolean;
}

/**
 * Translate a set of source contours by (dx, dy) so a part sits at its nested
 * position. Returns absolute-coordinate placed contours, normalising the source
 * so its bottom-left footprint corner lands at (dx, dy).
 */
export function placeContours(
  contours: LaserContour[],
  bounds: BBox,
  dx: number,
  dy: number,
): PlacedContour[] {
  const ox = bounds.valid ? bounds.min.x : 0;
  const oy = bounds.valid ? bounds.min.y : 0;
  return contours.map((c) => ({
    closed: c.closed,
    points: c.poly.points.map((p) => ({ x: p.x - ox + dx, y: p.y - oy + dy })),
  }));
}

/**
 * Order placed contours so inner loops are cut before the outer perimeter of a
 * part (smaller signed-area-magnitude loops first, then open lines, then the
 * largest loop last). This is a cheap heuristic that keeps small features from
 * dropping out before they're cut. Open lines keep their relative order.
 */
export function orderContours(contours: PlacedContour[]): PlacedContour[] {
  const withArea = contours.map((c, i) => {
    const pl = new Polyline();
    pl.points = c.points;
    pl.closed = c.closed;
    return { c, i, area: c.closed ? Math.abs(pl.signedArea()) : Number.POSITIVE_INFINITY };
  });
  // Smallest closed loops first; open lines (Infinity) kept after loops; ties by
  // original index for determinism.
  withArea.sort((a, b) => (a.area - b.area) || (a.i - b.i));
  return withArea.map((w) => w.c);
}

/**
 * Emit a complete, safe laser G-code program.
 *
 * `placed` is the final ordered list of contours in absolute work coordinates
 * (after nesting + ordering). The same routine serves CO2 and Fiber; `params`
 * gates piercing and focus-Z.
 */
export function emitLaserProgram(placed: PlacedContour[], params: Partial<LaserParams> = {}): string {
  const p = defaultLaserParams(params.mode ?? LaserMode.CO2, params);
  const d = p.decimals;
  const o: string[] = [];

  const sCut = Math.max(0, Math.round(p.power));
  const sPierce = Math.max(0, Math.round(p.piercePower));
  const passes = Math.max(1, Math.floor(p.passes));
  const onCode = p.powerMode === LaserPowerMode.Dynamic ? 'M4' : 'M3';

  // ---- Header -------------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push(`(Generated by hjLabs Candle Laser — ${p.mode} mode)`);
  o.push('(Requires GRBL laser mode: $32=1)');
  o.push('G21'); // mm
  o.push('G90'); // absolute
  o.push('G94'); // feed per minute
  o.push('G17'); // XY plane
  o.push('M5 S0'); // laser OFF to start (safe)

  // Focus-Z at program start (Z used only for focus, never as on/off).
  if (p.useFocusZ) {
    o.push(`(Focus height)`);
    o.push(`G0 Z${fmt(p.focusZ, d)}`);
  }

  // ---- Body ---------------------------------------------------------------
  let cn = 0;
  for (const c of placed) {
    if (c.points.length < 2) continue;
    ++cn;
    const start = c.points[0];

    // Travel to the start of the contour with the laser OFF (S0, G0).
    o.push(`(Contour ${cn}: ${c.closed ? 'loop' : 'line'})`);
    o.push(`G0 X${fmt(start.x, d)} Y${fmt(start.y, d)} S0`);

    // Optional pierce: dwell at the start point with the beam on at pierce power
    // BEFORE the cut begins. The pierce uses the same on-code; we drop to cut
    // power right after the dwell.
    if (p.pierce && p.pierceTime > 0) {
      o.push(`(Pierce ${fmt(p.pierceTime, d)}s @ S${sPierce})`);
      o.push(`${onCode} S${sPierce}`);
      o.push(`G4 P${fmt(p.pierceTime, d)}`);
    }

    // Turn the beam on at cut power and run the cut passes.
    for (let pass = 0; pass < passes; ++pass) {
      if (passes > 1) o.push(`(Pass ${pass + 1}/${passes})`);
      // For pass > 0 the head is already at `start` (a closed loop returns there;
      // an open line is re-positioned). Re-assert the on-code + cut power and a
      // feed word at the first cutting move.
      if (pass === 0) {
        o.push(`${onCode} S${sCut}`);
      } else {
        // Re-position to the start for the next pass with the beam off.
        o.push(`G0 X${fmt(start.x, d)} Y${fmt(start.y, d)} S0`);
        o.push(`${onCode} S${sCut}`);
      }

      let firstFeed = true;
      for (let i = 1; i < c.points.length; ++i) {
        const pt = c.points[i];
        if (firstFeed) {
          o.push(`G1 X${fmt(pt.x, d)} Y${fmt(pt.y, d)} F${fmt(p.cutFeed, d)}`);
          firstFeed = false;
        } else {
          o.push(`G1 X${fmt(pt.x, d)} Y${fmt(pt.y, d)}`);
        }
      }
      // Close a loop back to the start point.
      if (c.closed && distance(c.points[c.points.length - 1], start) > 1e-6) {
        o.push(`G1 X${fmt(start.x, d)} Y${fmt(start.y, d)}`);
      }
    }

    // Laser OFF after the contour, before the next travel.
    o.push('S0 M5');
  }

  // ---- Footer -------------------------------------------------------------
  o.push('M5 S0'); // laser OFF at program end
  if (p.useFocusZ) o.push(`G0 Z${fmt(p.focusZ, d)}`); // keep at focus height
  o.push('M30');

  return o.join('\n') + '\n';
}
