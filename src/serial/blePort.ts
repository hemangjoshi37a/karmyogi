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

/**
 * Other BLE-UART services we offer as `optionalServices` so HM-10 / HC-08 /
 * AT-09-style modules (and FluidNC's NimBLE bridge, which also uses NUS) work.
 * For these we auto-discover a notify characteristic (RX from device) and a
 * writable one (TX to device).
 */
const OPTIONAL_UART_SERVICES: BluetoothServiceUUID[] = [
  NUS_SERVICE,
  0xffe0, // HM-10 / HC-08 / AT-09 vendor service
  0xfff0, // common UART-bridge vendor service
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fff0-0000-1000-8000-00805f9b34fb',
]

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

    const requestOpts: RequestDeviceOptions = this.opts.acceptAllDevices
      ? { acceptAllDevices: true, optionalServices: OPTIONAL_UART_SERVICES }
      : {
          filters: [
            { services: [NUS_SERVICE] },
            { services: [0xffe0] },
            { services: [0xfff0] },
          ],
          optionalServices: OPTIONAL_UART_SERVICES,
        }

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
    // 1) Try the canonical NUS pair first.
    try {
      const svc = await server.getPrimaryService(NUS_SERVICE)
      const rx = await svc.getCharacteristic(NUS_TX_NOTIFY) // device→host notify
      const tx = await svc.getCharacteristic(NUS_RX_WRITE) // host→device write
      return { rx, tx }
    } catch {
      /* not a NUS device — fall through to generic discovery */
    }

    // 2) Generic discovery across whatever primary services we can reach.
    let services: BluetoothRemoteGATTService[] = []
    try {
      services = await server.getPrimaryServices()
    } catch {
      services = []
    }

    let notify: BluetoothRemoteGATTCharacteristic | null = null
    let write: BluetoothRemoteGATTCharacteristic | null = null
    for (const svc of services) {
      let chars: BluetoothRemoteGATTCharacteristic[] = []
      try {
        chars = await svc.getCharacteristics()
      } catch {
        continue
      }
      for (const c of chars) {
        const p = c.properties
        if (!notify && (p.notify || p.indicate)) notify = c
        if (!write && (p.write || p.writeWithoutResponse)) write = c
      }
      if (notify && write) break
    }

    // A single characteristic that is both notify and writable (HM-10 style).
    if (!notify && write && (write.properties.notify || write.properties.indicate)) notify = write
    if (!write && notify && (notify.properties.write || notify.properties.writeWithoutResponse))
      write = notify

    if (!notify || !write) {
      throw new Error(
        'No BLE-UART characteristics found on this device (need a notify + a write ' +
          'characteristic). Is this a GRBL Bluetooth-LE serial bridge (e.g. Nordic UART / HM-10)?',
      )
    }
    return { rx: notify, tx: write }
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
