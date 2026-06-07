import { create } from 'zustand'
import type { StlMesh } from '../core/slicer'
import { meshFootprint, type ToolType } from '../core/carve3d'
import { nestFootprints } from '../core/nesting'
import type { Placement } from '../core/transform'
import { IDENTITY_PLACEMENT } from '../core/transform'
import {
  hydrateCarveJobs,
  saveCarveJobs,
  clearPersistedCarveJobs,
} from './carveJobsPersist'

/**
 * Multi-model carving job list (3D Carving panel).
 *
 * The panel can keep importing STL files; EACH import becomes a JOB in this
 * list (it never replaces the previous one). A job owns its own material,
 * stock, speeds, placement and roughing/finishing flags, so every job is
 * individually editable; new jobs inherit the current `defaults` so by default
 * every job shares the same settings. The TOOL/BIT, safe-Z, spindle and Z-mode
 * are GLOBAL (one bit cuts all jobs in a single combined program).
 *
 * Meshes are large typed arrays, so this store is persisted to **IndexedDB**
 * (NOT localStorage — typed arrays would have to be base64'd and would blow the
 * ~5MB quota). On module load we hydrate the saved snapshot so previously
 * imported models reappear with their settings across page reloads / PWA
 * service-worker updates; after every mutation we debounce-save the whole list
 * (meshes + per-job metadata + defaults + global). Persistence is best-effort
 * and a silent no-op when IndexedDB is unavailable (see carveJobsPersist.ts).
 * Import this store directly where used.
 */

/** A material id from the material library (kept as a string to avoid a dep). */
export type MaterialId = string

/** Per-job speeds the operator tunes (cut/free in mm/s for the UI; depth mm). */
export interface JobSpeeds {
  cutSpeedMmS: number
  freeSpeedMmS: number
  cutDepthMm: number
}

/** Per-job stock block (auto from the mesh bbox, then editable). */
export interface JobStock {
  width: number
  depth: number
  height: number
}

/** A single carving job: one model with its own settings + placement. */
export interface CarveJob {
  id: string
  name: string
  /** Triangle mesh (large) — kept in memory, never persisted. */
  mesh: StlMesh
  enabled: boolean
  material: MaterialId
  stock: JobStock
  speeds: JobSpeeds
  placement: Placement
  roughing: boolean
  finishing: boolean
  /** Raster scan direction for finishing. */
  finishDir: 'x' | 'y'
  /** Max carve depth below the top surface (mm). */
  maxDepth: number
  /** Stepover between adjacent raster lines (mm). */
  stepover: number
}

/** The defaults a NEW job inherits (so every job starts identical). */
export interface JobDefaults {
  material: MaterialId
  speeds: JobSpeeds
  roughing: boolean
  finishing: boolean
  finishDir: 'x' | 'y'
  maxDepth: number
  stepover: number
}

/** Global settings shared by ALL jobs in the combined program. */
export interface GlobalCarveSettings {
  /** Selected bit/tool diameter (mm) — one bit cuts all jobs. */
  toolDiameter: number
  toolType: ToolType
  safeZ: number
  spindleRPM: number
  /** Plunge feed (mm/min) shared by all jobs. */
  feedZ: number
  /** Pull-up / Z-retract feed (mm/min). 0 = maximum (rapid G0). */
  retractFeedMmMin: number
  /** Gap kept between nested jobs and the bed edge (mm). */
  nestMargin: number
}

export const DEFAULT_JOB_DEFAULTS: JobDefaults = {
  material: 'softwood',
  speeds: { cutSpeedMmS: 10, freeSpeedMmS: 20, cutDepthMm: 1.0 },
  roughing: true,
  finishing: true,
  finishDir: 'x',
  maxDepth: 10,
  stepover: 0.5,
}

export const DEFAULT_GLOBAL: GlobalCarveSettings = {
  toolDiameter: 3.175,
  toolType: 'ball',
  safeZ: 5.0,
  spindleRPM: 10000,
  feedZ: 200,
  retractFeedMmMin: 0,
  nestMargin: 4,
}

interface CarveJobsState {
  jobs: CarveJob[]
  /** Currently selected job id (drives the per-job settings editor). */
  selectedId: string | null
  defaults: JobDefaults
  global: GlobalCarveSettings
  /** Bumped whenever the job list / settings change → live-generate trigger. */
  rev: number

  /** Import a mesh as a NEW job (inherits current defaults). Returns its id. */
  addJob: (mesh: StlMesh, name: string) => string
  /** Clone an existing job (mesh shared, settings copied). Returns the new id. */
  duplicateJob: (id: string) => string | null
  removeJob: (id: string) => void
  selectJob: (id: string) => void
  /** Patch one job's settings. */
  updateJob: (id: string, patch: Partial<Omit<CarveJob, 'id' | 'mesh'>>) => void
  /** Patch one job's placement (move/rotate/scale). */
  setJobPlacement: (id: string, p: Partial<Placement>) => void
  /** Patch one job's speeds. */
  setJobSpeeds: (id: string, s: Partial<JobSpeeds>) => void
  /** Patch one job's stock. */
  setJobStock: (id: string, s: Partial<JobStock>) => void
  /** Apply one settings key from the selected job to ALL jobs. */
  applyToAll: (key: ApplyAllKey) => void
  setGlobal: (g: Partial<GlobalCarveSettings>) => void
  setDefaults: (d: Partial<Omit<JobDefaults, 'speeds'>> & { speeds?: Partial<JobSpeeds> }) => void
  /** Re-pack all enabled jobs' footprints onto the bed (assigns placement.dx/dy). */
  renest: (bedW: number, bedH: number) => { overflow: boolean; warnings: string[] }
  clear: () => void
}

