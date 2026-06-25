import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { importDxfString } from '../core/dxf'
import { Drawing } from '../core/entity'
import { engrave, profileContours, pocket, ProfileSide, type CamParams } from '../core/cam'
import {
  applyLeadRamp,
  orientLoop,
  type CutDirection,
  type LeadShape,
  type PlungeMode,
  type LeadRampOptions,
} from '../core/carveStrategy'
import {
  composeFeatureToolpaths,
  composeMultiFileToolpaths,
  deriveFeatures,
  featureKey,
  parseFeatureKey,
  parseSurfaceKey,
  surfaceKey,
  loopLabel,
  opFromPreset,
  orderOpsSafe,
  BUILTIN_PRESETS,
  type DrawingFeature,
  type FeatureOp,
  type FeatureOpMap,
  type FileGeometry,
  type OrderableOp,
} from '../core/featureCam'
import {
  CARVE_PRESETS_KEY,
  type CarvePreset,
  CARVE_PRESETS_3D_KEY,
  type Carve3DPreset,
} from '../store/carvePresets'
import { type FeaturePreset } from '../core/featureCam'
import { usePresets, type PresetSlot } from '../components/presets/usePresets'
import { PresetRail } from '../components/presets/PresetRail'
import { PresetSaveBar } from '../components/presets/PresetSaveBar'
import { FeatureViewer } from '../components/cam/FeatureViewer'
import { SurfaceViewer } from '../components/cam/SurfaceViewer'
import { segmentSurfaces, regionOutlineXY, type SurfaceRegion } from '../core/meshSegment'
import { vCarveContours, type VCarveParams } from '../core/vcarve'
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
  placeToolpath,
  type Carve3DParams,
  type ToolType,
  type CarveJobSpec,
  type CarveProgramGlobals,
  type CarveWorkerRequest,
  type CarveWorkerOutbound,
} from '../core/carve3d'
import { defaultCutoutParams, type CutoutParams } from '../core/cutout'
import {
  buildCarveSessionZip,
  parseCarveSessionZip,
  meshToBinaryStl,
  CarveSessionError,
  CARVE_SESSION_EXT,
  type CarveSessionSource,
} from '../core/carveSession'
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
import { useHover } from '../store/hover'
import { usePlayback } from '../store/playback'
import { grbl } from '../serial/controller'
import { buildFrameProgram, frameBoundsOfGcode } from '../core/framing'
import { useTabCommands } from '../machine/tabCommands'
import {
  useCarveJobs,
  type CarveJob,
  type ApplyAllKey,
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
  Triangle,
  Spline,
  Route,
  Eraser,
  Pencil,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  Wand2,
} from 'lucide-react'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { SegControl } from '../components/ui/SegControl'
import { SliderField as UISliderField } from '../components/ui/SliderField'
import { CamEmpty, CamBusy, CamError } from '../components/cam/CamUI'
import { useT } from '../i18n'
import '../styles/cadcam.css'
import '../styles/cam.css'
import '../styles/vcarve.css'

/** Which import family is currently loaded — drives the whole panel layout. */
type Mode = 'none' | '3d' | '2d' | 'step' | 'cdr'

type Op = 'Engrave' | 'Profile' | 'Pocket' | 'VCarve'

/**
 * One uploaded 2D vector file (U8). Holds its own parsed geometry: a DXF parses
 * to a {@link Drawing} (flattened lazily); EPS/AI parse to ready polylines. The
 * stable `id` keys this file's loops in the shared FeatureOpMap.
 */
interface LoadedFile {
  id: string
  name: string
  kind: 'dxf' | 'eps'
  drawing: Drawing | null
  polylines: Polyline[] | null
  /** Per-file import warnings, surfaced under the model card. */
  warnings: string[]
  /**
   * The ORIGINAL imported file text (DXF / EPS / AI is text-based). Retained so a
   * carving SESSION export can re-pack the raw source bytes and an upload can
   * re-import the exact same drawing. Undefined for clones whose source isn't
   * tracked (the clone still shares the parsed geometry).
   */
  sourceText?: string
}

