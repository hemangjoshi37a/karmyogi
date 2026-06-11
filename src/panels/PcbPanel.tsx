import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { useProgram, useMachine } from '../store'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { importGerber, GerberData } from '../core/gerber'
import { importExcellon, ExcellonData } from '../core/excellon'
import { isolationRoutes, drillHits, boardCutout, boardOutlinePolygon } from '../core/pcbCam'
import { makeRect } from '../core/geometry'
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
import { Icon } from '../components/Icons'
import { IconButton } from '../components/IconButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import '../styles/pcb.css'

/** Single canonical program section for ALL PCB output (preview / play / generate).
 *  Using ONE name means each push REPLACES the previous one — the operator never
 *  accumulates stale stages, and what shows in the Visualizer == what runs. */
const PCB_SECTION = 'pcb'

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
type TFn = (key: string, english: string, vars?: Record<string, string | number>) => string

/** Localised verb describing each stage's operation, used in status messages. */
function stageVerb(t: TFn, stage: StageId): string {
  switch (stage) {
    case 'isolation':
      return t('pcb.verb.isolation', 'isolation routing')
    case 'drill':
      return t('pcb.verb.drill', 'drilling')
    case 'cutout':
      return t('pcb.verb.cutout', 'board cutout')
  }
}

/** Localised noun label for a stage — translated BEFORE being interpolated into
 *  status/title strings (so we never inject a raw English/enum id). */
function stageLabel(t: TFn, stage: StageId): string {
  switch (stage) {
    case 'isolation':
      return t('pcb.stage.isolation', 'Isolation')
    case 'drill':
      return t('pcb.stage.drilling', 'Drilling')
    case 'cutout':
      return t('pcb.stage.cutout', 'Cutout')
  }
}

/** The tool the operator must fit for each stage (for the run-all checklist). */
function stageTool(t: TFn, stage: StageId): string {
  switch (stage) {
    case 'isolation':
      return t('pcb.tool.isolation', 'V-bit / engraving tool for isolation')
    case 'drill':
      return t('pcb.tool.drill', 'drill bit matching the hole size')
    case 'cutout':
      return t('pcb.tool.cutout', 'end mill for the board cutout')
  }
}

/** Fixed CAM order for a full run: isolate copper, drill holes, cut the board out. */
const STAGE_ORDER: StageId[] = ['isolation', 'drill', 'cutout']

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

/**
 * The serializable PCB document written by Save / read by Load. Holds the CAM
 * params, the active stage, and the per-file role assignments (keyed by file
 * name). Gerber/Excellon file CONTENTS are not embedded — on load, roles are
 * re-applied to whatever package is currently loaded by matching file names.
 */
