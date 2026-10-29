// Review 2026-10-29 (A1–A3): voice-first batches are cancellable (the job stops, nothing stays behind), a re-planned plan reuses the
// clips already made for the same text + voice + speed instead of paying again, and clips of a failed / replaced pass leave the Library.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry, type ModelDef } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createAssetsModule } from '../../src/modules/assets.js';
import { createModelsModule } from '../../src/modules/models.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { createEgress } from '../../src/services/egress.js';
import { type GeneratorEngines } from '../../src/s2/generators-service.js';
import { modelsServiceOf } from '../../src/s2/models-service.js';
import { ingestOf } from '../../src/s2/ingest.js';
import { listAssets } from '../../src/s2/assets-repo.js';
import { hasFfmpeg, startS2, wavBuffer, type S2Service } from './harness.js';

describe.skipIf(!hasFfmpeg)('review A1–A3: voice-first batches (cancel, reuse, cleanup)', { timeout: 30_000 }, () => {
  let s: S2Service; let pid: string;
  const blob = crypto.randomBytes(1000);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  const file = (name: string, key: string) => ({ name, bytes: blob.length, bytesExact: true, sha256: sha, url: `https://huggingface.co/test/resolve/abc/${key}/${name}`, revision: 'abc' });
  const base = { version: 't1', availability: 'download' as const, licence: { name: 'MIT', url: 'https://example.org/mit', redistribution: 'yes' as const }, commercialUse: 'yes' as const, languages: ['id' as const],
    minTier: 'T0' as const, recommendedFor: ['T0' as const], ramBytes: 0, flag: null, priority: 'P1' as const, notes: [] };
  const voiceDef: ModelDef = { ...base, key: 'piper-id-news-medium', label: 'piper test', engine: 'sherpa-onnx', task: 'tts', files: [file('v.onnx', 'p')], bytes: blob.length };
  const calls: string[] = []; let failOn: string | null = null; let holdOn: string | null = null; let held: (() => void) | null = null;
  const engines: Partial<GeneratorEngines> = {
    voice: async (i, c) => {
      calls.push(i.text);
      if (failOn && i.text.includes(failOn)) throw new Error('sherpa failed');
      if (holdOn && i.text.includes(holdOn)) await new Promise<void>((res) => { held = res; c.signal.addEventListener('abort', () => res(), { once: true }); });
      const out = path.join(c.jobDir, 'out.wav');
      // a different tone per text so no two clips de-duplicate to one asset
      fs.writeFileSync(out, wavBuffer(Math.round((i.text.length * 60) / (i.speed ?? 1)), 200 + (i.text.length % 50) * 7, 16000));
      return { wavPath: out };
    },
  };
  const notices: Array<Record<string, unknown>> = [];
  const voiceAssets = () => listAssets(s.ctx, pid).filter((a) => a.kind === 'audio').map((a) => a.id);

  beforeAll(async () => {
    s = await startS2([health, createAssetsModule(), createModelsModule({ registry: () => [voiceDef, registry['frame-composite']!], freeBytes: async () => 1e12 }), createGeneratorsModule({ engines })]);
    pid = s.project();
    s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl: (async () => new Response(blob, { status: 200 })) as unknown as typeof fetch });
    ingestOf(s.ctx).checkCapacity = async () => undefined;      // the shared server's disk may be below the import floor
    await modelsServiceOf(s.ctx).install('piper-id-news-medium'); await modelsServiceOf(s.ctx).idle();
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { if (name === 'service.notice') notices.push(data as Record<string, unknown>); return emit(name, data); };
  });
  afterAll(async () => { await s.close(); });
  const input = (texts: string[], extra: Record<string, unknown> = {}) => ({ clips: texts.map((text, i) => ({ id: `v${i + 1}`, text })), voiceId: 'local:piper-id-news-medium', language: 'id' as const, insert: false, ...extra });

  it('A2: the same voice-first clips again (re-planned stale plan) reuse the clips already made — no second synthesis', async () => {
    const texts = ['Ekspor nikel naik tajam.', 'Harga turun pada Agustus.'];
    calls.length = 0;
    const a = await s.ctx.hooks.voiceBatch!(pid, input(texts));
    expect(calls).toEqual(texts);
    calls.length = 0;
    const b = await s.ctx.hooks.voiceBatch!(pid, input(texts));
    expect(calls).toEqual([]);                                                       // nothing paid / synthesised again
    expect(b.clips.map((c) => c.assetId)).toEqual(a.clips.map((c) => c.assetId));
    expect(b.clips.map((c) => c.durationMs)).toEqual(a.clips.map((c) => c.durationMs));
    expect(b.costUsd).toBe(0);
    calls.length = 0;
    await s.ctx.hooks.voiceBatch!(pid, input([texts[0]!, 'Kalimat yang baru.']));
    expect(calls).toEqual(['Kalimat yang baru.']);                                   // only the changed sentence is made
  });

  it('A3: a failed batch removes the clips it already made (nothing placed, nothing left in the Library)', async () => {
    const before = voiceAssets(); notices.length = 0;
    failOn = 'gagal';
    await expect(s.ctx.hooks.voiceBatch!(pid, input(['Kalimat pertama berhasil dibuat.', 'Kalimat kedua gagal.']))).rejects.toMatchObject({ code: expect.stringMatching(/^EM-/) });
    failOn = null;
    expect(voiceAssets()).toEqual(before);
    expect(notices.some((n) => n['kind'] === 'assets-removed' && n['projectId'] === pid)).toBe(true);
  });

  it('A3: a too-long first pass that is generated again faster leaves only the final clips in the Library', async () => {
    const before = voiceAssets().length;
    const r = await s.ctx.hooks.voiceBatch!(pid, input(['Satu kalimat yang cukup panjang untuk batas.', 'Dua kalimat yang juga cukup panjang.'], { maxTotalMs: 3000 }));
    expect(r.regenerated).toBe(true);
    expect(voiceAssets().length).toBe(before + 2);
    for (const c of r.clips) expect(voiceAssets()).toContain(c.assetId);
  });

  it('A1: Cancel (abort signal) stops the batch job at once and removes its clips; the call rejects with EM-4303', async () => {
    const before = voiceAssets();
    holdOn = 'ditahan';
    const ac = new AbortController();
    const p = s.ctx.hooks.voiceBatch!(pid, input(['Klip pertama selesai.', 'Klip kedua ditahan.', 'Klip ketiga tidak pernah dibuat.']), { signal: ac.signal });
    const t0 = Date.now();
    while (!held && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
    expect(held).not.toBeNull();
    calls.length = 0;
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: 'EM-4303' });
    holdOn = null;
    await modelsServiceOf(s.ctx).idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).not.toContain('Klip ketiga tidak pernah dibuat.');
    expect(voiceAssets()).toEqual(before);
  });
});
