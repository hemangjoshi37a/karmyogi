// Laser CAM G-code generator — UI-independent.
// Pure TypeScript: no React/DOM/three.js imports (mirrors the src/core/ split).
// Backs the upcoming "Laser Cutting" and "Laser Engraving" tabs.
//
// Machine model: a diode/CO2 laser driven by a GRBL controller in LASER MODE
// ($32=1). Beam power is the controller's "spindle" PWM output, set with the S
// word and switched on/off with M3 (constant power) / M4 (dynamic power, which
// scales the duty cycle with feed so corners and accelerations don't over-burn)
// and M5 (off). S0 also extinguishes the beam.
//
// SAFETY (critical): the laser MUST be OFF (M5 / S0) during every rapid/travel
// and at both program start AND end — the beam is never left on while moving
// between shapes or after the job finishes. Every program here opens with M5 S0
// and closes with S0 then M5. Like the rest of the CAM core we emit a
// G21/G90/G94/G17 header, keep words modal, and never produce "-0.000".

import { Point, Polyline } from './geometry';
import { offsetPolygon } from './offset';

/** Default S-value ceiling (GRBL's $30 "max spindle speed"). */
export const kDefaultSMax = 1000;

/** Formatted number, never "-0.000" — mirrors the emitter / soldering fmt(). */
function fmt(value: number, decimals: number): string {
  const snap = 0.5 * Math.pow(10, -decimals);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0; // collapse a residual signed zero
  return value.toFixed(decimals);
}

/** Clamp a number into [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Map a power percentage (0–100) to an integer S value given `sMax`. Out-of-range
 * percentages are clamped. The result is rounded to an integer because GRBL's
 * PWM resolution is integer S counts.
 */
export function powerToS(pct: number, sMax: number = kDefaultSMax): number {
  const p = clamp(pct, 0, 100);
  return Math.round((p / 100) * sMax);
}

// ---- Vector cutting / engraving -------------------------------------------

/**
 * Parameters for vector laser cutting. Distances are mm, feeds mm/min, power is
 * a 0–100 percentage mapped onto `sMax`.
 */
export interface LaserCutParams {
  feed: number; // cutting feed (mm/min)
  powerPct: number; // 0–100 % of sMax
  passes: number; // repeat all shapes N times (>=1)
  mode: 'M3' | 'M4'; // constant (M3) vs dynamic (M4) power
  sMax: number; // S value at 100% (GRBL $30)
  minPowerPct?: number; // floor power % (M4 minimum / S-min); default 0
  kerfMm?: number; // beam kerf width (mm); >0 enables offset compensation
  kerfSide?: 'outside' | 'inside' | 'none'; // which side to offset closed paths
  airAssist?: boolean; // M8/M9 air assist around the job
  passDownZ?: number; // lower Z by this each pass (focus stepping); mm
  safeZ?: number; // retract height used when passDownZ steps Z; mm
  decimals?: number; // coordinate precision (default 3)
  programName?: string; // leading comment
}

/** Parameters for raster (image) engraving. */
export interface LaserEngraveParams {
  feed: number; // scan feed (mm/min)
  powerPct: number; // 0–100 % of sMax (the darkest pixel's power)
  mode: 'M3' | 'M4'; // M4 (dynamic) recommended for rasters
  sMax: number; // S value at 100% (GRBL $30)
  lineIntervalMm?: number; // row pitch (mm); default = pxSizeMm
  bidirectional?: boolean; // scan alternate rows right→left
  overscanMm?: number; // lead-in/out past each row end (mm)
  threshold?: number; // gray 0–255 below which a pixel is "off" (skipped)
  invert?: boolean; // invert darkness (engrave the light areas)
  minPowerPct?: number; // floor power % for any burning pixel; default 0
  decimals?: number; // coordinate precision (default 3)
  programName?: string;
}

/** Resolve the optional cut params to concrete values. */
function resolveCut(params: LaserCutParams) {
  return {
    feed: params.feed,
    powerPct: params.powerPct,
    passes: Math.max(1, Math.floor(params.passes)),
    mode: params.mode,
    sMax: params.sMax > 0 ? params.sMax : kDefaultSMax,
    minPowerPct: params.minPowerPct ?? 0,
    kerfMm: params.kerfMm ?? 0,
    kerfSide: params.kerfSide ?? 'none',
    airAssist: params.airAssist ?? false,
    passDownZ: params.passDownZ ?? 0,
    safeZ: params.safeZ ?? 5.0,
    decimals: params.decimals ?? 3,
    programName: params.programName ?? '',
  };
}

