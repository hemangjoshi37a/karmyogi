// portScan.ts — auto-discover and PROBE the serial ports the user already
// granted, so the Machine Farm can self-populate with named, port-labeled
// entries (firmware + USB-chip) without the operator re-picking devices.
//
// ─── WEB SERIAL LIMITATIONS THIS MODULE WORKS WITHIN (read me first) ──────────
// The Web Serial API is deliberately privacy-restrictive. Two consequences shape
// this whole design:
//
//  1. There is NO blanket "grant all serial/USB ports" permission. The browser
//     only ever exposes a port the user EXPLICITLY picked once via
//     `navigator.serial.requestPort()` (which requires a user gesture + the
//     native chooser). After that one-time grant, `navigator.serial.getPorts()`
//     returns those ports on EVERY page load with NO further prompt — so we can
//     silently re-scan + probe them automatically. The practical UX therefore is:
//     the user clicks "Add port…" ONCE per physical device; thereafter "Scan"
//     (and the auto-scan on load) is fully automatic and prompt-free.
//
//  2. `port.getInfo()` exposes ONLY `{ usbVendorId, usbProductId }` (numbers).
//     It does NOT expose the OS device path (ttyUSB0 / COM3 / cu.usbserial-…).
//     So a per-port LABEL can only be built from the USB vendor:product id,
//     mapped to a friendly bridge-chip name where we know it (CH340, FTDI,
//     CP210x, Arduino, STM32-VCP, …) plus whatever firmware we detect by probing.
//     Unknown ids fall back to "USB vvvv:pppp".
//
// Probing is done SEQUENTIALLY (one port open at a time) and every probed port is
// ALWAYS closed in a `finally` so it stays available for a real connection right
// after. The currently-active connection's port is NEVER probed (that would tear
// down a live link), which the caller enforces by passing `skipActive`.

import { grbl } from './controller'

export type DetectedFirmware =
  | 'grbl'
  | 'grblhal'
  | 'fluidnc'
  | 'marlin'
  | 'smoothie'
  | 'unknown'

export interface PortUsbInfo {
  vendorId?: number
  productId?: number
}

export interface ScannedPort {
  /** The live SerialPort handle (already granted) — pass to a real connect. */
  port: SerialPort
  info: PortUsbInfo
  /** Friendly USB bridge-chip name (e.g. "CH340", "FTDI FT232", "Arduino"). */
  chip: string
  /** Firmware classified from the probe, or 'unknown' if nothing answered. */
  firmware: DetectedFirmware
  /** Firmware version string if one was reported (e.g. "1.1h", "3.7.6"). */
  version?: string
  /** Composed human label, e.g. "GRBL · CH340 (1A86:7523)". */
  label: string
}

// ─── USB vendor:product → friendly chip / board name ─────────────────────────
// Only `{usbVendorId, usbProductId}` is available (no OS path), so this map is
// the ONLY way to give a port a meaningful name. Common hobby-CNC bridge chips
// and board vendors are listed; anything else falls back to "USB vvvv:pppp".

interface ChipMatch {
  /** Exact vendor:product match, or vendor-only when productId is omitted. */
  vendorId: number
  productId?: number
  name: string
}

