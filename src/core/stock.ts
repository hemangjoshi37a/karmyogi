/**
 * Stock = the raw workpiece block the machine cuts/engraves/plots on.
 * This is PURE TypeScript (no React/DOM/three/zustand) so it mirrors the Qt
 * `cadcam` lib structure and stays portable.
 *
 * Coordinate model (must match the 3D viewer): work zero is at the origin,
 * Z-up. The XY footprint of the stock can be placed two ways, and work Z0 can
 * reference either the top or the bottom face of the block.
 */

/** Stock dimensions in mm: X width, Y depth, Z height/thickness. */
export interface StockDims {
  width: number
  depth: number
  height: number
}

/**
 * Where work X0/Y0 sits within the stock's XY footprint:
 * - 'center'    → origin is at the middle of the footprint.
 * - 'frontLeft' → origin is at the front-left corner (min X, min Y).
 */
export type XYOrigin = 'center' | 'frontLeft'

/**
 * Which face of the block work Z0 references:
 * - 'top'    → Z0 is the top surface, so material lives below at z in [-H..0].
 * - 'bottom' → Z0 is the bottom surface, so material lives above at z in [0..H].
 */
export type ZRef = 'top' | 'bottom'

export interface StockPlacement {
  dims: StockDims
  xyOrigin: XYOrigin
  zRef: ZRef
}

/**
 * Axis-aligned stock box corners in WORK coordinates (work zero at origin).
 *
 * XY footprint:
 *   - 'center'    → [-W/2 .. +W/2] x [-D/2 .. +D/2]
 *   - 'frontLeft' → [0 .. W]       x [0 .. D]
 * Z extent:
 *   - 'top'    → z in [-H .. 0]   (top face at work Z0, material below)
 *   - 'bottom' → z in [0 .. H]    (bottom face at work Z0, material above)
 */
export function stockBounds(
  p: StockPlacement,
): { min: [number, number, number]; max: [number, number, number] } {
  const { width: w, depth: d, height: h } = p.dims

  // XY: centered footprint straddles the origin; frontLeft anchors min corner at origin.
  const minX = p.xyOrigin === 'center' ? -w / 2 : 0
  const maxX = p.xyOrigin === 'center' ? w / 2 : w
  const minY = p.xyOrigin === 'center' ? -d / 2 : 0
  const maxY = p.xyOrigin === 'center' ? d / 2 : d

  // Z: 'top' puts the top face at z=0 (material below); 'bottom' puts the
  // bottom face at z=0 (material above).
  const minZ = p.zRef === 'top' ? -h : 0
  const maxZ = p.zRef === 'top' ? 0 : h

  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] }
}
