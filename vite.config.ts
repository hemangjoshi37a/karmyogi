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

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    cameraFrameReceiver(),
    machineBridgeReceiver(),
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
      registerType: 'autoUpdate',
      injectRegister: 'auto',
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
