// Model Manager additions: FR-121 model card fields, FR-123 recommended mark, FR-124 pause during Standard/Accelerated
// renders + Cancel that discards the partial, FR-126 per-engine folder, SEC-072 signed manifest overlay (dev key, test time only).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createEgress } from '../../src/services/egress.js';
import { json, startS2, type S2Service } from './harness.js';

const blob = crypto.randomBytes(200_000);
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const def = (key: string, over: Partial<ModelDef> = {}): ModelDef => ({
  key, label: `Test ${key}`, engine: 'sherpa-onnx', task: 'tts', version: 't1', availability: 'download',
  files: [{ name: 'voice.onnx', bytes: blob.length, bytesExact: true, sha256: sha(blob), url: `https://huggingface.co/test/resolve/abc/${key}.onnx`, revision: 'abc' }],
  bytes: blob.length, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' }, commercialUse: 'yes', languages: ['id'], minTier: 'T0',
  recommendedFor: ['T0'], ramBytes: 1, flag: 'model:piper-id', priority: 'P1', notes: ['a note'], ...over,
});
type Dto = { key: string; status: string; bytesDone: number; pausedReason: string | null; recommended: boolean; hashes: Array<{ sha256: string | null }>; pathLabel: string;
  usedBy: { generators: string[] }; engineNotices: Array<{ spdx: string | null }>; languages: string[]; displayName: { en: string; id: string }; flag: string | null; licence: { name: string } };

describe('Model Manager: card, pause during render, discard, folders (FR-121…FR-126)', () => {
  let s: S2Service; let busy = false; let streamed = 0;
  beforeAll(async () => {
    s = await startS2([health, createModelsModule({ registry: () => [def('voice-slow'), def('big', { minTier: 'T2', recommendedFor: ['T2'] })], freeBytes: async () => 1e12, renderBusy: () => busy, pausePollMs: 20 })]);
    s.ctx.hooks.tier = () => 'T0';
    s.ctx.egress = createEgress({ isPrivate: () => false, impl: (async (_u: string | URL | Request, init?: RequestInit) => {
      const sig = init?.signal as AbortSignal | undefined;
      const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(blob.subarray(0, 1000)); streamed++; sig?.addEventListener('abort', () => c.error(new Error('aborted')), { once: true }); } });
      return new Response(stream, { status: 200, headers: { 'content-length': String(blob.length) } });
    }) as typeof fetch });
  });
  afterAll(async () => { await s.close(); });

  it('rows carry the model card, recommended mark, used-by and the GPL engine notice of the bundled espeak-ng (FR-120, FR-121, FR-123)', async () => {
    const list = await json<{ items: Dto[]; registry: { source: string; code: string | null } }>(await s.api('/models'));
    const v = list.items.find((i) => i.key === 'voice-slow')!;
    expect(v).toMatchObject({ recommended: true, languages: ['id'], usedBy: { generators: ['voice'] }, pathLabel: 'models\\sherpa-onnx\\voice-slow\\' });
    expect(v.hashes[0]!.sha256).toBe(sha(blob));
    expect(v.engineNotices.map((n) => n.spdx)).toContain('GPL-3.0-or-later');
    // Creator-facing product name (en/id); a row without a DISPLAY_NAMES entry falls back to its label; licence unchanged
    expect(v).toMatchObject({ displayName: { en: 'Test voice-slow', id: 'Test voice-slow' }, flag: 'model:piper-id', licence: { name: 'MIT' } });
    expect(list.items.find((i) => i.key === 'big')!.recommended).toBe(false);
    expect(list.registry).toEqual({ source: 'built-in', seq: 0, code: null, reason: null });
  });

  it('a download pauses while a Standard/Accelerated render runs and resumes after it (FR-124)', async () => {
    await s.api('/models/voice-slow/install', { method: 'POST' });
    for (let i = 0; i < 100 && !streamed; i++) await new Promise((r) => setTimeout(r, 10));
    busy = true;
    await s.waitEvent((e) => e.name === 'model.progress' && e.data['status'] === 'paused', 3000);
    const p = await json<Dto>(await s.api('/models/voice-slow'));
    expect([p.status, p.pausedReason]).toEqual(['paused', 'render']);
    const before = streamed;
    busy = false;
    await s.waitEvent((e) => e.name === 'model.progress' && e.data['status'] === 'downloading' && !e.data['pausedReason'], 3000);
    for (let i = 0; i < 100 && streamed === before; i++) await new Promise((r) => setTimeout(r, 10));
    expect(streamed).toBeGreaterThan(before);
  });

  it('Pause keeps the partial; Cancel (discard) deletes it (FR-124)', async () => {
    const paused = await json<Dto>(await s.api('/models/voice-slow/cancel', { method: 'POST' }));
    expect(paused.status).toBe('not-installed');
    expect(paused.bytesDone).toBeGreaterThan(0);
    const partial = path.join(s.ctx.paths.models, '.partial', 'voice-slow');
    expect(fs.existsSync(partial)).toBe(true);
    const gone = await json<Dto>(await s.api('/models/voice-slow/cancel?discard=true', { method: 'POST' }));
    expect(gone.bytesDone).toBe(0);
    expect(fs.existsSync(partial)).toBe(false);
  });

  it('R-146 returns the per-engine folder for the Shell; unknown engines 404 (FR-126)', async () => {
    const r = await json<{ path: string }>(await s.api('/models/engines/sherpa-onnx/reveal', { method: 'POST' }));
    expect(r.path).toBe(path.join(path.resolve(s.ctx.paths.models), 'sherpa-onnx'));
    expect(fs.statSync(r.path).isDirectory()).toBe(true);
    expect((await s.api('/models/engines/nope/reveal', { method: 'POST' })).status).toBe(404);
  });
});

