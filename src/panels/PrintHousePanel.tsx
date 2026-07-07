import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useMachine, useProgram, usePersistentState } from '../store'
import { useT } from '../i18n'
import { InfoTip } from '../components/InfoTip'
import { SaveLoadButtons } from '../components/SaveLoadButtons'
import { Icon } from '../components/Icons'
import { CamEmpty, CamStatus } from '../components/cam/CamUI'
import { SegControl } from '../components/ui/SegControl'
import { SliderField } from '../components/ui/SliderField'
import { importVectorFile, VECTOR_ACCEPT, type ImportedPath } from '../core/vectorImport'
import '../styles/cam.css'
import '../styles/printhouse.css'

// ════════════════════════════════════════════════════════════════════════════
//  PURE plan → walls → layered G-code core (NO React / DOM below this line, up
//  to the panel). A construction / contour-crafting printer that extrudes
//  concrete/mortar in stacked layers along the WALL outlines of an architectural
//  floor plan. The spindle output is repurposed as the CONCRETE PUMP (M3 on /
//  M5 off); an optional E-axis model advances filament-style extrusion instead.
//  Safety mirrors the rest of the CAM core: a G21/G90/G94 header, pump-off before
//  any travel, a raise/park + M5 + M30 footer, and number formatting that never
//  emits "-0.000".
// ════════════════════════════════════════════════════════════════════════════

/** A point in the bed (XY) plane, millimetres in the machine frame. */
interface Pt {
  x: number
  y: number
}

/** One imported WALL — a plan-space polyline (Y-up) that becomes a wall outline. */
export interface Wall {
  id: string
  name: string
  /** Vertices in the plan's own units (Y-up). Curves already flattened. */
  points: Pt[]
  /** Closed loop (offset for perimeters is only applied to closed walls). */
  closed: boolean
}

/** A rectangular door/window OPENING where extrusion is skipped over a Z band.
 *  (x, y) is the opening CENTRE in the footprint (metres); w is its size (metres);
 *  extrusion is skipped for layers whose Z ∈ [sill, sill + height] (metres). */
export interface Opening {
  id: string
  x: number
  y: number
  w: number
  sill: number
  height: number
}

/** Plan metadata captured on import (name + combined plan-space bounds). */
export interface PlanMeta {
  name: string
  bounds: { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }
}

/** Global house-print policy. Lengths are metres unless the field says mm. */
export interface HouseParams {
  /** How the arbitrary plan units map to the real world. */
  scaleMode: 'factor' | 'width'
  /** metres per plan unit (factor mode). */
  scaleFactor: number
  /** desired real footprint WIDTH in metres — maps bounds.w (width mode). */
  realWidthM: number
  /** finished wall height (m). */
  wallHeightM: number
  /** concrete layer height (mm; ~10–40). */
  layerHeightMm: number
  /** bead / nozzle width (mm; ~20–60). */
  beadWidthMm: number
  /** wall passes / perimeters (1–3) — a simple inward offset per pass. */
  perimeters: number
  /** print feed while extruding (mm/min). */
  printFeed: number
  /** travel feed for the time estimate (mm/min); travel is emitted as G0 rapids. */
  travelFeed: number
  /** extruder model: concrete PUMP (M3/M5) or an E extrusion axis. */
  extruder: 'pump' | 'e'
  /** pump flow S value emitted as M3 S<flow> (pump model). */
  flowS: number
  /** E volumetric multiplier (E model): E advance = length × bead area × this. */
  eFlow: number
  /** emitted-coordinate decimal places (0..6). */
  decimals: number
}

let idSeq = 0
/** Reasonably-unique id for a fresh wall / opening. */
export function newHouseId(): string {
  idSeq += 1
  return `h${Date.now().toString(36)}_${idSeq.toString(36)}`
}

/** Default global params. */
export function defaultHouseParams(): HouseParams {
  return {
    scaleMode: 'width',
    scaleFactor: 0.001,
    realWidthM: 10,
    wallHeightM: 3,
    layerHeightMm: 20,
    beadWidthMm: 40,
    perimeters: 2,
    printFeed: 1500,
    travelFeed: 3000,
    extruder: 'pump',
    flowS: 700,
    eFlow: 1,
    decimals: 3,
  }
}

// ─────────────────────────── geometry helpers ───────────────────────────

const near = (a: Pt, b: Pt): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6

/** Normalize a plan path into a clean ring: drop a trailing duplicate of the
 * first vertex on closed paths so `closed` alone drives closure. */
export function cleanRing(points: Pt[], closed: boolean): Pt[] {
  const out = points.map((p) => ({ x: p.x, y: p.y }))
  if (closed && out.length > 1 && near(out[0], out[out.length - 1])) out.pop()
  return out
}

/** Total length of a polyline (mm). Closed rings include the closing edge. */
export function ringLength(points: Pt[], closed: boolean): number {
  let L = 0
  for (let i = 1; i < points.length; i++) L += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  if (closed && points.length > 2) {
    const a = points[points.length - 1]
    const b = points[0]
    L += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return L
}

function signedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return a / 2
}

function unit(dx: number, dy: number): Pt {
  const l = Math.hypot(dx, dy)
  return l < 1e-12 ? { x: 0, y: 0 } : { x: dx / l, y: dy / l }
}

/**
 * A simple INWARD offset of a closed polygon by `dist` (mm), used for the extra
 * wall perimeters (a double-wall cavity). Each vertex moves along the averaged,
 * miter-corrected inward edge normal. This is an MVP offset — good for the
 * mostly-rectilinear footprints real plans use; if it would self-intersect
 * (the offset flips orientation) it falls back to the original ring. Open walls
 * are NOT offset (perimeters just repeat the outline for a thicker single wall).
 */
