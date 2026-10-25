// tools/model-mirror: prepare (streamed download + sha256, opaque m/<sha256> objects, resume, revision pinning, licence skips),
// manifest generation and signing round-trip against the app's verifySignedRegistry. No network: a fake fetch serves fixtures.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySignedRegistry, verifySignedRegistry, type ModelDef } from '@expertmotion/models';
// @ts-expect-error plain ESM tool without type declarations
import { buildManifest, manifestBytes, normalizeCdn, prepare, selectModels, signDir, signManifestBytes, withRevision } from '../lib/mirror-lib.mjs';
// @ts-expect-error plain ESM tool without type declarations
import { keygen, loadPrivateKey } from '../../license-cli/src/lib/keys.mjs';

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const COMMIT = 'a'.repeat(40);
const CDN = 'https://models.expertmotion.example/v1/';
const blobA = crypto.randomBytes(300_000); const blobB = crypto.randomBytes(5_000); const blobC = crypto.randomBytes(1_000);
const HF = (repo: string, file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
const file = (name: string, b: Buffer, url: string) => ({ name, bytes: b.length, bytesExact: false, sha256: 'TO_PIN', url, revision: 'TO_PIN' });
const def = (key: string, files: ModelDef['files'], over: Partial<ModelDef> = {}): ModelDef => ({
  key, label: key, engine: 'whisper.cpp', task: 'stt', version: '2026.10', availability: 'download', files, bytes: files.reduce((a, f) => a + f.bytes, 0),
  licence: { name: 'MIT', url: 'https://example.org', redistribution: 'yes' }, commercialUse: 'yes', languages: [], minTier: 'T0', recommendedFor: [], ramBytes: 1, flag: null, priority: 'P1', notes: [], ...over,
});
const DEFS: ModelDef[] = [
  def('whisper-test', [file('ggml-test.bin', blobA, HF('ggerganov/whisper.cpp', 'ggml-test.bin'))]),
  def('piper-test', [file('voice.onnx', blobB, HF('rhasspy/piper-voices', 'id/voice.onnx')), file('voice.onnx.json', blobC, HF('rhasspy/piper-voices', 'id/voice.onnx.json'))],
    { licence: { name: 'dataset unverified', url: 'https://example.org', redistribution: 'verify' } }),
  def('gated-test', [file('x.bin', blobC, HF('acme/gated', 'x.bin'))], { licence: { name: 'Community', url: 'https://example.org', redistribution: 'no' } }),
  def('empty-test', []),
  def('bundled-test', [], { availability: 'bundled' }),
];
const BODY: Record<string, Buffer> = { 'ggml-test.bin': blobA, 'voice.onnx': blobB, 'voice.onnx.json': blobC, 'x.bin': blobC };

/** Fake Hugging Face: resolve/<rev>/ answers 302 + x-repo-commit to a CDN host that serves the bytes (Range supported). */
function fakeHf(opts: { cutAfter?: number } = {}) {
  const calls: Array<{ url: string; range: string | undefined; auth: string | undefined }> = [];
  let cut = opts.cutAfter;
  const impl = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, range: init.headers['Range'], auth: init.headers['Authorization'] });
    const u = new URL(url);
    if (u.hostname === 'huggingface.co') {
      const name = u.pathname.split('/').pop()!;
      return new Response(null, { status: 302, headers: { location: `https://cas-bridge.xethub.hf.co/obj/${name}`, 'x-repo-commit': COMMIT } });
    }
    const body = BODY[u.pathname.split('/').pop()!]!;
    const m = /^bytes=(\d+)-$/.exec(init.headers['Range'] ?? '');
    const start = m ? Number(m[1]) : 0;
    let slice = body.subarray(start);
    if (cut !== undefined) {                                                  // first transfer dies after `cut` bytes
      const n = cut; cut = undefined;
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({ pull(c) { if (!sent) { sent = true; c.enqueue(new Uint8Array(slice.subarray(0, n))); } else c.error(new Error('connection reset')); } });
      return new Response(stream, { status: 200, headers: { 'content-length': String(slice.length) } });
    }
    if (m) return new Response(new Uint8Array(slice), { status: 206, headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } });
    slice = body;
    return new Response(new Uint8Array(slice), { status: 200, headers: { 'content-length': String(slice.length) } });
  };
  return { calls, impl };
}

