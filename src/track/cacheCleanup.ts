// Disposable-cache cleanup — frees RAM/disk on low-end machines so the page
// doesn't crash with an out-of-memory error.
//
// PRINCIPLE: only the TRACKING / AUTO-RECORDING caches are clearable here — the
// stuff we collect (telemetry) or auto-capture (camera video). User-owned data —
// settings, presets, dock layout, GRBL config, saved machines, 3D carve jobs —
// is NEVER touched. The telemetry buffer is flushed to Firebase before it's
// dropped, so nothing already-collected is lost.

import { clearActivityCache } from './activity'
import { clearAllClips } from '../store/cameraClips'

export interface StorageInfo {
  /** Bytes currently used by this origin (IndexedDB + caches + localStorage…). */
  usage: number
  /** Bytes the browser will allow this origin (may be a fraction of disk). */
  quota: number
  /** usage / quota in [0,1] (0 when quota is unknown). */
  pct: number
}

/** Show the "free space" affordance once usage crosses EITHER threshold. */
export const NEAR_FULL_PCT = 0.8
export const NEAR_FULL_BYTES = 400 * 1024 * 1024 // 400 MB absolute floor

/** Best-effort origin storage estimate (null when the API is unavailable). */
export async function estimateStorage(): Promise<StorageInfo | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null
    const est = await navigator.storage.estimate()
    const usage = est.usage ?? 0
    const quota = est.quota ?? 0
    return { usage, quota, pct: quota > 0 ? usage / quota : 0 }
  } catch {
    return null
  }
}

/** True when local storage is heavy enough to warrant offering a cleanup. */
export function isNearFull(info: StorageInfo | null): boolean {
  if (!info) return false
  return info.pct >= NEAR_FULL_PCT || info.usage >= NEAR_FULL_BYTES
}

export interface CleanupResult {
  /** Approximate bytes freed. */
  freed: number
}

/**
 * Clear the disposable tracking/recording caches and report bytes freed:
 *   - activity telemetry buffer (flushed to Firebase first, then dropped)
 *   - auto-recorded camera clips (local-only video — the biggest hog)
 * Preserves ALL user-owned data. Best-effort — never throws.
 */
export async function clearTrackingCaches(): Promise<CleanupResult> {
  const before = await estimateStorage()
  let freed = 0
  try {
    await clearActivityCache()
  } catch {
    /* best-effort */
  }
  try {
    freed += await clearAllClips() // returns bytes freed (0 on failure)
  } catch {
    /* best-effort */
  }
  // Prefer the real before/after delta when the estimate API is available — it
  // also captures the (small) telemetry + tombstoned-IDB reclaim.
  const after = await estimateStorage()
  if (before && after) freed = Math.max(freed, before.usage - after.usage)
  return { freed: Math.max(0, freed) }
}

/** Human-readable byte size, e.g. "412 MB" / "1.3 GB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const kb = n / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  const gb = mb / 1024
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`
}
