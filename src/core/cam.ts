// Wood-carving CAM operations: profile / pocket / engrave — UI-independent.
// Ported from the Qt/C++ reference cadcam/camoperations.{h,cpp}.

import { Point, Polyline, kEpsilon, orderLoopsInsideOut } from './geometry';
import { Tool, Toolpath, defaultTool, toolRadius } from './toolpath';
import { insetRings, offsetPolygon } from './offset';

/** Which side of a closed contour the tool runs on. */
export enum ProfileSide {
  On = 'On', // follow the contour centreline (engrave-on-line)
  Inside = 'Inside', // offset inward by the tool radius
  Outside = 'Outside', // offset outward by the tool radius
}

/** Shared cutting parameters for a single CAM operation. */
export interface CamParams {
  tool: Tool;
  safeZ: number; // retract height above the stock (mm)
  surfaceZ: number; // top surface of the stock (mm)
  cutDepth: number; // total depth to remove, >= 0; floor = surfaceZ - cutDepth
  // Depth per pass comes from tool.stepdown; <= 0 means a single full-depth pass.
}

export function defaultCamParams(overrides: Partial<CamParams> = {}): CamParams {
  return {
    tool: overrides.tool ?? defaultTool(),
    safeZ: 5.0,
    surfaceZ: 0.0,
    cutDepth: 1.0,
    ...overrides,
  };
}

/**
 * Append a single closed/open loop cut at depth z, retracting to safeZ after.
 * Assumes the spindle is already running and Z starts at/above safeZ.
 */
function cutLoop(tp: Toolpath, loop: Polyline, z: number, safeZ: number): void {
  if (loop.points.length < 2) return;

  const start = loop.points[0];
  // Position above the entry point, then plunge.
  tp.rapid({ x: start.x, y: start.y, z: safeZ });
  tp.plunge({ x: start.x, y: start.y, z });

  for (let i = 1; i < loop.points.length; ++i)
    tp.feed({ x: loop.points[i].x, y: loop.points[i].y, z });

  if (loop.closed) tp.feed({ x: start.x, y: start.y, z });

  const end: Point = loop.closed ? start : loop.points[loop.points.length - 1];
  tp.rapid({ x: end.x, y: end.y, z: safeZ }); // retract straight up
}

/**
 * Compute the descending list of Z levels for multi-pass cutting. The final
 * level always equals the floor (surfaceZ - cutDepth).
 */
export function depthLevels(p: CamParams): number[] {
  const levels: number[] = [];
  const floorZ = p.surfaceZ - Math.abs(p.cutDepth);

  if (p.tool.stepdown <= 0 || Math.abs(p.cutDepth) < kEpsilon) {
    levels.push(floorZ);
    return levels;
  }

  let z = p.surfaceZ - p.tool.stepdown;
  while (z > floorZ + kEpsilon) {
    levels.push(z);
    z -= p.tool.stepdown;
  }
  levels.push(floorZ); // guarantee we reach the exact floor
  return levels;
}

/** Follow each polyline (open or closed) with the tool centre on the path. */
export function engrave(paths: Polyline | Polyline[], p: CamParams): Toolpath {
  const list = Array.isArray(paths) ? paths : [paths];
  const tp = new Toolpath();
  tp.name = 'Engrave';
  const levels = depthLevels(p);

  for (const z of levels) {
    for (const path of list) {
      if (path.points.length >= 2) cutLoop(tp, path, z, p.safeZ);
    }
  }
  return tp;
}

/**
 * Profile a closed contour on/inside/outside, with multi-depth passes.
 * Falls back to engrave (follow) when the contour is not closed.
 */