describe('model-mirror selection and URLs', () => {
  it('mirrors only availability download with files; skips redistribution no always and verify unless --include-verify (with reasons)', () => {
    const r = selectModels(DEFS);
    expect(r.chosen.map((d: ModelDef) => d.key)).toEqual(['whisper-test']);
    const why = Object.fromEntries(r.skipped.map((s: { key: string; why: string }) => [s.key, s.why]));
    expect(why['gated-test']).toMatch(/does not allow redistribution/);
    expect(why['piper-test']).toMatch(/--include-verify/);
    expect(why['empty-test']).toMatch(/no files/);
    expect(why['bundled-test']).toMatch(/bundled/);
    expect(selectModels(DEFS, { includeVerify: true }).chosen.map((d: ModelDef) => d.key)).toEqual(['whisper-test', 'piper-test']);
    expect(selectModels(DEFS, { includeVerify: true }).skipped.map((s: { key: string }) => s.key)).toContain('gated-test');
  });
  it('pins Hugging Face URLs to a revision and normalises the CDN base (https only)', () => {
    expect(withRevision(HF('a/b', 'dir/f.bin'), COMMIT)).toBe(`https://huggingface.co/a/b/resolve/${COMMIT}/dir/f.bin`);
    expect(normalizeCdn(CDN)).toBe('https://models.expertmotion.example/v1');
    for (const bad of ['http://models.x.com', 'https://1.2.3.4', 'https://u:p@models.x.com', 'https://models.x.com/?a=1', 'nope']) expect(() => normalizeCdn(bad), bad).toThrow();
  });
});

