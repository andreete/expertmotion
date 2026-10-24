// Bundles the Local Service into one CommonJS file (dist/service.cjs). Native addons stay external and ship unpacked.
// --encrypt-prompts (release builds, SEC-133): the prompt strings are replaced by empty stubs in the bundle and
// written AES-256-GCM encrypted to dist/assets.enc (src/services/prompt-assets.ts). Key = sha256(A xor B): half A
// is injected here, half B goes to dist/prompt-half-b.hex for the Desktop Shell build (never staged or shipped).
import { build } from 'esbuild';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const encrypt = process.argv.includes('--encrypt-prompts');
const dist = path.resolve('dist');
const generated = path.resolve('../../packages/agents/src/prompts.generated.ts');
for (const f of ['assets.enc', 'prompt-half-b.hex']) fs.rmSync(path.join(dist, f), { force: true });

let halfA = '';
const plugins = [];
if (encrypt) {
  // Evaluate the generated module to get the real strings.
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'em-prompts-')), 'prompts.cjs');
  await build({ entryPoints: [generated], bundle: true, platform: 'node', format: 'cjs', outfile: tmp, logLevel: 'silent' });
  const real = createRequire(import.meta.url)(tmp);
  fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  const set = { BRAINSTORM_SYSTEM: real.BRAINSTORM_SYSTEM, EDITOR_SYSTEM: real.EDITOR_SYSTEM, SOCIAL_CAPTION_PROMPT: real.SOCIAL_CAPTION_PROMPT };
  for (const [k, v] of Object.entries(set)) if (typeof v !== 'string' || v === '') throw new Error(`prompts.generated: ${k} missing`);

  halfA = crypto.randomBytes(32).toString('hex');
  const halfB = crypto.randomBytes(32).toString('hex');
  const a = Buffer.from(halfA, 'hex'); const b = Buffer.from(halfB, 'hex');
  const key = crypto.createHash('sha256').update(Buffer.from(a.map((x, i) => x ^ b[i]))).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(set), 'utf8'), c.final()]);
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'assets.enc'), Buffer.concat([iv, c.getAuthTag(), enc]));
  fs.writeFileSync(path.join(dist, 'prompt-half-b.hex'), halfB, { mode: 0o600 });

  const stub = `export const PROMPT_SET_VERSION = ${JSON.stringify(real.PROMPT_SET_VERSION)};\nexport const BRAINSTORM_SYSTEM = "";\nexport const EDITOR_SYSTEM = "";\nexport const SOCIAL_CAPTION_PROMPT = "";\n`;
  plugins.push({
    name: 'stub-prompts',
    setup(b) {
      b.onLoad({ filter: /prompts\.generated\.ts$/ }, () => ({ contents: stub, loader: 'ts' }));
    },
  });
}

await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/service.cjs',
  external: ['better-sqlite3-multiple-ciphers', '@remotion/renderer', '@remotion/compositor-*', 'systeminformation', 'electron'],
  conditions: ['source'], sourcemap: false, minify: process.env.EM_MINIFY !== '0', legalComments: 'none',
  define: { 'import.meta.url': '__em_import_meta_url', EM_BUILD_DATE: JSON.stringify(process.env.EM_BUILD_DATE ?? new Date().toISOString().slice(0, 10)), __EM_PROMPT_HALF_A__: JSON.stringify(halfA) }, banner: { js: 'const __em_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  loader: { '.sql': 'text' }, logLevel: 'info', plugins,
});

if (encrypt) {
  const out = fs.readFileSync(path.join(dist, 'service.cjs'), 'utf8');
  if (out.includes('You are the Editor Agent') || out.includes('You are the Brainstorming Agent')) throw new Error('encrypt-prompts: prompt text still present in service.cjs');
  console.log('prompts: encrypted to dist/assets.enc; half B in dist/prompt-half-b.hex (for build:main)');
}
