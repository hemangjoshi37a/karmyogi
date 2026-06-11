/**
 * Two-camera grid auto-calibration (Camera panel local module).
 *
 * Implements the detection + solving + head/stationary-discrimination pipeline
 * for the printed marker GRID produced by `calibPdf.ts`:
 *
 *  1. {@link detectGridMarkers} — run the platform `BarcodeDetector` over a live
 *     <video> frame, decode every `KMYG1|GRID|X=..|Y=..` marker, and pair its
 *     pixel CENTRE with the bed-mm coordinate the QR self-describes.
 *  2. {@link calibrateCameraFromGrid} — from ≥4 detected markers solve the
 *     image-px → bed-mm homography (1:1 bed→image map) + a reprojection RMS.
 *  3. {@link detectCameraRoles} — a guided routine that jogs the machine a small
 *     known distance and observes which feed the markers shift in: the HEAD-
 *     mounted camera sees the whole world translate (large coherent global
 *     shift, opposite the jog); a STATIONARY external camera barely changes. From
 *     the two per-camera shifts it infers which slot is head vs stationary.
 *
 * This is DOM/browser glue (canvas, BarcodeDetector, grbl jog) around the PURE
 * math in `../core/cameraCalib`; it imports the controller + machine store for
 * the jog probe but NO React / three.js. The panel owns all user-facing copy and
 * persistence; this module returns plain results + stable status codes.
 */

import { grbl } from '../serial/controller'
import { useMachine } from '../store'
import {
  solveHomography,
  reprojectionRMS,
  parseMarkerPayload,
  estimateGlobalShift,
  applyHomography,
  type Vec2,
  type Mat3,
} from '../core/cameraCalib'
import { GRID_ROLE } from './calibPdf'
import {
  captureFrame,
  videoToGray,
  detectQrCodes,
  barcodeDetectorAvailable,
} from './bedTracking'

export { barcodeDetectorAvailable }

// ---------------------------------------------------------------------------
// Marker detection
// ---------------------------------------------------------------------------

/** One detected GRID marker: its pixel centre paired with its bed-mm coordinate. */
export interface DetectedGridMarker {
  px: Vec2
  mm: Vec2
}

/**
 * Detect every `KMYG1|GRID` marker visible in the live <video>, returning each
 * marker's pixel centre + the bed-mm coordinate it encodes. Returns `[]` if
 * there is no frame, the detector is unavailable, or none are found. Use
 * {@link barcodeDetectorAvailable} to feature-gate before offering the action.
 */
export async function detectGridMarkers(
  video: HTMLVideoElement | null,
): Promise<{ markers: DetectedGridMarker[]; frameW: number; frameH: number }> {
  const frame = captureFrame(video)
  if (!frame) return { markers: [], frameW: 0, frameH: 0 }
  if (!barcodeDetectorAvailable()) return { markers: [], frameW: frame.width, frameH: frame.height }

  const codes = await detectQrCodes(frame)
  const markers: DetectedGridMarker[] = []
  for (const code of codes) {
    const parsed = parseMarkerPayload(code.rawValue)
    if (!parsed || parsed.kind !== GRID_ROLE) continue
    const xs = parsed.fields.X
    const ys = parsed.fields.Y
    const x = Number(xs)
    const y = Number(ys)
    if (xs == null || ys == null || !Number.isFinite(x) || !Number.isFinite(y)) continue
    markers.push({ px: code.center, mm: [x, y] })
  }
  return { markers, frameW: frame.width, frameH: frame.height }
}

// ---------------------------------------------------------------------------
// Sheet → machine registration (ties the printed sheet's frame to the machine)
// ---------------------------------------------------------------------------
//
// COORDINATE FRAMES (read this before touching the math):
//   • Printed-sheet frame: the GRID markers each encode their position in
//     SHEET-mm (origin at the grid's (0,0) marker centre, X = col*spacing grows
//     right, Y = row*spacing grows up). This is exactly what `detectGridMarkers`
//     returns as `mm`, and `solveHomography(imgPts, sheetMm)` yields an image-px
//     → SHEET-mm homography.
//   • Machine WORK frame: what every consumer assumes — origin = work zero, +X
//     right, +Y up (Z up), mm. `CameraBedPlane` treats `cameras[0].H` as
//     image-px → machine-work-mm and inverts it; the bed-corner and machine-
//     motion calibration methods already store H in this frame.
//
// The sheet sits at an ARBITRARY, unknown offset+rotation on the bed, so the raw
// grid homography lands in the wrong frame. To fix it we measure a RIGID
// transform (rotation + translation, scale fixed at 1:1 because both frames are
// real mm) sheet-mm → machine-mm from two physically-jogged correspondences, and
// compose it into H so the stored homography is image-px → machine-work-mm.

