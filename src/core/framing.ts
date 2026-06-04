// Laser/CNC framing helper — UI-independent.
// Pure TypeScript: no React/DOM/three.js imports (mirrors the src/core/ split).
//
// "Framing" (a.k.a. frame / outline trace) traces the XY bounding rectangle of
// a job so the operator can see exactly what area will be cut/engraved BEFORE
// committing to the run, and can reposition the stock / work-zero if the job is
// off-bed or clipping.
//
// This module is GENERIC (used by carving AND laser):
//   - `boundsOf(polylines)` / `frameBoundsOfGcode(lines)` compute the XY bounds.
//   - `buildFrameProgram(bounds, opts)` emits a SAFE motion-only perimeter trace
//     (safe-Z, no spindle, no laser power) — for carving / pen / generic use.
//   - `frameProgram(bbox, opts)` emits a laser-flavoured trace (optionally at a
//     faint power, bracketed by `M5 S0`) — for the Laser tab.
// All output is modal, `G21 G90`, and never emits "-0.000".

import { BBox, Polyline } from './geometry';

/** Formatted number, never "-0.000" — mirrors the emitter / soldering fmt(). */
function fmt(value: number, decimals: number): string {
  const snap = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(decimals);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Default S-value ceiling (GRBL's $30), matching laserCam. */
const kDefaultSMax = 1000;

// ===========================================================================
// XY bounds helpers
// ===========================================================================

/** XY bounding box across all polyline vertices (reuses geometry's BBox). */
export function boundsOf(polylines: Polyline[]): BBox {
  const b = new BBox();
  for (const pl of polylines) for (const p of pl.points) b.expand(p);
  return b;
}

/** Strip `;` line comments and `( … )` inline comments from one G-code line. */
function stripComments(line: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === ';' && depth === 0) break;
    if (c === '(') {
      depth++;
      continue;
    }
    if (c === ')') {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0) out += c;
  }
  return out;
}

/**
 * Scan a G-code program (array of lines) for the XY bounding box of every
 * commanded position. Self-contained (no viewer imports): a tiny modal X/Y scan
 * that tracks G90/G91 distance mode and carries unspecified axis words forward
 * (the same modal rules the viewer parser uses), but only what's needed for an
 * XY bounding box — arcs are bounded by their endpoints (a slight under-estimate
 * for bulging arcs, acceptable for a perimeter preview).
 *
 * Returns null when the program contains no XY motion (nothing to frame).
 */
export function frameBoundsOfGcode(lines: string[]): BBox | null {
  const bbox = new BBox();
  let x = 0;
  let y = 0;
  let absolute = true; // G90 default
  let any = false;

  const wordRe = /([A-Za-z])\s*([-+]?\d*\.?\d+)/g;

  for (const raw of lines) {
    const line = stripComments(raw).trim();
    if (line === '') continue;

    let sawX: number | undefined;
    let sawY: number | undefined;

    wordRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = wordRe.exec(line)) !== null) {
      const letter = m[1].toUpperCase();
      const value = parseFloat(m[2]);
      if (letter === 'G') {
        if (value === 90) absolute = true;
        else if (value === 91) absolute = false;
      } else if (letter === 'X') {
        sawX = value;
      } else if (letter === 'Y') {
        sawY = value;
      }
    }

    if (sawX === undefined && sawY === undefined) continue;

    // Resolve the target X/Y (modal: an unspecified axis carries forward).
    if (sawX !== undefined) x = absolute ? sawX : x + sawX;
    if (sawY !== undefined) y = absolute ? sawY : y + sawY;
    bbox.expand({ x, y });
    any = true;
  }

  return any && bbox.isValid() ? bbox : null;
}

// ===========================================================================
// Generic SAFE motion-only frame (carving / pen / any mode)
// ===========================================================================

