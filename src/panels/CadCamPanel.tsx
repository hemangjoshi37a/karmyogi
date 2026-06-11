import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { importDxfString } from '../core/dxf'
import { Drawing } from '../core/entity'
import { engrave, profileContours, pocket, ProfileSide, type CamParams } from '../core/cam'
import { orderLoopsInsideOut } from '../core/geometry'
import { defaultTool, type Tool, Toolpath } from '../core/toolpath'
import { GcodeEmitter, ZMode } from '../core/gcodeEmitter'
import { Polyline, BBox } from '../core/geometry'
import { type StlMesh } from '../core/slicer'
import { importMesh, isHeavyMeshFile } from '../core/meshImport'
import { uploadUserFile } from '../track/fileVault'
import {
  parseEpsPaths,
  defaultCarve3DParams,
  autoCarveParams,
  type Carve3DParams,
  type ToolType,
  type CarveJobSpec,
  type CarveProgramGlobals,
  type CarveWorkerRequest,
  type CarveWorkerOutbound,
} from '../core/carve3d'
import { defaultCutoutParams, type CutoutParams } from '../core/cutout'
import {
  buildTwoSidedProgram,
  defaultTwoSidedParams,
  flipCornerLabel,
  flippedCorner,
  type TwoSidedParams,
  type FlipAxis,
  type FlipCorner,
} from '../core/twoSided'
import { useProgram, usePersistentState } from '../store'
import {
  useCarveJobs,
  type CarveJob,
  type ApplyAllKey,
  type JobDefaults,
  type GlobalCarveSettings,
} from '../store/carveJobs'
import { useBed } from '../store/bed'
import { MATERIALS, getMaterial, DEFAULT_MATERIAL_ID, type MaterialPreset } from '../core/materials'
import {
  BIT_TYPES,
  bitsOfType,
  getBit,
  recommend,
  DEFAULT_BIT_ID,
  type BitType,
} from '../core/toolLibrary'
import { useStock } from '../store/stock'
import { useCameraCalib } from '../store/cameraCalib'
import { useExperimentalAI } from '../experimental'
import { Modal } from '../components/Modal'
import { InfoTip } from '../components/InfoTip'
import { Icon } from '../components/Icons'
import {
  PenLine,
  Frame,
  Grid2x2,
  MoveHorizontal,
  MoveVertical,
  MoveDiagonal,
  Drill,
  ArrowDownToLine,
  Layers,
  ArrowUpToLine,
  AlignVerticalSpaceBetween,
  Gauge,
  FastForward,
  Hash,
  ChevronsLeftRightEllipsis,
  Grip,
  Link2,
  Link2Off,
  RotateCw,
  Maximize2,
  Ruler,
  FlipHorizontal2,
  FlipVertical2,
} from 'lucide-react'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { usePresets } from '../components/presets/usePresets'
import { useT } from '../i18n'
import '../styles/cadcam.css'

/** Which import family is currently loaded — drives the whole panel layout. */
type Mode = 'none' | '3d' | '2d' | 'step' | 'cdr'

type Op = 'Engrave' | 'Profile' | 'Pocket'

// ============================================================================
// Color-coded SETTING PRESETS for the carving tab
// ----------------------------------------------------------------------------
// The floating rail on the left edge loads a slot's settings; the footer
// save-bar writes the CURRENT settings into the slot whose colour is selected.
// The generic slot machinery (10 colour slots, persistence, capture/apply
// wiring) lives in components/presets/usePresets; here we only define the
// carving snapshot shape and the capture/apply callbacks. A preset is a full
// snapshot of the tunable carving parameters (NOT the loaded geometry/jobs): 2D
// op + vector params + cutout, the chosen bit, the material, and the 3D carve
// global + job defaults.
// ============================================================================
interface CarvePreset {
  op: Op
  side: ProfileSide
  p2d: Params2D
  cutout: CutoutParams
  bitId: string
  bitLength: number
  materialId: string
  carveGlobal: GlobalCarveSettings
  carveDefaults: JobDefaults
}

/** Per-axis colours mirror the Visualizer's axis gizmo (X red, Y green, Z blue). */
const AXIS_COLOR = { x: '#ef4444', y: '#22c55e', z: '#3b82f6' } as const

/**
 * "MAX" free/travel speed (mm/min) for the auto-computed link feed. Safe-Z
 * retracts and re-positions are emitted as G0 rapids (the controller's true max
 * rate); this is the G1 feed used only for short in-material travel links, kept
 * deliberately high so non-cutting motion is as fast as the rig allows.
 */
const RAPID_FEED_MM_MIN = 3000

/**
 * A compact info affordance with an INLINE title + body (no explainers.ts entry).
 * We pass a synthetic topic so InfoTip is happy, but always override both texts
 * so the explanation lives right here next to the field it documents.
 */
function Tip({ id, title, body }: { id: string; title: string; body: string }) {
  return <InfoTip topic={`cc.inline.${id}`} title={title} body={body} />
}

/**
 * Sleek slider + number-input + unit row for the carving parameter fields,
 * modelled on the Controller tab's jog "Feed" control. A full-width row: leading
 * glyph + label, a themed draggable `.cc-slider` (accent fill via the inline
 * `--mc-pct` var), a small typable `.cc-slider-num` clamped to [min, max] for the
 * slider but allowing exact entry, and an inline unit suffix. The optional
 * `.cc-rechint` recommendation flows onto its own line below (same as IconField).
 *
 * `value`/`onChange` carry the field's existing wiring untouched — only the input
 * WIDGET changes (number box → slider + input). `disabled` greys it out when a
 * field has no meaningful value (e.g. Width/Height with no geometry).
 */
function SliderField({
  icon,
  label,
  htmlFor,
  unit,
  hint,
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  title,
  action,
}: {
  icon: ReactNode
  label: string
  htmlFor: string
  unit?: string
  hint?: ReactNode
  value: number
  onChange: (n: number) => void
  min: number
  max: number
  step: number
  disabled?: boolean
  title?: string
  /** Optional trailing control in the label area (e.g. an "apply to all" button). */
  action?: ReactNode
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : min))
  // Filled-track percentage for the slider's accent fill (read as --mc-pct by the
  // WebKit/Blink track gradient; Firefox fills via ::-moz-range-progress). Uses the
  // CLAMPED value so an out-of-range typed value doesn't overflow the fill.
  const pct =
    max > min ? Math.min(100, Math.max(0, ((clamp(value) - min) / (max - min)) * 100)) : 0
  return (
    <div className="cc-sfield" title={title}>
      <label className="cc-sfield-lbl" htmlFor={htmlFor}>
        <span className="cc-sfield-ico" aria-hidden>
          {icon}
        </span>
        <span className="cc-sfield-txt">{label}</span>
      </label>
      <input
        type="range"
        className="cc-slider"
        min={min}
        max={max}
        step={step}
        value={clamp(value)}
        disabled={disabled}
        style={{ '--mc-pct': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(clamp(Number(e.target.value)))}
        aria-label={label}
        tabIndex={-1}
      />
      <span className="cc-sfield-num">
        <input
          id={htmlFor}
          type="number"
          className="cc-slider-num"
          min={min}
          max={max}
          step={step}
          value={String(value)}
          disabled={disabled}
          aria-label={label}
          onChange={(e) => {
            // Allow EXACT entry (don't clamp the typed number) — a half-typed or
            // out-of-slider-range value is still committed verbatim; only blank/NaN
            // is rejected by the caller's own num2d/onChange guard.
            const v = parseFloat(e.target.value)
            if (Number.isFinite(v)) onChange(v)
          }}
        />
        {unit ? <span className="cc-sfield-unit">{unit}</span> : null}
      </span>
      {action ? <span className="cc-sfield-action">{action}</span> : null}
      {hint ? <span className="cc-rechint">{hint}</span> : null}
    </div>
  )
}

/**
 * Adobe-style chain-link toggle that sits BETWEEN a pair of SliderFields (Scale
 * X/Y and Width/Height) to lock/unlock their aspect ratio. One shared boolean
 * drives both link buttons (locking scale ⇔ locking W/H is the same constraint).
 */
function AspectLink({
  locked,
  onToggle,
  disabled,
  title,
}: {
  locked: boolean
  onToggle: () => void
  disabled?: boolean
  title?: string
}) {
  return (
    <button
      type="button"
      className={`cc-aspectlink${locked ? ' is-locked' : ''}`}
      aria-pressed={locked}
      disabled={disabled}
      title={title}
      onClick={onToggle}
    >
      {locked ? <Link2 size={13} strokeWidth={1.9} /> : <Link2Off size={13} strokeWidth={1.9} />}
    </button>
  )
}

/** Map a library BitType onto the 3D carver's two tool shapes. */
function bitTypeToToolType(t: BitType): ToolType {
  return t === 'ball' ? 'ball' : 'flat'
}

/** Pretty value rows for the material-info modal. */
function MaterialInfoModal({
  material,
  onClose,
  t,
}: {
  material: MaterialPreset | null
  onClose: () => void
  t: ReturnType<typeof useT>
}) {
  const CATEGORY_LABEL: Record<MaterialPreset['category'], string> = {
    wood: t('mat.cat.wood', 'Wood'),
    plastic: t('mat.cat.plastic', 'Plastic'),
    pcb: t('mat.cat.pcb', 'PCB'),
    metal: t('mat.cat.metal', 'Metal'),
    foam: t('mat.cat.foam', 'Foam'),
    other: t('mat.cat.other', 'Other'),
  }
  const m = material
  return (
    <Modal
      open={!!m}
      title={m ? t(m.i18nKey, m.name) : ''}
      onClose={onClose}
      width={560}
    >
      {m && (
        <div className="cc-matinfo">
          <div className="cc-matinfo-hero">
            {m.image ? (
              <img className="cc-matinfo-img" src={m.image} alt={t(m.i18nKey, m.name)} />
            ) : (
              <span className="cc-matinfo-emoji" aria-hidden>
                {m.icon}
              </span>
            )}
          </div>
          <p className="cc-matinfo-notes">{t(m.notesKey, m.notes)}</p>
          <dl className="cc-matinfo-props">
            <div>
              <dt>{t('cc.matCategory', 'Category')}</dt>
              <dd>{CATEGORY_LABEL[m.category]}</dd>
            </div>
            <div>
              <dt>{t('cc.feedXY', 'Feed XY')}</dt>
              <dd>{m.feedXY} mm/min</dd>
            </div>
            <div>
              <dt>{t('cc.feedZ', 'Plunge Z')}</dt>
              <dd>{m.feedZ} mm/min</dd>
            </div>
            <div>
              <dt>{t('cc.spindleRPM', 'Spindle RPM')}</dt>
              <dd>{m.spindleRPM.toLocaleString()}</dd>
            </div>
            <div>
              <dt>{t('cc.matStepdown', 'Depth / pass')}</dt>
              <dd>{Math.round(m.stepdownFraction * 100)}% of bit ⌀</dd>
            </div>
            <div>
              <dt>{t('cc.matStepover', 'Stepover')}</dt>
              <dd>{Math.round(m.stepoverFraction * 100)}% of bit ⌀</dd>
            </div>
          </dl>
          <p className="cc-matinfo-hint">
            {t(
              'cc.matInfoHint',
              'Baseline feeds/speeds for a hobby 3-axis router — scaled for your actual bit on the Recommended panel.',
            )}
          </p>
        </div>
      )}
    </Modal>
  )
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
  /** Position/size placement of the imported 2D drawing (mm / per-axis factor). */
  offsetX: number
  offsetY: number
  /** Independent X/Y scale factors (non-uniform allowed when aspect unlocked). */
  scaleX: number
  scaleY: number
  /** When true the X/Y scale (and thus Width/Height) are locked to one ratio. */
  aspectLocked: boolean
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
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    aspectLocked: true,
  }
})()

/** The serializable 3D-Carving document written by Save / read by Load. */
interface CarveDoc {
  kind: 'karmyogi.carve'
  version: 1
  bitId: string
  bitLength: number
  p2d: Params2D
  cutout: CutoutParams
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f
const boolOr = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)

/** Narrow unknown into valid CutoutParams, falling back to the normalised base. */
function parseCutout(v: unknown, base: CutoutParams): CutoutParams {
  if (!isRecord(v)) return base
  const shape = v.shape === 'outline' || v.shape === 'rect' ? v.shape : base.shape
  const t = isRecord(v.tabs) ? v.tabs : {}
  const r = isRecord(v.rect) ? v.rect : {}
  const rectMode = r.mode === 'auto' || r.mode === 'manual' ? r.mode : base.rect.mode
  return {
    enabled: boolOr(v.enabled, base.enabled),
    shape,
    clearAround: boolOr(v.clearAround, base.clearAround),
    stockThicknessMm: numOr(v.stockThicknessMm, base.stockThicknessMm),
    cutStepdownMm: numOr(v.cutStepdownMm, base.cutStepdownMm),
    breakThroughMm: numOr(v.breakThroughMm, base.breakThroughMm),
    finishAllowanceMm: numOr(v.finishAllowanceMm, base.finishAllowanceMm),
    side: 'outside',
    tabs: {
      count: numOr(t.count, base.tabs.count),
      lengthMm: numOr(t.lengthMm, base.tabs.lengthMm),
      heightMm: numOr(t.heightMm, base.tabs.heightMm),
    },
    rect: {
      mode: rectMode,
      marginMm: numOr(r.marginMm, base.rect.marginMm),
      x: numOr(r.x, base.rect.x),
      y: numOr(r.y, base.rect.y),
      width: numOr(r.width, base.rect.width),
      height: numOr(r.height, base.rect.height),
    },
  }
}

/** Narrow unknown into valid Params2D, falling back per-field to `base`. */
function parseP2d(v: unknown, base: Params2D): Params2D {
  if (!isRecord(v)) return base
  const zMode = v.zMode === ZMode.Pen || v.zMode === ZMode.Spindle ? v.zMode : base.zMode
  return {
    diameter: numOr(v.diameter, base.diameter),
    stepdown: numOr(v.stepdown, base.stepdown),
    stepover: numOr(v.stepover, base.stepover),
    safeZ: numOr(v.safeZ, base.safeZ),
    surfaceZ: numOr(v.surfaceZ, base.surfaceZ),
    cutDepth: numOr(v.cutDepth, base.cutDepth),
    feedXY: numOr(v.feedXY, base.feedXY),
    feedZ: numOr(v.feedZ, base.feedZ),
    zMode,
    spindleRPM: numOr(v.spindleRPM, base.spindleRPM),
    penUpZ: numOr(v.penUpZ, base.penUpZ),
    penDownZ: numOr(v.penDownZ, base.penDownZ),
    decimals: numOr(v.decimals, base.decimals),
    lineNumbers: boolOr(v.lineNumbers, base.lineNumbers),
    offsetX: numOr(v.offsetX, base.offsetX),
    offsetY: numOr(v.offsetY, base.offsetY),
    // MIGRATION: an older persisted blob carried a single uniform `scale`. Map it
    // to scaleX = scaleY = scale so saved layouts/presets keep their size. New
    // blobs carry scaleX/scaleY directly; fall back to the (migrated) uniform.
    scaleX: posScale(v.scaleX, posScale(v.scale, base.scaleX)),
    scaleY: posScale(v.scaleY, posScale(v.scale, base.scaleY)),
    aspectLocked: boolOr(v.aspectLocked, base.aspectLocked),
  }
}

/** A strictly-positive scale factor, else the fallback (also forced positive). */
function posScale(v: unknown, fallback: number): number {
  const n = numOr(v, fallback)
  return n > 0 ? n : (fallback > 0 ? fallback : 1)
}

/** Classify a picked file by its extension. */
function classify(name: string): Mode | 'dxf' {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  // STL / OBJ / STEP / STP all import to a carving mesh (the '3d' family).
  if (ext === 'stl' || ext === 'obj' || ext === 'step' || ext === 'stp') return '3d'
  if (ext === 'dxf') return 'dxf'
  if (ext === 'eps' || ext === 'ai') return '2d'
  if (ext === 'cdr') return 'cdr'
  return 'none'
}

/** Mesh XY-bbox centre — the pivot for a job's rotation/scale placement. */
function meshCenter(mesh: StlMesh): { x: number; y: number } {
  return {
    x: (mesh.bbox.min[0] + mesh.bbox.max[0]) / 2,
    y: (mesh.bbox.min[1] + mesh.bbox.max[1]) / 2,
  }
}

/**
 * Build the Carve3DParams for one job from its own settings + the GLOBAL tool.
 * Cut/free speeds are stored mm/s in the job and converted to mm/min here.
 */
