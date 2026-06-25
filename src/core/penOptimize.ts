// Pen-plotter / pen-mode path optimization core (UI-independent, pure).
//
// Mirrors the optimization passes that vpype / saxi / AxiDraw apply before
// plotting, but works on our own `Polyline[]` (mm-space, Y-up). Every function
// returns NEW polylines and never mutates its input. Ports the *behaviour* of:
//   • vpype `linemerge`   — join paths whose endpoints touch (within a tol).
//   • vpype `linesort`    — greedy nearest-neighbour reorder to cut pen-up travel.
//   • vpype `linesimplify` (Douglas-Peucker) + dedupe.
//   • vpype `multipass`   — repeat each path N× for bolder lines.
//   • vpype `reloop`      — randomize the seam (start vertex) of closed paths.
//   • vpype-occult        — hidden-line / occlusion removal (later paths occlude
//                           the parts of earlier paths they cover).
//   • saxi plot-time      — accel-naive but feed/penlift-aware time estimate.
//
// Kept dependency-free except the geometry primitives so it stays portable and
// mirrors the Qt `cadcam` lib structure.

import { Polyline, distance, distanceSquared, kEpsilon, type Point } from './geometry'

/** A path endpoint is "the same place" if within this many mm (overridable). */
const DEFAULT_WELD_TOL = 0.05

// ── small helpers ─────────────────────────────────────────────────────────

function clonePolyline(pl: Polyline): Polyline {
  const out = new Polyline()
  out.closed = pl.closed
  for (const p of pl.points) out.add({ x: p.x, y: p.y })
  return out
}

function first(pl: Polyline): Point {
  return pl.points[0]
}
function last(pl: Polyline): Point {
  return pl.points[pl.points.length - 1]
}

/** A polyline is plottable only if it has at least two distinct points. */
function isDrawable(pl: Polyline): boolean {
  return pl.points.length >= 2
}

// ── W2: simplify + dedupe ───────────────────────────────────────────────────

/**
 * Ramer–Douglas–Peucker point reduction (iterative, stack-safe). Drops vertices
 * that deviate from the simplified chord by less than `tolerance` mm. Preserves
 * the `closed` flag. `tolerance <= 0` is a no-op (returns a clone).
 */
export function simplify(pl: Polyline, tolerance: number): Polyline {
  const pts = pl.points
  const out = new Polyline()
  out.closed = pl.closed
  const n = pts.length
  if (n <= 2 || tolerance <= 0) {
    for (const p of pts) out.add({ x: p.x, y: p.y })
    return out
  }
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: Array<[number, number]> = [[0, n - 1]]
  while (stack.length > 0) {
    const [s, e] = stack.pop()!
    let maxD = 0
    let maxI = -1
    for (let i = s + 1; i < e; i++) {
      const d = perpDistance(pts[i], pts[s], pts[e])
      if (d > maxD) {
        maxD = d
        maxI = i
      }
    }
    if (maxD > tolerance && maxI !== -1) {
      keep[maxI] = 1
      stack.push([s, maxI])
      stack.push([maxI, e])
    }
  }
  for (let i = 0; i < n; i++) if (keep[i]) out.add({ x: pts[i].x, y: pts[i].y })
  return out
}

/** Perpendicular distance from point `p` to the segment a→b (degenerate-safe). */
function perpDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < kEpsilon) return distance(p, a)
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  const cx = a.x + t * dx
  const cy = a.y + t * dy
  return Math.hypot(p.x - cx, p.y - cy)
}

/**
 * Drop consecutive duplicate vertices (closer than `tol` mm). Also drops paths
 * that collapse to a single point. Returns NEW polylines.
 */
export function dedupe(polys: Polyline[], tol = DEFAULT_WELD_TOL): Polyline[] {
  const tol2 = tol * tol
  const out: Polyline[] = []
  for (const pl of polys) {
    const np = new Polyline()
    np.closed = pl.closed
    for (const p of pl.points) {
      const prev = np.points[np.points.length - 1]
      if (!prev || distanceSquared(prev, p) > tol2) np.add({ x: p.x, y: p.y })
    }
    if (isDrawable(np)) out.push(np)
  }
  return out
}

// ── W1: linemerge ────────────────────────────────────────────────────────────

