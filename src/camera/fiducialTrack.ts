/**
 * fiducialTrack — Phase 1 of camera skin tracking: ArUco fiducial markers.
 *
 * WHY FIDUCIALS FIRST: skin is low-texture, so feature-based tracking is fragile.
 * Sticking a few printed ArUco markers near the design gives robust, drift-free
 * 6-DoF detection every frame. Diffing the markers' live positions against a
 * captured "home" frame yields the planar registration offset the toolpath needs
 * to follow a body part that shifts: a translation (dx, dy) + rotation (theta).
 * (Absolute metric depth comes later, from stereo — see stereoDepth.ts.)
 *
 * ── REAL vs STUB ────────────────────────────────────────────────────────────
 *   • REAL: `poseFromMarkers` and `captureReference` are fully implemented in
 *     pure TS. The pose solve is a genuine 2-D rigid (Kabsch/Procrustes) fit over
 *     every matched marker-corner pair → least-squares rotation + translation,
 *     plus a residual-based confidence. No OpenCV needed for this step.
 *   • REAL (guarded): `detectMarkers` runs the actual OpenCV.js ArUco detector
 *     (the modern `cv.ArucoDetector` API) when OpenCV.js is loaded AND the build
 *     includes aruco. Mats are always freed.
 *   • HONEST STUB: when OpenCV.js isn't loaded, or the loaded build lacks the
 *     aruco module (the stock docs.opencv.org build often does — see
 *     opencvLoader CDN note), `detectMarkers` returns `[]` and sets an honest
 *     status ('opencv-not-loaded' / 'aruco-unavailable'). It NEVER fabricates
 *     markers or a pose.
 *
 * Units note: detection is in image PIXELS. `poseFromMarkers` returns the offset
 * in pixels by default; pass `mmPerPx` (from the camera calibration) to get bed
 * millimetres ready for the Tattoo panel / `skinTracking` store. Mapping pixels
 * to bed-mm robustly is the calibration step that bridges Phase 1 → real use.
 */

import { getOpenCV } from './opencvLoader'

/** A 2-D image point in pixels. */
export interface Pt2 {
  x: number
  y: number
}

/** One detected ArUco marker in the current frame (image pixels). */
export interface MarkerHit {
  /** Marker id within its dictionary. */
  id: number
  /** Four corner points (pixels), in OpenCV's detection order. */
  corners: Pt2[]
  /** Marker centroid (pixels) — mean of the four corners. */
  center: Pt2
}

/**
 * Captured "home" positions of the markers, recorded once at the start so live
 * frames diff against it to produce the registration offset.
 */
export interface ReferenceFrame {
  /** Per-marker-id home geometry (pixels). */
  markers: Record<number, { center: Pt2; corners: Pt2[] }>
  /** Capture time (ms epoch) — for staleness display. */
  capturedAt: number
}

/**
 * Planar registration offset that maps the design from its home pose onto the
 * skin's current pose: rotate by `theta` then translate by (dx, dy).
 */
export interface Registration {
  /** X offset (mm if `mmPerPx` was supplied, else pixels). */
  dx: number
  /** Y offset (mm if `mmPerPx` was supplied, else pixels). */
  dy: number
  /** Rotation about the marker centroid, in degrees. */
  theta: number
  /** Heuristic 0..1: blends matched-marker count and fit residual. */
  confidence: number
}

export interface DetectOptions {
  /**
   * Predefined dictionary id (an OpenCV `cv.DICT_*` constant). Defaults to
   * `cv.DICT_4X4_50` (id 0) when omitted.
   */
  dictionary?: number
}

export interface PoseOptions {
  /** Bed mm per image pixel (from calibration). Default 1 → output in pixels. */
  mmPerPx?: number
  /** Residual scale (px) for the confidence falloff. Default 4 px. */
  residualTolPx?: number
}

/** Honest status of the most recent `detectMarkers` call. */
export type FiducialStatus =
  | 'idle'
  | 'opencv-not-loaded'
  | 'aruco-unavailable'
  | 'no-markers'
  | 'ok'
  | 'error'

let lastStatus: FiducialStatus = 'idle'

/** The status of the most recent `detectMarkers` call (for honest UI display). */
export function lastDetectStatus(): FiducialStatus {
  return lastStatus
}

/**
 * Detect ArUco markers in a frame. REAL detection via OpenCV.js when available;
 * otherwise returns `[]` and records an honest status (see `lastDetectStatus`).
 * Always synchronous (uses the already-loaded module) and never throws; all
 * OpenCV Mats are released in `finally`.
 */
