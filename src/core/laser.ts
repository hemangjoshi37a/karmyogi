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
import { insetRings, offsetPolygon } from './offset';
import { convexHull } from './framing';

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

  // ---- Air assist ---------------------------------------------------------
  /**
   * Turn an air-assist solenoid on for the whole job: `M8` (flood/air) right
   * after the safe header, `M9` (off) at program end. Off by default; never
   * gates the beam — purely an auxiliary output.
   */
  airAssist?: boolean;

  // ---- Rotary mode (L14) --------------------------------------------------
  /**
   * Engrave/cut on a rotary axis: the Y travel is remapped to a rotary axis
   * (default A) by converting the linear Y distance into degrees of rotation
   * via the workpiece diameter (`mmPerDeg = π·⌀ / 360`). X stays linear. Off by
   * default. Feeds on the mapped axis become deg/min, scaled by the same factor.
   */
  rotary?: boolean;
  /** Rotary axis letter (A/B/C/Y). */
  rotaryAxis?: 'A' | 'B' | 'C' | 'Y';
  /** Workpiece diameter (mm) used for the mm→deg conversion. */
  rotaryDiameter?: number;

  // ---- Fiber galvo (L18) --------------------------------------------------
  /**
   * Fiber/galvo Q-switch frequency (kHz) emitted as an informational header
   * comment (plain GRBL has no pulse word; EZCAD-style controllers consume it).
   */
  fiberFrequencyKHz?: number;
  /** Fiber Q-pulse width (ns), header comment only. */
  fiberPulseNs?: number;

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
    airAssist: false,
    rotary: false,
    rotaryAxis: 'A',
    rotaryDiameter: 50,
    fiberFrequencyKHz: fiber ? 30 : undefined,
    fiberPulseNs: fiber ? 200 : undefined,
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
  // Defensive clamp so a bad `decimals` can't throw RangeError in toFixed.
  const d = Number.isFinite(decimals) ? Math.max(0, Math.min(8, Math.floor(decimals))) : 3;
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(d);
}

/** A single contour to cut, in placed (post-nesting) work coordinates. */
export interface LaserContour {
  /** Flattened polyline (closed => cut loop; open => cut line). */
  poly: Polyline;
  /** True if the source entity is a closed loop. */
  closed: boolean;
  /**
   * Source DXF layer name (L2 layer system). Empty when the source has no layer.
   * Contours sharing a layer are grouped into one layer with its own cut params.
   */
  layer?: string;
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
    out.push({ poly, closed: e.isClosed() || poly.closed, layer: e.layer || '' });
  }
  return out;
}

