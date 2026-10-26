#!/usr/bin/env node
// Lays out the Generator Engine Binaries for one target platform: resources/engines-<platform>-<arch>/<engine>/<version>/
// (LOCAL_AI_MODELS.md §3.1, DEPLOYMENT_AND_PACKAGING §17). Reads packages/models/engines.json, takes ONLY the entries of the target
// platform, downloads each official release once into a cache, verifies its sha256, extracts (zip, tar.gz, tar.bz2) only the listed
// files, keeps / sets the exec bit of every ELF and Mach-O image, and on Windows copies the app-local Visual C++ runtime DLLs next to
// the executables (carved from Microsoft's redistributable), so the Creator installs nothing. Every platform gets its own output
// folder with a PLATFORM.json marker, so stage-desktop can never stage another platform's engines. Entries without an official
// prebuilt (`source`: whisper.cpp on macOS) are built from the pinned tag + commit with CMake, only on a host of that platform.
//
// Usage: node scripts/prepare-engines.mjs [--platform=<win32|linux|darwin>] [--arch=<x64|arm64>] [--cache <dir>] [--out <dir>] [--spec <file>]
//   platform/arch default: the host; cache default: $EM_ENGINE_CACHE or ~/.cache/expertmotion-engines;
//   out default: resources/engines-<platform>-<arch>
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fixExecBits, foreignBinaries, platformInputs, selectEngineEntries, targetFromArgv } from './lib/platform.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const target = targetFromArgv(process.argv.slice(2));
const cache = path.resolve(arg('--cache') ?? process.env.EM_ENGINE_CACHE ?? path.join(os.homedir(), '.cache', 'expertmotion-engines'));
const out = path.resolve(arg('--out') ?? path.join(root, platformInputs(target).enginesDir));
const spec = JSON.parse(fs.readFileSync(path.resolve(arg('--spec') ?? path.join(root, 'packages/models/engines.json')), 'utf8'));
fs.mkdirSync(cache, { recursive: true });

const sha256File = (file) => {
  const h = createHash('sha256'), buf = Buffer.allocUnsafe(1 << 20), fd = fs.openSync(file, 'r');
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest('hex');
};

