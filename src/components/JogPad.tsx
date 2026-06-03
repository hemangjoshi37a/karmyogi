import { useEffect, useRef } from 'react'
import type { Vec3 } from '../store'
import { InfoTip } from './InfoTip'
import { useT } from '../i18n'

/**
 * How long a jog button must stay held (ms) before a tap becomes a continuous
 * jog. Under this threshold = a single precise step; over it = continuous motion
 * that stops the instant the button is released.
 */
export const HOLD_DELAY_MS = 250

export interface JogDelta {
  x?: number
  y?: number
  z?: number
}

/**
 * Maps a keyboard event key to a jog delta (relative mm) for the given step.
 * Arrow keys = XY, PageUp/PageDown = Z. Returns null for unhandled keys.
 * Pure — unit-tested.
 */
export function jogKeyToDelta(key: string, step: number): JogDelta | null {
  switch (key) {
    case 'ArrowRight':
      return { x: step }
    case 'ArrowLeft':
      return { x: -step }
    case 'ArrowUp':
      return { y: step }
    case 'ArrowDown':
      return { y: -step }
    case 'PageUp':
      return { z: step }
    case 'PageDown':
      return { z: -step }
    default:
      return null
  }
}

interface JogPadProps {
  disabled?: boolean
  step: number
  /** Single precise step (a tap). */
  onJog: (delta: JogDelta) => void
  /** Continuous jog (a hold) — keeps moving until onCancel. */
  onJogHold?: (delta: JogDelta) => void
  /** Cancel an in-progress jog (must send jogCancel / 0x85 to stop immediately). */
  onCancel?: () => void
}

interface JogCell {
  label: string
  delta?: JogDelta
  className?: string
  area: string
  /** i18n key + English fallback for the hover tooltip. */
  tip?: { key: string; en: string }
}

/**
 * Touch-friendly XY + Z jog pad. A quick tap fires a single precise `step`
 * (onJog); pressing and holding past HOLD_DELAY_MS switches to continuous motion
 * (onJogHold); releasing (pointer up / leave / cancel) calls onCancel which must
 * send GRBL's jog-cancel (0x85) so the machine STOPS immediately — no leftover
 * queued motion. Presentational (W4-owned); keyboard handling lives in the panel
 * via jogKeyToDelta so the panel can scope it to focus.
 */