/** Distinct layer names across contours, in first-seen order (L2). */
export function contourLayers(contours: LaserContour[]): string[] {
  const seen: string[] = [];
  for (const c of contours) {
    const l = c.layer ?? '';
    if (!seen.includes(l)) seen.push(l);
  }
  return seen;
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
  /** Source DXF layer name (L2), propagated from the source contour. */
  layer?: string;
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
    layer: c.layer ?? '',
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

// ---- L8: cut-order / travel optimization ----------------------------------

/** First / last point of a placed contour (its travel anchors). */
function endpoints(c: PlacedContour): { start: Point; end: Point } {
  const pts = c.points;
  const start = pts[0];
  const end = c.closed ? pts[0] : pts[pts.length - 1];
  return { start, end };
}

/**
 * Reorder placed contours with a greedy nearest-neighbour walk to minimize the
 * pen-up (beam-off) travel between cuts (L8). Starting from the machine origin
 * (or `from`), each step picks the unvisited contour whose start point is
 * nearest to the current head position. Closed loops can also be entered from
 * the nearest vertex (`rotateStart`) so the seam lands next to the previous cut;
 * open lines may be reversed so either end can be the entry. The *relative*
 * inner-first ordering is NOT preserved — call this only when travel reduction
 * is the priority (the UI gates it behind a toggle).
 */
export function optimizeTravel(
  contours: PlacedContour[],
  opts: { from?: Point; rotateClosedStart?: boolean; reverseOpen?: boolean } = {},
): PlacedContour[] {
  const n = contours.length;
  if (n <= 1) return contours.slice();
  const remaining = contours.map((_c, i) => i);
  const out: PlacedContour[] = [];
  let cur: Point = opts.from ?? { x: 0, y: 0 };
  const rot = opts.rotateClosedStart ?? true;
  const rev = opts.reverseOpen ?? true;

  while (remaining.length > 0) {
    let bestK = 0;
    let bestD = Number.POSITIVE_INFINITY;
    let bestReverse = false;
    for (let k = 0; k < remaining.length; ++k) {
      const c = contours[remaining[k]];
      const { start, end } = endpoints(c);
      const dStart = distance(cur, start);
      if (dStart < bestD) {
        bestD = dStart;
        bestK = k;
        bestReverse = false;
      }
      if (rev && !c.closed) {
        const dEnd = distance(cur, end);
        if (dEnd < bestD) {
          bestD = dEnd;
          bestK = k;
          bestReverse = true;
        }
      }
    }
    const idx = remaining[bestK];
    remaining.splice(bestK, 1);
    let chosen = contours[idx];
    if (bestReverse) {
      chosen = { ...chosen, points: chosen.points.slice().reverse() };
    } else if (rot && chosen.closed && chosen.points.length > 2) {
      chosen = rotateClosedToNearest(chosen, cur);
    }
    out.push(chosen);
    const { start, end } = endpoints(chosen);
    cur = chosen.closed ? start : end;
  }
  return out;
}

/** Rotate a closed loop so its seam (start vertex) is the vertex nearest `to`. */
function rotateClosedToNearest(c: PlacedContour, to: Point): PlacedContour {
  const pts = c.points;
  // Drop a duplicated closing vertex if present so rotation is clean.
  const n = pts.length >= 2 && distance(pts[0], pts[pts.length - 1]) < 1e-6 ? pts.length - 1 : pts.length;
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; ++i) {
    const d = distance(to, pts[i]);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best === 0) return c;
  const rotated: Point[] = [];
  for (let i = 0; i < n; ++i) rotated.push(pts[(best + i) % n]);
  return { ...c, points: rotated };
}

// ---- L9: tabs / bridges on cut paths --------------------------------------

/**
 * Insert un-cut "tabs" (bridges) into a CLOSED cut loop so the part stays
 * attached to the stock after cutting (L9). The loop perimeter is divided into
 * `count` equal arcs; a `tabWidthMm`-long gap is left un-cut at the centre of
 * each arc. Returns an ARRAY OF OPEN polylines (the cut segments between tabs).
 * Open contours and tiny loops are returned unchanged (wrapped in one segment).
 *
 * This is pure geometry — the emitter cuts each returned segment as an open
 * path, so the gaps are simply never traversed by the beam.
 */
export function tabContour(c: PlacedContour, count: number, tabWidthMm: number): PlacedContour[] {
  const tabs = Math.max(0, Math.floor(count));
  if (!c.closed || tabs <= 0 || tabWidthMm <= 0 || c.points.length < 3) return [c];

  // Build a closed point ring (drop a duplicate closing vertex).
  const pts = c.points.slice();
  if (distance(pts[0], pts[pts.length - 1]) < 1e-6) pts.pop();
  const n = pts.length;
  if (n < 3) return [c];

  // Cumulative perimeter length at each vertex (ring).
  const segLen: number[] = [];
  let perim = 0;
  for (let i = 0; i < n; ++i) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const len = distance(a, b);
    segLen.push(len);
    perim += len;
  }
  if (perim <= tabs * tabWidthMm * 1.2) return [c]; // tabs would consume the whole loop

  // Point at arc-length `s` along the ring (s in [0, perim)).
  const at = (s: number): Point => {
    let rem = ((s % perim) + perim) % perim;
    for (let i = 0; i < n; ++i) {
      if (rem <= segLen[i] || i === n - 1) {
        const a = pts[i];
        const b = pts[(i + 1) % n];
        const t = segLen[i] > 1e-9 ? rem / segLen[i] : 0;
        return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      }
      rem -= segLen[i];
    }
    return pts[0];
  };

  // Tab CENTRES evenly spaced; each tab spans [centre - half, centre + half].
  const half = tabWidthMm / 2;
  const segments: PlacedContour[] = [];
  for (let k = 0; k < tabs; ++k) {
    const tabCentre = (k / tabs) * perim;
    const cutStart = tabCentre + half; // cut begins after this tab
    const nextTabCentre = ((k + 1) / tabs) * perim;
    const cutEnd = nextTabCentre - half; // cut ends before the next tab
    const segPts: Point[] = [at(cutStart)];
    // Sample the open arc by stepping ring vertices between the two cut ends.
    const arc = sampleArc(pts, segLen, perim, cutStart, cutEnd);
    for (const p of arc) segPts.push(p);
    segPts.push(at(cutEnd));
    segments.push({ points: dedupe(segPts), closed: false, layer: c.layer });
  }
  return segments;
}

