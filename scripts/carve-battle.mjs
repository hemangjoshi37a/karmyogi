// DEEP battle-test for the 2D/3D carving CAM core. Drives the SAME pure modules
// the CadCamPanel uses (cam.ts, featureCam.ts, dxf.ts, slicer.ts, carve3d.ts,
// gcodeEmitter.ts) across many files × operations × settings, and validates the
// emitted G-code with a strict modal parser. Run: npx tsx scripts/carve-battle.mjs
import { readFileSync, existsSync, writeFileSync } from 'node:fs'

import { importDxfString } from '../src/core/dxf.ts'
import { engrave, profileContours, pocket, defaultCamParams, depthLevels, ProfileSide } from '../src/core/cam.ts'
import {
  composeFeatureToolpaths,
  deriveFeatures,
  BUILTIN_PRESETS,
  opFromPreset,
} from '../src/core/featureCam.ts'
import { defaultTool } from '../src/core/toolpath.ts'
import { GcodeEmitter, ZMode } from '../src/core/gcodeEmitter.ts'
import { parseStl } from '../src/core/slicer.ts'
import { carveMesh, defaultCarve3DParams } from '../src/core/carve3d.ts'

const TOL = 0.02
let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) pass++
  else { fail++; failures.push(`✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

// ---- Strict modal G-code validator -----------------------------------------
// Returns { errors: [...], minZ, maxZ, g1count, g0count }. `floor` = lowest legal
// Z (surfaceZ-cutDepth or -maxDepth or penDownZ). `safeZ` = retract height.
function validateGcode(gcode, { safeZ, floor, useSpindle, label }) {
  const errors = []
  const lines = gcode.split('\n')
  if (!/\bG21\b/.test(gcode)) errors.push('missing G21 (mm)')
  if (!/\bG90\b/.test(gcode)) errors.push('missing G90 (abs)')
  if (/NaN/.test(gcode)) errors.push('contains NaN')
  if (/Infinity/i.test(gcode)) errors.push('contains Infinity')
  if (/-0\.0+(\b|[^0-9])/.test(gcode)) errors.push('contains -0.000')
  if (useSpindle && !/\bM5\b/.test(gcode)) errors.push('missing M5 (spindle stop)')

  let mode = null // 0 rapid / 1 feed
  let x = 0, y = 0, z = safeZ, f = 0
  let haveXY = false
  let g1 = 0, g0 = 0
  let minZ = Infinity, maxZ = -Infinity
  let firstFeedNoF = false
  let rapidWhileLow = 0
  for (let raw of lines) {
    const line = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').trim()
    if (!line) continue
    const gm = line.match(/\bG([0-3])\b/)
    if (gm) mode = parseInt(gm[1], 10) <= 1 ? parseInt(gm[1], 10) : mode
    const fx = line.match(/X(-?\d+\.?\d*)/i)
    const fy = line.match(/Y(-?\d+\.?\d*)/i)
    const fz = line.match(/Z(-?\d+\.?\d*)/i)
    const ff = line.match(/F(\d+\.?\d*)/i)
    if (ff) f = parseFloat(ff[1])
    const prevZ = z
    const nx = fx ? parseFloat(fx[1]) : x
    const ny = fy ? parseFloat(fy[1]) : y
    const nz = fz ? parseFloat(fz[1]) : z
    const xyChanged = (fx && Math.abs(nx - x) > 1e-6) || (fy && Math.abs(ny - y) > 1e-6)
    const isMove = /\bG[0-3]\b/.test(line) && (fx || fy || fz)
    if (isMove) {
      if (mode === 0 && xyChanged) {
        g0++
        // safe-Z retract: a rapid XY travel must occur at/above safeZ at BOTH ends
        if (prevZ < safeZ - TOL || nz < safeZ - TOL) rapidWhileLow++
      }
      if (mode === 1) {
        g1++
        if (g1 === 1 && f <= 0) firstFeedNoF = true
      }
      x = nx; y = ny; z = nz; haveXY = haveXY || !!(fx || fy)
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
  }
  if (rapidWhileLow > 0) errors.push(`${rapidWhileLow} rapid XY move(s) below safe-Z (plunge-travel risk)`)
  if (minZ < floor - TOL) errors.push(`Z ${minZ.toFixed(3)} dives below floor ${floor.toFixed(3)}`)
  if (firstFeedNoF) errors.push('first cutting move (G1) has no feed F set')
  if (g1 === 0) errors.push('no cutting (G1) moves emitted')
  return { errors, minZ, maxZ, g1, g0 }
}

function emit2D(toolpaths, opts) {
  const e = new GcodeEmitter({
    programName: 'battle',
    safeZ: opts.safeZ,
    feedXY: 600,
    feedZ: 200,
    zMode: opts.zMode ?? ZMode.Spindle,
    useSpindle: (opts.zMode ?? ZMode.Spindle) === ZMode.Spindle,
    spindleRPM: 12000,
    penUpZ: opts.safeZ,
    penDownZ: opts.penDownZ ?? 0,
    decimals: 3,
  })
  return e.emitProgram(toolpaths)
}

// =====================  2D (DXF) SWEEP  ======================================
console.log('\n=== 2D DXF battle-test ===')
const dxfPath = 'reference' // placeholder
const DXF = '2carkal.dxf'
let polylines = []
if (existsSync(DXF)) {
  const res = importDxfString(readFileSync(DXF, 'utf8'))
  check('DXF parse ok', res.ok, res.error || '')
  polylines = res.drawing.flatten()
  check('DXF has polylines', polylines.length > 0, `got ${polylines.length}`)
  const closed = polylines.filter((p) => p.closed).length
  console.log(`  ${DXF}: ${polylines.length} polylines, ${closed} closed`)
} else {
  console.log(`  (skip — ${DXF} not found)`)
}

const TOOL_D = [0.5, 1, 3.175, 6]
const CUT_D = [0.5, 3, 10]
const STEPDOWN = [0.2, 1.6, 0] // 0 = single full-depth pass
const SURF = [0, -2]
const SAFE = [2, 5]

if (polylines.length) {
  let combos = 0
  for (const d of TOOL_D)
    for (const cut of CUT_D)
      for (const sd of STEPDOWN)
        for (const surf of SURF)
          for (const safe of SAFE) {
            const tool = defaultTool({ diameter: d, stepdown: sd, stepover: d * 0.5, feedXY: 600, feedZ: 200 })
            const p = defaultCamParams({ tool, safeZ: safe, surfaceZ: surf, cutDepth: cut })
            const floor = surf - cut
            const lvls = depthLevels(p)
            // engrave (all paths), profile on/inside/outside (closed only), pocket (closed only)
            const closedLoops = polylines.filter((pl) => pl.closed)
            const ops = [
              ['engrave', () => engrave(polylines, p)],
              ['profile-on', () => profileContours(closedLoops, ProfileSide.On, p)],
              ['profile-inside', () => profileContours(closedLoops, ProfileSide.Inside, p)],
              ['profile-outside', () => profileContours(closedLoops, ProfileSide.Outside, p)],
              ['pocket', () => closedLoops.map((l) => pocket(l, p)).flat?.() ?? pocket(closedLoops[0], p)],
            ]
            for (const [opName, fn] of ops) {
              combos++
              const label = `2D ${opName} d=${d} cut=${cut} sd=${sd} surf=${surf} safe=${safe}`
              try {
                let tps = fn()
                if (!Array.isArray(tps)) tps = [tps]
                const g = emit2D(tps, { safeZ: safe, surfaceZ: surf })
                const v = validateGcode(g, { safeZ: safe, floor, useSpindle: true, label })
                check(label, v.errors.length === 0, v.errors.join('; '))
              } catch (e) {
                check(label, false, 'THREW: ' + (e?.message || e))
              }
            }
          }
  console.log(`  swept ${combos} 2D op×setting combos`)

  // Pen (plotter) Z mode — depth is penDownZ, floor=penDownZ
  try {
    const tool = defaultTool({ diameter: 1, stepdown: 0 })
    const p = defaultCamParams({ tool, safeZ: 5, surfaceZ: 0, cutDepth: 0 })
    const g = emit2D([engrave(polylines, p)], { safeZ: 5, zMode: ZMode.Pen, penDownZ: 0 })
    const v = validateGcode(g, { safeZ: 5, floor: 0, useSpindle: false, label: 'pen' })
    check('2D pen-mode engrave', v.errors.length === 0, v.errors.join('; '))
  } catch (e) { check('2D pen-mode engrave', false, 'THREW: ' + (e?.message || e)) }
}

// =====================  PER-FEATURE SWEEP  ===================================
console.log('\n=== per-feature battle-test ===')
if (polylines.length) {
  const feats = deriveFeatures(polylines)
  check('deriveFeatures count', feats.length === polylines.length, `${feats.length} vs ${polylines.length}`)
  const baseTool = defaultTool({ diameter: 3.175, stepdown: 1.6 })
  const base = defaultCamParams({ tool: baseTool, safeZ: 5, surfaceZ: 0, cutDepth: 2 })

  // (a) whole-file fallback (no ops) → must reproduce legacy behavior
  let r = composeFeatureToolpaths(polylines, {}, baseTool, base, { op: 'Profile', side: ProfileSide.Outside })
  check('per-feature fallback perFeature=false', r.perFeature === false)
  check('per-feature fallback emits ops', r.opCount > 0, `opCount=${r.opCount}`)
  {
    const g = emit2D(r.toolpaths, { safeZ: 5 })
    const v = validateGcode(g, { safeZ: 5, floor: -2, useSpindle: true, label: 'pf-fallback' })
    check('per-feature fallback gcode', v.errors.length === 0, v.errors.join('; '))
  }

  // (b) per-feature: stack multiple presets across features (roughing+finishing, pocket, engrave)
  const presetIds = BUILTIN_PRESETS.map((p) => p.id)
  const opMap = {}
  feats.forEach((f, i) => {
    const closed = polylines[i]?.closed
    // closed loops: roughing + finishing + (pocket on even); open: engrave
    if (closed) {
      const rough = BUILTIN_PRESETS.find((p) => /rough/i.test(p.id) || /rough/i.test(p.label))
      const fin = BUILTIN_PRESETS.find((p) => /finish/i.test(p.id) || /finish/i.test(p.label))
      const pk = BUILTIN_PRESETS.find((p) => p.kind === 'Pocket' || /pocket/i.test(p.label))
      opMap[String(i)] = [rough, fin, i % 2 === 0 ? pk : null].filter(Boolean).map((p) => opFromPreset(p))
    } else {
      const eng = BUILTIN_PRESETS.find((p) => p.kind === 'Engrave' || /engrave/i.test(p.label))
      opMap[String(i)] = eng ? [opFromPreset(eng)] : []
    }
  })
  r = composeFeatureToolpaths(polylines, opMap, baseTool, base, { op: 'Profile', side: ProfileSide.Outside })
  check('per-feature active perFeature=true', r.perFeature === true)
  check('per-feature opCount>0', r.opCount > 0, `opCount=${r.opCount}`)
  try {
    const g = emit2D(r.toolpaths, { safeZ: 5 })
    const v = validateGcode(g, { safeZ: 5, floor: -2, useSpindle: true, label: 'pf-stacked' })
    check('per-feature stacked gcode', v.errors.length === 0, v.errors.join('; '))
    console.log(`  per-feature stacked: ${r.opCount} ops, ${v.g1} cut moves, Z∈[${v.minZ.toFixed(2)},${v.maxZ.toFixed(2)}]`)
  } catch (e) { check('per-feature stacked gcode', false, 'THREW: ' + (e?.message || e)) }

  // (c) empty opMap with NO fallback → empty result (no crash)
  r = composeFeatureToolpaths(polylines, {}, baseTool, base)
  check('per-feature no-fallback empty', r.toolpaths.length === 0 && r.opCount === 0)
}

// =====================  3D (STL) SWEEP  ======================================
console.log('\n=== 3D STL battle-test ===')
const STLS = [
  '.test-stl/cube.stl', '.test-stl/pyramid.stl', '.test-stl/dome.stl', '.test-stl/stairs.stl',
  'test.stl', 'test_stl_files/1.stl', 'test_stl_files/5.stl', 'test_stl_files/10.stl',
].filter(existsSync)
console.log(`  ${STLS.length} STL files found`)

const CARVE_VARIANTS = [
  { toolType: 'flat', toolDiameter: 3.175, stepover: 1.5, stepdown: 1.0, finishDir: 'x' },
  { toolType: 'ball', toolDiameter: 3.175, stepover: 0.8, stepdown: 1.5, finishDir: 'y' },
  { toolType: 'flat', toolDiameter: 6, stepover: 3, stepdown: 2, plungeStrategy: 'plunge' },
  { toolType: 'ball', toolDiameter: 1.5, stepover: 0.5, stepdown: 0.8, plungeStrategy: 'helix', finishPattern: 'climb' },
]
for (const file of STLS) {
  let mesh
  try {
    const buf = readFileSync(file)
    mesh = parseStl(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
    check(`STL parse ${file}`, mesh && mesh.triCount > 0, `tris=${mesh?.triCount}`)
  } catch (e) { check(`STL parse ${file}`, false, 'THREW: ' + (e?.message || e)); continue }
  const span = mesh.bbox.max[2] - mesh.bbox.min[2]
  for (const v of CARVE_VARIANTS) {
    const label = `3D ${file.split('/').pop()} ${v.toolType} d=${v.toolDiameter} so=${v.stepover}`
    try {
      const maxDepth = Math.min(span, 6) || 2
      const params = defaultCarve3DParams({
        ...v, safeZ: 5, maxDepth, feedXY: 800, feedZ: 250, travelFeed: 1500,
        spindleRPM: 12000, doRoughing: true, doFinishing: true,
      })
      const cr = carveMesh(mesh, params)
      check(`${label} carve produced toolpaths`, cr.toolpaths.length > 0, `tp=${cr.toolpaths.length} warns=${cr.warnings.join('|')}`)
      const e = new GcodeEmitter({
        programName: '3d', safeZ: 5, feedXY: 800, feedZ: 250, travelFeed: 1500,
        useSpindle: true, spindleRPM: 12000, zMode: ZMode.Spindle, decimals: 3,
      })
      const g = e.emitProgram(cr.toolpaths)
      const vd = validateGcode(g, { safeZ: 5, floor: -maxDepth, useSpindle: true, label })
      check(`${label} gcode valid`, vd.errors.length === 0, vd.errors.join('; '))
    } catch (e) { check(`${label}`, false, 'THREW: ' + (e?.message || e)) }
  }
}

// =====================  RESULTS  =============================================
const summary = `\n=== RESULTS ===\nPASS ${pass}  FAIL ${fail}\n` + (failures.length ? failures.join('\n') : 'No failures.')
console.log(summary)
writeFileSync('.carve-battle-results.txt', summary)
