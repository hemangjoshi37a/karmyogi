/**
 * Camera → 3D bed-tracking helpers (Camera panel local module).
 *
 * This is the thin DOM/browser glue around the PURE math in
 * `src/core/cameraCalib.ts`: grabbing pixels off a live <video>, feature-
 * detecting + driving the (optional) `BarcodeDetector` for the QR auto path,
 * loading the printed-marker registry, and small geometry utilities (corner
 * ordering, point distance) shared by the three calibration methods.
 *
 * It deliberately imports ONLY types/functions from the core module (and the
 * bed/rect types) — no React, no store, no three.js — so the panel stays the
 * single place that wires state. Anything that needs the browser (canvas,
 * BarcodeDetector, fetch) lives here, isolated and easy to reason about.
 */

import { toGray, type GrayImage, type Rect, type Vec2 } from '../core/cameraCalib'

// ---------------------------------------------------------------------------
// Marker registry (printed calibration sheet)
// ---------------------------------------------------------------------------

/** A printed `TARGET` fiducial: its CENTRE is at (frameXmm, frameYmm) on the bed. */
export interface TargetMarker {
  role: 'TARGET'
  id: 'TL' | 'TR' | 'BL' | 'BR'
  sizeMm: number
  frameXmm: number
  frameYmm: number
  targetWmm: number
  targetHmm: number
  payload: string
}

/** A printed `STOCK` sticker (placed on the workpiece corners). */
export interface StockMarker {
  role: 'STOCK'
  n: number
  sizeMm: number
  payload: string
}

/** A printed `MAT` material sticker (carries a material name + thickness). */
export interface MatMarker {
  role: 'MAT'
  name: string
  thicknessMm: number
  sizeMm: number
  payload: string
}

export type Marker = TargetMarker | StockMarker | MatMarker

export interface MarkerRegistry {
  version?: string
  unit?: string
  page?: string
  markers: Marker[]
}

/**
 * Fetch the printed-marker registry (`/calibration/markers.json`). Returns the
 * parsed registry, or `null` if it is missing / malformed (the caller then
 * falls back to manual / machine-motion calibration).
 */
export async function loadMarkerRegistry(
  signal?: AbortSignal,
): Promise<MarkerRegistry | null> {
  try {
    const res = await fetch('/calibration/markers.json', { signal })
    if (!res.ok) return null
    const json = (await res.json()) as MarkerRegistry
    if (!json || !Array.isArray(json.markers)) return null
    return json
  } catch {
    return null
  }
}

/** The four TARGET markers from a registry, keyed by id (or absent if missing). */
export function targetMarkers(reg: MarkerRegistry | null): TargetMarker[] {
  if (!reg) return []
  return reg.markers.filter((m): m is TargetMarker => m.role === 'TARGET')
}

// ---------------------------------------------------------------------------
// Frame capture
// ---------------------------------------------------------------------------

/** A captured still frame: an offscreen canvas plus its pixel dimensions. */
export interface CapturedFrame {
  canvas: HTMLCanvasElement
  width: number
  height: number
}

/**
 * Draw the current <video> frame into a freshly-allocated canvas. Returns
 * `null` if the video has no dimensions yet (metadata not loaded) or a 2D
 * context cannot be obtained.
 */
export function captureFrame(video: HTMLVideoElement | null): CapturedFrame | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
  return { canvas, width: canvas.width, height: canvas.height }
}

/** Read a captured frame's pixels as a single-channel {@link GrayImage}. */
export function frameToGray(frame: CapturedFrame): GrayImage | null {
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return null
  const img = ctx.getImageData(0, 0, frame.width, frame.height)
  return toGray(img.data, frame.width, frame.height)
}

/** Grab the current video frame straight to a {@link GrayImage} (capture + gray). */
export function videoToGray(video: HTMLVideoElement | null): GrayImage | null {
  const frame = captureFrame(video)
  if (!frame) return null
  return frameToGray(frame)
}

// ---------------------------------------------------------------------------
// BarcodeDetector (QR auto path) — optional, feature-detected
// ---------------------------------------------------------------------------

/** A single detected QR/barcode: its raw payload and the pixel CENTRE. */
export interface DetectedCode {
  rawValue: string
  /** Pixel centre of the code's bounding box. */
  center: Vec2
  /** Pixel corners as reported by the detector (may be 4 points). */
  corners: Vec2[]
}

interface BarcodeDetectorCorner {
  x: number
  y: number
}
interface BarcodeDetectorResult {
  rawValue: string
  cornerPoints?: BarcodeDetectorCorner[]
  boundingBox?: { x: number; y: number; width: number; height: number }
}
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<BarcodeDetectorResult[]>
}
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

/** True iff the browser exposes a usable `window.BarcodeDetector`. */
export function barcodeDetectorAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector ===
      'function'
  )
}

/**
 * Run the platform `BarcodeDetector` (QR format) over a captured frame and
 * return the decoded codes with their pixel centres. Returns `[]` if the API is
 * unavailable or detection throws. Feature-detect with
 * {@link barcodeDetectorAvailable} before showing the QR method in the UI.
 */
