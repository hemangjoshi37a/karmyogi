#!/usr/bin/env node
/*
 * karmyogi — Camera-calibration sheet generator.
 *
 * Produces a print-ready A4 HTML sheet of QR fiducial markers + a machine-
 * readable marker registry (markers.json). Each QR encodes a compact, SELF-
 * DESCRIBING payload (role + its own real-world size in mm + its position in
 * the target frame), so the vision pipeline (see plan.md §7) can recover the
 * bed-plane homography — mm-per-pixel + perspective — from a single detected
 * marker, then measure bed/stock edges in real millimetres.
 *
 * Marker payload grammar (pipe-delimited, ASCII, kept short so the QR stays a
 * low version = easy to detect from a webcam at bed distance):
 *
 *   KMYG1|TARGET|<corner>|X=<mm>|Y=<mm>|S=<mm>|W=<mm>|H=<mm>
 *       Bed calibration target. 4 corner markers at a known rectangle.
 *       X,Y = this marker's CENTRE in the target frame (origin = bottom-left
 *       marker, +X right, +Y up). S = marker side (mm). W,H = centre-to-centre
 *       spacing of the whole target (mm). Any single marker is self-describing.
 *   KMYG1|STOCK|N=<i>|S=<mm>
 *       Cut-out stock sticker. Stick on a workpiece corner; its known side S
 *       gives local scale and a stock-corner pose.
 *   KMYG1|MAT|name=<material>|t=<thickness_mm>|S=<mm>
 *       Optional labelled material tag (used when auto-classification is unsure).
 *
 * Usage:
 *   QR_LIB=/tmp/qrgen/node_modules/qrcode node tools/calibration/gen-calibration-sheet.cjs
 * (or `npm i -D qrcode` and run without QR_LIB). Then render to PDF with headless
 * Chrome:  chrome --headless --no-pdf-header-footer --print-to-pdf=out.pdf file://.../calibration-sheet.html
 */
'use strict'
const fs = require('fs')
const path = require('path')
const QRCode = require(process.env.QR_LIB || 'qrcode')

// --- A4 geometry (mm) --------------------------------------------------------
const PAGE_W = 210
const PAGE_H = 297

// Bed calibration target: 4 corner markers forming a known rectangle.
const M = 28 // corner-marker side (mm)
const MARGIN = 16 // distance from page edge to marker box (mm)
const corners = [
  { id: 'TL', left: MARGIN, top: 20 },
  { id: 'TR', left: PAGE_W - MARGIN - M, top: 20 },
  { id: 'BL', left: MARGIN, top: PAGE_H - 20 - M },
  { id: 'BR', left: PAGE_W - MARGIN - M, top: PAGE_H - 20 - M },
]
// Centre-to-centre spacing of the target (mm) — derived from the layout above.
const cx = (c) => c.left + M / 2
const cy = (c) => c.top + M / 2
const TARGET_W = Math.round(cx(corners[1]) - cx(corners[0])) // dx, TL→TR
const TARGET_H = Math.round(cy(corners[2]) - cy(corners[0])) // dy, TL→BL
// Target-frame coords (origin = BL marker centre, +X right, +Y up, mm).
const frame = {
  BL: { X: 0, Y: 0 },
  BR: { X: TARGET_W, Y: 0 },
  TL: { X: 0, Y: TARGET_H },
  TR: { X: TARGET_W, Y: TARGET_H },
}

// Cut-out stock stickers (a strip the operator cuts and sticks on the stock).
const STOCK_S = 18
const STOCK_N = 6

// Optional labelled material tags.
const MAT_S = 18
const materials = [
  { name: 'plywood', t: 12 },
  { name: 'mdf', t: 18 },
]

// --- marker registry (machine-readable; consumed by the vision pipeline) -----
const registry = { version: 'KMYG1', unit: 'mm', page: 'A4', markers: [] }