let loadedFileCounter = 0
function newFileId(): string {
  loadedFileCounter += 1
  return `f${Date.now().toString(36)}-${loadedFileCounter}`
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
 * Carving parameter row: the shared kit `<UISliderField>` (track + number + unit,
 * plan §2.8 / W-B) dressed with the carving-specific chrome — a leading colour
 * glyph, an optional trailing control (e.g. "apply to all jobs"), and a wrapped
 * recommendation hint below. The core control (label + draggable track + typable
 * number + unit) is the canonical shared component, so the bespoke `.cc-slider`
 * track/thumb CSS is gone; only the icon/hint/action wrapper is local.
 *
 * `value`/`onChange` carry the field's existing wiring untouched. `disabled`
 * greys it out when a field has no meaningful value (e.g. Width/Height with no
 * geometry).
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
  return (
    <div className="cc-sfield-row" title={title}>
      <span className="cc-sfield-ico" aria-hidden>
        {icon}
      </span>
      <UISliderField
        className="cc-sfield-core"
        id={htmlFor}
        label={label}
        unit={unit}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
      />
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

/** V-carving knobs (DXF / EPS / AI closed contours → variable-depth groove). */
interface VCarveUiParams {
  vBitAngleDeg: number // full included tip angle
  vTipDiameterMm: number // flat tip ⌀ (0 = sharp point)
  maxDepthMm: number // hard depth clamp
  cleanup: boolean // run a flat-endmill clearance pass for wide areas
  cleanupToolMm: number // flat cleanup tool ⌀
  cleanupStepoverFrac: number // cleanup stepover (×⌀)
}

const DEFAULT_VCARVE: VCarveUiParams = {
  vBitAngleDeg: 60,
  vTipDiameterMm: 0,
  maxDepthMm: 3,
  cleanup: false,
  cleanupToolMm: 3.175,
  cleanupStepoverFrac: 0.45,
}

/** Narrow unknown into valid VCarveUiParams, falling back per-field to `base`. */
function parseVcarve(v: unknown, base: VCarveUiParams): VCarveUiParams {
  if (!isRecord(v)) return base
  return {
    vBitAngleDeg: numOr(v.vBitAngleDeg, base.vBitAngleDeg),
    vTipDiameterMm: numOr(v.vTipDiameterMm, base.vTipDiameterMm),
    maxDepthMm: numOr(v.maxDepthMm, base.maxDepthMm),
    cleanup: boolOr(v.cleanup, base.cleanup),
    cleanupToolMm: numOr(v.cleanupToolMm, base.cleanupToolMm),
    cleanupStepoverFrac: numOr(v.cleanupStepoverFrac, base.cleanupStepoverFrac),
  }
}

/**
 * C7 + C12 · Cut-strategy knobs for the 2D milling ops (profile / pocket /
 * cutout). These are machinist-grade entry/direction controls layered on top of
 * the basic toolpath via core/carveStrategy post-processors — no straight
 * plunges, climb-vs-conventional control, and a finishing allowance.
 */
interface CutStrategyParams {
  /** Lead-in/out shape at each cut start/end. */
  lead: LeadShape
  /** Lead length / arc radius (mm). */
  leadLengthMm: number
  /** How the tool descends to depth (no straight plunge by default). */
  plunge: PlungeMode
  /** Ramp/helix descent angle from horizontal (deg). */
  rampAngleDeg: number
  /** Helix radius (mm). */
  helixRadiusMm: number
  /** Cut direction for closed loops (climb cuts cleaner; conventional is safer on slop). */
  direction: CutDirection
  /** Finishing allowance left on the wall (mm) for a later pass. */
  stockToLeaveMm: number
}

const DEFAULT_STRATEGY: CutStrategyParams = {
  lead: 'none',
  leadLengthMm: 2,
  plunge: 'ramp',
  rampAngleDeg: 15,
  helixRadiusMm: 1.5,
  direction: 'climb',
  stockToLeaveMm: 0,
}

function parseStrategy(v: unknown, base: CutStrategyParams): CutStrategyParams {
  if (!isRecord(v)) return base
  const lead = v.lead === 'tangent' || v.lead === 'arc' || v.lead === 'none' ? v.lead : base.lead
  const plunge =
    v.plunge === 'plunge' || v.plunge === 'ramp' || v.plunge === 'helix' ? v.plunge : base.plunge
  const direction = v.direction === 'climb' || v.direction === 'conventional' ? v.direction : base.direction
  return {
    lead: lead as LeadShape,
    leadLengthMm: numOr(v.leadLengthMm, base.leadLengthMm),
    plunge: plunge as PlungeMode,
    rampAngleDeg: numOr(v.rampAngleDeg, base.rampAngleDeg),
    helixRadiusMm: numOr(v.helixRadiusMm, base.helixRadiusMm),
    direction: direction as CutDirection,
    stockToLeaveMm: numOr(v.stockToLeaveMm, base.stockToLeaveMm),
  }
}

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

/** Human-readable file size, e.g. 4823000 → "4.6 MB". */
function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`
  const mb = kb / 1024
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * Split the worker's SINGLE combined 3D-carve program back into one safe,
 * standalone program PER JOB (U-PER-FILE). `buildCarveProgram` (core/carve3d)
 * delimits each job's cutting body with a `(<job name>)` comment line; we walk
 * those markers, group each job's body, and re-wrap it in its own safe header
 * (G21/G90/G94/G17 + safe-Z + M3) and footer (safe-Z + M5 + M30) so every
 * returned section is an independently-streamable safe program. Matching is by
 * the known active job names (order-preserving). Returns [] when no markers are
 * found (the caller then falls back to a single combined section).
 */
function splitCarveProgramByJob(
  combined: string,
  jobNames: string[],
  safeZ: number,
  spindleRPM: number,
): Array<{ name: string; gcode: string }> {
  const lines = combined.split(/\r?\n/)
  const markerSet = new Set(jobNames.map((n) => `(${n})`))
  const out: Array<{ name: string; body: string[] }> = []
  let cur: { name: string; body: string[] } | null = null
  for (const raw of lines) {
    const s = raw.trim()
    if (markerSet.has(s)) {
      // Start of a new job's body — the marker is `(<name>)`.
      cur = { name: s.slice(1, -1), body: [] }
      out.push(cur)
      continue
    }
    if (!cur) continue // still in the shared header (before the first marker)
    // Stop collecting at the shared footer (the last safe-Z / M5 / M30).
    if (/^M5\b/.test(s) || /^M30\b/.test(s)) continue
    if (s === '') continue
    cur.body.push(raw)
  }
  if (out.length === 0) return []
  const safe = safeZ.toFixed(3)
  return out
    .filter((j) => j.body.length > 0)
    .map((j) => ({
      name: j.name,
      gcode:
        [
          `(${j.name} — 3D Carving)`,
          '(Generated by karmyogi 3D Carving)',
          'G21',
          'G90',
          'G94',
          'G17',
          `G0 Z${safe}`,
          `M3 S${spindleRPM.toFixed(3)}`,
          ...j.body,
          `G0 Z${safe}`,
          'M5',
          'M30',
        ].join('\n') + '\n',
    }))
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
  // Cross-panel hover link: hovering an op row shimmers its toolpath in the 3D
  // viewer and highlights the matching Program-tab row (and vice-versa).
  const hoveredOpId = useHover((s) => s.hoveredOpId)
  const setHoveredOp = useHover((s) => s.setHoveredOp)
  const setGenerating = useProgram((s) => s.setGenerating)
  const setGeneratingStatus = useProgram((s) => s.setGeneratingStatus)
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
  // Live import status shown IN the panel (name + size + stage + 0..1 fraction).
  // `frac` is null for the indeterminate parsing stage. Cleared when the model
  // is loaded (or on error). Distinct from `importing` (the STEP spinner flag).
  const [importStatus, setImportStatus] = useState<{
    label: string
    stage: string
    frac: number | null
  } | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [nestWarn, setNestWarn] = useState<string[]>([])

  // 2D state (DXF / EPS / AI) — MULTI-FILE (U8). Each uploaded vector file is a
  // LoadedFile holding its own parsed geometry; placement (offset/scale, in p2d)
  // is applied uniformly to all files. Loops are keyed by fileId+loopIndex so two
  // files' loops never collide.
  const [files, setFiles] = useState<LoadedFile[]>([])
  const [op, setOp] = useState<Op>('Profile')
  const [side, setSide] = useState<ProfileSide>(ProfileSide.Outside)
  const [p2d, setP2d] = usePersistentState<Params2D>('karmyogi.carve.2d', DEFAULT_2D)
  // ── PER-FEATURE toolpaths ────────────────────────────────────────────────
  // Map of feature key (`${fileId}#${loopIndex}`) → ordered list of operations
  // stacked on that loop. Empty map → the legacy whole-file flow (the single
  // Operation chosen below applies to everything, across every file). The mini
  // feature viewer below each file writes this map. NOT persisted: keyed by
  // file id + polyline index, which only makes sense against loaded geometry.
  const [featureOpMap, setFeatureOpMap] = useState<FeatureOpMap>({})
  // The currently SELECTED loop, as a composite `${fileId}#${loopIndex}` key.
  const [selectedFeature, setSelectedFeature] = useState<string | null>(null)
  // Which model cards are EXPANDED (their preview + loop table visible). U5: the
  // card TITLE is the disclosure (caret). Keyed by file id.
  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  // The ADDED-SEQUENCE order of the per-loop operations: a flat list of op ids in
  // the order the user added them (across ALL loops/files). The operations list
  // (U4) renders in THIS order; the featureOpMap keeps the per-loop grouping the
  // composer needs. Both are kept in lock-step by the add/remove/reorder helpers.
  const [featureOpOrder, setFeatureOpOrder] = useState<string[]>([])
  // The per-loop preset SELECTION for the loop→preset→+ table (R3): composite
  // loop key → chosen preset id (defaults to the first preset for unset rows).
  const [loopPresetSel, setLoopPresetSel] = useState<Record<string, string>>({})
  // Per-SURFACE preset dropdown selection (3D), keyed by surface key.
  const [surfacePresetSel, setSurfacePresetSel] = useState<Record<string, string>>({})

  // ---- carve PRESETS — full param SNAPSHOTS (shared rail + save-bar) -------
  // A CARVE PRESET captures the WHOLE bottom-section cutting setup (op + side,
  // bit & material, tool & cut, Z mode, advanced, V-carve). Selecting a slot
  // LOADS it into the bottom sections (applyPreset); editing those sections edits
  // the active preset; Save persists it. Wired exactly like Soldering / Writing
  // via the shared `usePresets<CarvePreset>` hook + `<PresetRail>`/`<PresetSaveBar>`.
  // The 7 defaults are seeded into the slot list on first use (see carvePresets.ts).
  // (capturePreset / applyPreset are defined AFTER the bottom-param state below.)

  // ---- two-section split (top = files/loops, bottom = ops/params) (R6) ----
  // Persisted split position as a TOP-section height percentage (10–80%).
  // Top section now holds the model cards + the operations list, so give it a
  // bit under half by default. Key bumped to .v2 so a stale tiny value from the
  // previous layout can't collapse the top section to a sliver.
  const [splitPct, setSplitPct] = usePersistentState<number>('karmyogi.carve.split.v2', 44)
  // V-carve knobs (V-bit angle/tip + max depth + optional flat-bit cleanup),
  // persisted so the operator's V-carve setup survives reloads.
  const [vcarveRaw, setVcarve] = usePersistentState<VCarveUiParams>(
    'karmyogi.carve.vcarve',
    DEFAULT_VCARVE,
  )
  const vcarve = useMemo(() => parseVcarve(vcarveRaw, DEFAULT_VCARVE), [vcarveRaw])

  // C7 + C12 · cut-strategy (lead-in/out, ramp/helix plunge, climb direction,
  // stock-to-leave). Persisted so the operator's strategy survives reloads.
  const [strategyRaw, setStrategy] = usePersistentState<CutStrategyParams>(
    'karmyogi.carve.strategy',
    DEFAULT_STRATEGY,
  )
  const strategy = useMemo(() => parseStrategy(strategyRaw, DEFAULT_STRATEGY), [strategyRaw])

  /** Last V-carve generation stats (path/segment count) for the status line. */
  const [vcarveStats, setVcarveStats] = useState<{
    paths: number
    segs: number
    maxDepth: number
    cleanupNeeded: boolean
  } | null>(null)

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

  // ---- carve presets: snapshot ⇄ restore the bottom-section params ---------
  // Snapshot EVERY bottom-section cutting param (NOT the per-file placement) into
  // a serializable CarvePreset — the same pattern Soldering/Writing use.
  const capturePreset = (): CarvePreset => ({
    op,
    side,
    bitId,
    bitLength,
    materialId: stock.materialId,
    diameter: p2d.diameter,
    cutDepth: p2d.cutDepth,
    stepdown: p2d.stepdown,
    stepover: p2d.stepover,
    surfaceZ: p2d.surfaceZ,
    safeZ: p2d.safeZ,
    zMode: p2d.zMode,
    spindleRPM: p2d.spindleRPM,
    penUpZ: p2d.penUpZ,
    penDownZ: p2d.penDownZ,
    feedXY: p2d.feedXY,
    feedZ: p2d.feedZ,
    decimals: p2d.decimals,
    lineNumbers: p2d.lineNumbers,
    vcarve: { ...vcarve },
  })
  // Restore a captured preset into the live bottom-section state. Bit / material
  // are restored only when they still resolve to a real library entry (a stale id
  // is ignored, keeping the current choice). Placement (offset/scale) is left
  // untouched — it's per-file, not part of a preset.
  const applyPreset = (p: CarvePreset) => {
    // The bottom-section op selector only offers the whole-file ops; the per-loop
    // 'Cutout' kind has no whole-file equivalent, so it maps to Profile here (its
    // real Cutout intent lives on the placed loop op, snapshotted at add time).
    setOp(p.op === 'VCarve' ? 'VCarve' : p.op === 'Cutout' ? 'Profile' : p.op)
    setSide(p.side)
    if (getBit(p.bitId)) setBitId(p.bitId)
    setBitLength(p.bitLength >= 1 ? p.bitLength : 1)
    if (getMaterial(p.materialId)) stock.setMaterial(p.materialId)
    setP2d((prev) => ({
      ...prev,
      diameter: p.diameter,
      cutDepth: p.cutDepth,
      stepdown: p.stepdown,
      stepover: p.stepover,
      surfaceZ: p.surfaceZ,
      safeZ: p.safeZ,
      zMode: p.zMode,
      spindleRPM: p.spindleRPM,
      penUpZ: p.penUpZ,
      penDownZ: p.penDownZ,
      feedXY: p.feedXY,
      feedZ: p.feedZ,
      decimals: p.decimals,
      lineNumbers: p.lineNumbers,
    }))
    setVcarve(() => ({ ...p.vcarve }))
  }
  const presets = usePresets<CarvePreset>({
    storageKey: CARVE_PRESETS_KEY,
    capture: capturePreset,
    onApply: applyPreset,
  })

  // ---- 3D carve presets — full snapshot of the 3D relief-carving params ----
  // Captured from the carve-jobs GLOBAL (tool/RPM/plunge) + the selected job (or
  // the new-job defaults when no job is selected) for the per-job cut params.
  // Applying writes GLOBAL + the new-job defaults + every existing job, so the
  // combined carve regenerates with the preset — i.e. the 3D set is WIRED into
  // generation (not just UI-stored).
  const capture3DPreset = (): Carve3DPreset => {
    const j = selectedJob
    return {
      toolDiameter: carveGlobal.toolDiameter,
      toolType: carveGlobal.toolType,
      spindleRPM: carveGlobal.spindleRPM,
      stepover: j ? j.stepover : carveGlobal.toolDiameter * 0.16,
      roughStepover: Math.max(j ? j.stepover : 0.5, carveGlobal.toolDiameter * 0.45),
      stepdown: j ? j.speeds.cutDepthMm : 1.0,
      maxDepth: j ? j.maxDepth : 10,
      cutSpeedMmS: j ? j.speeds.cutSpeedMmS : 10,
      freeSpeedMmS: j ? j.speeds.freeSpeedMmS : 20,
      feedZ: carveGlobal.feedZ,
      doRoughing: j ? j.roughing : true,
      doFinishing: j ? j.finishing : true,
      finishDir: j ? j.finishDir : 'x',
      finishPattern: 'serpentine',
      cutout: cutout.enabled,
    }
  }
  /** Pick the bit whose type matches + diameter is nearest to the preset's tool. */
  const applyToolFromPreset = (diameter: number, type: ToolType) => {
    // Map the carver's flat/ball onto a library bit type, then nearest size.
    const libType: BitType = type === 'ball' ? 'ball' : 'flat'
    const candidates = bitsOfType(libType)
    if (candidates.length) {
      let best = candidates[0]
      for (const b of candidates)
        if (Math.abs(b.diameter - diameter) < Math.abs(best.diameter - diameter)) best = b
      setBitId(best.id)
    } else {
      // No matching library bit — still drive the carver tool directly.
      setGlobal({ toolDiameter: diameter, toolType: type })
    }
  }
  const apply3DPreset = (p: Carve3DPreset) => {
    applyToolFromPreset(p.toolDiameter, p.toolType)
    setGlobal({ spindleRPM: p.spindleRPM, feedZ: p.feedZ })
    // Flip the part-separation cutout pass on when the preset enables it (the
    // "Cutout" preset) so generate3D emits the part-free cut with tabs. Other
    // presets leave whatever the user has configured.
    if (p.cutout && !cutout.enabled) setCutout((c) => ({ ...defaultCutoutParams(c), enabled: true }))
    const speeds = { cutSpeedMmS: p.cutSpeedMmS, freeSpeedMmS: p.freeSpeedMmS, cutDepthMm: p.stepdown }
    // New jobs inherit these; existing jobs are updated in place below.
    setDefaults({
      speeds,
      roughing: p.doRoughing,
      finishing: p.doFinishing,
      finishDir: p.finishDir,
      maxDepth: p.maxDepth,
      stepover: p.stepover,
    })
    for (const j of jobs) {
      updateJob(j.id, {
        roughing: p.doRoughing,
        finishing: p.doFinishing,
        finishDir: p.finishDir,
        maxDepth: p.maxDepth,
        stepover: p.stepover,
      })
      setJobSpeeds(j.id, speeds)
    }
  }
  const presets3d = usePresets<Carve3DPreset>({
    storageKey: CARVE_PRESETS_3D_KEY,
    capture: capture3DPreset,
    onApply: apply3DPreset,
  })

  // 2D / 3D preset SET switch. Which preset set the rail + save-bar drive. It
  // DEFAULTS to match the loaded mode (3D when a mesh job is loaded, else 2D) but
  // the user can flip it independently of the file family.
  const [presetMode, setPresetMode] = useState<'2d' | '3d'>(mode === '3d' ? '3d' : '2d')
  // Track the LAST file-driven mode so loading a new file family snaps the
  // switch to it (a flip the user made stays until the next load).
  const lastFileModeRef = useRef<Mode>(mode)
  useEffect(() => {
    if (mode === lastFileModeRef.current) return
    lastFileModeRef.current = mode
    if (mode === '3d') setPresetMode('3d')
    else if (mode === '2d') setPresetMode('2d')
    // 'none' / 'cdr' / 'step' leave the user's current choice alone.
  }, [mode])
  // The active preset set the rail + save-bar bind to (2D feature presets vs 3D).
  // The shared PresetRail / PresetSaveBar only read each slot's colour/name/fill
  // and call back by INDEX — they don't touch the preset payload shape — so the
  // two differently-typed sets project onto one index-driven view for the UI.
  const activePresets: {
    slots: PresetSlot<unknown>[]
    selected: number
    load: (i: number) => void
    save: (i: number) => void
    clear: (i: number) => void
    rename: (i: number, name: string) => void
    select: (i: number) => void
  } = presetMode === '3d' ? presets3d : presets

  // The loop→preset table + FeatureViewer pick from the FILLED preset slots. Map
  // each into the light per-loop op intent (a {@link FeaturePreset}): the slot's
  // colour + name become the op's identity, the preset's op/side/cut overrides
  // become the op's intent. V-carve has no per-loop equivalent → Engrave intent.
  const presetPalette = useMemo<FeaturePreset[]>(
    () =>
      presets.slots
        .map((s, i) =>
          s.preset
            ? ({
                id: `carve-${i}`,
                name: s.name || t('presets.slotN', 'Preset {n}', { n: i + 1 }),
                color: s.color,
                op: s.preset.op === 'VCarve' ? 'Engrave' : s.preset.op,
                side:
                  s.preset.op === 'Profile' || s.preset.op === 'Cutout'
                    ? s.preset.side
                    : undefined,
                cutDepth: s.preset.cutDepth,
                stepdown: s.preset.stepdown,
                stepover: s.preset.stepover,
                diameter: s.preset.diameter,
              } as FeaturePreset)
            : null,
        )
        .filter((p): p is FeaturePreset => p !== null),
    [presets.slots, t],
  )

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

  // ---- file import --------------------------------------------------------
  /**
   * Import ONE file. `renestAfter` lets a multi-file drop add every model first
   * and re-nest only once at the end (avoids N intermediate nests + N warnings).
   */
  /**
   * Center a freshly-imported 2D drawing on the bed by setting Offset X/Y.
   * DXF/EPS files carry their own (often corner-anchored) coordinates, which
   * otherwise drop the toolpath wherever the file's coordinates happen to sit.
   *
   * IMPORTANT — the bed CENTER is the WORK ORIGIN (0,0), not (bedW/2, bedD/2):
   * the viewer draws the bed grid centered on the origin (usable area
   * [-W/2..+W/2] × [-D/2..+D/2]) and the bed-fit check is relative to that. So
   * we solve for the offset that lands the drawing's bbox center on (0,0),
   * accounting for the current X/Y scale (placed center = min + halfExtent*scale
   * + offset). Centering on (bedW/2, bedD/2) put it in the +X+Y corner instead.
   * The user can still nudge Offset X/Y (or drag in the viewer) afterward.
   */
  function centerDrawingOnBed(polys: Polyline[]) {
    const b = new BBox()
    for (const pl of polys) for (const p of pl.points) b.expand(p)
    if (!b.isValid()) return
    const halfW = (b.max.x - b.min.x) / 2
    const halfH = (b.max.y - b.min.y) / 2
    const round2 = (n: number) => Math.round(n * 100) / 100
    setP2d((p) => {
      const sx = p.scaleX > 0 ? p.scaleX : 1
      const sy = p.scaleY > 0 ? p.scaleY : 1
      return {
        ...p,
        offsetX: round2(-(b.min.x + halfW * sx)),
        offsetY: round2(-(b.min.y + halfH * sy)),
      }
    })
  }

  async function loadFile(file: File, renestAfter = true) {
    setImportError(null)
    setWarnings([])
    // Best-effort: archive the imported file to the user's vault for admin
    // assist (no-op when unconfigured / signed out; never blocks the import).
    void uploadUserFile(file, 'carve-import')
    const kind = classify(file.name)

    // Unsupported file type picked (e.g. via "All files" in the picker, or a
    // stray drag-drop). Tell the user plainly which types work instead of
    // falling through to a confusing "couldn't parse" error.
    if (kind === 'none') {
      setImportStatus(null)
      setImportError(
        t(
          'cc.errUnsupported',
          '“{name}” isn’t a supported model file. Use a 2D vector (DXF, EPS/AI) or a 3D model (STL, OBJ, STEP).',
          { name: file.name },
        ),
      )
      return
    }
    setFileName(file.name)

    if (kind === 'cdr') {
      setMode('cdr')
      setFiles([])
      return
    }

    if (kind === '3d') {
      setMode('3d')
      setFiles([])
      // Immediate feedback the moment the file is picked: name + human size, so
      // even a slow read/parse never looks frozen. Mirror it to the Program tab.
      const sizeLabel = humanSize(file.size)
      const baseLabel = sizeLabel ? `${file.name} · ${sizeLabel}` : file.name
      setImportStatus({
        label: baseLabel,
        stage: t('cc.stageReading', 'Reading model…'),
        frac: 0,
      })
      setGeneratingStatus(
        t('cc.statusLoading', 'Loading {name}', { name: baseLabel }),
        0,
      )
      // STEP/STP need the heavy async WASM (OpenCascade) parse — show a spinner.
      const heavy = isHeavyMeshFile(file.name)
      if (heavy) setImporting(true)
      try {
        const mesh = await importMesh(file, (stage, fraction, loaded, total) => {
          if (stage === 'reading') {
            const pct = Math.round((fraction ?? 0) * 100)
            // Real byte readout ("2.1 / 4.6 MB") so the user sees how much of the
            // file has loaded and how much remains, not just a percent.
            const bytes =
              loaded != null && total != null ? `${humanSize(loaded)} / ${humanSize(total)}` : sizeLabel
            setImportStatus({
              label: baseLabel,
              stage: t('cc.stageReadingBytes', 'Reading {bytes} · {pct}%', { bytes, pct }),
              frac: fraction ?? 0,
            })
            setGeneratingStatus(
              t('cc.statusReadingBytes', 'Reading {name} · {bytes} ({pct}%)', {
                name: file.name,
                bytes,
                pct,
              }),
              fraction ?? 0,
            )
          } else {
            setImportStatus({
              label: baseLabel,
              stage: t('cc.stageParsing', 'Parsing model…'),
              frac: null,
            })
            setGeneratingStatus(t('cc.statusParsing', 'Parsing model…'), null)
          }
        })
        if (mesh.triangleCount === 0) {
          setImportStatus(null)
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
        setImportStatus(null)
        setImportError(
          t('cc.errMesh', 'Failed to import model: {msg}', {
            msg: err instanceof Error ? err.message : String(err),
          })
        )
      } finally {
        if (heavy) setImporting(false)
        // Do NOT clear the status here: on success the carve worker (generate3D)
        // takes over and the carve-progress effect KEEPS this same bar visible
        // (file name + size + "Generating toolpath… NN%") through the whole carve,
        // clearing it only when the carve finishes — so the file label never
        // vanishes mid-load. The error/no-triangle paths clear it explicitly.
      }
      return
    }

    // 2D family — DXF or EPS/AI. Each file is ADDED to the multi-file list (U8).
    setMode('2d')
    setGcode('')
    setLineCount(0)
    const text = await file.text()
    const id = newFileId()

    if (kind === 'dxf') {
      const res = importDxfString(text)
      if (!res.ok) {
        setImportError(res.error ?? t('cc.errDxf', 'Failed to parse DXF'))
        return
      }
      setFiles((fs) => [
        ...fs,
        { id, name: file.name, kind: 'dxf', drawing: res.drawing, polylines: null, warnings: res.warnings ?? [], sourceText: text },
      ])
      setExpandedFiles((m) => ({ ...m, [id]: true }))
      return
    }

    const res = parseEpsPaths(text)
    if (!res.ok) {
      setImportError(res.error ?? t('cc.errEps', 'Couldn’t parse this EPS/AI — export as DXF.'))
      return
    }
    setFiles((fs) => [
      ...fs,
      { id, name: file.name, kind: 'eps', drawing: null, polylines: res.polylines, warnings: res.warnings ?? [], sourceText: text },
    ])
    setExpandedFiles((m) => ({ ...m, [id]: true }))
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

  // ---- 2D: multi-file flatten + closed-loop bookkeeping (U8) --------------
  // Per-file RAW (as-imported) flattened geometry, in the file list's order.
  const rawByFile = useMemo<{ id: string; name: string; raw: Polyline[] }[]>(() => {
    if (mode !== '2d') return []
    return files.map((f) => ({
      id: f.id,
      name: f.name,
      raw: f.drawing ? f.drawing.flatten() : f.polylines ?? [],
    }))
  }, [mode, files])
  // Combined raw polylines across all files (for bbox / stats / centering).
  const rawPolylines = useMemo<Polyline[]>(
    () => rawByFile.flatMap((f) => f.raw),
    [rawByFile],
  )
  // Center the COMBINED 2D geometry on the bed whenever the set of files changes
  // (a new import re-centers the whole arrangement; manual Offset X/Y afterward
  // sticks because it doesn't change the file identity list).
  const filesIdKey = useMemo(() => files.map((f) => f.id).join(','), [files])
  useEffect(() => {
    if (mode !== '2d') return
    if (rawPolylines.length) centerDrawingOnBed(rawPolylines)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesIdKey])
  // Natural (unscaled) bounds — drives the Width/Height fields + scale-about-corner.
  const naturalBounds = useMemo(() => {
    const b = new BBox()
    for (const pl of rawPolylines) for (const p of pl.points) b.expand(p)
    return b.isValid() ? b : null
  }, [rawPolylines])
  // Place one file's raw polylines: scale about the COMBINED lower-left corner,
  // then translate by the offset (so all files keep their relative arrangement).
  const placePolys = useMemo(() => {
    const sx = p2d.scaleX > 0 ? p2d.scaleX : 1
    const sy = p2d.scaleY > 0 ? p2d.scaleY : 1
    const ox = p2d.offsetX || 0
    const oy = p2d.offsetY || 0
    const minx = naturalBounds ? naturalBounds.min.x : 0
    const miny = naturalBounds ? naturalBounds.min.y : 0
    const identity = sx === 1 && sy === 1 && ox === 0 && oy === 0
    return (raw: Polyline[]): Polyline[] => {
      if (identity) return raw
      return raw.map((pl) => {
        const c = pl.clone()
        for (const p of c.points) {
          p.x = (p.x - minx) * sx + minx + ox
          p.y = (p.y - miny) * sy + miny + oy
        }
        return c
      })
    }
  }, [naturalBounds, p2d.scaleX, p2d.scaleY, p2d.offsetX, p2d.offsetY])
  // Per-file PLACED geometry + derived features (one feature per loop).
  const fileGeos = useMemo<FileGeometry[]>(
    () => rawByFile.map((f) => ({ fileId: f.id, name: f.name, polylines: placePolys(f.raw) })),
    [rawByFile, placePolys],
  )
  const featuresByFile = useMemo<Record<string, DrawingFeature[]>>(() => {
    const out: Record<string, DrawingFeature[]> = {}
    for (const g of fileGeos) out[g.fileId] = deriveFeatures(g.polylines)
    return out
  }, [fileGeos])
  // Combined placed polylines (for stats + bed-fit + V-carve whole-file ops).
  const polylines = useMemo<Polyline[]>(
    () => fileGeos.flatMap((g) => g.polylines),
    [fileGeos],
  )
  const closedCount = useMemo(
    () => polylines.filter((p) => p.closed && p.points.length >= 3).length,
    [polylines]
  )
  // True once the user has assigned at least one per-feature op — switches the
  // 2D generator from the whole-file path to the per-feature compositor.
  const hasFeatureOps = useMemo(
    () =>
      Object.entries(featureOpMap).some(
        ([k, ops]) => parseSurfaceKey(k) === null && ops && ops.length > 0,
      ),
    [featureOpMap]
  )
  // Drop per-feature ops / selections that point at loops no longer present
  // (a file was removed, or its loop count shrank). Keys are `${fileId}#index`.
  // SURFACE keys (`${jobId}#s${regionId}`) are pruned by a SEPARATE effect keyed
  // on the 3D jobs/regions — they must survive a 2D-files change untouched.
  useEffect(() => {
    const valid = new Set<string>()
    for (const g of fileGeos)
      g.polylines.forEach((_, i) => valid.add(featureKey(g.fileId, i)))
    setFeatureOpMap((m) => {
      let changed = false
      const next: FeatureOpMap = {}
      for (const [k, ops] of Object.entries(m)) {
        // Preserve surface keys (pruned elsewhere) and any still-valid loop keys.
        if (parseSurfaceKey(k) !== null || valid.has(k)) next[k] = ops
        else changed = true
      }
      return changed ? next : m
    })
    setSelectedFeature((s) => (s && (parseSurfaceKey(s) !== null || valid.has(s)) ? s : null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesIdKey])

  // ---- flat operations list (U4) across ALL files+loops, in added order ---
  // Each list entry pairs an op with the loop (file + loop index + name) it
  // belongs to. The displayed ORDER is `featureOpOrder` (added sequence); the
  // COMPOSE order stays containment-aware (in the composer) so cuts stay safe.
  interface OpListEntry {
    op: FeatureOp
    fileId: string
    fileName: string
    loopIndex: number
    closed: boolean
  }
  const opList = useMemo<OpListEntry[]>(() => {
    const fileById = new Map(fileGeos.map((g) => [g.fileId, g]))
    const byId = new Map<string, OpListEntry>()
    for (const [key, ops] of Object.entries(featureOpMap)) {
      // Skip 3D surface keys — they're listed in the separate Surface ops list.
      if (parseSurfaceKey(key) !== null) continue
      const { fileId, loopIndex } = parseFeatureKey(key)
      const g = fileById.get(fileId)
      const pl = g?.polylines[loopIndex]
      const closed = !!(pl && pl.closed && pl.points.length >= 3)
      for (const o of ops ?? [])
        byId.set(o.id, { op: o, fileId, fileName: g?.name ?? '', loopIndex, closed })
    }
    const out: OpListEntry[] = []
    for (const id of featureOpOrder) {
      const e = byId.get(id)
      if (e) {
        out.push(e)
        byId.delete(id)
      }
    }
    for (const e of byId.values()) out.push(e)
    return out
  }, [featureOpMap, featureOpOrder, fileGeos])

  // ── 3D SURFACE segmentation (auto flat/planar regions) ────────────────────
  // For each ENABLED 3D job, segment its mesh into connected near-coplanar face
  // regions so the user can stack a per-surface preset (mirroring 2D loop ops).
  // Cached by job id + mesh identity so it only recomputes when the mesh changes.
  // Segmentation is allocation-bounded (decimates a too-dense mesh) so it never
  // hangs the UI; see core/meshSegment.ts.
  const surfaceCacheRef = useRef<Map<string, { mesh: StlMesh; regions: SurfaceRegion[] }>>(new Map())
  const surfaceRegionsByJob = useMemo<Record<string, SurfaceRegion[]>>(() => {
    if (mode !== '3d') return {}
    const out: Record<string, SurfaceRegion[]> = {}
    for (const job of jobs) {
      const cached = surfaceCacheRef.current.get(job.id)
      if (cached && cached.mesh === job.mesh) {
        out[job.id] = cached.regions
        continue
      }
      const regions = segmentSurfaces(job.mesh)
      surfaceCacheRef.current.set(job.id, { mesh: job.mesh, regions })
      out[job.id] = regions
    }
    // Drop cache entries for removed jobs.
    for (const id of Array.from(surfaceCacheRef.current.keys()))
      if (!jobs.some((j) => j.id === id)) surfaceCacheRef.current.delete(id)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, jobs])

  // Prune SURFACE ops / selection for jobs or regions that no longer exist (a job
  // removed, or its mesh re-segmented into fewer regions). Surface keys are
  // `${jobId}#s${regionId}`.
  useEffect(() => {
    if (mode !== '3d') return
    const valid = new Set<string>()
    for (const [jobId, regions] of Object.entries(surfaceRegionsByJob))
      for (const r of regions) valid.add(surfaceKey(jobId, r.id))
    setFeatureOpMap((m) => {
      let changed = false
      const next: FeatureOpMap = {}
      for (const [k, ops] of Object.entries(m)) {
        if (parseSurfaceKey(k) === null || valid.has(k)) next[k] = ops
        else changed = true
      }
      return changed ? next : m
    })
    setSelectedFeature((s) => (s && parseSurfaceKey(s) !== null && !valid.has(s) ? null : s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, surfaceRegionsByJob])

  // The per-SURFACE preset palette. 3D surface presets reuse the shared built-in
  // 2D-op presets (Clear-out/Pocket/Profile/Engrave/Cutout) — a surface op runs
  // the SAME 2D CAM on the surface's XY outline, so the same intents apply.
  const surfacePalette = useMemo<FeaturePreset[]>(
    () =>
      BUILTIN_PRESETS.filter((p) =>
        ['clearout', 'pocket', 'engrave', 'profile-out', 'profile-in', 'cutout'].includes(p.id),
      ),
    [],
  )

  // Flat list of SURFACE ops (one row per stacked op across all jobs' surfaces),
  // in added order — the 3D analogue of `opList`. Keyed by `${jobId}#s${regionId}`.
  interface SurfaceOpEntry {
    op: FeatureOp
    jobId: string
    jobName: string
    regionId: number
    region: SurfaceRegion | null
  }
  const surfaceOpList = useMemo<SurfaceOpEntry[]>(() => {
    const jobById = new Map(jobs.map((j) => [j.id, j]))
    const byId = new Map<string, SurfaceOpEntry>()
    for (const [key, ops] of Object.entries(featureOpMap)) {
      const parsed = parseSurfaceKey(key)
      if (!parsed) continue
      const job = jobById.get(parsed.fileId)
      const region = (surfaceRegionsByJob[parsed.fileId] ?? []).find((r) => r.id === parsed.regionId) ?? null
      for (const o of ops ?? [])
        byId.set(o.id, {
          op: o,
          jobId: parsed.fileId,
          jobName: job?.name ?? '',
          regionId: parsed.regionId,
          region,
        })
    }
    const out: SurfaceOpEntry[] = []
    for (const id of featureOpOrder) {
      const e = byId.get(id)
      if (e) {
        out.push(e)
        byId.delete(id)
      }
    }
    for (const e of byId.values()) out.push(e)
    return out
  }, [featureOpMap, featureOpOrder, jobs, surfaceRegionsByJob])

  const hasSurfaceOps = surfaceOpList.length > 0

  /** Add an operation (from a preset) onto a loop, appending to the added-order list. */
  function addLoopOp(key: string, preset: FeaturePreset) {
    const fresh = opFromPreset(preset)
    // Idempotent against a double-invoked updater (React StrictMode): only append
    // `fresh` if its id isn't already present (else the same op id would render
    // twice → duplicate React keys + a doubled op).
    setFeatureOpMap((m) => {
      const cur = m[key] ?? []
      if (cur.some((o) => o.id === fresh.id)) return m
      return { ...m, [key]: [...cur, fresh] }
    })
    setFeatureOpOrder((o) => (o.includes(fresh.id) ? o : [...o, fresh.id]))
  }

  /** Remove a single operation by id from whichever loop holds it. */
  function removeLoopOp(opId: string) {
    setFeatureOpMap((m) => {
      const next: FeatureOpMap = {}
      for (const [key, ops] of Object.entries(m)) {
        const kept = (ops ?? []).filter((o) => o.id !== opId)
        if (kept.length) next[key] = kept
      }
      return next
    })
    setFeatureOpOrder((o) => o.filter((id) => id !== opId))
  }

  /** Reorder the flat operations list by moving one op earlier/later. */
  function moveLoopOp(opId: string, dir: -1 | 1) {
    setFeatureOpOrder((o) => {
      const idx = o.indexOf(opId)
      const j = idx + dir
      if (idx < 0 || j < 0 || j >= o.length) return o
      const next = o.slice()
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  /**
   * Reorder the visible ops list into a SAFE machining order, reusing
   * {@link orderOpsSafe} (containment-aware inside-out via orderLoopsInsideOut,
   * with any Cutout op forced to the very end). After this the visible list
   * matches the order the generator already emits in. A no-op when <2 ops.
   */
  function optimizeOps() {
    const fileById = new Map(fileGeos.map((g) => [g.fileId, g]))
    const orderable: OrderableOp[] = []
    opList.forEach((entry, seq) => {
      const poly = fileById.get(entry.fileId)?.polylines[entry.loopIndex]
      if (!poly) return
      orderable.push({ opId: entry.op.id, poly, op: entry.op.op, seq })
    })
    if (orderable.length < 2) return
    setFeatureOpOrder(orderOpsSafe(orderable))
  }

  /**
   * Optimize the SURFACE ops order (3D): order each planar region's ops by its
   * outline containment (inner surfaces first, cutout last) via the same
   * {@link orderOpsSafe}. Non-planar regions carry no outline → appended after.
   */
  function optimizeSurfaceOps() {
    const orderable: OrderableOp[] = []
    surfaceOpList.forEach((entry, seq) => {
      const job = jobs.find((j) => j.id === entry.jobId)
      if (!job || !entry.region) return
      const outline = entry.region.planar ? regionOutlineXY(job.mesh, entry.region) : []
      const poly = outline[0] ?? new Polyline()
      orderable.push({ opId: entry.op.id, poly, op: entry.op.op, seq })
    })
    if (orderable.length < 2) return
    setFeatureOpOrder(orderOpsSafe(orderable))
  }

  /** Clear EVERY per-loop operation (back to the whole-file fallback). */
  function clearAllLoopOps() {
    setFeatureOpMap({})
    setFeatureOpOrder([])
  }

  /** Toggle a model card's expanded (preview-visible) state. */
  function toggleFileExpanded(id: string) {
    setExpandedFiles((m) => ({ ...m, [id]: !(m[id] ?? false) }))
  }

  /**
   * Duplicate one uploaded 2D file (DXF/EPS/AI). The clone gets a FRESH id (so
   * its loops key into the shared FeatureOpMap independently — it does NOT share
   * the original's ops) and a "(copy)" suffix on its name, mirroring the 3D
   * "Duplicate this job" affordance. The user can then assign different
   * operations to the copy than the original drawing.
   */
  function duplicateFile(id: string) {
    const newId = newFileId()
    setFiles((fs) => {
      const idx = fs.findIndex((f) => f.id === id)
      if (idx < 0) return fs
      const src = fs[idx]
      const copy: LoadedFile = {
        // Re-parsing isn't needed: a Drawing/polyline set is immutable here (the
        // panel only ever reads it), so we share the parsed geometry reference.
        // Placement/scale is panel-global (p2d), and ops are keyed by the NEW id,
        // so the clone is fully independent for op assignment (it does NOT share
        // the original's per-loop ops).
        id: newId,
        name: src.name.replace(/\s*\(copy( \d+)?\)$/i, '') + ' (copy)',
        kind: src.kind,
        drawing: src.drawing,
        polylines: src.polylines,
        warnings: src.warnings.slice(),
        sourceText: src.sourceText,
      }
      const next = fs.slice()
      next.splice(idx + 1, 0, copy)
      return next
    })
    // Expand the new card so the user sees it (mirrors a fresh import).
    setExpandedFiles((m) => ({ ...m, [newId]: true }))
  }

  /** Remove one uploaded 2D file (and its loops' ops). */
  function removeFile(id: string) {
    setFiles((fs) => {
      const next = fs.filter((f) => f.id !== id)
      // Last file gone → drop back to the import screen.
      if (next.length === 0) {
        setMode('none')
        setFileName(null)
        setGcode('')
        setWarnings([])
      }
      return next
    })
    // The geometry-change effect prunes this file's ops/selection by key.
  }

  // Keep the persisted `fileName` summary in sync with the 2D file list (used for
  // the program name + the mode-restore on remount). 0 files → null; 1 → its
  // name; N → "N files".
  useEffect(() => {
    if (mode !== '2d') return
    const name =
      files.length === 0
        ? null
        : files.length === 1
          ? files[0].name
          : t('cc.nFiles', '{n} files', { n: files.length })
    setFileName(name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, mode])

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
    return {
      tool: build2DTool(),
      safeZ: p2d.safeZ,
      surfaceZ: p2d.surfaceZ,
      cutDepth: p2d.cutDepth,
      // C12 · finishing allowance left on the wall (mm).
      stockToLeave: Math.max(0, strategy.stockToLeaveMm),
    }
  }

  /** C7 · the lead-in/out + ramp/helix options derived from the strategy state. */
  function leadRampOpts(): LeadRampOptions {
    return {
      lead: strategy.lead,
      leadLengthMm: Math.max(0, strategy.leadLengthMm),
      plunge: strategy.plunge,
      rampAngleDeg: strategy.rampAngleDeg,
      helixRadiusMm: strategy.helixRadiusMm,
      safeZ: p2d.safeZ,
    }
  }

  /**
   * Post-process a freshly-built 2D toolpath with the cut strategy: rewrite
   * straight plunges into ramps/helixes and add leads (C7). Direction control
   * (C12) is applied at the geometry level in build2DToolpathsForFile before the
   * op runs, so it's not repeated here. Returns the toolpath unchanged when the
   * strategy is the default (no lead, plain plunge). Pen/laser jobs (no spindle)
   * skip ramping — a pen has no "plunge into material" to ease.
   */
  function applyStrategyPost(tp: Toolpath): Toolpath {
    if (p2d.zMode !== ZMode.Spindle) return tp
    const needsPost = strategy.lead !== 'none' || strategy.plunge !== 'plunge'
    if (!needsPost) return tp
    return applyLeadRamp(tp, leadRampOpts())
  }
  /**
   * Build the 2D toolpaths PLUS the per-operation breakdown (R11/R12 contract)
   * for ONE file's placed polylines. `operations` is the ComposedOperation list
   * when per-feature ops are active (each carries its own toolpath + preset
   * color + loop label) and EMPTY in the whole-file fallback (single Operation
   * over this file — today's behavior, now scoped per file so each loaded file
   * emits its OWN program section).
   *
   * U-PER-FILE: this is the per-file builder; the per-feature path composes via
   * {@link composeMultiFileToolpaths} on a SINGLE-file list so each file keeps
   * its own containment-aware inside-out ordering + cutout-last guarantee, and
   * the whole-file ops (Engrave/Profile/Pocket/VCarve) run over THIS file only.
   */
  function build2DToolpathsForFile(file: FileGeometry, p: CamParams): {
    toolpaths: Toolpath[]
    operations: ReturnType<typeof composeMultiFileToolpaths>['operations']
    vcarveStats?: { paths: number; segs: number; maxDepth: number; cleanupNeeded: boolean }
    warnings?: string[]
  } {
    const polys = file.polylines
    if (polys.length === 0) return { toolpaths: [], operations: [] }
    // PER-FEATURE mode: when the user has stacked any per-feature operation in
    // the mini viewer, the chosen-per-feature presets (each possibly several
    // passes) replace the single whole-file Operation. Compose this file's ops
    // (containment-ordered, cutout-last) via the multi-file composer fed a
    // one-file list so it shares the exact same ordering guarantees.
    if (hasFeatureOps) {
      const res = composeMultiFileToolpaths([file], featureOpMap, build2DTool(), p)
      return { toolpaths: res.toolpaths, operations: res.operations }
    }
    if (op === 'Engrave') return { toolpaths: [engrave(polys, p)], operations: [] }
    const closed = polys.filter((pl) => pl.closed && pl.points.length >= 3)
    if (closed.length === 0) return { toolpaths: [], operations: [] }
    if (op === 'VCarve') {
      // Variable-depth groove from the medial axis of the closed contours.
      const vp: VCarveParams = {
        vBitAngleDeg: vcarve.vBitAngleDeg,
        vTipDiameterMm: vcarve.vTipDiameterMm,
        maxDepthMm: vcarve.maxDepthMm,
        surfaceZ: p2d.surfaceZ,
        safeZ: p2d.safeZ,
        stepdownMm: p2d.stepdown,
        feedXY: p2d.feedXY,
        feedZ: p2d.feedZ,
        cleanup: vcarve.cleanup,
        cleanupToolMm: vcarve.cleanupToolMm,
        cleanupStepoverFrac: vcarve.cleanupStepoverFrac,
      }
      const res = vCarveContours(closed, vp)
      return {
        toolpaths: res.toolpath.isEmpty() ? [] : [res.toolpath],
        operations: [],
        vcarveStats: {
          paths: res.pathCount,
          segs: res.segmentCount,
          maxDepth: res.maxReachedDepthMm,
          cleanupNeeded: res.cleanupNeeded,
        },
        warnings: res.warnings,
      }
    }
    if (op === 'Profile') {
      // Cut nested closed loops INNERMOST-FIRST: an inner cutout must be cut
      // before the outer loop that contains it, or freeing the outer loop lets
      // the still-uncut inner piece wander. profileContours builds the
      // containment tree and emits children before parents (travel-minimised
      // among siblings).
      // C12 · re-orient each loop to the requested climb/conventional direction
      // (inside profiles flip the winding↔direction relation vs outside).
      const isInside = side === ProfileSide.Inside
      const oriented =
        side === ProfileSide.On ? closed : closed.map((c) => orientLoop(c, strategy.direction, isInside))
      const tp = applyStrategyPost(profileContours(oriented, side, p))
      return { toolpaths: tp.isEmpty() ? [] : [tp], operations: [] }
    }
    // Pocket: clear each closed region, innermost-first for the same reason.
    // C12 · pocket walls run as an inside cut → orient for the chosen direction.
    const out: Toolpath[] = []
    for (const idx of orderLoopsInsideOut(closed)) {
      const oriented = orientLoop(closed[idx], strategy.direction, true)
      const tp = applyStrategyPost(pocket(oriented, p))
      if (!tp.isEmpty()) out.push(tp)
    }
    return { toolpaths: out, operations: [] }
  }

  // The SET of program section NAMES this panel last pushed for the 2D files.
  // PER-FILE sections (U-PER-FILE): each loaded file emits its OWN section named
  // "<file> — <op>". The name encodes the operation, so switching operation/side
  // (or removing a file) renames/drops sections; we track every name we pushed
  // and clear any that are no longer emitted, so stale sections never linger.
  const last2DNamesRef = useRef<Set<string>>(new Set())

  /** Drop EVERY previously-pushed 2D section (nothing to emit / left 2D mode). */
  function clear2DSection() {
    for (const n of last2DNamesRef.current) setProgram(n, '') // clear-on-empty removes it
    last2DNamesRef.current = new Set()
  }

  /** The op label suffix for a 2D section's name (per-feature / profile-side / plain). */
  function op2DLabel(): string {
    return hasFeatureOps
      ? t('cc.perFeature', 'Per-feature')
      : op === 'Profile'
        ? `${opLabelText(t, op)} ${profileSideLabel(t, side)}`
        : opLabelText(t, op)
  }

  function generate2D(): string {
    if (polylines.length === 0) {
      clear2DSection()
      setGcode('')
      setLineCount(0)
      return ''
    }
    const camParams = build2DCamParams()
    const opLabel = op2DLabel()
    // V-carving is a variable-Z milling operation — it cannot be plotted with a
    // pen (the depth IS the result), so it always emits in Spindle Z mode.
    // Per-feature mode never uses the V-carve op, so honor the chosen Z mode.
    const vCarveZMode = !hasFeatureOps && op === 'VCarve' ? ZMode.Spindle : p2d.zMode

    // Build + emit ONE section PER loaded file. Each file keeps its own
    // containment-aware inside-out ordering + cutout-last guarantee internally;
    // ACROSS files we push in the file list's order (stable). The combined
    // program is the Program tab's concatenation of these sections.
    const pushedNames = new Set<string>()
    const combined: string[] = []
    let totalCount = 0
    let lastVStats: typeof vcarveStats = null
    const vWarnings: string[] = []

    for (const file of fileGeos) {
      const { toolpaths, operations, vcarveStats: vs, warnings: ws } =
        build2DToolpathsForFile(file, camParams)
      if (vs) lastVStats = vs
      if (ws && ws.length) for (const w of ws) vWarnings.push(w)
      if (toolpaths.length === 0) continue
      const progName = `${file.name} — ${opLabel}`
      // Disambiguate duplicate file names (e.g. a file and its "(copy)" sharing
      // a name) so two sections never collide on one upsert key.
      let uniqueName = progName
      let n = 2
      while (pushedNames.has(uniqueName)) uniqueName = `${progName} (${n++})`
      const emitOpts = {
        programName: uniqueName,
        safeZ: p2d.safeZ,
        feedXY: p2d.feedXY,
        feedZ: p2d.feedZ,
        zMode: vCarveZMode,
        useSpindle: vCarveZMode === ZMode.Spindle,
        spindleRPM: p2d.spindleRPM,
        penUpZ: p2d.penUpZ,
        penDownZ: p2d.penDownZ,
        decimals: p2d.decimals,
        lineNumbers: p2d.lineNumbers,
      }
      const out = new GcodeEmitter(emitOpts).emitProgram(toolpaths)
      const count = out.split('\n').filter((l) => l.length > 0).length
      totalCount += count
      combined.push(out)
      // Per-OPERATION breakdown (R11/R12): when per-feature ops drove this file's
      // toolpath, emit each op's OWN safe gcode + preset color + loop label, so
      // the Program tab can expand the section per op and the Visualizer tints
      // each op by its preset color. Whole-file fallback emits no operations[].
      const programOps =
        operations.length > 0
          ? operations.map((co) => ({
              id: co.opId,
              label: co.label,
              gcode: new GcodeEmitter({ ...emitOpts, programName: co.label }).emitProgram(
                co.toolpath,
              ),
              color: co.color,
            }))
          : undefined
      setProgram(uniqueName, out, programOps ? { operations: programOps } : undefined)
      pushedNames.add(uniqueName)
    }

    // Surface VCarve stats (last file) + warnings (deduped across files).
    if (op === 'VCarve' && !hasFeatureOps) {
      setVcarveStats(lastVStats)
      if (vWarnings.length) setWarnings((w) => Array.from(new Set([...w, ...vWarnings])))
    }

    // Drop any section we pushed previously but no longer emit (op/side switch,
    // a removed file, a now-empty file) so stale sections never linger.
    for (const n of last2DNamesRef.current) {
      if (!pushedNames.has(n)) setProgram(n, '')
    }
    last2DNamesRef.current = pushedNames

    if (pushedNames.size === 0) {
      setGcode('')
      setLineCount(0)
      return ''
    }
    const out = combined.join('\n')
    setGcode(out)
    setLineCount(totalCount)
    return out
  }

  // ---- 3D: combined carve over ALL enabled jobs (in a Web Worker) ----------
  const [, setCarveStats] = useState<{
    jobs: number
    grids: number
  } | null>(null)
  // Carve progress 0..1 (null = not carving). Drives a small "carving…" bar so a
  // heavy relief no longer freezes the UI — the compute runs off-thread.
  const [carveProgress, setCarveProgress] = useState<number | null>(null)

  // Mirror "is this panel computing in the background?" to the shared program
  // store, so the Program panel can show a "Generating…" indicator. Covers a
  // heavy model import, the 3D carve worker, and the 2D regen (busy).
  useEffect(() => {
    // `importStatus !== null` covers the read/parse phase of a LIGHT mesh (STL/
    // OBJ) where `importing` (the STEP-only WASM spinner flag) stays false — so
    // the Program tab still shows the staged "Reading…/Parsing…" status.
    setGenerating(importing || busy || carveProgress !== null || importStatus !== null)
  }, [importing, busy, carveProgress, importStatus, setGenerating])

  // Keep the file-load status bar (name + size) VISIBLE through the carve, so the
  // user always sees WHICH model is processing and HOW FAR along it is — not a
  // size-less generic bar. The carve runs right after the mesh is added; mirror
  // its progress into the same status block, and clear it only once the carve
  // that actually ran has finished. (During read/parse, carveProgress is null but
  // `carveRan` is false, so this never disturbs the read/parse status.)
  const carveRan = useRef(false)
  useEffect(() => {
    if (carveProgress !== null) {
      carveRan.current = true
      const pct = Math.round(carveProgress * 100)
      setImportStatus((s) =>
        s ? { ...s, stage: t('cc.stageGenPct', 'Generating toolpath… {pct}%', { pct }), frac: carveProgress } : s,
      )
    } else if (carveRan.current && !importing) {
      carveRan.current = false
      setImportStatus(null)
    }
  }, [carveProgress, importing, t])
  // On unmount, clear the indicator so a closed panel can't leave it stuck on.
  useEffect(() => () => setGenerating(false), [setGenerating])

  // The active carve worker (null when idle), held in a ref so a replace/cancel
  // can terminate it without re-rendering. `carveJobIdRef` is a monotonic id so a
  // late `done` from a superseded request is ignored.
  const carveWorkerRef = useRef<Worker | null>(null)
  const carveJobIdRef = useRef(0)
  // The last program NAME this panel pushed to the store, so removing all jobs
  // (or the worker producing nothing) can remove the stale carve section(s).
  // PER-FILE (U-PER-FILE): each enabled job emits its OWN section ("<model> — 3D
  // Carving"), so this tracks the SET of names we last pushed and clears any that
  // are no longer emitted. Two-sided mode pushes one combined section instead.
  const lastCarveNamesRef = useRef<Set<string>>(new Set())

  function teardownCarveWorker() {
    if (carveWorkerRef.current) {
      carveWorkerRef.current.terminate()
      carveWorkerRef.current = null
    }
  }

  // Remove our previously-pushed carve section(s) from the shared program store
  // (called when there is nothing to carve, so a stale section can't linger).
  function clearCarveProgram() {
    for (const name of lastCarveNamesRef.current) setProgram(name, '')
    lastCarveNamesRef.current = new Set()
  }

  // The SET of per-surface program section names we last pushed (so we can clear
  // stale ones when a surface op is removed / a job toggled off).
  const lastSurfaceNamesRef = useRef<Set<string>>(new Set())

  /**
   * Generate per-SURFACE toolpaths for the enabled 3D jobs and push them as their
   * OWN program sections — additive on top of the whole-mesh relief carve.
   *
   * PLANAR (roughly horizontal, up-facing) regions: the surface's XY boundary
   * (regionOutlineXY) feeds the existing 2D CAM (Clear-out → pocket, Cutout →
   * cutout-with-tabs, Profile/Engrave likewise) at the region's top Z, referenced
   * to the MESH TOP (Z=0) so it shares the carve worker's Z convention. The
   * job's XY placement (dx/dy) is baked in so it aligns with the relief toolpath
   * and the Visualizer.
   *
   * NON-PLANAR (sloped/curved) regions: an XY-projected area op is meaningless, so
   * these are LEFT to the existing whole-mesh relief carve (which already covers
   * the entire model). Only Engrave (a centreline trace of the outline) is offered
   * for them; the Surfaces UI disables area ops on non-planar regions.
   *
   * Each op runs through composeFeatureToolpaths so it inherits the SAME
   * containment-aware ordering + cutout-last safety, and is emitted with the
   * `{id,label,gcode,color}` ProgramOperation contract (operation.id ===
   * FeatureOp.id) so the hover cross-highlight + per-op Visualizer tint work.
   */
  function generateSurfaceOps(activeJobs: CarveJob[]): void {
    const pushed = new Set<string>()
    if (hasSurfaceOps) {
      for (const job of activeJobs) {
        const regions = surfaceRegionsByJob[job.id] ?? []
        if (regions.length === 0) continue
        const zRef = job.mesh.bbox.max[2]
        // surfaceZ is baked per op via a tailored CamParams, so we group ops by
        // region and compose/emit each region's outline separately.
        const tool = defaultTool({
          diameter: carveGlobal.toolDiameter,
          stepdown: job.speeds.cutDepthMm,
          stepover: job.stepover,
          feedXY: job.speeds.cutSpeedMmS * 60,
          feedZ: carveGlobal.feedZ,
          spindleRPM: carveGlobal.spindleRPM,
        })
        const operations: { id: string; label: string; gcode: string; color: string }[] = []
        const allToolpaths: Toolpath[] = []
        for (const region of regions) {
          const ops = featureOpMap[surfaceKey(job.id, region.id)]
          if (!ops || ops.length === 0) continue
          // Planar regions get a real XY outline; non-planar fall back to relief
          // (skip area ops, keep only Engrave which traces a line).
          const outline = region.planar ? regionOutlineXY(job.mesh, region) : []
          const usable = outline.filter((pl) => pl.points.length >= 3)
          if (usable.length === 0) continue
          // Reference the surface top to the mesh top (Z=0), so it shares the carve
          // worker's convention and the result lands at the right depth.
          const surfaceZ = region.z - zRef
          const camP: CamParams = { tool, safeZ: carveGlobal.safeZ, surfaceZ, cutDepth: p2d.cutDepth }
          // Apply the region's ops to its OUTER boundary loop only (the outline is
          // sorted largest-first). One op → one ComposedOperation → one unique op
          // id, so the Program-tab per-op breakdown + hover ids stay 1:1 with the
          // surface ops list. (A flat region's holes are left to the relief path.)
          const outer = usable[0]
          const regionMap: FeatureOpMap = { '0': ops }
          const res = composeFeatureToolpaths([outer], regionMap, tool, camP)
          for (const co of res.operations) {
            // Bake the job placement (XY) so it aligns with the relief toolpath.
            const placed = placeToolpath(co.toolpath, job.placement, meshCenter(job.mesh))
            placed.name = `${job.name} · S${region.id + 1} · ${co.label}`
            allToolpaths.push(placed)
            const emit = new GcodeEmitter({
              programName: placed.name,
              safeZ: carveGlobal.safeZ,
              feedXY: job.speeds.cutSpeedMmS * 60,
              feedZ: carveGlobal.feedZ,
              zMode: ZMode.Spindle,
              useSpindle: true,
              spindleRPM: carveGlobal.spindleRPM,
            }).emitProgram(placed)
            operations.push({ id: co.opId, label: placed.name, gcode: emit, color: co.color })
          }
        }
        if (allToolpaths.length === 0) continue
        const sectionGcode = new GcodeEmitter({
          programName: `${job.name} — Surfaces`,
          safeZ: carveGlobal.safeZ,
          feedXY: job.speeds.cutSpeedMmS * 60,
          feedZ: carveGlobal.feedZ,
          zMode: ZMode.Spindle,
          useSpindle: true,
          spindleRPM: carveGlobal.spindleRPM,
        }).emitProgram(allToolpaths)
        const name = t('cc.progNameSurfaces', '{name} — Surfaces', { name: job.name })
        setProgram(name, sectionGcode, { operations })
        pushed.add(name)
      }
    }
    // Drop any per-surface section we pushed before but no longer emit.
    for (const n of lastSurfaceNamesRef.current) if (!pushed.has(n)) setProgram(n, '')
    lastSurfaceNamesRef.current = pushed
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
    setGeneratingStatus(t('cc.statusCarving', 'Generating toolpath… {pct}%', { pct: 0 }), 0)

    worker.onmessage = (e: MessageEvent<CarveWorkerOutbound>) => {
      const msg = e.data
      if (msg.jobId !== carveJobIdRef.current) return // a superseded request
      if (msg.type === 'progress') {
        const frac = msg.total > 0 ? msg.done / msg.total : 0
        setCarveProgress(frac)
        setGeneratingStatus(
          t('cc.statusCarving', 'Generating toolpath… {pct}%', { pct: Math.round(frac * 100) }),
          frac,
        )
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

        // PER-FILE (U-PER-FILE) — DEFAULT path (two-sided OFF): split the worker's
        // single combined program back into one safe standalone program PER JOB
        // and push each as its OWN program section named "<model> — 3D Carving".
        // The worker delimits each job's body with a `(<job name>)` comment; we
        // re-wrap each body in its own safe header/footer so every section is a
        // valid, independently-streamable safe program. Across files we keep the
        // job list order (which already encodes the safe nesting/placement).
        if (!twoSided.enabled) {
          const perJob = splitCarveProgramByJob(
            msg.gcode,
            active.map((j) => j.name),
            carveGlobal.safeZ,
            carveGlobal.spindleRPM,
          )
          const pushed = new Set<string>()
          if (perJob.length > 0) {
            for (const seg of perJob) {
              const progName = t('cc.progName3dOne', '{name} — 3D Carving', { name: seg.name })
              let uniqueName = progName
              let n = 2
              while (pushed.has(uniqueName)) uniqueName = `${progName} (${n++})`
              setProgram(uniqueName, seg.gcode)
              pushed.add(uniqueName)
            }
          } else {
            // Parser found no per-job markers (older/edge output) → fall back to a
            // single combined section so the program is never lost.
            const baseName =
              active.length === 1
                ? t('cc.progName3dOne', '{name} — 3D Carving', { name: active[0].name })
                : t('cc.progName3dMany', '{n} jobs — 3D Carving', { n: active.length })
            setProgram(baseName, msg.gcode)
            pushed.add(baseName)
          }
          for (const nm of lastCarveNamesRef.current) if (!pushed.has(nm)) setProgram(nm, '')
          lastCarveNamesRef.current = pushed
          setGcode(msg.gcode)
          setLineCount(msg.lineCount)
          return
        }

        // ADVANCED · double-sided: post-process the front program into a combined
        // front+back program (pure core transform) — emitted as ONE section (the
        // flip instructions stitch the two sides into one program, so it can't be
        // split per job).
        const baseName =
          active.length === 1
            ? t('cc.progName3dOne', '{name} — 3D Carving', { name: active[0].name })
            : t('cc.progName3dMany', '{n} jobs — 3D Carving', { n: active.length })
        const twoSidedRes = buildTwoSidedProgram(msg.gcode, twoSided)
        const finalGcode = twoSidedRes.gcode
        if (twoSidedRes.warnings.length) setWarnings((w) => [...w, ...twoSidedRes.warnings])
        const name = `${baseName} (two-sided)`
        // Remove any previously-pushed carve section(s) not equal to this one.
        for (const nm of lastCarveNamesRef.current) if (nm !== name) setProgram(nm, '')
        lastCarveNamesRef.current = new Set([name])
        const lineCount = finalGcode.split('\n').filter((l) => l.length > 0).length
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
      // NOTE: per-SURFACE ops are intentionally NOT in this key — they regenerate
      // in their OWN lightweight effect (generateSurfaceOps), so editing a surface
      // preset never re-spins the heavy async relief-carve worker.
      return `3d|${carveRev}|${c}|${ts}`
    }
    if (mode === '2d') {
      const v = op === 'VCarve' ? `|${JSON.stringify(vcarve)}` : ''
      // The per-feature op map is part of the signature so stacking/removing a
      // feature pass live-regenerates the program just like a slider drag. The
      // added-order list is folded in too so REORDERING ops re-emits the section
      // metadata in the new order (the Program tab + Visualizer follow it).
      const f = `|${JSON.stringify(featureOpMap)}|${featureOpOrder.join(',')}`
      return `2d|${op}|${side}|${JSON.stringify(p2d)}${v}${f}`
    }
    return mode
    // polylines/drawing/epsPolys identity is folded in via the separate dep below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, carveRev, cutout, twoSided, op, side, p2d, vcarve, featureOpMap, featureOpOrder])

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

  // SURFACE ops (3D): a SEPARATE, lightweight live-regenerate. Editing a surface
  // preset only re-runs the synchronous per-surface CAM + program-section push —
  // it never re-spins the heavy async relief-carve worker (which is keyed on
  // `genKey` above, intentionally without surface state). Always-fresh handle so
  // the effect can depend on stable keys yet run the latest closure.
  const generateSurfaceOpsRef = useRef(generateSurfaceOps)
  generateSurfaceOpsRef.current = generateSurfaceOps
  useEffect(() => {
    if (mode !== '3d') return
    if (panelRef.current && panelRef.current.offsetParent === null) return // hidden tab
    generateSurfaceOpsRef.current(jobs.filter((j) => j.enabled))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, featureOpMap, featureOpOrder, surfaceRegionsByJob, carveRev])

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

  // Delete the SELECTED model/job (and its toolpath) with the Delete key — the
  // keyboard equivalent of the job's trash button. Scoped so it never fires
  // while typing in a field, when another handler already consumed the key (e.g.
  // the viewer deleting a selected shape/segment), or when this panel is hidden.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' || e.defaultPrevented) return
      const tgt = e.target as HTMLElement | null
      if (
        tgt &&
        (tgt.tagName === 'INPUT' ||
          tgt.tagName === 'TEXTAREA' ||
          tgt.tagName === 'SELECT' ||
          tgt.isContentEditable)
      )
        return
      if (!isPanelVisible()) return
      const id = useCarveJobs.getState().selectedId
      if (!id) return
      e.preventDefault()
      removeJob(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [removeJob])

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

  // ---- carving SESSION export / import (.karmyogi-carve.zip) --------------
  // A SESSION captures everything needed to reconstruct the panel after a reload
  // / power-cycle: every loaded source file's RAW bytes (DXF/EPS text, or a
  // binary STL for each 3D job) + a versioned manifest with all operations,
  // params, placement and presets. Download writes the zip; Upload restores it.
  const sessionFileRef = useRef<HTMLInputElement>(null)
  const [sessionError, setSessionError] = useState<string | null>(null)

  /** The WHOLE-session restore payload (everything not tied to a single file). */
  function captureSessionGlobals() {
    return {
      p2d,
      op,
      side,
      vcarve,
      strategy,
      cutout,
      twoSided,
      bitId,
      bitLength,
      materialId: stock.materialId,
      carveGlobal,
      carveDefaults: useCarveJobs.getState().defaults,
      featureOpMap,
      featureOpOrder,
      loopPresetSel,
      expandedFiles,
      presets2d: presets.slots,
      presets3d: presets3d.slots,
    }
  }

  function downloadCarveSession() {
    setSessionError(null)
    const entries: Array<{
      id: string
      name: string
      kind: 'dxf' | 'eps' | 'mesh'
      payload?: unknown
    }> = []
    const sources: CarveSessionSource[] = []

    if (mode === '2d') {
      for (const f of files) {
        entries.push({ id: f.id, name: f.name, kind: f.kind })
        if (f.sourceText != null)
          sources.push({ id: f.id, name: f.name, bytes: new TextEncoder().encode(f.sourceText) })
      }
    } else if (mode === '3d') {
      for (const j of jobs) {
        entries.push({
          id: j.id,
          name: `${j.name}.stl`,
          kind: 'mesh',
          payload: {
            name: j.name,
            enabled: j.enabled,
            material: j.material,
            stock: j.stock,
            speeds: j.speeds,
            placement: j.placement,
            roughing: j.roughing,
            finishing: j.finishing,
            finishDir: j.finishDir,
            maxDepth: j.maxDepth,
            stepover: j.stepover,
          },
        })
        // Re-derive a binary STL from the in-memory mesh (the original bytes
        // aren't retained; the parsed triangle soup round-trips faithfully).
        sources.push({
          id: j.id,
          name: `${j.name}.stl`,
          bytes: meshToBinaryStl(j.mesh.triangles, j.mesh.triangleCount),
        })
      }
    }

    if (entries.length === 0) {
      setSessionError(t('cc.sessionEmpty', 'Nothing to export — load a file first.'))
      return
    }
    try {
      const zip = buildCarveSessionZip({
        mode,
        entries,
        sources,
        globals: captureSessionGlobals(),
      })
      const base = (fileName ?? 'carve-session')
        .replace(/\.[^.]+$/, '')
        .replace(/[^\w.-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'carve-session'
      // Copy into a fresh ArrayBuffer so the Blob owns its bytes (avoids a
      // SharedArrayBuffer / detached-buffer edge under some bundlers).
      const blob = new Blob([zip.slice()], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${base}.${CARVE_SESSION_EXT}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 0)
    } catch (err) {
      setSessionError(
        t('cc.sessionExportFail', 'Could not build the session: {msg}', {
          msg: err instanceof Error ? err.message : String(err),
        }),
      )
    }
  }

  /** Restore EVERY whole-session global param from a manifest's `globals` blob. */
  function restoreSessionGlobals(g: Record<string, unknown> | undefined) {
    if (!isRecord(g)) return
    if (isRecord(g.p2d)) setP2d(parseP2d(g.p2d, DEFAULT_2D))
    if (g.op === 'Engrave' || g.op === 'Profile' || g.op === 'Pocket' || g.op === 'VCarve')
      setOp(g.op)
    if (
      g.side === ProfileSide.Inside ||
      g.side === ProfileSide.Outside ||
      g.side === ProfileSide.On
    )
      setSide(g.side as ProfileSide)
    setVcarve(parseVcarve(g.vcarve, DEFAULT_VCARVE))
    setStrategy(parseStrategy(g.strategy, DEFAULT_STRATEGY))
    setCutout(parseCutout(g.cutout, defaultCutoutParams()))
    setTwoSided(defaultTwoSidedParams(isRecord(g.twoSided) ? (g.twoSided as Partial<TwoSidedParams>) : undefined))
    if (typeof g.bitId === 'string' && getBit(g.bitId)) setBitId(g.bitId)
    if (typeof g.bitLength === 'number' && g.bitLength >= 1) setBitLength(g.bitLength)
    if (typeof g.materialId === 'string' && getMaterial(g.materialId)) stock.setMaterial(g.materialId)
    if (isRecord(g.carveGlobal)) setGlobal(g.carveGlobal as Partial<GlobalCarveSettings>)
    if (g.featureOpMap && isRecord(g.featureOpMap)) setFeatureOpMap(g.featureOpMap as FeatureOpMap)
    if (Array.isArray(g.featureOpOrder)) setFeatureOpOrder(g.featureOpOrder as string[])
    if (isRecord(g.loopPresetSel)) setLoopPresetSel(g.loopPresetSel as Record<string, string>)
    if (isRecord(g.expandedFiles)) setExpandedFiles(g.expandedFiles as Record<string, boolean>)
    // Presets persist to localStorage; write them so the rail reflects them on
    // its next (re)mount (usePresets re-reads localStorage on mount).
    try {
      if (Array.isArray(g.presets2d))
        localStorage.setItem(CARVE_PRESETS_KEY, JSON.stringify(g.presets2d))
      if (Array.isArray(g.presets3d))
        localStorage.setItem(CARVE_PRESETS_3D_KEY, JSON.stringify(g.presets3d))
    } catch {
      /* best-effort */
    }
  }

  async function uploadCarveSession(file: File) {
    setSessionError(null)
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { manifest, sources } = parseCarveSessionZip(bytes)

      if (manifest.mode === '3d') {
        // Rebuild the 3D jobs: clear, re-import each mesh, then patch its saved
        // settings + placement so the relief regenerates exactly as saved.
        clearJobs()
        teardownCarveWorker()
        clearCarveProgram()
        setFiles([])
        for (const entry of manifest.entries) {
          const src = sources.get(entry.id)
          if (!src) continue
          const meshFile = new File([src.slice()], entry.name, { type: 'model/stl' })
          let mesh
          try {
            mesh = await importMesh(meshFile)
          } catch {
            continue
          }
          if (mesh.triangleCount === 0) continue
          const p = isRecord(entry.payload) ? entry.payload : {}
          const niceName = typeof p.name === 'string' ? p.name : entry.name.replace(/\.stl$/i, '')
          const id = addJob(mesh, niceName)
          const patch: Partial<Omit<CarveJob, 'id' | 'mesh'>> = {}
          if (typeof p.enabled === 'boolean') patch.enabled = p.enabled
          if (typeof p.material === 'string') patch.material = p.material
          if (typeof p.roughing === 'boolean') patch.roughing = p.roughing
          if (typeof p.finishing === 'boolean') patch.finishing = p.finishing
          if (p.finishDir === 'x' || p.finishDir === 'y') patch.finishDir = p.finishDir
          if (typeof p.maxDepth === 'number') patch.maxDepth = p.maxDepth
          if (typeof p.stepover === 'number') patch.stepover = p.stepover
          if (Object.keys(patch).length) updateJob(id, patch)
          if (isRecord(p.speeds)) setJobSpeeds(id, p.speeds as Partial<CarveJob['speeds']>)
          if (isRecord(p.stock)) setJobStock(id, p.stock as Partial<CarveJob['stock']>)
          if (isRecord(p.placement)) setJobPlacement(id, p.placement)
        }
        restoreSessionGlobals(manifest.globals as Record<string, unknown> | undefined)
        setMode('3d')
        const res = renest(bed.width, bed.depth)
        setNestWarn(res.warnings)
      } else {
        // 2D: rebuild the file list (RE-USING the manifest's ids so the restored
        // featureOpMap keys — `${fileId}#loop` — still resolve to these files).
        clearJobs()
        const restored: LoadedFile[] = []
        const expand: Record<string, boolean> = {}
        for (const entry of manifest.entries) {
          const src = sources.get(entry.id)
          if (!src) continue
          const text = new TextDecoder().decode(src)
          if (entry.kind === 'dxf') {
            const res = importDxfString(text)
            if (!res.ok) continue
            restored.push({
              id: entry.id,
              name: entry.name,
              kind: 'dxf',
              drawing: res.drawing,
              polylines: null,
              warnings: res.warnings ?? [],
              sourceText: text,
            })
          } else if (entry.kind === 'eps') {
            const res = parseEpsPaths(text)
            if (!res.ok) continue
            restored.push({
              id: entry.id,
              name: entry.name,
              kind: 'eps',
              drawing: null,
              polylines: res.polylines,
              warnings: res.warnings ?? [],
              sourceText: text,
            })
          }
          expand[entry.id] = true
        }
        if (restored.length === 0) {
          setSessionError(t('cc.sessionNoFiles', 'No usable source files found in the session.'))
          return
        }
        // Restore globals FIRST (sets featureOpMap/order, which key by file id),
        // then the files. expandedFiles from globals is merged with the fresh set.
        restoreSessionGlobals(manifest.globals as Record<string, unknown> | undefined)
        setExpandedFiles((m) => ({ ...m, ...expand }))
        setFiles(restored)
        setMode('2d')
      }
    } catch (err) {
      const msg =
        err instanceof CarveSessionError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err)
      setSessionError(t('cc.sessionImportFail', 'Could not open the session: {msg}', { msg }))
    }
  }

  function onSessionFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) {
      if (!/\.zip$/i.test(file.name)) {
        // Wrong file for the Ops slot — point them at the .zip the Download
        // button makes, rather than failing inside the unzip with a cryptic error.
        setSessionError(
          t(
            'cc.sessionWrongType',
            '“{name}” isn’t a carving session. Upload the .zip you saved with the Download (Ops) button.',
            { name: file.name },
          ),
        )
      } else {
        void uploadCarveSession(file)
      }
    }
    e.target.value = ''
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

  // V-carve always mills in Spindle mode, so it never shows the pen-up/down fields.
  const isPen = p2d.zMode === ZMode.Pen && op !== 'VCarve'
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

  // ── Gamepad command bus: regenerate, frame, sim, and job navigation. ──
  // Generate re-runs the live toolpath build (idempotent — same as the auto
  // regen). Frame traces the combined program's XY bounds. Prev/Next/Delete walk
  // the carve-job list. All guarded; safe no-ops when there's nothing to act on.
  const cycleCarveJob = (dir: -1 | 1) => {
    if (jobs.length === 0) return
    const cur = jobs.findIndex((j) => j.id === selectedId)
    const start = cur < 0 ? (dir === 1 ? -1 : 0) : cur
    const next = jobs[(start + dir + jobs.length) % jobs.length]
    if (next) selectJob(next.id)
  }
  useTabCommands('cadcam', {
    generate: () => generateRef.current(),
    frame: () => {
      const lines = useProgram.getState().lines
      if (!grbl.isConnected || !lines.length) return
      const bounds = frameBoundsOfGcode(lines)
      if (!bounds || !bounds.isValid()) return
      for (const ln of buildFrameProgram(bounds, { safeZ: 5 })) void grbl.send(ln)
    },
    simPlayPause: () => {
      if (usePlayback.getState().timeline) usePlayback.getState().toggle()
    },
    prevJob: () => cycleCarveJob(-1),
    nextJob: () => cycleCarveJob(1),
    deleteJob: () => {
      if (selectedId) removeJob(selectedId)
    },
  })

  // ---- draggable horizontal separator between the two split sections (R6) --
  // Pointer-drag updates the persisted TOP-section height percentage; clamped so
  // both sections always keep a usable minimum. Pointer capture keeps the drag
  // tracking even if the cursor leaves the thin handle.
  const splitDragRef = useRef<{ startY: number; startPct: number } | null>(null)
  function onSplitPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const host = panelRef.current?.querySelector('.cc-split') as HTMLElement | null
    if (!host) return
    splitDragRef.current = { startY: e.clientY, startPct: splitPct }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    const total = host.getBoundingClientRect().height
    const onMove = (ev: PointerEvent) => {
      const st = splitDragRef.current
      if (!st || total <= 0) return
      const dPct = ((ev.clientY - st.startY) / total) * 100
      setSplitPct(Math.max(24, Math.min(80, st.startPct + dPct)))
    }
    const onUp = () => {
      splitDragRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // The whole-file vs per-loop "Operation" sections + the loop table are 2D-only.
  const is2D = mode === '2d'

  return (
    <div
      ref={panelRef}
      className={'cc-panel' + (dragOver ? ' cc-dragover' : '')}
      onDrop={onDrop}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
    >
      {/* Sticky LEFT colour-slot rail (2D only) — each slot is a full carve-param
          preset. Clicking a filled slot loads it into the bottom sections; the
          footer save-bar writes the current params back. Same shared components
          the Soldering / Writing tabs use. */}
      <div className="cc-split">
        {/* ───────────────────────── TOP: files + loop→preset table ─────── */}
        <div className="cc-split-top" style={{ height: `${Math.max(24, Math.min(80, splitPct))}%` }}>
        {/* The panel heading + its explainer InfoTip were removed; the same
            explainer now shows as a tooltip when hovering the "2D/3D Carving"
            dock TAB (see the dock tab component in shell.tsx). */}
        <div className="cc-cards">
          {/* ================= 1 · IMPORT / DROP ================= */}
          {/* ── PLAIN top row (NOT a card): a "Models" label + the Upload button
              + accepted file-types hint. The upload affordance is deliberately
              OUTSIDE any model card. 3D's re-nest / clear-all live here too. ── */}
          <div className="cc-modelbar">
            <span className="cc-modelbar-lbl">
              <Icon name="upload" size={14} />
              {mode === '3d' ? t('cc.models', 'Models') : t('cc.modelsLbl', 'Models')}
            </span>
            <span className="cc-modelbar-exts" title={t('cc.dropHintMulti', 'or drop a file anywhere — each model adds a job')}>
              .stl / .obj / .step / .dxf / .eps / .ai
            </span>
            <span className="cc-modelbar-actions">
              {mode === '3d' && (
                <>
                  <button
                    className="cc-iconbtn"
                    onClick={doRenest}
                    disabled={enabledJobs === 0}
                    title={
                      enabledJobs === 0
                        ? t('cc.renestDisabled', 'Add or enable a model first')
                        : t('cc.renest', 'Re-nest all jobs on the bed (no overlap)')
                    }
                    aria-label={t('cc.renest', 'Re-nest all jobs on the bed')}
                  >
                    <Icon name="frame" size={14} />
                  </button>
                  <button
                    className="cc-iconbtn danger"
                    onClick={clearAllJobs}
                    disabled={jobs.length === 0}
                    title={
                      jobs.length === 0
                        ? t('cc.clearAllDisabled', 'No models to clear')
                        : t('cc.clearAll', 'Clear all jobs / start over')
                    }
                    aria-label={t('cc.clearAll', 'Clear all jobs / start over')}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </>
              )}
              {/* SESSION export / import — pack every loaded source + all ops /
                  params / presets into one .karmyogi-carve.zip, and restore it.
                  Download appears once something is loaded; Upload is always
                  available so a fresh session can be restored from the zip. */}
              {(mode === '2d' || mode === '3d') && (
                <button
                  type="button"
                  className="cc-iconbtn"
                  onClick={downloadCarveSession}
                  disabled={mode === '2d' ? files.length === 0 : jobs.length === 0}
                  title={
                    (mode === '2d' ? files.length === 0 : jobs.length === 0)
                      ? t('cc.sessionDownloadDisabled', 'Load a model file first')
                      : t('cc.sessionDownload', 'Download this carving session (.zip) — sources + operations + presets')
                  }
                  aria-label={t('cc.sessionDownloadAria', 'Download carving session')}
                >
                  <Icon name="download" size={15} />
                </button>
              )}
              <button
                type="button"
                className="cc-iconbtn cc-iconbtn--labeled"
                onClick={() => sessionFileRef.current?.click()}
                title={t('cc.sessionUpload', 'Upload a saved operations session (.zip) — restores your files, operations, params & presets')}
                aria-label={t('cc.sessionUploadAria', 'Upload operations session (.zip)')}
              >
                <Icon name="upload" size={15} /> {t('cc.opsBtn', 'Ops')}
              </button>
              <button
                type="button"
                className="cc-uploadrow-btn cc-uploadrow-btn--labeled"
                onClick={() => fileRef.current?.click()}
                title={t('cc.uploadModel', 'Upload a model file — 2D vector (DXF, EPS/AI) or 3D model (STL, OBJ, STEP)')}
                aria-label={t('cc.uploadAria', 'Upload model file(s)')}
              >
                <Icon name="upload" size={16} /> {t('cc.modelBtn', 'Model')}
              </button>
            </span>
            <input
              ref={fileRef}
              className="cc-load-input"
              type="file"
              multiple
              accept=".stl,.obj,.step,.stp,.dxf,.eps,.ai,.cdr"
              onChange={onFileChange}
            />
            <input
              ref={sessionFileRef}
              className="cc-load-input"
              type="file"
              accept=".zip"
              onChange={onSessionFileChange}
            />
          </div>

          {/* 3D: the single canonical models list, in its own card (per-model
              visibility, select-to-edit, duplicate & remove). */}
          {mode === '3d' && jobs.length > 0 && (
            <section className="cc-section cc-span">
              <div className="cc-section-body">
                <ModelFilesList
                  jobs={jobs}
                  selectedId={selectedId}
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
                  t={t}
                />
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

          {/* 3D: per-surface preset assignment. Segment the SELECTED job's mesh
              into flat/planar regions; click a region to select, pick a preset
              per surface (mirrors the 2D loop table). Additive on top of the
              whole-model relief carve. */}
          {mode === '3d' && selectedJob && (surfaceRegionsByJob[selectedJob.id]?.length ?? 0) > 0 && (
            <section className="cc-section cc-span cc-surfcard">
              <h3>
                <Layers className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                {t('cc.surfaces', 'Surfaces')} · <span className="cc-jobcard-name">{selectedJob.name}</span>
              </h3>
              <div className="cc-section-body">
                <SurfaceViewer
                  fileId={selectedJob.id}
                  mesh={selectedJob.mesh}
                  regions={surfaceRegionsByJob[selectedJob.id] ?? []}
                  opMap={featureOpMap}
                  presets={surfacePalette}
                  onQuickAdd={addLoopOp}
                  selected={selectedFeature}
                  setSelected={setSelectedFeature}
                  t={t}
                />
                <table className="cc-looptable">
                  <thead>
                    <tr>
                      <th>{t('cc.surface', 'Surface')}</th>
                      <th>{t('cc.preset', 'Preset')}</th>
                      <th aria-label={t('cc.add', 'Add')} />
                    </tr>
                  </thead>
                  <tbody>
                    {(surfaceRegionsByJob[selectedJob.id] ?? []).map((region) => {
                      const key = surfaceKey(selectedJob.id, region.id)
                      const ops = featureOpMap[key]
                      const sel = surfacePalette.find((p) => p.id === (surfacePresetSel[key] ?? surfacePalette[0]?.id))
                        ?? surfacePalette[0]
                      const isSel = key === selectedFeature
                      return (
                        <tr
                          key={region.id}
                          className={isSel ? 'is-sel' : ''}
                          onClick={() => setSelectedFeature(isSel ? null : key)}
                        >
                          <td>
                            <span className="cc-loop-name">
                              {t('cc.surfaceN', 'Surface {n}', { n: region.id + 1 })}
                              {' · '}
                              {region.planar
                                ? t('cc.flatAtZ', 'flat @ Z{z}', { z: region.z.toFixed(1) })
                                : t('cc.slopedLbl', 'sloped')}
                            </span>
                            {ops && ops.length > 0 && (
                              <span className="cc-loop-count">{ops.length}</span>
                            )}
                          </td>
                          <td>
                            <select
                              value={surfacePresetSel[key] ?? surfacePalette[0]?.id ?? ''}
                              onChange={(e) =>
                                setSurfacePresetSel((m) => ({ ...m, [key]: e.target.value }))
                              }
                              onClick={(e) => e.stopPropagation()}
                            >
                              {surfacePalette.map((p) => {
                                const incompatible = p.op !== 'Engrave' && !region.planar
                                return (
                                  <option key={p.id} value={p.id} disabled={incompatible}>
                                    {p.name}
                                    {incompatible ? ` (${t('cc.needsFlat', 'needs flat')})` : ''}
                                  </option>
                                )
                              })}
                            </select>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="cc-loop-add"
                              disabled={!sel || (sel.op !== 'Engrave' && !region.planar)}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (sel) addLoopOp(key, sel)
                              }}
                              title={
                                sel && sel.op !== 'Engrave' && !region.planar
                                  ? t('cc.addOpNeedsFlat', 'This preset needs a flat surface')
                                  : t('cc.addOpToSurface', 'Add this preset to the surface')
                              }
                              aria-label={t('cc.addOpToSurface', 'Add this preset to the surface')}
                            >
                              <Plus size={15} strokeWidth={2.2} />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* 2D: ONE expandable CARD per uploaded file (U5/U6/U8/U9/U10). The
              card TITLE is the disclosure → expands to the preview + this file's
              loops→preset→+ table. Close ✕ sits in the card's upper-right. */}
          {mode === '2d' &&
            fileGeos.map((g) => (
              <ModelFileCard
                key={g.fileId}
                fileId={g.fileId}
                name={g.name}
                polylines={g.polylines}
                features={featuresByFile[g.fileId] ?? []}
                expanded={expandedFiles[g.fileId] ?? false}
                onToggle={() => toggleFileExpanded(g.fileId)}
                onDuplicate={() => duplicateFile(g.fileId)}
                onRemove={() => removeFile(g.fileId)}
                opMap={featureOpMap}
                presets={presetPalette}
                onQuickAdd={addLoopOp}
                loopPresetSel={loopPresetSel}
                setLoopPresetSel={setLoopPresetSel}
                selected={selectedFeature}
                setSelected={setSelectedFeature}
                t={t}
              />
            ))}

          {/* 3D multi-model empty-state + import status / errors / warnings. */}
          {mode === '3d' && jobs.length === 0 && (
            <CamEmpty
              icon={<Icon name="upload" size={22} />}
              title={t('cc.empty.title', 'No models yet')}
              hint={t('cc.empty.hint', 'Import a model to add a job — import again to nest more side-by-side.')}
              action={
                <button type="button" className="cam-primary" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={15} /> {t('cc.upload', 'Upload')}
                </button>
              }
            />
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
          {/* Failed file import → shared CamError with a Retry that re-opens the
              file picker (re-triggers the exact same pick flow). Replaces the old
              inline .cc-error text so a failed parse reads like every other CAM
              tab's error state. */}
          {importError && (
            <CamError
              title={t('cc.importFailed', 'Import failed')}
              message={importError}
              onRetry={() => {
                setImportError(null)
                fileRef.current?.click()
              }}
              retryLabel={t('cc.retryPick', 'Pick file again')}
            />
          )}
          {sessionError && (
            <CamError
              title={t('cc.sessionFailed', 'Session restore failed')}
              message={sessionError}
              onRetry={() => {
                setSessionError(null)
                sessionFileRef.current?.click()
              }}
              retryLabel={t('cc.retryPick', 'Pick file again')}
            />
          )}
          {/* Staged LOAD status: file name + size + reading/parsing stage. While
              READING we keep the rich determinate progress bar (real byte readout
              "2.1 / 4.6 MB"); for the indeterminate PARSING stage we surface the
              shared <CamBusy> (spinner + aria-busy) so the in-flight state reads
              identically to every other CAM tab. */}
          {importStatus &&
            (importStatus.frac === null ? (
              <CamBusy label={`${importStatus.label} · ${importStatus.stage}`} />
            ) : (
              <div className="cc-loadstatus" role="status" aria-busy="true" aria-live="polite">
                <div className="cc-loadstatus-row">
                  <span className="cc-loadstatus-name">{importStatus.label}</span>
                  <span className="cc-loadstatus-stage">{importStatus.stage}</span>
                </div>
                <div
                  className="cc-loadbar"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(importStatus.frac * 100)}
                >
                  <span
                    className="cc-loadbar-fill"
                    style={{ width: `${Math.round(importStatus.frac * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          {/* 3D carve progress — ONLY when there's no active file-load status (a
              standalone re-carve from a param/preset change). During a file load
              the importStatus bar above already shows the carve %, so this avoids
              rendering TWO progress bars at once. */}
          {carveProgress !== null && !importStatus && (
            <div className="cc-loadstatus" role="status" aria-live="polite">
              <div className="cc-loadstatus-row">
                <span className="cc-loadstatus-name">
                  {t('cc.stageCarving', 'Generating toolpath…')}
                </span>
                <span className="cc-loadstatus-stage">{Math.round(carveProgress * 100)}%</span>
              </div>
              <div
                className="cc-loadbar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(carveProgress * 100)}
              >
                <span className="cc-loadbar-fill" style={{ width: `${Math.round(carveProgress * 100)}%` }} />
              </div>
            </div>
          )}
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

          {/* ============ OPERATIONS LIST (R2/R4/U4) — every op across ALL loops
                & files in added order, with edit / reorder / delete. Lives in the
                TOP section (with the model cards), per request. ============ */}
          {is2D && hasFeatureOps && (
            <section className="cc-section cc-span">
              <h3>
                <Layers className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                {t('cc.operations', 'Operations')}
                <span className="cc-h3-actions">
                  <button
                    type="button"
                    className="cc-iconbtn cc-optimize"
                    onClick={optimizeOps}
                    disabled={opList.length < 2}
                    title={
                      opList.length < 2
                        ? t('cc.optimizeOpsDisabled', 'Add at least two operations to reorder')
                        : t('cc.optimizeOps', 'Reorder for safe machining (inner loops first, cutout last)')
                    }
                    aria-label={t('cc.optimizeOps', 'Optimize machining order')}
                  >
                    <Wand2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="cc-iconbtn danger"
                    onClick={clearAllLoopOps}
                    title={t('cc.clearOps', 'Clear all operations')}
                    aria-label={t('cc.clearOps', 'Clear all operations')}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </h3>
              <div className="cc-section-body">
                <ul className="cc-oplist">
                  {opList.map((entry, i) => (
                    <li
                      key={entry.op.id}
                      className={
                        'cc-oprow' +
                        (hoveredOpId === entry.op.id ? ' cc-oprow--hover' : '')
                      }
                      onMouseEnter={() => setHoveredOp(entry.op.id)}
                      onMouseLeave={() => setHoveredOp(null)}
                      onTouchStart={() => setHoveredOp(entry.op.id)}
                    >
                      <span className="cc-op-sw" style={{ background: entry.op.color }} />
                      <span className="cc-op-info">
                        <span className="cc-op-name">
                          {entry.op.label}
                          {entry.op.op === 'Profile' && entry.op.side ? ` · ${entry.op.side}` : ''}
                        </span>
                        <span className="cc-op-loop">
                          {files.length > 1 && entry.fileName ? `${entry.fileName} · ` : ''}
                          {loopLabel(entry.loopIndex, entry.closed)}
                        </span>
                      </span>
                      <span className="cc-op-actions">
                        <button
                          type="button"
                          className="cc-op-btn"
                          onClick={() => {
                            // Load this op's source preset into the bottom sections
                            // for tuning (presetId is `carve-<slotIndex>`).
                            const slot = Number(entry.op.presetId.replace(/^carve-/, ''))
                            if (Number.isInteger(slot)) presets.load(slot)
                            setSelectedFeature(featureKey(entry.fileId, entry.loopIndex))
                          }}
                          title={t('cc.editOp', 'Edit this operation’s preset below')}
                          aria-label={t('cc.editOp', 'Edit this operation’s preset')}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="cc-op-btn"
                          disabled={i === 0}
                          onClick={() => moveLoopOp(entry.op.id, -1)}
                          title={t('fv.up', 'Move earlier')}
                          aria-label={t('fv.up', 'Move earlier')}
                        >
                          <ChevronUp size={13} />
                        </button>
                        <button
                          type="button"
                          className="cc-op-btn"
                          disabled={i === opList.length - 1}
                          onClick={() => moveLoopOp(entry.op.id, 1)}
                          title={t('fv.down', 'Move later')}
                          aria-label={t('fv.down', 'Move later')}
                        >
                          <ChevronDown size={13} />
                        </button>
                        <button
                          type="button"
                          className="cc-op-btn danger"
                          onClick={() => removeLoopOp(entry.op.id)}
                          title={t('fv.remove', 'Remove this operation')}
                          aria-label={t('fv.remove', 'Remove this operation')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}

          {/* SURFACE OPERATIONS LIST (3D) — every per-surface op across all jobs
              in added order, with edit / reorder / delete. Mirrors the 2D ops
              list; cross-highlights via the same hover store + op ids. */}
          {mode === '3d' && hasSurfaceOps && (
            <section className="cc-section cc-span">
              <h3>
                <Layers className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                {t('cc.surfaceOps', 'Surface operations')}
                <span className="cc-h3-actions">
                  <button
                    type="button"
                    className="cc-iconbtn cc-optimize"
                    onClick={optimizeSurfaceOps}
                    disabled={surfaceOpList.length < 2}
                    title={
                      surfaceOpList.length < 2
                        ? t('cc.optimizeOpsDisabled', 'Add at least two operations to reorder')
                        : t('cc.optimizeOps', 'Reorder for safe machining (inner loops first, cutout last)')
                    }
                    aria-label={t('cc.optimizeOps', 'Optimize machining order')}
                  >
                    <Wand2 size={14} />
                  </button>
                  <button
                    type="button"
                    className="cc-iconbtn danger"
                    onClick={clearAllLoopOps}
                    title={t('cc.clearOps', 'Clear all operations')}
                    aria-label={t('cc.clearOps', 'Clear all operations')}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              </h3>
              <div className="cc-section-body">
                <ul className="cc-oplist">
                  {surfaceOpList.map((entry, i) => (
                    <li
                      key={entry.op.id}
                      className={'cc-oprow' + (hoveredOpId === entry.op.id ? ' cc-oprow--hover' : '')}
                      onMouseEnter={() => setHoveredOp(entry.op.id)}
                      onMouseLeave={() => setHoveredOp(null)}
                      onTouchStart={() => setHoveredOp(entry.op.id)}
                    >
                      <span className="cc-op-sw" style={{ background: entry.op.color }} />
                      <span className="cc-op-info">
                        <span className="cc-op-name">
                          {entry.op.label}
                          {entry.op.op === 'Profile' && entry.op.side ? ` · ${entry.op.side}` : ''}
                        </span>
                        <span className="cc-op-loop">
                          {jobs.length > 1 && entry.jobName ? `${entry.jobName} · ` : ''}
                          {t('cc.surfaceN', 'Surface {n}', { n: entry.regionId + 1 })}
                        </span>
                      </span>
                      <span className="cc-op-actions">
                        <button
                          type="button"
                          className="cc-op-btn"
                          disabled={i === 0}
                          onClick={() => moveLoopOp(entry.op.id, -1)}
                          title={t('fv.up', 'Move earlier')}
                          aria-label={t('fv.up', 'Move earlier')}
                        >
                          <ChevronUp size={13} />
                        </button>
                        <button
                          type="button"
                          className="cc-op-btn"
                          disabled={i === surfaceOpList.length - 1}
                          onClick={() => moveLoopOp(entry.op.id, 1)}
                          title={t('fv.down', 'Move later')}
                          aria-label={t('fv.down', 'Move later')}
                        >
                          <ChevronDown size={13} />
                        </button>
                        <button
                          type="button"
                          className="cc-op-btn danger"
                          onClick={() => removeLoopOp(entry.op.id)}
                          title={t('fv.remove', 'Remove this operation')}
                          aria-label={t('fv.remove', 'Remove this operation')}
                        >
                          <Trash2 size={13} />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          )}
          </div>{/* /cc-cards (top) */}
        </div>{/* /cc-split-top */}

        {/* ───── draggable horizontal separator between the two sections ── */}
        <div
          className="cc-split-handle"
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('cc.resizeSections', 'Drag to resize the two sections')}
          onPointerDown={onSplitPointerDown}
          title={t('cc.resizeSections', 'Drag to resize the two sections')}
        >
          <span className="cc-split-grip" aria-hidden />
        </div>

        {/* ─────────── BOTTOM: preset rail + params + preset editor ─── */}
        {/* The preset color rail is sticky on the LEFT of THIS (bottom) section
            only — the top section is purely for files/models/operations. The
            rail sits in .cc-split-bottom (position:relative, non-scrolling) while
            .cc-cards scrolls, so the rail never scrolls away or bleeds into the
            top section. */}
        <div className="cc-split-bottom">
          {/* The preset color rail shows in BOTH modes now. A 2D/3D toggle on
              top of it switches which preset SET the rail drives: the 2D feature
              presets or the 3D relief-carve presets. */}
          <div className="cc-presets-railwrap">
            <div
              className="cc-presetmode"
              role="radiogroup"
              aria-label={t('cc.presetMode.aria', '2D or 3D preset set')}
            >
              <button
                type="button"
                role="radio"
                aria-checked={presetMode === '2d'}
                className={'cc-presetmode-opt' + (presetMode === '2d' ? ' is-on' : '')}
                onClick={() => setPresetMode('2d')}
                title={t('cc.presetMode.2d', 'Show 2D feature presets')}
              >
                2D
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={presetMode === '3d'}
                className={'cc-presetmode-opt' + (presetMode === '3d' ? ' is-on' : '')}
                onClick={() => setPresetMode('3d')}
                title={t('cc.presetMode.3d', 'Show 3D relief-carve presets')}
              >
                3D
              </button>
              <span
                className={'cc-presetmode-thumb' + (presetMode === '3d' ? ' is-3d' : '')}
                aria-hidden="true"
              />
            </div>
            <PresetRail
              slots={activePresets.slots}
              selected={activePresets.selected}
              onLoad={activePresets.load}
              onSelect={activePresets.select}
              ariaLabel={
                presetMode === '3d'
                  ? t('cc.presets3d.aria', '3D carving setting presets')
                  : t('cc.presets.aria', 'Carving setting presets')
              }
            />
          </div>
          <div className="cc-cards">

          {/* OPERATIONS LIST moved to the TOP section (see /cc-split-top). */}

          {/* ============ 2 · BIT + MATERIAL (the only choices a beginner
                makes — everything else is auto-computed below) ============ */}
          <section className="cc-section cc-toolstrip cc-primary">
            <h3>
              <Drill className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
              {t('cc.pickBitMat', 'Bit & material')}
            </h3>
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
              <section className={'cc-section' + (hasFeatureOps ? ' cc-op-overridden' : '')}>
                <h3>
                  <Layers className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                  {t('cc.operation', 'Operation')}
                  {hasFeatureOps && (
                    <span className="cc-op-badge">
                      {t('cc.perFeatureActive', 'Per-feature active')}
                    </span>
                  )}
                </h3>
                <div className="cc-section-body">
                  {hasFeatureOps && (
                    <span className="cc-hint">
                      {t('cc.perFeatureNote', 'Per-feature operations (in the Features panel above) are driving the toolpath. Clear them to use this whole-file operation instead.')}
                    </span>
                  )}
                  <SegControl<Op>
                    className="cc-opseg"
                    ariaLabel={t('cc.operation', 'Operation')}
                    value={op}
                    onChange={setOp}
                    options={(['Engrave', 'Profile', 'Pocket', 'VCarve'] as Op[]).map((o) => ({
                      value: o,
                      title: `${opLabelText(t, o)} — ${opHelp(t, o)}`,
                      label: (
                        <>
                          <span className="cc-opseg-ico">{opIcon(o)}</span>
                          <span className="cc-opseg-lbl">{opLabelText(t, o)}</span>
                        </>
                      ),
                    }))}
                  />
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
                  {!hasFeatureOps && op !== 'Engrave' && closedCount === 0 && hasGeometry && (
                    <span className="cc-warn-line">
                      ⚠ {t('cc.needClosed', '{op} needs a closed contour — none found in this file.', { op: opLabelText(t, op) })}
                    </span>
                  )}
                </div>
              </section>

              {/* V-carve settings — only shown for the V-carve operation. */}
              {op === 'VCarve' && (
                <section className={'cc-section cc-vcarve' + (vcarve.cleanup ? ' has-cleanup' : '')}>
                  <h3>
                    <Spline className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                    {t('cc.vcarve.title', 'V-carve')}
                    <Tip
                      id="vcarve"
                      title={t('cc.vcarve.title', 'V-carve')}
                      body={t(
                        'cc.vcarve.tip',
                        'Finds each closed shape’s medial axis (centreline) and varies the Z so a V-bit cuts deeper where the shape is wide and tapers to nothing at sharp tips — the way carved signs & engraved text are made. Holes/counters are respected.',
                      )}
                    />
                  </h3>
                  <div className="cc-section-body">
                    {/* Live preview swatch of the V-groove section + reach. */}
                    <VCarveBitGlyph
                      angleDeg={vcarve.vBitAngleDeg}
                      tipMm={vcarve.vTipDiameterMm}
                      maxDepth={vcarve.maxDepthMm}
                    />
                    <div className="cc-sgrid">
                      <SliderField
                        icon={<Triangle size={14} strokeWidth={1.8} style={{ transform: 'rotate(180deg)' }} />}
                        label={t('cc.vcarve.angle', 'V-bit angle')}
                        htmlFor="cc-vc-angle"
                        unit="°"
                        min={10}
                        max={170}
                        step={1}
                        value={vcarve.vBitAngleDeg}
                        onChange={(n) => setVcarve((v) => ({ ...v, vBitAngleDeg: n }))}
                        title={t('cc.vcarve.angleTip', 'Full included tip angle of the V-bit (e.g. 60° or 90°). Sharper bits cut deeper for the same width.')}
                      />
                      <SliderField
                        icon={<Drill size={14} strokeWidth={1.8} />}
                        label={t('cc.vcarve.tip', 'Tip ⌀')}
                        htmlFor="cc-vc-tip"
                        unit="mm"
                        min={0}
                        max={6}
                        step={0.1}
                        value={vcarve.vTipDiameterMm}
                        onChange={(n) => setVcarve((v) => ({ ...v, vTipDiameterMm: n }))}
                        title={t('cc.vcarve.tipTip', 'Flat tip diameter of the V-bit (0 = perfectly sharp). The groove only deepens once it’s wider than the flat tip.')}
                      />
                      <SliderField
                        icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                        label={t('cc.vcarve.maxDepth', 'Max depth')}
                        htmlFor="cc-vc-maxdepth"
                        unit="mm"
                        min={0.1}
                        max={30}
                        step={0.1}
                        value={vcarve.maxDepthMm}
                        onChange={(n) => setVcarve((v) => ({ ...v, maxDepthMm: n }))}
                        title={t('cc.vcarve.maxDepthTip', 'The groove never goes deeper than this, even in wide areas. Wide areas that hit this limit can be flattened by the cleanup pass below.')}
                      />
                    </div>

                    {/* Flat-endmill cleanup (C3): clear wide areas the V-bit can't bottom. */}
                    <label className="cc-vc-cleanup-toggle" title={t('cc.vcarve.cleanupTip', 'Adds a flat-endmill clearance pass that levels any area too wide for the V-bit to reach Max depth.')}>
                      <input
                        type="checkbox"
                        checked={vcarve.cleanup}
                        onChange={(e) => setVcarve((v) => ({ ...v, cleanup: e.target.checked }))}
                      />
                      <Eraser size={14} strokeWidth={1.8} aria-hidden />
                      <span>{t('cc.vcarve.cleanup', 'Flat-bit cleanup for wide areas')}</span>
                    </label>
                    {vcarve.cleanup && (
                      <div className="cc-sgrid">
                        <SliderField
                          icon={<Drill size={14} strokeWidth={1.8} />}
                          label={t('cc.vcarve.cleanupTool', 'Cleanup tool ⌀')}
                          htmlFor="cc-vc-cltool"
                          unit="mm"
                          min={0.5}
                          max={12}
                          step={0.1}
                          value={vcarve.cleanupToolMm}
                          onChange={(n) => setVcarve((v) => ({ ...v, cleanupToolMm: n }))}
                          title={t('cc.vcarve.cleanupToolTip', 'Flat endmill ⌀ used to clear the wide areas at Max depth.')}
                        />
                        <SliderField
                          icon={<ChevronsLeftRightEllipsis size={14} strokeWidth={1.8} />}
                          label={t('cc.stepoverFrac', 'Stepover (×⌀)')}
                          htmlFor="cc-vc-clstep"
                          min={0.05}
                          max={0.95}
                          step={0.05}
                          value={vcarve.cleanupStepoverFrac}
                          onChange={(n) => setVcarve((v) => ({ ...v, cleanupStepoverFrac: n }))}
                          title={t('cc.vcarve.cleanupStepTip', 'Sideways overlap between cleanup passes, as a fraction of the cleanup tool ⌀.')}
                        />
                      </div>
                    )}

                    {/* Status: path / segment count + reached depth + cleanup hint. */}
                    {vcarveStats && closedCount > 0 && (
                      <div className="cc-vc-status" role="status">
                        <span className="cc-stat" title={t('cc.vcarve.pathsTip', 'Medial-axis paths the V-bit follows')}>
                          {t('cc.vcarve.paths', 'Paths')} <b>{vcarveStats.paths}</b>
                        </span>
                        <span className="cc-stat" title={t('cc.vcarve.segsTip', 'Total cut segments generated')}>
                          {t('cc.vcarve.segs', 'Segments')} <b>{vcarveStats.segs}</b>
                        </span>
                        <span className="cc-stat" title={t('cc.vcarve.depthTip', 'Deepest cut reached below the surface')}>
                          {t('cc.vcarve.depth', 'Max depth')} <b>{vcarveStats.maxDepth.toFixed(2)} mm</b>
                        </span>
                        {vcarveStats.cleanupNeeded && !vcarve.cleanup && (
                          <span className="cc-vc-flag" title={t('cc.vcarve.cleanupTip', 'Adds a flat-endmill clearance pass that levels any area too wide for the V-bit to reach Max depth.')}>
                            <Eraser size={12} strokeWidth={1.9} /> {t('cc.vcarve.needsCleanup', 'wide areas — enable cleanup')}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                </section>
              )}

              {/* C7 + C12 · Cut strategy — lead-in/out, ramped/helical plunge,
                  climb/conventional direction, finishing allowance. Shown for the
                  milling ops (Profile / Pocket) when not plotting with a pen. */}
              {!hasFeatureOps && (op === 'Profile' || op === 'Pocket') && p2d.zMode === ZMode.Spindle && (
                <section className="cc-section">
                  <h3>
                    <Route className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                    {t('cc.strat.title', 'Cut strategy')}
                    <Tip
                      id="cut-strategy"
                      title={t('cc.strat.title', 'Cut strategy')}
                      body={t(
                        'cc.strat.tip',
                        'Machinist-grade entry and direction control. Ease the tool into the cut with a lead-in and ramp/helix down instead of plunging straight; pick climb or conventional milling; and leave a finishing allowance on the wall.',
                      )}
                    />
                  </h3>
                  <div className="cc-section-body">
                    {/* Plunge mode — never a straight drop by default (C7). */}
                    <div className="cc-rowlabel" title={t('cc.strat.plungeTip', 'How the tool reaches cutting depth. A straight plunge stresses a desktop machine; a ramp or helix eases it in.')}>
                      <ArrowDownToLine size={13} strokeWidth={1.9} aria-hidden /> {t('cc.strat.plunge', 'Plunge')}
                    </div>
                    <SegControl<PlungeMode>
                      ariaLabel={t('cc.strat.plunge', 'Plunge')}
                      value={strategy.plunge}
                      onChange={(v) => setStrategy((s) => ({ ...s, plunge: v }))}
                      options={[
                        { value: 'ramp', label: t('cc.strat.ramp', 'Ramp'), title: t('cc.strat.rampTip', 'Zig-zag down along the first cut — gentle, works in narrow paths.') },
                        { value: 'helix', label: t('cc.strat.helix', 'Helix'), title: t('cc.strat.helixTip', 'Spiral down in a circle — ideal for entering open pockets.') },
                        { value: 'plunge', label: t('cc.strat.straight', 'Straight'), title: t('cc.strat.straightTip', 'Drop straight down (only for plunge-rated bits / soft material).') },
                      ]}
                    />
                    {strategy.plunge !== 'plunge' && (
                      <div className="cc-sgrid">
                        <SliderField
                          icon={<Triangle size={14} strokeWidth={1.8} />}
                          label={t('cc.strat.rampAngle', 'Ramp angle')}
                          htmlFor="cc-strat-angle"
                          unit="°"
                          min={1}
                          max={45}
                          step={1}
                          value={strategy.rampAngleDeg}
                          onChange={(n) => setStrategy((s) => ({ ...s, rampAngleDeg: n }))}
                          title={t('cc.strat.rampAngleTip', 'Descent angle from horizontal. Shallower (smaller) is gentler on the bit.')}
                        />
                        {strategy.plunge === 'helix' && (
                          <SliderField
                            icon={<RotateCw size={14} strokeWidth={1.8} />}
                            label={t('cc.strat.helixR', 'Helix radius')}
                            htmlFor="cc-strat-helixr"
                            unit="mm"
                            min={0.2}
                            max={10}
                            step={0.1}
                            value={strategy.helixRadiusMm}
                            onChange={(n) => setStrategy((s) => ({ ...s, helixRadiusMm: n }))}
                            title={t('cc.strat.helixRTip', 'Radius of the helical descent. Must fit inside the pocket being entered.')}
                          />
                        )}
                      </div>
                    )}

                    {/* Lead-in/out (C7). */}
                    <div className="cc-rowlabel" title={t('cc.strat.leadTip', 'Approach and leave the cut along a tangent or arc so the entry/exit mark is off the finished edge.')}>
                      <Spline size={13} strokeWidth={1.9} aria-hidden /> {t('cc.strat.lead', 'Lead-in / out')}
                    </div>
                    <SegControl<LeadShape>
                      ariaLabel={t('cc.strat.lead', 'Lead-in / out')}
                      value={strategy.lead}
                      onChange={(v) => setStrategy((s) => ({ ...s, lead: v }))}
                      options={[
                        { value: 'none', label: t('cc.strat.leadNone', 'None'), title: t('cc.strat.leadNoneTip', 'Enter directly on the contour.') },
                        { value: 'tangent', label: t('cc.strat.leadTan', 'Tangent'), title: t('cc.strat.leadTanTip', 'Straight run-in along the cut direction.') },
                        { value: 'arc', label: t('cc.strat.leadArc', 'Arc'), title: t('cc.strat.leadArcTip', 'Quarter-circle approach — smoothest entry.') },
                      ]}
                    />
                    {strategy.lead !== 'none' && (
                      <SliderField
                        icon={<Spline size={14} strokeWidth={1.8} />}
                        label={t('cc.strat.leadLen', 'Lead length')}
                        htmlFor="cc-strat-leadlen"
                        unit="mm"
                        min={0.5}
                        max={20}
                        step={0.5}
                        value={strategy.leadLengthMm}
                        onChange={(n) => setStrategy((s) => ({ ...s, leadLengthMm: n }))}
                        title={t('cc.strat.leadLenTip', 'Length of the tangent run-in, or radius of the arc lead.')}
                      />
                    )}

                    {/* Direction (C12). */}
                    <div className="cc-rowlabel" title={t('cc.strat.dirTip', 'Climb milling leaves a cleaner finish; conventional milling is more forgiving on machines with backlash.')}>
                      <RotateCw size={13} strokeWidth={1.9} aria-hidden /> {t('cc.strat.dir', 'Direction')}
                    </div>
                    <SegControl<CutDirection>
                      ariaLabel={t('cc.strat.dir', 'Direction')}
                      value={strategy.direction}
                      onChange={(v) => setStrategy((s) => ({ ...s, direction: v }))}
                      options={[
                        { value: 'climb', label: t('cc.strat.climb', 'Climb'), title: t('cc.strat.climbTip', 'Cutter spins into the uncut wall — cleaner edge, needs a rigid machine.') },
                        { value: 'conventional', label: t('cc.strat.conv', 'Conventional'), title: t('cc.strat.convTip', 'Cutter spins out of the wall — safer on a flexy/backlash machine.') },
                      ]}
                    />

                    {/* Stock-to-leave (C12). */}
                    <SliderField
                      icon={<Layers size={14} strokeWidth={1.8} />}
                      label={t('cc.strat.stl', 'Stock to leave')}
                      htmlFor="cc-strat-stl"
                      unit="mm"
                      min={0}
                      max={3}
                      step={0.05}
                      value={strategy.stockToLeaveMm}
                      onChange={(n) => setStrategy((s) => ({ ...s, stockToLeaveMm: Math.max(0, n) }))}
                      title={t('cc.strat.stlTip', 'Finishing allowance kept on the wall (mm) for a later clean-up pass. 0 cuts to size.')}
                    />
                  </div>
                </section>
              )}

              {/* Position & size — offset + uniform scale (or type a target W/H to
                  auto-fit), mirroring the placement controls 3D jobs already have. */}
              <section className="cc-section">
                <h3>
                  <Maximize2 className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                  {t('cc.posSize', 'Position & size')}
                </h3>
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
                      title={t('cc.offsetXTip', 'Shift the drawing left/right on the bed (mm). 0 = centred on the work origin.')}
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
                      title={t('cc.offsetYTip', 'Shift the drawing forward/back on the bed (mm). 0 = centred on the work origin.')}
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
                <h3>
                  <Gauge className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                  {t('cc.toolCut', 'Tool & cut')}
                </h3>
                <div className="cc-section-body">
                  <div className="cc-sgrid">
                    {/* For V-carve the tool ⌀ + cut depth are driven by the V-bit
                        angle/tip + Max depth in the V-carve card above. */}
                    {op !== 'VCarve' && (
                      <SliderField
                        icon={<Drill size={14} strokeWidth={1.8} />}
                        label={t('cc.toolDiaShort', 'Tool ⌀')}
                        htmlFor="cc-diameter"
                        unit="mm"
                        min={0.1}
                        max={25}
                        step={0.1}
                        hint={<>{t('cc.fromBit', 'from bit')}: {bit.diameter}</>}
                        title={t('cc.toolDiaTip', 'Cutting tool diameter (mm). Drives profile/pocket offsets — defaults to the chosen bit’s width.')}
                        {...slider2d('diameter')}
                      />
                    )}
                    {op !== 'VCarve' && (
                      <SliderField
                        icon={<ArrowDownToLine size={14} strokeWidth={1.8} />}
                        label={t('cc.cutDepthShort', 'Cut depth')}
                        htmlFor="cc-cutdepth"
                        unit="mm"
                        min={0}
                        max={60}
                        step={0.1}
                        title={t('cc.cutDepthTip', 'Total depth below the stock surface to cut (mm), reached over one or more passes.')}
                        {...slider2d('cutDepth')}
                      />
                    )}
                    <SliderField
                      icon={<Layers size={14} strokeWidth={1.8} />}
                      label={t('cc.stepdownPassShort', 'Stepdown / pass')}
                      htmlFor="cc-stepdown"
                      unit="mm"
                      min={0.05}
                      max={10}
                      step={0.05}
                      hint={<>{t('common.recommended', 'Recommended')}: {rec.stepdown}</>}
                      title={t('cc.stepdownTip', 'How much deeper each pass goes (mm). Smaller = gentler on the bit; the cut is split into passes until it reaches Cut depth.')}
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
                      title={t('cc.safeZTip', 'Retract height (mm above the surface) the tool lifts to before any rapid travel — keeps it clear of clamps and the work.')}
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
                <h3>
                  <ArrowUpToLine className="cam-card-ico" size={15} strokeWidth={1.9} aria-hidden />
                  {t('cc.zMode', 'Z mode')}
                </h3>
                <div className="cc-section-body">
                  {op === 'VCarve' ? (
                    <span className="cc-hint">
                      {t('cc.vcarve.spindleOnly', 'V-carve is a milling op — it always runs in Spindle mode (Z is the carved depth).')}
                    </span>
                  ) : (
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
                  )}
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
                        title={t('cc.spindleRPMTip', 'Spindle speed (M3 Sxxxx) emitted at the start of the program. Set per material + bit; 0 leaves the spindle off.')}
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
                          title={t('cc.penUpZTip', 'Z the pen lifts to for travel moves (no drawing) — high enough to clear the paper.')}
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
                          title={t('cc.penDownZTip', 'Z the pen drops to while drawing — just touching the paper (slightly negative presses harder).')}
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
                        title={t('cc.feedXYTip', 'Horizontal cutting feed rate (mm/min) for G1 moves in the material.')}
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
                        title={t('cc.feedZTip', 'Vertical plunge feed rate (mm/min) as the tool drives down into the stock — usually slower than Feed XY.')}
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

          {/* The preset list moved OUT of the bottom card stack: the colour-slot
              rail is the sticky LEFT bar and the name/save/delete/load controls
              live in the full-width footer save-bar (see below) — exactly like
              the Soldering / Writing tabs. The bottom param sections above ARE
              the active preset's params. */}

          {/* ---- output / live preview (streaming lives in the Program tab) ---- */}
          {/* The Output section was removed: regenerate is automatic (live), the
              Frame button + G-code copy/download moved to the Program tab. Only
              the carve-settings load error surfaces here. */}
          {loadError && <div className="cc-error cc-loaderr">{loadError}</div>}
          </div>{/* /cc-cards (bottom) */}
        </div>{/* /cc-split-bottom */}
      </div>{/* /cc-split */}
      {/* ── Full-width FOOTER save-bar ──────────────────────────────────────
          The shared preset save-bar (name + colour slot + save + delete) binds
          to the ACTIVE preset set (2D feature presets or the 3D relief presets,
          per the rail's 2D/3D switch), with the carve-settings document Save /
          Load (download / upload) in its `extra` slot. */}
      <PresetSaveBar
        slots={activePresets.slots}
        selected={activePresets.selected}
        onSelect={activePresets.select}
        onSave={activePresets.save}
        onClear={activePresets.clear}
        onRename={activePresets.rename}
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
    <div className="cc-matpickrow">
      {/* Compact thumbnail row (Area-3): a small material thumbnail + name on one
          line, replacing the tall photoreal banner so the material picker no
          longer dominates the bit/material strip. The full photo grid still lives
          in the chooser modal below. */}
      <button
        type="button"
        className="cc-matpick"
        onClick={() => setOpen(true)}
        title={t('cc.matPick', 'Material — click to choose ({name})', { name })}
        aria-haspopup="dialog"
      >
        <span
          className="cc-matpick-thumb"
          style={material.image ? { backgroundImage: `url(${material.image})` } : undefined}
          aria-hidden="true"
        >
          {!material.image && <span className="cc-matpick-emoji">{material.icon}</span>}
        </span>
        <span className="cc-matpick-name">{name}</span>
        <ChevronDown className="cc-matpick-caret" size={14} aria-hidden />
      </button>
      <button
        type="button"
        className="cc-matpick-info"
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
 * The 3D models list shown directly in the Model section: every imported job
 * (eye = visibility, click name = select for placement, duplicate, ✕ remove).
 * 2D files render as expandable {@link ModelFileCard}s instead.
 */
function ModelFilesList({
  jobs,
  selectedId,
  onSelect,
  onToggleJob,
  onDuplicateJob,
  onRemoveJob,
  t,
}: {
  jobs: CarveJob[]
  selectedId: string | null
  onSelect: (id: string) => void
  onToggleJob: (id: string, enabled: boolean) => void
  onDuplicateJob: (id: string) => void
  onRemoveJob: (id: string, name: string) => void
  t: ReturnType<typeof useT>
}) {
  if (jobs.length === 0) return null
  {
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
}

// ============================================================================
// 2D model file CARD (U5/U6/U8/U9/U10)
// ----------------------------------------------------------------------------
// One uploaded vector file = one card. The TITLE is an expand/collapse
// disclosure (caret + ext badge + file name); the REMOVE ✕ sits in the
// card's upper-right. Expanding reveals the file's PREVIEW (FeatureViewer loop
// picker) and, below it, this file's LOOPS table (loop · preset · +).
// ============================================================================
function ModelFileCard({
  fileId,
  name,
  polylines,
  features,
  expanded,
  onToggle,
  onDuplicate,
  onRemove,
  opMap,
  presets,
  onQuickAdd,
  loopPresetSel,
  setLoopPresetSel,
  selected,
  setSelected,
  t,
}: {
  fileId: string
  name: string
  polylines: Polyline[]
  features: DrawingFeature[]
  expanded: boolean
  onToggle: () => void
  onDuplicate: () => void
  onRemove: () => void
  opMap: FeatureOpMap
  presets: FeaturePreset[]
  onQuickAdd: (key: string, preset: FeaturePreset) => void
  loopPresetSel: Record<string, string>
  setLoopPresetSel: React.Dispatch<React.SetStateAction<Record<string, string>>>
  selected: string | null
  setSelected: (key: string | null) => void
  t: ReturnType<typeof useT>
}) {
  const totalOps = features.reduce(
    (n, f) => n + (opMap[featureKey(fileId, f.index)]?.length ?? 0),
    0,
  )
  return (
    <section className={'cc-section cc-span cc-mfcard' + (expanded ? ' is-open' : '')}>
      <h3 className="cc-mfcard-head">
        <button
          type="button"
          className="cc-mfcard-toggle"
          aria-expanded={expanded}
          onClick={onToggle}
          title={t('cc.togglePreview', 'Show / hide this file’s preview & loops')}
        >
          <span className={'cc-mfcard-caret' + (expanded ? ' open' : '')} aria-hidden>
            ▸
          </span>
          <span className="cc-mfcard-ext" aria-hidden="true">{fileExt(name)}</span>
          <span className="cc-mfcard-name" title={name}>{name}</span>
          {totalOps > 0 && <span className="cc-loop-badge">{totalOps}</span>}
        </button>
        <button
          type="button"
          className="cc-mfcard-dup"
          onClick={onDuplicate}
          title={t('cc.dupFile', 'Duplicate this file (run different operations on a copy)')}
          aria-label={t('cc.dupFileAria', 'Duplicate {name}', { name })}
        >
          <Icon name="duplicate" size={14} />
        </button>
        <button
          type="button"
          className="cc-mfcard-x"
          onClick={onRemove}
          title={t('cc.removeFile', 'Remove this file')}
          aria-label={t('cc.removeFileAria', 'Remove {name}', { name })}
        >
          ✕
        </button>
      </h3>
      {expanded && (
        <div className="cc-section-body">
          {/* Preview: pick a loop (right-click to quick-add a preset). */}
          <FeatureViewer
            fileId={fileId}
            polylines={polylines}
            features={features}
            opMap={opMap}
            presets={presets}
            onQuickAdd={onQuickAdd}
            selected={selected}
            setSelected={setSelected}
            t={t}
          />
          {/* This file's loops table (loop · preset · +). */}
          {features.length > 0 && (
            <table className="cc-looptable">
              <thead>
                <tr>
                  <th>{t('cc.loop', 'Loop')}</th>
                  <th>{t('cc.preset', 'Preset')}</th>
                  <th aria-label={t('cc.add', 'Add')}></th>
                </tr>
              </thead>
              <tbody>
                {features.map((f) => {
                  const key = featureKey(fileId, f.index)
                  const ops = opMap[key]
                  const opCount = ops?.length ?? 0
                  const selId = loopPresetSel[key] ?? presets[0]?.id ?? ''
                  const chosen = presets.find((p) => p.id === selId) ?? presets[0]
                  const incompatible =
                    chosen != null &&
                    chosen.op !== 'Engrave' &&
                    chosen.side !== ProfileSide.On &&
                    !f.closed
                  return (
                    <tr
                      key={f.index}
                      className={key === selected ? 'is-sel' : undefined}
                      onClick={() => setSelected(key === selected ? null : key)}
                    >
                      <td>
                        <span
                          className="cc-loop-dot"
                          style={{ background: opCount ? ops![0].color : f.color }}
                        />
                        {loopLabel(f.index, f.closed)}
                        {opCount > 0 && <span className="cc-loop-badge">{opCount}</span>}
                      </td>
                      <td>
                        <select
                          className="cc-prim-select"
                          value={selId}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setLoopPresetSel((m) => ({ ...m, [key]: e.target.value }))
                          }
                          aria-label={t('cc.preset', 'Preset')}
                        >
                          {presets.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          className="cc-loop-add"
                          disabled={!chosen || incompatible}
                          onClick={(e) => {
                            e.stopPropagation()
                            if (chosen) onQuickAdd(key, chosen)
                          }}
                          title={
                            incompatible
                              ? t('fv.needClosed', '{name} needs a closed loop', {
                                  name: chosen?.name ?? '',
                                })
                              : t('cc.addOp', 'Add this preset as an operation on this loop')
                          }
                          aria-label={t('cc.addOp', 'Add operation')}
                        >
                          <Plus size={15} strokeWidth={2.2} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
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
    case 'VCarve':
      return t('cc.vcarve.help', 'Variable-depth V-bit groove from the shape’s centreline — deep where wide, sharp at the tips. Crisp signs, text & logos.')
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
    case 'VCarve':
      return t('cc.vcarve.op', 'V-carve')
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
    case 'VCarve':
      // V-bit groove glyph
      return <Triangle size={18} strokeWidth={1.8} aria-hidden style={{ transform: 'rotate(180deg)' }} />
  }
}

/**
 * A small live cross-section glyph of the chosen V-bit: a downward V (or flat-tip
 * trapezoid) inscribed in a stock block, with the Max-depth line marked. Gives a
 * glance-to-understand picture of how the angle/tip/depth shape the groove.
 */
function VCarveBitGlyph({
  angleDeg,
  tipMm,
  maxDepth,
}: {
  angleDeg: number
  tipMm: number
  maxDepth: number
}) {
  const W = 132
  const H = 56
  const cx = W / 2
  const top = 8
  const half = (Math.max(10, Math.min(170, angleDeg)) * Math.PI) / 360
  // Draw the V opening at a fixed visual depth; the half-width = depth*tan(half).
  const depthPx = 34
  const tan = Math.tan(half)
  let halfW = depthPx * tan
  if (halfW > cx - 8) halfW = cx - 8 // clamp very-obtuse bits to the glyph
  const tipHalfPx = Math.min(halfW * 0.6, Math.max(0, tipMm) * 3)
  const bottomY = top + depthPx
  // Trapezoid (or triangle when tip=0): top opening → flat tip at bottom.
  const leftTop = cx - halfW
  const rightTop = cx + halfW
  const leftBot = cx - tipHalfPx
  const rightBot = cx + tipHalfPx
  return (
    <svg className="cc-vc-glyph" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden focusable="false">
      {/* stock surface line */}
      <line x1={2} y1={top} x2={W - 2} y2={top} className="cc-vc-glyph-surface" />
      {/* the V groove */}
      <path
        d={`M ${leftTop} ${top} L ${leftBot} ${bottomY} L ${rightBot} ${bottomY} L ${rightTop} ${top}`}
        className="cc-vc-glyph-groove"
      />
      {/* centreline (medial axis) */}
      <line x1={cx} y1={top} x2={cx} y2={bottomY} className="cc-vc-glyph-axis" />
      <text x={cx} y={H - 4} className="cc-vc-glyph-cap" textAnchor="middle">
        {angleDeg}° · {maxDepth.toFixed(1)}mm
      </text>
    </svg>
  )
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