export async function detectQrCodes(frame: CapturedFrame): Promise<DetectedCode[]> {
  if (!barcodeDetectorAvailable()) return []
  const Ctor = (window as unknown as { BarcodeDetector: BarcodeDetectorCtor })
    .BarcodeDetector
  let detector: BarcodeDetectorLike
  try {
    detector = new Ctor({ formats: ['qr_code'] })
  } catch {
    try {
      detector = new Ctor()
    } catch {
      return []
    }
  }
  let results: BarcodeDetectorResult[]
  try {
    results = await detector.detect(frame.canvas)
  } catch {
    return []
  }
  const out: DetectedCode[] = []
  for (const r of results) {
    if (!r.rawValue) continue
    const corners: Vec2[] = (r.cornerPoints ?? []).map((c) => [c.x, c.y] as Vec2)
    out.push({ rawValue: r.rawValue, center: codeCenter(r), corners })
  }
  return out
}

/** Centre of a detector result, from corner points if present, else its box. */
function codeCenter(r: BarcodeDetectorResult): Vec2 {
  const pts = r.cornerPoints
  if (pts && pts.length > 0) {
    let sx = 0
    let sy = 0
    for (const p of pts) {
      sx += p.x
      sy += p.y
    }
    return [sx / pts.length, sy / pts.length]
  }
  const b = r.boundingBox
  if (b) return [b.x + b.width / 2, b.y + b.height / 2]
  return [0, 0]
}

// ---------------------------------------------------------------------------
// Bed-corner geometry
// ---------------------------------------------------------------------------

/**
 * The four corners of the centered bed rectangle in bed-mm, in a FIXED order
 * matching the on-screen click prompt: top-left, top-right, bottom-right,
 * bottom-left. The 3D scene draws the bed centered on the work origin, so the
 * usable area is x∈[-W/2,+W/2], y∈[-D/2,+D/2] with Y up. "Top" = +Y (far edge),
 * "bottom" = −Y (near edge); "left" = −X, "right" = +X.
 */
export function bedCornersMm(width: number, depth: number): Vec2[] {
  const hw = width / 2
  const hd = depth / 2
  return [
    [-hw, hd], // top-left  (−X, +Y)
    [hw, hd], // top-right (+X, +Y)
    [hw, -hd], // bottom-right (+X, −Y)
    [-hw, -hd], // bottom-left  (−X, −Y)
  ]
}

/** Human labels for the four bed corners, same order as {@link bedCornersMm}. */
export const BED_CORNER_ORDER: ReadonlyArray<'TL' | 'TR' | 'BR' | 'BL'> = [
  'TL',
  'TR',
  'BR',
  'BL',
]

/** Euclidean distance between two pixel/world points. */
export function dist2(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1])
}

/**
 * Spread metric for a set of points: the minimum pairwise distance, used to
 * warn when machine-motion calibration points are too clustered to give a
 * well-conditioned homography. Returns `Infinity` for fewer than two points.
 */
export function minPairwiseDist(pts: readonly Vec2[]): number {
  if (pts.length < 2) return Infinity
  let m = Infinity
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const d = dist2(pts[i], pts[j])
      if (d < m) m = d
    }
  }
  return m
}

/**
 * Map a click on a rendered <video>/<img> back to native pixel coordinates.
 * `object-fit: contain` letterboxes the frame inside the element, so we undo
 * the letterbox + scale. Returns `null` if the click is in the letterbox gutter
 * (outside the actual image) or the geometry is degenerate.
 *
 * @param clientX/clientY Pointer position (from the click event).
 * @param rect The element's bounding client rect.
 * @param natW/natH The video's native (intrinsic) pixel size.
 */
export function clickToImagePx(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  natW: number,
  natH: number,
): Vec2 | null {
  if (natW <= 0 || natH <= 0 || rect.width <= 0 || rect.height <= 0) return null
  // Scale to fit (contain): the smaller ratio governs.
  const scale = Math.min(rect.width / natW, rect.height / natH)
  const dispW = natW * scale
  const dispH = natH * scale
  const offX = (rect.width - dispW) / 2
  const offY = (rect.height - dispH) / 2
  const lx = clientX - rect.left - offX
  const ly = clientY - rect.top - offY
  if (lx < 0 || ly < 0 || lx > dispW || ly > dispH) return null
  return [lx / scale, ly / scale]
}

/** Axis-aligned mm rect from a list of mm points (≥1). Null for an empty list. */
export function rectFromPoints(pts: readonly Vec2[]): Rect | null {
  if (pts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p[0] < minX) minX = p[0]
    if (p[1] < minY) minY = p[1]
    if (p[0] > maxX) maxX = p[0]
    if (p[1] > maxY) maxY = p[1]
  }
  return { minX, minY, maxX, maxY }
}

/** A bed-centered rect of the given size placed at the bed centre (0,0). */
export function centeredRect(widthMm: number, depthMm: number): Rect {
  const hw = widthMm / 2
  const hd = depthMm / 2
  return { minX: -hw, minY: -hd, maxX: hw, maxY: hd }
}
