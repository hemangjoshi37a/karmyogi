import { useMemo, useRef, useState } from 'react'
import { Viewer, type ViewerHandle } from '../viewer/Viewer'
import { gcodeToPolylines } from '../viewer/gcodeToPolylines'
import { useProgram, useMachine } from '../store'
import { useBed } from '../store/bed'

/**
 * Visualizer panel: hosts the 3D viewport and feeds it the loaded G-code program
 * (from the program store) and the live tool position (from the machine store).
 * A small toolbar exposes W3's imperative fit/iso/top/front view controls plus a
 * compact bed-size editor, and a corner overlay reports the loaded program's
 * size and bed-fit status.
 *
 * Coordinate model: the drawn bed grid (drei <Grid>) is CENTERED on the work
 * origin, so it spans [-W/2..+W/2] x [-D/2..+D/2]. The fit-check below uses that
 * SAME centered rectangle, so "fits / outside / exceeds" always matches the grid
 * the user sees. The bed size comes from the persisted bed store so the grid,
 * bounds box, and fit-check all react live to edits.
 */

export function VisualizerPanel() {
  const ref = useRef<ViewerHandle>(null)
  const lines = useProgram((s) => s.lines)
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)

  const gcode = useMemo(() => lines.join('\n'), [lines])
  const toolPosition: [number, number, number] | null = connected
    ? [wpos.x, wpos.y, wpos.z]
    : null

  // Bounding box of the loaded program (mm). The viewer scene is always mm
  // (the emitter outputs G21), so we report mm regardless of UI unit setting.
  const dims = useMemo(() => {
    if (!gcode || gcode.trim() === '') return null
    const { bounds } = gcodeToPolylines(gcode)
    if (!bounds) return null
    const w = bounds.max[0] - bounds.min[0]
    const h = bounds.max[1] - bounds.min[1]
    const d = bounds.max[2] - bounds.min[2]
    if (!isFinite(w) || !isFinite(h) || !isFinite(d)) return null

    // Fit check vs the machine work area. The grid is drawn CENTERED on the
    // work origin, so the usable area is [-W/2..+W/2] x [-D/2..+D/2]. A program
    // bigger than W x D is "oversized"; one whose bbox pokes past the centered
    // rectangle edges is "off bed". This matches exactly what the user sees.
    const halfW = bedW / 2
    const halfD = bedD / 2
    const oversized = w > bedW || h > bedD
    const offBed =
      bounds.min[0] < -halfW ||
      bounds.min[1] < -halfD ||
      bounds.max[0] > halfW ||
      bounds.max[1] > halfD
    const fit: 'ok' | 'warn' | 'danger' = oversized
      ? 'danger'
      : offBed
        ? 'warn'
        : 'ok'

    return {
      w,
      h,
      d,
      min: bounds.min,
      max: bounds.max,
      area: w * h, // mm²
      fit,
      offBed,
      oversized,
    }
  }, [gcode, bedW, bedD])

  return (
    <div style={{ height: '100%', width: '100%', position: 'relative' }}>
      <style>{OVERLAY_CSS}</style>
      <div className="vz-toolbar">
        <button
          className="vz-toolbar-btn"
          onClick={() => ref.current?.fit()}
          title="Fit to toolpath"
          aria-label="Fit to toolpath"
        >
          ⤢
        </button>
        <button
          className="vz-toolbar-btn"
          onClick={() => ref.current?.setView('iso')}
          title="Isometric view"
          aria-label="Isometric view"
        >
          ⧉
        </button>
        <button
          className="vz-toolbar-btn"
          onClick={() => ref.current?.setView('top')}
          title="Top view"
          aria-label="Top view"
        >
          ▣
        </button>
        <button
          className="vz-toolbar-btn"
          onClick={() => ref.current?.setView('front')}
          title="Front view"
          aria-label="Front view"
        >
          ▭
        </button>
        <BedSizeControl />
      </div>
      <Viewer
        ref={ref}
        gcode={gcode}
        toolPosition={toolPosition}
        bedWidth={bedW}
        bedDepth={bedD}
        bedHeight={bedH}
      />
      <DimensionsOverlay dims={dims} bedW={bedW} bedD={bedD} />
    </div>
  )
}

