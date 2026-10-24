/**
 * Hardening stage (coordinator items 1–4; ADR-007, SEC-130…134). Thin orchestrator: the pure
 * planning/config lives in src/lib/{harden-plan,obfuscation,integrity}.ts and is unit-tested on
 * Linux. This script compiles those modules with esbuild, then runs the heavy steps.
 *
 * Honest boundary: these layers make reverse engineering slow and costly; they cannot make it
 * impossible for someone who owns the device and attaches a debugger (README "Protection layers").
 *
 * Steps:
 *   1. V8 bytecode (bytenode) for dist/service/service.cjs → service.jsc (+ loader) AND
 *      dist/main.cjs → main.jsc. Compiled with the pinned Electron via ELECTRON_RUN_AS_NODE on the
 *      Windows build machine; the RunAsNode fuse is flipped AFTER (afterPack.cjs). Excludes the
 *      Remotion/engine path (served to Chrome, needs Function.prototype.toString). [UNVERIFIED on
 *      Electron >= 42 → POC-006]. Escape hatch: --no-bytecode.
 *   2. javascript-obfuscator on apps/ui/dist/*.js (debugProtection on) and
 *      resources/engine/bundle/*.js (debugProtection off, headless). Render-safe options.
 *   3. AES-256-GCM encryption of the prompts module; key split across the service bytecode and a
 *      build constant (src/lib/keysplit.ts). Decrypted in memory only.
 *   4. Integrity manifest: sha256 of service.jsc, the engine bundle index and resources/bin
 *      binaries, signed Ed25519 with the release key; public key embedded in the bytecode.
 *
 * Dry run on Linux: `node scripts/harden.mjs --plan` prints the plan (bytecode steps marked skipped
 * off-Windows) without touching files.
 */
import { build } from 'esbuild';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(root, '..', '..');
const args = new Set(process.argv.slice(2));
const flags = {
  bytecode: !args.has('--no-bytecode'),
  obfuscate: !args.has('--no-obfuscate'),
  encryptPrompts: !args.has('--no-encrypt'),
  integrity: !args.has('--no-integrity'),
  isWindows: process.platform === 'win32',
};
const planOnly = args.has('--plan');

