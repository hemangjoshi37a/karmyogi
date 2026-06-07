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
  /**
   * Called when a queued line is acknowledged with `ok`. `index` is the line's
   * 0-based position within the FULL program (i.e. it already includes any
   * `startIndex` offset applied via {@link Streamer.setStartIndex}).
   */
  onAck?: (line: string, index: number) => void
  /** Called when a queued line gets an `error:...` response. Index is full-program. */
  onError?: (line: string, response: string, index: number) => void
  /** Called when the whole queue has drained (no pending, none queued). */
  onIdle?: () => void
  /**
   * Progress callback. `completed` is the count of FULL-program lines done so
   * far (startIndex + lines completed within this slice), and `total` is the
   * FULL-program line count (startIndex + queued slice length). When streaming
   * from line N, `completed`/`total` therefore track the whole program, not
   * just the streamed tail — so a "feed from line N" run reports correct
   * progress and a correct current-line cursor.
   */
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
  /**
   * 0-based offset of the FIRST queued line within the FULL program. When a job
   * is streamed "from line N", this is N so that progress / current-line are
   * reported in full-program indices (startIndex + completed-within-slice)
   * rather than slice-local ones. Defaults to 0 (stream from the top).
   */
  private startIndex = 0

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

  /**
   * Full-program count of lines completed so far: `startIndex` (the lines we
   * skipped by feeding from line N — counted as already done) plus the number
   * of lines acknowledged within the streamed slice.
   */
  get completedInProgram(): number {
    return this.startIndex + this.completed
  }

  /** Full-program total line count (`startIndex` + the queued slice's total). */
  get totalInProgram(): number {
    return this.startIndex + this.total
  }

  /**
   * Set the 0-based offset of the first queued line within the FULL program, so
   * progress / current-line are reported in full-program indices. Must be set
   * BEFORE enqueueing/starting a slice (the controller calls this from
   * `startProgram({ startIndex })`). Cleared back to 0 by {@link reset}.
   */
  setStartIndex(index: number): void {
    this.startIndex = Number.isFinite(index) && index > 0 ? Math.floor(index) : 0
  }

  /** Queue one or more lines for streaming (blank/comment lines kept as-is). */
  enqueue(lines: string | string[]): void {
    const arr = Array.isArray(lines) ? lines : [lines]
    for (const l of arr) {
      this.queue.push(l)
      this.total++
    }
    if (this.running) this.safePump()
  }

  /** Begin streaming the queued lines. */
  start(): void {
    this.running = true
    this.safePump()
  }

  /**
   * Fire-and-forget pump that can never surface as an unhandled rejection (which
   * would otherwise leave `pumping` true after the `finally` only if the throw
   * escaped — it doesn't, but a rejected promise from a write must still not
   * crash the page or kill the loop silently). Errors are reported and swallowed.
   */
  private safePump(): void {
    void this.pump().catch((err) => {
      this.opts.onError?.(
        '<pump>',
        err instanceof Error ? err.message : String(err),
        -1,
      )
    })
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
    this.startIndex = 0
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

        // Reserve the slot BEFORE writing so concurrent re-entrant pumps can't
        // double-send the same line; roll the accounting back if the write
        // fails so a transient error never leaves a phantom in-flight line that
        // wedges the window forever.
        this.queue.shift()
        const entry: PendingLine = { text: next, bytes, index: this.nextIndex++ }
        this.pending.push(entry)
        this.bytesInFlight += bytes
        try {
          await this.writeLine(next)
        } catch (err) {
          // Undo the reservation and stop pumping; the caller's transport-error
          // handling (disconnect / reset) takes over. We must not loop forever
          // re-throwing, but we also must not silently swallow into a half state.
          this.pending.pop()
          this.bytesInFlight -= bytes
          if (this.bytesInFlight < 0) this.bytesInFlight = 0
          this.nextIndex--
          this.queue.unshift(entry.text)
          throw err
        }
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
    // Strip any leftover status report(s) so a glued `ok<Run|..>` (the
    // transport should already un-glue these, but be defensive — a missed ack
    // permanently dead-locks the char-counting window) still acknowledges.
    const t = line.replace(/<[^>]*>/g, '').trim()
    const lower = t.toLowerCase()
    // Match `ok` or `error[:N]` as a standalone token, tolerating trailing junk
    // but NOT matching it inside another word (so `[MSG:...]`, `oktoberfest`,
    // welcome banners, push messages, etc. are never mistaken for an ack).
    const isOk = lower === 'ok'
    const isError = /^error(:|\b)/.test(lower)

    if (!isOk && !isError) return false
    if (this.pending.length === 0) return false

    const entry = this.pending.shift() as PendingLine
    this.bytesInFlight -= entry.bytes
    if (this.bytesInFlight < 0) this.bytesInFlight = 0
    this.completed++

    // Report indices/counts in FULL-program space so a "feed from line N" run
    // tracks the whole program (startIndex + slice-local), not just the tail.
    if (isError) {
      this.opts.onError?.(entry.text, t, this.startIndex + entry.index)
    } else {
      this.opts.onAck?.(entry.text, this.startIndex + entry.index)
    }
    this.opts.onProgress?.(this.startIndex + this.completed, this.startIndex + this.total)

    // Keep the pipe full.
    this.safePump()

    if (this.queue.length === 0 && this.pending.length === 0) {
      this.running = false
      this.opts.onIdle?.()
    }
    return true
  }
}
