// High-level GRBL controller service (orchestrator-owned shared wiring).
//
// Composes the transport primitives (GrblConnection + Streamer + status parsing
// + realtime bytes) into a single stateful service the UI panels call, and
// wires controller events into the zustand stores (machine / program / console).
//
// Panels (Controller, Console, Program, Motion, …) import the `grbl` singleton
// and the helpers here — they never touch the raw transport classes directly.

import { GrblConnection, type PortLike } from './grblConnection'
import { Streamer, type StreamMode } from './streamer'
import { RealtimeByte } from './realtime'
import { isStatusReport } from './status'
import {
  GRBL_DIALECT,
  resolveDialect,
  statusQueryLine,
  g91JogLines,
  parseStatusForDialect,
  type ResolvedDialect,
} from './dialect'
import { parseSettingLine, writeSettingCommand } from './settings'
import { useMachine } from '../store/machine'
import { useProgram } from '../store/program'
import { useConsole } from '../store/console'
import { useGrblSettings } from '../store/grblSettings'
import { useMachineProfile } from '../store/machineProfile'
import { canLiveConnect, profileFor } from '../machine/controllers'
import type { ControllerKind } from '../machine/types'

/**
 * Optional descriptor passed when connecting, so the connection MANAGER (the
 * machine-farm store) can label the active connection in the UI. Purely
 * informational — it does not affect transport behaviour. Legacy callers that
 * omit it (the original Connect/Mock buttons) keep working unchanged.
 */
export interface ConnectMeta {
  /** Stable id assigned by the farm store, if it initiated the connect. */
  machineId?: string
  /** Human label shown in the appbar machine switcher (e.g. port / URL / "Mock"). */
  label?: string
  /** Transport kind, for the manager's bookkeeping. */
  kind?: 'serial' | 'mock' | 'websocket'
}

/** Snapshot of what the controller is currently (or was last) connected to. */
export interface ActivePortInfo extends ConnectMeta {
  connected: boolean
}

export interface JogParams {
  /** Axis deltas in mm (relative). */
  x?: number
  y?: number
  z?: number
  /** Feed rate in mm/min. */
  feed: number
}

const STATUS_POLL_MS = 200 // ~5 Hz

// Remembered device (by USB vendor/product) so we can auto-reconnect on reload.
const PREF_KEY = 'karmyogi.serial.preferred'
interface PortPref {
  usbVendorId?: number
  usbProductId?: number
  /** Controller firmware last connected with, so we can restore the selector. */
  controllerKind?: ControllerKind
  /** Baud rate the last successful connection used. */
  baud?: number
}

function savePreferredPort(
  port: PortLike,
  extra: { controllerKind: ControllerKind; baud: number },
): void {
  const p = port as unknown as { getInfo?: () => SerialPortInfo }
  if (typeof p.getInfo !== 'function') return // mock / non-USB — nothing to save
  try {
    const info = p.getInfo()
    const pref: PortPref = {
      usbVendorId: info.usbVendorId,
      usbProductId: info.usbProductId,
      controllerKind: extra.controllerKind,
      baud: extra.baud,
    }
    localStorage.setItem(PREF_KEY, JSON.stringify(pref))
  } catch {
    /* ignore storage / getInfo errors */
  }
}

/** Derive a short human label for an active connection of the given kind. */
function defaultPortLabel(kind: 'serial' | 'mock' | 'websocket', port: PortLike): string {
  if (kind === 'mock') return 'Mock'
  if (kind === 'websocket') return 'WebSocket'
  const p = port as unknown as { getInfo?: () => SerialPortInfo }
  if (typeof p.getInfo === 'function') {
    try {
      const info = p.getInfo()
      if (info.usbVendorId != null && info.usbProductId != null) {
        const v = info.usbVendorId.toString(16).padStart(4, '0')
        const pr = info.usbProductId.toString(16).padStart(4, '0')
        return `USB ${v}:${pr}`
      }
    } catch {
      /* ignore */
    }
  }
  return 'Serial'
}

function readPreferredPort(): PortPref | null {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    return raw ? (JSON.parse(raw) as PortPref) : null
  } catch {
    return null
  }
}

/**
 * Max number of discrete `$J=` jogs allowed to be in flight (sent but not yet
 * acknowledged with `ok`) at once. GRBL queues jogs in its small planner buffer
 * (~15 deep) and rejects/queues excess; rapid clicking or key auto-repeat can
 * otherwise overrun the planner + 127-byte RX buffer and wedge the controller.
 * Capping outstanding jogs (and dropping extras) coalesces a flood into smooth,
 * bounded motion. 2 keeps motion fluid (one executing, one queued) without ever
 * piling up.
 */