export function offsetClosedPolygon(pts: Pt[], dist: number): Pt[] {
  const n = pts.length
  if (n < 3 || dist <= 0) return pts.map((p) => ({ ...p }))
  const area = signedArea(pts)
  if (Math.abs(area) < 1e-6) return pts.map((p) => ({ ...p }))
  const s = area >= 0 ? 1 : -1 // CCW interior is on the left of each directed edge
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n]
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    const e1 = unit(cur.x - prev.x, cur.y - prev.y)
    const e2 = unit(next.x - cur.x, next.y - cur.y)
    // inward normal of a directed edge = left-normal (−dy, dx), flipped by orientation
    const n1 = { x: -e1.y * s, y: e1.x * s }
    const n2 = { x: -e2.y * s, y: e2.x * s }
    let mx = n1.x + n2.x
    let my = n1.y + n2.y
    const ml = Math.hypot(mx, my)
    if (ml < 1e-9) {
      out.push({ ...cur })
      continue
    }
    mx /= ml
    my /= ml
    const cosHalf = mx * n1.x + my * n1.y
    const scale = cosHalf > 0.25 ? dist / cosHalf : dist
    out.push({ x: cur.x + mx * scale, y: cur.y + my * scale })
  }
  // Guard: if the offset collapsed or flipped orientation, keep the original.
  if (signedArea(out) * area <= 0) return pts.map((p) => ({ ...p }))
  return out
}

// ─────────────────────────── G-code ───────────────────────────

/** Clamp decimals into the range toFixed() accepts (0..6). */
function clampDecimals(n: number): number {
  if (!Number.isFinite(n)) return 3
  return Math.min(6, Math.max(0, Math.floor(n)))
}

/** Formatted number, never "-0.000". */
function fmt(value: number, decimals: number): string {
  const d = clampDecimals(decimals)
  const snap = 0.5 * Math.pow(10, -d)
  let v = value
  if (Math.abs(v) < snap) v = 0
  if (v === 0) v = 0
  return v.toFixed(d)
}

/** A wall already transformed into the machine frame (mm). */
export interface WallMm {
  points: Pt[]
  closed: boolean
}

/** An opening pre-resolved to machine-frame millimetres. */
export interface OpeningMm {
  cx: number
  cy: number
  half: number
  sillMm: number
  topMm: number
}

/** The build result: the program plus stats for the readouts. */
export interface BuiltHouse {
  gcode: string
  beadLenMm: number
  travelLenMm: number
  layerCount: number
}

/** Safety cap on layer count so a mis-scaled plan can't emit a runaway program. */
const LAYER_CAP = 2000

/**
 * Emit a complete, safe, LAYERED house-print program.
 *
 * Header `G21 G90 G94` + pump-off (pump model) / `M83` relative extrusion (E
 * model). Then FOR each layer Z from one layerHeight up to wallHeight: raise to
 * Z (pump off), and for every wall perimeter → rapid (pump OFF, `G0`) to its
 * start, then trace the outline extruding (pump ON) at the print feed, skipping
 * any span that falls inside a door/window opening active at this Z (the pump
 * lifts over the gap). Footer: pump off, raise/park, `M5`, `M30`.
 */