export function profile(contour: Polyline, side: ProfileSide, p: CamParams): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Profile';

  // Open contours can't have a meaningful inside/outside — just follow them.
  if (!contour.closed || contour.points.length < 3) {
    tp.name = 'Profile (follow)';
    const levels = depthLevels(p);
    for (const z of levels) cutLoop(tp, contour, z, p.safeZ);
    return tp;
  }

  let path: Polyline;
  switch (side) {
    case ProfileSide.On:
      path = contour.clone();
      path.closed = true;
      break;
    case ProfileSide.Outside:
      path = offsetPolygon(contour, +toolRadius(p.tool));
      break;
    case ProfileSide.Inside:
      path = offsetPolygon(contour, -toolRadius(p.tool));
      break;
  }

  if (path.points.length < 3) return tp; // offset collapsed (tool too big for an inside profile)

  path.closed = true;
  const levels = depthLevels(p);
  for (const z of levels) cutLoop(tp, path, z, p.safeZ);
  return tp;
}

/**
 * Profile MANY closed contours into ONE toolpath, cut INSIDE-OUT so a contour is
 * never freed while a contour nested inside it still has cuts pending.
 *
 * CUT-ORDER SAFETY: when a closed profile loop is fully nested inside another
 * closed loop, cutting the OUTER first can detach the surrounding material so the
 * inner piece (which still needs its own cut) is free to wander. We build a
 * containment tree of the contours and emit them in POST-ORDER (innermost-first);
 * siblings (and unrelated contours) are ordered nearest-neighbour from the
 * previous contour so rapid travel stays minimal subject to that hard constraint.
 *
 * Open / non-closed contours carry no containment relation (they free nothing);
 * they are appended after the closed ones in nearest-neighbour order.
 *
 * Each contour's own offset/direction/lead-in is unchanged — this is purely the
 * order the closed contours are emitted in. Returns one merged {@link Toolpath}.
 */
export function profileContours(contours: Polyline[], side: ProfileSide, p: CamParams): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Profile';

  const closed = contours.filter((c) => c.closed && c.points.length >= 3);
  const open = contours.filter((c) => !(c.closed && c.points.length >= 3));

  // INSIDE-OUT order for the closed contours (children before parents).
  const order = orderLoopsInsideOut(closed);
  let last: Point | undefined;
  for (const idx of order) {
    const sub = profile(closed[idx], side, p);
    appendMoves(tp, sub);
    last = lastXY(sub) ?? last;
  }

  // Open paths: nearest-neighbour from the last position, no containment rule.
  const remaining = open.slice();
  while (remaining.length) {
    let bestK = 0;
    let bestD = Infinity;
    const from = last ?? { x: 0, y: 0 };
    for (let k = 0; k < remaining.length; k++) {
      const s = remaining[k].points[0];
      if (!s) continue;
      const d = (s.x - from.x) ** 2 + (s.y - from.y) ** 2;
      if (d < bestD) {
        bestD = d;
        bestK = k;
      }
    }
    const path = remaining.splice(bestK, 1)[0];
    const sub = profile(path, side, p);
    appendMoves(tp, sub);
    last = lastXY(sub) ?? last;
  }
  return tp;
}

/** Append every move of `src` onto `dst` (used to merge per-contour toolpaths). */
function appendMoves(dst: Toolpath, src: Toolpath): void {
  for (const m of src.moves) dst.moves.push(m);
}

/** Last XY position of a toolpath, or null if it has no moves. */
function lastXY(tp: Toolpath): Point | null {
  if (tp.moves.length === 0) return null;
  const t = tp.moves[tp.moves.length - 1].target;
  return { x: t.x, y: t.y };
}

/** Area-clear a closed boundary with concentric offset rings, multi-depth. */
export function pocket(boundary: Polyline, p: CamParams): Toolpath {
  const tp = new Toolpath();
  tp.name = 'Pocket';

  if (!boundary.closed || boundary.points.length < 3) return tp;

  const step = Math.max(kEpsilon, p.tool.stepover) * p.tool.diameter;
  const rings = insetRings(boundary, toolRadius(p.tool), step);
  if (rings.length === 0) return tp;

  const levels = depthLevels(p);
  for (const z of levels) {
    for (const ring of rings) {
      ring.closed = true;
      cutLoop(tp, ring, z, p.safeZ);
    }
  }
  return tp;
}