const CHIP_TABLE: ChipMatch[] = [
  // WCH CH340 / CH341 — the ubiquitous cheap Nano / GRBL-board bridge.
  { vendorId: 0x1a86, productId: 0x7523, name: 'CH340' },
  { vendorId: 0x1a86, productId: 0x7522, name: 'CH340K' },
  { vendorId: 0x1a86, productId: 0x5523, name: 'CH341' },
  { vendorId: 0x1a86, productId: 0x55d4, name: 'CH9102' },
  { vendorId: 0x1a86, name: 'WCH serial' }, // vendor fallback
  // FTDI.
  { vendorId: 0x0403, productId: 0x6001, name: 'FTDI FT232' },
  { vendorId: 0x0403, productId: 0x6010, name: 'FTDI FT2232' },
  { vendorId: 0x0403, productId: 0x6011, name: 'FTDI FT4232' },
  { vendorId: 0x0403, productId: 0x6014, name: 'FTDI FT232H' },
  { vendorId: 0x0403, productId: 0x6015, name: 'FTDI FT231X' },
  { vendorId: 0x0403, name: 'FTDI serial' }, // vendor fallback
  // Silicon Labs CP210x.
  { vendorId: 0x10c4, productId: 0xea60, name: 'CP2102' },
  { vendorId: 0x10c4, productId: 0xea70, name: 'CP2105' },
  { vendorId: 0x10c4, productId: 0xea71, name: 'CP2108' },
  { vendorId: 0x10c4, name: 'CP210x' }, // vendor fallback
  // Prolific PL2303.
  { vendorId: 0x067b, productId: 0x2303, name: 'PL2303' },
  { vendorId: 0x067b, name: 'Prolific serial' },
  // Arduino (genuine) — 16u2 ACM bridges + native-USB boards.
  { vendorId: 0x2341, productId: 0x0043, name: 'Arduino Uno' },
  { vendorId: 0x2341, productId: 0x0042, name: 'Arduino Mega' },
  { vendorId: 0x2341, productId: 0x8036, name: 'Arduino Leonardo' },
  { vendorId: 0x2341, name: 'Arduino' }, // vendor fallback
  { vendorId: 0x2a03, name: 'Arduino (arduino.org)' },
  // STMicroelectronics — STM32 Virtual COM Port (grblHAL / FluidNC on STM32).
  { vendorId: 0x0483, productId: 0x5740, name: 'STM32 VCP' },
  { vendorId: 0x0483, name: 'STMicro serial' },
  // Espressif native USB (ESP32-S2/S3 — FluidNC).
  { vendorId: 0x303a, name: 'Espressif USB' },
  // Raspberry Pi Pico / RP2040 CDC (some grblHAL builds).
  { vendorId: 0x2e8a, name: 'RP2040 USB' },
]

/** Map a vendor:product id to a friendly chip/board name, else null. */
function chipNameFor(vendorId?: number, productId?: number): string | null {
  if (vendorId == null) return null
  // Prefer an exact vendor:product row, then a vendor-only fallback row.
  const exact = CHIP_TABLE.find(
    (c) => c.vendorId === vendorId && c.productId != null && c.productId === productId,
  )
  if (exact) return exact.name
  const vendor = CHIP_TABLE.find((c) => c.vendorId === vendorId && c.productId == null)
  return vendor ? vendor.name : null
}

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

/** "1A86:7523" or "—" when ids are unavailable (e.g. some Bluetooth ports). */
function idString(vendorId?: number, productId?: number): string {
  if (vendorId == null || productId == null) return '—'
  return `${hex4(vendorId)}:${hex4(productId)}`
}

/** Human chip label: friendly name when known, else "USB vvvv:pppp". */
function chipLabel(vendorId?: number, productId?: number): string {
  const friendly = chipNameFor(vendorId, productId)
  if (friendly) return friendly
  if (vendorId != null && productId != null) return `USB ${idString(vendorId, productId)}`
  return 'Serial'
}

const FW_LABEL: Record<DetectedFirmware, string> = {
  grbl: 'GRBL',
  grblhal: 'grblHAL',
  fluidnc: 'FluidNC',
  marlin: 'Marlin',
  smoothie: 'Smoothie',
  unknown: 'Unknown',
}

/** Compose the port label, e.g. "GRBL · CH340 (1A86:7523)". */
function composeLabel(fw: DetectedFirmware, chip: string, info: PortUsbInfo): string {
  const ids = idString(info.vendorId, info.productId)
  const fwPart = FW_LABEL[fw]
  return ids === '—' ? `${fwPart} · ${chip}` : `${fwPart} · ${chip} (${ids})`
}

// ─── Probe ────────────────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 1200
// GRBL family answers `$I`/`$$`/`?`; Marlin/Smoothie answer `M115`. Send both so
// one bounded read window classifies any of them. `\r\n` framing satisfies both.
const PROBE_QUERY = '\r\n$I\r\n$$\r\nM115\r\n?\r\n'

interface ProbeResult {
  firmware: DetectedFirmware
  version?: string
}

/**
 * Classify firmware from a blob of response text accumulated during the probe.
 * Heuristics, in priority order:
 *   • `[VER:…]` / `[OPT:…]`  → GRBL family. `[OPT:…HAL…]` or a "grblHAL" banner
 *     narrows it to grblHAL; `[MSG:… FluidNC …]` / a "FluidNC" banner → FluidNC.
 *   • a "Grbl X.Xx" welcome banner → GRBL, with the version captured.
 *   • `FIRMWARE_NAME:Marlin` (from M115) → Marlin.
 *   • "Smoothie" anywhere → Smoothie.
 * Returns 'unknown' when nothing matched (no/garbled response).
 */
