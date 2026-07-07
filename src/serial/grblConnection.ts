// GRBL serial connection over the Web Serial API.
//
// This module owns the physical transport: opening a port, the read loop that
// decodes incoming bytes into newline-delimited lines, and the low-level write
// paths (line writes and single realtime bytes). It is intentionally agnostic
// about flow control and protocol semantics — those live in streamer.ts.
//
// The transport is INJECTABLE: anything implementing `PortLike` can be passed
// in (the real `SerialPort` does, and so does `MockPort`), so the whole stack
// is unit-testable without hardware.

import { XM, XMODEM_BLOCK, crc16ccitt } from './xmodem'

/**
 * The minimal subset of the Web Serial `SerialPort` we rely on. `MockPort`
 * implements the same shape so tests and the dev UI run with no device.
 */
export interface PortLike {
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  open(options: { baudRate: number; [k: string]: unknown }): Promise<void>
  close(): Promise<void>
}

export interface GrblConnectionOptions {
  baudRate?: number
  /** Called with each complete line received (newline stripped). */
  onLine?: (line: string) => void
  /** Called when the read loop ends or errors (e.g. unplug). */
  onDisconnect?: (error?: unknown) => void
}

const DEFAULT_BAUD = 115200

/**
 * A SINGLE global "an open() is in flight" lock, shared across every code path
 * that opens a Web Serial / WebUSB port (the live connect, silent auto-reconnect,
 * AND the firmware-probe scan). A `SerialPort` can only be opened once: two
 * near-simultaneous `open()` calls on the same handle make the browser throw
 *   "Failed to execute 'open' on 'SerialPort': A call to open() is already in
 *    progress."
 * which used to kill the silent reconnect and force the user to click Connect.
 *
 * React 18 StrictMode double-invokes effects, and the load path fans out into
 * several openers (App's autoConnect + ConnectionControl's probe scan), so these
 * races are routine in a single tab with nothing actually running.
 *
 * Rather than coordinate every caller pairwise, we serialize ALL port opens
 * through one promise chain: an opener appends its open to the chain and awaits
 * the predecessor first. Opens of *different* physical ports still serialize
 * (the browser/OS dislikes concurrent opens anyway, and probing is already
 * sequential by design), which is acceptable — opening is fast.
 */
let openChain: Promise<void> = Promise.resolve()

/**
 * Run `fn` (which performs a `port.open(...)`) under the global open lock. Any
 * other opener that arrives while one is in flight waits for it to finish before
 * issuing its own `open()`, so the browser never sees two concurrent opens.
 * Errors from `fn` are isolated so one failed open doesn't wedge the chain.
 */
export function withOpenLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = openChain.then(fn, fn)
  // Keep the chain alive regardless of success/failure, but never reject it.
  openChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * Per-port exclusion that spans a handle's WHOLE busy window (open → use →
 * close), not just the open() call. The probe scan opens a port, reads for ~1s,
 * then closes it; a connect to the SAME handle must not slip in during that
 * window (it would adopt a port the probe is about to close). Keyed by the
 * SerialPort/PortLike object identity. `withPortBusy` waits for any prior holder
 * of the same port, runs `fn`, then releases — serializing same-port work while
 * letting DIFFERENT ports proceed in parallel.
 */
const portBusy = new WeakMap<object, Promise<void>>()

export async function withPortBusy<T>(port: object, fn: () => Promise<T>): Promise<T> {
  const prev = portBusy.get(port) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  // Our turn completes only after the predecessor AND our own work (gate) finish,
  // so a later caller waits for us too. Stored so we can clear it when last.
  const mine = prev.then(() => gate)
  portBusy.set(port, mine)
  await prev.catch(() => {})
  try {
    return await fn()
  } finally {
    release()
    // Clear the slot if no one chained after us, so the map doesn't grow.
    if (portBusy.get(port) === mine) portBusy.delete(port)
  }
}

