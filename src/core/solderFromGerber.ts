// Extract soldering-point coordinates from parsed Gerber geometry — UI-independent.
// Pure TypeScript: no React/DOM/three.js imports.
//
// The auto-soldering tab places solder at a list of (x, y) points. A Gerber
// layer that carries the solder PADS (typically the paste layer or top copper)
// represents each pad as a FLASH — recorded by the existing Gerber parser as a
// closed `pad` polygon (circle or rectangle outline) in `GerberData.pads`. The
// centre of each pad polygon is the point where solder should be placed.
//
// We reuse that parsed geometry (never re-parse) and turn every pad's bounding
// box centre into one candidate soldering point, deduping coincident pads (the
// same hole can be flashed on several layers / multiple times) and rounding to a
// sensible precision. Coordinates are in millimetres, in the Gerber's own
// coordinate space — the operator zeros the machine to the board origin so this
// space lines up with the work coordinate system.

import type { GerberData } from './gerber';

/** A bare soldering-point coordinate (mm) in the Gerber coordinate space. */
export interface SolderPointXY {
  x: number;
  y: number;
}

/** Round to `decimals` places, normalising -0 to 0 so dedupe keys are stable. */
function round(v: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

/**
 * Convert the flashed PADS of a parsed Gerber layer into soldering-point
 * coordinates. Each pad polygon's bounding-box centre becomes one point.
 *
 * Coincident pads (within `tol` mm, after rounding) are deduped to a single
 * point so a hole flashed on multiple layers / repeatedly doesn't produce a
 * stack of identical points. Output order follows the first occurrence of each
 * unique location in the file.
 *
 * @param gerber parsed layer (uses `gerber.pads`, the D03 flash polygons)
 * @param decimals rounding precision for the emitted coordinates (default 3)
 */
export function padsToSolderPoints(gerber: GerberData, decimals = 3): SolderPointXY[] {
  const out: SolderPointXY[] = [];
  const seen = new Set<string>();
  for (const pad of gerber.pads) {
    const b = pad.bounds();
    if (!b.isValid()) continue;
    const c = b.center();
    const x = round(c.x, decimals);
    const y = round(c.y, decimals);
    const key = `${x},${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y });
  }
  return out;
}
