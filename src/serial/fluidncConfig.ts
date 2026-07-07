// Minimal, comment-preserving editor for a FluidNC config.yaml — just the limit
// pins. We read the running config with `$CD`, edit only the limit_*_pin scalars
// (everything else, incl. comments + formatting, is preserved by the yaml
// Document API), write it back over XMODEM, and [ESP444]RESTART.
//
// Limit pins live at:  axes.<AXIS>.motor0.limit_neg_pin / limit_pos_pin / limit_all_pin
// NOTE: real FluidNC dumps axis keys in UPPER case (X, Y, Z, A, B, C) and uses
// the sentinel `NO_PIN` for an unassigned pin. Pin format: gpio.5:low:pu

import { parseDocument, isMap, type Document } from 'yaml'

export type LimitKey = 'limit_neg_pin' | 'limit_pos_pin' | 'limit_all_pin'

export interface AxisLimits {
  /** Display label (the axis key as it appears in the config, e.g. "X"). */
  axis: string
  /** The EXACT key string used in the config (for round-trip edits). */
  axisKey: string
  negPin: string | null
  posPin: string | null
  allPin: string | null
}

export function parseConfig(text: string): Document {
  return parseDocument(text)
}

export function stringifyConfig(doc: Document): string {
  const out = doc.toString()
  return out.endsWith('\n') ? out : out + '\n'
}

/** The real axis-key strings under `axes:` in document order (e.g. ["X","Y",…]). */
function axisKeys(doc: Document): string[] {
  const axes = doc.get('axes', true)
  if (!axes || !isMap(axes)) return []
  return axes.items.map((pair) => String((pair.key as { value?: unknown })?.value ?? pair.key))
}

function pinAt(doc: Document, axisKey: string, key: LimitKey): string | null {
  const v = doc.getIn(['axes', axisKey, 'motor0', key])
  if (v == null) return null
  return String(v)
}

/** Read the per-axis limit pins for every axis actually present in the config. */
export function readAxisLimits(doc: Document): AxisLimits[] {
  return axisKeys(doc).map((axisKey) => ({
    axis: axisKey.toUpperCase(),
    axisKey,
    negPin: pinAt(doc, axisKey, 'limit_neg_pin'),
    posPin: pinAt(doc, axisKey, 'limit_pos_pin'),
    allPin: pinAt(doc, axisKey, 'limit_all_pin'),
  }))
}

/** Set one limit pin for an axis' motor0. Empty/null clears it to NO_PIN. */
export function setAxisLimitPin(
  doc: Document,
  axisKey: string,
  key: LimitKey,
  value: string | null,
): void {
  const v = value == null || value.trim() === '' ? 'NO_PIN' : value.trim()
  doc.setIn(['axes', axisKey, 'motor0', key], v)
}

/** Swap limit_neg_pin ↔ limit_pos_pin for an axis (the "switch on the wrong end" fix). */
export function swapAxisLimits(doc: Document, axisKey: string): void {
  const neg = pinAt(doc, axisKey, 'limit_neg_pin')
  const pos = pinAt(doc, axisKey, 'limit_pos_pin')
  setAxisLimitPin(doc, axisKey, 'limit_neg_pin', pos)
  setAxisLimitPin(doc, axisKey, 'limit_pos_pin', neg)
}

// ── FluidDial pendant UART ────────────────────────────────────────────────
// FluidDial (FluidNC's native encoder+display pendant) talks to the controller
// on a spare UART. FluidNC needs a numbered `uart<N>` (pins + baud + mode) plus a
// matching `uart_channel<N>` (which uart, and how often to push a status report).
// Numbered sections are flat top-level keys: `uart1:` / `uart_channel1:`.

