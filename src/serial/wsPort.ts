// WsPort — a `PortLike` backed by a WebSocket, so the GRBL transport stack can
// talk to a network-attached controller exactly like it talks to a USB serial
// port or the MockPort. This is what lets karmyogi drive ESP3D, grblHAL's
// WebSocket interface, or any tiny serial↔WebSocket bridge.
//
// It implements the SAME minimal `PortLike` interface GrblConnection/Streamer
// already consume (see grblConnection.ts and mockPort.ts):
//
//   readable  : ReadableStream<Uint8Array>  — bytes arriving from the device
//   writable  : WritableStream<Uint8Array>  — bytes we send to the device
//   open()    : opens the socket, resolves once connected (rejects on failure)
//   close()   : closes the socket and tears down the streams
//
// Because everything downstream is byte-oriented and newline-delimited, the
// WebSocket is used in BINARY mode: text frames are decoded to bytes, binary
// frames pass through untouched, and our writes go out as binary frames.
//
// NOTE on Telnet / raw TCP: browsers cannot open raw TCP or Telnet sockets, so
// there is no way to speak `telnet://host:23` (the classic ESP3D/grblHAL telnet
// port) directly from the page. To reach a telnet-only controller, run a tiny
// ws↔telnet bridge (e.g. websocketd / a 20-line Node relay) and point a WsPort
// at its `ws://` URL. We deliberately do NOT attempt raw TCP here.

import type { PortLike } from './grblConnection'

export interface WsPortOptions {
  /** ms to wait for the socket to open before failing. Default 8000. */
  connectTimeoutMs?: number
}

export class WsPort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  private ws: WebSocket | null = null
  private rxController: ReadableStreamDefaultController<Uint8Array> | null = null
  private readonly encoder = new TextEncoder()
  private opened = false

  constructor(
    private readonly url: string,
    private readonly opts: WsPortOptions = {},
  ) {
    if (!/^wss?:\/\//i.test(url)) {
      // Surface a clear, early error rather than a cryptic WebSocket failure.
      throw new Error(
        `WsPort URL must start with ws:// or wss:// (got "${url}"). ` +
          `Telnet/raw-TCP controllers need a ws↔telnet bridge.`,
      )
    }
  }

  /** Open the WebSocket. `baudRate` is accepted for interface parity but ignored. */
  async open(_options: { baudRate: number; [k: string]: unknown }): Promise<void> {
    if (this.opened) throw new Error('WsPort already open')
    if (typeof WebSocket === 'undefined') {
      throw new Error('WebSocket API is not available in this environment.')
    }

    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    // Wire the readable BEFORE the socket opens so no early frames are lost.
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.rxController = controller
      },
      cancel: () => {
        this.rxController = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          // Send a copy so a transferred/views-over-pooled buffer can't mutate.
          this.ws.send(chunk.slice())
        }
      },
    })

    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev)
    ws.onclose = () => this.teardownReadable()
    ws.onerror = () => {
      // onclose follows; teardown there. Errors before open reject below.
    }

    await this.waitForOpen(ws)
    this.opened = true
  }

  async close(): Promise<void> {
    this.opened = false
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onmessage = null
      ws.onerror = null
      ws.onclose = null
      try {
        ws.close()
      } catch {
        /* already closing/closed */
      }
    }
    this.teardownReadable()
    this.writable = null
  }

  // --- internals -------------------------------------------------------------

  private waitForOpen(ws: WebSocket): Promise<void> {
    const timeoutMs = this.opts.connectTimeoutMs ?? 8000
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket connect to ${this.url} timed out after ${timeoutMs}ms.`))
      }, timeoutMs)

      ws.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`WebSocket connection to ${this.url} failed.`))
      })
      ws.addEventListener('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`WebSocket to ${this.url} closed before opening.`))
      })
    })
  }

  private onMessage(ev: MessageEvent): void {
    if (!this.rxController) return
    let bytes: Uint8Array | null = null
    const data = ev.data
    if (typeof data === 'string') {
      bytes = this.encoder.encode(data)
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data)
    } else if (data && typeof (data as Blob).arrayBuffer === 'function') {
      // Blob — read asynchronously, then enqueue.
      void (data as Blob).arrayBuffer().then((buf) => {
        try {
          this.rxController?.enqueue(new Uint8Array(buf))
        } catch {
          /* closed */
        }
      })
      return
    }
    if (bytes && bytes.length) {
      try {
        this.rxController.enqueue(bytes)
      } catch {
        /* closed */
      }
    }
  }

  private teardownReadable(): void {
    try {
      this.rxController?.close()
    } catch {
      /* already closed */
    }
    this.rxController = null
    this.readable = null
  }
}
