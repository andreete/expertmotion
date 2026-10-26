// Per-platform packaging (DEPLOYMENT_AND_PACKAGING §17, Operator 2026-10-26 "jangan sampai salah alamat"): engines.json entries per
// platform, scripts/prepare-engines.mjs per platform (archives, exec bits, symlinked sonames, separate output + PLATFORM.json, no
// foreign binaries, no VC++ runtime off Windows) and scripts/stage-desktop.mjs platform selection and guard.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';

const repo = resolve(__dirname, '../../..');
const platformLib = join(repo, 'scripts/lib/platform.mjs');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let P: any;
beforeAll(async () => { P = await import(platformLib); });

const ELF64_X64 = (): Buffer => { const b = Buffer.alloc(64); b.write('\x7fELF', 0, 'latin1'); b[4] = 2; b[5] = 1; b.writeUInt16LE(0x3e, 18); return b; };
const ELF64_ARM = (): Buffer => { const b = ELF64_X64(); b.writeUInt16LE(0xb7, 18); return b; };
const PE = (): Buffer => Buffer.concat([Buffer.from('MZ'), Buffer.alloc(62)]);
const MACHO = (): Buffer => { const b = Buffer.alloc(64); b.writeUInt32LE(0xfeedfacf, 0); return b; };
const sha = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** Minimal ZIP (stored) with Unix modes in the external attributes, like the stable-diffusion.cpp release zips. */
function zip(entries: Array<{ name: string; data: Buffer; mode: number }>): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name); const data = deflateRawSync(e.data);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(e.data.length, 22); l.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(0x0314, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(e.data.length, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt32LE(((0o100000 | e.mode) << 16) >>> 0, 38); c.writeUInt32LE(off, 42);
    locals.push(l, name, data); centrals.push(c, name); off += l.length + name.length + data.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe('engines.json per platform', () => {
  const spec = JSON.parse(readFileSync(join(repo, 'packages/models/engines.json'), 'utf8')) as { engines: Array<Record<string, any>> };
  it('every downloadable entry is pinned by sha256 and declares its platform', () => {
    for (const e of spec.engines) {
      expect(['win32', 'linux', 'darwin'], e.url).toEqual(expect.arrayContaining(Array.isArray(e['platform']) ? e['platform'] : [e['platform']]));
      if (e['url']) expect(e['sha256'], e['url']).toMatch(/^[0-9a-f]{64}$/);
      else expect(e['source']?.commit, e['engine']).toMatch(/^[0-9a-f]{40}$/);
      for (const l of e['licences'] ?? []) expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });
  it('the Windows selection is the four original entries (unchanged URLs and hashes, VC++ runtime only there)', () => {
    const win = P.selectEngineEntries(spec, { platform: 'win32', arch: 'x64' });
    expect(win.map((e: any) => basename(e.url))).toEqual(['whisper-bin-x64.zip', 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release.tar.bz2', 'espeak-ng-data.zip', 'sd-master-0886f11-bin-win-vulkan-x64.zip']);
    expect(win.map((e: any) => e.sha256.slice(0, 8))).toEqual(['6ba69e34', '6dffdc71', 'bc4525ea', '09f1aaf8']);
  });
  it('Linux x64 takes only Linux archives (plus the platform-neutral espeak data), no .exe/.dll, no VC++ runtime', () => {
    const lin = P.selectEngineEntries(spec, { platform: 'linux', arch: 'x64' });
    expect(lin.map((e: any) => e.engine).sort()).toEqual(['sherpa-onnx', 'sherpa-onnx', 'stable-diffusion.cpp', 'whisper.cpp']);
    for (const e of lin) {
      expect(e.vcRuntime ?? false).toBe(false);
      expect(e.keep.join(' ')).not.toMatch(/\.(exe|dll)\b/);
      if (e.url !== undefined && !e.url.endsWith('espeak-ng-data.zip')) expect(e.url).toMatch(/linux|ubuntu/i);
    }
    expect(lin.find((e: any) => e.engine === 'stable-diffusion.cpp').url).not.toMatch(/vulkan|rocm/);   // CPU build: no GPU driver needed
  });
  it('macOS takes only macOS archives per architecture; whisper.cpp is a pinned source build', () => {
    for (const arch of ['arm64', 'x64']) {
      const mac = P.selectEngineEntries(spec, { platform: 'darwin', arch });
      expect(mac.map((e: any) => e.engine).sort()).toEqual(['sherpa-onnx', 'sherpa-onnx', 'stable-diffusion.cpp', 'whisper.cpp']);
      for (const e of mac) if (e.url && !e.url.endsWith('espeak-ng-data.zip')) expect(e.url).toMatch(/osx|darwin|macos/i);
      expect(mac.find((e: any) => e.url?.includes('sherpa-onnx-v1.13.8-osx')).url).toContain(`osx-${arch}-shared`);
      expect(mac.find((e: any) => e.engine === 'whisper.cpp').source.tag).toBe('b5454');
    }
    expect(P.selectEngineEntries(spec, { platform: 'linux', arch: 'arm64' }).every((e: any) => e.url?.endsWith('espeak-ng-data.zip'))).toBe(true);
  });
});

describe('platform helpers (scripts/lib/platform.mjs)', () => {
  it('reads --platform / --arch and refuses unknown or unsupported targets', () => {
    expect(P.targetFromArgv(['--platform=linux'], { platform: 'win32', arch: 'x64' })).toEqual({ platform: 'linux', arch: 'x64' });
    expect(P.targetFromArgv(['--platform', 'darwin', '--arch=arm64'], { platform: 'linux', arch: 'x64' })).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(P.targetFromArgv([], { platform: 'darwin', arch: 'arm64' })).toEqual({ platform: 'darwin', arch: 'arm64' });
    expect(() => P.targetFromArgv(['--platform=windows'])).toThrow(/unknown --platform/);
    expect(() => P.targetFromArgv(['--platform=win32', '--arch=arm64'])).toThrow(/x64 only/);
  });
  it('maps each target to its own Chrome, compositor, engines and FFmpeg folders', () => {
    const w = P.platformInputs({ platform: 'win32', arch: 'x64' }), l = P.platformInputs({ platform: 'linux', arch: 'x64' }), m = P.platformInputs({ platform: 'darwin', arch: 'arm64' });
    expect([w.chromeDir, w.compositorPackage, w.enginesDir, w.exe('ffmpeg')]).toEqual(['win64', 'compositor-win32-x64-msvc', 'resources/engines-win32-x64', 'ffmpeg.exe']);
    expect([l.chromeDir, l.compositorPackage, l.enginesDir, l.exe('ffmpeg'), l.binDirs]).toEqual(['linux64', 'compositor-linux-x64-gnu', 'resources/engines-linux-x64', 'ffmpeg', ['resources/bin-linux-x64']]);
    expect([m.chromeDir, m.compositorPackage, m.enginesDir]).toEqual(['mac-arm64', 'compositor-darwin-arm64', 'resources/engines-darwin-arm64']);
    expect(w.binDirs).toEqual(['resources/bin-win32-x64', 'resources/bin']);                    // the legacy folder only for Windows
  });
  it('recognises PE, ELF (with CPU) and Mach-O images and flags every file of another platform', () => {
    expect([P.binaryFormat(PE()), P.binaryFormat(ELF64_X64()), P.binaryFormat(MACHO()), P.binaryFormat(Buffer.from('hello'))]).toEqual(['pe', 'elf', 'macho', null]);
    expect([P.elfArch(ELF64_X64()), P.elfArch(ELF64_ARM())]).toEqual(['x64', 'arm64']);
    const d = tmp('em-foreign-');
    writeFileSync(join(d, 'ffmpeg'), ELF64_X64()); writeFileSync(join(d, 'tool.exe'), PE()); writeFileSync(join(d, 'arm-tool'), ELF64_ARM());
    mkdirSync(join(d, 'sub')); writeFileSync(join(d, 'sub', 'lib.dylib'), MACHO()); writeFileSync(join(d, 'README.txt'), 'text');
    const lin = P.foreignBinaries(d, { platform: 'linux', arch: 'x64' }).join('\n');
    expect(lin).toContain('tool.exe'); expect(lin).toContain('arm-tool'); expect(lin).toContain('sub/lib.dylib'); expect(lin).not.toContain('ffmpeg'); expect(lin).not.toContain('README');
    const win = P.foreignBinaries(d, { platform: 'win32', arch: 'x64' }).join('\n');
    expect(win).toContain('ffmpeg (elf'); expect(win).not.toContain('tool.exe');
  });
});

describe('prepare-engines --platform (real script, local pinned archives)', () => {
  const script = join(repo, 'scripts/prepare-engines.mjs');
  /** Builds a cache with one tar.gz and one zip, as prepare-engines names cached downloads (`<sha16>-<basename>`). */
  function fixture(): { cache: string; spec: string; out: string; specObj: any } {
    const work = tmp('em-prep-'); const cache = join(work, 'cache'); mkdirSync(cache);
    const src = join(work, 'src', 'tool-linux-x64'); mkdirSync(join(src, 'bin'), { recursive: true }); mkdirSync(join(src, 'lib'));
    writeFileSync(join(src, 'bin', 'tool-cli'), ELF64_X64()); chmodSync(join(src, 'bin', 'tool-cli'), 0o644);   // exec bit missing upstream
    writeFileSync(join(src, 'lib', 'libtool.so.1.2.3'), ELF64_X64());
    symlinkSync('libtool.so.1.2.3', join(src, 'lib', 'libtool.so.1'));
    writeFileSync(join(src, 'lib', 'notes.txt'), 'not kept');
    const tgz = join(work, 'tool-linux-x64.tar.gz');
    expect(spawnSync('tar', ['-czf', tgz, '-C', join(work, 'src'), 'tool-linux-x64']).status).toBe(0);
    const zipFile = join(work, 'img-linux.zip');
    writeFileSync(zipFile, zip([{ name: 'img-cli', data: ELF64_X64(), mode: 0o755 }, { name: 'libimg.so', data: ELF64_X64(), mode: 0o644 }, { name: 'readme.md', data: Buffer.from('x'), mode: 0o644 }]));
    const lic = join(work, 'LICENSE'); writeFileSync(lic, 'MIT');
    for (const f of [tgz, zipFile, lic]) cpSync(f, join(cache, `${sha(f).slice(0, 16)}-${basename(f)}`));
    const url = (f: string) => `https://example.invalid/${basename(f)}`;
    const specObj = { engines: [
      { engine: 'tool', version: '1.0', platform: 'linux', arch: ['x64'], licence: 'MIT', url: url(tgz), sha256: sha(tgz), strip: 'tool-linux-x64/', flatten: true,
        keep: ['bin/tool-cli', 'lib/libtool.so.1'], executables: ['tool-cli'], licences: [{ file: 'tool-LICENSE.txt', url: url(lic), sha256: sha(lic) }] },
      { engine: 'img', version: '2.0', platform: 'linux', arch: ['x64'], licence: 'MIT', url: url(zipFile), sha256: sha(zipFile), strip: '', keep: ['img-cli', 'libimg.so'] },
      { engine: 'tool', version: '1.0', platform: 'win32', arch: ['x64'], licence: 'MIT', url: 'https://example.invalid/never-downloaded.zip', sha256: 'f'.repeat(64), strip: '', keep: ['*.exe'], vcRuntime: true },
    ], vcRuntime: { url: 'https://example.invalid/vc.exe', sha256: 'e'.repeat(64), dlls: [] } };
    const spec = join(work, 'engines.json'); writeFileSync(spec, JSON.stringify(specObj));
    return { cache, spec, out: join(work, 'out'), specObj };
  }
  const run = (f: { cache: string; spec: string; out: string }, platform: string) =>
    spawnSync(process.execPath, [script, `--platform=${platform}`, '--arch=x64', '--cache', f.cache, '--spec', f.spec, '--out', f.out], { encoding: 'utf8' });

  it('lays out only the Linux entries: flattened, exec bits set, soname symlink copied as a real file, marker written', () => {
    const f = fixture();
    const r = run(f, 'linux');
    expect(r.status, r.stderr).toBe(0);
    const tool = join(f.out, 'tool', '1.0');
    expect(existsSync(join(tool, 'tool-cli'))).toBe(true);
    expect(statSync(join(tool, 'tool-cli')).mode & 0o111).toBe(0o111);
    expect(lstatSync(join(tool, 'libtool.so.1')).isFile()).toBe(true);           // not a dangling symlink in the package
    expect(existsSync(join(tool, 'notes.txt'))).toBe(false);
    expect(readFileSync(join(tool, 'LICENSES', 'tool-LICENSE.txt'), 'utf8')).toBe('MIT');
    expect(statSync(join(f.out, 'img', '2.0', 'img-cli')).mode & 0o111).toBe(0o111);   // zip external attributes
    expect(statSync(join(f.out, 'img', '2.0', 'libimg.so')).mode & 0o111).toBe(0o111); // ELF without mode bits → fixed
    expect(existsSync(join(f.out, 'img', '2.0', 'readme.md'))).toBe(false);
    expect(JSON.parse(readFileSync(join(f.out, 'PLATFORM.json'), 'utf8'))).toEqual({ platform: 'linux', arch: 'x64' });
    expect(readFileSync(join(f.out, 'ENGINES.txt'), 'utf8')).not.toContain('Visual C++');
  });
  it('refuses a Windows binary inside a Linux archive, and the VC++ runtime off Windows', () => {
    const f = fixture();
    const z = join(f.cache, 'bad.zip'); writeFileSync(z, zip([{ name: 'img-cli.exe', data: PE(), mode: 0o644 }]));
    const bad = { ...f.specObj, engines: [{ engine: 'img', version: '2.0', platform: 'linux', arch: ['x64'], licence: 'MIT', url: 'https://example.invalid/bad.zip', sha256: sha(z), strip: '', keep: ['img-cli.exe'] }] };
    cpSync(z, join(f.cache, `${sha(z).slice(0, 16)}-bad.zip`));
    writeFileSync(f.spec, JSON.stringify(bad));
    const r = run(f, 'linux');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/do not belong to linux-x64[\s\S]*img-cli\.exe/);
    writeFileSync(f.spec, JSON.stringify({ ...f.specObj, engines: [{ ...f.specObj.engines[1], vcRuntime: true }] }));
    expect(run(f, 'linux').stderr).toMatch(/Visual C\+\+ runtime requested for linux/);
  });
  it('has nothing for a platform without entries (never falls back to another platform)', () => {
    const f = fixture();
    const r = run(f, 'darwin');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no entry for darwin-x64');
  });
});

describe('stage-desktop --platform (real script in a scratch repo)', () => {
  /** A minimal repo tree with every staging input for linux-x64 and win32-x64. */
  function fakeRepo(): string {
    const r = tmp('em-stage-');
    for (const s of ['scripts/stage-desktop.mjs', 'scripts/lib/platform.mjs']) cpSync(join(repo, s), join(r, s));
    const put = (rel: string, data: string | Buffer, mode = 0o644) => { mkdirSync(join(r, rel, '..'), { recursive: true }); writeFileSync(join(r, rel), data); chmodSync(join(r, rel), mode); };
    put('apps/service/dist/service.cjs', 'module.exports={}'); put('apps/service/dist/assets.enc', 'x');
    put('apps/ui/dist/index.html', '<html></html>'); put('resources/catalogue/text/a.webm', 'w'); put('resources/engine/bundle/index.html', '<script>remotion_cwd = "/build/machine"</script>');
    put('resources/engine/bundle/bundle.js', 'console.log(1);\n//# sourceMappingURL=bundle.js.map'); put('resources/engine/bundle/bundle.js.map', '{}');
    put('resources/sample/clip-1.mp4', 'm');
    for (const ws of ['apps/service', 'apps/ui', 'apps/desktop', 'packages/engine']) put(`${ws}/package.json`, '{"name":"x","dependencies":{}}');
    put('node_modules/.remotion/chrome-headless-shell/linux64/chrome-headless-shell-linux64/chrome-headless-shell', ELF64_X64(), 0o644);
    put('node_modules/.remotion/chrome-headless-shell/win64/chrome-headless-shell-win64/chrome-headless-shell.exe', PE());
    put('node_modules/@remotion/compositor-linux-x64-gnu/remotion', ELF64_X64(), 0o755); put('node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg', ELF64_X64(), 0o755);
    put('node_modules/@remotion/compositor-win32-x64-msvc/remotion.exe', PE()); put('node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe', PE());
    put('resources/bin-linux-x64/ffmpeg', ELF64_X64(), 0o755); put('resources/bin-linux-x64/ffprobe', ELF64_X64(), 0o755);
    put('resources/bin/ffmpeg.exe', PE()); put('resources/bin/ffprobe.exe', PE());
    put('resources/engines-linux-x64/PLATFORM.json', '{"platform":"linux","arch":"x64"}'); put('resources/engines-linux-x64/whisper.cpp/1/whisper-cli', ELF64_X64(), 0o755);
    put('resources/engines-win32-x64/PLATFORM.json', '{"platform":"win32","arch":"x64"}'); put('resources/engines-win32-x64/whisper.cpp/1/whisper-cli.exe', PE());
    return r;
  }
  const stage = (r: string, ...args: string[]) => spawnSync(process.execPath, [join(r, 'scripts/stage-desktop.mjs'), ...args], { encoding: 'utf8', cwd: r });

  it('stages only the Linux inputs, with exec bits, and records the target in the notices', () => {
    const r = fakeRepo();
    const res = stage(r, '--platform=linux', '--arch=x64');
    expect(res.status, res.stderr).toBe(0);
    const d = join(r, 'apps/desktop/resources');
    expect(existsSync(join(d, 'engine/chrome/chrome-headless-shell'))).toBe(true);
    expect(statSync(join(d, 'engine/chrome/chrome-headless-shell')).mode & 0o111).toBe(0o111);
    expect(existsSync(join(d, 'engine/compositor/remotion'))).toBe(true);
    expect(existsSync(join(d, 'bin/ffmpeg'))).toBe(true);
    expect(existsSync(join(d, 'bin/ffmpeg.exe'))).toBe(false);
    expect(existsSync(join(d, 'engines/whisper.cpp/1/whisper-cli'))).toBe(true);
    expect(readFileSync(join(d, 'THIRD_PARTY_NOTICES.txt'), 'utf8')).toContain('Target: linux-x64.');
    const manifest = JSON.parse(readFileSync(join(d, 'engine-manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
    expect(manifest.files.some((x) => /\.exe$/.test(x.path))).toBe(false);
    // maps are not shipped, so no trailer may point at one (Remotion reads bundle.js.map synchronously → ENOENT on every render)
    expect(existsSync(join(d, 'engine/bundle/bundle.js.map'))).toBe(false);
    expect(readFileSync(join(d, 'engine/bundle/bundle.js'), 'utf8')).toBe('console.log(1);');
  });
  it('stages the Windows inputs for win32 (legacy resources/bin) and no ELF', () => {
    const r = fakeRepo();
    const res = stage(r, '--platform=win32', '--arch=x64');
    expect(res.status, res.stderr).toBe(0);
    expect(existsSync(join(r, 'apps/desktop/resources/bin/ffmpeg.exe'))).toBe(true);
    expect(existsSync(join(r, 'apps/desktop/resources/engines/whisper.cpp/1/whisper-cli.exe'))).toBe(true);
    expect(existsSync(join(r, 'apps/desktop/resources/engine/compositor/remotion'))).toBe(false);
  });
  it('refuses a Windows file in a Linux input, a wrong PLATFORM.json and missing inputs', () => {
    const r = fakeRepo();
    writeFileSync(join(r, 'resources/bin-linux-x64/ffmpeg.exe'), PE());
    let res = stage(r, '--platform=linux', '--check');
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('not a linux-x64 file: resources/bin-linux-x64/ffmpeg.exe');
    const r2 = fakeRepo();
    writeFileSync(join(r2, 'resources/engines-linux-x64/PLATFORM.json'), '{"platform":"win32","arch":"x64"}');
    res = stage(r2, '--platform=linux', '--check');
    expect(res.stderr).toContain('PLATFORM.json is win32-x64, target linux-x64');
    res = stage(fakeRepo(), '--platform=darwin', '--arch=arm64', '--check');
    expect(res.status).toBe(1);
    for (const s of ['mac-arm64', 'compositor-darwin-arm64', 'resources/bin-darwin-arm64', 'resources/engines-darwin-arm64']) expect(res.stderr).toContain(s);
  });
});