export interface PendantUart {
  /** Section number → `uart<N>` / `uart_channel<N>` (usually 1). */
  uartNum: number
  /** Controller pin wired to the DIAL's RX (controller transmits here). */
  txdPin: string | null
  /** Controller pin wired to the DIAL's TX (controller receives here). */
  rxdPin: string | null
  baud: number
  /** UART framing, e.g. "8N1". */
  mode: string
  /** Status-push cadence to the dial (ms); ~75 keeps the readout smooth. */
  reportIntervalMs: number
}

/** Sensible FluidDial defaults (pins are board-specific, so left empty). */
export const DEFAULT_PENDANT_UART: PendantUart = {
  uartNum: 1,
  txdPin: null,
  rxdPin: null,
  baud: 115200,
  mode: '8N1',
  reportIntervalMs: 75,
}

/** Read the pendant UART + channel (`uart<N>` / `uart_channel<N>`) from the config. */
export function readPendantUart(doc: Document, uartNum = 1): PendantUart {
  const u = `uart${uartNum}`
  const ch = `uart_channel${uartNum}`
  const str = (path: string[]): string | null => {
    const v = doc.getIn(path)
    return v == null ? null : String(v)
  }
  const num = (path: string[], dflt: number): number => {
    const v = doc.getIn(path)
    const n = v == null ? NaN : Number(v)
    return Number.isFinite(n) ? n : dflt
  }
  return {
    uartNum,
    txdPin: str([u, 'txd_pin']),
    rxdPin: str([u, 'rxd_pin']),
    baud: num([u, 'baud'], 115200),
    mode: str([u, 'mode']) ?? '8N1',
    reportIntervalMs: num([ch, 'report_interval_ms'], 75),
  }
}

/** True if a pendant `uart_channel<N>` is already configured. */
export function hasPendantUart(doc: Document, uartNum = 1): boolean {
  return doc.getIn([`uart_channel${uartNum}`]) != null
}

/**
 * Advisory ESP32 pin check for a UART pin. Returns a human warning for pins that
 * are known-dangerous on the classic ESP32 (the common FluidNC target) — a bad
 * pin here is what makes FluidNC PANIC on boot and skip the whole config. It stays
 * ADVISORY (not a hard block) because ESP32-S2/S3 boards have different maps.
 * `role` is 'tx' (must be output-capable) or 'rx'.
 */
export function validateUartPin(pin: string | null, role: 'tx' | 'rx'): string | null {
  if (!pin) return null
  const s = pin.trim()
  if (s === '' || /^NO_PIN$/i.test(s)) return null
  const m = /^gpio\.(\d+)/i.exec(s)
  if (!m) return null // not a gpio.N pin — leave it to the board
  const n = parseInt(m[1], 10)
  if (n >= 6 && n <= 11) {
    return 'GPIO 6–11 are wired to the ESP32’s SPI flash — using them WILL crash the controller. Pick another pin.'
  }
  if (n === 1 || n === 3) {
    return 'GPIO 1 / 3 are the USB serial console (UART0). Re-using them for the pendant conflicts with the console and can crash the board.'
  }
  if (role === 'tx' && n >= 34 && n <= 39) {
    return 'GPIO 34–39 are INPUT-ONLY on the ESP32 — they can’t drive the TX line. Use them for RX only.'
  }
  return null
}

/** Write the pendant `uart<N>` + `uart_channel<N>` sections (creates or updates). */
export function setPendantUart(doc: Document, p: PendantUart): void {
  const u = `uart${p.uartNum}`
  const ch = `uart_channel${p.uartNum}`
  const pin = (v: string | null) => (v == null || v.trim() === '' ? 'NO_PIN' : v.trim())
  doc.setIn([u, 'txd_pin'], pin(p.txdPin))
  doc.setIn([u, 'rxd_pin'], pin(p.rxdPin))
  doc.setIn([u, 'baud'], Math.round(p.baud))
  doc.setIn([u, 'mode'], p.mode.trim() || '8N1')
  doc.setIn([ch, 'uart_num'], p.uartNum)
  doc.setIn([ch, 'report_interval_ms'], Math.round(p.reportIntervalMs))
}
