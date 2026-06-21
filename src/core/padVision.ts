/**
 * Camera-based solder-PAD DETECTION — UI-independent, pure TypeScript.
 *
 * NO React / DOM / three.js imports. The ONLY browser type referenced is
 * `ImageData` (a structural { data, width, height }) — the caller decodes a
 * camera frame to RGBA pixels (canvas `getImageData`) and hands us that buffer;
 * everything below — grayscale, Otsu threshold, connected-component labelling,
 * shape filtering, centroid + radius — is pure and testable headless (the node
 * harness builds a plain `{ data, width, height }` object).
 *
 * Mirrors the `src/core/` separation (geometry / cam / laserImage all stay
 * portable). Reuses the Rec.601 luma weights of `laserImage.rgbaToGray` /
 * `cameraCalib.toGray`. The detector is DETERMINISTIC: same image + opts → same
 * pads, in a stable (top-to-bottom, left-to-right) order.
 *
 * Pipeline (classic blob detection — no external CV dependency):
 *   1. RGBA → grayscale luminance (Rec.601).
 *   2. Threshold to a binary mask. By default the THRESHOLD is auto-chosen by
 *      Otsu's method (maximizes between-class variance); the caller may force a
 *      fixed 0..255 threshold, and `invert` flips which side is "foreground"
 *      (bright metallic pads on a dark board → bright is foreground = default;
 *      dark pads on a light board → set `invert`).
 *   3. Label 8-connected components of the foreground mask (iterative flood
 *      fill, no recursion).
 *   4. For each blob compute area, centroid, bounding box and an equivalent
 *      radius (√(area/π)); reject blobs outside the area band or too far from
 *      round (circularity from the bbox fill-ratio × aspect, so we need no
 *      contour tracing).
 *   5. Return the surviving pads sorted in raster (row-major) order.
 *
 * The area band is given in MILLIMETRES by the caller (real pad sizes are mm,
 * not px); we convert to a pixel area band using `pxPerMm` (px-per-mm at the bed
 * plane). When `pxPerMm` is omitted the band falls back to pixel units directly.
 */

/** A structural subset of the DOM `ImageData` — lets the node harness pass a
 *  plain object (no real `ImageData` constructor needed off-DOM). */
export interface RgbaImage {
  /** Packed RGBA, length `width*height*4`, 0..255. */
  data: Uint8ClampedArray | Uint8Array | number[];
  width: number;
  height: number;
}

/** One detected solder pad, in image-pixel space. */
export interface DetectedPad {
  /** Centroid X in pixels. */
  xPx: number;
  /** Centroid Y in pixels. */
  yPx: number;
  /** Equivalent radius in pixels (√(area/π)). */
  rPx: number;
  /** Blob area in pixels. */
  areaPx: number;
  /** Pixel bounding box of the blob. */
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  /** Circularity in [0,1] (1 = a perfect filled disc; lower = elongated/ragged). */
  circularity: number;
}

/** Tunables for {@link detectSolderPads}. */
export interface PadVisionOpts {
  /**
   * Pixels per millimetre at the bed plane (from the camera calibration). When
   * provided, `minPadMm`/`maxPadMm` are interpreted as pad DIAMETERS in mm and
   * converted to a pixel-area band. Omit (or ≤0) to use the pixel bands directly.
   */
  pxPerMm?: number;
  /** Smallest pad DIAMETER to keep (mm, when `pxPerMm` set; default 0.4 mm). */
  minPadMm?: number;
  /** Largest pad DIAMETER to keep (mm, when `pxPerMm` set; default 6 mm). */
  maxPadMm?: number;
  /** Direct pixel-area floor (used when `pxPerMm` is absent; default 8 px). */
  minAreaPx?: number;
  /** Direct pixel-area ceiling (used when `pxPerMm` is absent; default 1e9). */
  maxAreaPx?: number;
  /**
   * Fixed luminance threshold 0..255. When omitted (default) Otsu's method picks
   * it automatically from the image histogram.
   */
  threshold?: number;
  /**
   * Treat DARK pixels as the pad foreground instead of bright ones. Default
   * false (bright/metallic pads on a darker board). Set true for dark pads /
   * tinned holes on a light soldermask.
   */
  invert?: boolean;
  /**
   * Minimum circularity in [0,1] to keep a blob (default 0.55). Round pads score
   * high; scratches, traces and silkscreen text score low and are rejected.
   */
  minCircularity?: number;
  /** Cap the number of returned pads (largest-area first kept); default 4000. */
  maxPads?: number;
}

/** Optional debug info (off the hot path) for tuning the detector in the UI. */
export interface PadVisionDebug {
  /** The luminance threshold actually used (auto or forced). */
  threshold: number;
  /** Total connected components found before shape/area filtering. */
  blobsBeforeFilter: number;
  /** Foreground pixel count in the binary mask. */
  foregroundPx: number;
  /** The pixel-area band used for filtering. */
  areaBandPx: { min: number; max: number };
}

export interface PadVisionResult {
  pads: DetectedPad[];
  debug: PadVisionDebug;
}

/** Rec.601 luma (matches laserImage/cameraCalib). Composites alpha onto white. */
function luma(r: number, g: number, b: number, a: number): number {
  const l = 0.299 * r + 0.587 * g + 0.114 * b;
  const af = a / 255;
  return l * af + 255 * (1 - af);
}

/** Build a 256-bin grayscale histogram of the image. */
function histogram(img: RgbaImage): { hist: Uint32Array; gray: Uint8Array } {
  const { data, width, height } = img;
  const n = width * height;
  const gray = new Uint8Array(n);
  const hist = new Uint32Array(256);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const v = Math.round(
      luma(data[j] ?? 0, data[j + 1] ?? 0, data[j + 2] ?? 0, data[j + 3] ?? 255),
    );
    const c = v < 0 ? 0 : v > 255 ? 255 : v;
    gray[i] = c;
    hist[c]++;
  }
  return { hist, gray };
}

