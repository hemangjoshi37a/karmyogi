import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { readFileSync, readdirSync } from 'node:fs'
// Dev-only camera-frame receiver lives in a plain .mjs (kept out of the app
// tsconfig so it can use Node APIs without leaking @types/node into the build).
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { cameraFrameReceiver } from './vite-camera-plugin.mjs'
// Dev-only machine bridge: relays this browser's GRBL machine to the server so
// an agent can read live state and queue commands. Plain .mjs (Node APIs),
// kept out of the app tsconfig like the camera plugin above.
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { machineBridgeReceiver } from './vite-machine-plugin.mjs'
// Dev observability + control bridge: mirrors the whole app state to the server
// and accepts machine-independent app commands (panel focus, calibration tuning).
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { devBridgeReceiver } from './vite-dev-bridge.mjs'
// Build-only international-SEO generator: emits a crawlable /<code>/ page per
// locale with hreflang + a multilingual sitemap. Plain .mjs (Node fs APIs).
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { i18nSeoGenerator } from './vite-i18n-seo.mjs'
// Serves the ZXing QR-decoder wasm at a stable /zxing_reader.wasm in dev + build.
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { zxingWasm } from './vite-zxing-plugin.mjs'

// `process` is provided by Node when Vite loads this config; declare it locally
// (the app tsconfig deliberately omits @types/node so browser globals stay clean).
declare const process: { env: Record<string, string | undefined> }

// HTTPS for the dev server — ON BY DEFAULT. The camera (`getUserMedia`), Web
// Serial (USB), WebUSB and Web Bluetooth ONLY exist in a SECURE CONTEXT —
// `https://` or `localhost`/`127.0.0.1`. On a plain `http://<lan-ip>` page (e.g.
// http://192.168.x.x:5186) the browser HIDES `navigator.serial` /
// `navigator.bluetooth` entirely, so the USB/Bluetooth buttons disable — there is
// no app-side workaround for that browser rule. Serving https by default means
// reaching the dev server from another device on the LAN just works:
//   npm run dev -- --host 0.0.0.0   → open https://<lan-ip>:5186 (accept the
//   self-signed cert once) → USB + Bluetooth + camera all available.
// Opt OUT to plain http with `HTTP=1` (only needed to reach a bare ws:// Wi-Fi
// board WITHOUT the wss→ws relay; with the relay, keep https and Wi-Fi also works).
const useHttps = process.env.HTTP !== '1' && process.env.HTTPS !== '0'

// Build identity, computed once when Vite loads this config. Baked into the app
// via `define` (so the running bundle knows which build it is) AND written to
// `dist/build-info.json` by the plugin below (so a loaded tab can fetch the
// server's latest build identity and detect when it has gone stale). The epoch
// is the source of truth; the base-36 string is a short human-ish version id.
const buildEpoch = Date.now()
const buildTime = new Date(buildEpoch).toISOString()
const buildVersion = buildEpoch.toString(36)
// Human-readable UTC stamp for the boot splash, e.g. "2026-06-22 03:40 UTC".
const buildStamp = buildTime.replace('T', ' ').replace(/:\d{2}\.\d+Z$/, ' UTC')

/**
 * Emits `build-info.json` at the dist root after the bundle is generated:
 *   { version, buildTime, bytes, totalBytes, files: [{ url, bytes }] }
 *
 * `files` is the BOOT GRAPH only — the entry chunk(s) + their transitive STATIC
 * imports + all CSS — i.e. exactly what's needed to run the new version. Lazy
 * panels, locale chunks, vendor-three etc. are excluded (the service worker
 * runtime-caches those on first use), so a forced update stays light and the
 * progress bar shows an honest "download the new app" size rather than all
 * ~14 MB of split chunks. `bytes` = sum of `files`; `totalBytes` = the whole
 * build's JS+CSS (for reference). Fetched with `cache: 'no-store'`, so it always
 * reflects the freshest deploy on the server.
 */
