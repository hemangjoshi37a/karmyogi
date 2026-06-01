import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  computeWindow,
  listHeight,
  rowOffset,
  needsScrollIntoView,
} from './programWindow'

const ROW_H = 18 // px; keep in sync with .pp-row in program.css

interface Props {
  lines: string[]
  /** Index of the line currently streaming (-1 idle). */
  cursor: number
  /** Currently user-selected line (for feed-from-line), or -1. */
  selected: number
  onSelect: (index: number) => void
}

/**
 * Scrollable, windowed (virtualized) G-code line list. Only renders the rows
 * inside the viewport (+ overscan) so 100k-line programs stay smooth.
 * Highlights the streaming cursor and the user selection, and auto-scrolls to
 * keep the cursor visible while streaming.
 */
export function ProgramList({ lines, cursor, selected, onSelect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(0)

  const total = lines.length
  // Fall back to a sensible height before the viewport is measured (e.g. first
  // mount, or a docked panel that was just revealed) so loaded lines always
  // render instead of showing a blank list until the ResizeObserver fires.
  const effViewportH = viewportH > 0 ? viewportH : 600
  const win = computeWindow(scrollTop, effViewportH, ROW_H, total)

  // Measure viewport height (and on resize).
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Auto-scroll to keep the streaming cursor in view.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || cursor < 0) return
    if (needsScrollIntoView(cursor, computeWindow(el.scrollTop, el.clientHeight, ROW_H, total))) {
      // Center the cursor row in the viewport.
      const target = rowOffset(cursor, ROW_H) - el.clientHeight / 2 + ROW_H / 2
      el.scrollTop = Math.max(0, target)
    }
  }, [cursor, total])

  const rows: React.ReactNode[] = []
  for (let i = win.start; i < win.end; i++) {
    const isCursor = i === cursor
    const isSelected = i === selected
    const cls =
      'pp-row' + (isCursor ? ' pp-row-cursor' : '') + (isSelected ? ' pp-row-selected' : '')
    rows.push(
      <div
        key={i}
        className={cls}
        style={{ top: rowOffset(i, ROW_H), height: ROW_H }}
        onClick={() => onSelect(i)}
        title="Click to select (feed-from-line start)"
      >
        <span className="pp-ln">{i + 1}</span>
        <span className="pp-code">{lines[i] || ' '}</span>
      </div>,
    )
  }

  return (
    <div
      ref={scrollRef}
      className="pp-list"
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      {total === 0 ? (
        <div className="pp-empty">No program loaded. Load a .nc / .gcode file to begin.</div>
      ) : (
        <div className="pp-list-inner" style={{ height: listHeight(total, ROW_H) }}>
          {rows}
        </div>
      )}
    </div>
  )
}