/** Collect ring vertices strictly between arc-lengths a→b (a<b mod perim). */
function sampleArc(pts: Point[], segLen: number[], perim: number, a: number, b: number): Point[] {
  const out: Point[] = [];
  const n = pts.length;
  // Vertex i sits at cumulative length cum[i].
  let cum = 0;
  const cums: number[] = [];
  for (let i = 0; i < n; ++i) {
    cums.push(cum);
    cum += segLen[i];
  }
  const aa = ((a % perim) + perim) % perim;
  const bb = ((b % perim) + perim) % perim;
  for (let i = 0; i < n; ++i) {
    const v = cums[i];
    const inRange = aa <= bb ? v > aa && v < bb : v > aa || v < bb;
    if (inRange) out.push(pts[i]);
  }
  return out;
}

/** Remove consecutive duplicate points. */
function dedupe(pts: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-6) out.push(p);
  }
  return out;
}

// ---- L11: offset (spiral) fill vs line fill -------------------------------

/** Fill style for closed loops. */
export enum FillStyle {
  /** No fill — cut the outline only. */
  None = 'none',
  /** Parallel scan lines clipped to the loop (line / hatch fill). */
  Line = 'line',
  /** Concentric offset rings spiralling inward (reuses the offset core). */
  Offset = 'offset',
}

/**
 * Generate offset (concentric) fill paths for a closed loop by repeatedly
 * insetting it by `spacing` until it collapses (L11). Reuses the shared
 * `insetRings` offset core (read-only). Returns closed ring polylines from the
 * outside in; the caller cuts them as additional closed contours.
 */
export function offsetFill(c: PlacedContour, spacing: number): PlacedContour[] {
  if (!c.closed || spacing <= 0 || c.points.length < 3) return [];
  const pl = new Polyline();
  pl.points = c.points.slice();
  pl.closed = true;
  const rings = insetRings(pl, spacing, spacing);
  return rings
    .filter((r) => r.points.length >= 3)
    .map((r) => ({ points: r.points.slice(), closed: true, layer: c.layer }));
}

/**
 * Generate parallel-line (hatch) fill for a closed loop (L11). Scan lines at
 * `angleDeg` spaced `spacing` apart are clipped to the polygon via even-odd
 * crossing; each clipped span becomes one open cut segment. Alternating lines
 * are reversed so the fill zig-zags (minimal travel).
 */
