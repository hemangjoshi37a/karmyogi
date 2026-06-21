// Editable, persisted CARVE PRESET model (v3) — UI-independent (no React/DOM).
// ----------------------------------------------------------------------------
// A CARVE PRESET is a FULL SNAPSHOT of the 2D-Carving panel's BOTTOM-section
// cutting parameters — exactly mirroring how the Soldering / Writing tabs snapshot
// their params (see `components/presets/usePresets.ts`). It captures:
//   • the operation kind (Engrave / Profile / Pocket / V-carve) + profile side,
//   • the chosen Bit & material (ids),
//   • Tool & cut (tool ⌀, cut depth, stepdown, stepover, surface Z, safe Z),
//   • Z mode (Spindle / Pen) + spindle RPM + pen up/down Z,
//   • the Advanced params (feeds, decimals, line numbers),
//   • a V-carve param bundle (only meaningful when op === 'VCarve').
// Position & size (offset/scale) is per-FILE PLACEMENT, NOT part of a preset.
//
// The named LIST of preset slots + which is selected is owned by the shared
// `usePresets<CarvePreset>` hook (persisted under `CARVE_PRESETS_KEY`). This module
// only defines the preset SHAPE, the 7 seed defaults, a narrow() guard, and a tiny
// adapter that turns a preset into the light per-loop op intent the loop→preset
// table + the multi-file composer consume.

import { ProfileSide } from '../core/cam'
import { ZMode } from '../core/gcodeEmitter'
import type { FeatureOpKind, FeatureOp } from '../core/featureCam'
import { PRESET_COLORS, type PresetSlot } from '../components/presets/usePresets'
import { DEFAULT_BIT_ID } from '../core/toolLibrary'
import { DEFAULT_MATERIAL_ID } from '../core/materials'

/**
 * localStorage key the carve-preset slot list persists under (v4 = full snapshot
 * + the Clear-out / Cutout default seeds). Bumped from v3 so a fresh seed set
 * (including the two new clearing/cutout presets) ships to existing installs.
 */
export const CARVE_PRESETS_KEY = 'karmyogi.carve.presets.v4'

/** The operation kinds a carve preset can carry (the 2D `Op`, incl. V-carve). */
export type CarveOp = FeatureOpKind | 'VCarve'

/** The V-carve sub-bundle (only meaningful when op === 'VCarve'). */
export interface CarveVParams {
  vBitAngleDeg: number
  vTipDiameterMm: number
  maxDepthMm: number
  cleanup: boolean
  cleanupToolMm: number
  cleanupStepoverFrac: number
}

/**
 * A full snapshot of the bottom-section cutting parameters. Selecting a preset
 * slot LOADS these into the panel; editing the bottom sections edits the active
 * preset (Save persists). Generation cuts each loop with its preset's params.
 */
export interface CarvePreset {
  // ── Operation ──────────────────────────────────────────────────────────
  op: CarveOp
  side: ProfileSide
  // ── Bit & material (ids; resolved against the libraries at use-time) ─────
  bitId: string
  bitLength: number
  materialId: string
  // ── Tool & cut ───────────────────────────────────────────────────────────
  diameter: number
  cutDepth: number
  stepdown: number
  stepover: number
  surfaceZ: number
  safeZ: number
  // ── Z mode ─────────────────────────────────────────────────────────────
  zMode: ZMode
  spindleRPM: number
  penUpZ: number
  penDownZ: number
  // ── Advanced ───────────────────────────────────────────────────────────
  feedXY: number
  feedZ: number
  decimals: number
  lineNumbers: boolean
  // ── V-carve sub-bundle ───────────────────────────────────────────────────
  vcarve: CarveVParams
}

const DEFAULT_VCARVE: CarveVParams = {
  vBitAngleDeg: 60,
  vTipDiameterMm: 0,
  maxDepthMm: 3,
  cleanup: false,
  cleanupToolMm: 3.175,
  cleanupStepoverFrac: 0.45,
}

