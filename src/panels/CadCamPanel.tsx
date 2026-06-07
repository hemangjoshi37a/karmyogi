import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
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
import { useProgram, usePersistentState } from '../store'
import { useCarveJobs, type CarveJob, type ApplyAllKey, type JobSpeeds } from '../store/carveJobs'
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
import { IconButton } from '../components/IconButton'
import { Icon } from '../components/Icons'
import { FrameButton } from '../components/FrameButton'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { useT } from '../i18n'
import '../styles/cadcam.css'

/** Which import family is currently loaded — drives the whole panel layout. */
type Mode = 'none' | '3d' | '2d' | 'step' | 'cdr'

type Op = 'Engrave' | 'Profile' | 'Pocket'

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
 * One auto-computed value row in the "Advanced (auto)" panel: a label (+ hover
 * explainer), an "auto" badge, and the value as an EDITABLE number input. The
 * value is auto-derived from bit + material, but the operator can override it
 * (the override holds until they change the bit/material, which re-derives it).
 */
function AutoRow({
  label,
  value,
  unit,
  onChange,
  tip,
  t,
  step = 1,
  min = 0,
}: {
  label: string
  value: number
  unit: string
  onChange: (n: number) => void
  tip: string
  t: ReturnType<typeof useT>
  step?: number
  min?: number
}) {
  return (
    <div className="cc-autorow">
      <span className="cc-autorow-lbl">
        {label}
        <Tip id={label} title={label} body={tip} />
      </span>
      <span className="cc-autorow-val">
        <span className="cc-auto-badge" title={t('cc.autoBadgeTip', 'Auto-set from your bit + material — editable')}>
          {t('cc.autoBadge', 'auto')}
        </span>
        <input
          className="cc-auto-input"
          type="number"
          min={min}
          step={step}
          value={String(value)}
          onChange={(e) => {
            const n = parseFloat(e.target.value)
            // Keep the current value on a blank/NaN entry — never coerce to 0,
            // which would feed the live preview a 0-speed / 0-depth pass.
            onChange(Number.isFinite(n) ? n : value)
          }}
        />
        <span className="cc-autorow-unit">{unit}</span>
      </span>
    </div>
  )
}

/** Map a library BitType onto the 3D carver's two tool shapes. */
function bitTypeToToolType(t: BitType): ToolType {
  return t === 'ball' ? 'ball' : 'flat'
}

/**
 * Material-picker swatch: a small realistic texture thumbnail. Falls back to the
 * material's emoji glyph if the image is missing or fails to load. Slim by design
 * (sized in CSS via `.cc-pick-swatch`).
 *
 * Clicking the thumbnail opens an info modal (large image + properties) via
 * {@link onInfo}; the click is kept from bubbling so it doesn't also re-select
 * the material — selecting stays on the surrounding button's label/body.
 */
