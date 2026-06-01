import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { useProgram, useMachine } from '../store'
import { grbl } from '../serial/controller'
import { importGerber, GerberData } from '../core/gerber'
import { importExcellon, ExcellonData } from '../core/excellon'
import { isolationRoutes, drillHits, boardCutout } from '../core/pcbCam'
import { Polyline, makeRect } from '../core/geometry'
import { Toolpath, defaultTool } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import {
  unzipGerberPackage,
  detectLayerRole,
  layerRoleLabel,
  LAYER_ROLES,
  GerberPackageError,
  type LayerRole,
  type PackageEntry,
} from '../core/gerberPackage'
import '../styles/pcb.css'

const ZIP_ACCEPT = '.zip'
const GERBER_ACCEPT = '.gbr,.ger,.gtl,.gbl,.art,.gko,.gm1,.txt'
const EXCELLON_ACCEPT = '.drl,.xln,.txt,.nc,.exc'

type StageId = 'isolation' | 'drill' | 'cutout'

/** Roles that have an associated CAM operation (so a per-layer run is meaningful). */
const ROLE_STAGE: Partial<Record<LayerRole, StageId>> = {
  CopperTop: 'isolation',
  CopperBottom: 'isolation',
  Drill: 'drill',
  BoardOutline: 'cutout',
}
const STAGE_VERB: Record<StageId, string> = {
  isolation: 'isolation routing',
  drill: 'drilling',
  cutout: 'board cutout',
}

interface Params {
  zmode: 'spindle' | 'pen'
  toolDia: number
  passes: number
  stepover: number
  safeZ: number
  copperZ: number
  drillZ: number
  peckDepth: number
  cutoutDepth: number
  tabs: number
  tabWidth: number
  feedXY: number
  feedZ: number
  rpm: number
}

const DEFAULTS: Params = {
  zmode: 'spindle',
  toolDia: 0.2,
  passes: 1,
  stepover: 0.15,
  safeZ: 3.0,
  copperZ: -0.1,
  drillZ: -1.8,
  peckDepth: 0.0,
  cutoutDepth: 1.6,
  tabs: 0,
  tabWidth: 2.0,
  feedXY: 200,
  feedZ: 60,
  rpm: 12000,
}

interface ParseInfo {
  text: string
  warnings: string[]
  error?: string
}

/** A layer file in the mapping table, with a one-line parse summary. */
interface LayerRow extends PackageEntry {
  /** Stable id for React keys / role edits. */
  id: string
  /** Short human summary (geometry counts) or parse error. */
  summary: string
  parseError?: boolean
}

const bytesLabel = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

// Summarise an entry's geometry for the table, without committing it to a stage.
function summarizeEntry(e: PackageEntry): { summary: string; parseError?: boolean } {
  if (e.role === 'Drill') {
    const res = importExcellon(e.text)
    if (!res.ok) return { summary: res.error ?? 'parse error', parseError: true }
    return { summary: `${res.data.hits.length} hits, ${res.data.toolDiameters().length} tools` }
  }
  if (e.role === 'CopperTop' || e.role === 'CopperBottom' || e.role === 'BoardOutline') {
    const res = importGerber(e.text)
    if (!res.ok) return { summary: res.error ?? 'parse error', parseError: true }
    const b = res.data.bounds()
    return {
      summary: `${res.data.traces.length}tr ${res.data.pads.length}pad ${res.data.regions.length}rgn · ${b.width().toFixed(1)}×${b.height().toFixed(1)}mm`,
    }
  }
  return { summary: bytesLabel(e.size) }
}

function makeRow(e: PackageEntry, idx: number): LayerRow {
  const { summary, parseError } = summarizeEntry(e)
  return { ...e, id: `${idx}-${e.name}`, summary, parseError }
}

/** Geometry resolved for a single layer row, ready to feed a CAM op. */
type RowGeom =
  | { kind: 'copper'; data: GerberData }
  | { kind: 'drill'; data: ExcellonData }
  | { kind: 'outline'; data: GerberData }