export function lineFill(c: PlacedContour, spacing: number, angleDeg: number): PlacedContour[] {
  if (!c.closed || spacing <= 0 || c.points.length < 3) return [];
  const pts = c.points;
  // Rotate the polygon by -angle so scan lines become horizontal, clip, rotate back.
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(-a);
  const sa = Math.sin(-a);
  const rot = (p: Point): Point => ({ x: p.x * ca - p.y * sa, y: p.x * sa + p.y * ca });
  const cb = Math.cos(a);
  const sb = Math.sin(a);
  const unrot = (p: Point): Point => ({ x: p.x * cb - p.y * sb, y: p.x * sb + p.y * cb });

  const rp = pts.map(rot);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of rp) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const out: PlacedContour[] = [];
  const n = rp.length;
  let flip = false;
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    // Find X crossings of the scan line y with each polygon edge.
    const xs: number[] = [];
    for (let i = 0; i < n; ++i) {
      const p1 = rp[i];
      const p2 = rp[(i + 1) % n];
      const yMin = Math.min(p1.y, p2.y);
      const yMax = Math.max(p1.y, p2.y);
      if (y < yMin || y >= yMax) continue; // half-open avoids double-counting vertices
      const t = (y - p1.y) / (p2.y - p1.y);
      xs.push(p1.x + t * (p2.x - p1.x));
    }
    xs.sort((u, v) => u - v);
    // Pair crossings into interior spans.
    const spans: Array<[number, number]> = [];
    for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i], xs[i + 1]]);
    if (flip) spans.reverse();
    for (const [x0, x1] of spans) {
      const sp = flip ? [x1, x0] : [x0, x1];
      const segPts = [unrot({ x: sp[0], y }), unrot({ x: sp[1], y })];
      if (distance(segPts[0], segPts[1]) > 1e-6) out.push({ points: segPts, closed: false, layer: c.layer });
    }
    flip = !flip;
  }
  return out;
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

  // ---- Rotary (L14): Y travel → rotary axis degrees. ----------------------
  // mmPerDeg = π·⌀ / 360; degrees = yMm / mmPerDeg. X stays linear; the swept
  // axis letter is configurable. When off, Y is emitted verbatim.
  const rotary = p.rotary === true && (p.rotaryDiameter ?? 0) > 0;
  const rotAxis = p.rotaryAxis ?? 'A';
  const mmPerDeg = rotary ? (Math.PI * (p.rotaryDiameter ?? 0)) / 360 : 1;
  // Y/rotary axis word for a Y position in mm.
  const yWord = (yMm: number): string =>
    rotary ? `${rotAxis}${fmt(yMm / mmPerDeg, d)}` : `Y${fmt(yMm, d)}`;
  // Feed in mm/min scaled to the dominant axis units (deg/min when rotary).
  const feedVal = rotary && mmPerDeg > 0 ? p.cutFeed / mmPerDeg : p.cutFeed;

  // ---- Header -------------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push(`(Generated by karmyogi.hjLabs.in Laser — ${p.mode} mode)`);
  o.push('(Requires GRBL laser mode: $32=1)');
  if (p.mode === LaserMode.Fiber && (p.fiberFrequencyKHz || p.fiberPulseNs)) {
    // L18: galvo/fiber pulse params. Plain GRBL has no pulse word — emit as a
    // header comment so EZCAD-class controllers / operators can apply it.
    o.push(
      `(Fiber: frequency ${p.fiberFrequencyKHz ?? 0}kHz, Q-pulse ${p.fiberPulseNs ?? 0}ns)`,
    );
  }
  if (rotary) {
    o.push(
      `(Rotary: ${rotAxis}-axis, ⌀${fmt(p.rotaryDiameter ?? 0, 2)}mm — ${fmt(mmPerDeg, 4)}mm/deg)`,
    );
  }
  o.push('G21'); // mm
  o.push('G90'); // absolute
  o.push('G94'); // feed per minute
  o.push('G17'); // XY plane
  o.push('M5 S0'); // laser OFF to start (safe)
  if (p.airAssist) o.push('M8'); // air assist on (auxiliary; never gates the beam)

  // Focus-Z at program start (Z used only for focus, never as on/off). Clamp to
  // >= 0 in the CORE (not just the UI) so a loaded/edited file with a negative
  // focusZ can never emit a downward `G0 Z-…` as the first motion.
  if (p.useFocusZ) {
    o.push(`(Focus height)`);
    o.push(`G0 Z${fmt(Math.max(0, p.focusZ), d)}`);
  }

  // ---- Body ---------------------------------------------------------------
  let cn = 0;
  for (const c of placed) {
    if (c.points.length < 2) continue;
    ++cn;
    const start = c.points[0];

    // Travel to the start of the contour with the laser OFF (S0, G0).
    o.push(`(Contour ${cn}: ${c.closed ? 'loop' : 'line'})`);
    o.push(`G0 X${fmt(start.x, d)} ${yWord(start.y)} S0`);

    // Optional pierce: dwell at the start point with the beam on at pierce power
    // BEFORE the cut begins. The pierce uses the same on-code; we drop to cut
    // power right after the dwell.
    if (p.pierce && p.pierceTime > 0) {
      // Dwell uses its OWN time precision (3 dp), not the coordinate `decimals`:
      // at decimals=0 `fmt(0.3,0)` would round to "0" and the pierce would vanish.
      o.push(`(Pierce ${fmt(p.pierceTime, 3)}s @ S${sPierce})`);
      o.push(`${onCode} S${sPierce}`);
      o.push(`G4 P${fmt(p.pierceTime, 3)}`);
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
        o.push(`G0 X${fmt(start.x, d)} ${yWord(start.y)} S0`);
        o.push(`${onCode} S${sCut}`);
      }

      let firstFeed = true;
      for (let i = 1; i < c.points.length; ++i) {
        const pt = c.points[i];
        if (firstFeed) {
          o.push(`G1 X${fmt(pt.x, d)} ${yWord(pt.y)} F${fmt(feedVal, d)}`);
          firstFeed = false;
        } else {
          o.push(`G1 X${fmt(pt.x, d)} ${yWord(pt.y)}`);
        }
      }
      // Close a loop back to the start point.
      if (c.closed && distance(c.points[c.points.length - 1], start) > 1e-6) {
        o.push(`G1 X${fmt(start.x, d)} ${yWord(start.y)}`);
      }
    }

    // Laser OFF after the contour, before the next travel.
    o.push('S0 M5');
  }

  // ---- Footer -------------------------------------------------------------
  o.push('M5 S0'); // laser OFF at program end
  if (p.useFocusZ) o.push(`G0 Z${fmt(Math.max(0, p.focusZ), d)}`); // keep at focus height
  if (p.airAssist) o.push('M9'); // air assist off
  o.push('M30');

  return o.join('\n') + '\n';
}

