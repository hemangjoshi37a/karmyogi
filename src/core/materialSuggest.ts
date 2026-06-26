/**
 * AI roadmap Phase 3 — Material + feeds SUGGESTER (scaffold).
 *
 * Proposes a likely {@link MaterialPreset} (and, via the existing
 * `recommend(material, bit)`, feeds/speeds) from a single camera frame of the
 * stock on the bed. Two paths:
 *
 *   1. RULE-BASED fallback (this module, pure + always available): cheap colour
 *      / brightness / saturation / texture statistics of the frame → a ranked
 *      list of candidate materials with a confidence score. No model download,
 *      no main-thread stall, runs everywhere.
 *   2. WEBGPU ML path (lazy, optional): a small MobileNet-class image classifier
 *      run via `transformers.js` / `onnxruntime-web` on WebGPU, mapped onto our
 *      material catalogue. The model asset is **NOT bundled** — see
 *      {@link loadMaterialModel} TODOs. It downloads ONCE and caches (PWA Cache
 *      Storage / OPFS) so first paint is never bloated. Until wired, this path
 *      returns `null` and callers fall back to {@link suggestMaterialRuleBased}.
 *
 * HUMAN-IN-THE-LOOP IS MANDATORY. This module only ever PROPOSES — wrong feeds
 * break bits or start fires. The operator must confirm before any cutting
 * parameter is applied. Nothing here mutates a store or emits G-code.
 *
 * NO React / DOM / three / zustand imports — pure core (camera frames are passed
 * in as plain RGBA buffers; they never leave the device).
 *
 * @see docs/ai-roadmap.md Phase 3
 */

