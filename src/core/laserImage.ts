// Laser raster (image) engraving — UI-independent, pure TypeScript.
// No React / DOM / three.js imports here (mirrors the cadcam lib split): the
// caller decodes the image to RGBA pixels (canvas) and hands us a plain
// Uint8ClampedArray; everything below — grayscale, tonal adjustments, dithering,
// and PWM raster G-code emission — is pure and testable without a browser.
//
// Pairs with `laser.ts` (vector cutting) and reuses the SAME GRBL laser safety
// scheme:
//   * GRBL laser mode ($32=1) assumed so S changes take effect with motion.
//   * ALL travel/positioning uses G0 with S0 (beam OFF). M5 asserted at start
//     and end. The beam is gated by S/M3/M4/M5 — never by Z.
//   * White → S-MIN, black → S-MAX (NOT 0 → full): we map the engraved tone to a
//     power band the operator controls. Travel power is always 0.
//   * M4 (dynamic) vs M3 (constant) is operator-selectable (L5).
//   * Overscan (L6): the head accelerates OUTSIDE the image margin so edge
//     pixels burn at the commanded feed (no edge over-burn at turnarounds).

/** Pixel-processing pipeline adjustments applied before dithering. */
export interface ImageAdjust {
  /** -100..100 — additive brightness. */
  brightness: number;
  /** -100..100 — contrast around mid-grey. */
  contrast: number;
  /** 0.1..3 — gamma (1 = linear; <1 darkens mids, >1 lightens). */
  gamma: number;
  /** Invert tones (black ⇄ white) before dithering. */
  invert: boolean;
}

export function defaultImageAdjust(): ImageAdjust {
  return { brightness: 0, contrast: 0, gamma: 1, invert: false };
}

/** Dithering / halftone algorithm. */
export enum DitherMode {
  /** Hard threshold at 50% — pure 1-bit on/off. */
  Threshold = 'threshold',
  /** Ordered 8×8 Bayer matrix. */
  Ordered = 'ordered',
  /** Floyd–Steinberg error diffusion (the classic). */
  FloydSteinberg = 'floyd',
  /** Jarvis–Judice–Ninke error diffusion (smoother, wider kernel). */
  Jarvis = 'jarvis',
  /** Stucki error diffusion. */
  Stucki = 'stucki',
  /** Atkinson error diffusion (high-contrast, partial diffusion). */
  Atkinson = 'atkinson',
  /** Newsprint / clustered-dot halftone (round dots on a grid). */
  Newsprint = 'newsprint',
  /** No dithering — variable power proportional to greyscale (3D-ish depth). */
  Grayscale = 'grayscale',
}

/** Scan direction for the raster sweep. */
export enum ScanAngle {
  /** Horizontal scan lines (sweep along X, step along Y). */
  Horizontal = 0,
  /** Vertical scan lines (sweep along Y, step along X). */
  Vertical = 90,
}

/**
 * A working grayscale image: row-major luminance 0..255 (0 = black/burn,
 * 255 = white/skip), `w`×`h` pixels.
 */
export interface GrayImage {
  w: number;
  h: number;
  /** length === w*h, 0..255. */
  data: Uint8ClampedArray;
}

/**
 * Convert RGBA pixels (length w*h*4, e.g. from `ctx.getImageData`) to a
 * grayscale luminance image, applying tonal adjustments. Transparent pixels are
 * composited onto white (so transparency reads as "skip / no burn").
 *
 * Luminance uses Rec. 601 (0.299/0.587/0.114) — the LightBurn/LaserGRBL default.
 */
export function rgbaToGray(
  rgba: Uint8ClampedArray | Uint8Array | number[],
  w: number,
  h: number,
  adj: ImageAdjust = defaultImageAdjust(),
): GrayImage {
  const n = w * h;
  const out = new Uint8ClampedArray(n);
  // Precompute the brightness/contrast/gamma LUT over 0..255 for speed.
  const lut = toneLUT(adj);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    const a = (rgba[i * 4 + 3] ?? 255) / 255;
    // Composite onto white background → transparent = white (skip).
    let lum = 0.299 * r + 0.587 * g + 0.114 * b;
    lum = lum * a + 255 * (1 - a);
    out[i] = lut[Math.round(lum)] ?? 0;
  }
  return { w, h, data: out };
}

