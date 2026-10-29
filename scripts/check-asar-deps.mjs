// Packaging guard: every bare module the Shell's main and preload bundles require at runtime must be inside app.asar.
// A build that drops one (e.g. electron-updater) starts on the Creator's PC with "Cannot find module" before any log exists.
// Usage: node scripts/check-asar-deps.mjs <path to app.asar>
import { builtinModules } from 'node:module';
import asar from '@electron/asar';

const asarPath = process.argv[2];
if (!asarPath) { console.error('usage: check-asar-deps.mjs <app.asar>'); process.exit(2); }

const files = new Set(asar.listPackage(asarPath, { isPack: false }).map((f) => f.replace(/\\/g, '/')));
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'electron', 'original-fs']);
const bundles = ['/dist/main.cjs', '/dist/preload.cjs'].filter((f) => files.has(f));
if (bundles.length === 0) { console.error(`check-asar-deps: no dist/main.cjs in ${asarPath}`); process.exit(1); }

const missing = [];
for (const bundle of bundles) {
  const src = asar.extractFile(asarPath, bundle.slice(1)).toString('utf8');
  const names = new Set();
  for (const m of src.matchAll(/\brequire\(\s*["']([^"'./][^"']*)["']\s*\)/g)) names.add(m[1]);
  for (const name of names) {
    if (builtins.has(name) || name.startsWith('node:')) continue;
    const pkg = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0];
    if (!files.has(`/node_modules/${pkg}/package.json`)) missing.push(`${bundle} requires "${name}" but /node_modules/${pkg} is not in app.asar`);
  }
}
if (missing.length) { console.error(`check-asar-deps: FAILED\n  ${missing.join('\n  ')}`); process.exit(1); }
console.log(`check-asar-deps: ok (${bundles.join(', ')})`);
