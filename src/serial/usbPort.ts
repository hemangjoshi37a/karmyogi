// UsbPort — a `PortLike` backed by WebUSB (`navigator.usb`), so karmyogi can
// drive a GRBL/Marlin board from an ANDROID phone over a USB-OTG cable, where
// the Web Serial API does not exist but WebUSB does.
//
// Web Serial (desktop Chromium) hands us a ready-made byte stream because the
// OS serial driver talks to the USB-serial bridge chip. On Android there is no
// such driver in the browser's path, so this module IS the driver: it detects
// the bridge chip and speaks its native USB protocol directly:
//
//   - CDC-ACM    (USB class 02/0a) — Arduino Uno/Mega (16u2), Leonardo,
//                                    ESP32-S2/S3 native USB, STM32 VCP, grblHAL
//   - CH340/341  (1a86:7523/5523…) — the ubiquitous cheap Nano / GRBL boards
//   - CP210x     (10c4:ea60…)      — ESP32 / NodeMCU devkits
//   - FTDI       (0403:6001…)      — FT232R / FT231X breakouts
//
// It implements the SAME minimal `PortLike` interface GrblConnection consumes
// (readable/writable byte streams + open/close — see grblConnection.ts), so the
// entire streaming stack (char-counting, status polling, dialects, Marlin's
// 250000 baud) works unchanged over OTG.
//
// Like Web Serial/Web Bluetooth, WebUSB is Chromium-only and needs a secure
// context (HTTPS / localhost) plus a user gesture for requestDevice().

import type { PortLike } from './grblConnection'

// --- Minimal WebUSB typings ---------------------------------------------------
// tsconfig pins `types` to vite/client + w3c-web-serial; @types/w3c-web-usb is
// intentionally not installed, so declare the small slice of the API we use
// (mirrors the W3C WebUSB IDL). These are module-local, so they can't collide
// with lib types.

type USBDirection = 'in' | 'out'
type USBTransferStatus = 'ok' | 'stall' | 'babble'

interface USBEndpoint {
  readonly endpointNumber: number
  readonly direction: USBDirection
  readonly type: 'bulk' | 'interrupt' | 'isochronous'
  readonly packetSize: number
}

interface USBAlternateInterface {
  readonly alternateSetting: number
  readonly interfaceClass: number
  readonly interfaceSubclass: number
  readonly interfaceProtocol: number
  readonly endpoints: USBEndpoint[]
}

interface USBInterface {
  readonly interfaceNumber: number
  readonly alternate: USBAlternateInterface
  readonly alternates: USBAlternateInterface[]
  readonly claimed: boolean
}

interface USBConfiguration {
  readonly configurationValue: number
  readonly interfaces: USBInterface[]
}

interface USBControlTransferParameters {
  requestType: 'standard' | 'class' | 'vendor'
  recipient: 'device' | 'interface' | 'endpoint' | 'other'
  request: number
  value: number
  index: number
}

interface USBInTransferResult {
  readonly data?: DataView
  readonly status?: USBTransferStatus
}

interface USBOutTransferResult {
  readonly bytesWritten: number
  readonly status?: USBTransferStatus
}

interface USBDevice {
  readonly vendorId: number
  readonly productId: number
  readonly productName?: string
  readonly configuration: USBConfiguration | null
  readonly configurations: USBConfiguration[]
  readonly opened: boolean
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  controlTransferIn(
    setup: USBControlTransferParameters,
    length: number,
  ): Promise<USBInTransferResult>
  controlTransferOut(
    setup: USBControlTransferParameters,
    data?: ArrayBuffer | ArrayBufferView,
  ): Promise<USBOutTransferResult>
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>
  transferOut(
    endpointNumber: number,
    data: ArrayBuffer | ArrayBufferView,
  ): Promise<USBOutTransferResult>
  clearHalt(direction: USBDirection, endpointNumber: number): Promise<void>
}

interface USBDeviceFilter {
  vendorId?: number
  productId?: number
  classCode?: number
  subclassCode?: number
  protocolCode?: number
}

interface USBConnectionEvent extends Event {
  readonly device: USBDevice
}

interface USBApi {
  getDevices(): Promise<USBDevice[]>
  requestDevice(options: { filters: USBDeviceFilter[] }): Promise<USBDevice>
  addEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: USBConnectionEvent) => void,
  ): void
  removeEventListener(
    type: 'connect' | 'disconnect',
    listener: (ev: USBConnectionEvent) => void,
  ): void
}