/**
 * The two sheet markers the operator physically registers, in SHEET-mm. These
 * are baked into the printed grid by `calibPdf.ts`: the ORIGIN marker is grid
 * (0,0) and the SECOND marker is grid (cols-1, 0) — same row, so the vector
 * between them is purely along the sheet's +X axis (recovers rotation + scale).
 */
export interface SheetRegistration {
  /** SHEET-mm coordinate of the origin marker (grid 0,0). Usually [0,0]. */
  originSheet: Vec2
  /** Machine WORK-mm captured by jogging the tool tip to the origin marker. */
  originMachine: Vec2
  /** SHEET-mm coordinate of the second marker (grid cols-1, 0). */
  secondSheet: Vec2
  /** Machine WORK-mm captured by jogging the tool tip to the second marker. */
  secondMachine: Vec2
}

/** A solved sheet-mm → machine-mm rigid transform plus diagnostics. */
export interface SheetTransform {
  /** Row-major 3×3 rigid transform mapping sheet-mm → machine-work-mm. */
  T: Mat3
  /** Rotation of the sheet on the bed, degrees (machine +X relative to sheet +X). */
  rotationDeg: number
  /**
   * Observed scale (machine span / sheet span). Should be ~1.0; a large
   * deviation means a bad capture or the sheet was printed at the wrong scale.
   */
  scale: number
}

/**
 * Solve the RIGID sheet-mm → machine-mm transform from two registered markers.
 *
 * Both frames are real millimetres, so the transform is a pure rotation +
 * translation (no scale): we take the vector between the two SHEET points and
 * the vector between the two MACHINE points, recover the rotation that aligns
 * them, then anchor the translation on the origin marker. The captured scale is
 * reported (for a sanity warning) but NOT applied — baking a non-unit scale in
 * would distort an otherwise-metric calibration.
 *
 * @returns the {@link SheetTransform}, or `null` if the two markers coincide in
 *   either frame (degenerate — can't recover a direction).
 */
export function solveSheetTransform(reg: SheetRegistration): SheetTransform | null {
  const sdx = reg.secondSheet[0] - reg.originSheet[0]
  const sdy = reg.secondSheet[1] - reg.originSheet[1]
  const mdx = reg.secondMachine[0] - reg.originMachine[0]
  const mdy = reg.secondMachine[1] - reg.originMachine[1]
  const sheetLen = Math.hypot(sdx, sdy)
  const machineLen = Math.hypot(mdx, mdy)
  if (sheetLen < 1e-6 || machineLen < 1e-6) return null

  // Rotation that maps the (unit) sheet direction onto the machine direction:
  // angle = atan2 of the machine vector minus atan2 of the sheet vector.
  const angle = Math.atan2(mdy, mdx) - Math.atan2(sdy, sdx)
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const scale = machineLen / sheetLen

  // Rigid map: machine = R * (sheet - originSheet) + originMachine, with R a pure
  // rotation (scale forced to 1). Expand to the affine form m = R*s + tdef.
  //   tx = originMachine.x - (cos*originSheet.x - sin*originSheet.y)
  //   ty = originMachine.y - (sin*originSheet.x + cos*originSheet.y)
  const tx = reg.originMachine[0] - (cos * reg.originSheet[0] - sin * reg.originSheet[1])
  const ty = reg.originMachine[1] - (sin * reg.originSheet[0] + cos * reg.originSheet[1])
  const T: Mat3 = [cos, -sin, tx, sin, cos, ty, 0, 0, 1]
  return { T, rotationDeg: (angle * 180) / Math.PI, scale }
}

/** Row-major 3×3 multiply (`a · b`). Local copy so this module stays pure. */
function mat3Mul(a: Mat3, b: Mat3): number[] {
  const out = new Array<number>(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] =
        a[r * 3 + 0] * b[0 * 3 + c] +
        a[r * 3 + 1] * b[1 * 3 + c] +
        a[r * 3 + 2] * b[2 * 3 + c]
    }
  }
  return out
}

/**
 * Compose a sheet-frame registration into an image-px → sheet-mm homography to
 * produce image-px → machine-work-mm: `H_machine = T_sheet2machine · H_sheet`.
 */
