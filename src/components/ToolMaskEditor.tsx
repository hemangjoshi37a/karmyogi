import { useCallback, useEffect, useRef, useState } from 'react'
import { useToolMask, type MaskRect } from '../store/toolMask'
import '../styles/cam.css'
import '../styles/camera.css'

/**
 * Tool-mask editor: draws the live head-camera view and overlays a
 * draggable/resizable rectangle the operator positions over the FIXED tool
 * (soldering iron / spindle) region so the bed-mosaic builder can exclude it.
 *
 * The rectangle is stored in NORMALIZED frame UV [0..1] in {@link useToolMask},
 * so it is independent of the on-screen preview size and feeds straight into the
 * mosaic shader (see `maskRectArray`). All interaction is via Pointer Events, so
 * the same drag/resize works on desktop (mouse) and touch (finger/stylus).
 *
 * Usage (mount inside the Camera panel):
 *   <ToolMaskEditor video={videoRef.current} />
 *
 * `video` is the live `<HTMLVideoElement>` (or null while the camera is off). We
 * never own the stream — we just mirror the element's pixels into a preview
 * via the same element wrapped in our own container.
 */
export interface ToolMaskEditorProps {
  /** Live camera video element, or null when no camera is connected. */
  video: HTMLVideoElement | null
  /** Optional extra className for the outer container. */
  className?: string
}

/** Which interaction is in progress on the overlay rectangle. */
type DragMode =
  | { kind: 'move'; startX: number; startY: number; rect: MaskRect }
  | { kind: 'resize'; corner: Corner; rect: MaskRect }
  | null

type Corner = 'nw' | 'ne' | 'sw' | 'se'

const CORNERS: Corner[] = ['nw', 'ne', 'sw', 'se']

