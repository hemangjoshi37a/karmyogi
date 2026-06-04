/**
 * Kinematics-aware calibration mapping helpers (pure math, NO DOM).
 *
 * The auto-calibrator probes machine axis X then Y from a known start point and,
 * using {@link classifyAxisMotion}, measures the IMAGE pixel displacement caused
 * by +1 mm of motion on each axis — regardless of whether that axis drives the
 * tool HEAD (a localized blob translates) or the BED (the whole frame translates
 * under a fixed camera). This module turns those two per-axis pixel vectors plus
 * the start correspondence into the image⇄machine-mm calibration the rest of the
 * app consumes.
 *
 * Sign convention for the BED case: when an axis moves the BED, a tool/feature
 * that is FIXED in machine space appears to translate in the image OPPOSITE to
 * the way the bed itself moved. We want, for BOTH kinematics, a consistent map
 * "machine +mm on this axis ⇒ which way a machine-fixed point moves in the
 * image". For a HEAD axis the tool IS the machine-fixed reference and its blob
 * delta already encodes that directly. For a BED axis the global frame shift is
 * the motion of the bed/background; a machine-fixed point (e.g. the tool, or the
 * machine origin) moves the OPPOSITE way, so we NEGATE the global shift. After
 * this normalization both axes express the same thing — how a point at fixed
 * MACHINE coordinates moves in the image per mm — which is exactly the Jacobian
 * of the machine-mm → image-pixel map, letting us assemble one affine.
 *
 * This file imports only the pure core (`../core/cameraCalib`); it is exercised
 * by the autoCalib driver and verifiable on synthetic images with a tsx harness.
 */

import {
  solveHomography,
  type GrayImage,
  type Mat3,
  type Vec2,
} from '../core/cameraCalib'
import { classifyAxisMotion } from '../core/cameraCalib'

/** Which machine axis the probe is measuring. */
export type ProbeAxis = 'X' | 'Y'

/** The detected kinematic for one axis + its measured image displacement. */
export interface AxisProbe {
  /** The machine axis this describes. */
  axis: ProbeAxis
  /** Whether this axis drives the tool HEAD, the BED, or showed no usable motion. */
  kind: 'head' | 'bed' | 'none'
  /**
   * Image pixels a MACHINE-FIXED point moves per +1 mm of this axis (already
   * sign-normalized: bed-axis global shift is negated, see the module doc). For
   * a HEAD axis this is the tool blob's centroid delta per mm.
   */
  pxPerMm: Vec2
  /** Raw measured pixel displacement over the full probe delta (before /mm). */
  rawPx: Vec2
  /** The probe delta in mm used for this axis. */
  deltaMm: number
  /** Classifier confidence in `[0, 1]`. */
  confidence: number
}

/**
 * Classify one probe (A = before jog, B = after a +`deltaMm` jog on `axis`) into
 * an {@link AxisProbe}. Sign-normalizes a BED-axis shift (negated) so both axes
 * describe how a machine-fixed point moves in the image per mm.
 *
 * @param axis    The machine axis probed.
 * @param a       Frame captured BEFORE the jog.
 * @param b       Frame captured AFTER the +deltaMm jog.
 * @param deltaMm The (positive) jog distance in mm.
 * @param opts    Optional classifier knobs forwarded to {@link classifyAxisMotion}.
 */
export function classifyProbe(
  axis: ProbeAxis,
  a: GrayImage,
  b: GrayImage,
  deltaMm: number,
  opts?: { maxShiftPx?: number; diffThreshold?: number },
): AxisProbe {
  const c = classifyAxisMotion(a, b, opts)
  const d = deltaMm !== 0 ? deltaMm : 1
  // For a BED axis the global shift is the bed/background motion; a MACHINE-FIXED
  // point moves the OPPOSITE way, so negate to match the HEAD convention.
  const sign = c.kind === 'bed' ? -1 : 1
  const rawPx: Vec2 = [sign * c.px[0], sign * c.px[1]]
  const pxPerMm: Vec2 = [rawPx[0] / d, rawPx[1] / d]
  return {
    axis,
    kind: c.kind,
    pxPerMm,
    rawPx,
    deltaMm,
    confidence: c.confidence,
  }
}

/**
 * A solved kinematics-aware calibration plus the per-axis diagnostics the UI
 * shows so the operator can confirm "X → head, Y → bed", etc.
 */
export interface KinematicMapping {
  /** Row-major 3×3 homography mapping IMAGE-px → machine-mm (length 9). */
  H: Mat3
  /** Reprojection RMS in mm over the synthesized correspondences. */
  rmsMm: number
  /** The X-axis probe diagnostics. */
  xProbe: AxisProbe
  /** The Y-axis probe diagnostics. */
  yProbe: AxisProbe
}

/**
 * Mean of the per-axis pixel-per-mm magnitudes — a quick "image scale" readout.
 */
