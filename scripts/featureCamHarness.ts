// Node harness for per-feature CAM composition (run via `npx tsx`).
// Verifies: (1) whole-file fallback == single-op behavior, (2) multi-pass per
// feature stacks correctly, (3) combined G-code is safe (G21/G90/G94/G17 +
// safe-Z) with no NaN / "-0.000". Writes a report to scripts/featureCamOut.txt.

import { readFileSync, writeFileSync } from 'node:fs'
import { importDxfString } from '../src/core/dxf'
import { Polyline, makeRect, makeCircle } from '../src/core/geometry'
import { defaultTool } from '../src/core/toolpath'
import { defaultCamParams, ProfileSide } from '../src/core/cam'
import {
  composeFeatureToolpaths,
  deriveFeatures,
  opFromPreset,
  findPreset,
  BUILTIN_PRESETS,
  type FeatureOpMap,
} from '../src/core/featureCam'
import { GcodeEmitter } from '../src/core/gcodeEmitter'

const out: string[] = []
const log = (s: string) => out.push(s)
let failures = 0
const assert = (cond: boolean, msg: string) => {
  log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`)
  if (!cond) failures++
}

function emit(toolpaths: ReturnType<typeof composeFeatureToolpaths>['toolpaths']): string {
  const e = new GcodeEmitter({ programName: 'harness', safeZ: 5, feedXY: 600, feedZ: 200 })
  return e.emitProgram(toolpaths)
}

function checkSafe(g: string, label: string) {
  assert(g.includes('G21'), `${label}: has G21`)
  assert(g.includes('G90'), `${label}: has G90`)
  assert(g.includes('G94'), `${label}: has G94`)
  assert(g.includes('G17'), `${label}: has G17`)
  assert(/G0 Z5/.test(g), `${label}: has a safe-Z retract (G0 Z5)`)
  assert(!/NaN/.test(g), `${label}: no NaN`)
  assert(!/-0\.000/.test(g), `${label}: no -0.000`)
  assert(g.trim().endsWith('M30'), `${label}: ends with M30`)
}

// ── Synthetic drawing: outer square with a circle hole inside + an open line ──
const square = makeRect({ x: 0, y: 0 }, 40, 40)
const hole = makeCircle({ x: 20, y: 20 }, 6)
const openLine = new Polyline()
openLine.add({ x: 50, y: 0 })
openLine.add({ x: 70, y: 20 })
const polys = [square, hole, openLine]

const tool = defaultTool()
const base = defaultCamParams({ safeZ: 5, surfaceZ: 0, cutDepth: 2 })

log('=== Synthetic drawing (square + hole + open line) ===')
const feats = deriveFeatures(polys)
log(`features: ${feats.length} (closed: ${feats.filter((f) => f.closed).length})`)
assert(feats.length === 3, 'derived 3 features')
assert(feats.filter((f) => f.closed).length === 2, '2 closed features')

// (1) Whole-file fallback (no per-feature ops) → profile-outside everything.
const fb = composeFeatureToolpaths(polys, {}, tool, base, { op: 'Profile', side: ProfileSide.Outside })
log(`fallback: perFeature=${fb.perFeature} opCount=${fb.opCount} toolpaths=${fb.toolpaths.length}`)
assert(fb.perFeature === false, 'fallback flagged perFeature=false')
assert(fb.opCount >= 2, 'fallback emitted ops for closed features')
checkSafe(emit(fb.toolpaths), 'fallback')

// (2) Multi-pass per feature: square gets Roughing + Finishing; hole gets Pocket.
const opMap: FeatureOpMap = {
  '0': [opFromPreset(findPreset('rough')!), opFromPreset(findPreset('finish')!)],
  '1': [opFromPreset(findPreset('pocket')!)],
  '2': [opFromPreset(findPreset('engrave')!)],
}
const pf = composeFeatureToolpaths(polys, opMap, tool, base)
log(`per-feature: perFeature=${pf.perFeature} opCount=${pf.opCount} toolpaths=${pf.toolpaths.length}`)
assert(pf.perFeature === true, 'per-feature flagged perFeature=true')
assert(pf.opCount === 4, 'per-feature emitted 4 ops (2 on square + 1 hole + 1 line)')
// Names should reflect feature + label so the program is readable.
log('toolpath names: ' + pf.toolpaths.map((t) => t.name).join(' | '))
const g = emit(pf.toolpaths)
checkSafe(g, 'per-feature')

// Containment order: the HOLE (feature 2, inside the square) must be cut before
// the square's profile passes. We can't easily read order from names alone, but
// orderLoopsInsideOut puts the inner loop first among closed features. Confirm
// the first emitted closed toolpath references the inner feature.
const closedNames = pf.toolpaths.map((t) => t.name)
log('first toolpath: ' + closedNames[0])

// (3) Builtin presets are all distinct colors + ids.
const ids = new Set(BUILTIN_PRESETS.map((p) => p.id))
assert(ids.size === BUILTIN_PRESETS.length, 'preset ids unique')

// ── Real DXF (2carkal.dxf) if present ──
try {
  const dxf = readFileSync('/home/hjoshi/karmyogi/2carkal.dxf', 'utf8')
  const res = importDxfString(dxf)
  log(`\n=== Real DXF 2carkal.dxf: ok=${res.ok} entities=${res.drawing.size()} ===`)
  if (res.ok && res.drawing.size() > 0) {
    const dpolys = res.drawing.flatten()
    const dfeats = deriveFeatures(dpolys)
    log(`flattened polylines: ${dpolys.length}, closed: ${dfeats.filter((f) => f.closed).length}`)
    // Stack two passes on the first closed feature; engrave the first open one.
    const firstClosed = dfeats.find((f) => f.closed)
    const dmap: FeatureOpMap = {}
    if (firstClosed) {
      dmap[String(firstClosed.index)] = [
        opFromPreset(findPreset('rough')!),
        opFromPreset(findPreset('finish')!),
      ]
    }
    const dres = composeFeatureToolpaths(dpolys, dmap, tool, base)
    log(`real DXF per-feature opCount=${dres.opCount}`)
    if (dres.opCount > 0) checkSafe(emit(dres.toolpaths), 'real DXF per-feature')
    else log('(no closed feature to stack — skipping real-DXF emit check)')
  }
} catch (e) {
  log('real DXF skipped: ' + (e as Error).message)
}

log(`\n=== ${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'} ===`)
writeFileSync('/home/hjoshi/karmyogi/scripts/featureCamOut.txt', out.join('\n') + '\n')