function buildInfoEmitter() {
  type Chunk = { type: string; code?: string; source?: string | Uint8Array; isEntry?: boolean; imports?: string[] }
  const byteLen = (raw: unknown) =>
    typeof raw === 'string'
      ? Buffer.byteLength(raw)
      : raw instanceof Uint8Array
        ? raw.byteLength
        : 0
  return {
    name: 'karmyogi-build-info',
    apply: 'build' as const,
    generateBundle(_opts: unknown, bundle: Record<string, Chunk>) {
      const chunks: Record<string, Chunk> = {}
      let totalBytes = 0
      for (const [fileName, c] of Object.entries(bundle)) {
        if (fileName.endsWith('.js') && c.type === 'chunk') chunks[fileName] = c
        if (fileName.endsWith('.js') || fileName.endsWith('.css')) {
          totalBytes += byteLen(c.type === 'chunk' ? c.code : c.source)
        }
      }
      // BFS the static-import graph from the entry chunk(s).
      const boot = new Set<string>()
      const queue: string[] = []
      for (const [fileName, c] of Object.entries(chunks)) {
        if (c.isEntry) {
          boot.add(fileName)
          queue.push(fileName)
        }
      }
      while (queue.length) {
        const fn = queue.pop()!
        for (const imp of chunks[fn]?.imports ?? []) {
          if (chunks[imp] && !boot.has(imp)) {
            boot.add(imp)
            queue.push(imp)
          }
        }
      }
      const files: { url: string; bytes: number }[] = []
      let bytes = 0
      for (const fileName of boot) {
        const b = byteLen(chunks[fileName].code)
        bytes += b
        files.push({ url: '/' + fileName, bytes: b })
      }
      for (const [fileName, c] of Object.entries(bundle)) {
        if (fileName.endsWith('.css')) {
          const b = byteLen(c.source)
          bytes += b
          files.push({ url: '/' + fileName, bytes: b })
        }
      }
      ;(this as unknown as { emitFile: (f: unknown) => void }).emitFile({
        type: 'asset',
        fileName: 'build-info.json',
        source: JSON.stringify({ version: buildVersion, buildTime, bytes, totalBytes, files }, null, 2),
      })
    },
  }
}

/**
 * Build the splash translation map (splash.* keys only) from every locale file,
 * so the pre-React boot splash can localize BEFORE any bundle/locale chunk loads.
 * Inlined as `window.__SPLASH_I18N__` (see splashBuildStamp). Computed once at
 * config load; a dev-server restart or a build picks up new translations.
 */
function buildSplashI18n(): string {
  const out: Record<string, Record<string, string>> = {}
  try {
    const dir = new URL('./src/i18n/locales/', import.meta.url)
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const code = f.slice(0, -5)
      try {
        const o = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as Record<string, string>
        const sub: Record<string, string> = {}
        for (const k of Object.keys(o)) if (k.startsWith('splash.')) sub[k] = o[k]
        if (Object.keys(sub).length) out[code] = sub
      } catch {
        /* skip an unreadable/invalid locale */
      }
    }
  } catch {
    /* no locales dir */
  }
  return JSON.stringify(out)
}

/**
 * Replaces the `__BUILD_VERSION__` / `__BUILD_DATE__` placeholders in the boot
 * splash (index.html) with the build identity, AND inlines `window.__SPLASH_I18N__`
 * (the splash.* translations) into <head>. Runs in BOTH dev and build.
 */