/** Match the browser's "port is busy being opened / already open" DOMExceptions. */
export function isAlreadyOpenError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /already in progress|already open|in use|is open/i.test(msg)
}

/**
 * True when a `PortLike` is already physically open (its streams are live), so a
 * second `open()` must be skipped. Web Serial / WebUSB expose `readable` once
 * open; a closed port has `readable === null`.
 */
export function isPortOpen(port: PortLike): boolean {
  return port.readable != null
}

export class GrblConnection {
  private port: PortLike | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private readLoopPromise: Promise<void> | null = null
  private closing = false
  private rxBuffer = ''
  // When set (during an XMODEM upload), the read loop routes raw bytes here
  // instead of the line parser, so the binary transfer isn't mangled by line
  // framing. Null in normal operation — the line path is completely unchanged.
  private xmodemSink: ((b: number) => void) | null = null
  private readonly decoder = new TextDecoder()

  readonly options: Required<Pick<GrblConnectionOptions, 'baudRate'>> &
    GrblConnectionOptions

  constructor(opts: GrblConnectionOptions = {}) {
    this.options = { baudRate: opts.baudRate ?? DEFAULT_BAUD, ...opts }
  }

  get isOpen(): boolean {
    return this.port !== null && !this.closing
  }

  /**
   * Request a serial port from the browser (must be called from a user
   * gesture) and open it. Returns the chosen port. Throws if Web Serial is
   * unavailable.
   */
  static async requestPort(
    filters?: SerialPortFilter[],
  ): Promise<SerialPort> {
    if (typeof navigator === 'undefined' || !navigator.serial) {
      throw new Error(
        'Web Serial API is not available (use Chrome/Edge over HTTPS or localhost).',
      )
    }
    return navigator.serial.requestPort(
      filters ? { filters } : undefined,
    )
  }

  /** Open the given port and start the read loop. */
  async open(port: PortLike): Promise<void> {
    if (this.port) throw new Error('Connection already open')
    this.closing = false
    this.rxBuffer = ''
    // Serialize against every other user of THIS handle (a probe scan opening +
    // reading + closing it, or a racing auto-connect) so the browser never sees
    // two concurrent open() calls on the same SerialPort (the "already in
    // progress" error) and a connect never slips into a probe's open/close
    // window. withPortBusy waits out any prior holder of this exact port; the
    // extra global open lock additionally avoids two DIFFERENT ports opening at
    // the same instant (the OS dislikes it). If the port is ALREADY open once we
    // hold the lock, adopt it rather than re-opening.
    await withPortBusy(port as object, () =>
      withOpenLock(async () => {
        if (isPortOpen(port)) return
        try {
          await port.open({ baudRate: this.options.baudRate })
        } catch (err) {
          // A concurrent opener won the race on this exact handle: don't surface
          // the scary native error — if it ended up open, adopt it; otherwise
          // rethrow for the caller's normal handling.
          if (isAlreadyOpenError(err) && isPortOpen(port)) return
          throw err
        }
      }),
    )
    this.port = port

    // ESP32-based controllers (FluidNC, GRBL-ESP32, grblHAL-ESP32) AUTO-RESET when
    // the serial DTR/RTS control lines toggle — that's the esptool/Arduino
    // auto-reset circuit (DTR→EN, RTS→IO0). Chrome's Web Serial asserts BOTH lines
    // on open, which can reboot the controller a second or two after connecting and
    // drop the link ("connects, then disconnects after ~2-3 s"). Deassert both
    // right after open so the board runs normally and the connection stays up.
    // Guarded: only real Web Serial ports expose setSignals (Mock / WebUSB / BLE /
    // WebSocket don't), and any failure here is non-fatal.
    const sp = port as unknown as {
      setSignals?: (s: { dataTerminalReady?: boolean; requestToSend?: boolean }) => Promise<void>
    }
    if (typeof sp.setSignals === 'function') {
      try {
        await sp.setSignals({ dataTerminalReady: false, requestToSend: false })
      } catch {
        /* setSignals unsupported or rejected — non-fatal; continue. */
      }
    }

    if (!port.writable) throw new Error('Port is not writable')
    this.writer = port.writable.getWriter()

    this.readLoopPromise = this.readLoop()
  }