describe('signed model manifest in the Service (SEC-072)', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const key = { kid: 'D1', publicKeyHex: (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex'), status: 'active' as const, since: '2026-10-24' };
  const unpinned = def('pin-me', { files: [{ ...def('pin-me').files[0]!, sha256: 'TO_PIN', revision: 'TO_PIN' }] });
  const manifest = Buffer.from(JSON.stringify({ schema: 1, seq: 2, issuedAt: '2026-10-24T10:00:00Z', models: [{ key: 'pin-me', files: [{ name: 'voice.onnx', bytes: blob.length, sha256: sha(blob), url: 'https://huggingface.co/test/resolve/c0ffee/voice.onnx', revision: 'c0ffee' }] }] }));
  const start = async (bytes: Buffer, keys = [key]) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-sec072-'));
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'models', 'models.json'), bytes);
    fs.writeFileSync(path.join(dataDir, 'models', 'models.json.sig'), JSON.stringify({ kid: 'D1', sig: crypto.sign(null, manifest, privateKey).toString('base64') }));
    return startS2([health, createModelsModule({ registry: () => [unpinned], freeBytes: async () => 1e12, manifestKeys: () => keys })], { dataDir });
  };

  it('a verified manifest pins the entry; a tampered one is ignored with EM-7111 and the built-in copy stays', async () => {
    const ok = await start(manifest);
    const l = await json<{ items: Dto[]; registry: { source: string; seq: number } }>(await ok.api('/models'));
    expect(l.registry).toMatchObject({ source: 'signed', seq: 2 });
    expect(l.items[0]!.hashes[0]!.sha256).toBe(sha(blob));
    await ok.close();
    const bad = await start(Buffer.from(manifest.toString().replace(sha(blob), sha('evil'))));
    const b = await json<{ items: Dto[]; registry: { source: string; code: string; reason: string } }>(await bad.api('/models'));
    expect(b.registry).toMatchObject({ source: 'built-in', code: 'EM-7111', reason: 'bad-signature' });
    expect(b.items[0]!.hashes[0]!.sha256).toBeNull();
    expect((await bad.api('/models/pin-me/install', { method: 'POST' })).status).toBe(422);    // still unpinned → EM-7110
    await bad.close();
    const nokeys = await start(manifest, []);
    expect((await json<{ registry: { reason: string } }>(await nokeys.api('/models'))).registry.reason).toBe('no-keys');
    await nokeys.close();
  });
});
