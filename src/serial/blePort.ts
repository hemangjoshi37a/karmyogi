// BlePort — a `PortLike` backed by Web Bluetooth (GATT), so the GRBL transport
// stack can talk to a Bluetooth-LE serial bridge exactly like it talks to a USB
// serial port, a WebSocket, or the MockPort.
//
// It implements the SAME minimal `PortLike` interface GrblConnection/Streamer
// already consume (see grblConnection.ts and mockPort.ts):
//
//   readable  : ReadableStream<Uint8Array>  — bytes arriving from the device
//   writable  : WritableStream<Uint8Array>  — bytes we send to the device
//   open()    : requestDevice → GATT connect → wire notifications, resolves when ready
//   close()   : disconnect GATT and tear down the streams
//
// TRANSPORT MODEL — BLE "serial" is a UART emulated over a GATT service with two
// characteristics: one we WRITE to (host → device) and one we subscribe to for
// NOTIFY (device → host). The de-facto standard is Nordic UART Service (NUS):
//
//   Service : 6e400001-b5a3-f393-e0a9-e50e24dcca9e
//   RX (write, host→device)   : 6e400002-b5a3-f393-e0a9-e50e24dcca9e
//   TX (notify, device→host)  : 6e400003-b5a3-f393-e0a9-e50e24dcca9e
//
// Cheap HM-10 / HC-08 / AT-09 style BLE-UART modules use their own vendor service
// + a single read/write/notify characteristic instead. We list those as
// `optionalServices` and, when present, auto-discover a notify characteristic for
// RX and a writable one for TX, so those modules work too.
//
// BLE GATT writes are bounded by the negotiated ATT MTU (default 23 bytes → 20
// usable payload bytes). We therefore chunk every write into ~20-byte frames.
//
// IMPORTANT: Web Bluetooth is Chromium-only and requires a secure context
// (HTTPS / localhost) AND a user gesture to call requestDevice() — the same
// constraints as Web Serial.

import type { PortLike } from './grblConnection'

// --- Minimal Web Bluetooth typings ------------------------------------------
// `@types/web-bluetooth` is intentionally not installed (the project pins
// `types` in tsconfig to vite/client + w3c-web-serial), so we declare the small
// slice of the API we actually use. These mirror the W3C Web Bluetooth IDL.
type BluetoothServiceUUID = number | string
type BluetoothCharacteristicUUID = number | string

interface BluetoothRemoteGATTCharacteristic extends EventTarget {
  readonly uuid: string
  readonly properties: {
    readonly write: boolean
    readonly writeWithoutResponse: boolean
    readonly notify: boolean
    readonly indicate: boolean
  }
  value?: DataView
  // Param typed as a permissive buffer view so a `Uint8Array<ArrayBufferLike>`
  // (TS 5.7+ default) is assignable without a cast at every call site.
  writeValueWithoutResponse?(value: ArrayBuffer | ArrayBufferView): Promise<void>
  writeValueWithResponse?(value: ArrayBuffer | ArrayBufferView): Promise<void>
  writeValue?(value: ArrayBuffer | ArrayBufferView): Promise<void>
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
  stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic>
}

interface BluetoothRemoteGATTService {
  getCharacteristic(uuid: BluetoothCharacteristicUUID): Promise<BluetoothRemoteGATTCharacteristic>
  getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]>
}

interface BluetoothRemoteGATTServer {
  readonly connected: boolean
  connect(): Promise<BluetoothRemoteGATTServer>
  disconnect(): void
  getPrimaryService(uuid: BluetoothServiceUUID): Promise<BluetoothRemoteGATTService>
  getPrimaryServices(): Promise<BluetoothRemoteGATTService[]>
}

interface BluetoothDevice extends EventTarget {
  readonly id: string
  readonly name?: string
  readonly gatt?: BluetoothRemoteGATTServer
}

interface RequestDeviceFilter {
  services?: BluetoothServiceUUID[]
  name?: string
  namePrefix?: string
}

