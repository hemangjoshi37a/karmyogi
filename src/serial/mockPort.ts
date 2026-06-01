// MockPort — a fake serial device implementing `PortLike` for hardware-free
// development and tests. It speaks just enough GRBL v1.1 to exercise the whole
// transport stack:
//
//  - On open: emits the GRBL welcome banner.
//  - On `?` (realtime): replies with a `<...>` status report reflecting a
//    simulated machine state and position.
//  - On `0x18` (soft reset): re-emits the welcome banner, clears any queue.
//  - On `!` / `~`: toggles Hold/Run state (reflected in status reports).
//  - On any line command (G-code, `$X`, `$H`, ...): replies `ok` (or `error:N`
//    for lines registered as failing).
//  - On `$$`: dumps a canned settings block then `ok`.
//
// It also lets G0/G1 moves nudge the simulated position so the Visualizer/
// Controller show motion when streaming against the mock.

import type { PortLike } from './grblConnection'
import { RealtimeByte } from './realtime'

export interface MockPortOptions {
  /** Initial machine state reported in status. Default 'Idle'. */
  initialState?: string
  /** Canned `$$` settings lines (without the trailing `ok`). */
  settings?: string[]
  /** Lines (exact, trimmed) that should respond with an error code. */
  errorLines?: Map<string, number>
  /** ms before each response is emitted (simulates latency). Default 0. */
  latencyMs?: number
}

const DEFAULT_SETTINGS = [
  '$0=10',
  '$1=25',
  '$10=1',
  '$20=0',
  '$21=0',
  '$22=0',
  '$100=250.000',
  '$101=250.000',
  '$102=250.000',
  '$110=500.000',
  '$111=500.000',
  '$112=500.000',
  '$120=10.000',
  '$121=10.000',
  '$122=10.000',
  '$130=200.000',
  '$131=200.000',
  '$132=200.000',
]

const WELCOME = "Grbl 1.1f ['$' for help]"

