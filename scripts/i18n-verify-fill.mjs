// i18n-verify-fill.mjs — verify the 14 (formerly) incomplete locales now match de.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, '..', 'src', 'i18n', 'locales');

const inc = ['am', 'as', 'bho', 'brx', 'doi', 'kok', 'ks', 'mai', 'mni', 'my', 'sa', 'sat', 'sd', 'yo'];
const ref = JSON.parse(readFileSync(join(localesDir, 'de.json'), 'utf8'));
const refKeys = new Set(Object.keys(ref));
const refOrder = Object.keys(ref);

const placeholderKeys = Object.keys(ref).filter((k) => /\{\{|\{[a-z0-9]+\}|<[a-z/]/i.test(ref[k]));

const lines = [];
let allOk = true;
for (const l of inc) {
  const o = JSON.parse(readFileSync(join(localesDir, `${l}.json`), 'utf8'));
  const keys = Object.keys(o);
  const count = keys.length;
  const missing = refOrder.filter((k) => !(k in o));
  const extra = keys.filter((k) => !refKeys.has(k));
  const localeRefOrder = keys.filter((k) => refKeys.has(k));
  let orderOk = true;
  for (let i = 0; i < localeRefOrder.length; i++) {
    if (localeRefOrder[i] !== refOrder[i]) { orderOk = false; break; }
  }
  const phProblems = [];
  for (const k of placeholderKeys) {
    if (!(k in o)) continue;
    const want = (ref[k].match(/\{\{[^}]+\}\}|\{[a-z0-9]+\}/gi) || []).sort();
    const got = (String(o[k]).match(/\{\{[^}]+\}\}|\{[a-z0-9]+\}/gi) || []).sort();
    if (want.join('|') !== got.join('|')) phProblems.push(k);
  }
  const ok = count === 2910 && missing.length === 0 && extra.length === 0 && orderOk && phProblems.length === 0;
  if (!ok) allOk = false;
  lines.push(`${l}: count=${count} missing=${missing.length} extra=${extra.length} order=${orderOk ? 'ok' : 'BAD'} phProblems=${phProblems.length}${phProblems.length ? ' [' + phProblems.slice(0, 5).join(',') + ']' : ''} -> ${ok ? 'OK' : 'FAIL'}`);
  if (missing.length) lines.push('   missing: ' + missing.slice(0, 10).join(', '));
}
lines.push(allOk ? 'ALL OK' : 'SOME FAILED');
writeFileSync(join(__dirname, 'i18n-verify-fill.out.txt'), lines.join('\n') + '\n', 'utf8');
console.log(lines.join('\n'));