interface RequestDeviceOptions {
  filters?: RequestDeviceFilter[]
  optionalServices?: BluetoothServiceUUID[]
  acceptAllDevices?: boolean
}

interface BluetoothApi {
  getAvailability?(): Promise<boolean>
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDevice>
}

function getBluetooth(): BluetoothApi | null {
  if (typeof navigator === 'undefined') return null
  const bt = (navigator as unknown as { bluetooth?: BluetoothApi }).bluetooth
  return bt ?? null
}

// --- Known BLE-UART services -------------------------------------------------

/** Nordic UART Service (NUS) — the de-facto BLE serial standard. */
export const NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'
/** NUS RX: host → device (write). */
export const NUS_RX_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'
/** NUS TX: device → host (notify). */
export const NUS_TX_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'

/** Microchip RN4870/71 (ISSC) Transparent UART service. */
export const RN4870_SERVICE = '49535343-fe7d-4ae5-8fa9-9fafd205e455'
/** RN4870 TX: device → host (notify). */
const RN4870_TX_NOTIFY = '49535343-1e4d-4bd9-ba61-23c647249616'
/** RN4870 RX: host → device (write / write-without-response). */
const RN4870_RX_WRITE = '49535343-8841-43f4-a8d4-ecbe34729bb3'

/** HM-10 / HC-08 / AT-09 / JDY-08 vendor UART service (single FFE1 char). */
const HM10_SERVICE = 0xffe0
/** Common UART-bridge vendor service variant. */
const FFF0_SERVICE = 0xfff0

/**
 * Every UART-ish service we may need to TALK to after connecting. Chrome only
 * exposes services listed here (or in a matching filter), so this is the
 * superset for both the filtered and the accept-all chooser.
 */
const OPTIONAL_UART_SERVICES: BluetoothServiceUUID[] = [
  NUS_SERVICE,
  HM10_SERVICE,
  FFF0_SERVICE,
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  RN4870_SERVICE,
]

/**
 * Chooser filters. LAYERED on purpose: most modules do NOT advertise their
 * UART service UUID (FluidNC/ESP32 NUS bridges usually advertise only a name;
 * HM-10s do advertise FFE0), so a services-only filter list hides most real
 * machines. We therefore ALSO match on the well-known module/firmware name
 * prefixes. `namePrefix` is case-sensitive, hence the case variants. Devices
 * with truly odd advertisements are reachable via the accept-all path.
 */
const REQUEST_FILTERS: RequestDeviceFilter[] = [
  { services: [NUS_SERVICE] },
  { services: [HM10_SERVICE] },
  { services: [FFF0_SERVICE] },
  { services: [RN4870_SERVICE] },
  { namePrefix: 'FluidNC' },
  { namePrefix: 'GRBL' },
  { namePrefix: 'Grbl' },
  { namePrefix: 'grbl' },
  { namePrefix: 'BT04' }, // BT04-A / AT-09 clones
  { namePrefix: 'BT05' },
  { namePrefix: 'HM' }, // HM-10 ("HMSoft"), HM-16/17
  { namePrefix: 'HC' }, // HC-08 (BLE — classic HC-05/06 never appear to BLE scans)
  { namePrefix: 'JDY' }, // JDY-08 / JDY-23
  { namePrefix: 'MLT' }, // MLT-BT05
]

/** Shown when we GATT-connected but found nothing UART-shaped to talk to. */
export const BLE_NO_UART_MESSAGE =
  'Connected, but the device has no supported BLE serial service (NUS / FFE0 / RN4870). ' +
  'Classic Bluetooth modules (HC-05/HC-06) are not reachable from browsers — use a ' +
  'BLE-UART module (HM-10 / JDY-08 / FluidNC) or the Wi-Fi (WebSocket) bridge.'

export interface BleRequestFailure {
  /** Human-actionable message for the connect UI / console. */
  message: string
  /** True when the user simply dismissed the chooser (not a real fault). */
  cancelled: boolean
}

/**
 * Translate a requestDevice() / GATT failure into a human-actionable message.
 * Consults getAvailability() AFTER the failure — never before the chooser (a
 * pre-flight await would void the tap's transient user activation) — so an
 * OFF adapter gets its own "turn on Bluetooth" hint.
 */
