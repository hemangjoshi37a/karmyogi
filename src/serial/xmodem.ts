// XMODEM-CRC primitives shared by the sender (GrblConnection.xmodemSend) and the
// mock receiver (MockPort). FluidNC uploads to its SD card via XMODEM: the host
// (us) is the SENDER, the controller is the RECEIVER. It requests CRC mode by
// sending 'C'; we reply with 128-byte SOH packets, CRC-16/CCITT (poly 0x1021,
// init 0x0000) over each block, and finish with EOT.
//
// Matches FluidNC's src/xmodem.cpp exactly (crc16_ccitt init 0, 128-byte SOH).

export const XM = {
  SOH: 0x01, // start of a 128-byte packet
  STX: 0x02, // start of a 1024-byte packet (we never send these, but accept on rx)
  EOT: 0x04, // end of transmission
  ACK: 0x06, // packet accepted
  NAK: 0x15, // packet rejected → resend (also: receiver wants checksum mode)
  CAN: 0x18, // cancel
  CRC: 0x43, // 'C' — receiver wants CRC mode
  CTRLZ: 0x1a, // pad byte for the final short packet
} as const

/** Packet payload size we send (classic XMODEM, 128 bytes). */
export const XMODEM_BLOCK = 128

/**
 * CRC-16/CCITT (a.k.a. CRC-16/XMODEM): poly 0x1021, init 0x0000, no reflection,
 * no final XOR — identical to FluidNC's table-driven `crc16_ccitt`.
 */
export function crc16ccitt(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0
  for (let i = start; i < end; i++) {
    crc ^= buf[i] << 8
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc & 0xffff
}
