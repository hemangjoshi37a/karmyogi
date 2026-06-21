// Headless harness for the camera pad-detection core + px→mm mapping.
// Run: npx tsx scripts/padvision-test.mjs
//
// NO unit-test framework (project rule) — a plain node script that synthesizes
// ImageData-like buffers with bright circles at KNOWN centres, runs the pure
// `detectSolderPads`, and asserts the count + centroids; then checks the px→mm
// mapping for a known calibration; then a degenerate (blank) image. Exits 1 on
// the first failed assertion so it doubles as a CI gate.

import { detectSolderPads, otsuThreshold } from '../src/core/padVision.ts'
import { makePixelToBedMapper } from '../src/camera/padMapping.ts'
import { applyHomography, solveHomography } from '../src/core/cameraCalib.ts'
import { runIronTouchZ, frameMotionFraction } from '../src/camera/ironTouchZ.ts'

let failures = 0
function ok(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}
function near(a, b, tol, msg) {
  ok(Math.abs(a - b) <= tol, `${msg} (got ${a.toFixed(3)}, want ${b.toFixed(3)} ±${tol})`)
}

/** Build an RGBA buffer: dark field with bright filled circles at the given
 *  centres/radii. Returns a plain { data, width, height } (structural ImageData). */
function synth(width, height, circles, { bg = 20, fg = 240 } = {}) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg
    data[i * 4 + 1] = bg
    data[i * 4 + 2] = bg
    data[i * 4 + 3] = 255
  }
  for (const c of circles) {
    const r2 = c.r * c.r
    for (let y = Math.max(0, Math.floor(c.y - c.r)); y <= Math.min(height - 1, Math.ceil(c.y + c.r)); y++) {
      for (let x = Math.max(0, Math.floor(c.x - c.r)); x <= Math.min(width - 1, Math.ceil(c.x + c.r)); x++) {
        const dx = x - c.x
        const dy = y - c.y
        if (dx * dx + dy * dy <= r2) {
          const j = (y * width + x) * 4
          data[j] = fg
          data[j + 1] = fg
          data[j + 2] = fg
        }
      }
    }
  }
  return { data, width, height }
}

console.log('1) Detect N bright circles at known centroids')
{
  const centres = [
    { x: 40, y: 30, r: 8 },
    { x: 120, y: 50, r: 10 },
    { x: 200, y: 140, r: 6 },
    { x: 70, y: 170, r: 12 },
  ]
  const img = synth(256, 200, centres)
  const { pads, debug } = detectSolderPads(img, { minAreaPx: 20, maxAreaPx: 5000, minCircularity: 0.5 })
  ok(pads.length === centres.length, `found ${pads.length} pads (expected ${centres.length})`)
  // pads are returned in raster (y,x) order; sort expected the same way for pairing.
  const expected = centres.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  for (let i = 0; i < Math.min(pads.length, expected.length); i++) {
    near(pads[i].xPx, expected[i].x, 1.5, `pad ${i} centroid X`)
    near(pads[i].yPx, expected[i].y, 1.5, `pad ${i} centroid Y`)
    near(pads[i].rPx, expected[i].r, 1.5, `pad ${i} radius`)
    ok(pads[i].circularity >= 0.7, `pad ${i} circularity ${pads[i].circularity.toFixed(2)} ≥ 0.7`)
  }
  // Otsu lands on/just-above the dark background level (≈20) so the bright pads
  // (240) fall cleanly on the foreground side. Assert it's in the low band.
  ok(debug.threshold >= 20 && debug.threshold < 240, `Otsu threshold ${debug.threshold} splits bg(20)/fg(240)`)
}

console.log('2) A long thin rectangle (trace) is REJECTED by circularity')
{
  // A 100×4 bright bar — high fill, but very low aspect → low circularity.
  const data = new Uint8ClampedArray(160 * 80 * 4)
  for (let i = 0; i < 160 * 80; i++) { data[i * 4 + 3] = 255 } // black, opaque
  for (let y = 38; y < 42; y++) for (let x = 30; x < 130; x++) {
    const j = (y * 160 + x) * 4
    data[j] = data[j + 1] = data[j + 2] = 240
  }
  const img = { data, width: 160, height: 80 }
  const { pads } = detectSolderPads(img, { minAreaPx: 20, maxAreaPx: 5000, minCircularity: 0.55 })
  ok(pads.length === 0, `trace bar rejected (got ${pads.length} pads)`)
  // With circularity disabled it WOULD be found — proves the filter is what rejects it.
  const loose = detectSolderPads(img, { minAreaPx: 20, maxAreaPx: 5000, minCircularity: 0 })
  ok(loose.pads.length === 1, `trace bar IS a blob when circularity is off (got ${loose.pads.length})`)
}

