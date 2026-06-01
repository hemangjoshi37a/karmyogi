// Raster → vector tracing for the Signature feature. UI-independent (no DOM):
// operates on raw RGBA pixel data passed in by the caller.
//
// Pipeline:
//   1. traceBitmap()      — threshold RGBA → binary ink mask, then trace the
//                           contours of every ink region into closed polylines
//                           (Moore-neighbour boundary tracing). IMAGE coords
//                           (origin top-left, y-down, units = pixels).
//   2. simplifyPolyline() — Ramer–Douglas–Peucker point reduction.
//   3. fitPolylinesToSize() — uniform scale to a target mm box (preserve aspect)
//                           and flip Y so machine Y is up (origin bottom-left).
//
// Dependency-free and bounded: tracing skips already-visited boundaries and
// tiny specks, and simplification caps the point count to keep a typical
// signature at a sane size.

import { Point, Polyline, pt } from './geometry';

export interface TraceOptions {
  /** Luminance threshold 0..255. Pixels darker than this are ink. */
  threshold: number;
  /** Treat light pixels as ink instead (for dark-background images). */
  invert?: boolean;
  /**
   * Ignore traced contours shorter than this many boundary pixels (drops
   * isolated specks / JPEG noise). Defaults to 8.
   */
  minContourLength?: number;
}

/** Rec. 601 luma of an RGBA pixel (0..255). */
function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Threshold RGBA pixels into a binary ink mask. `mask[y*width + x]` is 1 for
 * ink, 0 otherwise. Fully-transparent pixels are never ink.
 */
function buildInkMask(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
  invert: boolean
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const a = pixels[p + 3];
    if (a < 8) {
      mask[i] = 0;
      continue;
    }
    const lum = luminance(pixels[p], pixels[p + 1], pixels[p + 2]);
    const ink = invert ? lum >= threshold : lum < threshold;
    mask[i] = ink ? 1 : 0;
  }
  return mask;
}

// Moore-neighbour offsets, clockwise starting from East. Used to walk a
// boundary while keeping the interior on a consistent side.
const NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
];

/**
 * Trace the outer boundary of an ink blob starting at (sx, sy) using
 * Moore-neighbour tracing with Jacob's stopping criterion. `visited` marks
 * boundary cells already emitted so each contour is traced once. Returns the
 * ordered list of boundary pixel coordinates (pixel centres).
 */
function traceContour(
  mask: Uint8Array,
  width: number,
  height: number,
  sx: number,
  sy: number,
  visited: Uint8Array
): Point[] {
  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= width || y >= height) return 0;
    return mask[y * width + x];
  };

  const contour: Point[] = [];
  let cx = sx;
  let cy = sy;
  // `back` is the NEIGHBORS index of where we came from; searching clockwise
  // from (back + 1) keeps the interior on a consistent side. We entered the
  // start pixel "from the West" (the scan came from the left edge of the run).
  let back = 4; // West
  const startX = sx;
  const startY = sy;

  // Cap iterations so a pathological mask can never hang.
  const maxSteps = width * height * 4 + 16;
  let steps = 0;

  for (;;) {
    contour.push(pt(cx, cy));
    visited[cy * width + cx] = 1;

    // Search the 8 neighbours clockwise starting just after the backtrack dir.
    let found = false;
    for (let i = 0; i < 8; i++) {
      const d = (back + 1 + i) % 8;
      const nx = cx + NEIGHBORS[d][0];
      const ny = cy + NEIGHBORS[d][1];
      if (at(nx, ny)) {
        // Came from the opposite direction of the step we just took.
        back = (d + 4) % 8;
        cx = nx;
        cy = ny;
        found = true;
        break;
      }
    }
    if (!found) break; // isolated single pixel
    if (++steps > maxSteps) break;
    // Jacob's stopping criterion: back at the start pixel.
    if (cx === startX && cy === startY) {
      contour.push(pt(cx, cy));
      break;
    }
  }

  return contour;
}

/**
 * Threshold RGBA pixels to a binary ink mask, then trace the contours of every
 * ink region into closed polylines (Moore-neighbour boundary tracing). Returns
 * polylines in IMAGE pixel coordinates (origin top-left, y down). Because this
 * traces region BOUNDARIES, a pen drawn along the result outlines each ink
 * stroke rather than running down its centreline.
 */
