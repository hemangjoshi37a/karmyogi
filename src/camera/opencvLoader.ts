/**
 * opencvLoader — lazy, code-split loader for OpenCV.js (WASM).
 *
 * OpenCV.js is the shared computer-vision runtime for the camera-based skin
 * tracking on the Tattoo/Henna tab (and any future in-browser vision). It is a
 * large WASM payload (~8 MB), so it is NEVER bundled into the entry chunk — it is
 * fetched only the first time a CV feature is switched on, via `loadOpenCV()`.
 *
 * ── REAL vs STUB ────────────────────────────────────────────────────────────
 *   • REAL: the load orchestration here is genuine and honest. It (1) reuses a
 *     `cv` already on `window` (e.g. from a previous load), (2) tries the npm
 *     package `@techstark/opencv-js` via a *dynamic* import, and failing that
 *     (3) injects the official OpenCV.js build from a CDN <script> exactly once,
 *     then waits for the Emscripten WASM runtime to finish initializing. It
 *     caches the resolved module, de-dupes concurrent calls, never throws, and
 *     returns `null` on any failure so callers degrade gracefully.
 *   • NOT FAKED: if nothing loads, callers get `null` / `isOpenCVReady() === false`
 *     and must report an honest status ("opencv-not-loaded") — no stubbed cv.
 *
 * ── Why a *variable* import specifier ───────────────────────────────────────
 * `@techstark/opencv-js` is intentionally NOT a dependency yet. A non-literal
 * import specifier (plus a `@vite-ignore` hint) means neither `tsc --noEmit` nor
 * the production build try to resolve the module, so both stay green WITHOUT the
 * package installed. The instant someone runs `npm i @techstark/opencv-js`, this
 * code path lights up with no further changes.
 *
 * ── Phased roadmap (this file is the shared foundation) ─────────────────────
 *   Phase 1: ArUco fiducial 6-DoF pose → registration offset   (fiducialTrack.ts)
 *   Phase 2: stereo calibrate → disparity → depth → cylinder fit (stereoDepth.ts)
 *   Both phases call `loadOpenCV()` lazily and read the live result via the
 *   `skinTracking` store.
 */

/**
 * The slice of the OpenCV.js surface this app touches, typed LOOSELY on purpose:
 * every member is `any` via the index signature, so this code compiles WITHOUT
 * the npm package's real `.d.ts`. This is a guarded structural placeholder, not a
 * faithful binding — treat every call as untyped and null-guard at runtime.
 */
export interface OpenCVModule {
  [key: string]: any
}

/** Official prebuilt OpenCV.js (note: the docs build may NOT include aruco). */
const CDN_URL = 'https://docs.opencv.org/4.x/opencv.js'

/** How long to wait for the WASM runtime to initialize before giving up. */
const READY_TIMEOUT_MS = 60_000

/** Resolved, runtime-initialized module (the one good copy we hand out). */
let cached: OpenCVModule | null = null
/** In-flight load, so concurrent callers share one attempt. */
let pending: Promise<OpenCVModule | null> | null = null
/** In-flight CDN <script> injection, so we never add the tag twice. */
let cdnPromise: Promise<unknown> | null = null

/** Read the global `cv` without a global type augmentation (kept loose). */
function globalCv(): unknown {
  return typeof window === 'undefined' ? undefined : (window as unknown as Record<string, unknown>).cv
}

/** True once OpenCV.js is loaded AND its WASM runtime is initialized. */
export function isOpenCVReady(): boolean {
  return cached != null
}

/**
 * Synchronous accessor for the already-loaded module (or `null`). Callers whose
 * APIs are synchronous (e.g. `detectMarkers`) use this and report an honest
 * "opencv-not-loaded" status when it is `null`; they do NOT block on the load.
 */
export function getOpenCV(): OpenCVModule | null {
  return cached
}

/**
 * Lazily load OpenCV.js. Resolves to the ready module, or `null` on any failure
 * (missing package + CDN unreachable, blocked script, WASM init timeout, non-DOM
 * environment). Never throws. Safe to call repeatedly — the result is cached and
 * concurrent calls are de-duped.
 */
export function loadOpenCV(): Promise<OpenCVModule | null> {
  if (cached) return Promise.resolve(cached)
  if (pending) return pending
  pending = doLoad()
    .then((m) => {
      cached = m
      pending = null
      return m
    })
    .catch(() => {
      pending = null
      return null
    })
  return pending
}

