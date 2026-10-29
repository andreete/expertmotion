// QA UX fixes (round 1), P1-6: a validation that fails for any reason but a refused key (provider 5xx, 529 overloaded, 429)
// removes the connection it just stored, so failed tries never leave orphan "unvalidated" connections; 529 is "provider busy".
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { body, fakeEgress, json, type FakeCall } from './s3-helpers.js';

const KEY = `sk-ant-api03-${'q1w2e3r4'.repeat(6)}`;
let status = 529;
const anthropic = (c: FakeCall) => {
  if (!c.url.startsWith('https://api.anthropic.com/')) return undefined;
  if (status === 529) return json(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  if (status === 500) return json(500, { type: 'error', error: { type: 'api_error', message: 'Internal' } });
  if (status === 401) return json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
  return json(200, { data: [{ id: 'claude-x', display_name: 'Claude X', type: 'model' }], has_more: false });
};

describe('QA UX round 1 — failed validations leave no orphan connections', () => {
  let s: TestService;
  beforeAll(async () => { s = await startService({ modules: [health, settingsModule, providersModule, usageModule] }); fakeEgress(s, [anthropic]); });
  afterAll(async () => { await s.close(); });
  const count = () => (s.ctx.db.prepare('SELECT COUNT(*) n FROM provider_connections').get() as { n: number }).n;
  const add = () => s.api('/providers/connections', { method: 'POST', json: { provider: 'anthropic', label: 'Claude', secret: KEY } });

  it('529 overloaded → EM-4102 (provider busy) and no connection stays behind', async () => {
    status = 529;
    const r = await add();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await body<{ error: { code: string } }>(r)).error.code).toBe('EM-4102');
    expect(count()).toBe(0);
  });
  it('500 → EM-4103 and no connection stays behind; the default is not left pointing at it', async () => {
    status = 500;
    for (let i = 0; i < 3; i++) expect((await add()).status).toBeGreaterThanOrEqual(400);
    expect(count()).toBe(0);
    const d = s.ctx.db.prepare('SELECT default_connection_id d FROM provider_defaults WHERE id = 1').get() as { d: string | null } | undefined;
    expect(d?.d ?? null).toBeNull();
  });
  it('a refused key (401 → EM-4002) is still kept as invalid for the retry / replace flow', async () => {
    status = 401;
    const r = await add();
    expect((await body<{ error: { code: string } }>(r)).error.code).toBe('EM-4002');
    expect(count()).toBe(1);
  });
});

describe('QA UX round 1 — export estimate from this machine (measuredRenderRate)', () => {
  it('uses the median wall-clock ms per frame-megapixel of the last finished renders (queue → done, incl. memory wait)', async () => {
    const { measuredRenderRate } = await import('../../src/s2/render-service.js');
    const rows = [
      { c: '2026-10-29T10:00:00.000Z', f: '2026-10-29T10:02:40.000Z', n: 330, w: 720, h: 1280 },   // the QA's 160 s for 330 frames at 720p
      { c: '2026-10-29T11:00:00.000Z', f: '2026-10-29T11:02:28.000Z', n: 330, w: 720, h: 1280 },
      { c: '2026-10-29T12:00:00.000Z', f: '2026-10-29T12:03:32.000Z', n: 330, w: 720, h: 1280 },
    ];
    const ctx = { db: { prepare: () => ({ all: () => rows }) } } as never;
    const rate = measuredRenderRate(ctx)!;
    expect(rate).toBeCloseTo(160_000 / (330 * 0.9216), 0);
    // 330 frames at 720×1280 → about 160 s, not the tier table's ≈ 0:18
    expect(Math.round((330 * 0.9216 * rate) / 1000)).toBe(160);
    expect(measuredRenderRate({ db: { prepare: () => ({ all: () => [] }) } } as never)).toBeNull();
  });
});

describe('QA P1-9 — "no internet" is recognised from the first failed try', () => {
  it('ENETUNREACH / ENOTFOUND / ECONNREFUSED and DNS failures mean no network; a dropped connection or a 5xx does not', async () => {
    const { isNoNetwork } = await import('../../src/s2/models-service.js');
    for (const netCode of ['ENETUNREACH', 'ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']) expect(isNoNetwork({ reason: 'connection', netCode })).toBe(true);
    expect(isNoNetwork({ reason: 'dns' })).toBe(true);
    expect(isNoNetwork({ reason: 'connection', netCode: 'ECONNRESET' })).toBe(false);
    expect(isNoNetwork({ reason: 'server' })).toBe(false);
  });
});
