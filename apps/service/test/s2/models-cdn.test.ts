// Operator model CDN (decision 2026-10-25; SEC-071, SEC-072): the Service fetches <cdn>/models.json + .sig through the egress
// module (Private Mode → EM-8202), at most once per 24 h and on R-147 refresh, size-capped, verifies before saving atomically,
// and keeps the last accepted list on every failure. Downloads are then allowed from the CDN host only. Fake fetch, dev key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createEgress } from '../../src/services/egress.js';
import { modelCdnUrlProblem, modelDownloadHosts, normalizeModelCdnUrl, MODEL_CDN_PLACEHOLDER } from '../../src/services/model-cdn.js';
import { json, startS2, type S2Service } from './harness.js';

const CDN = 'https://models.expertmotion.example/v1';
const HOST = 'models.expertmotion.example';
const blob = crypto.randomBytes(50_000);
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const key = { kid: 'D1', publicKeyHex: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex'), status: 'active' as const, since: '2026-10-25' };
const unpinned: ModelDef = {
  key: 'voice-cdn', label: 'Test voice', engine: 'sherpa-onnx', task: 'tts', version: 't1', availability: 'download',
  files: [{ name: 'voice.onnx', bytes: blob.length, bytesExact: false, sha256: 'TO_PIN', url: 'https://huggingface.co/test/resolve/main/voice.onnx', revision: 'TO_PIN' }],
  bytes: blob.length, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' }, commercialUse: 'yes', languages: ['id'], minTier: 'T0',
  recommendedFor: ['T0'], ramBytes: 1, flag: null, priority: 'P1', notes: [],
};
const manifest = (seq: number, url = `${CDN}/m/${sha(blob)}`) => Buffer.from(JSON.stringify({ schema: 1, seq, issuedAt: '2026-10-25T10:00:00Z',
  models: [{ key: 'voice-cdn', files: [{ name: 'voice.onnx', bytes: blob.length, sha256: sha(blob), url, revision: 'c0ffee' }] }] }));
const signed = (b: Buffer) => JSON.stringify({ kid: 'D1', sig: crypto.sign(null, b, privateKey).toString('base64') });

type Update = { cdn: string | null; checkedAt: string | null; outcome: string | null; code: string | null; reason: string | null; seq: number | null };
type List = { items: Array<{ key: string; hashes: Array<{ sha256: string | null }>; status: string }>; registry: { source: string; seq: number; code: string | null; reason: string | null }; registryUpdate: Update };

describe('model CDN config (EM_MODEL_CDN_URL)', () => {
  it('accepts only https host names; the placeholder means no CDN; the allow-list is then exactly the CDN host', () => {
    expect(normalizeModelCdnUrl(`${CDN}/`)).toBe(CDN);
    expect(normalizeModelCdnUrl(MODEL_CDN_PLACEHOLDER)).toBeNull();
    expect(normalizeModelCdnUrl('')).toBeNull();
    for (const bad of ['http://models.x.com', 'https://10.0.0.1', 'https://localhost', 'https://u:p@models.x.com', 'https://models.x.com:8443', 'https://models.x.com/?q=1'])
      expect(modelCdnUrlProblem(bad), bad).not.toBeNull();
    expect(modelDownloadHosts(CDN)).toEqual([HOST]);
    expect(modelDownloadHosts(null)).toContain('huggingface.co');
  });
});

describe('signed model manifest from the Operator CDN (SEC-072)', () => {
  let s: S2Service; let clock = Date.parse('2026-10-25T12:00:00Z');
  let served: { json: Buffer | string; sig: string; jsonStatus?: number; fail?: boolean } = { json: manifest(2), sig: signed(manifest(2)) };
  const calls: string[] = [];
  beforeAll(async () => {
    s = await startS2([health, createModelsModule({ registry: () => [unpinned], freeBytes: async () => 1e12, manifestKeys: () => [key], cdnUrl: CDN, now: () => clock, renderBusy: () => false })]);
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, modelHosts: () => [HOST], impl: (async (u: string | URL | Request) => {
      const url = String(u); calls.push(url);
      if (served.fail) throw new TypeError('fetch failed');
      if (url === `${CDN}/models.json`) return new Response(served.json, { status: served.jsonStatus ?? 200 });
      if (url === `${CDN}/models.json.sig`) return new Response(served.sig, { status: 200 });
      if (url === `${CDN}/m/${sha(blob)}`) return new Response(blob, { status: 200, headers: { 'content-length': String(blob.length) } });
      return new Response('nope', { status: 404 });
    }) as typeof fetch });
  });
  afterAll(async () => { await s.close(); });
  const list = async () => json<List>(await s.api('/models'));
  const refresh = async () => json<{ registry: List['registry']; registryUpdate: Update }>(await s.api('/models/registry/refresh', { method: 'POST' }));

  it('R-140 fetches models.json + .sig once, verifies, saves them into the models folder and pins the entry', async () => {
    const l = await list();
    expect(calls).toEqual([`${CDN}/models.json`, `${CDN}/models.json.sig`]);
    expect(l.registry).toMatchObject({ source: 'signed', seq: 2 });
    expect(l.registryUpdate).toMatchObject({ cdn: CDN, outcome: 'updated', code: null, seq: 2 });
    expect(l.items[0]!.hashes[0]!.sha256).toBe(sha(blob));
    expect(fs.readFileSync(path.join(s.ctx.paths.models, 'models.json')).equals(manifest(2))).toBe(true);
    expect(fs.readdirSync(s.ctx.paths.models).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('at most once per 24 h: a second list does not fetch; after 24 h it checks again (unchanged)', async () => {
    calls.length = 0;
    await list();
    expect(calls).toEqual([]);
    clock += 25 * 3600_000;
    const l = await list();
    expect(calls).toHaveLength(2);
    expect(l.registryUpdate).toMatchObject({ outcome: 'unchanged', seq: 2 });
  });

  it('a tampered, stale or oversize manifest is refused (EM-7111) and the accepted list stays', async () => {
    served = { json: Buffer.from(manifest(3).toString().replace(sha(blob), sha('evil'))), sig: signed(manifest(3)) };
    let r = await refresh();
    expect(r.registryUpdate).toMatchObject({ outcome: 'refused', code: 'EM-7111', reason: 'bad-signature' });
    expect(r.registry).toMatchObject({ source: 'signed', seq: 2 });
    served = { json: manifest(1), sig: signed(manifest(1)) };
    expect((await refresh()).registryUpdate).toMatchObject({ outcome: 'refused', reason: 'stale' });
    const big = Buffer.alloc(2 * 1024 * 1024 + 10, 0x20);
    served = { json: big, sig: signed(big) };
    expect((await refresh()).registryUpdate).toMatchObject({ outcome: 'failed', code: 'EM-7111', reason: 'too-large' });
    served = { json: 'x', sig: '', jsonStatus: 404 };
    expect((await refresh()).registryUpdate).toMatchObject({ outcome: 'failed', code: 'EM-7111', reason: 'http-404' });
    r = await refresh();
    expect(r.registry).toMatchObject({ source: 'signed', seq: 2 });
    expect(fs.readFileSync(path.join(s.ctx.paths.models, 'models.json')).equals(manifest(2))).toBe(true);
  });

  it('offline keeps the list (EM-8201, not counted as a check); Private Mode blocks the fetch before any call (EM-8202)', async () => {
    const before = (await refresh()).registryUpdate.checkedAt;
    served = { json: manifest(4), sig: signed(manifest(4)), fail: true };
    clock += 60_000;
    const off = await refresh();
    expect(off.registryUpdate).toMatchObject({ outcome: 'failed', code: 'EM-8201', reason: 'network', checkedAt: before });
    served = { json: manifest(4), sig: signed(manifest(4)) };
    s.ctx.settings.update({ privateMode: true });
    calls.length = 0;
    const priv = await refresh();
    expect(priv.registryUpdate).toMatchObject({ outcome: 'skipped', code: 'EM-8202' });
    expect(calls).toEqual([]);
    s.ctx.settings.update({ privateMode: false });
    expect((await refresh()).registryUpdate).toMatchObject({ outcome: 'updated', seq: 4 });
  });

  it('the model installs from the CDN; a manifest entry on another host (Hugging Face) is not applied', async () => {
    const r = await s.api('/models/voice-cdn/install', { method: 'POST' });
    expect(r.status).toBe(202);
    await s.waitEvent((e) => e.name === 'model.installed' || e.name === 'model.failed', 5000);
    expect((await json<{ status: string }>(await s.api('/models/voice-cdn'))).status).toBe('installed');
    expect(calls).toContain(`${CDN}/m/${sha(blob)}`);
    const hf = manifest(5, 'https://huggingface.co/test/resolve/c0ffee/voice.onnx');
    served = { json: hf, sig: signed(hf) };
    const u = await refresh();
    expect(u.registryUpdate).toMatchObject({ outcome: 'updated', seq: 5 });
    const one = await json<{ hashes: Array<{ sha256: string | null }> }>(await s.api('/models/voice-cdn'));
    expect(one.hashes[0]!.sha256).toBeNull();                                 // entry dropped: host not on the CDN-only allow-list
  });
});

describe('without a model CDN (development build)', () => {
  it('no fetch happens and the built-in allow-list stays', async () => {
    const calls: string[] = [];
    const s = await startS2([health, createModelsModule({ registry: () => [unpinned], freeBytes: async () => 1e12, manifestKeys: () => [key], cdnUrl: null })]);
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async (u: string | URL | Request) => { calls.push(String(u)); return new Response('x'); }) as typeof fetch });
    const l = await json<List>(await s.api('/models'));
    expect(l.registryUpdate).toMatchObject({ cdn: null, outcome: 'skipped', reason: 'no-cdn' });
    expect((await json<{ registryUpdate: Update }>(await s.api('/models/registry/refresh', { method: 'POST' }))).registryUpdate.reason).toBe('no-cdn');
    expect(calls).toEqual([]);
    await s.close();
  });
});
