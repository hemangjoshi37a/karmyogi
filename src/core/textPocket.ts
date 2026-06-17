// Text-area pocketing — UI-independent, pure TS (no DOM/React).
//
// Two Writing modes need an AREA-CLEAR (pocket) over arbitrary glyph regions
// that can contain HOLES (letter counters like the inside of an 'O') and
// ISLANDS (whole letters that must be left standing, as in a Relief carve):
//
//   Carve in — pocket INSIDE the letters → recessed/engraved text.
//   Relief   — pocket OUTSIDE the letters (a bordered rectangle minus the
//              letters) → raised text; the letter bodies + their counters are
//              left as uncut islands.
//
// We clear the area with an EVEN-ODD SCANLINE FILL rather than polygon
// offsetting. This is robust and assumption-free:
//
//   * We treat the region as a flat SET of closed contour edges and use the
//     even-odd rule (parity of crossings) to decide what is "inside". With
//     even-odd, holes and islands are handled AUTOMATICALLY with no winding /
//     orientation bookkeeping: a counter inside a letter flips parity back to
//     "outside", and in Relief the letters themselves (nested inside the
//     border rectangle) flip parity to "outside" so they are never cut.
//
//   * For each scan row we collect the x-crossings, sort them, and pair them by
//     even-odd parity into inside spans. Each span is INSET BY THE TOOL RADIUS r
//     on both ends so the TOOL stays within the region — the cleared area then
//     equals the region with accurate edges (the cutter never overruns a wall).
//     Rows themselves are stepped from minY+r to maxY-r for the same reason.
//
//   * Rows alternate direction (BOUSTROPHEDON) to minimise travel, and spans are
//     returned as discrete 2-point segments. The toolpath builder decides
//     linking and NEVER links across a hole/island (that would gouge a relief
//     letter); when unsure it retracts.

import { Point, Polyline, kEpsilon } from './geometry';
import { Toolpath } from './toolpath';
import { depthLevels } from './cam';
import polygonClipping from 'polygon-clipping';
import type { MultiPolygon, Ring } from 'polygon-clipping';

const N_GON = 14; // sides of the round-join/cap approximation circle
const SNAP = 1e-3; // coordinate snap grid (mm) to defuse near-coincident vertices

/** Snap a coordinate to the SNAP grid (kills floating-point near-coincidences). */
function snap(v: number): number {
  return Math.round(v / SNAP) * SNAP;
}

/** A closed segment edge used by the scanline (with precomputed y-extent). */
interface Edge {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Convert a polygon-clipping Ring to a CLOSED Polyline. */
function fromRing(ring: Ring): Polyline {
  const pl = new Polyline();
  // polygon-clipping rings repeat the first point at the end — drop it.
  const n = ring.length;
  const end = n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1] ? n - 1 : n;
  for (let i = 0; i < end; i++) pl.add({ x: ring[i][0], y: ring[i][1] });
  pl.closed = true;
  return pl;
}

/** Flatten every ring (outer + holes) of a MultiPolygon into closed Polylines. */
function flattenMulti(mp: MultiPolygon): Polyline[] {
  const out: Polyline[] = [];
  for (const poly of mp) for (const ring of poly) {
    if (ring.length >= 3) out.push(fromRing(ring));
  }
  return out;
}

/** Convert a closed Polyline to a polygon-clipping single-ring Polygon (snapped). */
function toClipPoly(pl: Polyline): Ring[] {
  const ring: Ring = pl.points.map((p) => [snap(p.x), snap(p.y)] as [number, number]);
  if (ring.length) ring.push([ring[0][0], ring[0][1]]);
  return [ring];
}

/**
 * UNION a set of closed contours into clean, non-overlapping, correctly-wound
 * rings (outer + holes). This is the key robustness step for arbitrary font
 * glyphs: outline fonts — especially SCRIPT / CALLIGRAPHIC ones — emit contours
 * that OVERLAP each other (connected cursive strokes) or use inconsistent
 * winding. A raw even-odd scanline over overlapping same-winding contours would
 * wrongly treat the overlap as a hole; unioning first resolves all overlaps so
 * the subsequent even-odd fill is exactly correct. Done INCREMENTALLY with a
 * try/catch so one degenerate glyph can't abort the whole union (polygon-clipping
 * can throw "Unable to complete output ring" on near-degenerate input).
 */