function getUsb(): USBApi | null {
  if (typeof navigator === 'undefined') return null
  const usb = (navigator as unknown as { usb?: USBApi }).usb
  return usb ?? null
}

// --- Chip detection ------------------------------------------------------------

type UsbChip = 'cdc-acm' | 'ch34x' | 'cp210x' | 'ftdi'

const CHIP_LABEL: Record<UsbChip, string> = {
  'cdc-acm': 'USB serial (CDC)',
  ch34x: 'CH340 serial',
  cp210x: 'CP210x serial',
  ftdi: 'FTDI serial',
}

/**
 * Identify a vendor-protocol bridge chip from its USB ids. Anything not listed
 * here is sniffed for CDC-ACM interfaces instead (so e.g. WCH's newer CH9102,
 * which enumerates as a standard CDC device, lands on the CDC driver).
 */
function chipFromIds(vendorId: number, productId: number): UsbChip | null {
  if (vendorId === 0x1a86) {
    // CH340 (7523), CH340K (7522), CH341 (5523)
    if (productId === 0x7523 || productId === 0x7522 || productId === 0x5523) return 'ch34x'
    return null
  }
  if (vendorId === 0x10c4) {
    // CP2102/4 (ea60), CP210x (ea61/ea63), CP2105 (ea70), CP2108 (ea71)
    if (
      productId === 0xea60 ||
      productId === 0xea61 ||
      productId === 0xea63 ||
      productId === 0xea70 ||
      productId === 0xea71
    )
      return 'cp210x'
    return null
  }
  if (vendorId === 0x0403) {
    // FT232R (6001), FT2232 (6010), FT4232 (6011), FT232H (6014), FT231X (6015)
    if (
      productId === 0x6001 ||
      productId === 0x6010 ||
      productId === 0x6011 ||
      productId === 0x6014 ||
      productId === 0x6015
    )
      return 'ftdi'
    return null
  }
  return null
}

function bulkPairOf(
  alt: USBAlternateInterface,
): { epIn: USBEndpoint; epOut: USBEndpoint } | null {
  let epIn: USBEndpoint | null = null
  let epOut: USBEndpoint | null = null
  for (const ep of alt.endpoints) {
    if (ep.type !== 'bulk') continue
    if (ep.direction === 'in' && !epIn) epIn = ep
    if (ep.direction === 'out' && !epOut) epOut = ep
  }
  return epIn && epOut ? { epIn, epOut } : null
}

interface DevicePlan {
  chip: UsbChip
  /** Interface number that class/vendor control requests target. */
  ctrlIface: number
  epIn: USBEndpoint
  epOut: USBEndpoint
  /** Interface numbers to claim (data + separate CDC control, when present). */
  claim: number[]
  /** FTDI only: multi-interface part (FT2232/FT4232) — affects wIndex encoding. */
  multiPort: boolean
}

/**
 * Work out how to drive this device: which chip protocol, which interfaces to
 * claim, and which bulk endpoints carry the data. Returns null when the device
 * has nothing we can use.
 */
function planForDevice(device: USBDevice, config: USBConfiguration): DevicePlan | null {
  const chip = chipFromIds(device.vendorId, device.productId)
  if (chip) {
    // Vendor bridges expose one interface carrying the bulk data pair (plus an
    // interrupt-IN for modem status, which we don't need).
    for (const iface of config.interfaces) {
      const pair = bulkPairOf(iface.alternate)
      if (!pair) continue
      return {
        chip,
        ctrlIface: iface.interfaceNumber,
        epIn: pair.epIn,
        epOut: pair.epOut,
        claim: [iface.interfaceNumber],
        multiPort: chip === 'ftdi' && config.interfaces.length > 1,
      }
    }
    return null
  }

  // CDC-ACM: a class-02 communications interface (the target of the class
  // requests) paired with a class-0a data interface holding the bulk pair.
  // Claim BOTH — WebUSB requires an interface to be claimed before a control
  // transfer may target it.
  let ctrl: number | null = null
  for (const iface of config.interfaces) {
    if (iface.alternate.interfaceClass === 0x02) {
      ctrl = iface.interfaceNumber
      break
    }
  }
  for (const iface of config.interfaces) {
    if (iface.alternate.interfaceClass !== 0x0a) continue
    const pair = bulkPairOf(iface.alternate)
    if (!pair) continue
    const ctrlIface = ctrl ?? iface.interfaceNumber
    const claim =
      ctrlIface === iface.interfaceNumber
        ? [iface.interfaceNumber]
        : [ctrlIface, iface.interfaceNumber]
    return { chip: 'cdc-acm', ctrlIface, epIn: pair.epIn, epOut: pair.epOut, claim, multiPort: false }
  }

  // Last resort: ANY interface with a bulk in+out pair, driven CDC-style (the
  // CDC init tolerates stalls) — covers oddball vendor-class serial bridges.
  for (const iface of config.interfaces) {
    const pair = bulkPairOf(iface.alternate)
    if (!pair) continue
    return {
      chip: 'cdc-acm',
      ctrlIface: iface.interfaceNumber,
      epIn: pair.epIn,
      epOut: pair.epOut,
      claim: [iface.interfaceNumber],
      multiPort: false,
    }
  }
  return null
}

