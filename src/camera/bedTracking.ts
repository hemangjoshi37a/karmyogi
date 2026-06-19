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

import jsQR from 'jsqr'
import { readBarcodesFromImageData, setZXingModuleOverrides } from 'zxing-wasm/reader'
import { toGray, type GrayImage, type Rect, type Vec2 } from '../core/cameraCalib'

// The ZXing wasm is served at a STABLE url (/zxing_reader.wasm) by the
// `vite-zxing-plugin` in BOTH dev and production — robust where a `?url` import
// of a dependency's wasm is not.
const ZXING_WASM_URL = '/zxing_reader.wasm'

// Point the ZXing wasm loader at the bundled asset (works offline / behind CSP,
// instead of fetching from a CDN at runtime). Done once, lazily, on first use.
// Last ZXing decode outcome — surfaced in diagnostics so a failure tells us
// whether the wasm decoder actually ran (vs. silently erroring → jsQR fallback).
let zxingState: 'idle' | 'ok' | 'error' = 'idle'
let zxingErr = ''
export function zxingStatus(): { state: 'idle' | 'ok' | 'error'; error: string } {
  return { state: zxingState, error: zxingErr }
}

let zxingPrepared = false
function prepareZxing(): void {
  if (zxingPrepared) return
  zxingPrepared = true
  try {
    setZXingModuleOverrides({
      locateFile: (path: string, prefix: string) =>
        path.endsWith('.wasm') ? ZXING_WASM_URL : prefix + path,
    })
  } catch {
    /* override is best-effort; the default CDN loader still works online */
  }
}

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

/** True iff the browser exposes a usable native `window.BarcodeDetector`. */
export function barcodeDetectorAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector ===
      'function'
  )
}

/**
 * True iff QR decoding is possible at all. The native `BarcodeDetector` is NOT
 * implemented in desktop Chrome on Linux (and absent in Firefox/Safari), so we
 * always carry a pure-JS decoder (`jsQR`) fallback — meaning QR detection works
 * on EVERY platform/camera. The UI should gate the QR calibration method on THIS,
 * not on {@link barcodeDetectorAvailable}.
 */
export function qrDecodeAvailable(): boolean {
  return true
}

/**
 * Run the platform `BarcodeDetector` (QR format) over a captured frame and
 * return the decoded codes with their pixel centres. Falls back to a pure-JS
 * decoder (`jsQR`) when the native API is unavailable (Linux Chrome, Firefox,
 * Safari …), so detection works regardless of platform or camera. Returns `[]`
 * only when nothing decodes.
 */
export async function detectQrCodes(frame: CapturedFrame): Promise<DetectedCode[]> {
  // ZXing (C++/wasm, "try harder") is by far the most robust on real camera
  // frames — soft focus, glare, perspective — so try it FIRST.
  const zx = await detectQrCodesZxing(frame)
  if (zx.length > 0) return zx
  // WIDE-ANGLE rescue: a fisheye/barrel lens (e.g. a close Arducam IMX179) bends
  // the QR's module grid so straight-line decoders fail on the raw frame. Retry
  // through a sweep of barrel-undistortion strengths — verified to recover real
  // warped frames that no decoder reads otherwise.
  const ud = await detectQrCodesUndistortSweep(frame)
  if (ud.length > 0) return ud
  if (barcodeDetectorAvailable()) {
    const native = await detectQrCodesNative(frame)
    if (native.length > 0) return native
  }
  return detectQrCodesJs(frame)
}

/**
 * Remap `src` by a radial barrel-correction: output pixel (x,y) samples the
 * source at radius scaled by `C·rn + (1−C)` (rn = normalised radius). C<0 pulls
 * the centre out (corrects barrel/fisheye). Returns a fresh ImageData.
 */
function undistortImageData(src: ImageData, C: number): ImageData {
  const w = src.width
  const h = src.height
  const s = src.data
  const out = new Uint8ClampedArray(w * h * 4)
  const cx = w / 2
  const cy = h / 2
  const N = Math.min(w, h) / 2
  const D = 1 - C
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx
      const dy = y - cy
      const rn = Math.hypot(dx, dy) / N
      const scale = C * rn + D
      const sx = Math.round(cx + dx * scale)
      const sy = Math.round(cy + dy * scale)
      const o = (y * w + x) * 4
      if (sx >= 0 && sx < w && sy >= 0 && sy < h) {
        const i = (sy * w + sx) * 4
        out[o] = s[i]
        out[o + 1] = s[i + 1]
        out[o + 2] = s[i + 2]
        out[o + 3] = 255
      } else {
        out[o + 3] = 255
      }
    }
  }
  return new ImageData(out, w, h)
}

/** Try ZXing through a sweep of barrel-undistortion strengths (downscaled for
 *  speed). Maps any decoded corner back to ORIGINAL frame pixels. */
