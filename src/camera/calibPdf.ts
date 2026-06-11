/**
 * Printable A4 calibration-grid generator (Camera panel local module).
 *
 * Builds a known-size GRID of unique QR fiducial markers, each encoding its own
 * real-world bed coordinate in mm (payload `KMYG1|GRID|X=<mm>|Y=<mm>|S=<mm>`),
 * lays them out on an A4 page at TRUE physical size, and emits a one-page PDF the
 * user prints at 100% scale and tapes flat on the bed. The same marker positions
 * are returned so the calibrator (`qrCalib.ts`) knows the bed-mm coordinate of
 * every printed marker without re-reading the QR (the QR is the redundant,
 * self-describing source of truth that the detector reads back).
 *
 * Implementation notes:
 *  - No PDF dependency exists in the project (checked package.json — only
 *    `fflate`, no jspdf). So we (a) draw the whole sheet to a high-DPI canvas and
 *    (b) wrap that single raster as a minimal, valid one-page PDF by hand. This
 *    keeps everything client-side, offline, and free of new deps.
 *  - A self-contained QR encoder (byte mode, EC level M, auto version) lives here
 *    so each marker can carry an arbitrary mm payload — the platform has no QR
 *    *encoder* (BarcodeDetector only *decodes*).
 *  - Pure of React/store/three; only touches the browser canvas + Blob/URL.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One printed grid marker: its bed-mm centre + the payload its QR encodes. */
export interface GridMarker {
  /** Column/row indices (0-based) in the grid. */
  col: number
  row: number
  /** Bed-mm coordinate this marker's CENTRE represents (origin = sheet corner). */
  xMm: number
  yMm: number
  /** QR payload encoded in the marker. */
  payload: string
}

/** A generated calibration sheet: the PDF blob + the marker layout it encodes. */
export interface CalibSheet {
  /** The printable one-page A4 PDF. */
  blob: Blob
  /** Every marker on the sheet, with its bed-mm coordinate + payload. */
  markers: GridMarker[]
  /** Marker spacing (mm) used for the grid. */
  spacingMm: number
  /** Per-marker QR module-square size (mm). */
  markerMm: number
  /** Grid dimensions. */
  cols: number
  rows: number
}

/** Options for {@link generateCalibrationSheet}. */
export interface CalibSheetOptions {
  /** Columns of markers across the page (default 4). */
  cols?: number
  /** Rows of markers down the page (default 5). */
  rows?: number
  /** Centre-to-centre marker spacing in mm (default 38). */
  spacingMm?: number
  /** Printed QR square size in mm (default 22). */
  markerMm?: number
}

// A4 in millimetres.
const A4_W_MM = 210
const A4_H_MM = 297
// Render DPI for the raster we embed in the PDF (crisp print at 100%).
const DPI = 200
const MM_PER_INCH = 25.4

/** The shared marker-payload prefix used across karmyogi calibration markers. */
const PREFIX = 'KMYG1'
/** Role token for the auto two-camera grid markers (distinct from TARGET/STOCK). */
export const GRID_ROLE = 'GRID'

/**
 * Build the payload a grid marker encodes. The mm coordinate IS the marker's
 * bed position, so the detector can rebuild the bed↔image map with zero external
 * state. Rounded to 0.1 mm and stripped of any "-0".
 */