/** Build a 0..255 → 0..255 tonal lookup table for brightness/contrast/gamma/invert. */
export function toneLUT(adj: ImageAdjust): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  const b = clamp(adj.brightness, -100, 100) * 2.55; // additive
  // Contrast factor (standard formula).
  const c = clamp(adj.contrast, -100, 100);
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = clamp(adj.gamma, 0.1, 3);
  const invGamma = 1 / gamma;
  for (let i = 0; i < 256; i++) {
    let v = i;
    // brightness
    v = v + b;
    // contrast around 128
    v = cf * (v - 128) + 128;
    // clamp before gamma
    v = clamp(v, 0, 255);
    // gamma
    v = 255 * Math.pow(v / 255, invGamma);
    v = clamp(v, 0, 255);
    if (adj.invert) v = 255 - v;
    lut[i] = Math.round(v);
  }
  return lut;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

// ---- 8×8 Bayer ordered-dither matrix (normalised 0..1 thresholds). ----------
const BAYER8 = buildBayer8();
function buildBayer8(): number[][] {
  // Recursive Bayer construction from the 2×2 base.
  let m: number[][] = [[0, 2], [3, 1]];
  for (let size = 2; size < 8; size *= 2) {
    const n = size * 2;
    const next: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = m[y][x] * 4;
        next[y][x] = v;
        next[y][x + size] = v + 2;
        next[y + size][x] = v + 3;
        next[y + size][x + size] = v + 1;
      }
    }
    m = next;
  }
  // Normalise to (0,1) thresholds.
  const denom = 64;
  return m.map((row) => row.map((v) => (v + 0.5) / denom));
}

// Error-diffusion kernels: [dx, dy, weight]; weights sum to `divisor`.
interface DiffKernel {
  divisor: number;
  taps: [number, number, number][];
}
const KERNELS: Record<string, DiffKernel> = {
  [DitherMode.FloydSteinberg]: {
    divisor: 16,
    taps: [
      [1, 0, 7],
      [-1, 1, 3],
      [0, 1, 5],
      [1, 1, 1],
    ],
  },
  [DitherMode.Jarvis]: {
    divisor: 48,
    taps: [
      [1, 0, 7], [2, 0, 5],
      [-2, 1, 3], [-1, 1, 5], [0, 1, 7], [1, 1, 5], [2, 1, 3],
      [-2, 2, 1], [-1, 2, 3], [0, 2, 5], [1, 2, 3], [2, 2, 1],
    ],
  },
  [DitherMode.Stucki]: {
    divisor: 42,
    taps: [
      [1, 0, 8], [2, 0, 4],
      [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2],
      [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1],
    ],
  },
  [DitherMode.Atkinson]: {
    // Atkinson diffuses only 6/8 of the error (the rest is intentionally lost,
    // giving the crisp high-contrast look).
    divisor: 8,
    taps: [
      [1, 0, 1], [2, 0, 1],
      [-1, 1, 1], [0, 1, 1], [1, 1, 1],
      [0, 2, 1],
    ],
  },
};

/**
 * Dither a grayscale image to a Float32 "burn map" 0..1, where 1 = full burn
 * (was black) and 0 = no burn (was white). For 1-bit modes the result is 0 or 1;
 * for Grayscale it is the continuous inverted luminance.
 */