/** A sane baseline preset; the seeds below override the op/side/cut intent. */
export function defaultCarvePreset(over: Partial<CarvePreset> = {}): CarvePreset {
  const base: CarvePreset = {
    op: 'Profile',
    side: ProfileSide.Outside,
    bitId: DEFAULT_BIT_ID,
    bitLength: 16,
    materialId: DEFAULT_MATERIAL_ID,
    diameter: 3.175,
    cutDepth: 1.0,
    stepdown: 1.0,
    stepover: 0.45,
    surfaceZ: 0.0,
    safeZ: 5.0,
    zMode: ZMode.Spindle,
    spindleRPM: 12000,
    penUpZ: 5.0,
    penDownZ: 0.0,
    feedXY: 600,
    feedZ: 200,
    decimals: 3,
    lineNumbers: false,
    vcarve: { ...DEFAULT_VCARVE },
  }
  return { ...base, ...over, vcarve: { ...base.vcarve, ...(over.vcarve ?? {}) } }
}

// ── narrow / coerce (guards persisted slots from schema drift) ──────────────
const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const numOr = (v: unknown, f: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : f
const boolOr = (v: unknown, f: boolean): boolean => (typeof v === 'boolean' ? v : f)

function parseOp(v: unknown, f: CarveOp): CarveOp {
  return v === 'Engrave' || v === 'Profile' || v === 'Pocket' || v === 'Cutout' || v === 'VCarve'
    ? v
    : f
}
function parseSide(v: unknown, f: ProfileSide): ProfileSide {
  return v === ProfileSide.On || v === ProfileSide.Inside || v === ProfileSide.Outside ? v : f
}

function parseVcarve(v: unknown): CarveVParams {
  const b = DEFAULT_VCARVE
  if (!isRec(v)) return { ...b }
  return {
    vBitAngleDeg: numOr(v.vBitAngleDeg, b.vBitAngleDeg),
    vTipDiameterMm: numOr(v.vTipDiameterMm, b.vTipDiameterMm),
    maxDepthMm: numOr(v.maxDepthMm, b.maxDepthMm),
    cleanup: boolOr(v.cleanup, b.cleanup),
    cleanupToolMm: numOr(v.cleanupToolMm, b.cleanupToolMm),
    cleanupStepoverFrac: numOr(v.cleanupStepoverFrac, b.cleanupStepoverFrac),
  }
}

/** Coerce an untrusted (persisted / loaded) blob into a valid CarvePreset. */
export function parseCarvePreset(v: unknown, base: CarvePreset = defaultCarvePreset()): CarvePreset {
  if (!isRec(v)) return { ...base, vcarve: { ...base.vcarve } }
  return {
    op: parseOp(v.op, base.op),
    side: parseSide(v.side, base.side),
    bitId: typeof v.bitId === 'string' ? v.bitId : base.bitId,
    bitLength: numOr(v.bitLength, base.bitLength),
    materialId: typeof v.materialId === 'string' ? v.materialId : base.materialId,
    diameter: numOr(v.diameter, base.diameter),
    cutDepth: numOr(v.cutDepth, base.cutDepth),
    stepdown: numOr(v.stepdown, base.stepdown),
    stepover: numOr(v.stepover, base.stepover),
    surfaceZ: numOr(v.surfaceZ, base.surfaceZ),
    safeZ: numOr(v.safeZ, base.safeZ),
    zMode: v.zMode === ZMode.Pen ? ZMode.Pen : ZMode.Spindle,
    spindleRPM: numOr(v.spindleRPM, base.spindleRPM),
    penUpZ: numOr(v.penUpZ, base.penUpZ),
    penDownZ: numOr(v.penDownZ, base.penDownZ),
    feedXY: numOr(v.feedXY, base.feedXY),
    feedZ: numOr(v.feedZ, base.feedZ),
    decimals: numOr(v.decimals, base.decimals),
    lineNumbers: boolOr(v.lineNumbers, base.lineNumbers),
    vcarve: parseVcarve(v.vcarve),
  }
}

// ── 7 seed presets — the canonical defaults the loop table + rail show ──────
// Each is a full param bundle; the named slots line up with PRESET_COLORS by
// position (so the rail's fixed hues are also each preset's identity color).
interface Seed {
  name: string
  over: Partial<CarvePreset>
}
const SEEDS: Seed[] = [
  { name: 'Profile-outside', over: { op: 'Profile', side: ProfileSide.Outside } },
  { name: 'Profile-inside', over: { op: 'Profile', side: ProfileSide.Inside } },
  { name: 'Profile-on', over: { op: 'Profile', side: ProfileSide.On } },
  { name: 'Pocket', over: { op: 'Pocket' } },
  { name: 'Engrave', over: { op: 'Engrave', cutDepth: 0.4 } },
  // Flat clearing of the area inside a closed loop (a Pocket-style flat clear).
  { name: 'Clear-out', over: { op: 'Pocket' } },
  // Cut the part free from the stock with holding tabs — cut LAST, full depth.
  { name: 'Cutout', over: { op: 'Cutout', side: ProfileSide.Outside, cutDepth: 6, stepdown: 1.0 } },
  // Two common multi-pass intents (deep roughing + light finishing profile).
  { name: 'Roughing', over: { op: 'Profile', side: ProfileSide.Outside, stepdown: 2.0 } },
  { name: 'Finishing', over: { op: 'Profile', side: ProfileSide.Outside, stepdown: 0.4 } },
]

/** The 10 seed slots: 7 filled defaults + 3 empty (canonical PRESET_COLORS). */
export function seedCarveSlots(): PresetSlot<CarvePreset>[] {
  return PRESET_COLORS.map((color, i) => {
    const s = SEEDS[i]
    return s
      ? { color, name: s.name, preset: defaultCarvePreset(s.over) }
      : { color, name: '', preset: null }
  })
}

/**
 * Seed the persisted carve-preset slots ONCE (only when nothing is stored yet),
 * so a fresh install shows the 7 default presets in the rail / loop table. Runs
 * BEFORE `usePersistentState(CARVE_PRESETS_KEY, …)` first reads localStorage, so
 * the hook picks the seeds up as its initial value. A no-op once the user has any
 * saved slots (their edits are never overwritten).
 */
export function seedCarvePresetsIfEmpty(): void {
  try {
    if (localStorage.getItem(CARVE_PRESETS_KEY) != null) return
    localStorage.setItem(CARVE_PRESETS_KEY, JSON.stringify(seedCarveSlots()))
  } catch {
    /* ignore (private mode / quota) — the hook falls back to empty slots */
  }
}

// Seed at module load (import side-effect), before any component reads the key.
seedCarvePresetsIfEmpty()

// ============================================================================
// 3D CARVE PRESETS (relief carving) — a separate preset SET for the 3D mode.
// ----------------------------------------------------------------------------
// A 3D preset is a full snapshot of the 3D-Carving cutting params: tool ⌀ +
// type, finishing stepover, roughing stepover, stepdown, max depth, feeds,
// do-roughing/finishing, finish direction/pattern, and spindle RPM. It mirrors
// the carve3d `Carve3DParams` + the carve-jobs GLOBAL/per-job split (tool, RPM,
// safe-Z and plunge feed are GLOBAL; stepover/stepdown/depth/feeds/strategy are
// per-job). Persisted SEPARATELY from the 2D feature presets so flipping the
// 2D/3D switch shows the right set. The named slot LIST is owned by the same
// shared `usePresets<Carve3DPreset>` hook under `CARVE_PRESETS_3D_KEY`.
// ============================================================================

import type { ToolType } from '../core/carve3d'

/**
 * localStorage key the 3D carve-preset slot list persists under (v2 adds the
 * Clear-out / Cutout default seeds + the per-preset `cutout` flag). Bumped from
 * v1 so existing installs pick up the new seed defaults.
 */
export const CARVE_PRESETS_3D_KEY = 'karmyogi.carve.presets3d.v2'

/** A full snapshot of the 3D relief-carving cutting parameters. */
export interface Carve3DPreset {
  // ── Tool (GLOBAL — one bit cuts every job) ───────────────────────────────
  toolDiameter: number
  toolType: ToolType
  spindleRPM: number
  // ── Cut (per-job) ────────────────────────────────────────────────────────
  stepover: number // FINE finishing stepover (mm)
  roughStepover: number // coarse roughing stepover (mm)
  stepdown: number // depth-of-cut per roughing level (mm)
  maxDepth: number // max relief depth below the top surface (mm)
  // ── Feeds (mm/s in the UI, as the job stores them) ───────────────────────
  cutSpeedMmS: number
  freeSpeedMmS: number
  feedZ: number // plunge feed (mm/min) — GLOBAL
  // ── Strategy ─────────────────────────────────────────────────────────────
  doRoughing: boolean
  doFinishing: boolean
  finishDir: 'x' | 'y'
  finishPattern: 'serpentine' | 'climb'
  // ── Cutout (part-separation pass) ────────────────────────────────────────
  /**
   * When true, selecting this preset ENABLES the carve3d cutout pass so the
   * generated program cuts the finished part free from the stock (with holding
   * tabs). The "Cutout" seed turns this on; the others leave it as-is.
   */
  cutout: boolean
}

/** A sane baseline 3D preset; the seeds below override the strategy intent. */
export function defaultCarve3DPreset(over: Partial<Carve3DPreset> = {}): Carve3DPreset {
  const base: Carve3DPreset = {
    toolDiameter: 3.175,
    toolType: 'ball',
    spindleRPM: 10000,
    stepover: 0.5,
    roughStepover: 1.5,
    stepdown: 1.0,
    maxDepth: 10,
    cutSpeedMmS: 10,
    freeSpeedMmS: 20,
    feedZ: 200,
    doRoughing: true,
    doFinishing: true,
    finishDir: 'x',
    finishPattern: 'serpentine',
    cutout: false,
  }
  return { ...base, ...over }
}

function parseToolType(v: unknown, f: ToolType): ToolType {
  return v === 'ball' || v === 'flat' ? v : f
}
function parseFinishDir(v: unknown, f: 'x' | 'y'): 'x' | 'y' {
  return v === 'x' || v === 'y' ? v : f
}
function parseFinishPattern(v: unknown, f: 'serpentine' | 'climb'): 'serpentine' | 'climb' {
  return v === 'serpentine' || v === 'climb' ? v : f
}

/** Coerce an untrusted (persisted / loaded) blob into a valid Carve3DPreset. */
export function parseCarve3DPreset(
  v: unknown,
  base: Carve3DPreset = defaultCarve3DPreset(),
): Carve3DPreset {
  if (!isRec(v)) return { ...base }
  return {
    toolDiameter: numOr(v.toolDiameter, base.toolDiameter),
    toolType: parseToolType(v.toolType, base.toolType),
    spindleRPM: numOr(v.spindleRPM, base.spindleRPM),
    stepover: numOr(v.stepover, base.stepover),
    roughStepover: numOr(v.roughStepover, base.roughStepover),
    stepdown: numOr(v.stepdown, base.stepdown),
    maxDepth: numOr(v.maxDepth, base.maxDepth),
    cutSpeedMmS: numOr(v.cutSpeedMmS, base.cutSpeedMmS),
    freeSpeedMmS: numOr(v.freeSpeedMmS, base.freeSpeedMmS),
    feedZ: numOr(v.feedZ, base.feedZ),
    doRoughing: boolOr(v.doRoughing, base.doRoughing),
    doFinishing: boolOr(v.doFinishing, base.doFinishing),
    finishDir: parseFinishDir(v.finishDir, base.finishDir),
    finishPattern: parseFinishPattern(v.finishPattern, base.finishPattern),
    cutout: boolOr(v.cutout, base.cutout),
  }
}

// ── 3D seed presets — three common relief-carving intents ───────────────────
interface Seed3D {
  name: string
  over: Partial<Carve3DPreset>
}
const SEEDS_3D: Seed3D[] = [
  {
    name: 'Roughing + Finishing',
    over: { doRoughing: true, doFinishing: true, toolType: 'ball', stepover: 0.5, stepdown: 1.0 },
  },
  {
    name: 'Fine detail (ball)',
    over: { doRoughing: false, doFinishing: true, toolType: 'ball', stepover: 0.25, finishPattern: 'climb' },
  },
  {
    name: 'Fast clear (flat)',
    over: { doRoughing: true, doFinishing: false, toolType: 'flat', roughStepover: 2.0, stepdown: 1.5 },
  },
  {
    // Flat clearing / facing the region: roughing-style flat clear, larger
    // stepover, finishing off so it just levels the surface.
    name: 'Clear-out',
    over: {
      doRoughing: true,
      doFinishing: false,
      toolType: 'flat',
      roughStepover: 2.5,
      stepover: 2.5,
      stepdown: 1.5,
    },
  },
  {
    // Cut the finished part free from the stock with holding tabs (runs last).
    // Keeps roughing + finishing on so the relief is carved before separation,
    // and flips the cutout pass ON.
    name: 'Cutout',
    over: { doRoughing: true, doFinishing: true, toolType: 'ball', cutout: true },
  },
]

/** The 10 seed slots for the 3D set: 3 filled defaults + 7 empty. */
export function seedCarve3DSlots(): PresetSlot<Carve3DPreset>[] {
  return PRESET_COLORS.map((color, i) => {
    const s = SEEDS_3D[i]
    return s
      ? { color, name: s.name, preset: defaultCarve3DPreset(s.over) }
      : { color, name: '', preset: null }
  })
}

/** Seed the persisted 3D carve-preset slots ONCE (only when nothing is stored). */
export function seedCarve3DPresetsIfEmpty(): void {
  try {
    if (localStorage.getItem(CARVE_PRESETS_3D_KEY) != null) return
    localStorage.setItem(CARVE_PRESETS_3D_KEY, JSON.stringify(seedCarve3DSlots()))
  } catch {
    /* ignore (private mode / quota) — the hook falls back to empty slots */
  }
}

// Seed at module load, before any component reads the key.
seedCarve3DPresetsIfEmpty()

// ── adapter: a preset → the light per-loop op intent ────────────────────────
let opCounter = 0
/**
 * Instantiate a per-loop {@link FeatureOp} from a full carve preset + its slot
 * label/color. V-carve has no per-loop equivalent (it's a whole-file medial-axis
 * op), so a V-carve preset added to a loop falls back to an Engrave intent — the
 * loop table disables V-carve for closed-only ops anyway. The op snapshots the
 * preset's cut overrides so editing the slot later never rewrites a placed op.
 */
export function opFromCarvePreset(preset: CarvePreset, name: string, color: string): FeatureOp {
  opCounter += 1
  const kind: FeatureOpKind = preset.op === 'VCarve' ? 'Engrave' : preset.op
  return {
    id: `op-${Date.now().toString(36)}-${opCounter}`,
    presetId: `carve-${color}`,
    label: name,
    color,
    op: kind,
    side: kind === 'Profile' || kind === 'Cutout' ? preset.side : undefined,
    cutDepth: preset.cutDepth,
    stepdown: preset.stepdown,
    stepover: preset.stepover,
    diameter: preset.diameter,
  }
}
