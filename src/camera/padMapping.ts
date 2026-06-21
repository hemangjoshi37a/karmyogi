/**
 * Camera-pixel → bed-mm mapping for pad detection (Camera/Soldering glue).
 *
 * Thin wrapper over the PURE math in `src/core/cameraCalib.ts` that mirrors the
 * EXACT placement maths the 3D overlay (`viewer/CameraBedPlane.tsx`) uses, so a
 * pad detected at pixel (u,v) lands on the bed at the SAME mm coordinate the
 * operator sees the live video pinned to. Supports both mount types:
 *
 *  • `fixed`  — overhead camera with a full-bed homography `H` (image px → bed
 *    mm). A pixel maps to bed by `applyHomography(H, [u,v])`.
 *
 *  • `head`   — camera bolted to the head. A pixel OFFSET from the frame centre
 *    maps to a bed OFFSET via the perspective `headHomography` (preferred) or
 *    the affine `headMap` / `pxPerMm`+rotation, then is placed at the live
 *    machine XY + `offsetMm` (lens parallax). Identical to the overlay's
 *    per-frame math: world = (px-mapped offset) + wpos + offsetMm.
 *
 * No React / DOM / three.js — just the calibration slot, the live wpos, and the
 * core matrix helpers. Returns `null` when the slot is not usable for mapping
 * (so the caller can warn "calibrate the camera first").
 */

import { applyHomography, type Mat3, type Vec2 } from '../core/cameraCalib'
import type { CameraSlot } from '../store/cameraCalib'

/** Effective pixel-offset → bed-mm-offset 2×2 map for a head-mount slot, or null. */
function effHeadMap(slot: CameraSlot): number[] | null {
  if (slot.headMap && slot.headMap.length === 4) return slot.headMap
  if (slot.pxPerMm && slot.pxPerMm > 0) {
    const r = (slot.rotationDeg * Math.PI) / 180
    const s = 1 / slot.pxPerMm
    return [s * Math.cos(r), -s * Math.sin(r), s * Math.sin(r), s * Math.cos(r)]
  }
  return null
}

/**
 * A reusable pixel→bed-mm mapper built once from a calibration slot + the live
 * machine work XY (head mounts need it; fixed mounts ignore it). Returns `null`
 * if the slot lacks a usable calibration. Call `.map([u,v])` per detected pad.
 */
export interface PixelToBedMapper {
  /** Map an image pixel `[u,v]` to bed-mm `[x,y]`. */
  map: (px: Vec2) => Vec2
  /** px-per-mm at the bed plane (for converting pad radii to mm in the UI). */
  pxPerMm: number
}

/**
 * Build a {@link PixelToBedMapper} for the given camera slot.
 *
 * @param slot The calibrated camera slot (mount + H / headHomography / headMap …).
 * @param wpos Live machine work XY (used only for head mounts). Defaults to 0,0.
 * @returns A mapper, or `null` if the slot cannot map pixels to bed-mm yet.
 */
export function makePixelToBedMapper(
  slot: CameraSlot,
  wpos: { x: number; y: number } = { x: 0, y: 0 },
): PixelToBedMapper | null {
  const frameW = slot.frameW
  const frameH = slot.frameH

  if (slot.mount === 'head') {
    const cx = frameW / 2
    const cy = frameH / 2
    const ox = wpos.x + slot.offsetMm[0]
    const oy = wpos.y + slot.offsetMm[1]

    // Preferred: perspective homography (px → bed-mm offset RELATIVE to refMm),
    // placed at the live head: world = applyH(H, px) + (wpos − refHead) + offset.
    if (slot.headHomography && slot.headHomography.length === 9) {
      const H = slot.headHomography as Mat3
      const dx = wpos.x - slot.headRefMm[0] + slot.offsetMm[0]
      const dy = wpos.y - slot.headRefMm[1] + slot.offsetMm[1]
      const ppm = pxPerMmFromHomography(H, frameW, frameH)
      return {
        map: (px) => {
          const b = applyHomography(H, px)
          return [b[0] + dx, b[1] + dy]
        },
        pxPerMm: ppm,
      }
    }

    // Affine head map: bed-offset = M·(px − centre); world = wpos + offset + that.
    const m = effHeadMap(slot)
    if (!m || !(frameW > 0) || !(frameH > 0)) return null
    const [a, b, c, d] = m
    const det = a * d - b * c
    const ppm = Math.abs(det) > 1e-12 ? 1 / Math.sqrt(Math.abs(det)) : (slot.pxPerMm ?? 0)
    return {
      map: (px) => {
        const du = px[0] - cx
        const dv = px[1] - cy
        return [ox + a * du + b * dv, oy + c * du + d * dv]
      },
      pxPerMm: ppm,
    }
  }

  // Fixed mount: full-bed homography (image px → bed mm).
  if (slot.H && slot.H.length === 9) {
    const H = slot.H as Mat3
    return {
      map: (px) => applyHomography(H, px),
      pxPerMm: pxPerMmFromHomography(H, frameW, frameH),
    }
  }
  return null
}

/**
 * Estimate px-per-mm at the bed plane from an image→bed homography, by mapping
 * the frame centre and a 1-px step and measuring the bed-mm distance. Falls back
 * to 0 if the homography or frame size is degenerate.
 */
function pxPerMmFromHomography(Himg2bed: Mat3, frameW: number, frameH: number): number {
  const w = frameW > 0 ? frameW : 640
  const h = frameH > 0 ? frameH : 480
  const c: Vec2 = [w / 2, h / 2]
  const cx: Vec2 = [w / 2 + 1, h / 2]
  const cy: Vec2 = [w / 2, h / 2 + 1]
  const b0 = applyHomography(Himg2bed, c)
  const bx = applyHomography(Himg2bed, cx)
  const by = applyHomography(Himg2bed, cy)
  const mmPerPxX = Math.hypot(bx[0] - b0[0], bx[1] - b0[1])
  const mmPerPxY = Math.hypot(by[0] - b0[0], by[1] - b0[1])
  const mmPerPx = (mmPerPxX + mmPerPxY) / 2
  return mmPerPx > 1e-9 ? 1 / mmPerPx : 0
}