const MAX_INFLIGHT_JOGS = 2

class GrblController {
  private conn: GrblConnection | null = null
  private streamer: Streamer | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private settingsReading = false
  private connecting = false
  /**
   * Discrete jogs (`$J=`) sent but not yet acknowledged by an `ok`. Used to cap
   * how many jogs can be queued in GRBL at once so rapid clicks / key-repeat
   * can't flood the planner + RX buffer (see MAX_INFLIGHT_JOGS).
   */
  private inflightJogs = 0
  /**
   * Resolved protocol dialect for the active connection. Defaults to pure GRBL so
   * everything behaves exactly as before unless the selected firmware opts into
   * deviations (Marlin/Smoothie/Masso). Set at connect time from the profile.
   */
  private dialect: ResolvedDialect = GRBL_DIALECT
  /** What the active connection is (for the farm store's appbar label). */
  private active: ActivePortInfo = { connected: false }
  private readonly activeListeners = new Set<(info: ActivePortInfo) => void>()

  get isConnected(): boolean {
    return this.conn?.isOpen ?? false
  }

  /** Current active-connection descriptor (machineId/label/kind + connected). */
  get activePort(): ActivePortInfo {
    return this.active
  }

  /**
   * Subscribe to active-connection changes (connect/disconnect + label). Used by
   * the machine-farm store so the appbar reflects whatever the facade points at,
   * including connections made via the legacy Connect/Mock buttons. Returns an
   * unsubscribe fn.
   */
  onActiveChange(fn: (info: ActivePortInfo) => void): () => void {
    this.activeListeners.add(fn)
    return () => this.activeListeners.delete(fn)
  }

  private setActive(info: ActivePortInfo): void {
    this.active = info
    for (const fn of this.activeListeners) {
      try {
        fn(info)
      } catch {
        /* a listener throwing must not break the controller */
      }
    }
  }

