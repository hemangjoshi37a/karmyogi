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
    // PWA / offline: precache the built app shell so karmyogi loads without a
    // network (the app itself is offline-capable; the machine link is USB).
    // Uses the existing public/manifest.webmanifest (manifest: false).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2,wasm}'],
        maximumFileSizeToCacheInBytes: 7 * 1024 * 1024,
      },
    }),
  ],
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
