import { useMemo, useState } from 'react'
import { useT } from '../i18n'
import { useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import {
  frameBoundsOfGcode,
  buildFrameProgram,
  type BuildFrameOptions,
} from '../core/framing'
import { BBox } from '../core/geometry'
import { Icon } from './Icons'

/**
 * Reusable "Frame" (perimeter-trace) control.
 *
 * Pressing Frame walks the machine head around the JOB's XY bounding box at a
 * SAFE height with the tool/laser OFF, so the operator can see where the job
 * will land and reposition the stock / work-zero before committing. Generic by
 * design — the 3D Carving tab AND the Laser tab can both reuse it (pass the
 * program `lines` or a precomputed `bounds`).
 *
 * SAFETY:
 *   - Motion only. The streamed frame is built by {@link buildFrameProgram}
 *     (safe-Z, no spindle, no laser power, never plunges).
 *   - The button is DISABLED unless the machine is connected AND idle AND a
 *     program with valid XY bounds exists.
 *   - It NEVER moves on render — only on an explicit click.
 *   - It streams the frame line-by-line via the MDI path (`grbl.send`), so it
 *     does NOT touch the loaded program / streaming cursor in the program store
 *     (it never uses `grbl.startProgram`, which would clobber the loaded job).
 *
 * Persisted options (shared across tabs):
 *   - `karmyogi.frame.feed`   — perimeter feed (mm/min)
 *   - `karmyogi.frame.repeat` — loop count
 *   - `karmyogi.frame.margin` — inset(+)/margin(−) per side (mm)
 */
export interface FrameButtonProps {
  /**
   * The program lines whose XY bounds to frame. Either this or {@link bounds}
   * must be supplied; `bounds` wins when both are given.
   */
  lines?: string[]
  /** A precomputed XY bounding box (overrides {@link lines}). */
  bounds?: BBox | null
  /** Safe Z (mm) the trace travels at. Default 5. */
  safeZ?: number
  /** Optional extra class on the wrapper (for panel-specific layout). */
  className?: string
  /** Show the compact feed / repeat / margin option inputs. Default true. */
  showOptions?: boolean
  /** Accessible label / button text. Default "Frame". */
  label?: string
}

const FRAME_STATES_OK = new Set(['Idle', 'Check'])

export function FrameButton({
  lines,
  bounds,
  safeZ = 5,
  className,
  showOptions = true,
  label,
}: FrameButtonProps) {
  const t = useT()
  const frameLabel = label ?? t('vp.frame.title', 'Frame')
  const connection = useMachine((s) => s.connection)
  const machineState = useMachine((s) => s.state)

  const [feed, setFeed] = usePersistentState<number>('karmyogi.frame.feed', 1500)
  const [repeat, setRepeat] = usePersistentState<number>('karmyogi.frame.repeat', 1)
  const [margin, setMargin] = usePersistentState<number>('karmyogi.frame.margin', 0)
  const [running, setRunning] = useState(false)

  // Resolve the XY bounds: an explicit `bounds` wins; otherwise scan the lines.
  const resolvedBounds = useMemo<BBox | null>(() => {
    if (bounds) return bounds
    if (lines && lines.length > 0) return frameBoundsOfGcode(lines)
    return null
  }, [bounds, lines])

  const connected = connection === 'connected'
  const idle = FRAME_STATES_OK.has(machineState)
  const hasBounds = !!resolvedBounds && resolvedBounds.isValid()

  // Disabled unless connected AND idle AND we have a framable program.
  const disabled = !connected || !idle || !hasBounds || running

  const size = resolvedBounds
    ? { w: resolvedBounds.width(), h: resolvedBounds.height() }
    : null

  // A precise tooltip — explains what it does and, if disabled, exactly why.
  const tip = !connected
    ? t('vp.frame.tip.connect', 'Frame — connect the machine first.')
    : !hasBounds
      ? t('vp.frame.tip.noBounds', 'Frame — generate a program with XY bounds first.')
      : !idle
        ? t('vp.frame.tip.notIdle', 'Frame — machine is {state}; wait until it is Idle.', {
            state: machineState,
          })
        : running
          ? t('vp.frame.framing', 'Framing…')
          : size
            ? t(
                'vp.frame.tip.ready',
                'Frame — trace the job perimeter ({w}×{h} mm) at safe Z with the tool OFF, so you can check placement.',
                { w: size.w.toFixed(1), h: size.h.toFixed(1) },
              )
            : t('vp.frame.tip.readyNoSize', 'Frame — trace the job perimeter with the tool OFF.')

  async function runFrame() {
    if (disabled || !resolvedBounds) return
    const opts: Partial<BuildFrameOptions> = { safeZ, feed, repeat, margin }
    const program = buildFrameProgram(resolvedBounds, opts)
    if (program.length === 0) return
    setRunning(true)
    try {
      // Stream via the MDI path (line-by-line) so the loaded program / cursor in
      // the program store is untouched. Send sequentially.
      for (const line of program) {
        await grbl.send(line)
      }
    } catch {
      /* surfaced on the console by grbl.send; just stop the spinner */
    } finally {
      setRunning(false)
    }
  }

  const num = (v: number) => (Number.isFinite(v) ? v : 0)

  return (
    <div className={className ? `frame-ctl ${className}` : 'frame-ctl'}>
      <button
        type="button"
        className="frame-btn"
        onClick={() => void runFrame()}
        disabled={disabled}
        title={tip}
        aria-label={tip}
      >
        <span className="frame-btn-ico" aria-hidden>
          <Icon name="frame" size={15} />
        </span>
        <span className="frame-btn-lbl">
          {running ? t('vp.frame.framing', 'Framing…') : frameLabel}
        </span>
      </button>

      {showOptions && (
        <div className="frame-opts">
          <label
            className="frame-opt"
            title={t('vp.frame.feed.title', 'Feed rate for the perimeter trace (mm/min)')}
          >
            <span>{t('vp.frame.speed', 'Frame speed')}</span>
            <input
              type="number"
              min={1}
              step={50}
              value={String(feed)}
              onChange={(e) => setFeed(Math.max(1, num(+e.target.value)))}
            />
            <i className="frame-opt-unit">{t('cc.unitMmMin', 'mm/min')}</i>
          </label>
          <label
            className="frame-opt"
            title={t('vp.frame.loops.title', 'How many times to loop the perimeter')}
          >
            <span>{t('vp.frame.loops', 'Loops')}</span>
            <input
              type="number"
              min={1}
              step={1}
              value={String(repeat)}
              onChange={(e) => setRepeat(Math.max(1, Math.round(num(+e.target.value))))}
            />
          </label>
          <label
            className="frame-opt"
            title={t(
              'vp.frame.inset.title',
              'Inset (+) shrinks the trace inward; margin (−) grows it outward, per side (mm)',
            )}
          >
            <span>{t('vp.frame.inset', 'Inset')}</span>
            <input
              type="number"
              step={0.5}
              value={String(margin)}
              onChange={(e) => setMargin(num(+e.target.value))}
            />
          </label>
        </div>
      )}
    </div>
  )
}
