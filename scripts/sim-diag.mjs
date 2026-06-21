// Diagnostic: reproduce the soldering-sim "flying cone" bug.
// Run: npx tsx scripts/sim-diag.mjs   (writes scripts/sim-diag.out.txt)
import { writeFileSync } from 'node:fs'
import {
  defaultSolderPoint,
  defaultSolderingParams,
  generateSoldering,
  SolderFeedType,
} from '../src/core/soldering.ts'
import { buildTimeline } from '../src/core/simulation.ts'

const out = []
const log = (...a) => out.push(a.join(' '))

// 4-5 soldering points at varied XY, default free/touch-Z, mixed feed types
// AND mixed 45-degree angle approaches (these emit combined XYZ G1 moves).
const points = [
  defaultSolderPoint({ x: 10, y: 10, freeZ: 5, touchZ: -1, type: SolderFeedType.TouchDown, approach: 'angle-front' }),
  defaultSolderPoint({ x: 40, y: 12, freeZ: 5, touchZ: -1, type: SolderFeedType.PreSolder, approach: 'angle-right' }),
  defaultSolderPoint({ x: 35, y: 45, freeZ: 6, touchZ: 0.5, type: SolderFeedType.TouchDown, approach: 'angle-back' }),
  defaultSolderPoint({ x: 8, y: 50, freeZ: 5, touchZ: -1, type: SolderFeedType.TouchDown, approach: 'angle-left' }),
  defaultSolderPoint({ x: 22, y: 30, freeZ: 5, touchZ: -2, type: SolderFeedType.PreSolder, approach: 'plunge' }),
]
const params = defaultSolderingParams({ safeZ: 5, plungeFeed: 1000, feederRPM: 1000 })

const gcode = generateSoldering(points, params)
log('===== GENERATED G-CODE =====')
log(gcode)

const timeline = buildTimeline(gcode)
log('===== SEGMENTS =====')
log(`count=${timeline.segments.length} duration=${timeline.duration.toFixed(3)}s totalDist=${timeline.totalDistance.toFixed(2)}mm`)
timeline.segments.forEach((s, i) => {
  const bad =
    s.from.some((v) => !Number.isFinite(v)) || s.to.some((v) => !Number.isFinite(v))
  log(
    `#${i} ${s.kind} from=[${s.from.map((v) => v.toFixed(2)).join(',')}] to=[${s.to
      .map((v) => v.toFixed(2))
      .join(',')}] t=${s.tStart.toFixed(2)}..${s.tEnd.toFixed(2)}${bad ? '  <<< NON-FINITE' : ''}`,
  )
})

log('===== POSITION SAMPLES (flagging jumps) =====')
const dur = timeline.duration || 1
const bedDiag = 200 // a jump larger than this is "flying"
let prev = null
let flags = 0
for (let i = 0; i <= 100; i++) {
  const t = (i / 100) * dur
  const p = timeline.positionAt(t)
  const nonFinite = p.some((v) => !Number.isFinite(v))
  let jump = 0
  if (prev) jump = Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2])
  const flag = nonFinite || jump > bedDiag
  if (flag) flags++
  if (flag || i % 5 === 0) {
    log(
      `t=${t.toFixed(2)} pos=[${p.map((v) => (Number.isFinite(v) ? v.toFixed(2) : String(v))).join(',')}]` +
        (jump > 0 ? ` jump=${jump.toFixed(2)}` : '') +
        (flag ? '  <<< FLAG' : ''),
    )
  }
  prev = p
}
log(`\nTOTAL FLAGGED FRAMES: ${flags}`)

writeFileSync(new URL('./sim-diag.out.txt', import.meta.url), out.join('\n'))
console.log('wrote scripts/sim-diag.out.txt; flags=' + flags)