export function traceBitmap(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  opts: TraceOptions
): Polyline[] {
  if (width <= 0 || height <= 0 || pixels.length < width * height * 4) return [];

  const invert = opts.invert ?? false;
  const minLen = opts.minContourLength ?? 8;
  const mask = buildInkMask(pixels, width, height, opts.threshold, invert);
  const visited = new Uint8Array(width * height);

  const result: Polyline[] = [];

  // Scan row-major. A boundary start is an ink pixel that (a) has not been
  // traced yet and (b) has a non-ink (or off-image) pixel to its left — i.e. it
  // is on the left edge of a run, a classic contour-start condition.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (mask[idx] !== 1) continue;
      if (visited[idx]) continue;
      const leftInk = x > 0 && mask[idx - 1] === 1;
      if (leftInk) continue; // interior of a run — start from the run's left edge

      const contour = traceContour(mask, width, height, x, y, visited);
      if (contour.length < minLen) continue;

      const poly = new Polyline();
      poly.closed = true;
      for (const p of contour) poly.add(p);
      result.push(poly);
    }
  }

  return result;
}

/** Perpendicular distance from point p to the line through a→b. */
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // |cross(b-a, p-a)| / |b-a|
  const cross = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x));
  return cross / Math.sqrt(len2);
}

/**
 * Ramer–Douglas–Peucker simplification. Returns a new Polyline keeping fewer
 * points such that no removed point deviates from the kept polyline by more
 * than `tolerance`. Preserves the `closed` flag. Iterative (no recursion) so
 * very large contours cannot blow the stack.
 */
export function simplifyPolyline(poly: Polyline, tolerance: number): Polyline {
  const pts = poly.points;
  const out = new Polyline();
  out.closed = poly.closed;
  if (pts.length <= 2 || tolerance <= 0) {
    for (const p of pts) out.add(p);
    return out;
  }

  const n = pts.length;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  // Stack of [start, end] index ranges to process.
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = start + 1; i < end; i++) {
      const d = perpDistance(pts[i], pts[start], pts[end]);
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }
    if (maxDist > tolerance && maxIdx !== -1) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  for (let i = 0; i < n; i++) if (keep[i]) out.add(pts[i]);
  return out;
}

/**
 * Scale a set of polylines uniformly to fit a target mm box (preserving aspect
 * ratio), and optionally flip Y so machine Y points up (origin moves to the
 * bottom-left). Input polylines are in image pixel coords (y-down); output is
 * mm-space polylines whose bounding box starts at (0,0) and fits within
 * targetW × targetH. Returns NEW polylines; inputs are not mutated.
 */
export function fitPolylinesToSize(
  polys: Polyline[],
  targetW: number,
  targetH: number,
  flipY: boolean
): Polyline[] {
  if (polys.length === 0) return [];

  // Source bounds across all points.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of polys) {
    for (const p of poly.points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
  }
  if (!isFinite(minX) || !isFinite(minY)) return polys.map(clonePoly);

  const srcW = maxX - minX;
  const srcH = maxY - minY;
  if (srcW <= 0 && srcH <= 0) return polys.map(clonePoly);

  // Uniform scale: fit within both target dimensions, preserve aspect.
  const sx = srcW > 0 ? targetW / srcW : Infinity;
  const sy = srcH > 0 ? targetH / srcH : Infinity;
  const scale = Math.min(sx, sy);
  const safeScale = isFinite(scale) && scale > 0 ? scale : 1;

  const scaledH = srcH * safeScale;

  const result: Polyline[] = [];
  for (const poly of polys) {
    const out = new Polyline();
    out.closed = poly.closed;
    for (const p of poly.points) {
      const x = (p.x - minX) * safeScale;
      let y = (p.y - minY) * safeScale;
      // Flip Y about the scaled height so the image top maps to the box top in
      // machine space (Y-up), with the result resting on Y=0.
      if (flipY) y = scaledH - y;
      out.add(pt(x, y));
    }
    result.push(out);
  }
  return result;
}

function clonePoly(poly: Polyline): Polyline {
  const out = new Polyline();
  out.closed = poly.closed;
  for (const p of poly.points) out.add(p);
  return out;
}

/** Total point count across polylines (handy for UI status). */
export function countPoints(polys: Polyline[]): number {
  let n = 0;
  for (const p of polys) n += p.points.length;
  return n;
}