export function composeSheetRegistration(Himg2sheet: Mat3, Tsheet2machine: Mat3): number[] {
  const H = mat3Mul(Tsheet2machine, Himg2sheet)
  // Normalize so H[8] === 1 when possible (matches solveHomography's convention).
  if (Math.abs(H[8]) > 1e-12) {
    const inv = 1 / H[8]
    for (let i = 0; i < 9; i++) H[i] *= inv
  }
  return H
}

// ---------------------------------------------------------------------------
// Per-camera homography solve
// ---------------------------------------------------------------------------

/** A solved per-camera calibration, ready for `useCameraCalib.setCamera`. */
export interface GridCalibResult {
  H: number[]
  rmsMm: number
  frameW: number
  frameH: number
  /** How many markers were used for the solve. */
  used: number
  /**
   * True when a {@link SheetRegistration} was supplied and baked in, so `H` maps
   * image-px → machine-work-mm. False means `H` is still image-px → SHEET-mm and
   * the overlay will be offset/rotated until the operator registers the sheet.
   */
  registered: boolean
}

/**
 * Solve the image-px → mm homography for one camera from detected GRID markers.
 * Needs ≥4 markers that are not all collinear. Returns `null` (with a stable
 * `reason` code) when it can't solve so the caller can show guidance.
 *
 * When `registration` is supplied, the solved image-px → SHEET-mm homography is
 * composed with the sheet → machine rigid transform so the STORED `H` maps
 * image-px → MACHINE WORK mm — consistent with `CameraBedPlane` and the bed-
 * corner / machine-motion methods. Without a registration the homography stays
 * in the sheet frame (the overlay will be displaced until the sheet is tied to a
 * known machine point); `result.registered` reports which it is.
 */
export function calibrateCameraFromGrid(
  detected: { markers: DetectedGridMarker[]; frameW: number; frameH: number },
  registration?: SheetRegistration | null,
):
  | { ok: true; result: GridCalibResult }
  | { ok: false; reason: 'tooFew' | 'degenerate' | 'badRegistration' } {
  const { markers, frameW, frameH } = detected
  if (markers.length < 4) return { ok: false, reason: 'tooFew' }
  const imgPts = markers.map((m) => m.px)
  const sheetPts = markers.map((m) => m.mm)
  const Hsheet = solveHomography(imgPts, sheetPts)
  if (!Hsheet) return { ok: false, reason: 'degenerate' }

  let H: number[] = [...Hsheet]
  let registered = false
  // RMS is the image-px → mm reprojection error of the FINAL stored homography.
  // With a registration we reproject through to machine mm (mapping the sheet
  // markers' own mm through the same rigid transform); without one it's the
  // sheet-frame error. Either way it reflects the homography actually stored.
  let targetPts: Vec2[] = sheetPts
  if (registration) {
    const xf = solveSheetTransform(registration)
    if (!xf) return { ok: false, reason: 'badRegistration' }
    H = composeSheetRegistration(Hsheet, xf.T)
    registered = true
    targetPts = sheetPts.map((p) => applyHomography(xf.T, p))
  }
  const rmsMm = reprojectionRMS(H, imgPts, targetPts)
  return {
    ok: true,
    result: { H, rmsMm, frameW, frameH, used: markers.length, registered },
  }
}

// ---------------------------------------------------------------------------
// Head vs stationary discrimination (guided jog probe)
// ---------------------------------------------------------------------------

/** The inferred mount of one camera slot. */
export type CameraRole = 'head' | 'stationary' | 'unknown'

/** Per-slot result of the role probe. */
export interface SlotRoleProbe {
  role: CameraRole
  /** Coherent global pixel shift magnitude this slot saw from the jog. */
  shiftPx: number
  /** Confidence of the global-shift match in `[0,1]`. */
  score: number
}

/** The full role-detection outcome for both camera slots. */
export interface RoleDetectResult {
  slots: [SlotRoleProbe, SlotRoleProbe]
  /** Which slot index (0/1) is the head-mounted camera, or null if undecided. */
  headSlot: 0 | 1 | null
  /** Which slot index is the stationary external camera, or null if undecided. */
  stationarySlot: 0 | 1 | null
}

/** Stable progress codes for the role probe (the panel maps these to t()). */
export type RoleProbeCode =
  | 'capturing'
  | 'jogging'
  | 'capturingAfter'
  | 'returning'
  | 'analyzing'
  | 'done'
  | 'aborted'
  | 'failed'

/** A progress beat surfaced while the role probe runs. */
export interface RoleProbeProgress {
  code: RoleProbeCode
  params?: Record<string, string | number>
}