// ---- L15: low-power framing + focus dot ------------------------------------
//
// The operator "frames" a job by tracing its outline at a LOW, clearly-bounded
// power so they can see exactly where the cut lands on the stock before
// committing. Because framing FIRES THE BEAM while the head moves, the safety
// rules are stricter than a cut:
//   * Power is CONSTANT (M3) — never M4 — so the trace power is exactly the
//     operator-set S, independent of feed/accel.
//   * Power is clamped to a low ceiling (`kMaxFramePowerPct`) so framing MARKS
//     but cannot CUT, even if the operator drags the slider up.
//   * Emission routes through `emitLaserProgram`, inheriting every guarantee:
//     `M5 S0` header, `S0`/`G0` on all travel, `S0 M5` after the outline, and a
//     `M5 S0` footer — the beam is never left on.

/** Frame outline shape: the axis-aligned bounding box, or the convex hull. */
export type LaserFrameShape = 'box' | 'hull';

/** Hard ceiling on framing / focus-dot power (%) — framing must MARK, never CUT. */
export const kMaxFramePowerPct = 30;

/** Single GRBL command that extinguishes the beam (focus-dot OFF / safe). */
export const kLaserOffCommand = 'M5 S0';

/** Options for {@link emitLaserFrameProgram}. */
export interface LaserFrameOptions {
  /** 'box' = bounding rectangle; 'hull' = convex-hull rubber-band. */
  shape: LaserFrameShape;
  /** Operator-set LOW power as a % of sMax. Clamped to [0, kMaxFramePowerPct]. */
  powerPct: number;
  /** Outward margin (mm) so the outline clears the part. Default 0. */
  marginMm?: number;
  /** Repeat the outline N times. Default 1. */
  loops?: number;
  /** Perimeter feed (mm/min). Default 1500. */
  feed?: number;
  /** S value at 100% (GRBL $30). Default 1000. */
  sMax?: number;
  decimals?: number;
  programName?: string;
}

