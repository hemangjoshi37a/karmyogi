// Auto-nesting core — UI-independent, pure TypeScript.
// No React / DOM / three.js / zustand imports here (mirrors the Qt cadcam lib split).
//
// Packs a set of rectangular XY footprints onto a fixed-size bed without overlap,
// using a simple shelf / row bin-packing (First-Fit-Decreasing by height). This
// is robust, deterministic, and good enough for the handful of carve jobs a
// hobby machine runs at once. Each item gets back the (dx, dy) translation that
// places its footprint inside the bed; items that don't fit are flagged.
//
// SMART (least-waste) packing: each item may be tried at several rotations (0°
// and 90° at least). For every candidate rotation set we shelf-pack and score by
// the BOUNDING AREA of the packed block (tightest enclosing box) — the smaller
// that box, the less material is wasted. The best-scoring arrangement wins, and
// each item reports the rotation chosen for it so the caller can bake it back
// into the job placement.

/** A footprint to pack: an axis-aligned XY size in mm plus the caller's id. */
export interface NestItem {
  id: string
  /** Footprint width along X (mm), already including rotation+scale. */
  w: number
  /** Footprint depth along Y (mm), already including rotation+scale. */
  h: number
  /**
   * Extra rotation (degrees) ALREADY baked into `w`/`h` by the caller — the
   * nester reports `rotDeg + chosenExtra` so the result is an absolute rotation.
   * Defaults to 0.
   */
  rotDeg?: number
}

/** Result for one packed item: the bottom-left corner of its footprint (mm). */
export interface NestPlacement {
  id: string
  /** Bottom-left X of the footprint inside the bed (mm). */
  x: number
  /** Bottom-left Y of the footprint inside the bed (mm). */
  y: number
  /** True if this item could not be fitted on the bed. */
  overflow: boolean
  /**
   * Absolute rotation (degrees) the nester chose for this item: the caller's
   * input `rotDeg` plus any extra 90°-class turn applied to pack tighter.
   */
  rotDeg: number
  /** Footprint width AFTER the chosen rotation (mm). */
  w: number
  /** Footprint depth AFTER the chosen rotation (mm). */
  h: number
}

/**
 * Stable, machine-readable codes for nesting warnings. The core stays
 * UI-independent (no i18n imports), so it emits codes the UI can map to
 * localized strings via `t()` (with the English `warnings[]` as the fallback).
 */
export type NestWarningCode = 'tooLarge' | 'edgeOverflow'

/** One structured warning: a stable code + interpolation params + English text. */
export interface NestWarning {
  code: NestWarningCode
  /** English fallback (already interpolated). */
  message: string
  params?: Record<string, number>
}

export interface NestResult {
  placements: NestPlacement[]
  /** True if any item overflowed the bed. */
  overflow: boolean
  /**
   * Human-readable English warnings (e.g. "Job X is wider than the bed").
   * Retained as plain strings for backward compatibility with existing callers.
   */
  warnings: string[]
  /**
   * Structured warnings carrying a stable `code` + params so UI callers can
   * translate them. Parallel to `warnings` (same order, de-duplicated by code).
   */
  warningCodes: NestWarning[]
}

export interface NestOptions {
  /** Usable bed width along X (mm). */
  bedW: number
  /** Usable bed depth along Y (mm). */
  bedH: number
  /** Gap kept between footprints and around the bed edge (mm). */
  margin?: number
  /**
   * Candidate extra rotations (degrees) the nester may apply per item to pack
   * tighter. Defaults to [0, 90]. Pass [0] to disable rotation.
   */
  rotations?: number[]
}

/** One item resolved to a concrete oriented footprint for a single pack attempt. */
interface OrientedItem {
  id: string
  w: number
  h: number
  /** Extra rotation applied vs. the caller's input. */
  extraRot: number
  /** Caller's original rotation. */
  baseRot: number
}

interface ShelfPlacement {
  id: string
  x: number
  y: number
  overflow: boolean
  w: number
  h: number
  extraRot: number
  baseRot: number
}

interface ShelfResult {
  placements: ShelfPlacement[]
  overflow: boolean
  /** Bounding-box width of the packed block (mm) — used as the waste score. */
  usedW: number
  /** Bounding-box height of the packed block (mm). */
  usedH: number
  warnings: NestWarning[]
}

