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

    if (!port.writable) throw new Error('Port is not writable')
    this.writer = port.writable.getWriter()

    this.readLoopPromise = this.readLoop()
  }

  private async readLoop(): Promise<void> {
    while (this.port && this.port.readable && !this.closing) {
      const reader = this.port.readable.getReader()
      this.reader = reader
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (value && value.length) this.ingest(value)
        }
      } catch (err) {
        if (!this.closing) {
          this.options.onDisconnect?.(err)
          return
        }
      } finally {
        reader.releaseLock()
        this.reader = null
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
