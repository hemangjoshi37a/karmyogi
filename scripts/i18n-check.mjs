#!/usr/bin/env node
/**
 * i18n-check — extract every static `t('key', 'fallback')` call site from the
 * source tree and DIFF the extracted key set against each shipped locale file.
 *
 * What it does (READ-ONLY — it never writes to _catalog.json or locales/*.json):
 *   1. Scan src/ for source files and pull out all STATIC translate keys.
 *      The translate contract is `t('key', 'English fallback'[, vars])`, where
 *      `key` and `fallback` are string literals (single- or double-quoted).
 *      Dynamic/template keys like t(`conn.status.${x}`, …) are intentionally
 *      skipped — they can't be diffed against a fixed key set.
 *   2. For every src/i18n/locales/*.json, report keys that are MISSING from the
 *      locale (present in source, absent in the locale) and EXTRA keys (present
 *      in the locale, no matching source call site).
 *   3. Exit non-zero if ANY locale is missing keys (extra keys alone are a
 *      warning, not a failure — a future translation pass owns the locale files).
 *
 * Usage:  node scripts/i18n-check.mjs            (full per-locale report)
 *         node scripts/i18n-check.mjs --summary  (one line per locale)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC = join(ROOT, 'src')
const LOCALES_DIR = join(SRC, 'i18n', 'locales')

const SUMMARY = process.argv.includes('--summary')

const SRC_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs'])
// Directories whose contents are NOT call sites we should extract from.
const SKIP_DIRS = new Set(['node_modules', 'i18n', 'dist', '.git'])

/** Recursively collect source files under `dir`. */
function collectSources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name)) continue
      collectSources(full, out)
    } else {
      const dot = name.lastIndexOf('.')
      if (dot >= 0 && SRC_EXT.has(name.slice(dot))) out.push(full)
    }
  }
  return out
}

/**
 * Read a JS/TS string literal starting at `text[i]` (which must be a quote
 * char: ' or "). Returns { value, end } where `end` is the index just past the
 * closing quote, or null if the literal is dynamic (template literal) / invalid.
 */
function readStringLiteral(text, i) {
  const quote = text[i]
  if (quote !== "'" && quote !== '"') return null
  let j = i + 1
  let value = ''
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      // Decode the common escapes we care about for fallback text.
      const next = text[j + 1]
      if (next === 'n') value += '\n'
      else if (next === 't') value += '\t'
      else if (next === 'r') value += '\r'
      else value += next // \' \" \\ etc.
      j += 2
      continue
    }
    if (ch === quote) return { value, end: j + 1 }
    if (ch === '\n') return null // unterminated literal on one line → bail
    value += ch
    j++
  }
  return null
}

/** Skip whitespace/comments-free gap; return index of next non-space char. */
function skipSpace(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

/**
 * Extract static translate keys (and their fallbacks) from one file's source.
 * Matches `t(` and `useT()(` style call openers, then reads the first string
 * literal (the key) and, if the next token is a comma + string literal, the
 * fallback. Returns an array of { key, fallback }.
 */
function extractFromSource(text) {
  const found = []
  // Match an identifier ending in `t` immediately followed by `(`. This covers
  // the bound translator `t(...)` and avoids matching words like `format(` /
  // `connect(` because we additionally require the first arg to be a string key
  // shaped like a dot-key (letters/digits/dots/underscores) — see below.
  const opener = /(?<![A-Za-z0-9_$])t\s*\(/g
  let m
  while ((m = opener.exec(text))) {
    let i = skipSpace(text, m.index + m[0].length)
    const keyLit = readStringLiteral(text, i)
    if (!keyLit) continue // dynamic/template key or not a string → skip
    const key = keyLit.value
    // Heuristic: a real i18n key is a dot-key of [A-Za-z0-9_.] with no spaces.
    // This filters out unrelated `t('literal text', …)`-shaped calls.
    if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(key)) continue
    // Optional fallback: expect a comma then a string literal.
    let j = skipSpace(text, keyLit.end)
    let fallback = null
    if (text[j] === ',') {
      j = skipSpace(text, j + 1)
      const fbLit = readStringLiteral(text, j)
      if (fbLit) fallback = fbLit.value
    }
    found.push({ key, fallback })
  }
  return found
}

// ---- 1. Extract from source ----
const sources = collectSources(SRC)
/** key → { fallback, sites: Set<relpath> } */
const keys = new Map()
for (const file of sources) {
  const text = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  for (const { key, fallback } of extractFromSource(text)) {
    if (!keys.has(key)) keys.set(key, { fallback, sites: new Set() })
    const entry = keys.get(key)
    if (entry.fallback == null && fallback != null) entry.fallback = fallback
    entry.sites.add(rel)
  }
}
const sourceKeys = new Set(keys.keys())

// ---- 2. Diff each locale ----
let localeFiles = []
try {
  localeFiles = readdirSync(LOCALES_DIR)
    .filter((n) => n.endsWith('.json'))
    .sort()
} catch {
  console.error(`No locales directory at ${relative(ROOT, LOCALES_DIR)}`)
  process.exit(2)
}

console.log(
  `i18n-check: extracted ${sourceKeys.size} static keys from ${sources.length} source files.`,
)
console.log(`Checking ${localeFiles.length} locale file(s) in ${relative(ROOT, LOCALES_DIR)}/\n`)

let anyMissing = false
const rows = []

for (const fname of localeFiles) {
  const code = fname.replace(/\.json$/, '')
  let map
  try {
    map = JSON.parse(readFileSync(join(LOCALES_DIR, fname), 'utf8'))
  } catch (err) {
    console.error(`  ${code}: FAILED to parse (${err.message})`)
    anyMissing = true
    rows.push({ code, missing: NaN, extra: NaN })
    continue
  }
  const localeKeys = new Set(Object.keys(map))
  const missing = [...sourceKeys].filter((k) => !localeKeys.has(k)).sort()
  const extra = [...localeKeys].filter((k) => !sourceKeys.has(k)).sort()
  if (missing.length) anyMissing = true
  rows.push({ code, missing: missing.length, extra: extra.length })

  if (!SUMMARY) {
    const tag = missing.length ? 'MISSING' : 'ok'
    console.log(
      `  ${code.padEnd(5)} ${String(localeKeys.size).padStart(5)} keys  ` +
        `missing=${missing.length}  extra=${extra.length}  [${tag}]`,
    )
    const PREVIEW = 8
    if (missing.length) {
      console.log(
        `         missing: ${missing.slice(0, PREVIEW).join(', ')}` +
          (missing.length > PREVIEW ? `, … (+${missing.length - PREVIEW} more)` : ''),
      )
    }
    if (extra.length) {
      console.log(
        `         extra:   ${extra.slice(0, PREVIEW).join(', ')}` +
          (extra.length > PREVIEW ? `, … (+${extra.length - PREVIEW} more)` : ''),
      )
    }
  }
}

if (SUMMARY) {
  for (const r of rows) {
    console.log(`  ${r.code.padEnd(5)} missing=${r.missing}  extra=${r.extra}`)
  }
}

const totalMissing = rows.reduce((n, r) => n + (Number.isNaN(r.missing) ? 0 : r.missing), 0)
console.log(
  `\nSummary: ${sourceKeys.size} source keys · ${localeFiles.length} locales · ` +
    `${totalMissing} total missing key-slots across locales.`,
)

if (anyMissing) {
  console.log('Result: FAIL — at least one locale is missing keys (the translation pass fills these).')
  process.exit(1)
}
console.log('Result: PASS — every locale covers all source keys.')