function classify(text: string): ProbeResult {
  const lower = text.toLowerCase()

  // FluidNC identifies itself in [MSG:…] lines and a banner; it's GRBL-family but
  // we name it specifically. Check before the generic GRBL branch.
  if (lower.includes('fluidnc')) {
    const m = text.match(/FluidNC\s+v?([\w.\-]+)/i)
    return { firmware: 'fluidnc', version: m?.[1] }
  }

  // grblHAL: either an explicit banner or HAL noted in the option report.
  if (lower.includes('grblhal')) {
    const m = text.match(/grblHAL[^\d]*([\d.]+\w?)/i) || text.match(/\[VER:([^\]]+)\]/i)
    return { firmware: 'grblhal', version: extractVersion(m?.[1]) }
  }

  // GRBL family signature: the version / option reports, or the welcome banner.
  const ver = text.match(/\[VER:([^\]]+)\]/i)
  const opt = text.match(/\[OPT:([^\]]+)\]/i)
  const banner = text.match(/Grbl\s+([\d.]+\w?)/i)
  if (ver || opt || banner) {
    // `[OPT:…]` can flag a HAL build even without an explicit banner.
    if (opt && /hal/i.test(opt[1])) {
      return { firmware: 'grblhal', version: extractVersion(ver?.[1]) ?? banner?.[1] }
    }
    return { firmware: 'grbl', version: banner?.[1] ?? extractVersion(ver?.[1]) }
  }

  // Marlin / RepRap: M115 → `FIRMWARE_NAME:Marlin 2.x.x`.
  if (/firmware_name:\s*marlin/i.test(text)) {
    const m = text.match(/FIRMWARE_NAME:\s*Marlin\s*([\w.\-]+)?/i)
    return { firmware: 'marlin', version: m?.[1] }
  }
  // Smoothieware also answers M115 with FIRMWARE_NAME:Smoothie, or banners "Smoothie".
  if (lower.includes('smoothie')) {
    const m = text.match(/Smoothie[^\d]*([\d.]+\w?)/i)
    return { firmware: 'smoothie', version: m?.[1] }
  }

  return { firmware: 'unknown' }
}

/** Pull a leading "1.1h"-style version token out of a `[VER:…]` payload. */
function extractVersion(verPayload?: string): string | undefined {
  if (!verPayload) return undefined
  const m = verPayload.match(/^[\s]*([\d]+\.[\d]+\w?)/)
  return m?.[1]
}

/**
 * Probe a single (granted, NOT-active) serial port for its firmware. Opens the
 * port, writes a multi-firmware query, reads lines for a bounded window, then
 * ALWAYS closes/releases reader+writer+port in `finally` so the port is left
 * usable for a real connection. Robust to a port that never answers (returns
 * 'unknown'), to ports already opened elsewhere, and to open() rejection.
 */
export async function probePort(port: SerialPort): Promise<ProbeResult> {
  // Try 115200 first (GRBL/grblHAL/FluidNC default). If a non-error open yields
  // no firmware, retry once at 250000 for Marlin boards that use that rate.
  const first = await probeAtBaud(port, 115200)
  if (first.firmware !== 'unknown') return first
  // Only worth a second pass if the port opened cleanly the first time; a port
  // that threw on open at 115200 will throw again, so skip to keep this fast.
  if (first.opened) {
    const second = await probeAtBaud(port, 250000)
    if (second.firmware !== 'unknown') return second
  }
  return { firmware: first.firmware, version: first.version }
}

interface BaudProbeResult extends ProbeResult {
  /** True when the port actually opened (vs. throwing) — gates the retry baud. */
  opened: boolean
}

async function probeAtBaud(port: SerialPort, baudRate: number): Promise<BaudProbeResult> {
  let opened = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    await port.open({ baudRate })
    opened = true
    if (!port.writable || !port.readable) return { firmware: 'unknown', opened }
    writer = port.writable.getWriter()
    reader = port.readable.getReader()

    await writer.write(new TextEncoder().encode(PROBE_QUERY))

    const decoder = new TextDecoder()
    let buf = ''
    let done = false
    // Hard time bound: cancel the in-flight read so the loop can't hang on a
    // silent port. Cancelling the reader makes the pending read() resolve.
    timer = setTimeout(() => {
      done = true
      reader?.cancel().catch(() => {})
    }, PROBE_TIMEOUT_MS)

    while (!done) {
      const { value, done: streamDone } = await reader.read()
      if (streamDone) break
      if (value && value.length) {
        buf += decoder.decode(value, { stream: true })
        // Short-circuit as soon as a confident signature appears, to free the
        // port faster than the full timeout.
        const early = classify(buf)
        if (early.firmware !== 'unknown') {
          return { ...early, opened }
        }
      }
    }
    return { ...classify(buf), opened }
  } catch {
    // Open/read/write can reject if the port is busy, was unplugged, or the OS
    // refuses it. Treat as "couldn't identify" — never throw out of a probe.
    return { firmware: 'unknown', opened }
  } finally {
    if (timer) clearTimeout(timer)
    // Release the reader/writer locks BEFORE closing, or close() rejects.
    try {
      await reader?.cancel()
    } catch {
      /* ignore */
    }
    try {
      reader?.releaseLock()
    } catch {
      /* ignore */
    }
    try {
      await writer?.close()
    } catch {
      /* ignore */
    }
    try {
      writer?.releaseLock()
    } catch {
      /* ignore */
    }
    try {
      await port.close()
    } catch {
      /* ignore — leaving it for a real connect */
    }
  }
}