/**
 * Otsu's threshold: the 0..255 level that maximizes the between-class variance
 * of a grayscale histogram. Returns 127 for a degenerate (single-value/empty)
 * histogram. Pure and deterministic.
 */
export function otsuThreshold(hist: Uint32Array): number {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  if (total === 0) return 127;

  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Detect bright/metallic solder-pad blobs in a camera frame.
 *
 * @param image RGBA pixels (a DOM `ImageData` or any `{data,width,height}`).
 * @param opts  Tunables (see {@link PadVisionOpts}).
 * @returns The detected pads (pixel space) plus debug info. A blank / degenerate
 *   image yields `pads: []` and never throws.
 */
export function detectSolderPads(
  image: RgbaImage,
  opts: PadVisionOpts = {},
): PadVisionResult {
  const width = Math.max(0, Math.floor(image.width));
  const height = Math.max(0, Math.floor(image.height));
  const n = width * height;

  // --- Pixel-area band ------------------------------------------------------
  const ppm = opts.pxPerMm && opts.pxPerMm > 0 ? opts.pxPerMm : 0;
  let minArea: number;
  let maxArea: number;
  if (ppm > 0) {
    // Pad DIAMETER mm → pixel area of the equivalent disc (π·(d·ppm/2)²).
    const dMin = Math.max(0, opts.minPadMm ?? 0.4);
    const dMax = Math.max(dMin, opts.maxPadMm ?? 6);
    const areaOfDiaMm = (d: number) => Math.PI * Math.pow((d * ppm) / 2, 2);
    minArea = Math.max(4, areaOfDiaMm(dMin));
    maxArea = areaOfDiaMm(dMax);
  } else {
    minArea = Math.max(1, opts.minAreaPx ?? 8);
    maxArea = opts.maxAreaPx ?? 1e9;
  }
  const minCirc = opts.minCircularity ?? 0.55;
  const maxPads = Math.max(1, Math.floor(opts.maxPads ?? 4000));

  const emptyDebug: PadVisionDebug = {
    threshold: opts.threshold ?? 127,
    blobsBeforeFilter: 0,
    foregroundPx: 0,
    areaBandPx: { min: minArea, max: maxArea },
  };
  if (n === 0) return { pads: [], debug: emptyDebug };

  // --- Grayscale + threshold ------------------------------------------------
  const { hist, gray } = histogram(image);
  const threshold =
    opts.threshold != null && Number.isFinite(opts.threshold)
      ? Math.max(0, Math.min(255, Math.round(opts.threshold)))
      : otsuThreshold(hist);

  // Foreground = bright (>threshold) by default, or dark (<threshold) when inverted.
  const invert = !!opts.invert;
  const fg = new Uint8Array(n);
  let fgCount = 0;
  for (let i = 0; i < n; i++) {
    const on = invert ? gray[i] < threshold : gray[i] > threshold;
    if (on) {
      fg[i] = 1;
      fgCount++;
    }
  }

  // --- 8-connected component labelling (iterative flood fill) ---------------
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const pads: DetectedPad[] = [];
  let blobsBeforeFilter = 0;

  for (let start = 0; start < n; start++) {
    if (fg[start] !== 1 || visited[start] === 1) continue;
    blobsBeforeFilter++;

    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (sp > 0) {
      const idx = stack[--sp];
      const px = idx % width;
      const py = (idx - px) / width;
      area++;
      sumX += px;
      sumY += py;
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;

      // Visit the 8 neighbours.
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = px + dx;
          if (nx < 0 || nx >= width) continue;
          const nIdx = ny * width + nx;
          if (fg[nIdx] === 1 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            stack[sp++] = nIdx;
          }
        }
      }
    }

    if (area < minArea || area > maxArea) continue;

    // Circularity proxy: a filled disc fills π/4 ≈ 0.785 of its bounding box and
    // the bbox is ~square. We combine the bbox FILL ratio (area / bboxArea,
    // normalized by the ideal disc fill) with the bbox ASPECT ratio so a long
    // thin trace (high fill but skewed aspect) is rejected. No contour tracing
    // needed — robust and cheap. Result clamped to [0,1].
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const bboxArea = bw * bh;
    const fill = bboxArea > 0 ? area / bboxArea : 0;
    const fillScore = Math.min(1, fill / (Math.PI / 4)); // 1 when fill ≈ disc fill
    const aspect = bw >= bh ? bh / bw : bw / bh; // ≤1, →1 for square
    const circularity = Math.max(0, Math.min(1, fillScore * aspect));
    if (circularity < minCirc) continue;

    pads.push({
      xPx: sumX / area,
      yPx: sumY / area,
      rPx: Math.sqrt(area / Math.PI),
      areaPx: area,
      bbox: { minX, minY, maxX, maxY },
      circularity,
    });
  }

  // Cap by area (keep the biggest) when there are too many; then return in a
  // stable raster order (top→bottom, left→right) for a predictable review list.
  let kept = pads;
  if (pads.length > maxPads) {
    kept = pads.slice().sort((a, b) => b.areaPx - a.areaPx).slice(0, maxPads);
  }
  kept.sort((a, b) => a.yPx - b.yPx || a.xPx - b.xPx);

  return {
    pads: kept,
    debug: {
      threshold,
      blobsBeforeFilter,
      foregroundPx: fgCount,
      areaBandPx: { min: minArea, max: maxArea },
    },
  };
}
