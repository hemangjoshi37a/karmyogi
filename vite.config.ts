import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'
// Dev-only camera-frame receiver lives in a plain .mjs (kept out of the app
// tsconfig so it can use Node APIs without leaking @types/node into the build).
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { cameraFrameReceiver } from './vite-camera-plugin.mjs'
// Dev-only machine bridge: relays this browser's GRBL machine to the server so
// an agent can read live state and queue commands. Plain .mjs (Node APIs),
// kept out of the app tsconfig like the camera plugin above.
// @ts-ignore - JS module, not typechecked by the app tsconfig
import { machineBridgeReceiver } from './vite-machine-plugin.mjs'

// `process` is provided by Node when Vite loads this config; declare it locally
// (the app tsconfig deliberately omits @types/node so browser globals stay clean).
declare const process: { env: Record<string, string | undefined> }

// Opt-in HTTPS for the dev server. The camera (`getUserMedia`) and Web Serial
// only work in a SECURE CONTEXT — `https://` or `localhost`. Plain `http://<lan-ip>`
// is NOT secure, so the browser hides `navigator.mediaDevices` and the camera
// can't start. To use the camera / Web Serial from another device over the LAN:
//   HTTPS=1 npm run dev -- --host 0.0.0.0
// then open `https://<lan-ip>:5185` and accept the self-signed certificate once.
// Default (no HTTPS env) keeps plain http://localhost for normal local dev.
const useHttps = !!process.env.HTTPS

// Build identity, computed once when Vite loads this config. Baked into the app
// via `define` (so the running bundle knows which build it is) AND written to
// `dist/build-info.json` by the plugin below (so a loaded tab can fetch the
// server's latest build identity and detect when it has gone stale). The epoch
// is the source of truth; the base-36 string is a short human-ish version id.
const buildEpoch = Date.now()
const buildTime = new Date(buildEpoch).toISOString()
const buildVersion = buildEpoch.toString(36)

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

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(buildVersion),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    react(),
    cameraFrameReceiver(),
    machineBridgeReceiver(),
    buildInfoEmitter(),
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
        // Skip any single asset larger than this from the PRECACHE manifest; it
        // will instead be fetched + cached on demand by runtimeCaching.
        maximumFileSizeToCacheInBytes: 2 * 1024 * 1024,
        // Lazy/code-split JS chunks and the OCCT WASM are cached the first time
        // they're actually requested, so offline use still works after a panel
        // has been opened once — without front-loading megabytes on install.
        runtimeCaching: [
          {
            urlPattern: ({ request, url }) =>
              request.destination === 'script' || url.pathname.endsWith('.js'),
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'karmyogi-js',
              expiration: { maxEntries: 80, maxAgeSeconds: 60 * 60 * 24 * 30 },
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