  /**
   * Connect to a GRBL device. Pass a `PortLike` (e.g. a MockPort for dev/tests);
   * if omitted, prompts the browser port picker (must be a user gesture).
   */
  async connect(
    port?: PortLike,
    opts?: { streamMode?: StreamMode; meta?: ConnectMeta },
  ): Promise<void> {
    if (this.conn || this.connecting) return
    const machine = useMachine.getState()
    // Resolve the active controller profile. The mock device (an explicit
    // `port`) always works regardless of profile; only real hardware connections
    // are gated by whether we can actually speak the firmware's protocol.
    const profile = profileFor(useMachineProfile.getState().controllerKind)
    const isMock = !!port
    if (!isMock && !canLiveConnect(profile)) {
      const msg = `${profile.label} uses a proprietary binary protocol; live connection isn't supported yet — use GRBL/FluidNC, or Mock.`
      useConsole.getState().push('error', msg)
      machine.setError(msg)
      machine.setConnection('disconnected')
      return
    }
    this.connecting = true
    // Resolve the firmware's protocol deviations once per connection. Mock always
    // speaks GRBL (the MockPort is a GRBL emulator), so pin it to the GRBL dialect.
    this.dialect = isMock ? GRBL_DIALECT : resolveDialect(profile.dialect)
    machine.setConnection('connecting')
    machine.setError(null)
    try {
      const conn = new GrblConnection({
        baudRate: profile.baud,
        // A bug parsing ONE response line must never tear down the whole
        // connection: the read loop reports any onLine throw as a disconnect, so
        // we swallow per-line handler errors here (logged to the console) and
        // keep streaming. Genuine transport failures still surface via onDisconnect.
        onLine: (line) => {
          try {
            this.handleLine(line)
          } catch (e) {
            useConsole
              .getState()
              .push('error', `line handler failed on "${line}": ${e instanceof Error ? e.message : String(e)}`)
          }
        },
        onDisconnect: (err) => this.handleDisconnect(err),
      })
      const chosen = port ?? (await GrblConnection.requestPort())
      await conn.open(chosen as PortLike)
      this.conn = conn
      // Coalesce cursor updates to ONE per animation frame. A char-counting
      // burst acks many lines in a single synchronous read tick; pushing a store
      // update per `ok` floods React with dozens of synchronous external-store
      // mutations in one tick (which trips its max-update-depth guard and makes
      // streaming janky). Throttling to rAF keeps the cursor visibly live while
      // collapsing the storm into one update per frame.
      let pendingCursor = -1
      let cursorRaf: number | null = null
      const raf =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame
          : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 16) as unknown as number
      const cancelRaf =
        typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : clearTimeout
      const flushCursor = () => {
        cursorRaf = null
        useProgram.getState().setCursor?.(pendingCursor)
      }
      this.streamer = new Streamer({
        mode: opts?.streamMode ?? 'char-counting',
        writeLine: (l) => conn.writeLine(l),
        onProgress: (completed) => {
          pendingCursor = completed - 1
          if (cursorRaf === null) cursorRaf = raf(flushCursor)
        },
        onError: (line, response) =>
          useConsole.getState().push('error', `error on "${line}": ${response}`),
        onIdle: () => {
          if (cursorRaf !== null) {
            cancelRaf(cursorRaf)
            cursorRaf = null
          }
          useProgram.getState().setStreaming?.(false)
          useProgram.getState().setCursor?.(-1)
        },
      })
      machine.setConnection('connected')
      savePreferredPort(chosen as PortLike, {
        controllerKind: profile.kind,
        baud: profile.baud,
      })
      // Record what we're connected to so the farm store / appbar can label it.
      // Default kind/label inference covers the legacy Connect & Mock buttons,
      // which pass no meta: a `port` arg means Mock, otherwise Web Serial.
      const meta = opts?.meta
      const kind = meta?.kind ?? (isMock ? 'mock' : 'serial')
      const label = meta?.label ?? defaultPortLabel(kind, chosen as PortLike)
      this.setActive({ connected: true, machineId: meta?.machineId, kind, label })
      useConsole.getState().push('info', `Connected (${profile.label}).`)
      this.startStatusPolling()
    } catch (err) {
      machine.setConnection('disconnected')
      machine.setError(err instanceof Error ? err.message : String(err))
      throw err
    } finally {
      this.connecting = false
    }
  }

  /**
   * Attempt to silently reconnect to a previously-authorized device on load.
   * Web Serial remembers granted ports (`navigator.serial.getPorts()`), so no
   * user gesture is needed. Prefers the last-used device (by USB vendor/product
   * saved in localStorage), else the first granted port. Returns true if it
   * connected. Safe to call when nothing was ever authorized (returns false).
   */
  async autoConnect(): Promise<boolean> {
    if (this.conn || this.connecting) return !!this.conn
    if (typeof navigator === 'undefined' || !navigator.serial) return false
    let ports: SerialPort[] = []
    try {
      ports = await navigator.serial.getPorts()
    } catch {
      return false
    }
    if (ports.length === 0) return false
    const pref = readPreferredPort()
    let chosen = ports[0]
    if (pref) {
      // Restore the last-used controller so the selector reflects it and the
      // connection (re)opens at that firmware's baud / capability set.
      if (pref.controllerKind) {
        useMachineProfile.getState().setControllerKind(pref.controllerKind)
      }
      const match = ports.find((p) => {
        const i = p.getInfo()
        return i.usbVendorId === pref.usbVendorId && i.usbProductId === pref.usbProductId
      })
      if (match) chosen = match
    }
    try {
      await this.connect(chosen as unknown as PortLike)
      return true
    } catch {
      return false
    }
  }

  async disconnect(): Promise<void> {
    this.stopStatusPolling()
    this.inflightJogs = 0
    this.streamer?.reset()
    this.streamer = null
    await this.conn?.close()
    this.conn = null
    this.dialect = GRBL_DIALECT
    this.setActive({ connected: false, machineId: this.active.machineId })
    useMachine.getState().setConnection('disconnected')
    useMachine.getState().resetMachine()
    useConsole.getState().push('info', 'Disconnected.')
  }

  private handleLine(line: string): void {
    // GRBL family: a `<...>` realtime report. Parse straight through (unchanged).
    if (this.dialect.status === 'grbl') {
      if (isStatusReport(line)) {
        useMachine.getState().ingestStatusLine(line)
        return
      }
    } else if (this.dialect.status === 'marlin') {
      // Marlin/RepRap/Smoothie: position arrives as an `M114` reply line (not
      // `<...>`). Parse it into a StatusReport and apply it via the same store
      // action GRBL uses. NB: the line may also still carry an `ok` (e.g.
      // "X:.. Y:.. Z:.. ok") — we don't return so the ack accounting below runs.
      const report = parseStatusForDialect(this.dialect, line)
      if (report) {
        useMachine.getState().applyStatus(report)
        // Don't `return`: fall through so a trailing `ok` still drives the streamer.
      }
    }
    // Capture `$N=val` setting lines (from a `$$` dump) into the settings store.
    const setting = parseSettingLine(line)
    if (setting) {
      useGrblSettings.getState().setOne(setting)
      useConsole.getState().push('recv', line)
      this.streamer?.onResponse(line)
      return
    }
    // The `ok` terminating a `$$` dump completes the read.
    if (this.settingsReading && line.trim().toLowerCase() === 'ok') {
      this.settingsReading = false
      useGrblSettings.getState().markRead()
    }
    // During an active program stream, suppress the high-volume routine `ok`
    // acks from the console: pushing one console entry per line floods the store
    // and blocks the UI on a large/fast program. Errors and any non-`ok`
    // response (status, alarms, [MSG:…]) are ALWAYS shown.
    const isRoutineAck = line.trim().toLowerCase() === 'ok'
    if (!(this.streamer?.isRunning && isRoutineAck)) {
      useConsole.getState().push('recv', line)
    }
    // Account for jog acks: an `ok`/`error` frees one in-flight jog so the next
    // queued jog can go out. Only consume one when we're NOT streaming a program
    // (a program's acks belong to the streamer, not the jog gate).
    if (this.inflightJogs > 0 && !this.streamer?.isRunning) {
      const lower = line.trim().toLowerCase()
      if (lower === 'ok' || lower.startsWith('error')) {
        this.inflightJogs--
      }
    }
    this.streamer?.onResponse(line)
  }

  private handleDisconnect(err?: unknown): void {
    if (err) useMachine.getState().setError(err instanceof Error ? err.message : String(err))
    void this.disconnect()
  }

  /** Send a single G-code/`$` line (also echoed to the console). */
  async send(line: string): Promise<void> {
    if (!this.conn) throw new Error('Not connected')
    useConsole.getState().push('send', line)
    await this.conn.writeLine(line)
  }

  /**
   * Write a realtime byte (status, hold, resume, overrides, …). On firmwares that
   * DON'T implement GRBL's single-byte realtime channel (Marlin/Smoothie), spraying
   * these bytes does nothing useful and can confuse the line parser — so they are
   * dropped. The GRBL family (`realtimeBytes: true`) behaves exactly as before.
   */
  async realtime(byte: number): Promise<void> {
    if (!this.conn) return
    if (!this.dialect.realtimeBytes) return
    await this.conn.writeByte(byte)
  }

  // --- common realtime helpers (dialect-aware) ---
  /**
   * Request a status report. GRBL: the `?` realtime byte. Marlin/RepRap/Smoothie:
   * an `M114` query line (parsed back via the dialect). `none`: nothing to send.
   */
  requestStatus = async (): Promise<void> => {
    if (!this.conn) return
    if (this.dialect.status === 'grbl') {
      await this.realtime(RealtimeByte.StatusReport)
      return
    }
    const q = statusQueryLine(this.dialect)
    if (q) await this.conn.writeLine(q)
  }

  /** Feed hold. GRBL: `!` byte. Non-realtime firmwares have no equivalent → no-op. */
  feedHold = () => this.realtime(RealtimeByte.FeedHold)
  /** Resume. GRBL: `~` byte. Non-realtime firmwares have no equivalent → no-op. */
  resume = () => this.realtime(RealtimeByte.CycleStart)

  /**
   * Stop / soft-reset. GRBL: `0x18` realtime byte. Marlin/Smoothie: an `M112`
   * emergency-stop line (they have no realtime reset byte). `none`: just clears the
   * local stream state. In every case the local streamer/program state is reset.
   */
  async softReset(): Promise<void> {
    this.inflightJogs = 0
    this.streamer?.reset()
    useProgram.getState().setStreaming?.(false)
    useProgram.getState().setCursor?.(-1)
    if (this.dialect.reset === 'grbl-0x18') {
      await this.realtime(RealtimeByte.SoftReset)
    } else if (this.dialect.reset === 'marlin-m112' && this.conn) {
      // M112 is Marlin's emergency stop (kill). Sent as a normal line.
      await this.conn.writeLine('M112')
    }
  }

  // --- common line commands (dialect-aware) ---
  /** True for the GRBL family (GRBL / grblHAL / FluidNC + Mock). */
  private get isGrblFamily(): boolean {
    return this.dialect.status === 'grbl' && this.dialect.dollarSettings
  }
  /** Home all axes. GRBL family: `$H`. Marlin/Smoothie: `G28`. */
  home = () => this.send(this.isGrblFamily ? '$H' : 'G28')
  /**
   * Clear an alarm / unlock. GRBL family: `$X`. Marlin/Smoothie have no soft-lock
   * alarm to clear, so this clears the firmware kill state via `M999`.
   */
  unlock = () => this.send(this.isGrblFamily ? '$X' : 'M999')

  // --- GRBL `$`-settings (Motion panel) ---
  /** Request the full settings dump (`$$`). Results land in useGrblSettings. */
  async readSettings(): Promise<void> {
    if (!this.conn) throw new Error('Not connected')
    // Firmwares without GRBL `$`-settings (Marlin/Smoothie/Masso) have nothing to
    // dump — the Motion panel renders their own (M-code / config / on-device) view.
    if (!this.dialect.dollarSettings) return
    this.settingsReading = true
    useGrblSettings.getState().setLoading(true)
    await this.send('$$')
  }

  /** Write a single setting (`$N=val`) and re-read to confirm. */
  async writeSetting(num: number, value: number | string): Promise<void> {
    await this.send(writeSettingCommand(num, value))
  }

  /**
   * Factory reset. `$` = restore settings to defaults, `#` = clear G54–G59
   * offsets, `*` = full EEPROM wipe (settings + offsets). Re-reads settings.
   */
  async resetSettings(kind: '$' | '#' | '*'): Promise<void> {
    await this.send(`$RST=${kind}`)
  }

  /**
   * Relative jog. GRBL family: the cancellable `$J=` jog command (no Alarm on
   * limit). Firmwares without `$J=` (Marlin/Smoothie): fall back to a relative
   * `G91 G1 … F…` move followed by a `G90` restore (not cancellable, but correct).
   */
  async jog({ x, y, z, feed }: JogParams, opts?: { force?: boolean }): Promise<void> {
    if (this.dialect.jogCommand === 'grbl-$J') {
      // Coalesce a flood: drop this jog if too many are already in flight
      // (unacknowledged). Rapid clicking / key auto-repeat thus produces smooth,
      // bounded motion instead of piling jogs into GRBL's planner + RX buffer
      // until the controller stops accepting input. The dropped jog is simply
      // not sent — the next accepted press/tap continues motion.
      //
      // `force` is used for the single continuous (press-hold) jog: it's one
      // long, intentional move that motion-stops on release (0x85), so it must
      // not be coalesced away even if a just-tapped step is still unacked.
      if (!opts?.force && this.inflightJogs >= MAX_INFLIGHT_JOGS) return
      const parts = ['$J=G91', 'G21']
      if (x) parts.push(`X${x}`)
      if (y) parts.push(`Y${y}`)
      if (z) parts.push(`Z${z}`)
      parts.push(`F${feed}`)
      this.inflightJogs++
      try {
        await this.send(parts.join(''))
      } catch (e) {
        // Send failed — don't leave a phantom in-flight jog wedging the gate.
        this.inflightJogs = Math.max(0, this.inflightJogs - 1)
        throw e
      }
      return
    }
    for (const line of g91JogLines({ x, y, z, feed })) {
      await this.send(line)
    }
  }

  /**
   * Cancel an in-progress jog (GRBL 0x85). Flushes any queued jog motion and
   * clears the in-flight gate so the next press jogs immediately. No-op on
   * firmwares without realtime bytes (their jog is a plain blocking move, so
   * there's nothing to cancel).
   */
  jogCancel = async (): Promise<void> => {
    this.inflightJogs = 0
    await this.realtime(0x85)
  }

  /** Stream a program (array of lines). Drives program-store progress. */
  startProgram(lines: string[]): void {
    if (!this.streamer) throw new Error('Not connected')
    this.streamer.reset()
    const program = useProgram.getState()
    program.setStreaming?.(true)
    program.setCursor?.(0)
    this.streamer.enqueue(lines)
    this.streamer.start()
  }

  abortProgram(): void {
    void this.softReset()
  }

  private startStatusPolling(): void {
    this.stopStatusPolling()
    this.statusTimer = setInterval(() => void this.requestStatus(), STATUS_POLL_MS)
  }

  private stopStatusPolling(): void {
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }
}

/** Singleton controller shared across all panels. */
export const grbl = new GrblController()