/** Options for {@link detectCameraRoles}. */
export interface RoleDetectOptions {
  /** The two slot <video> elements (slot 0, slot 1). Either may be null. */
  videos: [HTMLVideoElement | null, HTMLVideoElement | null]
  /** Jog distance (mm) on X used to provoke the head-camera world-shift. */
  jogMm: number
  /** Jog feed rate (mm/min). */
  feed: number
  /** Settle delay (ms) after the jog before sampling the second frame. */
  settleMs: number
  /** Abort signal. */
  signal: AbortSignal
  /** Progress callback. */
  onProgress: (p: RoleProbeProgress) => void
}

/** How long (ms) to wait for the jog to begin/settle before sampling. */
const MOVE_TIMEOUT_MS = 8000
const POLL_MS = 100
const ARRIVE_TOL_MM = 0.3
/**
 * Pixel-shift threshold above which a slot is considered to have "moved with the
 * head" (i.e. the whole world translated). A stationary camera bolted to the
 * frame sees ~0 px of coherent global shift from a tool/head jog.
 */
const HEAD_SHIFT_PX = 3
/** Minimum global-shift coherence to trust a measured shift at all. */
const MIN_SCORE = 0.18

/** `await`-able delay that rejects promptly if the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(id)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Round to 3dp, stripping any "-0", for clean jog words. */
function fmt(n: number): string {
  const v = Number(n.toFixed(3))
  return Object.is(v, -0) ? '0' : String(v)
}

/** Wait until the machine is Idle within tol of `target` (X only matters here). */
async function waitForArrivalX(
  targetX: number,
  preX: number,
  signal: AbortSignal,
): Promise<void> {
  const start = Date.now()
  const alreadyThere = Math.abs(preX - targetX) < ARRIVE_TOL_MM
  let motionConfirmed = alreadyThere
  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const s = useMachine.getState()
    if (s.state === 'Alarm') throw new Error('Machine entered Alarm during the probe.')
    const moved = Math.abs(s.wpos.x - preX)
    const reached = Math.abs(s.wpos.x - targetX) < ARRIVE_TOL_MM
    if (!motionConfirmed) {
      if (s.state === 'Jog' || s.state === 'Run' || moved > ARRIVE_TOL_MM * 2) {
        motionConfirmed = true
      } else if (Date.now() - start > 2500) {
        throw new Error('The machine did not move — the jog may have been rejected.')
      }
    }
    if (motionConfirmed && reached && s.state === 'Idle') return
    if (Date.now() - start > MOVE_TIMEOUT_MS) {
      throw new Error('Timed out waiting for the machine to move during the probe.')
    }
    await delay(POLL_MS, signal)
  }
}

/**
 * Guided HEAD-vs-STATIONARY probe. Captures a frame from each live slot, jogs the
 * machine `+jogMm` on X, settles, captures again, jogs back, then measures the
 * coherent global pixel shift in each feed via {@link estimateGlobalShift}. The
 * slot with the largest above-threshold shift is the HEAD-mounted camera (its
 * whole field of view translates with the spindle); the near-zero one is the
 * STATIONARY external camera.
 *
 * SAFETY: only a bounded, cancellable single-axis X jog is emitted (Z untouched),
 * gated on connected + Idle/Jog; on any throw/abort `grbl.jogCancel()` fires and
 * a best-effort return jog is issued so the machine is left where it started.
 *
 * Requires both slots live for a comparison; if only one slot is live it still
 * reports that slot's shift (head if above threshold) and leaves the other
 * `unknown`.
 */
