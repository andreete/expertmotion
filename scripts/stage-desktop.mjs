#!/usr/bin/env node
// Stages every build output where apps/desktop/electron-builder.config.cjs expects it (DEPLOYMENT_AND_PACKAGING §3, §17), for ONE
// target platform and architecture. Usage: node scripts/stage-desktop.mjs [--check] [--platform=<win32|linux|darwin>] [--arch=<x64|arm64>]
//   apps/service/dist/service.cjs        → apps/desktop/dist/service/service.cjs
//   apps/service/dist/assets.enc         → apps/desktop/dist/service/assets.enc (encrypted prompts; prompt-half-b.hex is never staged)
//   apps/ui/dist/**                      → apps/desktop/dist/ui/**
//   resources/engine/bundle/**           → apps/desktop/resources/engine/bundle/**
//   resources/catalogue/<category>/*.webm (build-loops) → apps/desktop/dist/ui/catalogue/** (served over app:// with the Editor)
//   node_modules/.remotion/chrome-headless-shell/<win64|linux64|mac-arm64|mac-x64>/<dir>/** → apps/desktop/resources/engine/chrome/**
//   node_modules/@remotion/compositor-<platform>-<arch>[-gnu|-msvc]/**                   → apps/desktop/resources/engine/compositor/**
//   resources/sample/** (onboarding Sample Project, CC0; node packages/engine/scripts/build-sample.mjs) → apps/desktop/resources/sample/**
//   resources/bin-<platform>-<arch>/** (full LGPL FFmpeg + ffprobe for ingestion, ADR-019; placed by the Operator; Windows falls back
//     to resources/bin)                → apps/desktop/resources/bin/**
//   resources/engines-<platform>-<arch>/** (node scripts/prepare-engines.mjs --platform=<p>) → apps/desktop/resources/engines/**
// Platform guard ("jangan sampai salah alamat"): every staged executable image must match the target (no PE/.exe/.dll in a Linux or
// macOS package, no ELF/Mach-O in a Windows one, no ELF of another CPU), the engines tree must carry the target's PLATFORM.json, and
// FFmpeg/ffprobe must exist under the target's file names. POSIX targets get the exec bit on every ELF / Mach-O image.
// Writes resources/engine-manifest.json (sha256 of every staged engine file) and THIRD_PARTY_NOTICES.txt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fixExecBits, foreignBinaries, platformInputs, targetFromArgv } from './lib/platform.mjs';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const desk = path.join(root, 'apps', 'desktop');
const check = process.argv.includes('--check');
// --platform/--arch stage another host's binaries (scripts/cross-build-win.sh, scripts/build-linux.sh, scripts/build-mac.sh).
const target = targetFromArgv(process.argv.slice(2));
const plat = platformInputs(target);
const problems = [];
const need = (p, what) => { if (!fs.existsSync(p)) problems.push(`${what} missing: ${path.relative(root, p)}`); return p; };

