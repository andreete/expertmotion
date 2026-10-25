#!/usr/bin/env node
// Lays out the Generator Engine Binaries for the installer: resources/engines/<engine>/<version>/ (LOCAL_AI_MODELS.md §3.1).
// Reads packages/models/engines.json, downloads each official Windows x64 release once into a cache, verifies its sha256,
// extracts only the listed files and, where needed, copies the app-local Visual C++ runtime DLLs next to the executable
// (carved from Microsoft's redistributable), so the Creator installs nothing. Runs on the Linux build server and on Windows.
//
// Usage: node scripts/prepare-engines.mjs [--cache <dir>] [--out <dir>]
//   cache default: $EM_ENGINE_CACHE or ~/.cache/expertmotion-engines; out default: resources/engines
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const cache = path.resolve(arg('--cache') ?? process.env.EM_ENGINE_CACHE ?? path.join(os.homedir(), '.cache', 'expertmotion-engines'));
const out = path.resolve(arg('--out') ?? path.join(root, 'resources', 'engines'));
const spec = JSON.parse(fs.readFileSync(path.join(root, 'packages/models/engines.json'), 'utf8'));
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
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
}
function untarBz2(file, dest) { fs.mkdirSync(dest, { recursive: true }); run('tar', ['-xjf', file, '-C', dest]); }

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

fs.rmSync(out, { recursive: true, force: true });
let vc = null;
const report = [];
for (const e of spec.engines) {
  const archive = await fetchPinned(e.url, e.sha256);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'em-engine-'));
  if (archive.endsWith('.zip')) unzip(archive, tmp); else untarBz2(archive, tmp);
  const target = path.join(out, e.engine, e.version);
  const pats = e.keep.map(globRe);
  let n = 0;
  for (const rel of walk(tmp)) {
    if (e.strip && !rel.startsWith(e.strip)) continue;
    const inner = rel.slice(e.strip.length);
    if (!pats.some((re) => re.test(inner))) continue;
    const dst = path.join(target, ...inner.split('/'));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(tmp, ...rel.split('/')), dst);
    n++;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!n) throw new Error(`${e.engine}: no files matched ${e.keep.join(', ')} under "${e.strip}"`);
  // Licence texts the upstream licences require to travel with the binaries (pinned like the archives).
  for (const l of e.licences ?? []) fs.cpSync(await fetchPinned(l.url, l.sha256), path.join(target, 'LICENSES', l.file));
  if (e.sourceNotice) { fs.mkdirSync(path.join(target, 'LICENSES'), { recursive: true }); fs.appendFileSync(path.join(target, 'LICENSES', 'SOURCE.txt'), `${e.sourceNotice}\n`); }
  if (e.vcRuntime) {
    vc ??= vcRuntimeDlls(await fetchPinned(spec.vcRuntime.url, spec.vcRuntime.sha256), spec.vcRuntime.dlls);
    for (const [name, src] of vc.files) fs.copyFileSync(src, path.join(target, name));
  }
  report.push(`${e.engine} ${e.version}: ${n} file(s)${e.vcRuntime ? ' + VC++ runtime' : ''}`);
}
vc?.cleanup();
fs.writeFileSync(path.join(out, 'ENGINES.txt'), `Generator Engine Binaries (packages/models/engines.json), prepared ${new Date().toISOString()}\n${spec.engines.map((e) => `${e.engine} ${e.version} — ${e.licence} — ${e.url}`).join('\n')}\nVisual C++ runtime (app-local): ${spec.vcRuntime.url}\n`);
console.log(`prepare-engines: ${out}\n  ${report.join('\n  ')}`);
