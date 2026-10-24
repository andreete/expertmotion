import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { buildManifest, canonicalManifestBytes, isEngineExecutable, verifyManifest, type Ed25519Verify, type SignedManifest } from '../src/lib/integrity.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubDer = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));

const edVerify: Ed25519Verify = (message, sigB64, pk) =>
  verify(null, Buffer.from(message), { key: Buffer.from(pk), format: 'der', type: 'spki' }, Buffer.from(sigB64, 'base64'));

function signManifest(entries: { path: string; sha256: string; bytes: number }[]): SignedManifest {
  const manifest = buildManifest({ appVersion: '1.0.0', builtAt: '2026-10-24T00:00:00Z', entries });
  const signature = sign(null, Buffer.from(canonicalManifestBytes(manifest)), privateKey).toString('base64');
  return { manifest, signature, alg: 'ed25519' };
}

describe('integrity manifest (SEC-061, SEC-133; hardening item 4)', () => {
  const entries = [
    { path: 'dist/service/service.jsc', sha256: 'aa', bytes: 10 },
    { path: 'engine/bundle/index.html', sha256: 'bb', bytes: 20 },
  ];

  it('sorts entries canonically regardless of input order', () => {
    const a = buildManifest({ appVersion: '1', builtAt: 't', entries });
    const b = buildManifest({ appVersion: '1', builtAt: 't', entries: [...entries].reverse() });
    expect(canonicalManifestBytes(a)).toEqual(canonicalManifestBytes(b));
  });

  it('verifies a correctly signed manifest against matching digests', () => {
    const signed = signManifest(entries);
    const actual = new Map(entries.map((e) => [e.path, { sha256: e.sha256, bytes: e.bytes }]));
    expect(verifyManifest(signed, pubDer, actual, edVerify)).toEqual({ ok: true });
  });

  it('rejects a tampered signature', () => {
    const signed = signManifest(entries);
    const bad = { ...signed, signature: Buffer.from('nope').toString('base64') };
    const actual = new Map(entries.map((e) => [e.path, { sha256: e.sha256, bytes: e.bytes }]));
    expect(verifyManifest(bad, pubDer, actual, edVerify)).toEqual({ ok: false, code: 'bad-signature' });
  });

  it('detects a hash mismatch (a flipped byte in a binary)', () => {
    const signed = signManifest(entries);
    const actual = new Map([
      ['dist/service/service.jsc', { sha256: 'aa', bytes: 10 }],
      ['engine/bundle/index.html', { sha256: 'CORRUPT', bytes: 20 }],
    ]);
    expect(verifyManifest(signed, pubDer, actual, edVerify)).toMatchObject({ ok: false, code: 'hash-mismatch', path: 'engine/bundle/index.html' });
  });

  it('detects a missing file and a size mismatch', () => {
    const signed = signManifest(entries);
    const missing = new Map([['dist/service/service.jsc', { sha256: 'aa', bytes: 10 }]]);
    expect(verifyManifest(signed, pubDer, missing, edVerify)).toMatchObject({ ok: false, code: 'missing' });
    const wrongSize = new Map(entries.map((e) => [e.path, { sha256: e.sha256, bytes: e.bytes + 1 }]));
    expect(verifyManifest(signed, pubDer, wrongSize, edVerify)).toMatchObject({ ok: false, code: 'size-mismatch' });
  });

  it('hashing is sha256 hex (sanity)', () => {
    expect(createHash('sha256').update('x').digest('hex')).toHaveLength(64);
  });
});

describe('SEC-061 engine executables in the integrity manifest', () => {
  it('selects Chrome Headless Shell and compositor binaries, not resources or docs', () => {
    for (const f of ['C:\\x\\engine\\chrome\\chrome-headless-shell.exe', 'engine/chrome/chrome_elf.dll', 'engine/compositor/remotion.exe', 'engine/compositor/ffmpeg.exe', 'engine/compositor/remotion', 'engine/chrome/chrome-headless-shell'])
      expect(isEngineExecutable(f), f).toBe(true);
    for (const f of ['engine/chrome/resources.pak', 'engine/chrome/locales/en-US.pak', 'engine/compositor/package.json', 'engine/chrome/LICENSE'])
      expect(isEngineExecutable(f), f).toBe(false);
  });
});