describe('model-mirror prepare + sign → verifySignedRegistry', () => {
  it('streams, hashes, stores m/<sha256>, records x-repo-commit, writes a manifest the app verifies and applies (CDN host only)', async () => {
    const out = tmp('em-mirror-');
    const hf = fakeHf();
    const logs: string[] = [];
    const r = await prepare({ defs: DEFS, out, cdn: CDN, fetch: hf.impl, includeVerify: true, hfToken: 'hf_secret', now: () => new Date('2026-10-25T08:00:00Z'), log: (s: string) => logs.push(s) });
    expect(r.failed).toEqual([]);
    expect(r.manifest).toMatchObject({ schema: 1, seq: 1, issuedAt: '2026-10-25T08:00:00.000Z' });
    expect(r.manifest.models.map((m: { key: string }) => m.key)).toEqual(['whisper-test', 'piper-test']);
    const f0 = r.manifest.models[0].files[0];
    expect(f0).toEqual({ name: 'ggml-test.bin', bytes: blobA.length, sha256: sha(blobA), url: `https://models.expertmotion.example/v1/m/${sha(blobA)}`, revision: COMMIT });
    for (const b of [blobA, blobB, blobC]) expect(fs.readFileSync(path.join(out, 'm', sha(b))).equals(b)).toBe(true);
    expect(fs.existsSync(path.join(out, 'models.json.sig'))).toBe(false);
    expect(logs.join('\n')).toMatch(/skip gated-test: .*does not allow redistribution/);
    expect(hf.calls.filter((c) => c.auth).every((c) => new URL(c.url).hostname === 'huggingface.co')).toBe(true);   // token never leaves huggingface.co

    // sign with a sealed key created by the licence CLI's keygen (outside the repo), then verify with the app's code
    const keyDir = tmp('em-mirror-key-');
    const pass = 'correct horse battery staple';
    const kg = keygen({ kid: 'M1', out: path.join(keyDir, 'manifest-M1.key.json'), seal: true, passphrase: pass });
    const key = loadPrivateKey({ 'key-file': kg.path, passphrase: pass });
    const s = await signDir({ out, key });
    expect(s).toMatchObject({ kid: 'M1', seq: 1, models: 2, publicKeyHex: kg.publicKeyHex });
    const bytes = fs.readFileSync(path.join(out, 'models.json')); const sig = fs.readFileSync(path.join(out, 'models.json.sig'), 'utf8');
    const keys = [{ kid: 'M1', publicKeyHex: kg.publicKeyHex, status: 'active' as const, since: '2026-10-25' }];
    const v = verifySignedRegistry(bytes, sig, { keys });
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    const applied = applySignedRegistry(DEFS, v.registry, ['models.expertmotion.example']);
    expect(applied[0]!.files[0]).toMatchObject({ sha256: sha(blobA), bytesExact: true, url: f0.url });
    expect(verifySignedRegistry(Buffer.from(bytes.toString().replace('"seq": 1', '"seq": 9')), sig, { keys })).toEqual({ ok: false, reason: 'bad-signature' });
    expect(verifySignedRegistry(bytes, sig, { keys: [{ ...keys[0]!, kid: 'M2' }] })).toEqual({ ok: false, reason: 'unknown-kid' });

    // re-run: nothing is downloaded again, seq rises, the stale signature is removed
    const before = hf.calls.length;
    const r2 = await prepare({ defs: DEFS, out, cdn: CDN, fetch: hf.impl, includeVerify: true, log: () => undefined });
    expect(hf.calls.length).toBe(before);
    expect(r2.manifest.seq).toBe(2);
    expect(fs.existsSync(path.join(out, 'models.json.sig'))).toBe(false);
    expect(verifySignedRegistry(bytes, sig, { keys, lastSeq: 2 })).toEqual({ ok: false, reason: 'stale' });
  });

  it('resumes an interrupted file with Range from the recorded commit and still hashes the whole file', async () => {
    const out = tmp('em-mirror-resume-');
    const hf = fakeHf({ cutAfter: 120_000 });
    const one = [DEFS[0]!];
    const r1 = await prepare({ defs: one, out, cdn: CDN, fetch: hf.impl, log: () => undefined });
    expect(r1.failed).toHaveLength(1);
    expect(r1.manifest.models).toEqual([]);
    expect(fs.statSync(path.join(out, '.partial', 'whisper-test', 'ggml-test.bin.part')).size).toBe(120_000);
    const r2 = await prepare({ defs: one, out, cdn: CDN, fetch: hf.impl, log: () => undefined });
    expect(r2.failed).toEqual([]);
    const resumed = hf.calls.filter((c) => c.range === 'bytes=120000-');
    expect(resumed.length).toBeGreaterThan(0);
    expect(hf.calls.some((c) => c.url.includes(`/resolve/${COMMIT}/`))).toBe(true);    // resume pinned to the commit seen first
    expect(r2.manifest.models[0].files[0]).toMatchObject({ sha256: sha(blobA), bytes: blobA.length, revision: COMMIT });
    expect(fs.existsSync(path.join(out, '.partial', 'whisper-test', 'ggml-test.bin.part'))).toBe(false);
  });

  it('a --revision map pins the request URL; a pinned registry sha256 that does not match is refused', async () => {
    const out = tmp('em-mirror-rev-');
    const hf = fakeHf();
    const rev = 'b'.repeat(40);
    const r = await prepare({ defs: [DEFS[0]!], out, cdn: CDN, fetch: hf.impl, revisions: { 'ggerganov/whisper.cpp': rev }, log: () => undefined });
    expect(hf.calls[0]!.url).toBe(`https://huggingface.co/ggerganov/whisper.cpp/resolve/${rev}/ggml-test.bin`);
    expect(r.manifest.models[0].files[0].revision).toBe(rev);
    const wrong = def('whisper-pinned', [{ ...file('ggml-test.bin', blobA, HF('ggerganov/whisper.cpp', 'ggml-test.bin')), sha256: 'c'.repeat(64) }]);
    const r2 = await prepare({ defs: [wrong], out: tmp('em-mirror-bad-'), cdn: CDN, fetch: fakeHf().impl, log: () => undefined });
    expect(r2.failed[0].error).toMatch(/does not match the registry's pinned/);
  });

  it('buildManifest + signManifestBytes are deterministic over the exact bytes', () => {
    const seed = crypto.randomBytes(32);
    const state = { schema: 1, files: { 'whisper-test/ggml-test.bin': { name: 'ggml-test.bin', bytes: 3, sha256: 'd'.repeat(64), revision: COMMIT, upstream: 'x' } } };
    const m = buildManifest({ defs: [DEFS[0]!], state, cdn: CDN, seq: 7, issuedAt: '2026-10-25T00:00:00.000Z' });
    const b = manifestBytes(m);
    const env = signManifestBytes(b, { kid: 'M1', seed });
    expect(env.sig).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    expect(signManifestBytes(b, { kid: 'M1', seed })).toEqual(env);
    const pub = (crypto.createPublicKey(crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' }))
      .export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
    expect(verifySignedRegistry(b, JSON.stringify(env), { keys: [{ kid: 'M1', publicKeyHex: pub, status: 'active', since: '' }] }).ok).toBe(true);
    expect(() => buildManifest({ defs: [], state, cdn: CDN, seq: 0, issuedAt: '' })).toThrow();
  });
});
