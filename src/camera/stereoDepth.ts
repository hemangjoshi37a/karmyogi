/**
 * stereoDepth — Phase 2 of camera skin tracking: metric depth from two cameras.
 *
 * WHY STEREO: a single camera can't recover absolute scale, so mono "depth" is
 * unreliable. Two calibrated cameras a known baseline apart give true metric
 * depth by triangulation. The full pipeline:
 *
 *   calibrate each cam + the stereo pair (checkerboard)   → calibrateStereo()
 *     → rectify both images so rows align                 → rectify()
 *       → per-pixel disparity (StereoSGBM)                → computeDisparity()
 *         → disparity → metric 3-D point cloud            → disparityToDepth()
 *           → fit a cylinder/surface to the skin          → fitCylinder()
 *             → live limb radius + surface Z for the toolpath (skinTracking store)
 *
 * ── REAL vs STUB (honest scaffold — no fabricated numbers anywhere) ─────────
 *   • REAL: `disparityToDepth` (triangulation math), `fitCylinder` (a genuine
 *     least-squares circle fit in the plane perpendicular to the chosen axis),
 *     and `findCheckerboard` (guarded OpenCV.js `findChessboardCorners`).
 *   • REAL (guarded): `computeDisparity` runs OpenCV.js StereoSGBM/StereoBM when
 *     OpenCV.js is loaded and the build exposes the matcher; Mats are freed.
 *   • HONEST STUB: `calibrateStereo` and `rectify` are wired and validated but
 *     the heavy multi-view solve / remap is not built yet — they return a clear
 *     status ('opencv-not-loaded' | 'needs-calibration' | 'not-implemented'),
 *     never fake intrinsics or a fake rectified image.
 *
 * Every step returns a `StereoStepResult<T>` carrying an honest `status`, so the
 * Tattoo panel / `skinTracking` store can surface exactly where the pipeline is.
 */

import { getOpenCV } from './opencvLoader'

/** Honest status for any pipeline step. */
export type StereoStatus =
  | 'ok'
  | 'opencv-not-loaded'
  | 'needs-calibration'
  | 'not-implemented'
  | 'bad-input'
  | 'error'

/** Uniform result wrapper: `ok` + an honest `status` + optional `data`. */
export interface StereoStepResult<T> {
  ok: boolean
  status: StereoStatus
  data?: T
  /** Optional human-readable note (e.g. why a stub returned not-implemented). */
  note?: string
}

/** Pinhole intrinsics (pixels) + radial/tangential distortion coefficients. */
export interface CameraIntrinsics {
  fx: number
  fy: number
  cx: number
  cy: number
  /** OpenCV distortion vector [k1, k2, p1, p2, k3]. */
  dist: number[]
}

/** Result of a full stereo calibration (the inputs the rest of the pipe needs). */
export interface StereoCalibration {
  left: CameraIntrinsics
  right: CameraIntrinsics
  /** 3×3 rotation, row-major, left→right camera. */
  R: number[]
  /** 3×1 translation (mm), left→right camera. */
  T: number[]
  /** Stereo baseline (mm) = |T|. */
  baselineMm: number
  imageSize: { width: number; height: number }
}

/** One captured checkerboard view: matched corner lists from both cameras. */
export interface CheckerboardView {
  left: { x: number; y: number }[]
  right: { x: number; y: number }[]
}

/** A rectified stereo pair + the 4×4 reprojection matrix Q. */
export interface RectifiedPair {
  left: ImageData
  right: ImageData
  /** 4×4 row-major reprojection matrix (for disparity → 3-D). */
  Q: number[]
}

/** A dense disparity map (pixels), one float per pixel; invalid = NaN. */
export interface DisparityMap {
  width: number
  height: number
  /** Row-major disparity in pixels; NaN where no match. */
  data: Float32Array
}

export interface DisparityOptions {
  /** SGBM minimum disparity. Default 0. */
  minDisparity?: number
  /** Number of disparities (multiple of 16). Default 64. */
  numDisparities?: number
  /** Matched block size (odd). Default 5. */
  blockSize?: number
}

