import { useEffect, useRef } from 'react'
import type { Vec3 } from '../store'

/** How often a held jog button re-fires (ms). */
const HOLD_INTERVAL_MS = 125

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
  onJog: (delta: JogDelta) => void
  /** Cancel an in-progress jog. */
  onCancel?: () => void
}

interface JogCell {
  label: string
  delta?: JogDelta
  className?: string
  area: string
}

/**
 * Touch-friendly XY + Z jog pad. Calls onJog with a relative-mm delta scaled by
 * `step`. Presentational (W4-owned); keyboard handling lives in the panel via
 * jogKeyToDelta so the panel can scope it to focus.
 */
export function JogPad({ disabled, step, onJog, onCancel }: JogPadProps) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const holding = useRef(false)

  const stopTimer = () => {
    if (timer.current !== null) {
      clearInterval(timer.current)
      timer.current = null
    }
  }

  // Begin a held jog: fire once immediately, then repeat until release.
  const startHold = (delta: JogDelta) => {
    if (disabled) return
    holding.current = true
    onJog(delta)
    stopTimer()
    timer.current = setInterval(() => onJog(delta), HOLD_INTERVAL_MS)
  }

  // Release: stop repeating and cancel any queued motion so it halts at once.
  const endHold = () => {
    if (!holding.current) return
    holding.current = false
    stopTimer()
    onCancel?.()
  }

  // Safety: clear the timer if the component unmounts mid-hold.
  useEffect(() => stopTimer, [])

  const holdHandlers = (delta: JogDelta) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      startHold(delta)
    },
    onPointerUp: endHold,
    onPointerLeave: endHold,
    onPointerCancel: endHold,
  })

  const xy: JogCell[] = [
    { label: '↖', delta: { x: -step, y: step }, area: '1 / 1' },
    { label: 'Y+', delta: { y: step }, area: '1 / 2' },
    { label: '↗', delta: { x: step, y: step }, area: '1 / 3' },
    { label: 'X−', delta: { x: -step }, area: '2 / 1' },
    { label: '⨯', className: 'cancel', area: '2 / 2' },
    { label: 'X+', delta: { x: step }, area: '2 / 3' },
    { label: '↙', delta: { x: -step, y: -step }, area: '3 / 1' },
    { label: 'Y−', delta: { y: -step }, area: '3 / 2' },
    { label: '↘', delta: { x: step, y: -step }, area: '3 / 3' },
  ]

  const z: JogCell[] = [
    { label: 'Z+', delta: { z: step }, area: '1' },
    { label: 'Z−', delta: { z: -step }, area: '3' },
  ]

  return (
    <div className="jogpad">
      <div className="jog-grid" role="group" aria-label="XY jog">
        {xy.map((c) => (
          <button
            key={c.area}
            type="button"
            className={`jog-btn${c.className ? ' ' + c.className : ''}`}
            style={{ touchAction: 'none' }}
            disabled={disabled}
            aria-label={c.delta ? `Jog ${c.label}` : 'Cancel jog'}
            {...(c.delta ? holdHandlers(c.delta) : { onClick: () => onCancel?.() })}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="jog-z" role="group" aria-label="Z jog">
        {z.map((c) => (
          <button
            key={c.area}
            type="button"
            className="jog-btn"
            style={{ gridRow: c.area, touchAction: 'none' }}
            disabled={disabled}
            aria-label={`Jog ${c.label}`}
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
