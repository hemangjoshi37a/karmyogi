/**
 * Fully-automatic camera ⇄ machine calibration driver.
 *
 * The trick: the tool sits at a DIFFERENT pixel in every frame while the bed is
 * static. So the per-pixel MEDIAN across all frames is the background (bed); each
 * frame minus that background isolates the tool blob, whose centroid is the tool
 * pixel for that frame's KNOWN machine XY. Pair (toolPixel ↔ machineXY) over a
 * grid → solve the image→bed-mm homography.
 *
 * This module is the thin DRIVER glue: it jogs the machine to a bounded XY grid,
 * snaps a grayscale frame at each, then runs the PURE math from
 * `../core/cameraCalib` to detect the tool and solve. It imports only the
 * controller (`grbl`), the machine store (`useMachine`), the pure core, and the
 * DOM frame-grab helper (`videoToGray`) — NO React, NO three.js.
 *
 * SAFETY (hard requirements):
 *   - Only XY moves are ever emitted (cancellable `$J=` jogs); Z is never touched.
 *   - Every target is strictly bounded to ±spreadMm of the supplied center.
 *   - Fully abortable: `signal.aborted` is checked each iteration and on every
 *     throw path `grbl.jogCancel()` is fired so no jog is left running.
 *   - Each move has a hard timeout so the run can never hang.
 *   - Does nothing if the machine is not connected; refuses to start in Alarm.
 */

import { grbl } from '../serial/controller'
import { useMachine } from '../store'
import {
  medianGray,
  silhouetteMask,
  largestBlobCentroidPx,
  solveHomography,
  reprojectionRMS,
  type GrayImage,
  type Vec2,
} from '../core/cameraCalib'
import {
  classifyProbe,
  buildKinematicMapping,
  type AxisProbe,
  type ProbeAxis,
} from './motionDetect'
import { videoToGray } from './bedTracking'

/** A progress beat surfaced to the UI as the run advances. */
export interface AutoCalibProgress {
  /** Current high-level phase. */
  phase: 'probing' | 'moving' | 'capturing' | 'solving' | 'done' | 'error'
  /** 0-based index of the point being processed (or count done, for solving/done). */
  index: number
  /** Total number of grid points. */
  total: number
  /** Human-readable one-line status. */
  message: string
}

/**
 * Per-axis kinematics detected by the probe step, surfaced to the UI so the
 * operator can confirm "X → head, Y → bed" with the px/mm for each axis.
 */
export interface KinematicsInfo {
  /** X-axis probe (head/bed/none + px/mm). */
  x: AxisProbe
  /** Y-axis probe (head/bed/none + px/mm). */
  y: AxisProbe
}

/** The solved calibration, ready to hand to `useCameraCalib.setCamera`. */
export interface AutoCalibResult {
  /** Row-major 3×3 homography mapping IMAGE-px → bed-mm (length 9). */
  H: number[]
  /** Reprojection RMS in mm. */
  rmsMm: number
  /** Source frame width in pixels. */
  frameW: number
  /** Source frame height in pixels. */
  frameH: number
  /** How many points yielded a usable tool detection (grid fallback path). */
  used: number
  /** Total grid points attempted (grid fallback path). */
  total: number
  /** Which solve path produced the result. */
  method: 'kinematics' | 'grid'
  /** Per-axis kinematics from the probe step (present whenever the probe ran). */
  kinematics?: KinematicsInfo
}

/** Options for {@link runAutoCalibration}. */
export interface AutoCalibOptions {
  /** The live <video> element whose frames are sampled. */
  video: HTMLVideoElement
  /** Grid centre in machine work XY (mm) — typically the current tool position. */
  center: [number, number]
  /** Half-extent of the grid in mm; every target is within ±spreadMm of center. */
  spreadMm: number
  /** Points per side (≥2). grid=3 → a 3×3 lattice of 9 points. */
  grid: number
  /** Jog feed rate (mm/min). */
  feed: number
  /** Extra settle delay after the move completes, for camera exposure (ms). */
  settleMs: number
  /** Absolute-difference threshold for the silhouette mask. */
  diffThreshold: number
  /**
   * Probe distance (mm) jogged on each axis during the kinematics probe. Larger
   * gives a cleaner pixel displacement but must stay within travel/soft limits.
   * Defaults to `min(spreadMm, 15)` when omitted.
   */
  probeDeltaMm?: number
  /** Abort signal — checked each iteration and on every throw path. */
  signal: AbortSignal
  /** Progress callback. */
  onProgress: (p: AutoCalibProgress) => void
}

