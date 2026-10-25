// Bundles Expertmotion License Admin with esbuild (same approach as apps/desktop/scripts/build-main.mjs):
// main and preload to CommonJS for Electron (electron external), the renderer to one IIFE script, and
// copies index.html + styles.css. The license CLI library (tools/license-cli/src/lib) and
// @noble/ed25519 are bundled into dist/main.cjs, so the packaged app needs no node_modules.
// keys.mjs uses import.meta.url (repo-root check); in the CJS bundle it is defined from __filename.
// On the shared Linux server run it under scripts/run-capped.sh.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const dist = join(root, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'renderer'), { recursive: true });

const node = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  external: ['electron'],
  define: { 'process.env.EM_ADMIN_VERSION': JSON.stringify(pkg.version), 'import.meta.url': '__em_import_meta_url' },
  banner: { js: 'var __em_import_meta_url=require("node:url").pathToFileURL(__filename).href;' },
  logLevel: 'info',
};

await build({ ...node, entryPoints: [join(root, 'src/main.ts')], outfile: join(dist, 'main.cjs') });
// The preload runs in the sandboxed renderer, where only `electron` can be required: no banner, no node: built-ins.
const { banner: _mainOnly, define: { 'import.meta.url': _metaUrl, ...preloadDefine }, ...preloadOpts } = node;
await build({ ...preloadOpts, define: preloadDefine, entryPoints: [join(root, 'src/preload.ts')], outfile: join(dist, 'preload.cjs') });
const preloadRequires = [...readFileSync(join(dist, 'preload.cjs'), 'utf8').matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
if (preloadRequires.some((r) => r !== 'electron')) throw new Error(`preload.cjs requires ${preloadRequires.join(', ')}; a sandboxed preload may only require electron`);
await build({
  bundle: true, platform: 'browser', target: 'chrome140', format: 'iife', minify: true, sourcemap: false, logLevel: 'info',
  entryPoints: [join(root, 'src/renderer/app.ts')], outfile: join(dist, 'renderer', 'app.js'),
});
copyFileSync(join(root, 'src/renderer/index.html'), join(dist, 'renderer', 'index.html'));
copyFileSync(join(root, 'src/renderer/styles.css'), join(dist, 'renderer', 'styles.css'));
console.log(`built Expertmotion License Admin ${pkg.version} → dist/main.cjs, dist/preload.cjs, dist/renderer/`);