/**
 * Apply kerf compensation to a single polyline. Open paths are cut on-line
 * (returned unchanged); closed paths are offset by half the kerf to the chosen
 * side so the finished part lands on its nominal dimension. Returns the original
 * polyline if the offset collapses.
 */
function applyKerf(
  poly: Polyline,
  kerfMm: number,
  side: 'outside' | 'inside' | 'none'
): Polyline {
  if (kerfMm <= 0 || side === 'none' || !poly.closed || poly.points.length < 3) return poly;
  // Positive delta grows the polygon outward, negative shrinks it (offset.ts
  // normalises winding internally), so the requested side maps directly.
  const delta = side === 'outside' ? kerfMm / 2 : -kerfMm / 2;
  const off = offsetPolygon(poly, delta);
  return off.points.length >= 3 ? off : poly;
}

/** Iterate a closed polyline's vertices, repeating the first point to close it. */
function* closedLoop(poly: Polyline): Generator<Point> {
  for (const p of poly.points) yield p;
  if (poly.closed && poly.points.length > 0) yield poly.points[0];
}

/**
 * Generate G-code that vector-cuts the given polylines with the laser.
 *
 * Sequencing per the safety contract:
 *  - header `G21 G90 G94 G17`, then `M5 S0` (laser guaranteed off), optional M8.
 *  - for each shape: `G0` rapid to the start WITH THE BEAM OFF (S0), then enable
 *    (`M3`/`M4 S<power>`) and `G1` along the points at `feed`; immediately drop
 *    to `S0` (off) before the next travel.
 *  - `passes` repeats every shape; with `passDownZ` the Z is lowered by that
 *    amount each pass (focus stepping) and retracted to `safeZ` at the end.
 *  - footer: `S0`, `M5`, optional `M9`.
 */
export function cutPolylines(polylines: Polyline[], params: LaserCutParams): string {
  const p = resolveCut(params);
  const d = p.decimals;
  const o: string[] = [];

  const sOn = powerToS(p.powerPct, p.sMax);
  const sMin = powerToS(p.minPowerPct, p.sMax);
  // Kerf-compensate up front so the geometry is stable across passes.
  const shapes = polylines
    .filter((pl) => pl.points.length >= 2)
    .map((pl) => applyKerf(pl, p.kerfMm, p.kerfSide));

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi Laser CAM — cut)');
  o.push(`(Laser mode ${p.mode}, power ${fmt(p.powerPct, 1)}% -> S${sOn} of ${p.sMax})`);
  o.push('G21'); // mm
  o.push('G90'); // absolute
  o.push('G94'); // feed per minute
  o.push('G17'); // XY plane
  o.push('M5 S0'); // beam OFF at start (safety)
  if (p.airAssist) o.push('M8'); // air assist on

  const usesZ = p.passDownZ !== 0;
  if (usesZ) o.push(`G0 Z${fmt(p.safeZ, d)}`); // known-safe focus height first

  // ---- Body -------------------------------------------------------------
  let lastFeed = -1;
  for (let pass = 0; pass < p.passes; ++pass) {
    if (p.passes > 1) o.push(`(Pass ${pass + 1} of ${p.passes})`);
    if (usesZ) {
      // Focus stepping: each pass drops below the previous one.
      const z = -(pass + 1) * p.passDownZ;
      o.push(`G0 Z${fmt(z, d)}`);
    }
    for (const shape of shapes) {
      const verts = Array.from(closedLoop(shape));
      if (verts.length < 2) continue;
      const start = verts[0];
      // Rapid to the start with the beam OFF (S0 guarantees no travel burn).
      o.push(`G0 X${fmt(start.x, d)} Y${fmt(start.y, d)} S0`);
      // Enable the beam for the cut. M4's S-min keeps dynamic power from hitting
      // zero mid-cut; for M3 we just set the constant power.
      if (p.mode === 'M4' && sMin > 0) o.push(`M4 S${sOn}`);
      else o.push(`${p.mode} S${sOn}`);
      lastFeed = -1; // force the feed word on the first cutting move of the run
      for (let i = 1; i < verts.length; ++i) {
        const v = verts[i];
        let line = `G1 X${fmt(v.x, d)} Y${fmt(v.y, d)}`;
        if (Math.abs(p.feed - lastFeed) > 1e-6) {
          line += ` F${fmt(p.feed, d)}`;
          lastFeed = p.feed;
        }
        o.push(line);
      }
      // Beam OFF before the next travel (safety).
      o.push('S0');
    }
  }

  // ---- Footer -----------------------------------------------------------
  if (usesZ) o.push(`G0 Z${fmt(p.safeZ, d)}`); // retract focus
  o.push('S0'); // power to zero
  o.push('M5'); // laser fully off
  if (p.airAssist) o.push('M9'); // air assist off
  o.push('M30');

  return o.join('\n') + '\n';
}