/**
 * Tiny bed-size editor: an icon button in the view toolbar that toggles a
 * compact popover with three axis-coloured number inputs (X/Y/Z, mm). Edits go
 * straight to the persisted bed store, so the grid + bounds box + fit-check all
 * update live.
 */
function BedSizeControl() {
  const [open, setOpen] = useState(false)
  const width = useBed((s) => s.width)
  const depth = useBed((s) => s.depth)
  const height = useBed((s) => s.height)
  const setWidth = useBed((s) => s.setWidth)
  const setDepth = useBed((s) => s.setDepth)
  const setHeight = useBed((s) => s.setHeight)

  return (
    <div className="vz-bed-wrap">
      <button
        className="vz-toolbar-btn"
        onClick={() => setOpen((o) => !o)}
        title="Bed size (work area)"
        aria-label="Bed size"
        aria-expanded={open}
      >
        📐
      </button>
      {open && (
        <div className="vz-bed-pop" role="dialog" aria-label="Bed size (mm)">
          <BedField
            label="X"
            color="#ef4444"
            value={width}
            onChange={setWidth}
            title="Work area width — X axis (mm)"
          />
          <BedField
            label="Y"
            color="#22c55e"
            value={depth}
            onChange={setDepth}
            title="Work area depth — Y axis (mm)"
          />
          <BedField
            label="Z"
            color="#3b82f6"
            value={height}
            onChange={setHeight}
            title="Work area height — Z axis (mm)"
          />
        </div>
      )}
    </div>
  )
}

