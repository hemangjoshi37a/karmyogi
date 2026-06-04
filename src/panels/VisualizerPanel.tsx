import { useEffect, useMemo, useRef, useState } from 'react'
import { Viewer, type ViewerHandle } from '../viewer/Viewer'
import { gcodeToPolylines, type Segment } from '../viewer/gcodeToPolylines'
import { useProgram, useMachine, useCameraCalib } from '../store'
import { useBed } from '../store/bed'
import { buildTimeline } from '../core/simulation'
import { usePlayback } from '../store/playback'
import { PlaybackTimeline } from '../components/PlaybackTimeline'
import { useT } from '../i18n'
import type { Placement } from '../core/transform'

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
  const t = useT()
  const ref = useRef<ViewerHandle>(null)
  const lines = useProgram((s) => s.lines)
  const wpos = useMachine((s) => s.wpos)
  const connected = useMachine((s) => s.connection === 'connected')

  const bedW = useBed((s) => s.width)
  const bedD = useBed((s) => s.depth)
  const bedH = useBed((s) => s.height)

  const [showStock, setShowStock] = useState(true)
  // Independent show/hide for the two spindle cones (actual machine vs simulation).
  const [showActualTool, setShowActualTool] = useState(true)
  const [showSimTool, setShowSimTool] = useState(true)
  // Material-removal simulation: progressively carve the stock surface as the
  // toolpath reveals. On by default so the operator sees stock → finished part.
  const [carveSim, setCarveSim] = useState(true)

  // Live camera → 3D bed overlay (persisted in the camera-calib store, so the
  // toggle survives refresh). The overlay components self-gate on `enabled`.
  const camOverlay = useCameraCalib((s) => s.enabled)
  const toggleCamOverlay = useCameraCalib((s) => s.toggleEnabled)

  // Placement gizmo: toggle the in-scene move/rotate/scale handles.
  const [gizmoOn, setGizmoOn] = useState(false)
  const [gizmoMode, setGizmoMode] = useState<'translate' | 'rotate' | 'scale'>(
    'translate',
  )
  const placement = useProgram((s) => s.placement)
  const hasProgram = lines.some((l) => l.trim() !== '')

  const gcode = useMemo(() => lines.join('\n'), [lines])

  // Cutter radius for the material-removal sim. Read from the persisted carve
  // tool diameter (set in the 3D Carving panel); recomputed when the program
  // changes so a freshly generated job uses its own bit size. Falls back to a
  // sane default when nothing has been configured yet.
  const toolRadius = useMemo(() => {
    const read = (key: string, field: string): number | null => {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return null
        const v = JSON.parse(raw)?.[field]
        return typeof v === 'number' && v > 0 ? v : null
      } catch {
        return null
      }
    }
    const dia =
      read('karmyogi.carve.3d', 'toolDiameter') ??
      read('karmyogi.carve.2d', 'diameter') ??
      3.175
    return Math.max(0.1, dia / 2)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gcode])

  // Build a time-parameterised simulation timeline from the loaded program and
  // install it in the playback store. Rebuilds only when the gcode text changes.
  const timeline = useMemo(
    () => (gcode.trim() !== '' ? buildTimeline(gcode) : null),
    [gcode],
  )
  useEffect(() => {
    usePlayback.getState().setTimeline(timeline)
  }, [timeline])

  // The DRAWN geometry must equal the SIMULATED geometry so reveal indices line
  // up exactly: feed the Viewer the timeline's segments (same {from,to,kind}
  // shape). Memoized on `timeline` only — NOT on the 60fps playhead time.
  const simSegments: Segment[] | undefined = useMemo(() => {
    if (!timeline) return undefined
    return timeline.segments.map((s) => ({
      from: s.from,
      to: s.to,
      kind: s.kind,
    }))
  }, [timeline])

  // Subscribe to the playhead. Recomputing only the marker + reveal (cheap) on
  // each tick keeps the heavy geometry stable.
  const time = usePlayback((s) => s.time)
  const isPlaying = usePlayback((s) => s.isPlaying)
  const pbTimeline = usePlayback((s) => s.timeline)

  const simActive = !!pbTimeline && pbTimeline.duration > 0
  const simulating = simActive && (isPlaying || time > 0)

  // Actual (live machine) cone — ALWAYS follows the controller when connected,
  // independent of the simulation, so streaming a program shows real motion in
  // the 3D view. (Previously the single marker switched to the sim once scrubbed,
  // which hid live streaming — that regression is fixed by drawing both cones.)
  const actualPosition: [number, number, number] | null = connected
    ? [wpos.x, wpos.y, wpos.z]
    : null
  // Simulation cone + progressive path reveal — driven by the playback timeline
  // while the user plays or scrubs the preview.
  let simPosition: [number, number, number] | null = null
  let revealIndex: number | undefined
  let revealPoint: [number, number, number] | null = null
  if (simulating && pbTimeline) {
    simPosition = pbTimeline.positionAt(time)
    revealIndex = pbTimeline.activeIndexAt(time)
    revealPoint = simPosition
  }

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
    <div className="vz-root">
      <style>{OVERLAY_CSS}</style>
      <div className="vz-stage">
        <div className="vz-toolbar">
          <button
            className="vz-toolbar-btn"
            onClick={() => ref.current?.fit()}
            title={t('vz.fit', 'Fit to toolpath')}
            aria-label={t('vz.fit', 'Fit to toolpath')}
          >
            ⤢
          </button>
          <button
            className="vz-toolbar-btn"
            onClick={() => ref.current?.setView('iso')}
            title={t('vz.iso', 'Isometric view')}
            aria-label={t('vz.iso', 'Isometric view')}
          >
            ⧉
          </button>
          <button
            className="vz-toolbar-btn"
            onClick={() => ref.current?.setView('top')}
            title={t('vz.top', 'Top view')}
            aria-label={t('vz.top', 'Top view')}
          >
            ▣
          </button>
          <button
            className="vz-toolbar-btn"
            onClick={() => ref.current?.setView('front')}
            title={t('vz.front', 'Front view')}
            aria-label={t('vz.front', 'Front view')}
          >
            ▭
          </button>
          <button
            className={
              showStock ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={() => setShowStock((s) => !s)}
            title={t('vz.showStock', 'Show stock')}
            aria-label={t('vz.showStock', 'Show stock')}
            aria-pressed={showStock}
          >
            📦
          </button>
          <button
            className={
              carveSim ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={() => setCarveSim((s) => !s)}
            title={t(
              'vz.carveSim',
              'Material removal simulation (carve the stock as it runs)',
            )}
            aria-label={t('vz.carveSim', 'Material removal simulation')}
            aria-pressed={carveSim}
          >
            🪵
          </button>
          <button
            className={
              showActualTool ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={() => setShowActualTool((s) => !s)}
            title={t('vz.showActualTool', 'Show actual machine tool (live)')}
            aria-label={t('vz.showActualTool', 'Show actual machine tool (live)')}
            aria-pressed={showActualTool}
          >
            <span style={{ color: '#f59e0b' }}>▼</span>
          </button>
          <button
            className={
              showSimTool ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={() => setShowSimTool((s) => !s)}
            title={t('vz.showSimTool', 'Show simulation tool')}
            aria-label={t('vz.showSimTool', 'Show simulation tool')}
            aria-pressed={showSimTool}
          >
            <span style={{ color: '#22d3ee' }}>▼</span>
          </button>
          <BedSizeControl />
          <button
            className={
              camOverlay ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={toggleCamOverlay}
            title={t('vz.cameraOverlay', 'Show live camera 3D (bed + job from the Camera panel)')}
            aria-label={t('vz.cameraOverlay', 'Show live camera 3D')}
            aria-pressed={camOverlay}
          >
            📷
          </button>
          <span className="vz-toolbar-sep" aria-hidden="true" />
          <button
            className={
              gizmoOn ? 'vz-toolbar-btn vz-toolbar-btn--on' : 'vz-toolbar-btn'
            }
            onClick={() => setGizmoOn((g) => !g)}
            disabled={!hasProgram}
            title={t('vz.place', 'Place job (move / rotate / scale)')}
            aria-label={t('vz.place', 'Place job')}
            aria-pressed={gizmoOn}
          >
            ✛
          </button>
          {gizmoOn && (
            <>
              <button
                className={
                  gizmoMode === 'translate'
                    ? 'vz-toolbar-btn vz-toolbar-btn--on'
                    : 'vz-toolbar-btn'
                }
                onClick={() => setGizmoMode('translate')}
                title={t('vz.move', 'Move')}
                aria-label={t('vz.move', 'Move')}
                aria-pressed={gizmoMode === 'translate'}
              >
                ↔
              </button>
              <button
                className={
                  gizmoMode === 'rotate'
                    ? 'vz-toolbar-btn vz-toolbar-btn--on'
                    : 'vz-toolbar-btn'
                }
                onClick={() => setGizmoMode('rotate')}
                title={t('vz.rotate', 'Rotate')}
                aria-label={t('vz.rotate', 'Rotate')}
                aria-pressed={gizmoMode === 'rotate'}
              >
                ⟲
              </button>
              <button
                className={
                  gizmoMode === 'scale'
                    ? 'vz-toolbar-btn vz-toolbar-btn--on'
                    : 'vz-toolbar-btn'
                }
                onClick={() => setGizmoMode('scale')}
                title={t('vz.scale', 'Scale')}
                aria-label={t('vz.scale', 'Scale')}
                aria-pressed={gizmoMode === 'scale'}
              >
                ⤢
              </button>
              <button
                className="vz-toolbar-btn"
                onClick={() => useProgram.getState().resetPlacement()}
                title={t('vz.resetPlacement', 'Reset placement')}
                aria-label={t('vz.resetPlacement', 'Reset placement')}
              >
                ⟳
              </button>
            </>
          )}
        </div>
        <Viewer
          ref={ref}
          gcode={gcode}
          segments={simSegments}
          toolPosition={actualPosition}
          simPosition={simPosition}
          showActualTool={showActualTool}
          showSimTool={showSimTool}
          revealIndex={revealIndex}
          revealPoint={revealPoint}
          carveSim={carveSim && simulating}
          toolRadius={toolRadius}
          showStock={showStock}
          bedWidth={bedW}
          bedDepth={bedD}
          bedHeight={bedH}
          gizmo={gizmoOn && hasProgram}
          gizmoMode={gizmoMode}
        />
        {gizmoOn && hasProgram && (
          <PlacementReadout placement={placement} t={t} />
        )}
        <DimensionsOverlay dims={dims} bedW={bedW} bedD={bedD} />
      </div>
      <PlaybackTimeline />
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
  const t = useT()
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
        title={t('vz.bedSize.title', 'Bed size (work area)')}
        aria-label={t('vz.bedSize.aria', 'Bed size')}
        aria-expanded={open}
      >
        📐
      </button>
      {open && (
        <div
          className="vz-bed-pop"
          role="dialog"
          aria-label={t('vz.bedSize.dialog', 'Bed size (mm)')}
        >
          <BedField
            label="X"
            color="#ef4444"
            value={width}
            onChange={setWidth}
            title={t('vz.bedSize.x', 'Work area width — X axis (mm)')}
          />
          <BedField
            label="Y"
            color="#22c55e"
            value={depth}
            onChange={setDepth}
            title={t('vz.bedSize.y', 'Work area depth — Y axis (mm)')}
          />
          <BedField
            label="Z"
            color="#3b82f6"
            value={height}
            onChange={setHeight}
            title={t('vz.bedSize.z', 'Work area height — Z axis (mm)')}
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

/**
 * Compact top-left readout of the current placement (XY offset in mm, Z rotation
 * in degrees, uniform scale as a percentage). Sits opposite the toolbar so the
 * user always sees exactly how the job has been moved while the gizmo is active.
 */
function PlacementReadout({
  placement,
  t,
}: {
  placement: Placement
  t: (key: string, english: string) => string
}) {
  return (
    <div className="vz-place" role="status" aria-label={t('vz.placement', 'Placement')}>
      <span className="vz-place-pair" title={t('vz.move', 'Move')}>
        <span className="vz-place-k">X</span>
        <span className="vz-place-v">{mm(placement.dx)}</span>
        <span className="vz-place-k">Y</span>
        <span className="vz-place-v">{mm(placement.dy)}</span>
        <span className="vz-place-unit">mm</span>
      </span>
      <span className="vz-place-pair" title={t('vz.rotate', 'Rotate')}>
        <span className="vz-place-v">{mm(placement.rotDeg)}</span>
        <span className="vz-place-unit">°</span>
      </span>
      <span className="vz-place-pair" title={t('vz.scale', 'Scale')}>
        <span className="vz-place-v">{Math.round(placement.scale * 100)}</span>
        <span className="vz-place-unit">%</span>
      </span>
    </div>
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
  const t = useT()
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
      ? t('vz.fit.exceeds', 'exceeds bed {bed}', { bed: bedLabel })
      : dims.fit === 'warn'
        ? t('vz.fit.outside', 'outside bed {bed}', { bed: bedLabel })
        : t('vz.fit.fits', 'fits bed {bed}', { bed: bedLabel })

  return (
    <div className="vz-dims" role="status" aria-label={t('vz.programDims.aria', 'Program dimensions')}>
      <div
        className="vz-dims-row vz-dims-size"
        title={t(
          'vz.size.title',
          "Width (X) × Depth (Y) of the loaded program's bounding box, in mm",
        )}
      >
        <span className="vz-dims-val">{mm(dims.w)}</span>
        <span className="vz-dims-x">×</span>
        <span className="vz-dims-val">{mm(dims.h)}</span>
        <span className="vz-dims-unit">mm</span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title={t('vz.zrange.title', 'Z range (top→bottom) and total cut depth, in mm')}
      >
        <span>
          {t('vz.zrange', 'Z {min}…{max} ({depth})', {
            min: mm(dims.min[2]),
            max: mm(dims.max[2]),
            depth: mm(dims.d),
          })}
        </span>
      </div>
      <div
        className="vz-dims-row vz-dims-meta"
        title={t('vz.footprint.title', 'Footprint area covered by the toolpath')}
      >
        <span>{fmtArea(dims.area)}</span>
      </div>
      <div
        className="vz-dims-row vz-dims-fit"
        data-fit={dims.fit}
        title={t(
          'vz.fit.title',
          'Whether the program fits within the machine work area (bed {bed} mm)',
          { bed: bedLabel },
        )}
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
.vz-root {
  height: 100%;
  width: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.vz-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
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
.vz-toolbar-btn[aria-expanded='true'],
.vz-toolbar-btn--on {
  border-color: var(--accent, var(--fg-muted));
  background: color-mix(in srgb, var(--accent, var(--bg-elev)) 28%, var(--bg-elev));
  color: var(--accent-fg, var(--fg));
}
.vz-toolbar-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.vz-toolbar-sep {
  width: 1px;
  align-self: stretch;
  margin: 2px 2px;
  background: var(--border);
  flex: 0 0 auto;
}
.vz-place {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 3;
  pointer-events: none;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 9px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elev) 82%, transparent);
  backdrop-filter: blur(4px);
  color: var(--fg);
  font-size: 11px;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
}
.vz-place-pair { display: inline-flex; align-items: baseline; gap: 3px; }
.vz-place-k { color: var(--fg-muted); font-weight: 600; }
.vz-place-v { font-weight: 600; }
.vz-place-unit { color: var(--fg-muted); font-size: 10px; }
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
  .vz-place { font-size: 12px; padding: 6px 10px; gap: 12px; }
  .vz-place-unit { font-size: 11px; }
}
`