import type { MaterialPreset, MaterialCategory } from './materials'
import { MATERIALS } from './materials'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A packed-RGBA frame (same shape as padVision's RgbaImage). */
export interface RgbaFrame {
  /** Packed RGBA, length `width*height*4`, 0..255. */
  data: Uint8ClampedArray | Uint8Array | number[]
  width: number
  height: number
}

/** One ranked material proposal. */
export interface MaterialSuggestion {
  /** The proposed material from the catalogue. */
  material: MaterialPreset
  /**
   * ABSOLUTE plausibility in [0,1] — the raw category score, so a low number is
   * an honest "not sure" (not just "lost the relative vote"). The operator
   * confirms regardless; this is a proposal, never a measurement.
   */
  confidence: number
  /** Share of the returned list's total score (0..1) — relative ranking weight. */
  share: number
  /** Short human reason (English; caller may wrap in t()). */
  reason: string
}

/** Result of a suggestion run. */
export interface MaterialSuggestResult {
  /** Ranked candidates, best first (length ≤ `topK`). */
  candidates: MaterialSuggestion[]
  /** Which engine produced this. `'ml'` only when the WebGPU model ran. */
  source: 'rule' | 'ml'
  /** Coarse colour stats used by the rule path (handy for the UI / debugging). */
  stats: FrameStats
}

/** Aggregate colour / texture statistics of a frame. */
export interface FrameStats {
  /** Mean R/G/B in 0..255. */
  meanR: number
  meanG: number
  meanB: number
  /** Mean luma (Rec.601) in 0..255. */
  luma: number
  /** HSV saturation of the mean colour, 0..1. */
  saturation: number
  /** HSV hue of the mean colour, 0..360 (0 when achromatic). */
  hue: number
  /** Luma standard deviation — a coarse "busy texture / grain" proxy (0..~128). */
  textureStd: number
  /** Number of pixels actually sampled. */
  samples: number
}

// ---------------------------------------------------------------------------
// Frame statistics (pure)
// ---------------------------------------------------------------------------

/**
 * Compute coarse colour + texture statistics over a frame. Subsamples to keep it
 * cheap (≤ `maxSamples` pixels), so it is safe to call on the UI thread for a
 * live preview.
 *
 * @param frame      Packed RGBA frame.
 * @param maxSamples Approximate pixel budget (default 4096). The frame is
 *                   strided to roughly hit this.
 */
export function frameStats(frame: RgbaFrame, maxSamples = 4096): FrameStats {
  const { data, width, height } = frame
  const px = Math.max(1, width * height)
  // Stride so we touch ~maxSamples pixels.
  const stride = Math.max(1, Math.floor(px / Math.max(1, maxSamples)))

  let sr = 0
  let sg = 0
  let sb = 0
  let n = 0
  // Two-pass-free luma variance via running sums.
  let sLuma = 0
  let sLuma2 = 0

  for (let i = 0; i < px; i += stride) {
    const j = i * 4
    const r = data[j]
    const g = data[j + 1]
    const b = data[j + 2]
    if (r === undefined || g === undefined || b === undefined) break
    sr += r
    sg += g
    sb += b
    const ly = 0.299 * r + 0.587 * g + 0.114 * b
    sLuma += ly
    sLuma2 += ly * ly
    n++
  }
  if (n === 0) {
    return { meanR: 0, meanG: 0, meanB: 0, luma: 0, saturation: 0, hue: 0, textureStd: 0, samples: 0 }
  }

  const meanR = sr / n
  const meanG = sg / n
  const meanB = sb / n
  const luma = sLuma / n
  const variance = Math.max(0, sLuma2 / n - luma * luma)
  const textureStd = Math.sqrt(variance)

  const { hue, saturation } = rgbToHs(meanR, meanG, meanB)
  return { meanR, meanG, meanB, luma, saturation, hue, textureStd, samples: n }
}

/** RGB (0..255) → HSV hue (0..360) + saturation (0..1). Value is implicit. */
function rgbToHs(r: number, g: number, b: number): { hue: number; saturation: number } {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  const saturation = max <= 0 ? 0 : d / max
  let hue = 0
  if (d > 1e-6) {
    if (max === rn) hue = ((gn - bn) / d) % 6
    else if (max === gn) hue = (bn - rn) / d + 2
    else hue = (rn - gn) / d + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return { hue, saturation }
}

// ---------------------------------------------------------------------------
// Rule-based classifier (pure, always available)
// ---------------------------------------------------------------------------

/**
 * A hand-written scorer per material CATEGORY from frame stats. Deliberately
 * conservative and explainable — this is a *suggestion* the operator confirms,
 * not a measurement. Returns a 0..1 plausibility per category.
 *
 * Heuristics (coarse, documented; tune against real bed photos before any
 * graduation from the experimental flag):
 *   - metal   : low saturation + high brightness + low texture (shiny, even).
 *   - pcb     : green-ish hue (FR-4 soldermask) OR dark with copper-orange.
 *   - wood    : warm hue (orange/yellow), medium saturation, HIGH texture (grain).
 *   - plastic : high brightness, low-medium texture, can be saturated (coloured).
 *   - foam    : very high brightness, very low texture, low saturation (matte white).
 *   - other   : flat baseline so there is always a fallback.
 */
function scoreCategories(s: FrameStats): Record<MaterialCategory, number> {
  const warm = s.hue >= 15 && s.hue <= 60 // orange→yellow
  const greenish = s.hue >= 70 && s.hue <= 160
  const bright = s.luma / 255 // 0..1
  const tex = Math.min(1, s.textureStd / 60) // 0..1 grain proxy
  const sat = s.saturation

  const dark = bright < 0.4 // low-luma board (copper-on-dark FR-4)
  const metal = clamp01(0.5 * (1 - sat) + 0.3 * bright + 0.2 * (1 - tex) - 0.1)
  const pcb = clamp01((greenish ? 0.6 : 0) + (warm && dark ? 0.2 : 0) + 0.2 * (1 - tex))
  const wood = clamp01((warm ? 0.45 : 0.05) + 0.35 * tex + 0.2 * Math.min(1, sat * 2))
  const plastic = clamp01(0.35 * bright + 0.25 * sat + 0.2 * (1 - tex) + (greenish || warm ? 0 : 0.1))
  const foam = clamp01(0.5 * bright + 0.4 * (1 - tex) + 0.1 * (1 - sat) - 0.25)
  const other = 0.12 // always-present baseline

  return { wood, plastic, pcb, metal, foam, other }
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return n < 0 ? 0 : n > 1 ? 1 : n
}

/**
 * Rule-based material suggestion from a frame. ALWAYS available (no download).
 *
 * Scores material categories from {@link frameStats}, then picks the best
 * matching catalogue {@link MaterialPreset} per category (the first entry of
 * that category, which our catalogue orders easiest-first), and returns the top
 * `topK` as normalized-confidence suggestions.
 *
 * @param frame Packed RGBA camera frame (stays on-device; never uploaded).
 * @param opts  `topK` (default 3), `catalogue` (defaults to built-in MATERIALS).
 */
export function suggestMaterialRuleBased(
  frame: RgbaFrame,
  opts?: { topK?: number; catalogue?: MaterialPreset[] },
): MaterialSuggestResult {
  const topK = Math.max(1, opts?.topK ?? 3)
  const catalogue = opts?.catalogue ?? MATERIALS
  const stats = frameStats(frame)
  const catScores = scoreCategories(stats)

  // Map each category score onto a representative catalogue material.
  const byCat = new Map<MaterialCategory, MaterialPreset>()
  for (const m of catalogue) {
    if (!byCat.has(m.category)) byCat.set(m.category, m)
  }

  const raw: { material: MaterialPreset; score: number; reason: string }[] = []
  for (const [cat, score] of Object.entries(catScores) as [MaterialCategory, number][]) {
    const material = byCat.get(cat)
    if (!material) continue
    raw.push({ material, score, reason: reasonFor(cat, stats) })
  }
  raw.sort((a, b) => b.score - a.score)
  const top = raw.slice(0, topK)

  // Confidence is the ABSOLUTE per-category plausibility (so "weak" reads as weak).
  // `share` keeps the relative ranking weight (sums to ~1 across the kept list).
  const sum = top.reduce((acc, c) => acc + c.score, 0) || 1
  const candidates: MaterialSuggestion[] = top.map((c) => ({
    material: c.material,
    confidence: clamp01(c.score),
    share: clamp01(c.score / sum),
    reason: c.reason,
  }))

  return { candidates, source: 'rule', stats }
}

/** A short English explanation for why a category scored. */
function reasonFor(cat: MaterialCategory, s: FrameStats): string {
  const b = Math.round((s.luma / 255) * 100)
  const t = Math.round(Math.min(1, s.textureStd / 60) * 100)
  switch (cat) {
    case 'metal':
      return `Shiny, even surface (low texture ${t}%, low colour).`
    case 'pcb':
      return s.hue >= 70 && s.hue <= 160 ? 'Green soldermask hue detected.' : 'Dark board with copper tones.'
    case 'wood':
      return `Warm tone with grain-like texture (${t}%).`
    case 'plastic':
      return `Bright, fairly smooth surface (${b}% brightness).`
    case 'foam':
      return `Very bright, matte, low texture (${b}% brightness).`
    default:
      return 'Closest catalogue fallback.'
  }
}

// ---------------------------------------------------------------------------
// WebGPU ML path (lazy scaffold — model asset NOT bundled yet)
// ---------------------------------------------------------------------------

/** Opaque handle to a loaded classifier. */
export interface MaterialModel {
  /** Run inference on a frame → ranked suggestions, or `null` if it fails. */
  classify(frame: RgbaFrame, topK: number): Promise<MaterialSuggestion[] | null>
}

let modelPromise: Promise<MaterialModel | null> | null = null

/**
 * Whether WebGPU is available in this environment (cheap, sync). The ML path is
 * only attempted when this is true; otherwise we stay on the rule-based path.
 */
export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

/**
 * Lazily load the WebGPU material classifier, ONCE (memoized). The heavy model
 * runtime + weights are dynamically imported so they never touch first paint;
 * the download is cached by the PWA (Cache Storage / OPFS) on first use.
 *
 * STATUS: SCAFFOLD. The model asset is not bundled and `transformers.js` /
 * `onnxruntime-web` are not yet dependencies, so this currently resolves to
 * `null` and callers fall back to {@link suggestMaterialRuleBased}.
 *
 * TODO(ai-phase3):
 *   1. Add `@xenova/transformers` (or `onnxruntime-web`) as a dependency.
 *   2. Host a small quantized MobileNet-class image classifier on R2 and add a
 *      `karmyogi-models` runtime-cache rule in vite.config.ts PWA config (OWNED
 *      BY ANOTHER AGENT — coordinate; do not edit vite.config.ts here).
 *   3. Dynamic-import the runtime, create a WebGPU pipeline, load the weights.
 *   4. Map the model's ImageNet-ish labels onto our MaterialCategory set
 *      (e.g. a small label→category lookup), then onto catalogue materials.
 *   5. Return a {@link MaterialModel} whose `classify` resizes the frame to the
 *      model input, runs inference on WebGPU, and returns ranked suggestions.
 *
 * @returns The loaded model, or `null` when unavailable (always, until wired).
 */
export function loadMaterialModel(): Promise<MaterialModel | null> {
  if (modelPromise) return modelPromise
  modelPromise = (async () => {
    if (!webgpuAvailable()) return null
    // TODO(ai-phase3): replace this stub with a real lazy dynamic import:
    //   const { pipeline, env } = await import('@xenova/transformers')
    //   env.backends.onnx.wasm.proxy = true           // keep off the UI thread
    //   const clf = await pipeline('image-classification', '<r2-model-id>',
    //                              { device: 'webgpu', quantized: true })
    //   return { async classify(frame, topK) { /* preprocess + run + map */ } }
    return null
  })()
  return modelPromise
}

/**
 * High-level suggester: try the WebGPU ML path if it is loaded/loadable, else
 * fall back to the rule-based path. ALWAYS returns a result (rule-based is the
 * floor). The caller MUST present these as proposals the operator confirms.
 *
 * @param frame   Packed RGBA camera frame (on-device only).
 * @param opts    `topK` (default 3); `useMl` (default true) to attempt WebGPU.
 */
export async function suggestMaterial(
  frame: RgbaFrame,
  opts?: { topK?: number; useMl?: boolean },
): Promise<MaterialSuggestResult> {
  const topK = Math.max(1, opts?.topK ?? 3)
  const useMl = opts?.useMl !== false
  if (useMl && webgpuAvailable()) {
    try {
      const model = await loadMaterialModel()
      const ml = model ? await model.classify(frame, topK) : null
      if (ml && ml.length > 0) {
        return { candidates: ml, source: 'ml', stats: frameStats(frame) }
      }
    } catch {
      // Fall through to the rule-based path on any ML failure.
    }
  }
  return suggestMaterialRuleBased(frame, { topK })
}