export function gridMarkerPayload(xMm: number, yMm: number, sizeMm: number): string {
  const f = (n: number) => {
    const v = Number(n.toFixed(1))
    return Object.is(v, -0) ? '0' : String(v)
  }
  return `${PREFIX}|${GRID_ROLE}|X=${f(xMm)}|Y=${f(yMm)}|S=${f(sizeMm)}`
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Compute the marker grid for a sheet (centred on the page, origin at the
 * BOTTOM-LEFT of the marker grid so bed mm grow right/up like the machine bed).
 */
export function buildGridLayout(opts: CalibSheetOptions = {}): {
  markers: GridMarker[]
  cols: number
  rows: number
  spacingMm: number
  markerMm: number
  /** Page-mm origin (left, bottom) of the (0,0) marker centre. */
  originMm: { x: number; y: number }
} {
  const cols = Math.max(2, Math.floor(opts.cols ?? 4))
  const rows = Math.max(2, Math.floor(opts.rows ?? 5))
  const spacingMm = Math.max(10, opts.spacingMm ?? 38)
  const markerMm = Math.max(8, Math.min(spacingMm - 6, opts.markerMm ?? 22))

  // Centre the grid on the page.
  const gridW = (cols - 1) * spacingMm
  const gridH = (rows - 1) * spacingMm
  const originX = (A4_W_MM - gridW) / 2
  // Page Y grows DOWN in PDF/canvas; bed Y grows UP. We place row 0 at the bottom.
  const originY = (A4_H_MM - gridH) / 2

  const markers: GridMarker[] = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const xMm = col * spacingMm
      const yMm = row * spacingMm
      markers.push({
        col,
        row,
        xMm,
        yMm,
        payload: gridMarkerPayload(xMm, yMm, markerMm),
      })
    }
  }
  return { markers, cols, rows, spacingMm, markerMm, originMm: { x: originX, y: originY } }
}

// ---------------------------------------------------------------------------
// Sheet → machine registration anchors
// ---------------------------------------------------------------------------

/**
 * The two SHEET-mm marker coordinates the operator physically registers to tie
 * the printed sheet's frame to the machine work frame (see `qrCalib.ts`
 * {@link SheetRegistration}). Both lie on grid row 0:
 *   - the ORIGIN is grid (0,0) → sheet-mm (0,0);
 *   - the SECOND is grid (cols-1, 0) → sheet-mm ((cols-1)*spacing, 0).
 * They share a row so the vector between them is purely along the sheet's +X
 * axis, which makes the recovered rotation/scale unambiguous.
 */
export interface RegistrationMarkers {
  /** Grid column/row of each anchor, for an on-screen "which marker" hint. */
  originColRow: { col: number; row: number }
  secondColRow: { col: number; row: number }
  /** Sheet-mm coordinate of each anchor (matches the marker's printed X/Y label). */
  originMm: { x: number; y: number }
  secondMm: { x: number; y: number }
}

/**
 * Compute the registration-anchor marker coordinates for a grid layout. Defaults
 * match {@link generateCalibrationSheet} (4×5 grid, 38 mm spacing), so the panel
 * can guide "jog to the X0 Y0 marker, then the X{n} Y0 marker" without
 * re-deriving the layout.
 */
export function registrationMarkers(opts: CalibSheetOptions = {}): RegistrationMarkers {
  const { cols, spacingMm } = buildGridLayout(opts)
  const secondX = (cols - 1) * spacingMm
  return {
    originColRow: { col: 0, row: 0 },
    secondColRow: { col: cols - 1, row: 0 },
    originMm: { x: 0, y: 0 },
    secondMm: { x: secondX, y: 0 },
  }
}

// ---------------------------------------------------------------------------
// Sheet rendering (canvas → PDF)
// ---------------------------------------------------------------------------

/**
 * Generate the printable A4 calibration sheet. Returns the PDF blob and the
 * marker layout it encodes. Throws if a canvas context cannot be obtained.
 *
 * NOTE TO THE OPERATOR (surfaced by the panel): the user must PRINT this at 100%
 * (no "fit to page") and tape it flat on the bed before auto-calibrating.
 */
