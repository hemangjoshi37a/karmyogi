import { useEffect, useRef } from 'react'
import type { ShapeKind } from '../store/viewportShapes'
import { useT } from '../i18n'

/**
 * Right-click context menu for the 3D viewport. Lists the primitive shapes the
 * user can drop onto the bed plane. Purely presentational + positioned at the
 * click point in viewport-local (CSS pixel) coordinates; the Viewer owns the
 * open/close state and the add-shape action.
 *
 * Self-contained styles (no shared CSS files, which other agents own). The menu
 * clamps itself inside the viewport so it never overflows on a narrow screen.
 */

export interface ShapeMenuItem {
  kind: ShapeKind
  /** i18n key for the label. */
  key: string
  /** English fallback label. */
  label: string
  glyph: string
}

const ITEMS: ShapeMenuItem[] = [
  { kind: 'circle', key: 'vp.menu.circle', label: 'Circle', glyph: '○' },
  { kind: 'rectangle', key: 'vp.menu.rectangle', label: 'Rectangle', glyph: '▭' },
  { kind: 'triangle', key: 'vp.menu.triangle', label: 'Triangle', glyph: '△' },
  { kind: 'line', key: 'vp.menu.line', label: 'Line', glyph: '╱' },
]

export interface ShapeContextMenuProps {
  /** Local x/y (CSS px) within the viewport stage where the menu opens. */
  x: number
  y: number
  /** Container width/height (CSS px) used to clamp the menu inside the viewport. */
  containerW: number
  containerH: number
  onPick: (kind: ShapeKind) => void
  onClose: () => void
}

const MENU_W = 168
const MENU_ITEM_H = 34
const MENU_PAD = 12

export function ShapeContextMenu({
  x,
  y,
  containerW,
  containerH,
  onPick,
  onClose,
}: ShapeContextMenuProps) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const menuH = ITEMS.length * MENU_ITEM_H + 2 * 6 + 22
  const left = Math.max(4, Math.min(x, containerW - MENU_W - 4))
  const top = Math.max(4, Math.min(y, containerH - menuH - 4))

  return (
    <>
      <style>{MENU_CSS}</style>
      <div
        ref={ref}
        className="vshape-menu"
        role="menu"
        style={{ left, top, width: MENU_W }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="vshape-menu-title">{t('vp.menu.title', 'Add shape')}</div>
        {ITEMS.map((it) => (
          <button
            key={it.kind}
            className="vshape-menu-item"
            role="menuitem"
            onClick={() => onPick(it.kind)}
          >
            <span className="vshape-menu-glyph" aria-hidden="true">
              {it.glyph}
            </span>
            <span>{t(it.key, it.label)}</span>
          </button>
        ))}
      </div>
    </>
  )
}

void MENU_PAD

const MENU_CSS = `
.vshape-menu {
  position: absolute;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 96%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.32);
  user-select: none;
}
.vshape-menu-title {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--fg-muted);
  padding: 2px 8px 4px;
}
.vshape-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.vshape-menu-item:hover {
  background: color-mix(in srgb, var(--accent, var(--fg-muted)) 22%, transparent);
}
.vshape-menu-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  font-size: 16px;
  color: var(--accent, var(--fg));
}
@media (pointer: coarse), (max-width: 768px) {
  .vshape-menu-item { height: 42px; font-size: 15px; }
  .vshape-menu-glyph { width: 22px; font-size: 19px; }
}
`