/** Orchestrate the three acquisition strategies in order of preference. */
async function doLoad(): Promise<OpenCVModule | null> {
  // Non-DOM environment (SSR / a worker without `window`) — nothing to load.
  if (typeof window === 'undefined') return null

  // (1) Already on `window` (a prior load / a manually-added tag) → adopt it.
  const existing = await waitForReady(globalCv())
  if (existing) return existing

  // (2) The npm package, if installed. Variable specifier keeps tsc/Vite happy
  //     when it is NOT installed (see the file header).
  const pkg = await tryImportPackage()
  if (pkg) {
    const ready = await waitForReady(pkg)
    if (ready) return ready
  }

  // (3) Inject the official CDN build once, then wait for `window.cv`.
  await loadCdnScript()
  const viaCdn = await waitForReady(globalCv())
  if (viaCdn) return viaCdn

  return null
}

/** Attempt the optional npm package; returns its cv object or `null`. */
async function tryImportPackage(): Promise<unknown> {
  try {
    // Non-literal specifier => TS/Vite do not statically require the module, so
    // this file type-checks and builds with the package absent. `@vite-ignore`
    // silences Vite's dynamic-import analysis warning.
    const spec = '@techstark/opencv-js'
    const mod = (await import(/* @vite-ignore */ spec)) as { default?: unknown } & Record<string, unknown>
    return mod?.default ?? mod ?? null
  } catch {
    return null // not installed → fall through to the CDN
  }
}

/** Inject the CDN <script> exactly once; resolves when it loads (or errors). */
function loadCdnScript(): Promise<unknown> {
  if (cdnPromise) return cdnPromise
  cdnPromise = new Promise<unknown>((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null)
      return
    }
    const settle = () => resolve(globalCv() ?? null)
    const prior = document.querySelector<HTMLScriptElement>('script[data-opencv-loader]')
    if (prior) {
      // A tag is already present/loading — piggyback on it.
      if (globalCv()) settle()
      else {
        prior.addEventListener('load', settle, { once: true })
        prior.addEventListener('error', () => resolve(null), { once: true })
      }
      return
    }
    const script = document.createElement('script')
    script.src = CDN_URL
    script.async = true
    script.defer = true
    script.setAttribute('data-opencv-loader', '1')
    script.addEventListener('load', settle, { once: true })
    script.addEventListener('error', () => resolve(null), { once: true })
    document.head.appendChild(script)
  })
  return cdnPromise
}

/**
 * Normalize the many shapes an OpenCV.js build can take into a runtime-ready
 * module (or `null`). Handles: a thenable/Promise (await it), an Emscripten
 * module factory (call → Promise), an object that fires `onRuntimeInitialized`,
 * and an already-ready object exposing `cv.Mat`. Times out rather than hanging.
 */
async function waitForReady(input: unknown): Promise<OpenCVModule | null> {
  let candidate: any = input
  if (!candidate) return null

  // A Promise / thenable → await the resolved module.
  if (typeof candidate.then === 'function') {
    try {
      candidate = await candidate
    } catch {
      return null
    }
    if (!candidate) return null
  }

  // An Emscripten module factory (function) → invoke it; it returns a Promise.
  if (typeof candidate === 'function') {
    try {
      candidate = await candidate()
    } catch {
      return null
    }
    if (!candidate) return null
  }

  // Already initialized (the cleanest case).
  if (candidate.Mat) return candidate as OpenCVModule

  // Otherwise wait for the runtime-init event, polling as a fallback, bounded by
  // a timeout so a broken/partial load can never hang the caller forever.
  return await new Promise<OpenCVModule | null>((resolve) => {
    let settled = false
    const finish = (v: OpenCVModule | null) => {
      if (settled) return
      settled = true
      clearInterval(poll)
      clearTimeout(timer)
      resolve(v)
    }
    try {
      candidate.onRuntimeInitialized = () => finish(candidate as OpenCVModule)
    } catch {
      /* read-only property on some builds — the poll below covers it */
    }
    const poll = setInterval(() => {
      if (candidate && candidate.Mat) finish(candidate as OpenCVModule)
    }, 50)
    const timer = setTimeout(() => finish(candidate && candidate.Mat ? (candidate as OpenCVModule) : null), READY_TIMEOUT_MS)
  })
}
