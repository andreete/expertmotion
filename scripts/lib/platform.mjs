// Target-platform facts shared by scripts/prepare-engines.mjs and scripts/stage-desktop.mjs (DEPLOYMENT_AND_PACKAGING §17).
// One table says where each platform's inputs live, so a Windows build never stages Linux or macOS binaries and vice versa
// ("jangan sampai salah alamat"). Pure helpers, no side effects; unit-tested in apps/desktop/test/platform-packaging.test.ts.
import fs from 'node:fs';
import path from 'node:path';

export const PLATFORMS = /** @type {const} */ (['win32', 'linux', 'darwin']);
export const ARCHES = /** @type {const} */ (['x64', 'arm64']);

/** `--platform=<p>` / `--arch=<a>` from argv, defaulting to the host. Throws on an unknown value. */
export function targetFromArgv(argv, host = { platform: process.platform, arch: process.arch }) {
  const val = (name) => { const a = argv.find((x) => x.startsWith(`--${name}=`)); if (a) return a.slice(name.length + 3); const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const platform = val('platform') ?? host.platform;
  const arch = val('arch') ?? (platform === host.platform ? host.arch : 'x64');
  if (!PLATFORMS.includes(platform)) throw new Error(`unknown --platform=${platform} (expected ${PLATFORMS.join(' | ')})`);
  if (!ARCHES.includes(arch)) throw new Error(`unknown --arch=${arch} (expected ${ARCHES.join(' | ')})`);
  if (platform === 'win32' && arch !== 'x64') throw new Error('win32 builds are x64 only');
  if (platform === 'linux' && arch !== 'x64') throw new Error('linux builds are x64 only');
  return { platform, arch };
}

/** Where each platform's build inputs come from (relative to the repo root) and what the Engine expects. */
export function platformInputs({ platform, arch }) {
  const id = `${platform}-${arch}`;
  const chrome = { win32: 'win64', linux: 'linux64', darwin: arch === 'arm64' ? 'mac-arm64' : 'mac-x64' }[platform];
  const compositor = { win32: 'compositor-win32-x64-msvc', linux: 'compositor-linux-x64-gnu', darwin: `compositor-darwin-${arch}` }[platform];
  return {
    id,
    /** node_modules/.remotion/chrome-headless-shell/<dir> (Remotion's `ensureBrowser` layout). */
    chromeDir: chrome,
    /** node_modules/@remotion/<pkg> */
    compositorPackage: compositor,
    /** scripts/prepare-engines.mjs output for this platform. */
    enginesDir: `resources/engines-${id}`,
    /** Ingestion FFmpeg/ffprobe placed by the Operator (ADR-019). Windows keeps the historical resources/bin as a fallback. */
    binDirs: platform === 'win32' ? [`resources/bin-${id}`, 'resources/bin'] : [`resources/bin-${id}`],
    exe: (base) => (platform === 'win32' ? `${base}.exe` : base),
  };
}

/** Executable format of a file from its first bytes: 'pe' | 'elf' | 'macho' | null (not an executable image). */
export function binaryFormat(head) {
  if (head.length >= 2 && head[0] === 0x4d && head[1] === 0x5a) return 'pe';
  if (head.length >= 4 && head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46) return 'elf';
  if (head.length >= 4) {
    const le = head.readUInt32LE(0), be = head.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf].includes(le) || [0xfeedface, 0xfeedfacf].includes(be)) return 'macho';
    if (be === 0xcafebabe && head.length >= 8 && head.readUInt32BE(4) < 32) return 'macho';   // fat/universal (not a Java class: those carry a version > 32)
  }
  return null;
}

/** CPU of an ELF image ('x64' | 'arm64' | 'other'); null for non-ELF. */
export function elfArch(head) {
  if (binaryFormat(head) !== 'elf' || head.length < 20) return null;
  const machine = head[5] === 2 ? head.readUInt16BE(18) : head.readUInt16LE(18);
  return machine === 0x3e ? 'x64' : machine === 0xb7 ? 'arm64' : 'other';
}

export const FORMAT_OF = { win32: 'pe', linux: 'elf', darwin: 'macho' };

function readHead(file, n = 64) {
  const fd = fs.openSync(file, 'r');
  try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, 0); return b.subarray(0, got); } finally { fs.closeSync(fd); }
}

/**
 * Every file under `dir` that does not belong to `target`: an executable image of another OS (PE on Linux, ELF on Windows …), an
 * ELF of the wrong CPU, or a Windows-only name (.exe/.dll) outside Windows. Returns relative paths with the reason.
 */
export function foreignBinaries(dir, target) {
  const want = FORMAT_OF[target.platform];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      const rel = path.relative(dir, p).split(path.sep).join('/');
      if (target.platform !== 'win32' && /\.(exe|dll)$/i.test(e.name)) { out.push(`${rel} (Windows file name)`); continue; }
      const head = readHead(p);
      const fmt = binaryFormat(head);
      if (fmt && fmt !== want) out.push(`${rel} (${fmt} image, target ${target.platform})`);
      else if (fmt === 'elf' && elfArch(head) !== target.arch) out.push(`${rel} (ELF ${elfArch(head)}, target ${target.arch})`);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** Files that must be executable on POSIX targets: every ELF / Mach-O image (executables and shared libraries). */
export function needsExecBit(file) {
  try { return binaryFormat(readHead(file)) === 'elf' || binaryFormat(readHead(file)) === 'macho'; } catch { return false; }
}

/** chmod 0755 on every ELF / Mach-O file under `dir` (POSIX targets). Returns how many files changed. */
export function fixExecBits(dir) {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && needsExecBit(p) && (fs.statSync(p).mode & 0o111) !== 0o111) { fs.chmodSync(p, 0o755); n++; }
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

/** Entries of packages/models/engines.json for one target (platform may be a string or a list; arch a list). */
export function selectEngineEntries(spec, target) {
  return spec.engines.filter((e) => {
    const plats = Array.isArray(e.platform) ? e.platform : [e.platform];
    const arches = Array.isArray(e.arch) ? e.arch : [e.arch ?? 'x64'];
    return plats.includes(target.platform) && arches.includes(target.arch);
  });
}