function jobCarveParams(
  job: CarveJob,
  global: { toolDiameter: number; toolType: ToolType; safeZ: number; spindleRPM: number; feedZ: number },
): Carve3DParams {
  // The job's `stepover` is the FINE finishing stepover (surface quality). Bulk
  // roughing can clear far faster with a coarser stepover — derive that from the
  // tool diameter so roughing isn't needlessly crawling at the finishing pitch.
  const auto = autoCarveParams(global.toolDiameter, global.toolType, job.speeds.cutDepthMm / Math.max(global.toolDiameter, 0.01))
  // Auto-skip roughing when the whole relief fits in one stepdown (finishing
  // alone clears it — faster). Honour the user's explicit roughing toggle: only
  // skip when they left roughing ON but it's not actually needed.
  const reliefDepth = Math.max(0, job.maxDepth)
  const roughingNeeded = reliefDepth > Math.max(job.speeds.cutDepthMm, 0.01) + 1e-6
  return defaultCarve3DParams({
    toolDiameter: global.toolDiameter,
    toolType: global.toolType,
    stepover: job.stepover,
    roughStepover: Math.max(job.stepover, auto.roughStepover),
    stepdown: job.speeds.cutDepthMm,
    safeZ: global.safeZ,
    maxDepth: job.maxDepth,
    feedXY: job.speeds.cutSpeedMmS * 60,
    feedZ: global.feedZ,
    travelFeed: job.speeds.freeSpeedMmS * 60,
    spindleRPM: global.spindleRPM,
    doRoughing: job.roughing && roughingNeeded,
    doFinishing: job.finishing,
    finishDir: job.finishDir,
  })
}

/**
 * 3D Carving panel (W7): turn one OR MANY models into a single safe GRBL program.
 *
 * MULTI-MODEL: importing an STL adds a JOB to a list (it never replaces the
 * previous). Each job owns its material / stock / speeds / placement / strategy
 * (new jobs inherit the current defaults, so by default all jobs match); the
 * TOOL/BIT, safe-Z, spindle and Z-mode are GLOBAL — one bit cuts every job in a
 * single combined program. Jobs auto-nest onto the bed so footprints don't
 * collide; the combined toolpath previews live in the Visualizer.
 *
 * - STL → 3D relief carving job(s) (roughing + finishing) via core/carve3d.
 * - DXF / EPS / AI → 2D engrave / profile / pocket via core/dxf + core/cam.
 * - STEP / STP → accepted but unsupported (clear "export as STL" message).
 */