/**
 * Join paths whose endpoints coincide (within `tol` mm) into longer continuous
 * paths — the vpype `linemerge` pass. Reversal is allowed so an end can meet
 * another end. Closed paths are passed through untouched (already continuous).
 * Greedy: O(n·k) over open paths; plenty fast for plotter-scale path counts.
 * Returns NEW polylines.
 */
export function linemerge(polys: Polyline[], tol = DEFAULT_WELD_TOL): Polyline[] {
  const closed: Polyline[] = []
  const open: Polyline[] = []
  for (const pl of polys) {
    if (!isDrawable(pl)) continue
    const c = clonePolyline(pl)
    // Treat a path whose ends already coincide as closed.
    if (c.closed || distance(first(c), last(c)) <= tol) {
      c.closed = true
      closed.push(c)
    } else {
      open.push(c)
    }
  }

  const tol2 = tol * tol
  const used = new Array<boolean>(open.length).fill(false)
  const merged: Polyline[] = []

  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue
    used[i] = true
    const chain = clonePolyline(open[i])
    // Extend the chain at its tail, repeatedly, finding any open path whose
    // start OR end touches the chain's tail.
    let extended = true
    while (extended) {
      extended = false
      const tail = last(chain)
      for (let j = 0; j < open.length; j++) {
        if (used[j]) continue
        const cand = open[j]
        const cs = first(cand)
        const ce = last(cand)
        if (distanceSquared(tail, cs) <= tol2) {
          for (let k = 1; k < cand.points.length; k++)
            chain.add({ x: cand.points[k].x, y: cand.points[k].y })
          used[j] = true
          extended = true
          break
        }
        if (distanceSquared(tail, ce) <= tol2) {
          for (let k = cand.points.length - 2; k >= 0; k--)
            chain.add({ x: cand.points[k].x, y: cand.points[k].y })
          used[j] = true
          extended = true
          break
        }
      }
    }
    // If the chain closed on itself, mark it.
    if (chain.points.length > 2 && distance(first(chain), last(chain)) <= tol)
      chain.closed = true
    merged.push(chain)
  }

  return [...merged, ...closed]
}

// ── W1: linesort ─────────────────────────────────────────────────────────────

/**
 * Greedy nearest-neighbour reorder to minimize pen-up (travel) distance — the
 * vpype `linesort` pass. Open paths may be reversed if their other end is
 * nearer. Starts from `startAt` (defaults to the origin 0,0). Closed paths keep
 * their seam (use `reloop` to move it). Returns NEW polylines in plot order.
 */
export function linesort(polys: Polyline[], startAt: Point = { x: 0, y: 0 }): Polyline[] {
  const items = polys.filter(isDrawable).map(clonePolyline)
  const n = items.length
  if (n <= 1) return items
  const used = new Array<boolean>(n).fill(false)
  const out: Polyline[] = []
  let cur = startAt
  for (let step = 0; step < n; step++) {
    let bestIdx = -1
    let bestDist = Infinity
    let bestReverse = false
    for (let i = 0; i < n; i++) {
      if (used[i]) continue
      const pl = items[i]
      const ds = distanceSquared(cur, first(pl))
      if (ds < bestDist) {
        bestDist = ds
        bestIdx = i
        bestReverse = false
      }
      // Open paths: also consider entering from the far end.
      if (!pl.closed) {
        const de = distanceSquared(cur, last(pl))
        if (de < bestDist) {
          bestDist = de
          bestIdx = i
          bestReverse = true
        }
      }
    }
    if (bestIdx === -1) break
    used[bestIdx] = true
    const chosen = items[bestIdx]
    if (bestReverse) chosen.reverse()
    out.push(chosen)
    cur = last(chosen)
  }
  return out
}

// ── W8: reloop ────────────────────────────────────────────────────────────────

/**
 * Randomize the seam (start vertex) of each CLOSED path — the vpype `reloop`
 * pass. Spreads the tiny start/stop blob around closed shapes so it isn't always
 * in the same spot. Open paths are returned unchanged. `rng` is injectable for
 * determinism in tests/preview (defaults to Math.random). Returns NEW polylines.
 */
