// One-off: tessellate the gamepad STEP CAD files into compact mesh JSON so the
// app renders them instantly (no 6 MB STEP + no main-thread OCCT freeze).
// Run: node scripts/bake-controllers.mjs   (output → public/controllers_3d/*.json)
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'node_modules', 'occt-import-js', 'dist')
const WASM = join(DIST, 'occt-import-js.wasm')

const factory = require(join(DIST, 'occt-import-js.js'))

// Source STEP CAD lives OUTSIDE public/ so the 12 MB isn't deployed; only the
// baked ~1 MB JSON ships. Re-run this script if the source models change.
const files = [
  { step: 'scripts/controllers-src/ps5.step', out: 'public/controllers_3d/ps5.json' },
  { step: 'scripts/controllers-src/xbox.step', out: 'public/controllers_3d/xbox.json' },
]

const occt = await factory({ locateFile: (p) => (p.endsWith('.wasm') ? WASM : p) })

for (const f of files) {
  const buf = new Uint8Array(readFileSync(join(ROOT, f.step)))
  const res = occt.ReadStepFile(buf, null)
  if (!res?.success) throw new Error('parse failed: ' + f.step)
  // Round positions to ~micron precision to shrink JSON, keep indices as ints.
  const meshes = res.meshes.map((m) => ({
    position: Array.from(m.attributes.position.array, (v) => Math.round(v * 1000) / 1000),
    index: m.index?.array ? Array.from(m.index.array) : null,
    color: m.color ?? null,
  }))
  const outPath = join(ROOT, f.out)
  writeFileSync(outPath, JSON.stringify({ meshes }))
  const kb = (statSync(outPath).size / 1024).toFixed(0)
  console.log(`${f.out}: ${meshes.length} meshes, ${kb} KB`)
}
console.log('done')
