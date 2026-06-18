/**
 * F2 — Array / grid duplication engine.
 *
 * A PURE, UI-independent module (no React/DOM/three imports) that replicates a
 * set of source points/operations across two pattern families:
 *
 *   • LINEAR  — a rows × cols grid with per-axis spacing, an optional staggered
 *               (brick) offset, and an optional uniform rotation per instance.
 *   • RADIAL  — N instances spread around a center over an angular sweep, each
 *               optionally rotated to face outward (or kept axis-aligned).
 *
 * It powers batch-signing, PnP panelization, screw grids, and dispense arrays:
 * every workbench that needs "do this op many times in a regular layout" calls
 * `expandArray()` with its own points and gets back a flat list of placed
 * points, each tagged with the instance it belongs to (row/col or angular
 * index) plus the rigid transform applied to that instance.
 *
 * Design notes:
 *  - Geometry is 2D in the XY plane (Z is carried through untouched) — that
 *    matches every consumer (soldering, dispensing, signing, PnP all act on a
 *    flat workpiece). A point may carry an arbitrary `meta` payload that is
 *    preserved verbatim on every copy, so an operation's parameters ride along.
 *  - Each instance is a rigid transform (translate + rotate about the instance
 *    origin) applied to the whole source set, so relative geometry is preserved.
 *  - Rotation is in DEGREES at the API boundary (human-facing), radians only
 *    internally.
 *  - The first instance (index 0) is the identity placement of the source set,
 *    so an array of count 1 returns the source unchanged.
 */

/** A source point. `z` and `meta` are optional and carried through unchanged. */
export interface ArrayPoint<M = unknown> {
  x: number
  y: number
  z?: number
  /** Opaque per-point payload (op params, label, id…). Preserved on every copy. */
  meta?: M
}

/** A rigid 2D placement: translate by (dx,dy) then rotate `rotDeg` about the cell origin. */
export interface InstanceTransform {
  /** Translation applied to the cell origin, in mm. */
  dx: number
  dy: number
  /** Rotation of the instance, in degrees (CCW, about the cell origin pre-translation). */
  rotDeg: number
}

/** One produced instance of the source set. */
export interface ArrayInstance<M = unknown> {
  /** Flat sequence index of this instance (0 = the original). */
  index: number
  /** Grid row (linear) — 0 for radial. */
  row: number
  /** Grid column (linear) — for radial this is the angular step index. */
  col: number
  /** The transform that produced this instance's points. */
  transform: InstanceTransform
  /** The source points after this instance's transform. */
  points: ArrayPoint<M>[]
}

/** Result of expanding an array spec. */
export interface ArrayResult<M = unknown> {
  /** Every instance, in row-major (linear) / angular (radial) order. */
  instances: ArrayInstance<M>[]
  /** All placed points across every instance, flattened (instances in order). */
  points: ArrayPoint<M>[]
  /** Number of instances produced. */
  count: number
  /** Axis-aligned bounding box of all placed points (null if there are none). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null
}

/** rows × cols grid pattern. */
export interface LinearArraySpec {
  kind: 'linear'
  /** Number of rows (≥1). Y direction. */
  rows: number
  /** Number of columns (≥1). X direction. */
  cols: number
  /** Center-to-center spacing along X, in mm (may be negative to mirror direction). */
  spacingX: number
  /** Center-to-center spacing along Y, in mm. */
  spacingY: number
  /**
   * Optional per-row X stagger (brick offset), in mm — added to even rows' X
   * (row index 0,2,4…). Defaults to 0. Use spacingX/2 for a classic half-brick.
   */
  staggerX?: number
  /** Optional uniform rotation applied to every instance, in degrees. Default 0. */
  rotDeg?: number
}

/** N instances around a center over an angular sweep. */
export interface RadialArraySpec {
  kind: 'radial'
  /** Number of instances around the circle (≥1). */
  count: number
  /** Radius from center to each instance origin, in mm (≥0). */
  radius: number
  /** Center X of the circle, in mm. Default 0. */
  centerX?: number
  /** Center Y of the circle, in mm. Default 0. */
  centerY?: number
  /** Angle of the first instance, in degrees (CCW from +X). Default 0. */
  startAngleDeg?: number
  /**
   * Total angular sweep, in degrees. Default 360 (full circle). When the sweep
   * is a full 360°, the last instance is NOT placed on top of the first (the
   * step is sweep/count); for a partial sweep the endpoints are inclusive
   * (step is sweep/(count-1)) so the first and last sit on the sweep limits.
   */
  sweepDeg?: number
  /**
   * If true, each instance is rotated so its local +X points away from the
   * center (radially outward), like spokes. If false (default) instances keep
   * their original orientation (only translated).
   */
  faceOutward?: boolean
  /** Extra uniform rotation added to every instance, in degrees. Default 0. */
  rotDeg?: number
}

export type ArraySpec = LinearArraySpec | RadialArraySpec

const DEG2RAD = Math.PI / 180

/** Clean -0 / tiny FP noise to keep emitted coordinates tidy. */
function tidy(n: number): number {
  const r = Math.round(n * 1e6) / 1e6
  return r === 0 ? 0 : r
}

/**
 * Apply a rigid transform to a point: rotate about the local origin (0,0) by
 * `rotDeg`, then translate by (dx,dy). Z and meta ride through unchanged.
 */
function placePoint<M>(p: ArrayPoint<M>, t: InstanceTransform): ArrayPoint<M> {
  const a = t.rotDeg * DEG2RAD
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const rx = p.x * cos - p.y * sin
  const ry = p.x * sin + p.y * cos
  const out: ArrayPoint<M> = { x: tidy(rx + t.dx), y: tidy(ry + t.dy) }
  if (p.z !== undefined) out.z = p.z
  if (p.meta !== undefined) out.meta = p.meta
  return out
}

function clampInt(n: number, min: number): number {
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.floor(n))
}

