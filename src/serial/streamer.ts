// GRBL line streamer.
//
// Two streaming strategies, selectable per instance:
//
//  - 'char-counting' (default, high throughput): track how many bytes are
//    in flight inside GRBL's 127-byte serial RX buffer. Send the next line
//    only while (bytesInFlight + nextLineLength) <= RX_BUFFER. Each `ok`/
//    `error` response frees the oldest pending line's bytes. This keeps the
//    controller's planner buffer fed without ever overflowing the 128-byte
//    hardware RX buffer.
//
//  - 'send-response' (simple): send one line, wait for `ok`/`error`, repeat.
//
// The streamer is transport-agnostic: it is given an async `writeLine` and is
// fed response lines via `onResponse(line)`. Status reports (`<...>`) and
// pushed messages are ignored for accounting.

/** GRBL's serial RX buffer size. We reserve 1 byte for safety. */
export const GRBL_RX_BUFFER = 128
export const RX_BUFFER_LIMIT = GRBL_RX_BUFFER - 1 // 127 usable

export type StreamMode = 'char-counting' | 'send-response'

export interface StreamerOptions {
  mode?: StreamMode
  /** Async function that writes a single line (newline handling internal). */
  writeLine: (line: string) => Promise<void>
  /** RX buffer limit override (defaults to 127). */
  rxBufferLimit?: number
  /** Called when a queued line is acknowledged with `ok`. */
  onAck?: (line: string, index: number) => void
  /** Called when a queued line gets an `error:...` response. */
  onError?: (line: string, response: string, index: number) => void
  /** Called when the whole queue has drained (no pending, none queued). */
  onIdle?: () => void
  /** Progress callback: (completed, total). */
  onProgress?: (completed: number, total: number) => void
}

interface PendingLine {
  text: string
  /** Bytes this line occupies in the RX buffer (incl. the `\n`). */
  bytes: number
  index: number
}

export class Streamer {
  readonly mode: StreamMode
  private readonly rxLimit: number
  private readonly writeLine: (line: string) => Promise<void>

  private queue: string[] = []
  private pending: PendingLine[] = []
  private bytesInFlight = 0
  private nextIndex = 0
  private completed = 0
  private total = 0
  private running = false
  private pumping = false

  private readonly opts: StreamerOptions

  constructor(opts: StreamerOptions) {
    this.opts = opts
    this.mode = opts.mode ?? 'char-counting'
    this.rxLimit = opts.rxBufferLimit ?? RX_BUFFER_LIMIT
    this.writeLine = opts.writeLine
  }

  /** Bytes currently believed to be in GRBL's RX buffer. */
  get inFlightBytes(): number {
    return this.bytesInFlight
  }

  /** Number of lines sent but not yet acknowledged. */
  get pendingCount(): number {
    return this.pending.length
  }

  get queuedCount(): number {
    return this.queue.length
  }

  get isRunning(): boolean {
    return this.running
  }

  /** Queue one or more lines for streaming (blank/comment lines kept as-is). */
  enqueue(lines: string | string[]): void {
    const arr = Array.isArray(lines) ? lines : [lines]
    for (const l of arr) {
      this.queue.push(l)
      this.total++
    }
    if (this.running) void this.pump()
  }

  /** Begin streaming the queued lines. */
  start(): void {
    this.running = true
    void this.pump()
  }

  /**
   * Abort streaming. Clears the queue and pending accounting. The caller is
   * responsible for issuing a GRBL soft-reset (0x18) to flush the controller.
   */
  reset(): void {
    this.running = false
    this.queue = []
    this.pending = []
    this.bytesInFlight = 0
    this.completed = 0
    this.total = 0
    this.nextIndex = 0
  }

  private lineBytes(line: string): number {
    // GRBL counts the terminating newline against the buffer.
    return line.length + 1
  }

  /** Send as many lines as the chosen strategy and buffer allow. */
  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      while (this.running && this.queue.length > 0) {
        const next = this.queue[0]
        const bytes = this.lineBytes(next)

        if (this.mode === 'send-response') {
          // Only one line in flight at a time.
          if (this.pending.length > 0) break
        } else {
          // char-counting: respect the RX buffer ceiling. Always allow at
          // least one line through even if it alone exceeds the limit.
          if (
            this.pending.length > 0 &&
            this.bytesInFlight + bytes > this.rxLimit
          ) {
            break
          }
        }

        this.queue.shift()
        const entry: PendingLine = { text: next, bytes, index: this.nextIndex++ }
        this.pending.push(entry)
        this.bytesInFlight += bytes
        await this.writeLine(next)
      }
    } finally {
      this.pumping = false
    }
  }

  /**
   * Feed a response line from the controller. Returns true if it was consumed
   * as an acknowledgement (`ok`/`error`), false otherwise (status report, push
   * message, welcome banner, etc.).
   */
  onResponse(line: string): boolean {
    const t = line.trim()
    const lower = t.toLowerCase()
    const isOk = lower === 'ok'
    const isError = lower.startsWith('error')

    if (!isOk && !isError) return false
    if (this.pending.length === 0) return false

    const entry = this.pending.shift() as PendingLine
    this.bytesInFlight -= entry.bytes
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.completed++

    if (isError) {
      this.opts.onError?.(entry.text, t, entry.index)
    } else {
      this.opts.onAck?.(entry.text, entry.index)
    }
    this.opts.onProgress?.(this.completed, this.total)

    // Keep the pipe full.
    void this.pump()

    if (this.queue.length === 0 && this.pending.length === 0) {
      this.running = false
      this.opts.onIdle?.()
    }
    return true
  }
}
