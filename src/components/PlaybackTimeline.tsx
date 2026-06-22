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
import type { ReactNode } from 'react'
import { IconButton } from './IconButton'
import { SegControl } from './ui/SegControl'
import { usePlayback } from '../store/playback'
import { useT } from '../i18n'
import '../styles/timeline.css'

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const

/**
 * Tiny inline-SVG wrapper for the transport glyphs that have no entry in the
 * shared Icon set (jump-to-start/end, step-segment, loop). Crisp 24×24 line
 * icons inheriting `currentColor` instead of per-OS-inconsistent media emoji.
 */
function TIcon({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill={fill ? 'currentColor' : 'none'}
      stroke={fill ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

// ⏮ jump to start: a play-triangle pointing left against a bar.
const IconJumpStart = (
  <TIcon fill>
    <rect x="5" y="5" width="2.4" height="14" rx="0.5" />
    <path d="M20 5L9 12l11 7z" />
  </TIcon>
)
// ⏪ previous segment: a DOUBLE left triangle (rewind) — distinct from the single
// play triangle and from the bar-flanked jump-to-start.
const IconPrevSeg = (
  <TIcon fill>
    <path d="M12 5 4 12l8 7z" />
    <path d="M20 5l-8 7 8 7z" />
  </TIcon>
)
// ⏩ next segment: a DOUBLE right triangle (fast-forward) — clearly different
// from the single play triangle (the two looked identical before) and from the
// bar-flanked jump-to-end.
const IconNextSeg = (
  <TIcon fill>
    <path d="M4 5l8 7-8 7z" />
    <path d="M12 5l8 7-8 7z" />
  </TIcon>
)
// ⏭ jump to end: a play-triangle pointing right against a bar.
const IconJumpEnd = (
  <TIcon fill>
    <path d="M4 5l11 7L4 19z" />
    <rect x="16.6" y="5" width="2.4" height="14" rx="0.5" />
  </TIcon>
)
// 🔁 loop: two circular arrows.
const IconLoop = (
  <TIcon>
    <path d="M4 9a6 6 0 0 1 6-6h7" />
    <path d="M14 0.5L17.5 3 14 5.5" />
    <path d="M20 15a6 6 0 0 1-6 6H7" />
    <path d="M10 18.5L6.5 21 10 23.5" />
  </TIcon>
)

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
          icon={IconJumpStart}
          label={t('transport.jumpStart', 'Jump to start')}
          className="pt-btn"
          onClick={() => seek(0)}
        />
        <IconButton
          icon={IconPrevSeg}
          label={t('transport.prevSeg', 'Previous segment')}
          className="pt-btn"
          onClick={() => stepSeg(-1)}
        />
        <IconButton
          iconName={isPlaying ? 'pause' : 'play'}
          label={isPlaying ? t('transport.pause', 'Pause') : t('transport.play', 'Play')}
          className="pt-btn pt-btn--play"
          onClick={() => toggle()}
        />
        <IconButton
          icon={IconNextSeg}
          label={t('transport.nextSeg', 'Next segment')}
          className="pt-btn"
          onClick={() => stepSeg(1)}
        />
        <IconButton
          icon={IconJumpEnd}
          label={t('transport.jumpEnd', 'Jump to end')}
          className="pt-btn"
          onClick={() => seek(duration)}
        />
        <IconButton
          icon={IconLoop}
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

      <SegControl
        className="pt-speed"
        ariaLabel={t('transport.speed', 'Playback speed')}
        size="sm"
        value={speed}
        onChange={setSpeed}
        options={SPEEDS.map((s) => ({
          value: s,
          label: `${s}×`,
          title: t('transport.speedX', 'Speed {speed}×', { speed: s }),
        }))}
      />
    </div>
  )
}