export function reloop(polys: Polyline[], rng: () => number = Math.random): Polyline[] {
  return polys.map((pl) => {
    if (!pl.closed || pl.points.length < 4) return clonePolyline(pl)
    // Drop a duplicated closing vertex if present, rotate, then re-close.
    const pts = pl.points.slice()
    if (distance(pts[0], pts[pts.length - 1]) <= kEpsilon) pts.pop()
    const k = Math.floor(rng() * pts.length) % pts.length
    const rotated = pts.slice(k).concat(pts.slice(0, k))
    const out = new Polyline()
    out.closed = true
    for (const p of rotated) out.add({ x: p.x, y: p.y })
    return out
  })
}

// ── W3: multipass ─────────────────────────────────────────────────────────────

/**
 * Repeat each path `passes` times back-to-back for bolder, darker lines — the
 * vpype `multipass` pass. The pen stays down between passes of the same path:
 * we emit the path forward, then reversed, then forward… so consecutive passes
 * share an endpoint (no pen-up between passes). `passes <= 1` is a no-op clone.
 * Returns NEW polylines (one per pass, in draw order).
 */
export function multipass(polys: Polyline[], passes: number): Polyline[] {
  const n = Math.max(1, Math.floor(passes))
  if (n <= 1) return polys.map(clonePolyline)
  const out: Polyline[] = []
  for (const pl of polys) {
    if (!isDrawable(pl)) continue
    for (let p = 0; p < n; p++) {
      const c = clonePolyline(pl)
      // Alternate direction on each repeat so the pen needn't lift between
      // passes (open paths only; closed paths repeat in the same winding).
      if (!c.closed && p % 2 === 1) c.reverse()
      out.push(c)
    }
  }
  return out
}

// ── W7: occlusion / hidden-line removal ──────────────────────────────────────

/**
 * Hidden-line removal — vpype-occult. Paths drawn LATER are "on top"; the parts
 * of EARLIER paths that fall inside a later CLOSED path are removed (clipped),
 * as if the later shape were opaque and painted over them. Open later paths and
 * any path's self never occlude. Result preserves draw order. Returns NEW
 * polylines; an earlier path may be split into several visible fragments.
 *
 * This is a sampling/segment clip (not exact boolean): each earlier segment is
 * walked and the portions whose midpoints land inside a later occluder are
 * dropped, splitting the segment chain into visible runs. Good enough for the
 * plotter use-case (thin pen lines) and robust for arbitrary self-overlapping
 * art, matching occult's practical behaviour.
 */
export function occlude(polys: Polyline[]): Polyline[] {
  const src = polys.filter(isDrawable).map(clonePolyline)
  const result: Polyline[] = []
  for (let i = 0; i < src.length; i++) {
    // Occluders are the CLOSED paths drawn after this one.
    const occluders: Polyline[] = []
    for (let j = i + 1; j < src.length; j++) {
      if (src[j].closed && src[j].points.length >= 3) occluders.push(src[j])
    }
    if (occluders.length === 0) {
      result.push(src[i])
      continue
    }
    for (const frag of clipPolylineByOccluders(src[i], occluders)) result.push(frag)
  }
  return result
}

/**
 * Split a polyline into the runs that are NOT covered by any occluder polygon.
 * Each segment is subdivided so the inside/outside test has reasonable spatial
 * resolution relative to the occluders' size.
 */
function clipPolylineByOccluders(pl: Polyline, occluders: Polyline[]): Polyline[] {
  const pts = pl.points
  if (pts.length < 2) return [clonePolyline(pl)]
  // Subdivision step: a fraction of the smallest occluder extent, clamped.
  let minExtent = Infinity
  for (const o of occluders) {
    const b = o.bounds()
    minExtent = Math.min(minExtent, Math.max(b.width(), b.height()))
  }
  const step = Number.isFinite(minExtent) && minExtent > 0 ? Math.max(minExtent / 24, 0.1) : 0.5

  const out: Polyline[] = []
  let run: Polyline | null = null
  const flush = () => {
    if (run && isDrawable(run)) out.push(run)
    run = null
  }

  const visibleAt = (p: Point): boolean => {
    for (const o of occluders) if (pointInPolygon(p, o.points)) return false
    return true
  }

  for (let s = 0; s < pts.length - 1; s++) {
    const a = pts[s]
    const b = pts[s + 1]
    const segLen = distance(a, b)
    const sub = Math.max(1, Math.ceil(segLen / step))
    for (let k = 0; k <= sub; k++) {
      // Skip re-emitting the shared vertex between consecutive segments.
      if (s > 0 && k === 0) continue
      const t = k / sub
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (visibleAt(p)) {
        if (!run) {
          run = new Polyline()
        }
        run.add(p)
      } else {
        flush()
      }
    }
  }
  flush()
  return out.length > 0 ? out : []
}

