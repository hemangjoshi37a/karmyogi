import { create } from 'zustand'

/**
 * skinTracking — the LIVE channel for camera-based skin tracking on the
 * Tattoo/Henna tab. This store is the INTEGRATION SEAM between the computer-vision
 * modules and the panel (mirrors how `solderViz` connects the Soldering panel to
 * the 3D Viewer):
 *
 *   • the CV pipeline computes results and PUSHES them here
 *       Phase 1 (fiducialTrack):  detectMarkers → poseFromMarkers → setOffset()
 *       Phase 2 (stereoDepth):    disparity → depth → fitCylinder → setDepth()
 *       both report progress via setStatus()
 *   • the Tattoo panel READS `offset` to drive its registration (dx, dy, theta)
 *     and `depth.radius` to drive the cylinder-wrap radius, falling back to its
 *     manual controls when tracking is off / not yet producing data.
 *
 * HONEST by construction: when the CV isn't actually producing numbers (OpenCV
 * not loaded, no markers, calibration missing), `status` carries the real reason
 * and `offset` / `depth` stay `null` — the panel must not invent values. The CV
 * modules NEVER write fabricated data here.
 *
 * Pure data (no React/DOM/three/OpenCV imports). Not persisted — it is live,
 * session-only tracking state, meaningless without the camera running.
 */

/** Planar registration offset from the fiducial pose (Phase 1). */
export interface SkinOffset {
  /** X offset (mm) to shift the toolpath by. */
  dx: number
  /** Y offset (mm) to shift the toolpath by. */
  dy: number
  /** Rotation (deg) about the design centre. */
  theta: number
  /** Tracker confidence 0..1 (for honest UI display / gating). */
  confidence: number
}

/** Skin-surface model from the stereo depth fit (Phase 2). */
export interface SkinDepth {
  /** Fitted limb cylinder radius (mm). */
  radius: number
  /** Top surface Z (mm) — the skin-Z datum for the toolpath. */
  topZ: number
}

/**
 * Honest pipeline status. Aligns with the CV modules' own status codes so they
 * map straight through. `off` = tracking disabled; `tracking` = live data fresh.
 */
export type SkinTrackStatus =
  | 'off'
  | 'opencv-not-loaded'
  | 'aruco-unavailable'
  | 'no-markers'
  | 'needs-calibration'
  | 'tracking'
  | 'error'

interface SkinTrackingState {
  /** Whether camera tracking is switched on (gates the pipeline). */
  enabled: boolean
  /** Honest status of the live pipeline. */
  status: SkinTrackStatus
  /** Latest Phase-1 registration offset, or null when none is available. */
  offset: SkinOffset | null
  /** Latest Phase-2 skin-depth model, or null when none is available. */
  depth: SkinDepth | null
  /** Enable/disable tracking. Disabling resets status to 'off'. */
  setEnabled: (enabled: boolean) => void
  /** Publish (or clear) the live registration offset. */
  setOffset: (offset: SkinOffset | null) => void
  /** Publish (or clear) the live skin-depth model. */
  setDepth: (depth: SkinDepth | null) => void
  /** Publish the honest pipeline status. */
  setStatus: (status: SkinTrackStatus) => void
  /** Reset to the idle baseline (panel unmounted / tracking stopped). */
  reset: () => void
}

export const useSkinTracking = create<SkinTrackingState>((set) => ({
  enabled: false,
  status: 'off',
  offset: null,
  depth: null,
  setEnabled: (enabled) => set(enabled ? { enabled } : { enabled: false, status: 'off' }),
  setOffset: (offset) => set({ offset }),
  setDepth: (depth) => set({ depth }),
  setStatus: (status) => set({ status }),
  reset: () => set({ enabled: false, status: 'off', offset: null, depth: null }),
}))