/** A single 3-D point (mm) in the left-camera frame. */
export interface Point3 {
  x: number
  y: number
  z: number
}

export type PointCloud = Point3[]

export interface DepthOptions {
  /** Focal length (px) — typically the rectified left fx. */
  fx: number
  /** Stereo baseline (mm). */
  baselineMm: number
  /** Principal point (px). Default = image centre. */
  cx?: number
  cy?: number
  /** Ignore disparities ≤ this (noise floor). Default 0.5 px. */
  minDisparity?: number
  /** Subsample stride to bound the cloud size. Default 4. */
  step?: number
}

/** A fitted cylinder model of the skin/limb surface. */
export interface CylinderFit {
  /** Cylinder radius (mm). */
  radius: number
  /** Unit axis direction (the limb's long axis) in the cloud frame. */
  axis: [number, number, number]
  /** Highest surface Z (mm) — the toolpath's skin-Z datum (limb top). */
  topZ: number
}

export interface CylinderOptions {
  /** Which axis the limb runs ALONG (the circle is fit in the other two). */
  axis?: 'x' | 'y'
}

/** Minimum checkerboard views before a stereo solve is meaningful. */
const MIN_CALIB_VIEWS = 8

/**
 * Detect a checkerboard's inner corners in one image. REAL — guarded OpenCV.js
 * `findChessboardCorners`. Returns the corner pixels, or `null` if OpenCV isn't
 * loaded / the build lacks the function / no board was found. Mats are freed.
 *
 * @param cols inner corners per row, @param rows inner corners per column.
 */
export function findCheckerboard(image: ImageData, cols: number, rows: number): { x: number; y: number }[] | null {
  const cv = getOpenCV()
  if (!cv || typeof cv.findChessboardCorners !== 'function') return null

  let src: any = null
  let gray: any = null
  let cornersMat: any = null
  let size: any = null
  try {
    src = cv.matFromImageData(image)
    gray = new cv.Mat()
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)
    size = new cv.Size(cols, rows)
    cornersMat = new cv.Mat()
    const found = cv.findChessboardCorners(gray, size, cornersMat, undefined)
    if (!found) return null
    const out: { x: number; y: number }[] = []
    const d = cornersMat.data32F as Float32Array
    const count = (cornersMat.rows ?? 0) * (cornersMat.cols ?? 0)
    for (let i = 0; i < count; i++) out.push({ x: d[i * 2], y: d[i * 2 + 1] })
    return out
  } catch {
    return null
  } finally {
    src?.delete?.()
    gray?.delete?.()
    cornersMat?.delete?.()
    size?.delete?.()
  }
}

/**
 * Stereo-calibrate from accumulated checkerboard views. HONEST STUB: the input
 * validation and gating are real, but the multi-view `cv.stereoCalibrate` solve
 * is the next build step — so this returns a clear status instead of fabricating
 * intrinsics. Gather ≥ `MIN_CALIB_VIEWS` views (via `findCheckerboard`) first.
 */
export function calibrateStereo(
  views: CheckerboardView[],
  boardSquareMm: number,
  imageSize: { width: number; height: number },
): StereoStepResult<StereoCalibration> {
  if (!getOpenCV()) return { ok: false, status: 'opencv-not-loaded' }
  if (boardSquareMm <= 0 || imageSize.width <= 0 || imageSize.height <= 0) {
    return { ok: false, status: 'bad-input', note: 'board square size and image dimensions must be positive' }
  }
  if (views.length < MIN_CALIB_VIEWS) {
    return {
      ok: false,
      status: 'needs-calibration',
      note: `captured ${views.length}/${MIN_CALIB_VIEWS} checkerboard views`,
    }
  }
  // Enough views collected, but the actual solve isn't wired yet.
  return {
    ok: false,
    status: 'not-implemented',
    note: 'cv.stereoCalibrate solve is the next build step (intrinsics/extrinsics not yet computed)',
  }
}

