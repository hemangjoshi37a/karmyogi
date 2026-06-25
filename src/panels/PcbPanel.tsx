import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import { useProgram, useMachine, usePersistentState } from '../store'
import { useT } from '../i18n'
import { grbl } from '../serial/controller'
import { buildFrameProgram, frameBoundsOfGcode } from '../core/framing'
import { useTabCommands } from '../machine/tabCommands'
import { importGerber, GerberData } from '../core/gerber'
import { importExcellon, ExcellonData } from '../core/excellon'
import {
  isolationRoutes,
  drillHits,
  boardCutout,
  boardOutlinePolygon,
  vbitDepthForWidth,
  vbitWidthAtDepth,
  groupDrillHits,
  drillGroup as drillGroupTp,
  mirrorGerber,
  mirrorExcellon,
  drcCheck,
  copperPourClear,
  millHoles as millHolesTp,
  oversizedHoleCount,
  originShift,
  reoriginGerber,
  reoriginExcellon,
  type DrcIssue,
  type MirrorAxis,
  type OriginMode,
} from '../core/pcbCam'
import { makeRect, BBox, Polyline } from '../core/geometry'
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
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { SegControl } from '../components/ui/SegControl'
import { SliderField as UISliderField } from '../components/ui/SliderField'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { CamEmpty, CamBusy, CamError } from '../components/cam/CamUI'
import { useHeightmap, type ApplyMode } from '../store/heightmap'
import { useConsole } from '../store/console'
import {
  probeGrid,
  snakeOrder,
  gridForSpacing,
  defaultSpacing,
  expandArea,
  warpGcode,
  isComplete,
  probedCount,
  zExtent,
  sampleHeight,
  type HeightMap,
  type ProbeArea,
  type ProbePoint,
} from '../core/heightmap'
import '../styles/pcb.css'
import '../styles/cam.css'
import '../styles/pcbLevel.css'

/** Single canonical program section for ALL PCB output (preview / play / generate).
 *  Using ONE name means each push REPLACES the previous one — the operator never
 *  accumulates stale stages, and what shows in the Visualizer == what runs. */
const PCB_SECTION = 'pcb'

/** Presentation-only: the section flow now carries an authoritative numbered
 *  step badge, so drop any leading "N · " (or "N - " / "N. ") number that legacy
 *  translation strings still embed in the title — otherwise the badge and the
 *  text would show the number twice. Matches digits of any script. */
const stripStepNum = (s: string): string =>
  s.replace(/^[\s]*[\p{Nd}]+[\s]*[·.\-—]?[\s]*/u, '')

const ZIP_ACCEPT = '.zip'
const GERBER_ACCEPT = '.gbr,.ger,.gtl,.gbl,.art,.gko,.gm1,.txt'
const EXCELLON_ACCEPT = '.drl,.xln,.txt,.nc,.exc'

type StageId = 'isolation' | 'drill' | 'cutout'

/** Names of paste/stencil layers — noted on the cutout card as "for Soldering". */
const PASTE_NAME = /\.(gtp|gbp|crc|crs|spt|spb)$|paste|stencil|\bcream\b/i

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
  // P3 — V-bit isolation: when on, the copper cut Z is computed from the desired
  // isolation WIDTH using the bit's tip angle (depth-from-width), overriding copperZ.
  vbit: boolean
  vbitAngle: number // included tip angle (deg)
  vbitTip: number // flat-tip diameter (mm)
  isoWidth: number // desired isolation groove width (mm)
  // P5 — group drilling by tool diameter (one paused stage per bit).
  drillGroup: boolean
  minDrillBit: number // smallest bit you own (mm) — for DRC + grouping note
  // P8 — double-sided: mirror the BOTTOM copper/drill about an axis for the flip.
  twoSided: boolean
  mirrorAxis: 'x' | 'y'
  // P2 — express pass stepover as a fixed mm distance or as a % overlap of the
  // cutter width (overlap → step = width·(1 − overlap)). Stored alongside the mm.
  stepoverMode: 'mm' | 'overlap'
  overlapPct: number // 0..90 (% the next pass overlaps the previous cut width)
  // P11 — multi-depth isolation + cut direction.
  isoStepdown: number // depth per isolation pass (mm); 0 = single full-depth pass
  climb: boolean // true = climb milling (CW); false = conventional (CCW)
  // P4 — copper-pour / non-copper clearing of the open field between nets.
  copperClear: boolean
  copperClearClearance: number // mm gap kept between cutter edge and copper
  copperClearStepover: number // mm raster stepover
  // P6 — mill holes that are larger than the drill bit instead of plunge-drilling.
  millHoles: boolean
  millOversize: number // mm: mill a hole only if Ø exceeds bit by this margin
  // P10 — board origin handling (corner/center/keep-positive).
  origin: 'asis' | 'keepPositive' | 'corner' | 'center'
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
  vbit: false,
  vbitAngle: 30,
  vbitTip: 0.1,
  isoWidth: 0.2,
  drillGroup: false,
  minDrillBit: 0.3,
  twoSided: false,
  mirrorAxis: 'y',
  stepoverMode: 'mm',
  overlapPct: 25,
  isoStepdown: 0,
  climb: false,
  copperClear: false,
  copperClearClearance: 0.2,
  copperClearStepover: 0.3,
  millHoles: false,
  millOversize: 0.1,
  origin: 'asis',
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
  const mirrorAxis = v.mirrorAxis === 'x' || v.mirrorAxis === 'y' ? v.mirrorAxis : base.mirrorAxis
  const stepoverMode = v.stepoverMode === 'mm' || v.stepoverMode === 'overlap' ? v.stepoverMode : base.stepoverMode
  const origin =
    v.origin === 'asis' || v.origin === 'keepPositive' || v.origin === 'corner' || v.origin === 'center'
      ? v.origin
      : base.origin
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
    vbit: typeof v.vbit === 'boolean' ? v.vbit : base.vbit,
    vbitAngle: numOr(v.vbitAngle, base.vbitAngle),
    vbitTip: numOr(v.vbitTip, base.vbitTip),
    isoWidth: numOr(v.isoWidth, base.isoWidth),
    drillGroup: typeof v.drillGroup === 'boolean' ? v.drillGroup : base.drillGroup,
    minDrillBit: numOr(v.minDrillBit, base.minDrillBit),
    twoSided: typeof v.twoSided === 'boolean' ? v.twoSided : base.twoSided,
    mirrorAxis,
    stepoverMode,
    overlapPct: numOr(v.overlapPct, base.overlapPct),
    isoStepdown: numOr(v.isoStepdown, base.isoStepdown),
    climb: typeof v.climb === 'boolean' ? v.climb : base.climb,
    copperClear: typeof v.copperClear === 'boolean' ? v.copperClear : base.copperClear,
    copperClearClearance: numOr(v.copperClearClearance, base.copperClearClearance),
    copperClearStepover: numOr(v.copperClearStepover, base.copperClearStepover),
    millHoles: typeof v.millHoles === 'boolean' ? v.millHoles : base.millHoles,
    millOversize: numOr(v.millOversize, base.millOversize),
    origin,
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

/**
 * Themed slider + number-input row for a numeric CAM parameter. This is now the
 * shared kit `<SliderField>` (plan §2.8 / W-B — track + number + unit, usable
 * track at all widths, stable number-frame gutter so units never clip); this
 * thin adapter only maps the panel's existing `htmlFor` prop onto the shared
 * component's `id`, leaving every call site untouched.
 */