/** Even-odd point-in-polygon (ray cast). Polygon is an array of vertices. */
function pointInPolygon(p: Point, poly: Point[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i].x
    const yi = poly[i].y
    const xj = poly[j].x
    const yj = poly[j].y
    const intersect = yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

// ── W6: auto scale + center to bed ───────────────────────────────────────────

export interface FitToBedOptions {
  /** Bed width in mm. */
  bedW: number
  /** Bed height in mm. */
  bedH: number
  /** Margin kept clear on every side, in mm. */
  margin?: number
  /** Scale to fill the usable bed (true) or only center without scaling up. */
  scale?: boolean
}

/**
 * Uniformly scale (optional) + translate a drawing so it is centered on the
 * bed, optionally fitting within `bed - 2·margin`. Preserves aspect ratio and
 * the `closed` flag. Returns NEW polylines and the applied transform.
 */
export function fitToBed(
  polys: Polyline[],
  opts: FitToBedOptions,
): { polys: Polyline[]; scale: number; dx: number; dy: number } {
  const drawable = polys.filter(isDrawable)
  if (drawable.length === 0) return { polys: [], scale: 1, dx: 0, dy: 0 }
  const margin = Math.max(0, opts.margin ?? 0)
  const usableW = Math.max(0, opts.bedW - 2 * margin)
  const usableH = Math.max(0, opts.bedH - 2 * margin)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pl of drawable)
    for (const p of pl.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  const srcW = maxX - minX
  const srcH = maxY - minY

  let scale = 1
  if (opts.scale !== false && usableW > 0 && usableH > 0) {
    const sx = srcW > kEpsilon ? usableW / srcW : Infinity
    const sy = srcH > kEpsilon ? usableH / srcH : Infinity
    const s = Math.min(sx, sy)
    if (Number.isFinite(s) && s > 0) scale = s
  } else if (usableW > 0 && usableH > 0) {
    // Center-only: shrink to fit if oversized, never enlarge.
    const sx = srcW > usableW ? usableW / srcW : 1
    const sy = srcH > usableH ? usableH / srcH : 1
    scale = Math.min(sx, sy)
  }

  const scaledW = srcW * scale
  const scaledH = srcH * scale
  // Center the scaled bbox on the bed.
  const dx = (opts.bedW - scaledW) / 2 - minX * scale
  const dy = (opts.bedH - scaledH) / 2 - minY * scale

  const out = drawable.map((pl) => {
    const np = new Polyline()
    np.closed = pl.closed
    for (const p of pl.points) np.add({ x: p.x * scale + dx, y: p.y * scale + dy })
    return np
  })
  return { polys: out, scale, dx, dy }
}

// ── W9: motion preview + plot-time estimate ──────────────────────────────────

export interface PlotTimeOptions {
  /** Pen-down drawing feed, mm/min. */
  feedXY: number
  /** Pen-up travel feed, mm/min. If omitted, uses feedXY. */
  travelFeed?: number
  /** Pen lift+lower time per pen-down, seconds (both directions summed). */
  penChangeSec?: number
  /** Where the pen starts (defaults to origin). */
  startAt?: Point
}

export interface PlotEstimate {
  /** Total wall-clock estimate, seconds. */
  seconds: number
  /** Pen-DOWN (drawing) distance, mm. */
  drawDist: number
  /** Pen-UP (travel between paths) distance, mm. */
  travelDist: number
  /** Number of pen-down strokes (≈ pen lifts). */
  penDowns: number
  /** Total vertex count across all paths. */
  points: number
}

/**
 * Estimate plot time + travel for an ORDERED set of pen paths (run `linesort`
 * first for a realistic number). Feed-rate based (no accel model — like saxi's
 * simple estimate), plus a fixed per-stroke pen lift/lower allowance. Pure: does
 * not emit G-code, just measures the same motion the emitter will produce.
 */
export function estimatePlotTime(polys: Polyline[], opts: PlotTimeOptions): PlotEstimate {
  const feed = opts.feedXY > 0 ? opts.feedXY : 1
  const travelFeed = opts.travelFeed && opts.travelFeed > 0 ? opts.travelFeed : feed
  const penChangeSec = Math.max(0, opts.penChangeSec ?? 0)
  let cur = opts.startAt ?? { x: 0, y: 0 }

  let drawDist = 0
  let travelDist = 0
  let penDowns = 0
  let points = 0

  for (const pl of polys) {
    if (!isDrawable(pl)) continue
    points += pl.points.length
    penDowns++
    // Pen-up travel from current position to this path's start.
    travelDist += distance(cur, first(pl))
    // Pen-down drawing along the path.
    for (let i = 1; i < pl.points.length; i++) drawDist += distance(pl.points[i - 1], pl.points[i])
    if (pl.closed) drawDist += distance(last(pl), first(pl))
    cur = pl.closed ? first(pl) : last(pl)
  }

  // feed is mm/min → seconds = mm / feed * 60.
  const seconds =
    (drawDist / feed) * 60 + (travelDist / travelFeed) * 60 + penDowns * penChangeSec
  return { seconds, drawDist, travelDist, penDowns, points }
}

/** Format a seconds duration as a compact `1h 02m 03s` / `2m 03s` / `12s`. */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

// ── S1: pressure / speed-modulated stroke replay ────────────────────────────

export interface ModulateOptions {
  /**
   * Corner-rounding strength 0..1 (Chaikin iterations scale with it). Higher =
   * smoother, less mechanical motion. 0 = leave the captured polyline as-is.
   */
  smoothing?: number
  /**
   * Pressure taper 0..1: near slow points (tight curves + stroke ends, where a
   * human presses harder / lingers) add short overlapping retrace passes to lay
   * down more ink, emulating variable pressure. 0 = uniform single pass.
   */
  pressure?: number
}

/**
 * S1 — make a replayed stroke look HAND-DRAWN rather than mechanical, using only
 * XY geometry (so it survives the fixed-feed pen emitter):
 *   • Chaikin corner-rounding eases the angular vertices a digitizer captures,
 *     mimicking the way a real pen can't change direction instantly.
 *   • A pressure taper adds short retrace passes around slow points (tight turns
 *     and the stroke ends), depositing more ink there like a pressed pen nib.
 * Returns NEW polylines (one stroke may become several overlapping passes when
 * pressure > 0). Pure; injects nothing into the emitter.
 */
export function modulateStroke(pl: Polyline, opts: ModulateOptions): Polyline[] {
  if (!isDrawable(pl)) return []
  const smoothing = Math.min(Math.max(opts.smoothing ?? 0, 0), 1)
  const pressure = Math.min(Math.max(opts.pressure ?? 0, 0), 1)

  // 1) Corner rounding via Chaikin's algorithm (iteration count scales 0..3).
  let pts = pl.points.map((p) => ({ x: p.x, y: p.y }))
  const iters = Math.round(smoothing * 3)
  for (let it = 0; it < iters; it++) pts = chaikin(pts, pl.closed)

  const smooth = new Polyline()
  smooth.closed = pl.closed
  for (const p of pts) smooth.add(p)
  if (pressure <= 0 || pts.length < 3) return [smooth]

  // 2) Pressure taper: find the slowest points (sharpest turns) and the ends,
  // and add a short retrace pass over the neighbourhood of each so more ink is
  // laid down there. The retrace is a tiny sub-path that shares geometry with
  // the main stroke (pen stays roughly in place), reading as a pressed nib.
  const out: Polyline[] = [smooth]
  const span = Math.max(1, Math.round(pts.length * 0.08 * pressure))
  const anchors: number[] = []
  if (!pl.closed) {
    anchors.push(0, pts.length - 1) // stroke ends: a human starts/ends pressed.
  }
  // Sharpest interior turns.
  let sharpestIdx = -1
  let sharpestTurn = 0
  for (let i = 1; i < pts.length - 1; i++) {
    const turn = turnAngle(pts[i - 1], pts[i], pts[i + 1])
    if (turn > sharpestTurn) {
      sharpestTurn = turn
      sharpestIdx = i
    }
  }
  if (sharpestIdx !== -1 && sharpestTurn > 0.35) anchors.push(sharpestIdx)

  for (const a of anchors) {
    const s = Math.max(0, a - span)
    const e = Math.min(pts.length - 1, a + span)
    if (e - s < 1) continue
    const retrace = new Polyline()
    for (let i = s; i <= e; i++) retrace.add({ x: pts[i].x, y: pts[i].y })
    if (isDrawable(retrace)) out.push(retrace)
  }
  return out
}

/** One Chaikin corner-cutting pass (open or closed). */
function chaikin(pts: Point[], closed: boolean): Point[] {
  if (pts.length < 3) return pts.map((p) => ({ x: p.x, y: p.y }))
  const out: Point[] = []
  if (!closed) out.push({ x: pts[0].x, y: pts[0].y })
  const n = pts.length
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
  }
  if (!closed) out.push({ x: pts[n - 1].x, y: pts[n - 1].y })
  return out
}