console.log('3) Area band filters out too-small / too-large blobs')
{
  const img = synth(200, 200, [
    { x: 50, y: 50, r: 3 },   // small
    { x: 100, y: 100, r: 9 }, // medium (keep)
    { x: 150, y: 150, r: 40 },// large
  ])
  const { pads } = detectSolderPads(img, { minAreaPx: 100, maxAreaPx: 1000, minCircularity: 0.5 })
  ok(pads.length === 1, `only the medium blob survives the area band (got ${pads.length})`)
  if (pads.length === 1) near(pads[0].xPx, 100, 2, 'surviving blob X')
}

console.log('4) Degenerate images → 0 pads, no throw')
{
  const blank = synth(64, 64, [])
  const r1 = detectSolderPads(blank, {})
  ok(r1.pads.length === 0, `blank dark field → 0 pads (got ${r1.pads.length})`)
  const empty = { data: new Uint8ClampedArray(0), width: 0, height: 0 }
  const r2 = detectSolderPads(empty, {})
  ok(r2.pads.length === 0, `zero-size image → 0 pads, no throw`)
  // Uniform mid-grey: there is no pad-sized blob. With a realistic size band
  // (what the panel always supplies via min/max pad mm) the lone full-frame blob
  // is rejected as far too large → 0 pads.
  const grey = new Uint8ClampedArray(32 * 32 * 4).fill(128)
  for (let i = 3; i < grey.length; i += 4) grey[i] = 255
  const r3 = detectSolderPads({ data: grey, width: 32, height: 32 }, { minAreaPx: 4, maxAreaPx: 300 })
  ok(r3.pads.length === 0, `uniform grey → 0 pads with a size band (got ${r3.pads.length})`)
  ok(otsuThreshold(new Uint32Array(256)) === 127, `Otsu of an empty histogram is the 127 fallback`)
}

console.log('5) px→mm mapping for a known FIXED-mount homography')
{
  // A bed 100×80 mm imaged into a 640×480 frame, Y flipped (image y-down,
  // bed y-up). Solve H (image px → bed mm) from 4 corner correspondences.
  const imgPts = [[0, 0], [640, 0], [640, 480], [0, 480]]
  const bedPts = [[-50, 40], [50, 40], [50, -40], [-50, -40]]
  const H = solveHomography(imgPts, bedPts)
  ok(H != null, 'homography solved')
  // Frame centre → bed origin.
  const c = applyHomography(H, [320, 240])
  near(c[0], 0, 0.05, 'frame centre maps to bed X=0')
  near(c[1], 0, 0.05, 'frame centre maps to bed Y=0')

  const slot = {
    deviceId: '', label: '', mount: 'fixed', H, rmsMm: 0,
    frameW: 640, frameH: 480,
    pxPerMm: null, rotationDeg: 0, headMap: null, headHomography: null,
    headRefMm: [0, 0], headRotateQuarters: 0, headFlipH: false, headFlipV: false,
    offsetMm: [0, 0], distortK: 0,
  }
  const mapper = makePixelToBedMapper(slot)
  ok(mapper != null, 'mapper built for fixed mount')
  const b = mapper.map([640, 0]) // top-right image corner → bed (50, 40)
  near(b[0], 50, 0.1, 'top-right corner → bed X=50')
  near(b[1], 40, 0.1, 'top-right corner → bed Y=40')
  // px-per-mm: 640 px over 100 mm = 6.4 px/mm (X), 480/80 = 6 px/mm (Y) → ~6.2 avg.
  near(mapper.pxPerMm, 6.2, 0.5, 'estimated px-per-mm ≈ 6.2')
}

