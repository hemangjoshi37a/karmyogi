// Build identity helpers shared by the PWA updater and the About modal.
//
// At build time vite.config.ts (a) bakes `__APP_VERSION__` / `__BUILD_TIME__`
// into the bundle and (b) writes the SAME identity — plus the hashed JS/CSS
// chunk list and byte sizes — to `dist/build-info.json`. The running tab fetches
// that JSON (uncached) to learn the server's freshest build, so it can tell when
// it has gone stale and how big the update download will be.

export interface BuildFile {
  url: string
  bytes: number
}

export interface BuildInfo {
  version: string
  buildTime: string
  bytes: number
  jsBytes: number
  cssBytes: number
  files: BuildFile[]
}

/** The version baked into THIS running bundle. */
export const RUNNING_VERSION: string =
  typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'

/** ISO timestamp of when THIS running bundle was built. */
export const RUNNING_BUILD_TIME: string =
  typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : new Date().toISOString()

/**
 * Fetch the server's current build-info.json, bypassing every cache (HTTP + the
 * service worker) so we always see the freshest deploy. Returns null in dev
 * (the file only exists in a production build) or on any network/parse error.
 */
export async function fetchBuildInfo(): Promise<BuildInfo | null> {
  try {
    const res = await fetch('/build-info.json', { cache: 'no-store' })
    if (!res.ok) return null
    const json = (await res.json()) as BuildInfo
    if (!json || typeof json.version !== 'string') return null
    return json
  } catch {
    return null
  }
}

/** Format bytes as a compact "1.2 MB" / "840 KB" string. */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return '0 KB'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Human-friendly local date+time for a build's ISO timestamp. */
export function formatBuildTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
