/**
 * Playback / simulation transport state (zustand).
 *
 * Drives the "Premiere-Pro-style" timeline that scrubs a built {@link Timeline}
 * in time so the 3D viewer can animate the cutter tip and progressively reveal
 * the toolpath. This store is deliberately NOT persisted — it is transient
 * playhead state tied to the currently loaded program.
 *
 * The clock itself is driven externally (the transport component runs a
 * requestAnimationFrame loop and calls `tick(dt)` each frame while playing);
 * this store only holds state and advances time when ticked.
 */

import { create } from 'zustand'
import type { Timeline } from '../core/simulation'

interface PlaybackState {
  /** The currently loaded timeline, or null when there is nothing to simulate. */
  timeline: Timeline | null
  isPlaying: boolean
  /** Current playhead time in seconds. */
  time: number
  /** Playback rate multiplier (1 = realtime). */
  speed: number
  loop: boolean

  /** Install a timeline; resets playhead to 0 and pauses. */
  setTimeline(tl: Timeline | null): void
  play(): void
  pause(): void
  toggle(): void
  /** Seek to an absolute time (seconds), clamped to [0, duration]. */
  seek(t: number): void
  /** Seek to a fraction of the duration; `f` in [0,1]. */
  seekFraction(f: number): void
  setSpeed(s: number): void
  setLoop(b: boolean): void
  /** Jump the playhead to the previous (-1) or next (+1) segment boundary. */
  stepSeg(dir: 1 | -1): void
  /** Advance time by `dtSec * speed` while playing; loop or pause at the end. */
  tick(dtSec: number): void
}

const clampTime = (t: number, duration: number): number =>
  t < 0 ? 0 : t > duration ? duration : t

export const usePlayback = create<PlaybackState>()((set, get) => ({
  timeline: null,
  isPlaying: false,
  time: 0,
  speed: 1,
  loop: false,

  setTimeline: (tl) => set({ timeline: tl, time: 0, isPlaying: false }),

  play: () => {
    const { timeline } = get()
    if (!timeline || timeline.duration <= 0) return
    // Replaying from the very end restarts from the top.
    const time = get().time >= timeline.duration ? 0 : get().time
    set({ isPlaying: true, time })
  },

  pause: () => set({ isPlaying: false }),

  toggle: () => {
    if (get().isPlaying) get().pause()
    else get().play()
  },

  seek: (t) => {
    const { timeline } = get()
    const duration = timeline?.duration ?? 0
    set({ time: clampTime(t, duration) })
  },

  seekFraction: (f) => {
    const { timeline } = get()
    const duration = timeline?.duration ?? 0
    const ff = f < 0 ? 0 : f > 1 ? 1 : f
    set({ time: clampTime(ff * duration, duration) })
  },

  setSpeed: (s) => set({ speed: s > 0 ? s : 1 }),

  setLoop: (b) => set({ loop: b }),

  stepSeg: (dir) => {
    const { timeline, time } = get()
    if (!timeline || timeline.segments.length === 0) return
    const segs = timeline.segments
    const eps = 1e-6
    if (dir > 0) {
      // Next boundary strictly after the current time.
      for (const seg of segs) {
        if (seg.tEnd > time + eps) {
          get().seek(seg.tEnd)
          return
        }
      }
      get().seek(timeline.duration)
    } else {
      // Previous boundary strictly before the current time.
      let target = 0
      for (const seg of segs) {
        if (seg.tStart < time - eps) target = seg.tStart
        else break
      }
      get().seek(target)
    }
  },

  tick: (dtSec) => {
    const { isPlaying, timeline, time, speed, loop } = get()
    if (!isPlaying || !timeline || timeline.duration <= 0) return
    const next = time + dtSec * speed
    if (next >= timeline.duration) {
      if (loop) set({ time: next % timeline.duration })
      else set({ time: timeline.duration, isPlaying: false })
    } else {
      set({ time: next < 0 ? 0 : next })
    }
  },
}))
