// SEC-066 (Private Mode / declared network need before spawning Engine Binaries) and SEC-061 (hashes before spawn, cached).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';
import type { ServiceContext } from '../../src/context.js';
import { ENGINE_NETWORK, assertEngineSpawnAllowed, engineBinaryMismatches, spawnRefusal } from '../../src/s2/spawn-gate.js';
import { isEngineExecutable, verifyBundleHash } from '../../src/s2/engine-check.js';

const ctxFor = (root: string, privateMode = false) => ({
  resources: { engineBundle: path.join(root, 'engine', 'bundle') }, settings: { get: () => ({ privateMode }) },
  log: { info() {}, warn() {}, error() {}, debug() {} },
}) as unknown as ServiceContext;
const entry = (root: string, rel: string) => { const d = fs.readFileSync(path.join(root, rel)); return { path: rel, size: d.length, sha256: crypto.createHash('sha256').update(d).digest('hex') }; };

describe('SEC-066 spawn gate', () => {
  it('every shipped engine declares network: false and runs in Private Mode; unknown engines are refused there', () => {
    for (const e of ['whisper.cpp', 'sherpa-onnx', 'stable-diffusion.cpp', 'ace-step', 'loops', 'none']) {
      expect(ENGINE_NETWORK[e]).toBe(false);
      expect(spawnRefusal(e, true)).toBeNull();
    }
    expect(spawnRefusal('python-downloader', true)?.code).toBe('EM-8202');
    expect(spawnRefusal('python-downloader', false)).toBeNull();
  });
});

describe('SEC-061 engine hashes', () => {
  it('generator engine executables are hashed before spawn against engine-manifest.json; a flipped byte → EM-7108', async () => {
    const root = tempDir('em-gate-');
    const dir = path.join(root, 'engines', 'whisper.cpp', '1.7.6'); fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(root, 'engine', 'bundle'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'whisper-cli.exe'), 'MZ-binary'); fs.writeFileSync(path.join(dir, 'README.txt'), 'docs');
    fs.writeFileSync(path.join(root, 'engine-manifest.json'), JSON.stringify({ files: [entry(root, 'engines/whisper.cpp/1.7.6/whisper-cli.exe'), entry(root, 'engines/whisper.cpp/1.7.6/README.txt')] }));
    const ctx = ctxFor(root);
    expect(await engineBinaryMismatches(ctx, dir)).toEqual([]);
    await expect(assertEngineSpawnAllowed(ctx, 'whisper.cpp', dir)).resolves.toBeUndefined();
    fs.writeFileSync(path.join(dir, 'whisper-cli.exe'), 'MZ-binarX');
    await expect(assertEngineSpawnAllowed(ctx, 'whisper.cpp', dir)).rejects.toMatchObject({ code: 'EM-7108' });
    fs.writeFileSync(path.join(dir, 'README.txt'), 'changed docs are not executables');
    expect(await engineBinaryMismatches(ctx, dir)).toEqual(['engines/whisper.cpp/1.7.6/whisper-cli.exe']);
  });
  it('no manifest (development) → nothing to compare', async () => {
    expect(await engineBinaryMismatches(ctxFor(tempDir('em-gate-dev-')), '/nowhere')).toEqual([]);
  });
  it('engine-check covers Chrome Headless Shell and compositor executables, not their data files', async () => {
    const root = tempDir('em-ec-');
    for (const d of ['engine/bundle', 'engine/chrome', 'engine/compositor']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'engine/bundle/index.html'), '<html>');
    fs.writeFileSync(path.join(root, 'engine/chrome/chrome-headless-shell.exe'), 'chrome');
    fs.writeFileSync(path.join(root, 'engine/chrome/resources.pak'), 'pak');
    fs.writeFileSync(path.join(root, 'engine/compositor/remotion.exe'), 'comp');
    const files = ['engine/bundle/index.html', 'engine/chrome/chrome-headless-shell.exe', 'engine/chrome/resources.pak', 'engine/compositor/remotion.exe'].map((f) => entry(root, f));
    fs.writeFileSync(path.join(root, 'engine-manifest.json'), JSON.stringify({ files }));
    const ctx = ctxFor(root);
    expect(await verifyBundleHash(ctx)).toEqual({ hash: 'ok', mismatched: [] });
    fs.writeFileSync(path.join(root, 'engine/chrome/resources.pak'), 'changed');           // not an executable: not hashed at start
    fs.writeFileSync(path.join(root, 'engine/compositor/remotion.exe'), 'tampered');
    expect(await verifyBundleHash(ctx)).toEqual({ hash: 'mismatch', mismatched: ['engine/compositor/remotion.exe'] });
    expect(isEngineExecutable('engine/chrome/chrome-headless-shell')).toBe(true);
  });
});