function BedField({
  label,
  color,
  value,
  onChange,
  title,
}: {
  label: string
  color: string
  value: number
  onChange: (v: number) => void
  title: string
}) {
  return (
    <label className="vz-bed-field" title={title}>
      <span className="vz-bed-axis" style={{ color }}>
        {label}
      </span>
      <input
        type="number"
        className="vz-bed-input"
        value={value}
        min={1}
        step={1}
        onChange={(e) => {
          const v = e.target.valueAsNumber
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </label>
  )
}

interface Dims {
  w: number
  h: number
  d: number
  min: [number, number, number]
  max: [number, number, number]
  area: number
  fit: 'ok' | 'warn' | 'danger'
  offBed: boolean
  oversized: boolean
}

/** Format a length in mm with at most 1 decimal, trimming trailing zeros. */
function mm(v: number): string {
  return (Math.round(v * 10) / 10).toString()
}

/** Area in cm² (>=1cm²) or mm², human-friendly. */
function fmtArea(mm2: number): string {
  if (mm2 >= 100) return `${(Math.round((mm2 / 100) * 10) / 10).toString()} cm²`
  return `${Math.round(mm2)} mm²`
}

/** Compact bottom-left overlay reporting program size + bed-fit status. */
function DimensionsOverlay({
  dims,
  bedW,
  bedD,
}: {
  dims: Dims | null
  bedW: number
  bedD: number
}) {
  if (!dims) {
    return (
      <div className="vz-dims" data-empty="true" aria-hidden="true">
        <span className="vz-dims-dash">—</span>
      </div>
    )
  }

  const bedLabel = `${mm(bedW)}×${mm(bedD)}`
  const fitLabel =
    dims.fit === 'danger'
      ? `exceeds bed ${bedLabel}`
      : dims.fit === 'warn'
        ? `outside bed ${bedLabel}`
        : `fits bed ${bedLabel}`

  return (
    <div className="vz-dims" role="status" aria-label="Program dimensions">
      <div
        className="vz-dims-row vz-dims-size"
        title="Width (X) × Depth (Y) of the loaded program's bounding box, in mm"
      >
        <span className="vz-dims-val">{mm(dims.w)}</span>
        <span className="vz-dims-x">×</span>
        <span className="vz-dims-val">{mm(dims.h)}</span>
        <span className="vz-dims-unit">mm</span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title="Z range (top→bottom) and total cut depth, in mm"
      >
        <span>Z {mm(dims.min[2])}…{mm(dims.max[2])} ({mm(dims.d)})</span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title="Footprint area covered by the toolpath"
      >
        <span>{fmtArea(dims.area)}</span>
      </div>
      <div
        className="vz-dims-row vz-dims-fit"
        data-fit={dims.fit}
        title={`Whether the program fits within the machine work area (bed ${bedLabel} mm)`}
      >
        <span className="vz-dims-dot" data-fit={dims.fit} />
        <span>{fitLabel}</span>
      </div>
    </div>
  )
}

// Inline (panel-local) styles — globals.css is owned by another agent.
// Theme-aware via CSS vars. The view toolbar lives top-right (icon buttons);
// the dimensions overlay lives bottom-left so the two never collide.
// Touch-friendly sizing on coarse pointers.
const OVERLAY_CSS = `
.vz-toolbar {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  gap: 4px;
  pointer-events: auto;
}
.vz-toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  color: var(--fg);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
}
.vz-toolbar-btn:hover {
  background: color-mix(in srgb, var(--bg-elev) 95%, transparent);
  border-color: var(--accent, var(--fg-muted));
}
.vz-toolbar-btn:active {
  transform: translateY(1px);
}
.vz-toolbar-btn[aria-expanded='true'] {
  border-color: var(--accent, var(--fg-muted));
  background: color-mix(in srgb, var(--bg-elev) 95%, transparent);
}
.vz-bed-wrap { position: relative; display: inline-flex; }
.vz-bed-pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 7px 8px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 94%, transparent);
  backdrop-filter: blur(6px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
}
.vz-bed-field {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
}
.vz-bed-axis {
  width: 12px;
  text-align: center;
  font-weight: 700;
  font-size: 11px;
  flex: 0 0 auto;
}
.vz-bed-input {
  width: 64px;
  max-width: 64px;
  height: 24px;
  padding: 1px 5px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--fg);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.vz-bed-input:focus {
  outline: none;
  border-color: var(--accent, var(--fg-muted));
}
.vz-dims {
  position: absolute;
  left: 8px;
  bottom: 8px;
  z-index: 2;
  pointer-events: auto;
  user-select: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 9px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  color: var(--fg);
  font-size: 11px;
  line-height: 1.3;
  max-width: min(60%, 240px);
}
.vz-dims[data-empty='true'] {
  color: var(--fg-muted);
  font-size: 13px;
  padding: 4px 8px;
}
.vz-dims-row { display: flex; align-items: baseline; gap: 4px; white-space: nowrap; }
.vz-dims-size { font-size: 14px; font-weight: 600; letter-spacing: 0.2px; }
.vz-dims-x { color: var(--fg-muted); font-weight: 400; }
.vz-dims-unit { color: var(--fg-muted); font-size: 10px; font-weight: 400; }
.vz-dims-meta { color: var(--fg-muted); font-size: 10px; }
.vz-dims-fit { font-size: 10px; align-items: center; }
.vz-dims-fit[data-fit='ok'] { color: var(--fg-muted); }
.vz-dims-fit[data-fit='warn'] { color: var(--warn); font-weight: 600; }
.vz-dims-fit[data-fit='danger'] { color: var(--danger); font-weight: 600; }
.vz-dims-dot {
  width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
  display: inline-block;
}
.vz-dims-dot[data-fit='ok'] { background: var(--ok); }
.vz-dims-dot[data-fit='warn'] { background: var(--warn); }
.vz-dims-dot[data-fit='danger'] { background: var(--danger); }

@media (pointer: coarse), (max-width: 768px) {
  .vz-toolbar { gap: 6px; }
  .vz-toolbar-btn { width: 36px; height: 36px; font-size: 18px; }
  .vz-bed-field { gap: 8px; font-size: 13px; }
  .vz-bed-axis { width: 14px; font-size: 13px; }
  .vz-bed-input { height: 36px; font-size: 14px; }
  .vz-dims { font-size: 12px; padding: 8px 11px; gap: 3px; }
  .vz-dims-size { font-size: 16px; }
  .vz-dims-meta, .vz-dims-fit, .vz-dims-unit, .vz-dims-x { font-size: 11px; }
}
`
