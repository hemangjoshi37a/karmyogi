import { create } from 'zustand'

/**
 * Transient (NOT persisted) live-camera bus.
 *
 * The Camera panel owns the `getUserMedia` <video> elements; the 3D viewer's
 * `CameraBedPlane` needs them to build a live `THREE.VideoTexture`. Rather than
 * thread refs across the two component trees, the panel publishes its active
 * <video> element(s) here by slot and the viewer subscribes. Calibration itself
 * (the homography, opacity, toggle, job rect) lives in the PERSISTED
 * `useCameraCalib` store — this one holds only the ephemeral DOM/stream handles,
 * so nothing here is written to localStorage.
 */
interface CameraLiveState {
  /** Live <video> per camera slot (0 = primary, 1 = secondary), or null when off. */
  videoEls: [HTMLVideoElement | null, HTMLVideoElement | null]
  /** Bumped whenever a stream (re)starts, so the viewer can re-create its texture. */
  epoch: number
  setVideoEl: (index: 0 | 1, el: HTMLVideoElement | null) => void
}

export const useCameraLive = create<CameraLiveState>((set) => ({
  videoEls: [null, null],
  epoch: 0,
  setVideoEl: (index, el) =>
    set((s) => {
      const videoEls: [HTMLVideoElement | null, HTMLVideoElement | null] = [s.videoEls[0], s.videoEls[1]]
      videoEls[index] = el
      return { videoEls, epoch: s.epoch + 1 }
    }),
}))
