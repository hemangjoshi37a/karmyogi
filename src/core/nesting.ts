// Auto-nesting core — UI-independent, pure TypeScript.
// No React / DOM / three.js / zustand imports here (mirrors the Qt cadcam lib split).
//
// Packs a set of rectangular XY footprints onto a fixed-size bed without overlap,
// using a simple shelf / row bin-packing (First-Fit-Decreasing by height). This
// is robust, deterministic, and good enough for the handful of carve jobs a
// hobby machine runs at once. Each item gets back the (dx, dy) translation that
// places its footprint inside the bed; items that don't fit are flagged.

/** A footprint to pack: an axis-aligned XY size in mm plus the caller's id. */
export interface NestItem {
  id: string
  /** Footprint width along X (mm), already including rotation+scale. */
  w: number
  /** Footprint depth along Y (mm), already including rotation+scale. */
  h: number
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
}

export interface NestResult {
  placements: NestPlacement[]
  /** True if any item overflowed the bed. */
  overflow: boolean
  /** Human-readable warnings (e.g. "Job X is wider than the bed"). */
  warnings: string[]
}

export interface NestOptions {
  /** Usable bed width along X (mm). */
  bedW: number
  /** Usable bed depth along Y (mm). */
  bedH: number
  /** Gap kept between footprints and around the bed edge (mm). */
  margin?: number
}

/**
 * Shelf bin-packing: sort items tallest-first, lay them left-to-right on a
 * "shelf"; when an item doesn't fit the current shelf width, start a new shelf
 * above. Each footprint is inflated by `margin` so neighbours never touch.
 *
 * Returns the bottom-left corner of every item's footprint, anchored so the
 * packed block sits in the bed's lower-left (the caller maps that into work
 * coordinates). Items larger than the bed are placed at the origin and flagged.
 */
export function nestFootprints(items: NestItem[], opts: NestOptions): NestResult {
  const margin = Math.max(0, opts.margin ?? 2)
  const bedW = Math.max(1, opts.bedW)
  const bedH = Math.max(1, opts.bedH)
  const warnings: string[] = []

  const placements: NestPlacement[] = []
  let overflow = false

  // Sort tallest-first for tighter shelves; keep original ids.
  const sorted = items
    .map((it) => ({
      id: it.id,
      // Inflate by margin so a gap is kept on every side.
      w: Math.max(0, it.w) + margin,
      h: Math.max(0, it.h) + margin,
    }))
    .sort((a, b) => b.h - a.h)

  // Current shelf cursor (in bed coordinates, lower-left origin).
  let shelfX = margin
  let shelfY = margin
  let shelfH = 0

  for (const it of sorted) {
    const tooWide = it.w - margin > bedW
    const tooTall = it.h - margin > bedH
    if (tooWide || tooTall) {
      // Cannot ever fit — place at origin, flag it.
      placements.push({ id: it.id, x: margin, y: margin, overflow: true })
      overflow = true
      warnings.push(
        `Job is larger (${Math.round(it.w - margin)}×${Math.round(it.h - margin)}mm) than the bed (${Math.round(
          bedW,
        )}×${Math.round(bedH)}mm) — shrink it or use a bigger bed.`,
      )
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
      // Ran out of bed height — place it anyway at the current cursor, flag.
      placements.push({ id: it.id, x: shelfX, y: shelfY, overflow: true })
      overflow = true
      warnings.push('Not all jobs fit on the bed — they are stacked but overlap the edge.')
    } else {
      placements.push({ id: it.id, x: shelfX, y: shelfY, overflow: false })
    }

    shelfX += it.w
    if (it.h > shelfH) shelfH = it.h
  }

  // Restore the caller's input order in the output.
  const byId = new Map(placements.map((p) => [p.id, p]))
  const ordered = items.map(
    (it) => byId.get(it.id) ?? { id: it.id, x: margin, y: margin, overflow: true },
  )

  return { placements: ordered, overflow, warnings }
}