console.log('6) px→mm mapping for a HEAD-mount affine map + live wpos')
{
  // 5 px per mm, no rotation, lens offset (1, -2) mm; head at machine (10, 20).
  const slot = {
    deviceId: '', label: '', mount: 'head', H: null, rmsMm: 0,
    frameW: 320, frameH: 240,
    pxPerMm: 5, rotationDeg: 0, headMap: null, headHomography: null,
    headRefMm: [0, 0], headRotateQuarters: 0, headFlipH: false, headFlipV: false,
    offsetMm: [1, -2], distortK: 0,
  }
  const mapper = makePixelToBedMapper(slot, { x: 10, y: 20 })
  ok(mapper != null, 'mapper built for head mount')
  // Frame centre (160,120) → machine XY + offset = (11, 18).
  const c = mapper.map([160, 120])
  near(c[0], 11, 0.001, 'head centre → bed X = wpos.x + offset.x')
  near(c[1], 18, 0.001, 'head centre → bed Y = wpos.y + offset.y')
  // +50 px in X from centre = +10 mm at 5 px/mm → X = 21.
  const r = mapper.map([210, 120])
  near(r[0], 21, 0.001, '+50px X → +10 mm bed X')
  near(r[1], 18, 0.001, 'pure-X move leaves bed Y unchanged')
  near(mapper.pxPerMm, 5, 0.001, 'head px-per-mm = 5')
}

console.log('7) makePixelToBedMapper returns null for an uncalibrated slot')
{
  const slot = {
    deviceId: '', label: '', mount: 'fixed', H: null, rmsMm: null,
    frameW: 0, frameH: 0, pxPerMm: null, rotationDeg: 0, headMap: null,
    headHomography: null, headRefMm: [0, 0], headRotateQuarters: 0,
    headFlipH: false, headFlipV: false, offsetMm: [0, 0], distortK: 0,
  }
  ok(makePixelToBedMapper(slot) === null, 'uncalibrated fixed slot → null mapper')
}

console.log('8) Iron-touch Z (Phase 2) control flow over injected ops')
{
  // A 16×16 gray frame. The "tip" descends (frame keeps changing) for the first
  // few steps, then CONTACTS (frame stops changing). We feed a scripted sequence
  // of frames and assert the loop zeros Z at the contact step.
  const W = 16, H = 16
  const grayFrame = (seed) => {
    const data = new Uint8Array(W * H)
    // Encode a moving bright block whose position = seed (the descending tip);
    // once seed stops advancing the frame is identical (= contact).
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const on = x >= (seed % 6) && x < (seed % 6) + 3 && y >= 6 && y < 9
      data[y * W + x] = on ? 220 : 30
    }
    return { data, width: W, height: H }
  }
  // motion fraction sanity: a shifted block vs a static one.
  ok(frameMotionFraction(grayFrame(0), grayFrame(1), 18) > 0, 'moving frame → non-zero motion')
  ok(frameMotionFraction(grayFrame(3), grayFrame(3), 18) === 0, 'identical frames → zero motion')

  // Script: seeds 1,2,3 move (descending), then 3,3,3 (contact – no further move).
  const seeds = [1, 2, 3, 3, 3, 3]
  let idx = 0
  let zeroed = false
  let jogs = 0
  const res = await runIronTouchZ(
    {
      jogDownZ: async () => { jogs++ },
      grabGray: () => grayFrame(seeds[Math.min(idx++, seeds.length - 1)]),
      setWorkZeroZ: async () => { zeroed = true },
      sleep: async () => {},
    },
    { stepMm: 0.1, maxTravelMm: 5, settleMs: 0, motionThreshold: 0.001, confirmSteps: 2 },
  )
  ok(res.ok === true, `contact detected (reason=${res.ok ? 'ok' : res.reason})`)
  ok(zeroed === true, 'work Z was zeroed on contact')
  ok(jogs >= 3 && jogs <= 6, `jogged a sane number of steps (${jogs})`)

  // No-contact: the frame ALWAYS moves → loop consumes the travel limit and aborts
  // WITHOUT zeroing Z (fails safe).
  let moved = 0
  let zeroed2 = false
  let cancelled = false
  const res2 = await runIronTouchZ(
    {
      jogDownZ: async () => { moved++ },
      grabGray: () => grayFrame(moved), // always advancing → always "moving"
      setWorkZeroZ: async () => { zeroed2 = true },
      sleep: async () => {},
      jogCancel: async () => { cancelled = true },
    },
    { stepMm: 0.5, maxTravelMm: 2, settleMs: 0, motionThreshold: 0.001, confirmSteps: 2 },
  )
  ok(res2.ok === false && res2.reason === 'no-contact', 'no-contact within travel limit → abort')
  ok(zeroed2 === false, 'no Z zero on a no-contact abort (fails safe)')
  ok(cancelled === true, 'jog cancelled on abort')
}

console.log('')
if (failures > 0) {
  console.error(`FAILED: ${failures} assertion(s)`)
  process.exit(1)
}
console.log('ALL PAD-VISION CHECKS PASSED')