/**
 * Vector ENGRAVE: trace the outlines ONCE at the (typically lower) engrave
 * power/feed. This is `cutPolylines` with a single pass and no kerf
 * compensation — the beam stays exactly on the drawn line.
 */
export function engravePolylines(polylines: Polyline[], params: LaserCutParams): string {
  return cutPolylines(polylines, {
    ...params,
    passes: 1,
    kerfMm: 0,
    kerfSide: 'none',
    passDownZ: 0,
    programName: params.programName ?? 'karmyogi Laser Vector Engrave',
  });
}

// ---- Raster engraving ------------------------------------------------------

/** A grayscale image buffer (one byte per pixel, row-major, top row first). */
export interface GrayImage {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

function resolveEngrave(params: LaserEngraveParams, pxSizeMm: number) {
  return {
    feed: params.feed,
    powerPct: params.powerPct,
    mode: params.mode,
    sMax: params.sMax > 0 ? params.sMax : kDefaultSMax,
    lineIntervalMm: params.lineIntervalMm && params.lineIntervalMm > 0 ? params.lineIntervalMm : pxSizeMm,
    bidirectional: params.bidirectional ?? true,
    overscanMm: params.overscanMm ?? 0,
    threshold: params.threshold ?? 0,
    invert: params.invert ?? false,
    minPowerPct: params.minPowerPct ?? 0,
    decimals: params.decimals ?? 3,
    programName: params.programName ?? '',
  };
}

/**
 * Generate raster-engraving G-code for a grayscale image.
 *
 * The image's top row is data row 0; the machine scans BOTTOM-to-TOP so the
 * engraved result is upright relative to `originXY` (the bottom-left corner of
 * the engraved area). Each scan row advances by `lineIntervalMm`. Within a row
 * we walk pixels left→right (and right→left on alternate rows when
 * `bidirectional`); the S value is set proportional to darkness (white = off,
 * black = full power × powerPct). White/below-threshold runs are skipped with
 * the beam off. `overscanMm` adds a beam-off lead-in/out past each row end so
 * the servo is up to speed before the first burn and the row edges aren't
 * over-burned. The beam is off between rows and at program end. M4 (dynamic
 * power) is recommended so partial-power pixels track the feed.
 */
export function rasterEngrave(
  gray: GrayImage,
  originXY: { x: number; y: number },
  pxSizeMm: number,
  params: LaserEngraveParams
): string {
  const p = resolveEngrave(params, pxSizeMm);
  const d = p.decimals;
  const o: string[] = [];

  const w = gray.width;
  const h = gray.height;
  const sMaxPower = powerToS(p.powerPct, p.sMax); // S at the darkest pixel
  const sMin = powerToS(p.minPowerPct, p.sMax); // floor for any burning pixel

  // Darkness 0..1 for a data pixel (0=white, 1=black), honouring invert.
  const darknessAt = (col: number, dataRow: number): number => {
    const g = gray.data[dataRow * w + col] ?? 255;
    let dk = (255 - g) / 255; // black(0) -> 1, white(255) -> 0
    if (p.invert) dk = 1 - dk;
    return dk;
  };
  // Threshold as a darkness floor: pixels lighter than `threshold` gray are off.
  const offDarkness = p.threshold > 0 ? (255 - p.threshold) / 255 : 0;
  // S for a darkness value; 0 when below threshold/white.
  const sFor = (dk: number): number => {
    if (dk <= offDarkness || dk <= 0) return 0;
    const s = Math.round(dk * sMaxPower);
    if (s <= 0) return 0;
    return sMin > 0 ? Math.max(s, sMin) : s;
  };

  // ---- Header -----------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi Laser CAM — raster engrave)');
  o.push(`(${w}x${h}px @ ${fmt(pxSizeMm, 4)}mm/px, mode ${p.mode}, max S${sMaxPower} of ${p.sMax})`);
  o.push('G21');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5 S0'); // beam OFF at start (safety)

  const pitchRows = Math.max(1, Math.round(p.lineIntervalMm / pxSizeMm));
  let scanY = originXY.y;
  let lastFeed = -1;
  let leftToRight = true;
  let started = false; // have we enabled the laser at least once?

  // Walk data rows from the BOTTOM of the image (h-1) to the TOP (0); each
  // physical scan line steps +lineIntervalMm in Y.
  for (let dataRow = h - 1; dataRow >= 0; dataRow -= pitchRows) {
    // Collect this row's S samples in the travel direction.
    const order: number[] = [];
    for (let i = 0; i < w; ++i) order.push(leftToRight ? i : w - 1 - i);

    // Pixel X centre for column `col`. Pixel `col` spans [origin+col*px,
    // origin+(col+1)*px); we burn from one centre to the next.
    const xAt = (col: number): number => originXY.x + (col + 0.5) * pxSizeMm;

    // Skip fully-blank rows entirely (beam stays off, no motion emitted).
    let anyBurn = false;
    for (let i = 0; i < w; ++i) {
      if (sFor(darknessAt(i, dataRow)) > 0) {
        anyBurn = true;
        break;
      }
    }
    if (anyBurn) {
      const dir = leftToRight ? 1 : -1;
      const firstCol = order[0];
      // Beam-off rapid to the row start, including the overscan lead-in.
      const rowStartX = xAt(firstCol) - dir * p.overscanMm;
      if (!started) {
        // First active row: move into position with the beam off, then enable.
        o.push(`G0 X${fmt(rowStartX, d)} Y${fmt(scanY, d)} S0`);
        o.push(`${p.mode} S0`); // laser enabled but at zero power (off)
        started = true;
        lastFeed = -1;
      } else {
        o.push(`G0 X${fmt(rowStartX, d)} Y${fmt(scanY, d)} S0`);
      }

      // Lead-in: travel from the overscan-offset start to the first pixel centre
      // at feed with the beam off, so the axis is up to speed before the first
      // burn. With no overscan we start exactly on the first pixel centre.
      let lastS = -1;
      if (p.overscanMm > 0) {
        let line = `G1 X${fmt(xAt(firstCol), d)} S0`;
        lastS = 0;
        if (Math.abs(p.feed - lastFeed) > 1e-6) {
          line += ` F${fmt(p.feed, d)}`;
          lastFeed = p.feed;
        }
        o.push(line);
      }

      // Emit one G1 per pixel; S changes only when the burn level changes. The
      // first column is skipped when a lead-in already arrived at its centre —
      // we only need to set its S (handled by the next column's modal X).
      for (let idx = 0; idx < order.length; ++idx) {
        const col = order[idx];
        const s = sFor(darknessAt(col, dataRow));
        // First pixel after a lead-in: same X as the lead-in target, so emit an
        // S-only state change (no redundant zero-length move).
        if (idx === 0 && p.overscanMm > 0) {
          if (s !== lastS) {
            o.push(`S${s}`);
            lastS = s;
          }
          continue;
        }
        let line = `G1 X${fmt(xAt(col), d)}`;
        if (s !== lastS) {
          line += ` S${s}`;
          lastS = s;
        }
        if (Math.abs(p.feed - lastFeed) > 1e-6) {
          line += ` F${fmt(p.feed, d)}`;
          lastFeed = p.feed;
        }
        o.push(line);
      }

      // Lead-out: continue past the last pixel with the beam off (no over-burn).
      o.push('S0');
      if (p.overscanMm > 0) {
        const lastCol = order[order.length - 1];
        o.push(`G1 X${fmt(xAt(lastCol) + dir * p.overscanMm, d)}`);
      }

      if (p.bidirectional) leftToRight = !leftToRight;
    }

    scanY += p.lineIntervalMm;
  }

  // ---- Footer -----------------------------------------------------------
  o.push('S0'); // power to zero
  o.push('M5'); // laser fully off
  o.push('M30');

  return o.join('\n') + '\n';
}