export function ToolMaskEditor({ video, className }: ToolMaskEditorProps) {
  const enabled = useToolMask((s) => s.enabled)
  const rect = useToolMask((s) => s.rect)
  const setEnabled = useToolMask((s) => s.setEnabled)
  const setRect = useToolMask((s) => s.setRect)
  const reset = useToolMask((s) => s.reset)

  const stageRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const dragRef = useRef<DragMode>(null)
  const [hasVideo, setHasVideo] = useState(false)

  // Mirror the live video into a canvas (we don't own/move the real <video>).
  // A rAF loop paints each frame; falls back to a placeholder when no source.
  useEffect(() => {
    let raf = 0
    const draw = () => {
      const cv = canvasRef.current
      const ctx = cv?.getContext('2d')
      if (cv && ctx) {
        const vw = video?.videoWidth ?? 0
        const vh = video?.videoHeight ?? 0
        if (video && vw > 0 && vh > 0) {
          if (cv.width !== vw || cv.height !== vh) {
            cv.width = vw
            cv.height = vh
          }
          if (!hasVideo) setHasVideo(true)
          try {
            ctx.drawImage(video, 0, 0, vw, vh)
          } catch {
            /* not ready yet */
          }
        } else if (hasVideo) {
          setHasVideo(false)
        }
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [video, hasVideo])

  /** Pointer position → normalized [0..1] coords within the preview stage. */
  const toNorm = useCallback((clientX: number, clientY: number) => {
    const el = stageRef.current
    if (!el) return { nx: 0, ny: 0 }
    const r = el.getBoundingClientRect()
    const nx = r.width > 0 ? (clientX - r.left) / r.width : 0
    const ny = r.height > 0 ? (clientY - r.top) / r.height : 0
    return { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) }
  }, [])

  const onPointerDownMove = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      const { nx, ny } = toNorm(e.clientX, e.clientY)
      dragRef.current = { kind: 'move', startX: nx, startY: ny, rect: { ...rect } }
    },
    [rect, toNorm],
  )

  const onPointerDownResize = useCallback(
    (corner: Corner) => (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      dragRef.current = { kind: 'resize', corner, rect: { ...rect } }
    },
    [rect],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = dragRef.current
      if (!drag) return
      e.preventDefault()
      const { nx, ny } = toNorm(e.clientX, e.clientY)
      if (drag.kind === 'move') {
        const dx = nx - drag.startX
        const dy = ny - drag.startY
        setRect({ x: drag.rect.x + dx, y: drag.rect.y + dy, w: drag.rect.w, h: drag.rect.h })
      } else {
        // Resize: keep the OPPOSITE corner fixed, move the grabbed corner to (nx,ny).
        const left = drag.corner === 'nw' || drag.corner === 'sw'
        const top = drag.corner === 'nw' || drag.corner === 'ne'
        const fixedX = left ? drag.rect.x + drag.rect.w : drag.rect.x
        const fixedY = top ? drag.rect.y + drag.rect.h : drag.rect.y
        const x = Math.min(fixedX, nx)
        const y = Math.min(fixedY, ny)
        const w = Math.abs(fixedX - nx)
        const h = Math.abs(fixedY - ny)
        setRect({ x, y, w, h })
      }
    },
    [setRect, toNorm],
  )

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current) {
      ;(e.target as Element).releasePointerCapture?.(e.pointerId)
      dragRef.current = null
    }
  }, [])

  // ── inline styles (theme-token driven where it overlays app chrome; the
  // selection handles keep a fixed white ring so they stay legible over ANY
  // camera frame regardless of theme) ──────────────────────────────────────────
  const pct = (v: number) => `${(v * 100).toFixed(3)}%`
  const handleSize = 14
  const handleStyle: React.CSSProperties = {
    position: 'absolute',
    width: handleSize,
    height: handleSize,
    background: 'var(--accent)',
    border: '2px solid #fff',
    borderRadius: 'var(--radius-sm)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.5)',
    touchAction: 'none',
  }
  const cornerPos: Record<Corner, React.CSSProperties> = {
    nw: { left: -handleSize / 2, top: -handleSize / 2, cursor: 'nwse-resize' },
    ne: { right: -handleSize / 2, top: -handleSize / 2, cursor: 'nesw-resize' },
    sw: { left: -handleSize / 2, bottom: -handleSize / 2, cursor: 'nesw-resize' },
    se: { right: -handleSize / 2, bottom: -handleSize / 2, cursor: 'nwse-resize' },
  }

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <label
          className="cam-switch"
          style={{ minHeight: 36 }}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          <span>Enable tool mask</span>
        </label>
        <button
          type="button"
          className="cam-btn"
          onClick={reset}
        >
          Reset
        </button>
        <span style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-body)' }}>
          Drag the box over the tool to exclude it from the bed mosaic.
        </span>
      </div>

      <div
        ref={stageRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '4 / 3',
          maxWidth: 640,
          background: '#000',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          touchAction: 'none',
          userSelect: 'none',
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
        />
        {!hasVideo && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 'var(--sp-4)',
              color: 'var(--fg-muted)',
              fontSize: 'var(--fs-body)',
              pointerEvents: 'none',
            }}
          >
            No camera — connect the head camera to position the mask
          </div>
        )}

        {/* Dim overlay outside the rect (only meaningful look when enabled). */}
        <div
          style={{
            position: 'absolute',
            left: pct(rect.x),
            top: pct(rect.y),
            width: pct(rect.w),
            height: pct(rect.h),
            border: `2px dashed ${enabled ? 'var(--accent)' : 'var(--fg-muted)'}`,
            background: enabled
              ? 'color-mix(in srgb, var(--accent) 18%, transparent)'
              : 'color-mix(in srgb, var(--fg-muted) 14%, transparent)',
            boxSizing: 'border-box',
            cursor: 'move',
            touchAction: 'none',
          }}
          onPointerDown={onPointerDownMove}
        >
          <div
            style={{
              position: 'absolute',
              top: 2,
              left: 4,
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.5px',
              color: '#fff',
              textShadow: '0 0 3px #000',
              pointerEvents: 'none',
            }}
          >
            TOOL
          </div>
          {CORNERS.map((c) => (
            <div
              key={c}
              onPointerDown={onPointerDownResize(c)}
              style={{ ...handleStyle, ...cornerPos[c] }}
            />
          ))}
        </div>
      </div>

      <div
        style={{
          fontSize: 'var(--fs-label)',
          fontFamily: 'ui-monospace, monospace',
          color: 'var(--fg-muted)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        rect uv: x={rect.x.toFixed(3)} y={rect.y.toFixed(3)} w={rect.w.toFixed(3)} h={rect.h.toFixed(3)}
      </div>
    </div>
  )
}

export default ToolMaskEditor