export function meanPxPerMm(x: AxisProbe, y: AxisProbe): number {
  const sx = Math.hypot(x.pxPerMm[0], x.pxPerMm[1])
  const sy = Math.hypot(y.pxPerMm[0], y.pxPerMm[1])
  return (sx + sy) / 2
}

/**
 * Build the image⇄machine-mm calibration from the start correspondence and the
 * two sign-normalized per-axis pixel Jacobian vectors.
 *
 * Model: a point at machine coords `(X, Y)` images to pixel
 *   `p = startPx + Jx·(X − X0) + Jy·(Y − Y0)`
 * where `Jx = xProbe.pxPerMm`, `Jy = yProbe.pxPerMm`, and `(X0, Y0)` = the start
 * machine XY whose tool/feature pixel is `startPx`. That is an affine machine→
 * image map; we invert it to image→machine and express it as a homography so it
 * drops straight into `useCameraCalib.setCamera` (H maps IMAGE→machine-mm, so
 * the viewer's `invertMat3(H)` for world→image stays correct).
 *
 * Rather than invert the 2×2 by hand (and risk a near-degenerate Jacobian giving
 * a silently-bad inverse), we synthesize four well-spread machine corners around
 * the start, project them through the affine to pixels, and feed the pixel→mm
 * correspondences into the robust normalized-DLT {@link solveHomography} (which
 * also yields a reprojection RMS for the quality chip). The result is an exact
 * affine when the Jacobian is non-degenerate, and {@link solveHomography} returns
 * `null` on a degenerate (collinear / zero-area) Jacobian so the caller can fail
 * cleanly.
 *
 * @param args.startPx   Pixel of a machine-fixed feature at `startXY` (the probe
 *   start). For the head kinematic this is the tool blob centroid; we accept it
 *   from the caller so this stays pure.
 * @param args.startXY   Machine work XY (mm) at the probe start.
 * @param args.xProbe    Sign-normalized X-axis probe (`pxPerMm` = Jx).
 * @param args.yProbe    Sign-normalized Y-axis probe (`pxPerMm` = Jy).
 * @param args.spanMm    Half-extent (mm) of the synthesized correspondence square
 *   around the start (default 20).
 * @returns The {@link KinematicMapping}, or `null` if the Jacobian is degenerate
 *   (parallel/zero axis vectors) so no homography can be solved.
 */
export function buildKinematicMapping(args: {
  startPx: Vec2
  startXY: Vec2
  xProbe: AxisProbe
  yProbe: AxisProbe
  spanMm?: number
}): KinematicMapping | null {
  const { startPx, startXY, xProbe, yProbe } = args
  const span = args.spanMm != null && args.spanMm > 0 ? args.spanMm : 20

  const Jx = xProbe.pxPerMm
  const Jy = yProbe.pxPerMm

  // Reject a degenerate Jacobian early (both axes map to ~the same image
  // direction, or one is ~zero ⇒ no recoverable 2D scale).
  const detJ = Jx[0] * Jy[1] - Jx[1] * Jy[0]
  const sx = Math.hypot(Jx[0], Jx[1])
  const sy = Math.hypot(Jy[0], Jy[1])
  if (sx < 1e-6 || sy < 1e-6 || Math.abs(detJ) < 1e-6 * sx * sy) {
    return null
  }

  // Project a machine point to pixels via the affine.
  const toPx = (X: number, Y: number): Vec2 => [
    startPx[0] + Jx[0] * (X - startXY[0]) + Jy[0] * (Y - startXY[1]),
    startPx[1] + Jx[1] * (X - startXY[0]) + Jy[1] * (Y - startXY[1]),
  ]

  // Four well-spread machine corners around the start.
  const worldPts: Vec2[] = [
    [startXY[0] - span, startXY[1] - span],
    [startXY[0] + span, startXY[1] - span],
    [startXY[0] + span, startXY[1] + span],
    [startXY[0] - span, startXY[1] + span],
  ]
  const imgPts: Vec2[] = worldPts.map((w) => toPx(w[0], w[1]))

  // image-px (src) → machine-mm (dst), matching the other calibration methods.
  const H = solveHomography(imgPts, worldPts)
  if (!H) return null

  // RMS over the synthesized correspondences (exact affine ⇒ ~0).
  let sum = 0
  for (let i = 0; i < imgPts.length; i++) {
    const x = H[0] * imgPts[i][0] + H[1] * imgPts[i][1] + H[2]
    const y = H[3] * imgPts[i][0] + H[4] * imgPts[i][1] + H[5]
    const w = H[6] * imgPts[i][0] + H[7] * imgPts[i][1] + H[8]
    const mx = Math.abs(w) > 1e-12 ? x / w : x
    const my = Math.abs(w) > 1e-12 ? y / w : y
    const dx = mx - worldPts[i][0]
    const dy = my - worldPts[i][1]
    sum += dx * dx + dy * dy
  }
  const rmsMm = Math.sqrt(sum / imgPts.length)

  return { H, rmsMm, xProbe, yProbe }
}