export function dither(img: GrayImage, mode: DitherMode, newsCell = 4): Float32Array {
  const { w, h, data } = img;
  const n = w * h;
  const burn = new Float32Array(n);

  if (mode === DitherMode.Grayscale) {
    for (let i = 0; i < n; i++) burn[i] = 1 - data[i] / 255;
    return burn;
  }

  if (mode === DitherMode.Threshold) {
    for (let i = 0; i < n; i++) burn[i] = data[i] < 128 ? 1 : 0;
    return burn;
  }

  if (mode === DitherMode.Ordered) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = BAYER8[y & 7][x & 7];
        burn[y * w + x] = data[y * w + x] / 255 < t ? 1 : 0;
      }
    }
    return burn;
  }

  if (mode === DitherMode.Newsprint) {
    return newsprint(img, Math.max(2, Math.floor(newsCell)));
  }

  // Error diffusion. Work on a float copy so error can push values out of 0..255.
  const kernel = KERNELS[mode];
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = data[i];
  for (let y = 0; y < h; y++) {
    // Serpentine scan halves directional artifacts and matches the bidirectional
    // raster sweep; flip the kernel's X taps on right-to-left rows.
    const ltr = (y & 1) === 0;
    const xStart = ltr ? 0 : w - 1;
    const xEnd = ltr ? w : -1;
    const xStep = ltr ? 1 : -1;
    for (let x = xStart; x !== xEnd; x += xStep) {
      const idx = y * w + x;
      const old = buf[idx];
      const newV = old < 128 ? 0 : 255;
      burn[idx] = old < 128 ? 1 : 0;
      const err = old - newV;
      for (const [dx, dy, wgt] of kernel.taps) {
        const sx = x + (ltr ? dx : -dx);
        const sy = y + dy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        buf[sy * w + sx] += (err * wgt) / kernel.divisor;
      }
    }
  }
  return burn;
}

/**
 * Clustered-dot (newsprint) halftone: each cell of a fixed grid gets a round dot
 * whose radius grows as the cell darkens. Classic print look; gives big visible
 * dots that survive low-DPI engraving.
 */
function newsprint(img: GrayImage, cell = 4): Float32Array {
  const { w, h, data } = img;
  const burn = new Float32Array(w * h);
  const half = cell / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Average the cell's luminance.
      const cx = Math.floor(x / cell) * cell;
      const cy = Math.floor(y / cell) * cell;
      let sum = 0;
      let cnt = 0;
      for (let j = 0; j < cell && cy + j < h; j++) {
        for (let i = 0; i < cell && cx + i < w; i++) {
          sum += data[(cy + j) * w + (cx + i)];
          cnt++;
        }
      }
      const lum = cnt > 0 ? sum / cnt / 255 : 1;
      // Darkness 0..1 → dot radius. Centre of the cell.
      const darkness = 1 - lum;
      const maxR = half * Math.SQRT2;
      const r = darkness * maxR;
      const dx = x - (cx + half) + 0.5;
      const dy = y - (cy + half) + 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      burn[y * w + x] = dist <= r ? 1 : 0;
    }
  }
  return burn;
}

