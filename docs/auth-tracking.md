# Auth, activity tracking & bug reports

karmyogi can optionally gate access behind **Google sign-in (Firebase Auth)**,
record **per-user activity** to **Cloud Firestore**, and surface a floating
**dev-logs** bug-report widget. All three are **opt-in via environment
variables** and **gracefully disabled** when unconfigured.

## Graceful degradation (important)

The app reads its config from `import.meta.env.VITE_*` (see `.env.example`).
A single helper, `firebaseConfigured()` (`src/auth/firebase.ts`), returns `true`
only when **real** Firebase values are present (placeholders like `your-api-key`
and empty values are rejected).

- **Unconfigured** (no `.env`, or placeholder values):
  - Auth gate is **bypassed** — the app is fully open, exactly as before.
  - Activity tracking **no-ops** (never touches the network).
  - dev-logs overlay loads only on `localhost`/dev (against the default
    `http://localhost:4445`) and is hidden in production.
- **Configured**: sign-in screen gates the app, tracking writes events, and a
  user chip + sign-out appear in the top bar.

You can therefore run/test the live app with **no `.env` at all**.

## 1. Firebase setup

1. Create a Firebase project at <https://console.firebase.google.com>.
2. **Authentication → Sign-in method →** enable the **Google** provider.
3. **Authentication → Settings → Authorized domains →** add:
   - `karmyogi.hjlabs.in`
   - `192.168.3.200`
   - `localhost`
4. **Firestore Database →** create a database (production mode is fine — the
   rules below lock it down).
5. **Project settings → Your apps →** add a **Web app** and copy its SDK config
   into your `.env` (see keys below).
6. Deploy the security rules (see `firestore.rules`):
   ```bash
   firebase deploy --only firestore:rules
   ```

### Firestore rules (`firestore.rules`)

Each signed-in user owns a private subtree `users/{uid}/**`. The app writes
events to `users/{uid}/events/{id}`. A user may **create + read only their own**
docs; updates/deletes from the client are denied, and everything else is denied
by default.

### Data model

Events are written to `users/{uid}/events/{autoId}`:

```jsonc
{
  "type": "click",            // event taxonomy (see below)
  "ts": 1733400000000,        // client epoch ms
  "serverTs": <serverTimestamp>,
  "sessionId": "s-abc-1",     // one app load = one session
  "uid": "…",
  "tab": "cadcam",            // active tab/panel id when known
  // …small, type-specific payload (no file contents, nothing huge)
}
```

## 2. `.env` keys

Copy `.env.example` to `.env` and fill in:

| Key | Required | Purpose |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | yes | Firebase web API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | yes | `<project>.firebaseapp.com` |
| `VITE_FIREBASE_PROJECT_ID` | yes | Firebase project id |
| `VITE_FIREBASE_STORAGE_BUCKET` | rec. | `<project>.appspot.com` |
| `VITE_FIREBASE_MESSAGING_SENDER_ID` | rec. | FCM sender id |
| `VITE_FIREBASE_APP_ID` | yes | Firebase web app id |
| `VITE_FIREBASE_MEASUREMENT_ID` | opt. | enables Analytics when set |
| `VITE_DEVLOGS_ENDPOINT` | opt. | dev-logs server URL (see below) |

The auth gate + tracking turn on once `API_KEY`, `AUTH_DOMAIN`, `PROJECT_ID` and
`APP_ID` are all present. These are client-side keys (safe to ship in the bundle);
security is enforced by Auth + the Firestore rules, never by hiding them. **Never**
put admin/service-account secrets in `.env`.

## 3. Activity tracking — what is captured

Tracking is **centralized** (no per-panel instrumentation) via global listeners
installed once by `useActivityTracking()` (`src/track/useActivityTracking.ts`),
buffered + batched by `src/track/activity.ts` (flush every ~5s, or every 25
events, and on `visibilitychange`/`pagehide`).

| `type` | Trigger | Payload |
|---|---|---|
| `session_start` | sign-in / app load while signed in | viewport, userAgent, language, sessionId |
| `click` | document-capture click listener | tag, classes, label (aria/title/text), selector path |
| `file_upload` | capture `change` on `input[type=file]` | filename, size, mime, accept (metadata only — never contents) |
| `tab_enter` | active dockview panel changes | tab id |
| `tab_dwell` | leaving a tab | tab id, seconds spent |
| `program_generated` | `useProgram` store change | section names, section count, line count |
| `error` | `window.onerror` | message, source, truncated stack |
| `unhandled_rejection` | `unhandledrejection` | message, truncated stack |
| `visibility` | `visibilitychange` | `visible` / `hidden` |

No file **contents** are ever stored — only metadata.

## 4. dev-logs bug-report widget

karmyogi embeds [`@hemangjoshi37a/dev-logs`](https://www.npmjs.com/package/@hemangjoshi37a/dev-logs).
Its embed API is an injectable overlay script: the package ships a standalone
server (`npx @hemangjoshi37a/dev-logs`, default `http://localhost:4445`) that
serves `overlay.js`. Loading that script renders the floating purple bug button
(toggle with **Ctrl+D**) and posts submissions to the same origin's
`/api/requests`.

`src/integrations/devlogs.ts` injects `<endpoint>/overlay.js`:

- `VITE_DEVLOGS_ENDPOINT` set → use that server.
- unset, on dev/localhost → fall back to `http://localhost:4445`.
- unset, in production → not injected (hidden).

The signed-in user (uid/email) is published on `window.__karmyogiContext` so
reports are attributable; the overlay also auto-captures page URL, viewport,
user-agent and console errors.

To run the dev-logs server locally:

```bash
npx @hemangjoshi37a/dev-logs        # serves dashboard + overlay on :4445
```