export function unionContours(contours: Polyline[]): Polyline[] {
  const polys = contours.filter((c) => c.points.length >= 3).map(toClipPoly);
  if (polys.length === 0) return [];
  let acc: MultiPolygon = [polys[0]];
  for (let i = 1; i < polys.length; i++) {
    try {
      acc = polygonClipping.union(acc, [polys[i]]);
    } catch {
      // Skip a degenerate glyph contour; the rest still union correctly.
    }
  }
  return flattenMulti(acc);
}

/** A regular n-gon (CCW) approximating a circle of `r` about `c`, as a Ring. */
function circleRing(c: Point, r: number, sides = N_GON): Ring {
  const ring: Ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (2 * Math.PI * i) / sides;
    ring.push([snap(c.x + r * Math.cos(a)), snap(c.y + r * Math.sin(a))]);
  }
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

/**
 * Thicken OPEN centerlines into CLOSED filled contours of width `strokeWidthMm`.
 * Each segment becomes a rectangle offset by half-width along both normals, and
 * a small circle is added at every vertex/endpoint for round joins + caps. All
 * primitives are unioned into one MultiPolygon, then every resulting ring (outer
 * + holes) is returned as a closed Polyline.
 */
export function bufferStrokesToContours(open: Polyline[], strokeWidthMm: number): Polyline[] {
  const hw = Math.max(kEpsilon, strokeWidthMm / 2);
  const prims: MultiPolygon = [];

  for (const pl of open) {
    const pts = pl.points;
    if (pts.length === 0) continue;
    if (pts.length === 1) {
      prims.push([circleRing(pts[0], hw)]);
      continue;
    }
    // Round cap/join circle at every vertex.
    for (const p of pts) prims.push([circleRing(p, hw)]);
    // Offset rectangle along each segment.
    const segCount = pl.closed ? pts.length : pts.length - 1;
    for (let i = 0; i < segCount; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < kEpsilon) continue;
      const nx = (-dy / len) * hw;
      const ny = (dx / len) * hw;
      const ring: Ring = [
        [snap(a.x + nx), snap(a.y + ny)],
        [snap(b.x + nx), snap(b.y + ny)],
        [snap(b.x - nx), snap(b.y - ny)],
        [snap(a.x - nx), snap(a.y - ny)],
      ];
      ring.push([ring[0][0], ring[0][1]]);
      prims.push([ring]);
    }
  }

  if (prims.length === 0) return [];

  // ROBUSTNESS: polygon-clipping can throw ("Unable to complete output ring") on
  // certain near-degenerate overlaps. Accumulate the union INCREMENTALLY and, if
  // a step throws, fall back to a chunked retry; any chunk that still fails is
  // skipped (its strokes already overlap others, so the filled area is preserved).
  let acc: MultiPolygon = [prims[0]];
  const safeUnion = (a: MultiPolygon, b: MultiPolygon): MultiPolygon | null => {
    try {
      return polygonClipping.union(a, b);
    } catch {
      return null;
    }
  };
  for (let i = 1; i < prims.length; i++) {
    const next = safeUnion(acc, [prims[i]]);
    if (next) acc = next;
    // else: skip this primitive (overlapping neighbours keep the area filled).
  }
  return flattenMulti(acc);
}

/**
 * A closed CCW rectangle = union bbox of all `contours`, expanded by `marginMm`.
 * Used as the Relief border so the pocket clears everything between the letters
 * and the rectangle edge.
 */
export function boundsRect(contours: Polyline[], marginMm: number): Polyline {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of contours) for (const p of c.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const m = Math.max(0, marginMm);
  const pl = new Polyline();
  if (!Number.isFinite(minX)) {
    pl.closed = true;
    return pl;
  }
  // CCW winding.
  pl.add({ x: minX - m, y: minY - m });
  pl.add({ x: maxX + m, y: minY - m });
  pl.add({ x: maxX + m, y: maxY + m });
  pl.add({ x: minX - m, y: maxY + m });
  pl.closed = true;
  return pl;
}