function payloadTarget(c) {
  const f = frame[c.id]
  return `KMYG1|TARGET|${c.id}|X=${f.X}|Y=${f.Y}|S=${M}|W=${TARGET_W}|H=${TARGET_H}`
}
function payloadStock(i) {
  return `KMYG1|STOCK|N=${i}|S=${STOCK_S}`
}
function payloadMat(m) {
  return `KMYG1|MAT|name=${m.name}|t=${m.t}|S=${MAT_S}`
}

// --- QR rendering ------------------------------------------------------------
// QRCode.toString is async; we pre-render every payload into this map up front
// (see main()) and the synchronous HTML builder reads SVGs from here.
const svgCache = new Map()
function qrSvg(text) {
  const svg = svgCache.get(text)
  if (svg === undefined) throw new Error('QR not pre-rendered: ' + text)
  return svg
}
async function renderQr(text) {
  // errorCorrectionLevel 'Q' (25%) survives print smudging; margin 2 modules.
  let svg = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'Q',
    margin: 2,
    width: 256,
  })
  // Make it scale to the container exactly (strip fixed width/height attrs).
  return svg
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/width="[^"]*"/, 'width="100%"')
    .replace(/height="[^"]*"/, 'height="100%"')
    .replace('<svg ', '<svg preserveAspectRatio="xMidYMid meet" style="display:block" ')
}

function markerBox({ left, top, size, svg, label, sub }) {
  const labelTop = top + size + 1.2
  return `
  <div class="marker" style="left:${left}mm;top:${top}mm;width:${size}mm;height:${size}mm;">${svg}</div>
  <div class="mlabel" style="left:${left}mm;top:${labelTop}mm;width:${size}mm;">${label}${
    sub ? `<span class="msub">${sub}</span>` : ''
  }</div>`
}