async function detectQrCodesUndistortSweep(frame: CapturedFrame): Promise<DetectedCode[]> {
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return []
  const W = frame.width
  const H = frame.height
  const longest = Math.max(W, H)
  const f = longest > 960 ? 960 / longest : 1
  const dw = Math.max(1, Math.round(W * f))
  const dh = Math.max(1, Math.round(H * f))
  const small = document.createElement('canvas')
  small.width = dw
  small.height = dh
  const sctx = small.getContext('2d')
  if (!sctx) return []
  sctx.drawImage(frame.canvas, 0, 0, dw, dh)
  let base: ImageData
  try {
    base = sctx.getImageData(0, 0, dw, dh)
  } catch {
    return []
  }
  prepareZxing()
  const cx = dw / 2
  const cy = dh / 2
  const N = Math.min(dw, dh) / 2
  // Sweep barrel strengths (mild → strong). Real fisheye lenses land in here.
  for (const C of [-0.1, -0.14, -0.18, -0.08, -0.22, -0.26, -0.32]) {
    const ud = undistortImageData(base, C)
    let results
    try {
      results = await readBarcodesFromImageData(ud, { tryHarder: true, formats: ['QRCode'], maxNumberOfSymbols: 8 })
    } catch (e) {
      zxingState = 'error'
      zxingErr = e instanceof Error ? e.message : String(e)
      continue
    }
    if (results.length === 0) continue
    const D = 1 - C
    const mapBack = (ux: number, uy: number): Vec2 => {
      const dx = ux - cx
      const dy = uy - cy
      const rn = Math.hypot(dx, dy) / N
      const scale = C * rn + D
      return [(cx + dx * scale) / f, (cy + dy * scale) / f]
    }
    const out: DetectedCode[] = []
    for (const r of results) {
      if (!r.text) continue
      const p = r.position
      const corners: Vec2[] = p
        ? [
            mapBack(p.topLeft.x, p.topLeft.y),
            mapBack(p.topRight.x, p.topRight.y),
            mapBack(p.bottomRight.x, p.bottomRight.y),
            mapBack(p.bottomLeft.x, p.bottomLeft.y),
          ]
        : []
      let sx = 0
      let sy = 0
      for (const c of corners) {
        sx += c[0]
        sy += c[1]
      }
      const center: Vec2 = corners.length ? [sx / corners.length, sy / corners.length] : [0, 0]
      out.push({ rawValue: r.text, center, corners })
    }
    if (out.length > 0) {
      zxingState = 'ok'
      return out
    }
  }
  return []
}

/** ZXing-wasm decode of a captured frame (QR, try-harder). Returns `[]` on any
 *  failure (tainted canvas, wasm load error, nothing found). */
async function detectQrCodesZxing(frame: CapturedFrame): Promise<DetectedCode[]> {
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return []
  let img: ImageData
  try {
    img = ctx.getImageData(0, 0, frame.width, frame.height)
  } catch {
    return [] // tainted canvas
  }
  prepareZxing()
  try {
    const results = await readBarcodesFromImageData(img, {
      tryHarder: true,
      formats: ['QRCode'],
      maxNumberOfSymbols: 8,
    })
    zxingState = 'ok'
    zxingErr = ''
    const out: DetectedCode[] = []
    for (const r of results) {
      if (!r.text) continue
      const p = r.position
      const corners: Vec2[] = p
        ? [
            [p.topLeft.x, p.topLeft.y],
            [p.topRight.x, p.topRight.y],
            [p.bottomRight.x, p.bottomRight.y],
            [p.bottomLeft.x, p.bottomLeft.y],
          ]
        : []
      let sx = 0
      let sy = 0
      for (const c of corners) {
        sx += c[0]
        sy += c[1]
      }
      const center: Vec2 = corners.length ? [sx / corners.length, sy / corners.length] : [0, 0]
      out.push({ rawValue: r.text, center, corners })
    }
    return out
  } catch (e) {
    zxingState = 'error'
    zxingErr = e instanceof Error ? e.message : String(e)
    return []
  }
}