  private async readLoop(): Promise<void> {
    // Count CONSECUTIVE read errors that left the USB device still enumerated, so a
    // transient blip is tolerated but a truly wedged stream eventually gives up.
    // Reset to 0 the moment bytes flow again. ~12 × 300ms ≈ 3.6s of tolerance —
    // comfortably covers an ESP32 controller's one-time auto-reset reboot (~1.5-2s).
    let transientErrors = 0
    const MAX_TRANSIENT_ERRORS = 12
    while (this.port && this.port.readable && !this.closing) {
      const reader = this.port.readable.getReader()
      this.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) {
            transientErrors = 0
            if (this.xmodemSink) {
              // Raw mode (XMODEM upload): hand every byte to the transfer.
              for (let i = 0; i < value.length; i++) this.xmodemSink(value[i])
            } else {
              this.ingest(value)
            }
          }
        }
        reader.releaseLock()
        this.reader = null
      } catch (err) {
        reader.releaseLock()
        this.reader = null
        if (this.closing) return
        // A read error while the device is STILL enumerated is usually TRANSIENT,
        // not a real unplug. The big one: an ESP32 controller (FluidNC / GRBL-ESP32
        // / grblHAL-ESP32) AUTO-RESETS when the port opens (DTR/RTS → EN), so it
        // reboots ~1.5-2s after connect; the CP210x bridge stays enumerated
        // (`port.readable` becomes a fresh stream, NOT null) but the stream blips
        // during the reboot. Tearing the connection down here is exactly the
        // "connects, then disconnects after 2-3s" bug. So while the port handle is
        // still alive, release the reader, pause briefly and re-read from the new
        // stream — the board finishes booting and streams its `Grbl [FluidNC…]`
        // banner. Only give up once the handle is genuinely gone (unplug →
        // `port.readable` null) or after repeated failures.
        if (this.port?.readable && transientErrors < MAX_TRANSIENT_ERRORS) {
          transientErrors++
          await new Promise((resolve) => setTimeout(resolve, 300))
          continue
        }
        this.options.onDisconnect?.(err)
        return
      }
      if (this.closing) break
    }
    if (!this.closing) this.options.onDisconnect?.()
  }

  /**
   * Decode bytes and emit complete lines.
   *
   * GRBL's realtime status reports (`<...>`) are emitted asynchronously and are
   * NOT synchronized with the line-oriented response stream, so a `?` injected
   * (e.g. by the status poller) mid-`ok` can land glued onto a normal response
   * with no separating newline — the reader would otherwise see a single
   * un-parseable line like `ok<Run|MPos:..>` or `<Run|..>ok`. If the `ok` is
   * buried in such a glob it's never counted as an acknowledgement, the
   * char-counting window never drains, and streaming dead-locks the moment the
   * window first fills (the classic "stalls after ~100-200 lines" failure).
   *
   * To make framing robust we split on `\n` AND `\r` (treat either as a line
   * terminator), and additionally carve any self-delimited `<...>` status report
   * out into its own line even when it is not newline-separated from the
   * surrounding response. Empty fragments are dropped.
   */
  private ingest(chunk: Uint8Array): void {
    this.rxBuffer += this.decoder.decode(chunk, { stream: true })
    // Process every complete (newline/carriage-return terminated) line.
    let idx: number
    while ((idx = this.findLineEnd(this.rxBuffer)) >= 0) {
      const raw = this.rxBuffer.slice(0, idx)
      // Skip the terminator (handle a `\r\n` pair as one terminator).
      let next = idx + 1
      if (this.rxBuffer[idx] === '\r' && this.rxBuffer[next] === '\n') next++
      this.rxBuffer = this.rxBuffer.slice(next)
      this.emitFramed(raw)
    }
    // A `<...>` report can arrive fully WITHIN the buffer ahead of any newline
    // (glued to the front of a not-yet-complete response). Pull out any complete
    // leading report so its `ok`-bearing tail isn't held hostage by it.
    this.drainLeadingReports()
  }

  /** Index of the first `\n` or `\r`, or -1. */
  private findLineEnd(s: string): number {
    const n = s.indexOf('\n')
    const r = s.indexOf('\r')
    if (n < 0) return r
    if (r < 0) return n
    return Math.min(n, r)
  }

  /**
   * Emit one framed line, but first split out any self-delimited `<...>` status
   * report(s) glued to ordinary response text. This guarantees a buried `ok` /
   * `error` is delivered as its own line so the streamer can account for it.
   */
  private emitFramed(rawLine: string): void {
    let s = rawLine
    // Repeatedly carve out `<...>` reports anywhere in the line.
    for (;;) {
      const lt = s.indexOf('<')
      if (lt < 0) break
      const gt = s.indexOf('>', lt + 1)
      if (gt < 0) break // incomplete report — leave the rest intact
      const before = s.slice(0, lt)
      const report = s.slice(lt, gt + 1)
      this.emitLine(before)
      this.emitLine(report)
      s = s.slice(gt + 1)
    }
    this.emitLine(s)
  }

  /** Pull complete `<...>` reports out of the FRONT of the pending rxBuffer. */
  private drainLeadingReports(): void {
    for (;;) {
      const lt = this.rxBuffer.indexOf('<')
      if (lt !== 0) return // nothing, or there's response text before it (wait for newline)
      const gt = this.rxBuffer.indexOf('>', 1)
      if (gt < 0) return // report not yet complete
      const report = this.rxBuffer.slice(0, gt + 1)
      this.rxBuffer = this.rxBuffer.slice(gt + 1)
      this.emitLine(report)
    }
  }

  /** Trim a `\r`/whitespace artefact and emit non-empty lines. */
  private emitLine(line: string): void {
    const t = line.replace(/\r$/, '')
    if (t.length === 0) return
    this.options.onLine?.(t)
  }

  /** Write a raw string (no newline added). */
  async writeRaw(data: string): Promise<void> {
    if (!this.writer) throw new Error('Connection not open')
    await this.writer.write(new TextEncoder().encode(data))
  }

  /** Write a single byte — used for GRBL realtime commands. */
  async writeByte(byte: number): Promise<void> {
    if (!this.writer) throw new Error('Connection not open')
    await this.writer.write(new Uint8Array([byte & 0xff]))
  }

  /** Write a line, appending `\n` if absent. */
  async writeLine(line: string): Promise<void> {
    await this.writeRaw(line.endsWith('\n') ? line : line + '\n')
  }

  /**
   * Send `data` to the controller using the XMODEM-CRC protocol (we are the
   * sender; the controller is the receiver, e.g. via `$Xmodem/Receive=/sd/foo.nc`).
   * `opts.start` is invoked AFTER the raw-byte sink is installed — call it to fire
   * the receive command so the controller's `'C'` handshake bytes are captured
   * here rather than parsed as lines. Resolves with the byte count sent.
   *
   * The CALLER must pause all other traffic (status `?`, `$G`, `$#` polls,
   * streaming) for the duration — any stray byte corrupts the binary stream.
   */
  async xmodemSend(
    data: Uint8Array,
    opts: { start: () => Promise<void>; onProgress?: (frac: number) => void },
  ): Promise<number> {
    if (!this.writer) throw new Error('Connection not open')
    const writer = this.writer
    const queue: number[] = []
    let waiter: ((b: number) => void) | null = null
    this.xmodemSink = (b) => {
      if (waiter) {
        const w = waiter
        waiter = null
        w(b)
      } else {
        queue.push(b)
      }
    }
    // Read one byte from the controller, or null on timeout.
    const readByte = (timeoutMs: number): Promise<number | null> =>
      new Promise((resolve) => {
        if (queue.length) {
          resolve(queue.shift() ?? null)
          return
        }
        const timer = setTimeout(() => {
          if (waiter === w) {
            waiter = null
            resolve(null)
          }
        }, timeoutMs)
        const w = (b: number) => {
          clearTimeout(timer)
          resolve(b)
        }
        waiter = w
      })

    try {
      // Fire the receive command now that the sink captures the reply bytes.
      await opts.start()

      // 1. Wait for the receiver's mode request: 'C' (CRC) or NAK (checksum).
      //    FluidNC delays ~1s, then sends 'C' repeatedly (≤16×, ~2s apart).
      let crcMode = true
      let started = false
      for (let i = 0; i < 24 && !started; i++) {
        const b = await readByte(2500)
        if (b === XM.CRC) {
          crcMode = true
          started = true
        } else if (b === XM.NAK) {
          crcMode = false
          started = true
        } else if (b === XM.CAN) {
          throw new Error('Upload refused by the controller (SD card missing or unwritable?)')
        }
        // null (timeout) or stray banner byte → keep waiting
      }
      if (!started) throw new Error('Controller did not start the XMODEM transfer')

      // 2. Send the data as 128-byte SOH packets (≥1 packet, even if empty).
      const nPackets = Math.max(1, Math.ceil(data.length / XMODEM_BLOCK))
      for (let k = 0; k < nPackets; k++) {
        const off = k * XMODEM_BLOCK
        const pkt = new Uint8Array(3 + XMODEM_BLOCK + (crcMode ? 2 : 1))
        pkt[0] = XM.SOH
        pkt[1] = (k + 1) & 0xff
        pkt[2] = ~(k + 1) & 0xff
        pkt.fill(XM.CTRLZ, 3, 3 + XMODEM_BLOCK)
        pkt.set(data.subarray(off, off + XMODEM_BLOCK), 3)
        if (crcMode) {
          const c = crc16ccitt(pkt, 3, 3 + XMODEM_BLOCK)
          pkt[3 + XMODEM_BLOCK] = (c >> 8) & 0xff
          pkt[3 + XMODEM_BLOCK + 1] = c & 0xff
        } else {
          let cks = 0
          for (let m = 3; m < 3 + XMODEM_BLOCK; m++) cks = (cks + pkt[m]) & 0xff
          pkt[3 + XMODEM_BLOCK] = cks
        }
        let acked = false
        for (let retry = 0; retry < 10 && !acked; retry++) {
          await writer.write(pkt)
          const resp = await readByte(2500)
          if (resp === XM.ACK) acked = true
          else if (resp === XM.CAN) throw new Error('Upload canceled by the controller')
          // NAK / null / other → resend the same packet
        }
        if (!acked) throw new Error(`No ACK for packet ${k + 1} after retries`)
        opts.onProgress?.((k + 1) / nPackets)
      }

      // 3. End of transmission — send EOT, await the final ACK.
      let done = false
      for (let retry = 0; retry < 6 && !done; retry++) {
        await this.writeByte(XM.EOT)
        const resp = await readByte(2500)
        if (resp === XM.ACK) done = true
      }
      if (!done) throw new Error('Controller did not acknowledge end-of-transfer')
      opts.onProgress?.(1)
      return data.length
    } finally {
      // Restore the line parser no matter how the transfer ended.
      this.xmodemSink = null
    }
  }

  /** Close the port and tear down reader/writer. Idempotent. */
  async close(): Promise<void> {
    if (!this.port) return
    this.closing = true
    try {
      await this.reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      this.writer?.releaseLock()
    } catch {
      /* ignore */
    }
    this.writer = null
    try {
      await this.readLoopPromise
    } catch {
      /* ignore */
    }
    try {
      await this.port.close()
    } catch {
      /* ignore */
    }
    this.port = null
    this.reader = null
    this.readLoopPromise = null
  }
}
