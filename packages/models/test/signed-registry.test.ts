// SEC-072: signed model manifest. Dev key pairs are generated at test time and never stored.
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applySignedRegistry, embeddedManifestKeys, registry, verifySignedRegistry, type ManifestKeyEntry, type SignedRegistryT } from '../src/index.js';
import { sha } from './helpers.js';

function devKey(kid = 'D1') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32);
  const entry: ManifestKeyEntry = { kid, publicKeyHex: raw.toString('hex'), status: 'active', since: '2026-10-24' };
  const signFile = (bytes: Buffer) => JSON.stringify({ kid, sig: sign(null, bytes, privateKey).toString('base64') });
  return { entry, signFile };
}
const whisper = registry['whisper-small']!;
const manifest = (seq: number, url = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/0123abcd/ggml-small.bin'): SignedRegistryT => ({
  schema: 1, seq, issuedAt: '2026-10-24T10:00:00Z',
  models: [{ key: 'whisper-small', files: [{ name: 'ggml-small.bin', bytes: 487_601_967, sha256: sha('weights'), url, revision: '0123abcd' }] }, { key: 'not-in-this-build', files: [{ name: 'x.bin', bytes: 1, sha256: sha('x'), url, revision: 'r' }] }],
});

describe('signed model manifest (SEC-072)', () => {
  it('the shipped key table holds only a placeholder, so every manifest is refused (built-in registry used)', () => {
    expect(embeddedManifestKeys()).toEqual([]);
    const bytes = Buffer.from(JSON.stringify(manifest(1)));
    expect(verifySignedRegistry(bytes, devKey().signFile(bytes))).toEqual({ ok: false, reason: 'no-keys' });
  });

  it('accepts a correctly signed manifest and overlays pinned files onto known registry entries only', () => {
    const k = devKey();
    const bytes = Buffer.from(JSON.stringify(manifest(3)));
    const r = verifySignedRegistry(bytes, k.signFile(bytes), { keys: [k.entry] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [out] = applySignedRegistry([whisper], r.registry);
    expect(out!.files[0]).toMatchObject({ sha256: sha('weights'), bytesExact: true, revision: '0123abcd' });
    expect(out!.bytes).toBe(487_601_967);
    expect(whisper.files[0]!.sha256).not.toBe(sha('weights'));                           // built-in entry untouched (its own pins.ts pin)
  });

  it('rejects tampered bytes, unknown kids, revoked keys, malformed signatures, stale sequence and foreign hosts', () => {
    const k = devKey();
    const bytes = Buffer.from(JSON.stringify(manifest(5)));
    const sig = k.signFile(bytes);
    const tampered = Buffer.from(bytes.toString('utf8').replace(sha('weights'), sha('evil')));
    expect(verifySignedRegistry(tampered, sig, { keys: [k.entry] })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySignedRegistry(bytes, sig, { keys: [devKey('D2').entry] })).toEqual({ ok: false, reason: 'unknown-kid' });
    expect(verifySignedRegistry(bytes, sig, { keys: [{ ...k.entry, status: 'revoked' }] })).toEqual({ ok: false, reason: 'unknown-kid' });
    expect(verifySignedRegistry(bytes, 'not json', { keys: [k.entry] })).toEqual({ ok: false, reason: 'malformed-signature' });
    expect(verifySignedRegistry(bytes, sig, { keys: [k.entry], lastSeq: 6 })).toEqual({ ok: false, reason: 'stale' });
    expect(verifySignedRegistry(bytes, sig, { keys: [k.entry], lastSeq: 5 }).ok).toBe(true);
    const http = Buffer.from(JSON.stringify(manifest(7, 'http://huggingface.co/x/ggml-small.bin')));
    expect(verifySignedRegistry(http, k.signFile(http), { keys: [k.entry] })).toEqual({ ok: false, reason: 'malformed' });
    const evilHost = Buffer.from(JSON.stringify(manifest(8, 'https://evil.example/ggml-small.bin')));
    const r = verifySignedRegistry(evilHost, k.signFile(evilHost), { keys: [k.entry] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(applySignedRegistry([whisper], r.registry)[0]).toBe(whisper);   // SEC-071: entry ignored
  });
});