/** Render a burn map (0..1) to an RGBA preview (white bg, grey burn). */
export function burnToRGBA(burn: Float32Array, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round((1 - burn[i]) * 255); // 1 burn → 0 (black)
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Raster engraving parameters (geometry, feeds, power band). */
export interface RasterParams {
  /** Engraved output width in mm (height derived from image aspect). */
  widthMm: number;
  /** Engraved output height in mm. */
  heightMm: number;
  /** Origin of the engraving (work coords) — bottom-left corner. */
  originX: number;
  originY: number;

  /** Line interval (mm between scan lines) — derived from DPI in the UI. */
  lineInterval: number;
  /** Scan direction. */
  scanAngle: ScanAngle;
  /** Overscan margin (mm) added at each end of a scan line for accel/decel. */
  overscan: number;
  /** Bidirectional (scan both directions) vs unidirectional (always L→R). */
  bidirectional: boolean;

  /** Engraving feed (mm/min). */
  feed: number;
  /** Constant (M3) vs dynamic (M4) power. */
  dynamicPower: boolean;
  /** S value for white (lightest burn). */
  sMin: number;
  /** S value for black (darkest burn). */
  sMax: number;
  /** Minimum burn fraction below which a pixel is treated as blank (skip). */
  threshold: number;

  /** Number of passes. */
  passes: number;
  /** Z step applied per pass (mm, e.g. focus stepping). 0 = none. */
  zPerPass: number;
  /** Apply a focus Z at program start. */
  useFocusZ: boolean;
  focusZ: number;

  /** Coordinate precision. */
  decimals: number;
  programName: string;
}

export function defaultRasterParams(overrides: Partial<RasterParams> = {}): RasterParams {
  return {
    widthMm: 80,
    heightMm: 60,
    originX: 0,
    originY: 0,
    lineInterval: 0.1, // ~254 DPI
    scanAngle: ScanAngle.Horizontal,
    overscan: 2,
    bidirectional: true,
    feed: 3000,
    dynamicPower: true,
    sMin: 0,
    sMax: 1000,
    threshold: 0.004,
    passes: 1,
    zPerPass: 0,
    useFocusZ: false,
    focusZ: 0,
    decimals: 3,
    programName: 'hjLabs Laser Raster',
    ...overrides,
  };
}

/** Convert DPI (dots/inch) to a line interval (mm). */
export function dpiToInterval(dpi: number): number {
  if (dpi <= 0) return 0.1;
  return 25.4 / dpi;
}
/** Convert a line interval (mm) to DPI. */
export function intervalToDpi(interval: number): number {
  if (interval <= 0) return 254;
  return 25.4 / interval;
}

/** Formatted number, never "-0.000" — mirrors the emitter's fmt(). */
function fmt(value: number, decimals: number): string {
  const d = Number.isFinite(decimals) ? Math.max(0, Math.min(8, Math.floor(decimals))) : 3;
  const snap = 0.5 * Math.pow(10, -d);
  if (Math.abs(value) < snap) value = 0;
  if (value === 0) value = 0;
  return value.toFixed(d);
}

/**
 * Map a burn fraction (0..1) to an S value: white (0) → sMin, black (1) → sMax.
 * Rounded to an integer. Below `threshold` the caller treats the pixel as blank.
 */
function burnToS(burn: number, sMin: number, sMax: number): number {
  return Math.round(sMin + burn * (sMax - sMin));
}

/** Summary stats for the UI. */
export interface RasterResult {
  gcode: string;
  /** Total non-comment line count. */
  lines: number;
  /** Total travel + burn path length (mm), all passes. */
  pathLengthMm: number;
  /** Estimated time (seconds). */
  timeSeconds: number;
  /** Scan-line count (one direction, single pass). */
  scanLines: number;
}

/**
 * Emit a complete, safe PWM raster-engraving G-code program from a burn map.
 *
 * The burn map is row-major, `w`×`h`, 0..1 (1 = darkest). Row 0 is the TOP of the
 * image; we flip Y so the engraving sits the right way up in work coordinates
 * (origin bottom-left). Each scan line emits runs of constant S (run-length
 * encoded) — within a run the head moves at the engraving feed firing at the
 * mapped power; blank gaps move with the beam OFF (S0) at the same feed so timing
 * stays even (LightBurn behaviour). Overscan extends past each end with S0 so the
 * machine reaches feed before the first lit pixel.
 */
export function emitRasterProgram(
  burn: Float32Array,
  w: number,
  h: number,
  params: Partial<RasterParams> = {},
): RasterResult {
  const p = defaultRasterParams(params);
  const d = p.decimals;
  const o: string[] = [];
  const onCode = p.dynamicPower ? 'M4' : 'M3';

  const interval = Math.max(0.001, p.lineInterval);
  const widthMm = Math.max(0.001, p.widthMm);
  const heightMm = Math.max(0.001, p.heightMm);
  const sMin = Math.max(0, Math.round(p.sMin));
  const sMax = Math.max(sMin, Math.round(p.sMax));
  const passes = Math.max(1, Math.floor(p.passes));
  const vertical = p.scanAngle === ScanAngle.Vertical;

  // Pixel pitch in mm for each axis.
  const pxW = widthMm / w;
  const pxH = heightMm / h;

  // ---- Header -------------------------------------------------------------
  if (p.programName.length > 0) o.push(`(${p.programName})`);
  o.push('(Generated by karmyogi.hjLabs.in Laser raster engraving)');
  o.push('(Requires GRBL laser mode: $32=1)');
  o.push(`(${w}x${h}px -> ${fmt(widthMm, 2)}x${fmt(heightMm, 2)}mm, interval ${fmt(interval, 4)}mm)`);
  o.push('G21');
  o.push('G90');
  o.push('G94');
  o.push('G17');
  o.push('M5 S0'); // beam OFF
  if (p.useFocusZ) {
    o.push('(Focus height)');
    o.push(`G0 Z${fmt(Math.max(0, p.focusZ), d)}`);
  }

  let pathLen = 0;
  let scanLineCount = 0;
  let dir = 1; // 1 = forward (L→R or B→T), -1 = reverse

  // Power-map helper: returns S for a pixel, or -1 when below threshold (blank).
  const sAt = (col: number, row: number): number => {
    const b = burn[row * w + col];
    if (b <= p.threshold) return -1;
    return burnToS(b, sMin, sMax);
  };

  for (let pass = 0; pass < passes; pass++) {
    if (passes > 1) o.push(`(Pass ${pass + 1}/${passes})`);
    if (p.zPerPass !== 0 && pass > 0) {
      o.push(`G0 Z${fmt(Math.max(0, p.focusZ) + p.zPerPass * pass, d)}`);
    }
    o.push(`${onCode} S0`); // assert on-mode with zero power; S rides on motion

    if (!vertical) {
      // ---- Horizontal scan lines (sweep X, step Y). Iterate image rows. -----
      // Image row 0 is the top → highest Y. We step from the bottom row up so
      // travel between passes is small and the picture is upright.
      const nLines = Math.ceil(heightMm / interval);
      for (let li = 0; li < nLines; li++) {
        const yMm = p.originY + li * interval;
        if (yMm > p.originY + heightMm) break;
        // Which image row maps to this Y (flip: bottom of image = last row).
        const row = clampInt(h - 1 - Math.floor((li * interval) / pxH), 0, h - 1);
        scanLineCount++;
        dir = p.bidirectional ? (li & 1 ? -1 : 1) : 1;
        pathLen += emitScanLine(o, sAt, {
          axisSweep: 'X',
          axisStep: 'Y',
          fixed: yMm,
          start: p.originX,
          pxPitch: pxW,
          count: w,
          rowOrCol: row,
          isRow: true,
          dir,
          overscan: p.overscan,
          feed: p.feed,
          d,
        });
      }
    } else {
      // ---- Vertical scan lines (sweep Y, step X). Iterate image cols. -------
      const nLines = Math.ceil(widthMm / interval);
      for (let li = 0; li < nLines; li++) {
        const xMm = p.originX + li * interval;
        if (xMm > p.originX + widthMm) break;
        const col = clampInt(Math.floor((li * interval) / pxW), 0, w - 1);
        scanLineCount++;
        dir = p.bidirectional ? (li & 1 ? -1 : 1) : 1;
        pathLen += emitScanLine(o, sAt, {
          axisSweep: 'Y',
          axisStep: 'X',
          fixed: xMm,
          start: p.originY,
          pxPitch: pxH,
          count: h,
          rowOrCol: col,
          isRow: false,
          dir,
          overscan: p.overscan,
          feed: p.feed,
          d,
        });
      }
    }
    o.push('S0 M5');
  }

  // ---- Footer -------------------------------------------------------------
  o.push('G0 X0 Y0 S0'); // park
  o.push('M5 S0');
  o.push('M30');

  const gcode = o.join('\n') + '\n';
  const timeSeconds = p.feed > 0 ? (pathLen / p.feed) * 60 : 0;
  return {
    gcode,
    lines: gcode.split('\n').filter((l) => l.trim() && !l.trim().startsWith('(')).length,
    pathLengthMm: pathLen,
    timeSeconds,
    scanLines: scanLineCount,
  };
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(n);
  return v < lo ? lo : v > hi ? hi : v;
}

interface ScanCfg {
  axisSweep: 'X' | 'Y';
  axisStep: 'X' | 'Y';
  /** Fixed coordinate value of the step axis for this line. */
  fixed: number;
  /** World start (origin) of the sweep axis. */
  start: number;
  /** mm per pixel along the sweep axis. */
  pxPitch: number;
  /** Pixel count along the sweep axis. */
  count: number;
  /** Image row (horizontal) or column (vertical) to sample. */
  rowOrCol: number;
  /** True if sampling a row (sweep over columns); false → sweep over rows. */
  isRow: boolean;
  /** +1 forward, -1 reverse. */
  dir: number;
  overscan: number;
  feed: number;
  d: number;
}

/**
 * Emit ONE scan line. Returns the path length contributed (mm). Builds run-length
 * runs of constant S, moving G1 with the laser firing (S>0) over lit runs and G1
 * with S0 over blanks. Overscan pads both ends (G0 to the start of overscan, then
 * the lit sweep). Reverse direction sweeps high→low.
 */
function emitScanLine(
  o: string[],
  sAt: (col: number, row: number) => number,
  c: ScanCfg,
): number {
  // Build the per-pixel S array along the sweep axis (in image order 0..count-1).
  const sArr = new Int32Array(c.count);
  let anyLit = false;
  for (let i = 0; i < c.count; i++) {
    // Build sArr in WORLD order (index i ↔ coordAt(i)). For a row sweep the step
    // axis is X (columns left→right, no flip). For a column (vertical) sweep the
    // step axis is Y: world Y increases upward from `start`, but image row 0 is
    // the TOP, so sample the flipped row (count-1-i) — otherwise the engrave is
    // mirrored in Y vs the preview and vs horizontal-scan output.
    const s = c.isRow ? sAt(i, c.rowOrCol) : sAt(c.rowOrCol, c.count - 1 - i);
    sArr[i] = s;
    if (s > 0) anyLit = true;
  }
  if (!anyLit) return 0; // skip wholly-blank scan lines (huge speed-up)

  // Find the lit span so overscan hugs the content, not the whole bed width.
  let firstLit = 0;
  let lastLit = c.count - 1;
  while (firstLit < c.count && sArr[firstLit] <= 0) firstLit++;
  while (lastLit >= 0 && sArr[lastLit] <= 0) lastLit--;

  // Sweep-axis world coordinate of a pixel's LEADING edge (cell start).
  const coordAt = (i: number) => c.start + i * c.pxPitch;
  const fixedWord = `${c.axisStep}${fmt(c.fixed, c.d)}`;
  const reverse = c.dir < 0;

  // World extents of the lit content (cell edges).
  const litLo = coordAt(firstLit);
  const litHi = coordAt(lastLit + 1);

  // Overscan-padded start/end in world coords (sweep direction aware).
  const osLo = litLo - c.overscan;
  const osHi = litHi + c.overscan;

  const sweep = c.axisSweep;
  const fmtN = (v: number) => fmt(v, c.d);

  // G0 (beam off) to the start of the overscan run, at the fixed step coord.
  const startCoord = reverse ? osHi : osLo;
  o.push(`G0 ${sweep}${fmtN(startCoord)} ${fixedWord} S0`);

  let pathLen = c.overscan; // overscan accel run

  // Walk the lit span in sweep order, run-length encoding constant S.
  const order: number[] = [];
  if (!reverse) {
    for (let i = firstLit; i <= lastLit; i++) order.push(i);
  } else {
    for (let i = lastLit; i >= firstLit; i--) order.push(i);
  }

  let k = 0;
  let lastS = -999;
  let firstFeed = true;
  // Feed word, emitted only on the first G1 of the scan line (modal afterwards).
  const feedWord = () => {
    if (firstFeed) {
      firstFeed = false;
      return ` F${fmtN(c.feed)}`;
    }
    return '';
  };
  while (k < order.length) {
    const i = order[k];
    const s = sArr[i] > 0 ? sArr[i] : 0; // blanks burn at S0
    // Extend the run while S is constant.
    let j = k + 1;
    while (j < order.length) {
      const sj = sArr[order[j]] > 0 ? sArr[order[j]] : 0;
      if (sj !== s) break;
      j++;
    }
    // The run covers pixels order[k..j-1]; emit a G1 to the run's trailing edge.
    const lastPix = order[j - 1];
    const edge = reverse ? coordAt(lastPix) : coordAt(lastPix + 1);
    if (s !== lastS) {
      o.push(`S${s} G1 ${sweep}${fmtN(edge)}${feedWord()}`);
      lastS = s;
    } else {
      o.push(`G1 ${sweep}${fmtN(edge)}`);
    }
    pathLen += Math.abs((j - k)) * c.pxPitch;
    k = j;
  }

  // Trailing overscan run (beam off).
  const endCoord = reverse ? osLo : osHi;
  o.push(`S0 G1 ${sweep}${fmtN(endCoord)}${feedWord()}`);
  pathLen += c.overscan;

  return pathLen;
}