async function fetchPinned(url, sha256) {
  const file = path.join(cache, `${sha256.slice(0, 16)}-${path.basename(new URL(url).pathname)}`);
  if (fs.existsSync(file) && sha256File(file) === sha256) return file;
  console.log(`download ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} ${url}`);
  const tmp = `${file}.part`;
  const ws = fs.createWriteStream(tmp);
  for await (const chunk of res.body) if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
  await new Promise((r, j) => ws.end((e) => (e ? j(e) : r())));
  const got = sha256File(tmp);
  if (got !== sha256) { fs.rmSync(tmp, { force: true }); throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${got}`); }
  fs.renameSync(tmp, file);
  return file;
}

/** Minimal ZIP reader (stored + deflate) over the central directory: no external tool needed. */
function unzip(file, dest) {
  const b = fs.readFileSync(file);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`not a zip: ${file}`);
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32);
    const local = b.readUInt32LE(p + 42);
    const unixMode = (b.readUInt32LE(p + 38) >>> 16) & 0o777;           // external attributes, high 16 bits = st_mode (made on Unix)
    const name = b.subarray(p + 46, p + 46 + nlen).toString('utf8').replace(/\\/g, '/');
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;
    if (name.split('/').some((s) => s === '..') || path.isAbsolute(name)) throw new Error(`unsafe zip entry ${name}`);
    const dataStart = local + 30 + b.readUInt16LE(local + 26) + b.readUInt16LE(local + 28);
    const raw = b.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (!data) throw new Error(`unsupported zip method ${method} for ${name}`);
    const target = path.join(dest, ...name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    if (unixMode & 0o111) fs.chmodSync(target, 0o755);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}
/** tar.gz / tar.bz2 with the system tar (GNU tar on Linux, bsdtar on macOS and Windows 10+): modes, including exec bits, are kept. */
function untar(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  run('tar', [/\.(tgz|tar\.gz)$/.test(file) ? '-xzf' : '-xjf', file, '-C', dest]);
}
function extract(file, dest) {
  if (file.endsWith('.zip')) unzip(file, dest);
  else if (/\.(tgz|tar\.gz|tar\.bz2|tbz2)$/.test(file)) untar(file, dest);
  else throw new Error(`unsupported archive ${path.basename(file)}`);
}

/**
 * Engines without an official prebuilt for this platform (engines.json `source`): shallow clone of the pinned tag, the commit is
 * checked, then a CMake build of one target. Runs only on a host of the target platform (a macOS binary is built on a Mac).
 */
function buildFromSource(e, dest) {
  if (process.platform !== target.platform) throw new Error(`${e.engine} for ${target.platform} has no official prebuilt and must be built from source on a ${target.platform} host (engines.json "source"); run this on that platform`);
  const src = path.join(cache, `src-${e.engine}-${e.source.commit.slice(0, 12)}`);
  if (!fs.existsSync(path.join(src, '.git'))) { fs.rmSync(src, { recursive: true, force: true }); run('git', ['clone', '--depth', '1', '--branch', e.source.tag, e.source.repo, src]); }
  const head = spawnSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (head !== e.source.commit) throw new Error(`${e.engine}: tag ${e.source.tag} is at ${head}, engines.json pins ${e.source.commit}`);
  const build = path.join(src, `build-${target.platform}-${target.arch}`);
  const osxArch = target.platform === 'darwin' ? [`-DCMAKE_OSX_ARCHITECTURES=${target.arch === 'arm64' ? 'arm64' : 'x86_64'}`] : [];
  run('cmake', ['-S', src, '-B', build, ...e.source.cmake, ...osxArch]);
  run('cmake', ['--build', build, '--config', 'Release', '--target', e.source.target, '-j', String(Math.max(1, os.cpus().length - 1))]);
  fs.mkdirSync(dest, { recursive: true });
  for (const o of e.source.outputs) fs.copyFileSync(path.join(build, ...o.split('/')), path.join(dest, path.basename(o)));
}

/** CAB extraction: Windows' own expand.exe, else 7-Zip (electron-builder's cached 7zz, or 7z/7zz/cabextract on PATH). */
function extractCab(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (process.platform === 'win32') { run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'expand.exe'), [file, '-F:*', dest]); return; }
  const cached = (() => { try { const d = path.join(os.homedir(), '.cache', 'electron-builder'); for (const e of fs.readdirSync(d)) if (e.startsWith('7zip')) for (const s of fs.readdirSync(path.join(d, e))) { const c = path.join(d, e, s, 'bin', '7zz'); if (fs.existsSync(c)) return c; } } catch { /* none */ } return null; })();
  for (const tool of [cached, '7zz', '7z'].filter(Boolean)) { const r = spawnSync(tool, ['x', '-y', `-o${dest}`, file], { stdio: 'ignore' }); if (r.status === 0) return; }
  run('cabextract', ['-q', '-d', dest, file]);
}

/** The redistributable is a WiX Burn bundle: carve its attached CAB container, then the runtime CAB inside it. */
function vcRuntimeDlls(exe, wanted) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'em-vcrt-'));
  const d = fs.readFileSync(exe);
  const cabs = [];
  for (let i = d.indexOf('MSCF\0\0\0\0'); i >= 0; i = d.indexOf('MSCF\0\0\0\0', i + 4)) {
    const size = d.readUInt32LE(i + 8);
    if (size > 0 && size <= d.length - i) cabs.push(d.subarray(i, i + size));
  }
  const found = new Map();
  const scan = (dir, depth) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p, depth); continue; }
      const base = e.name.toLowerCase().replace(/_amd64$/, '');
      if (wanted.includes(base) && !found.has(base)) found.set(base, p);
      else if (depth < 3 && fs.readFileSync(p).subarray(0, 4).toString('latin1') === 'MSCF') { const sub = `${p}.x`; try { extractCab(p, sub); scan(sub, depth + 1); } catch { /* not a runtime cab */ } }
    }
  };
  cabs.forEach((c, n) => { const f = path.join(work, `c${n}.cab`); fs.writeFileSync(f, c); extractCab(f, path.join(work, `c${n}`)); });
  scan(work, 0);
  const missing = wanted.filter((w) => !found.has(w));
  if (missing.length) throw new Error(`Visual C++ runtime DLLs not found in the redistributable: ${missing.join(', ')}`);
  return { files: found, cleanup: () => fs.rmSync(work, { recursive: true, force: true }) };
}

const globRe = (g) => new RegExp(`^${g.split('**').map((s) => s.split('*').map((t) => t.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')).join('.*')}$`, 'i');
const walk = (dir, base = dir, acc = []) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p, base, acc); else acc.push(path.relative(base, p).split(path.sep).join('/')); } return acc; };

const entries = selectEngineEntries(spec, target);
if (!entries.length) throw new Error(`engines.json has no entry for ${target.platform}-${target.arch}`);
const forbidden = entries.filter((e) => e.vcRuntime && target.platform !== 'win32');
if (forbidden.length) throw new Error(`Visual C++ runtime requested for ${target.platform} (${forbidden.map((e) => e.engine).join(', ')}): Windows only`);

fs.rmSync(out, { recursive: true, force: true });
let vc = null;
const report = [];
for (const e of entries) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-engine-'));
  if (e.source) buildFromSource(e, tmp);
  else extract(await fetchPinned(e.url, e.sha256), tmp);
  const target_ = path.join(out, e.engine, e.version);
  const pats = e.keep.map(globRe);
  const strip = e.strip ?? '';
  let n = 0;
  for (const rel of walk(tmp)) {
    if (strip && !rel.startsWith(strip)) continue;
    const inner = rel.slice(strip.length);
    if (!pats.some((re) => re.test(inner))) continue;
    // flatten: bin/ and lib/ of one archive land side by side (the executables' RPATH / LC_RPATH starts with $ORIGIN / @loader_path)
    const dst = path.join(target_, ...(e.flatten ? [path.posix.basename(inner)] : inner.split('/')));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(tmp, ...rel.split('/')), dst);    // follows symlinks: a soname link becomes the real library under that name
    n++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!n) throw new Error(`${e.engine}: no files matched ${e.keep.join(', ')} under "${strip}"`);
  for (const x of e.executables ?? []) if (!fs.existsSync(path.join(target_, x))) throw new Error(`${e.engine}: executable ${x} missing after extraction`);
  // Licence texts the upstream licences require to travel with the binaries (pinned like the archives).
  for (const l of e.licences ?? []) { fs.mkdirSync(path.join(target_, 'LICENSES'), { recursive: true }); fs.cpSync(await fetchPinned(l.url, l.sha256), path.join(target_, 'LICENSES', l.file)); }
  if (e.sourceNotice) { fs.mkdirSync(path.join(target_, 'LICENSES'), { recursive: true }); fs.appendFileSync(path.join(target_, 'LICENSES', 'SOURCE.txt'), `${e.sourceNotice}\n`); }
  if (e.vcRuntime) {
    vc ??= vcRuntimeDlls(await fetchPinned(spec.vcRuntime.url, spec.vcRuntime.sha256), spec.vcRuntime.dlls);
    for (const [name, src] of vc.files) fs.copyFileSync(src, path.join(target_, name));
  }
  report.push(`${e.engine} ${e.version}: ${n} file(s)${e.vcRuntime ? ' + VC++ runtime' : ''}${e.source ? ' (built from source)' : ''}`);
}
vc?.cleanup();
// POSIX: every ELF / Mach-O image must be executable (zip archives made on Windows carry no mode bits).
const fixed = target.platform === 'win32' ? 0 : fixExecBits(out);
// Never hand another platform's binaries to this platform's package.
const foreign = foreignBinaries(out, target);
if (foreign.length) throw new Error(`prepare-engines: files that do not belong to ${target.platform}-${target.arch}:\n  ${foreign.slice(0, 10).join('\n  ')}`);
fs.writeFileSync(path.join(out, 'PLATFORM.json'), `${JSON.stringify({ platform: target.platform, arch: target.arch }, null, 2)}\n`);
fs.writeFileSync(path.join(out, 'ENGINES.txt'), `Generator Engine Binaries for ${target.platform}-${target.arch} (packages/models/engines.json), prepared ${new Date().toISOString()}\n`
  + `${entries.map((e) => `${e.engine} ${e.version} — ${e.licence} — ${e.url ?? `${e.source.repo} ${e.source.tag} (${e.source.commit})`}`).join('\n')}\n`
  + (entries.some((e) => e.vcRuntime) ? `Visual C++ runtime (app-local): ${spec.vcRuntime.url}\n` : ''));
console.log(`prepare-engines: ${target.platform}-${target.arch} → ${out}${fixed ? ` (exec bit set on ${fixed} file(s))` : ''}\n  ${report.join('\n  ')}`);
