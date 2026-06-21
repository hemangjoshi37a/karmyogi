// DEV helper: compute the missing-key set for incomplete locales and resolve
// each key's English source string from useT(key, english) call sites.
// Writes .i18n-missing.json at repo root. Run: node scripts/i18n-missing.mjs
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const LOC = 'src/i18n/locales'
const load = (f) => JSON.parse(readFileSync(`${LOC}/${f}.json`, 'utf8'))
const paths = (o, p = '', a = []) => {
  for (const k in o) {
    const n = p ? `${p}.${k}` : k
    if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) paths(o[k], n, a)
    else a.push(n)
  }
  return a
}

const all = readdirSync(LOC).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''))
const counts = Object.fromEntries(all.map((c) => [c, paths(load(c)).length]))
const max = Math.max(...Object.values(counts))
const ref = new Set(paths(load('de'))) // a complete locale = key superset
const incomplete = all.filter((c) => counts[c] < max)

// shared missing set (verify all incompletes share it)
const missingByLocale = Object.fromEntries(
  incomplete.map((c) => [c, [...ref].filter((k) => !new Set(paths(load(c))).has(k)).sort()]),
)
const base = missingByLocale[incomplete[0]] || []

// resolve English source from useT/t(key,'English') call sites via ripgrep
const englishFor = {}
for (const key of base) {
  let eng = null
  try {
    const esc = key.replace(/[.[\]]/g, '\\$&')
    const out = execSync(
      `grep -rhoE "['\\"]${esc}['\\"]\\s*,\\s*['\\"][^'\\"]*['\\"]" src --include=*.ts --include=*.tsx | head -1`,
      { encoding: 'utf8' },
    ).trim()
    const m = out.match(/,\s*['"]([^'"]*)['"]/)
    if (m) eng = m[1]
  } catch {
    /* none */
  }
  englishFor[key] = eng
}

const resolved = Object.values(englishFor).filter(Boolean).length
writeFileSync(
  '.i18n-missing.json',
  JSON.stringify(
    {
      counts,
      maxKeys: max,
      incomplete,
      missingCount: base.length,
      allShareSameMissingSet: incomplete.every(
        (c) => JSON.stringify(missingByLocale[c]) === JSON.stringify(base),
      ),
      englishResolved: `${resolved}/${base.length}`,
      english: englishFor,
    },
    null,
    2,
  ),
)
console.log(
  `incomplete=${incomplete.join(',')} missing=${base.length} englishResolved=${resolved}/${base.length}`,
)