// ─── Scan ───────────────────────────────────────────────────────────────────

/** Is Web Serial available in this browser/context? */
export function isSerialScanSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.serial
}

/**
 * Prompt the user to grant a NEW serial port (must be a user gesture — opens the
 * browser's native chooser). Returns the chosen port, or null if the chooser was
 * dismissed. This is the ONE place a prompt is needed; subsequent scans are
 * silent. Honors the Web Serial reality that there is no "grant all" permission.
 */
export async function requestPort(): Promise<SerialPort | null> {
  if (!isSerialScanSupported()) return null
  try {
    return await navigator.serial.requestPort()
  } catch {
    // AbortError/NotFoundError = the user dismissed the chooser — not an error.
    return null
  }
}

/**
 * Scan every ALREADY-GRANTED serial port and probe each (skipping the currently-
 * active connection's port — probing it would tear down a live link). Probes run
 * SEQUENTIALLY (one open at a time) so two probes never fight over the same OS
 * resource. Returns one descriptor per granted port. Safe to call on load with
 * no grants (returns []), and when Web Serial is unavailable (returns []).
 *
 * NOTE on skipping the active port: the controller does not expose its raw
 * SerialPort handle, so we identify the active port by its USB vendor:product id
 * (the only stable identifier Web Serial gives us) when a real serial connection
 * is live. Mock / WebSocket / BLE connections have no SerialPort, so nothing is
 * skipped for them.
 */
export async function scanGrantedPorts(): Promise<ScannedPort[]> {
  if (!isSerialScanSupported()) return []
  let ports: SerialPort[] = []
  try {
    ports = await navigator.serial.getPorts()
  } catch {
    return []
  }
  if (ports.length === 0) return []

  // Identify the active connection's port (if it is a real serial link) by its
  // USB ids, so we can skip probing it. grbl.activePort tells us a serial link is
  // live; we match the granted port whose ids equal the active connection's.
  const activeIds = activeSerialIds()

  const results: ScannedPort[] = []
  for (const port of ports) {
    let info: PortUsbInfo = {}
    try {
      const raw = port.getInfo()
      info = { vendorId: raw.usbVendorId, productId: raw.usbProductId }
    } catch {
      info = {}
    }
    // Skip the live connection's port — never probe what's actively streaming.
    if (
      activeIds &&
      info.vendorId === activeIds.vendorId &&
      info.productId === activeIds.productId
    ) {
      continue
    }

    const chip = chipLabel(info.vendorId, info.productId)
    const { firmware, version } = await probePort(port)
    results.push({
      port,
      info,
      chip,
      firmware,
      version,
      label: composeLabel(firmware, chip, info),
    })
  }
  return results
}

/**
 * The USB ids of the currently-active REAL serial connection, or null. We can't
 * reach the controller's private SerialPort, but we CAN avoid probing a live
 * link: a connected `kind:'serial'` whose port matches a granted port's ids is
 * the active one. We read the last-active port pref the controller persists.
 */
function activeSerialIds(): { vendorId?: number; productId?: number } | null {
  const active = grbl.activePort
  if (!active.connected || active.kind !== 'serial') return null
  // The controller persists the active port's USB ids for auto-reconnect; reuse
  // them to identify (and skip) the live port during a scan.
  try {
    const raw = localStorage.getItem('karmyogi.serial.preferred')
    if (!raw) return null
    const pref = JSON.parse(raw) as { usbVendorId?: number; usbProductId?: number }
    return { vendorId: pref.usbVendorId, productId: pref.usbProductId }
  } catch {
    return null
  }
}
