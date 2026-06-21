// Per-file feature PREVIEW — the loop-picker SVG shown inside an expanded model
// card in the CAD/CAM panel.
// ----------------------------------------------------------------------------
// This is a thin, presentational React component: all CAM logic lives in the
// pure core (`core/featureCam.ts`) and the parent panel. It renders the file's
// flattened loops as a clickable SVG (left-click selects a loop; RIGHT-CLICK
// opens a quick-add menu to drop a preset onto that loop's operations). Loops
// are keyed by `${fileId}#${loopIndex}` so loops from different files never
// collide. The card title (in the panel) is the expand/collapse disclosure, so
// this component no longer carries its own collapsible header.

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Polyline } from '../../core/geometry'
import {
  featureKey,
  type DrawingFeature,
  type FeatureOpMap,
  type FeaturePreset,
} from '../../core/featureCam'
import { ProfileSide } from '../../core/cam'
import { InfoTip } from '../InfoTip'
import { useT } from '../../i18n'
import '../../styles/featureViewer.css'

interface Props {
  /** Stable id of the file these loops belong to (composite-key prefix). */
  fileId: string
  polylines: Polyline[]
  features: DrawingFeature[]
  opMap: FeatureOpMap
  /** The editable preset palette (for the right-click quick-add menu). */
  presets: FeaturePreset[]
  /** Quick-add a preset onto a loop's operations (composite loop key). */
  onQuickAdd: (key: string, preset: FeaturePreset) => void
  /** Selected loop, as a composite `${fileId}#${loopIndex}` key (or null). */
  selected: string | null
  setSelected: (key: string | null) => void
  t: ReturnType<typeof useT>
}

/** Compute the SVG viewBox + a flip transform (CAD Y-up → SVG Y-down). */
function computeViewBox(polylines: Polyline[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const pl of polylines)
    for (const p of pl.points) {
      if (p.x < minX) minX = p.x
      if (p.y < minY) minY = p.y
      if (p.x > maxX) maxX = p.x
      if (p.y > maxY) maxY = p.y
    }
  if (!isFinite(minX)) return null
  const w = Math.max(maxX - minX, 1e-3)
  const h = Math.max(maxY - minY, 1e-3)
  const pad = Math.max(w, h) * 0.06
  return { minX, minY, w, h, pad, maxY }
}