/**
 * Compute the list of instance transforms for a spec (without applying them to
 * any points). Useful for a lightweight layout preview (draw a marker at each
 * cell origin) before committing to a full expansion. Order matches
 * `expandArray`'s instances.
 */
export function arrayTransforms(spec: ArraySpec): InstanceTransform[] {
  if (spec.kind === 'linear') {
    const rows = clampInt(spec.rows, 1)
    const cols = clampInt(spec.cols, 1)
    const sx = spec.spacingX
    const sy = spec.spacingY
    const stagger = spec.staggerX ?? 0
    const rot = spec.rotDeg ?? 0
    const out: InstanceTransform[] = []
    for (let r = 0; r < rows; r++) {
      // Stagger ODD rows (0-based) by `stagger`, like brickwork. Row 0 is left
      // un-staggered so instance 0 stays the identity placement (a 1×1 array, or
      // the first cell, lands exactly on the source — consumers align to that).
      const rowStagger = r % 2 === 1 ? stagger : 0
      for (let c = 0; c < cols; c++) {
        out.push({ dx: tidy(c * sx + rowStagger), dy: tidy(r * sy), rotDeg: rot })
      }
    }
    return out
  }

  // radial
  const count = clampInt(spec.count, 1)
  const radius = Number.isFinite(spec.radius) ? spec.radius : 0
  const cx = spec.centerX ?? 0
  const cy = spec.centerY ?? 0
  const start = spec.startAngleDeg ?? 0
  const sweep = spec.sweepDeg ?? 360
  const extraRot = spec.rotDeg ?? 0
  // Full circle: divide by count so we don't double-place at the seam.
  // Partial sweep: divide by (count-1) so the endpoints land on the limits.
  const isFull = Math.abs(Math.abs(sweep) - 360) < 1e-9
  const denom = isFull ? count : Math.max(1, count - 1)
  const step = count > 1 ? sweep / denom : 0
  const out: InstanceTransform[] = []
  for (let i = 0; i < count; i++) {
    const ang = (start + step * i) * DEG2RAD
    const dx = cx + radius * Math.cos(ang)
    const dy = cy + radius * Math.sin(ang)
    // faceOutward orients local +X radially; otherwise keep source orientation.
    const facing = spec.faceOutward ? start + step * i : 0
    out.push({ dx: tidy(dx), dy: tidy(dy), rotDeg: tidy(facing + extraRot) })
  }
  return out
}

/** Total instance count a spec will produce (cheap, no allocation of points). */
export function arrayCount(spec: ArraySpec): number {
  if (spec.kind === 'linear') return clampInt(spec.rows, 1) * clampInt(spec.cols, 1)
  return clampInt(spec.count, 1)
}

function updateBounds(
  b: { minX: number; minY: number; maxX: number; maxY: number } | null,
  p: ArrayPoint,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!b) return { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }
  return {
    minX: Math.min(b.minX, p.x),
    minY: Math.min(b.minY, p.y),
    maxX: Math.max(b.maxX, p.x),
    maxY: Math.max(b.maxY, p.y),
  }
}

/**
 * Expand a source point set across an array pattern.
 *
 * @param source The points to replicate (their geometry is preserved relative
 *               to each instance origin). An empty source yields zero points but
 *               still reports the instance transforms.
 * @param spec   The linear or radial pattern.
 * @returns      Flat placed points + per-instance breakdown + bounds.
 */
export function expandArray<M = unknown>(
  source: ArrayPoint<M>[],
  spec: ArraySpec,
): ArrayResult<M> {
  const transforms = arrayTransforms(spec)
  const instances: ArrayInstance<M>[] = []
  const points: ArrayPoint<M>[] = []
  let bounds: ArrayResult<M>['bounds'] = null

  const cols = spec.kind === 'linear' ? clampInt(spec.cols, 1) : 1

  transforms.forEach((transform, index) => {
    const placed = source.map((p) => placePoint(p, transform))
    for (const p of placed) {
      points.push(p)
      bounds = updateBounds(bounds, p)
    }
    instances.push({
      index,
      row: spec.kind === 'linear' ? Math.floor(index / cols) : 0,
      col: spec.kind === 'linear' ? index % cols : index,
      transform,
      points: placed,
    })
  })

  return { instances, points, count: transforms.length, bounds }
}
