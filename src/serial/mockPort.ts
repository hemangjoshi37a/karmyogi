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
import { XM, XMODEM_BLOCK, crc16ccitt } from './xmodem'

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

// FluidNC-style banner so the controller's generalised firmware auto-detection
// recognises the mock as FluidNC (it emulates the FluidNC SD + XMODEM commands).
const WELCOME = "Grbl 3.7 [FluidNC v3.7.0 (mock) '$' for help]"

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
  /** True while a simulated homing cycle is animating. */
  private homing = false
  /** Live `$`-settings (number → value string); writes persist here. */
  private readonly settings = new Map<number, string>()
  // Canned SD-card filesystem so the SD browser is usable against the mock with no
  // hardware: name → G-code content. Mutated by `$SD/Delete`.
  private readonly sdFiles = new Map<string, string>([
    [
      'demo-square.nc',
      'G21 G90\nG0 X0 Y0\nG1 X20 Y0 F600\nG1 X20 Y20\nG1 X0 Y20\nG1 X0 Y0\nM2',
    ],
    [
      'logo-engrave.gcode',
      'G21 G90\nG0 Z5\nG0 X5 Y5\nG1 Z-0.3 F200\nG1 X25 Y5 F800\nG1 X25 Y15\nG1 X5 Y15\nG1 X5 Y5\nG0 Z5\nM2',
    ],
    [
      'drill-holes.nc',
      'G21 G90\nG0 Z5\nG0 X10 Y10\nG1 Z-2 F150\nG0 Z5\nG0 X30 Y10\nG1 Z-2\nG0 Z5\nM2',
    ],
  ])
  // Canned FluidNC config.yaml so the Limit-pin config editor works without
  // hardware: $CD dumps it, an XMODEM write to config.yaml replaces it, and
  // [ESP444]RESTART re-reads it + prints the limit assignments to the boot log.
  private mockConfig =
    'name: Mock CNC\nboard: ESP32\naxes:\n' +
    '  x:\n    motor0:\n      limit_neg_pin: gpio.34:low:pu\n      limit_pos_pin: gpio.35:low:pu\n' +
    '  y:\n    motor0:\n      limit_neg_pin: gpio.36:low:pu\n      limit_pos_pin: gpio.39:low:pu\n' +
    '  z:\n    motor0:\n      limit_neg_pin: gpio.25:low:pu\n      limit_pos_pin: gpio.26:low:pu\n'
  // In-flight XMODEM RECEIVE state (emulating $Xmodem/Receive). When set,
  // handleWrite routes ALL incoming bytes to the receiver state machine.
  private xmodemRx: {
    name: string
    data: number[]
    pkt: number[]
    started: boolean
    cTimer: ReturnType<typeof setInterval> | null
  } | null = null
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

    // Dev-only debug handle: lets you trip simulated limit switches from the
    // console to exercise limit-aware jogging without hardware, e.g.
    //   __kmMock.setLimitBits('010000')  // X+ held → X+ jog greys out
    //   __kmMock.setLimitBits('000000')  // release all
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      ;(window as unknown as { __kmMock?: MockPort }).__kmMock = this
    }

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

  /** Enqueue a single raw byte (for the XMODEM control bytes C/ACK/NAK). */
  private emitByte(b: number): void {
    if (!this.rxController) return
    try {
      this.rxController.enqueue(Uint8Array.of(b & 0xff))
    } catch {
      /* closed */
    }
  }

  /** Begin emulating a FluidNC XMODEM file receive (`$Xmodem/Receive`). */
  private startXmodemReceive(name: string): void {
    const rx = {
      name,
      data: [] as number[],
      pkt: [] as number[],
      started: false,
      cTimer: null as ReturnType<typeof setInterval> | null,
    }
    this.xmodemRx = rx
    // Like real FluidNC: pause briefly, then send 'C' (request CRC mode) until the
    // first packet arrives.
    const sendC = () => {
      if (this.xmodemRx === rx && !rx.started) this.emitByte(XM.CRC)
    }
    setTimeout(() => {
      if (this.xmodemRx !== rx || rx.started) return
      sendC()
      rx.cTimer = setInterval(sendC, 1000)
    }, 400)
  }

  /** Feed one byte to the in-flight XMODEM receiver. */
  private xmodemRxByte(b: number): void {
    const rx = this.xmodemRx
    if (!rx) return
    if (rx.pkt.length === 0) {
      if (b === XM.SOH) {
        rx.pkt.push(b)
      } else if (b === XM.EOT) {
        this.finishXmodem()
      } else if (b === XM.CAN) {
        this.cancelXmodem()
      }
      return // ignore stray bytes between packets
    }
    rx.pkt.push(b)
    // SOH packet (CRC mode): SOH + blk + ~blk + 128 data + crc_hi + crc_lo.
    const need = 3 + XMODEM_BLOCK + 2
    if (rx.pkt.length < need) return
    const p = rx.pkt
    rx.pkt = []
    const blkOk = p[1] === ((~p[2]) & 0xff)
    const crcGiven = (p[3 + XMODEM_BLOCK] << 8) | p[3 + XMODEM_BLOCK + 1]
    const crcCalc = crc16ccitt(Uint8Array.from(p.slice(3, 3 + XMODEM_BLOCK)))
    if (blkOk && crcGiven === crcCalc) {
      if (!rx.started) {
        rx.started = true
        if (rx.cTimer) {
          clearInterval(rx.cTimer)
          rx.cTimer = null
        }
      }
      for (let i = 0; i < XMODEM_BLOCK; i++) rx.data.push(p[3 + i])
      this.emitByte(XM.ACK)
    } else {
      this.emitByte(XM.NAK)
    }
  }

  /** EOT received: strip padding, store the file, ACK + emit the command's `ok`. */
  private finishXmodem(): void {
    const rx = this.xmodemRx
    if (!rx) return
    if (rx.cTimer) clearInterval(rx.cTimer)
    this.xmodemRx = null
    let end = rx.data.length
    while (end > 0 && rx.data[end - 1] === XM.CTRLZ) end--
    const bytes = Uint8Array.from(rx.data.slice(0, end))
    const content = new TextDecoder().decode(bytes)
    // A write to config.yaml replaces the running config (re-read on [ESP444]);
    // everything else lands in the canned SD filesystem.
    const isConfig = /(^|\/)config\.yaml$/i.test(rx.name)
    if (isConfig) this.mockConfig = content
    else this.sdFiles.set(rx.name, content)
    this.emitByte(XM.ACK)
    this.emit(`[MSG:Received ${bytes.length} bytes to file ${isConfig ? '/littlefs/' + rx.name : '/sd/' + rx.name}]\r\n`)
    this.emit('ok\r\n')
  }

  private cancelXmodem(): void {
    const rx = this.xmodemRx
    if (rx?.cTimer) clearInterval(rx.cTimer)
    this.xmodemRx = null
    this.emit('error:7\r\n')
  }

  private handleWrite(chunk: Uint8Array): void {
    // During an XMODEM receive every byte is part of the binary transfer — route
    // it straight to the receiver (before the realtime check, since packet/CRC
    // bytes can collide with realtime byte values).
    if (this.xmodemRx) {
      for (const byte of chunk) this.xmodemRxByte(byte)
      return
    }
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

    // `$CD` (Config/Dump): stream the running config.yaml over the channel, then ok.
    if (line === '$CD' || /^\$Config\/Dump$/i.test(line)) {
      for (const l of this.mockConfig.split('\n')) this.emit(`${l}\r\n`)
      this.emit('ok\r\n')
      return
    }
    // `[ESP444]RESTART`: simulate a reboot — re-read config + print the limit
    // assignments to the boot log (so the host can verify the new pins), then ok.
    if (/^\[ESP444\]/i.test(line)) {
      this.emit('ok\r\n')
      setTimeout(() => {
        this.emit('\r\n')
        this.emit('[MSG:INFO: FluidNC v3.7.0 (mock)]\r\n')
        const m = this.mockConfig.match(
          /([xyzabc]):\s*\n\s*motor0:\s*\n\s*limit_neg_pin:\s*(\S+)\s*\n\s*limit_pos_pin:\s*(\S+)/gi,
        )
        if (m) {
          for (const block of m) {
            const mm = /([xyzabc]):[\s\S]*?limit_neg_pin:\s*(\S+)[\s\S]*?limit_pos_pin:\s*(\S+)/i.exec(block)
            if (mm) {
              const ax = mm[1].toUpperCase()
              this.emit(`[MSG:INFO: ${ax} Neg Limit ${mm[2]}]\r\n`)
              this.emit(`[MSG:INFO: ${ax} Pos Limit ${mm[3]}]\r\n`)
            }
          }
        }
        this.emit(WELCOME + '\r\n')
      }, 400)
      return
    }

    // `$#` work-coordinate-offset dump: canned G54–G59 origins (machine coords)
    // plus the other reports real GRBL emits, so the visualizer can draw the
    // G54–G59 origin markers without hardware. Distinct offsets spread them
    // across the bed; G54 sits at machine zero (the active work origin).
    if (line === '$#') {
      this.emit(
        [
          '[G54:0.000,0.000,0.000]',
          '[G55:50.000,0.000,0.000]',
          '[G56:0.000,50.000,0.000]',
          '[G57:-60.000,-40.000,0.000]',
          '[G58:80.000,60.000,0.000]',
          '[G59:-80.000,40.000,0.000]',
          '[G28:0.000,0.000,0.000]',
          '[G30:0.000,0.000,0.000]',
          '[G92:0.000,0.000,0.000]',
          '[TLO:0.000]',
          '[PRB:0.000,0.000,0.000:0]',
        ].join('\r\n') + '\r\n',
      )
      this.emit('ok\r\n')
      return
    }

    // `$G` parser-state report: announce G54 active + the usual modal words so the
    // Coordinates panel + visualizer reflect a real active WCS in the mock.
    if (line === '$G') {
      this.emit('[GC:G0 G54 G17 G21 G90 G94 M5 M9 T0 F0 S0]\r\n')
      this.emit('ok\r\n')
      return
    }

    // ── FluidNC SD-card file commands (emulated so the SD browser works) ──
    // `$SD/List`: one [FILE: name|SIZE:n] line per file, then a volume summary.
    if (line === '$SD/List' || /^\$SD\/List($|=)/i.test(line)) {
      let total = 0
      for (const [name, content] of this.sdFiles) {
        const size = content.length
        total += size
        this.emit(`[FILE: ${name}|SIZE:${size}]\r\n`)
      }
      this.emit(`[/sd/ Free:7.9 GB Used:${total} B Total:8.0 GB]\r\n`)
      this.emit('ok\r\n')
      return
    }
    // `$SD/Show=<path>`: dump the file's G-code lines, then ok (real FluidNC needs Idle).
    const sdShow = /^\$SD\/Show=(.+)$/i.exec(line)
    if (sdShow) {
      const name = sdShow[1].trim().replace(/^\/?sd\//i, '')
      const content = this.sdFiles.get(name)
      if (content === undefined) {
        this.emit('error:60\r\n') // FluidNC: failed to open file
      } else {
        for (const l of content.split('\n')) this.emit(`${l}\r\n`)
        this.emit('ok\r\n')
      }
      return
    }
    // `$SD/Run=<path>`: the controller would execute it itself — just ack here.
    if (/^\$SD\/Run=/i.test(line)) {
      this.emit('ok\r\n')
      return
    }
    // `$Xmodem/Receive=<path>`: enter XMODEM receive mode (no `ok` until done).
    const xr = /^\$Xmodem\/Receive=(.+)$/i.exec(line)
    if (xr) {
      const name = xr[1].trim().replace(/^\/?sd\//i, '')
      this.startXmodemReceive(name)
      return
    }
    // `$SD/Delete=<path>`: remove from the canned filesystem.
    const sdDel = /^\$SD\/Delete=(.+)$/i.exec(line)
    if (sdDel) {
      const name = sdDel[1].trim().replace(/^\/?sd\//i, '')
      this.sdFiles.delete(name)
      this.emit('ok\r\n')
      return
    }

    // Homing cycle ($H): real GRBL physically seeks the limit switches and only
    // returns 'ok' once it finishes. Simulate a visible homing move so the DRO +
    // 3D viewer show the axes travelling to the home corner, then 'ok'.
    if (/^\$H$/i.test(line)) {
      this.startHoming()
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

  /**
   * Very small G-code interpreter so the viewer/DRO show movement: track X/Y/Z
   * words on G0/G1 moves AND on `$J=` jog commands. Jogs (and any G91 block) are
   * applied relative to the current position; everything else is absolute.
   */
  private applyMotion(line: string): void {
    const isJog = /^\$J=/i.test(line)
    const body = isJog ? line.replace(/^\$J=/i, '') : line
    if (!isJog && !/\bG0?[01]\b/i.test(body)) return
    const grab = (axis: string): number | undefined => {
      const m = new RegExp(`${axis}(-?\\d+(?:\\.\\d+)?)`, 'i').exec(body)
      return m ? parseFloat(m[1]) : undefined
    }
    const relative = /\bG91\b/i.test(body)
    const x = grab('X')
    const y = grab('Y')
    const z = grab('Z')
    if (relative) {
      if (x !== undefined) this.mpos.x += x
      if (y !== undefined) this.mpos.y += y
      if (z !== undefined) this.mpos.z += z
    } else {
      if (x !== undefined) this.mpos.x = x
      if (y !== undefined) this.mpos.y = y
      if (z !== undefined) this.mpos.z = z
    }
  }

  /**
   * Simulate a GRBL homing cycle with visible motion: set state to 'Home', step
   * the machine position along a believable path (retract Z, rush to the home
   * corner, settle to machine zero), then return to 'Idle' and emit the single
   * 'ok' that real GRBL only sends once homing completes.
   */
  private startHoming(): void {
    if (this.homing) return
    this.homing = true
    this.state = 'Home'
    // Absolute machine-mm waypoints; the negative corner stays on the bed grid.
    const path = [
      { x: this.mpos.x, y: this.mpos.y, z: 5 }, // lift Z clear
      { x: -120, y: -90, z: 5 }, // seek the home corner
      { x: -120, y: -90, z: 0 }, // touch Z
      { x: 0, y: 0, z: 0 }, // pull off to machine zero
    ]
    const segSteps = 6
    const stepMs = 55
    let from = { ...this.mpos }
    let seg = 0
    let t = 0
    const tick = () => {
      const to = path[seg]
      t++
      const a = Math.min(1, t / segSteps)
      this.mpos = {
        x: from.x + (to.x - from.x) * a,
        y: from.y + (to.y - from.y) * a,
        z: from.z + (to.z - from.z) * a,
      }
      if (a >= 1) {
        from = { ...to }
        seg++
        t = 0
        if (seg >= path.length) {
          this.mpos = { x: 0, y: 0, z: 0 }
          this.state = 'Idle'
          this.homing = false
          this.emit('ok\r\n')
          return
        }
      }
      setTimeout(tick, stepMs)
    }
    setTimeout(tick, stepMs)
  }

  private fmt(n: number): string {
    return n.toFixed(3)
  }

  private statusReport(): string {
    const { x, y, z } = this.mpos
    // Emulate the FluidNC per-direction limit report (LS: bits X−,X+,Y−,Y+,Z−,Z+).
    // All open by default; `setLimitBits()` can trigger some for tests/demos. Also
    // mirror any triggered axis into Pn: so per-axis-fallback clients agree.
    const pn = this.limitBits.includes('1') ? '|Pn:' + this.limitPnLetters() : ''
    return `<${this.state}|MPos:${this.fmt(x)},${this.fmt(y)},${this.fmt(
      z,
    )}|FS:0,0|Ov:100,100,100|LS:${this.limitBits}${pn}>`
  }

  /** Per-direction limit bits X−,X+,Y−,Y+,Z−,Z+; all open by default. */
  private limitBits = '000000'
  /** Test/demo helper: trigger limit switches (6-char bitstring). */
  setLimitBits(bits: string): void {
    this.limitBits = (bits + '000000').slice(0, 6)
  }
  private limitPnLetters(): string {
    const order = ['X', 'X', 'Y', 'Y', 'Z', 'Z']
    const set = new Set<string>()
    for (let i = 0; i < 6; i++) if (this.limitBits[i] === '1') set.add(order[i])
    return [...set].join('')
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