export async function generateCalibrationSheet(
  opts: CalibSheetOptions = {},
): Promise<CalibSheet> {
  const layout = buildGridLayout(opts)
  const pxPerMm = DPI / MM_PER_INCH
  const W = Math.round(A4_W_MM * pxPerMm)
  const H = Math.round(A4_H_MM * pxPerMm)

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Could not get a 2D canvas context for the calibration sheet.')

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)

  // Title + print-scale warning, rendered in real mm units.
  const mm = (v: number) => v * pxPerMm
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'top'
  ctx.font = `${Math.round(mm(5))}px sans-serif`
  ctx.fillText('karmyogi · camera calibration grid', mm(12), mm(8))
  ctx.font = `${Math.round(mm(3.2))}px sans-serif`
  ctx.fillStyle = '#444444'
  ctx.fillText(
    `Print at 100% (NO fit-to-page). Spacing ${layout.spacingMm} mm · marker ${layout.markerMm} mm.`,
    mm(12),
    mm(15),
  )
  ctx.fillText('Lay flat on the bed; both cameras must see several markers.', mm(12), mm(19.5))

  // A 10 mm calibration ruler so the operator can verify the print scale.
  const rulerY = mm(A4_H_MM - 14)
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = Math.max(1, mm(0.3))
  ctx.beginPath()
  ctx.moveTo(mm(12), rulerY)
  ctx.lineTo(mm(12 + 50), rulerY)
  ctx.stroke()
  for (let i = 0; i <= 50; i += 10) {
    ctx.beginPath()
    ctx.moveTo(mm(12 + i), rulerY - mm(2))
    ctx.lineTo(mm(12 + i), rulerY + mm(2))
    ctx.stroke()
  }
  ctx.fillStyle = '#000000'
  ctx.font = `${Math.round(mm(3))}px sans-serif`
  ctx.fillText('0', mm(12), rulerY + mm(3))
  ctx.fillText('50 mm — measure to verify scale', mm(12 + 52), rulerY - mm(1))

  // Render every marker as a QR matrix + a small mm label underneath.
  for (const marker of layout.markers) {
    const matrix = encodeQr(marker.payload)
    const n = matrix.size
    // Marker centre in PAGE mm. Bed Y grows up; PAGE Y grows down → flip.
    const cxMm = layout.originMm.x + marker.xMm
    const cyMmPage = layout.originMm.y + ((layout.rows - 1) * layout.spacingMm - marker.yMm)
    const sizePx = mm(layout.markerMm)
    const left = mm(cxMm) - sizePx / 2
    const top = mm(cyMmPage) - sizePx / 2
    const cell = sizePx / n

    // Quiet zone is white (page already white); draw the dark modules.
    ctx.fillStyle = '#000000'
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        if (matrix.get(x, y)) {
          ctx.fillRect(
            Math.round(left + x * cell),
            Math.round(top + y * cell),
            Math.ceil(cell),
            Math.ceil(cell),
          )
        }
      }
    }
    // mm label below the marker.
    ctx.fillStyle = '#222222'
    ctx.font = `${Math.round(mm(2.6))}px sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(`X${marker.xMm}  Y${marker.yMm}`, mm(cxMm), top + sizePx + mm(1))
    ctx.textAlign = 'left'
  }

  // Encode to JPEG (smaller than PNG for this mostly-white raster) and wrap as PDF.
  const jpeg = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
  )
  if (!jpeg) throw new Error('Could not rasterize the calibration sheet.')
  const jpegBytes = new Uint8Array(await jpeg.arrayBuffer())
  const pdf = wrapJpegInPdf(jpegBytes, W, H, A4_W_MM, A4_H_MM)

  return {
    blob: new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }),
    markers: layout.markers,
    spacingMm: layout.spacingMm,
    markerMm: layout.markerMm,
    cols: layout.cols,
    rows: layout.rows,
  }
}

// ---------------------------------------------------------------------------
// Minimal single-page PDF wrapping a JPEG (DCTDecode) at A4 size
// ---------------------------------------------------------------------------

/**
 * Hand-assemble a valid one-page PDF that draws `jpeg` (with native pixel
 * dimensions `imgW`×`imgH`) scaled to fill an A4 page (`pageWmm`×`pageHmm`).
 * Uses the JPEG verbatim via the `DCTDecode` filter — no re-encoding.
 */
function wrapJpegInPdf(
  jpeg: Uint8Array,
  imgW: number,
  imgH: number,
  pageWmm: number,
  pageHmm: number,
): Uint8Array {
  // PDF user-space unit = 1/72 inch (a "point"). 1 mm = 72/25.4 pt.
  const ptPerMm = 72 / MM_PER_INCH
  const pageWpt = (pageWmm * ptPerMm).toFixed(2)
  const pageHpt = (pageHmm * ptPerMm).toFixed(2)

  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (bytes: Uint8Array) => {
    chunks.push(bytes)
    length += bytes.length
  }
  const pushStr = (s: string) => push(enc.encode(s))

  pushStr('%PDF-1.4\n')
  // Binary-comment marker (raw high bytes) so viewers treat the file as binary.
  push(new Uint8Array([0x25, 0xff, 0xff, 0xff, 0xff, 0x0a]))

  const startObj = () => {
    offsets.push(length)
  }

  // 1: Catalog
  startObj()
  pushStr('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  // 2: Pages
  startObj()
  pushStr('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n')
  // 3: Page
  startObj()
  pushStr(
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWpt} ${pageHpt}] ` +
      `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>\nendobj\n`,
  )
  // 4: Image XObject (the JPEG)
  startObj()
  pushStr(
    `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ` +
      `/Length ${jpeg.length} >>\nstream\n`,
  )
  push(jpeg)
  pushStr('\nendstream\nendobj\n')
  // 5: Content stream (draw the image to fill the page)
  const content = `q\n${pageWpt} 0 0 ${pageHpt} 0 0 cm\n/Im0 Do\nQ\n`
  startObj()
  pushStr(`5 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`)

  // xref
  const xrefStart = length
  const objCount = offsets.length + 1 // + the free object 0
  let xref = `xref\n0 ${objCount}\n0000000000 65535 f \n`
  for (const off of offsets) {
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  pushStr(xref)
  pushStr(
    `trailer\n<< /Size ${objCount} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
  )

  // Concatenate.
  const out = new Uint8Array(length)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  return out
}

// ===========================================================================
// Self-contained QR encoder (byte mode · EC level M · auto version)
// ===========================================================================
//
// Small, dependency-free encoder good for short ASCII payloads (our KMYG1 grid
// strings are < ~30 bytes, easily inside version 1–4). Implements: GF(256)
// Reed–Solomon, byte-mode bitstream, version capacity tables, mask 0 + the
// canonical function-pattern placement, and format-info. Returns a boolean
// module matrix. (Encoder only — the platform BarcodeDetector handles decoding.)

interface QrMatrix {
  size: number
  get(x: number, y: number): boolean
}

// EC level M codeword block layout per version (1..10), as
// [total data codewords, ecCodewordsPerBlock, [#blocks group1, dataCW group1, #blocks group2, dataCW group2]].
// Source: QR spec Table 9 (level M). Only versions 1..10 (ample for our payload).
const EC_M: Record<
  number,
  { totalData: number; ecPerBlock: number; groups: [number, number][] }
> = {
  1: { totalData: 16, ecPerBlock: 10, groups: [[1, 16]] },
  2: { totalData: 28, ecPerBlock: 16, groups: [[1, 28]] },
  3: { totalData: 44, ecPerBlock: 26, groups: [[1, 44]] },
  4: { totalData: 64, ecPerBlock: 18, groups: [[2, 32]] },
  5: { totalData: 86, ecPerBlock: 24, groups: [[2, 43]] },
  6: { totalData: 108, ecPerBlock: 16, groups: [[4, 27]] },
  7: { totalData: 124, ecPerBlock: 18, groups: [[4, 31]] },
  8: { totalData: 154, ecPerBlock: 22, groups: [[2, 38], [2, 39]] },
  9: { totalData: 182, ecPerBlock: 22, groups: [[3, 36], [2, 37]] },
  10: { totalData: 216, ecPerBlock: 26, groups: [[4, 43], [1, 44]] },
}

/** Choose the smallest version (1..10) whose level-M capacity fits `byteLen`. */
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= 10; v++) {
    // 4 bits mode + char-count indicator (8 bits for v<10) overhead.
    const overheadBytes = v < 10 ? 2 : 3
    if (EC_M[v].totalData >= byteLen + overheadBytes) return v
  }
  throw new Error('QR payload too long for the calibration encoder.')
}

// --- GF(256) arithmetic (primitive poly 0x11D) ---
const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a] + GF_LOG[b]]
}

/** Reed–Solomon EC codewords for `data` with `ecLen` parity symbols. */
function rsEncode(data: number[], ecLen: number): number[] {
  // Generator polynomial.
  let gen = [1]
  for (let i = 0; i < ecLen; i++) {
    const next = new Array(gen.length + 1).fill(0)
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j]
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i])
    }
    gen = next
  }
  const res = new Array(ecLen).fill(0)
  for (const d of data) {
    const factor = d ^ res[0]
    res.shift()
    res.push(0)
    for (let j = 0; j < gen.length - 1; j++) {
      res[j] ^= gfMul(gen[j + 1] ?? 0, factor)
    }
  }
  return res
}

// --- bit buffer ---
class BitBuffer {
  bits: number[] = []
  put(value: number, len: number) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1)
  }
}

/** Encode `text` (ASCII bytes) into a QR module matrix (level M, mask 0). */
function encodeQr(text: string): QrMatrix {
  const bytes: number[] = []
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff)
  const version = pickVersion(bytes.length)
  const spec = EC_M[version]

  // 1) build the data bitstream: mode (byte=0100), char count, data, terminator.
  const bb = new BitBuffer()
  bb.put(0b0100, 4)
  const ccBits = version < 10 ? 8 : 16
  bb.put(bytes.length, ccBits)
  for (const b of bytes) bb.put(b, 8)
  // Terminator (up to 4 zero bits) + pad to byte boundary.
  const capacityBits = spec.totalData * 8
  const remaining = capacityBits - bb.bits.length
  bb.put(0, Math.min(4, Math.max(0, remaining)))
  while (bb.bits.length % 8 !== 0) bb.bits.push(0)
  // Pad bytes 0xEC, 0x11 alternating.
  const dataCw: number[] = []
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j]
    dataCw.push(v)
  }
  const padBytes = [0xec, 0x11]
  let pi = 0
  while (dataCw.length < spec.totalData) {
    dataCw.push(padBytes[pi % 2])
    pi++
  }

  // 2) split into blocks, compute EC per block, interleave.
  const blocks: { data: number[]; ec: number[] }[] = []
  let offset = 0
  for (const [count, dataPer] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const slice = dataCw.slice(offset, offset + dataPer)
      offset += dataPer
      blocks.push({ data: slice, ec: rsEncode(slice, spec.ecPerBlock) })
    }
  }
  const maxData = Math.max(...blocks.map((b) => b.data.length))
  const finalCw: number[] = []
  for (let i = 0; i < maxData; i++) {
    for (const blk of blocks) if (i < blk.data.length) finalCw.push(blk.data[i])
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of blocks) finalCw.push(blk.ec[i])
  }

  // 3) place into the module matrix.
  const size = 17 + version * 4
  const modules: (boolean | null)[][] = Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  )
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  )

  const setF = (x: number, y: number, v: boolean) => {
    modules[y][x] = v
    reserved[y][x] = true
  }

  // Finder patterns + separators.
  const placeFinder = (ox: number, oy: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx
        const y = oy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const onBorder = dx === 0 || dx === 6 || dy === 0 || dy === 6
        const inCore = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4
        const dark = (dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6) && (onBorder || inCore)
        setF(x, y, dark)
      }
    }
  }
  placeFinder(0, 0)
  placeFinder(size - 7, 0)
  placeFinder(0, size - 7)

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0
    if (!reserved[6][i]) setF(i, 6, v)
    if (!reserved[i][6]) setF(6, i, v)
  }

  // Alignment patterns (versions ≥ 2). Center coords per version.
  const alignCenters = ALIGN_POS[version] ?? []
  for (const cy of alignCenters) {
    for (const cx of alignCenters) {
      // Skip overlap with finders.
      if (
        (cx <= 8 && cy <= 8) ||
        (cx >= size - 9 && cy <= 8) ||
        (cx <= 8 && cy >= size - 9)
      )
        continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const ring = Math.max(Math.abs(dx), Math.abs(dy))
          setF(cx + dx, cy + dy, ring !== 1)
        }
      }
    }
  }

  // Dark module + reserve format-info areas.
  setF(8, size - 8, true)
  reserveFormatAreas(reserved, size)

  // 4) lay the data bitstream in the zig-zag, applying mask 0.
  const bitstream: number[] = []
  for (const cw of finalCw) for (let i = 7; i >= 0; i--) bitstream.push((cw >> i) & 1)

  let bitIdx = 0
  let upward = true
  // Walk the RIGHT column of each 2-wide pair from the right edge inward. The
  // vertical timing column (x=6) is never a data column: once we cross it, every
  // remaining pair's right column shifts left by one so no column is read twice.
  for (let right = size - 1; right > 0; right -= 2) {
    const rc = right > 6 ? right : right - 1 // skip the timing column at x=6
    for (let i = 0; i < size; i++) {
      const y = upward ? size - 1 - i : i
      for (let s = 0; s < 2; s++) {
        const x = rc - s
        if (x < 0 || reserved[y][x]) continue
        let bit = bitIdx < bitstream.length ? bitstream[bitIdx] : 0
        bitIdx++
        // Mask 0: invert where (x + y) % 2 === 0.
        if ((x + y) % 2 === 0) bit ^= 1
        modules[y][x] = bit === 1
      }
    }
    upward = !upward
  }

  // 5) format info (EC level M = 0b00, mask 0). Precomputed 15-bit string.
  placeFormatInfo(modules, reserved, size, FORMAT_M_MASK0)

  // Any module still null → light.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x] === null) modules[y][x] = false
    }
  }

  return {
    size,
    get: (x: number, y: number) => modules[y][x] === true,
  }
}

// Alignment-pattern centre coordinates per version (1..10).
const ALIGN_POS: Record<number, number[]> = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

/** Reserve the 15-bit format-info areas around the finders (level M / mask 0). */
function reserveFormatAreas(reserved: boolean[][], size: number) {
  for (let i = 0; i < 9; i++) {
    if (i !== 6) {
      reserved[8][i] = true
      reserved[i][8] = true
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true
    reserved[size - 1 - i][8] = true
  }
  reserved[8][6] = true
  reserved[6][8] = true
}

// The 15-bit format string for EC level M, mask pattern 0 (precomputed, masked
// with 0x5412 per spec). Bits MSB-first.
const FORMAT_M_MASK0 = 0x5412

/**
 * Place the 15-bit format info bits in both copies. Coordinates are (x=col,
 * y=row); `modules[y][x]`. Bit 0 is the LSB of `fmt`. Layout per ISO/IEC 18004.
 */
function placeFormatInfo(
  modules: (boolean | null)[][],
  reserved: boolean[][],
  size: number,
  fmt: number,
) {
  const bit = (i: number) => ((fmt >> i) & 1) === 1
  const set = (x: number, y: number, v: boolean) => {
    modules[y][x] = v
    reserved[y][x] = true
  }
  // Copy 1: around the top-left finder.
  // bits 0..5 down column x=8 (rows 0..5).
  for (let i = 0; i <= 5; i++) set(8, i, bit(i))
  set(8, 7, bit(6))
  set(8, 8, bit(7))
  set(7, 8, bit(8))
  // bits 9..14 along row y=8 (cols 5..0).
  for (let i = 9; i <= 14; i++) set(14 - i, 8, bit(i))

  // Copy 2: split across the other two finders. Per ISO/IEC 18004 the LOW bits
  // (0..7) run ALONG row y=8 from the right edge inward (next to the top-right
  // finder); the HIGH bits (8..14) run UP column x=8 (beside the bottom-left
  // finder). Copy 1 above is the canonical opposite split; the previous code
  // here had these two runs transposed.
  // bits 0..7 along row y=8 (cols size-1 .. size-8).
  for (let i = 0; i <= 7; i++) set(size - 1 - i, 8, bit(i))
  // bits 8..14 up column x=8 (rows size-7 .. size-1).
  for (let i = 8; i <= 14; i++) set(8, size - 15 + i, bit(i))

  // Dark module at (x=8, y=size-8).
  set(8, size - 8, true)
}
