// Regenerates the err.<code>.title/.body/.action keys of src/i18n/en.json and id.json from docs/ERROR_CATALOGUE.md
// (the owner of EM- copy). UI keys are left untouched. Usage: node apps/ui/scripts/sync-error-copy.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const doc = readFileSync(here('../../../docs/ERROR_CATALOGUE.md'), 'utf8');
const files = { en: here('../src/i18n/en.json'), id: here('../src/i18n/id.json') };
const out = { en: {}, id: {} };
for (const [lang, path] of Object.entries(files)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(path, 'utf8')))) if (!k.startsWith('err.')) out[lang][k] = v;

const clean = (s) => s.replace(/`([^`]*)`/g, '$1').replaceAll('**', '').trim();
const split2 = (s) => { const i = s.indexOf(' / '); return i < 0 ? [s.trim(), s.trim()] : [s.slice(0, i).trim(), s.slice(i + 3).trim()]; };
let n = 0;
for (const line of doc.split('\n')) {
  if (!line.startsWith('| ')) continue;
  const cols = line.trim().replace(/^\||\|$/g, '').split(' | ').map((c) => c.trim());
  const m = /^\**(EM-\d{4})\**/.exec(cols[0] ?? '');
  if (!m || cols.length < 6 || !['info', 'warn', 'error', 'fatal', 'deprecated'].includes(cols[1])) continue;
  const code = m[1];
  const [tEn, tId] = split2(clean(cols[2]));
  const actsEn = [], actsId = [];
  for (const part of clean(cols[5]).split(/;\s*/)) { const p = part.split('→')[0].trim(); if (!p) continue; const [e, i] = split2(p); actsEn.push(e); actsId.push(i); }
  Object.assign(out.en, { [`err.${code}.title`]: tEn, [`err.${code}.body`]: clean(cols[3]), [`err.${code}.action`]: actsEn.join(' · ') || 'OK' });
  Object.assign(out.id, { [`err.${code}.title`]: tId, [`err.${code}.body`]: clean(cols[4]), [`err.${code}.action`]: actsId.join(' · ') || 'Oke' });
  n += 1;
}
for (const [lang, path] of Object.entries(files)) {
  const sorted = Object.fromEntries(Object.entries(out[lang]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(path, `${JSON.stringify(sorted, null, 1)}\n`);
}
console.log(`synced ${n} EM- codes`);