interface PcbDoc {
  kind: 'karmyogi.pcb'
  version: 1
  params: Params
  activeStage: StageId
  /** Map of layer file name → assigned role. */
  roles: Record<string, LayerRole>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f

const VALID_ROLES: LayerRole[] = LAYER_ROLES.map((r) => r.role)
const VALID_STAGES: StageId[] = ['isolation', 'drill', 'cutout']

/** Narrow unknown into valid Params, falling back per-field to `base`. */
function parsePcbParams(v: unknown, base: Params): Params {
  if (!isRecord(v)) return base
  const zmode = v.zmode === 'spindle' || v.zmode === 'pen' ? v.zmode : base.zmode
  return {
    zmode,
    toolDia: numOr(v.toolDia, base.toolDia),
    passes: numOr(v.passes, base.passes),
    stepover: numOr(v.stepover, base.stepover),
    safeZ: numOr(v.safeZ, base.safeZ),
    copperZ: numOr(v.copperZ, base.copperZ),
    drillZ: numOr(v.drillZ, base.drillZ),
    peckDepth: numOr(v.peckDepth, base.peckDepth),
    cutoutDepth: numOr(v.cutoutDepth, base.cutoutDepth),
    tabs: numOr(v.tabs, base.tabs),
    tabWidth: numOr(v.tabWidth, base.tabWidth),
    feedXY: numOr(v.feedXY, base.feedXY),
    feedZ: numOr(v.feedZ, base.feedZ),
    rpm: numOr(v.rpm, base.rpm),
  }
}

/**
 * Parsed geometry for a row, cached on the row so a file is parsed exactly ONCE
 * (in {@link makeRow} / {@link changeRole}) and reused everywhere — the summary,
 * the `resolved` stage inputs, and per-row Preview/Play. `kind` follows the row's
 * role at parse time; an error means the file failed to parse for that role.
 */
type ParsedGeom =
  | { kind: 'copper'; data: GerberData }
  | { kind: 'drill'; data: ExcellonData }
  | { kind: 'outline'; data: GerberData }
  | { kind: 'none' } // role with no CAM op (Ignore/Unknown)
  | { kind: 'error'; error: string }

/** A layer file in the mapping table, with a one-line parse summary + cached geometry. */
interface LayerRow extends PackageEntry {
  /** Stable id for React keys / role edits. */
  id: string
  /** Short human summary (geometry counts) or parse error. */
  summary: string
  parseError?: boolean
  /** Geometry parsed ONCE for the current role (memoised on the row). */
  parsed: ParsedGeom
}

const bytesLabel = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`)

// Parse an entry's file ONCE for its current role and build both the cached
// geometry and the one-line table summary. Called only when a row is created or
// its role changes — never during render — so files aren't re-parsed per frame.
function parseEntry(t: TFn, e: PackageEntry): { parsed: ParsedGeom; summary: string; parseError?: boolean } {
  if (e.role === 'Drill') {
    const res = importExcellon(e.text)
    if (!res.ok) {
      const error = res.error ?? t('pcb.summary.parseError', 'parse error')
      return { parsed: { kind: 'error', error }, summary: error, parseError: true }
    }
    return {
      parsed: { kind: 'drill', data: res.data },
      summary: t('pcb.summary.drill', '{hits} hits, {tools} tools', {
        hits: res.data.hits.length,
        tools: res.data.toolDiameters().length,
      }),
    }
  }
  if (e.role === 'CopperTop' || e.role === 'CopperBottom' || e.role === 'BoardOutline') {
    const res = importGerber(e.text)
    if (!res.ok) {
      const error = res.error ?? t('pcb.summary.parseError', 'parse error')
      return { parsed: { kind: 'error', error }, summary: error, parseError: true }
    }
    const b = res.data.bounds()
    return {
      parsed: { kind: e.role === 'BoardOutline' ? 'outline' : 'copper', data: res.data },
      summary: t('pcb.summary.gerber', '{tr}tr {pad}pad {rgn}rgn · {w}×{h}mm', {
        tr: res.data.traces.length,
        pad: res.data.pads.length,
        rgn: res.data.regions.length,
        w: b.width().toFixed(1),
        h: b.height().toFixed(1),
      }),
    }
  }
  return { parsed: { kind: 'none' }, summary: bytesLabel(e.size) }
}

function makeRow(t: TFn, e: PackageEntry, idx: number): LayerRow {
  const { parsed, summary, parseError } = parseEntry(t, e)
  return { ...e, id: `${idx}-${e.name}`, summary, parseError, parsed }
}

/** Re-parse a row for a new role (used by changeRole / loadPcbDoc remap). */
function rowWithRole(t: TFn, row: LayerRow, role: LayerRole): LayerRow {
  const updated: PackageEntry = { ...row, role }
  const { parsed, summary, parseError } = parseEntry(t, updated)
  return { ...row, role, summary, parseError, parsed }
}

/** Geometry resolved for a single layer row, ready to feed a CAM op (reuses the
 *  cached parse — no re-parsing). */
type RowGeom =
  | { kind: 'copper'; data: GerberData }
  | { kind: 'drill'; data: ExcellonData }
  | { kind: 'outline'; data: GerberData }

function rowGeometry(t: TFn, row: LayerRow): RowGeom | { error: string } {
  const stage = ROLE_STAGE[row.role]
  if (!stage) return { error: t('pcb.error.noOperation', 'This layer role has no machining operation.') }
  const p = row.parsed
  if (p.kind === 'error') return { error: p.error }
  if (p.kind === 'drill') return { kind: 'drill', data: p.data }
  if (p.kind === 'copper') return { kind: 'copper', data: p.data }
  if (p.kind === 'outline') return { kind: 'outline', data: p.data }
  return { error: t('pcb.error.noOperation', 'This layer role has no machining operation.') }
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
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)
  const connected = useMachine((s) => s.connection === 'connected')
  const machineState = useMachine((s) => s.state)

  // The machine is "busy" while a program is streaming OR GRBL reports Run/Hold;
  // running another job on top would corrupt the active stream. Used to gate
  // every Play / streamed-generate affordance below.
  const machineBusy = streaming || machineState === 'Run' || machineState === 'Hold'

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
  // The single status line. `statusError` routes the message to .pcb-error
  // (red/danger) styling rather than the green .pcb-status success styling.
  const [status, setStatus] = useState<string>('')
  const [statusError, setStatusError] = useState(false)

  // Report a success message (green) or a failure (red). `setStatus` is reserved
  // for clearing ('') and for SaveLoadButtons' onError (treated as an error).
  const ok = (msg: string) => {
    setStatusError(false)
    setStatus(msg)
  }
  const fail = (msg: string) => {
    setStatusError(true)
    setStatus(msg)
  }

  // Advanced section is collapsed by default — beginners drive the layer table.
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Last generated G-code, shown in a collapsible (collapsed by default) preview.
  const [lastGcode, setLastGcode] = useState<{ name: string; text: string } | null>(null)
  const [showGcode, setShowGcode] = useState(false)

  // Run-gate: the row whose Play has been "armed" (a styled hold-to-run affordance
  // that replaces the native window.confirm). Confirming it streams; arming any
  // other row (or generating elsewhere) cancels a previous arm.
  const [armedRunId, setArmedRunId] = useState<string | null>(null)

  function set<K extends keyof Params>(key: K, value: Params[K]) {
    setParams((p) => ({ ...p, [key]: value }))
  }
  // Numeric input handler with clamping. A blank/non-numeric value keeps the
  // PREVIOUS value (instead of silently coercing to 0, which would, e.g., make a
  // cut depth or tool diameter zero); finite values are clamped to [min, max].
  function num(key: keyof Params, min?: number, max?: number) {
    return (e: ChangeEvent<HTMLInputElement>) => {
      const v = parseFloat(e.target.value)
      if (!Number.isFinite(v)) return // blank/garbage: leave the field unchanged
      let clamped = v
      if (min != null && clamped < min) clamped = min
      if (max != null && clamped > max) clamped = max
      set(key, clamped as Params[typeof key])
    }
  }

  // ---- ZIP handling ----
  async function loadZip(file: File) {
    setPkgError('')
    setStatus('')
    setStatusError(false)
    setArmedRunId(null)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      const entries = unzipGerberPackage(buf)
      setLayers(entries.map((e, idx) => makeRow(t, e, idx)))
      setPkgName(
        entries.length === 1
          ? t('pcb.pkg.name_one', '{file} — {count} layer file', {
              file: file.name,
              count: entries.length,
            })
          : t('pcb.pkg.name_other', '{file} — {count} layer files', {
              file: file.name,
              count: entries.length,
            }),
      )
    } catch (err) {
      const msg =
        err instanceof GerberPackageError
          ? err.message
          : t('pcb.pkg.readError', 'Failed to read ZIP: {detail}', {
              detail: err instanceof Error ? err.message : String(err),
            })
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
    setArmedRunId(null)
    setLayers((rows) => rows.map((r) => (r.id === id ? rowWithRole(t, r, role) : r)))
  }

  // Clear the whole package back to the empty state (TASK: Clear package reset).
  function clearPackage() {
    setLayers([])
    setPkgName('')
    setPkgError('')
    setStatus('')
    setStatusError(false)
    setArmedRunId(null)
    setLastGcode(null)
    // Drop our (single canonical) section from the program store too, so the
    // Visualizer/Program tab don't keep showing a now-orphaned PCB program.
    removeSection(PCB_SECTION)
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
      text: t(
        'pcb.single.gerberInfo',
        '{file}: {traces} traces, {pads} pads, {regions} regions; {w} × {h} mm',
        {
          file: file.name,
          traces: res.data.traces.length,
          pads: res.data.pads.length,
          regions: res.data.regions.length,
          w: b.width().toFixed(2),
          h: b.height().toFixed(2),
        },
      ),
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
      text: t('pcb.single.drillInfo', '{file}: {hits} hits, {tools} distinct tools', {
        file: file.name,
        hits: res.data.hits.length,
        tools: res.data.toolDiameters().length,
      }),
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
    // NOTE: `Tool.stepover` is the documented 0..1 fraction (used by pocketing);
    // we leave it at the library default. The PCB "Pass stepover (mm)" field is a
    // METRIC value passed EXPLICITLY to isolationRoutes() instead (see below), so
    // the unit contract is unambiguous and a sub-mm value is never mistaken for a
    // fraction of the (tiny) tool diameter.
    return defaultTool({
      diameter: params.toolDia,
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
        return {
          error: t(
            'pcb.error.assignCopper',
            'Assign a Copper Top/Bottom layer (or load a Gerber) for isolation routing.',
          ),
        }
      tp = isolationRoutes(geom.copper, tool, params.safeZ, params.copperZ, params.passes, params.stepover)
    } else if (stage === 'drill') {
      if (!geom.drillData)
        return {
          error: t('pcb.error.assignDrill', 'Assign a Drill layer (or load an Excellon file) for drilling.'),
        }
      tp = drillHits(geom.drillData, params.safeZ, params.drillZ, params.peckDepth)
    } else {
      // Cutout: prefer an assigned Board Outline layer; fall back to copper.
      const source = geom.outline ?? geom.copper
      if (!source)
        return {
          error: t(
            'pcb.error.assignOutline',
            'Assign a Board Outline or Copper layer to derive the cutout outline.',
          ),
        }
      // Use the real outline polygon (stitched from the edge-cuts traces/region)
      // when we can derive one; otherwise fall back to the bounding rectangle.
      let outline = boardOutlinePolygon(source)
      if (!outline || outline.points.length < 3) {
        const b = source.bounds()
        if (!b.isValid())
          return { error: t('pcb.error.emptyBounds', 'Layer bounds are empty; cannot derive cutout outline.') }
        outline = makeRect(b.min, b.width(), b.height())
      }
      tp = boardCutout(outline, tool, params.safeZ, params.cutoutDepth, params.tabs, params.tabWidth)
    }
    if (tp.isEmpty()) return { error: t('pcb.error.noToolpath', 'No toolpath produced for this stage.') }
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
  // REUSES each row's cached `parsed` geometry — no file is re-parsed here.
  const resolved = useMemo(() => {
    const copperRow = rowFor('CopperTop') ?? rowFor('CopperBottom')
    let copper: GerberData | null = null
    if (copperRow && copperRow.parsed.kind === 'copper') copper = copperRow.parsed.data
    if (!copper) copper = singleGerber

    const drillRow = rowFor('Drill')
    let drillData: ExcellonData | null = null
    if (drillRow && drillRow.parsed.kind === 'drill') drillData = drillRow.parsed.data
    if (!drillData) drillData = singleDrill

    const outlineRow = rowFor('BoardOutline')
    let outline: GerberData | null = null
    if (outlineRow && outlineRow.parsed.kind === 'outline') outline = outlineRow.parsed.data

    return { copper, drillData, outline }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, singleGerber, singleDrill])

  // Push G-code into the SINGLE canonical PCB section (replacing whatever was
  // there) and mirror it into the collapsible preview, then return the program
  // store's BAKED (placement-applied) lines. Streaming these guarantees
  // what-shows == what-runs (WYSIWYG): both the Visualizer and the machine get
  // the same placed program, never a divergent raw split. `label` is the
  // human-readable program name shown in the G-code preview header.
  function pushProgram(gcode: string, label: string): string[] {
    setProgram(PCB_SECTION, gcode)
    // After setProgram, the store has re-baked `lines` (placement applied). Read
    // them back so the preview text and the streamed lines are the SAME source.
    const baked = useProgram.getState().lines
    const text = baked.join('\n')
    setLastGcode({ name: label, text })
    return baked.filter((l) => l.length > 0)
  }

  // Generate a (global) stage and push it to the program store (NOT streamed).
  function sendStage(stage: StageId) {
    const res = buildGcode(stage, resolved)
    if ('error' in res) {
      fail(res.error)
      setLastGcode(null)
      return
    }
    setArmedRunId(null)
    pushProgram(res.gcode, `pcb-${stage}.nc`)
    ok(
      t('pcb.status.sentStage', 'Sent {stage} to program: {moves} moves, cut {mm} mm.', {
        stage: stageLabel(t, stage),
        moves: res.tp.size(),
        mm: res.tp.cutLength().toFixed(1),
      }),
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
    if (!stage) return { error: t('pcb.error.noOperation', 'This layer role has no machining operation.') }
    const g = rowGeometry(t, row)
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
    setArmedRunId(null)
    const res = buildRowGcode(row)
    if ('error' in res) {
      fail(t('pcb.status.rowError', '{name}: {error}', { name: row.name, error: res.error }))
      return
    }
    pushProgram(res.gcode, res.name)
    ok(
      t(
        'pcb.status.preview',
        'Preview {verb} for {name}: {moves} moves, cut {mm} mm. Shown in Visualizer.',
        {
          verb: stageVerb(t, res.stage),
          name: row.name,
          moves: res.tp.size(),
          mm: res.tp.cutLength().toFixed(1),
        },
      ),
    )
  }

  // Tapping Play ARMS the row (a styled, in-panel confirm — no native dialog).
  // A second tap on the now-armed control actually streams it.
  function playRow(row: LayerRow) {
    if (!connected) {
      fail(t('pcb.status.connectFirst', 'Connect to the machine before running a layer.'))
      return
    }
    if (machineBusy) {
      fail(t('pcb.status.busy', 'Machine is busy (running/paused) — wait for the current job to finish.'))
      return
    }
    // Always show the layer in the Visualizer first (WYSIWYG), then arm.
    const res = buildRowGcode(row)
    if ('error' in res) {
      fail(t('pcb.status.rowError', '{name}: {error}', { name: row.name, error: res.error }))
      return
    }
    pushProgram(res.gcode, res.name)
    setArmedRunId(row.id)
    ok(
      t('pcb.status.armed', 'Armed {verb} for {name} — {moves} moves, {mm} mm. Confirm to run.', {
        verb: stageVerb(t, res.stage),
        name: row.name,
        moves: res.tp.size(),
        mm: res.tp.cutLength().toFixed(1),
      }),
    )
  }

  // Confirm the armed run: re-check the gate, push the canonical section, and
  // stream the program store's BAKED lines so what-shows == what-runs.
  function confirmRunRow(row: LayerRow) {
    setArmedRunId(null)
    if (!connected || machineBusy) {
      fail(t('pcb.status.busy', 'Machine is busy (running/paused) — wait for the current job to finish.'))
      return
    }
    const res = buildRowGcode(row)
    if ('error' in res) {
      fail(t('pcb.status.rowError', '{name}: {error}', { name: row.name, error: res.error }))
      return
    }
    const lines = pushProgram(res.gcode, res.name)
    grbl.startProgram(lines)
    ok(
      t('pcb.status.streaming', 'Streaming {verb} for {name} — {lines} lines.', {
        verb: stageVerb(t, res.stage),
        name: row.name,
        lines: lines.length,
      }),
    )
  }

  const hasCopper = !!resolved.copper
  const hasDrill = !!resolved.drillData
  const hasOutline = !!resolved.outline

  // Board extents (mm) — prefer the outline layer, else copper — for the summary.
  const boardSize = useMemo(() => {
    const src = resolved.outline ?? resolved.copper
    if (!src) return null
    const b = src.bounds()
    if (!b.isValid()) return null
    return { w: b.width(), h: b.height() }
  }, [resolved])
  const drillTools = resolved.drillData ? resolved.drillData.toolDiameters().length : 0
  const drillHitsCount = resolved.drillData ? resolved.drillData.hits.length : 0

  const stageReady: Record<StageId, boolean> = {
    isolation: hasCopper,
    drill: hasDrill,
    cutout: hasOutline || hasCopper,
  }
  const stageMeta: { id: StageId; label: string; ready: boolean; note?: string }[] = [
    { id: 'isolation', label: t('pcb.stage.isolation', 'Isolation'), ready: stageReady.isolation },
    { id: 'drill', label: t('pcb.stage.drilling', 'Drilling'), ready: stageReady.drill },
    {
      id: 'cutout',
      label: t('pcb.stage.cutout', 'Cutout'),
      ready: stageReady.cutout,
      note: hasOutline
        ? undefined
        : hasCopper
        ? t('pcb.stage.usingCopperBounds', 'using copper bounds')
        : undefined,
    },
  ]

  // The stages that CAN run (in fixed CAM order) given the assigned layers.
  const readyStages = STAGE_ORDER.filter((s) => stageReady[s])

  // ---- Run all ready stages in sequence ----
  // Build ONE program that runs each ready stage back-to-back, pausing (M0) before
  // each so the operator can fit the right tool / re-zero. Streams the BAKED lines
  // from the single canonical section, so the Visualizer shows the full sequence.
  function buildAllStagesGcode(): { gcode: string; stages: StageId[]; moves: number } | { error: string } {
    const parts: string[] = []
    let totalMoves = 0
    const done: StageId[] = []
    for (const stage of readyStages) {
      const res = buildGcode(stage, resolved)
      if ('error' in res) continue // skip a stage that produced nothing
      // A pause + comment between stages so the operator can change the tool.
      if (parts.length > 0) {
        parts.push('M0 (tool change — fit ' + stageTool(t, stage).replace(/[()]/g, '') + ')')
      }
      parts.push(`(— ${stageLabel(t, stage)} —)`)
      parts.push(res.gcode.trimEnd())
      totalMoves += res.tp.size()
      done.push(stage)
    }
    if (done.length === 0) return { error: t('pcb.error.noStages', 'No stages are ready to run. Assign layers first.') }
    return { gcode: parts.join('\n'), stages: done, moves: totalMoves }
  }

  function previewAllStages() {
    setArmedRunId(null)
    const res = buildAllStagesGcode()
    if ('error' in res) {
      fail(res.error)
      return
    }
    pushProgram(res.gcode, 'pcb-all.nc')
    ok(
      t('pcb.status.previewAll', 'Preview all {n} stages — {moves} moves. Shown in Visualizer.', {
        n: res.stages.length,
        moves: res.moves,
      }),
    )
  }

  function runAllStages() {
    setArmedRunId(null)
    if (!connected || machineBusy) {
      fail(t('pcb.status.busy', 'Machine is busy (running/paused) — wait for the current job to finish.'))
      return
    }
    const res = buildAllStagesGcode()
    if ('error' in res) {
      fail(res.error)
      return
    }
    const lines = pushProgram(res.gcode, 'pcb-all.nc')
    grbl.startProgram(lines)
    ok(
      t('pcb.status.streamingAll', 'Streaming all {n} stages — {lines} lines. Pauses (M0) between stages for tool changes.', {
        n: res.stages.length,
        lines: lines.length,
      }),
    )
  }

  // Counts for the package summary banner.
  const roleCounts = useMemo(() => {
    const c = new Map<LayerRole, number>()
    for (const r of layers) c.set(r.role, (c.get(r.role) ?? 0) + 1)
    return c
  }, [layers])
  const unknownCount = roleCounts.get('Unknown') ?? 0

  // Common filename prefix (e.g. "devansuh_project_torch - CADCAM ") — stripped
  // for display so the meaningful per-layer suffix is readable in the narrow
  // column. The full name is kept in the cell's title tooltip.
  const namePrefix = useMemo(() => {
    if (layers.length < 2) return ''
    let p = layers[0].name
    for (const r of layers) {
      let i = 0
      while (i < p.length && i < r.name.length && p[i] === r.name[i]) i++
      p = p.slice(0, i)
      if (!p) break
    }
    // Only strip up to a sensible separator so we don't cut mid-word.
    const m = p.match(/^(.*[ \-_/])/)
    return m ? m[1] : ''
  }, [layers])
  const shortName = (n: string) => (namePrefix && n.startsWith(namePrefix) ? n.slice(namePrefix.length) : n)

  // ---- Save / Load document (params + role assignments; no file contents) --
  const pcbDoc: PcbDoc = {
    kind: 'karmyogi.pcb',
    version: 1,
    params,
    activeStage,
    roles: Object.fromEntries(layers.map((r) => [r.name, r.role])),
  }

  function loadPcbDoc(data: unknown) {
    if (!isRecord(data)) {
      fail(t('pcb.load.bad', 'Could not load — not a valid PCB settings file.'))
      return
    }
    setArmedRunId(null)
    setParams((p) => parsePcbParams(data.params, p))
    if (VALID_STAGES.includes(data.activeStage as StageId)) {
      setActiveStage(data.activeStage as StageId)
    }
    // Re-apply role assignments to the currently-loaded layers by file name.
    let remapped = 0
    if (isRecord(data.roles)) {
      const roles = data.roles
      setLayers((rows) =>
        rows.map((r) => {
          const role = roles[r.name]
          if (typeof role !== 'string' || !VALID_ROLES.includes(role as LayerRole)) return r
          remapped++
          return rowWithRole(t, r, role as LayerRole)
        }),
      )
    }
    ok(
      layers.length === 0
        ? t('pcb.load.paramsOnly', 'Loaded PCB settings. Upload a Gerber ZIP to apply the saved layer roles.')
        : t('pcb.load.applied', 'Loaded PCB settings — re-applied {n} layer roles.', { n: remapped }),
    )
  }

  // ---- colour-coded setting PRESETS (CAM params only — NOT the layer files /
  // role assignments, which are the operator's actual board). Scoped to its own
  // persistence key, independent of the carving / soldering / writing presets.
  // capture() snapshots the current Params; onApply() restores them, reusing the
  // same defensive parsePcbParams() so a corrupt persisted slot can never feed a
  // NaN into the emitter. The settings-only Save/Load pair lives in the bar's
  // `extra` slot; the toolbar SaveLoadButtons (params + roles) stays as-is.
  const applyPcbParams = (p: unknown) => setParams((prev) => parsePcbParams(p, prev))
  const presets = usePresets<Params>({
    storageKey: 'karmyogi.pcb.presets',
    capture: () => ({ ...params }),
    onApply: applyPcbParams,
  })

  return (
    <div className="cc-presets-host">
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('pcb.presets.aria', 'PCB setting presets')}
      />
    <div className="pcb-panel">
      <div className="pcb-scroll">
        {/* ---- 1. Upload package (primary action) ---- */}
        <section className="pcb-section pcb-section-wide">
          <h3>{t('pcb.upload.title', '1 · Upload Gerber ZIP')}</h3>
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
                <Icon name="upload" size={16} className="pcb-btn-icon" />
                {t('pcb.upload.button', 'Upload Gerber ZIP…')}
              </button>
              <span className="pcb-drop-hint">{t('pcb.upload.dropHint', 'or drop a .zip export here')}</span>
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
                {t(
                  'pcb.intro.lead',
                  "Drop your board's Gerber/Excellon export ZIP here. Layers are detected automatically — then press ",
                )}
                <span className="pcb-kbd">
                  <Icon name="play" size={11} />
                </span>
                {t('pcb.intro.rest', ' on a layer to run it.')}
              </p>
            )}

            {pkgError && <div className="pcb-error">{pkgError}</div>}

            <button
              className="pcb-toggle-single"
              onClick={() => setShowSingle((s) => !s)}
              aria-expanded={showSingle}
            >
              <Icon name={showSingle ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
              {t('pcb.single.toggle', 'or load individual files')}
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
                    {t('pcb.single.gerberButton', 'Load Gerber (copper)…')}
                  </button>
                  <span className="pcb-drop-hint">{t('pcb.single.gerberDropHint', 'or drop a .gbr / .gtl file')}</span>
                  <input
                    ref={gerberRef}
                    className="pcb-load-input"
                    type="file"
                    accept={GERBER_ACCEPT}
                    onChange={onGerberInput}
                  />
                </div>
                {gerberInfo?.error && (
                  <div className="pcb-error">
                    {t('pcb.single.gerberErrorPrefix', 'Gerber: {error}', { error: gerberInfo.error })}
                  </div>
                )}
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
                    {t('pcb.single.excellonButton', 'Load Excellon (drill)…')}
                  </button>
                  <span className="pcb-drop-hint">{t('pcb.single.excellonDropHint', 'or drop a .drl / .xln file')}</span>
                  <input
                    ref={excellonRef}
                    className="pcb-load-input"
                    type="file"
                    accept={EXCELLON_ACCEPT}
                    onChange={onExcellonInput}
                  />
                </div>
                {drillInfo?.error && (
                  <div className="pcb-error">
                    {t('pcb.single.excellonErrorPrefix', 'Excellon: {error}', { error: drillInfo.error })}
                  </div>
                )}
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
          <section className="pcb-section pcb-section-wide">
            <h3 className="pcb-h3-row">
              <span>{t('pcb.layers.title', '2 · Layers')}</span>
              <IconButton
                className="pcb-clear-btn"
                iconName="trash"
                iconSize={14}
                onClick={clearPackage}
                label={t('pcb.layers.clear', 'Clear package')}
              />
            </h3>
            <div className="pcb-section-body">
              {pkgName && <div className="pcb-info">{pkgName}</div>}

              {/* Canonical at-a-glance readiness: size + which stages are ready. */}
              <div className="pcb-summary">
                {boardSize && (
                  <span className="pcb-chip pcb-chip-dim" title={t('pcb.summary.boardSizeTitle', 'Board extents (mm)')}>
                    <Icon name="frame" size={12} /> {boardSize.w.toFixed(1)} × {boardSize.h.toFixed(1)} mm
                  </span>
                )}
                <span className={'pcb-chip' + (hasCopper ? ' pcb-chip-ok' : ' pcb-chip-off')}>
                  <Icon name={hasCopper ? 'zero' : 'info'} size={12} /> {t('pcb.stage.isolation', 'Isolation')}
                </span>
                <span className={'pcb-chip' + (hasDrill ? ' pcb-chip-ok' : ' pcb-chip-off')}>
                  <Icon name={hasDrill ? 'zero' : 'info'} size={12} /> {t('pcb.stage.drilling', 'Drilling')}
                  {hasDrill ? ` · ${drillHitsCount}/${drillTools}T` : ''}
                </span>
                <span className={'pcb-chip' + (hasOutline || hasCopper ? ' pcb-chip-ok' : ' pcb-chip-off')}>
                  <Icon name={hasOutline || hasCopper ? 'zero' : 'info'} size={12} /> {t('pcb.stage.cutout', 'Cutout')}
                  {!hasOutline && hasCopper ? ` · ${t('pcb.summary.fromCopper', 'from copper')}` : ''}
                </span>
              </div>

              {unknownCount > 0 && (
                <div className="pcb-warnings-inline">
                  {unknownCount === 1
                    ? t('pcb.layers.unrecognised_one', '{count} file unrecognised — set a role below.', {
                        count: unknownCount,
                      })
                    : t('pcb.layers.unrecognised_other', '{count} files unrecognised — set a role below.', {
                        count: unknownCount,
                      })}
                </div>
              )}

              <div className="pcb-layer-table-wrap">
                <table className="pcb-layer-table">
                  <thead>
                    <tr>
                      <th>{t('pcb.layers.col.file', 'File')}</th>
                      <th>{t('pcb.layers.col.role', 'Role')}</th>
                      <th>{t('pcb.layers.col.summary', 'Summary')}</th>
                      <th className="pcb-col-run">{t('pcb.layers.col.run', 'Run')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {layers.map((row) => {
                      const auto = detectLayerRole(row.name)
                      const reassigned = row.role !== auto
                      const stage = ROLE_STAGE[row.role]
                      const runnable = !!stage && !row.parseError
                      const verb = stage ? stageVerb(t, stage) : ''
                      const armed = armedRunId === row.id
                      return (
                        <tr
                          key={row.id}
                          className={
                            (row.role === 'Unknown' ? 'pcb-row-unknown' : '') +
                            (row.parseError ? ' pcb-row-error' : '')
                          }
                        >
                          <td className="pcb-cell-name" title={row.name}>
                            {shortName(row.name)}
                          </td>
                          <td className="pcb-cell-role">
                            <select
                              className="pcb-role-select"
                              value={row.role}
                              onChange={(e) => changeRole(row.id, e.target.value as LayerRole)}
                              title={
                                reassigned
                                  ? t('pcb.layers.autoDetected', 'Auto-detected: {role}', {
                                      role: layerRoleLabel(auto),
                                    })
                                  : undefined
                              }
                            >
                              {LAYER_ROLES.map((r) => (
                                <option key={r.role} value={r.role}>
                                  {t(r.labelKey, r.label)}
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
                              {armed ? (
                                // Styled in-panel arm/confirm (replaces window.confirm).
                                <>
                                  <button
                                    className="pcb-run-confirm"
                                    onClick={() => confirmRunRow(row)}
                                    disabled={machineBusy}
                                    title={t('pcb.layers.confirmRunTitle', 'Confirm — stream to the machine')}
                                  >
                                    <Icon name="play" size={13} />
                                    {t('pcb.layers.confirmRun', 'Run')}
                                  </button>
                                  <IconButton
                                    className="pcb-icon-btn"
                                    iconName="close"
                                    onClick={() => setArmedRunId(null)}
                                    label={t('pcb.layers.cancelRun', 'Cancel run')}
                                  />
                                </>
                              ) : (
                                <>
                                  <IconButton
                                    className="pcb-icon-btn"
                                    iconName="eye"
                                    disabled={!runnable}
                                    onClick={() => previewRow(row)}
                                    label={
                                      runnable
                                        ? `${t('pcb.layers.previewAria', 'Preview {name}', {
                                            name: row.name,
                                          })} — ${t('pcb.layers.previewTitle', 'Preview {verb} in the Visualizer', {
                                            verb,
                                          })}`
                                        : t('pcb.layers.noOpTitle', 'No machining operation for this role')
                                    }
                                  />
                                  <IconButton
                                    className="pcb-icon-btn pcb-icon-play"
                                    iconName="play"
                                    disabled={!runnable || !connected || machineBusy}
                                    onClick={() => playRow(row)}
                                    label={
                                      !runnable
                                        ? t('pcb.layers.noOpTitle', 'No machining operation for this role')
                                        : !connected
                                        ? t('pcb.layers.connectToRunTitle', 'Connect to the machine to run')
                                        : machineBusy
                                        ? t('pcb.layers.busyTitle', 'Machine is busy — wait for the current job')
                                        : `${t('pcb.layers.runAria', 'Run {name} on the machine', {
                                            name: row.name,
                                          })} — ${t('pcb.layers.runTitle', 'RUN {verb} on the machine', { verb })}`
                                    }
                                  />
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <p className="pcb-legend">
                <span className="pcb-kbd">
                  <Icon name="eye" size={11} />
                </span>{' '}
                {t('pcb.legend.preview', 'preview in the 3D Visualizer · ')}
                <span className="pcb-kbd">
                  <Icon name="play" size={11} />
                </span>{' '}
                {t('pcb.legend.stream', 'stream to the machine. Adjust the cut in Advanced below.')}
              </p>

              {/* ---- Run all ready stages in sequence (with tool-change checklist) ---- */}
              {readyStages.length > 0 && (
                <div className="pcb-runall">
                  <div className="pcb-subhead">
                    {t('pcb.runall.title', 'Run all stages in sequence')}
                  </div>
                  <ol className="pcb-runall-list">
                    {readyStages.map((s, i) => (
                      <li key={s}>
                        <span className="pcb-runall-step">{i + 1}.</span>{' '}
                        <b>{stageLabel(t, s)}</b>
                        {' — '}
                        {t('pcb.runall.fit', 'fit {tool}', { tool: stageTool(t, s) })}
                      </li>
                    ))}
                  </ol>
                  <p className="pcb-hint">
                    {t(
                      'pcb.runall.hint',
                      'Runs each ready stage back-to-back, pausing (M0) before each so you can change the tool and re-zero.',
                    )}
                  </p>
                  <div className="pcb-runall-actions">
                    <button className="pcb-load-btn" onClick={previewAllStages}>
                      <Icon name="eye" size={14} className="pcb-btn-icon" />
                      {t('pcb.runall.preview', 'Preview all')}
                    </button>
                    <button
                      className="pcb-load-btn primary"
                      onClick={runAllStages}
                      disabled={!connected || machineBusy}
                      title={
                        !connected
                          ? t('pcb.layers.connectToRunTitle', 'Connect to the machine to run')
                          : machineBusy
                          ? t('pcb.layers.busyTitle', 'Machine is busy — wait for the current job')
                          : t('pcb.runall.runTitle', 'Stream all ready stages in sequence')
                      }
                    >
                      <Icon name="play" size={14} className="pcb-btn-icon" />
                      {t('pcb.runall.run', 'Run all')}
                    </button>
                    {machineBusy && (
                      <span className="pcb-hint">{t('pcb.runall.busy', 'Machine busy')}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {/* ---- 3. Essentials (always handy) ---- */}
        <section className="pcb-section">
          <h3 className="pcb-h3-row">
            <span>{t('pcb.essentials.title', '3 · Essentials')}</span>
            <SaveLoadButtons
              value={pcbDoc}
              onLoad={loadPcbDoc}
              onError={fail}
              fileBase="karmyogi-pcb"
              ext="kpcb"
              saveTitle={t('pcb.save', 'Save PCB settings + layer roles')}
              loadTitle={t('pcb.load', 'Load PCB settings + layer roles')}
            />
          </h3>
          <div className="pcb-section-body">
            <div className="pcb-zmode">
              <button
                className={params.zmode === 'spindle' ? 'active' : ''}
                onClick={() => set('zmode', 'spindle')}
              >
                {t('pcb.essentials.spindle', 'Spindle (mill)')}
              </button>
              <button
                className={params.zmode === 'pen' ? 'active' : ''}
                onClick={() => set('zmode', 'pen')}
              >
                {t('pcb.essentials.pen', 'Pen (plotter)')}
              </button>
            </div>
            <div className="pcb-grid">
              <Field label={t('pcb.essentials.toolDia', 'Tool Ø (mm)')}>
                <input type="number" step="0.05" min="0.05" value={params.toolDia} onChange={num('toolDia', 0.05)} />
              </Field>
              <Field label={t('pcb.essentials.safeZ', 'Safe Z (mm)')}>
                <input type="number" step="0.5" min="0" value={params.safeZ} onChange={num('safeZ', 0)} />
              </Field>
            </div>
            <p className="pcb-hint">
              {t(
                'pcb.essentials.hint',
                'These apply to every operation. Fine-tune passes, depths and feeds under Advanced.',
              )}
            </p>
          </div>
        </section>

        {/* ---- 4. Advanced (collapsed): stage, exact CAM params, manual generate ---- */}
        <section className={'pcb-section' + (showAdvanced ? ' pcb-section-wide' : '')}>
          <button
            className="pcb-advanced-toggle"
            onClick={() => setShowAdvanced((v) => !v)}
            aria-expanded={showAdvanced}
          >
            <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
            {t('pcb.advanced.toggle', 'Advanced — stage, depths & feeds')}
          </button>
          {showAdvanced && (
            <div className="pcb-section-body">
              {/* Operation stage */}
              <div className="pcb-subhead">{t('pcb.advanced.operationStage', 'Operation stage')}</div>
              <div className="pcb-stages">
                {stageMeta.map((s) => (
                  <button
                    key={s.id}
                    className={'pcb-stage-btn' + (activeStage === s.id ? ' active' : '')}
                    onClick={() => setActiveStage(s.id)}
                    title={s.ready ? s.note : t('pcb.advanced.layerNotAssigned', 'Required layer not assigned')}
                  >
                    {s.label}
                    {!s.ready && (
                      <span className="pcb-stage-missing" title={t('pcb.advanced.layerNotAssigned', 'Required layer not assigned')}>
                        {' '}
                        <Icon name="warning" size={12} />
                      </span>
                    )}
                  </button>
                ))}
              </div>
              {(() => {
                const cur = stageMeta.find((s) => s.id === activeStage)
                return cur?.ready && cur.note ? (
                  <div className="pcb-info">
                    {t('pcb.advanced.cutoutNote', 'Cutout: {note}.', { note: cur.note })}
                  </div>
                ) : null
              })()}

              {/* Feeds (+ spindle) */}
              <div className="pcb-subhead">{t('pcb.advanced.feeds', 'Feeds')}</div>
              <div className="pcb-grid">
                <Field label={t('pcb.advanced.feedXY', 'Feed XY (mm/min)')}>
                  <input type="number" step="10" min="1" value={params.feedXY} onChange={num('feedXY', 1)} />
                </Field>
                <Field label={t('pcb.advanced.feedZ', 'Feed Z (mm/min)')}>
                  <input type="number" step="10" min="1" value={params.feedZ} onChange={num('feedZ', 1)} />
                </Field>
                {params.zmode === 'spindle' && (
                  <Field label={t('pcb.advanced.spindleRpm', 'Spindle (rpm)')}>
                    <input type="number" step="500" min="0" value={params.rpm} onChange={num('rpm', 0)} />
                  </Field>
                )}
              </div>

              {/* Stage-specific params */}
              <div className="pcb-subhead">
                {t('pcb.advanced.stageParams', '{stage} parameters', {
                  stage: stageMeta.find((s) => s.id === activeStage)?.label ?? '',
                })}
              </div>
              {activeStage === 'isolation' && (
                <div className="pcb-grid">
                  <Field label={t('pcb.advanced.isolationPasses', 'Isolation passes')}>
                    <input type="number" step="1" min="1" max="8" value={params.passes} onChange={num('passes', 1, 8)} />
                  </Field>
                  <Field label={t('pcb.advanced.passStepover', 'Pass stepover (mm)')}>
                    <input type="number" step="0.05" min="0.05" value={params.stepover} onChange={num('stepover', 0.05)} />
                  </Field>
                  <Field label={t('pcb.advanced.copperCutZ', 'Copper cut Z (mm)')}>
                    <input type="number" step="0.01" max="0" value={params.copperZ} onChange={num('copperZ', undefined, 0)} />
                  </Field>
                </div>
              )}
              {activeStage === 'drill' && (
                <div className="pcb-grid">
                  <Field label={t('pcb.advanced.drillZ', 'Drill Z (mm)')}>
                    <input type="number" step="0.1" max="0" value={params.drillZ} onChange={num('drillZ', undefined, 0)} />
                  </Field>
                  <Field label={t('pcb.advanced.peckDepth', 'Peck depth (mm, 0 = off)')}>
                    <input type="number" step="0.1" min="0" value={params.peckDepth} onChange={num('peckDepth', 0)} />
                  </Field>
                </div>
              )}
              {activeStage === 'cutout' && (
                <div className="pcb-grid">
                  <Field label={t('pcb.advanced.cutoutDepth', 'Cutout depth (mm)')}>
                    <input type="number" step="0.1" min="0.1" value={params.cutoutDepth} onChange={num('cutoutDepth', 0.1)} />
                  </Field>
                  <Field label={t('pcb.advanced.holdingTabs', 'Holding tabs (0 = none)')}>
                    <input type="number" step="1" min="0" max="12" value={params.tabs} onChange={num('tabs', 0, 12)} />
                  </Field>
                  <Field label={t('pcb.advanced.tabWidth', 'Tab width (mm)')}>
                    <input type="number" step="0.5" min="0.5" value={params.tabWidth} onChange={num('tabWidth', 0.5)} />
                  </Field>
                </div>
              )}

              {/* Manual generate for the active stage (pushes to the program store
                  ONLY — never streams — so it stays enabled even while busy). */}
              <div className="pcb-generate">
                <button className="primary" onClick={() => sendStage(activeStage)}>
                  {t('pcb.advanced.generate', 'Generate {stage} → Program', {
                    stage: stageLabel(t, activeStage),
                  })}
                </button>
                <span className="pcb-hint">
                  {t(
                    'pcb.advanced.generateHint',
                    'Sends the active stage to the program store (same as a layer Play, without streaming).',
                  )}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* ---- Output: status + collapsed raw G-code ---- */}
        {(status || lastGcode) && (
          <section className="pcb-section pcb-section-wide">
            <h3>{t('pcb.output.title', 'Output')}</h3>
            <div className="pcb-section-body">
              {status && (
                <div className={statusError ? 'pcb-error' : 'pcb-status'} role={statusError ? 'alert' : undefined}>
                  {status}
                </div>
              )}
              {lastGcode && (
                <div className="pcb-gcode">
                  <button
                    className="pcb-gcode-toggle"
                    onClick={() => setShowGcode((v) => !v)}
                    aria-expanded={showGcode}
                  >
                    <Icon name={showGcode ? 'chevron-down' : 'chevron-right'} size={14} />{' '}
                    {t('pcb.output.gcodeLabel', 'G-code — {name}', { name: lastGcode.name })}
                    <span className="pcb-gcode-meta">
                      {t('pcb.output.lines', '{count} lines', {
                        count: lastGcode.text.split('\n').length,
                      })}
                    </span>
                  </button>
                  {showGcode && (
                    <pre className="pcb-gcode-text" aria-label={t('pcb.output.gcodeAria', 'generated g-code')}>
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
      <PresetSaveBar
        slots={presets.slots}
        selected={presets.selected}
        onSelect={presets.select}
        onSave={presets.save}
        onClear={presets.clear}
        onRename={presets.rename}
        extra={
          <SaveLoadButtons
            value={params}
            onLoad={applyPcbParams}
            onError={fail}
            fileBase="pcb-settings"
            ext="kpcbs"
            saveTitle={t('pcb.presets.saveSettings', 'Save PCB CAM settings to file')}
            loadTitle={t('pcb.presets.loadSettings', 'Load PCB CAM settings from file')}
          />
        }
      />
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
