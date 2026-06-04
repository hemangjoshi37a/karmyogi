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

/** One calibrated camera slot. */
export interface CameraSlot {
  /** Chosen `MediaDeviceInfo.deviceId` (re-acquired on reload), or '' if unset. */
  deviceId: string
  /** Human label for the picker. */
  label: string
  /**
   * Image-pixel → bed-mm homography (length-9 row-major Mat3), or null until
   * calibrated. Solved from QR `TARGET` corners (recommended) or clicked bed
   * corners (markerless fallback) via core `solveHomography`.
   */
  H: number[] | null
  /** Reprojection RMS in mm of the last solve (calibration quality); null if uncalibrated. */
  rmsMm: number | null
  /** Frame size (px) the homography was solved at — overlay sampling needs it. */
  frameW: number
  frameH: number
}

function emptySlot(): CameraSlot {
  return { deviceId: '', label: '', H: null, rmsMm: null, frameW: 0, frameH: 0 }
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
        const h = get().cameras[0].H
        return Array.isArray(h) && h.length === 9
      },
    }),
    {
      name: KEY,
      // Persist calibration + the toggle; the live stream/reference frame are transient.
      partialize: (s) => ({
        enabled: s.enabled,
        overlayOpacity: s.overlayOpacity,
        cameras: s.cameras,
        jobRect: s.jobRect,
        jobHeightMm: s.jobHeightMm,
      }),
    },
  ),
)

/** Re-export the matrix/rect types so consumers import them from the store too. */
export type { Mat3, Rect }
