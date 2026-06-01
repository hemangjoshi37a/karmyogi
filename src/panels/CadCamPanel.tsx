import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { importDxfString } from '../core/dxf'
import { Drawing } from '../core/entity'
import { engrave, profile, pocket, ProfileSide, type CamParams } from '../core/cam'
import { defaultTool, type Tool, Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { Polyline } from '../core/geometry'
import { parseStl, type StlMesh } from '../core/slicer'
import {
  carveMesh,
  parseEpsPaths,
  defaultCarve3DParams,
  type Carve3DParams,
  type ToolType,
} from '../core/carve3d'
import { useProgram, useMachine, usePersistentState } from '../store'
import { grbl } from '../serial/controller'
import '../styles/cadcam.css'

/** Split G-code into non-empty lines for streaming to the controller. */
function gcodeLines(gcode: string): string[] {
  return gcode.split(/\r?\n/).filter((l) => l.trim().length > 0)
}

/** Which import family is currently loaded — drives the whole panel layout. */
type Mode = 'none' | '3d' | '2d' | 'step'

type Op = 'Engrave' | 'Profile' | 'Pocket'

/** Short one-liner shown under each 2D operation so beginners know what it does. */
const OP_HELP: Record<Op, string> = {
  Engrave: 'Follow every line at one depth — good for V-carving text & detail.',
  Profile: 'Cut along closed shapes (on / inside / outside the line).',
  Pocket: 'Clear out the inside area of closed shapes, pass by pass.',
}

/** 2D numeric knobs (DXF / EPS / AI). */
interface Params2D {
  diameter: number
  stepdown: number // depth per pass (mm); <= 0 => single full-depth pass
  stepover: number // fraction of diameter (0..1) for pocketing
  safeZ: number
  surfaceZ: number
  cutDepth: number
  feedXY: number
  feedZ: number
  zMode: ZMode
  spindleRPM: number
  penUpZ: number
  penDownZ: number
  decimals: number
  lineNumbers: boolean
}

const DEFAULT_2D: Params2D = (() => {
  const t = defaultTool()
  return {
    diameter: t.diameter,
    stepdown: t.stepdown,
    stepover: t.stepover,
    safeZ: 5.0,
    surfaceZ: 0.0,
    cutDepth: 1.0,
    feedXY: t.feedXY,
    feedZ: t.feedZ,
    zMode: ZMode.Spindle,
    spindleRPM: t.spindleRPM,
    penUpZ: 5.0,
    penDownZ: 0.0,
    decimals: 3,
    lineNumbers: false,
  }
})()

const DEFAULT_3D: Carve3DParams = defaultCarve3DParams()

interface MeshInfo {
  mesh: StlMesh
  format: string
}

/** Classify a picked file by its extension. */
function classify(name: string): Mode | 'dxf' {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'stl') return '3d'
  if (ext === 'step' || ext === 'stp') return 'step'
  if (ext === 'dxf') return 'dxf'
  if (ext === 'eps' || ext === 'ai') return '2d'
  return 'none'
}

/**
 * 3D Carving panel (W7): one place to turn a model into safe GRBL G-code.
 *
 * - STL → 3D relief carving (roughing + finishing) via core/carve3d.
 * - DXF / EPS / AI → 2D engrave / profile (on·inside·outside) / pocket via
 *   core/dxf + core/carve3d's EPS path extractor + core/cam.
 * - STEP / STP → accepted but unsupported (clear "export as STL" message).
 *
 * Live generation pushes G-code to the program store so the Visualizer previews
 * it; Play ▶ streams it when connected.
 */
