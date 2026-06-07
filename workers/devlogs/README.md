# karmyogi-devlogs — Cloudflare Worker backend

Backend for the in-app **bug-report / feature-request** overlay
(`@hemangjoshi37a/dev-logs`) embedded in karmyogi. It receives reports submitted
from the floating bug button (Ctrl+D), persists them to **Cloudflare KV**, and
(optionally) mirrors them as **GitHub Issues**. It also serves the overlay
bundle, so a single `VITE_DEVLOGS_ENDPOINT` URL is all the app needs.

## What the overlay sends (the contract this implements)

The overlay (`<endpoint>/overlay.js`) derives its API origin from its own
`<script>` src and then:

- `POST <origin>/api/requests` — `Content-Type: application/json`
  ```json
  { "title": "...", "description": "...", "priority": "high",
    "category": "bug", "submitted_by": "overlay", "platform": "karmyogi.hjlabs.in" }
  ```
  It reads `response.request.id` from the JSON we return, so this Worker responds
  with `{ "ok": true, "request": { "id": "...", ... } }`.
- `POST <origin>/api/requests/:id/attachments` — `multipart/form-data`
  (acknowledged but not stored in this KV-only backend; wire R2 to persist blobs).

## Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `OPTIONS` | `*` | — | CORS preflight |
| `GET` | `/overlay.js` | — | Serves the overlay bundle (proxied from jsDelivr) |
| `GET` | `/` or `/health` | — | Health check |
| `POST` | `/api/requests` | — | Create a report → KV (+ optional GitHub issue) |
| `POST` | `/api/requests/:id/attachments` | — | Accept attachment upload (not stored) |
| `GET` | `/api/requests` | `ADMIN_TOKEN` | List recent reports (newest first, max 100) |

Admin list auth: send `Authorization: Bearer <ADMIN_TOKEN>` or `?token=<ADMIN_TOKEN>`.

## Storage

Each report is written to KV under key `report:<ISO-timestamp>:<id>` so keys sort
chronologically. The admin `GET` lists them newest-first.

## Deploy

Prereqs: `npm i -g wrangler` and `wrangler login`.

```bash
cd workers/devlogs

# 1) Create the KV namespace, then paste the printed id into wrangler.toml
#    (the `id` field under [[kv_namespaces]]).
wrangler kv namespace create REPORTS
# optional, only if you want local `wrangler dev`:
wrangler kv namespace create REPORTS --preview   # paste as preview_id

# 2) Set secrets
wrangler secret put ADMIN_TOKEN        # required for the GET list endpoint
# optional — enable GitHub Issue mirroring:
wrangler secret put GITHUB_TOKEN       # GitHub PAT with repo/issues scope
wrangler secret put GITHUB_REPO        # e.g. hemangjoshi37a/karmyogi
#   (GITHUB_REPO may instead be set as a [vars] entry in wrangler.toml)

# 3) Set ALLOWED_ORIGIN in wrangler.toml [vars] to your app origin(s)
#    e.g. https://karmyogi.hjlabs.in (comma-separate multiple origins)

# 4) Deploy
wrangler deploy
```

`wrangler deploy` prints the Worker URL, e.g.
`https://karmyogi-devlogs.<your-subdomain>.workers.dev`.

## Point the app at it

In the **app's** `.env` (gitignored — see repo root `.env.example`):

```ini
VITE_DEVLOGS_ENDPOINT=https://karmyogi-devlogs.<your-subdomain>.workers.dev
```

Then rebuild/redeploy the app:

```bash
npm run build
```

Leaving `VITE_DEVLOGS_ENDPOINT` blank disables the overlay entirely — no script
injection, no network calls, no console errors.

## Local development

```bash
cd workers/devlogs
wrangler dev      # serves on http://localhost:8787 by default
```

Set `VITE_DEVLOGS_ENDPOINT=http://localhost:8787` in the app `.env`, or run the
upstream package directly with `npx @hemangjoshi37a/dev-logs` (default
`http://localhost:4445`) and point `VITE_DEVLOGS_ENDPOINT` there.

## Notes / extending

- **R2 for attachments:** add an `[[r2_buckets]]` binding and store the uploaded
  file in the `/api/requests/:id/attachments` handler.
- **CORS:** `ALLOWED_ORIGIN` echoes the request origin only when allow-listed;
  set `*` to allow any origin (not recommended for an admin-listable store).
- The body is size-limited to 64 KB; priority/category are validated against a
  fixed set and default to `medium`/`bug`.