// --- main (async, because QR rendering is async) ----------------------------
;(async () => {
// Pre-render every QR payload into svgCache so the HTML builder stays synchronous.
const allPayloads = [
  ...corners.map(payloadTarget),
  ...Array.from({ length: STOCK_N }, (_, i) => payloadStock(i + 1)),
  ...materials.map(payloadMat),
]
await Promise.all(allPayloads.map(async (p) => svgCache.set(p, await renderQr(p))))

// --- build the four corner markers ------------------------------------------
let cornerHtml = ''
for (const c of corners) {
  const text = payloadTarget(c)
  registry.markers.push({
    role: 'TARGET',
    id: c.id,
    sizeMm: M,
    frameXmm: frame[c.id].X,
    frameYmm: frame[c.id].Y,
    targetWmm: TARGET_W,
    targetHmm: TARGET_H,
    payload: text,
  })
  cornerHtml += markerBox({
    left: c.left,
    top: c.top,
    size: M,
    svg: qrSvg(text),
    label: `BED · ${c.id}`,
    sub: `${M}mm`,
  })
  // corner crop ticks
  cornerHtml += `<div class="crop" style="left:${c.left - 3}mm;top:${c.top - 3}mm;"></div>`
}

// --- axis indicator (machine origin reference, next to BL marker) -----------
const bl = corners.find((c) => c.id === 'BL')
const axis = `
  <svg class="axis" style="left:${bl.left + M + 3}mm;top:${bl.top - 2}mm;" width="34mm" height="34mm" viewBox="0 0 34 34">
    <line x1="2" y1="32" x2="30" y2="32" stroke="#000" stroke-width="0.6"/>
    <polygon points="30,32 25,30 25,34" fill="#000"/>
    <text x="31" y="33.5" font-size="3.4" font-family="sans-serif">X</text>
    <line x1="2" y1="32" x2="2" y2="4" stroke="#000" stroke-width="0.6"/>
    <polygon points="2,4 0,9 4,9" fill="#000"/>
    <text x="0.2" y="3.2" font-size="3.4" font-family="sans-serif">Y</text>
    <text x="4.5" y="30" font-size="2.5" font-family="sans-serif">origin</text>
  </svg>`

// --- stock stickers strip ----------------------------------------------------
const stripTop = 150
const stripGap = 6
const stripW = STOCK_N * STOCK_S + (STOCK_N - 1) * stripGap
const stripLeft = (PAGE_W - stripW) / 2
let stockHtml = ''
for (let i = 1; i <= STOCK_N; i++) {
  const text = payloadStock(i)
  registry.markers.push({ role: 'STOCK', n: i, sizeMm: STOCK_S, payload: text })
  const left = stripLeft + (i - 1) * (STOCK_S + stripGap)
  stockHtml += `<div class="cut" style="left:${left - 1.5}mm;top:${stripTop - 1.5}mm;width:${
    STOCK_S + 3
  }mm;height:${STOCK_S + 3}mm;"></div>`
  stockHtml += markerBox({
    left,
    top: stripTop,
    size: STOCK_S,
    svg: qrSvg(text),
    label: `S${i}`,
    sub: '',
  })
}

// --- material tags -----------------------------------------------------------
const matTop = 188
const matGap = 10
const matW = materials.length * MAT_S + (materials.length - 1) * matGap
const matLeft = (PAGE_W - matW) / 2
let matHtml = ''
materials.forEach((m, i) => {
  const text = payloadMat(m)
  registry.markers.push({ role: 'MAT', name: m.name, thicknessMm: m.t, sizeMm: MAT_S, payload: text })
  const left = matLeft + i * (MAT_S + matGap)
  matHtml += markerBox({
    left,
    top: matTop,
    size: MAT_S,
    svg: qrSvg(text),
    label: m.name,
    sub: `${m.t}mm`,
  })
})

// --- 100mm ruler -------------------------------------------------------------
function ruler() {
  let ticks = ''
  for (let i = 0; i <= 100; i++) {
    const h = i % 10 === 0 ? 6 : i % 5 === 0 ? 4 : 2.2
    ticks += `<line x1="${i}" y1="${10 - h}" x2="${i}" y2="10" stroke="#000" stroke-width="0.2"/>`
    if (i % 10 === 0) ticks += `<text x="${i}" y="3.2" font-size="3" text-anchor="middle" font-family="sans-serif">${i}</text>`
  }
  // viewBox padded by 7mm each side so the 0 and 100 end-labels aren't clipped
  // (1 viewBox unit still == 1 mm, so tick positions stay physically exact).
  return `<svg class="ruler" width="114mm" height="12mm" viewBox="-7 0 114 12">
    <line x1="0" y1="10" x2="100" y2="10" stroke="#000" stroke-width="0.3"/>${ticks}
    <text x="50" y="12.4" font-size="2.6" text-anchor="middle" font-family="sans-serif">100 mm reference ruler — verify with a real ruler</text>
  </svg>`
}

// --- scale-check square ------------------------------------------------------
const SCALE = 40
const scaleLeft = (PAGE_W - SCALE) / 2

// --- assemble the page -------------------------------------------------------
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>karmyogi — Camera Calibration Sheet</title>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { position: relative; width: ${PAGE_W}mm; height: ${PAGE_H}mm; background: #fff; font-family: -apple-system, Segoe UI, Roboto, sans-serif; color: #000; overflow: hidden; }
  .marker { position: absolute; }
  .marker svg { width: 100%; height: 100%; }
  .mlabel { position: absolute; text-align: center; font-size: 2.6mm; line-height: 1; font-weight: 600; letter-spacing: 0.2px; }
  .msub { font-weight: 400; opacity: 0.7; margin-left: 1mm; }
  .crop { position: absolute; width: 3mm; height: 3mm; border-left: 0.3mm solid #000; border-top: 0.3mm solid #000; }
  .axis { position: absolute; }
  .title { position: absolute; left: 0; top: 52mm; width: 100%; text-align: center; }
  .title h1 { margin: 0; font-size: 6mm; letter-spacing: 0.4px; }
  .title .sub { font-size: 3mm; margin-top: 1.5mm; }
  .title .warn { font-size: 3.2mm; font-weight: 700; margin-top: 2mm; color: #b00; }
  .scalebox { position: absolute; left: ${scaleLeft}mm; top: 70mm; width: ${SCALE}mm; height: ${SCALE}mm; border: 0.35mm solid #000; }
  .scalebox .cap { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); font-size: 3mm; font-weight: 700; text-align: center; width: ${SCALE}mm; }
  .scalecap { position: absolute; left: 0; top: ${70 + SCALE + 1}mm; width: 100%; text-align: center; font-size: 2.6mm; }
  .ruler { position: absolute; left: ${(PAGE_W - 114) / 2}mm; top: 124mm; }
  .sech { position: absolute; width: 100%; text-align: center; font-size: 3.2mm; font-weight: 700; }
  .cut { position: absolute; border: 0.2mm dashed #888; border-radius: 0.5mm; }
  .steps { position: absolute; left: 24mm; top: 214mm; width: 162mm; font-size: 2.9mm; line-height: 1.5; }
  .steps li { margin-bottom: 0.8mm; }
  .foot { position: absolute; left: 0; top: 284mm; width: 100%; text-align: center; font-size: 2.3mm; opacity: 0.75; }
</style>
</head>
<body>
<div class="sheet">
  ${cornerHtml}
  ${axis}

  <div class="title">
    <h1>karmyogi · Camera Calibration Sheet</h1>
    <div class="sub">Place flat on the machine bed. The 4 corner codes set the bed-plane scale &amp; perspective; cut-out codes mark the stock.</div>
    <div class="warn">PRINT AT 100% — “Actual size”, NOT “Fit to page”.</div>
  </div>

  <div class="scalebox"><div class="cap">40.0&nbsp;mm</div></div>
  <div class="scalecap">↑ This square must measure exactly <b>40.0 mm</b> per side. If not, reprint at 100% scale.</div>

  ${ruler()}

  <div class="sech" style="top:144mm;">CUT OUT &amp; STICK ON STOCK CORNERS (each ${STOCK_S} mm)</div>
  ${stockHtml}

  <div class="sech" style="top:182mm;">OPTIONAL MATERIAL TAGS</div>
  ${matHtml}

  <ol class="steps">
    <li><b>Print at 100%</b> and confirm the 40&nbsp;mm square measures 40&nbsp;mm with a ruler.</li>
    <li><b>Bed:</b> lay this sheet flat on the bed, BL code toward the machine front-left (the X→ / Y↑ origin arrow).</li>
    <li><b>Stock:</b> cut out one or more <b>S#</b> stickers and stick them on the workpiece corners (top face).</li>
    <li>In karmyogi open <b>Camera</b> → <b>Auto-setup</b>: it detects the codes, solves mm-per-pixel + perspective, then measures bed &amp; stock size by edge detection.</li>
    <li>Each code is self-describing (role + real size in mm baked into its payload), so a single detected code already fixes the scale.</li>
  </ol>

  <div class="foot">karmyogi.hjlabs.in · marker spec KMYG1 · target ${TARGET_W}×${TARGET_H} mm (centre-to-centre) · regenerate via tools/calibration/gen-calibration-sheet.cjs</div>
</div>
</body>
</html>`

// --- write outputs -----------------------------------------------------------
const outDir = path.resolve(__dirname)
fs.writeFileSync(path.join(outDir, 'calibration-sheet.html'), html, 'utf8')

const pubDir = path.resolve(__dirname, '../../public/calibration')
fs.mkdirSync(pubDir, { recursive: true })
fs.writeFileSync(path.join(pubDir, 'markers.json'), JSON.stringify(registry, null, 2) + '\n', 'utf8')

console.log('wrote', path.join(outDir, 'calibration-sheet.html'))
console.log('wrote', path.join(pubDir, 'markers.json'))
console.log('markers:', registry.markers.length, '| target', TARGET_W + '×' + TARGET_H, 'mm c-to-c')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
