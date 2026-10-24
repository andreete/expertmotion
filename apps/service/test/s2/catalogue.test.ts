import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGUE_VERSION } from '@expertmotion/catalogue';
import { health } from '../../src/modules/health.js';
import { catalogueModule } from '../../src/modules/catalogue.js';
import { createModelsModule } from '../../src/modules/models.js';
import { json, startS2, type S2Service } from './harness.js';

type Item = { id: string; category: string; priority: string; flags: string[]; paramsSchema: Record<string, unknown>; availability: { ok: boolean; reason?: string; code?: string }; score?: number };

describe('catalogue (R-120/R-121)', () => {
  let s: S2Service;
  beforeAll(async () => { s = await startS2([health, createModelsModule({ registry: () => [] }), catalogueModule]); });
  afterAll(async () => { await s.close(); });

  it('lists P0 presets by default with params schema, availability and an ETag (304 on match)', async () => {
    const r = await s.api('/catalogue');
    expect(r.status).toBe(200);
    const body = await json<{ items: Item[]; catalogueVersion: string }>(r);
    expect(body.catalogueVersion).toBe(CATALOGUE_VERSION);
    expect(body.items.length).toBeGreaterThan(20);
    expect(body.items.every((i) => i.priority === 'p0')).toBe(true);
    expect(body.items[0]!.paramsSchema).toHaveProperty('type');
    const etag = r.headers.get('etag')!;
    expect(etag).toContain(CATALOGUE_VERSION);
    expect((await s.api('/catalogue', { headers: { 'If-None-Match': etag } })).status).toBe(304);
    const all = await json<{ items: Item[] }>(await s.api('/catalogue?priority=p0,p1,p2&category=transition'));
    expect(all.items.every((i) => i.category === 'transition')).toBe(true);
    expect(all.items.length).toBeGreaterThanOrEqual(body.items.filter((i) => i.category === 'transition').length);
    expect((await s.api('/catalogue?category=nope')).status).toBe(400);
  });
  it('availability follows the Hardware Tier (WebGPU only on T2, GPU badge on T0)', async () => {
    s.ctx.hooks.tier = () => 'T0';
    const t0 = await json<{ items: Item[] }>(await s.api('/catalogue?priority=p0,p1,p2'));
    const webgpu = t0.items.filter((i) => i.flags.includes('webgpu'));
    expect(webgpu.every((i) => !i.availability.ok && i.availability.reason === 'webgpu')).toBe(true);
    for (const i of t0.items.filter((x) => x.flags.includes('gpu') && !x.flags.includes('webgpu'))) expect(i.availability).toMatchObject({ ok: true, reason: 'gpu' });
    s.ctx.hooks.tier = () => 'T2';
    const t2 = await json<{ items: Item[] }>(await s.api('/catalogue?priority=p0,p1,p2'));
    expect(t2.items.filter((i) => i.flags.includes('webgpu')).every((i) => i.availability.ok)).toBe(true);
    s.ctx.hooks.tier = () => 'T1';
  });
  it('search ranks in both languages; empty q returns suggestions', async () => {
    const id = await json<{ items: Item[] }>(await s.api(`/catalogue/search?q=${encodeURIComponent('transisi')}&lang=id`));
    expect(id.items.length).toBeGreaterThan(0);
    expect(id.items.every((i) => i.category === 'transition')).toBe(true);
    expect(id.items[0]!.score).toBe(1);
    const en = await json<{ items: Item[] }>(await s.api('/catalogue/search?q=fade&category=transition'));
    expect(en.items.some((i) => i.id === 'preset:transition.fade')).toBe(true);
    const empty = await json<{ items: Item[]; suggestions: string[] }>(await s.api('/catalogue/search?q='));
    expect(empty.items).toEqual([]); expect(empty.suggestions.length).toBeGreaterThan(0);
  });
});