function rowGeometry(row: LayerRow): RowGeom | { error: string } {
  const stage = ROLE_STAGE[row.role]
  if (!stage) return { error: 'This layer role has no machining operation.' }
  if (row.role === 'Drill') {
    const res = importExcellon(row.text)
    if (!res.ok) return { error: res.error ?? 'Excellon parse error' }
    return { kind: 'drill', data: res.data }
  }
  const res = importGerber(row.text)
  if (!res.ok) return { error: res.error ?? 'Gerber parse error' }
  return { kind: row.role === 'BoardOutline' ? 'outline' : 'copper', data: res.data }
}

/**
 * PCB panel (W10): upload a Gerber/Excellon export ZIP, review/assign each
 * layer's role in a table, then generate isolation-routing / drilling /
 * board-cutout G-code as staged programs. Each layer row also has inline
 * Preview (push that layer's G-code to the visualizer) and Play (preview +
 * stream to the machine) buttons. A secondary path still allows loading single
 * Gerber/Excellon files directly.
 */
export function PcbPanel() {
  const setProgram = useProgram((s) => s.setProgram)
  const connected = useMachine((s) => s.connection === 'connected')

  const zipRef = useRef<HTMLInputElement>(null)
  const gerberRef = useRef<HTMLInputElement>(null)
  const excellonRef = useRef<HTMLInputElement>(null)

  // ---- ZIP package + layer mapping ----
  const [layers, setLayers] = useState<LayerRow[]>([])
  const [pkgError, setPkgError] = useState<string>('')
  const [pkgName, setPkgName] = useState<string>('')
  const [dragZip, setDragZip] = useState(false)

  // ---- secondary single-file inputs ----
  const [singleGerber, setSingleGerber] = useState<GerberData | null>(null)
  const [singleDrill, setSingleDrill] = useState<ExcellonData | null>(null)
  const [gerberInfo, setGerberInfo] = useState<ParseInfo | null>(null)
  const [drillInfo, setDrillInfo] = useState<ParseInfo | null>(null)
  const [dragGerber, setDragGerber] = useState(false)
  const [dragDrill, setDragDrill] = useState(false)
  const [showSingle, setShowSingle] = useState(false)

  const [params, setParams] = useState<Params>(DEFAULTS)
  const [activeStage, setActiveStage] = useState<StageId>('isolation')
  const [status, setStatus] = useState<string>('')

  // Advanced section is collapsed by default — beginners drive the layer table.
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Last generated G-code, shown in a collapsible (collapsed by default) preview.
  const [lastGcode, setLastGcode] = useState<{ name: string; text: string } | null>(null)
  const [showGcode, setShowGcode] = useState(false)

  function set<K extends keyof Params>(key: K, value: Params[K]) {
    setParams((p) => ({ ...p, [key]: value }))
  }
  function num(key: keyof Params) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      set(key, (Number.isFinite(v) ? v : 0) as Params[typeof key])
    }
  }

  // ---- ZIP handling ----
  async function loadZip(file: File) {
    setPkgError('')
    setStatus('')
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const entries = unzipGerberPackage(buf)
      setLayers(entries.map(makeRow))
      setPkgName(`${file.name} — ${entries.length} layer file${entries.length === 1 ? '' : 's'}`)
    } catch (err) {
      const msg =
        err instanceof GerberPackageError
          ? err.message
          : `Failed to read ZIP: ${err instanceof Error ? err.message : String(err)}`
      setLayers([])
      setPkgName('')
      setPkgError(msg)
    }
  }

  function onZipInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void loadZip(f)
    e.target.value = ''
  }

  function changeRole(id: string, role: LayerRole) {
    setLayers((rows) =>
      rows.map((r) => {
        if (r.id !== id) return r
        const updated: PackageEntry = { ...r, role }
        const { summary, parseError } = summarizeEntry(updated)
        return { ...r, role, summary, parseError }
      })
    )
  }

  // Find the first non-erroring layer row assigned to a given role.
  function rowFor(role: LayerRole): LayerRow | undefined {
    return layers.find((r) => r.role === role && !r.parseError)
  }

  // ---- secondary single-file loaders ----
  async function loadGerberFile(file: File) {
    const text = await file.text()
    const res = importGerber(text)
    if (!res.ok) {
      setSingleGerber(null)
      setGerberInfo({ text: '', warnings: res.warnings, error: res.error })
      return
    }
    setSingleGerber(res.data)
    const b = res.data.bounds()
    setGerberInfo({
      text: `${file.name}: ${res.data.traces.length} traces, ${res.data.pads.length} pads, ${res.data.regions.length} regions; ${b.width().toFixed(2)} × ${b.height().toFixed(2)} mm`,
      warnings: res.warnings,
    })
  }

  async function loadExcellonFile(file: File) {
    const text = await file.text()
    const res = importExcellon(text)
    if (!res.ok) {
      setSingleDrill(null)
      setDrillInfo({ text: '', warnings: res.warnings, error: res.error })
      return
    }
    setSingleDrill(res.data)
    setDrillInfo({
      text: `${file.name}: ${res.data.hits.length} hits, ${res.data.toolDiameters().length} distinct tools`,
      warnings: res.warnings,
    })
  }

  function onGerberInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void loadGerberFile(f)
    e.target.value = ''
  }
  function onExcellonInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (f) void loadExcellonFile(f)
    e.target.value = ''
  }

  // Build an emitter configured from the current params + tool.
  function makeEmitter(tool: ReturnType<typeof defaultTool>, tpName: string): GcodeEmitter {
    const pen = params.zmode === 'pen'
    return new GcodeEmitter({
      safeZ: params.safeZ,
      feedXY: tool.feedXY,
      feedZ: tool.feedZ,
      spindleRPM: tool.spindleRPM,
      zMode: pen ? ZMode.Pen : ZMode.Spindle,
      useSpindle: !pen,
      penUpZ: params.safeZ,
      penDownZ: 0.0,
      programName: `karmyogi PCB ${tpName}`,
    })
  }

  function makeTool() {
    return defaultTool({
      diameter: params.toolDia,
      stepover: params.stepover, // metric step (mm) for isolation passes
      stepdown: params.cutoutDepth > 0.6 ? 0.6 : params.cutoutDepth,
      feedXY: params.feedXY,
      feedZ: params.feedZ,
      spindleRPM: params.rpm,
    })
  }

  // Build a toolpath for one stage from explicit geometry inputs.
  function buildToolpath(
    stage: StageId,
    geom: { copper?: GerberData | null; drillData?: ExcellonData | null; outline?: GerberData | null }
  ): { tp: Toolpath } | { error: string } {
    const tool = makeTool()
    let tp: Toolpath
    if (stage === 'isolation') {
      if (!geom.copper)
        return { error: 'Assign a Copper Top/Bottom layer (or load a Gerber) for isolation routing.' }
      tp = isolationRoutes(geom.copper, tool, params.safeZ, params.copperZ, params.passes)
    } else if (stage === 'drill') {
      if (!geom.drillData)
        return { error: 'Assign a Drill layer (or load an Excellon file) for drilling.' }
      tp = drillHits(geom.drillData, params.safeZ, params.drillZ, params.peckDepth)
    } else {
      // Cutout: use an assigned Board Outline if present, else the copper bounds.
      const source = geom.outline ?? geom.copper
      if (!source)
        return { error: 'Assign a Board Outline or Copper layer to derive the cutout outline.' }
      const b = source.bounds()
      if (!b.isValid()) return { error: 'Layer bounds are empty; cannot derive cutout outline.' }
      const outline: Polyline = makeRect(b.min, b.width(), b.height())
      tp = boardCutout(outline, tool, params.safeZ, params.cutoutDepth, params.tabs, params.tabWidth)
    }
    if (tp.isEmpty()) return { error: 'No toolpath produced for this stage.' }
    return { tp }
  }

  function buildGcode(
    stage: StageId,
    geom: { copper?: GerberData | null; drillData?: ExcellonData | null; outline?: GerberData | null }
  ): { gcode: string; tp: Toolpath } | { error: string } {
    const res = buildToolpath(stage, geom)
    if ('error' in res) return res
    const tool = makeTool()
    const emitter = makeEmitter(tool, res.tp.name)
    return { gcode: emitter.emitProgram(res.tp), tp: res.tp }
  }

  // ---- resolve the geometry that drives each (global) stage ----
  // Prefer a layer assigned in the ZIP table; fall back to the single-file input.
  const resolved = useMemo(() => {
    const copperRow = rowFor('CopperTop') ?? rowFor('CopperBottom')
    let copper: GerberData | null = null
    if (copperRow) {
      const res = importGerber(copperRow.text)
      if (res.ok) copper = res.data
    }
    if (!copper) copper = singleGerber

    const drillRow = rowFor('Drill')
    let drillData: ExcellonData | null = null
    if (drillRow) {
      const res = importExcellon(drillRow.text)
      if (res.ok) drillData = res.data
    }
    if (!drillData) drillData = singleDrill

    const outlineRow = rowFor('BoardOutline')
    let outline: GerberData | null = null
    if (outlineRow) {
      const res = importGerber(outlineRow.text)
      if (res.ok) outline = res.data
    }

    return { copper, drillData, outline }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, singleGerber, singleDrill])

  // Generate a (global) stage and push it to the program store.
  function sendStage(stage: StageId) {
    const res = buildGcode(stage, resolved)
    if ('error' in res) {
      setStatus(res.error)
      return
    }
    const name = `pcb-${stage}.nc`
    setProgram(name, res.gcode)
    setLastGcode({ name, text: res.gcode })
    setStatus(
      `Sent ${stage} to program: ${res.tp.size()} moves, cut ${res.tp.cutLength().toFixed(1)} mm.`
    )
  }

  // ---- per-layer Preview / Play ----
  // Build that single layer's G-code for its role's operation, push it to the
  // program store (so it shows in the 3D Visualizer immediately), and optionally
  // stream it straight to the machine.
  function buildRowGcode(
    row: LayerRow
  ): { stage: StageId; gcode: string; tp: Toolpath; name: string } | { error: string } {
    const stage = ROLE_STAGE[row.role]
    if (!stage) return { error: 'This layer role has no machining operation.' }
    const g = rowGeometry(row)
    if ('error' in g) return g
    const geom =
      g.kind === 'drill'
        ? { drillData: g.data }
        : g.kind === 'outline'
        ? { outline: g.data }
        : { copper: g.data }
    const res = buildGcode(stage, geom)
    if ('error' in res) return res
    return { stage, gcode: res.gcode, tp: res.tp, name: `pcb-${row.role}.nc` }
  }

  function previewRow(row: LayerRow) {
    const res = buildRowGcode(row)
    if ('error' in res) {
      setStatus(`${row.name}: ${res.error}`)
      return
    }
    setProgram(res.name, res.gcode)
    setLastGcode({ name: res.name, text: res.gcode })
    setStatus(
      `Preview ${STAGE_VERB[res.stage]} for ${row.name}: ${res.tp.size()} moves, cut ${res.tp
        .cutLength()
        .toFixed(1)} mm. Shown in Visualizer.`
    )
  }

  function playRow(row: LayerRow) {
    if (!connected) {
      setStatus('Connect to the machine before running a layer.')
      return
    }
    const res = buildRowGcode(row)
    if ('error' in res) {
      setStatus(`${row.name}: ${res.error}`)
      return
    }
    const ok = window.confirm(
      `RUN ${STAGE_VERB[res.stage]} for "${row.name}" on the machine now?\n` +
        `${res.tp.size()} moves, ${res.tp.cutLength().toFixed(1)} mm of cutting.\n` +
        `Make sure the work is clamped and Z is zeroed.`
    )
    if (!ok) return
    setProgram(res.name, res.gcode)
    setLastGcode({ name: res.name, text: res.gcode })
    const lines = res.gcode.split(/\r?\n/).filter((l) => l.length > 0)
    grbl.startProgram(lines)
    setStatus(`Streaming ${STAGE_VERB[res.stage]} for ${row.name} — ${lines.length} lines.`)
  }

  const hasCopper = !!resolved.copper
  const hasDrill = !!resolved.drillData
  const hasOutline = !!resolved.outline

  const stageMeta: { id: StageId; label: string; ready: boolean; note?: string }[] = [
    { id: 'isolation', label: 'Isolation', ready: hasCopper },
    { id: 'drill', label: 'Drilling', ready: hasDrill },
    {
      id: 'cutout',
      label: 'Cutout',
      ready: hasOutline || hasCopper,
      note: hasOutline ? undefined : hasCopper ? 'using copper bounds' : undefined,
    },
  ]

  // Counts for the package summary banner.
  const roleCounts = useMemo(() => {
    const c = new Map<LayerRole, number>()
    for (const r of layers) c.set(r.role, (c.get(r.role) ?? 0) + 1)
    return c
  }, [layers])
  const unknownCount = roleCounts.get('Unknown') ?? 0

  return (
    <div className="pcb-panel">
      <div className="pcb-scroll">
        {/* ---- 1. Upload package (primary action) ---- */}
        <section className="pcb-section">
          <h3>1 · Upload Gerber ZIP</h3>
          <div className="pcb-section-body">
            <div
              className={'pcb-drop pcb-drop-primary' + (dragZip ? ' pcb-dragover' : '')}
              onDragOver={(e: DragEvent) => {
                e.preventDefault()
                setDragZip(true)
              }}
              onDragLeave={() => setDragZip(false)}
              onDrop={(e: DragEvent) => {
                e.preventDefault()
                setDragZip(false)
                const f = e.dataTransfer.files?.[0]
                if (f) void loadZip(f)
              }}
            >
              <button className="pcb-load-btn primary pcb-load-zip" onClick={() => zipRef.current?.click()}>
                ⬆ Upload Gerber ZIP…
              </button>
              <span className="pcb-drop-hint">or drop a .zip export here</span>
              <input
                ref={zipRef}
                className="pcb-load-input"
                type="file"
                accept={ZIP_ACCEPT}
                onChange={onZipInput}
              />
            </div>

            {!layers.length && !pkgError && (
              <p className="pcb-intro">
                Drop your board's Gerber/Excellon export ZIP here. Layers are detected
                automatically — then press <span className="pcb-kbd">▶</span> on a layer to run it.
              </p>
            )}

            {pkgError && <div className="pcb-error">{pkgError}</div>}

            <button
              className="pcb-toggle-single"
              onClick={() => setShowSingle((s) => !s)}
              aria-expanded={showSingle}
            >
              {showSingle ? '▾' : '▸'} or load individual files
            </button>

            {showSingle && (
              <div className="pcb-single">
                <div
                  className={'pcb-drop' + (dragGerber ? ' pcb-dragover' : '')}
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault()
                    setDragGerber(true)
                  }}
                  onDragLeave={() => setDragGerber(false)}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault()
                    setDragGerber(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) void loadGerberFile(f)
                  }}
                >
                  <button className="pcb-load-btn" onClick={() => gerberRef.current?.click()}>
                    Load Gerber (copper)…
                  </button>
                  <span className="pcb-drop-hint">or drop a .gbr / .gtl file</span>
                  <input
                    ref={gerberRef}
                    className="pcb-load-input"
                    type="file"
                    accept={GERBER_ACCEPT}
                    onChange={onGerberInput}
                  />
                </div>
                {gerberInfo?.error && <div className="pcb-error">Gerber: {gerberInfo.error}</div>}
                {gerberInfo?.text && <div className="pcb-info">{gerberInfo.text}</div>}
                {gerberInfo && gerberInfo.warnings.length > 0 && (
                  <ul className="pcb-warnings">
                    {gerberInfo.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}

                <div
                  className={'pcb-drop' + (dragDrill ? ' pcb-dragover' : '')}
                  onDragOver={(e: DragEvent) => {
                    e.preventDefault()
                    setDragDrill(true)
                  }}
                  onDragLeave={() => setDragDrill(false)}
                  onDrop={(e: DragEvent) => {
                    e.preventDefault()
                    setDragDrill(false)
                    const f = e.dataTransfer.files?.[0]
                    if (f) void loadExcellonFile(f)
                  }}
                >
                  <button className="pcb-load-btn" onClick={() => excellonRef.current?.click()}>
                    Load Excellon (drill)…
                  </button>
                  <span className="pcb-drop-hint">or drop a .drl / .xln file</span>
                  <input
                    ref={excellonRef}
                    className="pcb-load-input"
                    type="file"
                    accept={EXCELLON_ACCEPT}
                    onChange={onExcellonInput}
                  />
                </div>
                {drillInfo?.error && <div className="pcb-error">Excellon: {drillInfo.error}</div>}
                {drillInfo?.text && <div className="pcb-info">{drillInfo.text}</div>}
                {drillInfo && drillInfo.warnings.length > 0 && (
                  <ul className="pcb-warnings">
                    {drillInfo.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </section>

        {/* ---- 2. Detected layers ---- */}
        {layers.length > 0 && (
          <section className="pcb-section">
            <h3>2 · Layers — press ▶ to run</h3>
            <div className="pcb-section-body">
              {pkgName && <div className="pcb-info">{pkgName}</div>}
              {unknownCount > 0 && (
                <div className="pcb-warnings-inline">
                  {unknownCount} file{unknownCount === 1 ? '' : 's'} unrecognised — set a role below.
                </div>
              )}

              <div className="pcb-layer-table-wrap">
                <table className="pcb-layer-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Role</th>
                      <th>Summary</th>
                      <th className="pcb-col-run">Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {layers.map((row) => {
                      const auto = detectLayerRole(row.name)
                      const reassigned = row.role !== auto
                      const stage = ROLE_STAGE[row.role]
                      const runnable = !!stage && !row.parseError
                      const verb = stage ? STAGE_VERB[stage] : ''
                      return (
                        <tr
                          key={row.id}
                          className={
                            (row.role === 'Unknown' ? 'pcb-row-unknown' : '') +
                            (row.parseError ? ' pcb-row-error' : '')
                          }
                        >
                          <td className="pcb-cell-name" title={row.name}>
                            {row.name}
                          </td>
                          <td className="pcb-cell-role">
                            <select
                              className="pcb-role-select"
                              value={row.role}
                              onChange={(e) => changeRole(row.id, e.target.value as LayerRole)}
                              title={reassigned ? `Auto-detected: ${layerRoleLabel(auto)}` : undefined}
                            >
                              {LAYER_ROLES.map((r) => (
                                <option key={r.role} value={r.role}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td
                            className={'pcb-cell-summary' + (row.parseError ? ' pcb-cell-bad' : '')}
                            title={row.summary}
                          >
                            {row.summary}
                          </td>
                          <td className="pcb-cell-run">
                            <div className="pcb-row-actions">
                              <button
                                className="pcb-icon-btn"
                                disabled={!runnable}
                                onClick={() => previewRow(row)}
                                title={
                                  runnable
                                    ? `Preview ${verb} in the Visualizer`
                                    : 'No machining operation for this role'
                                }
                                aria-label={`Preview ${row.name}`}
                              >
                                👁
                              </button>
                              <button
                                className="pcb-icon-btn pcb-icon-play"
                                disabled={!runnable || !connected}
                                onClick={() => playRow(row)}
                                title={
                                  !runnable
                                    ? 'No machining operation for this role'
                                    : !connected
                                    ? 'Connect to the machine to run'
                                    : `RUN ${verb} on the machine`
                                }
                                aria-label={`Run ${row.name} on the machine`}
                              >
                                ▶
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="pcb-legend">
                <span className="pcb-kbd">👁</span> preview in the 3D Visualizer ·{' '}
                <span className="pcb-kbd">▶</span> stream to the machine. Adjust the cut in
                Advanced below.
              </p>
            </div>
          </section>
        )}

        {/* ---- 3. Essentials (always handy) ---- */}
        <section className="pcb-section">
          <h3>3 · Essentials</h3>
          <div className="pcb-section-body">
            <div className="pcb-zmode">
              <button
                className={params.zmode === 'spindle' ? 'active' : ''}
                onClick={() => set('zmode', 'spindle')}
              >
                Spindle (mill)
              </button>
              <button
                className={params.zmode === 'pen' ? 'active' : ''}
                onClick={() => set('zmode', 'pen')}
              >
                Pen (plotter)
              </button>
            </div>
            <div className="pcb-grid">
              <Field label="Tool Ø (mm)">
                <input type="number" step="0.05" min="0.05" value={params.toolDia} onChange={num('toolDia')} />
              </Field>
              <Field label="Safe Z (mm)">
                <input type="number" step="0.5" value={params.safeZ} onChange={num('safeZ')} />
              </Field>
            </div>
            <p className="pcb-hint">
              These apply to every operation. Fine-tune passes, depths and feeds under Advanced.
            </p>
          </div>
        </section>

        {/* ---- 4. Advanced (collapsed): stage, exact CAM params, manual generate ---- */}
        <section className="pcb-section">
          <button
            className="pcb-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            {showAdvanced ? '▾' : '▸'} Advanced — stage, depths &amp; feeds
          </button>
          {showAdvanced && (
            <div className="pcb-section-body">
              {/* Operation stage */}
              <div className="pcb-subhead">Operation stage</div>
              <div className="pcb-stages">
                {stageMeta.map((s) => (
                  <button
                    key={s.id}
                    className={'pcb-stage-btn' + (activeStage === s.id ? ' active' : '')}
                    onClick={() => setActiveStage(s.id)}
                    title={s.ready ? s.note : 'Required layer not assigned'}
                  >
                    {s.label}
                    {!s.ready && <span className="pcb-stage-missing"> ⚠</span>}
                  </button>
                ))}
              </div>
              {(() => {
                const cur = stageMeta.find((s) => s.id === activeStage)
                return cur?.ready && cur.note ? (
                  <div className="pcb-info">Cutout: {cur.note}.</div>
                ) : null
              })()}

              {/* Feeds (+ spindle) */}
              <div className="pcb-subhead">Feeds</div>
              <div className="pcb-grid">
                <Field label="Feed XY (mm/min)">
                  <input type="number" step="10" min="1" value={params.feedXY} onChange={num('feedXY')} />
                </Field>
                <Field label="Feed Z (mm/min)">
                  <input type="number" step="10" min="1" value={params.feedZ} onChange={num('feedZ')} />
                </Field>
                {params.zmode === 'spindle' && (
                  <Field label="Spindle (rpm)">
                    <input type="number" step="500" min="0" value={params.rpm} onChange={num('rpm')} />
                  </Field>
                )}
              </div>

              {/* Stage-specific params */}
              <div className="pcb-subhead">{stageMeta.find((s) => s.id === activeStage)?.label} parameters</div>
              {activeStage === 'isolation' && (
                <div className="pcb-grid">
                  <Field label="Isolation passes">
                    <input type="number" step="1" min="1" max="8" value={params.passes} onChange={num('passes')} />
                  </Field>
                  <Field label="Pass stepover (mm)">
                    <input type="number" step="0.05" min="0.05" value={params.stepover} onChange={num('stepover')} />
                  </Field>
                  <Field label="Copper cut Z (mm)">
                    <input type="number" step="0.01" max="0" value={params.copperZ} onChange={num('copperZ')} />
                  </Field>
                </div>
              )}
              {activeStage === 'drill' && (
                <div className="pcb-grid">
                  <Field label="Drill Z (mm)">
                    <input type="number" step="0.1" max="0" value={params.drillZ} onChange={num('drillZ')} />
                  </Field>
                  <Field label="Peck depth (mm, 0 = off)">
                    <input type="number" step="0.1" min="0" value={params.peckDepth} onChange={num('peckDepth')} />
                  </Field>
                </div>
              )}
              {activeStage === 'cutout' && (
                <div className="pcb-grid">
                  <Field label="Cutout depth (mm)">
                    <input type="number" step="0.1" min="0.1" value={params.cutoutDepth} onChange={num('cutoutDepth')} />
                  </Field>
                  <Field label="Holding tabs (0 = none)">
                    <input type="number" step="1" min="0" max="12" value={params.tabs} onChange={num('tabs')} />
                  </Field>
                  <Field label="Tab width (mm)">
                    <input type="number" step="0.5" min="0.5" value={params.tabWidth} onChange={num('tabWidth')} />
                  </Field>
                </div>
              )}

              {/* Manual generate for the active stage */}
              <div className="pcb-generate">
                <button className="primary" onClick={() => sendStage(activeStage)}>
                  Generate {activeStage} → Program
                </button>
                <span className="pcb-hint">
                  Sends the active stage to the program store (same as a layer ▶, without
                  streaming).
                </span>
              </div>
            </div>
          )}
        </section>

        {/* ---- Output: status + collapsed raw G-code ---- */}
        {(status || lastGcode) && (
          <section className="pcb-section">
            <h3>Output</h3>
            <div className="pcb-section-body">
              {status && <div className="pcb-status">{status}</div>}
              {lastGcode && (
                <div className="pcb-gcode">
                  <button
                    className="pcb-gcode-toggle"
                    onClick={() => setShowGcode((v) => !v)}
                    aria-expanded={showGcode}
                  >
                    {showGcode ? '▾' : '▸'} G-code — {lastGcode.name}
                    <span className="pcb-gcode-meta">
                      {lastGcode.text.split('\n').length} lines
                    </span>
                  </button>
                  {showGcode && (
                    <pre className="pcb-gcode-text" aria-label="generated g-code">
                      {lastGcode.text}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="pcb-field">
      <span>{label}</span>
      {children}
    </label>
  )
}
