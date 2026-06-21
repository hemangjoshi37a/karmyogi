// i18n-fill.mjs — merge translated leaf keys into a locale file, then reorder
// to match the reference locale's key order (de.json). Files are FLAT objects
// keyed by dotted strings.
//
// Usage:
//   node scripts/i18n-fill.mjs <locale> <translations.json>
// where <translations.json> is { "dotted.key": "translated string", ... }
//
// Writes the locale file back with 2-space indent + trailing newline, key order
// matching de.json (reference) for keys present in de.json, with any locale-only
// extras appended in their original order.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, '..', 'src', 'i18n', 'locales');

const [, , locale, transPath] = process.argv;
if (!locale || !transPath) {
  console.error('usage: node scripts/i18n-fill.mjs <locale> <translations.json>');
  process.exit(1);
}

const refPath = join(localesDir, 'de.json');
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
const refOrder = Object.keys(ref);

const localePath = join(localesDir, `${locale}.json`);
const obj = JSON.parse(readFileSync(localePath, 'utf8'));
const trans = JSON.parse(readFileSync(transPath, 'utf8'));

// merge translations
let added = 0;
for (const [k, v] of Object.entries(trans)) {
  if (!(k in obj)) added++;
  obj[k] = v;
}

// reorder: reference order first, then any locale-only extras
const out = {};
const refSet = new Set(refOrder);
for (const k of refOrder) {
  if (k in obj) out[k] = obj[k];
}
for (const k of Object.keys(obj)) {
  if (!refSet.has(k)) out[k] = obj[k];
}

writeFileSync(localePath, JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`${locale}: +${added} keys, total ${Object.keys(out).length}`);