export function CadCamPanel() {
  const setProgram = useProgram((s) => s.setProgram)
  const connected = useMachine((s) => s.connection === 'connected')

  const fileRef = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('none')
  const [dragOver, setDragOver] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  // 2D state (DXF / EPS / AI)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [epsPolys, setEpsPolys] = useState<Polyline[] | null>(null)
  const [op, setOp] = useState<Op>('Profile')
  const [side, setSide] = useState<ProfileSide>(ProfileSide.Outside)
  const [p2d, setP2d] = usePersistentState<Params2D>('karmyogi.carve.2d', DEFAULT_2D)

  // 3D state (STL)
  const [meshInfo, setMeshInfo] = useState<MeshInfo | null>(null)
  const [p3d, setP3d] = usePersistentState<Carve3DParams>('karmyogi.carve.3d', DEFAULT_3D)

  // Output
  const [gcode, setGcode] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // ---- file import --------------------------------------------------------
  async function loadFile(file: File) {
    setImportError(null)
    setWarnings([])
    setGcode('')
    setLineCount(0)
    setFileName(file.name)
    const kind = classify(file.name)

    if (kind === 'step') {
      setMode('step')
      setDrawing(null)
      setEpsPolys(null)
      setMeshInfo(null)
      return
    }

    if (kind === '3d') {
      setMode('3d')
      setDrawing(null)
      setEpsPolys(null)
      try {
        const buf = await file.arrayBuffer()
        const mesh = parseStl(buf)
        if (mesh.triangleCount === 0) {
          setMeshInfo(null)
          setImportError('STL parsed but contained no triangles.')
          return
        }
        setMeshInfo({ mesh, format: mesh.format })
      } catch (err) {
        setMeshInfo(null)
        setImportError(`Failed to read STL: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    // 2D family — DXF or EPS/AI.
    setMode('2d')
    setMeshInfo(null)
    const text = await file.text()

    if (kind === 'dxf') {
      setEpsPolys(null)
      const res = importDxfString(text)
      setWarnings(res.warnings ?? [])
      if (!res.ok) {
        setDrawing(null)
        setImportError(res.error ?? 'Failed to parse DXF')
        return
      }
      setDrawing(res.drawing)
      return
    }

    // EPS / AI — best effort.
    setDrawing(null)
    const res = parseEpsPaths(text)
    setWarnings(res.warnings ?? [])
    if (!res.ok) {
      setEpsPolys(null)
      setImportError(res.error ?? 'Couldn’t parse this EPS/AI — export as DXF.')
      return
    }
    setEpsPolys(res.polylines)
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) void loadFile(file)
    e.target.value = '' // allow re-picking the same file
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) void loadFile(file)
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget === e.target) setDragOver(false)
  }

  // ---- 2D: flatten + closed-loop bookkeeping ------------------------------
  const polylines = useMemo<Polyline[]>(() => {
    if (mode !== '2d') return []
    if (drawing) return drawing.flatten()
    if (epsPolys) return epsPolys
    return []
  }, [mode, drawing, epsPolys])
  const closedCount = useMemo(
    () => polylines.filter((p) => p.closed && p.points.length >= 3).length,
    [polylines]
  )

  // ---- 2D: build CamParams / emitter --------------------------------------
  function build2DTool(): Tool {
    return defaultTool({
      diameter: p2d.diameter,
      stepdown: p2d.stepdown,
      stepover: p2d.stepover,
      feedXY: p2d.feedXY,
      feedZ: p2d.feedZ,
      spindleRPM: p2d.spindleRPM,
    })
  }
  function build2DCamParams(): CamParams {
    return { tool: build2DTool(), safeZ: p2d.safeZ, surfaceZ: p2d.surfaceZ, cutDepth: p2d.cutDepth }
  }
  function build2DToolpaths(p: CamParams): Toolpath[] {
    if (polylines.length === 0) return []
    if (op === 'Engrave') return [engrave(polylines, p)]
    const closed = polylines.filter((pl) => pl.closed && pl.points.length >= 3)
    const out: Toolpath[] = []
    for (const c of closed) {
      const tp = op === 'Profile' ? profile(c, side, p) : pocket(c, p)
      if (!tp.isEmpty()) out.push(tp)
    }
    return out
  }

  function generate2D(): string {
    if (polylines.length === 0) {
      setGcode('')
      setLineCount(0)
      return ''
    }
    const camParams = build2DCamParams()
    const toolpaths = build2DToolpaths(camParams)
    if (toolpaths.length === 0) {
      setGcode('')
      setLineCount(0)
      return ''
    }
    const opLabel = op === 'Profile' ? `Profile ${side}` : op
    const emitter = new GcodeEmitter({
      programName: `${fileName ?? 'drawing'} — ${opLabel}`,
      safeZ: p2d.safeZ,
      feedXY: p2d.feedXY,
      feedZ: p2d.feedZ,
      zMode: p2d.zMode,
      useSpindle: p2d.zMode === ZMode.Spindle,
      spindleRPM: p2d.spindleRPM,
      penUpZ: p2d.penUpZ,
      penDownZ: p2d.penDownZ,
      decimals: p2d.decimals,
      lineNumbers: p2d.lineNumbers,
    })
    const out = emitter.emitProgram(toolpaths)
    const count = out.split('\n').filter((l) => l.length > 0).length
    setProgram(`${fileName ?? 'drawing'} — ${opLabel}`, out)
    setGcode(out)
    setLineCount(count)
    return out
  }

  // ---- 3D: carve ----------------------------------------------------------
  const [carveStats, setCarveStats] = useState<{
    roughLevels: number
    finishLines: number
    gridX: number
    gridY: number
  } | null>(null)

  function generate3D(): string {
    if (!meshInfo) {
      setGcode('')
      setLineCount(0)
      return ''
    }
    const result = carveMesh(meshInfo.mesh, p3d)
    setWarnings(result.warnings)
    setCarveStats({
      roughLevels: result.roughLevels,
      finishLines: result.finishLines,
      gridX: result.gridX,
      gridY: result.gridY,
    })
    if (result.toolpaths.length === 0) {
      setGcode('')
      setLineCount(0)
      return ''
    }
    const emitter = new GcodeEmitter({
      programName: `${fileName ?? 'model'} — 3D Carving`,
      safeZ: p3d.safeZ,
      feedXY: p3d.feedXY,
      feedZ: p3d.feedZ,
      zMode: ZMode.Spindle,
      useSpindle: true,
      spindleRPM: p3d.spindleRPM,
    })
    const out = emitter.emitProgram(result.toolpaths)
    const count = out.split('\n').filter((l) => l.length > 0).length
    setProgram(`${fileName ?? 'model'} — 3D Carving`, out)
    setGcode(out)
    setLineCount(count)
    return out
  }

  function generate(): string {
    if (mode === '3d') return generate3D()
    if (mode === '2d') return generate2D()
    return ''
  }

  // Live G-code: regenerate (debounced) whenever inputs change, off the UI
  // critical path so a heavy carve never blocks typing.
  useEffect(() => {
    if (mode !== '2d' && mode !== '3d') return
    setBusy(true)
    const id = window.setTimeout(() => {
      try {
        generate()
      } finally {
        setBusy(false)
      }
    }, 300)
    return () => {
      window.clearTimeout(id)
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, drawing, epsPolys, meshInfo, op, side, p2d, p3d, polylines])

  // ---- send to machine ----------------------------------------------------
  function play() {
    const out = gcode || generate()
    const lines = gcodeLines(out)
    if (lines.length === 0 || !connected) return
    grbl.startProgram(lines)
  }

  // ---- param input helpers ------------------------------------------------
  function num2d<K extends keyof Params2D>(key: K) {
    return {
      type: 'number' as const,
      value: String(p2d[key]),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = parseFloat(e.target.value)
        setP2d((prev) => ({ ...prev, [key]: Number.isFinite(v) ? v : 0 }))
      },
    }
  }
  function num3d<K extends keyof Carve3DParams>(key: K) {
    return {
      type: 'number' as const,
      value: String(p3d[key]),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = parseFloat(e.target.value)
        setP3d((prev) => ({ ...prev, [key]: Number.isFinite(v) ? v : 0 }))
      },
    }
  }

  const isPen = p2d.zMode === ZMode.Pen
  const hasGeometry = polylines.length > 0
  const canGenerate2D = hasGeometry && (op === 'Engrave' || closedCount > 0)
  const canGenerate = mode === '3d' ? !!meshInfo : canGenerate2D
  const flowStep =
    mode === 'none' ? 1 : !canGenerate ? 2 : lineCount > 0 ? 3 : 2

  // Mesh stats for the 3D card.
  const meshSize = useMemo(() => {
    if (!meshInfo) return null
    const b = meshInfo.mesh.bbox
    return {
      x: b.max[0] - b.min[0],
      y: b.max[1] - b.min[1],
      z: b.max[2] - b.min[2],
    }
  }, [meshInfo])

  return (
    <div
      className={'cc-panel' + (dragOver ? ' cc-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="cc-scroll">
        {/* ---- intro / flow ---- */}
        <p className="cc-intro">
          <b>3D Carving.</b> Import an STL to carve in relief, or a DXF / vector
          file for 2D engrave · profile · pocket — the toolpath previews live in
          the Visualizer, then press Send.
        </p>
        <ol className="cc-flow" aria-label="workflow steps">
          <li className={flowStep >= 1 ? 'done' : ''}>
            <span className="cc-flow-n">1</span> Import model
          </li>
          <li className={flowStep >= 2 ? 'done' : ''}>
            <span className="cc-flow-n">2</span>{' '}
            {mode === '3d' ? 'Carve settings' : 'Operation'}
          </li>
          <li className={flowStep >= 3 ? 'done' : ''}>
            <span className="cc-flow-n">3</span> Send ▶
          </li>
        </ol>

        <div className="cc-cards">
          {/* ---- import ---- */}
          <section className="cc-section">
            <h3>1 · Model</h3>
            <div className="cc-section-body">
              <div className={'cc-drop' + (dragOver ? ' cc-dragover' : '')}>
                <span className="cc-drop-icon" aria-hidden>
                  ⤓
                </span>
                <button
                  className="cc-load-btn primary"
                  onClick={() => fileRef.current?.click()}
                  title="Pick a .stl / .step / .dxf / .eps / .ai file to carve"
                >
                  Import model…
                </button>
                <span
                  className={'cc-file-name' + (fileName ? '' : ' empty')}
                  title={fileName ?? undefined}
                >
                  {fileName ?? 'No file loaded'}
                </span>
                <span className="cc-drop-hint">
                  or drop a .stl / .step / .dxf / .eps / .ai file anywhere on this panel
                </span>
                <input
                  ref={fileRef}
                  className="cc-load-input"
                  type="file"
                  accept=".stl,.step,.stp,.dxf,.eps,.ai"
                  onChange={onFileChange}
                />
              </div>

              {mode !== 'none' && (
                <div className="cc-mode-badge" data-mode={mode}>
                  {mode === '3d' && '🗻 3D relief carving (STL)'}
                  {mode === '2d' && '✎ 2D vector (DXF / EPS / AI)'}
                  {mode === 'step' && '⚠ STEP / STP — not supported'}
                </div>
              )}

              {importError && <div className="cc-error">{importError}</div>}

              {mode === 'step' && (
                <div className="cc-error">
                  STEP import isn’t supported yet — full ISO-10303 (B-rep) parsing is
                  out of scope. Please export your model as <b>STL</b> (most CAD tools:
                  File → Export → STL) and import that instead.
                </div>
              )}

              {/* 3D mesh stats */}
              {mode === '3d' && meshInfo && meshSize && (
                <div className="cc-import-stats">
                  <span className="cc-stat" title="Triangles in the mesh">
                    Triangles <b>{meshInfo.mesh.triangleCount.toLocaleString()}</b>
                  </span>
                  <span className="cc-stat" title="Bounding-box size (mm)">
                    Size{' '}
                    <b>
                      {meshSize.x.toFixed(1)}×{meshSize.y.toFixed(1)}×{meshSize.z.toFixed(1)}
                    </b>
                  </span>
                  <span className="cc-stat" title="Source format">
                    {meshInfo.format} STL
                  </span>
                </div>
              )}

              {/* 2D stats */}
              {mode === '2d' && hasGeometry && (
                <div className="cc-import-stats">
                  {drawing && (
                    <span className="cc-stat" title="Raw DXF entities">
                      Entities <b>{drawing.size()}</b>
                    </span>
                  )}
                  <span className="cc-stat" title="Flattened polylines (curves → segments)">
                    Polylines <b>{polylines.length}</b>
                  </span>
                  <span className="cc-stat" title="Closed loops — needed for Profile / Pocket">
                    Closed <b>{closedCount}</b>
                  </span>
                </div>
              )}

              {warnings.length > 0 && (
                <ul className="cc-warnings">
                  {warnings.slice(0, 20).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {warnings.length > 20 && <li>… {warnings.length - 20} more</li>}
                </ul>
              )}
            </div>
          </section>

          {/* ================= 3D CARVING CONTROLS ================= */}
          {mode === '3d' && (
            <>
              <section className="cc-section">
                <h3>2 · Tool</h3>
                <div className="cc-section-body">
                  <div className="cc-zmode">
                    <button
                      className={p3d.toolType === 'ball' ? 'active' : ''}
                      onClick={() => setP3d((p) => ({ ...p, toolType: 'ball' as ToolType }))}
                      title="Ball-nose: best for smooth relief finishing"
                    >
                      ◓ Ball-nose
                    </button>
                    <button
                      className={p3d.toolType === 'flat' ? 'active' : ''}
                      onClick={() => setP3d((p) => ({ ...p, toolType: 'flat' as ToolType }))}
                      title="Flat-end: faster roughing, flat-bottom pockets"
                    >
                      ▢ Flat-end
                    </button>
                  </div>
                  <div className="cc-grid">
                    <div className="cc-field">
                      <label htmlFor="cc3-dia">Tool ⌀ (mm)</label>
                      <input id="cc3-dia" min={0.1} step={0.1} {...num3d('toolDiameter')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc3-stepover">Stepover (mm)</label>
                      <input id="cc3-stepover" min={0.05} step={0.1} {...num3d('stepover')} />
                    </div>
                  </div>
                  <span className="cc-hint">
                    Smaller stepover = finer surface but more passes. Ball-nose is the
                    classic relief finishing tool.
                  </span>
                </div>
              </section>

              <section className="cc-section">
                <h3>Depth &amp; passes</h3>
                <div className="cc-section-body">
                  <div className="cc-grid">
                    <div className="cc-field">
                      <label htmlFor="cc3-maxdepth">Max carve depth (mm)</label>
                      <input id="cc3-maxdepth" min={0} step={0.5} {...num3d('maxDepth')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc3-stepdown">Roughing stepdown (mm)</label>
                      <input id="cc3-stepdown" min={0.1} step={0.1} {...num3d('stepdown')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc3-safez">Safe Z (mm)</label>
                      <input id="cc3-safez" step={0.5} {...num3d('safeZ')} />
                    </div>
                  </div>
                  <span className="cc-hint">
                    Carve depth limits how far below the model’s top surface the tool
                    goes (protects the bed / clamps).
                  </span>
                </div>
              </section>

              <section className="cc-section">
                <h3>Strategy</h3>
                <div className="cc-section-body">
                  <label className="cc-check">
                    <input
                      type="checkbox"
                      checked={p3d.doRoughing}
                      onChange={(e) => setP3d((p) => ({ ...p, doRoughing: e.target.checked }))}
                    />
                    Roughing — clear bulk stock in flat stepdown layers
                  </label>
                  <label className="cc-check">
                    <input
                      type="checkbox"
                      checked={p3d.doFinishing}
                      onChange={(e) => setP3d((p) => ({ ...p, doFinishing: e.target.checked }))}
                    />
                    Finishing — parallel raster following the relief surface
                  </label>
                  <div className="cc-zmode">
                    <button
                      className={p3d.finishDir === 'x' ? 'active' : ''}
                      onClick={() => setP3d((p) => ({ ...p, finishDir: 'x' }))}
                      title="Finishing scans rows along X"
                    >
                      ↔ Raster X
                    </button>
                    <button
                      className={p3d.finishDir === 'y' ? 'active' : ''}
                      onClick={() => setP3d((p) => ({ ...p, finishDir: 'y' }))}
                      title="Finishing scans columns along Y"
                    >
                      ↕ Raster Y
                    </button>
                  </div>
                  {carveStats && (
                    <span className="cc-gen-meta">
                      Heightmap <b>{carveStats.gridX}×{carveStats.gridY}</b> · rough levels{' '}
                      <b>{carveStats.roughLevels}</b> · finish lines{' '}
                      <b>{carveStats.finishLines}</b>
                    </span>
                  )}
                </div>
              </section>

              {/* 3D advanced */}
              <section className="cc-section cc-advanced">
                <button
                  className="cc-adv-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  title="Feed rates and spindle speed — defaults are usually fine"
                >
                  {showAdvanced ? '▾' : '▸'} Advanced — feeds &amp; spindle
                </button>
                {showAdvanced && (
                  <div className="cc-section-body">
                    <div className="cc-grid">
                      <div className="cc-field">
                        <label htmlFor="cc3-feedxy">Feed XY (mm/min)</label>
                        <input id="cc3-feedxy" min={0} step={10} {...num3d('feedXY')} />
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc3-feedz">Feed Z / plunge (mm/min)</label>
                        <input id="cc3-feedz" min={0} step={10} {...num3d('feedZ')} />
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc3-rpm">Spindle RPM</label>
                        <input id="cc3-rpm" min={0} step={500} {...num3d('spindleRPM')} />
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </>
          )}

          {/* ================= 2D CONTROLS ================= */}
          {mode === '2d' && (
            <>
              <section className="cc-section">
                <h3>2 · Operation</h3>
                <div className="cc-section-body">
                  <div className="cc-ops">
                    {(['Engrave', 'Profile', 'Pocket'] as Op[]).map((o) => (
                      <button
                        key={o}
                        className={'cc-op-btn' + (op === o ? ' active' : '')}
                        onClick={() => setOp(o)}
                        title={OP_HELP[o]}
                      >
                        {o}
                      </button>
                    ))}
                  </div>

                  {op === 'Profile' && (
                    <div className="cc-subops">
                      {[ProfileSide.On, ProfileSide.Inside, ProfileSide.Outside].map((s) => (
                        <button
                          key={s}
                          className={'cc-subop-btn' + (side === s ? ' active' : '')}
                          onClick={() => setSide(s)}
                          title={`Cut ${String(s).toLowerCase()} the contour`}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}

                  <span className="cc-hint">{OP_HELP[op]}</span>

                  {op !== 'Engrave' && closedCount === 0 && hasGeometry && (
                    <span className="cc-warn-line">
                      ⚠ {op} needs a closed contour — none found in this file.
                    </span>
                  )}
                </div>
              </section>

              <section className="cc-section">
                <h3>Tool &amp; cut</h3>
                <div className="cc-section-body">
                  <div className="cc-grid">
                    <div className="cc-field">
                      <label htmlFor="cc-diameter">Tool ⌀ (mm)</label>
                      <input id="cc-diameter" min={0} step={0.1} {...num2d('diameter')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-cutdepth">Cut depth (mm)</label>
                      <input id="cc-cutdepth" min={0} step={0.1} {...num2d('cutDepth')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-stepdown">Stepdown / pass (mm)</label>
                      <input id="cc-stepdown" min={0} step={0.1} {...num2d('stepdown')} />
                    </div>
                    {op === 'Pocket' && (
                      <div className="cc-field">
                        <label htmlFor="cc-stepover">Stepover (×⌀)</label>
                        <input
                          id="cc-stepover"
                          min={0.05}
                          max={1}
                          step={0.05}
                          title="Sideways overlap between pocket passes, as a fraction of tool ⌀"
                          {...num2d('stepover')}
                        />
                      </div>
                    )}
                    <div className="cc-field">
                      <label htmlFor="cc-safez">Safe Z (mm)</label>
                      <input id="cc-safez" step={0.5} {...num2d('safeZ')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-surfacez">Surface Z (mm)</label>
                      <input
                        id="cc-surfacez"
                        step={0.5}
                        title="Z of the stock top — cuts go from here down to Cut depth"
                        {...num2d('surfaceZ')}
                      />
                    </div>
                  </div>
                </div>
              </section>

              <section className="cc-section">
                <h3>Z mode</h3>
                <div className="cc-section-body">
                  <div className="cc-zmode">
                    <button
                      className={p2d.zMode === ZMode.Spindle ? 'active' : ''}
                      onClick={() => setP2d((p) => ({ ...p, zMode: ZMode.Spindle }))}
                      title="Router/spindle: Z is cut depth; M3/M5 control the spindle"
                    >
                      🛞 Spindle
                    </button>
                    <button
                      className={p2d.zMode === ZMode.Pen ? 'active' : ''}
                      onClick={() => setP2d((p) => ({ ...p, zMode: ZMode.Pen }))}
                      title="Pen plotter: cuts → pen-down Z, travels → pen-up Z (no spindle)"
                    >
                      ✒ Pen
                    </button>
                  </div>

                  <div className="cc-grid">
                    {!isPen && (
                      <div className="cc-field">
                        <label htmlFor="cc-rpm">Spindle RPM</label>
                        <input id="cc-rpm" min={0} step={500} {...num2d('spindleRPM')} />
                      </div>
                    )}
                    {isPen && (
                      <>
                        <div className="cc-field">
                          <label htmlFor="cc-penup">Pen up Z (mm)</label>
                          <input id="cc-penup" step={0.5} {...num2d('penUpZ')} />
                        </div>
                        <div className="cc-field">
                          <label htmlFor="cc-pendown">Pen down Z (mm)</label>
                          <input id="cc-pendown" step={0.5} {...num2d('penDownZ')} />
                        </div>
                      </>
                    )}
                  </div>
                  <span className="cc-hint">
                    {isPen
                      ? 'Pen: cuts map to pen-down Z, travels to pen-up Z (no spindle).'
                      : 'Spindle: Z values are written verbatim; M3/M5 wrap the program.'}
                  </span>
                </div>
              </section>

              <section className="cc-section cc-advanced">
                <button
                  className="cc-adv-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  title="Feed rates, decimals & line numbers — defaults are usually fine"
                >
                  {showAdvanced ? '▾' : '▸'} Advanced
                </button>
                {showAdvanced && (
                  <div className="cc-section-body">
                    <div className="cc-grid">
                      <div className="cc-field">
                        <label htmlFor="cc-feedxy">Feed XY (mm/min)</label>
                        <input id="cc-feedxy" min={0} step={10} {...num2d('feedXY')} />
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc-feedz">Feed Z / plunge (mm/min)</label>
                        <input id="cc-feedz" min={0} step={10} {...num2d('feedZ')} />
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc-decimals">Decimals</label>
                        <input
                          id="cc-decimals"
                          min={1}
                          max={6}
                          step={1}
                          title="Number of decimal places in emitted coordinates"
                          {...num2d('decimals')}
                        />
                      </div>
                    </div>
                    <label className="cc-check">
                      <input
                        type="checkbox"
                        checked={p2d.lineNumbers}
                        onChange={(e) => setP2d((p) => ({ ...p, lineNumbers: e.target.checked }))}
                      />
                      Line numbers (N10, N20 …)
                    </label>
                  </div>
                )}
              </section>
            </>
          )}

          {/* ---- output / send ---- */}
          <section className="cc-section cc-send">
            <h3>3 · Send</h3>
            <div className="cc-section-body">
              <div className="cc-generate">
                <button
                  className="primary cc-play"
                  onClick={play}
                  disabled={!canGenerate || lineCount === 0 || !connected}
                  title={
                    connected
                      ? 'Stream this program to the machine'
                      : 'Connect to a machine to send'
                  }
                >
                  ▶ Send to machine
                </button>
                <button
                  className="cc-regen"
                  onClick={() => generate()}
                  disabled={!canGenerate}
                  title="Regenerate now"
                  aria-label="Regenerate"
                >
                  ↻
                </button>
              </div>
              <span className="cc-gen-meta">
                {busy ? 'Generating…' : 'Live preview'} · <b>{lineCount}</b> lines → Visualizer
              </span>

              {mode === 'none' && (
                <span className="cc-hint">Import a model to generate a toolpath.</span>
              )}
              {mode === 'step' && (
                <span className="cc-hint">Export your STEP model as STL to carve it.</span>
              )}
              {!connected && canGenerate && lineCount > 0 && (
                <span className="cc-hint">Not connected — preview is live; connect to send.</span>
              )}

              {lineCount > 0 && (
                <>
                  <button
                    className="cc-raw-toggle"
                    onClick={() => setShowRaw((v) => !v)}
                    aria-expanded={showRaw}
                    title="Show the generated G-code text (read-only)"
                  >
                    {showRaw ? '▾' : '▸'} Raw G-code ({lineCount} lines)
                  </button>
                  {showRaw && (
                    <textarea className="cc-raw" readOnly value={gcode} spellCheck={false} />
                  )}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