export function buildHouse(walls: WallMm[], params: HouseParams, openings: OpeningMm[]): BuiltHouse {
  const d = clampDecimals(params.decimals)
  const F = (v: number) => fmt(v, d)
  const o: string[] = []
  const usePump = params.extruder === 'pump'
  const beadW = Math.max(0, params.beadWidthMm)
  const layerH = Math.max(0.01, params.layerHeightMm)
  const beadArea = beadW * layerH // mm² bead cross-section
  const wallHeightMm = Math.max(0, params.wallHeightM * 1000)
  const rawLayers = Math.floor((wallHeightMm + 1e-6) / layerH)
  const layerCount = Math.max(0, Math.min(LAYER_CAP, rawLayers))
  const perims = Math.max(1, Math.min(3, Math.round(params.perimeters)))
  const printFeed = Math.max(1, params.printFeed)
  const flow = Math.max(0, Math.round(params.flowS))
  const eFlow = Math.max(0, params.eFlow)
  let beadLenMm = 0
  let travelLenMm = 0

  // Pre-compute the perimeter rings per wall (Z-independent). Perimeter 0 is the
  // imported outline; each extra perimeter is inset inward by one bead width
  // (closed walls only — open walls repeat the outline for a thicker wall).
  const wallRings = walls.map((w) => {
    const base = w.points
    const rings: WallMm[] = []
    for (let p = 0; p < perims; p++) {
      const inset = p * beadW
      const pts = p > 0 && w.closed ? offsetClosedPolygon(base, inset) : base
      rings.push({ points: pts, closed: w.closed })
    }
    return rings
  })

  const inOpening = (x: number, y: number, z: number): boolean => {
    for (const op of openings) {
      if (z >= op.sillMm && z <= op.topMm && Math.abs(x - op.cx) <= op.half && Math.abs(y - op.cy) <= op.half) {
        return true
      }
    }
    return false
  }

  // ---- Header -----------------------------------------------------------
  o.push('(karmyogi 3D Print House — contour crafting)')
  o.push('(Generated by karmyogi.hjLabs.in Print House)')
  o.push('(CAUTION: large machine + wet concrete — verify SCALE before printing)')
  o.push(`(footprint layers: ${layerCount}, perimeters: ${perims}, bead ${F(beadW)}mm)`)
  o.push('G21') // mm
  o.push('G90') // absolute
  o.push('G94') // feed per minute
  if (usePump) o.push('M5') // pump off to start
  else o.push('M83') // relative extrusion for the E model

  let pumpOn = false
  const pumpOff = () => {
    if (usePump && pumpOn) {
      o.push('M5')
      pumpOn = false
    }
  }
  const pumpOnCmd = () => {
    if (usePump && !pumpOn) {
      o.push(flow > 0 ? `M3 S${flow}` : 'M3')
      pumpOn = true
    }
  }
  let feedWritten = false

  for (let li = 0; li < layerCount; li++) {
    const z = (li + 1) * layerH // first bead sits one layer height above the bed
    o.push(`(layer ${li + 1}/${layerCount} Z${F(z)})`)
    pumpOff()
    o.push(`G0 Z${F(z)}`) // raise to this layer's Z before any XY travel
    for (const rings of wallRings) {
      for (const ring of rings) {
        const pts = ring.points
        if (pts.length < 2) continue
        const seq = ring.closed ? [...pts, pts[0]] : pts
        pumpOff()
        o.push(`G0 X${F(seq[0].x)} Y${F(seq[0].y)}`) // rapid (pump off) to the wall start
        for (let i = 1; i < seq.length; i++) {
          const a = seq[i - 1]
          const b = seq[i]
          const segLen = Math.hypot(b.x - a.x, b.y - a.y)
          if (segLen < 1e-6) continue
          const skip = inOpening(a.x, a.y, z) || inOpening(b.x, b.y, z)
          if (skip) {
            // Opening span at this Z: lift over the gap (pump off, rapid across).
            pumpOff()
            o.push(`G0 X${F(b.x)} Y${F(b.y)}`)
            travelLenMm += segLen
          } else {
            pumpOnCmd()
            let line = `G1 X${F(b.x)} Y${F(b.y)}`
            if (!usePump) {
              const e = segLen * beadArea * eFlow
              line += ` E${F(e)}`
            }
            if (!feedWritten) {
              line += ` F${F(printFeed)}`
              feedWritten = true
            }
            o.push(line)
            beadLenMm += segLen
          }
        }
      }
    }
  }

  // ---- Footer -----------------------------------------------------------
  pumpOff()
  const parkZ = Math.max(wallHeightMm + 50, layerCount * layerH + 50)
  o.push(`G0 Z${F(parkZ)}`) // raise / park clear of the printed wall
  if (usePump) o.push('M5')
  o.push('M30')
  return { gcode: o.join('\n') + '\n', beadLenMm, travelLenMm, layerCount }
}

// ════════════════════════════════════════════════════════════════════════════
//  React panel
// ════════════════════════════════════════════════════════════════════════════

const num = (v: string, fallback: number): number => {
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}

/** Human-readable duration from seconds. */
function fmtDuration(totalSeconds: number, t: ReturnType<typeof useT>): string {
  const s = Math.max(0, Math.round(totalSeconds))
  if (s < 60) return t('time.seconds', '{s} s', { s })
  const m = Math.floor(s / 60)
  const rem = s % 60
  if (m < 60) return t('time.minSec', '{m} m {s} s', { m, s: rem })
  const h = Math.floor(m / 60)
  const mm = m % 60
  return t('time.hourMin', '{h} h {m} m', { h, m: mm })
}

// ---- persisted-doc validation --------------------------------------------
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const numOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fb)

function parsePt(v: unknown): Pt | null {
  if (!isRecord(v)) return null
  const x = numOr(v.x, NaN)
  const y = numOr(v.y, NaN)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

function parseWall(v: unknown): Wall | null {
  if (!isRecord(v)) return null
  const raw = Array.isArray(v.points) ? v.points : []
  const points: Pt[] = []
  for (const r of raw) {
    const p = parsePt(r)
    if (p) points.push(p)
  }
  if (points.length < 2) return null
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : newHouseId(),
    name: typeof v.name === 'string' ? v.name : 'Wall',
    points,
    closed: typeof v.closed === 'boolean' ? v.closed : false,
  }
}

function parseOpening(v: unknown): Opening | null {
  if (!isRecord(v)) return null
  return {
    id: typeof v.id === 'string' && v.id.length > 0 ? v.id : newHouseId(),
    x: numOr(v.x, 0),
    y: numOr(v.y, 0),
    w: Math.max(0, numOr(v.w, 1)),
    sill: Math.max(0, numOr(v.sill, 1)),
    height: Math.max(0, numOr(v.height, 1)),
  }
}

function parsePlan(v: unknown): PlanMeta | null {
  if (!isRecord(v) || !isRecord(v.bounds)) return null
  const b = v.bounds
  const minX = numOr(b.minX, NaN)
  const minY = numOr(b.minY, NaN)
  const maxX = numOr(b.maxX, NaN)
  const maxY = numOr(b.maxY, NaN)
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null
  return {
    name: typeof v.name === 'string' ? v.name : 'plan',
    bounds: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY },
  }
}