export interface ScanlineOptions {
  toolDiameterMm: number;
  stepoverFrac: number;
  angleDeg?: number;
}

/** Build the flat closed-edge set from a contour list (closing each ring). */
function buildEdges(contours: Polyline[]): Edge[] {
  const edges: Edge[] = [];
  for (const c of contours) {
    const n = c.points.length;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const a = c.points[i];
      const b = c.points[(i + 1) % n]; // always closed for fill
      edges.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
    }
  }
  return edges;
}

function rotPt(p: Point, cos: number, sin: number): Point {
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

/**
 * EVEN-ODD scanline area-clear over `contours` (treated as a flat closed-edge
 * set). Returns the cut spans as 2-point OPEN Polylines, inset by the tool
 * radius so the tool stays inside the region (accurate edges). Holes/islands
 * fall out of even-odd parity automatically. Rows alternate L→R / R→L. `angle`
 * is implemented by rotating the contours by -angle before scanning and the
 * output back by +angle.
 */
export function scanlinePocket(contours: Polyline[], opts: ScanlineOptions): Polyline[] {
  const r = Math.max(kEpsilon, opts.toolDiameterMm / 2);
  const pitch = Math.max(kEpsilon, opts.stepoverFrac) * Math.max(kEpsilon, opts.toolDiameterMm);
  const angle = ((opts.angleDeg ?? 0) * Math.PI) / 180;

  // Rotate contours by -angle so we can scan along horizontal rows.
  const cosN = Math.cos(-angle);
  const sinN = Math.sin(-angle);
  const rotated = contours.map((c) => {
    const pl = new Polyline();
    pl.closed = true;
    pl.points = c.points.map((p) => rotPt(p, cosN, sinN));
    return pl;
  });

  const edges = buildEdges(rotated);
  if (edges.length === 0) return [];

  let minY = Infinity;
  let maxY = -Infinity;
  for (const e of edges) {
    minY = Math.min(minY, e.y0, e.y1);
    maxY = Math.max(maxY, e.y0, e.y1);
  }

  // Rotate output spans back by +angle.
  const cosB = Math.cos(angle);
  const sinB = Math.sin(angle);

  const out: Polyline[] = [];
  let row = 0;
  for (let y = minY + r; y <= maxY - r + kEpsilon; y += pitch, row++) {
    // Collect x-crossings using the half-open rule [y0,y1) to avoid double
    // counting at shared vertices (standard even-odd scanline convention).
    const xs: number[] = [];
    for (const e of edges) {
      const yA = e.y0;
      const yB = e.y1;
      // Half-open: count if y is in [min,max) of the edge's y-range.
      if ((yA <= y && yB > y) || (yB <= y && yA > y)) {
        const t = (y - yA) / (yB - yA);
        xs.push(e.x0 + t * (e.x1 - e.x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);

    // Even-odd: inside spans are [x[0],x[1]], [x[2],x[3]], ...
    // For a span WIDER than the tool we inset by r on both ends so the tool stays
    // inside the region (accurate edges). For a NARROWER-but-real feature (e.g. a
    // thin glyph stem the tool can't fully fit between) we still cut a SINGLE
    // CENTERED pass so the feature is engraved rather than silently dropped —
    // standard for thin text; the tool tracks the feature's centreline.
    const spans: { x0: number; x1: number }[] = [];
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = xs[k];
      const x1 = xs[k + 1];
      const w = x1 - x0;
      if (w > 2 * r + kEpsilon) {
        spans.push({ x0: x0 + r, x1: x1 - r });
      } else if (w > kEpsilon) {
        const mid = (x0 + x1) / 2;
        spans.push({ x0: mid, x1: mid }); // single centred plunge-cut
      }
    }
    if (spans.length === 0) continue;

    // Boustrophedon: reverse every other occupied row.
    const ltr = row % 2 === 0;
    const ordered = ltr ? spans : spans.slice().reverse();
    for (const sp of ordered) {
      const [a, b] = ltr ? [sp.x0, sp.x1] : [sp.x1, sp.x0];
      const seg = new Polyline();
      seg.add(rotPt({ x: a, y }, cosB, sinB));
      seg.add(rotPt({ x: b, y }, cosB, sinB));
      seg.closed = false;
      out.push(seg);
    }
  }
  return out;
}

export interface PocketParams {
  toolDiameterMm: number;
  stepoverFrac: number;
  stepdownMm: number;
  cutDepthMm: number;
  safeZ: number;
  surfaceZ: number;
  feedXY: number;
}

/** Even-odd inside test against a flat closed-edge set (parity of x-crossings). */
function insideEvenOdd(contours: Polyline[], p: Point): boolean {
  let inside = false;
  for (const c of contours) {
    const n = c.points.length;
    if (n < 3) continue;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const pi = c.points[i];
      const pj = c.points[j];
      const crosses = pi.y > p.y !== pj.y > p.y;
      if (crosses) {
        const xCross = ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x;
        if (p.x < xCross) inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * Build a multi-depth area-clear Toolpath that fills `region` (a flat contour
 * set: glyph fills for Carve-in, or [borderRect, ...glyphFills] for Relief). For
 * each depth level and each scan span we use the SAFE pattern:
 *   rapid (x0,y,safeZ) → plunge (x0,y,z) → feed (x1,y,z) → rapid retract safeZ.
 *
 * Adjacent spans at the same depth are feed-LINKED only when the midpoint of the
 * link passes an even-odd inside-region test (so we never link across a hole or
 * an island — that would gouge a relief letter); otherwise we retract. `region`
 * is the flat contour set the scanline clears (glyph fills for Carve-in, or
 * [borderRect, ...glyphFills] for Relief).
 */
export function pocketContoursToToolpath(
  _contours: Polyline[],
  region: Polyline[],
  params: PocketParams,
): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Writing pocket';

  const spans = scanlinePocket(region, {
    toolDiameterMm: params.toolDiameterMm,
    stepoverFrac: params.stepoverFrac,
  });
  if (spans.length === 0) return tp;

  const levels = depthLevels({
    tool: {
      name: 'pocket',
      diameter: params.toolDiameterMm,
      feedXY: params.feedXY,
      feedZ: params.feedXY,
      spindleRPM: 0,
      stepover: params.stepoverFrac,
      stepdown: params.stepdownMm,
    },
    safeZ: params.safeZ,
    surfaceZ: params.surfaceZ,
    cutDepth: params.cutDepthMm,
  });

  for (const z of levels) {
    let penDown = false;
    let prev: Point | null = null;
    for (const seg of spans) {
      const a = seg.points[0];
      const b = seg.points[seg.points.length - 1];

      // Decide whether we can feed-link from the previous span end to this start
      // (no retract) — only if the link midpoint stays inside the cleared region.
      let link = false;
      if (penDown && prev) {
        const mid = { x: (prev.x + a.x) / 2, y: (prev.y + a.y) / 2 };
        // By the SAME even-odd rule the scanline uses: for Relief this excludes
        // points inside a letter (letters flip parity to "outside"), so we never
        // link across an island; for Carve-in any in-region link is fine.
        const short = Math.hypot(a.x - prev.x, a.y - prev.y) <= params.toolDiameterMm * 1.5;
        link = short && insideEvenOdd(region, mid);
      }

      if (link && prev) {
        tp.feed({ x: a.x, y: a.y, z });
      } else {
        if (penDown && prev) tp.rapid({ x: prev.x, y: prev.y, z: params.safeZ });
        tp.rapid({ x: a.x, y: a.y, z: params.safeZ });
        tp.plunge({ x: a.x, y: a.y, z });
        penDown = true;
      }
      tp.feed({ x: b.x, y: b.y, z });
      prev = { x: b.x, y: b.y };
    }
    if (penDown && prev) tp.rapid({ x: prev.x, y: prev.y, z: params.safeZ });
  }

  return tp;
}
