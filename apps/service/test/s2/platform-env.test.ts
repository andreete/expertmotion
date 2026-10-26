// Per-platform child environment and engine-file rules of the Local Service (DEPLOYMENT_AND_PACKAGING §17, SEC-061, SEC-065).
import { describe, expect, it } from 'vitest';
import { toolEnv } from '../../src/s2/proc.js';
import { isEngineExecutable } from '../../src/s2/engine-check.js';
import { defaultResources } from '../../src/boot.js';
import { removableMediaRoots } from '../../src/modules/assets.js';

describe('toolEnv per platform (FFmpeg / ffprobe)', () => {
  const parent = { PATH: '/home/u/bin:/usr/bin', SYSTEMROOT: 'C:\\Windows', LANG: 'id_ID.UTF-8', LD_LIBRARY_PATH: '/home/u/evil', LD_PRELOAD: '/x.so', DYLD_INSERT_LIBRARIES: '/x.dylib' };
  it('Linux: PATH and LD_LIBRARY_PATH are the binary\'s folder, TMPDIR the job folder, nothing else inherited', () => {
    expect(toolEnv('/opt/Expertmotion/resources/bin/ffmpeg', '/d/tmp/j1', 'linux', parent)).toEqual({
      PATH: '/opt/Expertmotion/resources/bin', LD_LIBRARY_PATH: '/opt/Expertmotion/resources/bin', LANG: 'id_ID.UTF-8', TEMP: '/d/tmp/j1', TMP: '/d/tmp/j1', TMPDIR: '/d/tmp/j1' });
  });
  it('macOS: no DYLD_* and no LD_*; Windows: SYSTEMROOT kept', () => {
    const mac = toolEnv('/Applications/Expertmotion.app/Contents/Resources/bin/ffmpeg', undefined, 'darwin', parent);
    expect(Object.keys(mac).sort()).toEqual(['LANG', 'PATH']);
    expect(toolEnv('/x/bin/ffmpeg', undefined, 'win32', parent)['SYSTEMROOT']).toBe('C:\\Windows');
    expect(toolEnv('/x/bin/ffmpeg', undefined, 'linux', parent)).not.toHaveProperty('SYSTEMROOT');
  });
  it('development (bare name): the parent PATH, no LD_LIBRARY_PATH', () => {
    expect(toolEnv('ffmpeg', undefined, 'linux', parent)).toEqual({ PATH: parent.PATH, LANG: 'id_ID.UTF-8' });
  });
});

describe('packaged resource paths per platform', () => {
  it('the host build resolves FFmpeg, ffprobe and Chrome without .exe off Windows (process.resourcesPath layout)', () => {
    const p = process as { resourcesPath?: string };
    const before = p.resourcesPath;
    p.resourcesPath = '/opt/Expertmotion/resources';
    try {
      const r = defaultResources({});
      const exe = process.platform === 'win32' ? '.exe' : '';
      expect(r.ffmpeg).toBe(`/opt/Expertmotion/resources/bin/ffmpeg${exe}`.split('/').join(process.platform === 'win32' ? '\\' : '/'));
      expect(r.browserExecutable).toMatch(new RegExp(`engine[\\\\/]chrome[\\\\/]chrome-headless-shell${exe.replace('.', '\\.')}$`));
      expect(r.enginesDir).toMatch(/resources[\\/]engines$/);
    } finally { p.resourcesPath = before; }
  });
  it('engine-check treats the Linux / macOS engine executables and sonames as binaries (SEC-061)', () => {
    for (const f of ['engine/chrome/chrome-headless-shell', 'engine/chrome/libEGL.so', 'engine/chrome/libvulkan.so.1', 'engine/compositor/libavcodec.so', 'engines/whisper.cpp/v/whisper-cli', 'engines/sherpa-onnx/v/sherpa-onnx-offline-tts', 'engines/stable-diffusion.cpp/v/sd-cli'])
      expect(isEngineExecutable(f), f).toBe(true);
    expect(isEngineExecutable('engine/chrome/vk_swiftshader_icd.json')).toBe(false);
  });
});

describe('import roots per platform (TR-081)', () => {
  it('removable media mount points: /media/<user> and /run/media/<user> on Linux, /Volumes on macOS, none added on Windows', () => {
    expect(removableMediaRoots('linux', 'budi')).toEqual(['/media/budi', '/run/media/budi']);
    expect(removableMediaRoots('linux', '')).toEqual([]);
    expect(removableMediaRoots('darwin', 'budi')).toEqual(['/Volumes']);
    expect(removableMediaRoots('win32', 'budi')).toEqual([]);
  });
});
