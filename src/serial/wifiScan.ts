// LAN subnet scanner for networked GRBL controllers (FluidNC / ESP3D / grblHAL
// over WebSocket, MKS DLC32, any serial↔ws bridge).
//
// The single-host Wi-Fi connect (controller.connectWebSocket) already AUTO-DETECTS
// the WebSocket *port* for a known IP by probing 81/82/8080/80. This module is the
// complement: it sweeps an entire /24 subnet's IPs so the user can DISCOVER every
// networked controller instead of typing each IP by hand, then add the found ones
// to the Machine Farm.
//
// A host counts as "found" the moment a WebSocket OPENS at ws(s)://{ip}:{port} —
// exactly mirroring the controller's `probeWs` (resolve true on `onopen`, false on
// error/close/timeout, and ALWAYS close the probe socket). We do NOT run the GRBL
// handshake here: an open socket on a controller port is a strong-enough signal,
// and the real connect (which does handshake) happens when the user picks a hit.
//
// MIXED-CONTENT: a `ws://` probe is blocked by the browser from an `https:` page
// (see wsPort.mixedContentReason). The scan is therefore only meaningful on the
// http LAN build; the UI gates on `mixedContentReason` before ever calling here.
//
// Pure-ish: no React/DOM/zustand imports — just WebSocket + the wsPort helpers, so
// it stays portable and testable through the running app.

import { normalizeWsUrl, mixedContentReason } from './wsPort'

/** One discovered controller: the host IP, the port that answered, and the URL. */
export interface WsScanHit {
  host: string
  port: number
  url: string
}

export interface ScanWsSubnetOptions {
  /** WebSocket ports to probe per host. Default `[80, 81]` (common ESP3D/FluidNC). */
  ports?: number[]
  /** Max simultaneous probe sockets in flight. Default 24. */
  concurrency?: number
  /** ms before a probe gives up on a single host:port. Default 1200. */
  timeoutMs?: number
  /** Abort the whole sweep (cancels in-flight + pending probes). */
  signal?: AbortSignal
  /** Progress callback: (probesDone, probesTotal). Fires after each probe settles. */
  onProgress?: (done: number, total: number) => void
  /** Fires the instant a host:port answers, so the UI can stream hits live. */
  onFound?: (hit: WsScanHit) => void
}

/**
 * The first three octets of an IPv4 address (its /24 subnet base), or null if the
 * input isn't a dotted-quad IPv4. Accepts a bare IP, an `ip:port`, or a ws(s):// URL
 * — anything `normalizeWsUrl`/`URL` can yield a hostname from. Hostnames (e.g.
 * `esp32.local`) and IPv6 return null (no meaningful /24 to sweep).
 */
export function subnetBaseFromHost(host: string): string | null {
  if (!host) return null
  let h = host.trim()
  // Pull the hostname out of a ws(s):// or bare host[:port] form.
  if (/^wss?:\/\//i.test(h)) {
    try {
      h = new URL(h).hostname
    } catch {
      return null
    }
  } else {
    // Strip any path then any :port (IPv4 only — no brackets to worry about).
    h = h.split('/')[0]
    const colon = h.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon)
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return null
  const oct = m.slice(1, 5).map((n) => Number(n))
  if (oct.some((n) => n < 0 || n > 255)) return null
  return `${oct[0]}.${oct[1]}.${oct[2]}`
}

/**
 * Probe a single ws(s):// URL: resolve true if the socket OPENS within `timeoutMs`,
 * false on error/close/timeout. ALWAYS closes the probe socket. Aborts to false if
 * `signal` fires. Mirrors controller.probeWs exactly.
 */
function probeWs(url: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof WebSocket === 'undefined') return resolve(false)
    if (signal?.aborted) return resolve(false)
    let settled = false
    let ws: WebSocket | null = null
    let onAbort: (() => void) | null = null
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (onAbort && signal) signal.removeEventListener('abort', onAbort)
      try {
        ws?.close()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    if (signal) {
      onAbort = () => finish(false)
      signal.addEventListener('abort', onAbort)
    }
    try {
      ws = new WebSocket(url)
      ws.onopen = () => finish(true)
      ws.onerror = () => finish(false)
      ws.onclose = () => finish(false)
    } catch {
      finish(false)
    }
  })
}

/**
 * Sweep a /24 subnet for WebSocket-attached GRBL controllers.
 *
 * `base` is the first three octets (e.g. `192.168.29`). Probes
 * `ws(s)://{base}.{n}:{port}` for n in 0..255 × each `port`, batched at
 * `concurrency`. Resolves with the list of hosts that answered (also streamed via
 * `onFound`). Honours `signal` to abort early. Throws synchronously if `base` would
 * be blocked as mixed content from this (https) page — the caller should gate on
 * `mixedContentReason` first, but this is a backstop so a doomed scan fails loudly.
 */
export async function scanWsSubnet(
  base: string,
  opts: ScanWsSubnetOptions = {},
): Promise<WsScanHit[]> {
  const cleanBase = base.trim().replace(/\.+$/, '')
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanBase)) {
    throw new Error(`Subnet base must be three octets, e.g. "192.168.1" (got "${base}").`)
  }
  const ports = opts.ports && opts.ports.length ? opts.ports : [80, 81]
  const concurrency = Math.max(1, opts.concurrency ?? 24)
  const timeoutMs = opts.timeoutMs ?? 1200
  const { signal, onProgress, onFound } = opts

  // Backstop mixed-content gate: every probe shares the same scheme+host class, so
  // checking one representative is enough.
  const blocked = mixedContentReason(normalizeWsUrl(`${cleanBase}.1`, ports[0]))
  if (blocked) throw new Error(blocked)

  // Build the full probe list: every host × every port.
  const targets: { host: string; port: number; url: string }[] = []
  for (let n = 0; n <= 255; n++) {
    const host = `${cleanBase}.${n}`
    for (const port of ports) {
      targets.push({ host, port, url: normalizeWsUrl(host, port) })
    }
  }

  const total = targets.length
  const hits: WsScanHit[] = []
  let done = 0
  let next = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) return
      const i = next++
      if (i >= targets.length) return
      const tgt = targets[i]
      const ok = await probeWs(tgt.url, timeoutMs, signal)
      if (ok) {
        const hit: WsScanHit = { host: tgt.host, port: tgt.port, url: tgt.url }
        hits.push(hit)
        try {
          onFound?.(hit)
        } catch {
          /* swallow listener errors */
        }
      }
      done++
      try {
        onProgress?.(done, total)
      } catch {
        /* swallow listener errors */
      }
    }
  }

  const pool = Array.from({ length: Math.min(concurrency, targets.length) }, () => worker())
  await Promise.all(pool)
  // Stable order: by host's last octet, then port.
  hits.sort((a, b) => {
    const oa = Number(a.host.split('.')[3])
    const ob = Number(b.host.split('.')[3])
    return oa - ob || a.port - b.port
  })
  return hits
}