/** Options controlling the safe motion-only perimeter trace. */
export interface BuildFrameOptions {
  /**
   * Safe Z (mm) the head travels at for the WHOLE frame — high enough to clear
   * the stock and any clamps. The trace never plunges below this. Default 5mm.
   */
  safeZ: number;
  /** Feed rate (mm/min) for the G1 perimeter moves. Default 1500. */
  feed: number;
  /**
   * Inset (+) / margin (−) on every side, mm. POSITIVE shrinks the traced
   * rectangle inward; NEGATIVE grows it outward (a margin so the trace clears
   * the part). Default 0 (trace the exact bounds).
   */
  margin: number;
  /** How many times to loop the perimeter. Clamped to >= 1. Default 1. */
  repeat: number;
  /** Coordinate precision (decimal places). Default 3. */
  decimals: number;
  /** Include explanatory comments. Default true. */
  comments: boolean;
}

export function defaultBuildFrameOptions(
  overrides: Partial<BuildFrameOptions> = {},
): BuildFrameOptions {
  return {
    safeZ: 5.0,
    feed: 1500,
    margin: 0,
    repeat: 1,
    decimals: 3,
    comments: true,
    ...overrides,
  };
}

/**
 * Build a SAFE perimeter-trace program for the given XY bounds.
 *
 * Motion only — NO spindle, NO laser power. The head lifts to `safeZ` first and
 * stays there for the whole trace (it never plunges). It rapids (G0) to the
 * first corner, then feeds (G1) around the rectangle min,min → max,min →
 * max,max → min,max → min,min at `feed`, repeating `repeat` times, finishing
 * back at the start corner. Generic — works for carving, pen, or laser.
 *
 * Returns [] when the bounds are invalid/degenerate (zero area after the inset),
 * so the caller can guard the button.
 */
export function buildFrameProgram(
  bounds: BBox,
  opts: Partial<BuildFrameOptions> = {},
): string[] {
  const o = defaultBuildFrameOptions(opts);
  if (!bounds.isValid()) return [];

  // Apply the inset/margin: positive shrinks inward, negative grows outward.
  const minX = bounds.min.x + o.margin;
  const minY = bounds.min.y + o.margin;
  const maxX = bounds.max.x - o.margin;
  const maxY = bounds.max.y - o.margin;

  // Degenerate after inset (would invert or collapse) → nothing safe to frame.
  if (!(maxX > minX) || !(maxY > minY)) return [];

  const repeat = Math.max(1, Math.floor(o.repeat));
  const d = o.decimals;
  const f = (v: number) => fmt(v, d);

  const out: string[] = [];
  if (o.comments) {
    out.push('(Frame / perimeter trace — motion only, tool OFF)');
    out.push(
      `(bounds X${f(bounds.min.x)}..${f(bounds.max.x)} Y${f(bounds.min.y)}..${f(bounds.max.y)})`,
    );
  }
  // Modal setup: mm, absolute. (No spindle / no laser — pure framing.)
  out.push('G21');
  out.push('G90');
  // Guaranteed safe-Z lift BEFORE any XY travel.
  out.push(`G0 Z${f(o.safeZ)}`);
  // Rapid to the first corner at safe height.
  out.push(`G0 X${f(minX)} Y${f(minY)}`);

  // Feed around the rectangle `repeat` times, ending back at the start corner.
  const feedWord = `F${f(o.feed)}`;
  for (let r = 0; r < repeat; r++) {
    // The first feed move carries the F word; it stays modal afterwards.
    out.push(`G1 X${f(maxX)} Y${f(minY)}${r === 0 ? ` ${feedWord}` : ''}`);
    out.push(`G1 X${f(maxX)} Y${f(maxY)}`);
    out.push(`G1 X${f(minX)} Y${f(maxY)}`);
    out.push(`G1 X${f(minX)} Y${f(minY)}`);
  }

  return out;
}

// ===========================================================================
// Laser-flavoured frame (Laser tab) — optionally traces at a faint power
// ===========================================================================