/** Unsigned turn angle (radians) at b between segments a→b and b→c. */
function turnAngle(a: Point, b: Point, c: Point): number {
  const v1x = b.x - a.x
  const v1y = b.y - a.y
  const v2x = c.x - b.x
  const v2y = c.y - b.y
  const l1 = Math.hypot(v1x, v1y)
  const l2 = Math.hypot(v2x, v2y)
  if (l1 < kEpsilon || l2 < kEpsilon) return 0
  const dot = (v1x * v2x + v1y * v2y) / (l1 * l2)
  return Math.acos(Math.min(1, Math.max(-1, dot)))
}

/** Apply {@link modulateStroke} across a set of strokes (S1). */
export function modulateStrokes(polys: Polyline[], opts: ModulateOptions): Polyline[] {
  if ((opts.smoothing ?? 0) <= 0 && (opts.pressure ?? 0) <= 0)
    return polys.filter(isDrawable).map(clonePolyline)
  const out: Polyline[] = []
  for (const pl of polys) for (const m of modulateStroke(pl, opts)) out.push(m)
  return out
}

// ── W1–W9 combined pipeline ──────────────────────────────────────────────────

export interface OptimizeOptions {
  /** W2: Douglas-Peucker tolerance, mm (0 = off). */
  simplifyTol?: number
  /** W2: dedupe consecutive-vertex weld tolerance, mm (0 = off). */
  dedupeTol?: number
  /** W1: merge touching endpoints into longer paths. */
  merge?: boolean
  /** W1: endpoint weld tolerance for merge + closed detection, mm. */
  weldTol?: number
  /** W7: hidden-line / occlusion removal. */
  occlusion?: boolean
  /** W8: randomize the seam on closed paths. */
  reloop?: boolean
  /** W8: RNG for reloop (injectable for determinism). */
  rng?: () => number
  /** W1: greedy nearest-neighbour sort to cut pen-up travel. */
  sort?: boolean
  /** linesort start point (defaults to origin). */
  startAt?: Point
  /** W3: number of passes per path (>=1). */
  passes?: number
}

/**
 * Run the selected pen-path optimizations in the order that makes them compose
 * correctly: dedupe → simplify → merge → occlusion → reloop → sort → multipass.
 * (Simplify/merge BEFORE occlusion so we clip clean geometry; sort AFTER
 * occlusion so travel reflects the final fragments; multipass LAST so the sorted
 * order is preserved and each path is repeated in place.) Returns NEW polylines.
 */
export function optimizePenPaths(polys: Polyline[], opts: OptimizeOptions): Polyline[] {
  const weldTol = opts.weldTol ?? DEFAULT_WELD_TOL
  let out = polys.filter(isDrawable).map(clonePolyline)
  if (opts.dedupeTol && opts.dedupeTol > 0) out = dedupe(out, opts.dedupeTol)
  if (opts.simplifyTol && opts.simplifyTol > 0) out = out.map((p) => simplify(p, opts.simplifyTol!))
  if (opts.merge) out = linemerge(out, weldTol)
  if (opts.occlusion) out = occlude(out)
  if (opts.reloop) out = reloop(out, opts.rng)
  if (opts.sort) out = linesort(out, opts.startAt)
  if (opts.passes && opts.passes > 1) out = multipass(out, opts.passes)
  return out
}
