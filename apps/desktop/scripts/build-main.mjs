// Bundles the Desktop Shell main and preload processes to CommonJS with esbuild (DEPLOYMENT §2,
// BLUEPRINT §2.2). electron is external (provided by the runtime). Outputs dist/main.cjs and
// dist/preload.cjs, both minified with no source maps (SEC-130). Build constants are injected with
// `define`: the pinned update feed URL (SEC-096) and the embedded Ed25519 public key (SEC-045,
// integrity verification). On Linux this runs under scripts/run-capped.sh (README).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const feedUrl = process.env.EM_FEED_URL ?? 'https://updates.expertmotion.example/win';
const enginePublicKey = process.env.EM_ENGINE_PUBLIC_KEY_B64 ?? '';

const define = {
  __EM_FEED_URL__: JSON.stringify(feedUrl),
  __EM_ENGINE_PUBLIC_KEY_B64__: JSON.stringify(enginePublicKey),
  'process.env.EM_APP_VERSION': JSON.stringify(pkg.version),
};

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  external: ['electron', 'electron-updater'],
  define,
  logLevel: 'info',
};

await build({ ...common, entryPoints: [join(root, 'src/main.ts')], outfile: join(root, 'dist/main.cjs') });
await build({ ...common, entryPoints: [join(root, 'src/preload.ts')], outfile: join(root, 'dist/preload.cjs') });

console.log('built dist/main.cjs and dist/preload.cjs');