/** Could we plausibly drive this (already-authorized) device? */
function looksSupported(device: USBDevice): boolean {
  if (chipFromIds(device.vendorId, device.productId)) return true
  for (const config of device.configurations) {
    for (const iface of config.interfaces) {
      const alt = iface.alternate
      if (alt.interfaceClass === 0x02 || alt.interfaceClass === 0x0a) return true
      if (bulkPairOf(alt)) return true
    }
  }
  return false
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

/**
 * FTDI SET_BAUDRATE encoding. The UART clocks from a 3MHz reference (48MHz/16)
 * with a divisor whose fractional part is in EIGHTHS: divisor×8 = round(24e6 /
 * baud). The integer part fills wValue bits 13..0; the fraction is encoded into
 * wValue bits 15..14 plus one extra bit carried in wIndex (table from FTDI's
 * app note, as used by linux ftdi_sio / usb-serial-for-android). Divisors 0 and
 * 1 are special-cased to 3M / 2M baud. Handles arbitrary rates incl. 250000.
 */
function ftdiBaudParams(baud: number, multiPort: boolean): { value: number; index: number } {
  let value: number
  let fracIndexBit: number
  if (baud >= 2500000) {
    value = 0 // divisor 0 → 3,000,000 baud
    fracIndexBit = 0
  } else if (baud >= 1750000) {
    value = 1 // divisor 1 → 2,000,000 baud
    fracIndexBit = 0
  } else {
    let divisor8 = Math.floor(48000000 / baud)
    divisor8 = (divisor8 + 1) >> 1 // = round(24e6 / baud)
    const sub = divisor8 & 7
    const div = divisor8 >> 3
    if (div > 0x3fff || div < 1) {
      throw new Error(`FTDI: baud rate ${baud} is out of range for this chip.`)
    }
    // sub-eighth → (wValue bits 15..14, wIndex bit) per the FTDI encoding table.
    const FRAC_VALUE = [0x0000, 0xc000, 0x8000, 0x0000, 0x4000, 0x4000, 0x8000, 0xc000]
    const FRAC_INDEX = [0, 0, 0, 1, 0, 1, 1, 1]
    value = (div & 0x3fff) | FRAC_VALUE[sub]
    fracIndexBit = FRAC_INDEX[sub]
  }
  // Multi-interface parts (FT2232/FT4232) put the port number (A=1) in the low
  // byte of wIndex and shift the fractional bit up; single-port parts use the
  // bit directly (their port field is ignored).
  const index = multiPort ? (fracIndexBit << 8) | 1 : fracIndexBit
  return { value, index }
}

// --- The port -------------------------------------------------------------------

export class UsbPort implements PortLike {
  readable: ReadableStream<Uint8Array> | null = null
  writable: WritableStream<Uint8Array> | null = null

  private chip: UsbChip | null = null
  private ctrlIface = 0
  private epIn = 0
  private epOut = 0
  private epInSize = 64
  private epOutSize = 64
  private ftdiMultiPort = false
  private claimed: number[] = []
  private opened = false
  private closing = false
  private rxController: ReadableStreamDefaultController<Uint8Array> | null = null
  private pumpPromise: Promise<void> | null = null
  private onDisconnectCb: (() => void) | null = null

  private readonly onUsbDisconnect = (ev: USBConnectionEvent): void => {
    if (ev.device !== this.device) return
    // Error the readable so GrblConnection's read loop ends and the controller's
    // disconnect teardown runs (the in-flight transferIn also rejects).
    this.errorReadable(new Error('USB device disconnected — was the OTG cable unplugged?'))
    this.onDisconnectCb?.()
  }

  constructor(private readonly device: USBDevice) {}

  /** Is WebUSB available in this browser/context? */
  static isSupported(): boolean {
    return getUsb() !== null
  }

  /**
   * Show the browser's USB device chooser (must be a user gesture) filtered to
   * devices we can drive: any CDC-class device plus the known bridge-chip
   * vendors. The actual interface sniffing happens at open().
   */
  static async request(): Promise<UsbPort> {
    const usb = getUsb()
    if (!usb) {
      throw new Error(
        'WebUSB is not available — use Chrome/Edge (Android or desktop) over HTTPS or localhost.',
      )
    }
    const device = await usb.requestDevice({
      filters: [
        { classCode: 0x02 }, // CDC — matches the device class OR any interface class
        { vendorId: 0x1a86 }, // WCH CH340/CH341 (CH9102 sniffs as CDC)
        { vendorId: 0x10c4 }, // Silicon Labs CP210x
        { vendorId: 0x0403 }, // FTDI
      ],
    })
    return new UsbPort(device)
  }

  /**
   * Find a previously-authorized, driveable device for silent reconnect on app
   * load (Chrome persists WebUSB grants per origin — no gesture needed for
   * getDevices()). Prefers a vendor/product match with `pref` (the controller's
   * remembered last port), else the first usable device. Null when none.
   */
  static async findAuthorized(pref?: {
    usbVendorId?: number
    usbProductId?: number
  }): Promise<UsbPort | null> {
    const usb = getUsb()
    if (!usb) return null
    let devices: USBDevice[] = []
    try {
      devices = await usb.getDevices()
    } catch {
      return null
    }
    const usable = devices.filter(looksSupported)
    if (usable.length === 0) return null
    const preferred =
      pref &&
      usable.find((d) => d.vendorId === pref.usbVendorId && d.productId === pref.usbProductId)
    return new UsbPort(preferred || usable[0])
  }

  /** A human label for the device (product name, else chip name), for the appbar. */
  get label(): string {
    const name = this.device.productName?.trim()
    if (name) return name
    return this.chip ? CHIP_LABEL[this.chip] : 'USB serial'
  }

  /**
   * Mirrors `SerialPort.getInfo()` so the controller's preferred-port
   * persistence (savePreferredPort / autoConnect matching) works for WebUSB too.
   */
  getInfo(): { usbVendorId: number; usbProductId: number } {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId }
  }

  /** Learn about an unexpected unplug (parallels BlePort.setOnDisconnect). */
  setOnDisconnect(cb: () => void): void {
    this.onDisconnectCb = cb
  }

  /**
   * Open the device, claim its interfaces, run the chip-specific init at
   * `baudRate` (8N1, DTR+RTS asserted), and start the read pump.
   */
  async open(options: { baudRate: number; [k: string]: unknown }): Promise<void> {
    if (this.opened) throw new Error('UsbPort already open')
    this.closing = false
    const baud =
      Number.isFinite(options.baudRate) && options.baudRate > 0
        ? Math.floor(options.baudRate)
        : 115200
    const device = this.device
    await device.open()
    try {
      if (!device.configuration) {
        const cfg = device.configurations[0]
        if (!cfg) throw new Error('USB device exposes no configurations.')
        await device.selectConfiguration(cfg.configurationValue)
      }
      const config = device.configuration
      if (!config) throw new Error('Could not select a USB configuration.')
      const plan = planForDevice(device, config)
      if (!plan) {
        throw new Error(
          `Unsupported USB-serial adapter (${hex4(device.vendorId)}:${hex4(device.productId)}) — ` +
            'supported bridges: CDC-ACM, CH340/CH341, CP210x, FTDI.',
        )
      }
      this.chip = plan.chip
      this.ctrlIface = plan.ctrlIface
      this.epIn = plan.epIn.endpointNumber
      this.epOut = plan.epOut.endpointNumber
      this.epInSize = plan.epIn.packetSize || 64
      this.epOutSize = plan.epOut.packetSize || 64
      this.ftdiMultiPort = plan.multiPort
      await this.claimAll(plan.claim)
      await this.initChip(baud)

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
      getUsb()?.addEventListener('disconnect', this.onUsbDisconnect)
      this.pumpPromise = this.pumpIn()
      this.opened = true
    } catch (err) {
      this.claimed = []
      try {
        await device.close()
      } catch {
        /* already closed / unplugged */
      }
      throw err
    }
  }

  async close(): Promise<void> {
    this.closing = true
    this.opened = false
    getUsb()?.removeEventListener('disconnect', this.onUsbDisconnect)
    const device = this.device
    if (device.opened) {
      // Best-effort clean hang-up: drop DTR/RTS like an OS serial driver would.
      try {
        await this.deassertLines()
      } catch {
        /* device may already be gone */
      }
      // Releasing the data interface aborts the pump's pending transferIn.
      for (const n of this.claimed) {
        try {
          await device.releaseInterface(n)
        } catch {
          /* ignore */
        }
      }
      try {
        await device.close()
      } catch {
        /* ignore */
      }
    }
    this.claimed = []
    try {
      await this.pumpPromise
    } catch {
      /* the pump exits on the aborted transfer */
    }
    this.pumpPromise = null
    try {
      this.rxController?.close()
    } catch {
      /* already closed/errored */
    }
    this.rxController = null
    this.readable = null
    this.writable = null
  }

  // --- internals -----------------------------------------------------------------

  private async claimAll(ifaces: number[]): Promise<void> {
    for (const n of ifaces) {
      try {
        await this.device.claimInterface(n)
        this.claimed.push(n)
      } catch (err) {
        // Android: the OS or another app (a serial-terminal app, an IDE) may be
        // holding the interface; desktop Chromium refuses interfaces bound to a
        // kernel driver. Either way the fix is on the user's side — say so.
        const detail = err instanceof Error ? err.message : String(err)
        throw new Error(
          'USB interface busy — the system or another app is using this device. ' +
            'Unplug/replug it and close other apps that talk to it, then try again. ' +
            `(${detail})`,
        )
      }
    }
  }

  /**
   * Continuously read the bulk-IN endpoint into the readable stream. Requests
   * EXACTLY one max-packet per transfer: a bulk transfer only completes early on
   * a SHORT packet, so asking for more would let a full-sized packet (e.g. a
   * 64-byte burst of `ok`s) sit inside the transfer until the NEXT short packet
   * arrived — latency the char-counting streamer would feel. One packet per
   * transferIn delivers every byte immediately.
   */
  private async pumpIn(): Promise<void> {
    const device = this.device
    const size = this.epInSize
    while (!this.closing) {
      let result: USBInTransferResult
      try {
        result = await device.transferIn(this.epIn, size)
      } catch (err) {
        if (!this.closing) {
          this.errorReadable(err instanceof Error ? err : new Error(String(err)))
        }
        return
      }
      if (result.status === 'stall') {
        // A stalled bulk endpoint stays stalled until the halt is cleared.
        try {
          await device.clearHalt('in', this.epIn)
          continue
        } catch (err) {
          if (!this.closing) {
            this.errorReadable(err instanceof Error ? err : new Error(String(err)))
          }
          return
        }
      }
      const dv = result.data
      if (!dv || dv.byteLength === 0) continue
      let bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
      // FTDI prefixes EVERY in-packet with 2 modem-status bytes (and emits a
      // status-only 2-byte packet each latency-timer tick) — strip them.
      if (this.chip === 'ftdi') bytes = bytes.subarray(2)
      if (bytes.length === 0) continue
      try {
        // Copy: the DataView's buffer belongs to the platform transfer result.
        this.rxController?.enqueue(bytes.slice())
      } catch {
        /* stream closed */
      }
    }
  }

  private errorReadable(err: Error): void {
    try {
      this.rxController?.error(err)
    } catch {
      /* already closed/errored */
    }
    this.rxController = null
  }

  /** Write a chunk, split to the OUT endpoint's max packet size. */
  private async writeChunked(chunk: Uint8Array): Promise<void> {
    const device = this.device
    const max = this.epOutSize
    for (let off = 0; off < chunk.length; off += max) {
      // Copy: the source may be a view over a pooled/reused buffer.
      const slice = chunk.slice(off, Math.min(off + max, chunk.length))
      let res = await device.transferOut(this.epOut, slice)
      if (res.status === 'stall') {
        await device.clearHalt('out', this.epOut)
        res = await device.transferOut(this.epOut, slice)
        if (res.status !== 'ok') throw new Error('USB write failed (endpoint stalled).')
      }
    }
  }

  // --- chip drivers ----------------------------------------------------------------

  private async initChip(baud: number): Promise<void> {
    switch (this.chip) {
      case 'cdc-acm':
        return this.initCdc(baud)
      case 'ch34x':
        return this.initCh34x(baud)
      case 'cp210x':
        return this.initCp210x(baud)
      case 'ftdi':
        return this.initFtdi(baud)
      default:
        throw new Error('USB bridge chip type was not detected.')
    }
  }

  private async deassertLines(): Promise<void> {
    switch (this.chip) {
      case 'cdc-acm':
        await this.cdcControlLineState(false, false)
        return
      case 'ch34x':
        await this.ch34xSetHandshake(false, false)
        return
      case 'cp210x':
        // SET_MHS: mask DTR+RTS writable (0x0300), both values 0 → de-asserted.
        await this.cpOut(0x07, 0x0300)
        return
      case 'ftdi':
        await this.ftdiOut(0x01, 0x0100, 1) // MODEM_CTRL: DTR low (mask only)
        await this.ftdiOut(0x01, 0x0200, 1) // MODEM_CTRL: RTS low (mask only)
        return
      default:
        return
    }
  }

  // CDC-ACM (USB class 02/0a) ---------------------------------------------------

  private async initCdc(baud: number): Promise<void> {
    // SET_LINE_CODING (0x20): dwDTERate LE32 + 1 stop bit + no parity + 8 data
    // bits. Real bridges (Uno's 16u2, STM32 VCP) program their UART from it;
    // native-USB CDC stacks (Leonardo, ESP32-S2/S3) may ignore or even stall it
    // — their "serial" is USB-native with no physical baud — so tolerate failure.
    const coding = new Uint8Array(7)
    new DataView(coding.buffer).setUint32(0, baud, true)
    coding[4] = 0 // bCharFormat: 1 stop bit
    coding[5] = 0 // bParityType: none
    coding[6] = 8 // bDataBits: 8
    try {
      await this.device.controlTransferOut(
        { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: this.ctrlIface },
        coding,
      )
    } catch {
      /* optional on native-USB CDC */
    }
    // SET_CONTROL_LINE_STATE: many boards only start sending once DTR asserts
    // (and Arduinos auto-reset on its edge — same as desktop serial monitors).
    try {
      await this.cdcControlLineState(true, true)
    } catch {
      /* some minimal CDC stacks don't implement it */
    }
  }

  private async cdcControlLineState(dtr: boolean, rts: boolean): Promise<void> {
    const value = (dtr ? 0x01 : 0) | (rts ? 0x02 : 0)
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: 0x22,
      value,
      index: this.ctrlIface,
    })
  }

  // CH340 / CH341 (WCH vendor protocol) ------------------------------------------

  private ch34xOut(request: number, value: number, index: number): Promise<USBOutTransferResult> {
    return this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index,
    })
  }

  private ch34xIn(
    request: number,
    value: number,
    index: number,
    length: number,
  ): Promise<USBInTransferResult> {
    return this.device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request, value, index },
      length,
    )
  }

  private async initCh34x(baud: number): Promise<void> {
    // Init sequence from the proven open-source drivers (linux ch341.c /
    // usb-serial-for-android Ch34xSerialDriver). WCH never documented these
    // registers — the magic constants are load-bearing; don't "clean them up".
    await this.ch34xIn(0x5f, 0, 0, 2) // probe chip version/status
    await this.ch34xOut(0xa1, 0, 0) // serial-engine init
    await this.ch34xSetBaud(baud)
    await this.ch34xIn(0x95, 0x2518, 0, 2) // read LCR block
    // LCR = enable RX (0x80) | enable TX (0x40) | 8 data bits (0x03);
    // no parity bit, 1 stop bit → 8N1.
    await this.ch34xOut(0x9a, 0x2518, 0x00c3)
    await this.ch34xIn(0x95, 0x0706, 0, 2) // read modem status
    await this.ch34xOut(0xa1, 0x501f, 0xd90a) // finish init (vendor magic pair)
    await this.ch34xSetBaud(baud) // re-assert baud post-init, as the drivers do
    await this.ch34xSetHandshake(true, true)
  }

  private async ch34xSetBaud(baud: number): Promise<void> {
    // The CH34x clocks its UART from 48MHz through a 3-stage ÷8 prescaler:
    // factor = 1532620800 / baud, shifted right 3 bits (dropping a prescaler
    // stage) until it fits 16 bits; the register takes 0x10000 - factor. This
    // reaches ANY rate the silicon can — 115200 and Marlin's 250000 included.
    let factor: number
    let divisor: number
    if (baud === 921600) {
      // Known silicon quirk: 921600 needs this exact magic pair.
      divisor = 7
      factor = 0xf300
    } else {
      factor = Math.floor(1532620800 / baud)
      divisor = 3
      while (factor > 0xfff0 && divisor > 0) {
        factor >>= 3
        divisor--
      }
      if (factor > 0xfff0) throw new Error(`CH340: baud rate ${baud} is not reachable.`)
      factor = 0x10000 - factor
    }
    // 0x0080: transmit immediately instead of waiting for the internal buffer
    // to fill (without it the chip batches RX into laggy chunks).
    divisor |= 0x0080
    await this.ch34xOut(0x9a, 0x1312, ((factor & 0xff00) | divisor) & 0xffff)
    await this.ch34xOut(0x9a, 0x0f2c, factor & 0xff)
  }

  private async ch34xSetHandshake(dtr: boolean, rts: boolean): Promise<void> {
    // Request 0xa4 takes ACTIVE-LOW modem bits: 0x20 = DTR, 0x40 = RTS.
    const bits = (dtr ? 0x20 : 0) | (rts ? 0x40 : 0)
    await this.ch34xOut(0xa4, ~bits & 0xffff, 0)
  }

  // CP210x (Silicon Labs vendor protocol) ------------------------------------------

  private cpOut(
    request: number,
    value: number,
    data?: Uint8Array,
  ): Promise<USBOutTransferResult> {
    // CP210x vendor requests target the INTERFACE (wIndex = interface number,
    // which doubles as the port number on multi-port CP2105/CP2108).
    return this.device.controlTransferOut(
      { requestType: 'vendor', recipient: 'interface', request, value, index: this.ctrlIface },
      data,
    )
  }

  private async initCp210x(baud: number): Promise<void> {
    await this.cpOut(0x00, 0x0001) // IFC_ENABLE: power up the UART
    // SET_BAUDRATE (0x1e): 32-bit little-endian rate in the data stage — the
    // chip picks its closest divisor, so arbitrary values (250000) just work.
    const rate = new Uint8Array(4)
    new DataView(rate.buffer).setUint32(0, baud, true)
    await this.cpOut(0x1e, 0, rate)
    // SET_LINE_CTL: data bits in the high nibble-byte (8 << 8), parity (0) in
    // bits 7..4, stop bits (0 = 1 stop) in bits 3..0 → 0x0800 = 8N1.
    await this.cpOut(0x03, 0x0800)
    // SET_MHS: low byte = line states (DTR 0x01 | RTS 0x02), high byte = which
    // of them to write (mask) → 0x0303 asserts both.
    await this.cpOut(0x07, 0x0303)
  }

  // FTDI (FT232R / FT231X / FT2232 …) -----------------------------------------------

  private ftdiOut(request: number, value: number, index: number): Promise<USBOutTransferResult> {
    return this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index,
    })
  }

  private async initFtdi(baud: number): Promise<void> {
    // wIndex = port number (A = 1) for everything but SET_BAUDRATE, whose index
    // also carries the fractional-divisor bit (see ftdiBaudParams). Single-port
    // chips ignore the port field, so 1 is safe everywhere.
    const port = 1
    await this.ftdiOut(0x00, 0x0000, port) // SIO_RESET: purge buffers, reset state
    await this.ftdiOut(0x04, 0x0008, port) // SET_DATA: 8 data bits, no parity, 1 stop
    const { value, index } = ftdiBaudParams(baud, this.ftdiMultiPort)
    await this.ftdiOut(0x03, value, index) // SET_BAUD_RATE
    await this.ftdiOut(0x01, 0x0101, port) // MODEM_CTRL: assert DTR (mask 0x01 << 8)
    await this.ftdiOut(0x01, 0x0202, port) // MODEM_CTRL: assert RTS (mask 0x02 << 8)
    // Latency timer → 1ms: the chip otherwise holds RX up to 16ms before
    // flushing a non-full packet, which jogging / 5Hz status polling would feel.
    await this.ftdiOut(0x09, 1, port)
  }
}
