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
    await port.open({ baudRate: this.options.baudRate })
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