function MaterialSwatch({
  material,
  onInfo,
  label,
}: {
  material: MaterialPreset
  onInfo: (m: MaterialPreset) => void
  /** Accessible label, e.g. "View Plywood details". */
  label: string
}) {
  const [failed, setFailed] = useState(!material.image)
  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    onInfo(material)
  }
  if (failed) {
    return (
      <span
        className="cc-pick-icon cc-pick-swatch-btn"
        role="button"
        tabIndex={0}
        title={label}
        aria-label={label}
        onClick={open}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') open(e)
        }}
      >
        {material.icon}
      </span>
    )
  }
  return (
    <img
      className="cc-pick-swatch cc-pick-swatch-btn"
      src={material.image}
      alt=""
      role="button"
      tabIndex={0}
      title={label}
      aria-label={label}
      loading="lazy"
      draggable={false}
      onError={() => setFailed(true)}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e)
      }}
    />
  )
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
  /** Position/size placement of the imported 2D drawing (mm / uniform factor). */
  offsetX: number
  offsetY: number
  scale: number
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
    scale: 1,
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
    scale: numOr(v.scale, base.scale) > 0 ? numOr(v.scale, base.scale) : base.scale,
  }
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
  // The currently-loaded/combined program lines — used by the Frame button to
  // trace this carving's XY perimeter on the machine (placement already baked).
  const programLines = useProgram((s) => s.lines)
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

  // Effective per-job speeds/stepover for the editable "auto" rows: bind to the
  // selected job when there is one, else to the defaults that new jobs inherit.
  const effSpeeds = selectedJob?.speeds ?? carveDefaults.speeds
  const effStepover = selectedJob?.stepover ?? carveDefaults.stepover
  const setEffSpeeds = (patch: Partial<JobSpeeds>) =>
    selectedJob ? setJobSpeeds(selectedJob.id, patch) : setDefaults({ speeds: patch })
  const setEffStepover = (n: number) =>
    selectedJob ? updateJob(selectedJob.id, { stepover: n }) : setDefaults({ stepover: n })

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
  const [busy, setBusy] = useState(false)
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
  const [gcode, setGcode] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [showRaw, setShowRaw] = useState(false)
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
    const s = p2d.scale > 0 ? p2d.scale : 1
    const ox = p2d.offsetX || 0
    const oy = p2d.offsetY || 0
    if (s === 1 && ox === 0 && oy === 0) return rawPolylines
    const minx = naturalBounds ? naturalBounds.min.x : 0
    const miny = naturalBounds ? naturalBounds.min.y : 0
    return rawPolylines.map((pl) => {
      const c = pl.clone()
      for (const p of c.points) {
        p.x = (p.x - minx) * s + minx + ox
        p.y = (p.y - miny) * s + miny + oy
      }
      return c
    })
  }, [rawPolylines, naturalBounds, p2d.scale, p2d.offsetX, p2d.offsetY])
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
  const [carveStats, setCarveStats] = useState<{
    jobs: number
    grids: number
  } | null>(null)
  // Carve progress 0..1 (null = not carving). Drives a small "carving…" bar so a
  // heavy relief no longer freezes the UI — the compute runs off-thread.
  const [carveProgress, setCarveProgress] = useState<number | null>(null)

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
        const name =
          active.length === 1
            ? t('cc.progName3dOne', '{name} — 3D Carving', { name: active[0].name })
            : t('cc.progName3dMany', '{n} jobs — 3D Carving', { n: active.length })
        // If the program name changed (job count crossed 1↔many, or a renamed
        // single job), remove the previous section so it doesn't linger.
        if (lastCarveNameRef.current && lastCarveNameRef.current !== name) clearCarveProgram()
        lastCarveNameRef.current = name
        setProgram(name, msg.gcode)
        setGcode(msg.gcode)
        setLineCount(msg.lineCount)
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
      return `3d|${carveRev}|${c}`
    }
    if (mode === '2d') {
      return `2d|${op}|${side}|${JSON.stringify(p2d)}`
    }
    return mode
    // polylines/drawing/epsPolys identity is folded in via the separate dep below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, carveRev, cutout, op, side, p2d])

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

  // Live G-code: regenerate (debounced) whenever inputs change, off the UI
  // critical path so a heavy carve never blocks typing. For 3D the heavy compute
  // runs in a Web Worker (generate3D posts to it), so the timeout body never
  // blocks; for 2D it's a quick synchronous emit.
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
    // Single debounced, coalesced timeout. We depend on STABLE keys (genKey +
    // geometry identity), not whole objects, so a burst of keystrokes resets one
    // timer instead of spinning up + tearing down a Worker on each — and we call
    // through generateRef so the body always runs the LATEST closure (no stale
    // jobs/global/cutout/p2d reads). The original pipeline is preserved exactly.
    const id = window.setTimeout(() => {
      try {
        if (!isPanelVisible()) return
        generateRef.current()
      } finally {
        setBusy(false)
      }
    }, 300)
    return () => {
      window.clearTimeout(id)
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

  // ---- output actions: copy / download / clear ---------------------------
  /** A safe file base for the downloaded .nc, derived from the program name. */
  function gcodeFileBase(): string {
    const base = (fileName ?? 'carving').replace(/\.[^.]+$/, '')
    return base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'carving'
  }
  function copyGcode() {
    if (!gcode) return
    // navigator.clipboard needs a secure context; fall back to a temp textarea.
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(gcode).catch(() => fallbackCopy(gcode))
    } else {
      fallbackCopy(gcode)
    }
  }
  function fallbackCopy(text: string) {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch {
      /* best-effort */
    }
  }
  function downloadGcode() {
    if (!gcode) return
    const blob = new Blob([gcode], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${gcodeFileBase()}.nc`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 0)
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
  // Coerce a blank/NaN entry to the PREVIOUS value (not 0) so a half-typed or
  // cleared field never feeds the live preview a 0-feed / 0-depth toolpath.
  function num2d<K extends keyof Params2D>(key: K) {
    return {
      type: 'number' as const,
      value: String(p2d[key]),
      onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
        const v = parseFloat(e.target.value)
        setP2d((prev) => ({ ...prev, [key]: Number.isFinite(v) ? v : prev[key] }))
      },
    }
  }

  const isPen = p2d.zMode === ZMode.Pen
  const hasGeometry = polylines.length > 0

  // 2D placement: natural size (mm) + helpers so the Width/Height fields can
  // auto-compute the uniform scale ("fit to this size") instead of a raw factor.
  const natW = naturalBounds ? naturalBounds.width() : 0
  const natH = naturalBounds ? naturalBounds.height() : 0
  const curScale2D = p2d.scale > 0 ? p2d.scale : 1
  const setScale2D = (s: number) =>
    setP2d((p) => ({ ...p, scale: Number.isFinite(s) && s > 0 ? s : p.scale }))
  const round2 = (n: number) => Math.round(n * 100) / 100
  const canGenerate2D = hasGeometry && (op === 'Engrave' || closedCount > 0)
  const enabledJobs = jobs.filter((j) => j.enabled).length
  const canGenerate = mode === '3d' ? enabledJobs > 0 : canGenerate2D

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

  // The "Advanced (auto)" card — auto-computed feeds/depths (read-only with an
  // "auto" badge); only Plunge-Z and Safe-Z are editable. Defined here so it can
  // be placed AFTER the operation/strategy step in the top-down flow.
  const advancedAutoSection = (
    <section className="cc-section cc-advanced cc-autoadv">
      <button
        className="cc-adv-toggle"
        onClick={() => setShowAdvanced((v) => !v)}
        aria-expanded={showAdvanced}
        title={t('cc.advAutoTip', 'Auto-computed speeds & depths from your bit + material. Plunge-Z is editable; the rest are derived for you.')}
      >
        <Icon name={showAdvanced ? 'chevron-down' : 'chevron-right'} size={13} />{' '}
        {t('cc.advancedAuto', 'Advanced (auto) speeds & depths')}
      </button>
      {showAdvanced && (
        <div className="cc-section-body">
          <div className="cc-autogrid">
            <AutoRow
              label={t('cc.cuttingSpeed', 'Cutting speed')}
              unit={t('cc.unitMmMin', 'mm/min')}
              value={Math.round(effSpeeds.cutSpeedMmS * 60)}
              onChange={(n) => setEffSpeeds({ cutSpeedMmS: n / 60 })}
              step={10}
              tip={t('cc.tipCuttingSpeed', 'How fast the bit moves while cutting — auto-derived from the material + bit so it cuts cleanly without stalling. Override if you know better.')}
              t={t}
            />
            <AutoRow
              label={t('cc.depthPerPass', 'Depth of cut / pass')}
              unit={t('cc.unitMm', 'mm')}
              value={effSpeeds.cutDepthMm}
              onChange={(n) => setEffSpeeds({ cutDepthMm: n })}
              step={0.1}
              tip={t('cc.tipDepthPass', 'How much material each downward pass removes — kept shallow enough for your bit + material to stay safe. Lower it for hard material.')}
              t={t}
            />
            <AutoRow
              label={t('cc.freeSpeed', 'Free / travel speed')}
              unit={t('cc.unitMmMin', 'mm/min')}
              value={Math.round(effSpeeds.freeSpeedMmS * 60)}
              onChange={(n) => setEffSpeeds({ freeSpeedMmS: n / 60 })}
              step={50}
              tip={t('cc.tipFreeSpeed', 'Speed for non-cutting moves between cuts. Defaults to the machine maximum (rapid); lower it if rapids are too aggressive.')}
              t={t}
            />
            <AutoRow
              label={t('cc.pullUpSpeed', 'Pull-up Z speed')}
              unit={t('cc.unitMmMin', 'mm/min')}
              value={carveGlobal.retractFeedMmMin}
              onChange={(n) => setGlobal({ retractFeedMmMin: n })}
              step={50}
              tip={t('cc.tipPullUp', 'How fast the bit retracts out of the cut. 0 = maximum (rapid G0). Set a value (mm/min) to lift more gently.')}
              t={t}
            />
            <AutoRow
              label={t('cc.spindleRPM', 'Spindle RPM')}
              unit={t('cc.unitRpm', 'RPM')}
              value={carveGlobal.spindleRPM}
              onChange={(n) => setGlobal({ spindleRPM: n })}
              step={500}
              tip={t('cc.tipSpindle', 'Spindle speed suggested for this material — slower for plastics/metal, faster for wood. Override for your bit/spindle.')}
              t={t}
            />
            <AutoRow
              label={t('cc.stepover', 'Stepover')}
              unit={t('cc.unitMm', 'mm')}
              value={effStepover}
              onChange={(n) => setEffStepover(n)}
              step={0.1}
              tip={t('cc.tipStepover', 'Sideways spacing between cutting lines — finer means smoother but slower.')}
              t={t}
            />
            {/* Editable: Plunge-Z */}
            <div className="cc-field cc-autofield">
              <label>
                {t('cc.plungeZ', 'Plunge Z speed (mm/min)')}
                <Tip
                  id="plungeZ"
                  title={t('cc.plungeZ', 'Plunge Z speed (mm/min)')}
                  body={t(
                    'cc.tipPlungeZ',
                    'How fast the bit drives straight DOWN into the stock. Auto-set to a safe fraction of the cutting speed — lower it if your bit chatters when entering the cut.',
                  )}
                />
              </label>
              <input
                type="number"
                min={0}
                step={10}
                value={String(carveGlobal.feedZ)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setGlobal({ feedZ: Number.isFinite(v) ? v : carveGlobal.feedZ })
                }}
              />
            </div>
            {/* Editable: Safe-Z (needed, kept) */}
            <div className="cc-field cc-autofield">
              <label>
                {t('cc.safeZ', 'Safe Z (mm)')}
                <Tip
                  id="safeZ"
                  title={t('cc.safeZ', 'Safe Z (mm)')}
                  body={t(
                    'cc.tipSafeZ',
                    'Height the bit lifts to before moving across the stock. Must clear any clamps and the tallest part of your model.',
                  )}
                />
              </label>
              <input
                type="number"
                step={0.5}
                value={String(carveGlobal.safeZ)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setGlobal({ safeZ: Number.isFinite(v) ? v : carveGlobal.safeZ })
                }}
              />
            </div>
          </div>
          <span className="cc-hint">
            {t('cc.autoFootnote', 'These update automatically when you change the bit or material. Only Plunge-Z and Safe-Z are yours to tweak.')}
          </span>
        </div>
      )}
    </section>
  )

  return (
    <div
      ref={panelRef}
      className={'cc-panel' + (dragOver ? ' cc-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="cc-scroll">
        <h2 className="cc-heading">
          {t('cc.titleMulti', '2D/3D Carving')}
          <InfoTip
            topic="cc.introMulti"
            title={t('cc.titleMulti', '2D/3D Carving')}
            body={t(
              'cc.introMulti',
              'Import one or more STL models — each becomes a job that auto-nests on the bed and carves in a single combined program. DXF / vector files do 2D engrave · profile · pocket.'
            )}
          />
        </h2>

        <div className="cc-cards">
          {/* ================= 1 · IMPORT / DROP ================= */}
          <section className="cc-section cc-span">
            <h3>{t('cc.model', 'Model')}</h3>
            <div className="cc-section-body">
              <div className={'cc-drop' + (dragOver ? ' cc-dragover' : '')}>
                <span className="cc-drop-icon" aria-hidden>
                  <Icon name="upload" size={18} />
                </span>
                <button
                  className="cc-load-btn primary"
                  onClick={() => fileRef.current?.click()}
                  title={t('cc.importTipMulti', 'Add an .stl model as a job (import again for more) — or a .dxf / .eps / .ai vector file')}
                >
                  {t('cc.importAdd', 'Add model…')}
                </button>
                <span className="cc-drop-hint">
                  {t('cc.dropHintMulti', 'or drop a .stl / .obj / .step / .dxf / .eps / .ai file anywhere — each model adds a job')}
                </span>
                <input
                  ref={fileRef}
                  className="cc-load-input"
                  type="file"
                  multiple
                  accept=".stl,.obj,.step,.stp,.dxf,.eps,.ai,.cdr"
                  onChange={onFileChange}
                />
              </div>

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
              {/* Bit type + width (diameter) + length */}
              <div className="cc-prim-grid">
                <label className="cc-prim-field">
                  <span className="cc-prim-lbl">
                    {t('cc.bitType', 'Bit type')}
                    <Tip
                      id="bitType"
                      title={t('cc.bitType', 'Bit type')}
                      body={t(
                        'cc.tipBitType',
                        'The shape of your cutter. Flat = straight bottom (pockets/profiles); Ball = rounded tip (smooth 3D relief). This picks the right tool model for the carve.',
                      )}
                    />
                  </span>
                  <select
                    className="cc-prim-select"
                    value={bitType}
                    onChange={(e) => pickBitType(e.target.value as BitType)}
                    aria-label={t('cc.bitType', 'Bit type')}
                  >
                    {BIT_TYPES.map((bt) => (
                      <option key={bt.type} value={bt.type}>
                        {bt.icon} {t(bt.i18nKey, bt.name)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cc-prim-field">
                  <span className="cc-prim-lbl">
                    {t('cc.bitWidth', 'Bit width ⌀ (mm)')}
                    <Tip
                      id="bitWidth"
                      title={t('cc.bitWidth', 'Bit width ⌀ (mm)')}
                      body={t(
                        'cc.tipBitWidth',
                        'The cutting diameter of your bit. A wider bit clears faster but loses fine detail; a narrower bit is slower but finer. All speeds/depths below are sized for this width.',
                      )}
                    />
                  </span>
                  <select
                    className="cc-prim-select"
                    value={bit.id}
                    onChange={(e) => setBitId(e.target.value)}
                    aria-label={t('cc.bitWidth', 'Bit width ⌀ (mm)')}
                  >
                    {sizesForType.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.icon} {t(b.i18nKey, b.name)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="cc-prim-field">
                  <span className="cc-prim-lbl">
                    {t('cc.bitLength', 'Bit length (mm)')}
                    <Tip
                      id="bitLength"
                      title={t('cc.bitLength', 'Bit length (mm)')}
                      body={t(
                        'cc.tipBitLength',
                        'The usable cutting length of the bit — the deepest it can reach. Keep your total carve depth under this so the bit shank never rubs the stock.',
                      )}
                    />
                  </span>
                  <input
                    className="cc-prim-input"
                    type="number"
                    min={1}
                    step={1}
                    value={String(bitLength)}
                    onChange={(e) =>
                      setBitLength(Number.isFinite(+e.target.value) ? +e.target.value : 1)
                    }
                    aria-label={t('cc.bitLength', 'Bit length (mm)')}
                  />
                </label>
              </div>

              {/* Material — a compact dropdown (the 4th primary choice) with an
                  inline swatch + info icon to the details modal. */}
              <label className="cc-prim-field cc-matfield">
                <span className="cc-prim-lbl cc-prim-matlbl">
                  {t('cc.material', 'Material')}
                  <Tip
                    id="material"
                    title={t('cc.material', 'Material')}
                    body={t(
                      'cc.tipMaterial',
                      'What you are cutting. Together with the bit, this decides safe feeds, spindle speed and depth-of-cut. Pick from the list; open the details for full properties.',
                    )}
                  />
                </span>
                <div className="cc-matrow">
                  <MaterialSwatch
                    material={material}
                    onInfo={setInfoMaterial}
                    label={t('cc.matViewDetails', 'View {mat} details', {
                      mat: t(material.i18nKey, material.name),
                    })}
                  />
                  <select
                    className="cc-prim-select cc-matselect"
                    value={material.id}
                    onChange={(e) => {
                      const id = e.target.value
                      stock.setMaterial(id)
                      if (mode === '3d' && selectedJob) updateJob(selectedJob.id, { material: id })
                    }}
                    aria-label={t('cc.material', 'Material')}
                    title={t(material.notesKey, material.notes)}
                  >
                    {MATERIALS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.icon} {t(m.i18nKey, m.name)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="cc-iconbtn cc-matinfo-btn"
                    onClick={() => setInfoMaterial(material)}
                    title={t('cc.matViewDetails', 'View {mat} details', {
                      mat: t(material.i18nKey, material.name),
                    })}
                    aria-label={t('cc.matViewDetails', 'View {mat} details', {
                      mat: t(material.i18nKey, material.name),
                    })}
                  >
                    <Icon name="info" size={15} />
                  </button>
                </div>
              </label>
              <span className="cc-hint">
                {t('cc.primaryHint', 'One bit cuts every job. Speeds & depth are worked out from these — see Advanced (auto) below.')}
              </span>
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

          {/* ================= JOBS LIST (3D multi-model) ================= */}
          {mode === '3d' && (
            <section className="cc-section">
              <h3>
                {t('cc.jobs', 'Jobs')} ({jobs.length})
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
              </h3>
              <div className="cc-section-body">
                {jobs.length === 0 && (
                  <span className="cc-hint">
                    {t('cc.noJobs', 'No models yet — Add a model above. Import again to nest more side-by-side.')}
                  </span>
                )}
                {jobs.length > 0 && (
                  <ul className="cc-joblist">
                    {jobs.map((job) => (
                      <li
                        key={job.id}
                        className={'cc-jobrow' + (job.id === selectedId ? ' active' : '')}
                      >
                        <button
                          className={'cc-iconbtn cc-job-eye' + (job.enabled ? '' : ' hidden')}
                          onClick={() => updateJob(job.id, { enabled: !job.enabled })}
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
                          onClick={() => selectJob(job.id)}
                          title={t('cc.jobSelect', 'Select to edit this job’s settings')}
                        >
                          <span className="cc-job-label">{job.name}</span>
                        </button>
                        <button
                          className="cc-iconbtn"
                          onClick={() => {
                            duplicateJob(job.id)
                            const res = renest(bed.width, bed.depth)
                            setNestWarn(res.warnings)
                          }}
                          title={t('cc.jobDup', 'Duplicate this job')}
                          aria-label={t('cc.jobDup', 'Duplicate this job')}
                        >
                          <Icon name="duplicate" size={14} />
                        </button>
                        <button
                          className="cc-iconbtn danger"
                          onClick={() => {
                            if (
                              !window.confirm(
                                t('cc.jobRemoveConfirm', 'Remove “{name}”?', { name: job.name }),
                              )
                            )
                              return
                            removeJob(job.id)
                            const res = renest(bed.width, bed.depth)
                            setNestWarn(res.warnings)
                          }}
                          title={t('cc.jobRemove', 'Remove this job')}
                          aria-label={t('cc.jobRemove', 'Remove this job')}
                        >
                          <Icon name="close" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {nestWarn.length > 0 && (
                  <ul className="cc-warnings">
                    {nestWarn.slice(0, 4).map((w, i) => (
                      <li key={i}>
                        <Icon name="warning" size={12} /> {w}
                      </li>
                    ))}
                  </ul>
                )}
                <span className="cc-hint">
                  {t('cc.bedHint', 'Bed {w}×{d}mm — jobs auto-nest with a {m}mm gap.', {
                    w: bed.width,
                    d: bed.depth,
                    m: carveGlobal.nestMargin,
                  })}
                </span>
              </div>
            </section>
          )}

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
              renest={() => {
                const res = renest(bed.width, bed.depth)
                setNestWarn(res.warnings)
              }}
            />
          )}

          {/* ============ 4 · ADVANCED (AUTO) speeds & depths (3D) ============ */}
          {mode === '3d' && jobs.length > 0 && advancedAutoSection}

          {/* ============ 5 · CUTOUT (cut part free from stock) ============ */}
          {mode === '3d' && jobs.length > 0 && (
            <CutoutCard t={t} cutout={cutout} setCutout={setCutout} />
          )}

          {/* Material + recommended-passes now live in the primary section and
              the Advanced (auto) panel above; speeds/depths apply themselves. */}

          {/* ================= 2D CONTROLS ================= */}
          {mode === '2d' && (
            <>
              <section className="cc-section">
                <h3>{t('cc.operation', 'Operation')}</h3>
                <div className="cc-section-body">
                  <div className="cc-ops">
                    {(['Engrave', 'Profile', 'Pocket'] as Op[]).map((o) => (
                      <button
                        key={o}
                        className={'cc-op-btn' + (op === o ? ' active' : '')}
                        onClick={() => setOp(o)}
                        title={opHelp(t, o)}
                      >
                        {opLabelText(t, o)}
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
                          title={t('cc.profileSideTip', 'Cut {side} the contour', { side: profileSideLabel(t, s).toLowerCase() })}
                        >
                          {profileSideLabel(t, s)}
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
                  <div className="cc-grid">
                    <div className="cc-field">
                      <label htmlFor="cc-2d-offx">{t('cc.offsetX', 'Offset X (mm)')}</label>
                      <input id="cc-2d-offx" step={1} {...num2d('offsetX')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-2d-offy">{t('cc.offsetY', 'Offset Y (mm)')}</label>
                      <input id="cc-2d-offy" step={1} {...num2d('offsetY')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-2d-scale">{t('cc.scaleX', 'Scale ×')}</label>
                      <input
                        id="cc-2d-scale"
                        type="number"
                        min={0.01}
                        step={0.1}
                        value={String(round2(curScale2D))}
                        title={t('cc.scaleTip', 'Uniform scale factor (1 = original size)')}
                        onChange={(e) => setScale2D(parseFloat(e.target.value))}
                      />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-2d-w">{t('cc.targetW', 'Width (mm)')}</label>
                      <input
                        id="cc-2d-w"
                        type="number"
                        min={0}
                        step={1}
                        disabled={!(natW > 0)}
                        value={natW > 0 ? String(round2(natW * curScale2D)) : ''}
                        title={t('cc.targetWTip', 'Target width — sets the scale to fit this size (aspect kept)')}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v) && v > 0 && natW > 0) setScale2D(v / natW)
                        }}
                      />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-2d-h">{t('cc.targetH', 'Height (mm)')}</label>
                      <input
                        id="cc-2d-h"
                        type="number"
                        min={0}
                        step={1}
                        disabled={!(natH > 0)}
                        value={natH > 0 ? String(round2(natH * curScale2D)) : ''}
                        title={t('cc.targetHTip', 'Target height — sets the scale to fit this size (aspect kept)')}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value)
                          if (Number.isFinite(v) && v > 0 && natH > 0) setScale2D(v / natH)
                        }}
                      />
                    </div>
                  </div>
                  <span className="cc-hint">
                    {t(
                      'cc.posSizeHint',
                      'Shift the drawing with Offset X/Y. Scale uniformly, or type a target Width or Height to auto-fit (aspect ratio kept).',
                    )}
                  </span>
                </div>
              </section>

              <section className="cc-section">
                <h3>{t('cc.toolCut', 'Tool & cut')}</h3>
                <div className="cc-section-body">
                  <div className="cc-grid">
                    <div className="cc-field">
                      <label htmlFor="cc-diameter">{t('cc.toolDia', 'Tool ⌀ (mm)')}</label>
                      <input id="cc-diameter" min={0} step={0.1} {...num2d('diameter')} />
                      <span className="cc-rechint">{t('cc.fromBit', 'from bit')}: {bit.diameter}</span>
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-cutdepth">{t('cc.cutDepth', 'Cut depth (mm)')}</label>
                      <input id="cc-cutdepth" min={0} step={0.1} {...num2d('cutDepth')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-stepdown">{t('cc.stepdownPass', 'Stepdown / pass (mm)')}</label>
                      <input id="cc-stepdown" min={0} step={0.1} {...num2d('stepdown')} />
                      <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.stepdown}</span>
                    </div>
                    {op === 'Pocket' && (
                      <div className="cc-field">
                        <label htmlFor="cc-stepover">{t('cc.stepoverFrac', 'Stepover (×⌀)')}</label>
                        <input
                          id="cc-stepover"
                          min={0.05}
                          max={1}
                          step={0.05}
                          title={t('cc.stepoverFracTip', 'Sideways overlap between pocket passes, as a fraction of tool ⌀')}
                          {...num2d('stepover')}
                        />
                        <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.stepoverFraction}</span>
                      </div>
                    )}
                    <div className="cc-field">
                      <label htmlFor="cc-safez">{t('cc.safeZ', 'Safe Z (mm)')}</label>
                      <input id="cc-safez" step={0.5} {...num2d('safeZ')} />
                    </div>
                    <div className="cc-field">
                      <label htmlFor="cc-surfacez">{t('cc.surfaceZ', 'Surface Z (mm)')}</label>
                      <input
                        id="cc-surfacez"
                        step={0.5}
                        title={t('cc.surfaceZTip', 'Z of the stock top — cuts go from here down to Cut depth')}
                        {...num2d('surfaceZ')}
                      />
                    </div>
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
                  <div className="cc-grid">
                    {!isPen && (
                      <div className="cc-field">
                        <label htmlFor="cc-rpm">{t('cc.spindleRPM', 'Spindle RPM')}</label>
                        <input id="cc-rpm" min={0} step={500} {...num2d('spindleRPM')} />
                        <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.spindleRPM}</span>
                      </div>
                    )}
                    {isPen && (
                      <>
                        <div className="cc-field">
                          <label htmlFor="cc-penup">{t('cc.penUpZ', 'Pen up Z (mm)')}</label>
                          <input id="cc-penup" step={0.5} {...num2d('penUpZ')} />
                        </div>
                        <div className="cc-field">
                          <label htmlFor="cc-pendown">{t('cc.penDownZ', 'Pen down Z (mm)')}</label>
                          <input id="cc-pendown" step={0.5} {...num2d('penDownZ')} />
                        </div>
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
                    <div className="cc-grid">
                      <div className="cc-field">
                        <label htmlFor="cc-feedxy">{t('cc.feedXYmm', 'Feed XY (mm/min)')}</label>
                        <input id="cc-feedxy" min={0} step={10} {...num2d('feedXY')} />
                        <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.feedXY}</span>
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc-feedz">{t('cc.feedZmm', 'Feed Z / plunge (mm/min)')}</label>
                        <input id="cc-feedz" min={0} step={10} {...num2d('feedZ')} />
                        <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.feedZ}</span>
                      </div>
                      <div className="cc-field">
                        <label htmlFor="cc-decimals">{t('cc.decimals', 'Decimals')}</label>
                        <input
                          id="cc-decimals"
                          min={1}
                          max={6}
                          step={1}
                          title={t('cc.decimalsTip', 'Number of decimal places in emitted coordinates')}
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
                      {t('cc.lineNumbers', 'Line numbers (N10, N20 …)')}
                    </label>
                  </div>
                )}
              </section>
            </>
          )}

          {/* ---- output / live preview (streaming lives in the Program tab) ---- */}
          <section className="cc-section cc-output cc-span">
            <h3>{t('cc.output', 'Output')}</h3>
            <div className="cc-section-body">
              {/* Status: live state + line count (+ carve progress bar). */}
              <div className="cc-out-status">
                <span className="cc-gen-meta">
                  {carveProgress !== null
                    ? t('cc.carving', 'Carving…')
                    : busy
                      ? t('cc.generating', 'Generating…')
                      : t('cc.livePreview', 'Live preview')}{' '}
                  ·{' '}
                  <b>{lineCount}</b> {t('cc.linesToViz', 'lines → Visualizer')}
                  {mode === '3d' && carveStats && (
                    <> · {t('cc.combinedJobs', '{n} jobs combined', { n: carveStats.jobs })}</>
                  )}
                </span>
                {carveProgress !== null && (
                  <div
                    className="cc-carve-progress"
                    role="progressbar"
                    aria-label={t('cc.carveProgress', 'carving progress')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(carveProgress * 100)}
                    title={t('cc.carvingOffThread', 'Carving off the main thread — the UI stays responsive')}
                  >
                    <div className="cc-carve-progress-bar" style={{ width: `${Math.round(carveProgress * 100)}%` }} />
                  </div>
                )}
              </div>
              {/* Actions toolbar: the primary Regenerate action on the left, the
                 secondary Save/Load + Frame controls grouped and aligned right.
                 Each cluster keeps its own gap so buttons read as tidy groups. */}
              <div className="cc-out-actions">
                <div className="cc-out-actions-primary">
                  <IconButton
                    className="cc-regen"
                    icon="↻"
                    label={t('cc.regen', 'Regenerate now')}
                    onClick={() => generate()}
                    disabled={!canGenerate}
                  />
                </div>
                <div className="cc-out-actions-secondary">
                  <SaveLoadButtons
                    value={carveDoc}
                    onLoad={loadCarveDoc}
                    onError={setLoadError}
                    fileBase="karmyogi-carving"
                    ext="kcarve"
                    saveTitle={t('cc.save', 'Save carve settings')}
                    loadTitle={t('cc.load', 'Load carve settings')}
                  />
                  <FrameButton
                    className="cc-frame"
                    lines={programLines}
                    safeZ={carveGlobal.safeZ}
                    label={t('cc.frame', 'Frame')}
                  />
                </div>
              </div>
              {loadError && <div className="cc-error">{loadError}</div>}

              {mode === 'none' && (
                <span className="cc-hint">{t('cc.importToGen', 'Import a model to generate a toolpath.')}</span>
              )}
              {canGenerate && lineCount > 0 && (
                <span className="cc-hint">{t('cc.openProgramTab', 'Generated live — open the Program tab to stream, pause or step it.')}</span>
              )}

              {lineCount > 0 && (
                <>
                  <div className="cc-raw-head">
                    <button
                      className="cc-raw-toggle"
                      onClick={() => setShowRaw((v) => !v)}
                      aria-expanded={showRaw}
                      title={t('cc.rawTip', 'Show the generated G-code text (read-only)')}
                    >
                      <Icon name={showRaw ? 'chevron-down' : 'chevron-right'} size={13} />{' '}
                      {t('cc.rawGcode', 'Raw G-code ({n} lines)', { n: lineCount })}
                    </button>
                    <span className="cc-raw-acts">
                      <IconButton
                        iconName="copy"
                        label={t('cc.copyGcode', 'Copy G-code to clipboard')}
                        onClick={copyGcode}
                        disabled={!gcode}
                      />
                      <IconButton
                        iconName="download"
                        label={t('cc.downloadGcode', 'Download G-code (.nc)')}
                        onClick={downloadGcode}
                        disabled={!gcode}
                      />
                    </span>
                  </div>
                  {showRaw && <textarea className="cc-raw" readOnly value={gcode} spellCheck={false} />}
                </>
              )}
            </div>
          </section>
        </div>
      </div>
      <MaterialInfoModal material={infoMaterial} onClose={() => setInfoMaterial(null)} t={t} />
    </div>
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
  renest: () => void
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
  const num = (v: string, fallback = 0) => (Number.isFinite(+v) ? +v : fallback)
  const fNum = (n: number) => String(Math.round(n * 1000) / 1000)
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
              <div className="cc-grid">
                {!isManual && (
                  <div className="cc-field">
                    <label>{t('cc.cutoutMargin', 'Margin around part (mm)')}</label>
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={fNum(cutout.rect.marginMm)}
                      title={t('cc.cutoutMarginTip', 'Extra space left around the part’s bounding box on every side')}
                      onChange={(e) => patchRect({ marginMm: num(e.target.value) })}
                    />
                  </div>
                )}
                {isManual && (
                  <>
                    <div className="cc-field">
                      <label>{t('cc.cutoutRectX', 'Origin X (mm)')}</label>
                      <input
                        type="number"
                        step={1}
                        value={fNum(cutout.rect.x)}
                        title={t('cc.cutoutRectXTip', 'Lower-left X of the rectangle in bed coordinates')}
                        onChange={(e) => patchRect({ x: num(e.target.value) })}
                      />
                    </div>
                    <div className="cc-field">
                      <label>{t('cc.cutoutRectY', 'Origin Y (mm)')}</label>
                      <input
                        type="number"
                        step={1}
                        value={fNum(cutout.rect.y)}
                        title={t('cc.cutoutRectYTip', 'Lower-left Y of the rectangle in bed coordinates')}
                        onChange={(e) => patchRect({ y: num(e.target.value) })}
                      />
                    </div>
                    <div className="cc-field">
                      <label>{t('cc.cutoutRectW', 'Width (mm)')}</label>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={fNum(cutout.rect.width)}
                        title={t('cc.cutoutRectWTip', 'Rectangle width along X')}
                        onChange={(e) => patchRect({ width: Math.max(0, num(e.target.value)) })}
                      />
                    </div>
                    <div className="cc-field">
                      <label>{t('cc.cutoutRectH', 'Height (mm)')}</label>
                      <input
                        type="number"
                        min={0}
                        step={1}
                        value={fNum(cutout.rect.height)}
                        title={t('cc.cutoutRectHTip', 'Rectangle height along Y')}
                        onChange={(e) => patchRect({ height: Math.max(0, num(e.target.value)) })}
                      />
                    </div>
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
          <div className="cc-grid">
            <div className="cc-field">
              <label>{t('cc.cutStepdown', 'Stepdown / pass (mm)')}</label>
              <input
                type="number"
                min={0.1}
                step={0.1}
                value={fNum(cutout.cutStepdownMm)}
                title={t('cc.cutStepdownTip', 'Depth removed per profile pass through the stock')}
                onChange={(e) => patch({ cutStepdownMm: num(e.target.value, cutout.cutStepdownMm) })}
              />
            </div>
            <div className="cc-field">
              <label>{t('cc.breakThrough', 'Break-through (mm)')}</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={fNum(cutout.breakThroughMm)}
                title={t('cc.breakThroughTip', 'Extra depth below the stock bottom so the cut goes fully through')}
                onChange={(e) => patch({ breakThroughMm: num(e.target.value) })}
              />
            </div>
            {!isRect && (
              <div className="cc-field">
                <label>{t('cc.finishAllowance', 'Finish allowance (mm)')}</label>
                <input
                  type="number"
                  min={0}
                  step={0.1}
                  value={fNum(cutout.finishAllowanceMm)}
                  title={t('cc.finishAllowanceTip', 'Extra clearance beyond the tool radius left on the part edge')}
                  onChange={(e) => patch({ finishAllowanceMm: num(e.target.value) })}
                />
              </div>
            )}
          </div>

          <div className="cc-rowlabel">{t('cc.holdingTabs', 'Holding tabs')}</div>
          <div className="cc-grid">
            <div className="cc-field">
              <label>{t('cc.tabCount', 'Count')}</label>
              <input
                type="number"
                min={0}
                step={1}
                value={String(cutout.tabs.count)}
                title={t('cc.tabCountTip', 'Number of bridges spaced evenly around the part')}
                onChange={(e) => patchTabs({ count: Math.max(0, Math.round(num(e.target.value))) })}
              />
            </div>
            <div className="cc-field">
              <label>{t('cc.tabLength', 'Length (mm)')}</label>
              <input
                type="number"
                min={0}
                step={0.5}
                value={fNum(cutout.tabs.lengthMm)}
                title={t('cc.tabLengthTip', 'Width of each tab along the perimeter')}
                onChange={(e) => patchTabs({ lengthMm: num(e.target.value) })}
              />
            </div>
            <div className="cc-field">
              <label>{t('cc.tabHeight', 'Height (mm)')}</label>
              <input
                type="number"
                min={0}
                step={0.1}
                value={fNum(cutout.tabs.heightMm)}
                title={t('cc.tabHeightTip', 'Material left under each tab, measured up from the stock bottom')}
                onChange={(e) => patchTabs({ heightMm: num(e.target.value) })}
              />
            </div>
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
  renest,
}: SelectedJobCardProps) {
  const tris = job.mesh.triangleCount
  const size = {
    x: job.mesh.bbox.max[0] - job.mesh.bbox.min[0],
    y: job.mesh.bbox.max[1] - job.mesh.bbox.min[1],
    z: job.mesh.bbox.max[2] - job.mesh.bbox.min[2],
  }
  const fNum = (n: number) => String(Math.round(n * 1000) / 1000)
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
        <div className="cc-grid">
          <div className="cc-field">
            <label>
              {t('cc.cutSpeed', 'Cut speed (mm/s)')}
              <ApplyAll t={t} onClick={() => applyToAll('speeds')} />
            </label>
            <input
              type="number"
              min={0}
              step={1}
              value={fNum(job.speeds.cutSpeedMmS)}
              title={t('cc.cutSpeedTip', 'Cutting feed while the tool is engaged in material')}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setJobSpeeds(job.id, { cutSpeedMmS: Number.isFinite(v) ? v : job.speeds.cutSpeedMmS })
              }}
            />
          </div>
          <div className="cc-field">
            <label>{t('cc.freeSpeed', 'Free speed (mm/s)')}</label>
            <input
              type="number"
              min={0}
              step={1}
              value={fNum(job.speeds.freeSpeedMmS)}
              title={t('cc.freeSpeedTip', 'Travel feed for non-cutting links between one cut and the next')}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setJobSpeeds(job.id, { freeSpeedMmS: Number.isFinite(v) ? v : job.speeds.freeSpeedMmS })
              }}
            />
          </div>
          <div className="cc-field">
            <label>{t('cc.cutDepthPass', 'Cut depth / pass (mm)')}</label>
            <input
              type="number"
              min={0.05}
              step={0.1}
              value={fNum(job.speeds.cutDepthMm)}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                setJobSpeeds(job.id, { cutDepthMm: Number.isFinite(v) ? v : job.speeds.cutDepthMm })
              }}
            />
            <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.stepdown}</span>
          </div>
          <div className="cc-field">
            <label>
              {t('cc.maxDepth', 'Max carve depth (mm)')}
              <ApplyAll t={t} onClick={() => applyToAll('maxDepth')} />
            </label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={fNum(job.maxDepth)}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                updateJob(job.id, { maxDepth: Number.isFinite(v) ? v : job.maxDepth })
              }}
            />
          </div>
          <div className="cc-field">
            <label>
              {t('cc.stepoverMm', 'Stepover (mm)')}
              <ApplyAll t={t} onClick={() => applyToAll('stepover')} />
            </label>
            <input
              type="number"
              min={0.05}
              step={0.1}
              value={fNum(job.stepover)}
              onChange={(e) => {
                const v = parseFloat(e.target.value)
                updateJob(job.id, { stepover: Number.isFinite(v) ? v : job.stepover })
              }}
            />
            <span className="cc-rechint">{t('common.recommended', 'Recommended')}: {rec.stepover}</span>
          </div>
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
        <div className="cc-grid">
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.x }}>{t('cc.offsetX', 'X offset (mm)')}</label>
            <div className="cc-nudge">
              <button
                type="button"
                onClick={() => setJobPlacement(job.id, { dx: job.placement.dx - 1 })}
                title={t('cc.nudgeMinus', 'Nudge −1')}
                aria-label={t('cc.nudgeMinus', 'Nudge −1')}
              >−</button>
              <input
                type="number"
                step={0.5}
                value={fNum(job.placement.dx)}
                onChange={(e) =>
                  setJobPlacement(job.id, { dx: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
                }
              />
              <button
                type="button"
                onClick={() => setJobPlacement(job.id, { dx: job.placement.dx + 1 })}
                title={t('cc.nudgePlus', 'Nudge +1')}
                aria-label={t('cc.nudgePlus', 'Nudge +1')}
              >+</button>
            </div>
          </div>
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.y }}>{t('cc.offsetY', 'Y offset (mm)')}</label>
            <div className="cc-nudge">
              <button
                type="button"
                onClick={() => setJobPlacement(job.id, { dy: job.placement.dy - 1 })}
                title={t('cc.nudgeMinus', 'Nudge −1')}
                aria-label={t('cc.nudgeMinus', 'Nudge −1')}
              >−</button>
              <input
                type="number"
                step={0.5}
                value={fNum(job.placement.dy)}
                onChange={(e) =>
                  setJobPlacement(job.id, { dy: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
                }
              />
              <button
                type="button"
                onClick={() => setJobPlacement(job.id, { dy: job.placement.dy + 1 })}
                title={t('cc.nudgePlus', 'Nudge +1')}
                aria-label={t('cc.nudgePlus', 'Nudge +1')}
              >+</button>
            </div>
          </div>
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.z }}>{t('cc.rotation', 'Rotation (°)')}</label>
            <div className="cc-nudge">
              <button
                type="button"
                onClick={() => {
                  setJobPlacement(job.id, { rotDeg: job.placement.rotDeg - 5 })
                  renest()
                }}
                title={t('cc.nudgeRotMinus', 'Rotate −5°')}
                aria-label={t('cc.nudgeRotMinus', 'Rotate −5°')}
              >↺</button>
              <input
                type="number"
                step={1}
                value={fNum(job.placement.rotDeg)}
                onChange={(e) =>
                  setJobPlacement(job.id, { rotDeg: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
                }
              />
              <button
                type="button"
                onClick={() => {
                  setJobPlacement(job.id, { rotDeg: job.placement.rotDeg + 5 })
                  renest()
                }}
                title={t('cc.nudgeRotPlus', 'Rotate +5°')}
                aria-label={t('cc.nudgeRotPlus', 'Rotate +5°')}
              >↻</button>
            </div>
          </div>
          <div className="cc-field">
            <label>{t('cc.scale', 'Scale (×)')}</label>
            <div className="cc-nudge">
              <button
                type="button"
                onClick={() => {
                  setJobPlacement(job.id, { scale: Math.max(0.01, job.placement.scale - 0.1) })
                  renest()
                }}
                title={t('cc.nudgeScaleMinus', 'Scale −0.1×')}
                aria-label={t('cc.nudgeScaleMinus', 'Scale −0.1×')}
              >−</button>
              <input
                type="number"
                min={0.01}
                step={0.05}
                value={fNum(job.placement.scale)}
                onChange={(e) => {
                  const v = parseFloat(e.target.value)
                  setJobPlacement(job.id, { scale: Number.isFinite(v) && v > 0 ? v : 1 })
                }}
              />
              <button
                type="button"
                onClick={() => {
                  setJobPlacement(job.id, { scale: job.placement.scale + 0.1 })
                  renest()
                }}
                title={t('cc.nudgeScalePlus', 'Scale +0.1×')}
                aria-label={t('cc.nudgeScalePlus', 'Scale +0.1×')}
              >+</button>
            </div>
          </div>
        </div>
        <span className="cc-hint">
          {t('cc.placementJobHint', 'X/Y/rotation/scale move just THIS job. Re-nest packs all jobs without overlap.')}
        </span>

        {/* Per-job stock */}
        <div className="cc-rowlabel">
          {t('cc.stock', 'Stock')}
          <ApplyAll t={t} onClick={() => applyToAll('stock')} />
        </div>
        <div className="cc-grid">
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.x }}>{t('common.width', 'Width')} X</label>
            <input
              type="number"
              min={1}
              step={1}
              value={fNum(job.stock.width)}
              onChange={(e) =>
                setJobStock(job.id, { width: Number.isFinite(+e.target.value) ? +e.target.value : 1 })
              }
            />
          </div>
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.y }}>{t('common.depth', 'Depth')} Y</label>
            <input
              type="number"
              min={1}
              step={1}
              value={fNum(job.stock.depth)}
              onChange={(e) =>
                setJobStock(job.id, { depth: Number.isFinite(+e.target.value) ? +e.target.value : 1 })
              }
            />
          </div>
          <div className="cc-field">
            <label style={{ color: AXIS_COLOR.z }}>{t('common.thickness', 'Thickness')} Z</label>
            <input
              type="number"
              min={1}
              step={1}
              value={fNum(job.stock.height)}
              onChange={(e) =>
                setJobStock(job.id, { height: Number.isFinite(+e.target.value) ? +e.target.value : 1 })
              }
            />
          </div>
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
