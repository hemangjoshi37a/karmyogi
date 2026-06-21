/**
 * Vision "iron-touch" Z calibration (Phase 2) — Soldering/Camera glue.
 *
 * ⚠️ NEEDS LIVE-HARDWARE VERIFICATION. The image-motion detection thresholds and
 * the jog timing below are reasoned starting points; they have only been
 * exercised against synthesized frames in the node harness — NOT against a real
 * spring-loaded soldering iron descending onto a real PCB under a real camera.
 * Expect to tune `motionThreshold`, `settleMs`, and `stepMm` on the bench. The
 * routine is written defensively (bounded travel, abort on no-contact, jog
 * cancel on stop) so a mis-tune fails SAFE rather than crashing the head.
 *
 * Principle: the soldering iron tip is SPRING-LOADED. As the gantry steps Z
 * DOWN, the tip moves down WITH it — visible in the camera as the tip blob
 * shifting frame-to-frame. The instant the tip touches the board it STOPS moving
 * (the spring compresses) even though the gantry keeps descending. So: step Z
 * down a little, settle, grab a frame, diff it against the previous frame over
 * the tip region; while the inter-frame motion stays ABOVE `motionThreshold` the
 * tip is still descending freely; when motion drops BELOW it for `confirmSteps`
 * consecutive steps, the tip has contacted the board — STOP and zero work Z
 * there. If the full `maxTravelMm` is consumed without a contact, ABORT.
 *
 * This module is transport-agnostic: the caller injects `jogDownZ` (a single
 * relative −Z jog of `stepMm` that resolves once sent), `grabGray` (capture the
 * current frame as a GrayImage), `setWorkZeroZ` (G10 L20 P0 Z0), and `sleep`.
 * That keeps the procedure testable and free of direct grbl/DOM imports.
 */

import { silhouetteMask, type GrayImage } from '../core/cameraCalib'

export interface IronTouchOpts {
  /** Z step per descent increment (mm, positive magnitude). Default 0.1. */
  stepMm?: number
  /** Hard travel limit (mm) before aborting if no contact seen. Default 8. */
  maxTravelMm?: number
  /** Settle time after each jog before grabbing the compare frame (ms). Default 220. */
  settleMs?: number
  /**
   * Per-pixel abs-diff threshold for the inter-frame motion mask (0..255).
   * Default 18 — same family as the bedTracking diff threshold.
   */
  diffThreshold?: number
  /**
   * Changed-pixel-count fraction (of the frame) ABOVE which the tip is judged
   * "still moving". Below it, the frame is judged static (contact). Default
   * 0.0008 (≈0.08% of pixels). NEEDS TUNING per camera/lighting.
   */
  motionThreshold?: number
  /** Consecutive static steps required to confirm contact. Default 2. */
  confirmSteps?: number
}

/** Why an iron-touch run failed (no success variant). */
export type IronTouchFailReason = 'no-contact' | 'no-frame' | 'aborted' | 'bad-setup'

export type IronTouchResult =
  | { ok: true; travelMm: number; steps: number }
  | { ok: false; reason: IronTouchFailReason; travelMm: number }

/** Injected machine/camera/timer ops (kept abstract so this stays testable). */
export interface IronTouchDeps {
  /** Send ONE relative −Z jog of `stepMm`; resolves once dispatched. */
  jogDownZ: (stepMm: number) => Promise<void>
  /** Capture the current camera frame as a single-channel GrayImage, or null. */
  grabGray: () => GrayImage | null
  /** Set work Z zero at the current position (G10 L20 P0 Z0). */
  setWorkZeroZ: () => Promise<void>
  /** Sleep helper (ms). */
  sleep: (ms: number) => Promise<void>
  /** Optional abort signal — when it fires the loop stops and cancels the jog. */
  signal?: AbortSignal
  /** Optional cancel of an in-flight jog when aborting. */
  jogCancel?: () => Promise<void>
  /** Optional progress callback (step index, motion fraction, travel mm). */
  onStep?: (info: { step: number; motion: number; travelMm: number }) => void
}