/** How long (ms) to wait for a single jog to settle before giving up. */
const MOVE_TIMEOUT_MS = 8000
/** Polling cadence (ms) while waiting for the machine to reach a target. */
const POLL_MS = 120
/** Position tolerance (mm) for "arrived at target". */
const ARRIVE_TOL_MM = 0.3

/** Round to a fixed precision and strip any "-0" so jog lines stay clean. */
function fmt(n: number): string {
  const v = Number(n.toFixed(3))
  return Object.is(v, -0) ? '0' : String(v)
}

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

/**
 * Build a grid×grid lattice of target XY over
 * `[cx ± spreadMm, cy ± spreadMm]`, ordered in a boustrophedon (snake) so
 * consecutive points are adjacent and total travel is short.
 */
function buildSnakeGrid(
  center: [number, number],
  spreadMm: number,
  grid: number,
): [number, number][] {
  const g = Math.max(2, Math.floor(grid))
  const [cx, cy] = center
  const step = (2 * spreadMm) / (g - 1)
  const out: [number, number][] = []
  for (let row = 0; row < g; row++) {
    const y = cy - spreadMm + row * step
    for (let k = 0; k < g; k++) {
      // Snake: even rows go left→right, odd rows right→left.
      const col = row % 2 === 0 ? k : g - 1 - k
      const x = cx - spreadMm + col * step
      out.push([x, y])
    }
  }
  return out
}

/** GRBL realtime status-report query byte (`?`) — nudges a fresh status now. */
const STATUS_QUERY = 0x3f
/** How long (ms) to wait for a jog to actually START before deciding it was rejected. */
const MOTION_START_TIMEOUT_MS = 2500

/**
 * Wait for a jog to `target` to complete, robust against GRBL's status latency.
 *
 * `grbl.send()` resolves when the line is WRITTEN, not when motion starts, and
 * the status poll lags ~200 ms — so the store can still read the PRE-move
 * `Idle`/position for a moment. We therefore first confirm motion actually
 * BEGAN (state → Jog/Run, or the position moved away from `preWpos`); if it
 * never does and we're not already at the target, the jog was likely rejected
 * (soft-limit clamp / not ready) and we throw rather than pair a stale frame.
 * Only after motion is confirmed (or we were already there) do we wait for
 * `Idle` AND within {@link ARRIVE_TOL_MM} of `target`.
 */
async function waitForArrival(
  target: [number, number],
  preWpos: [number, number],
  signal: AbortSignal,
): Promise<void> {
  const start = Date.now()
  // If the target is essentially where we already are, there's no motion to see.
  const alreadyThere =
    Math.hypot(preWpos[0] - target[0], preWpos[1] - target[1]) < ARRIVE_TOL_MM
  let motionConfirmed = alreadyThere
  for (;;) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const s = useMachine.getState()
    if (s.state === 'Alarm') {
      throw new Error('Machine entered Alarm during calibration — aborting.')
    }
    const movedFromStart = Math.hypot(s.wpos.x - preWpos[0], s.wpos.y - preWpos[1])
    const reached = Math.hypot(s.wpos.x - target[0], s.wpos.y - target[1]) < ARRIVE_TOL_MM

    if (!motionConfirmed) {
      if (s.state === 'Jog' || s.state === 'Run' || movedFromStart > ARRIVE_TOL_MM * 2) {
        motionConfirmed = true
      } else if (Date.now() - start > MOTION_START_TIMEOUT_MS) {
        throw new Error(
          `The machine didn't move toward X${fmt(target[0])} Y${fmt(target[1])} — the jog may have been rejected (soft-limit?) or the machine isn't ready.`,
        )
      }
    }

    if (motionConfirmed && reached && s.state === 'Idle') return

    if (Date.now() - start > MOVE_TIMEOUT_MS) {
      throw new Error(
        `Timed out waiting for the machine to reach X${fmt(target[0])} Y${fmt(
          target[1],
        )} — check the jog feed and that the move is unobstructed.`,
      )
    }
    await delay(POLL_MS, signal)
  }
}

/**
 * Jog a single axis by `+deltaMm` (absolute, bounded), waiting for arrival, then
 * return whether it succeeded. Used by the kinematics probe; uses the SAME
 * safety as the grid driver (Idle/connected gate via the caller, motion-start
 * confirm + timeout in {@link waitForArrival}). Z is never touched. The caller
 * is responsible for jogging back / cancelling on any throw.
 */