/** Flatten every vertex of the placed contours into one point cloud. */
export function framePoints(placed: PlacedContour[]): Point[] {
  const out: Point[] = [];
  for (const c of placed) for (const p of c.points) out.push(p);
  return out;
}

/**
 * Build the frame OUTLINE contour (a closed loop) for a set of placed contours.
 * 'box' yields the axis-aligned bounding rectangle; 'hull' yields the convex
 * hull (rubber-band). A positive `marginMm` grows the outline outward so the
 * low-power trace clears the part. A degenerate (collinear) hull falls back to
 * the box. Returns null when there is nothing to frame.
 */
export function buildFrameContour(
  placed: PlacedContour[],
  shape: LaserFrameShape,
  marginMm = 0,
): PlacedContour | null {
  const pts = framePoints(placed);
  if (pts.length < 2) return null;
  const m = Math.max(0, marginMm);

  if (shape === 'hull') {
    const hull = convexHull(pts);
    if (hull.length >= 3) {
      let ring = hull;
      if (m > 0) {
        const pl = new Polyline();
        pl.points = hull.slice();
        pl.closed = true;
        const off = offsetPolygon(pl, m);
        if (off.points.length >= 3) ring = off.points.slice();
      }
      return { points: ring, closed: true };
    }
    // Fall through to the box for a degenerate (collinear) hull.
  }

  // Box: axis-aligned bounding rectangle (optionally grown by the margin).
  const b = new BBox();
  for (const p of pts) b.expand(p);
  if (!b.valid) return null;
  const x0 = b.min.x - m;
  const y0 = b.min.y - m;
  const x1 = b.max.x + m;
  const y1 = b.max.y + m;
  if (!(x1 > x0) || !(y1 > y0)) return null;
  return {
    points: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
    closed: true,
  };
}

/**
 * Emit a SAFE low-power FRAME program (L15): trace the job's outline (box or
 * convex hull) at a low, operator-set CONSTANT power so the operator can see
 * exactly where the job lands on the stock BEFORE cutting. See the section
 * comment above for the beam-safety contract. Returns a safe no-op program
 * (header + `M5 S0` footer) when there is nothing to frame.
 */
export function emitLaserFrameProgram(placed: PlacedContour[], opts: LaserFrameOptions): string {
  const sMax = opts.sMax && opts.sMax > 0 ? opts.sMax : 1000;
  const pct = Math.max(0, Math.min(kMaxFramePowerPct, opts.powerPct));
  const sFrame = Math.round((pct / 100) * sMax);
  const frame = buildFrameContour(placed, opts.shape, Math.max(0, opts.marginMm ?? 0));
  const contours = frame ? [frame] : [];
  return emitLaserProgram(contours, {
    mode: LaserMode.CO2,
    cutFeed: opts.feed && opts.feed > 0 ? opts.feed : 1500,
    power: sFrame,
    sMax,
    passes: Math.max(1, Math.floor(opts.loops ?? 1)),
    powerMode: LaserPowerMode.Constant, // M3 constant — NEVER M4 for framing
    useFocusZ: false, // no Z move for a frame
    pierce: false, // no pierce dwell
    airAssist: false,
    rotary: false,
    decimals: opts.decimals ?? 3,
    programName:
      opts.programName ?? `karmyogi Laser FRAME (low power ${fmt(pct, 1)}%) — ${opts.shape}`,
  });
}

/**
 * Single GRBL command for a stationary low-power FOCUS DOT: constant-power M3 at
 * a low, operator-set S so a diode/CO2 head shows a faint dot for manual
 * focusing. M3 (constant) is REQUIRED — in GRBL laser mode M4 (dynamic) only
 * fires during motion, so a stationary dot needs constant power. Power is
 * clamped to the same low framing ceiling. Pair with {@link kLaserOffCommand}.
 */
export function laserDotOnCommand(powerPct: number, sMax = 1000): string {
  const max = sMax > 0 ? sMax : 1000;
  const pct = Math.max(0, Math.min(kMaxFramePowerPct, powerPct));
  const s = Math.round((pct / 100) * max);
  return `M3 S${s}`;
}