/** Build an SVG path "d" for a polyline (flipping Y so the drawing is upright). */
function pathFor(pl: Polyline, flipY: number): string {
  if (pl.points.length === 0) return ''
  const seg = pl.points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(3)} ${(flipY - p.y).toFixed(3)}`)
    .join(' ')
  return pl.closed && pl.points.length >= 3 ? `${seg} Z` : seg
}

export function FeatureViewer({
  fileId,
  polylines,
  features,
  opMap,
  presets,
  onQuickAdd,
  selected,
  setSelected,
  t,
}: Props) {
  const vb = computeViewBox(polylines)
  // Right-click quick-add menu state: which loop + where (VIEWPORT px — the menu
  // is portaled to <body> so it floats above all panel UI and is never clipped
  // by a scrolling section's overflow or out-stacked by a sibling card).
  const [menu, setMenu] = useState<{ loop: number; x: number; y: number } | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close the quick-add menu on any outside click / Escape. The menu lives in a
  // body portal, so "outside" must also exclude the menu itself (else the very
  // pointerdown that lands on a menu item would close it before the click fires).
  useEffect(() => {
    if (!menu) return
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (!bodyRef.current?.contains(target) && !menuRef.current?.contains(target)) setMenu(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [menu])

  function openMenuFor(loopIndex: number, e: React.MouseEvent) {
    e.preventDefault()
    setSelected(featureKey(fileId, loopIndex))
    // Viewport coords — the menu is fixed-positioned in a body portal, and
    // lightly clamped so it never spills off the right/bottom edge.
    const mw = 220
    const mh = 40 + presets.length * 30
    const x = Math.min(e.clientX, window.innerWidth - mw - 8)
    const y = Math.min(e.clientY, window.innerHeight - mh - 8)
    setMenu({ loop: loopIndex, x: Math.max(8, x), y: Math.max(8, y) })
  }

  if (features.length === 0) return null

  const menuFeature = menu != null ? features.find((f) => f.index === menu.loop) ?? null : null

  return (
    <div className="fv-body" ref={bodyRef}>
      {/* ── Help affordance (U7): a small ⓘ hover-tip in the UPPER-LEFT corner
          of the preview, replacing the old permanent explainer/stat lines. ── */}
      <span className="fv-help">
        <InfoTip
          topic="cc.fvHelp"
          title={t('fv.title', 'Preview')}
          body={t(
            'fv.helpBody',
            'Click a loop to select it. Right-click a loop (or use the table below) to add a preset operation. Leave all loops empty to use the whole-file operation.',
          )}
        />
      </span>

      {/* ── Clickable mini drawing ────────────────────────────────── */}
      {vb && (
        <svg
          className="fv-svg"
          viewBox={`${vb.minX - vb.pad} ${vb.minY - vb.pad} ${vb.w + vb.pad * 2} ${vb.h + vb.pad * 2}`}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          aria-label={t('fv.svgAria', 'Drawing loops — click to select, right-click to add a preset')}
        >
          {features.map((f) => {
            const pl = polylines[f.index]
            if (!pl) return null
            const key = featureKey(fileId, f.index)
            const isSel = key === selected
            const ops = opMap[key]
            const hasOps = (ops?.length ?? 0) > 0
            // Color a loop by its FIRST op (the assigned preset color);
            // otherwise the loop's own identity color.
            const stroke = ops && ops.length > 0 ? ops[0].color : f.color
            return (
              <path
                key={f.index}
                className={'fv-loop' + (isSel ? ' sel' : '') + (hasOps ? ' has-ops' : '')}
                d={pathFor(pl, vb.minY + vb.maxY)}
                stroke={stroke}
                fill={f.closed && (isSel || hasOps) ? stroke : 'none'}
                fillOpacity={f.closed && (isSel || hasOps) ? 0.14 : 0}
                vectorEffect="non-scaling-stroke"
                onClick={() => setSelected(isSel ? null : key)}
                onContextMenu={(e) => openMenuFor(f.index, e)}
              >
                <title>
                  {t('fv.loopTitle', 'Loop {n} — {kind}', {
                    n: f.index + 1,
                    kind: f.closed ? t('fv.closed', 'closed loop') : t('fv.open', 'open path'),
                  })}
                </title>
              </path>
            )
          })}
        </svg>
      )}

      {/* ── Loop chips (also pickable; mirror the SVG selection) ────── */}
      <div className="fv-chips" role="listbox" aria-label={t('fv.featuresAria', 'Loops')}>
        {features.map((f) => {
          const key = featureKey(fileId, f.index)
          const ops = opMap[key]
          const isSel = key === selected
          return (
            <button
              key={f.index}
              type="button"
              role="option"
              aria-selected={isSel}
              className={'fv-chip' + (isSel ? ' sel' : '')}
              onClick={() => setSelected(isSel ? null : key)}
              onContextMenu={(e) => openMenuFor(f.index, e)}
              title={f.closed ? t('fv.closed', 'closed loop') : t('fv.open', 'open path')}
            >
              <span
                className="fv-chip-dot"
                style={{ background: ops && ops.length ? ops[0].color : f.color }}
              />
              <span className="fv-chip-lbl">#{f.index + 1}</span>
              {ops && ops.length > 0 && <span className="fv-chip-badge">{ops.length}</span>}
            </button>
          )
        })}
      </div>

      {/* ── Right-click quick-add menu (portaled to <body> so it floats above
            all panel UI and can't be clipped/covered) ─────────────────── */}
      {menu && menuFeature && createPortal(
        <div
          ref={menuRef}
          className="fv-menu"
          style={{ position: 'fixed', left: menu.x, top: menu.y, zIndex: 1000 }}
          role="menu"
          aria-label={t('fv.quickAdd', 'Add preset to loop')}
        >
          <div className="fv-menu-head">
            {t('fv.addToLoop', 'Add to Loop {n}', { n: menu.loop + 1 })}
          </div>
          {presets.map((p) => {
            const incompatible = p.op !== 'Engrave' && p.side !== ProfileSide.On && !menuFeature.closed
            return (
              <button
                key={p.id}
                type="button"
                role="menuitem"
                className="fv-menu-item"
                disabled={incompatible}
                onClick={() => {
                  onQuickAdd(featureKey(fileId, menu.loop), p)
                  setMenu(null)
                }}
                title={
                  incompatible
                    ? t('fv.needClosed', '{name} needs a closed loop', { name: p.name })
                    : t('fv.addPreset', 'Add “{name}” to this loop', { name: p.name })
                }
              >
                <span className="fv-menu-sw" style={{ background: p.color }} />
                <span className="fv-menu-lbl">{p.name}</span>
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </div>
  )
}