async function jogAxisTo(
  axis: ProbeAxis,
  fromXY: [number, number],
  targetVal: number,
  feed: number,
  signal: AbortSignal,
): Promise<void> {
  const target: [number, number] =
    axis === 'X' ? [targetVal, fromXY[1]] : [fromXY[0], targetVal]
  const pre = useMachine.getState().wpos
  const preWpos: [number, number] = [pre.x, pre.y]
  const axisWord = axis === 'X' ? `X${fmt(target[0])}` : `Y${fmt(target[1])}`
  // Cancellable, soft-limit-safe ABSOLUTE single-axis jog. Z is never touched.
  await grbl.send(`$J=G90 ${axisWord} F${fmt(feed)}`)
  grbl.realtime(STATUS_QUERY)
  await waitForArrival(target, preWpos, signal)
}

/**
 * KINEMATICS PROBE — for machine axis X then Y, from a safe start: capture frame
 * A, jog `+probeDeltaMm` on that axis, settle, capture frame B, jog back to the
 * start; classify the per-axis image motion (HEAD = localized tool blob moved /
 * BED = whole frame shifted) via {@link classifyProbe}. This works whether an
 * axis moves the head or the bed under a fixed camera.
 *
 * SAFETY: same as the grid driver — connected + Idle/Jog gate (gated by the
 * caller, {@link runAutoCalibration}), bounded absolute single-axis jogs only
 * (Z untouched), motion-start confirm + per-move timeout (via
 * {@link waitForArrival}), abortable at each step. After each axis it jogs back
 * to the start, and on any throw/abort the caller's outer catch fires
 * `grbl.jogCancel()` so no jog is ever left running (identical to the grid path).
 *
 * @returns `{ x, y }` per-axis {@link AxisProbe}, the start XY, the captured
 *   start frame, and the detected start tool pixel (largest blob in frame A of
 *   the X probe) for anchoring the affine. Throws on precondition / timeout /
 *   abort failures (after cancelling the jog).
 */
async function runKinematicsProbe(opts: {
  video: HTMLVideoElement
  start: [number, number]
  probeDeltaMm: number
  feed: number
  settleMs: number
  diffThreshold: number
  signal: AbortSignal
  onProgress: (p: AutoCalibProgress) => void
}): Promise<{
  x: AxisProbe
  y: AxisProbe
  startXY: [number, number]
  startPx: Vec2 | null
}> {
  const { video, start, probeDeltaMm, feed, settleMs, diffThreshold, signal, onProgress } =
    opts

  const grab = (): GrayImage => {
    const g = videoToGray(video)
    if (!g) throw new Error('Lost the camera frame during the kinematics probe.')
    return g
  }

  const probeOne = async (
    axis: ProbeAxis,
    label: string,
  ): Promise<{ probe: AxisProbe; frameA: GrayImage }> => {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    onProgress({
      phase: 'probing',
      index: 0,
      total: 0,
      message: `Probing ${label} kinematics — capturing…`,
    })
    if (settleMs > 0) await delay(settleMs, signal)
    const frameA = grab()

    const axisStartVal = axis === 'X' ? start[0] : start[1]
    onProgress({
      phase: 'probing',
      index: 0,
      total: 0,
      message: `Probing ${label} kinematics — jogging +${fmt(probeDeltaMm)} mm…`,
    })
    await jogAxisTo(axis, start, axisStartVal + probeDeltaMm, feed, signal)
    if (settleMs > 0) await delay(settleMs, signal)
    const frameB = grab()

    // Always jog back to the start before measuring the next axis.
    await jogAxisTo(axis, start, axisStartVal, feed, signal)

    if (frameA.width !== frameB.width || frameA.height !== frameB.height) {
      throw new Error('Camera frame size changed mid-probe — try again.')
    }
    const probe = classifyProbe(axis, frameA, frameB, probeDeltaMm, {
      diffThreshold,
    })
    return { probe, frameA }
  }

  const { probe: xProbe, frameA: frameAX } = await probeOne('X', 'X')
  const { probe: yProbe } = await probeOne('Y', 'Y')

  // Anchor pixel: the tool blob in the X-probe's first frame, found by diffing it
  // against the (machine-fixed) bed background proxy. We reuse the largest blob
  // of the frame-vs-its-mean as a cheap tool locator; if absent the caller falls
  // back to the frame centre (only sets the overall image offset).
  let startPx: Vec2 | null = null
  {
    const w = frameAX.width
    const h = frameAX.height
    let sum = 0
    for (let i = 0; i < frameAX.data.length; i++) sum += frameAX.data[i]
    const mean = sum / frameAX.data.length
    const mask = new Uint8Array(w * h)
    for (let i = 0; i < frameAX.data.length; i++) {
      mask[i] = Math.abs(frameAX.data[i] - mean) > diffThreshold ? 1 : 0
    }
    startPx = largestBlobCentroidPx(mask, w, h, Math.max(24, Math.round(w * h * 0.0003)))
  }

  return { x: xProbe, y: yProbe, startXY: start, startPx }
}

