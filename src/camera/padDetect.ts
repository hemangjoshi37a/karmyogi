/**
 * Camera pad-detection GLUE (Soldering/Camera panels).
 *
 * Ties the live <video> → ImageData capture (`bedTracking.captureFrame`) to the
 * PURE `detectSolderPads` core and the `padMapping` px→bed-mm mapper, so the
 * Soldering panel gets one call: "grab the current camera frame, detect pads,
 * and give me each pad's bed XY + radius in mm". No React; just DOM canvas +
 * the pure cores + the calibration slot.
 */

import { captureFrame } from './bedTracking'
import { makePixelToBedMapper } from './padMapping'
import {
  detectSolderPads,
  type PadVisionOpts,
  type PadVisionDebug,
} from '../core/padVision'
import type { CameraSlot } from '../store/cameraCalib'

/** One detected pad mapped to the bed, ready to become a solder point. */
export interface MappedPad {
  /** Bed X (mm). */
  x: number
  /** Bed Y (mm). */
  y: number
  /** Pad radius (mm); 0 if the calibration can't give a scale. */
  rMm: number
  /** Source pixel centroid (for debugging / overlay). */
  xPx: number
  yPx: number
}

export interface DetectPadsOutcome {
  ok: boolean
  /** Mapped pads (bed-mm), empty on any failure. */
  pads: MappedPad[]
  /** A reason code the UI turns into a localized message when `ok` is false. */
  reason?:
    | 'no-video'
    | 'no-frame'
    | 'tainted'
    | 'not-calibrated'
    | 'no-pads'
  debug?: PadVisionDebug
}

/**
 * Capture the current frame from the given <video>, detect solder pads, and map
 * each to bed-mm using the camera calibration `slot` + live machine `wpos`.
 *
 * @param video The live camera <video> element (from `cameraLive.videoEls[0]`).
 * @param slot  The calibrated camera slot (mount + homography / headMap …).
 * @param wpos  Live machine work XY (only used for head-mounted cameras).
 * @param opts  Detector tunables. `pxPerMm` is auto-filled from the calibration
 *   when omitted (so the mm pad-size band works without the caller knowing it).
 */
export function detectPadsFromVideo(
  video: HTMLVideoElement | null,
  slot: CameraSlot,
  wpos: { x: number; y: number },
  opts: PadVisionOpts = {},
): DetectPadsOutcome {
  if (!video) return { ok: false, pads: [], reason: 'no-video' }
  const frame = captureFrame(video)
  if (!frame) return { ok: false, pads: [], reason: 'no-frame' }
  const ctx = frame.canvas.getContext('2d')
  if (!ctx) return { ok: false, pads: [], reason: 'no-frame' }

  let image: ImageData
  try {
    image = ctx.getImageData(0, 0, frame.width, frame.height)
  } catch {
    return { ok: false, pads: [], reason: 'tainted' } // cross-origin tainted canvas
  }

  // Build the mapper from the calibration BEFORE detecting, so we can supply the
  // calibrated px-per-mm to the detector's mm-based size band.
  const mapper = makePixelToBedMapper(slot, wpos)
  if (!mapper) return { ok: false, pads: [], reason: 'not-calibrated' }

  const result = detectSolderPads(image, {
    pxPerMm: opts.pxPerMm ?? (mapper.pxPerMm > 0 ? mapper.pxPerMm : undefined),
    ...opts,
  })
  if (result.pads.length === 0) {
    return { ok: false, pads: [], reason: 'no-pads', debug: result.debug }
  }

  const mmPerPx = mapper.pxPerMm > 0 ? 1 / mapper.pxPerMm : 0
  const pads: MappedPad[] = result.pads.map((p) => {
    const [x, y] = mapper.map([p.xPx, p.yPx])
    return { x, y, rMm: mmPerPx > 0 ? p.rPx * mmPerPx : 0, xPx: p.xPx, yPx: p.yPx }
  })
  return { ok: true, pads, debug: result.debug }
}
