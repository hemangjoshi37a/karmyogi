import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { EXPLAINERS } from '../core/explainers'
import { useT } from '../i18n'
import '../styles/infotip.css'

interface InfoTipProps {
  /** Looks up plain-language content in EXPLAINERS (and the explain.* keys). */
  topic: string
  /** Optional override for the popover heading. */
  title?: string
  /** Optional override for the popover body text. */
  body?: string
  /** Extra class on the trigger button (for inline spacing tweaks). */
  className?: string
}

/**
 * A tiny, accessible "ⓘ" info affordance.
 *
 * Reveals a small popover with a short TITLE + plain-language BODY explaining
 * what a setting means and what changing it does — so a non-expert operator can
 * understand a knob without leaving the panel.
 *
 * Behaviour:
 *  - Opens on hover (desktop) AND on click/tap (mobile/touch).
 *  - Keyboard: focus the ⓘ, Enter/Space toggles, Esc closes (and the trigger
 *    keeps focus). The button is in the tab order and `aria-describedby` links
 *    it to the popover so screen readers announce the explanation.
 *  - Dismisses on outside click/blur (pointerdown anywhere else, or focus
 *    leaving the widget).
 *  - Positions itself so it doesn't overflow the panel/screen edge: it renders
 *    below by default, flips above when there's no room, and nudges left/right
 *    to stay on-screen.
 *
 * Content is rendered through t() so each title/body is translatable, with the
 * English EXPLAINERS entry as the fallback.
 */
export function InfoTip({ topic, title, body, className }: InfoTipProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Hover and focus/click are tracked separately so a hover-out doesn't close a
  // popover the user opened by clicking (and vice-versa).
  const hoverOpen = useRef(false)
  const pinnedOpen = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const popId = useId()

  // Vertical/horizontal placement flags, recomputed when the popover opens.
  const [placeAbove, setPlaceAbove] = useState(false)
  const [shiftX, setShiftX] = useState(0)

  const fallback = EXPLAINERS[topic]
  const headingText = title ?? t(`explain.${topic}.title`, fallback?.title ?? topic)
  const bodyText = body ?? t(`explain.${topic}.body`, fallback?.body ?? '')

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
  }

  const sync = useCallback(() => {
    setOpen(hoverOpen.current || pinnedOpen.current)
  }, [])

  const openHover = () => {
    clearCloseTimer()
    hoverOpen.current = true
    sync()
  }
  // Small grace period so moving the pointer from the icon into the popover
  // (or vice-versa) doesn't flicker it shut.
  const closeHoverSoon = () => {
    clearCloseTimer()
    closeTimer.current = setTimeout(() => {
      hoverOpen.current = false
      sync()
    }, 120)
  }

  const togglePinned = () => {
    pinnedOpen.current = !pinnedOpen.current
    sync()
  }

  const closeAll = useCallback(() => {
    clearCloseTimer()
    hoverOpen.current = false
    pinnedOpen.current = false
    setOpen(false)
  }, [])

  // Dismiss on outside pointerdown / Escape, while open.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closeAll()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeAll()
        btnRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, closeAll])

  // Position so the popover stays inside the viewport: flip above if it would
  // overflow the bottom, and shift horizontally so it doesn't clip an edge.
  useLayoutEffect(() => {
    if (!open) return
    const btn = btnRef.current
    const pop = popRef.current
    if (!btn || !pop) return
    const margin = 8
    const br = btn.getBoundingClientRect()
    const pr = pop.getBoundingClientRect()
    const spaceBelow = window.innerHeight - br.bottom
    const above = spaceBelow < pr.height + margin && br.top > spaceBelow
    setPlaceAbove(above)

    // The popover is centred on the icon (translateX(-50%)); compute how far it
    // would overflow either edge and shift it back on-screen.
    const center = br.left + br.width / 2
    const half = pr.width / 2
    let dx = 0
    if (center - half < margin) dx = margin - (center - half)
    else if (center + half > window.innerWidth - margin)
      dx = window.innerWidth - margin - (center + half)
    setShiftX(dx)
  }, [open])

  return (
    <span
      ref={rootRef}
      className={`infotip${className ? ' ' + className : ''}`}
      onMouseEnter={openHover}
      onMouseLeave={closeHoverSoon}
      onFocus={openHover}
      onBlur={(e) => {
        // Close once focus leaves the whole widget (icon + popover).
        if (!rootRef.current?.contains(e.relatedTarget as Node)) closeAll()
      }}
    >
      <button
        ref={btnRef}
        type="button"
        className="infotip-btn"
        aria-label={t('infotip.aria', 'What is “{title}”?', { title: headingText })}
        aria-expanded={open}
        aria-describedby={open ? popId : undefined}
        onClick={togglePinned}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            togglePinned()
          }
        }}
      >
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="4.6" r="0.95" fill="currentColor" />
          <rect x="7.2" y="6.7" width="1.6" height="5" rx="0.8" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          id={popId}
          role="tooltip"
          className={`infotip-pop${placeAbove ? ' above' : ''}`}
          style={{ ['--infotip-shift' as string]: `${shiftX}px` }}
          onMouseEnter={openHover}
          onMouseLeave={closeHoverSoon}
        >
          <div className="infotip-title">{headingText}</div>
          <div className="infotip-body">{bodyText}</div>
        </div>
      )}
    </span>
  )
}