/**
 * Rectify a stereo pair so corresponding points share a row (a precondition for
 * disparity). HONEST STUB: requires a calibration; the `cv.stereoRectify` +
 * `initUndistortRectifyMap` + `remap` wiring is pending, so this reports status
 * rather than returning an un-rectified image dressed up as rectified.
 */
export function rectify(left: ImageData, right: ImageData, calib: StereoCalibration | null): StereoStepResult<RectifiedPair> {
  if (!calib) return { ok: false, status: 'needs-calibration' }
  if (!getOpenCV()) return { ok: false, status: 'opencv-not-loaded' }
  if (left.width !== right.width || left.height !== right.height) {
    return { ok: false, status: 'bad-input', note: 'left/right frames must share dimensions' }
  }
  return {
    ok: false,
    status: 'not-implemented',
    note: 'stereoRectify + initUndistortRectifyMap + remap wiring is the next build step',
  }
}

/**
 * Compute a dense disparity map from a RECTIFIED pair. REAL (guarded): uses
 * OpenCV.js StereoSGBM (preferred) or StereoBM. Returns disparity in pixels
 * (NaN where unmatched). Honest status when OpenCV / the matcher is unavailable.
 */
export function computeDisparity(left: ImageData, right: ImageData, opts: DisparityOptions = {}): StereoStepResult<DisparityMap> {
  const cv = getOpenCV()
  if (!cv) return { ok: false, status: 'opencv-not-loaded' }
  if (left.width !== right.width || left.height !== right.height) {
    return { ok: false, status: 'bad-input', note: 'left/right frames must share dimensions' }
  }
  const hasSGBM = typeof cv.StereoSGBM_create === 'function'
  const hasBM = typeof cv.StereoBM_create === 'function'
  if (!hasSGBM && !hasBM) {
    return { ok: false, status: 'not-implemented', note: 'this OpenCV.js build exposes neither StereoSGBM nor StereoBM' }
  }

  const minDisparity = opts.minDisparity ?? 0
  const numDisparities = opts.numDisparities ?? 64
  const blockSize = opts.blockSize ?? 5

  let lSrc: any = null
  let rSrc: any = null
  let lGray: any = null
  let rGray: any = null
  let matcher: any = null
  let disp16: any = null
  try {
    lSrc = cv.matFromImageData(left)
    rSrc = cv.matFromImageData(right)
    lGray = new cv.Mat()
    rGray = new cv.Mat()
    cv.cvtColor(lSrc, lGray, cv.COLOR_RGBA2GRAY)
    cv.cvtColor(rSrc, rGray, cv.COLOR_RGBA2GRAY)

    matcher = hasSGBM
      ? cv.StereoSGBM_create(minDisparity, numDisparities, blockSize)
      : cv.StereoBM_create(numDisparities, blockSize)

    disp16 = new cv.Mat()
    matcher.compute(lGray, rGray, disp16) // CV_16S, fixed-point ×16

    const width = left.width
    const height = left.height
    const out = new Float32Array(width * height)
    const raw = disp16.data16S as Int16Array
    for (let i = 0; i < out.length; i++) {
      const v = raw[i] / 16 // undo the ×16 fixed point
      out[i] = v > minDisparity ? v : NaN
    }
    return { ok: true, status: 'ok', data: { width, height, data: out } }
  } catch {
    return { ok: false, status: 'error' }
  } finally {
    lSrc?.delete?.()
    rSrc?.delete?.()
    lGray?.delete?.()
    rGray?.delete?.()
    matcher?.delete?.()
    disp16?.delete?.()
  }
}

/**
 * Triangulate a disparity map into a metric 3-D point cloud. REAL — the textbook
 * pinhole stereo formulas: Z = fx·baseline / disparity, X = (u−cx)·Z/fx,
 * Y = (v−cy)·Z/fx. No OpenCV needed. Subsamples by `step` to bound cloud size.
 */
