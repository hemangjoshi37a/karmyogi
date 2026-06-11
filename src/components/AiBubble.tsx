import { useCallback, useEffect, useRef, useState } from 'react'
import { AiChat, AiSettings } from '../panels/AiGcodePanel'
import { Modal } from './Modal'
import { Icon } from './Icons'
import { usePersistentState } from '../store'
import { useT } from '../i18n'
import '../styles/aibubble.css'

/**
 * Floating, draggable AI chat BUBBLE — the shipping surface for the AI G-code
 * feature (the old dockable "AI G-code" tab was dissolved). Behaves like a
 * website help/support widget:
 *
 *  - COLLAPSED: a circular floating button. Pointer-DRAGGABLE anywhere on screen
 *    (clamped to the viewport, position persisted). A click (movement under a
 *    small threshold) EXPANDS it; a drag just repositions it.
 *  - EXPANDED: a compact chat panel anchored to the bubble. Header has a SETTINGS
 *    gear (opens a modal with the provider/auth/model setup), a MINIMIZE button
 *    (back to the circle), and a CLOSE button (removes the bubble entirely —
 *    persisted; reopen from the top-bar AI toggle).
 *
 * The heavy chat + settings UI is reused verbatim from AiGcodePanel
 * (<AiChat/> + <AiSettings/>) so there is no copy-paste divergence; this file is
 * only the floating shell + drag/persistence + the settings modal.
 *
 * All open/closed/expanded/position state persists in localStorage so it
 * survives reloads.
 */

/** Click-vs-drag movement threshold in px — below this, a pointer-up is a click. */
const DRAG_THRESHOLD = 4
/** Default collapsed-bubble size (kept in sync with the CSS var). */
const BUBBLE_SIZE = 56
/** Margin to keep the bubble fully inside the viewport. */
const EDGE = 8

interface Pos {
  x: number
  y: number
}

/** Clamp a point so the bubble (size px) stays inside the viewport. */
function clampPos(p: Pos, size: number): Pos {
  if (typeof window === 'undefined') return p
  const maxX = Math.max(EDGE, window.innerWidth - size - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - size - EDGE)
  return {
    x: Math.min(Math.max(EDGE, p.x), maxX),
    y: Math.min(Math.max(EDGE, p.y), maxY),
  }
}

/** Clamp a top-left point so a w×h rect stays fully inside the viewport. */
function clampRect(p: Pos, w: number, h: number): Pos {
  if (typeof window === 'undefined') return p
  const maxX = Math.max(EDGE, window.innerWidth - w - EDGE)
  const maxY = Math.max(EDGE, window.innerHeight - h - EDGE)
  return { x: Math.min(Math.max(EDGE, p.x), maxX), y: Math.min(Math.max(EDGE, p.y), maxY) }
}

/** Default bubble anchor: bottom-right corner. */
function defaultPos(): Pos {
  if (typeof window === 'undefined') return { x: 24, y: 24 }
  return {
    x: window.innerWidth - BUBBLE_SIZE - 24,
    y: window.innerHeight - BUBBLE_SIZE - 24,
  }
}