/** Options for {@link frameProgram}. */
export interface FrameOptions {
  feed: number; // perimeter feed (mm/min) when tracing at power
  powerPct?: number; // small >0 → trace at low power (G1); 0/undefined → G0 rapids, beam off
  sMax?: number; // S value at 100% (GRBL $30); default 1000
  loops?: number; // repeat the rectangle N times (default 1)
  mode?: 'M3' | 'M4'; // laser on mode when tracing at power (default M3)
  decimals?: number; // coordinate precision (default 3)
  programName?: string; // leading comment
}

/**
 * Generate a G-code program that walks the machine around the job's XY bounding
 * RECTANGLE: (minX,minY) → (maxX,minY) → (maxX,maxY) → (minX,maxY) → close.
 *
 * If `powerPct` is a small >0 value, the perimeter is traced at that low power
 * with `G1` at `feed` (so a diode laser shows a faint visible tracing dot);
 * otherwise the head moves with `G0` rapids and the laser OFF (motion only).
 * `loops` repeats the rectangle (default 1). The program ALWAYS starts and ends
 * with `M5 S0` so the beam is off before and after the trace. Output is modal,
 * `G21 G90`, and never emits "-0.000". The returned string is streamed to the
 * controller by the UI.
 */
export function frameProgram(bbox: BBox, opts: FrameOptions): string {
  const d = opts.decimals ?? 3;
  const sMax = opts.sMax && opts.sMax > 0 ? opts.sMax : kDefaultSMax;
  const loops = Math.max(1, Math.floor(opts.loops ?? 1));
  const mode = opts.mode ?? 'M3';
  const pct = clamp(opts.powerPct ?? 0, 0, 100);
  const trace = pct > 0; // trace at power (G1) vs move only (G0)
  const sOn = Math.round((pct / 100) * sMax);

  const o: string[] = [];

  if (opts.programName && opts.programName.length > 0) o.push(`(${opts.programName})`);
  o.push('(Generated by karmyogi Framing — traces the XY bounding box)');

  // An invalid/empty bbox yields a safe no-op frame: still bracket with M5 S0.
  if (!bbox.isValid()) {
    o.push('G21');
    o.push('G90');
    o.push('M5 S0');
    o.push('M5');
    o.push('M30');
    return o.join('\n') + '\n';
  }

  const x0 = bbox.min.x;
  const y0 = bbox.min.y;
  const x1 = bbox.max.x;
  const y1 = bbox.max.y;
  // Corner order: BL → BR → TR → TL → back to BL.
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];

  if (trace) {
    o.push(`(Trace at ${fmt(pct, 1)}% -> S${sOn} of ${sMax}, mode ${mode})`);
  } else {
    o.push('(Move only — laser OFF, G0 rapids)');
  }

  // ---- Header -----------------------------------------------------------
  o.push('G21'); // mm
  o.push('G90'); // absolute
  o.push('M5 S0'); // beam OFF at start (safety)

  // Position at the first corner with the beam OFF regardless of mode.
  o.push(`G0 X${fmt(x0, d)} Y${fmt(y0, d)} S0`);
  if (trace) o.push(`${mode} S${sOn}`); // enable the faint tracing beam

  let lastFeed = -1;
  for (let loop = 0; loop < loops; ++loop) {
    if (loops > 1) o.push(`(Loop ${loop + 1} of ${loops})`);
    // From the current corner (BL), walk BR → TR → TL → BL.
    const seq: Array<[number, number]> = [corners[1], corners[2], corners[3], corners[0]];
    for (const [x, y] of seq) {
      if (trace) {
        let line = `G1 X${fmt(x, d)} Y${fmt(y, d)}`;
        if (Math.abs(opts.feed - lastFeed) > 1e-6) {
          line += ` F${fmt(opts.feed, d)}`;
          lastFeed = opts.feed;
        }
        o.push(line);
      } else {
        o.push(`G0 X${fmt(x, d)} Y${fmt(y, d)}`);
      }
    }
  }

  // ---- Footer -----------------------------------------------------------
  if (trace) o.push('S0'); // power to zero before turning off
  o.push('M5'); // laser fully off (safety)
  o.push('M30');

  return o.join('\n') + '\n';
}