export function disparityToDepth(disp: DisparityMap, opts: DepthOptions): StereoStepResult<PointCloud> {
  if (opts.fx <= 0 || opts.baselineMm <= 0) {
    return { ok: false, status: 'bad-input', note: 'fx and baselineMm must be positive' }
  }
  const { width, height, data } = disp
  const fx = opts.fx
  const cx = opts.cx ?? width / 2
  const cy = opts.cy ?? height / 2
  const minD = opts.minDisparity ?? 0.5
  const step = Math.max(1, Math.floor(opts.step ?? 4))

  const cloud: PointCloud = []
  for (let v = 0; v < height; v += step) {
    for (let u = 0; u < width; u += step) {
      const d = data[v * width + u]
      if (!Number.isFinite(d) || d <= minD) continue
      const z = (fx * opts.baselineMm) / d
      cloud.push({ x: ((u - cx) * z) / fx, y: ((v - cy) * z) / fx, z })
    }
  }
  if (cloud.length === 0) return { ok: false, status: 'bad-input', note: 'no valid disparities to triangulate' }
  return { ok: true, status: 'ok', data: cloud }
}

/**
 * Fit a cylinder to a point cloud of the skin. REAL — a least-squares (Kåsa)
 * circle fit in the plane perpendicular to the chosen limb axis, giving the limb
 * radius; `topZ` is the highest surface Z (the toolpath's skin datum). Assumes
 * the limb runs roughly along `axis` (default 'x'), matching the panel's wrap
 * model; a full free-axis RANSAC cylinder fit is a future refinement. Returns
 * `null` for too few / degenerate points.
 */
export function fitCylinder(cloud: PointCloud, opts: CylinderOptions = {}): CylinderFit | null {
  if (!cloud || cloud.length < 8) return null
  const along = opts.axis ?? 'x'

  // Project onto the plane perpendicular to the limb axis. Fit the circle there;
  // the third coordinate (height above bed) is always z, which gives topZ.
  // For axis 'x' the circle lives in (y, z); for axis 'y' it lives in (x, z).
  let sumU = 0
  let sumV = 0
  let sumUU = 0
  let sumVV = 0
  let sumUV = 0
  let sumUUU = 0
  let sumVVV = 0
  let sumUVV = 0
  let sumVUU = 0
  let topZ = -Infinity
  const n = cloud.length
  for (const p of cloud) {
    const u = along === 'x' ? p.y : p.x
    const v = p.z
    const uu = u * u
    const vv = v * v
    sumU += u
    sumV += v
    sumUU += uu
    sumVV += vv
    sumUV += u * v
    sumUUU += uu * u
    sumVVV += vv * v
    sumUVV += u * vv
    sumVUU += v * uu
    if (p.z > topZ) topZ = p.z
  }

  // Kåsa circle fit: solve the 2×2 normal equations for the centre (uc, vc).
  const a11 = 2 * (sumUU - (sumU * sumU) / n)
  const a12 = 2 * (sumUV - (sumU * sumV) / n)
  const a22 = 2 * (sumVV - (sumV * sumV) / n)
  const b1 = sumUUU + sumUVV - ((sumUU + sumVV) * sumU) / n
  const b2 = sumVVV + sumVUU - ((sumUU + sumVV) * sumV) / n
  const det = a11 * a22 - a12 * a12
  if (Math.abs(det) < 1e-9) return null // collinear / degenerate

  const uc = (b1 * a22 - b2 * a12) / det
  const vc = (a11 * b2 - a12 * b1) / det
  const radius = Math.sqrt(Math.max(0, (sumUU + sumVV) / n - 2 * (uc * (sumU / n) + vc * (sumV / n)) + uc * uc + vc * vc))
  if (!Number.isFinite(radius) || radius <= 0) return null

  const axis: [number, number, number] = along === 'x' ? [1, 0, 0] : [0, 1, 0]
  return { radius, axis, topZ: Number.isFinite(topZ) ? topZ : 0 }
}
