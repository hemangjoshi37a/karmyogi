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
import { parseSettingLine, writeSettingCommand } from './settings'
import { useMachine } from '../store/machine'
import { useProgram } from '../store/program'
import { useConsole } from '../store/console'
import { useGrblSettings } from '../store/grblSettings'
import { useMachineProfile } from '../store/machineProfile'
import { canLiveConnect, profileFor } from '../machine/controllers'
import type { ControllerKind } from '../machine/types'

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

function readPreferredPort(): PortPref | null {
  try {
    const raw = localStorage.getItem(PREF_KEY)
    return raw ? (JSON.parse(raw) as PortPref) : null
  } catch {
    return null
  }
}

class GrblController {
  private conn: GrblConnection | null = null
  private streamer: Streamer | null = null
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private settingsReading = false
  private connecting = false

  get isConnected(): boolean {
    return this.conn?.isOpen ?? false
  }

  /**
   * Connect to a GRBL device. Pass a `PortLike` (e.g. a MockPort for dev/tests);
   * if omitted, prompts the browser port picker (must be a user gesture).
   */
  async connect(port?: PortLike, opts?: { streamMode?: StreamMode }): Promise<void> {
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
    machine.setConnection('connecting')
    machine.setError(null)
    try {
      const conn = new GrblConnection({
        baudRate: profile.baud,
        onLine: (line) => this.handleLine(line),
        onDisconnect: (err) => this.handleDisconnect(err),
      })
      const chosen = port ?? (await GrblConnection.requestPort())
      await conn.open(chosen as PortLike)
      this.conn = conn
      this.streamer = new Streamer({
        mode: opts?.streamMode ?? 'char-counting',
        writeLine: (l) => conn.writeLine(l),
        onProgress: (completed) => useProgram.getState().setCursor?.(completed - 1),
        onError: (line, response) =>
          useConsole.getState().push('error', `error on "${line}": ${response}`),
        onIdle: () => {
          useProgram.getState().setStreaming?.(false)
          useProgram.getState().setCursor?.(-1)
        },
      })
      machine.setConnection('connected')
      savePreferredPort(chosen as PortLike, {
        controllerKind: profile.kind,
        baud: profile.baud,
      })
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
    this.streamer?.reset()
    this.streamer = null
    await this.conn?.close()
    this.conn = null
    useMachine.getState().setConnection('disconnected')
    useMachine.getState().resetMachine()
    useConsole.getState().push('info', 'Disconnected.')
  }

  private handleLine(line: string): void {
    if (isStatusReport(line)) {
      useMachine.getState().ingestStatusLine(line)
      return
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
    useConsole.getState().push('recv', line)
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

  /** Write a realtime byte (status, hold, resume, overrides, …). */
  async realtime(byte: number): Promise<void> {
    if (!this.conn) return
    await this.conn.writeByte(byte)
  }

  // --- common realtime helpers ---
  requestStatus = () => this.realtime(RealtimeByte.StatusReport)
  feedHold = () => this.realtime(RealtimeByte.FeedHold)
  resume = () => this.realtime(RealtimeByte.CycleStart)
  async softReset(): Promise<void> {
    this.streamer?.reset()
    useProgram.getState().setStreaming?.(false)
    useProgram.getState().setCursor?.(-1)
    await this.realtime(RealtimeByte.SoftReset)
  }

  // --- common line commands ---
  home = () => this.send('$H')
  unlock = () => this.send('$X')

  // --- GRBL `$`-settings (Motion panel) ---
  /** Request the full settings dump (`$$`). Results land in useGrblSettings. */
  async readSettings(): Promise<void> {
    if (!this.conn) throw new Error('Not connected')
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

  /** Relative jog using GRBL's `$J=` jog command (cancellable, no Alarm on limit). */
  async jog({ x, y, z, feed }: JogParams): Promise<void> {
    const parts = ['$J=G91', 'G21']
    if (x) parts.push(`X${x}`)
    if (y) parts.push(`Y${y}`)
    if (z) parts.push(`Z${z}`)
    parts.push(`F${feed}`)
    await this.send(parts.join(''))
  }

  /** Cancel an in-progress jog (GRBL 0x85). */
  jogCancel = () => this.realtime(0x85)

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