/**
 * Shelf bin-packing for ONE fixed orientation per item: sort items tallest-first,
 * lay them left-to-right on a "shelf"; when an item doesn't fit the current shelf
 * width, start a new shelf above. Each footprint is inflated by `margin` so
 * neighbours never touch. Returns the bottom-left corner of every item plus the
 * bounding box of the packed block (the least-waste score).
 */
function shelfPack(items: OrientedItem[], bedW: number, bedH: number, margin: number): ShelfResult {
  const warnings: NestWarning[] = []
  const placements: ShelfPlacement[] = []
  let overflow = false
  let usedW = 0
  let usedH = 0

  // Sort tallest-first for tighter shelves; keep original ids.
  const sorted = items
    .map((it) => ({
      id: it.id,
      w: Math.max(0, it.w) + margin,
      h: Math.max(0, it.h) + margin,
      rawW: Math.max(0, it.w),
      rawH: Math.max(0, it.h),
      extraRot: it.extraRot,
      baseRot: it.baseRot,
    }))
    .sort((a, b) => b.h - a.h)

  let shelfX = margin
  let shelfY = margin
  let shelfH = 0

  for (const it of sorted) {
    const tooWide = it.rawW > bedW
    const tooTall = it.rawH > bedH
    if (tooWide || tooTall) {
      placements.push({
        id: it.id,
        x: margin,
        y: margin,
        overflow: true,
        w: it.rawW,
        h: it.rawH,
        extraRot: it.extraRot,
        baseRot: it.baseRot,
      })
      overflow = true
      warnings.push({
        code: 'tooLarge',
        message: `Job is larger (${Math.round(it.rawW)}×${Math.round(it.rawH)}mm) than the bed (${Math.round(
          bedW,
        )}×${Math.round(bedH)}mm) — shrink it or use a bigger bed.`,
        params: {
          jobW: Math.round(it.rawW),
          jobH: Math.round(it.rawH),
          bedW: Math.round(bedW),
          bedH: Math.round(bedH),
        },
      })
      continue
    }

    // Wrap to a new shelf if it overflows the current row width.
    if (shelfX + it.w > bedW + margin && shelfH > 0) {
      shelfY += shelfH
      shelfX = margin
      shelfH = 0
    }

    const fitsVertically = shelfY + it.h <= bedH + margin + 1e-6
    if (!fitsVertically) {
      placements.push({
        id: it.id,
        x: shelfX,
        y: shelfY,
        overflow: true,
        w: it.rawW,
        h: it.rawH,
        extraRot: it.extraRot,
        baseRot: it.baseRot,
      })
      overflow = true
      warnings.push({
        code: 'edgeOverflow',
        message: 'Not all jobs fit on the bed — they are stacked but overlap the edge.',
      })
    } else {
      placements.push({
        id: it.id,
        x: shelfX,
        y: shelfY,
        overflow: false,
        w: it.rawW,
        h: it.rawH,
        extraRot: it.extraRot,
        baseRot: it.baseRot,
      })
    }

    // Track the packed block's bounding box (waste score).
    if (shelfX - margin + it.rawW > usedW) usedW = shelfX - margin + it.rawW
    if (shelfY - margin + it.rawH > usedH) usedH = shelfY - margin + it.rawH

    shelfX += it.w
    if (it.h > shelfH) shelfH = it.h
  }

  return { placements, overflow, usedW, usedH, warnings }
}

/**
 * Smart shelf bin-packing with per-item rotation. Greedily picks, for each item
 * (tallest-first), the orientation (from `rotations`) that keeps the packed
 * block's bounding box smallest — minimising wasted material. Falls back to a
 * deterministic pack so the result is stable.
 *
 * Returns the bottom-left corner of every item's footprint plus the absolute
 * rotation chosen for it, anchored so the packed block sits in the bed's
 * lower-left (the caller maps that into work coordinates).
 */
