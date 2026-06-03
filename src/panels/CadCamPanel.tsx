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
  placeToolpath,
  parseEpsPaths,
  defaultCarve3DParams,
  type Carve3DParams,
  type ToolType,
} from '../core/carve3d'
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
import { Modal } from '../components/Modal'
import { InfoTip } from '../components/InfoTip'
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
            onChange(Number.isFinite(n) ? n : 0)
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
          <p className="cc-matinfo-notes">{m.notes}</p>
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

/** Classify a picked file by its extension. */
function classify(name: string): Mode | 'dxf' {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'stl') return '3d'
  if (ext === 'step' || ext === 'stp') return 'step'
  if (ext === 'dxf') return 'dxf'
  if (ext === 'eps' || ext === 'ai') return '2d'
  if (ext === 'cdr') return 'cdr'
  return 'none'
}

/**
 * Strip the standard {@link GcodeEmitter} header/footer from a single-job
 * program, returning just the cutting body so several jobs can be stitched under
 * ONE shared header (units/plane), spindle start, and footer. A safe-Z retract
 * is prepended so each stitched job begins above the stock before its first XY
 * travel (the boundary between jobs is always safe).
 *
 * The emitter header is fixed: optional `( … )` comments, then G21, G90, G94,
 * G17, `G0 Z<safe>`, optional `M3 …`/`G4 …`. The footer is `G0 Z<safe>`, optional
 * `M5`, `M30`. We drop those modal/setup/spindle/end lines and keep everything in
 * between (comments and motion).
 */
