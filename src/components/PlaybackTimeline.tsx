/**
 * PlaybackTimeline — a compact, Premiere-Pro-style transport bar.
 *
 * Reads and drives the {@link usePlayback} store: transport buttons, a scrubber
 * bound to the playhead time, an elapsed/total readout, and a speed control.
 * It also OWNS the clock: a requestAnimationFrame loop advances playback time
 * while playing (the store itself never self-ticks). The 3D viewer reads the
 * same store to animate the cutter and reveal the path.
 */

import { useEffect, useRef } from 'react'
import { IconButton } from './IconButton'
import { usePlayback } from '../store/playback'
import { useT } from '../i18n'
import '../styles/timeline.css'

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const

/** Format seconds as `m:ss`. */
function fmt(sec: number): string {
  if (!isFinite(sec) || sec < 0) sec = 0
  const total = Math.floor(sec)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function PlaybackTimeline() {
  const t = useT()
  const timeline = usePlayback((s) => s.timeline)
  const isPlaying = usePlayback((s) => s.isPlaying)
  const time = usePlayback((s) => s.time)
  const speed = usePlayback((s) => s.speed)
  const loop = usePlayback((s) => s.loop)

  const seek = usePlayback((s) => s.seek)
  const toggle = usePlayback((s) => s.toggle)
  const stepSeg = usePlayback((s) => s.stepSeg)
  const setSpeed = usePlayback((s) => s.setSpeed)
  const setLoop = usePlayback((s) => s.setLoop)

  const duration = timeline?.duration ?? 0
  const disabled = !timeline || duration <= 0

  // ---- Clock: rAF loop, active only while playing. -----------------------
  const rafRef = useRef<number | null>(null)
  const lastRef = useRef<number>(0)

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      return
    }
    lastRef.current = performance.now()
    const frame = (now: number) => {
      const dt = (now - lastRef.current) / 1000
      lastRef.current = now
      usePlayback.getState().tick(dt)
      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
  }, [isPlaying])

  if (disabled) {
    return (
      <div className="pt-bar pt-bar--disabled" aria-disabled="true">
        <span className="pt-empty">
          {t('transport.empty', 'No toolpath to simulate')}
        </span>
      </div>
    )
  }

  const pct = duration > 0 ? (time / duration) * 100 : 0

  return (
    <div className="pt-bar">
      <div className="pt-transport">
        <IconButton
          icon="⏮"
          label={t('transport.jumpStart', 'Jump to start')}
          className="pt-btn"
          onClick={() => seek(0)}
        />
        <IconButton
          icon="◀"
          label={t('transport.prevSeg', 'Previous segment')}
          className="pt-btn"
          onClick={() => stepSeg(-1)}
        />
        <IconButton
          icon={isPlaying ? '⏸' : '▶'}
          label={isPlaying ? t('transport.pause', 'Pause') : t('transport.play', 'Play')}
          className="pt-btn pt-btn--play"
          onClick={() => toggle()}
        />
        <IconButton
          icon="▶▌"
          label={t('transport.nextSeg', 'Next segment')}
          className="pt-btn"
          onClick={() => stepSeg(1)}
        />
        <IconButton
          icon="⏭"
          label={t('transport.jumpEnd', 'Jump to end')}
          className="pt-btn"
          onClick={() => seek(duration)}
        />
        <IconButton
          icon="🔁"
          label={loop ? t('transport.looping', 'Looping (on)') : t('transport.loop', 'Loop')}
          className={loop ? 'pt-btn pt-btn--active' : 'pt-btn'}
          aria-pressed={loop}
          onClick={() => setLoop(!loop)}
        />
      </div>

      <div
        className="pt-scrub"
        style={{
          ['--pt-pct' as string]: `${pct}%`,
          // Unitless fraction so the fill can be aligned to the thumb CENTRE
          // (which is inset by half the thumb width at each end).
          ['--pt-frac' as string]: `${pct / 100}`,
        }}
      >
        <input
          type="range"
          className="pt-range"
          min={0}
          max={duration}
          step={duration / 1000 || 0.001}
          value={time}
          aria-label={t('transport.scrub', 'Scrub timeline')}
          onChange={(e) => seek(parseFloat(e.target.value))}
        />
      </div>

      <span className="pt-readout" aria-label={t('transport.readout', 'Elapsed and total time')}>
        {fmt(time)} / {fmt(duration)}
      </span>

      <div className="pt-speed" role="group" aria-label={t('transport.speed', 'Playback speed')}>
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={s === speed ? 'pt-speed-btn pt-speed-btn--active' : 'pt-speed-btn'}
            aria-pressed={s === speed}
            title={t('transport.speedX', 'Speed {speed}×', { speed: s })}
            onClick={() => setSpeed(s)}
          >
            {s}×
          </button>
        ))}
      </div>
    </div>
  )
}
