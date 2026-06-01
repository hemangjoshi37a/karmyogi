// Shared CAD/CAM geometry core — UI-independent.
// Ported from the Qt/C++ reference cadcam/geometry.{h,cpp}.
// Pure TypeScript: no React/DOM/three.js imports.

/** Default chord tolerance (mm) used when flattening arcs/circles to polylines. */
export const kDefaultArcTolerance = 0.05;
/** Generic geometric epsilon (mm). */
export const kEpsilon = 1e-9;

/** A 2D point. Mirrors Qt's QPointF (mutable plain object). */
export interface Point {
  x: number;
  y: number;
}

export function pt(x: number, y: number): Point {
  return { x, y };
}

/** Axis-aligned 2D bounding box. Starts invalid; expand() grows it. */
export class BBox {
  min: Point = { x: 0, y: 0 };
  max: Point = { x: 0, y: 0 };
  valid = false;

  /** Expand to include a point or another BBox. */
  expand(p: Point): void;
  expand(other: BBox): void;
  expand(arg: Point | BBox): void {
    if (arg instanceof BBox) {
      if (!arg.valid) return;
      this.expand(arg.min);
      this.expand(arg.max);
      return;
    }
    const p = arg;
    if (!this.valid) {
      this.min = { x: p.x, y: p.y };
      this.max = { x: p.x, y: p.y };
      this.valid = true;
      return;
    }
    if (p.x < this.min.x) this.min.x = p.x;
    if (p.y < this.min.y) this.min.y = p.y;
    if (p.x > this.max.x) this.max.x = p.x;
    if (p.y > this.max.y) this.max.y = p.y;
  }

  width(): number {
    return this.valid ? this.max.x - this.min.x : 0;
  }
  height(): number {
    return this.valid ? this.max.y - this.min.y : 0;
  }
  center(): Point {
    if (!this.valid) return { x: 0, y: 0 };
    return { x: (this.min.x + this.max.x) / 2, y: (this.min.y + this.max.y) / 2 };
  }
  isValid(): boolean {
    return this.valid;
  }
}

/**
 * A connected chain of vertices. Closed polylines represent polygons.
 * Arcs are represented by flattening into vertices via add* helpers.
 */
export class Polyline {
  points: Point[] = [];
  closed = false;

  size(): number {
    return this.points.length;
  }
  isEmpty(): boolean {
    return this.points.length === 0;
  }
  clear(): void {
    this.points = [];
    this.closed = false;
  }

  add(p: Point): void {
    this.points.push({ x: p.x, y: p.y });
  }

  addUnique(p: Point, tol = kEpsilon): void {
    if (this.points.length > 0 && distance(this.points[this.points.length - 1], p) <= tol) return;
    this.points.push({ x: p.x, y: p.y });
  }

  /**
   * Append an arc (center, radius, start/end angle in radians) approximated by
   * line segments not deviating from the true arc by more than `tol`.
   */
  addArc(
    center: Point,
    radius: number,
    startAngle: number,
    endAngle: number,
    ccw: boolean,
    tol = kDefaultArcTolerance
  ): void {
    let sweep = endAngle - startAngle;
    if (ccw) {
      while (sweep <= 0) sweep += 2 * Math.PI;
      while (sweep > 2 * Math.PI) sweep -= 2 * Math.PI;
    } else {
      while (sweep >= 0) sweep -= 2 * Math.PI;
      while (sweep < -2 * Math.PI) sweep += 2 * Math.PI;
    }

    let segments = 1;
    if (radius > tol && tol > 0) {
      const maxStep = 2 * Math.acos(Math.max(0, 1 - tol / radius));
      if (maxStep > kEpsilon) segments = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep));
    }
    segments = Math.max(segments, 2);

    for (let i = 0; i <= segments; ++i) {
      const a = startAngle + sweep * (i / segments);
      this.addUnique({ x: center.x + radius * Math.cos(a), y: center.y + radius * Math.sin(a) });
    }
  }

  length(): number {
    if (this.points.length < 2) return 0;
    let total = 0;
    for (let i = 1; i < this.points.length; ++i) total += distance(this.points[i - 1], this.points[i]);
    if (this.closed) total += distance(this.points[this.points.length - 1], this.points[0]);
    return total;
  }

  signedArea(): number {
    if (this.points.length < 3) return 0;
    let area = 0;
    const n = this.points.length;
    for (let i = 0; i < n; ++i) {
      const a = this.points[i];
      const b = this.points[(i + 1) % n];
      area += a.x * b.y - b.x * a.y;
    }
    return area / 2;
  }

  isClockwise(): boolean {
    return this.signedArea() < 0;
  }

  reverse(): void {
    this.points.reverse();
  }

  makeClockwise(cw: boolean): void {
    if (this.isClockwise() !== cw) this.reverse();
  }

  bounds(): BBox {
    const b = new BBox();
    for (const p of this.points) b.expand(p);
    return b;
  }

  /** Deep copy. */
  clone(): Polyline {
    const pl = new Polyline();
    pl.closed = this.closed;
    pl.points = this.points.map((p) => ({ x: p.x, y: p.y }));
    return pl;
  }
}