function splashBuildStamp() {
  return {
    name: 'karmyogi-splash-build-stamp',
    transformIndexHtml(html: string) {
      // Recompute per call so a dev server reflects locale edits without a
      // restart; at build it simply runs once.
      const splashI18n = buildSplashI18n()
      return html
        .replace(
          '</head>',
          `  <script>window.__SPLASH_I18N__=${splashI18n}</script>\n  </head>`,
        )
        .replace(/__BUILD_VERSION__/g, buildVersion)
        .replace(/__BUILD_DATE__/g, buildStamp)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    splashBuildStamp(),
    cameraFrameReceiver(),
    machineBridgeReceiver(),
    devBridgeReceiver(), // dev observability + control relay

    buildInfoEmitter(),
    zxingWasm(),
    ...(useHttps ? [basicSsl()] : []),
    // PWA / offline: precache ONLY the small, always-needed app shell so the
    // first-install download stays light (it was ~18MB because the ~7.6MB OCCT
    // WASM and the big lazy CAM chunks were all precached up front). The shell
    // (entry JS/CSS/HTML + icons + fonts) is precached; everything heavy is
    // runtime-cached on first use instead, so unopened CAM modes never cost the
    // user a download.
    //   - `wasm` is NOT precached → the OCCT WASM loads lazily with the Carving
    //     panel and is then cached for offline reuse via runtimeCaching below.
    //   - `maximumFileSizeToCacheInBytes` is lowered so any single oversized
    //     asset is skipped by the precache and runtime-cached instead.
    // Uses the existing public/manifest.webmanifest (manifest: false).
    VitePWA({
      // 'prompt' (not 'autoUpdate') so the waiting SW does NOT skipWaiting on its
      // own — src/pwa/PwaManager.tsx decides WHEN to apply the update (it defers
      // the reload while a job is streaming to the machine) and drives the
      // visible download-progress UI. Registration is handled by useRegisterSW in
      // that component, so injectRegister is disabled to avoid double-registering.
      registerType: 'prompt',
      injectRegister: null,
      manifest: false,
      workbox: {
        // Precache the lightweight shell only (no wasm).
        globPatterns: ['**/*.{css,html,svg,woff2,ico,png,webmanifest}'],
        // The user guide at /guide/ is a standalone static document carrying
        // ~5MB of annotated screenshots. It matches the html/png patterns
        // above, so without this it lands in the precache and every install
        // pays 5MB for a page most users never open (install went 8.8 → 14.2MB).
        // It is runtime-cached on first visit instead — see runtimeCaching.
        globIgnores: ['guide/**'],
        // The SW answers every *navigation* with the precached index.html (the
        // SPA shell). /guide/ is a real static page, NOT an app route, so
        // without this exclusion an installed client navigating to /guide gets
        // the SPA, which has no such route and renders its 404 — the page 404s
        // for returning users while working fine in a fresh browser. Excluding
        // it lets those navigations reach the network (and the /guide/ runtime
        // cache below), so the guide is served as the document it is.
        navigateFallbackDenylist: [/^\/guide(\/|$)/],
        // Skip any single asset larger than this from the PRECACHE manifest; it
        // will instead be fetched + cached on demand by runtimeCaching.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        // Lazy/code-split JS chunks and the OCCT WASM are cached the first time
        // they're actually requested, so offline use still works after a panel
        // has been opened once — without front-loading megabytes on install.
        runtimeCaching: [
          {
            // NetworkFirst, NOT StaleWhileRevalidate — and a new cacheName.
            //
            // The SPA fallback (`/* -> /index.html 200`) answers a request for a
            // missing chunk with HTML at status 200. Under SWR that HTML got
            // cached UNDER the .js URL, and cache-first then served HTML for a
            // JS module on every later load — "Failed to fetch dynamically
            // imported module: .../ControllerPanel-*.js" — permanently, even
            // after the server was serving valid JS again. Renaming the cache
            // abandons any already-poisoned entries; NetworkFirst means an
            // online client can never be pinned to a bad cached response.
            // Chunks are content-hashed and served immutable (see _headers), so
            // the HTTP cache still does the heavy lifting; this cache exists for
            // offline use, which the fallback below preserves.
            urlPattern: ({ request, url }) =>
              request.destination === 'script' || url.pathname.endsWith('.js'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'karmyogi-js-v2',
              networkTimeoutSeconds: 10,
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'karmyogi-wasm',
              expiration: { maxEntries: 8, maxAgeSeconds: 60 * 60 * 24 * 30 },
              rangeRequests: true,
            },
          },
          {
            // The user guide — excluded from the precache (see globIgnores).
            // StaleWhileRevalidate rather than CacheFirst so a reader who opens
            // it again picks up a redeployed edition instead of being pinned to
            // a stale copy, while still rendering instantly from cache offline.
            urlPattern: ({ url }) => url.pathname.startsWith('/guide/'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'karmyogi-guide',
              expiration: { maxEntries: 40, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            // 3D models (controller STL/STEP, any glb/gltf) — large and rarely
            // change, so cache the first download and serve from cache after, so
            // the ~MBs are never re-fetched on later opens/reloads.
            urlPattern: ({ url }) => /\.(stl|step|stp|glb|gltf)$/i.test(url.pathname),
            handler: 'CacheFirst',
            options: {
              cacheName: 'karmyogi-models',
              expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 60 },
              rangeRequests: true,
            },
          },
        ],
      },
    }),
    // Last: post-process dist/ into per-locale pages + hreflang + sitemap.
    i18nSeoGenerator(),
  ],
  build: {
    // Vendor code-splitting: keep heavy, independently-loaded libraries in their
    // own chunks so they're cached separately and only fetched when a panel that
    // needs them is opened (the panels themselves are React.lazy — see
    // src/app/panelRegistry.ts). This keeps the entry chunk small for the 1M-user
    // first paint.
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined
          // 3D stack: three.js + the @react-three ecosystem (only the Visualizer
          // and a couple of CAM previews pull this in).
          if (
            /[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id) ||
            id.includes('postprocessing') ||
            id.includes('troika')
          ) {
            return 'vendor-three'
          }
          // Docking shell.
          if (/[\\/]node_modules[\\/]dockview/.test(id)) return 'vendor-dockview'
          // Heavy CAD/CAM libraries, each loaded lazily with its panel.
          if (/[\\/]occt-import-js[\\/]/.test(id)) return 'vendor-occt'
          if (/[\\/]opentype\.js[\\/]/.test(id)) return 'vendor-opentype'
          if (/[\\/]polygon-clipping[\\/]/.test(id) || /[\\/]splaytree[\\/]/.test(id)) {
            return 'vendor-clipping'
          }
          // Firebase is sizeable; keep it isolated from the entry chunk.
          if (/[\\/]node_modules[\\/](@firebase|firebase)[\\/]/.test(id)) return 'vendor-firebase'
          // React runtime shared by everything.
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) {
            return 'vendor-react'
          }
          return undefined
        },
      },
    },
  },
  server: {
    // Bind to ALL interfaces (0.0.0.0) so the dev server is reachable from other
    // devices on the LAN (a phone/tablet for Bluetooth / USB / camera testing)
    // WITHOUT needing `-- --host`. Combined with the HTTPS-by-default above, that
    // gives a SECURE CONTEXT at https://<lan-ip>:5185 so Web Bluetooth / Web Serial
    // stay available on the phone. Set HOST=localhost to bind to localhost only.
    host: process.env.HOST ?? true,
    port: 5185,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'https://karmyogi.hjlabs.in',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