export class MockPort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  private rxController: ReadableStreamDefaultController<Uint8Array> | null =
    null
  private readonly encoder = new TextEncoder()
  private readonly decoder = new TextDecoder()
  private writeBuffer = ''
  private opened = false

  private state: string
  private mpos = { x: 0, y: 0, z: 0 }
  /** Live `$`-settings (number → value string); writes persist here. */
  private readonly settings = new Map<number, string>()
  private readonly opts: Required<
    Pick<MockPortOptions, 'initialState' | 'settings' | 'latencyMs'>
  > & { errorLines: Map<string, number> }

  constructor(opts: MockPortOptions = {}) {
    this.opts = {
      initialState: opts.initialState ?? 'Idle',
      settings: opts.settings ?? DEFAULT_SETTINGS,
      latencyMs: opts.latencyMs ?? 0,
      errorLines: opts.errorLines ?? new Map(),
    }
    this.state = this.opts.initialState
    for (const line of this.opts.settings) {
      const m = /^\$(\d+)\s*=\s*(.+)$/.exec(line.trim())
      if (m) this.settings.set(parseInt(m[1], 10), m[2])
    }
  }

  async open(_options: { baudRate: number }): Promise<void> {
    if (this.opened) throw new Error('MockPort already open')
    this.opened = true

    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.rxController = controller
        // GRBL emits a welcome banner shortly after connect.
        this.emit('\r\n' + WELCOME + '\r\n')
      },
      cancel: () => {
        this.rxController = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        this.handleWrite(chunk)
      },
    })
  }

  async close(): Promise<void> {
    this.opened = false
    try {
      this.rxController?.close()
    } catch {
      /* already closed */
    }
    this.rxController = null
    this.readable = null
    this.writable = null
  }

  // --- internals -------------------------------------------------------------

  private emit(text: string): void {
    if (!this.rxController) return
    const bytes = this.encoder.encode(text)
    const push = () => {
      try {
        this.rxController?.enqueue(bytes)
      } catch {
        /* closed */
      }
    }
    if (this.opts.latencyMs > 0) setTimeout(push, this.opts.latencyMs)
    else push()
  }

  private handleWrite(chunk: Uint8Array): void {
    // Realtime bytes are processed immediately and never buffered.
    const lineBytes: number[] = []
    for (const byte of chunk) {
      if (this.isRealtime(byte)) {
        this.handleRealtime(byte)
      } else {
        lineBytes.push(byte)
      }
    }
    if (lineBytes.length === 0) return

    this.writeBuffer += this.decoder.decode(Uint8Array.from(lineBytes), {
      stream: true,
    })
    let idx: number
    while ((idx = this.writeBuffer.indexOf('\n')) >= 0) {
      let line = this.writeBuffer.slice(0, idx)
      this.writeBuffer = this.writeBuffer.slice(idx + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      this.handleLine(line)
    }
  }

  private isRealtime(byte: number): boolean {
    return (
      byte === RealtimeByte.StatusReport ||
      byte === RealtimeByte.FeedHold ||
      byte === RealtimeByte.CycleStart ||
      byte === RealtimeByte.SoftReset ||
      byte >= 0x80 // override / toggle bytes
    )
  }

  private handleRealtime(byte: number): void {
    switch (byte) {
      case RealtimeByte.StatusReport:
        this.emit(this.statusReport() + '\r\n')
        break
      case RealtimeByte.FeedHold:
        if (this.state === 'Run') this.state = 'Hold'
        break
      case RealtimeByte.CycleStart:
        if (this.state === 'Hold') this.state = 'Run'
        break
      case RealtimeByte.SoftReset:
        this.writeBuffer = ''
        this.state = this.opts.initialState
        this.emit('\r\n' + WELCOME + '\r\n')
        break
      default:
        // overrides / toggles: accept silently (reflected nowhere here)
        break
    }
  }

  private handleLine(rawLine: string): void {
    const line = rawLine.trim()
    if (line.length === 0) {
      this.emit('ok\r\n')
      return
    }

    if (line === '$$') {
      const dump = [...this.settings.keys()]
        .sort((a, b) => a - b)
        .map((n) => `$${n}=${this.settings.get(n)}`)
      this.emit(dump.join('\r\n') + '\r\n')
      this.emit('ok\r\n')
      return
    }

    // Persist a `$N=val` settings write so it survives the next `$$`.
    const write = /^\$(\d+)\s*=\s*(.+)$/.exec(line)
    if (write) {
      this.settings.set(parseInt(write[1], 10), write[2].trim())
      this.emit('ok\r\n')
      return
    }

    // Simulate motion so the viewer shows movement.
    this.applyMotion(line)

    const err = this.opts.errorLines.get(line)
    if (err !== undefined) {
      this.emit(`error:${err}\r\n`)
    } else {
      this.emit('ok\r\n')
    }
  }

  /** Very small G-code interpreter: track X/Y/Z words on G0/G1 lines. */
  private applyMotion(line: string): void {
    if (!/\bG0?[01]\b/i.test(line)) return
    const grab = (axis: string): number | undefined => {
      const m = new RegExp(`${axis}(-?\\d+(?:\\.\\d+)?)`, 'i').exec(line)
      return m ? parseFloat(m[1]) : undefined
    }
    const x = grab('X')
    const y = grab('Y')
    const z = grab('Z')
    if (x !== undefined) this.mpos.x = x
    if (y !== undefined) this.mpos.y = y
    if (z !== undefined) this.mpos.z = z
  }

  private fmt(n: number): string {
    return n.toFixed(3)
  }

  private statusReport(): string {
    const { x, y, z } = this.mpos
    return `<${this.state}|MPos:${this.fmt(x)},${this.fmt(y)},${this.fmt(
      z,
    )}|FS:0,0|Ov:100,100,100>`
  }

  // --- test helpers ----------------------------------------------------------

  /** Force the simulated machine state (for tests). */
  setState(state: string): void {
    this.state = state
  }

  /** Force the simulated machine position (for tests). */
  setPosition(x: number, y: number, z: number): void {
    this.mpos = { x, y, z }
  }
}
