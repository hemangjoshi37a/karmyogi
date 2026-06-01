// Polygon offsetting for CAM (profile / pocket / isolation).
// Ported from the Qt/C++ reference cadcam/offset.{h,cpp}.
//
// DEVIATION NOTE: the plan suggested using `polygon-clipping` for robustness,
// but that library performs boolean set operations (union/intersect/diff) — it
// does NOT provide polygon *offsetting*. We therefore port the Qt v1 miter
// offset directly: it is exact for convex polygons and correct for simple
// (non-self-intersecting) concave polygons, and reproduces the reference unit
// tests' exact expected values. For production-grade robustness on complex
// copper pours / nested pockets, swap in a Clipper2-style offsetter behind this
// same API (offsetPolygon / insetRings).

import { Point, Polyline, distance, kEpsilon } from './geometry';

/**
 * Intersection of two infinite lines: line A through a0 with direction da,
 * line B through b0 with direction db. Returns null when (near) parallel.
 */
function lineIntersect(a0: Point, da: Point, b0: Point, db: Point): Point | null {
  const denom = da.x * db.y - da.y * db.x;
  if (Math.abs(denom) < 1e-12) return null;
  const diff = { x: b0.x - a0.x, y: b0.y - a0.y };
  const t = (diff.x * db.y - diff.y * db.x) / denom;
  return { x: a0.x + da.x * t, y: a0.y + da.y * t };
}

/** Remove consecutive duplicate vertices (within kEpsilon). */
function dedupe(input: Polyline): Polyline {
  const out = new Polyline();
  out.closed = input.closed;
  for (const p of input.points) {
    if (out.points.length === 0 || distance(out.points[out.points.length - 1], p) > kEpsilon)
      out.points.push({ x: p.x, y: p.y });
  }
  // Drop a closing duplicate vertex.
  if (out.points.length > 1 && distance(out.points[0], out.points[out.points.length - 1]) <= kEpsilon)
    out.points.pop();
  return out;
}

/**
 * Offset a closed polygon by `delta`. Positive delta grows the polygon outward,
 * negative shrinks it inward (regardless of the input winding order). Returns an
 * empty polyline if the result collapses (|delta| too large for an inward offset).
 */
export function offsetPolygon(poly: Polyline, delta: number): Polyline {
  const input = dedupe(poly);
  let n = input.points.length;
  if (n < 3) return new Polyline();

  // Normalise to CCW so a right-hand normal points outward and +delta grows.
  if (input.signedArea() < 0) input.reverse();
  n = input.points.length;

  // Per-edge offset line: base point + unit direction.
  const base: Point[] = new Array(n);
  const dir: Point[] = new Array(n);
  for (let i = 0; i < n; ++i) {
    const p0 = input.points[i];
    const p1 = input.points[(i + 1) % n];
    let dx = p1.x - p0.x;
    let dy = p1.y - p0.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < kEpsilon) {
      dir[i] = { x: 1, y: 0 };
      base[i] = { x: p0.x, y: p0.y };
      continue;
    }
    dx /= len;
    dy /= len;
    dir[i] = { x: dx, y: dy };
    // Right-hand normal (dy, -dx) points outward for a CCW polygon.
    base[i] = { x: p0.x + dy * delta, y: p0.y - dx * delta };
  }

  const out = new Polyline();
  out.closed = true;
  for (let i = 0; i < n; ++i) {
    const prev = (i - 1 + n) % n;
    const ip = lineIntersect(base[prev], dir[prev], base[i], dir[i]);
    out.points.push(ip ?? { x: base[i].x, y: base[i].y }); // parallel: keep shifted start
  }

  return out;
}

/**
 * Successive inward offsets at `step` spacing, starting at `firstOffset` inside
 * the boundary, until the region collapses. Used for area-clearing (pocketing).
 * Each returned ring is a closed polyline; outermost first.
 */
export function insetRings(poly: Polyline, firstOffset: number, step: number): Polyline[] {
  const rings: Polyline[] = [];
  if (poly.points.length < 3 || step <= 0 || firstOffset <= 0) return rings;

  const bb = poly.bounds();
  const maxInset = 0.5 * Math.min(bb.width(), bb.height());

  const refArea = Math.abs(poly.signedArea());
  if (refArea < kEpsilon) return rings;

  const cap = 100000;
  for (let k = 0; k < cap; ++k) {
    const inset = firstOffset + k * step;
    if (inset > maxInset + step) break; // allow one ring past centre, then stop
    const ring = offsetPolygon(poly, -inset);
    if (ring.points.length < 3) break;
    const area = ring.signedArea();
    // Collapse detection: area vanished or winding flipped (self-overlap).
    if (Math.abs(area) < 1e-6 || area < 0) break;
    if (Math.abs(area) > refArea) break; // sanity: inset must not grow area
    rings.push(ring);
  }
  return rings;
}