export function nestFootprints(items: NestItem[], opts: NestOptions): NestResult {
  const margin = Math.max(0, opts.margin ?? 2)
  const bedW = Math.max(1, opts.bedW)
  const bedH = Math.max(1, opts.bedH)
  const rotations =
    opts.rotations && opts.rotations.length > 0 ? opts.rotations : [0, 90]

  // Single (or zero) item: keep it as-is, no rotation. The caller (single job)
  // wants it left at its own placement, so don't shuffle one footprint around.
  if (items.length <= 1) {
    const placements: NestPlacement[] = items.map((it) => ({
      id: it.id,
      x: margin,
      y: margin,
      overflow: Math.max(0, it.w) > bedW || Math.max(0, it.h) > bedH,
      rotDeg: it.rotDeg ?? 0,
      w: Math.max(0, it.w),
      h: Math.max(0, it.h),
    }))
    const overflow = placements.some((p) => p.overflow)
    if (overflow) {
      const big = placements.find((p) => p.overflow)!
      const code: NestWarning = {
        code: 'tooLarge',
        message: 'Job is larger than the bed — shrink it or use a bigger bed.',
        params: {
          jobW: Math.round(big.w),
          jobH: Math.round(big.h),
          bedW: Math.round(bedW),
          bedH: Math.round(bedH),
        },
      }
      return { placements, overflow, warnings: [code.message], warningCodes: [code] }
    }
    return { placements, overflow, warnings: [], warningCodes: [] }
  }

  // Each item resolved to its candidate orientations. An odd 90° turn swaps w/h.
  const oriented = items.map((it) =>
    rotations.map((r): OrientedItem => {
      // Apply the extra rotation to the footprint: 0/180 keep w,h; 90/270 swap.
      const turned = (((r % 180) + 180) % 180) === 90
      return {
        id: it.id,
        w: turned ? Math.max(0, it.h) : Math.max(0, it.w),
        h: turned ? Math.max(0, it.w) : Math.max(0, it.h),
        extraRot: r,
        baseRot: it.rotDeg ?? 0,
      }
    }),
  )

  // GREEDY least-waste: process items tallest-first (by their default 0° height
  // — keeps ordering stable), and for each, try every orientation, keeping the
  // one that yields the smallest packed bounding box when packed together.
  // Because shelfPack is deterministic and order-stable, we evaluate the full
  // set per orientation choice via a small hill-climb: start all-default, then
  // for each item flip to the orientation that improves the score.
  const choice = oriented.map(() => 0) // index into each item's orientation list

  const buildSet = (): OrientedItem[] => oriented.map((opts2, i) => opts2[choice[i]])
  const score = (res: ShelfResult): number => {
    // Penalise overflow heavily; otherwise minimise the packed bounding area.
    const area = res.usedW * res.usedH
    return res.overflow ? area + 1e12 : area
  }

  let best = shelfPack(buildSet(), bedW, bedH, margin)
  let bestScore = score(best)

  // Hill-climb: repeatedly try flipping each item to a better orientation until
  // no single flip improves the score (bounded passes for determinism).
  let improved = true
  let passes = 0
  while (improved && passes < oriented.length + 2) {
    improved = false
    passes++
    for (let i = 0; i < oriented.length; i++) {
      const orig = choice[i]
      for (let o = 0; o < oriented[i].length; o++) {
        if (o === orig) continue
        choice[i] = o
        const res = shelfPack(buildSet(), bedW, bedH, margin)
        const s = score(res)
        if (s < bestScore - 1e-6) {
          bestScore = s
          best = res
          improved = true
        } else {
          choice[i] = orig
        }
      }
    }
  }

  // Map back to the caller's input order, reporting the absolute rotation.
  const byId = new Map(best.placements.map((p) => [p.id, p]))
  const placements: NestPlacement[] = items.map((it) => {
    const p = byId.get(it.id)
    if (!p) {
      return {
        id: it.id,
        x: margin,
        y: margin,
        overflow: true,
        rotDeg: it.rotDeg ?? 0,
        w: Math.max(0, it.w),
        h: Math.max(0, it.h),
      }
    }
    return {
      id: p.id,
      x: p.x,
      y: p.y,
      overflow: p.overflow,
      rotDeg: p.baseRot + p.extraRot,
      w: p.w,
      h: p.h,
    }
  })

  // De-duplicate warnings from the chosen arrangement (by code, keeping the
  // first message of each code so the strings + codes stay in lockstep).
  const seen = new Set<NestWarningCode>()
  const warningCodes: NestWarning[] = []
  for (const w of best.warnings) {
    if (seen.has(w.code)) continue
    seen.add(w.code)
    warningCodes.push(w)
  }
  const warnings = warningCodes.map((w) => w.message)

  return { placements, overflow: best.overflow, warnings, warningCodes }
}