// Compile the pure planning/config modules so this JS script can import them.
async function loadLib() {
  const outfile = join(mkdtempSync(join(tmpdir(), 'em-harden-')), 'lib.mjs');
  await build({ entryPoints: [join(root, 'src/lib/index.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
  return import(pathToFileURL(outfile).href);
}

const lib = await loadLib();
const steps = lib.planHardening(flags);

console.log('Hardening plan:');
for (const s of steps) console.log(`  [${s.skipped ? 'skip' : ' run'}] ${s.id} — ${s.description}${s.skipReason ? ` (${s.skipReason})` : ''}`);
if (planOnly) { console.log('\n--plan: no files changed.'); process.exit(0); }

function sha256(file) { return createHash('sha256').update(readFileSync(file)).digest('hex'); }
function listJs(dir) { return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => join(dir, f)) : []; }

for (const step of steps) {
  if (step.skipped) { console.log(`skip ${step.id}: ${step.skipReason}`); continue; }
  switch (step.id) {
    case 'bytecode:service':
    case 'bytecode:main': {
      // Runs only on Windows (planHardening marks it skipped elsewhere). Imported lazily so the
      // Linux dry run never requires bytenode to load the native V8 path.
      const bytenode = (await import('bytenode')).default;
      const isMain = step.id === 'bytecode:main';
      const srcFile = isMain ? join(root, 'dist/main.cjs') : join(root, 'dist/service/service.cjs');
      const outFile = srcFile.replace(/\.cjs$/, '.jsc');
      const code = readFileSync(srcFile, 'utf8');
      const compiled = isMain
        ? await bytenode.compileElectronMainCode(code, { electronPath: process.env.EM_ELECTRON_PATH })
        : await bytenode.compileElectronCode(code, { electronPath: process.env.EM_ELECTRON_PATH });
      writeFileSync(outFile, compiled);
      // Tiny loader that `require`s the .jsc (bytenode registers the .jsc extension on import).
      writeFileSync(srcFile, `require('bytenode');\nmodule.exports = require('./${join(outFile).split(/[\\/]/).pop()}');\n`);
      console.log(`bytecode: ${relative(root, outFile)} written`);
      break;
    }
    case 'obfuscate:editor':
    case 'obfuscate:engine': {
      const JsObfuscator = (await import('javascript-obfuscator')).default;
      const target = step.id === 'obfuscate:editor' ? 'editor' : 'engine';
      const dir = target === 'editor' ? join(root, 'dist/ui/assets') : join(root, 'resources/engine/bundle');
      const cfg = lib.obfuscationConfig(target);
      if (!lib.isRenderSafe(cfg)) throw new Error(`${target} obfuscation config is not render-safe`);
      // EM_OBFUSCATE_MAX_BYTES: low-memory hosts (the 1.9 GB Linux server) skip the largest chunks; unset on the build machine.
      const maxBytes = Number(process.env.EM_OBFUSCATE_MAX_BYTES ?? Infinity);
      for (const file of listJs(dir)) {
        if (statSync(file).size > maxBytes) { console.log(`obfuscate: ${target} ${relative(root, file)} skipped (larger than EM_OBFUSCATE_MAX_BYTES)`); continue; }
        const out = JsObfuscator.obfuscate(readFileSync(file, 'utf8'), cfg).getObfuscatedCode();
        writeFileSync(file, out);
      }
      console.log(`obfuscate: ${target} bundle processed`);
      break;
    }
    case 'encrypt:prompts': {
      // Key split: half in the (bytecode) service build constant, half here. Both 32 bytes.
      const halfA = process.env.EM_PROMPT_KEY_HALF_A || randomBytes(32).toString('hex');
      const halfB = process.env.EM_PROMPT_KEY_HALF_B || randomBytes(32).toString('hex');
      const key = lib.deriveAssetKey(halfA, halfB, (buf) => new Uint8Array(createHash('sha256').update(buf).digest()));
      const promptsFile = join(root, 'dist/service/prompts.json');
      if (!existsSync(promptsFile)) { console.log('encrypt:prompts: no prompts.json yet (service build pending); skipping payload'); break; }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', Buffer.from(key), iv);
      const enc = Buffer.concat([cipher.update(readFileSync(promptsFile)), cipher.final()]);
      const tag = cipher.getAuthTag();
      writeFileSync(join(root, 'dist/service/assets.enc'), Buffer.concat([iv, tag, enc]));
      console.log('encrypt:prompts: assets.enc written (key split A/B; combined in service memory only)');
      break;
    }
    case 'integrity:manifest': {
      const entries = [];
      const add = (abs, logical) => { if (existsSync(abs)) entries.push({ path: logical, sha256: sha256(abs), bytes: statSync(abs).size }); };
      add(join(root, 'dist/service/service.jsc'), 'dist/service/service.jsc');
      add(join(root, 'dist/service/service.cjs'), 'dist/service/service.cjs');
      add(join(root, 'resources/engine/bundle/index.html'), 'engine/bundle/index.html');
      for (const bin of listBinaries(join(root, 'resources/bin'))) add(bin, `bin/${relative(join(root, 'resources/bin'), bin).split(/[\\/]/).join('/')}`);
      const manifest = lib.buildManifest({ appVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, builtAt: new Date().toISOString(), entries });

      // Ed25519 signature with the release key. On the build machine the private key is supplied via
      // EM_RELEASE_PRIVATE_KEY_PEM; here we generate an ephemeral pair for a local dry run.
      let privPem = process.env.EM_RELEASE_PRIVATE_KEY_PEM;
      let pubB64 = process.env.EM_ENGINE_PUBLIC_KEY_B64;
      if (!privPem) {
        const pair = generateKeyPairSync('ed25519');
        privPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
        pubB64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
        console.log('integrity: generated ephemeral release key (DRY RUN — not for shipping)');
      }
      const sig = edSign(null, Buffer.from(lib.canonicalManifestBytes(manifest)), privPem).toString('base64');
      const signed = { manifest, signature: sig, alg: 'ed25519' };
      mkdirSync(join(root, 'resources'), { recursive: true });
      writeFileSync(join(root, 'resources/integrity-manifest.json'), JSON.stringify(signed, null, 2));
      writeFileSync(join(root, 'resources/integrity-pubkey.txt'), pubB64 ?? '');
      console.log(`integrity: manifest signed over ${entries.length} entries; embed EM_ENGINE_PUBLIC_KEY_B64 in the main bundle`);
      break;
    }
    default: throw new Error(`unknown step ${step.id}`);
  }
}

function listBinaries(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listBinaries(p));
    else out.push(p);
  }
  return out;
}

console.log('harden: done');
