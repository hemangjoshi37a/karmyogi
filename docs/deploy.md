# Deploying karmyogi

karmyogi is a static SPA. `npm run build` emits `dist/`, which can be hosted on
any static host. **Cloudflare Pages** is the intended target.

## Requirements / platform notes

- **Web Serial is Chromium-only** (Chrome / Edge / Opera / Brave; not Firefox/Safari)
  and requires **HTTPS** (or `localhost`). Cloudflare Pages serves HTTPS automatically,
  so the USB/GRBL connection works on the deployed site.
- The app is a pure browser SPA — **no server/back end**. All machine I/O is over the
  browser's Web Serial API directly to the GRBL controller.

## Build

```bash
npm install
npm run build      # type-checks then builds → dist/
npm run preview    # serve the production build locally to sanity-check
```

`dist/` contains `index.html`, hashed `assets/`, the PWA service worker
(`sw.js` + `workbox-*`), `manifest.webmanifest`, and the routing/header files
copied from `public/` (`_redirects`, `_headers`).

## Cloudflare Pages

- **Framework preset:** None / Vite.
- **Build command:** `npm run build`
- **Build output directory:** `dist`
- SPA routing: `public/_redirects` (`/* /index.html 200`) is copied into `dist/` so
  deep links resolve to the app.
- Caching/security headers: `public/_headers`.
- HTTPS + the custom subdomain (e.g. `karmyogi.hjlabs.in`) are configured in the
  Cloudflare Pages dashboard.

### Wrangler (optional, direct upload)

```bash
npm run build
npx wrangler pages deploy dist --project-name karmyogi
```

## PWA / offline

`vite-plugin-pwa` precaches the app shell, so karmyogi loads offline once visited
(the machine link itself still needs the USB device present). The service worker
uses `autoUpdate`, so a new deploy refreshes clients automatically.