/**
 * Run the fully-automatic calibration. See module docs for the algorithm.
 *
 * Order: a KINEMATICS PROBE runs first (jog +probeDelta on X then Y, classify
 * head/bed per axis, build an affine image⇄mm mapping). If the probe yields a
 * non-degenerate mapping it is used directly (and `kinematics` is reported). If
 * the probe is inconclusive (an axis showed no usable motion, or the Jacobian is
 * degenerate) it FALLS BACK to the legacy tool-grid tracking so Auto still works
 * on a conventional head-moves-in-XY machine.
 *
 * @throws DOMException('AbortError') if aborted; Error with a clear message on
 *   any precondition / runtime failure (not connected, Alarm, timeout, too few
 *   detections, degenerate solve). On EVERY throw path `grbl.jogCancel()` has
 *   been fired so no jog is left in flight.
 */
export async function runAutoCalibration(
  opts: AutoCalibOptions,
): Promise<AutoCalibResult> {
  const {
    video,
    center,
    spreadMm,
    grid,
    feed,
    settleMs,
    diffThreshold,
    signal,
    onProgress,
  } = opts

  // --- preconditions ---
  if (useMachine.getState().connection !== 'connected') {
    throw new Error('Machine is not connected — connect it in the Controller tab first.')
  }
  const startState = useMachine.getState().state
  if (startState === 'Alarm') {
    throw new Error('Machine is in Alarm — unlock the machine first (Controller → Unlock).')
  }
  // Must be settled before we start jogging. A `$J=` sent while Run/Hold/Door
  // could interfere with a running job or be silently queued/ignored.
  if (startState !== 'Idle' && startState !== 'Jog') {
    throw new Error(
      `Machine must be Idle to auto-calibrate (state: ${startState}). Stop any running job first.`,
    )
  }
  if (!(spreadMm > 0)) {
    throw new Error('Spread must be greater than zero.')
  }

  const targets = buildSnakeGrid(center, spreadMm, grid)
  const total = targets.length

  // Captured per-target frames (grayscale) paired with the known machine XY.
  const samples: { gray: GrayImage; target: [number, number] }[] = []

  // Per-axis kinematics from the probe (filled in below; attached to the result
  // for the UI whether the kinematics OR the grid path ultimately solves).
  let kinematics: KinematicsInfo | undefined

  try {
    // --- (0) KINEMATICS PROBE: learn whether X / Y drive the head or the bed ---
    const probeDelta = Math.max(
      2,
      opts.probeDeltaMm != null && opts.probeDeltaMm > 0
        ? Math.min(opts.probeDeltaMm, spreadMm)
        : Math.min(spreadMm, 15),
    )
    try {
      const probe = await runKinematicsProbe({
        video,
        start: center,
        probeDeltaMm: probeDelta,
        feed,
        settleMs,
        diffThreshold,
        signal,
        onProgress,
      })
      kinematics = { x: probe.x, y: probe.y }

      // Build the affine image⇄mm mapping from the two per-axis pixel vectors.
      // Anchor at the detected start tool pixel, or the frame centre if no blob
      // was found (centre only sets the overall image offset).
      const probeFrame = videoToGray(video)
      const fw = probeFrame?.width ?? 0
      const fh = probeFrame?.height ?? 0
      const startPx: Vec2 = probe.startPx ?? [fw / 2, fh / 2]
      if (
        probe.x.kind !== 'none' &&
        probe.y.kind !== 'none' &&
        fw > 0 &&
        fh > 0
      ) {
        const mapping = buildKinematicMapping({
          startPx,
          startXY: probe.startXY,
          xProbe: probe.x,
          yProbe: probe.y,
          spanMm: Math.max(probeDelta, spreadMm),
        })
        if (mapping) {
          onProgress({
            phase: 'done',
            index: total,
            total,
            message: `Calibrated (kinematics: X→${probe.x.kind}, Y→${probe.y.kind}) — RMS ${mapping.rmsMm.toFixed(2)} mm.`,
          })
          return {
            H: [...mapping.H],
            rmsMm: mapping.rmsMm,
            frameW: fw,
            frameH: fh,
            used: 2,
            total,
            method: 'kinematics',
            kinematics,
          }
        }
      }
      // Probe inconclusive (an axis showed no usable motion or degenerate
      // Jacobian) — fall through to the legacy tool-grid path below.
      onProgress({
        phase: 'solving',
        index: 0,
        total,
        message: 'Kinematics probe inconclusive — falling back to tool-grid tracking…',
      })
    } catch (probeErr) {
      // Re-throw aborts; otherwise treat a probe failure as "fall back to grid".
      if (probeErr instanceof DOMException && probeErr.name === 'AbortError') throw probeErr
      onProgress({
        phase: 'solving',
        index: 0,
        total,
        message: 'Kinematics probe failed — falling back to tool-grid tracking…',
      })
    }

    for (let i = 0; i < total; i++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      // Bail early (rather than stalling per-move) if the link drops mid-run.
      if (useMachine.getState().connection !== 'connected') {
        throw new Error('Lost connection to the machine during calibration.')
      }
      const [x, y] = targets[i]

      onProgress({
        phase: 'moving',
        index: i,
        total,
        message: `Point ${i + 1}/${total} — moving…`,
      })

      // Snapshot the position BEFORE the move so we can confirm motion began.
      const pre = useMachine.getState().wpos
      const preWpos: [number, number] = [pre.x, pre.y]
      // Cancellable, soft-limit-safe ABSOLUTE jog. Z is never touched.
      await grbl.send(`$J=G90 X${fmt(x)} Y${fmt(y)} F${fmt(feed)}`)
      // Nudge an immediate status report to shrink the ~200 ms poll latency.
      grbl.realtime(STATUS_QUERY)
      await waitForArrival([x, y], preWpos, signal)

      // Extra camera-exposure settle.
      if (settleMs > 0) await delay(settleMs, signal)

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      onProgress({
        phase: 'capturing',
        index: i,
        total,
        message: `Point ${i + 1}/${total} — capturing…`,
      })

      const gray = videoToGray(video)
      if (gray) samples.push({ gray, target: [x, y] })
    }

    // --- solve ---
    onProgress({
      phase: 'solving',
      index: total,
      total,
      message: 'Detecting the tool and solving the homography…',
    })

    if (samples.length < 4) {
      throw new Error(
        'Captured too few frames to calibrate — check the camera feed and try again.',
      )
    }

    const grays = samples.map((s) => s.gray)
    const bg = medianGray(grays)
    const w = bg.width
    const h = bg.height

    // Reject specks: the tool blob should be a non-trivial fraction of the frame.
    const minBlobArea = Math.max(24, Math.round(w * h * 0.0003))
    const pixels: Vec2[] = []
    const worlds: Vec2[] = []
    for (const s of samples) {
      if (s.gray.width !== w || s.gray.height !== h) continue
      const mask = silhouetteMask(bg, s.gray, diffThreshold)
      const c = largestBlobCentroidPx(mask, w, h, minBlobArea)
      if (c) {
        pixels.push(c)
        worlds.push([s.target[0], s.target[1]])
      }
    }

    if (pixels.length < 4) {
      throw new Error(
        "Couldn't detect the tool in enough frames — improve lighting/contrast, increase spread, or use Manual.",
      )
    }

    // image-px (src) → bed-mm (dst), matching the manual machine-motion method
    // so the 3D viewer's invert(H) gives world→image correctly.
    const H = solveHomography(pixels, worlds)
    if (!H) {
      throw new Error(
        'Could not solve the homography — detected points may be collinear. Increase spread or use Manual.',
      )
    }
    const rmsMm = reprojectionRMS(H, pixels, worlds)

    onProgress({
      phase: 'done',
      index: total,
      total,
      message: `Calibrated — RMS ${rmsMm.toFixed(2)} mm, used ${pixels.length}/${total} points.`,
    })

    return {
      H: [...H],
      rmsMm,
      frameW: w,
      frameH: h,
      used: pixels.length,
      total,
      method: 'grid',
      kinematics,
    }
  } catch (err) {
    // SAFETY: never leave a jog running, whatever went wrong.
    grbl.jogCancel()
    const isAbort = err instanceof DOMException && err.name === 'AbortError'
    onProgress({
      phase: 'error',
      index: samples.length,
      total,
      message: isAbort
        ? 'Calibration aborted — machine stopped.'
        : err instanceof Error
          ? err.message
          : 'Calibration failed.',
    })
    throw err
  }
}
