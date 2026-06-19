import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Mat3, Rect } from '../core/cameraCalib'

/**
 * Live-camera → 3D bed/job calibration state (feature spec: plan.md §7.9).
 *
 * Holds the per-camera image⇄bed-mm homography and the detected job footprint
 * so the 3D viewer can draw the real bed plane (live video, rectified through H)
 * and the job box, and run the design "does it fit?" check. Two cameras are
 * supported (each independently calibrated to the SAME bed plane); markerless
 * shape-from-silhouette across both yields the job height.
 *
 * Persistence: the CALIBRATION survives reload (homography, chosen deviceId,
 * opacity, the `enabled` toggle, the job rect/height) — the live MediaStream and
 * the empty-bed reference frame are transient and re-acquired on demand. So a
 * refresh restores "show live camera 3D" and where the job sits, then just
 * re-opens the camera. localStorage key follows the app convention.
 */

const KEY = 'karmyogi.camera'

/**
 * Camera mount type.
 *  • `fixed`     — overhead/stationary camera that sees the whole bed; calibrated
 *                  by a single image→bed-mm homography (4 corners / motion / grid).
 *  • `head`      — camera bolted to the spindle/head; CLOSE to the bed so it only
 *                  sees a small patch and CANNOT see all 4 corners at once. Its
 *                  view is placed on the bed at the LIVE machine XY (it pans with
 *                  the head), scaled by px-per-mm + rotation, with a lens offset.
 */
export type CameraMount = 'fixed' | 'head'

/** One calibrated camera slot. */
export interface CameraSlot {
  /** Chosen `MediaDeviceInfo.deviceId` (re-acquired on reload), or '' if unset. */
  deviceId: string
  /** Human label for the picker. */
  label: string
  /** How the camera is mounted (drives which calibration + overlay model is used). */
  mount: CameraMount
  /**
   * Image-pixel → bed-mm homography (length-9 row-major Mat3), or null until
   * calibrated. Used by the `fixed` mount. Solved from QR `TARGET` corners,
   * clicked bed corners, or machine motion via core `solveHomography`.
   */
  H: number[] | null
  /** Reprojection RMS in mm of the last solve (calibration quality); null if uncalibrated. */
  rmsMm: number | null
  /** Frame size (px) the homography was solved at — overlay sampling needs it. */
  frameW: number
  frameH: number
  // ── head-mount calibration (ignored when mount==='fixed') ──────────────────
  /** Image scale: pixels per millimetre of bed, at the bed plane. null = uncalibrated. */
  pxPerMm: number | null
  /** Camera rotation about the optical axis relative to the bed +X, degrees.
   *  (Used by the simple single-QR head calibration when `headMap` is null.) */
  rotationDeg: number
  /**
   * Head-camera pixel-offset → bed-mm-offset 2×2 linear map `[m00,m01,m10,m11]`
   * (= M⁻¹ from {@link solveHeadMotionMap}). Solved by jogging the head and
   * tracking a fixed marker, so it encodes scale + rotation + shear + handedness
   * (mirror) automatically — the overlay orients the live patch with this. null
   * until motion-calibrated (then it supersedes pxPerMm + rotationDeg). */
  headMap: number[] | null
  /** Manual view-orientation override for a rotated mount: quarter turns (0..3 =
   *  0°/90°/180°/270°) applied ON TOP of the calibration. (Auto-align already
   *  detects orientation; this is for the Quick-QR method or a deliberate flip.) */
  headRotateQuarters: number
  /** Manual horizontal flip (mirror left↔right) of the head overlay. */
  headFlipH: boolean
  /** Manual vertical flip (mirror top↔bottom) of the head overlay. */
  headFlipV: boolean
  /** Lens-centre offset on the bed relative to the tool/work XY, mm [dx,dy]
   *  (parallax between the camera's optical axis and the spindle). */
  offsetMm: [number, number]
  /** Radial (barrel/pincushion) lens-distortion coefficient k1 applied at render
   *  to straighten a wide-angle view. 0 = none; >0 corrects barrel distortion. */
  distortK: number
}