export function AiBubble() {
  const t = useT()
  // Default to a visible collapsed bubble (closed = false) so first-run users
  // discover the feature; closing it persists and the top-bar toggle reopens it.
  const [closed, setClosed] = usePersistentState('karmyogi.aiBubble.closed', false)
  const [expanded, setExpanded] = usePersistentState('karmyogi.aiBubble.expanded', false)
  const [pos, setPos] = usePersistentState<Pos>('karmyogi.aiBubble.pos', defaultPos())
  // The EXPANDED panel can be dragged by its header to its own position; null =
  // anchored to the bubble (the default until the user first drags it).
  const [panelPos, setPanelPos] = usePersistentState<Pos | null>('karmyogi.aiBubble.panelPos', null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Re-show the bubble when the top-bar toggle dispatches the reopen event.
  useEffect(() => {
    const onOpen = () => {
      setClosed(false)
    }
    window.addEventListener('karmyogi:openAiBubble', onOpen)
    return () => window.removeEventListener('karmyogi:openAiBubble', onOpen)
  }, [setClosed])

  // Keep the bubble on-screen across viewport resizes.
  useEffect(() => {
    const onResize = () => {
      setPos((p) => clampPos(p, BUBBLE_SIZE))
      setPanelPos((p) =>
        p
          ? clampRect(p, Math.min(380, window.innerWidth - 16), Math.min(560, window.innerHeight - 16))
          : p,
      )
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setPos, setPanelPos])

  // --- Drag handling on the collapsed bubble (pointer events). ---
  const dragRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    moved: boolean
    pointerId: number
  } | null>(null)

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only primary button / touch.
      if (e.button !== 0 && e.pointerType === 'mouse') return
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: pos.x,
        originY: pos.y,
        moved: false,
        pointerId: e.pointerId,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [pos.x, pos.y],
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
      d.moved = true
      setPos(clampPos({ x: d.originX + dx, y: d.originY + dy }, BUBBLE_SIZE))
    },
    [setPos],
  )

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current
      dragRef.current = null
      try {
        ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
      // A non-drag pointer-up is a CLICK → expand.
      if (d && !d.moved) setExpanded(true)
    },
    [setExpanded],
  )

  // --- Drag handling on the EXPANDED panel's header (move the whole panel). ---
  const panelDragRef = useRef<{
    startX: number
    startY: number
    originX: number
    originY: number
    pointerId: number
  } | null>(null)

  const onHeadPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return
      // Don't start a drag from the header action buttons (settings/min/close).
      if ((e.target as HTMLElement).closest('.ai-bubble-btn')) return
      const W = Math.min(380, window.innerWidth - 16)
      const H = Math.min(560, window.innerHeight - 16)
      // Current panel top-left: the dragged position if set, else anchored to the bubble.
      let origin: Pos
      if (panelPos) {
        origin = clampRect(panelPos, W, H)
      } else {
        let left = pos.x + BUBBLE_SIZE - W
        let top = pos.y - H + BUBBLE_SIZE
        left = Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - W - EDGE))
        top = Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - H - EDGE))
        origin = { x: left, y: top }
      }
      panelDragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: origin.x,
        originY: origin.y,
        pointerId: e.pointerId,
      }
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    [panelPos, pos.x, pos.y],
  )

  const onHeadPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = panelDragRef.current
      if (!d) return
      const W = Math.min(380, window.innerWidth - 16)
      const H = Math.min(560, window.innerHeight - 16)
      setPanelPos(
        clampRect({ x: d.originX + (e.clientX - d.startX), y: d.originY + (e.clientY - d.startY) }, W, H),
      )
    },
    [setPanelPos],
  )

  const onHeadPointerUp = useCallback((e: React.PointerEvent) => {
    panelDragRef.current = null
    try {
      ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }, [])

  if (closed) return null

  const bubbleStyle: React.CSSProperties = { left: pos.x, top: pos.y }

  // Expanded-panel geometry. Until the user drags the header, the panel is
  // ANCHORED near the bubble (bottom-right at the bubble corner, clamped on
  // screen); once the header is dragged, `panelPos` takes over. (On phones, CSS
  // overrides this to a bottom sheet.)
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1366
  const vh = typeof window !== 'undefined' ? window.innerHeight : 768
  const panelW = Math.min(380, vw - 16)
  const panelH = Math.min(560, vh - 16)
  const anchored = (() => {
    let left = pos.x + BUBBLE_SIZE - panelW
    let top = pos.y - panelH + BUBBLE_SIZE
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, vw - panelW - EDGE))
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, vh - panelH - EDGE))
    return { x: left, y: top }
  })()
  const effectivePanel = panelPos ? clampRect(panelPos, panelW, panelH) : anchored
  const panelStyle: React.CSSProperties = {
    left: effectivePanel.x,
    top: effectivePanel.y,
    width: panelW,
    height: panelH,
  }

  return (
    <>
      {!expanded ? (
        <button
          type="button"
          className="ai-bubble"
          style={bubbleStyle}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          aria-label={t('ai.bubble.open', 'Open the AI G-code assistant')}
          title={t('ai.bubble.openTip', 'AI G-code assistant — drag to move, click to open')}
        >
          <AiSparkGlyph />
        </button>
      ) : (
        <div
          className="ai-bubble-panel"
          style={panelStyle}
          role="dialog"
          aria-label={t('ai.bubble.panelAria', 'AI G-code assistant')}
        >
          <header
            className="ai-bubble-head"
            style={{ cursor: 'move', touchAction: 'none' }}
            onPointerDown={onHeadPointerDown}
            onPointerMove={onHeadPointerMove}
            onPointerUp={onHeadPointerUp}
          >
            <span className="ai-bubble-head-title">
              <AiSparkGlyph size={16} />
              {t('ai.title', 'AI G-code')}
            </span>
            <span className="ai-bubble-head-actions">
              <button
                type="button"
                className="ai-bubble-btn"
                onClick={() => setSettingsOpen(true)}
                aria-label={t('ai.bubble.settings', 'AI settings')}
                title={t('ai.bubble.settings', 'AI settings')}
              >
                <Icon name="settings" size={16} />
              </button>
              <button
                type="button"
                className="ai-bubble-btn"
                onClick={() => setExpanded(false)}
                aria-label={t('ai.bubble.minimize', 'Minimize')}
                title={t('ai.bubble.minimizeTip', 'Minimize to the floating bubble')}
              >
                <Icon name="chevron-down" size={16} />
              </button>
              <button
                type="button"
                className="ai-bubble-btn ai-bubble-btn-close"
                onClick={() => {
                  setExpanded(false)
                  setClosed(true)
                }}
                aria-label={t('ai.bubble.close', 'Close assistant')}
                title={t('ai.bubble.closeTip', 'Close — reopen from the AI button in the top bar')}
              >
                <Icon name="close" size={16} />
              </button>
            </span>
          </header>
          <div className="ai-bubble-body">
            <AiChat compact onOpenSettings={() => setSettingsOpen(true)} />
          </div>
        </div>
      )}

      <Modal
        open={settingsOpen}
        title={t('ai.bubble.settingsTitle', 'AI provider & connection')}
        width={560}
        onClose={() => setSettingsOpen(false)}
      >
        <AiSettings />
      </Modal>
    </>
  )
}

/** Small sparkle/AI glyph (inline — Icons.tsx must not be edited). */
function AiSparkGlyph({ size = 26 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3l1.8 4.6L18.5 9.4 13.8 11.2 12 15.8 10.2 11.2 5.5 9.4 10.2 7.6z" />
      <path d="M18 14l.8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8z" />
    </svg>
  )
}
