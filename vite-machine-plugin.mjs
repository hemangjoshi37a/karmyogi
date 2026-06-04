// DEV-ONLY Vite plugin (plain JS — intentionally outside the app tsconfig so it
// can use Node APIs without pulling @types/node into the browser build).
//
// Mirrors vite-camera-plugin.mjs, but for the GRBL MACHINE. The machine is
// connected via Web Serial in the BROWSER; the agent/developer runs on the
// SERVER. This plugin is the relay between them:
//
//   • The SERVER (curl/agent) enqueues commands via POST /__machine_enqueue and
//     reads live machine state from ./.machine-bridge/state.json + console.log.
//   • The BROWSER (src/machine/machineBridge.ts) polls GET /__machine_cmd to run
//     the queued commands through the GRBL controller, and POSTs the latest
//     machine snapshot to POST /__machine_state.
//
// SAFETY: this is a serve-time-only (apply: 'serve') dev convenience for the LAN
// dev server. The browser bridge only RELAYS what is queued here through the
// controller's normal grbl.send/realtime path — nothing here moves the machine.
import { writeFileSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { Buffer } from 'node:buffer'

const DIR = '.machine-bridge'
const STATE_FILE = `${DIR}/state.json`
const CONSOLE_FILE = `${DIR}/console.log`
const MAX_BODY = 1 * 1024 * 1024 // 1MB guard — machine payloads are tiny JSON
const MAX_QUEUE = 256 // bound the queue so a looping enqueuer can't grow it unbounded

// In-memory FIFO of commands the server has queued for the browser to run.
// Each entry is one of: {cmd:string} | {realtime:number} | {lines:string[]},
// stamped with `_t` (enqueue time, ms) so the browser can drop stale commands.
let pending = []

/** Collect a request body (with a size guard) and resolve the UTF-8 string. */
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

export function machineBridgeReceiver() {
  return {
    name: 'karmyogi-machine-bridge-receiver',
    apply: 'serve',
    configureServer(server) {
      // --- POST /__machine_enqueue : server queues a command for the browser ---
      server.middlewares.use('/__machine_enqueue', (req, res, next) => {
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
            // Accept exactly one command shape per request, but be lenient about
            // which: {cmd} | {realtime} | {lines}.
            const cmd = {}
            if (typeof parsed.cmd === 'string') cmd.cmd = parsed.cmd
            else if (typeof parsed.realtime === 'number') cmd.realtime = parsed.realtime
            else if (Array.isArray(parsed.lines)) {
              cmd.lines = parsed.lines.filter((l) => typeof l === 'string')
            } else {
              sendJson(res, 400, {
                error: 'expected {cmd:string} | {realtime:number} | {lines:string[]}',
              })
              return
            }
            cmd._t = Date.now() // enqueue timestamp → browser drops stale commands
            pending.push(cmd)
            // Bound the queue (drop oldest) so a runaway enqueuer can't grow it.
            if (pending.length > MAX_QUEUE) pending.splice(0, pending.length - MAX_QUEUE)
            // eslint-disable-next-line no-console
            console.log(`[machine-bridge] enqueue ${JSON.stringify(cmd)} (queue=${pending.length})`)
            sendJson(res, 200, { ok: true, queued: pending.length })
          })
          .catch(() => sendJson(res, 413, { error: 'body too large' }))
      })

      // --- GET /__machine_cmd : browser drains the queue (run-once semantics) ---
      server.middlewares.use('/__machine_cmd', (req, res, next) => {
        if (req.method !== 'GET') return next()
        const cmds = pending
        pending = []
        sendJson(res, 200, { cmds })
      })

      // --- /__machine_state : browser POSTs snapshot; server may GET the file ---
      server.middlewares.use('/__machine_state', (req, res, next) => {
        if (req.method === 'GET') {
          try {
            const raw = readFileSync(STATE_FILE, 'utf8')
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(raw)
          } catch {
            sendJson(res, 404, { error: 'no state yet' })
          }
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
            mkdirSync(DIR, { recursive: true })
            // Separate the (potentially large/streaming) console lines from the
            // single-shot latest-state snapshot.
            const { console: consoleLines, ...state } = parsed
            writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
            if (Array.isArray(consoleLines) && consoleLines.length > 0) {
              const text =
                consoleLines
                  .map((l) => (typeof l === 'string' ? l : JSON.stringify(l)))
                  .join('\n') + '\n'
              appendFileSync(CONSOLE_FILE, text)
            }
            sendJson(res, 200, { ok: true })
          })
          .catch(() => sendJson(res, 413, { error: 'body too large' }))
      })
    },
  }
}