function emptySlot(): CameraSlot {
  return {
    deviceId: '',
    label: '',
    mount: 'fixed',
    H: null,
    rmsMm: null,
    frameW: 0,
    frameH: 0,
    pxPerMm: null,
    rotationDeg: 0,
    headMap: null,
    headRotateQuarters: 0,
    headFlipH: false,
    headFlipV: false,
    offsetMm: [0, 0],
    distortK: 0,
  }
}

interface CameraCalibState {
  /** The 3D-viewport "show live camera overlay" toggle (persisted across refresh). */
  enabled: boolean
  /** Bed-plane video texture opacity 0..1. */
  overlayOpacity: number
  /** Exactly two camera slots (index 0 = primary, 1 = secondary for visual hull). */
  cameras: [CameraSlot, CameraSlot]
  /** Detected job footprint on the bed, in bed-mm (null until known). */
  jobRect: Rect | null
  /** Job height in mm — from two-view visual hull or operator entry (null = flat plane). */
  jobHeightMm: number | null

  setEnabled: (v: boolean) => void
  toggleEnabled: () => void
  setOpacity: (v: number) => void
  /** Patch one camera slot (0 or 1). */
  setCamera: (index: 0 | 1, patch: Partial<CameraSlot>) => void
  /** Reset one camera slot to uncalibrated. */
  clearCamera: (index: 0 | 1) => void
  setJobRect: (r: Rect | null) => void
  setJobHeight: (mm: number | null) => void
  /** Whether at least the primary camera has a usable homography. */
  isCalibrated: () => boolean
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.85)

export const useCameraCalib = create<CameraCalibState>()(
  persist(
    (set, get) => ({
      enabled: false,
      overlayOpacity: 0.85,
      cameras: [emptySlot(), emptySlot()],
      jobRect: null,
      jobHeightMm: null,

      setEnabled: (v) => set({ enabled: v }),
      toggleEnabled: () => set((s) => ({ enabled: !s.enabled })),
      setOpacity: (v) => set({ overlayOpacity: clamp01(v) }),
      setCamera: (index, patch) =>
        set((s) => {
          const cameras: [CameraSlot, CameraSlot] = [s.cameras[0], s.cameras[1]]
          cameras[index] = { ...cameras[index], ...patch }
          return { cameras }
        }),
      clearCamera: (index) =>
        set((s) => {
          const cameras: [CameraSlot, CameraSlot] = [s.cameras[0], s.cameras[1]]
          cameras[index] = emptySlot()
          return { cameras }
        }),
      setJobRect: (r) => set({ jobRect: r }),
      setJobHeight: (mm) => set({ jobHeightMm: mm == null || Number.isFinite(mm) ? mm : get().jobHeightMm }),
      isCalibrated: () => {
        const c = get().cameras[0]
        if (c.mount === 'head') return Number.isFinite(c.pxPerMm) && (c.pxPerMm ?? 0) > 0
        return Array.isArray(c.H) && c.H.length === 9
      },
    }),
    {
      name: KEY,
      version: 2,
      // Persist calibration + the toggle; the live stream/reference frame are transient.
      partialize: (s) => ({
        enabled: s.enabled,
        overlayOpacity: s.overlayOpacity,
        cameras: s.cameras,
        jobRect: s.jobRect,
        jobHeightMm: s.jobHeightMm,
      }),
      // Backfill the head-mount fields onto calibrations saved before they existed
      // (older persisted slots only have deviceId/label/H/rms/frame*).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<CameraCalibState>
        const fix = (c: Partial<CameraSlot> | undefined): CameraSlot => ({ ...emptySlot(), ...(c ?? {}) })
        const cams = p.cameras
        const cameras: [CameraSlot, CameraSlot] = [
          fix(cams?.[0]),
          fix(cams?.[1]),
        ]
        return { ...current, ...p, cameras }
      },
    },
  ),
)

/** Re-export the matrix/rect types so consumers import them from the store too. */
export type { Mat3, Rect }
