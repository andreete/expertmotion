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
 *   4. Integrity manifest: sha256 of service.jsc, the engine bundle index, the Chrome Headless Shell
 *      and compositor executables (resources/engine/chrome, resources/engine/compositor; SEC-061) and
 *      resources/bin binaries, signed Ed25519 with the release key; public key embedded in the bytecode.
 *      The release key comes from EM_RELEASE_PRIVATE_KEY_PEM; without it the script FAILS (a release
 *      must never be signed with a throwaway key). `--dry-run` alone allows an ephemeral key for a
 *      local rehearsal, and the output is then not shippable.
 *
 * Dry run on Linux: `node scripts/harden.mjs --plan` prints the plan (bytecode steps marked skipped
 * off-Windows) without touching files.
 */
import { build } from 'esbuild';
import { createHash, generateKeyPairSync, randomBytes, sign as edSign, createCipheriv } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
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
const dryRun = args.has('--dry-run');
// Release safety: refuse early (before any file is touched) when the release key is missing.
if (!planOnly && flags.integrity && !process.env.EM_RELEASE_PRIVATE_KEY_PEM && !dryRun) {
  console.error('harden: EM_RELEASE_PRIVATE_KEY_PEM is not set. The integrity manifest must be signed with the Operator\'s release key.\n'
    + '  Set EM_RELEASE_PRIVATE_KEY_PEM (and EM_ENGINE_PUBLIC_KEY_B64), or pass --dry-run for a local rehearsal (output not shippable).');
  process.exit(2);
}

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

// Streams in 1 MB chunks: Chrome Headless Shell and the compositor DLLs are hundreds of MB, and reading them whole
// pushed the 1.9 GB build server into the OOM killer.
function sha256(file) {
  const hash = createHash('sha256'), buf = Buffer.allocUnsafe(1 << 20), fd = openSync(file, 'r');
  try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return hash.digest('hex');
}
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
      // The Service checks the Engine bundle against resources/engine-manifest.json (EM-3003), which stage-desktop wrote
      // before obfuscation: re-hash every bundle file so the manifest describes what ships.
      if (target === 'engine') {
        const mf = join(root, 'resources/engine-manifest.json');
        const manifest = JSON.parse(readFileSync(mf, 'utf8'));
        let refreshed = 0;
        for (const entry of manifest.files) {
          if (!entry.path.startsWith('engine/bundle/')) continue;
          const abs = join(root, 'resources', ...entry.path.split('/'));
          const digest = sha256(abs), size = statSync(abs).size;
          if (digest !== entry.sha256 || size !== entry.size) { entry.sha256 = digest; entry.size = size; refreshed += 1; }
        }
        writeFileSync(mf, JSON.stringify(manifest, null, 2));
        console.log(`obfuscate: engine-manifest.json re-hashed (${refreshed} bundle file(s) changed)`);
      }
      console.log(`obfuscate: ${target} bundle processed`);
      break;
    }
    case 'encrypt:prompts': {
      // The release service build (npm run build:release -w @expertmotion/service) already moved the prompts
      // into dist/service/assets.enc with a split key (apps/service/src/services/prompt-assets.ts). Verify it.
      const enc = join(root, 'dist/service/assets.enc');
      const svc = readFileSync(join(root, 'dist/service/service.cjs'), 'utf8');
      const main = readFileSync(join(root, 'dist/main.cjs'), 'utf8');
      if (!existsSync(enc)) throw new Error('encrypt:prompts: dist/service/assets.enc missing (run build:release for the service, then stage)');
      if (svc.includes('You are the Editor Agent') || svc.includes('You are the Brainstorming Agent')) throw new Error('encrypt:prompts: prompt text found in service.cjs');
      const halfBFile = join(repoRoot, 'apps/service/dist/prompt-half-b.hex');
      if (!existsSync(halfBFile) || !main.includes(readFileSync(halfBFile, 'utf8').trim())) throw new Error('encrypt:prompts: main.cjs does not carry this build\'s prompt key half (rebuild main after build:release)');
      console.log('encrypt:prompts: verified (assets.enc present, no prompt text in service.cjs)');
      break;
    }
    case 'integrity:manifest': {
      const entries = [];
      const add = (abs, logical) => { if (existsSync(abs)) entries.push({ path: logical, sha256: sha256(abs), bytes: statSync(abs).size }); };
      add(join(root, 'dist/service/service.jsc'), 'dist/service/service.jsc');
      add(join(root, 'dist/service/service.cjs'), 'dist/service/service.cjs');
      add(join(root, 'dist/service/assets.enc'), 'dist/service/assets.enc');
      add(join(root, 'resources/engine/bundle/index.html'), 'engine/bundle/index.html');
      add(join(root, 'resources/engine-manifest.json'), 'engine-manifest.json');   // the Service's per-file Engine check (EM-3003)
      // SEC-061: the Engine executables the Service spawns (Chrome Headless Shell, compositor + its FFmpeg).
      for (const sub of ['chrome', 'compositor']) {
        const base = join(root, 'resources/engine', sub);
        for (const f of listBinaries(base).filter((f) => lib.isEngineExecutable(f))) add(f, `engine/${sub}/${relative(base, f).split(/[\\/]/).join('/')}`);
      }
      for (const bin of listBinaries(join(root, 'resources/bin'))) add(bin, `bin/${relative(join(root, 'resources/bin'), bin).split(/[\\/]/).join('/')}`);
      const manifest = lib.buildManifest({ appVersion: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, builtAt: new Date().toISOString(), entries });

      // Ed25519 signature with the release key. On the build machine the private key is supplied via
      // EM_RELEASE_PRIVATE_KEY_PEM; here we generate an ephemeral pair for a local dry run.
      let privPem = process.env.EM_RELEASE_PRIVATE_KEY_PEM;
      let pubB64 = process.env.EM_ENGINE_PUBLIC_KEY_B64;
      if (!privPem) {
        if (!dryRun) throw new Error('integrity: EM_RELEASE_PRIVATE_KEY_PEM missing (checked at start; pass --dry-run for a rehearsal)');
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