function extractEmitterBody(program: string, safeZ: number): string[] {
  const raw = program.split(/\r?\n/)
  // Header words to drop wherever they appear at the top (and the program-level
  // comments). We strip leading setup until the first real motion/comment body.
  const isHeaderLine = (l: string): boolean => {
    const s = l.trim()
    if (s === '') return true
    if (/^G21$|^G20$|^G90$|^G91$|^G94$|^G17$/.test(s)) return true
    if (/^M3\b/.test(s) || /^M4\b/.test(s) || /^G4\b/.test(s)) return true
    // The header's initial safe-Z retract.
    if (/^G0\s+Z/i.test(s)) return true
    // Generator banner / program-name comments.
    if (/^\(Generated by /i.test(s)) return true
    return false
  }
  // Find the end of the contiguous header block.
  let start = 0
  while (start < raw.length && isHeaderLine(raw[start])) start++
  // Find the start of the footer block (M30 / M5 / trailing safe-Z) from the end.
  let end = raw.length
  while (end > start) {
    const s = raw[end - 1].trim()
    if (s === '' || /^M30\b/.test(s) || /^M5\b/.test(s) || /^G0\s+Z/i.test(s)) {
      end--
      continue
    }
    break
  }
  const body = raw.slice(start, end).filter((l) => l.trim().length > 0)
  if (body.length === 0) return []
  // Prepend a safe retract so the job's first rapid XY is preceded by a lift.
  return [`G0 Z${safeZ.toFixed(3)}`, ...body]
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
  return defaultCarve3DParams({
    toolDiameter: global.toolDiameter,
    toolType: global.toolType,
    stepover: job.stepover,
    stepdown: job.speeds.cutDepthMm,
    safeZ: global.safeZ,
    maxDepth: job.maxDepth,
    feedXY: job.speeds.cutSpeedMmS * 60,
    feedZ: global.feedZ,
    travelFeed: job.speeds.freeSpeedMmS * 60,
    spindleRPM: global.spindleRPM,
    doRoughing: job.roughing,
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
  const [fileName, setFileName] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('none')
  const [dragOver, setDragOver] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [nestWarn, setNestWarn] = useState<string[]>([])

  // 2D state (DXF / EPS / AI)
  const [drawing, setDrawing] = useState<Drawing | null>(null)
  const [epsPolys, setEpsPolys] = useState<Polyline[] | null>(null)
  const [op, setOp] = useState<Op>('Profile')
  const [side, setSide] = useState<ProfileSide>(ProfileSide.Outside)
  const [p2d, setP2d] = usePersistentState<Params2D>('karmyogi.carve.2d', DEFAULT_2D)

  // Tool/bit selection — persisted so the operator's bit survives reloads.
  const [bitId, setBitId] = usePersistentState<string>('karmyogi.carve.bit', DEFAULT_BIT_ID)
  // Bit cutting LENGTH (flute/usable length, mm) — a primary, beginner-visible
  // choice. It doesn't change the toolpath, but it's the safe limit on how deep
  // the bit can reach, so we surface it and use it as a sanity hint for depth.
  const [bitLength, setBitLength] = usePersistentState<number>('karmyogi.carve.bitLen', 16)

  // Output
  const [gcode, setGcode] = useState('')
  const [lineCount, setLineCount] = useState(0)
  const [showRaw, setShowRaw] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  /** Material whose info modal is open (large image + properties), or null. */
  const [infoMaterial, setInfoMaterial] = useState<MaterialPreset | null>(null)

  // ---- material + bit + recommendation ------------------------------------
  const material = useMemo(
    () => getMaterial(stock.materialId) ?? getMaterial(DEFAULT_MATERIAL_ID)!,
    [stock.materialId]
  )
  const bit = useMemo(() => getBit(bitId) ?? getBit(DEFAULT_BIT_ID)!, [bitId])
  const bitType = bit.type
  const sizesForType = useMemo(() => bitsOfType(bitType), [bitType])
  const rec = useMemo(() => recommend(material, bit), [material, bit])

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
  useEffect(() => {
    const speeds: Partial<CarveJob['speeds']> = {
      cutSpeedMmS: Math.round((rec.feedXY / 60) * 100) / 100,
      cutDepthMm: rec.stepdown,
      // Free/travel speed → MAX (rapid-class link feed).
      freeSpeedMmS: Math.round((RAPID_FEED_MM_MIN / 60) * 100) / 100,
    }
    setDefaults({ speeds, stepover: rec.stepover })
    // Plunge-Z (feedZ) + spindle are global; recompute on bit/material change.
    setGlobal({ feedZ: rec.feedZ, spindleRPM: rec.spindleRPM })
    if (selectedJob) {
      setJobSpeeds(selectedJob.id, speeds)
      updateJob(selectedJob.id, { stepover: rec.stepover })
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
  async function loadFile(file: File) {
    setImportError(null)
    setWarnings([])
    const kind = classify(file.name)
    setFileName(file.name)

    if (kind === 'step') {
      setMode('step')
      setDrawing(null)
      setEpsPolys(null)
      return
    }
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
      try {
        const buf = await file.arrayBuffer()
        const mesh = parseStl(buf)
        if (mesh.triangleCount === 0) {
          setImportError(t('cc.errNoTriangles', 'STL parsed but contained no triangles.'))
          return
        }
        // ADD as a new job (do NOT replace existing jobs).
        const niceName = file.name.replace(/\.stl$/i, '')
        addJob(mesh, niceName)
        // Auto-nest so the new model lands beside the others.
        const res = renest(bed.width, bed.depth)
        setNestWarn(res.warnings)
      } catch (err) {
        setImportError(
          t('cc.errStl', 'Failed to read STL: {msg}', {
            msg: err instanceof Error ? err.message : String(err),
          })
        )
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

  // ---- 3D: combined carve over ALL enabled jobs ---------------------------
  const [carveStats, setCarveStats] = useState<{
    jobs: number
    grids: number
  } | null>(null)

  function generate3D(): string {
    const active = jobs.filter((j) => j.enabled)
    if (active.length === 0) {
      setGcode('')
      setLineCount(0)
      setCarveStats(null)
      return ''
    }
    const allWarnings: string[] = []
    // Each job carves with ITS OWN feeds, so we emit each job's body with a
    // per-job emitter (which writes that job's F words) and stitch the bodies
    // under ONE shared header / spindle-start / footer — so the operator gets a
    // single combined program with correct per-job speeds.
    const bodies: string[] = []
    let grids = 0
    let carved = 0
    for (const job of active) {
      const params = jobCarveParams(job, carveGlobal)
      const result = carveMesh(job.mesh, params)
      for (const w of result.warnings) allWarnings.push(`${job.name}: ${w}`)
      if (result.gridX > 0) grids += 1
      if (result.toolpaths.length === 0) continue

      // Bake the job's placement (move/rotate/scale about its mesh centre).
      const pivot = meshCenter(job.mesh)
      const placed = result.toolpaths.map((tp) => {
        const p = placeToolpath(tp, job.placement, pivot)
        p.name = `${job.name} — ${tp.name}`
        return p
      })
      const jobEmitter = new GcodeEmitter({
        programName: '',
        comments: true,
        safeZ: carveGlobal.safeZ,
        feedXY: job.speeds.cutSpeedMmS * 60,
        feedZ: carveGlobal.feedZ,
        travelFeed: job.speeds.freeSpeedMmS * 60,
        zMode: ZMode.Spindle,
        useSpindle: false, // spindle handled once in the shared header
        spindleRPM: carveGlobal.spindleRPM,
      })
      const body = extractEmitterBody(jobEmitter.emitProgram(placed), carveGlobal.safeZ)
      if (body.length > 0) bodies.push(`(${job.name})`, ...body)
      carved += 1
    }
    setWarnings(allWarnings)
    setCarveStats({ jobs: carved, grids })

    if (bodies.length === 0) {
      setGcode('')
      setLineCount(0)
      return ''
    }

    // Assemble the SINGLE combined program: one safe header, one M3, all job
    // bodies (each prefixed by a safe-Z retract from extractEmitterBody), one M5.
    const name =
      active.length === 1 ? `${active[0].name} — 3D Carving` : `${active.length} jobs — 3D Carving`
    const safe = carveGlobal.safeZ.toFixed(3)
    const lines: string[] = [
      `(${name})`,
      '(Generated by karmyogi 3D Carving — multi-model)',
      'G21',
      'G90',
      'G94',
      'G17',
      `G0 Z${safe}`,
      `M3 S${carveGlobal.spindleRPM.toFixed(3)}`,
      ...bodies,
      `G0 Z${safe}`,
      'M5',
      'M30',
    ]
    const out = lines.join('\n') + '\n'
    const count = out.split('\n').filter((l) => l.length > 0).length
    setProgram(name, out)
    setGcode(out)
    setLineCount(count)
    return out
  }

  function generate(): string {
    if (mode === '3d') return generate3D()
    if (mode === '2d') return generate2D()
    return ''
  }

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
  // critical path so a heavy carve never blocks typing.
  useEffect(() => {
    if (mode !== '2d' && mode !== '3d') return
    if (mode === '3d' && jobs.filter((j) => j.enabled).length === 0) return
    setBusy(true)
    const id = window.setTimeout(() => {
      try {
        if (!isPanelVisible()) return
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
  }, [mode, drawing, epsPolys, op, side, p2d, polylines, carveRev, jobs, carveGlobal])

  // When the panel becomes visible again (tab re-selected) and we have carve
  // jobs, re-assert our program so a sibling panel can't leave a stale program
  // showing in the Visualizer.
  useEffect(() => {
    if (mode !== '3d') return
    const el = panelRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (isPanelVisible() && jobs.some((j) => j.enabled)) generate3D()
    })
    ro.observe(el)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, jobs.length])

  function doRenest() {
    const res = renest(bed.width, bed.depth)
    setNestWarn(res.warnings)
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

  const isPen = p2d.zMode === ZMode.Pen
  const hasGeometry = polylines.length > 0
  const canGenerate2D = hasGeometry && (op === 'Engrave' || closedCount > 0)
  const enabledJobs = jobs.filter((j) => j.enabled).length
  const canGenerate = mode === '3d' ? enabledJobs > 0 : canGenerate2D
  const flowStep =
    mode === 'none' ? 1 : !canGenerate ? 2 : lineCount > 0 ? 3 : 2

  // Selected job's footprint vs bed (cheap fit hint).
  const selFootprint = useMemo(() => {
    if (!selectedJob) return null
    const w = selectedJob.stock.width
    const d = selectedJob.stock.depth
    return { w, d, fits: w <= bed.width && d <= bed.depth }
  }, [selectedJob, bed.width, bed.depth])

  return (
    <div
      ref={panelRef}
      className={'cc-panel' + (dragOver ? ' cc-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      <div className="cc-scroll">
        <p className="cc-intro">
          <b>{t('cc.title', '3D Carving.')}</b>{' '}
          {t(
            'cc.introMulti',
            'Import one or more STL models — each becomes a job that auto-nests on the bed and carves in a single combined program. DXF / vector files do 2D engrave · profile · pocket.'
          )}
        </p>
        <ol className="cc-flow" aria-label={t('cc.workflow', 'workflow steps')}>
          <li className={flowStep >= 1 ? 'done' : ''}>
            <span className="cc-flow-n">1</span> {t('cc.stepImport', 'Import model')}
          </li>
          <li className={flowStep >= 2 ? 'done' : ''}>
            <span className="cc-flow-n">2</span>{' '}
            {mode === '3d'
              ? t('cc.stepCarve', 'Carve settings')
              : t('cc.operation', 'Operation')}
          </li>
          <li className={flowStep >= 3 ? 'done' : ''}>
            <span className="cc-flow-n">3</span> {t('common.send', 'Send')} ▶
          </li>
        </ol>

        <div className="cc-cards">
          {/* ============ PRIMARY: BIT + MATERIAL (the only choices a beginner
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
                        {b.icon} {b.name}
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

              {/* Material swatches — the 4th primary choice */}
              <div className="cc-prim-lbl cc-prim-matlbl">
                {t('cc.material', 'Material')}
                <Tip
                  id="material"
                  title={t('cc.material', 'Material')}
                  body={t(
                    'cc.tipMaterial',
                    'What you are cutting. Together with the bit, this decides safe feeds, spindle speed and depth-of-cut. Click a swatch to pick; click its picture for full details.',
                  )}
                />
              </div>
              <div className="cc-pickgrid" role="group" aria-label={t('cc.material', 'Material')}>
                {MATERIALS.map((m) => (
                  <button
                    key={m.id}
                    className={'cc-pick' + (m.id === material.id ? ' active' : '')}
                    onClick={() => {
                      stock.setMaterial(m.id)
                      if (mode === '3d' && selectedJob) updateJob(selectedJob.id, { material: m.id })
                    }}
                    title={m.notes}
                    aria-pressed={m.id === material.id}
                  >
                    <MaterialSwatch
                      material={m}
                      onInfo={setInfoMaterial}
                      label={t('cc.matViewDetails', 'View {mat} details', {
                        mat: t(m.i18nKey, m.name),
                      })}
                    />
                    <span className="cc-pick-label">{t(m.i18nKey, m.name)}</span>
                  </button>
                ))}
              </div>
              <span className="cc-hint">
                {t('cc.primaryHint', 'One bit cuts every job. Speeds & depth are worked out from these — see Advanced (auto) below.')}
              </span>
            </div>
          </section>

          {/* ============ ADVANCED (AUTO): computed feeds/depths, read-only with
                an "auto" badge; only Plunge-Z and Safe-Z are editable. ======== */}
          <section className="cc-section cc-advanced cc-autoadv">
            <button
              className="cc-adv-toggle"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              title={t('cc.advAutoTip', 'Auto-computed speeds & depths from your bit + material. Plunge-Z is editable; the rest are derived for you.')}
            >
              {showAdvanced ? '▾' : '▸'} {t('cc.advancedAuto', 'Advanced (auto)')}
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
                      onChange={(e) =>
                        setGlobal({ feedZ: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
                      }
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
                      onChange={(e) =>
                        setGlobal({ safeZ: Number.isFinite(+e.target.value) ? +e.target.value : 5 })
                      }
                    />
                  </div>
                </div>
                <span className="cc-hint">
                  {t('cc.autoFootnote', 'These update automatically when you change the bit or material. Only Plunge-Z and Safe-Z are yours to tweak.')}
                </span>
              </div>
            )}
          </section>

          {/* ================= IMPORT / DROP ================= */}
          <section className="cc-section">
            <h3>1 · {t('cc.model', 'Model')}</h3>
            <div className="cc-section-body">
              <div className={'cc-drop' + (dragOver ? ' cc-dragover' : '')}>
                <span className="cc-drop-icon" aria-hidden>
                  ⤓
                </span>
                <button
                  className="cc-load-btn primary"
                  onClick={() => fileRef.current?.click()}
                  title={t('cc.importTipMulti', 'Add an .stl model as a job (import again for more) — or a .dxf / .eps / .ai vector file')}
                >
                  {t('cc.importAdd', 'Add model…')}
                </button>
                <span className="cc-drop-hint">
                  {t('cc.dropHintMulti', 'or drop a .stl / .dxf / .eps / .ai file anywhere — each STL adds a job')}
                </span>
                <input
                  ref={fileRef}
                  className="cc-load-input"
                  type="file"
                  accept=".stl,.step,.stp,.dxf,.eps,.ai,.cdr"
                  onChange={onFileChange}
                />
              </div>

              {importError && <div className="cc-error">{importError}</div>}

              {mode === 'step' && (
                <div className="cc-error">
                  {t(
                    'cc.stepUnsupported',
                    'STEP import isn’t supported yet — full ISO-10303 (B-rep) parsing is out of scope. Please export your model as STL (most CAD tools: File → Export → STL) and import that instead.'
                  )}
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
                    ▦
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
                        <input
                          type="checkbox"
                          className="cc-job-en"
                          checked={job.enabled}
                          onChange={(e) => updateJob(job.id, { enabled: e.target.checked })}
                          title={t('cc.jobEnable', 'Include this job in the program')}
                          aria-label={t('cc.jobEnable', 'Include this job in the program')}
                        />
                        <button
                          className="cc-job-name"
                          onClick={() => selectJob(job.id)}
                          title={t('cc.jobSelect', 'Select to edit this job’s settings')}
                        >
                          <span className="cc-job-ico" aria-hidden>🗻</span>
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
                          ⧉
                        </button>
                        <button
                          className="cc-iconbtn danger"
                          onClick={() => {
                            removeJob(job.id)
                            const res = renest(bed.width, bed.depth)
                            setNestWarn(res.warnings)
                          }}
                          title={t('cc.jobRemove', 'Remove this job')}
                          aria-label={t('cc.jobRemove', 'Remove this job')}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {nestWarn.length > 0 && (
                  <ul className="cc-warnings">
                    {nestWarn.slice(0, 4).map((w, i) => (
                      <li key={i}>⚠ {w}</li>
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
                        {o === 'Engrave'
                          ? t('cc.engrave', 'Engrave')
                          : o === 'Profile'
                            ? t('cc.profile', 'Profile')
                            : t('cc.pocket', 'Pocket')}
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
                          title={t('cc.profileSideTip', 'Cut {side} the contour', { side: String(s).toLowerCase() })}
                        >
                          {s}
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
                      🛞 {t('cc.spindle', 'Spindle')}
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
                  {showAdvanced ? '▾' : '▸'} {t('common.advanced', 'Advanced')}
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
          <section className="cc-section cc-output">
            <h3>{t('cc.output', 'Output')}</h3>
            <div className="cc-section-body">
              <div className="cc-generate">
                <span className="cc-gen-meta">
                  {busy ? t('cc.generating', 'Generating…') : t('cc.livePreview', 'Live preview')} ·{' '}
                  <b>{lineCount}</b> {t('cc.linesToViz', 'lines → Visualizer')}
                  {mode === '3d' && carveStats && (
                    <> · {t('cc.combinedJobs', '{n} jobs combined', { n: carveStats.jobs })}</>
                  )}
                </span>
                <button
                  className="cc-regen"
                  onClick={() => generate()}
                  disabled={!canGenerate}
                  title={t('cc.regen', 'Regenerate now')}
                  aria-label={t('cc.regen', 'Regenerate now')}
                >
                  ↻
                </button>
              </div>

              {mode === 'none' && (
                <span className="cc-hint">{t('cc.importToGen', 'Import a model to generate a toolpath.')}</span>
              )}
              {mode === 'step' && (
                <span className="cc-hint">{t('cc.exportStl', 'Export your STEP model as STL to carve it.')}</span>
              )}
              {canGenerate && lineCount > 0 && (
                <span className="cc-hint">{t('cc.openProgramTab', 'Generated live — open the Program tab to stream, pause or step it.')}</span>
              )}

              {lineCount > 0 && (
                <>
                  <button
                    className="cc-raw-toggle"
                    onClick={() => setShowRaw((v) => !v)}
                    aria-expanded={showRaw}
                    title={t('cc.rawTip', 'Show the generated G-code text (read-only)')}
                  >
                    {showRaw ? '▾' : '▸'} {t('cc.rawGcode', 'Raw G-code ({n} lines)', { n: lineCount })}
                  </button>
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

  return (
    <section className="cc-section cc-jobcard">
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
              onChange={(e) =>
                setJobSpeeds(job.id, { cutSpeedMmS: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
              }
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
              onChange={(e) =>
                setJobSpeeds(job.id, { freeSpeedMmS: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
              }
            />
          </div>
          <div className="cc-field">
            <label>{t('cc.cutDepthPass', 'Cut depth / pass (mm)')}</label>
            <input
              type="number"
              min={0.05}
              step={0.1}
              value={fNum(job.speeds.cutDepthMm)}
              onChange={(e) =>
                setJobSpeeds(job.id, { cutDepthMm: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
              }
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
              onChange={(e) =>
                updateJob(job.id, { maxDepth: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
              }
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
              onChange={(e) =>
                updateJob(job.id, { stepover: Number.isFinite(+e.target.value) ? +e.target.value : 0 })
              }
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
      </div>
    </section>
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