const chromeBase = path.join(root, 'node_modules', '.remotion', 'chrome-headless-shell', plat.chromeDir);
const chromeDir = fs.existsSync(chromeBase) ? (fs.readdirSync(chromeBase).map((d) => path.join(chromeBase, d)).find((d) => fs.statSync(d).isDirectory()) ?? chromeBase) : chromeBase;
const binDir = plat.binDirs.map((d) => path.join(root, d)).find((d) => fs.existsSync(d)) ?? path.join(root, plat.binDirs[0]);
const enginesDir = path.join(root, plat.enginesDir);
const plan = [
  [need(path.join(root, 'apps/service/dist/service.cjs'), 'service bundle (npm run build -w @expertmotion/service)'), path.join(desk, 'dist/service/service.cjs')],
  [need(path.join(root, 'apps/service/dist/assets.enc'), 'encrypted prompts (npm run build:release -w @expertmotion/service)'), path.join(desk, 'dist/service/assets.enc')],
  [need(path.join(root, 'apps/ui/dist'), 'Editor build (npm run build -w @expertmotion/ui)'), path.join(desk, 'dist/ui')],
  [need(path.join(root, 'resources/catalogue'), 'catalogue loops (node packages/engine/scripts/build-loops.mjs)'), path.join(desk, 'dist/ui/catalogue')],
  [need(path.join(root, 'resources/engine/bundle'), 'Engine bundle (npm run build:bundle -w @expertmotion/engine)'), path.join(desk, 'resources/engine/bundle')],
  [need(chromeDir, `Chrome Headless Shell ${plat.chromeDir} (npx remotion browser ensure on that platform, or Chrome for Testing)`), path.join(desk, 'resources/engine/chrome')],
  [need(path.join(root, 'node_modules/@remotion', plat.compositorPackage), `Remotion compositor @remotion/${plat.compositorPackage} (npm pack of the pinned version)`), path.join(desk, 'resources/engine/compositor')],
  [need(path.join(root, 'resources/sample'), 'Sample Project media (node packages/engine/scripts/build-sample.mjs)'), path.join(desk, 'resources/sample')],
  [need(binDir, `ingestion FFmpeg/ffprobe for ${plat.id} (${plat.binDirs.join(' or ')}, ADR-019)`), path.join(desk, 'resources/bin')],
  [need(enginesDir, `Generator Engine Binaries (node scripts/prepare-engines.mjs --platform=${target.platform} --arch=${target.arch})`), path.join(desk, 'resources/engines')],
];
for (const exe of ['ffmpeg', 'ffprobe']) if (fs.existsSync(binDir)) need(path.join(binDir, plat.exe(exe)), `${plat.exe(exe)} in ${path.relative(root, binDir)}`);
if (fs.existsSync(enginesDir)) {
  let marker = null;
  try { marker = JSON.parse(fs.readFileSync(path.join(enginesDir, 'PLATFORM.json'), 'utf8')); } catch { /* reported below */ }
  if (!marker || marker.platform !== target.platform || marker.arch !== target.arch) problems.push(`${plat.enginesDir}/PLATFORM.json is ${marker ? `${marker.platform}-${marker.arch}` : 'missing'}, target ${plat.id} (re-run prepare-engines --platform=${target.platform})`);
}
// Wrong-platform binaries in any input are a hard stop, before anything is copied.
for (const [from] of plan.slice(5)) if (fs.existsSync(from)) for (const f of foreignBinaries(from, target)) problems.push(`not a ${plat.id} file: ${path.relative(root, path.join(from, f.split(' (')[0]))} (${f.split(' (').slice(1).join(' (')}`);
if (problems.length) { console.error(`stage-desktop (${plat.id}): ${problems.length} problem(s):\n  ${problems.join('\n  ')}`); process.exit(1); }
if (check) { console.log('stage-desktop: all inputs present'); process.exit(0); }

for (const [from, to] of plan) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !/\.map$|\.d\.ts$|[\\/]test[\\/]/.test(src) });
  console.log(`staged ${path.relative(root, from)} → ${path.relative(root, to)}`);
}

// Source maps are not shipped (filter above), so the `//# sourceMappingURL=` trailers must go too: Remotion's renderer reads
// `bundle.js.map` synchronously when it prepares the bundle server (`getSourceMapFromLocalFile`), and a trailer pointing at a missing
// file makes EVERY renderStill / renderMedia from the packaged bundle fail with ENOENT (found 2026-10-26: the frame thumbnail, and
// Export, of the cross-built test packages; the release build only escaped it where the obfuscator dropped comments).
{
  let n = 0;
  const strip = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) strip(f); else if (/\.(m?js|css)$/.test(e.name)) { const t = fs.readFileSync(f, 'utf8'); const u = t.replace(/\n?\/\/[#@] ?sourceMappingURL=[^\s'"]+\s*$/gm, '').replace(/\n?\/\*# ?sourceMappingURL=[^*]*\*\/\s*$/gm, ''); if (u !== t) { fs.writeFileSync(f, u); n++; } } } };
  strip(path.join(desk, 'resources/engine/bundle')); strip(path.join(desk, 'dist/ui'));
  if (n) console.log(`removed sourceMappingURL trailers from ${n} staged file(s) (maps are not shipped)`);
}

// POSIX targets: every ELF / Mach-O image must be executable inside the package (zip inputs and some npm tarballs carry no mode bits).
if (target.platform !== 'win32') {
  let n = 0;
  for (const d of ['resources/engine/chrome', 'resources/engine/compositor', 'resources/bin', 'resources/engines']) n += fixExecBits(path.join(desk, d));
  if (n) console.log(`exec bit set on ${n} staged file(s)`);
}

// The engine bundle's index.html records the build machine's absolute project path (Remotion's `remotion_cwd`, used only by
// the development Studio). Ship a neutral value, and refuse to stage any build-machine path into the package.
{
  const html = path.join(desk, 'resources/engine/bundle/index.html');
  if (fs.existsSync(html)) fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(/(remotion_cwd\s*=\s*)(["'])[^"']*\2/, '$1"."'));
  const leaks = [];
  const scan = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) scan(f); else if (/\.(html|js|json|css|txt)$/.test(e.name) && fs.readFileSync(f, 'utf8').includes(root)) leaks.push(path.relative(desk, f)); } };
  for (const d of ['dist', 'resources']) if (fs.existsSync(path.join(desk, d))) scan(path.join(desk, d));
  if (leaks.length) { console.error(`stage-desktop: build-machine path ${root} found in ${leaks.slice(0, 5).join(', ')}`); process.exit(1); }
  // The build machine's home folder (e.g. /home/<user> on the Linux build server) must not appear either.
  const home = os.homedir();
  if (home && home.length > 3) {
    const homeLeaks = [];
    const scanHome = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) scanHome(f); else if (/\.(html|js|cjs|json|css|txt)$/.test(e.name) && fs.readFileSync(f, 'utf8').includes(`${home}${path.sep}`)) homeLeaks.push(path.relative(desk, f)); } };
    for (const d of ['dist', 'resources']) if (fs.existsSync(path.join(desk, d))) scanHome(path.join(desk, d));
    if (homeLeaks.length) { console.error(`stage-desktop: build-machine home ${home} found in ${homeLeaks.slice(0, 5).join(', ')}`); process.exit(1); }
  }
}

