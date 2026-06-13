// High-level GRBL controller service (orchestrator-owned shared wiring).
//
// Composes the transport primitives (GrblConnection + Streamer + status parsing
// + realtime bytes) into a single stateful service the UI panels call, and
// wires controller events into the zustand stores (machine / program / console).
//
// Panels (Controller, Console, Program, Motion, …) import the `grbl` singleton
// and the helpers here — they never touch the raw transport classes directly.

import { GrblConnection, type PortLike } from './grblConnection'
import { WsPort, normalizeWsUrl, mixedContentReason } from './wsPort'
import { BlePort, describeBleRequestError } from './blePort'
import { UsbPort } from './usbPort'
import { Streamer, type StreamMode } from './streamer'
import { playCompletionChime } from './completionChime'
import { RealtimeByte } from './realtime'
import { isStatusReport, isParserStateLine } from './status'
import {
  GRBL_DIALECT,
  resolveDialect,
  statusQueryLine,
  g91JogLines,
  isMarlinChatter,
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
import { reportSerialConnected } from '../track/adsConversion'

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
  /**
   * Transport kind, for the manager's bookkeeping. Constrained to the kinds the
   * machine-farm store understands (serial / mock / websocket). Bluetooth (BLE)
   * connections register as `serial` for the farm's roster — BLE can't be
   * silently reconnected anyway (Web Bluetooth requires a fresh user gesture +
   * device chooser), so it isn't a persistently-reconnectable farm entry; its
   * appbar label still reads "Bluetooth …" (see defaultPortLabel + the BlePort
   * detection in connect()). WebUSB (USB-OTG) connections also register as
   * `serial` — unlike BLE they DO auto-reconnect on load via
   * navigator.usb.getDevices() (see autoConnectWebUsb), and their appbar label
   * is the USB product name (see the UsbPort detection in defaultPortLabel).
   */
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
// `$G` parser state changes rarely (only on a G54–G59 / modal change), and it is
// a buffered LINE command (not a realtime byte), so polling it fast would
// needlessly fill the RX buffer and compete with a running job. Poll it slowly
// and ONLY when idle/not streaming (see the timer) so the active WCS badge stays
// fresh without ever interfering with a cut.
const PARSER_STATE_POLL_MS = 2000 // ~0.5 Hz

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
  // A BLE connection arrives as kind 'serial' (farm bookkeeping), so detect it by
  // the BlePort's `label` and prefer the device name.
  if (port instanceof BlePort) return port.label
  // WebUSB (USB-OTG) also arrives as kind 'serial' — prefer its product name
  // over the raw vendor:product fallback its getInfo() would otherwise produce.
  if (port instanceof UsbPort) return port.label
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
  private parserStateTimer: ReturnType<typeof setInterval> | null = null
  // Set when an automatic `$G` poll's `[GC:…]` report arrives, so the matching
  // `ok` that immediately follows is consumed SILENTLY (not echoed to the console
  // and not counted by the jog gate) — otherwise the slow poll spams the console.
  private suppressNextOk = false
  // Marlin only: the automatic `M114` status poll is a buffered LINE command that
  // replies `X:.. Y:.. Z:..` then a bare `ok`. We poll it ~5 Hz, so that `ok` must
  // be swallowed SILENTLY (no console echo, not counted by the jog gate) exactly
  // like the `$G` poll's `ok` above — otherwise the console floods with `ok`s.
  // Counted so a position reply that didn't arrive (busy/echo chatter in between)
  // can't strand the flag and swallow an unrelated later `ok`.
  private pendingStatusAcks = 0
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
    // A WebUSB (USB-OTG) port is REAL hardware: it must resolve the firmware's
    // dialect (Marlin M114 polling etc.), respect the live-connect gate, and
    // count as a real serial connection. Every other injected port keeps the
    // legacy path (Mock today; BLE/WS connections behave exactly as before).
    const isMock = !!port && !(port instanceof UsbPort)
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
    this.dialect = isMock ? GRBL_DIALECT : resolveDialect(profile.dialect, profile.kind)
    // Baud the port is actually opened at: the user's override (if set) wins over
    // the profile default. The mock/WebSocket transports ignore baud, so this only
    // matters for real USB (Web Serial) — but it's harmless to pass through.
    const baudRate = useMachineProfile.getState().effectiveBaud()
    machine.setConnection('connecting')
    machine.setError(null)
    try {
      const conn = new GrblConnection({
        baudRate,
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
          // Natural completion only — abort goes through streamer.reset(), which
          // never fires onIdle. Signal the finished cycle with a chime + a console
          // line so the user knows the machine is done without watching.
          const wasStreaming = useProgram.getState().streaming
          useProgram.getState().setStreaming?.(false)
          useProgram.getState().setCursor?.(-1)
          if (wasStreaming) {
            playCompletionChime()
            useConsole.getState().push('info', '✓ Program complete — cycle finished.')
          }
        },
      })
      machine.setConnection('connected')
      savePreferredPort(chosen as PortLike, {
        controllerKind: profile.kind,
        baud: baudRate,
      })
      // Record what we're connected to so the farm store / appbar can label it.
      // Default kind/label inference covers the legacy Connect & Mock buttons,
      // which pass no meta: a `port` arg means Mock, otherwise Web Serial.
      const meta = opts?.meta
      const kind = meta?.kind ?? (isMock ? 'mock' : 'serial')
      const label = meta?.label ?? defaultPortLabel(kind, chosen as PortLike)
      this.setActive({ connected: true, machineId: meta?.machineId, kind, label })
      useConsole.getState().push('info', `Connected (${profile.label}).`)
      // Fire the Google Ads "Serial Connected" activation conversion (best-effort,
      // once per session, off-on-localhost). Only for a REAL serial port — not the
      // in-browser mock or a WebSocket. BLE arrives as kind 'serial' (farm
      // bookkeeping) and may also fire it; that's acceptable (still a real machine
      // link, deduped once-per-session, and guarded off on dev/localhost). Must
      // never throw or delay the connection, so it's a fire-and-forget call after
      // the link is confirmed established.
      if (kind === 'serial' && !isMock) {
        try {
          reportSerialConnected()
        } catch {
          /* tracking is best-effort and must never affect the connection */
        }
      }
      this.startStatusPolling()
    } catch (err) {
      machine.setConnection('disconnected')
      // Dismissing the Web Serial port picker (no device chosen) is a normal user
      // action, NOT a failure — don't surface it as an error.
      const name = (err as { name?: string } | null)?.name
      if (name !== 'AbortError' && name !== 'NotFoundError') {
        machine.setError(err instanceof Error ? err.message : String(err))
      }
      throw err
    } finally {
      this.connecting = false
    }
  }

  /**
   * Connect over WiFi to a network-attached GRBL controller (ESP3D / FluidNC /
   * MKS DLC32) via its WebSocket bridge. `endpoint` may be a bare host/IP, a
   * host:port, or a full ws(s):// URL (see normalizeWsUrl). When the page is
   * served over https and no scheme is given we default to `wss://`; a plain
   * `ws://` from an https page is blocked by the browser (mixed content) and is
   * rejected up front with a clear, actionable message.
   */
  async connectWebSocket(
    endpoint: string,
    opts?: { defaultPort?: number; label?: string; machineId?: string; streamMode?: StreamMode },
  ): Promise<void> {
    const raw = endpoint.trim()
    if (!raw) {
      const msg = 'Enter a host or IP address.'
      useMachine.getState().setError(msg)
      throw new Error(msg)
    }
    // If the input already pins a port — a full ws(s):// URL, a host:port, or a
    // user-typed port (opts.defaultPort) — connect to exactly that. Otherwise
    // AUTO-DETECT: FluidNC/ESP3D users usually know the IP but not the WebSocket
    // port, so probe the common ones and use the first that answers.
    const authority = raw.replace(/^wss?:\/\//i, '').split('/')[0]
    const inputHasPort =
      /]:\d+$/.test(authority) || (!authority.includes(']') && /:\d+$/.test(authority))
    if (/^wss?:\/\//i.test(raw) || inputHasPort || opts?.defaultPort != null) {
      await this.connectWsUrl(normalizeWsUrl(raw, opts?.defaultPort ?? 81), opts)
      return
    }
    const CANDIDATE_PORTS = [81, 82, 8080, 80]
    // Mixed-content blocking is identical for every candidate (same scheme + host),
    // so fail once up front rather than probing ports that can never connect.
    const blocked = mixedContentReason(normalizeWsUrl(raw, CANDIDATE_PORTS[0]))
    if (blocked) {
      useConsole.getState().push('error', blocked)
      useMachine.getState().setError(blocked)
      throw new Error(blocked)
    }
    useMachine.getState().setError(null)
    useMachine.getState().setConnection('connecting')
    useConsole
      .getState()
      .push('info', `Auto-detecting WebSocket port — trying ${CANDIDATE_PORTS.join(', ')}…`)
    for (const cp of CANDIDATE_PORTS) {
      const url = normalizeWsUrl(raw, cp)
      if (await this.probeWs(url, 2500)) {
        useConsole.getState().push('info', `Port ${cp} answered — connecting.`)
        // Let the probe socket fully close before the real connection (some
        // controllers accept only one WebSocket client at a time).
        await new Promise((r) => setTimeout(r, 200))
        await this.connectWsUrl(url, opts)
        return
      }
    }
    useMachine.getState().setConnection('disconnected')
    const fail = `Couldn't reach ${authority} on any common WebSocket port (${CANDIDATE_PORTS.join(', ')}). Check the IP, make sure the controller's Wi-Fi/WebSocket is on, or enter the port manually if you know it.`
    useConsole.getState().push('error', fail)
    useMachine.getState().setError(fail)
    throw new Error(fail)
  }

  /** Connect to one fully-resolved ws(s):// URL — the single, explicit-port path. */
  private async connectWsUrl(
    url: string,
    opts?: { label?: string; machineId?: string; streamMode?: StreamMode },
  ): Promise<void> {
    // Pre-flight the mixed-content rule so the UI gets a clean message instead of
    // an opaque socket failure (the WsPort ctor also enforces this).
    const blocked = mixedContentReason(url)
    if (blocked) {
      useConsole.getState().push('error', blocked)
      useMachine.getState().setError(blocked)
      throw new Error(blocked)
    }
    const port = new WsPort(url)
    await this.connect(port, {
      streamMode: opts?.streamMode,
      meta: { kind: 'websocket', label: opts?.label ?? url, machineId: opts?.machineId },
    })
  }

  /**
   * Quickly test whether a WebSocket OPENS at `url` within `timeoutMs`, then close
   * the probe. Used to auto-detect a controller's port without running the full
   * GRBL handshake against every candidate.
   */
  private probeWs(url: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (typeof WebSocket === 'undefined') return resolve(false)
      let settled = false
      let ws: WebSocket | null = null
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          ws?.close()
        } catch {
          /* ignore */
        }
        resolve(ok)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      try {
        ws = new WebSocket(url)
        ws.onopen = () => finish(true)
        ws.onerror = () => finish(false)
        ws.onclose = () => finish(false)
      } catch {
        finish(false)
      }
    })
  }

  /**
   * Connect over Bluetooth (Web Bluetooth / BLE GATT) to a GRBL Bluetooth-LE
   * serial bridge (Nordic UART Service, or an HM-10/HC-08-style module). Must be
   * called from a user gesture; the browser shows its device chooser. Reuses the
   * whole streaming stack via a BlePort PortLike.
   */
  async connectBluetooth(
    opts?: { acceptAllDevices?: boolean; machineId?: string; streamMode?: StreamMode },
  ): Promise<void> {
    if (!BlePort.isSupported()) {
      const msg =
        'Web Bluetooth is not available in this browser. Use Chrome/Edge over HTTPS ' +
        '(or localhost) with the OS Bluetooth turned on.'
      useConsole.getState().push('error', msg)
      useMachine.getState().setError(msg)
      throw new Error(msg)
    }
    const port = new BlePort({ acceptAllDevices: opts?.acceptAllDevices })
    // Surface an unexpected GATT drop (the read loop also catches the readable
    // closing, but this guarantees the disconnect path runs).
    port.setOnDisconnect(() => this.handleDisconnect())
    // The device name isn't known until requestDevice resolves; connect() reads
    // the BlePort.label after open() via defaultPortLabel (which detects BlePort),
    // so leave label unset. `kind: 'serial'` is the farm-understood fallback
    // (the farm has no 'ble' kind); BLE isn't a reconnectable farm entry anyway.
    try {
      await this.connect(port, {
        streamMode: opts?.streamMode,
        meta: { kind: 'serial', machineId: opts?.machineId },
      })
    } catch (err) {
      // Always log the RAW error (name + message) for diagnosis — the friendly
      // message below can otherwise mask what truly failed.
      const rawName = (err as { name?: string } | null)?.name ?? 'Error'
      const rawMsg = err instanceof Error ? err.message : String(err)
      useConsole.getState().push('error', `BLE raw error — ${rawName}: ${rawMsg}`)
      // Translate the (often cryptic) Web Bluetooth failure into an actionable
      // message: dismissing the chooser stays quiet; adapter-off / permission /
      // no-UART-service all get a clear hint. The message is surfaced here, so the
      // caller's no-op .catch() never leaves the user with "nothing happened".
      const f = await describeBleRequestError(err)
      const machine = useMachine.getState()
      if (f.cancelled) {
        machine.setError(null)
      } else {
        useConsole.getState().push('error', f.message)
        machine.setError(f.message)
      }
    }
  }

  /**
   * Connect over WebUSB — the USB-OTG path for Android Chromium, where Web
   * Serial does not exist but `navigator.usb` does. UsbPort speaks the bridge
   * chip's native protocol (CDC-ACM / CH340 / CP210x / FTDI) in the browser, so
   * the same byte stream the desktop gets from Web Serial arrives here and the
   * whole streaming stack (incl. the effectiveBaud override / Marlin's 250000)
   * is reused unchanged. Must be called from a user gesture (device chooser).
   */
  async connectUsbOtg(opts?: { machineId?: string; streamMode?: StreamMode }): Promise<void> {
    if (!UsbPort.isSupported()) {
      const msg =
        'WebUSB is not available in this browser. On Android use Chrome/Edge over ' +
        'HTTPS; on iPhone/iPad use the Network (WebSocket) bridge instead.'
      useConsole.getState().push('error', msg)
      useMachine.getState().setError(msg)
      throw new Error(msg)
    }
    // Dismissing the chooser throws NotFoundError before any state changed —
    // it propagates to the caller (the UI ignores it), with no error surfaced.
    const port = await UsbPort.request()
    // Surface an unplug immediately (the read pump also errors the readable).
    port.setOnDisconnect(() => this.handleDisconnect())
    await this.connect(port, {
      streamMode: opts?.streamMode,
      meta: { kind: 'serial', machineId: opts?.machineId },
    })
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
    if (typeof navigator === 'undefined') return false
    // No Web Serial (Android Chromium): fall back to WebUSB, whose permission
    // grants Chrome also persists per origin — same silent-reconnect pattern.
    if (!navigator.serial) return this.autoConnectWebUsb()
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

  /**
   * WebUSB flavour of autoConnect (Android, where navigator.serial is absent):
   * `navigator.usb.getDevices()` returns devices this origin was already
   * granted, so a previously-used OTG adapter reconnects with no gesture.
   * UsbPort.getInfo() feeds the same vendor/product preference matching as the
   * Web Serial path. Returns true if it connected.
   */
  private async autoConnectWebUsb(): Promise<boolean> {
    if (!UsbPort.isSupported()) return false
    const pref = readPreferredPort()
    const port = await UsbPort.findAuthorized(pref ?? undefined)
    if (!port) return false
    // Restore the last-used controller so the selector + baud/capability set
    // match what this device was driven with before.
    if (pref?.controllerKind) {
      useMachineProfile.getState().setControllerKind(pref.controllerKind)
    }
    port.setOnDisconnect(() => this.handleDisconnect())
    try {
      await this.connect(port, { meta: { kind: 'serial' } })
      return true
    } catch {
      // claimInterface can fail when the OS/another app holds the device — the
      // user can still connect manually from the menu (with the clear error).
      return false
    }
  }

  async disconnect(): Promise<void> {
    this.stopStatusPolling()
    this.inflightJogs = 0
    this.pendingStatusAcks = 0
    this.suppressNextOk = false
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
      // `$G` parser-state report (`[GC:G0 G54 …]`): record the active WCS + modal
      // words so the Coordinates panel reflects the machine's REAL state. This is
      // an AUTOMATIC poll, so consume it SILENTLY (like a `?` status report) — do
      // NOT echo it to the console — and flag the matching `ok` (which arrives on
      // the next line) for silent consumption too, so the poll never spams.
      if (isParserStateLine(line)) {
        useMachine.getState().ingestParserStateLine(line)
        this.suppressNextOk = true
        return
      }
    } else if (this.dialect.status === 'marlin') {
      // Marlin/RepRap/Smoothie: position arrives as an `M114` reply line (not
      // `<...>`). Parse it into a StatusReport and apply it via the same store
      // action GRBL uses.
      const report = parseStatusForDialect(this.dialect, line)
      if (report) {
        useMachine.getState().applyStatus(report)
        // Echo the position report to the console (it's a recv line), but do NOT
        // fall through to the jog/stream ack accounting — a position line is not
        // an `ok`. The bare `ok` that follows is handled below (and silently
        // swallowed for an automatic poll via pendingStatusAcks).
        useConsole.getState().push('recv', line)
        return
      }
      // Marlin chatter (echo:/busy:/temperature/boot banner) is informational and
      // is NEVER an ack — echo it to the console but keep it away from the settings
      // capture, the jog gate, and the streamer's `ok` accounting below.
      if (isMarlinChatter(this.dialect, line)) {
        useConsole.getState().push('recv', line)
        return
      }
      // The bare `ok` acknowledging an AUTOMATIC `M114` status poll: swallow it
      // silently (no console echo, not a jog/stream ack) so the ~5 Hz poll never
      // spams. Only consume it when NOT streaming — during a stream the poll is
      // gated off (Marlin status is a buffered line command) so any `ok` belongs
      // to the program and must reach the streamer.
      if (
        this.pendingStatusAcks > 0 &&
        !this.streamer?.isRunning &&
        line.trim().toLowerCase() === 'ok'
      ) {
        this.pendingStatusAcks--
        return
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
    // Silently swallow the `ok` that acknowledges an AUTOMATIC `$G` poll (its
    // `[GC:…]` was just ingested above): no console echo, and it must NOT reach the
    // jog gate below (it isn't a jog ack). This stops the slow poll spamming.
    if (this.suppressNextOk && line.trim().toLowerCase() === 'ok') {
      this.suppressNextOk = false
      return
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
    // The dangerous CNC case: losing the link WHILE a job is streaming. Surface
    // an explicit, prominent message (not just a console line) via the machine
    // store so the operator immediately sees the cut was interrupted. A plain
    // idle disconnect just shows the underlying transport error (if any).
    const detail = err instanceof Error ? err.message : err ? String(err) : ''
    const wasStreaming = !!this.streamer?.isRunning
    if (wasStreaming) {
      const msg =
        'Connection lost while a program was running — the job was interrupted. ' +
        'Check the machine before reconnecting.' + (detail ? ` (${detail})` : '')
      useMachine.getState().setError(msg)
      useConsole.getState().push('error', msg)
    } else if (detail) {
      useMachine.getState().setError(detail)
    }
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
      // GRBL's `?` is a free realtime byte (no RX-buffer cost, no `ok`), so it is
      // safe to poll continuously even mid-stream — behaviour is unchanged.
      await this.realtime(RealtimeByte.StatusReport)
      return
    }
    const q = statusQueryLine(this.dialect)
    if (!q) return
    // Marlin/RepRap: status is a buffered LINE command (`M114`) that occupies the
    // RX buffer and replies with its own `ok`. Injecting it into an active
    // char-counting stream would both consume buffer space the streamer doesn't
    // account for AND have its `ok` miscounted as a program-line ack — desyncing
    // the stream. So skip polling while a program is running (position simply
    // freezes during the cut, which is safe; the poll resumes on idle). The poll
    // timer also guards this, but guard here too in case requestStatus is called
    // directly.
    if (this.streamer?.isRunning) return
    // Flag the matching `ok` for silent consumption (see handleLine) so the poll
    // doesn't spam the console. Capped so a missed reply can't strand the flag.
    if (this.pendingStatusAcks < 4) this.pendingStatusAcks++
    try {
      await this.conn.writeLine(q)
    } catch {
      this.pendingStatusAcks = Math.max(0, this.pendingStatusAcks - 1)
    }
  }

  /**
   * Request the GRBL `$G` parser-state report (`[GC:…]`). GRBL family only — it
   * carries the active work coordinate system (G54–G59) which the Coordinates
   * panel reads. A buffered line command; skipped while NOT connected to the
   * GRBL family. Errors are swallowed (a transient write failure must not crash
   * the poll loop; the next tick retries).
   */
  requestParserState = async (): Promise<void> => {
    if (!this.conn) return
    if (!this.isGrblFamily) return
    try {
      // Flag the ACK suppression at SEND time, not on the `[GC:…]` line: real GRBL
      // replies `[GC:…]` + `ok`, but the mock device (and anything that doesn't
      // emit the parser-state report) replies with a bare `ok`. Suppressing here
      // swallows the auto-poll's ack in BOTH cases, so the console never spams.
      this.suppressNextOk = true
      await this.conn.writeLine('$G')
    } catch {
      this.suppressNextOk = false
      /* transient write error — the next poll tick retries */
    }
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

  /**
   * Stream a program. `lines` is the slice to actually send; `opts.startIndex`
   * is the 0-based offset of `lines[0]` within the FULL program (default 0), so
   * a "feed from line N" run reports progress / current-line in full-program
   * indices. The streamer adds `startIndex` to every reported index/count, and
   * the cursor below is seeded to the first line being sent (= startIndex).
   */
  startProgram(lines: string[], opts?: { startIndex?: number }): void {
    if (!this.streamer) throw new Error('Not connected')
    const startIndex =
      opts?.startIndex != null && Number.isFinite(opts.startIndex) && opts.startIndex > 0
        ? Math.floor(opts.startIndex)
        : 0
    this.streamer.reset()
    this.streamer.setStartIndex(startIndex)
    const program = useProgram.getState()
    program.setStreaming?.(true)
    // Seed the cursor at the first line we're about to send (full-program index).
    program.setCursor?.(startIndex)
    this.streamer.enqueue(lines)
    this.streamer.start()
  }

  abortProgram(): void {
    void this.softReset()
  }

  private startStatusPolling(): void {
    this.stopStatusPolling()
    this.statusTimer = setInterval(() => {
      // For a line-command status (Marlin `M114`) skip the poll while streaming —
      // it would compete for the RX buffer and its `ok` would desync the
      // char-counting window. GRBL's `?` realtime byte is free, so it always polls.
      if (this.dialect.statusIsLineCommand && this.streamer?.isRunning) return
      void this.requestStatus()
    }, STATUS_POLL_MS)
    // Prime the active-WCS badge immediately, then poll `$G` slowly. The poll
    // only fires when a program is NOT streaming, so it never competes with a
    // job for the RX buffer (the WCS won't change mid-cut anyway).
    void this.requestParserState()
    this.parserStateTimer = setInterval(() => {
      if (this.streamer?.isRunning) return
      void this.requestParserState()
    }, PARSER_STATE_POLL_MS)
  }

  private stopStatusPolling(): void {
    if (this.statusTimer !== null) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
    if (this.parserStateTimer !== null) {
      clearInterval(this.parserStateTimer)
      this.parserStateTimer = null
    }
  }
}

/** Singleton controller shared across all panels. */
export const grbl = new GrblController()
