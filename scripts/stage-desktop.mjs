#!/usr/bin/env node
// Stages every build output where apps/desktop/electron-builder.config.cjs expects it (DEPLOYMENT_AND_PACKAGING §3).
// Run on the Windows build machine after: npm run build:all. Usage: node scripts/stage-desktop.mjs [--check] [--platform=win32]
//   apps/service/dist/service.cjs        → apps/desktop/dist/service/service.cjs
//   apps/service/dist/assets.enc         → apps/desktop/dist/service/assets.enc (encrypted prompts; prompt-half-b.hex is never staged)
//   apps/ui/dist/**                      → apps/desktop/dist/ui/**
//   resources/engine/bundle/**           → apps/desktop/resources/engine/bundle/**
//   resources/catalogue/<category>/*.webm (build-loops) → apps/desktop/dist/ui/catalogue/** (served over app:// with the Editor)
//   node_modules/.remotion/chrome-headless-shell/<platform>/<dir>/**  → apps/desktop/resources/engine/chrome/**
//   node_modules/@remotion/compositor-<platform>/**                    → apps/desktop/resources/engine/compositor/**
//   resources/sample/** (onboarding Sample Project, CC0; node packages/engine/scripts/build-sample.mjs) → apps/desktop/resources/sample/**
//   resources/bin/** (full LGPL FFmpeg + ffprobe for ingestion, ADR-019; placed by the Operator) → apps/desktop/resources/bin/**
// Writes resources/engine-manifest.json (sha256 of every staged engine file) and THIRD_PARTY_NOTICES.txt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const desk = path.join(root, 'apps', 'desktop');
const check = process.argv.includes('--check');
// --platform=win32 stages the Windows binaries on another host (scripts/cross-build-win.sh).
const targetPlatform = process.argv.find((a) => a.startsWith('--platform='))?.split('=')[1] ?? process.platform;
const plat = targetPlatform === 'win32' ? { chrome: 'win64', compositor: 'compositor-win32-x64-msvc' } : { chrome: 'linux64', compositor: 'compositor-linux-x64-gnu' };
const problems = [];
const need = (p, what) => { if (!fs.existsSync(p)) problems.push(`${what} missing: ${path.relative(root, p)}`); return p; };

const chromeBase = path.join(root, 'node_modules', '.remotion', 'chrome-headless-shell', plat.chrome);
const chromeDir = fs.existsSync(chromeBase) ? (fs.readdirSync(chromeBase).map((d) => path.join(chromeBase, d)).find((d) => fs.statSync(d).isDirectory()) ?? chromeBase) : chromeBase;
const plan = [
  [need(path.join(root, 'apps/service/dist/service.cjs'), 'service bundle (npm run build -w @expertmotion/service)'), path.join(desk, 'dist/service/service.cjs')],
  [need(path.join(root, 'apps/service/dist/assets.enc'), 'encrypted prompts (npm run build:release -w @expertmotion/service)'), path.join(desk, 'dist/service/assets.enc')],
  [need(path.join(root, 'apps/ui/dist'), 'Editor build (npm run build -w @expertmotion/ui)'), path.join(desk, 'dist/ui')],
  [need(path.join(root, 'resources/catalogue'), 'catalogue loops (node packages/engine/scripts/build-loops.mjs)'), path.join(desk, 'dist/ui/catalogue')],
  [need(path.join(root, 'resources/engine/bundle'), 'Engine bundle (npm run build:bundle -w @expertmotion/engine)'), path.join(desk, 'resources/engine/bundle')],
  [need(chromeDir, 'Chrome Headless Shell (npx remotion browser ensure)'), path.join(desk, 'resources/engine/chrome')],
  [need(path.join(root, 'node_modules/@remotion', plat.compositor), 'Remotion compositor'), path.join(desk, 'resources/engine/compositor')],
  [need(path.join(root, 'resources/sample'), 'Sample Project media (node packages/engine/scripts/build-sample.mjs)'), path.join(desk, 'resources/sample')],
  [need(path.join(root, 'resources/bin'), 'ingestion FFmpeg/ffprobe (resources/bin, ADR-019)'), path.join(desk, 'resources/bin')],
  [need(path.join(root, 'resources/engines'), 'Generator Engine Binaries (node scripts/prepare-engines.mjs)'), path.join(desk, 'resources/engines')],
];
if (problems.length) { console.error(`stage-desktop: ${problems.length} input(s) missing:\n  ${problems.join('\n  ')}`); process.exit(1); }
if (check) { console.log('stage-desktop: all inputs present'); process.exit(0); }

for (const [from, to] of plan) {
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.cpSync(from, to, { recursive: true, dereference: true, filter: (src) => !/\.map$|\.d\.ts$|[\\/]test[\\/]/.test(src) });
  console.log(`staged ${path.relative(root, from)} → ${path.relative(root, to)}`);
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
  'Bundled binaries: Chrome Headless Shell (BSD-3-Clause and others, see chrome/ licence files); Remotion compositor incl. FFmpeg n7.1 built with libx264 and libfdk-aac (see RISK-030); ingestion FFmpeg (resources/bin, LGPL build, ADR-019).', '',
  ...[...seen].sort(([a], [b]) => a.localeCompare(b)).flatMap(([n, v]) => [`==== ${n}@${v.version} (${v.license})`, v.text.trim(), ''])];
fs.writeFileSync(path.join(desk, 'resources/THIRD_PARTY_NOTICES.txt'), notices.join('\n'));
const unknown = [...seen].filter(([, v]) => v.license === 'UNKNOWN' || /GPL/.test(v.license) && !/LGPL/.test(v.license)).map(([n, v]) => `${n} (${v.license})`);
console.log(`engine-manifest: ${files.length} files; notices: ${seen.size} packages${unknown.length ? `; REVIEW: ${unknown.join(', ')}` : ''}`);