function SliderField({
  label,
  htmlFor,
  unit,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string
  htmlFor: string
  unit?: string
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step: number
}) {
  return (
    <UISliderField
      id={htmlFor}
      label={label}
      unit={unit}
      value={value}
      onChange={onChange}
      min={min}
      max={max}
      step={step}
    />
  )
}

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

  // ---- Auto-leveling (heightmap) ----
  // The warp is applied EXACTLY ONCE, governed by the heightmap store's
  // `applyMode`: 'baked' warps the generated text BEFORE it is pushed (so the
  // Visualizer shows the warped surface-following path), while 'onfly' keeps the
  // program flat and warps only the lines handed to the streamer. The two are
  // mutually exclusive (one selector), so Z is never double-offset.
  const levelMap = useHeightmap((s) => s.map)
  const levelMode = useHeightmap((s) => s.applyMode)
  const levelMaxSeg = useHeightmap((s) => s.maxSegment)
  // The warp only fires when a COMPLETE map exists and the mode isn't 'off'.
  const levelActive = !!levelMap && isComplete(levelMap) && levelMode !== 'off'
  /** Warp G-code text for the 'baked' path (no-op unless baked + complete map). */
  const bakeLevel = (gcode: string): string =>
    levelActive && levelMode === 'baked' && levelMap
      ? warpGcode(gcode, levelMap, { maxSegment: levelMaxSeg, cutCeiling: 0 })
      : gcode
  /** Warp baked program lines for the 'onfly' path (just before streaming). */
  const levelLines = (lines: string[]): string[] =>
    levelActive && levelMode === 'onfly' && levelMap
      ? warpGcode(lines.join('\n'), levelMap, { maxSegment: levelMaxSeg, cutCeiling: 0 }).split('\n')
      : lines

  const zipRef = useRef<HTMLInputElement>(null)
  const gerberRef = useRef<HTMLInputElement>(null)
  const excellonRef = useRef<HTMLInputElement>(null)

  // ---- ZIP package + layer mapping ----
  const [layers, setLayers] = useState<LayerRow[]>([])
  const [pkgError, setPkgError] = useState<string>('')
  const [pkgName, setPkgName] = useState<string>('')
  const [dragZip, setDragZip] = useState(false)
  // Presentation-only (W-Q): true while a ZIP is being unzipped/parsed (drives
  // <CamBusy>); the last dropped/picked file is kept so <CamError> can re-trigger
  // the same upload on Retry. Neither changes the parse logic.
  const [parsingZip, setParsingZip] = useState(false)
  const lastZipFile = useRef<File | null>(null)

  // ---- secondary single-file inputs ----
  const [singleGerber, setSingleGerber] = useState<GerberData | null>(null)
  const [singleDrill, setSingleDrill] = useState<ExcellonData | null>(null)
  const [gerberInfo, setGerberInfo] = useState<ParseInfo | null>(null)
  const [drillInfo, setDrillInfo] = useState<ParseInfo | null>(null)
  const [dragGerber, setDragGerber] = useState(false)
  const [dragDrill, setDragDrill] = useState(false)
  const [showSingle, setShowSingle] = useState(false)

  // Persisted CAM params + active stage so the operator's tool/feed/depth tuning
  // and selected stage survive a reload. Seed with a merge over DEFAULTS so a
  // newly-added field is never undefined if an older saved shape is restored.
  const [storedParams, setParams] = usePersistentState<Params>('karmyogi.pcb.params', DEFAULTS)
  const params = useMemo<Params>(() => ({ ...DEFAULTS, ...storedParams }), [storedParams])
  const [activeStage, setActiveStage] = usePersistentState<StageId>(
    'karmyogi.pcb.activeStage',
    'isolation',
  )
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
  const [showAdvanced, setShowAdvanced] = usePersistentState<boolean>('karmyogi.pcb.showAdvanced', false)

  // Last generated G-code, shown in a collapsible (collapsed by default) preview.
  const [lastGcode, setLastGcode] = useState<{ name: string; text: string } | null>(null)
  const [showGcode, setShowGcode] = useState(false)

  // Run-gate: the row whose Play has been "armed" (a styled hold-to-run affordance
  // that replaces the native window.confirm). Confirming it streams; arming any
  // other row (or generating elsewhere) cancels a previous arm.
  const [armedRunId, setArmedRunId] = useState<string | null>(null)

  // P8 — which board side the operation cards currently target. 'top' is the
  // normal (un-mirrored) program; 'bottom' mirrors the geometry about the chosen
  // axis so the layer machines correctly from the FLIPPED setup. Only meaningful
  // when twoSided is on (otherwise forced to 'top').
  const [genSide, setGenSide] = useState<'top' | 'bottom'>('top')
  const side: 'top' | 'bottom' = params.twoSided ? genSide : 'top'
  const mirrorOpt = { mirror: side === 'bottom' }

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
    lastZipFile.current = file
    setPkgError('')
    setStatus('')
    setStatusError(false)
    setArmedRunId(null)
    setParsingZip(true)
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
    } finally {
      setParsingZip(false)
    }
  }

  // Re-run the last upload (wired to the <CamError> Retry). If no file was ever
  // picked (shouldn't happen — the error only shows after an attempt), fall back
  // to re-opening the file picker.
  function retryZip() {
    const f = lastZipFile.current
    if (f) void loadZip(f)
    else zipRef.current?.click()
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
  // P3 — when V-bit mode is on, the copper plunge Z is COMPUTED from the desired
  // isolation width via the tip-angle relation (depth-from-width); otherwise the
  // operator's explicit copper cut Z is used. Always a negative cut depth.
  const effCopperZ = useMemo(() => {
    if (!params.vbit) return params.copperZ
    return -Math.abs(vbitDepthForWidth(params.isoWidth, params.vbitAngle, params.vbitTip))
  }, [params.vbit, params.copperZ, params.isoWidth, params.vbitAngle, params.vbitTip])

  // The effective isolation cutter WIDTH used for DRC: a V-bit's groove width at
  // the computed depth, else the flat tool diameter.
  const effToolWidth = useMemo(
    () =>
      params.vbit
        ? vbitWidthAtDepth(Math.abs(effCopperZ), params.vbitAngle, params.vbitTip)
        : params.toolDia,
    [params.vbit, effCopperZ, params.vbitAngle, params.vbitTip, params.toolDia],
  )

  // P2 — effective per-pass lateral spacing (mm). In 'overlap' mode the step is
  // derived from the cutter WIDTH so each pass overlaps the previous by the chosen
  // %: step = width · (1 − overlap). In 'mm' mode the explicit field is used.
  const effStepover = useMemo(() => {
    if (params.stepoverMode === 'overlap') {
      const ov = Math.min(90, Math.max(0, params.overlapPct)) / 100
      const s = effToolWidth * (1 - ov)
      return s > 0.01 ? s : 0.01
    }
    return params.stepover
  }, [params.stepoverMode, params.overlapPct, params.stepover, effToolWidth])

  function buildToolpath(
    stage: StageId,
    geom: { copper?: GerberData | null; drillData?: ExcellonData | null; outline?: GerberData | null },
    opts: { mirror?: boolean } = {}
  ): { tp: Toolpath } | { error: string } {
    const tool = makeTool()
    const mirror = !!opts.mirror
    const axis: MirrorAxis = params.mirrorAxis
    // P10 — board re-origin: a single shift derived from the board extents (outline
    // preferred, else copper) applied identically to copper + drill + outline so
    // every layer stays registered. 'asis' is a no-op.
    const originMode: OriginMode = params.origin
    let originDelta = { x: 0, y: 0 }
    if (originMode !== 'asis') {
      const ob = (geom.outline ?? geom.copper ?? geom.drillData)?.bounds()
      if (ob && ob.isValid()) originDelta = originShift(ob, originMode)
    }
    const shiftG = (g: GerberData) => reoriginGerber(g, originDelta)
    // P8 — the flip datum: the mid-line of the board (outline preferred, else the
    // copper being machined) on the mirror axis, so the mirrored bottom registers
    // against the SAME line the operator flips the stock about.
    const datumSrc = geom.outline ?? geom.copper
    let mirrorCoord: number | undefined
    if (datumSrc) {
      const b = datumSrc.bounds()
      if (b.isValid()) mirrorCoord = (axis === 'y' ? b.center().x : b.center().y) + (axis === 'y' ? originDelta.x : originDelta.y)
    }
    let tp: Toolpath
    if (stage === 'isolation') {
      if (!geom.copper)
        return {
          error: t(
            'pcb.error.assignCopper',
            'Assign a Copper Top/Bottom layer (or load a Gerber) for isolation routing.',
          ),
        }
      let copper = shiftG(geom.copper)
      copper = mirror ? mirrorGerber(copper, axis, mirrorCoord) : copper
      // P11 — multi-depth + climb/conventional; P2 — overlap/mm stepover.
      tp = isolationRoutes(copper, tool, params.safeZ, effCopperZ, params.passes, effStepover, true, {
        stepdown: params.isoStepdown,
        climb: params.climb,
      })
      // P4 — optionally clear the non-copper field (copper pour) after isolating.
      if (params.copperClear) {
        let outlinePoly: Polyline | null = null
        if (geom.outline) {
          const ol = mirror ? mirrorGerber(shiftG(geom.outline), axis, mirrorCoord) : shiftG(geom.outline)
          outlinePoly = boardOutlinePolygon(ol)
        }
        const clearTp = copperPourClear(copper, tool, params.safeZ, effCopperZ, outlinePoly, {
          clearanceMm: params.copperClearClearance,
          stepoverMm: params.copperClearStepover,
          stepdown: params.isoStepdown,
        })
        for (const m of clearTp.moves) tp.append(m)
      }
    } else if (stage === 'drill') {
      if (!geom.drillData)
        return {
          error: t('pcb.error.assignDrill', 'Assign a Drill layer (or load an Excellon file) for drilling.'),
        }
      let drillData = reoriginExcellon(geom.drillData, originDelta)
      drillData = mirror ? mirrorExcellon(drillData, axis, mirrorCoord) : drillData
      // P6 — split oversized holes off to a milling pass; the rest plunge-drill.
      let millOnly: ExcellonData | null = null
      if (params.millHoles) {
        const big = new ExcellonData()
        const small = new ExcellonData()
        for (const h of drillData.hits) {
          if (h.diameter > params.toolDia + params.millOversize) big.hits.push(h)
          else small.hits.push(h)
        }
        if (big.hits.length > 0) {
          millOnly = big
          drillData = small
        }
      }
      if (params.drillGroup) {
        // P5 — one travel-optimised sub-path per drill bit, concatenated in
        // ascending Ø order with the bit annotated. (The All-stages run inserts an
        // M0 pause between full stages; here every group shares ONE bit change at
        // the start of drilling, so we keep them in one toolpath but ordered.)
        tp = new Toolpath()
        tp.name = 'Drill (grouped)'
        for (const g of groupDrillHits(drillData)) {
          const gtp = drillGroupTp(g, params.safeZ, params.drillZ, params.peckDepth)
          for (const m of gtp.moves) tp.append(m)
        }
      } else {
        tp = drillHits(drillData, params.safeZ, params.drillZ, params.peckDepth)
      }
      // P6 — append the milled-bore pass for holes bigger than the bit.
      if (millOnly && millOnly.hits.length > 0) {
        const mtp = millHolesTp(millOnly, params.toolDia, params.safeZ, params.drillZ, {
          minOversizeMm: params.millOversize,
          stepdown: params.isoStepdown,
        })
        for (const m of mtp.moves) tp.append(m)
      }
    } else {
      // Cutout: prefer an assigned Board Outline layer; fall back to copper.
      const source0 = geom.outline ?? geom.copper
      if (!source0)
        return {
          error: t(
            'pcb.error.assignOutline',
            'Assign a Board Outline or Copper layer to derive the cutout outline.',
          ),
        }
      const source = shiftG(source0)
      // Use the real outline polygon (stitched from the edge-cuts traces/region)
      // when we can derive one; otherwise fall back to the bounding rectangle.
      const src = mirror ? mirrorGerber(source, axis, mirrorCoord) : source
      let outline = boardOutlinePolygon(src)
      if (!outline || outline.points.length < 3) {
        const b = src.bounds()
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
    geom: { copper?: GerberData | null; drillData?: ExcellonData | null; outline?: GerberData | null },
    opts: { mirror?: boolean } = {}
  ): { gcode: string; tp: Toolpath } | { error: string } {
    const res = buildToolpath(stage, geom, opts)
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

    // A board may export several drill files (e.g. separate PTH + NPTH passes).
    // Merge every Drill-assigned layer's hits into one set so drilling covers ALL
    // holes — picking only the first file would silently skip the rest.
    const drillRows = layers.filter((r) => r.role === 'Drill' && r.parsed.kind === 'drill')
    let drillData: ExcellonData | null = null
    if (drillRows.length === 1 && drillRows[0].parsed.kind === 'drill') {
      drillData = drillRows[0].parsed.data
    } else if (drillRows.length > 1) {
      const merged = new ExcellonData()
      for (const r of drillRows) if (r.parsed.kind === 'drill') merged.hits.push(...r.parsed.data.hits)
      drillData = merged
    }
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
    // In 'baked' apply-mode the warp is folded into the program TEXT here, so the
    // Visualizer + the streamed lines are one and the same warped path. In
    // 'onfly' / 'off' mode this is a no-op and the program stays flat (the warp,
    // if any, is applied to the streamed lines only — see confirmRun*).
    gcode = bakeLevel(gcode)
    setProgram(PCB_SECTION, gcode)
    // After setProgram, the store has re-baked `lines` (placement applied). Read
    // them back so the preview text and the streamed lines are the SAME source.
    const baked = useProgram.getState().lines
    const text = baked.join('\n')
    setLastGcode({ name: label, text })
    return baked.filter((l) => l.length > 0)
  }

  // Program name for a stage, tagged with the (mirrored) side when two-sided.
  const sideName = (stage: StageId) =>
    params.twoSided ? `pcb-${stage}-${side}.nc` : `pcb-${stage}.nc`

  // Generate a (global) stage and push it to the program store (NOT streamed).
  function sendStage(stage: StageId) {
    const res = buildGcode(stage, resolved, mirrorOpt)
    if ('error' in res) {
      fail(res.error)
      setLastGcode(null)
      return
    }
    setArmedRunId(null)
    pushProgram(res.gcode, sideName(stage))
    ok(
      t('pcb.status.sentStage', 'Sent {stage} to program: {moves} moves, cut {mm} mm.', {
        stage: stageLabel(t, stage),
        moves: res.tp.size(),
        mm: res.tp.cutLength().toFixed(1),
      }),
    )
  }

  // ---- per-operation (stage) Preview / Generate / Play ----
  // These drive the operation cards. They build from the RESOLVED geometry (which
  // aggregates every layer of a role — e.g. all drill files merged), so a card
  // covers the whole board's task, not just one file.
  const STAGE_ARM = (s: StageId) => `stage:${s}`

  function previewStage(stage: StageId) {
    setArmedRunId(null)
    const res = buildGcode(stage, resolved, mirrorOpt)
    if ('error' in res) {
      fail(res.error)
      return
    }
    pushProgram(res.gcode, sideName(stage))
    ok(
      t('pcb.status.preview', 'Preview {verb} for {name}: {moves} moves, cut {mm} mm. Shown in Visualizer.', {
        verb: stageVerb(t, stage),
        name: stageLabel(t, stage),
        moves: res.tp.size(),
        mm: res.tp.cutLength().toFixed(1),
      }),
    )
  }

  // Tapping Run on an op card ARMS it (styled in-panel confirm, no native dialog).
  function playStage(stage: StageId) {
    if (!connected) {
      fail(t('pcb.status.connectFirst', 'Connect to the machine before running a layer.'))
      return
    }
    if (machineBusy) {
      fail(t('pcb.status.busy', 'Machine is busy (running/paused) — wait for the current job to finish.'))
      return
    }
    const res = buildGcode(stage, resolved, mirrorOpt)
    if ('error' in res) {
      fail(res.error)
      return
    }
    pushProgram(res.gcode, sideName(stage))
    setArmedRunId(STAGE_ARM(stage))
    ok(
      t('pcb.status.armed', 'Armed {verb} for {name} — {moves} moves, {mm} mm. Confirm to run.', {
        verb: stageVerb(t, stage),
        name: stageLabel(t, stage),
        moves: res.tp.size(),
        mm: res.tp.cutLength().toFixed(1),
      }),
    )
  }

  function confirmRunStage(stage: StageId) {
    setArmedRunId(null)
    if (!connected || machineBusy) {
      fail(t('pcb.status.busy', 'Machine is busy (running/paused) — wait for the current job to finish.'))
      return
    }
    const res = buildGcode(stage, resolved, mirrorOpt)
    if ('error' in res) {
      fail(res.error)
      return
    }
    const lines = pushProgram(res.gcode, sideName(stage))
    grbl.startProgram(levelLines(lines))
    ok(
      t('pcb.status.streaming', 'Streaming {verb} for {name} — {lines} lines.', {
        verb: stageVerb(t, stage),
        name: stageLabel(t, stage),
        lines: lines.length,
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
    grbl.startProgram(levelLines(lines))
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

  // P5 — distinct drill bits (per-diameter groups), for the grouping note + DRC.
  const drillGroups = useMemo(
    () => (resolved.drillData ? groupDrillHits(resolved.drillData) : []),
    [resolved],
  )

  // P6 — holes bigger than the bit (which a small mill must ROUT, not plunge).
  const oversizedCount = useMemo(
    () => (resolved.drillData ? oversizedHoleCount(resolved.drillData, params.toolDia, params.millOversize) : 0),
    [resolved, params.toolDia, params.millOversize],
  )

  // P12 — DRC-lite: cheap pre-flight checks (copper gap vs cutter width, tiny
  // holes, slots-as-drills). Recomputed only when the geometry or the effective
  // cutter width / smallest bit changes. Bounded internally to stay responsive.
  const drcIssues: DrcIssue[] = useMemo(
    () =>
      drcCheck({
        toolWidth: effToolWidth,
        copper: resolved.copper,
        drill: resolved.drillData,
        minDrillBit: params.minDrillBit,
      }),
    [resolved, effToolWidth, params.minDrillBit],
  )
  const drcErrors = drcIssues.filter((i) => i.severity === 'error').length
  const drcWarnings = drcIssues.filter((i) => i.severity === 'warning').length

  // Raw probe area (work coords) auto-derived from the board's isolation/outline
  // extents — the auto-level section adds its configurable margin on top.
  const levelBounds: ProbeArea | null = useMemo(() => {
    const src = resolved.outline ?? resolved.copper
    if (!src) return null
    const b = src.bounds()
    if (!b.isValid()) return null
    return { minX: b.min.x, minY: b.min.y, maxX: b.max.x, maxY: b.max.y }
  }, [resolved])

  // Names of the layer file(s) feeding each operation card, so the operator can
  // see exactly which layers a task uses (or that it's falling back to copper /
  // the single-file input). Computed from the current role assignments.
  const opSources = useMemo(() => {
    const copperRows = layers.filter(
      (r) => (r.role === 'CopperTop' || r.role === 'CopperBottom') && !r.parseError,
    )
    const drillRows = layers.filter((r) => r.role === 'Drill' && !r.parseError)
    const outlineRows = layers.filter((r) => r.role === 'BoardOutline' && !r.parseError)
    const pasteRows = layers.filter((r) => PASTE_NAME.test(r.name))
    return {
      copper: copperRows.map((r) => r.name),
      drill: drillRows.map((r) => r.name),
      outline: outlineRows.map((r) => r.name),
      paste: pasteRows.map((r) => r.name),
    }
  }, [layers])

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
      const res = buildGcode(stage, resolved, mirrorOpt)
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
    grbl.startProgram(levelLines(lines))
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

  // ── Gamepad command bus: preview (generate) / run all stages / frame. ──
  // generate previews all stages into the program store; runAll streams them;
  // frame traces the current program's XY bounds (tool OFF). The height-map probe
  // is registered separately by the leveling sub-component below. All guarded.
  useTabCommands('pcb', {
    generate: () => previewAllStages(),
    runAll: () => runAllStages(),
    frame: () => {
      const lines = useProgram.getState().lines
      if (!grbl.isConnected || lines.length === 0) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
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
          <h3>
            <span className="cam-card-ico" aria-hidden="true">
              <Icon name="upload" size={15} />
            </span>
            {stripStepNum(t('pcb.upload.title', 'Upload Gerber ZIP'))}
          </h3>
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
              {parsingZip ? (
                <CamBusy label={t('pcb.upload.busy', 'Reading the Gerber package…')} />
              ) : pkgError ? (
                <CamError
                  title={t('pcb.upload.error.title', "Couldn't read that ZIP")}
                  message={pkgError}
                  onRetry={retryZip}
                  retryLabel={t('pcb.upload.error.retry', 'Try again')}
                />
              ) : !layers.length ? (
                <CamEmpty
                  icon={<Icon name="upload" size={20} />}
                  title={t('pcb.upload.empty.title', 'Drop your board export here')}
                  hint={t(
                    'pcb.upload.empty.hint',
                    'Upload a Gerber/Excellon ZIP — layers are detected automatically, then press play on a layer to run it.',
                  )}
                  action={
                    <button className="cam-primary pcb-load-zip" onClick={() => zipRef.current?.click()}>
                      <Icon name="upload" size={16} className="pcb-btn-icon" />
                      {t('pcb.upload.button', 'Upload Gerber ZIP…')}
                    </button>
                  }
                />
              ) : (
                <>
                  <button className="cam-primary pcb-load-zip" onClick={() => zipRef.current?.click()}>
                    <Icon name="upload" size={16} className="pcb-btn-icon" />
                    {t('pcb.upload.button', 'Upload Gerber ZIP…')}
                  </button>
                  <span className="pcb-drop-hint">{t('pcb.upload.dropHint', 'or drop a .zip export here')}</span>
                </>
              )}
              <input
                ref={zipRef}
                className="pcb-load-input"
                type="file"
                accept={ZIP_ACCEPT}
                onChange={onZipInput}
              />
            </div>

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
              <span>
                <span className="cam-card-ico" aria-hidden="true">
                  <Icon name="copy" size={15} />
                </span>
                {stripStepNum(t('pcb.layers.title', 'Layers — press ▶ to run'))}
              </span>
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

        {/* ---- P9 Layer viewer ---- */}
        {(hasCopper || hasDrill || hasOutline) && (
          <section className="pcb-section pcb-section-wide">
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="eye" size={15} />
              </span>
              {t('pcb.lv.title', 'Layer preview')}
            </h3>
            <div className="pcb-section-body">
              <LayerViewer t={t} copper={resolved.copper} outline={resolved.outline} drill={resolved.drillData} />
              <p className="pcb-hint">
                {t('pcb.lv.hint', 'What will be machined — toggle layers above. Copper isolates, dots drill, the outline cuts out.')}
              </p>
            </div>
          </section>
        )}

        {/* ---- P12 DRC-lite (pre-flight warnings) ---- */}
        {drcIssues.length > 0 && (hasCopper || hasDrill) && (
          <section className="pcb-section pcb-section-wide">
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name={drcErrors > 0 ? 'warning' : 'info'} size={15} />
              </span>
              {t('pcb.drc.title', 'Design checks')}
              {(drcErrors > 0 || drcWarnings > 0) && (
                <span className={'pcb-chip' + (drcErrors > 0 ? ' pcb-chip-err' : ' pcb-chip-warn')}>
                  {drcErrors > 0
                    ? t('pcb.drc.errCount', '{n} error', { n: drcErrors })
                    : t('pcb.drc.warnCount', '{n} warning', { n: drcWarnings })}
                </span>
              )}
            </h3>
            <div className="pcb-section-body">
              <ul className="pcb-drc-list">
                {drcIssues.map((issue, i) => (
                  <li key={i} className={'pcb-drc-item pcb-drc-' + issue.severity}>
                    <Icon
                      name={issue.severity === 'error' ? 'warning' : issue.severity === 'warning' ? 'warning' : 'info'}
                      size={13}
                    />
                    <span>{issue.message}</span>
                  </li>
                ))}
              </ul>
              <p className="pcb-hint">
                {t('pcb.drc.hint', 'Conservative pre-flight checks. Errors will likely ruin the board; review before running.')}
              </p>
            </div>
          </section>
        )}

        {/* ---- P8 Double-sided ---- */}
        {(hasCopper || hasOutline) && (
          <section className="pcb-section">
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="copy" size={15} />
              </span>
              {t('pcb.twoSided.title', 'Double-sided')}
            </h3>
            <div className="pcb-section-body">
              <label className="pcb-check">
                <input
                  type="checkbox"
                  checked={params.twoSided}
                  onChange={(e) => {
                    set('twoSided', e.target.checked)
                    if (!e.target.checked) setGenSide('top')
                  }}
                />
                <span>{t('pcb.twoSided.enable', 'Two-sided board (mirror the bottom side)')}</span>
              </label>
              {params.twoSided && (
                <>
                  <div className="pcb-grid">
                    <Field label={t('pcb.twoSided.axis', 'Flip / mirror axis')}>
                      <SegControl<'x' | 'y'>
                        ariaLabel={t('pcb.twoSided.axis', 'Flip / mirror axis')}
                        value={params.mirrorAxis}
                        onChange={(v) => set('mirrorAxis', v)}
                        options={[
                          { value: 'y', label: t('pcb.twoSided.axisY', 'Mirror X (flip ↔)') },
                          { value: 'x', label: t('pcb.twoSided.axisX', 'Mirror Y (flip ↕)') },
                        ]}
                      />
                    </Field>
                    <Field label={t('pcb.twoSided.side', 'Generate for side')}>
                      <SegControl<'top' | 'bottom'>
                        ariaLabel={t('pcb.twoSided.side', 'Generate for side')}
                        value={genSide}
                        onChange={setGenSide}
                        options={[
                          { value: 'top', label: t('pcb.twoSided.top', 'Top') },
                          { value: 'bottom', label: t('pcb.twoSided.bottom', 'Bottom (mirrored)') },
                        ]}
                      />
                    </Field>
                  </div>
                  <p className="pcb-hint">
                    {side === 'bottom'
                      ? t(
                          'pcb.twoSided.bottomHint',
                          'Operations now emit MIRRORED geometry. Mill the top first, then physically flip the board about the same axis, re-zero against the registered corner, and run these bottom programs.',
                        )
                      : t(
                          'pcb.twoSided.topHint',
                          'Top side selected — operations emit the normal (un-mirrored) program. Switch to Bottom after flipping the stock.',
                        )}
                  </p>
                </>
              )}
            </div>
          </section>
        )}

        {/* ---- 3. Toolpath operations (one machining task per layer) ---- */}
        {layers.length > 0 && (
          <section className="pcb-section pcb-section-wide">
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="settings" size={15} />
              </span>
              {stripStepNum(t('pcb.ops.title', 'Toolpath operations'))}
            </h3>
            <div className="pcb-section-body">
              <p className="pcb-hint">
                {t(
                  'pcb.ops.lead',
                  'Each detected layer maps to one machining task. Tune its cut below, then Preview (show in Visualizer), Generate (send to Program), or Run (stream to the machine after a confirm).',
                )}
              </p>
              <div className="pcb-ops-grid">
                {/* === Isolation routing (copper) === */}
                <div className={'pcb-op-card' + (hasCopper ? '' : ' pcb-op-disabled')}>
                  <div className="pcb-op-head">
                    <span className="pcb-op-icon">
                      <Icon name="copy" size={16} />
                    </span>
                    <span className="pcb-op-title">{t('pcb.op.isolation.title', 'Isolation routing')}</span>
                    <span className={'pcb-op-badge' + (hasCopper ? ' ok' : '')}>
                      {hasCopper ? t('pcb.op.ready', 'ready') : t('pcb.op.isolation.none', 'no copper layer')}
                    </span>
                  </div>
                  <div className="pcb-op-src">
                    <span className="pcb-op-desc">
                      {t('pcb.op.isolation.desc', 'Mills around copper traces & pads to electrically isolate them.')}
                    </span>
                    {opSources.copper.length > 0 && (
                      <span className="pcb-op-layer" title={opSources.copper.join('\n')}>
                        {opSources.copper.map(shortName).join(', ')}
                      </span>
                    )}
                  </div>
                  {hasCopper && (
                    <>
                      <label className="pcb-check pcb-op-check">
                        <input
                          type="checkbox"
                          checked={params.vbit}
                          onChange={(e) => set('vbit', e.target.checked)}
                        />
                        <span>{t('pcb.vbit.enable', 'V-bit (depth-from-width)')}</span>
                      </label>
                      <div className="cc-sgrid pcb-op-params">
                        <SliderField
                          label={t('pcb.advanced.isolationPasses', 'Isolation passes')}
                          htmlFor="pcb-iso-passes"
                          value={params.passes}
                          onChange={(n) => set('passes', Math.round(Math.min(8, Math.max(1, n))))}
                          min={1}
                          max={8}
                          step={1}
                        />
                        {params.stepoverMode === 'overlap' ? (
                          <SliderField
                            label={t('pcb.p2.overlap', 'Pass overlap')}
                            htmlFor="pcb-iso-overlap"
                            unit="%"
                            value={params.overlapPct}
                            onChange={(n) => set('overlapPct', Math.min(90, Math.max(0, n)))}
                            min={0}
                            max={90}
                            step={5}
                          />
                        ) : (
                          <SliderField
                            label={t('pcb.advanced.passStepover', 'Pass stepover')}
                            htmlFor="pcb-iso-step"
                            unit="mm"
                            value={params.stepover}
                            onChange={(n) => set('stepover', Math.max(0.05, n))}
                            min={0.05}
                            max={1}
                            step={0.05}
                          />
                        )}
                        {params.vbit ? (
                          <>
                            <SliderField
                              label={t('pcb.vbit.width', 'Isolation width')}
                              htmlFor="pcb-iso-w"
                              unit="mm"
                              value={params.isoWidth}
                              onChange={(n) => set('isoWidth', Math.max(0.05, n))}
                              min={0.05}
                              max={1}
                              step={0.01}
                            />
                            <SliderField
                              label={t('pcb.vbit.angle', 'Tip angle')}
                              htmlFor="pcb-iso-ang"
                              unit="°"
                              value={params.vbitAngle}
                              onChange={(n) => set('vbitAngle', Math.min(120, Math.max(5, n)))}
                              min={5}
                              max={120}
                              step={1}
                            />
                            <SliderField
                              label={t('pcb.vbit.tip', 'Tip flat Ø')}
                              htmlFor="pcb-iso-tip"
                              unit="mm"
                              value={params.vbitTip}
                              onChange={(n) => set('vbitTip', Math.max(0, n))}
                              min={0}
                              max={0.5}
                              step={0.01}
                            />
                          </>
                        ) : (
                          <SliderField
                            label={t('pcb.advanced.copperCutZ', 'Copper cut Z')}
                            htmlFor="pcb-iso-z"
                            unit="mm"
                            value={params.copperZ}
                            onChange={(n) => set('copperZ', Math.min(0, n))}
                            min={-0.5}
                            max={0}
                            step={0.01}
                          />
                        )}
                        <SliderField
                          label={t('pcb.advanced.feedXY', 'Feed XY')}
                          htmlFor="pcb-iso-feed"
                          unit="mm/min"
                          value={params.feedXY}
                          onChange={(n) => set('feedXY', Math.max(1, n))}
                          min={20}
                          max={1200}
                          step={10}
                        />
                      </div>
                      {params.vbit && (
                        <p className="pcb-hint pcb-vbit-readout">
                          {t('pcb.vbit.readout', 'Plunge {z} mm → {w} mm groove at depth.', {
                            z: Math.abs(effCopperZ).toFixed(3),
                            w: vbitWidthAtDepth(Math.abs(effCopperZ), params.vbitAngle, params.vbitTip).toFixed(3),
                          })}
                        </p>
                      )}
                      {/* P2 stepover mode + P11 direction */}
                      <div className="pcb-op-toggles">
                        <SegControl<'mm' | 'overlap'>
                          ariaLabel={t('pcb.p2.modeAria', 'Stepover mode')}
                          value={params.stepoverMode}
                          onChange={(v) => set('stepoverMode', v)}
                          options={[
                            { value: 'mm', label: t('pcb.p2.mm', 'Stepover mm') },
                            { value: 'overlap', label: t('pcb.p2.overlapMode', 'Overlap %') },
                          ]}
                        />
                        <SegControl<'conv' | 'climb'>
                          ariaLabel={t('pcb.p11.dirAria', 'Cut direction')}
                          value={params.climb ? 'climb' : 'conv'}
                          onChange={(v) => set('climb', v === 'climb')}
                          options={[
                            { value: 'conv', label: t('pcb.p11.conventional', 'Conventional') },
                            { value: 'climb', label: t('pcb.p11.climb', 'Climb') },
                          ]}
                        />
                      </div>
                      {params.stepoverMode === 'overlap' && (
                        <p className="pcb-hint">
                          {t('pcb.p2.overlapReadout', '≈ {mm} mm step (over a {w} mm cut).', {
                            mm: effStepover.toFixed(3),
                            w: effToolWidth.toFixed(3),
                          })}
                        </p>
                      )}
                      {/* P11 multi-depth */}
                      <div className="cc-sgrid pcb-op-params">
                        <SliderField
                          label={t('pcb.p11.stepdown', 'Depth per pass (0 = single)')}
                          htmlFor="pcb-iso-sd"
                          unit="mm"
                          value={params.isoStepdown}
                          onChange={(n) => set('isoStepdown', Math.max(0, n))}
                          min={0}
                          max={0.3}
                          step={0.01}
                        />
                      </div>
                      {/* P4 copper-pour / non-copper clearing */}
                      <label className="pcb-check pcb-op-check">
                        <input
                          type="checkbox"
                          checked={params.copperClear}
                          onChange={(e) => set('copperClear', e.target.checked)}
                        />
                        <span>{t('pcb.p4.enable', 'Clear copper pour (mill the non-copper field)')}</span>
                      </label>
                      {params.copperClear && (
                        <div className="cc-sgrid pcb-op-params">
                          <SliderField
                            label={t('pcb.p4.clearance', 'Keep-out from copper')}
                            htmlFor="pcb-cc-clr"
                            unit="mm"
                            value={params.copperClearClearance}
                            onChange={(n) => set('copperClearClearance', Math.max(0, n))}
                            min={0}
                            max={2}
                            step={0.05}
                          />
                          <SliderField
                            label={t('pcb.p4.stepover', 'Clear stepover')}
                            htmlFor="pcb-cc-step"
                            unit="mm"
                            value={params.copperClearStepover}
                            onChange={(n) => set('copperClearStepover', Math.max(0.05, n))}
                            min={0.05}
                            max={2}
                            step={0.05}
                          />
                        </div>
                      )}
                      {params.copperClear && (
                        <p className="pcb-hint">
                          {t('pcb.p4.hint', 'Removes the open ground-plane field so only isolated copper remains. Slow — uses the same bit and copper Z.')}
                        </p>
                      )}
                    </>
                  )}
                  <OpActions
                    t={t}
                    ready={hasCopper}
                    armed={armedRunId === STAGE_ARM('isolation')}
                    connected={connected}
                    machineBusy={machineBusy}
                    onPreview={() => previewStage('isolation')}
                    onGenerate={() => sendStage('isolation')}
                    onPlay={() => playStage('isolation')}
                    onConfirm={() => confirmRunStage('isolation')}
                    onCancel={() => setArmedRunId(null)}
                  />
                </div>

                {/* === Drilling (Excellon) === */}
                <div className={'pcb-op-card' + (hasDrill ? '' : ' pcb-op-disabled')}>
                  <div className="pcb-op-head">
                    <span className="pcb-op-icon">
                      <Icon name="zero" size={16} />
                    </span>
                    <span className="pcb-op-title">{t('pcb.op.drill.title', 'Drilling')}</span>
                    <span className={'pcb-op-badge' + (hasDrill ? ' ok' : '')}>
                      {hasDrill
                        ? t('pcb.op.drill.count', '{hits} holes · {tools}T', {
                            hits: drillHitsCount,
                            tools: drillTools,
                          })
                        : t('pcb.op.drill.none', 'no drill file')}
                    </span>
                  </div>
                  <div className="pcb-op-src">
                    <span className="pcb-op-desc">
                      {hasDrill
                        ? t('pcb.op.drill.desc', 'Plunge-drills every hole. Fit a drill bit per hole size.')
                        : t(
                            'pcb.op.drill.noneDesc',
                            'This package has no Excellon drill file — drilling is unavailable.',
                          )}
                    </span>
                    {opSources.drill.length > 0 && (
                      <span className="pcb-op-layer" title={opSources.drill.join('\n')}>
                        {opSources.drill.length > 1
                          ? t('pcb.op.drill.merged', '{n} drill files merged', { n: opSources.drill.length })
                          : opSources.drill.map(shortName).join(', ')}
                      </span>
                    )}
                  </div>
                  {hasDrill && (
                    <div className="cc-sgrid pcb-op-params">
                      <SliderField
                        label={t('pcb.advanced.drillZ', 'Drill Z')}
                        htmlFor="pcb-drill-z"
                        unit="mm"
                        value={params.drillZ}
                        onChange={(n) => set('drillZ', Math.min(0, n))}
                        min={-5}
                        max={0}
                        step={0.1}
                      />
                      <SliderField
                        label={t('pcb.advanced.peckDepth', 'Peck depth (0 = off)')}
                        htmlFor="pcb-drill-peck"
                        unit="mm"
                        value={params.peckDepth}
                        onChange={(n) => set('peckDepth', Math.max(0, n))}
                        min={0}
                        max={3}
                        step={0.1}
                      />
                      <SliderField
                        label={t('pcb.advanced.feedZ', 'Plunge feed')}
                        htmlFor="pcb-drill-feed"
                        unit="mm/min"
                        value={params.feedZ}
                        onChange={(n) => set('feedZ', Math.max(1, n))}
                        min={10}
                        max={600}
                        step={5}
                      />
                    </div>
                  )}
                  {hasDrill && (
                    <>
                      <label className="pcb-check pcb-op-check">
                        <input
                          type="checkbox"
                          checked={params.drillGroup}
                          onChange={(e) => set('drillGroup', e.target.checked)}
                        />
                        <span>{t('pcb.drillGroup.enable', 'Group by drill bit ({n})', { n: drillGroups.length })}</span>
                      </label>
                      {params.drillGroup && drillGroups.length > 0 && (
                        <p className="pcb-hint">
                          {t('pcb.drillGroup.readout', 'Bits: {list}', {
                            list: drillGroups.map((g) => `Ø${g.diameter.toFixed(2)} ×${g.hits.length}`).join(', '),
                          })}
                        </p>
                      )}
                      {/* P6 — mill holes bigger than the bit. */}
                      <label className="pcb-check pcb-op-check">
                        <input
                          type="checkbox"
                          checked={params.millHoles}
                          onChange={(e) => set('millHoles', e.target.checked)}
                        />
                        <span>{t('pcb.p6.enable', 'Mill holes bigger than the bit ({n})', { n: oversizedCount })}</span>
                      </label>
                      {params.millHoles && (
                        <div className="cc-sgrid pcb-op-params">
                          <SliderField
                            label={t('pcb.p6.oversize', 'Mill if Ø over bit by')}
                            htmlFor="pcb-mill-over"
                            unit="mm"
                            value={params.millOversize}
                            onChange={(n) => set('millOversize', Math.max(0, n))}
                            min={0}
                            max={2}
                            step={0.05}
                          />
                        </div>
                      )}
                      {params.millHoles && (
                        <p className="pcb-hint">
                          {oversizedCount > 0
                            ? t('pcb.p6.readout', '{n} oversized hole(s) will be milled out (spiralled) with the {dia} mm bit; the rest plunge-drill.', {
                                n: oversizedCount,
                                dia: params.toolDia.toFixed(2),
                              })
                            : t('pcb.p6.none', 'No holes exceed the bit Ø by the threshold — all will plunge-drill.')}
                        </p>
                      )}
                    </>
                  )}
                  <OpActions
                    t={t}
                    ready={hasDrill}
                    armed={armedRunId === STAGE_ARM('drill')}
                    connected={connected}
                    machineBusy={machineBusy}
                    onPreview={() => previewStage('drill')}
                    onGenerate={() => sendStage('drill')}
                    onPlay={() => playStage('drill')}
                    onConfirm={() => confirmRunStage('drill')}
                    onCancel={() => setArmedRunId(null)}
                  />
                </div>

                {/* === Board cutout (outline) === */}
                <div className={'pcb-op-card' + (hasOutline || hasCopper ? '' : ' pcb-op-disabled')}>
                  <div className="pcb-op-head">
                    <span className="pcb-op-icon">
                      <Icon name="frame" size={16} />
                    </span>
                    <span className="pcb-op-title">{t('pcb.op.cutout.title', 'Board cutout')}</span>
                    <span className={'pcb-op-badge' + (hasOutline || hasCopper ? ' ok' : '')}>
                      {hasOutline
                        ? t('pcb.op.ready', 'ready')
                        : hasCopper
                        ? t('pcb.summary.fromCopper', 'from copper')
                        : t('pcb.op.cutout.none', 'no outline layer')}
                    </span>
                  </div>
                  <div className="pcb-op-src">
                    <span className="pcb-op-desc">
                      {t('pcb.op.cutout.desc', 'Profile-cuts the board outline so it releases from the stock.')}
                    </span>
                    {opSources.outline.length > 0 ? (
                      <span className="pcb-op-layer" title={opSources.outline.join('\n')}>
                        {opSources.outline.map(shortName).join(', ')}
                      </span>
                    ) : hasCopper ? (
                      <span className="pcb-op-layer">
                        {t('pcb.op.cutout.usingCopper', 'using copper bounds (no outline layer)')}
                      </span>
                    ) : null}
                    {opSources.paste.length > 0 && (
                      <span className="pcb-op-note" title={opSources.paste.join('\n')}>
                        {t('pcb.op.paste.note', 'Paste layer present — solder it from the Soldering tab.')}
                      </span>
                    )}
                  </div>
                  {(hasOutline || hasCopper) && (
                    <div className="cc-sgrid pcb-op-params">
                      <SliderField
                        label={t('pcb.advanced.cutoutDepth', 'Cutout depth')}
                        htmlFor="pcb-cut-depth"
                        unit="mm"
                        value={params.cutoutDepth}
                        onChange={(n) => set('cutoutDepth', Math.max(0.1, n))}
                        min={0.1}
                        max={6}
                        step={0.1}
                      />
                      <SliderField
                        label={t('pcb.advanced.holdingTabs', 'Holding tabs')}
                        htmlFor="pcb-cut-tabs"
                        value={params.tabs}
                        onChange={(n) => set('tabs', Math.round(Math.min(12, Math.max(0, n))))}
                        min={0}
                        max={12}
                        step={1}
                      />
                      <SliderField
                        label={t('pcb.advanced.tabWidth', 'Tab width')}
                        htmlFor="pcb-cut-tabw"
                        unit="mm"
                        value={params.tabWidth}
                        onChange={(n) => set('tabWidth', Math.max(0.5, n))}
                        min={0.5}
                        max={10}
                        step={0.5}
                      />
                      <SliderField
                        label={t('pcb.advanced.feedXY', 'Feed XY')}
                        htmlFor="pcb-cut-feed"
                        unit="mm/min"
                        value={params.feedXY}
                        onChange={(n) => set('feedXY', Math.max(1, n))}
                        min={20}
                        max={1200}
                        step={10}
                      />
                    </div>
                  )}
                  <OpActions
                    t={t}
                    ready={hasOutline || hasCopper}
                    armed={armedRunId === STAGE_ARM('cutout')}
                    connected={connected}
                    machineBusy={machineBusy}
                    onPreview={() => previewStage('cutout')}
                    onGenerate={() => sendStage('cutout')}
                    onPlay={() => playStage('cutout')}
                    onConfirm={() => confirmRunStage('cutout')}
                    onCancel={() => setArmedRunId(null)}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {/* ---- Auto-leveling / heightmap (O1/P1) ---- */}
        {levelBounds && (
          <AutoLevelSection
            t={t}
            bounds={levelBounds}
            connected={connected}
            machineBusy={machineBusy}
            machineState={machineState}
          />
        )}

        {/* ---- 4. Essentials (always handy) ---- */}
        <section className="pcb-section">
          <h3 className="pcb-h3-row">
            <span>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="settings" size={15} />
              </span>
              {stripStepNum(t('pcb.essentials.title', 'Essentials'))}
            </span>
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
            <SegControl<'spindle' | 'pen'>
              className="pcb-zmode"
              ariaLabel={t('pcb.essentials.zmode', 'Z mode')}
              value={params.zmode}
              onChange={(v) => set('zmode', v)}
              options={[
                { value: 'spindle', label: t('pcb.essentials.spindle', 'Spindle (mill)') },
                { value: 'pen', label: t('pcb.essentials.pen', 'Pen (plotter)') },
              ]}
            />
            <div className="pcb-grid">
              <Field label={t('pcb.essentials.toolDia', 'Tool Ø (mm)')}>
                <input type="number" step="0.05" min="0.05" value={params.toolDia} onChange={num('toolDia', 0.05)} />
              </Field>
              <Field label={t('pcb.essentials.safeZ', 'Safe Z (mm)')}>
                <input type="number" step="0.5" min="0" value={params.safeZ} onChange={num('safeZ', 0)} />
              </Field>
            </div>
            {/* P10 — board origin handling (mm/inch is auto-detected on import). */}
            <Field label={t('pcb.p10.origin', 'Board origin')}>
              <SegControl<'asis' | 'keepPositive' | 'corner' | 'center'>
                ariaLabel={t('pcb.p10.origin', 'Board origin')}
                value={params.origin}
                onChange={(v) => set('origin', v)}
                options={[
                  { value: 'asis', label: t('pcb.p10.asis', 'As-is') },
                  { value: 'keepPositive', label: t('pcb.p10.keepPositive', 'Keep +') },
                  { value: 'corner', label: t('pcb.p10.corner', 'Corner') },
                  { value: 'center', label: t('pcb.p10.center', 'Center') },
                ]}
              />
            </Field>
            <p className="pcb-hint">
              {t(
                'pcb.essentials.hint',
                'These apply to every operation. Units (mm/inch) are auto-detected from the Gerber/Excellon header. Fine-tune passes, depths and feeds under Advanced.',
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
              <SegControl<StageId>
                className="pcb-stages"
                ariaLabel={t('pcb.advanced.operationStage', 'Operation stage')}
                value={activeStage}
                onChange={setActiveStage}
                options={stageMeta.map((s) => ({
                  value: s.id,
                  title: s.ready ? s.note : t('pcb.advanced.layerNotAssigned', 'Required layer not assigned'),
                  label: (
                    <>
                      {s.label}
                      {!s.ready && (
                        <span className="pcb-stage-missing" aria-hidden>
                          {' '}
                          <Icon name="warning" size={12} />
                        </span>
                      )}
                    </>
                  ),
                }))}
              />
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
            <h3>
              <span className="cam-card-ico" aria-hidden="true">
                <Icon name="download" size={15} />
              </span>
              {t('pcb.output.title', 'Output')}
            </h3>
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

// ---------------------------------------------------------------------------
// P9 — Gerber/Excellon layer viewer
// ---------------------------------------------------------------------------

type LayerVis = { copper: boolean; pads: boolean; drill: boolean; outline: boolean }

/**
 * A compact SVG preview of the loaded copper / drill / outline geometry, with
 * per-layer visibility toggles and role colours, so the operator can SEE what
 * will be machined before generating. Pure render off the parsed geometry — no
 * 3D viewer, no program store; copper traces are stroked at their real width,
 * pads/regions filled, drill hits dotted at their diameter, the outline drawn as
 * a closed loop. Y is flipped so +Y is up (matching the bed view).
 */
function LayerViewer({
  t,
  copper,
  outline,
  drill,
}: {
  t: TFn
  copper: GerberData | null
  outline: GerberData | null
  drill: ExcellonData | null
}) {
  const [vis, setVis] = usePersistentState<LayerVis>('karmyogi.pcb.layerVis', {
    copper: true,
    pads: true,
    drill: true,
    outline: true,
  })

  // Combined extents across every loaded layer, for the viewBox.
  const box = useMemo(() => {
    const b = new BBox()
    if (copper) b.expand(copper.bounds())
    if (outline) b.expand(outline.bounds())
    if (drill) b.expand(drill.bounds())
    return b
  }, [copper, outline, drill])

  if (!box.isValid()) return null
  const pad = Math.max(1, Math.max(box.width(), box.height()) * 0.04)
  const minX = box.min.x - pad
  const minY = box.min.y - pad
  const w = box.width() + pad * 2
  const h = box.height() + pad * 2
  // Flip Y inside the viewBox: translate + negative scale via a group transform.
  const flip = `translate(0 ${2 * minY + h}) scale(1 -1)`
  const strokeW = Math.max(w, h) / 900

  const ptsStr = (pl: Polyline) => pl.points.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <div className="pcb-lv">
      <div className="pcb-lv-toggles" role="group" aria-label={t('pcb.lv.aria', 'Layer visibility')}>
        {([
          ['copper', t('pcb.lv.copper', 'Copper'), 'var(--pcb-copper)'],
          ['pads', t('pcb.lv.pads', 'Pads'), 'var(--pcb-pad)'],
          ['drill', t('pcb.lv.drill', 'Drill'), 'var(--pcb-drill)'],
          ['outline', t('pcb.lv.outline', 'Outline'), 'var(--pcb-outline)'],
        ] as [keyof LayerVis, string, string][]).map(([key, label, color]) => (
          <button
            key={key}
            className={'pcb-lv-tog' + (vis[key] ? ' on' : '')}
            onClick={() => setVis((v) => ({ ...v, [key]: !v[key] }))}
            aria-pressed={vis[key]}
          >
            <span className="pcb-lv-sw" style={{ background: color }} />
            {label}
          </button>
        ))}
      </div>
      <svg
        className="pcb-lv-svg"
        viewBox={`${minX} ${minY} ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t('pcb.lv.svgAria', 'PCB layer preview')}
      >
        <g transform={flip}>
          {/* Outline */}
          {vis.outline && outline && (
            <g className="pcb-lv-outline">
              {outline.regions.map((r, i) => (
                <polygon key={'or' + i} points={ptsStr(r)} fill="none" stroke="var(--pcb-outline)" strokeWidth={strokeW * 2} />
              ))}
              {outline.traces.map((tr, i) => (
                <polyline key={'ot' + i} points={ptsStr(tr.centreline)} fill="none" stroke="var(--pcb-outline)" strokeWidth={strokeW * 2} />
              ))}
            </g>
          )}
          {/* Copper regions + traces */}
          {vis.copper && copper && (
            <g className="pcb-lv-copper">
              {copper.regions.map((r, i) => (
                <polygon key={'cr' + i} points={ptsStr(r)} fill="var(--pcb-copper)" fillOpacity={0.5} stroke="none" />
              ))}
              {copper.traces.map((tr, i) => (
                <polyline
                  key={'ct' + i}
                  points={ptsStr(tr.centreline)}
                  fill="none"
                  stroke="var(--pcb-copper)"
                  strokeOpacity={0.85}
                  strokeWidth={Math.max(strokeW, tr.width)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </g>
          )}
          {/* Pads */}
          {vis.pads && copper && (
            <g className="pcb-lv-pads">
              {copper.pads.map((p, i) => (
                <polygon key={'pad' + i} points={ptsStr(p)} fill="var(--pcb-pad)" fillOpacity={0.8} stroke="none" />
              ))}
            </g>
          )}
          {/* Drill hits */}
          {vis.drill && drill && (
            <g className="pcb-lv-drill">
              {drill.hits.map((hit, i) => (
                <circle
                  key={'d' + i}
                  cx={hit.pos.x}
                  cy={hit.pos.y}
                  r={Math.max(strokeW * 2, hit.diameter / 2)}
                  fill="var(--pcb-drill)"
                  stroke="#0006"
                  strokeWidth={strokeW}
                />
              ))}
            </g>
          )}
        </g>
      </svg>
    </div>
  )
}

/**
 * The Preview / Generate / Run button row shared by every operation card. Run is
 * a two-step armed confirm (styled in-panel, no native dialog): the first tap
 * arms it (handled by the parent, which sets `armed`), and while armed this shows
 * a Run-confirm + Cancel pair instead. Buttons disable when the op has no source
 * layer (`ready`), or — for Run — when the machine is disconnected/busy.
 */
function OpActions({
  t,
  ready,
  armed,
  connected,
  machineBusy,
  onPreview,
  onGenerate,
  onPlay,
  onConfirm,
  onCancel,
}: {
  t: TFn
  ready: boolean
  armed: boolean
  connected: boolean
  machineBusy: boolean
  onPreview: () => void
  onGenerate: () => void
  onPlay: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  if (armed) {
    return (
      <div className="pcb-op-actions">
        <button className="pcb-run-confirm" onClick={onConfirm} disabled={machineBusy}>
          <Icon name="play" size={13} />
          {t('pcb.layers.confirmRun', 'Run')}
        </button>
        <button className="pcb-op-btn" onClick={onCancel}>
          <Icon name="close" size={13} />
          {t('pcb.layers.cancelRun', 'Cancel')}
        </button>
      </div>
    )
  }
  return (
    <div className="pcb-op-actions">
      <button className="pcb-op-btn" onClick={onPreview} disabled={!ready}>
        <Icon name="eye" size={13} />
        {t('pcb.op.preview', 'Preview')}
      </button>
      <button className="pcb-op-btn" onClick={onGenerate} disabled={!ready}>
        <Icon name="download" size={13} />
        {t('pcb.op.generate', 'Generate')}
      </button>
      <button
        className="pcb-op-btn primary"
        onClick={onPlay}
        disabled={!ready || !connected || machineBusy}
        title={
          !ready
            ? t('pcb.op.notReady', 'Assign the required layer first')
            : !connected
            ? t('pcb.layers.connectToRunTitle', 'Connect to the machine to run')
            : machineBusy
            ? t('pcb.layers.busyTitle', 'Machine is busy — wait for the current job')
            : t('pcb.op.runTitle', 'Stream this operation to the machine')
        }
      >
        <Icon name="play" size={13} />
        {t('pcb.op.run', 'Run')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Auto-leveling (heightmap) section — O1/P1
// ---------------------------------------------------------------------------

/** Parse a GRBL `[PRB:x,y,z:s]` probe-result line; undefined if it isn't one. */
function parsePrb(line: string): { x: number; y: number; z: number; ok: boolean } | undefined {
  const m = /^\[PRB:(-?\d+\.?\d*),(-?\d+\.?\d*),(-?\d+\.?\d*):([01])\]$/.exec(line.trim())
  if (!m) return undefined
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: parseFloat(m[3]), ok: m[4] === '1' }
}

/** A small numeric field with label + InfoTip, mirroring the panel vocabulary. */
function LvlField({
  label,
  tip,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  disabled,
}: {
  label: string
  tip?: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
  unit?: string
  disabled?: boolean
}) {
  return (
    <label className="lvl-field">
      <span className="lvl-field-lbl">
        {label}
        {unit ? ` (${unit})` : ''}
        {tip ? <InfoTip topic="" title={label} body={tip} /> : null}
      </span>
      <input
        type="number"
        value={String(value)}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
    </label>
  )
}

/**
 * The 2D heat-map preview. Renders the probed surface to a small <canvas>:
 * each grid cell is bilinearly shaded from a cool→warm scale across the probed
 * Z range, with the probe points dotted on top. Pure render off the map (no 3D
 * viewer touched). Cool = low (recessed), warm = high (raised).
 */
function HeatMap({ map, size = 168 }: { map: HeightMap; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const w = map.area.maxX - map.area.minX || 1
    const h = map.area.maxY - map.area.minY || 1
    // Keep aspect ratio inside a `size`-px box.
    const aspect = w / h
    const cw = aspect >= 1 ? size : Math.round(size * aspect)
    const ch = aspect >= 1 ? Math.round(size / aspect) : size
    cv.width = cw
    cv.height = ch
    const { min, max } = zExtent(map)
    const span = max - min || 1
    // Cool→warm gradient stops.
    const grad = (t: number): [number, number, number] => {
      const stops: [number, [number, number, number]][] = [
        [0, [43, 89, 255]],
        [0.4, [22, 194, 163]],
        [0.7, [255, 210, 63]],
        [1, [255, 90, 60]],
      ]
      for (let i = 1; i < stops.length; i++) {
        if (t <= stops[i][0]) {
          const [a, ca] = stops[i - 1]
          const [b, cb] = stops[i]
          const f = (t - a) / (b - a || 1)
          return [
            Math.round(ca[0] + (cb[0] - ca[0]) * f),
            Math.round(ca[1] + (cb[1] - ca[1]) * f),
            Math.round(ca[2] + (cb[2] - ca[2]) * f),
          ]
        }
      }
      return stops[stops.length - 1][1]
    }
    const img = ctx.createImageData(cw, ch)
    for (let py = 0; py < ch; py++) {
      for (let px = 0; px < cw; px++) {
        // Map pixel → work XY (flip Y so +Y is up, like the bed view).
        const x = map.area.minX + (px / (cw - 1 || 1)) * w
        const y = map.area.maxY - (py / (ch - 1 || 1)) * h
        const z = sampleHeight(map, x, y)
        const [r, g, b] = grad((z - min) / span)
        const o = (py * cw + px) * 4
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    // Probe-point dots.
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    for (const p of map.points) {
      const px = ((p.x - map.area.minX) / w) * (cw - 1)
      const py = ((map.area.maxY - p.y) / h) * (ch - 1)
      ctx.beginPath()
      ctx.arc(px, py, 1.6, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [map, size])
  return <canvas ref={ref} className="lvl-heat" style={{ width: 'auto' }} />
}

type LvlT = (key: string, english: string, vars?: Record<string, string | number>) => string

/** Probe-cycle phase. */
type ProbePhase = 'idle' | 'running' | 'done' | 'error'

/**
 * Auto-leveling section: define the probe area, run the G38.2 grid probe, see a
 * 2D heat-map of the surface, and choose how the warp is applied (off / on-fly /
 * baked — mutually exclusive). The probe cycle drives the existing controller
 * command API (grbl.send) and listens to the console for `[PRB:…]` results; it
 * never edits the serial layer.
 */
function AutoLevelSection({
  t,
  bounds,
  connected,
  machineBusy,
  machineState,
}: {
  t: LvlT
  bounds: ProbeArea
  connected: boolean
  machineBusy: boolean
  machineState: string
}) {
  const map = useHeightmap((s) => s.map)
  const setMap = useHeightmap((s) => s.setMap)
  const clearMap = useHeightmap((s) => s.clearMap)
  const applyMode = useHeightmap((s) => s.applyMode)
  const setApplyMode = useHeightmap((s) => s.setApplyMode)
  const maxSegment = useHeightmap((s) => s.maxSegment)
  const setMaxSegment = useHeightmap((s) => s.setMaxSegment)
  const margin = useHeightmap((s) => s.margin)
  const setMargin = useHeightmap((s) => s.setMargin)
  const probeFeed = useHeightmap((s) => s.probeFeed)
  const setProbeFeed = useHeightmap((s) => s.setProbeFeed)
  const probeDepth = useHeightmap((s) => s.probeDepth)
  const setProbeDepth = useHeightmap((s) => s.setProbeDepth)
  const probeClearance = useHeightmap((s) => s.probeClearance)

  const area = useMemo(() => expandArea(bounds, margin), [bounds, margin])
  const [spacing, setSpacing] = useState<number>(() => Math.round(defaultSpacing(area)))
  const grid = useMemo(() => gridForSpacing(area, spacing), [area, spacing])

  const [phase, setPhase] = useState<ProbePhase>('idle')
  const [status, setStatus] = useState<string>('')
  const [statusErr, setStatusErr] = useState(false)
  // Probe progress (points done / total) while a cycle runs.
  const [done, setDone] = useState(0)

  // The live probe-cycle state lives in a ref so the async loop isn't restarted
  // by React re-renders.
  const cycle = useRef<{
    seq: ProbePoint[]
    idx: number
    work: HeightMap
    abort: boolean
  } | null>(null)
  const lastSeen = useRef(0)

  const mapComplete = !!map && isComplete(map)
  const probedNow = map ? probedCount(map) : 0
  const z = map ? zExtent(map) : { min: 0, max: 0 }
  const warp = z.max - z.min

  const finishCycle = (ok: boolean) => {
    const c = cycle.current
    cycle.current = null
    if (!c) return
    if (ok) {
      setMap(c.work)
      setPhase('done')
      const e = zExtent(c.work)
      setStatusErr(false)
      setStatus(
        t('pcb.level.status.done', 'Probed {n} points — surface warp {warp} mm (Z {min}…{max}).', {
          n: c.seq.length,
          warp: (e.max - e.min).toFixed(3),
          min: e.min.toFixed(3),
          max: e.max.toFixed(3),
        }),
      )
    }
  }

  // Send the probe sequence for the next point: rapid to safe-Z, move XY, slow
  // G38.2 plunge. The [PRB:…] reply (watched below) records Z and advances.
  const probeNext = () => {
    const c = cycle.current
    if (!c || c.abort) return
    if (c.idx >= c.seq.length) {
      finishCycle(true)
      return
    }
    const p = c.seq[c.idx]
    setDone(c.idx)
    grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
    grbl.send(`G0 X${p.x.toFixed(3)} Y${p.y.toFixed(3)}`).catch(() => {})
    grbl.send(`G38.2 Z${(-Math.abs(probeDepth)).toFixed(3)} F${Math.abs(probeFeed)}`).catch(() => {})
  }

  // Watch the console for [PRB:…] replies and advance the cycle.
  useEffect(() => {
    const entries = useConsole.getState().entries
    lastSeen.current = entries.length ? entries[entries.length - 1].id : 0
    const unsub = useConsole.subscribe((s) => {
      const c = cycle.current
      if (!c || c.abort) return
      for (const e of s.entries) {
        if (e.id <= lastSeen.current) continue
        lastSeen.current = e.id
        if (e.dir !== 'recv') continue
        const prb = parsePrb(e.text)
        if (!prb) continue
        if (!prb.ok) {
          c.abort = true
          cycle.current = null
          setPhase('error')
          setStatusErr(true)
          setStatus(
            t('pcb.level.status.noContact', 'No probe contact at point {i} — cycle stopped. Check wiring / Z range.', {
              i: c.idx + 1,
            }),
          )
          return
        }
        // Record the touched Z at this grid point, CONVERTED to the WORK frame.
        // GRBL reports [PRB:...] in MACHINE coords; the heightmap warps work-frame
        // cut Z, so subtract the active work-coordinate offset (WPos = MPos − WCO).
        const pt = c.seq[c.idx]
        const node = c.work.points.find((n) => n.ix === pt.ix && n.iy === pt.iy)
        if (node) node.z = prb.z - useMachine.getState().wco.z
        c.idx++
        // Retract before the next move, then probe on.
        grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
        probeNext()
      }
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // An Alarm aborts the cycle (a no-contact G38.2 alarms on real GRBL).
  useEffect(() => {
    if (phase === 'running' && machineState === 'Alarm' && cycle.current) {
      cycle.current.abort = true
      cycle.current = null
      setPhase('error')
      setStatusErr(true)
      setStatus(t('pcb.level.status.alarm', 'Machine alarmed during probing — Unlock ($X) and check the probe.'))
    }
  }, [machineState, phase, t])

  // A dropped connection aborts an in-flight cycle.
  useEffect(() => {
    if (!connected && cycle.current) {
      cycle.current.abort = true
      cycle.current = null
      setPhase('idle')
    }
  }, [connected])

  const startProbe = () => {
    if (!connected || machineBusy) {
      setStatusErr(true)
      setStatus(t('pcb.level.status.connectFirst', 'Connect (and free the machine) before probing.'))
      return
    }
    const fresh = probeGrid(area, grid)
    const seq = snakeOrder(fresh)
    cycle.current = { seq, idx: 0, work: fresh, abort: false }
    setDone(0)
    setPhase('running')
    setStatusErr(false)
    setStatus(t('pcb.level.status.probing', 'Probing {n} points… keep clear. Runs slow on purpose.', { n: seq.length }))
    probeNext()
  }

  const abortProbe = () => {
    if (cycle.current) cycle.current.abort = true
    cycle.current = null
    setPhase('idle')
    setStatus(t('pcb.level.status.aborted', 'Probe cycle stopped.'))
    grbl.send(`G0 Z${probeClearance.toFixed(3)}`).catch(() => {})
  }

  // ── Gamepad command bus: start (or stop) the height-map probe cycle. ──
  // Registered for the SAME 'pcb' tab as the board panel; the registry merges
  // both registrants so board + level commands coexist. Toggles: stop if running.
  useTabCommands('pcb', {
    levelProbe: () => {
      if (phase === 'running') abortProbe()
      else startProbe()
    },
  })

  const running = phase === 'running'
  const total = grid.nx * grid.ny

  // The apply selector is locked while probing or with no complete map (a stale /
  // partial surface must never warp a board).
  const canApply = mapComplete && !running

  const setMode = (m: ApplyMode) => {
    if (!canApply && m !== 'off') return
    setApplyMode(m)
  }

  return (
    <section className="pcb-section pcb-section-wide">
      <h3>
        <span className="cam-card-ico" aria-hidden="true">
          <Icon name="probe" size={15} />
        </span>
        {t('pcb.level.title', 'Auto-leveling (heightmap)')}
        {applyMode !== 'off' && mapComplete && (
          <span className="lvl-applied-badge">
            <Icon name="zero" size={11} />
            {applyMode === 'baked'
              ? t('pcb.level.badge.baked', 'baked in')
              : t('pcb.level.badge.onfly', 'on-the-fly')}
          </span>
        )}
      </h3>
      <div className="pcb-section-body">
        <div className="lvl-body">
          <div className="lvl-safety">
            <Icon name="warning" size={15} />
            <span>
              {t(
                'pcb.level.safety',
                'Wire the probe clip to the tool and the plate/clip to the copper first. The cycle lowers the tool slowly at each grid point — keep clear. Sets work Z=0 as your surface datum.',
              )}
            </span>
          </div>

          <div className="lvl-steps">
            {/* Step 1 — define the probe area + grid. */}
            <div className="lvl-step">
              <div className="lvl-step-head">
                <span className="lvl-step-num">1</span>
                {t('pcb.level.step1', 'Define probe area')}
              </div>
              <div className="lvl-area-readout">
                {t('pcb.level.area', 'Area {w} × {h} mm (from toolpath + margin)', {
                  w: (area.maxX - area.minX).toFixed(1),
                  h: (area.maxY - area.minY).toFixed(1),
                })}
                {' · '}
                <b>
                  {t('pcb.level.gridSize', '{nx} × {ny} = {n} points', {
                    nx: grid.nx,
                    ny: grid.ny,
                    n: grid.nx * grid.ny,
                  })}
                </b>
              </div>
              <div className="lvl-fields">
                <LvlField
                  label={t('pcb.level.margin', 'Margin')}
                  unit="mm"
                  tip={t('pcb.level.marginTip', 'Extra border probed around the toolpath extents, so edge traces still sit on interpolated surface.')}
                  value={margin}
                  onChange={setMargin}
                  min={0}
                  max={50}
                  step={0.5}
                  disabled={running}
                />
                <LvlField
                  label={t('pcb.level.spacing', 'Point spacing')}
                  unit="mm"
                  tip={t('pcb.level.spacingTip', 'Target distance between probe points. Smaller spacing = more points = a finer surface map (and a slower probe cycle). ~ board/10 is a good start.')}
                  value={spacing}
                  onChange={(n) => setSpacing(Math.max(1, n))}
                  min={1}
                  max={50}
                  step={1}
                  disabled={running}
                />
                <LvlField
                  label={t('pcb.level.probeFeed', 'Probe feed')}
                  unit="mm/min"
                  tip={t('pcb.level.probeFeedTip', 'How fast the tool lowers toward the copper at each point. Keep it slow for an accurate, gentle touch-off.')}
                  value={probeFeed}
                  onChange={setProbeFeed}
                  min={5}
                  max={500}
                  step={5}
                  disabled={running}
                />
                <LvlField
                  label={t('pcb.level.probeDepth', 'Max plunge')}
                  unit="mm"
                  tip={t('pcb.level.probeDepthTip', 'Give up (and stop the cycle) if no contact is made within this distance below safe-Z. A guard against a mis-wired probe.')}
                  value={probeDepth}
                  onChange={setProbeDepth}
                  min={0.5}
                  max={50}
                  step={0.5}
                  disabled={running}
                />
              </div>
            </div>

            {/* Step 2 — run the probe cycle. */}
            <div className={'lvl-step' + (mapComplete ? ' done' : '')}>
              <div className="lvl-step-head">
                <span className="lvl-step-num">2</span>
                {t('pcb.level.step2', 'Probe the surface')}
              </div>
              <p className="lvl-hint">
                {t(
                  'pcb.level.step2Hint',
                  'Rapids to safe-Z, moves over each point, then slowly G38.2-touches down — recording the board height. Needs a connected machine with the probe wired.',
                )}
              </p>
              {running ? (
                <div className="lvl-progress">
                  <span>
                    {t('pcb.level.probingN', 'Probing point {i} of {n}…', { i: done + 1, n: total })}
                  </span>
                  <div className="lvl-bar">
                    <span style={{ width: `${(done / Math.max(1, total)) * 100}%` }} />
                  </div>
                </div>
              ) : mapComplete ? (
                <div className="lvl-progress">
                  <span>
                    {t('pcb.level.probedOk', '✓ {n} points probed · warp {warp} mm', {
                      n: probedNow,
                      warp: warp.toFixed(3),
                    })}
                  </span>
                </div>
              ) : null}
              <div className="lvl-actions">
                {running ? (
                  <button className="lvl-btn danger" onClick={abortProbe}>
                    <Icon name="stop" size={14} />
                    {t('pcb.level.stop', 'Stop probing')}
                  </button>
                ) : (
                  <button
                    className="lvl-btn primary"
                    onClick={startProbe}
                    disabled={!connected || machineBusy}
                    title={
                      !connected
                        ? t('pcb.level.connectFirst', 'Connect to the machine first')
                        : machineBusy
                        ? t('pcb.level.busy', 'Machine is busy — wait for the current job')
                        : t('pcb.level.probeTitle', 'Run the grid probe cycle (moves the machine)')
                    }
                  >
                    <Icon name="probe" size={14} />
                    {mapComplete ? t('pcb.level.reprobe', 'Re-probe') : t('pcb.level.probe', 'Probe now')}
                  </button>
                )}
                {map && !running && (
                  <button className="lvl-btn" onClick={clearMap} title={t('pcb.level.clearTitle', 'Discard the probed surface and turn the warp off')}>
                    <Icon name="trash" size={14} />
                    {t('pcb.level.clear', 'Clear map')}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 3 — preview the heat-map. */}
          <div className="lvl-step">
            <div className="lvl-step-head">
              <span className="lvl-step-num">3</span>
              {t('pcb.level.step3', 'Surface preview')}
            </div>
            {map && mapComplete ? (
              <div className="lvl-preview">
                <HeatMap map={map} />
                <div className="lvl-scale">
                  <span>{t('pcb.level.scaleTitle', 'Height (mm)')}</span>
                  <div className="lvl-scale-row">
                    <div className="lvl-scale-bar" aria-hidden="true" />
                    <div className="lvl-scale-vals">
                      <b>{z.max.toFixed(3)}</b>
                      <span>{((z.max + z.min) / 2).toFixed(3)}</span>
                      <b>{z.min.toFixed(3)}</b>
                    </div>
                  </div>
                  <span className="lvl-hint">{t('pcb.level.scaleHint', 'warm = high · cool = low')}</span>
                </div>
              </div>
            ) : (
              <p className="lvl-empty">
                {t('pcb.level.noMap', 'Probe the surface to see a 2D height map of the board here.')}
              </p>
            )}
          </div>

          {/* Step 4 — apply (mutually-exclusive selector). */}
          <div className="lvl-step">
            <div className="lvl-step-head">
              <span className="lvl-step-num">4</span>
              {t('pcb.level.step4', 'Apply to G-code')}
              <InfoTip
                topic=""
                title={t('pcb.level.applyTipTitle', 'Apply exactly once')}
                body={t(
                  'pcb.level.applyTip',
                  'The Z-warp must be applied ONCE. "On-the-fly" warps the lines as they stream (the saved program stays flat); "Baked in" folds the warp into the generated G-code (the Visualizer shows the surface-following path). Pick one — applying both would double-offset Z and ruin the board.',
                )}
              />
            </div>
            <div className="lvl-modes" role="group" aria-label={t('pcb.level.applyAria', 'Heightmap apply mode')}>
              <button
                className={applyMode === 'off' ? 'active' : ''}
                onClick={() => setMode('off')}
                title={t('pcb.level.modeOffTitle', 'No leveling — flat Z')}
              >
                {t('pcb.level.modeOff', 'Off')}
              </button>
              <button
                className={applyMode === 'onfly' ? 'active' : ''}
                onClick={() => setMode('onfly')}
                disabled={!canApply}
                title={t('pcb.level.modeOnflyTitle', 'Warp Z as the program streams (program stays flat)')}
              >
                {t('pcb.level.modeOnfly', 'On-the-fly')}
              </button>
              <button
                className={applyMode === 'baked' ? 'active' : ''}
                onClick={() => setMode('baked')}
                disabled={!canApply}
                title={t('pcb.level.modeBakedTitle', 'Bake the warp into the generated G-code (shown in the Visualizer)')}
              >
                {t('pcb.level.modeBaked', 'Baked in')}
              </button>
            </div>
            <div className="lvl-fields">
              <LvlField
                label={t('pcb.level.maxSeg', 'Segment length')}
                unit="mm"
                tip={t('pcb.level.maxSegTip', 'Long cuts are split into segments this short so Z follows the surface between probe points. Arcs are linearized first. Smaller = smoother warp, more lines.')}
                value={maxSegment}
                onChange={setMaxSegment}
                min={0.2}
                max={10}
                step={0.1}
                disabled={running}
              />
            </div>
            {!mapComplete && (
              <p className="lvl-hint">
                {t('pcb.level.applyNeedsMap', 'Probe a full surface (step 2) to enable on-the-fly / baked leveling.')}
              </p>
            )}
            {mapComplete && applyMode !== 'off' && (
              <p className="lvl-hint">
                {applyMode === 'baked'
                  ? t('pcb.level.bakedNote', 'Generated PCB G-code is warped to follow the surface — Preview/Generate/Run all use the leveled path.')
                  : t('pcb.level.onflyNote', 'PCB programs stream with Z warped on-the-fly; the saved/previewed program stays flat.')}
              </p>
            )}
          </div>

          {status && (
            <p className={'lvl-status' + (statusErr ? ' err' : phase === 'done' ? ' ok' : '')} role="status" aria-live="polite">
              {status}
            </p>
          )}
        </div>
      </div>
    </section>
  )
}
