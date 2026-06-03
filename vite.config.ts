import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
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