export async function describeBleRequestError(err: unknown): Promise<BleRequestFailure> {
  const name = (err as { name?: string } | null)?.name ?? ''
  const raw = err instanceof Error ? err.message : String(err ?? '')
  // Chooser dismissed: Chrome rejects with NotFoundError "User cancelled the
  // requestDevice() chooser." (some platforms use AbortError). A normal action.
  if (name === 'AbortError' || (name === 'NotFoundError' && /cancel/i.test(raw))) {
    return { cancelled: true, message: 'No Bluetooth device selected.' }
  }
  // chrome://flags / enterprise policy: NotFoundError "Web Bluetooth API globally disabled."
  if (name === 'NotFoundError' && /globally disabled/i.test(raw)) {
    return {
      cancelled: false,
      message:
        'Web Bluetooth is disabled in this browser (flag or policy). Check chrome://flags ' +
        '→ "Web Bluetooth" and the browser policy, then retry.',
    }
  }
  if (name === 'SecurityError' || name === 'NotAllowedError') {
    return {
      cancelled: false,
      message:
        'Bluetooth permission denied — allow "Nearby devices" for this browser ' +
        '(Android: Settings → Apps → Chrome → Permissions) and open karmyogi over a ' +
        'trusted HTTPS connection.',
    }
  }
  if (name === 'InvalidStateError') {
    return {
      cancelled: false,
      message: 'The Bluetooth adapter is not ready — toggle Bluetooth off/on and retry.',
    }
  }
  // Anything else. IMPORTANT: navigator.bluetooth.getAvailability() is UNRELIABLE
  // on Android (it frequently returns false even when Bluetooth is ON), so we must
  // NOT use it to flatly claim "Bluetooth is off" — doing that hides the real
  // failure. Instead we ALWAYS surface the underlying error and only soften the
  // adapter hint based on availability.
  const avail = await BlePort.availability()
  const base = raw ? `Bluetooth connect failed: ${raw}` : 'Bluetooth connect failed.'
  const hint =
    avail === false
      ? ' If Bluetooth is OFF, turn it on (plus Location on Android 11 and older). If it IS on, the browser didn’t report a Bluetooth adapter — open karmyogi over HTTPS in Chrome/Edge.'
      : ' Make sure the machine is powered, advertising over BLE, and in range; if it isn’t in the list, tap “Show all devices”. (Classic Bluetooth HC-05/HC-06 can’t be reached from a browser.)'
  return { cancelled: false, message: `${base}${hint}` }
}

/**
 * Scan one GATT service for a notify characteristic (RX, device → host) and a
 * writable one (TX, host → device). HM-10-style modules expose ONE FFE1
 * characteristic that is BOTH — it is then used for both directions.
 */
async function pickUartPair(
  svc: BluetoothRemoteGATTService,
): Promise<{ rx: BluetoothRemoteGATTCharacteristic; tx: BluetoothRemoteGATTCharacteristic } | null> {
  let chars: BluetoothRemoteGATTCharacteristic[] = []
  try {
    chars = await svc.getCharacteristics()
  } catch {
    return null
  }
  let notify: BluetoothRemoteGATTCharacteristic | null = null
  let write: BluetoothRemoteGATTCharacteristic | null = null
  for (const c of chars) {
    const p = c.properties
    if (!notify && (p.notify || p.indicate)) notify = c
    if (!write && (p.write || p.writeWithoutResponse)) write = c
  }
  // A single characteristic that is both notify and writable (HM-10 style).
  if (!notify && write && (write.properties.notify || write.properties.indicate)) notify = write
  if (!write && notify && (notify.properties.write || notify.properties.writeWithoutResponse))
    write = notify
  return notify && write ? { rx: notify, tx: write } : null
}

export interface BlePortOptions {
  /**
   * If true, show ALL nearby BLE devices in the chooser (plus the UART services
   * as optionalServices). Use when a module advertises a non-standard service so
   * a service-filtered chooser would hide it. Default false (filter to NUS +
   * known UART services for a tidy chooser).
   */
  acceptAllDevices?: boolean
}