function parseHouseParams(v: unknown, base: HouseParams): HouseParams {
  if (!isRecord(v)) return { ...base, decimals: clampDecimals(base.decimals) }
  return {
    scaleMode: v.scaleMode === 'factor' ? 'factor' : 'width',
    scaleFactor: Math.max(1e-9, numOr(v.scaleFactor, base.scaleFactor)),
    realWidthM: Math.max(0.1, numOr(v.realWidthM, base.realWidthM)),
    wallHeightM: Math.max(0, numOr(v.wallHeightM, base.wallHeightM)),
    layerHeightMm: Math.max(1, numOr(v.layerHeightMm, base.layerHeightMm)),
    beadWidthMm: Math.max(1, numOr(v.beadWidthMm, base.beadWidthMm)),
    perimeters: Math.max(1, Math.min(3, Math.round(numOr(v.perimeters, base.perimeters)))),
    printFeed: Math.max(1, numOr(v.printFeed, base.printFeed)),
    travelFeed: Math.max(1, numOr(v.travelFeed, base.travelFeed)),
    extruder: v.extruder === 'e' ? 'e' : 'pump',
    flowS: Math.max(0, numOr(v.flowS, base.flowS)),
    eFlow: Math.max(0, numOr(v.eFlow, base.eFlow)),
    decimals: clampDecimals(numOr(v.decimals, base.decimals)),
  }
}

/** The serializable Print-House document written by Save / read by Load. */
interface HouseDoc {
  kind: 'karmyogi.printhouse'
  version: 1
  plan: PlanMeta | null
  walls: Wall[]
  openings: Opening[]
  params: HouseParams
}

/**
 * 3D Print House panel — a construction / contour-crafting planner. Import a 2D
 * architectural FLOOR PLAN (SVG/DXF); its lines & polylines become WALL outlines.
 * A plan-scale control maps the arbitrary plan units to a real footprint (a scale
 * factor, or "set real building width"). The house is then printed as stacked
 * concrete/mortar layers along the walls: for every layer Z the pump traces each
 * wall (multiple perimeters give a double-wall cavity) and lifts over any
 * door/window opening. The spindle output drives the concrete PUMP (M3 on / M5
 * off), or an optional E axis. The pure `buildHouse` core emits a safe layered
 * program; generation is live — every edit pushes a fresh program into the shared
 * store under the `'printhouse'` section (Visualizer renders / Program streams).
 */
