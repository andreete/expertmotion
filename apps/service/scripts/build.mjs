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

// Operator model CDN (Cloudflare R2 custom domain; DEPLOYMENT_AND_PACKAGING.md §16): https only. Unset → the placeholder, which
// src/services/model-cdn.ts treats as "no CDN" (development) and scripts/release-check.mjs refuses for a release.
const MODEL_CDN_PLACEHOLDER = 'PLACEHOLDER_SET_EM_MODEL_CDN_URL';
const modelCdnUrl = (() => {
  const raw = (process.env.EM_MODEL_CDN_URL ?? '').trim();
  if (!raw) return MODEL_CDN_PLACEHOLDER;
  let u;
  try { u = new URL(raw); } catch { throw new Error(`EM_MODEL_CDN_URL is not a URL: ${raw}`); }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.port || !u.hostname.includes('.') || /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname))
    throw new Error(`EM_MODEL_CDN_URL must be https://<host name>[/path] without credentials, port, query or fragment: ${raw}`);
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
})();
console.log(`model CDN: ${modelCdnUrl === MODEL_CDN_PLACEHOLDER ? 'not set (placeholder; development build)' : modelCdnUrl}`);

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


// Operator public keys (hex, 32-byte Ed25519) injected at build time so a release never needs a source edit:
// EM_LICENSE_PUBLIC_KEY_A1_HEX (licence keys, LICENSE_OPERATIONS §4) and EM_MANIFEST_PUBLIC_KEY_M1_HEX (models.json, SEC-072).
// Unset = the source constants (placeholders until the Operator pastes keys). Only PUBLIC keys ever go here.
const pubKeyFromEnv = (name) => {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v && !/^[0-9a-f]{64}$/.test(v)) { console.error(`${name} must be 64 hex characters (an Ed25519 public key)`); process.exit(1); }
  return v;
};
const licenceKeyHex = pubKeyFromEnv('EM_LICENSE_PUBLIC_KEY_A1_HEX');
const manifestKeyHex = pubKeyFromEnv('EM_MANIFEST_PUBLIC_KEY_M1_HEX');
if (licenceKeyHex) console.log('licence public key A1 injected from EM_LICENSE_PUBLIC_KEY_A1_HEX');
if (manifestKeyHex) console.log('manifest public key M1 injected from EM_MANIFEST_PUBLIC_KEY_M1_HEX');

await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'node', target: 'node22', format: 'cjs', outfile: 'dist/service.cjs',
  external: ['better-sqlite3-multiple-ciphers', '@remotion/renderer', '@remotion/compositor-*', 'systeminformation', 'electron'],
  conditions: ['source'], sourcemap: false, minify: process.env.EM_MINIFY !== '0', legalComments: 'none',
  define: { 'import.meta.url': '__em_import_meta_url', EM_BUILD_DATE: JSON.stringify(process.env.EM_BUILD_DATE ?? new Date().toISOString().slice(0, 10)), __EM_PROMPT_HALF_A__: JSON.stringify(halfA), __EM_MODEL_CDN_URL__: JSON.stringify(modelCdnUrl), __EM_LICENSE_PUBLIC_KEY_A1_HEX__: JSON.stringify(licenceKeyHex), __EM_MANIFEST_PUBLIC_KEY_M1_HEX__: JSON.stringify(manifestKeyHex) }, banner: { js: 'const __em_import_meta_url = require("url").pathToFileURL(__filename).href;' },
  loader: { '.sql': 'text' }, logLevel: 'info', plugins,
});

if (encrypt) {
  const out = fs.readFileSync(path.join(dist, 'service.cjs'), 'utf8');
  if (out.includes('You are the Editor Agent') || out.includes('You are the Brainstorming Agent')) throw new Error('encrypt-prompts: prompt text still present in service.cjs');
  console.log('prompts: encrypted to dist/assets.enc; half B in dist/prompt-half-b.hex (for build:main)');
}
