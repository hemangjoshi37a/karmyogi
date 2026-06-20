// DEV-ONLY Vite plugin (plain JS — intentionally outside the app tsconfig so it
// can use Node APIs without pulling @types/node into the browser build).
//
// A general "developer observability + control" relay between the BROWSER app
// and an agent/developer on the SERVER. It complements the camera + machine
// bridges by exposing the *whole app state* and a *machine-independent command
// channel*, so the app can be observed and driven from the server WITHOUT the
// user having to touch the browser (focus a panel, read calibration, etc.):
//
//   • POST /__app_state  — the browser (src/dev/devBridge.ts) pushes a JSON
//     snapshot of the relevant zustand stores every ~600ms.
//   • GET  /__app_state  — the server reads that snapshot (live app state).
//   • POST /__app_cmd    — the server enqueues an app action, e.g.
//     {action:"autoAlign"} or {action:"focus:visualizer"}.
//   • GET  /__app_cmd    — the browser drains the queue (run-once) and
//     dispatches each action (focus a tab / fire a `karmyogi:app` event).
//
// Unlike the machine bridge, this channel does NOT require the GRBL machine to
// be connected — it always runs in dev — so panel focus / mosaic / mask / tuning
// actions work even with no hardware. Serve-time only (apply: 'serve').
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const DIR = '.dev-bridge'
const STATE_FILE = `${DIR}/app-state.json`
const MAX_BODY = 4 * 1024 * 1024 // 4MB guard — app-state JSON is small but be generous
const MAX_QUEUE = 256

// In-memory FIFO of app actions the server has queued for the browser.
// Each entry: { action: string, _t: number } (enqueue time, ms).
let pending = []

// Boot id — changes whenever this plugin module is (re)loaded, i.e. whenever the
// Vite dev server restarts. Lets the server-side agent detect a restart (and thus
// a forced browser reload) deterministically. Also records the latest app-state
// push time so the agent can tell whether the BROWSER tab is alive/foreground.
const BOOT_ID = `${process.pid}-${Date.now()}`
let lastStatePushAt = 0

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, code, obj) {
  res.statusCode = code
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(obj))
}

export function devBridgeReceiver() {
  return {
    name: 'karmyogi-dev-bridge-receiver',
    apply: 'serve',
    configureServer(server) {
      // --- GET /__bridge_ping : restart + tab-liveness probe -----------------
      // bootId changes on every dev-server restart (so the agent can confirm a
      // forced reload happened); stateAgeMs tells how long since the browser last
      // pushed app state (small ⇒ a live tab is connected and its timers run).
      server.middlewares.use('/__bridge_ping', (req, res, next) => {
        if (req.method !== 'GET') return next()
        sendJson(res, 200, {
          bootId: BOOT_ID,
          now: Date.now(),
          lastStatePushAt,
          stateAgeMs: lastStatePushAt ? Date.now() - lastStatePushAt : null,
          queued: pending.length,
        })
      })

      // --- /__app_state : browser POSTs snapshot; server GETs it -------------
      server.middlewares.use('/__app_state', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(readFileSync(STATE_FILE, 'utf8'))
          } catch {
            sendJson(res, 404, { error: 'no app state yet' })
          }
          return
        }
        if (req.method !== 'POST') return next()
        readBody(req)
          .then((body) => {
            // Validate it parses, then write the raw (pretty) text for the server.
            let parsed
            try {
              parsed = JSON.parse(body || '{}')
            } catch {
              sendJson(res, 400, { error: 'invalid JSON' })
              return
            }
            mkdirSync(DIR, { recursive: true })
            writeFileSync(STATE_FILE, JSON.stringify(parsed, null, 2))
            lastStatePushAt = Date.now()
            sendJson(res, 200, { ok: true })
          })
          .catch(() => sendJson(res, 413, { error: 'body too large' }))
      })

      // --- POST /__app_cmd : server queues an app action ---------------------
      server.middlewares.use('/__app_cmd', (req, res, next) => {
        if (req.method === 'GET') {
          // browser drains the queue (run-once semantics)
          const cmds = pending
          pending = []
          sendJson(res, 200, { cmds })
          return
        }
        if (req.method !== 'POST') return next()
        readBody(req)
          .then((body) => {
            let parsed
            try {
              parsed = JSON.parse(body || '{}')
            } catch {
              sendJson(res, 400, { error: 'invalid JSON' })
              return
            }
            const action = typeof parsed.action === 'string' ? parsed.action : null
            if (!action) {
              sendJson(res, 400, { error: 'expected {action:string}' })
              return
            }
            pending.push({ action, _t: Date.now() })
            if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE)
            // eslint-disable-next-line no-console
            console.log(`[dev-bridge] action ${action} (queue=${pending.length})`)
            sendJson(res, 200, { ok: true, queued: pending.length })
          })
          .catch(() => sendJson(res, 413, { error: 'body too large' }))
      })
    },
  }
}