const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else files.push(p); } };
walk(path.join(desk, 'resources/engine')); walk(path.join(desk, 'resources/bin'));
// Generator Engine Binaries (whisper.cpp, sherpa-onnx, sd.cpp) when the Operator placed them: hashed before spawn (SEC-061).
if (fs.existsSync(path.join(desk, 'resources/engines'))) walk(path.join(desk, 'resources/engines'));
const manifest = { generatedAt: new Date().toISOString(), files: files.sort().map((f) => ({ path: path.relative(path.join(desk, 'resources'), f).split(path.sep).join('/'), size: fs.statSync(f).size, sha256: crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') })) };
fs.writeFileSync(path.join(desk, 'resources/engine-manifest.json'), JSON.stringify(manifest, null, 2));

// Third-party notices: licence of every production dependency reachable from the shipped workspaces.
const seen = new Map();
const visit = (name, from) => {
  if (seen.has(name)) return;
  let dir = from; let pkgPath;
  while (true) { const c = path.join(dir, 'node_modules', name, 'package.json'); if (fs.existsSync(c)) { pkgPath = c; break; } const up = path.dirname(dir); if (up === dir) return; dir = up; }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const pdir = path.dirname(pkgPath);
  const lic = fs.readdirSync(pdir).find((f) => /^(licen[cs]e|copying|notice)/i.test(f));
  seen.set(name, { version: pkg.version, license: typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license ?? 'UNKNOWN'), text: lic ? fs.readFileSync(path.join(pdir, lic), 'utf8') : '' });
  for (const dep of Object.keys(pkg.dependencies ?? {})) visit(dep, pdir);
};
for (const ws of ['apps/service', 'apps/ui', 'apps/desktop', 'packages/engine']) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, ws, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) if (!dep.startsWith('@expertmotion/')) visit(dep, path.join(root, ws));
}
const notices = ['Expertmotion third-party notices', `Generated ${manifest.generatedAt}`, '',
  `Target: ${plat.id}.`,
  'Bundled binaries: Chrome Headless Shell (BSD-3-Clause and others, see chrome/ licence files); Remotion compositor incl. FFmpeg n7.1 built with libx264 and libfdk-aac (see RISK-030); ingestion FFmpeg (resources/bin, LGPL build, ADR-019).',
  'Generator Engine Binaries: whisper.cpp (MIT), sherpa-onnx (Apache-2.0) with onnxruntime (MIT) and espeak-ng-data (GPL-3.0-or-later data), stable-diffusion.cpp (MIT); licence texts in engines/<engine>/<version>/LICENSES.', '',
  ...[...seen].sort(([a], [b]) => a.localeCompare(b)).flatMap(([n, v]) => [`==== ${n}@${v.version} (${v.license})`, v.text.trim(), ''])];
fs.writeFileSync(path.join(desk, 'resources/THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
const unknown = [...seen].filter(([, v]) => v.license === 'UNKNOWN' || /GPL/.test(v.license) && !/LGPL/.test(v.license)).map(([n, v]) => `${n} (${v.license})`);
console.log(`stage-desktop: ${plat.id}; engine-manifest: ${files.length} files; notices: ${seen.size} packages${unknown.length ? `; REVIEW: ${unknown.join(', ')}` : ''}`);