/** Which setting "apply to all jobs" copies from the selected job. */
export type ApplyAllKey =
  | 'material'
  | 'speeds'
  | 'roughing'
  | 'finishing'
  | 'finishDir'
  | 'maxDepth'
  | 'stepover'
  | 'stock'

let seq = 0
function nextId(): string {
  seq += 1
  return `job-${Date.now().toString(36)}-${seq}`
}

/** Auto stock dims from a mesh bbox (XY footprint + Z thickness), clamped ≥1mm. */
function stockFromMesh(mesh: StlMesh): JobStock {
  const w = mesh.bbox.max[0] - mesh.bbox.min[0]
  const d = mesh.bbox.max[1] - mesh.bbox.min[1]
  const h = mesh.bbox.max[2] - mesh.bbox.min[2]
  return {
    width: Math.max(1, Math.round(w * 10) / 10),
    depth: Math.max(1, Math.round(d * 10) / 10),
    height: Math.max(1, Math.round(h * 10) / 10),
  }
}

function makeJob(mesh: StlMesh, name: string, d: JobDefaults): CarveJob {
  return {
    id: nextId(),
    name,
    mesh,
    enabled: true,
    material: d.material,
    stock: stockFromMesh(mesh),
    speeds: { ...d.speeds },
    placement: { ...IDENTITY_PLACEMENT },
    roughing: d.roughing,
    finishing: d.finishing,
    finishDir: d.finishDir,
    maxDepth: d.maxDepth,
    stepover: d.stepover,
  }
}

