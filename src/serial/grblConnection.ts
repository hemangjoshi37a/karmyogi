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

  /** Decode bytes and emit complete `\n`-terminated lines. */
  private ingest(chunk: Uint8Array): void {
    this.rxBuffer += this.decoder.decode(chunk, { stream: true })
    let idx: number
    while ((idx = this.rxBuffer.indexOf('\n')) >= 0) {
      let line = this.rxBuffer.slice(0, idx)
      this.rxBuffer = this.rxBuffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.options.onLine?.(line)
    }
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