// ---- Free construction helpers --------------------------------------------

export function makeArcPolyline(
  center: Point,
  radius: number,
  startAngle: number,
  endAngle: number,
  ccw: boolean,
  tol = kDefaultArcTolerance
): Polyline {
  const pl = new Polyline();
  pl.addArc(center, radius, startAngle, endAngle, ccw, tol);
  return pl;
}

export function makeCircle(center: Point, radius: number, tol = kDefaultArcTolerance): Polyline {
  const pl = new Polyline();
  pl.addArc(center, radius, 0, 2 * Math.PI, true, tol);
  // Drop the duplicate closing vertex; mark closed instead.
  if (pl.points.length > 1 && distance(pl.points[0], pl.points[pl.points.length - 1]) <= kEpsilon)
    pl.points.pop();
  pl.closed = true;
  return pl;
}

export function makeRect(corner: Point, width: number, height: number): Polyline {
  const pl = new Polyline();
  pl.add(corner);
  pl.add({ x: corner.x + width, y: corner.y });
  pl.add({ x: corner.x + width, y: corner.y + height });
  pl.add({ x: corner.x, y: corner.y + height });
  pl.closed = true;
  return pl;
}

// ---- Geometric predicates / utilities -------------------------------------

export function distance(a: Point, b: Point): number {
  return Math.sqrt(distanceSquared(a, b));
}

export function distanceSquared(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= kEpsilon) return distance(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

/** Even-odd ray-cast test. Treats the polyline as closed regardless of flag. */
export function pointInPolygon(poly: Polyline, p: Point): boolean {
  const n = poly.points.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = poly.points[i];
    const pj = poly.points[j];
    const crosses = pi.y > p.y !== pj.y > p.y;
    if (crosses) {
      const xCross = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Convert a DXF "bulge" value between two vertices into an arc and append the
 * flattened points (excluding p0, including p1) to `out`. bulge==0 -> straight.
 */
export function appendBulgeArc(
  out: Polyline,
  p0: Point,
  p1: Point,
  bulge: number,
  tol = kDefaultArcTolerance
): void {
  if (Math.abs(bulge) < kEpsilon) {
    out.addUnique(p1);
    return;
  }

  // bulge = tan(theta/4); theta is the included angle (signed: +CCW, -CW).
  const theta = 4 * Math.atan(bulge);
  const chord = distance(p0, p1);
  if (chord < kEpsilon) {
    out.addUnique(p1);
    return;
  }

  const radius = chord / (2 * Math.sin(Math.abs(theta) / 2));

  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  // Apothem (centre offset from chord midpoint).
  const h = radius * Math.cos(Math.abs(theta) / 2);
  const sign = theta > 0 ? 1 : -1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const center = { x: mid.x + sign * h * nx, y: mid.y + sign * h * ny };

  const a0 = Math.atan2(p0.y - center.y, p0.x - center.x);
  const a1 = Math.atan2(p1.y - center.y, p1.x - center.x);

  const ccw = theta > 0;
  const tmp = new Polyline();
  tmp.addArc(center, radius, a0, a1, ccw, tol);
  for (let i = 1; i < tmp.points.length; ++i) out.addUnique(tmp.points[i]);
  // Guarantee the exact end vertex.
  out.addUnique(p1);
}