export const useCarveJobs = create<CarveJobsState>((set, get) => ({
  jobs: [],
  selectedId: null,
  defaults: { ...DEFAULT_JOB_DEFAULTS, speeds: { ...DEFAULT_JOB_DEFAULTS.speeds } },
  global: { ...DEFAULT_GLOBAL },
  rev: 0,

  addJob: (mesh, name) => {
    const job = makeJob(mesh, name, get().defaults)
    set((st) => ({ jobs: [...st.jobs, job], selectedId: job.id, rev: st.rev + 1 }))
    return job.id
  },

  duplicateJob: (id) => {
    const src = get().jobs.find((j) => j.id === id)
    if (!src) return null
    const copy: CarveJob = {
      ...src,
      id: nextId(),
      name: src.name.replace(/\s*\(copy( \d+)?\)$/i, '') + ' (copy)',
      speeds: { ...src.speeds },
      stock: { ...src.stock },
      placement: { ...src.placement },
    }
    set((st) => ({ jobs: [...st.jobs, copy], selectedId: copy.id, rev: st.rev + 1 }))
    return copy.id
  },

  removeJob: (id) =>
    set((st) => {
      const jobs = st.jobs.filter((j) => j.id !== id)
      const selectedId =
        st.selectedId === id ? (jobs.length ? jobs[jobs.length - 1].id : null) : st.selectedId
      return { jobs, selectedId, rev: st.rev + 1 }
    }),

  selectJob: (id) => set({ selectedId: id }),

  updateJob: (id, patch) =>
    set((st) => ({
      jobs: st.jobs.map((j) => (j.id === id ? { ...j, ...patch } : j)),
      rev: st.rev + 1,
    })),

  setJobPlacement: (id, p) =>
    set((st) => ({
      jobs: st.jobs.map((j) => (j.id === id ? { ...j, placement: { ...j.placement, ...p } } : j)),
      rev: st.rev + 1,
    })),

  setJobSpeeds: (id, s) =>
    set((st) => ({
      jobs: st.jobs.map((j) => (j.id === id ? { ...j, speeds: { ...j.speeds, ...s } } : j)),
      rev: st.rev + 1,
    })),

  setJobStock: (id, s) =>
    set((st) => ({
      jobs: st.jobs.map((j) => (j.id === id ? { ...j, stock: { ...j.stock, ...s } } : j)),
      rev: st.rev + 1,
    })),

  applyToAll: (key) =>
    set((st) => {
      const sel = st.jobs.find((j) => j.id === st.selectedId)
      if (!sel) return {}
      const jobs = st.jobs.map((j) => {
        if (j.id === sel.id) return j
        switch (key) {
          case 'speeds':
            return { ...j, speeds: { ...sel.speeds } }
          case 'stock':
            return { ...j, stock: { ...sel.stock } }
          case 'material':
            return { ...j, material: sel.material }
          case 'roughing':
            return { ...j, roughing: sel.roughing }
          case 'finishing':
            return { ...j, finishing: sel.finishing }
          case 'finishDir':
            return { ...j, finishDir: sel.finishDir }
          case 'maxDepth':
            return { ...j, maxDepth: sel.maxDepth }
          case 'stepover':
            return { ...j, stepover: sel.stepover }
          default:
            return j
        }
      })
      return { jobs, rev: st.rev + 1 }
    }),

  setGlobal: (g) => set((st) => ({ global: { ...st.global, ...g }, rev: st.rev + 1 })),

  setDefaults: (d) =>
    set((st) => ({
      defaults: { ...st.defaults, ...d, speeds: { ...st.defaults.speeds, ...(d.speeds ?? {}) } },
    })),

  renest: (bedW, bedH) => {
    const st = get()
    const active = st.jobs.filter((j) => j.enabled)
    if (active.length === 0) return { overflow: false, warnings: [] }

    // SINGLE job: leave it exactly where the operator placed it (the X/Y=0
    // default, or wherever they nudged it). Never auto-rotate a single job —
    // there is no material to save by turning one part.
    if (active.length === 1) {
      const j = active[0]
      const fp = meshFootprint(j.mesh, { rotDeg: j.placement.rotDeg, scale: j.placement.scale })
      const overflow = fp.w > bedW || fp.h > bedH
      return {
        overflow,
        warnings: overflow
          ? ['Job is larger than the bed — shrink it or use a bigger bed.']
          : [],
      }
    }

    const margin = st.global.nestMargin
    // Feed each job's footprint at its CURRENT scale but BASE rotation (the
    // nester may add a 90°-class turn to pack tighter; pass the job's existing
    // rotation as `rotDeg` so the reported rotation is absolute).
    const items = active.map((j) => {
      const fp = meshFootprint(j.mesh, { rotDeg: j.placement.rotDeg, scale: j.placement.scale })
      return { id: j.id, w: fp.w, h: fp.h, rotDeg: j.placement.rotDeg }
    })
    const res = nestFootprints(items, { bedW, bedH, margin, rotations: [0, 90] })

    // Map each packed footprint's bottom-left corner into work coordinates.
    // The viewer/work origin is the bed CENTRE, so shift the packed block (which
    // sits in [0..bedW]×[0..bedH]) to be centred on the origin, then translate
    // each job from its mesh's own footprint min corner to the packed slot.
    const jobs = st.jobs.map((j) => {
      const slot = res.placements.find((p) => p.id === j.id)
      if (!slot) return j
      // The nester may have chosen a tighter rotation — adopt it, and use the
      // post-rotation footprint dims (returned by the nester) for centring.
      const rotDeg = slot.rotDeg
      const fpW = slot.w
      const fpH = slot.h
      // Footprint centre at the packed slot centre, re-centred on the bed origin.
      const slotCx = slot.x + fpW / 2 - bedW / 2
      const slotCy = slot.y + fpH / 2 - bedH / 2
      // The job's design centre is its mesh bbox centre; placement.dx/dy move
      // that centre. Carving emits in the mesh's own coords, so we need the
      // translation that brings the mesh footprint centre to slotC.
      const meshCx = (j.mesh.bbox.min[0] + j.mesh.bbox.max[0]) / 2
      const meshCy = (j.mesh.bbox.min[1] + j.mesh.bbox.max[1]) / 2
      return {
        ...j,
        placement: { ...j.placement, rotDeg, dx: slotCx - meshCx, dy: slotCy - meshCy },
      }
    })
    set({ jobs, rev: st.rev + 1 })
    return { overflow: res.overflow, warnings: res.warnings }
  },

  clear: () => {
    clearPersistedCarveJobs()
    set((st) => ({ jobs: [], selectedId: null, rev: st.rev + 1 }))
  },
}))

// ---------------------------------------------------------------------------
// IndexedDB persistence wiring (best-effort, never blocks the UI).
// ---------------------------------------------------------------------------

/** True once the initial hydrate has resolved, so we don't save over the
 *  persisted snapshot before we've loaded it (a save fired during hydration
 *  could otherwise clobber the saved jobs with the empty initial state). */
let hydrated = false

// Persist on any meaningful change. We subscribe to the whole state and write a
// snapshot of the persisted slices; the debounce in carveJobsPersist coalesces
// bursts. `clear()` handles its own deletion, so an empty list after clear is
// simply saved as empty (harmless).
useCarveJobs.subscribe((st) => {
  if (!hydrated) return
  saveCarveJobs({
    jobs: st.jobs,
    selectedId: st.selectedId,
    defaults: st.defaults,
    global: st.global,
  })
})

// Hydrate once at startup: restore previously imported models + settings so a
// page reload (or PWA update) doesn't lose the operator's work.
void hydrateCarveJobs()
  .then((snap) => {
    if (snap) {
      useCarveJobs.setState((st) => ({
        jobs: snap.jobs,
        selectedId: snap.selectedId,
        defaults: snap.defaults,
        global: snap.global,
        rev: st.rev + 1,
      }))
    }
  })
  .catch(() => {
    /* persistence is best-effort; ignore */
  })
  .finally(() => {
    hydrated = true
  })