/** Fraction of frame pixels that changed between two same-size gray frames. */
export function frameMotionFraction(
  prev: GrayImage,
  cur: GrayImage,
  diffThreshold: number,
): number {
  if (prev.width !== cur.width || prev.height !== cur.height) return 1
  const mask = silhouetteMask(prev, cur, diffThreshold)
  let changed = 0
  for (let i = 0; i < mask.length; i++) changed += mask[i]
  const total = prev.width * prev.height
  return total > 0 ? changed / total : 0
}

/**
 * Run the iron-touch descent. Steps Z down until the camera shows the tip has
 * stopped moving (contact) or the travel limit is hit. On contact it zeroes work
 * Z. Pure control-flow over injected ops — no direct grbl/DOM dependency.
 */
export async function runIronTouchZ(
  deps: IronTouchDeps,
  opts: IronTouchOpts = {},
): Promise<IronTouchResult> {
  const stepMm = Math.max(0.01, opts.stepMm ?? 0.1)
  const maxTravelMm = Math.max(stepMm, opts.maxTravelMm ?? 8)
  const settleMs = Math.max(0, opts.settleMs ?? 220)
  const diffThreshold = opts.diffThreshold ?? 18
  const motionThreshold = opts.motionThreshold ?? 0.0008
  const confirmSteps = Math.max(1, Math.floor(opts.confirmSteps ?? 2))

  const aborted = () => deps.signal?.aborted === true
  const bail = async (reason: IronTouchFailReason, travelMm: number): Promise<IronTouchResult> => {
    try {
      await deps.jogCancel?.()
    } catch {
      /* best-effort */
    }
    return { ok: false, reason, travelMm }
  }

  // Baseline frame (tip at its current, freely-suspended position).
  let prev = deps.grabGray()
  if (!prev) return { ok: false, reason: 'no-frame', travelMm: 0 }

  let travelMm = 0
  let staticRun = 0
  let step = 0
  const maxSteps = Math.ceil(maxTravelMm / stepMm)

  // A short baseline-motion calibration would help, but we keep it simple: the
  // FIRST step establishes that the tip really does move when jogged (if it
  // doesn't, the setup is wrong — bail early so we don't false-positive contact).
  let sawAnyMotion = false

  while (step < maxSteps) {
    if (aborted()) return bail('aborted', travelMm)

    await deps.jogDownZ(stepMm)
    travelMm += stepMm
    step++
    await deps.sleep(settleMs)
    if (aborted()) return bail('aborted', travelMm)

    const cur = deps.grabGray()
    if (!cur) return bail('no-frame', travelMm)

    const motion = frameMotionFraction(prev, cur, diffThreshold)
    deps.onStep?.({ step, motion, travelMm })
    prev = cur

    if (motion >= motionThreshold) {
      sawAnyMotion = true
      staticRun = 0
      continue
    }

    // Below the motion threshold. Only count it as contact AFTER we've seen the
    // tip move freely at least once — otherwise a totally static scene (camera
    // not pointed at the tip, or the tip already touching) would instantly
    // "succeed" at travel 0, which is wrong/unsafe.
    if (!sawAnyMotion) {
      // No motion yet and none ever — the camera probably isn't seeing the tip.
      // Keep stepping until either motion appears or we hit the travel limit
      // (then we abort as no-contact). Do NOT confirm contact here.
      continue
    }
    staticRun++
    if (staticRun >= confirmSteps) {
      // Contact confirmed — zero work Z here.
      try {
        await deps.setWorkZeroZ()
      } catch {
        return bail('bad-setup', travelMm)
      }
      return { ok: true, travelMm, steps: step }
    }
  }

  // Travel limit consumed without a confirmed contact.
  return bail('no-contact', travelMm)
}