export function detectMarkers(image: ImageData, opts: DetectOptions = {}): MarkerHit[] {
  const cv = getOpenCV()
  if (!cv) {
    lastStatus = 'opencv-not-loaded'
    return []
  }
  // We implement the modern objdetect ArUco API. If the loaded build doesn't
  // ship aruco (common with the stock docs CDN build), say so honestly.
  if (typeof cv.ArucoDetector !== 'function' || typeof cv.getPredefinedDictionary !== 'function') {
    lastStatus = 'aruco-unavailable'
    return []
  }

  const hits: MarkerHit[] = []
  let src: any = null
  let gray: any = null
  let dict: any = null
  let params: any = null
  let detector: any = null
  let corners: any = null
  let ids: any = null
  try {
    src = cv.matFromImageData(image)
    gray = new cv.Mat()
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY)

    const dictId = opts.dictionary ?? cv.DICT_4X4_50 ?? 0
    dict = cv.getPredefinedDictionary(dictId)
    params =
      typeof cv.aruco_DetectorParameters === 'function'
        ? new cv.aruco_DetectorParameters()
        : typeof cv.DetectorParameters === 'function'
          ? new cv.DetectorParameters()
          : null
    detector = new cv.ArucoDetector(dict, params)

    corners = new cv.MatVector()
    ids = new cv.Mat()
    detector.detectMarkers(gray, corners, ids)

    const n = ids?.rows ?? 0
    for (let i = 0; i < n; i++) {
      const id = ids.intAt(i, 0)
      const cm = corners.get(i) // 1x4, CV_32FC2 → [x0,y0,x1,y1,x2,y2,x3,y3]
      const d = cm.data32F as Float32Array
      const pts: Pt2[] = []
      for (let k = 0; k < 4; k++) pts.push({ x: d[k * 2], y: d[k * 2 + 1] })
      cm.delete?.()
      const center = {
        x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4,
        y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4,
      }
      hits.push({ id, corners: pts, center })
    }
    lastStatus = hits.length ? 'ok' : 'no-markers'
  } catch {
    lastStatus = 'error'
    return []
  } finally {
    src?.delete?.()
    gray?.delete?.()
    dict?.delete?.()
    params?.delete?.()
    detector?.delete?.()
    corners?.delete?.()
    ids?.delete?.()
  }
  return hits
}

/**
 * Record the current detections as the home reference frame. REAL — pure data
 * capture. Returns `null` if there is nothing to anchor to.
 */
export function captureReference(hits: MarkerHit[]): ReferenceFrame | null {
  if (!hits.length) return null
  const markers: ReferenceFrame['markers'] = {}
  for (const h of hits) {
    markers[h.id] = {
      center: { x: h.center.x, y: h.center.y },
      corners: h.corners.map((c) => ({ x: c.x, y: c.y })),
    }
  }
  return { markers, capturedAt: Date.now() }
}

/**
 * Compute the registration offset that takes the reference (home) markers to the
 * live markers. REAL — a genuine 2-D rigid least-squares (Kabsch) fit over all
 * matched corner + center point pairs. Returns `null` when no markers match.
 *
 * Output is in pixels unless `mmPerPx` is supplied (then mm). `theta` is degrees.
 */
export function poseFromMarkers(
  hits: MarkerHit[],
  ref: ReferenceFrame | null,
  opts: PoseOptions = {},
): Registration | null {
  if (!ref || !hits.length) return null
  const mmPerPx = opts.mmPerPx ?? 1
  const tol = opts.residualTolPx ?? 4

  // Pair every matched marker's corners + center: home → live.
  const refPts: Pt2[] = []
  const livePts: Pt2[] = []
  let matched = 0
  for (const h of hits) {
    const r = ref.markers[h.id]
    if (!r) continue
    matched++
    const m = Math.min(h.corners.length, r.corners.length)
    for (let k = 0; k < m; k++) {
      refPts.push(r.corners[k])
      livePts.push(h.corners[k])
    }
    refPts.push(r.center)
    livePts.push(h.center)
  }
  if (matched === 0 || refPts.length < 2) return null

  // Centroids.
  const cRef = centroid(refPts)
  const cLive = centroid(livePts)

  // Rotation via the 2-D Kabsch closed form:
  //   Sxx = Σ (a·b),  Sxy = Σ (a×b)  over centered point pairs a (ref), b (live).
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < refPts.length; i++) {
    const ax = refPts[i].x - cRef.x
    const ay = refPts[i].y - cRef.y
    const bx = livePts[i].x - cLive.x
    const by = livePts[i].y - cLive.y
    sxx += ax * bx + ay * by
    sxy += ax * by - ay * bx
  }
  const theta = Math.atan2(sxy, sxx) // radians, ref → live
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)

  // Translation (pixels): live_centroid - R * ref_centroid.
  const txPx = cLive.x - (cos * cRef.x - sin * cRef.y)
  const tyPx = cLive.y - (sin * cRef.x + cos * cRef.y)

  // Residual RMS (pixels) of the fitted transform → confidence falloff.
  let sumSq = 0
  for (let i = 0; i < refPts.length; i++) {
    const px = cos * refPts[i].x - sin * refPts[i].y + txPx
    const py = sin * refPts[i].x + cos * refPts[i].y + tyPx
    sumSq += (px - livePts[i].x) ** 2 + (py - livePts[i].y) ** 2
  }
  const rms = Math.sqrt(sumSq / refPts.length)

  // Confidence: more matched markers + a tighter fit → higher. Bounded 0..1.
  const matchFactor = Math.min(1, matched / 3) // ~3 markers ⇒ saturate
  const fitFactor = 1 / (1 + rms / tol)
  const confidence = clamp01(matchFactor * fitFactor)

  return {
    dx: txPx * mmPerPx,
    dy: tyPx * mmPerPx,
    theta: (theta * 180) / Math.PI,
    confidence,
  }
}

function centroid(pts: Pt2[]): Pt2 {
  let sx = 0
  let sy = 0
  for (const p of pts) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / pts.length, y: sy / pts.length }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}