export async function detectCameraRoles(opts: RoleDetectOptions): Promise<RoleDetectResult> {
  const { videos, jogMm, feed, settleMs, signal, onProgress } = opts

  // --- preconditions ---
  const m = useMachine.getState()
  if (m.connection !== 'connected') {
    throw new Error('Machine is not connected — connect it in the Controller tab first.')
  }
  if (m.state === 'Alarm') {
    throw new Error('Machine is in Alarm — unlock it first (Controller → Unlock).')
  }
  if (m.state !== 'Idle' && m.state !== 'Jog') {
    throw new Error(`Machine must be Idle to run the probe (state: ${m.state}).`)
  }
  const delta = Math.max(2, Math.abs(jogMm))
  const liveSlots: (0 | 1)[] = []
  if (videos[0] && videos[0]!.videoWidth) liveSlots.push(0)
  if (videos[1] && videos[1]!.videoWidth) liveSlots.push(1)
  if (liveSlots.length === 0) {
    throw new Error('No live camera frame — start at least one camera first.')
  }

  const startX = m.wpos.x
  let movedAway = false

  try {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress({ code: 'capturing' })
    if (settleMs > 0) await delay(settleMs, signal)
    const before = liveSlots.map((s) => videoToGray(videos[s]))

    onProgress({ code: 'jogging', params: { delta: fmt(delta) } })
    await grbl.send(`$J=G91 G21 X${fmt(delta)} F${fmt(feed)}`)
    grbl.realtime(0x3f) // nudge a status report
    movedAway = true
    await waitForArrivalX(startX + delta, startX, signal)
    if (settleMs > 0) await delay(settleMs, signal)

    onProgress({ code: 'capturingAfter' })
    const after = liveSlots.map((s) => videoToGray(videos[s]))

    // Return to the start position before analysing.
    onProgress({ code: 'returning' })
    const preReturn = useMachine.getState().wpos.x
    await grbl.send(`$J=G91 G21 X${fmt(-delta)} F${fmt(feed)}`)
    grbl.realtime(0x3f)
    await waitForArrivalX(startX, preReturn, signal)
    movedAway = false

    onProgress({ code: 'analyzing' })
    // Measure each live slot's coherent global shift.
    const maxShiftPx = 64
    const perSlot: Record<number, SlotRoleProbe> = {
      0: { role: 'unknown', shiftPx: 0, score: 0 },
      1: { role: 'unknown', shiftPx: 0, score: 0 },
    }
    for (let i = 0; i < liveSlots.length; i++) {
      const slot = liveSlots[i]
      const a = before[i]
      const b = after[i]
      if (!a || !b || a.width !== b.width || a.height !== b.height) {
        perSlot[slot] = { role: 'unknown', shiftPx: 0, score: 0 }
        continue
      }
      const shift = estimateGlobalShift(a, b, maxShiftPx)
      const mag = Math.hypot(shift.dx, shift.dy)
      perSlot[slot] = { role: 'unknown', shiftPx: mag, score: shift.score }
    }

    // Decide roles. A HEAD camera shows a large, coherent global shift; a
    // STATIONARY one shows ~0. When both slots were measured, the larger
    // above-threshold shift is the head and the other is stationary.
    const decide = (): { headSlot: 0 | 1 | null; stationarySlot: 0 | 1 | null } => {
      if (liveSlots.length === 2) {
        const s0 = perSlot[0]
        const s1 = perSlot[1]
        const moved0 = s0.shiftPx >= HEAD_SHIFT_PX && s0.score >= MIN_SCORE
        const moved1 = s1.shiftPx >= HEAD_SHIFT_PX && s1.score >= MIN_SCORE
        if (moved0 && moved1) {
          // Both moved — the larger-shift one is the head.
          return s0.shiftPx >= s1.shiftPx
            ? { headSlot: 0, stationarySlot: 1 }
            : { headSlot: 1, stationarySlot: 0 }
        }
        if (moved0 && !moved1) return { headSlot: 0, stationarySlot: 1 }
        if (moved1 && !moved0) return { headSlot: 1, stationarySlot: 0 }
        return { headSlot: null, stationarySlot: null }
      }
      // Only one slot was live — classify it alone.
      const slot = liveSlots[0]
      const probe = perSlot[slot]
      const moved = probe.shiftPx >= HEAD_SHIFT_PX && probe.score >= MIN_SCORE
      return moved
        ? { headSlot: slot, stationarySlot: null }
        : { headSlot: null, stationarySlot: slot }
    }

    const { headSlot, stationarySlot } = decide()
    if (headSlot != null) perSlot[headSlot].role = 'head'
    if (stationarySlot != null) perSlot[stationarySlot].role = 'stationary'

    onProgress({ code: 'done' })
    return {
      slots: [perSlot[0], perSlot[1]],
      headSlot,
      stationarySlot,
    }
  } catch (err) {
    // SAFETY: cancel any in-flight jog and best-effort return to start.
    grbl.jogCancel().catch(() => {})
    if (movedAway) {
      // Best-effort absolute restore (ignore failures — jog already cancelled).
      grbl.send(`$J=G90 X${fmt(startX)} F${fmt(feed)}`).catch(() => {})
    }
    const isAbort = err instanceof DOMException && err.name === 'AbortError'
    onProgress({ code: isAbort ? 'aborted' : 'failed' })
    throw err
  }
}