export function CadCamPanel() {
  const t = useT()
  const setProgram = useProgram((s) => s.setProgram)
  const bed = useBed()

  // ---- multi-job carving store -------------------------------------------
  const jobs = useCarveJobs((s) => s.jobs)
  const selectedId = useCarveJobs((s) => s.selectedId)
  const carveGlobal = useCarveJobs((s) => s.global)
  const carveRev = useCarveJobs((s) => s.rev)
  const addJob = useCarveJobs((s) => s.addJob)
  const duplicateJob = useCarveJobs((s) => s.duplicateJob)
  const removeJob = useCarveJobs((s) => s.removeJob)
  const selectJob = useCarveJobs((s) => s.selectJob)
  const updateJob = useCarveJobs((s) => s.updateJob)
  const setJobPlacement = useCarveJobs((s) => s.setJobPlacement)
  const setJobSpeeds = useCarveJobs((s) => s.setJobSpeeds)
  const setJobStock = useCarveJobs((s) => s.setJobStock)
  const applyToAll = useCarveJobs((s) => s.applyToAll)
  const setGlobal = useCarveJobs((s) => s.setGlobal)
  const setDefaults = useCarveJobs((s) => s.setDefaults)
  const renest = useCarveJobs((s) => s.renest)
  const clearJobs = useCarveJobs((s) => s.clear)
  const carveDefaults = useCarveJobs((s) => s.defaults)

  const selectedJob = useMemo(
    () => jobs.find((j) => j.id === selectedId) ?? null,
    [jobs, selectedId]
  )

  // Stock / material live in the persisted stock store so the 3D Visualizer can
  // render the same block + material the user picks (used by 2D + as a bed-fit
  // reference; per-job stock lives on each job).
  const stock = useStock()

  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  // `fileName` + `mode` are PERSISTED so a tab-switch remount (dockview/mobile
  // both unmount the inactive panel) restores the panel to the family it was in
  // — otherwise `mode` reset to 'none' and the live G-code/viewport silently
  // reverted to default content even though the jobs/params survived.
  const [fileName, setFileName] = usePersistentState<string | null>('karmyogi.carve.fileName', null)
  // Restore the loaded mode on remount: 3D jobs live in the (module-level) jobs
  // store, so if any survive we come back as '3d' and faithfully regenerate from
  // the CURRENT store state. 2D drawing geometry can't persist, so a persisted
  // '2d'/'cdr' mode with no live geometry falls back to 'none' below.
  const [mode, setMode] = usePersistentState<Mode>('karmyogi.carve.mode', 'none')
  const [dragOver, setDragOver] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [warnings, setWarnings] = useState<string[]>([])
  const [, setBusy] = useState(false)
  const [nestWarn, setNestWarn] = useState<string[]>([])

  // 2D state (DXF / EPS / AI)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [epsPolys, setEpsPolys] = useState<Polyline[] | null>(null)
  const [op, setOp] = useState<Op>('Profile')
  const [side, setSide] = useState<ProfileSide>(ProfileSide.Outside)
  const [p2d, setP2d] = usePersistentState<Params2D>('karmyogi.carve.2d', DEFAULT_2D)

  // Optional CUTOUT pass: after the relief is carved, profile the part's outer
  // perimeter down through the stock to free it, leaving holding tabs. One shared
  // setting across all jobs (each job cuts around its own footprint, using its own
  // stock thickness when the override below is off). Default OFF. Persisted so the
  // operator's preference survives reloads.
  const [cutoutRaw, setCutout] = usePersistentState<CutoutParams>(
    'karmyogi.carve.cutout',
    defaultCutoutParams(),
  )
  // An OLDER persisted shape may be missing the newer `shape` / `clearAround` /
  // `rect` fields — normalise through the defaults so nested reads never crash.
  const cutout = useMemo(() => defaultCutoutParams(cutoutRaw), [cutoutRaw])

  // ADVANCED · double-sided (front + back) machining. OFF by default — emits the
  // front side as today, then a flipped+Z-inverted back side as a second program
  // section with an operator FLIP instruction block between them. Persisted so
  // the operator's preference survives reloads. Normalised through the defaults so
  // an older/short saved shape can't read undefined.
  const [twoSidedRaw, setTwoSided] = usePersistentState<TwoSidedParams>(
    'karmyogi.carve.twoSided',
    defaultTwoSidedParams(),
  )
  const twoSided = useMemo(() => defaultTwoSidedParams(twoSidedRaw), [twoSidedRaw])

  // Tool/bit selection — persisted so the operator's bit survives reloads.
  const [bitId, setBitId] = usePersistentState<string>('karmyogi.carve.bit', DEFAULT_BIT_ID)
  // Bit cutting LENGTH (flute/usable length, mm) — a primary, beginner-visible
  // choice. It doesn't change the toolpath, but it's the safe limit on how deep
  // the bit can reach, so we surface it and use it as a sanity hint for depth.
  const [bitLength, setBitLength] = usePersistentState<number>('karmyogi.carve.bitLen', 16)

  // ---- mount reconcile: keep the restored `mode` consistent with live data ---
  // On a tab-switch remount the persisted `mode` is restored, but the heavy 2D
  // drawing geometry (DXF/EPS) cannot be persisted — only 3D jobs survive (in the
  // module-level jobs store). Reconcile ONCE on mount so the panel comes back in
  // a coherent state and the live-generate effect regenerates from the CURRENT
  // store/persisted params (never from defaults):
  //   • jobs present                → '3d' (regenerate the combined carve)
  //   • persisted '2d'/'cdr' but no live geometry → 'none' (nothing to show)
  useEffect(() => {
    if (jobs.length > 0) {
      if (mode !== '3d') setMode('3d')
      return
    }
    if (mode === '2d' || mode === 'cdr' || mode === 'step') {
      // No live geometry survived the remount → drop back to the import screen.
      setMode('none')
      setFileName(null)
    }
    // Run once on mount only — later mode changes are driven by import/clear.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Output
  const [, setGcode] = useState('')
  const [, setLineCount] = useState(0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** Material whose info modal is open (large image + properties), or null. */
  const [infoMaterial, setInfoMaterial] = useState<MaterialPreset | null>(null)
  /** Friendly message shown when a Load fails to parse. */
  const [loadError, setLoadError] = useState('')

  // ---- material + bit + recommendation ------------------------------------
  const material = useMemo(
    () => getMaterial(stock.materialId) ?? getMaterial(DEFAULT_MATERIAL_ID)!,
    [stock.materialId]
  )
  const bit = useMemo(() => getBit(bitId) ?? getBit(DEFAULT_BIT_ID)!, [bitId])
  const bitType = bit.type
  const sizesForType = useMemo(() => bitsOfType(bitType), [bitType])
  const rec = useMemo(() => recommend(material, bit), [material, bit])
  // 3D relief carving only models a FLAT or BALL cutter — bitTypeToToolType maps
  // V-bit / engraving / drill onto 'flat', which is geometrically wrong for the
  // carved surface. Warn (don't silently approximate) when one is picked in 3D.
  const nonCarveBitIn3D = mode === '3d' && bitType !== 'flat' && bitType !== 'ball'

  /** Pick a bit type: jump to its first concrete size. */
  function pickBitType(type: BitType) {
    const first = bitsOfType(type)[0]
    if (first) setBitId(first.id)
  }

  // Whenever the chosen bit changes, mirror its diameter into the 2D params and
  // the GLOBAL carve tool (one bit cuts every job).
  useEffect(() => {
    setP2d((p) => (p.diameter === bit.diameter ? p : { ...p, diameter: bit.diameter }))
    setGlobal({ toolDiameter: bit.diameter, toolType: bitTypeToToolType(bit.type) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bit])

  // The selected material (from the stock picker) becomes the default + is also
  // applied to a job whenever it's the operator's chosen material — but per-job
  // material stays editable below. Keep the "new job inherits" default in sync.
  useEffect(() => {
    setDefaults({ material: stock.materialId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stock.materialId])

  // ---- AUTO-COMPUTE: derive every speed/depth from {material, bit} ----------
  // The beginner picks only bit type / width / length / material; from those the
  // recommender decides the cutting feed + depth-of-cut, and we set the free /
  // pull-up speeds to MAX (rapids). These flow into the new-job defaults, the
  // GLOBAL settings and the currently-selected job so the live carve always uses
  // the computed numbers — no "Use recommended" click required. The plunge-Z
  // (global.feedZ) is auto-set here too but stays user-editable in Advanced; we
  // only re-assert it when the bit/material actually changes (below), so a manual
  // override isn't stomped on every render.
  //
  // TAB-SWITCH FIX: skip the FIRST run after a (re)mount. The bit + material both
  // persist, so on a remount this effect would re-derive the auto speeds and
  // STOMP the selected job's user-edited speeds/stepover (and bump `rev`),
  // silently reverting the live G-code + viewport to default-derived content even
  // though the visible params survived. Re-deriving must only happen when the
  // operator actually CHANGES the bit or material, not on a plain remount.
  const autoComputeMounted = useRef(false)
  useEffect(() => {
    if (!autoComputeMounted.current) {
      autoComputeMounted.current = true
      return
    }
    // Improved auto-derivation: a FINE finishing stepover from the desired
    // surface scallop (ball-nose) or a sane fraction of the diameter (flat),
    // plus a stepdown sized from the material's depth-of-cut. Roughing uses a
    // coarser stepover internally (see jobCarveParams) and is auto-skipped for
    // shallow reliefs — both shorten machine time without hurting finish.
    const auto = autoCarveParams(bit.diameter, bitTypeToToolType(bit.type), material.stepdownFraction)
    const speeds: Partial<CarveJob['speeds']> = {
      cutSpeedMmS: Math.round((rec.feedXY / 60) * 100) / 100,
      cutDepthMm: auto.stepdown,
      // Free/travel speed → MAX (rapid-class link feed).
      freeSpeedMmS: Math.round((RAPID_FEED_MM_MIN / 60) * 100) / 100,
    }
    setDefaults({ speeds, stepover: auto.finishStepover })
    // Plunge-Z (feedZ) + spindle are global; recompute on bit/material change.
    setGlobal({ feedZ: rec.feedZ, spindleRPM: rec.spindleRPM })
    if (selectedJob) {
      setJobSpeeds(selectedJob.id, speeds)
      updateJob(selectedJob.id, { stepover: auto.finishStepover })
    }
    // Keep the 2D vector knobs aligned with the recommendation too.
    setP2d((p) => ({
      ...p,
      feedXY: rec.feedXY,
      feedZ: rec.feedZ,
      spindleRPM: rec.spindleRPM,
      stepdown: rec.stepdown,
      stepover: rec.stepoverFraction,
    }))
    // Re-run ONLY when the chosen bit or material changes (rec is derived from
    // both); intentionally NOT on selectedJob so picking a job doesn't re-stomp
    // its edited speeds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bit.id, material.id])

  // ---- preset capture / apply ---------------------------------------------
  /** Snapshot every tunable carving setting (NOT the loaded geometry/jobs). */
  const captureSettings = (): CarvePreset => ({
    op,
    side,
    p2d: { ...p2d },
    cutout: { ...cutoutRaw },
    bitId,
    bitLength,
    materialId: stock.materialId,
    carveGlobal: { ...carveGlobal },
    carveDefaults: { ...carveDefaults, speeds: { ...carveDefaults.speeds } },
  })

  /** Restore a captured preset into all the live settings. */
  const applyPreset = (p: CarvePreset) => {
    // If the bit or material actually changes, the auto-derive effect (above)
    // will fire — disarm it ONCE (same guard it uses on remount) so it doesn't
    // re-derive speeds/feeds from {bit,material} and stomp the preset's tuned
    // numbers. When bit+material are unchanged the effect won't fire, so we
    // leave the guard alone (avoids skipping a later genuine re-derive).
    if (p.bitId !== bitId || p.materialId !== stock.materialId) {
      autoComputeMounted.current = false
    }
    setOp(p.op)
    setSide(p.side)
    setP2d(p.p2d)
    setCutout(p.cutout)
    setBitId(p.bitId)
    setBitLength(p.bitLength)
    stock.setMaterial(p.materialId)
    setGlobal(p.carveGlobal)
    setDefaults(p.carveDefaults)
    // Reflect the preset on the currently-selected 3D job so the visible
    // speed/depth/strategy fields (bound to that job) update too.
    if (selectedJob) {
      setJobSpeeds(selectedJob.id, p.carveDefaults.speeds)
      updateJob(selectedJob.id, {
        stepover: p.carveDefaults.stepover,
        maxDepth: p.carveDefaults.maxDepth,
        roughing: p.carveDefaults.roughing,
        finishing: p.carveDefaults.finishing,
        finishDir: p.carveDefaults.finishDir,
      })
    }
  }

  // Named, colour-coded slots (persisted) wired to the carving capture/apply.
  const presets = usePresets<CarvePreset>({
    storageKey: 'karmyogi.carve.presets',
    capture: captureSettings,
    onApply: applyPreset,
  })

  // ---- file import --------------------------------------------------------
  /**
   * Import ONE file. `renestAfter` lets a multi-file drop add every model first
   * and re-nest only once at the end (avoids N intermediate nests + N warnings).
   */
  async function loadFile(file: File, renestAfter = true) {
    setImportError(null)
    setWarnings([])
    // Best-effort: archive the imported file to the user's vault for admin
    // assist (no-op when unconfigured / signed out; never blocks the import).
    void uploadUserFile(file, 'carve-import')
    const kind = classify(file.name)
    setFileName(file.name)

    if (kind === 'cdr') {
      setMode('cdr')
      setDrawing(null)
      setEpsPolys(null)
      return
    }

    if (kind === '3d') {
      setMode('3d')
      setDrawing(null)
      setEpsPolys(null)
      // STEP/STP need the heavy async WASM (OpenCascade) parse — show a spinner.
      const heavy = isHeavyMeshFile(file.name)
      if (heavy) setImporting(true)
      try {
        const mesh = await importMesh(file)
        if (mesh.triangleCount === 0) {
          setImportError(t('cc.errNoTriangles', 'Model parsed but contained no triangles.'))
          return
        }
        // ADD as a new job (do NOT replace existing jobs).
        const niceName = file.name.replace(/\.(stl|obj|step|stp)$/i, '')
        addJob(mesh, niceName)
        // Auto-nest so the new model lands beside the others (skipped for a
        // multi-file batch — the caller re-nests once after all are added).
        if (renestAfter) {
          const res = renest(bed.width, bed.depth)
          setNestWarn(res.warnings)
        }
      } catch (err) {
        setImportError(
          t('cc.errMesh', 'Failed to import model: {msg}', {
            msg: err instanceof Error ? err.message : String(err),
          })
        )
      } finally {
        if (heavy) setImporting(false)
      }
      return
    }

    // 2D family — DXF or EPS/AI.
    setMode('2d')
    setGcode('')
    setLineCount(0)
    const text = await file.text()

    if (kind === 'dxf') {
      setEpsPolys(null)
      const res = importDxfString(text)
      setWarnings(res.warnings ?? [])
      if (!res.ok) {
        setDrawing(null)
        setImportError(res.error ?? t('cc.errDxf', 'Failed to parse DXF'))
        return
      }
      setDrawing(res.drawing)
      return
    }

    setDrawing(null)
    const res = parseEpsPaths(text)
    setWarnings(res.warnings ?? [])
    if (!res.ok) {
      setEpsPolys(null)
      setImportError(res.error ?? t('cc.errEps', 'Couldn’t parse this EPS/AI — export as DXF.'))
      return
    }
    setEpsPolys(res.polylines)
  }

  /**
   * Import a batch of dropped/picked files. STL/OBJ/STEP each add a job; the
   * 3D ones re-nest only ONCE after the whole batch is in (so dropping several
   * models packs them all together, not after each one). A single non-3D file
   * (DXF/EPS/AI/CDR) falls through to its own loader.
   */
  async function loadFiles(files: File[]) {
    if (files.length === 0) return
    if (files.length === 1) {
      await loadFile(files[0])
      return
    }
    let addedMesh = false
    for (const f of files) {
      const isMesh = classify(f.name) === '3d'
      if (isMesh) addedMesh = true
      // Add every file; skip the per-file re-nest for mesh jobs so we pack once.
      await loadFile(f, !isMesh)
    }
    // Pack all the newly-added 3D jobs together in one go.
    if (addedMesh) {
      const res = renest(bed.width, bed.depth)
      setNestWarn(res.warnings)
    }
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : []
    if (files.length) void loadFiles(files)
    e.target.value = '' // allow re-picking the same file
  }
  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files ? Array.from(e.dataTransfer.files) : []
    if (files.length) void loadFiles(files)
  }
  function onDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    if (!dragOver) setDragOver(true)
  }
  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    if (e.currentTarget === e.target) setDragOver(false)
  }

  // ---- 2D: flatten + closed-loop bookkeeping ------------------------------
  // Raw (as-imported) flattened geometry. The placed `polylines` below applies
  // the user's offset + uniform scale on top of this.
  const rawPolylines = useMemo<Polyline[]>(() => {
    if (mode !== '2d') return []
    if (drawing) return drawing.flatten()
    if (epsPolys) return epsPolys
    return []
  }, [mode, drawing, epsPolys])
  // Natural (unscaled) bounds — drives the Width/Height fields + scale-about-corner.
  const naturalBounds = useMemo(() => {
    const b = new BBox()
    for (const pl of rawPolylines) for (const p of pl.points) b.expand(p)
    return b.isValid() ? b : null
  }, [rawPolylines])
  // Placed geometry: scale about the drawing's lower-left corner, then translate
  // by the offset. Identity placement returns the raw polylines untouched.
  const polylines = useMemo<Polyline[]>(() => {
    if (rawPolylines.length === 0) return []
    // Non-uniform: independent X/Y scale about the drawing's lower-left corner.
    const sx = p2d.scaleX > 0 ? p2d.scaleX : 1
    const sy = p2d.scaleY > 0 ? p2d.scaleY : 1
    const ox = p2d.offsetX || 0
    const oy = p2d.offsetY || 0
    if (sx === 1 && sy === 1 && ox === 0 && oy === 0) return rawPolylines
    const minx = naturalBounds ? naturalBounds.min.x : 0
    const miny = naturalBounds ? naturalBounds.min.y : 0
    return rawPolylines.map((pl) => {
      const c = pl.clone()
      for (const p of c.points) {
        p.x = (p.x - minx) * sx + minx + ox
        p.y = (p.y - miny) * sy + miny + oy
      }
      return c
    })
  }, [rawPolylines, naturalBounds, p2d.scaleX, p2d.scaleY, p2d.offsetX, p2d.offsetY])
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
    if (closed.length === 0) return []
    if (op === 'Profile') {
      // Cut nested closed loops INNERMOST-FIRST: an inner cutout must be cut
      // before the outer loop that contains it, or freeing the outer loop lets
      // the still-uncut inner piece wander. profileContours builds the
      // containment tree and emits children before parents (travel-minimised
      // among siblings).
      const tp = profileContours(closed, side, p)
      return tp.isEmpty() ? [] : [tp]
    }
    // Pocket: clear each closed region, innermost-first for the same reason.
    const out: Toolpath[] = []
    for (const idx of orderLoopsInsideOut(closed)) {
      const tp = pocket(closed[idx], p)
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
    const opLabel =
      op === 'Profile'
        ? `${opLabelText(t, op)} ${profileSideLabel(t, side)}`
        : opLabelText(t, op)
    const progName = `${fileName ?? t('cc.drawing', 'drawing')} — ${opLabel}`
    const emitter = new GcodeEmitter({
      programName: progName,
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
    setProgram(progName, out)
    setGcode(out)
    setLineCount(count)
    return out
  }

  // ---- 3D: combined carve over ALL enabled jobs (in a Web Worker) ----------
  const [, setCarveStats] = useState<{
    jobs: number
    grids: number
  } | null>(null)
  // Carve progress 0..1 (null = not carving). Drives a small "carving…" bar so a
  // heavy relief no longer freezes the UI — the compute runs off-thread.
  const [, setCarveProgress] = useState<number | null>(null)

  // The active carve worker (null when idle), held in a ref so a replace/cancel
  // can terminate it without re-rendering. `carveJobIdRef` is a monotonic id so a
  // late `done` from a superseded request is ignored.
  const carveWorkerRef = useRef<Worker | null>(null)
  const carveJobIdRef = useRef(0)
  // The last program NAME this panel pushed to the store, so removing all jobs
  // (or the worker producing nothing) can remove the stale carve section.
  const lastCarveNameRef = useRef<string | null>(null)

  function teardownCarveWorker() {
    if (carveWorkerRef.current) {
      carveWorkerRef.current.terminate()
      carveWorkerRef.current = null
    }
  }

  // Remove our previously-pushed carve section from the shared program store
  // (called when there is nothing to carve, so a stale section can't linger).
  function clearCarveProgram() {
    const name = lastCarveNameRef.current
    if (!name) return
    const st = useProgram.getState()
    const sec = st.sections.find((s) => s.name === name)
    if (sec) st.removeSection(sec.id)
    lastCarveNameRef.current = null
  }

  function generate3D(): string {
    const active = jobs.filter((j) => j.enabled)
    if (active.length === 0) {
      teardownCarveWorker()
      setGcode('')
      setLineCount(0)
      setCarveStats(null)
      setCarveProgress(null)
      clearCarveProgram()
      return ''
    }

    // Build per-job specs + copy each mesh's triangle buffer to TRANSFER it
    // (zero-copy) to the worker, leaving the in-memory mesh intact for the
    // viewer. carveMesh/buildCutout/emit all run off the main thread.
    const globals: CarveProgramGlobals = {
      safeZ: carveGlobal.safeZ,
      spindleRPM: carveGlobal.spindleRPM,
      feedZ: carveGlobal.feedZ,
      toolDiameter: carveGlobal.toolDiameter,
    }
    const transfers: ArrayBuffer[] = []
    const workerJobs = active.map((job) => {
      const spec: CarveJobSpec = {
        name: job.name,
        params: jobCarveParams(job, carveGlobal),
        placement: job.placement,
        pivot: meshCenter(job.mesh),
        stockThicknessMm: job.stock.height,
      }
      const tris = job.mesh.triangles.slice()
      transfers.push(tris.buffer)
      return {
        spec,
        triangles: tris,
        triangleCount: job.mesh.triangleCount,
        vertexCount: job.mesh.vertexCount,
        bbox: job.mesh.bbox,
        format: job.mesh.format,
      }
    })

    // Supersede any in-flight carve.
    teardownCarveWorker()
    const jobId = ++carveJobIdRef.current
    let worker: Worker
    try {
      worker = new Worker(new URL('../core/carve3d.worker.ts', import.meta.url), { type: 'module' })
    } catch {
      setCarveProgress(null)
      return ''
    }
    carveWorkerRef.current = worker
    setCarveProgress(0)

    worker.onmessage = (e: MessageEvent<CarveWorkerOutbound>) => {
      const msg = e.data
      if (msg.jobId !== carveJobIdRef.current) return // a superseded request
      if (msg.type === 'progress') {
        setCarveProgress(msg.total > 0 ? msg.done / msg.total : 0)
        return
      }
      if (msg.type === 'done') {
        teardownCarveWorker()
        setCarveProgress(null)
        setWarnings(msg.warnings)
        setCarveStats({ jobs: msg.jobsCarved, grids: msg.grids })
        if (!msg.gcode) {
          setGcode('')
          setLineCount(0)
          clearCarveProgram()
          return
        }
        const baseName =
          active.length === 1
            ? t('cc.progName3dOne', '{name} — 3D Carving', { name: active[0].name })
            : t('cc.progName3dMany', '{n} jobs — 3D Carving', { n: active.length })
        // ADVANCED · double-sided: post-process the front program into a combined
        // front+back program (pure core transform). Disabled → returns it as-is.
        const twoSidedRes = buildTwoSidedProgram(msg.gcode, twoSided)
        const finalGcode = twoSidedRes.gcode
        if (twoSidedRes.warnings.length) setWarnings((w) => [...w, ...twoSidedRes.warnings])
        const name = twoSided.enabled ? `${baseName} (two-sided)` : baseName
        // If the program name changed (job count crossed 1↔many, a renamed single
        // job, or the two-sided toggle), remove the previous section so it doesn't
        // linger.
        if (lastCarveNameRef.current && lastCarveNameRef.current !== name) clearCarveProgram()
        lastCarveNameRef.current = name
        const lineCount = twoSided.enabled
          ? finalGcode.split('\n').filter((l) => l.length > 0).length
          : msg.lineCount
        setProgram(name, finalGcode)
        setGcode(finalGcode)
        setLineCount(lineCount)
        return
      }
      // error
      teardownCarveWorker()
      setCarveProgress(null)
      if (!msg.cancelled) {
        setWarnings([t('cc.carveFailed', 'Carve failed: {msg}', { msg: msg.message })])
      }
    }
    worker.onerror = () => {
      teardownCarveWorker()
      setCarveProgress(null)
    }

    const req: CarveWorkerRequest = {
      type: 'carve',
      jobId,
      jobs: workerJobs,
      globals,
      cutout: cutout.enabled ? cutout : null,
    }
    worker.postMessage(req, transfers)
    return ''
  }

  // Terminate any live carve worker on unmount so a backgrounded carve can't leak.
  useEffect(() => {
    return () => teardownCarveWorker()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function generate(): string {
    if (mode === '3d') return generate3D()
    if (mode === '2d') return generate2D()
    return ''
  }

  // Always-fresh handle to generate3D. The re-assert-on-visible ResizeObserver
  // below is created with deps [mode, jobs.length] — it does NOT recreate when
  // `cutout` (or other carve params) change, so its captured `generate3D` closure
  // would be STALE and emit a program missing the cutout. Calling through this
  // ref (updated every render) guarantees the visible/remount re-assert path runs
  // the SAME complete generation as the live-generate effect and the manual
  // "Regenerate now" button — including the persisted cutout.
  const generate3DRef = useRef(generate3D)
  generate3DRef.current = generate3D

  // Always-fresh handle to the mode-dispatching generate(), so the live-generate
  // effect can depend on STABLE primitive/rev keys (not whole objects) yet still
  // run the latest closure — no stale reads of jobs/global/cutout/p2d. This lets
  // us THROTTLE: rapid slider/field edits bump a primitive dep and the single
  // debounced timeout coalesces them into one worker spin-up, instead of a new
  // Worker churned + torn down on every keystroke from whole-object deps.
  const generateRef = useRef(generate)
  generateRef.current = generate

  // A stable signature of the inputs that should trigger a regenerate, WITHOUT
  // using whole-object identities (which change on every keystroke even when the
  // value didn't). For 3D the store's `carveRev` already bumps on any job/global
  // change; only the cutout (separate persisted state) needs hashing. For 2D the
  // 2D params + geometry identity drive it.
  const genKey = useMemo(() => {
    if (mode === '3d') {
      // carveRev covers jobs + global; append the cutout fields that affect output.
      const c = cutout.enabled
        ? `1|${cutout.shape}|${cutout.clearAround ? 1 : 0}|${cutout.cutStepdownMm}|${cutout.breakThroughMm}|${cutout.finishAllowanceMm}|${cutout.tabs.count}|${cutout.tabs.lengthMm}|${cutout.tabs.heightMm}|${cutout.rect.mode}|${cutout.rect.marginMm}|${cutout.rect.x}|${cutout.rect.y}|${cutout.rect.width}|${cutout.rect.height}`
        : '0'
      // Two-sided post-process inputs change the emitted program too.
      const ts = twoSided.enabled
        ? `1|${twoSided.stockThicknessMm}|${twoSided.flipAxis}|${twoSided.flipCorner}`
        : '0'
      return `3d|${carveRev}|${c}|${ts}`
    }
    if (mode === '2d') {
      return `2d|${op}|${side}|${JSON.stringify(p2d)}`
    }
    return mode
    // polylines/drawing/epsPolys identity is folded in via the separate dep below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, carveRev, cutout, twoSided, op, side, p2d])

  // ---- clobber guard: only own the Visualizer when this panel is VISIBLE --
  // Several CAM panels write the shared program store via live-generate effects;
  // an inactive (hidden) tab could clobber the carve. dockview sets
  // `display:none` on a hidden tab's content, so `offsetParent === null` tells us
  // we're hidden — skip live-generate then. We DO write when visible + have work.
  function isPanelVisible(): boolean {
    const el = panelRef.current
    if (!el) return true
    // offsetParent is null when the element (or an ancestor) is display:none.
    return el.offsetParent !== null || el.getClientRects().length > 0
  }

  // requestAnimationFrame handle for the LIVE regen below (held in a ref so an
  // unmount / superseding edit can cancel a still-pending frame).
  const regenRafRef = useRef<number | null>(null)

  // Live G-code: regenerate whenever inputs change, COALESCED to one regen per
  // animation frame so the toolpath, G-code and 3D Visualizer track a dragged
  // slider in REAL TIME (no wait-for-mouse-release). Previously a 300ms debounce
  // gated this, so the preview only refreshed after the drag ended. We depend on
  // STABLE keys (genKey + geometry identity), not whole objects, and call through
  // generateRef so the frame body always runs the LATEST closure (no stale
  // jobs/global/cutout/p2d reads). For 3D the heavy compute runs in a Web Worker
  // (generate3D posts to it), so coalescing to one post-per-frame keeps it from
  // churning a Worker dozens of times per frame; for 2D it's a quick sync emit.
  useEffect(() => {
    if (mode !== '2d' && mode !== '3d') return
    // No enabled 3D jobs (e.g. the last job was removed) → tear down the worker
    // and remove our now-orphaned program section, then stop.
    if (mode === '3d' && useCarveJobs.getState().jobs.filter((j) => j.enabled).length === 0) {
      teardownCarveWorker()
      setGcode('')
      setLineCount(0)
      setCarveStats(null)
      setCarveProgress(null)
      clearCarveProgram()
      return
    }
    setBusy(true)
    // Cancel any frame still pending from a previous edit so a burst of slider
    // updates coalesces into a SINGLE regen on the next frame (not one per event).
    if (regenRafRef.current !== null) cancelAnimationFrame(regenRafRef.current)
    regenRafRef.current = requestAnimationFrame(() => {
      regenRafRef.current = null
      try {
        if (!isPanelVisible()) return
        generateRef.current()
      } finally {
        setBusy(false)
      }
    })
    return () => {
      if (regenRafRef.current !== null) {
        cancelAnimationFrame(regenRafRef.current)
        regenRafRef.current = null
      }
      setBusy(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, genKey, polylines])

  // When the panel becomes visible again (tab re-selected) and we have carve
  // jobs, re-assert our program so a sibling panel can't leave a stale program
  // showing in the Visualizer.
  useEffect(() => {
    if (mode !== '3d') return
    const el = panelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      // Call through the ref so the re-assert always uses the LATEST generate3D
      // (current cutout + job + global state), never a stale closure that would
      // drop the persisted cutout on remount.
      if (isPanelVisible() && useCarveJobs.getState().jobs.some((j) => j.enabled)) {
        generate3DRef.current()
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, jobs.length])

  function doRenest() {
    const res = renest(bed.width, bed.depth)
    setNestWarn(res.warnings)
  }

  /** Clear ALL jobs (and the import) after a confirm — a clean "start over". */
  function clearAllJobs() {
    if (jobs.length === 0) return
    if (
      !window.confirm(
        t(
          'cc.clearAllConfirm',
          'Remove all {n} jobs and start over? This clears the imported models and cannot be undone.',
          { n: jobs.length },
        ),
      )
    )
      return
    clearJobs()
    teardownCarveWorker()
    clearCarveProgram()
    setGcode('')
    setLineCount(0)
    setCarveStats(null)
    setCarveProgress(null)
    setNestWarn([])
    setMode('none')
    setFileName(null)
  }

  // ---- param input helpers ------------------------------------------------
  // Slider value/onChange wiring for a Params2D key: coerce a blank/NaN entry to
  // the PREVIOUS value (not 0) so a half-typed or cleared field never feeds the
  // live preview a 0-feed / 0-depth toolpath.
  function slider2d<K extends keyof Params2D>(key: K) {
    return {
      value: p2d[key] as number,
      onChange: (n: number) =>
        setP2d((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] })),
    }
  }
  // Bed XY extents, used for the position/size slider ranges.
  const bedW = bed.width
  const bedH = bed.depth

  const isPen = p2d.zMode === ZMode.Pen
  const hasGeometry = polylines.length > 0

  // 2D placement: natural size (mm) + helpers so the Width/Height fields can
  // auto-compute the uniform scale ("fit to this size") instead of a raw factor.
  const natW = naturalBounds ? naturalBounds.width() : 0
  const natH = naturalBounds ? naturalBounds.height() : 0
  const curScaleX = p2d.scaleX > 0 ? p2d.scaleX : 1
  const curScaleY = p2d.scaleY > 0 ? p2d.scaleY : 1
  const aspectLocked = p2d.aspectLocked
  // Set the X scale. When the aspect is locked the Y scale follows (uniform).
  const setScaleX = (s: number) =>
    setP2d((p) =>
      Number.isFinite(s) && s > 0
        ? { ...p, scaleX: s, scaleY: p.aspectLocked ? s : p.scaleY }
        : p,
    )
  // Set the Y scale. When the aspect is locked the X scale follows (uniform).
  const setScaleY = (s: number) =>
    setP2d((p) =>
      Number.isFinite(s) && s > 0
        ? { ...p, scaleY: s, scaleX: p.aspectLocked ? s : p.scaleX }
        : p,
    )
  // Width edits drive scaleX (= W/natW); locked → scaleY follows so Height tracks.
  const setWidth2D = (w: number) => {
    if (!(Number.isFinite(w) && w > 0 && natW > 0)) return
    setScaleX(w / natW)
  }
  // Height edits drive scaleY (= H/natH); locked → scaleX follows so Width tracks.
  const setHeight2D = (h: number) => {
    if (!(Number.isFinite(h) && h > 0 && natH > 0)) return
    setScaleY(h / natH)
  }
  const toggleAspectLock = () =>
    setP2d((p) =>
      // Re-locking from a non-uniform state snaps Y to X so the ratio is defined.
      p.aspectLocked
        ? { ...p, aspectLocked: false }
        : { ...p, aspectLocked: true, scaleY: p.scaleX },
    )
  const round2 = (n: number) => Math.round(n * 100) / 100
  const enabledJobs = jobs.filter((j) => j.enabled).length

  // Selected job's footprint vs bed (cheap fit hint).
  const selFootprint = useMemo(() => {
    if (!selectedJob) return null
    const w = selectedJob.stock.width
    const d = selectedJob.stock.depth
    return { w, d, fits: w <= bed.width && d <= bed.depth }
  }, [selectedJob, bed.width, bed.depth])

  // ---- bit-LENGTH safety check -------------------------------------------
  // The bit can only reach `bitLength` mm deep before its shank rubs the stock.
  // Compute the deepest plunge the current program asks for and warn if it
  // exceeds the flute length. Three sources: a 3D job's max relief depth, the
  // 2D cut depth, and (when a cutout is on) each job's own stock thickness plus
  // the break-through. The values are already collected — this just validates.
  const depthWarnings = useMemo<string[]>(() => {
    const out: string[] = []
    if (mode === '3d') {
      for (const j of jobs) {
        if (!j.enabled) continue
        if (j.maxDepth > bitLength + 1e-6) {
          out.push(
            t(
              'cc.warnBitLenJob',
              '“{name}” carves {depth}mm deep but the bit is only {len}mm long — it cannot reach that depth. Use a longer bit or reduce Max carve depth.',
              { name: j.name, depth: Math.round(j.maxDepth * 100) / 100, len: bitLength },
            ),
          )
        }
        if (cutout.enabled) {
          const through = j.stock.height + cutout.breakThroughMm
          if (through > bitLength + 1e-6) {
            out.push(
              t(
                'cc.warnBitLenCutout',
                'Cutting “{name}” free needs {depth}mm of reach (stock {stock}mm + break-through {bt}mm) but the bit is only {len}mm long. Use a longer bit, thinner stock, or less break-through.',
                {
                  name: j.name,
                  depth: Math.round(through * 100) / 100,
                  stock: Math.round(j.stock.height * 100) / 100,
                  bt: Math.round(cutout.breakThroughMm * 100) / 100,
                  len: bitLength,
                },
              ),
            )
          }
        }
      }
    } else if (mode === '2d') {
      if (p2d.cutDepth > bitLength + 1e-6) {
        out.push(
          t(
            'cc.warnBitLen2d',
            'Cut depth {depth}mm exceeds the bit length {len}mm — the bit cannot reach that deep. Use a longer bit or a shallower cut.',
            { depth: Math.round(p2d.cutDepth * 100) / 100, len: bitLength },
          ),
        )
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, jobs, bitLength, cutout.enabled, cutout.breakThroughMm, p2d.cutDepth])

  // ---- Save / Load document (carve params + cutout; STL re-imported) -------
  const carveDoc: CarveDoc = {
    kind: 'karmyogi.carve',
    version: 1,
    bitId,
    bitLength,
    p2d,
    cutout: cutoutRaw,
  }

  function loadCarveDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('cc.load.bad', 'Could not load — not a valid carving settings file.'))
      return
    }
    // bitId: accept only a string that resolves to a real bit.
    if (typeof data.bitId === 'string' && getBit(data.bitId)) setBitId(data.bitId)
    if (typeof data.bitLength === 'number' && Number.isFinite(data.bitLength))
      setBitLength(data.bitLength)
    setP2d((p) => parseP2d(data.p2d, p))
    // Narrow the cutout against the current normalised values, then store it.
    if (isRecord(data.cutout)) setCutout(parseCutout(data.cutout, cutout))
    setLoadError('')
  }

  return (
    <div
      ref={panelRef}
      className={'cc-panel' + (dragOver ? ' cc-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <PresetRail
        slots={presets.slots}
        selected={presets.selected}
        onLoad={presets.load}
        onSelect={presets.select}
        ariaLabel={t('cc.presets.aria', 'Carving setting presets')}
      />
      <div className="cc-scroll">
        {/* The panel heading + its explainer InfoTip were removed; the same
            explainer now shows as a tooltip when hovering the "2D/3D Carving"
            dock TAB (see the dock tab component in shell.tsx). */}
        <div className="cc-cards">
          {/* ================= 1 · IMPORT / DROP ================= */}
          <section className="cc-section cc-span">
            <h3>
              {mode === '3d' ? t('cc.models', 'Models') : t('cc.model', 'Model')}
              {mode === '3d' && (
                <span className="cc-h3-actions">
                  <button
                    className="cc-iconbtn"
                    onClick={doRenest}
                    disabled={enabledJobs === 0}
                    title={t('cc.renest', 'Re-nest all jobs on the bed (no overlap)')}
                    aria-label={t('cc.renest', 'Re-nest all jobs on the bed')}
                  >
                    <Icon name="frame" size={14} />
                  </button>
                  <button
                    className="cc-iconbtn danger"
                    onClick={clearAllJobs}
                    disabled={jobs.length === 0}
                    title={t('cc.clearAll', 'Clear all jobs / start over')}
                    aria-label={t('cc.clearAll', 'Clear all jobs / start over')}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              )}
            </h3>
            <div className={'cc-section-body' + (dragOver ? ' cc-dragover' : '')}>
              {/* Compact upload row: accepted extensions + a rectangular upload
                  icon button (drag-drop onto the panel still works too). */}
              <div className="cc-uploadrow">
                <span className="cc-uploadrow-exts" title={t('cc.dropHintMulti', 'or drop a file anywhere — each model adds a job')}>
                  .stl / .obj / .step / .dxf / .eps / .ai
                </span>
                <button
                  type="button"
                  className="cc-uploadrow-btn"
                  onClick={() => fileRef.current?.click()}
                  title={t('cc.upload', 'Upload')}
                  aria-label={t('cc.uploadAria', 'Upload model file(s)')}
                >
                  <Icon name="upload" size={16} />
                </button>
                <input
                  ref={fileRef}
                  className="cc-load-input"
                  type="file"
                  multiple
                  accept=".stl,.obj,.step,.stp,.dxf,.eps,.ai,.cdr"
                  onChange={onFileChange}
                />
              </div>

              {/* Uploaded model files / jobs, listed right here in the Model
                  section. In 3D this is the single canonical models list with
                  per-model visibility, select-to-edit, duplicate & remove. */}
              <ModelFilesList
                mode={mode}
                jobs={jobs}
                selectedId={selectedId}
                fileName={fileName}
                onSelect={selectJob}
                onToggleJob={(id, enabled) => updateJob(id, { enabled })}
                onDuplicateJob={(id) => {
                  duplicateJob(id)
                  const res = renest(bed.width, bed.depth)
                  setNestWarn(res.warnings)
                }}
                onRemoveJob={(id, name) => {
                  if (!window.confirm(t('cc.jobRemoveConfirm', 'Remove “{name}”?', { name }))) return
                  removeJob(id)
                  const res = renest(bed.width, bed.depth)
                  setNestWarn(res.warnings)
                }}
                onRemove2D={() => {
                  setMode('none')
                  setFileName(null)
                  setDrawing(null)
                  setEpsPolys(null)
                  setGcode('')
                  setWarnings([])
                }}
                t={t}
              />

              {/* 3D multi-model: empty-state, nesting warnings & bed hint —
                  moved here from the old standalone "Jobs" section. */}
              {mode === '3d' && jobs.length === 0 && (
                <span className="cc-hint">
                  {t('cc.noJobs', 'No models yet — Add a model above. Import again to nest more side-by-side.')}
                </span>
              )}
              {mode === '3d' && nestWarn.length > 0 && (
                <ul className="cc-warnings">
                  {nestWarn.slice(0, 4).map((w, i) => (
                    <li key={i}>
                      <Icon name="warning" size={12} /> {w}
                    </li>
                  ))}
                </ul>
              )}
              {mode === '3d' && jobs.length > 0 && (
                <span className="cc-hint">
                  {t('cc.bedHint', 'Bed {w}×{d}mm — jobs auto-nest with a {m}mm gap.', {
                    w: bed.width,
                    d: bed.depth,
                    m: carveGlobal.nestMargin,
                  })}
                </span>
              )}

              {importError && <div className="cc-error">{importError}</div>}

              {importing && (
                <div className="cc-hint">
                  {t('cc.importingStep', 'Importing STEP model… (tessellating B-rep — this may take a moment)')}
                </div>
              )}
              {mode === 'cdr' && (
                <div className="cc-error">
                  {t(
                    'cc.cdrUnsupported',
                    'CorelDRAW .cdr is a proprietary binary format with no reliable in-browser parser. In CorelDRAW choose File → Export → DXF (or SVG/EPS) and import that — karmyogi fully supports DXF, including splines & ellipses.'
                  )}
                </div>
              )}

              {/* 2D stats */}
              {mode === '2d' && hasGeometry && (
                <div className="cc-import-stats">
                  {drawing && (
                    <span className="cc-stat" title={t('cc.entitiesTip', 'Raw DXF entities')}>
                      {t('cc.entities', 'Entities')} <b>{drawing.size()}</b>
                    </span>
                  )}
                  <span className="cc-stat" title={t('cc.polylinesTip', 'Flattened polylines (curves → segments)')}>
                    {t('cc.polylines', 'Polylines')} <b>{polylines.length}</b>
                  </span>
                  <span className="cc-stat" title={t('cc.closedTip', 'Closed loops — needed for Profile / Pocket')}>
                    {t('cc.closed', 'Closed')} <b>{closedCount}</b>
                  </span>
                </div>
              )}

              {warnings.length > 0 && (
                <ul className="cc-warnings">
                  {warnings.slice(0, 20).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                  {warnings.length > 20 && (
                    <li>… {t('cc.moreWarnings', '{n} more', { n: warnings.length - 20 })}</li>
                  )}
                </ul>
              )}
            </div>
          </section>

          {/* ============ 2 · BIT + MATERIAL (the only choices a beginner
                makes — everything else is auto-computed below) ============ */}
          <section className="cc-section cc-toolstrip cc-primary">
            <h3>{t('cc.pickBitMat', 'Bit & material')}</h3>
            <div className="cc-section-body">
              {/* Graphical bit + material card (replaces the old 3 bit selects
                  + material dropdown row). */}
              <div className="cc-bitmat">
                <BitWidget
                  bitType={bitType}
                  diameter={bit.diameter}
                  bitLength={bitLength}
                  onPickType={pickBitType}
                  onWidth={(mm) => {
                    if (!sizesForType.length) return
                    let best = sizesForType[0]
                    for (const b of sizesForType)
                      if (Math.abs(b.diameter - mm) < Math.abs(best.diameter - mm)) best = b
                    setBitId(best.id)
                  }}
                  onLength={(mm) => setBitLength(mm >= 1 ? mm : 1)}
                  t={t}
                />
                <MaterialCard
                  material={material}
                  onPick={(id) => {
                    stock.setMaterial(id)
                    if (mode === '3d' && selectedJob) updateJob(selectedJob.id, { material: id })
                  }}
                  onInfo={setInfoMaterial}
                  t={t}
                />
              </div>
              {nonCarveBitIn3D && (
                <span className="cc-warn-line">
                  <Icon name="warning" size={13} />{' '}
                  {t(
                    'cc.bitNonCarveWarn',
                    '3D relief carving only models a flat or ball cutter — a {type} bit is approximated as flat, so the carved surface will be wrong. Pick a Flat or Ball bit for 3D carving.',
                    { type: t(BIT_TYPES.find((b) => b.type === bitType)?.i18nKey ?? '', bitType) },
                  )}
                </span>
              )}
              {depthWarnings.map((w, i) => (
                <span className="cc-warn-line" key={i}>
                  <Icon name="warning" size={13} /> {w}
                </span>
              ))}
            </div>
          </section>

          {/* The standalone "Jobs" section was merged into the "Models" section
              above (single canonical models list). */}

          {/* ================= SELECTED JOB SETTINGS (3D) ================= */}
          {mode === '3d' && selectedJob && (
            <SelectedJobCard
              t={t}
              job={selectedJob}
              rec={rec}
              bedW={bed.width}
              bedD={bed.depth}
              fits={selFootprint?.fits ?? true}
              applyToAll={applyToAll}
              updateJob={updateJob}
              setJobSpeeds={setJobSpeeds}
              setJobStock={setJobStock}
              setJobPlacement={setJobPlacement}
              carveGlobal={carveGlobal}
              setGlobal={setGlobal}
            />
          )}

          {/* ============ 5 · CUTOUT (cut part free from stock) ============ */}
          {mode === '3d' && jobs.length > 0 && (
            <CutoutCard t={t} cutout={cutout} setCutout={setCutout} />
          )}

          {/* ====== 6 · ADVANCED · two-sided (front + back) machining ====== */}
          {mode === '3d' && jobs.length > 0 && (
            <TwoSidedCard t={t} twoSided={twoSided} setTwoSided={setTwoSided} />
          )}

          {/* Material + recommended-passes live in the primary section; the
              per-job Editing card carries every speed/depth/spindle control. */}

          {/* ================= 2D CONTROLS ================= */}
          {mode === '2d' && (
            <>
              <section className="cc-section">
                <h3>{t('cc.operation', 'Operation')}</h3>
                <div className="cc-section-body">
                  <div className="cc-opseg" role="group" aria-label={t('cc.operation', 'Operation')}>
                    {(['Engrave', 'Profile', 'Pocket'] as Op[]).map((o) => (
                      <button
                        key={o}
                        type="button"
                        className={'cc-opseg-btn' + (op === o ? ' active' : '')}
                        aria-pressed={op === o}
                        onClick={() => setOp(o)}
                        title={`${opLabelText(t, o)} — ${opHelp(t, o)}`}
                      >
                        <span className="cc-opseg-ico">{opIcon(o)}</span>
                        <span className="cc-opseg-lbl">{opLabelText(t, o)}</span>
                      </button>
                    ))}
                  </div>
                  {op === 'Profile' && (
                    <div className="cc-sideseg" role="group" aria-label={t('cc.profile', 'Profile')}>
                      {[ProfileSide.On, ProfileSide.Inside, ProfileSide.Outside].map((s) => (
                        <button
                          key={s}
                          type="button"
                          className={'cc-sideseg-btn' + (side === s ? ' active' : '')}
                          aria-pressed={side === s}
                          onClick={() => setSide(s)}
                          title={`${profileSideLabel(t, s)} — ${profileSideHelp(t, s)}`}
                        >
                          <span className="cc-sideseg-ico">{sideIcon(s)}</span>
                          <span className="cc-sideseg-lbl">{profileSideLabel(t, s)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <span className="cc-hint">{opHelp(t, op)}</span>
                  {op !== 'Engrave' && closedCount === 0 && hasGeometry && (
                    <span className="cc-warn-line">
                      ⚠ {t('cc.needClosed', '{op} needs a closed contour — none found in this file.', { op })}
                    </span>
                  )}
                </div>
              </section>

              {/* Position & size — offset + uniform scale (or type a target W/H to
                  auto-fit), mirroring the placement controls 3D jobs already have. */}
              <section className="cc-section">
                <h3>{t('cc.posSize', 'Position & size')}</h3>
                <div className="cc-section-body">
                  <div className="cc-sgrid">
                    <SliderField
                      icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                      label={t('cc.offsetXShort', 'Offset X')}
                      htmlFor="cc-2d-offx"
                      unit="mm"
                      min={-bedW}
                      max={bedW}
                      step={1}
                      {...slider2d('offsetX')}
                    />
                    <SliderField
                      icon={<MoveVertical size={14} strokeWidth={1.8} />}
                      label={t('cc.offsetYShort', 'Offset Y')}
                      htmlFor="cc-2d-offy"
                      unit="mm"
                      min={-bedH}
                      max={bedH}
                      step={1}
                      {...slider2d('offsetY')}
                    />
                    <div className="cc-linkpair">
                      <SliderField
                        icon={<MoveHorizontal size={14} strokeWidth={1.8} />}
                        label={t('cc.scaleXAxis', 'Scale X')}
                        htmlFor="cc-2d-scalex"
                        unit="×"
                        min={0.05}
                        max={10}
                        step={0.05}
                        value={round2(curScaleX)}
                        onChange={(n) => setScaleX(n)}
                        title={t('cc.scaleXTip', 'Horizontal scale factor (1 = original size)')}
                      />
                      <AspectLink
                        locked={aspectLocked}
                        onToggle={toggleAspectLock}
                        title={
                          aspectLocked
                            ? t('cc.aspectLockedTip', 'Aspect locked — X and Y scale together. Click to unlock.')
                            : t('cc.aspectUnlockedTip', 'Aspect unlocked — X and Y scale independently. Click to lock.')
                        }
                      />
                      <SliderField
                        icon={<MoveVertical size={14} strokeWidth={1.8} />}
                        label={t('cc.scaleYAxis', 'Scale Y')}
                        htmlFor="cc-2d-scaley"
                        unit="×"
                        min={0.05}
                        max={10}
                        step={0.05}
                        value={round2(curScaleY)}
                        onChange={(n) => setScaleY(n)}
                        title={t('cc.scaleYTip', 'Vertical scale factor (1 = original size)')}
                      />
                    </div>
                    <div className="cc-linkpair">
                      <SliderField
                        icon={<MoveDiagonal size={14} strokeWidth={1.8} />}
                        label={t('cc.targetWShort', 'Width')}
                        htmlFor="cc-2d-w"
                        unit="mm"
                        min={1}
                        max={Math.max(bedW, 500)}
                        step={1}
                        disabled={!(natW > 0)}
                        value={natW > 0 ? round2(natW * curScaleX) : 0}
                        onChange={(v) => setWidth2D(v)}
                        title={t('cc.targetWTip', 'Target width (mm). Drives the X scale; locked → height follows.')}
                      />
                      <AspectLink
                        locked={aspectLocked}
                        onToggle={toggleAspectLock}
                        disabled={!(natW > 0) || !(natH > 0)}
                        title={
                          aspectLocked
                            ? t('cc.aspectLockedTip', 'Aspect locked — X and Y scale together. Click to unlock.')
                            : t('cc.aspectUnlockedTip', 'Aspect unlocked — X and Y scale independently. Click to lock.')
                        }
                      />
                      <SliderField
                        icon={<MoveDiagonal size={14} strokeWidth={1.8} style={{ transform: 'rotate(90deg)' }} />}
                        label={t('cc.targetHShort', 'Height')}
                        htmlFor="cc-2d-h"
                        unit="mm"
                        min={1}
                        max={Math.max(bedH, 500)}
                        step={1}
                        disabled={!(natH > 0)}
                        value={natH > 0 ? round2(natH * curScaleY) : 0}
                        onChange={(v) => setHeight2D(v)}
                        title={t('cc.targetHTip', 'Target height (mm). Drives the Y scale; locked → width follows.')}
                      />
                    </div>
                  </div>
                  <span className="cc-hint">
                    {t(
                      'cc.posSizeHint',
                      'Shift the drawing with Offset X/Y. Lock the chain link to scale X and Y together (aspect kept), or unlock it to set Width and Height independently.',
                    )}
                  </span>
                </div>
              </section>

              <section className="cc-section">
                <h3>{t('cc.toolCut', 'Tool & cut')}</h3>
                <div className="cc-section-body">
                  <div className="cc-sgrid">
                    <SliderField
                      icon={<Drill size={14} strokeWidth={1.8} />}
                      label={t('cc.toolDiaShort', 'Tool ⌀')}
                      htmlFor="cc-diameter"
                      unit="mm"
                      min={0.1}
                      max={25}
                      step={0.1}
                      hint={<>{t('cc.fromBit', 'from bit')}: {bit.diameter}</>}
                      {...slider2d('diameter')}
                    />
                    <SliderField
                      icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                      label={t('cc.cutDepthShort', 'Cut depth')}
                      htmlFor="cc-cutdepth"
                      unit="mm"
                      min={0}
                      max={60}
                      step={0.1}
                      {...slider2d('cutDepth')}
                    />
                    <SliderField
                      icon={<Layers size={14} strokeWidth={1.8} />}
                      label={t('cc.stepdownPassShort', 'Stepdown / pass')}
                      htmlFor="cc-stepdown"
                      unit="mm"
                      min={0.05}
                      max={10}
                      step={0.05}
                      hint={<>{t('common.recommended', 'Recommended')}: {rec.stepdown}</>}
                      {...slider2d('stepdown')}
                    />
                    <SliderField
                      icon={<AlignVerticalSpaceBetween size={14} strokeWidth={1.8} />}
                      label={t('cc.surfaceZShort', 'Surface Z')}
                      htmlFor="cc-surfacez"
                      unit="mm"
                      min={-50}
                      max={50}
                      step={0.1}
                      title={t('cc.surfaceZTip', 'Z of the stock top — cuts go from here down to Cut depth')}
                      {...slider2d('surfaceZ')}
                    />
                    <SliderField
                      icon={<ArrowUpToLine size={14} strokeWidth={1.8} />}
                      label={t('cc.safeZShort', 'Safe Z')}
                      htmlFor="cc-safez"
                      unit="mm"
                      min={0}
                      max={50}
                      step={0.5}
                      {...slider2d('safeZ')}
                    />
                    {op === 'Pocket' && (
                      <SliderField
                        icon={<ChevronsLeftRightEllipsis size={14} strokeWidth={1.8} />}
                        label={t('cc.stepoverFrac', 'Stepover (×⌀)')}
                        htmlFor="cc-stepover"
                        min={0.05}
                        max={0.95}
                        step={0.05}
                        hint={<>{t('common.recommended', 'Recommended')}: {rec.stepoverFraction}</>}
                        title={t('cc.stepoverFracTip', 'Sideways overlap between pocket passes, as a fraction of tool ⌀')}
                        {...slider2d('stepover')}
                      />
                    )}
                  </div>
                </div>
              </section>

              <section className="cc-section">
                <h3>{t('cc.zMode', 'Z mode')}</h3>
                <div className="cc-section-body">
                  <div className="cc-zmode">
                    <button
                      className={p2d.zMode === ZMode.Spindle ? 'active' : ''}
                      onClick={() => setP2d((p) => ({ ...p, zMode: ZMode.Spindle }))}
                      title={t('cc.spindleModeTip', 'Router/spindle: Z is cut depth; M3/M5 control the spindle')}
                    >
                      <Icon name="spindle" size={14} /> {t('cc.spindle', 'Spindle')}
                    </button>
                    <button
                      className={p2d.zMode === ZMode.Pen ? 'active' : ''}
                      onClick={() => setP2d((p) => ({ ...p, zMode: ZMode.Pen }))}
                      title={t('cc.penModeTip', 'Pen plotter: cuts → pen-down Z, travels → pen-up Z (no spindle)')}
                    >
                      ✒ {t('cc.pen', 'Pen')}
                    </button>
                  </div>
                  <div className="cc-sgrid">
                    {!isPen && (
                      <SliderField
                        icon={<Icon name="spindle" size={14} />}
                        label={t('cc.spindleRPM', 'Spindle RPM')}
                        htmlFor="cc-rpm"
                        unit={t('cc.unitRpm', 'RPM')}
                        min={0}
                        max={30000}
                        step={500}
                        hint={<>{t('common.recommended', 'Recommended')}: {rec.spindleRPM}</>}
                        {...slider2d('spindleRPM')}
                      />
                    )}
                    {isPen && (
                      <>
                        <SliderField
                          icon={<ArrowUpToLine size={14} strokeWidth={1.8} />}
                          label={t('cc.penUpZShort', 'Pen up Z')}
                          htmlFor="cc-penup"
                          unit="mm"
                          min={0}
                          max={50}
                          step={0.5}
                          {...slider2d('penUpZ')}
                        />
                        <SliderField
                          icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                          label={t('cc.penDownZShort', 'Pen down Z')}
                          htmlFor="cc-pendown"
                          unit="mm"
                          min={-20}
                          max={20}
                          step={0.1}
                          {...slider2d('penDownZ')}
                        />
                      </>
                    )}
                  </div>
                  <span className="cc-hint">
                    {isPen
                      ? t('cc.penHint', 'Pen: cuts map to pen-down Z, travels to pen-up Z (no spindle).')
                      : t('cc.spindleHint', 'Spindle: Z values are written verbatim; M3/M5 wrap the program.')}
                  </span>
                </div>
              </section>

              <section className="cc-section cc-advanced">
                <button
                  className="cc-adv-toggle"
                  onClick={() => setShowAdvanced((v) => !v)}
                  aria-expanded={showAdvanced}
                  title={t('cc.adv2dTip', 'Feed rates, decimals & line numbers — defaults are usually fine')}
                >
                  <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={13} />{' '}
                  {t('common.advanced', 'Advanced')}
                </button>
                {showAdvanced && (
                  <div className="cc-section-body">
                    <div className="cc-sgrid">
                      <SliderField
                        icon={<Gauge size={14} strokeWidth={1.8} />}
                        label={t('cc.feedXYShort', 'Feed XY')}
                        htmlFor="cc-feedxy"
                        unit={t('cc.mmMin', 'mm/min')}
                        min={0}
                        max={6000}
                        step={50}
                        hint={<>{t('common.recommended', 'Recommended')}: {rec.feedXY}</>}
                        {...slider2d('feedXY')}
                      />
                      <SliderField
                        icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                        label={t('cc.feedZShort', 'Plunge Z')}
                        htmlFor="cc-feedz"
                        unit={t('cc.mmMin', 'mm/min')}
                        min={0}
                        max={3000}
                        step={10}
                        hint={<>{t('common.recommended', 'Recommended')}: {rec.feedZ}</>}
                        {...slider2d('feedZ')}
                      />
                      <SliderField
                        icon={<Hash size={14} strokeWidth={1.8} />}
                        label={t('cc.decimals', 'Decimals')}
                        htmlFor="cc-decimals"
                        min={0}
                        max={6}
                        step={1}
                        title={t('cc.decimalsTip', 'Number of decimal places in emitted coordinates')}
                        {...slider2d('decimals')}
                      />
                    </div>
                    <label className="cc-check">
                      <input
                        type="checkbox"
                        checked={p2d.lineNumbers}
                        onChange={(e) => setP2d((p) => ({ ...p, lineNumbers: e.target.checked }))}
                      />
                      {t('cc.lineNumbers', 'Line numbers (N10, N20 …)')}
                    </label>
                  </div>
                )}
              </section>
            </>
          )}

          {/* ---- output / live preview (streaming lives in the Program tab) ---- */}
          {/* The Output section was removed: regenerate is automatic (live), the
              Frame button + G-code copy/download moved to the Program tab, and the
              carve-settings Save/Load moved into the preset bar below. Only the
              carve-settings load error surfaces here. */}
          {loadError && <div className="cc-error cc-loaderr">{loadError}</div>}
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
            value={carveDoc}
            onLoad={loadCarveDoc}
            onError={setLoadError}
            fileBase="karmyogi-carving"
            ext="kcarve"
            saveTitle={t('cc.save', 'Save carve settings')}
            loadTitle={t('cc.load', 'Load carve settings')}
          />
        }
      />
      <MaterialInfoModal material={infoMaterial} onClose={() => setInfoMaterial(null)} t={t} />
    </div>
  )
}

// ============================================================================
// Graphical bit widget + material card (Bit & material section)
// ============================================================================

/**
 * Editable dimension number with local text state so typing isn't fought by a
 * snapped/derived value; commits on blur or Enter.
 */
function DimInput({
  value,
  onCommit,
  title,
  ariaLabel,
}: {
  value: number
  onCommit: (v: number) => void
  title: string
  ariaLabel: string
}) {
  const [txt, setTxt] = useState(String(value))
  const [editing, setEditing] = useState(false)
  useEffect(() => {
    if (!editing) setTxt(String(value))
  }, [value, editing])
  const commit = () => {
    const v = parseFloat(txt)
    if (Number.isFinite(v)) onCommit(v)
    setEditing(false)
  }
  return (
    <input
      className="cc-dim-input"
      type="number"
      min={0}
      step={0.1}
      value={txt}
      title={title}
      aria-label={ariaLabel}
      onFocus={() => setEditing(true)}
      onChange={(e) => setTxt(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/**
 * Graphical cutting-bit widget: an SVG of the tool (its tip shape follows the
 * selected type) with civil-engineering-style double-arrow dimension lines for
 * WIDTH (⌀, snapped to the nearest stocked size) and HEIGHT (cutting length),
 * plus a tip-type dropdown beneath. Replaces the old three separate selects.
 */
function BitWidget({
  bitType,
  diameter,
  bitLength,
  onPickType,
  onWidth,
  onLength,
  t,
}: {
  bitType: BitType
  diameter: number
  bitLength: number
  onPickType: (type: BitType) => void
  onWidth: (mm: number) => void
  onLength: (mm: number) => void
  t: ReturnType<typeof useT>
}) {
  // Tip geometry by type (illustrative, not to scale — the numbers are exact).
  const pointed = bitType === 'vbit' || bitType === 'engraving' || bitType === 'drill'
  const tipBottom = bitType === 'ball' ? 86 : pointed ? 90 : 80
  const tip =
    bitType === 'ball' ? (
      <path className="cc-bit-body" d="M52,74 q8,18 16,0 z" />
    ) : pointed ? (
      <path className="cc-bit-body" d="M52,74 L60,90 L68,74 z" />
    ) : (
      <rect className="cc-bit-body" x="52" y="74" width="16" height="6" />
    )
  return (
    <div className="cc-bit">
      <svg className="cc-bit-svg" viewBox="2 4 76 124" role="img" aria-label={t('cc.bitDrawing', 'Cutting bit')}>
        <defs>
          <marker
            id="ccDimArrow"
            viewBox="0 0 10 10"
            markerWidth="7"
            markerHeight="7"
            refX="9"
            refY="5"
            orient="auto-start-reverse"
          >
            <path d="M0,1 L9,5 L0,9 z" className="cc-bit-arrowhead" />
          </marker>
          {/* clip the flute hatching to the cutting body */}
          <clipPath id="ccBitBodyClip">
            <rect x="52" y="22" width="16" height="52" />
          </clipPath>
        </defs>
        {/* tool: collar + cutting body + tip */}
        <rect className="cc-bit-collar" x="48" y="8" width="24" height="14" rx="2" />
        <rect className="cc-bit-body" x="52" y="22" width="16" height="52" />
        {/* SPIRAL (helical) flutes: a front helix (solid) + a back helix (faint),
            curved and crossing — so it reads as a twisted cutting tool. */}
        <g clipPath="url(#ccBitBodyClip)">
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const y = 16 + i * 12
            return (
              <path
                key={'fb' + i}
                className="cc-bit-flute cc-bit-flute-back"
                fill="none"
                d={`M52,${y - 20} Q66,${y - 13} 68,${y}`}
              />
            )
          })}
          {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
            const y = 16 + i * 12
            return (
              <path
                key={'ff' + i}
                className="cc-bit-flute"
                fill="none"
                d={`M52,${y} Q54,${y - 13} 68,${y - 20}`}
              />
            )
          })}
        </g>
        {tip}
        {/* LENGTH dimension — vertical line on the LEFT spanning the bit from the
            top of the body to the bottom of the tip, with arrowheads at both
            ends + extension lines, and the editable value on the line. */}
        <line className="cc-bit-extline" x1="52" y1="22" x2="30" y2="22" />
        <line className="cc-bit-extline" x1="52" y1={tipBottom} x2="30" y2={tipBottom} />
        <line
          className="cc-bit-dimline"
          x1="34"
          y1="22"
          x2="34"
          y2={tipBottom}
          markerStart="url(#ccDimArrow)"
          markerEnd="url(#ccDimArrow)"
        />
        <foreignObject x="6" y={(22 + tipBottom) / 2 - 9} width="30" height="18">
          <div className="cc-bit-fo">
            <DimInput
              value={Math.round(bitLength * 100) / 100}
              onCommit={onLength}
              title={t('cc.bitLength', 'Bit length (mm) — the deepest the bit can reach')}
              ariaLabel={t('cc.bitLength', 'Bit length (mm)')}
            />
          </div>
        </foreignObject>
        {/* WIDTH (⌀) dimension — the bit is too narrow to fit outward arrows +
            value between the extension lines, so the arrowheads point INWARD
            (placed outside the lines) and the editable value sits BELOW. */}
        <line className="cc-bit-extline" x1="52" y1={tipBottom} x2="52" y2={tipBottom + 16} />
        <line className="cc-bit-extline" x1="68" y1={tipBottom} x2="68" y2={tipBottom + 16} />
        <line className="cc-bit-dimline" x1="50" y1={tipBottom + 12} x2="70" y2={tipBottom + 12} />
        <path className="cc-bit-arrowhead" d={`M46,${tipBottom + 9} L52,${tipBottom + 12} L46,${tipBottom + 15} z`} />
        <path className="cc-bit-arrowhead" d={`M74,${tipBottom + 9} L68,${tipBottom + 12} L74,${tipBottom + 15} z`} />
        <foreignObject x="43" y={tipBottom + 15} width="34" height="17">
          <div className="cc-bit-fo">
            <DimInput
              value={Math.round(diameter * 100) / 100}
              onCommit={onWidth}
              title={t('cc.bitWidth', 'Bit width ⌀ (mm) — snaps to the nearest stocked size')}
              ariaLabel={t('cc.bitWidth', 'Bit width ⌀ (mm)')}
            />
          </div>
        </foreignObject>
      </svg>
      <label className="cc-bit-tip">
        <span className="cc-bit-tip-lbl">{t('cc.tipType', 'Tip')}</span>
        <select
          className="cc-prim-select"
          value={bitType}
          onChange={(e) => onPickType(e.target.value as BitType)}
          aria-label={t('cc.bitType', 'Bit type')}
        >
          {BIT_TYPES.map((bt) => (
            <option key={bt.type} value={bt.type}>
              {bt.icon} {t(bt.i18nKey, bt.name)}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

/**
 * Graphical material card: a medium square with the material PHOTO as the
 * background, the material NAME overlaid along the bottom, and a translucent
 * info button overlaid (opens the details modal). Clicking the card opens a
 * photo grid to pick a different material. Replaces the label + small swatch +
 * dropdown + info button + helper text row.
 */
function MaterialCard({
  material,
  onPick,
  onInfo,
  t,
}: {
  material: MaterialPreset
  onPick: (id: string) => void
  onInfo: (m: MaterialPreset) => void
  t: ReturnType<typeof useT>
}) {
  const [open, setOpen] = useState(false)
  const name = t(material.i18nKey, material.name)
  return (
    <div className="cc-matcard-wrap">
      <button
        type="button"
        className="cc-matcard"
        style={material.image ? { backgroundImage: `url(${material.image})` } : undefined}
        onClick={() => setOpen(true)}
        title={t('cc.matPick', 'Material — click to choose ({name})', { name })}
        aria-haspopup="dialog"
      >
        {!material.image && (
          <span className="cc-matcard-emoji" aria-hidden="true">
            {material.icon}
          </span>
        )}
        <span className="cc-matcard-name">{name}</span>
      </button>
      <button
        type="button"
        className="cc-matcard-info"
        onClick={() => onInfo(material)}
        title={t('cc.matViewDetails', 'View {mat} details', { mat: name })}
        aria-label={t('cc.matViewDetails', 'View {mat} details', { mat: name })}
      >
        <Icon name="info" size={14} />
      </button>
      <Modal
        open={open}
        title={t('cc.chooseMaterial', 'Choose material')}
        onClose={() => setOpen(false)}
      >
        <div className="cc-matmodal-grid">
          {MATERIALS.map((m) => {
            const mn = t(m.i18nKey, m.name)
            return (
              <div
                key={m.id}
                className={'cc-matmodal-tile' + (m.id === material.id ? ' is-sel' : '')}
                style={m.image ? { backgroundImage: `url(${m.image})` } : undefined}
              >
                <button
                  type="button"
                  className="cc-matmodal-pick"
                  onClick={() => {
                    onPick(m.id)
                    setOpen(false)
                  }}
                  title={t('cc.matSelect', 'Use {mat}', { mat: mn })}
                  aria-label={t('cc.matSelect', 'Use {mat}', { mat: mn })}
                >
                  {!m.image && (
                    <span className="cc-matcard-emoji" aria-hidden="true">
                      {m.icon}
                    </span>
                  )}
                  <span className="cc-matmodal-name">{mn}</span>
                </button>
                <button
                  type="button"
                  className="cc-matmodal-info"
                  onClick={() => {
                    setOpen(false)
                    onInfo(m)
                  }}
                  title={t('cc.matViewDetails', 'View {mat} details', { mat: mn })}
                  aria-label={t('cc.matViewDetails', 'View {mat} details', { mat: mn })}
                >
                  <Icon name="info" size={15} />
                </button>
              </div>
            )
          })}
        </div>
      </Modal>
    </div>
  )
}

/** Uppercase file-extension badge (e.g. "STL") derived from a filename. */
function fileExt(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i)
  return m ? m[1].toUpperCase() : '—'
}

/**
 * The list of uploaded model files shown directly in the Model section. For 3D
 * it lists every imported job (click to select for placement, ✕ to remove); for
 * 2D it shows the single loaded vector file. Empty → a friendly hint.
 */
function ModelFilesList({
  mode,
  jobs,
  selectedId,
  fileName,
  onSelect,
  onToggleJob,
  onDuplicateJob,
  onRemoveJob,
  onRemove2D,
  t,
}: {
  mode: Mode
  jobs: CarveJob[]
  selectedId: string | null
  fileName: string | null
  onSelect: (id: string) => void
  onToggleJob: (id: string, enabled: boolean) => void
  onDuplicateJob: (id: string) => void
  onRemoveJob: (id: string, name: string) => void
  onRemove2D: () => void
  t: ReturnType<typeof useT>
}) {
  const has3D = mode === '3d' && jobs.length > 0
  const has2D = (mode === '2d' || mode === 'cdr' || mode === 'step') && !!fileName
  // Nothing uploaded yet → render nothing (no placeholder text).
  if (!has3D && !has2D) return null
  // 3D — the single canonical models list: per-model visibility (eye),
  // select-to-edit, duplicate & remove. (Merged from the old "Jobs" section.)
  if (has3D) {
    return (
      <ul className="cc-joblist">
        {jobs.map((job) => (
          <li
            key={job.id}
            className={'cc-jobrow' + (job.id === selectedId ? ' active' : '')}
          >
            <button
              className={'cc-iconbtn cc-job-eye' + (job.enabled ? '' : ' hidden')}
              onClick={() => onToggleJob(job.id, !job.enabled)}
              title={
                job.enabled
                  ? t('cc.jobHide', 'Visible — click to hide this model from the toolpath & 3D view')
                  : t('cc.jobShow', 'Hidden — click to show this model in the toolpath & 3D view')
              }
              aria-label={
                job.enabled
                  ? t('cc.jobHide', 'Hide this model from the toolpath')
                  : t('cc.jobShow', 'Show this model in the toolpath')
              }
              aria-pressed={!job.enabled}
            >
              <Icon name={job.enabled ? 'eye' : 'eye-off'} size={14} />
            </button>
            <button
              className={'cc-job-name' + (job.enabled ? '' : ' hidden')}
              onClick={() => onSelect(job.id)}
              title={t('cc.jobSelect', 'Select to edit this job’s settings')}
            >
              <span className="cc-job-label">{job.name}</span>
            </button>
            <button
              className="cc-iconbtn"
              onClick={() => onDuplicateJob(job.id)}
              title={t('cc.jobDup', 'Duplicate this job')}
              aria-label={t('cc.jobDup', 'Duplicate this job')}
            >
              <Icon name="duplicate" size={14} />
            </button>
            <button
              className="cc-iconbtn danger"
              onClick={() => onRemoveJob(job.id, job.name)}
              title={t('cc.jobRemove', 'Remove this job')}
              aria-label={t('cc.jobRemove', 'Remove this job')}
            >
              <Icon name="close" size={14} />
            </button>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <ul className="cc-modelfiles">
      {has2D && fileName && (
        <li className="cc-modelfile is-sel">
          <span className="cc-modelfile-pick" title={fileName}>
            <span className="cc-modelfile-ext" aria-hidden="true">{fileExt(fileName)}</span>
            <span className="cc-modelfile-name">{fileName}</span>
          </span>
          <button
            type="button"
            className="cc-modelfile-x"
            onClick={onRemove2D}
            title={t('cc.removeFile', 'Remove this file')}
            aria-label={t('cc.removeFileAria', 'Remove {name}', { name: fileName })}
          >
            ✕
          </button>
        </li>
      )}
    </ul>
  )
}

// ============================================================================
// Selected-job settings card (3D multi-model)
// ============================================================================

interface SelectedJobCardProps {
  t: ReturnType<typeof useT>
  job: CarveJob
  rec: { stepover: number; stepdown: number }
  bedW: number
  bedD: number
  fits: boolean
  applyToAll: (k: ApplyAllKey) => void
  updateJob: (id: string, patch: Partial<Omit<CarveJob, 'id' | 'mesh'>>) => void
  setJobSpeeds: (id: string, s: Partial<CarveJob['speeds']>) => void
  setJobStock: (id: string, s: Partial<CarveJob['stock']>) => void
  setJobPlacement: (id: string, p: Partial<CarveJob['placement']>) => void
  /** GLOBAL motion settings (one bit cuts every job): plunge/pull-up/spindle/safe-Z. */
  carveGlobal: GlobalCarveSettings
  setGlobal: (g: Partial<GlobalCarveSettings>) => void
}

/** "Apply to all jobs" mini-button. */
function ApplyAll({
  t,
  onClick,
}: {
  t: ReturnType<typeof useT>
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="cc-applyall"
      onClick={onClick}
      title={t('cc.applyAll', 'Apply this setting to all jobs')}
      aria-label={t('cc.applyAll', 'Apply this setting to all jobs')}
    >
      ⇄
    </button>
  )
}

/**
 * Compact "✂ Cut part from stock" card (3D mode). When enabled, the emitted
 * program appends — AFTER the relief finishing pass — a profiling pass around
 * each carved part's outer footprint, cutting down through the stock so the part
 * is freed, with evenly-spaced holding TABS so it doesn't break loose. Each job
 * cuts using its OWN stock thickness; these fields are shared across jobs.
 * Default OFF.
 */
function CutoutCard({
  t,
  cutout,
  setCutout,
}: {
  t: ReturnType<typeof useT>
  cutout: CutoutParams
  setCutout: (updater: CutoutParams | ((prev: CutoutParams) => CutoutParams)) => void
}) {
  // Normalise prev through defaults so writes against an older saved shape (no
  // shape/clearAround/rect fields) never read undefined nested objects.
  const patch = (p: Partial<CutoutParams>) =>
    setCutout((c) => ({ ...defaultCutoutParams(c), ...p }))
  const patchTabs = (p: Partial<CutoutParams['tabs']>) =>
    setCutout((c) => {
      const n = defaultCutoutParams(c)
      return { ...n, tabs: { ...n.tabs, ...p } }
    })
  const patchRect = (p: Partial<CutoutParams['rect']>) =>
    setCutout((c) => {
      const n = defaultCutoutParams(c)
      return { ...n, rect: { ...n.rect, ...p } }
    })

  const isRect = cutout.shape === 'rect'
  const isManual = cutout.rect.mode === 'manual'

  return (
    <section className={'cc-section cc-cutout cc-span' + (cutout.enabled ? ' on' : '')}>
      <h3>
        <label className="cc-cutout-toggle">
          <input
            type="checkbox"
            checked={cutout.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span className="cc-cutout-title">✂ {t('cc.cutout', 'Cut part from stock')}</span>
        </label>
        <Tip
          id="cutout"
          title={t('cc.cutout', 'Cut part from stock')}
          body={t(
            'cc.cutoutTip',
            'After the relief is carved, cut the part free from the block. Choose to follow the part’s outline or cut a rectangle, optionally clearing the material around the part. Holding tabs leave small bridges so the part stays put until you snap it out.',
          )}
        />
      </h3>
      {cutout.enabled && (
        <div className="cc-section-body">
          {/* ---- SHAPE: the up-front choice (part outline vs rectangle) ---- */}
          <div className="cc-cutshape" role="group" aria-label={t('cc.cutoutShape', 'Cutout shape')}>
            <button
              type="button"
              className={'cc-cutshape-btn' + (!isRect ? ' active' : '')}
              // Switching to the part outline turns flatten OFF by default — there
              // is no empty area inside an outline cut, so it isn't needed.
              onClick={() => patch({ shape: 'outline', clearAround: false })}
              aria-pressed={!isRect}
              title={t('cc.cutoutOutlineTip', 'Cut along the carved part’s outer edge — the tool rides just outside the part outline.')}
            >
              <span className="cc-cutshape-ico" aria-hidden>⬡</span>
              <span className="cc-cutshape-lbl">{t('cc.cutoutOutline', 'Part outline')}</span>
            </button>
            <button
              type="button"
              className={'cc-cutshape-btn' + (isRect ? ' active' : '')}
              // Switching to a rectangle turns flatten ON by default — a rectangle
              // leaves empty stock around the part that is usually worth clearing.
              onClick={() => patch({ shape: 'rect', clearAround: true })}
              aria-pressed={isRect}
              title={t('cc.cutoutRectTip', 'Cut a rectangle you size yourself — auto-fit to the part plus a margin, or set explicit X/Y origin and size.')}
            >
              <span className="cc-cutshape-ico" aria-hidden>▭</span>
              <span className="cc-cutshape-lbl">{t('cc.cutoutRect', 'Rectangle')}</span>
            </button>
          </div>

          {/* ---- RECTANGLE fields (only for the rectangle shape) ---- */}
          {isRect && (
            <>
              <div className="cc-subops cc-cutrect-mode">
                <button
                  type="button"
                  className={'cc-subop-btn' + (!isManual ? ' active' : '')}
                  onClick={() => patchRect({ mode: 'auto' })}
                  title={t('cc.cutoutRectAutoTip', 'Size the rectangle to the part bounding box plus a margin')}
                >
                  {t('cc.cutoutRectAuto', 'Auto (part + margin)')}
                </button>
                <button
                  type="button"
                  className={'cc-subop-btn' + (isManual ? ' active' : '')}
                  onClick={() => patchRect({ mode: 'manual' })}
                  title={t('cc.cutoutRectManualTip', 'Set an explicit origin and size for the rectangle')}
                >
                  {t('cc.cutoutRectManual', 'Custom size')}
                </button>
              </div>
              <div className="cc-sgrid">
                {!isManual && (
                  <SliderField
                    icon={<Maximize2 size={14} strokeWidth={1.8} style={{ color: '#38bdf8' }} />}
                    label={t('cc.cutoutMargin', 'Margin around part')}
                    htmlFor="cc-cut-margin"
                    unit="mm"
                    min={0}
                    max={100}
                    step={0.5}
                    title={t('cc.cutoutMarginTip', 'Extra space left around the part’s bounding box on every side')}
                    value={cutout.rect.marginMm}
                    onChange={(v) => patchRect({ marginMm: Math.max(0, v) })}
                  />
                )}
                {isManual && (
                  <>
                    <SliderField
                      icon={<MoveHorizontal size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.x }} />}
                      label={t('cc.cutoutRectX', 'Origin X')}
                      htmlFor="cc-cut-x"
                      unit="mm"
                      min={0}
                      max={1000}
                      step={1}
                      title={t('cc.cutoutRectXTip', 'Lower-left X of the rectangle in bed coordinates')}
                      value={cutout.rect.x}
                      onChange={(v) => patchRect({ x: v })}
                    />
                    <SliderField
                      icon={<MoveVertical size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.y }} />}
                      label={t('cc.cutoutRectY', 'Origin Y')}
                      htmlFor="cc-cut-y"
                      unit="mm"
                      min={0}
                      max={1000}
                      step={1}
                      title={t('cc.cutoutRectYTip', 'Lower-left Y of the rectangle in bed coordinates')}
                      value={cutout.rect.y}
                      onChange={(v) => patchRect({ y: v })}
                    />
                    <SliderField
                      icon={<Ruler size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.x }} />}
                      label={t('cc.cutoutRectW', 'Width')}
                      htmlFor="cc-cut-w"
                      unit="mm"
                      min={0}
                      max={1000}
                      step={1}
                      title={t('cc.cutoutRectWTip', 'Rectangle width along X')}
                      value={cutout.rect.width}
                      onChange={(v) => patchRect({ width: Math.max(0, v) })}
                    />
                    <SliderField
                      icon={<Ruler size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.y, transform: 'rotate(90deg)' }} />}
                      label={t('cc.cutoutRectH', 'Height')}
                      htmlFor="cc-cut-h"
                      unit="mm"
                      min={0}
                      max={1000}
                      step={1}
                      title={t('cc.cutoutRectHTip', 'Rectangle height along Y')}
                      value={cutout.rect.height}
                      onChange={(v) => patchRect({ height: Math.max(0, v) })}
                    />
                  </>
                )}
              </div>
            </>
          )}

          {/* ---- FLATTEN / clear-around toggle ----
               Only meaningful for the RECTANGLE shape: a rectangle leaves empty
               stock around the part that can be flattened away. The part outline
               has no empty area inside it, so the toggle is disabled there (and
               the shape buttons above default it ON for rect, OFF for outline). */}
          <label
            className="cc-check cc-cutclear"
            style={!isRect ? { opacity: 0.6 } : undefined}
          >
            <input
              type="checkbox"
              checked={isRect && cutout.clearAround}
              disabled={!isRect}
              onChange={(e) => patch({ clearAround: e.target.checked })}
            />
            {isRect
              ? t('cc.cutoutFlattenRect', 'Flatten empty area inside rectangle')
              : t('cc.cutoutFlattenOutline', 'Flatten empty area (not needed for part outline)')}
            <Tip
              id="cutoutClear"
              title={t('cc.cutoutFlatten', 'Flatten empty area')}
              body={
                isRect
                  ? t(
                      'cc.cutoutFlattenTipRect',
                      'Clear all the stock between the rectangle and the part down to the bottom level — leaving the part standing on a flattened floor instead of only cutting the rectangle perimeter.',
                    )
                  : t(
                      'cc.cutoutFlattenTipOutline',
                      'Not needed when cutting from the part outline — the cut rides the part edge, so there is no empty area inside to flatten.',
                    )
              }
            />
          </label>
          {!isRect && (
            <span className="cc-hint">
              {t('cc.cutoutFlattenHint', 'Not needed when cutting from the part outline.')}
            </span>
          )}

          <div className="cc-rowlabel">{t('cc.cutoutDepth', 'Depth & edge')}</div>
          <div className="cc-sgrid">
            <SliderField
              icon={<Layers size={14} strokeWidth={1.8} style={{ color: '#f59e0b' }} />}
              label={t('cc.cutStepdown', 'Stepdown / pass')}
              htmlFor="cc-cut-stepdown"
              unit="mm"
              min={0.1}
              max={20}
              step={0.1}
              title={t('cc.cutStepdownTip', 'Depth removed per profile pass through the stock')}
              value={cutout.cutStepdownMm}
              onChange={(v) => patch({ cutStepdownMm: v > 0 ? v : cutout.cutStepdownMm })}
            />
            <SliderField
              icon={<ArrowDownToLine size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
              label={t('cc.breakThrough', 'Break-through')}
              htmlFor="cc-cut-breakthrough"
              unit="mm"
              min={0}
              max={10}
              step={0.1}
              title={t('cc.breakThroughTip', 'Extra depth below the stock bottom so the cut goes fully through')}
              value={cutout.breakThroughMm}
              onChange={(v) => patch({ breakThroughMm: Math.max(0, v) })}
            />
            {!isRect && (
              <SliderField
                icon={<ChevronsLeftRightEllipsis size={14} strokeWidth={1.8} style={{ color: '#a78bfa' }} />}
                label={t('cc.finishAllowance', 'Finish allowance')}
                htmlFor="cc-cut-finish"
                unit="mm"
                min={0}
                max={5}
                step={0.1}
                title={t('cc.finishAllowanceTip', 'Extra clearance beyond the tool radius left on the part edge')}
                value={cutout.finishAllowanceMm}
                onChange={(v) => patch({ finishAllowanceMm: Math.max(0, v) })}
              />
            )}
          </div>

          <div className="cc-rowlabel">{t('cc.holdingTabs', 'Holding tabs')}</div>
          <div className="cc-sgrid">
            <SliderField
              icon={<Hash size={14} strokeWidth={1.8} style={{ color: '#38bdf8' }} />}
              label={t('cc.tabCount', 'Count')}
              htmlFor="cc-cut-tabcount"
              min={0}
              max={20}
              step={1}
              title={t('cc.tabCountTip', 'Number of bridges spaced evenly around the part')}
              value={cutout.tabs.count}
              onChange={(v) => patchTabs({ count: Math.max(0, Math.round(v)) })}
            />
            <SliderField
              icon={<Grip size={14} strokeWidth={1.8} style={{ color: '#f59e0b' }} />}
              label={t('cc.tabLength', 'Length')}
              htmlFor="cc-cut-tablen"
              unit="mm"
              min={0}
              max={30}
              step={0.5}
              title={t('cc.tabLengthTip', 'Width of each tab along the perimeter')}
              value={cutout.tabs.lengthMm}
              onChange={(v) => patchTabs({ lengthMm: Math.max(0, v) })}
            />
            <SliderField
              icon={<ArrowUpToLine size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
              label={t('cc.tabHeight', 'Height')}
              htmlFor="cc-cut-tabh"
              unit="mm"
              min={0}
              max={10}
              step={0.1}
              title={t('cc.tabHeightTip', 'Material left under each tab, measured up from the stock bottom')}
              value={cutout.tabs.heightMm}
              onChange={(v) => patchTabs({ heightMm: Math.max(0, v) })}
            />
          </div>
          <span className="cc-hint">
            {isRect
              ? t(
                  'cc.cutoutHintRect',
                  'Cuts a rectangle through each job’s own stock thickness. Set 0 tabs only if the part is held some other way.',
                )
              : t(
                  'cc.cutoutHint',
                  'Cuts through each job’s own stock thickness, riding outside the part edge. Set 0 tabs only if the part is held some other way.',
                )}
          </span>
        </div>
      )}
    </section>
  )
}

/**
 * ADVANCED · double-sided (front + back) machining card. Collapsed by default and
 * clearly labelled so beginners aren't confused. When enabled it makes the carve
 * emit two clearly-separated program sections — the front exactly as today, then a
 * mirrored + Z-inverted back side — with an operator FLIP instruction block between
 * them. The transform math lives in the pure core (core/twoSided.ts); this card
 * only wires the inputs.
 */
function TwoSidedCard({
  t,
  twoSided,
  setTwoSided,
}: {
  t: ReturnType<typeof useT>
  twoSided: TwoSidedParams
  setTwoSided: (updater: TwoSidedParams | ((prev: TwoSidedParams) => TwoSidedParams)) => void
}) {
  const [open, setOpen] = useState(false)
  const patch = (p: Partial<TwoSidedParams>) =>
    setTwoSided((c) => ({ ...defaultTwoSidedParams(c), ...p }))

  const CORNERS: { id: FlipCorner; label: string }[] = [
    { id: 'back-left', label: t('cc.ts.cornerBL', 'Back-left') },
    { id: 'back-right', label: t('cc.ts.cornerBR', 'Back-right') },
    { id: 'front-left', label: t('cc.ts.cornerFL', 'Front-left') },
    { id: 'front-right', label: t('cc.ts.cornerFR', 'Front-right') },
  ]

  return (
    <section className={'cc-section cc-advanced cc-span' + (twoSided.enabled ? ' on' : '')}>
      <button
        className="cc-adv-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={t(
          'cc.ts.tip',
          'Carve the FRONT, then flip the stock and carve the BACK in one program. Advanced — leave off for normal single-side carving.',
        )}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />{' '}
        {t('cc.ts.title', 'Advanced · Two-sided machining')}
        {twoSided.enabled && <span className="cc-ts-on-badge"> {t('cc.ts.onBadge', 'ON')}</span>}
      </button>
      {open && (
        <div className="cc-section-body">
          <label className="cc-check cc-ts-enable">
            <input
              type="checkbox"
              checked={twoSided.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            {t('cc.ts.enable', 'Enable two-sided (front + back) carving')}
            <Tip
              id="twoSided"
              title={t('cc.ts.title', 'Advanced · Two-sided machining')}
              body={t(
                'cc.ts.enableTip',
                'Emits the front side as usual, then a second section that mirrors the toolpath across the flip axis and references depths to the new top face after you turn the stock over. A pause + on-screen instruction tells you when to flip and re-zero.',
              )}
            />
          </label>

          {twoSided.enabled && (
            <>
              <div className="cc-sgrid">
                <SliderField
                  icon={<Layers size={14} strokeWidth={1.8} style={{ color: '#f59e0b' }} />}
                  label={t('cc.ts.thicknessShort', 'Thickness')}
                  htmlFor="cc-ts-thickness"
                  unit={t('unit.mm', 'mm')}
                  min={0.5}
                  max={100}
                  step={0.5}
                  title={t(
                    'cc.ts.thicknessTip',
                    'Total block thickness — the back-side cut depths are referenced from the new (flipped) top face using this.',
                  )}
                  value={Math.round(twoSided.stockThicknessMm * 1000) / 1000}
                  onChange={(v) => patch({ stockThicknessMm: v })}
                />
              </div>

              <div className="cc-rowlabel">{t('cc.ts.flipAxis', 'Flip axis')}</div>
              <div
                className="cc-subops cc-ts-axis"
                role="group"
                aria-label={t('cc.ts.flipAxis', 'Flip axis')}
              >
                {(['x', 'y'] as FlipAxis[]).map((ax) => (
                  <button
                    key={ax}
                    type="button"
                    className={'cc-subop-btn cc-ts-axis-btn' + (twoSided.flipAxis === ax ? ' active' : '')}
                    onClick={() => patch({ flipAxis: ax })}
                    aria-pressed={twoSided.flipAxis === ax}
                    title={
                      ax === 'x'
                        ? t('cc.ts.flipXTip', 'Turn the stock over about the X axis (Y mirrors)')
                        : t('cc.ts.flipYTip', 'Turn the stock over about the Y axis (X mirrors)')
                    }
                  >
                    <span className="cc-ts-axis-ico" aria-hidden>
                      {ax === 'x' ? (
                        <FlipVertical2 size={15} strokeWidth={1.8} />
                      ) : (
                        <FlipHorizontal2 size={15} strokeWidth={1.8} />
                      )}
                    </span>
                    {ax === 'x' ? t('cc.ts.flipX', 'About X') : t('cc.ts.flipY', 'About Y')}
                  </button>
                ))}
              </div>

              <div className="cc-rowlabel">{t('cc.ts.corner', 'Front zero / re-zero corner')}</div>
              <div
                className="cc-subops cc-ts-corners"
                role="group"
                aria-label={t('cc.ts.corner', 'Front zero / re-zero corner')}
              >
                {CORNERS.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={'cc-subop-btn' + (twoSided.flipCorner === c.id ? ' active' : '')}
                    onClick={() => patch({ flipCorner: c.id })}
                    aria-pressed={twoSided.flipCorner === c.id}
                    title={t(
                      'cc.ts.cornerTip',
                      'The corner the FRONT is zeroed against — the back instruction tells you where it lands after the flip',
                    )}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <span className="cc-hint">
                {t(
                  'cc.ts.hint',
                  'The program runs the front, lifts to safe-Z, stops the spindle and PAUSES (M0). Flip the stock about {axis}, re-zero the tool (X0 Y0) at the {corner} corner, then resume to cut the back.',
                  {
                    axis: twoSided.flipAxis === 'x' ? 'X' : 'Y',
                    corner: flipCornerLabel(flippedCorner(twoSided.flipCorner, twoSided.flipAxis)),
                  },
                )}
              </span>
            </>
          )}
        </div>
      )}
    </section>
  )
}

function SelectedJobCard({
  t,
  job,
  rec,
  bedW,
  bedD,
  fits,
  applyToAll,
  updateJob,
  setJobSpeeds,
  setJobStock,
  setJobPlacement,
  carveGlobal,
  setGlobal,
}: SelectedJobCardProps) {
  const tris = job.mesh.triangleCount
  const size = {
    x: job.mesh.bbox.max[0] - job.mesh.bbox.min[0],
    y: job.mesh.bbox.max[1] - job.mesh.bbox.min[1],
    z: job.mesh.bbox.max[2] - job.mesh.bbox.min[2],
  }
  const round2 = (n: number) => Math.round(n * 100) / 100
  // Archival AI/camera feature — visible only to the owner (or local dev opt-in).
  const showExperimentalAI = useExperimentalAI()

  return (
    <section className="cc-section cc-jobcard cc-span">
      <h3>
        {t('cc.editing', 'Editing')}: <span className="cc-jobcard-name">{job.name}</span>
      </h3>
      <div className="cc-section-body">
        <div className="cc-import-stats">
          <span className="cc-stat" title={t('cc.trianglesTip', 'Triangles in the mesh')}>
            {t('cc.triangles', 'Triangles')} <b>{tris.toLocaleString()}</b>
          </span>
          <span className="cc-stat" title={t('cc.sizeTip', 'Bounding-box size (mm)')}>
            {t('common.size', 'Size')}{' '}
            <b>{size.x.toFixed(1)}×{size.y.toFixed(1)}×{size.z.toFixed(1)}</b>
          </span>
          {!fits && (
            <span className="cc-stat cc-stat-warn" title={t('cc.tooBigTip', 'Footprint exceeds the bed')}>
              ⚠ {t('cc.overBed', 'over bed {w}×{d}', { w: bedW, d: bedD })}
            </span>
          )}
        </div>

        {/* Speeds & depth (per-job, mm/s) */}
        <div className="cc-rowlabel">
          {t('cc.speedsDepth', 'Speeds & cut depth')}
        </div>
        <div className="cc-sgrid">
          <SliderField
            icon={<Gauge size={14} strokeWidth={1.8} style={{ color: '#22c55e' }} />}
            label={t('cc.cutSpeedShort', 'Cut speed')}
            htmlFor="cc-3d-cutspeed"
            unit={t('cc.mmS', 'mm/s')}
            min={0}
            max={200}
            step={1}
            title={t('cc.cutSpeedTip', 'Cutting feed while the tool is engaged in material')}
            action={<ApplyAll t={t} onClick={() => applyToAll('speeds')} />}
            value={round2(job.speeds.cutSpeedMmS)}
            onChange={(v) => setJobSpeeds(job.id, { cutSpeedMmS: v })}
          />
          <SliderField
            icon={<FastForward size={14} strokeWidth={1.8} style={{ color: '#38bdf8' }} />}
            label={t('cc.freeSpeedShort', 'Free speed')}
            htmlFor="cc-3d-freespeed"
            unit={t('cc.mmS', 'mm/s')}
            min={0}
            max={500}
            step={1}
            title={t('cc.freeSpeedTip', 'Travel feed for non-cutting links between one cut and the next')}
            value={round2(job.speeds.freeSpeedMmS)}
            onChange={(v) => setJobSpeeds(job.id, { freeSpeedMmS: v })}
          />
          <SliderField
            icon={<Layers size={14} strokeWidth={1.8} style={{ color: '#f59e0b' }} />}
            label={t('cc.cutDepthPassShort', 'Cut depth / pass')}
            htmlFor="cc-3d-cutdepth"
            unit="mm"
            min={0.05}
            max={20}
            step={0.05}
            hint={<>{t('common.recommended', 'Recommended')}: {rec.stepdown}</>}
            value={round2(job.speeds.cutDepthMm)}
            onChange={(v) => setJobSpeeds(job.id, { cutDepthMm: v })}
          />
          <SliderField
            icon={<ArrowDownToLine size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
            label={t('cc.maxDepthShort', 'Max carve depth')}
            htmlFor="cc-3d-maxdepth"
            unit="mm"
            min={0}
            max={100}
            step={0.5}
            title={t('cc.maxDepth', 'Max carve depth (mm)')}
            action={<ApplyAll t={t} onClick={() => applyToAll('maxDepth')} />}
            value={round2(job.maxDepth)}
            onChange={(v) => updateJob(job.id, { maxDepth: v })}
          />
          <SliderField
            icon={<ChevronsLeftRightEllipsis size={14} strokeWidth={1.8} style={{ color: '#a78bfa' }} />}
            label={t('cc.stepoverMmShort', 'Stepover')}
            htmlFor="cc-3d-stepover"
            unit="mm"
            min={0.05}
            max={10}
            step={0.05}
            hint={<>{t('common.recommended', 'Recommended')}: {rec.stepover}</>}
            action={<ApplyAll t={t} onClick={() => applyToAll('stepover')} />}
            value={round2(job.stepover)}
            onChange={(v) => updateJob(job.id, { stepover: v })}
          />
        </div>

        {/* Motion (GLOBAL — one bit cuts every job). Moved here from the old
            "Advanced (auto)" section: plunge / pull-up / spindle / safe-Z. These
            are auto-set from the bit + material but remain editable. */}
        <div className="cc-rowlabel">{t('cc.motion', 'Motion & spindle (all jobs)')}</div>
        <div className="cc-sgrid">
          <SliderField
            icon={<ArrowDownToLine size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
            label={t('cc.plungeZShort', 'Plunge Z')}
            htmlFor="cc-3d-plungez"
            unit={t('cc.unitMmMin', 'mm/min')}
            min={0}
            max={2000}
            step={10}
            title={t('cc.tipPlungeZ', 'How fast the bit drives straight DOWN into the stock. Auto-set to a safe fraction of the cutting speed — lower it if your bit chatters when entering the cut.')}
            value={carveGlobal.feedZ}
            onChange={(v) => setGlobal({ feedZ: v })}
          />
          <SliderField
            icon={<ArrowUpToLine size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
            label={t('cc.pullUpZShort', 'Pull-up Z')}
            htmlFor="cc-3d-pullupz"
            unit={t('cc.unitMmMin', 'mm/min')}
            min={0}
            max={3000}
            step={50}
            title={t('cc.tipPullUp', 'How fast the bit retracts out of the cut. 0 = maximum (rapid G0). Set a value (mm/min) to lift more gently.')}
            value={carveGlobal.retractFeedMmMin}
            onChange={(v) => setGlobal({ retractFeedMmMin: v })}
          />
          <SliderField
            icon={<RotateCw size={14} strokeWidth={1.8} style={{ color: '#22c55e' }} />}
            label={t('cc.spindleRPM', 'Spindle RPM')}
            htmlFor="cc-3d-spindle"
            unit={t('cc.unitRpm', 'RPM')}
            min={0}
            max={30000}
            step={500}
            title={t('cc.tipSpindle', 'Spindle speed suggested for this material — slower for plastics/metal, faster for wood. Override for your bit/spindle.')}
            value={carveGlobal.spindleRPM}
            onChange={(v) => setGlobal({ spindleRPM: v })}
          />
          <SliderField
            icon={<ArrowUpToLine size={14} strokeWidth={1.8} style={{ color: '#38bdf8' }} />}
            label={t('cc.safeZ', 'Safe Z (mm)')}
            htmlFor="cc-3d-safez"
            unit="mm"
            min={0}
            max={60}
            step={0.5}
            title={t('cc.tipSafeZ', 'Height the bit lifts to before moving across the stock. Must clear any clamps and the tallest part of your model.')}
            value={round2(carveGlobal.safeZ)}
            onChange={(v) => setGlobal({ safeZ: v })}
          />
        </div>

        {/* Strategy */}
        <div className="cc-rowlabel">
          {t('cc.strategy', 'Strategy')}
          <ApplyAll t={t} onClick={() => applyToAll('roughing')} />
        </div>
        <label className="cc-check">
          <input
            type="checkbox"
            checked={job.roughing}
            onChange={(e) => updateJob(job.id, { roughing: e.target.checked })}
          />
          {t('cc.roughing', 'Roughing — clear bulk stock in flat stepdown layers')}
        </label>
        <label className="cc-check">
          <input
            type="checkbox"
            checked={job.finishing}
            onChange={(e) => updateJob(job.id, { finishing: e.target.checked })}
          />
          {t('cc.finishing', 'Finishing — parallel raster following the relief surface')}
        </label>
        <div className="cc-zmode">
          <button
            className={job.finishDir === 'x' ? 'active' : ''}
            onClick={() => updateJob(job.id, { finishDir: 'x' })}
            title={t('cc.rasterXTip', 'Finishing scans rows along X')}
          >
            ↔ {t('cc.rasterX', 'Raster X')}
          </button>
          <button
            className={job.finishDir === 'y' ? 'active' : ''}
            onClick={() => updateJob(job.id, { finishDir: 'y' })}
            title={t('cc.rasterYTip', 'Finishing scans columns along Y')}
          >
            ↕ {t('cc.rasterY', 'Raster Y')}
          </button>
        </div>

        {/* Place this job */}
        <div className="cc-rowlabel">{t('cc.placement', 'Place model')}</div>
        <div className="cc-sgrid">
          <SliderField
            icon={<MoveHorizontal size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.x }} />}
            label={t('cc.offsetXShort', 'Offset X')}
            htmlFor="cc-3d-offx"
            unit="mm"
            min={-Math.max(bedW, 1)}
            max={Math.max(bedW, 1)}
            step={0.5}
            title={t('cc.offsetX', 'X offset (mm)')}
            value={round2(job.placement.dx)}
            onChange={(v) => setJobPlacement(job.id, { dx: v })}
          />
          <SliderField
            icon={<MoveVertical size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.y }} />}
            label={t('cc.offsetYShort', 'Offset Y')}
            htmlFor="cc-3d-offy"
            unit="mm"
            min={-Math.max(bedD, 1)}
            max={Math.max(bedD, 1)}
            step={0.5}
            title={t('cc.offsetY', 'Y offset (mm)')}
            value={round2(job.placement.dy)}
            onChange={(v) => setJobPlacement(job.id, { dy: v })}
          />
          <SliderField
            icon={<RotateCw size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
            label={t('cc.rotationShort', 'Rotation')}
            htmlFor="cc-3d-rot"
            unit="°"
            min={0}
            max={360}
            step={1}
            title={t('cc.rotation', 'Rotation (°)')}
            value={round2(job.placement.rotDeg)}
            onChange={(v) => setJobPlacement(job.id, { rotDeg: v })}
          />
          <SliderField
            icon={<Maximize2 size={14} strokeWidth={1.8} />}
            label={t('cc.scaleShort', 'Scale')}
            htmlFor="cc-3d-scale"
            unit="×"
            min={0.05}
            max={10}
            step={0.05}
            title={t('cc.scale', 'Scale (×)')}
            value={round2(job.placement.scale)}
            onChange={(v) => setJobPlacement(job.id, { scale: v > 0 ? v : 0.01 })}
          />
        </div>
        <span className="cc-hint">
          {t('cc.placementJobHint', 'X/Y/rotation/scale move just THIS job. Re-nest packs all jobs without overlap.')}
        </span>

        {/* Per-job stock */}
        <div className="cc-rowlabel">
          {t('cc.stock', 'Stock')}
          <ApplyAll t={t} onClick={() => applyToAll('stock')} />
        </div>
        <div className="cc-sgrid">
          <SliderField
            icon={<Ruler size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.x }} />}
            label={t('cc.stockWidthShort', 'Width X')}
            htmlFor="cc-3d-stockw"
            unit="mm"
            min={1}
            max={Math.max(bedW, 500)}
            step={1}
            title={t('common.width', 'Width')}
            value={round2(job.stock.width)}
            onChange={(v) => setJobStock(job.id, { width: v >= 1 ? v : 1 })}
          />
          <SliderField
            icon={<Ruler size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.y, transform: 'rotate(90deg)' }} />}
            label={t('cc.stockDepthShort', 'Depth Y')}
            htmlFor="cc-3d-stockd"
            unit="mm"
            min={1}
            max={Math.max(bedD, 500)}
            step={1}
            title={t('common.depth', 'Depth')}
            value={round2(job.stock.depth)}
            onChange={(v) => setJobStock(job.id, { depth: v >= 1 ? v : 1 })}
          />
          <SliderField
            icon={<AlignVerticalSpaceBetween size={14} strokeWidth={1.8} style={{ color: AXIS_COLOR.z }} />}
            label={t('cc.stockThicknessShort', 'Thickness Z')}
            htmlFor="cc-3d-stockh"
            unit="mm"
            min={1}
            max={200}
            step={1}
            title={t('common.thickness', 'Thickness')}
            value={round2(job.stock.height)}
            onChange={(v) => setJobStock(job.id, { height: v >= 1 ? v : 1 })}
          />
        </div>

        {/* Phase 1 of the AI/camera workbench — ARCHIVAL, gated out of the public
            build behind VITE_EXPERIMENTAL_AI until the full pipeline is finished
            and battle-tested. See docs/ai-roadmap.md. */}
        {showExperimentalAI && (
          <CameraStockApply
            t={t}
            jobId={job.id}
            setJobStock={setJobStock}
            setJobPlacement={setJobPlacement}
          />
        )}
      </div>
    </section>
  )
}

/**
 * "Stock from camera" — the keystone that connects the Camera tab's auto-detected
 * workpiece (calib.jobRect in bed-mm + calib.jobHeightMm from the two-camera
 * visual hull) to the selected carving job. Reads the detected rect/height and,
 * on click, fills the job's stock size and CENTRES the model on the detected
 * stock's position on the bed. Shows a hint when nothing has been detected yet.
 */
function CameraStockApply({
  t,
  jobId,
  setJobStock,
  setJobPlacement,
}: {
  t: ReturnType<typeof useT>
  jobId: string
  setJobStock: (id: string, s: Partial<CarveJob['stock']>) => void
  setJobPlacement: (id: string, p: Partial<CarveJob['placement']>) => void
}) {
  const jobRect = useCameraCalib((s) => s.jobRect)
  const jobHeightMm = useCameraCalib((s) => s.jobHeightMm)

  if (!jobRect) {
    return (
      <>
        <div className="cc-rowlabel">{t('cc.camStock', 'Stock from camera')}</div>
        <span className="cc-hint">
          {t(
            'cc.camStockNone',
            'No camera-detected stock yet. Open the Camera tab, calibrate, and detect the workpiece to auto-fill stock size + position here.',
          )}
        </span>
      </>
    )
  }

  const w = jobRect.maxX - jobRect.minX
  const d = jobRect.maxY - jobRect.minY
  const cx = (jobRect.minX + jobRect.maxX) / 2
  const cy = (jobRect.minY + jobRect.maxY) / 2
  const hasH = jobHeightMm != null && Number.isFinite(jobHeightMm) && jobHeightMm > 0

  const apply = () => {
    const patch: Partial<CarveJob['stock']> = { width: Math.max(1, w), depth: Math.max(1, d) }
    if (hasH) patch.height = Math.max(1, jobHeightMm as number)
    setJobStock(jobId, patch)
    // Centre this model's pivot on the detected stock's centre on the bed.
    setJobPlacement(jobId, { dx: cx, dy: cy })
  }

  return (
    <>
      <div className="cc-rowlabel">{t('cc.camStock', 'Stock from camera')}</div>
      <div className="cc-camstock">
        <span className="cc-camstock-dims" title={t('cc.camStockDimsTip', 'Camera-detected workpiece on the bed')}>
          📷 {w.toFixed(0)} × {d.toFixed(0)}
          {hasH ? ` × ${(jobHeightMm as number).toFixed(1)}` : ''} mm
        </span>
        <button type="button" className="cc-camstock-apply" onClick={apply}>
          {t('cc.camStockApply', 'Use detected stock')}
        </button>
      </div>
      <span className="cc-hint">
        {t(
          'cc.camStockHint',
          'Applies the camera-detected workpiece size and centres this model on it. Thickness comes from the two-camera height estimate when available.',
        )}
      </span>
    </>
  )
}

/** Translated one-liner shown under each 2D operation so beginners know what it does. */
function opHelp(t: (k: string, e: string) => string, op: Op): string {
  switch (op) {
    case 'Engrave':
      return t('cc.engraveHelp', 'Follow every line at one depth — good for V-carving text & detail.')
    case 'Profile':
      return t('cc.profileHelp', 'Cut along closed shapes (on / inside / outside the line).')
    case 'Pocket':
      return t('cc.pocketHelp', 'Clear out the inside area of closed shapes, pass by pass.')
  }
}

/** Translated label for a 2D operation (also used to build the program name). */
function opLabelText(t: (k: string, e: string) => string, op: Op): string {
  switch (op) {
    case 'Engrave':
      return t('cc.engrave', 'Engrave')
    case 'Profile':
      return t('cc.profile', 'Profile')
    case 'Pocket':
      return t('cc.pocket', 'Pocket')
  }
}

/** Small graphical glyph for each 2D operation type in the segmented selector. */
function opIcon(op: Op): ReactNode {
  switch (op) {
    case 'Engrave':
      // trace-the-lines glyph
      return <PenLine size={18} strokeWidth={1.8} aria-hidden />
    case 'Profile':
      // cut-around-outline glyph
      return <Frame size={18} strokeWidth={1.8} aria-hidden />
    case 'Pocket':
      // clear-out-area glyph
      return <Grid2x2 size={18} strokeWidth={1.8} aria-hidden />
  }
}

/**
 * Custom inline SVG depicting where the cut path sits relative to the part
 * outline: ON the line, just INSIDE it, or just OUTSIDE it. The solid rounded
 * rect is the part outline; the dashed accent path is the toolpath.
 */
function sideIcon(side: ProfileSide): ReactNode {
  // outer = part outline; the dashed path is offset in/out (or on) the line.
  const outline = (
    <rect x={8} y={5} width={24} height={20} rx={4} fill="none" stroke="currentColor" strokeWidth={1.4} />
  )
  let path: ReactNode
  switch (side) {
    case ProfileSide.On:
      path = (
        <rect
          x={8} y={5} width={24} height={20} rx={4}
          fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="3 2"
        />
      )
      break
    case ProfileSide.Inside:
      path = (
        <rect
          x={12} y={9} width={16} height={12} rx={3}
          fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="3 2"
        />
      )
      break
    case ProfileSide.Outside:
      path = (
        <rect
          x={4} y={1} width={32} height={28} rx={5}
          fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="3 2"
        />
      )
      break
  }
  return (
    <svg width={40} height={30} viewBox="0 0 40 30" aria-hidden focusable="false">
      {side === ProfileSide.On ? path : outline}
      {side === ProfileSide.On ? null : path}
    </svg>
  )
}

/** Plain one-line explanation of a Profile side (used in the button tooltip). */
function profileSideHelp(t: (k: string, e: string) => string, side: ProfileSide): string {
  switch (side) {
    case ProfileSide.On:
      return t('cc.sideOnHelp', 'Cut centered on the line.')
    case ProfileSide.Inside:
      return t('cc.sideInsideHelp', 'Offset the cut inside the outline (for holes/cavities).')
    case ProfileSide.Outside:
      return t('cc.sideOutsideHelp', 'Offset the cut outside the outline (to keep the part to size).')
  }
}

/** Translated label for a Profile side (the On / Inside / Outside buttons). */
function profileSideLabel(t: (k: string, e: string) => string, side: ProfileSide): string {
  switch (side) {
    case ProfileSide.On:
      return t('cc.sideOn', 'On')
    case ProfileSide.Inside:
      return t('cc.sideInside', 'Inside')
    case ProfileSide.Outside:
      return t('cc.sideOutside', 'Outside')
  }
}
