// Bundles the Local Service into one CommonJS file (dist/service.cjs). Native addons stay external and ship unpacked.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/service.cjs',
  external: ['better-sqlite3-multiple-ciphers', '@remotion/renderer', '@remotion/compositor-*', 'systeminformation', 'electron'],
  conditions: ['source'], sourcemap: false, minify: process.env.EM_MINIFY !== '0', legalComments: 'none',
  define: { 'import.meta.url': '__em_import_meta_url' }, banner: { js: 'const __em_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  loader: { '.sql': 'text' }, logLevel: 'info',
});