export function JogPad({ disabled, step, onJog, onJogHold, onCancel }: JogPadProps) {
  const t = useT()
  // Single one-shot timer: when it fires, the press has become a hold.
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while a press is active (between pointer-down and release).
  const pressed = useRef(false)
  // True once a press has escalated to continuous motion (needs a cancel).
  const continuous = useRef(false)

  const clearHoldTimer = () => {
    if (holdTimer.current !== null) {
      clearTimeout(holdTimer.current)
      holdTimer.current = null
    }
  }

  // Begin a press: fire one precise step now (the tap); if still held after the
  // delay, escalate to continuous motion.
  const startPress = (delta: JogDelta) => {
    if (disabled) return
    pressed.current = true
    continuous.current = false
    onJog(delta) // precise single-step tap
    clearHoldTimer()
    holdTimer.current = setTimeout(() => {
      holdTimer.current = null
      if (!pressed.current) return
      continuous.current = true
      onJogHold?.(delta) // escalate to continuous motion
    }, HOLD_DELAY_MS)
  }

  // Release: cancel the pending escalation and stop any continuous motion at
  // once. Always cancel — even a quick tap may have queued a jog — so the
  // machine never keeps moving after release.
  const endPress = () => {
    if (!pressed.current) return
    pressed.current = false
    continuous.current = false
    clearHoldTimer()
    onCancel?.()
  }

  // Safety: clear the timer if the component unmounts mid-press.
  useEffect(() => clearHoldTimer, [])

  const holdHandlers = (delta: JogDelta) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      startPress(delta)
    },
    onPointerUp: endPress,
    onPointerLeave: endPress,
    onPointerCancel: endPress,
  })

  const xy: JogCell[] = [
    { label: '↖', delta: { x: -step, y: step }, area: '1 / 1', tip: { key: 'ctrl.jog.tip.xnyp', en: 'Jog X−Y+ (hold for continuous)' } },
    { label: 'Y+', delta: { y: step }, area: '1 / 2', tip: { key: 'ctrl.jog.tip.yp', en: 'Jog Y+ (hold for continuous)' } },
    { label: '↗', delta: { x: step, y: step }, area: '1 / 3', tip: { key: 'ctrl.jog.tip.xpyp', en: 'Jog X+Y+ (hold for continuous)' } },
    { label: 'X−', delta: { x: -step }, area: '2 / 1', tip: { key: 'ctrl.jog.tip.xn', en: 'Jog X− (hold for continuous)' } },
    { label: '⨯', className: 'cancel', area: '2 / 2', tip: { key: 'ctrl.jog.tip.cancel', en: 'Stop / cancel jog' } },
    { label: 'X+', delta: { x: step }, area: '2 / 3', tip: { key: 'ctrl.jog.tip.xp', en: 'Jog X+ (hold for continuous)' } },
    { label: '↙', delta: { x: -step, y: -step }, area: '3 / 1', tip: { key: 'ctrl.jog.tip.xnyn', en: 'Jog X−Y− (hold for continuous)' } },
    { label: 'Y−', delta: { y: -step }, area: '3 / 2', tip: { key: 'ctrl.jog.tip.yn', en: 'Jog Y− (hold for continuous)' } },
    { label: '↘', delta: { x: step, y: -step }, area: '3 / 3', tip: { key: 'ctrl.jog.tip.xpyn', en: 'Jog X+Y− (hold for continuous)' } },
  ]

  const z: JogCell[] = [
    { label: 'Z+', delta: { z: step }, area: '1', tip: { key: 'ctrl.jog.tip.zp', en: 'Jog Z+ (hold for continuous)' } },
    { label: 'Z−', delta: { z: -step }, area: '3', tip: { key: 'ctrl.jog.tip.zn', en: 'Jog Z− (hold for continuous)' } },
  ]

  return (
    <div className="jogpad">
      <span className="jog-info" aria-hidden="false">
        <InfoTip topic="jogStep" />
      </span>
      <div className="jog-grid" role="group" aria-label={t('ctrl.jog.xy', 'XY jog')}>
        {xy.map((c) => (
          <button
            key={c.area}
            type="button"
            className={`jog-btn${c.className ? ' ' + c.className : ''}`}
            style={{ touchAction: 'none' }}
            disabled={disabled}
            title={c.tip ? t(c.tip.key, c.tip.en) : undefined}
            aria-label={c.delta ? t('ctrl.jog.dir', 'Jog {dir}', { dir: c.label }) : t('ctrl.jog.cancel', 'Cancel jog')}
            {...(c.delta ? holdHandlers(c.delta) : { onClick: () => onCancel?.() })}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="jog-z" role="group" aria-label={t('ctrl.jog.z', 'Z jog')}>
        {z.map((c) => (
          <button
            key={c.area}
            type="button"
            className="jog-btn"
            style={{ gridRow: c.area, touchAction: 'none' }}
            disabled={disabled}
            title={c.tip ? t(c.tip.key, c.tip.en) : undefined}
            aria-label={t('ctrl.jog.dir', 'Jog {dir}', { dir: c.label })}
            {...(c.delta ? holdHandlers(c.delta) : {})}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Builds a JogParams-shaped object from a delta + feed (skips zero axes). */
export function jogParamsFromDelta(delta: JogDelta, feed: number): { x?: number; y?: number; z?: number; feed: number } {
  const out: { x?: number; y?: number; z?: number; feed: number } = { feed }
  if (delta.x) out.x = delta.x
  if (delta.y) out.y = delta.y
  if (delta.z) out.z = delta.z
  return out
}

export type { Vec3 }