export function PrintHousePanel() {
  const t = useT()
  const connected = useMachine((s) => s.connection === 'connected')
  const setProgram = useProgram((s) => s.setProgram)
  const removeSection = useProgram((s) => s.removeSection)
  const streaming = useProgram((s) => s.streaming)

  const [plan, setPlan] = usePersistentState<PlanMeta | null>('karmyogi.printhouse.plan', null)
  const [walls, setWalls] = usePersistentState<Wall[]>('karmyogi.printhouse.walls', [])
  const [openings, setOpenings] = usePersistentState<Opening[]>('karmyogi.printhouse.openings', [])
  const [selected, setSelected] = usePersistentState<string>('karmyogi.printhouse.selectedId', '')
  const [params, setParams] = usePersistentState<HouseParams>('karmyogi.printhouse.params', defaultHouseParams())
  const [defaultsOpen, setDefaultsOpen] = usePersistentState<boolean | null>('karmyogi.printhouse.defaultsOpen', null)
  const [loadError, setLoadError] = useState<string>('')
  const [importWarn, setImportWarn] = useState<string>('')

  const fileRef = useRef<HTMLInputElement>(null)

  // Sanitize PERSISTED decimals once on mount (a restored value bypasses the
  // input/load guards and could otherwise reach toFixed()).
  useEffect(() => {
    if (clampDecimals(params.decimals) !== params.decimals) {
      setParams((p) => ({ ...p, decimals: clampDecimals(p.decimals) }))
    }
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── floor-plan import ──
  async function onFileInput(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setLoadError('')
    setImportWarn('')
    try {
      const r = importVectorFile(f.name, await f.text())
      if (!r.ok || !r.bounds) {
        setLoadError(r.error ?? t('ph.import.failed', 'Could not read the floor plan.'))
        return
      }
      const nextWalls: Wall[] = r.paths.map((p: ImportedPath, i) => ({
        id: newHouseId(),
        name: t('ph.wall.name', 'Wall {n}', { n: i + 1 }),
        points: cleanRing(p.points, p.closed),
        closed: p.closed,
      }))
      setPlan({ name: f.name, bounds: r.bounds })
      setWalls(nextWalls)
      setSelected(nextWalls.length ? nextWalls[0].id : '')
      if (r.warnings.length) setImportWarn(r.warnings.join(' '))
    } catch (err) {
      setLoadError(t('ph.import.error', 'Failed to read plan: {msg}', { msg: err instanceof Error ? err.message : String(err) }))
    }
  }

  // ── wall + opening CRUD ──
  function deleteWall(id: string) {
    setWalls((s) => s.filter((w) => w.id !== id))
    setSelected((sel) => (sel === id ? '' : sel))
  }
  function toggleClosed(id: string) {
    setWalls((s) => s.map((w) => (w.id === id ? { ...w, closed: !w.closed } : w)))
  }
  function clearAll() {
    if (walls.length === 0 && !plan) return
    if (!window.confirm(t('ph.clearConfirm', 'Clear the floor plan and all {n} wall(s)?', { n: walls.length }))) return
    setWalls([])
    setOpenings([])
    setPlan(null)
    setSelected('')
  }

  function addOpening() {
    setOpenings((s) => [...s, { id: newHouseId(), x: fp ? fp.wM / 2 : 2, y: fp ? fp.hM / 2 : 2, w: 1, sill: 1, height: 2 }])
  }
  function updateOpening(id: string, patch: Partial<Opening>) {
    setOpenings((s) => s.map((op) => (op.id === id ? { ...op, ...patch } : op)))
  }
  function deleteOpening(id: string) {
    setOpenings((s) => s.filter((op) => op.id !== id))
  }

  // ── scale + derived geometry (mm) ──
  const bounds = plan?.bounds ?? null
  // Millimetres of machine travel per plan unit.
  const mmPerUnit = useMemo(() => {
    if (params.scaleMode === 'width' && bounds && bounds.w > 1e-9) {
      return (Math.max(0.1, params.realWidthM) * 1000) / bounds.w
    }
    return Math.max(1e-9, params.scaleFactor) * 1000
  }, [params.scaleMode, params.realWidthM, params.scaleFactor, bounds])

  // Real footprint (m × m).
  const fp = useMemo(() => {
    if (!bounds) return null
    return { wM: (bounds.w * mmPerUnit) / 1000, hM: (bounds.h * mmPerUnit) / 1000 }
  }, [bounds, mmPerUnit])

  // Walls transformed into the machine frame (mm), origin at the footprint min.
  const wallsMm = useMemo<WallMm[]>(() => {
    if (!bounds) return []
    return walls.map((w) => ({
      closed: w.closed,
      points: w.points.map((p) => ({ x: (p.x - bounds.minX) * mmPerUnit, y: (p.y - bounds.minY) * mmPerUnit })),
    }))
  }, [walls, bounds, mmPerUnit])

  // Openings pre-resolved to machine-frame millimetres.
  const openingsMm = useMemo<OpeningMm[]>(
    () =>
      openings.map((op) => ({
        cx: op.x * 1000,
        cy: op.y * 1000,
        half: (Math.max(0, op.w) * 1000) / 2,
        sillMm: op.sill * 1000,
        topMm: (op.sill + op.height) * 1000,
      })),
    [openings],
  )

  // Live build (G-code + stats).
  const built = useMemo(() => buildHouse(wallsMm, params, openingsMm), [wallsMm, params, openingsMm])
  const gcode = built.gcode

  const lineCount = useMemo(() => gcode.split(/\r?\n/).filter((l) => l.trim().length > 0).length, [gcode])
  const effectiveLines = walls.length === 0 ? 0 : lineCount
  const totalPathM = built.beadLenMm / 1000
  const estSeconds = useMemo(
    () => (built.beadLenMm / Math.max(1, params.printFeed)) * 60 + (built.travelLenMm / Math.max(1, params.travelFeed)) * 60,
    [built.beadLenMm, built.travelLenMm, params.printFeed, params.travelFeed],
  )
  // Rough concrete volume (m³) = bead length × bead width × layer height.
  const concreteM3 = totalPathM * (params.beadWidthMm / 1000) * (params.layerHeightMm / 1000)

  // Live generation → shared store (debounced), dropping the section when empty.
  useEffect(() => {
    if (streaming) return
    if (!walls.length) {
      removeSection('printhouse')
      return
    }
    const id = window.setTimeout(() => setProgram('printhouse', gcode), 300)
    return () => window.clearTimeout(id)
  }, [gcode, walls.length, setProgram, removeSection, streaming])

  // ── Save / Load document ──
  const doc: HouseDoc = { kind: 'karmyogi.printhouse', version: 1, plan, walls, openings, params }
  function loadDoc(data: unknown) {
    if (!isRecord(data)) {
      setLoadError(t('ph.load.bad', 'Could not load — not a valid print-house file.'))
      return
    }
    const nextParams = parseHouseParams(data.params, params)
    if (Array.isArray(data.walls)) {
      const next: Wall[] = []
      for (const raw of data.walls) {
        const w = parseWall(raw)
        if (w) next.push(w)
      }
      setWalls(next)
      setSelected(next.length ? next[0].id : '')
    }
    if (Array.isArray(data.openings)) {
      const next: Opening[] = []
      for (const raw of data.openings) {
        const op = parseOpening(raw)
        if (op) next.push(op)
      }
      setOpenings(next)
    }
    setPlan(parsePlan(data.plan))
    setParams(nextParams)
    setLoadError('')
  }

  const defaultsEffectiveOpen = defaultsOpen ?? walls.length === 0
  const toggleDefaults = () => setDefaultsOpen(!defaultsEffectiveOpen)

  return (
    <div className="ph-panel">
      {/* Slim header: title + icon toolbar. */}
      <header className="ph-head">
        <div className="ph-head-title">
          <span className="ph-head-name">{t('ph.title', '3D Print House')}</span>
          <InfoTip
            topic="phMode"
            title={t('ph.title', '3D Print House')}
            body={t(
              'ph.intro',
              'A construction / contour-crafting printer: import a 2D architectural floor plan (SVG/DXF) whose lines become WALLS, set the real-world scale, then print the house as stacked concrete/mortar layers along every wall. Multiple perimeters build a double-wall cavity; door/window openings are lifted over. The spindle output drives the concrete pump (M3 on / M5 off). Auto-syncs to the Program tab.',
            )}
          />
        </div>
        <div className="ph-tools">
          <button
            type="button"
            className="ph-ico ph-ico-primary"
            onClick={() => fileRef.current?.click()}
            title={t('ph.toolbar.load', 'Load floor plan (SVG/DXF)')}
            aria-label={t('ph.toolbar.load', 'Load floor plan (SVG/DXF)')}
          >
            <Icon name="upload" size={15} />
          </button>
          <input
            ref={fileRef}
            className="ph-file-input"
            type="file"
            accept={VECTOR_ACCEPT}
            onChange={onFileInput}
          />
          <span className="ph-tools-sep" aria-hidden="true" />
          <button
            type="button"
            className={`ph-ico${defaultsEffectiveOpen ? ' is-active' : ''}`}
            onClick={toggleDefaults}
            aria-expanded={defaultsEffectiveOpen}
            title={t('ph.toolbar.settings', 'House print settings')}
            aria-label={t('ph.toolbar.settings', 'House print settings')}
          >
            <Icon name="settings" size={15} />
          </button>
          <span className="ph-tools-sep" aria-hidden="true" />
          <SaveLoadButtons
            value={doc}
            onLoad={loadDoc}
            onError={setLoadError}
            fileBase="karmyogi-printhouse"
            ext="khouse"
            saveDisabled={walls.length === 0}
            saveTitle={t('ph.toolbar.save', 'Save plan + settings')}
            loadTitle={t('ph.toolbar.loadDoc', 'Load plan + settings')}
          />
          <span className="ph-tools-sep" aria-hidden="true" />
          <button
            type="button"
            className="ph-ico ph-ico-danger"
            onClick={clearAll}
            disabled={walls.length === 0 && !plan}
            title={t('ph.toolbar.clear', 'Clear plan')}
            aria-label={t('ph.toolbar.clear', 'Clear plan')}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      </header>

      {/* Live status strip. */}
      <div className="ph-status">
        <CamStatus
          items={[
            {
              value: fp ? `${fp.wM.toFixed(2)}×${fp.hM.toFixed(2)}` : '—',
              unit: t('ph.status.footprint', 'm footprint'),
              title: t('ph.status.footprint.title', 'Real building footprint (width × depth) at the current plan scale.'),
            },
            { value: walls.length, unit: t('ph.status.walls', 'walls') },
            { value: built.layerCount, unit: t('ph.status.layers', 'layers') },
            {
              value: totalPathM.toFixed(1),
              unit: t('ph.status.path', 'm bead'),
              title: t('ph.status.path.title', 'Total extruded bead length across every layer.'),
            },
            {
              value: concreteM3.toFixed(2),
              unit: t('ph.status.volume', 'm³'),
              title: t('ph.status.volume.title', 'Rough concrete volume = bead length × bead width × layer height.'),
            },
            {
              value: fmtDuration(estSeconds, t),
              unit: t('ph.status.est', 'est.'),
              title: t('ph.status.est.title', 'Estimated print time (bead ÷ print feed + travel ÷ travel feed).'),
            },
            { value: effectiveLines, unit: t('ph.status.gcode', 'G-code lines') },
          ]}
        />
      </div>

      {/* Caution banner — always visible; this is a large, hazardous machine. */}
      <p className="ph-caution" role="note">
        <Icon name="warning" size={13} />
        <span>
          {t(
            'ph.caution',
            'Large construction machine + wet concrete. VERIFY the plan scale (footprint) and layer height on a dry run before printing — a mis-scaled plan moves the gantry metres.',
          )}
        </span>
      </p>

      {loadError && <p className="ph-warn">{loadError}</p>}
      {importWarn && <p className="ph-warn">{importWarn}</p>}
      {!connected && walls.length > 0 && (
        <p className="ph-warn">
          {t('ph.notConnected', 'Not connected — preview is live; connect from the Program tab to stream.')}
        </p>
      )}

      {/* Plan scale — always shown once a plan is loaded (this is the safety knob). */}
      {plan && (
        <div className="ph-card">
          <div className="ph-card-head">
            <h4>
              <Icon name="frame" size={14} className="cam-card-ico" /> {t('ph.scale.title', 'Plan scale')}
            </h4>
            <InfoTip
              topic="phScale"
              title={t('ph.scale.title', 'Plan scale')}
              body={t('ph.scale.body', 'Architectural plans arrive in arbitrary units. Either give the real building WIDTH (the plan is scaled so its footprint width matches), or a scale factor in metres per plan unit. The resulting footprint is shown live.')}
            />
          </div>
          <div className="ph-fields">
            <div className="ph-segrow">
              <span className="ph-segrow-lbl">{t('ph.scale.mode', 'Scale by')}</span>
              <SegControl<'width' | 'factor'>
                options={[
                  { value: 'width', label: t('ph.scale.byWidth', 'Real width') },
                  { value: 'factor', label: t('ph.scale.byFactor', 'Factor') },
                ]}
                value={params.scaleMode}
                onChange={(v) => setParams((p) => ({ ...p, scaleMode: v }))}
                ariaLabel={t('ph.scale.mode', 'Scale by')}
                variant="tonal"
                size="sm"
              />
            </div>
            {params.scaleMode === 'width' ? (
              <SliderField
                label={t('ph.scale.realWidth', 'Building width')}
                unit={t('unit.m', 'm')}
                min={1}
                max={60}
                step={0.5}
                value={params.realWidthM}
                onChange={(v) => setParams((p) => ({ ...p, realWidthM: Math.max(0.1, v) }))}
              />
            ) : (
              <SliderField
                label={t('ph.scale.factor', 'Metres / unit')}
                unit={t('unit.mPerUnit', 'm/u')}
                min={0.0001}
                max={1}
                step={0.0001}
                value={params.scaleFactor}
                onChange={(v) => setParams((p) => ({ ...p, scaleFactor: Math.max(1e-9, v) }))}
              />
            )}
            <div className="ph-footprint">
              {fp
                ? t('ph.scale.footprint', 'Footprint: {w} × {d} m', { w: fp.wM.toFixed(2), d: fp.hM.toFixed(2) })
                : t('ph.scale.noPlan', 'No plan loaded.')}
            </div>
          </div>
        </div>
      )}

      {/* Defaults / house-print settings disclosure. */}
      <button
        type="button"
        className="ph-defaults-toggle"
        data-open={defaultsEffectiveOpen}
        aria-expanded={defaultsEffectiveOpen}
        onClick={toggleDefaults}
      >
        <Icon name="settings" size={14} className="ph-defaults-ico" />
        <span className="ph-defaults-word">{t('ph.defaults.disclosure', 'House print settings')}</span>
        <span className="ui-caret" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
      </button>

      {defaultsEffectiveOpen && (
        <section className="ph-settings">
          {/* Walls & layers */}
          <div className="ph-card">
            <div className="ph-card-head">
              <h4>
                <Icon name="jog" size={14} className="cam-card-ico" /> {t('ph.layers.title', 'Walls & layers')}
              </h4>
              <InfoTip
                topic="phLayers"
                title={t('ph.layers.title', 'Walls & layers')}
                body={t('ph.layers.body', 'Wall height sets how many concrete layers are stacked (height ÷ layer height). Bead/nozzle width is the printed line thickness; perimeters lay that many passes, each inset one bead width, for a double-wall cavity.')}
              />
            </div>
            <div className="ph-fields">
              <SliderField
                label={t('ph.field.wallHeight', 'Wall height')}
                unit={t('unit.m', 'm')}
                min={0.2}
                max={8}
                step={0.1}
                value={params.wallHeightM}
                onChange={(v) => setParams((p) => ({ ...p, wallHeightM: Math.max(0, v) }))}
                title={t('ph.field.wallHeight.title', 'Finished wall height (m). Layers = height ÷ layer height.')}
              />
              <SliderField
                label={t('ph.field.layerHeight', 'Layer height')}
                unit={t('unit.mm', 'mm')}
                min={5}
                max={60}
                step={1}
                value={params.layerHeightMm}
                onChange={(v) => setParams((p) => ({ ...p, layerHeightMm: Math.max(1, v) }))}
                title={t('ph.field.layerHeight.title', 'Concrete layer height (mm) — typically 10–40 mm.')}
              />
              <SliderField
                label={t('ph.field.beadWidth', 'Bead width')}
                unit={t('unit.mm', 'mm')}
                min={10}
                max={100}
                step={1}
                value={params.beadWidthMm}
                onChange={(v) => setParams((p) => ({ ...p, beadWidthMm: Math.max(1, v) }))}
                title={t('ph.field.beadWidth.title', 'Extruded bead / nozzle width (mm) — typically 20–60 mm.')}
              />
              <SliderField
                label={t('ph.field.perimeters', 'Perimeters')}
                unit={t('unit.walls', 'passes')}
                min={1}
                max={3}
                step={1}
                value={params.perimeters}
                onChange={(v) => setParams((p) => ({ ...p, perimeters: Math.max(1, Math.min(3, Math.round(v))) }))}
                title={t('ph.field.perimeters.title', 'Wall passes (1–3). Extra passes are inset one bead width for a cavity wall.')}
              />
            </div>
          </div>

          {/* Feeds */}
          <div className="ph-card">
            <div className="ph-card-head">
              <h4>
                <Icon name="jog" size={14} className="cam-card-ico" /> {t('ph.feeds.title', 'Feeds')}
              </h4>
              <InfoTip
                topic="phFeeds"
                title={t('ph.feeds.title', 'Feeds')}
                body={t('ph.feeds.body', 'Print feed is the speed while extruding concrete along a wall. Travel feed is used for the time estimate — travel between walls is emitted as G0 rapids with the pump off.')}
              />
            </div>
            <div className="ph-fields">
              <SliderField
                label={t('ph.field.printFeed', 'Print feed')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={100}
                max={6000}
                step={50}
                value={params.printFeed}
                onChange={(v) => setParams((p) => ({ ...p, printFeed: Math.max(1, v) }))}
              />
              <SliderField
                label={t('ph.field.travelFeed', 'Travel feed')}
                unit={t('unit.mmPerMin', 'mm/min')}
                min={100}
                max={10000}
                step={100}
                value={params.travelFeed}
                onChange={(v) => setParams((p) => ({ ...p, travelFeed: Math.max(1, v) }))}
              />
              <SliderField
                label={t('ph.field.decimals', 'Decimals')}
                min={0}
                max={6}
                step={1}
                value={params.decimals}
                onChange={(v) => setParams((p) => ({ ...p, decimals: clampDecimals(v) }))}
                title={t('ph.field.decimals.title', 'Decimal places in the emitted coordinates (0–6).')}
              />
            </div>
          </div>

          {/* Extruder / pump */}
          <div className="ph-card">
            <div className="ph-card-head">
              <h4>
                <Icon name="spindle" size={14} className="cam-card-ico" /> {t('ph.pump.title', 'Extruder / pump')}
              </h4>
              <InfoTip
                topic="phPump"
                title={t('ph.pump.title', 'Extruder / pump')}
                body={t('ph.pump.body', 'Pump model: the spindle output turns the concrete pump on (M3 S<flow>) and off (M5) around each wall. E model: an extrusion axis advances proportional to move length × bead area (relative extrusion, M83).')}
              />
            </div>
            <div className="ph-fields">
              <div className="ph-segrow">
                <span className="ph-segrow-lbl">{t('ph.pump.model', 'Model')}</span>
                <SegControl<'pump' | 'e'>
                  options={[
                    { value: 'pump', label: t('ph.pump.pump', 'Pump M3/M5') },
                    { value: 'e', label: t('ph.pump.e', 'E axis') },
                  ]}
                  value={params.extruder}
                  onChange={(v) => setParams((p) => ({ ...p, extruder: v }))}
                  ariaLabel={t('ph.pump.model', 'Extruder model')}
                  variant="tonal"
                  size="sm"
                />
              </div>
              {params.extruder === 'pump' ? (
                <SliderField
                  label={t('ph.field.flow', 'Pump flow')}
                  unit={t('unit.sWord', 'S')}
                  min={0}
                  max={1000}
                  step={10}
                  value={params.flowS}
                  onChange={(v) => setParams((p) => ({ ...p, flowS: Math.max(0, v) }))}
                  title={t('ph.field.flow.title', 'Emitted as M3 S<flow> to set the pump/auger rate. 0 = plain M3.')}
                />
              ) : (
                <SliderField
                  label={t('ph.field.eFlow', 'E flow')}
                  unit={t('unit.mult', '×')}
                  min={0}
                  max={5}
                  step={0.05}
                  value={params.eFlow}
                  onChange={(v) => setParams((p) => ({ ...p, eFlow: Math.max(0, v) }))}
                  title={t('ph.field.eFlow.title', 'E advance = move length × bead cross-section × this multiplier (relative extrusion).')}
                />
              )}
            </div>
          </div>

          {/* Openings (doors / windows) */}
          <div className="ph-card ph-card-wide">
            <div className="ph-card-head">
              <h4>
                <Icon name="frame" size={14} className="cam-card-ico" /> {t('ph.openings.title', 'Openings (doors / windows)')}
              </h4>
              <InfoTip
                topic="phOpenings"
                title={t('ph.openings.title', 'Openings')}
                body={t('ph.openings.body', 'Optional rectangular door/window gaps. Each opening is centred at (X, Y) in the footprint (metres) with size W; extrusion is SKIPPED for layers whose Z is within [sill, sill + height] — the pump lifts over the gap.')}
              />
              <button type="button" className="ph-add-btn" onClick={addOpening}>
                <Icon name="add" size={13} /> {t('ph.openings.add', 'Add')}
              </button>
            </div>
            <div className="ph-openings">
              {openings.length === 0 && (
                <p className="ph-openings-empty">
                  {t('ph.openings.empty', 'No openings — walls print solid. Add a door/window to lift the pump over a gap.')}
                </p>
              )}
              {openings.map((op, i) => (
                <div className="ph-open-row" key={op.id}>
                  <span className="ph-open-idx">{i + 1}</span>
                  {(['x', 'y', 'w', 'sill', 'height'] as const).map((field) => (
                    <label className="ph-mini" key={field}>
                      <span>
                        {field === 'x'
                          ? t('ph.open.x', 'X m')
                          : field === 'y'
                            ? t('ph.open.y', 'Y m')
                            : field === 'w'
                              ? t('ph.open.w', 'W m')
                              : field === 'sill'
                                ? t('ph.open.sill', 'Sill m')
                                : t('ph.open.h', 'H m')}
                      </span>
                      <input
                        type="number"
                        step="0.1"
                        value={op[field]}
                        onChange={(e) => updateOpening(op.id, { [field]: num(e.target.value, op[field]) })}
                      />
                    </label>
                  ))}
                  <button
                    type="button"
                    className="ph-row-ico ph-del"
                    onClick={() => deleteOpening(op.id)}
                    title={t('ph.openings.delete', 'Delete opening')}
                    aria-label={t('ph.openings.delete', 'Delete opening')}
                  >
                    <Icon name="close" size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Walls list. */}
      <div className="ph-card ph-walls">
        <div className="ph-card-head">
          <h4>
            <Icon name="frame" size={14} className="cam-card-ico" /> {t('ph.walls.title', 'Walls')}
          </h4>
          <span className="ph-card-count">{walls.length}</span>
        </div>
        <div className="ph-wall-list">
          {walls.length === 0 ? (
            <CamEmpty
              icon={<Icon name="upload" size={22} />}
              title={t('ph.empty.title', 'No floor plan loaded')}
              hint={t('ph.empty.hint', 'Load an architectural floor plan (SVG or DXF); its lines and polylines become the walls to print.')}
              action={
                <button type="button" className="cam-primary" onClick={() => fileRef.current?.click()}>
                  <Icon name="upload" size={14} /> {t('ph.empty.load', 'Load floor plan')}
                </button>
              }
            />
          ) : (
            walls.map((w, i) => {
              const lenMm = wallsMm[i] ? ringLength(wallsMm[i].points, wallsMm[i].closed) : 0
              return (
                <div
                  key={w.id}
                  className={`ph-wcard${w.id === selected ? ' is-selected' : ''}`}
                  onClick={() => setSelected(w.id)}
                >
                  <span className="ph-wcard-idx">{w.name}</span>
                  <span className="ph-wcard-meta">
                    {t('ph.wall.meta', '{pts} pts · {len} m', { pts: w.points.length, len: (lenMm / 1000).toFixed(2) })}
                  </span>
                  <span className={`ph-wcard-badge${w.closed ? ' is-closed' : ''}`}>
                    {w.closed ? t('ph.wall.closed', 'closed') : t('ph.wall.open', 'open')}
                  </span>
                  <div className="ph-wcard-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      className="ph-row-ico"
                      onClick={() => toggleClosed(w.id)}
                      title={t('ph.wall.toggleClosed', 'Toggle open / closed loop')}
                      aria-label={t('ph.wall.toggleClosed', 'Toggle open / closed loop')}
                    >
                      <Icon name="copy" size={14} />
                    </button>
                    <button
                      type="button"
                      className="ph-row-ico ph-del"
                      onClick={() => deleteWall(w.id)}
                      title={t('ph.wall.delete', 'Delete wall')}
                      aria-label={t('ph.wall.delete', 'Delete wall')}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