export class BlePort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  private device: BluetoothDevice | null = null
  private rxChar: BluetoothRemoteGATTCharacteristic | null = null // NOTIFY: device → host
  private txChar: BluetoothRemoteGATTCharacteristic | null = null // WRITE:  host → device
  private rxController: ReadableStreamDefaultController<Uint8Array> | null = null
  private opened = false
  private onDisconnectCb: (() => void) | null = null

  private readonly onCharNotify = (ev: Event): void => {
    const ch = ev.target as BluetoothRemoteGATTCharacteristic
    const dv = ch.value
    if (!dv || !this.rxController) return
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    if (bytes.length === 0) return
    try {
      // Copy: the DataView is backed by a buffer the platform may reuse.
      this.rxController.enqueue(bytes.slice())
    } catch {
      /* stream closed */
    }
  }

  private readonly onGattDisconnected = (): void => {
    // Surface the unexpected drop (unplug / out of range) to the read loop by
    // closing the readable; GrblConnection's read loop then ends and the
    // controller's onDisconnect runs.
    this.teardownReadable()
    this.onDisconnectCb?.()
  }

  constructor(private readonly opts: BlePortOptions = {}) {}

  /** A human label for the chosen device (after open), for the appbar. */
  get label(): string {
    return this.device?.name?.trim() || 'Bluetooth'
  }

  /** Is Web Bluetooth available in this browser/context? */
  static isSupported(): boolean {
    return getBluetooth() !== null
  }

  /**
   * Best-effort adapter availability via navigator.bluetooth.getAvailability().
   * Returns true/false when known, or null when the API/method is absent — so
   * callers can tell "adapter OFF" apart from "unknown". Consulted AFTER a failed
   * chooser (never before — a pre-flight await would void the tap's user gesture).
   */
  static async availability(): Promise<boolean | null> {
    const bt = getBluetooth()
    if (!bt?.getAvailability) return null
    try {
      return await bt.getAvailability()
    } catch {
      return null
    }
  }

  /**
   * Request a device (must be a user gesture), GATT-connect, locate the UART
   * RX/TX characteristics, and start notifications. `baudRate` is accepted for
   * PortLike parity but ignored (BLE has no baud rate).
   */
  async open(_options: { baudRate: number; [k: string]: unknown }): Promise<void> {
    if (this.opened) throw new Error('BlePort already open')
    const bt = getBluetooth()
    if (!bt) {
      throw new Error(
        'Web Bluetooth is not available — use Chrome/Edge over HTTPS (or localhost), ' +
          'and ensure the OS Bluetooth is on.',
      )
    }

    // Filtered chooser uses the LAYERED filter set (UART services + the common
    // FluidNC/GRBL/HM/JDY name prefixes) so machines that advertise only a name
    // still appear; the accept-all path lists everything for odd advertisers.
    const requestOpts: RequestDeviceOptions = this.opts.acceptAllDevices
      ? { acceptAllDevices: true, optionalServices: OPTIONAL_UART_SERVICES }
      : { filters: REQUEST_FILTERS, optionalServices: OPTIONAL_UART_SERVICES }

    const device = await bt.requestDevice(requestOpts)
    this.device = device
    if (!device.gatt) throw new Error('Selected Bluetooth device has no GATT server.')

    device.addEventListener('gattserverdisconnected', this.onGattDisconnected)

    const server = await device.gatt.connect()
    const { rx, tx } = await this.discoverCharacteristics(server)
    this.rxChar = rx
    this.txChar = tx

    // Wire the readable BEFORE starting notifications so no early bytes are lost.
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.rxController = controller
      },
      cancel: () => {
        this.rxController = null
      },
    })

    this.writable = new WritableStream<Uint8Array>({
      write: (chunk) => this.writeChunked(chunk),
    })

    rx.addEventListener('characteristicvaluechanged', this.onCharNotify)
    await rx.startNotifications()

    this.opened = true
  }

  /** Allow the controller/connection to learn about an unexpected GATT drop. */
  setOnDisconnect(cb: () => void): void {
    this.onDisconnectCb = cb
  }

  async close(): Promise<void> {
    this.opened = false
    const rx = this.rxChar
    const device = this.device
    this.rxChar = null
    this.txChar = null
    this.device = null
    if (rx) {
      rx.removeEventListener('characteristicvaluechanged', this.onCharNotify)
      try {
        await rx.stopNotifications()
      } catch {
        /* device may already be gone */
      }
    }
    if (device) {
      device.removeEventListener('gattserverdisconnected', this.onGattDisconnected)
      try {
        device.gatt?.disconnect()
      } catch {
        /* already disconnected */
      }
    }
    this.teardownReadable()
    this.writable = null
  }

  // --- internals -------------------------------------------------------------

  /**
   * Locate the RX (notify) and TX (write) characteristics. Prefer the NUS pair
   * by exact UUID; otherwise scan each known UART service for a notify
   * characteristic (RX) and a writable one (TX). Some single-characteristic
   * modules (HM-10) expose ONE characteristic that is both notify and write —
   * we then use it for both directions.
   */
  private async discoverCharacteristics(
    server: BluetoothRemoteGATTServer,
  ): Promise<{ rx: BluetoothRemoteGATTCharacteristic; tx: BluetoothRemoteGATTCharacteristic }> {
    // 1) Canonical Nordic UART (NUS) exact pair: device→host notify + host→device write.
    try {
      const svc = await server.getPrimaryService(NUS_SERVICE)
      const rx = await svc.getCharacteristic(NUS_TX_NOTIFY)
      const tx = await svc.getCharacteristic(NUS_RX_WRITE)
      return { rx, tx }
    } catch {
      /* not a NUS device — keep trying */
    }

    // 2) Microchip RN4870/71 transparent-UART exact pair.
    try {
      const svc = await server.getPrimaryService(RN4870_SERVICE)
      const rx = await svc.getCharacteristic(RN4870_TX_NOTIFY)
      const tx = await svc.getCharacteristic(RN4870_RX_WRITE)
      return { rx, tx }
    } catch {
      /* not an RN4870 — fall through to generic discovery */
    }

    // 3) Generic discovery: scan each reachable primary service for a notify +
    //    writable pair (HM-10 / FFE0 / FFF0 modules, incl. single-char HM-10s).
    let services: BluetoothRemoteGATTService[] = []
    try {
      services = await server.getPrimaryServices()
    } catch {
      services = []
    }
    for (const svc of services) {
      const pair = await pickUartPair(svc)
      if (pair) return pair
    }

    throw new Error(BLE_NO_UART_MESSAGE)
  }

  /** Write a chunk, split to ~20-byte frames for the default BLE ATT MTU. */
  private async writeChunked(chunk: Uint8Array): Promise<void> {
    const tx = this.txChar
    if (!tx) return
    const MTU = 20
    for (let off = 0; off < chunk.length; off += MTU) {
      const slice = chunk.subarray(off, Math.min(off + MTU, chunk.length))
      // Send a copy: the source may be a view over a pooled/reused buffer.
      await this.writeOne(tx, slice.slice())
    }
  }

  /** Prefer write-without-response (faster, no ack) when supported. */
  private async writeOne(
    tx: BluetoothRemoteGATTCharacteristic,
    data: Uint8Array,
  ): Promise<void> {
    if (tx.properties.writeWithoutResponse && tx.writeValueWithoutResponse) {
      await tx.writeValueWithoutResponse(data)
    } else if (tx.writeValueWithResponse) {
      await tx.writeValueWithResponse(data)
    } else if (tx.writeValue) {
      await tx.writeValue(data)
    } else {
      throw new Error('BLE TX characteristic is not writable.')
    }
  }

  private teardownReadable(): void {
    try {
      this.rxController?.close()
    } catch {
      /* already closed */
    }
    this.rxController = null
    this.readable = null
  }
}