/** Native `BarcodeDetector` path (used when the platform implements it). */
async function detectQrCodesNative(frame: CapturedFrame): Promise<DetectedCode[]> {
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

/**
 * Pure-JS QR fallback (`jsQR`). jsQR decodes ONE (the most prominent) code per
 * call, so to find SEPARATED codes — the 4 corner TARGET markers each live in a
 * different region of the frame — we scan the whole frame plus a 3×3 grid of
 * overlapping tiles and dedupe the results by payload. All pixel coordinates are
 * translated back to full-frame space. One-shot (calibration) use, so the extra
 * scans are fine. Returns each code's payload, pixel centre, and 4 corners.
 */
function detectQrCodesJs(frame: CapturedFrame): DetectedCode[] {
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return []
  const W = frame.width
  const H = frame.height
  const found = new Map<string, DetectedCode>()

  // Decode one ImageData and record any new code, mapping its corners back to
  // full-frame pixel space via `map` (handles tile offsets + downscale + padding).
  const consider = (data: Uint8ClampedArray, w: number, h: number, map: (x: number, y: number) => Vec2) => {
    const res = jsQR(data, w, h, { inversionAttempts: 'attemptBoth' })
    if (!res || !res.data || found.has(res.data)) return
    const L = res.location
    const corners: Vec2[] = [
      map(L.topLeftCorner.x, L.topLeftCorner.y),
      map(L.topRightCorner.x, L.topRightCorner.y),
      map(L.bottomRightCorner.x, L.bottomRightCorner.y),
      map(L.bottomLeftCorner.x, L.bottomLeftCorner.y),
    ]
    let sx = 0
    let sy = 0
    for (const c of corners) {
      sx += c[0]
      sy += c[1]
    }
    found.set(res.data, { rawValue: res.data, center: [sx / 4, sy / 4], corners })
  }

  // 1) Whole frame at native resolution.
  try {
    const img = ctx.getImageData(0, 0, W, H)
    consider(img.data, W, H, (x, y) => [x, y])
  } catch {
    return [] // tainted canvas — can't read pixels
  }

  // 1b) UPSCALED pass for low-res frames (e.g. 640×480): a close QR there has few
  //     pixels per module, and jsQR's locator is more reliable with more samples.
  if (found.size === 0 && Math.max(W, H) <= 800) {
    const f = 2
    const uw = W * f
    const uh = H * f
    const cu = document.createElement('canvas')
    cu.width = uw
    cu.height = uh
    const xu = cu.getContext('2d')
    if (xu) {
      xu.imageSmoothingEnabled = true
      xu.drawImage(frame.canvas, 0, 0, uw, uh)
      try {
        const img = xu.getImageData(0, 0, uw, uh)
        consider(img.data, uw, uh, (x, y) => [x / f, y / f])
      } catch {
        /* ignore */
      }
    }
  }

  // 2) Downscaled whole frame at SEVERAL target sizes — jsQR's success depends
  //    strongly on how many pixels the QR occupies, which varies with camera
  //    distance, so we try a few. (Skipped if already decoded above.)
  const longest = Math.max(W, H)
  for (const target of [1280, 800, 540]) {
    if (found.size > 0) break
    if (longest <= target) continue
    const s = target / longest
    const dw = Math.max(1, Math.round(W * s))
    const dh = Math.max(1, Math.round(H * s))
    const c2 = document.createElement('canvas')
    c2.width = dw
    c2.height = dh
    const x2 = c2.getContext('2d')
    if (x2) {
      x2.drawImage(frame.canvas, 0, 0, dw, dh)
      try {
        const img = x2.getImageData(0, 0, dw, dh)
        consider(img.data, dw, dh, (x, y) => [x / s, y / s])
      } catch {
        /* ignore */
      }
    }
  }

  // 3) White-padded frame — a close head camera often crops the QR's quiet-zone
  //    border (or the QR touches a frame edge); jsQR needs that margin. Draw the
  //    (downscaled) frame onto a white canvas with a generous border to synthesise
  //    the quiet zone, then map corners back through the pad + scale.
  {
    const s = longest > 900 ? 900 / longest : 1
    const iw = Math.max(1, Math.round(W * s))
    const ih = Math.max(1, Math.round(H * s))
    const pad = Math.round(Math.max(iw, ih) * 0.12)
    const pw = iw + pad * 2
    const ph = ih + pad * 2
    const cp = document.createElement('canvas')
    cp.width = pw
    cp.height = ph
    const xp = cp.getContext('2d')
    if (xp) {
      xp.fillStyle = '#ffffff'
      xp.fillRect(0, 0, pw, ph)
      xp.drawImage(frame.canvas, pad, pad, iw, ih)
      try {
        const img = xp.getImageData(0, 0, pw, ph)
        consider(img.data, pw, ph, (x, y) => [(x - pad) / s, (y - pad) / s])
      } catch {
        /* ignore */
      }
    }
  }

  // 4) Overlapping tiles — for SEPARATED codes (the 4 corner markers each land in
  //    a different region) that a single whole-frame pass can only catch one of.
  const scanTile = (ox: number, oy: number, w: number, h: number) => {
    if (w < 24 || h < 24) return
    try {
      const img = ctx.getImageData(ox, oy, w, h)
      consider(img.data, w, h, (x, y) => [x + ox, y + oy])
    } catch {
      /* ignore */
    }
  }
  const tw = Math.floor(W * 0.55)
  const th = Math.floor(H * 0.55)
  const xs = [0, Math.floor((W - tw) / 2), W - tw]
  const ys = [0, Math.floor((H - th) / 2), H - th]
  for (const ty of ys) for (const tx of xs) scanTile(tx, ty, tw, th)

  return [...found.values()]
}

/** Quick health check of a captured frame: is its pixel buffer readable (not
 *  cross-origin tainted), and roughly how bright is it (0..255, -1 if unreadable)?
 *  Used to diagnose "QR not decoded" — distinguishes a black/tainted frame from a
 *  real decode failure. */
export function frameDiagnostics(frame: CapturedFrame): { readable: boolean; lum: number } {
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return { readable: false, lum: -1 }
  const w = Math.min(frame.width, 80)
  const h = Math.min(frame.height, 80)
  try {
    const img = ctx.getImageData(0, 0, w, h)
    let sum = 0
    const d = img.data
    for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3
    return { readable: true, lum: Math.round(sum / (d.length / 4)) }
  } catch {
    return { readable: false, lum: -1 }
  }
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
