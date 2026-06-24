#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// wifi-relay.mjs — a tiny `wss://` → `ws://` bridge for networked GRBL boards.
//
// WHY: a browser FORBIDS an insecure `ws://` connection from a page served over
// `https:` (mixed active content). FluidNC / ESP3D / MKS DLC32 boards only speak
// plain `ws://` (no TLS), so the DEPLOYED (https) karmyogi at karmyogi.hjlabs.in
// can't reach them directly. This relay runs on your LAN, presents a `wss://`
// endpoint (TLS, so the https page is happy), and forwards every byte to the
// board's plain `ws://`. Paste the printed `wss://…` URL into karmyogi's
// Connect ▸ Wi-Fi (WebSocket) Host field.
//
// USAGE (from the repo root, after `npm install`):
//   node scripts/wifi-relay.mjs --target 192.168.29.128:80
//   node scripts/wifi-relay.mjs --target ws://192.168.29.128:80 --port 8443
//   PORT=8443 TARGET=192.168.29.128:80 node scripts/wifi-relay.mjs
//
// Options:
//   --target <host[:port] | ws://host:port>   the board's WebSocket (required)
//   --port   <n>     local wss listen port (default 8443)
//   --host   <addr>  local bind address (default 0.0.0.0 = all interfaces)
//   --cert <file> --key <file>   use your own TLS cert/key (else self-signed)
//
// The first time you connect, the browser will warn about the self-signed cert.
// Open the printed https://… URL once and accept it, then connect from karmyogi.
// ─────────────────────────────────────────────────────────────────────────────

import https from 'node:https'
import os from 'node:os'
import { readFileSync } from 'node:fs'
import { WebSocketServer, WebSocket } from 'ws'
import selfsigned from 'selfsigned'

// ── arg parsing (--flag value, plus env fallbacks) ──────────────────────────
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    }
  }
  return out
}
const args = parseArgs(process.argv.slice(2))
const rawTarget = args.target ?? process.env.TARGET
const listenPort = Number(args.port ?? process.env.PORT ?? 8443)
const bindAddr = args.host ?? process.env.HOST ?? '0.0.0.0'

if (!rawTarget || rawTarget === true) {
  console.error(
    'Missing --target. Example:\n' +
      '  node scripts/wifi-relay.mjs --target 192.168.29.128:80\n',
  )
  process.exit(1)
}
if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
  console.error(`Bad --port "${args.port ?? process.env.PORT}": must be 1–65535.`)
  process.exit(1)
}

/** Normalize a target into a ws://host:port URL (default port 80). */
function normalizeTarget(t) {
  let s = String(t).trim()
  if (/^wss?:\/\//i.test(s)) return s
  s = s.replace(/^https?:\/\//i, '')
  const slash = s.indexOf('/')
  let authority = slash >= 0 ? s.slice(0, slash) : s
  const path = slash >= 0 ? s.slice(slash) : ''
  if (!/:\d+$/.test(authority)) authority += ':80'
  return `ws://${authority}${path}`
}
const targetUrl = normalizeTarget(rawTarget)

// ── TLS credentials: provided cert/key, else a runtime self-signed cert ──────
let credentials
if (args.cert && args.key) {
  credentials = { cert: readFileSync(args.cert), key: readFileSync(args.key) }
  console.log(`Using TLS cert ${args.cert}`)
} else {
  const pems = selfsigned.generate([{ name: 'commonName', value: 'karmyogi-wifi-relay' }], {
    days: 3650,
    keySize: 2048,
    algorithm: 'sha256',
  })
  credentials = { cert: pems.cert, key: pems.private }
  console.log('Using a generated self-signed certificate (accept it once in the browser).')
}

/** LAN IPv4 addresses, so we can print the wss:// URL(s) to paste into karmyogi. */
function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address)
    }
  }
  return out
}

// ── server: terminate wss, forward each client to a fresh upstream ws ────────
const server = https.createServer(credentials)
const wss = new WebSocketServer({ server })

wss.on('connection', (client, req) => {
  const peer = req.socket.remoteAddress
  console.log(`▶ client connected (${peer}) → dialing ${targetUrl}`)
  const upstream = new WebSocket(targetUrl)
  // Buffer anything the client sends before the upstream is open.
  const pending = []
  let upstreamOpen = false

  const closeBoth = (code, reason) => {
    try {
      client.close(code, reason)
    } catch {
      /* ignore */
    }
    try {
      upstream.close(code, reason)
    } catch {
      /* ignore */
    }
  }

  upstream.on('open', () => {
    upstreamOpen = true
    for (const m of pending.splice(0)) upstream.send(m)
    console.log(`✓ bridged client(${peer}) ↔ ${targetUrl}`)
  })
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary })
  })
  upstream.on('close', () => closeBoth())
  upstream.on('error', (e) => {
    console.error(`✗ upstream error (${targetUrl}): ${e?.message ?? e}`)
    closeBoth()
  })

  client.on('message', (data, isBinary) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
    } else {
      pending.push(data)
    }
  })
  client.on('close', () => {
    console.log(`◀ client disconnected (${peer})`)
    closeBoth()
  })
  client.on('error', () => closeBoth())
})

server.on('error', (e) => {
  if (e?.code === 'EADDRINUSE') {
    console.error(`Port ${listenPort} is already in use — pick another with --port.`)
  } else {
    console.error(`Server error: ${e?.message ?? e}`)
  }
  process.exit(1)
})

server.listen(listenPort, bindAddr, () => {
  const addrs = lanAddresses()
  console.log('\n  karmyogi Wi-Fi relay is up.')
  console.log(`  forwarding  wss://<this-host>:${listenPort}  →  ${targetUrl}\n`)
  console.log('  1) Accept the cert once: open ONE of these in your browser and proceed:')
  for (const a of addrs) console.log(`        https://${a}:${listenPort}/`)
  if (addrs.length === 0) console.log(`        https://localhost:${listenPort}/`)
  console.log('\n  2) In karmyogi → Connect ▸ Wi-Fi (WebSocket), paste as the Host:')
  for (const a of addrs) console.log(`        wss://${a}:${listenPort}`)
  if (addrs.length === 0) console.log(`        wss://localhost:${listenPort}`)
  console.log('\n  (Ctrl-C to stop.)\n')
})
