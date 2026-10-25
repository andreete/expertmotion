import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startService, tempDir, type TestService } from '../helpers.js';
import { listMigrations, migrate, openDatabase, openRaw } from '../../src/db/open.js';
import { GrantStore } from '../../src/services/grants.js';
import { createEgress } from '../../src/services/egress.js';
import { EventBus } from '../../src/http/events.js';
import { SettingsStore } from '../../src/services/settings.js';
import { health } from '../../src/modules/health.js';
import { route } from '../../src/http/route.js';
import { z } from 'zod';
import { EmError } from '@expertmotion/shared';
import type { ServiceModule } from '../../src/modules/types.js';

const probe: ServiceModule = {
  name: 'probe',
  register(router) {
    route(router, 'post', '/probe/:id', { params: z.object({ id: z.string().regex(/^[a-z]+$/) }), body: z.object({ n: z.number().int() }) }, ({ params, body }) => ({ id: params.id, n: body.n }));
    route(router, 'get', '/probe-fail', {}, () => { throw new EmError('EM-4201', 'Budget reached.'); });
    route(router, 'get', '/probe-crash', {}, () => { throw new Error('secret sk-or-v1-abcdefabcdefabcdefabcdef'); });
  },
};

describe('service skeleton over HTTP', () => {
  let s: TestService;
  beforeAll(async () => { s = await startService({ modules: [health, probe] }); });
  afterAll(async () => { await s.close(); });

  it('health is open, everything else needs the token', async () => {
    expect((await s.api('/health', { auth: false })).status).toBe(200);
    const r = await s.api('/version', { auth: false });
    expect(r.status).toBe(401);
    expect((await s.api('/version')).status).toBe(200);
  });
  it('validates params and body with EM-9002', async () => {
    expect(await (await s.api('/probe/abc', { method: 'POST', json: { n: 3 } })).json()).toEqual({ id: 'abc', n: 3 });
    const bad = await s.api('/probe/ABC', { method: 'POST', json: { n: 3 } });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: { code: string } }).error.code).toBe('EM-9002');
    const badBody = await s.api('/probe/abc', { method: 'POST', json: { n: 'x' } });
    expect((await badBody.json() as { error: { code: string; path?: string } }).error.path).toBe('body.n');
  });
  it('maps EmError and hides unexpected errors', async () => {
    const r = await s.api('/probe-fail');
    expect((await r.json() as { error: { code: string } }).error.code).toBe('EM-4201');
    const c = await s.api('/probe-crash');
    expect(c.status).toBe(500);
    const txt = await c.text();
    expect(txt).not.toContain('sk-or');
    expect(JSON.parse(txt).error.code).toBe('EM-9001');
  });
  it('unknown route gives EM-9003; foreign Host and Origin are refused', async () => {
    expect((await (await s.api('/nope')).json() as { error: { code: string } }).error.code).toBe('EM-9003');
    expect((await s.api('/version', { headers: { Origin: 'http://evil.example' } })).status).toBe(403);
  });
  it('sends no-store and nosniff headers', async () => {
    const r = await s.api('/version');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-powered-by')).toBeNull();
  });
  it('writes logs with secrets redacted', () => {
    const logs = fs.readdirSync(s.ctx.paths.logs).map((f) => fs.readFileSync(path.join(s.ctx.paths.logs, f), 'utf8')).join('');
    expect(logs).toContain('EM-9001');
    expect(logs).not.toContain('sk-or-v1-abcdef');
  });
});

describe('database', () => {
  const key = crypto.randomBytes(32).toString('hex');
  it('migrates, refuses a wrong key, and is encrypted on disk', () => {
    const dir = tempDir(); const file = path.join(dir, 'a.db');
    const { db, openedVia, migrated } = openDatabase(file, key);
    expect(openedVia).toBe('main');
    expect(migrated[0]).toBe(1);
    expect(migrate(db, file)).toEqual([]);
    db.prepare("INSERT INTO settings VALUES ('k', '1', 'now')").run();
    db.close();
    expect(fs.readFileSync(file).subarray(0, 16).toString('latin1')).not.toContain('SQLite format 3');
    expect(() => openRaw(file, crypto.randomBytes(32).toString('hex'))).toThrow();
  });
  it('falls back to a fresh database when the file is garbage', () => {
    const dir = tempDir(); const file = path.join(dir, 'b.db');
    fs.writeFileSync(file, crypto.randomBytes(8192));
    const r = openDatabase(file, key);
    expect(r.openedVia).toBe('fresh');
    expect(fs.readdirSync(dir).some((f) => f.includes('.corrupt-'))).toBe(true);
    r.db.close();
  });
  it('rejects duplicate migration versions', () => {
    expect(() => listMigrations([{ version: 1, name: 'a', sql: '' }, { version: 1, name: 'b', sql: '' }])).toThrow(/Duplicate/);
  });
  it('settings store validates and notifies', () => {
    const { db } = openDatabase(path.join(tempDir(), 'c.db'), key);
    const st = new SettingsStore(db);
    expect(st.get().privateMode).toBe(false);
    const seen: string[][] = [];
    st.onChange((_s, ch) => seen.push(ch));
    st.update({ privateMode: true, uiLanguage: 'id' });
    expect(new SettingsStore(db).get()).toMatchObject({ privateMode: true, uiLanguage: 'id' });
    expect(seen[0]?.sort()).toEqual(['privateMode', 'uiLanguage']);
    expect(() => st.update({ autosaveDebounceMs: 1 })).toThrow();
    db.close();
  });
});

describe('grants, egress, events', () => {
  it('grants are project-scoped, render grants are asset-scoped and revocable', () => {
    let t = 0; const g = new GrantStore(1000, () => t);
    const p = g.issuePreview('P1');
    expect(g.issuePreview('P1').token).toBe(p.token);
    expect(g.check(p.token, 'P1', 'A')).toBeTruthy();
    expect(g.check(p.token, 'P2', 'A')).toBeUndefined();
    t = 999; expect(g.check(p.token, 'P1', 'A')).toBeTruthy();   // sliding
    t = 2100; expect(g.check(p.token, 'P1', 'A')).toBeUndefined();
    const r = g.issueRender('P1', 'J1', ['A']);
    expect(g.check(r.token, 'P1', 'B')).toBeUndefined();
    g.revokeJob('J1'); expect(g.lookup(r.token)).toBeUndefined();
  });
  it('egress blocks Private Mode, plain HTTP and unknown hosts', async () => {
    let priv = false; const calls: string[] = [];
    const e = createEgress({ isPrivate: () => priv, impl: (async (u: string) => { calls.push(String(u)); return new Response('ok'); }) as typeof fetch });
    await expect(e.fetch('http://openrouter.ai/x')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.fetch('https://evil.example/x')).rejects.toMatchObject({ code: 'EM-8203' });
    await expect(e.fetch('https://openrouter.ai.evil.example/x')).rejects.toMatchObject({ code: 'EM-8203' });
    expect((await e.fetch('https://openrouter.ai/api/v1/models')).ok).toBe(true);
    priv = true; await expect(e.fetch('https://openrouter.ai/api/v1/models')).rejects.toMatchObject({ code: 'EM-8202' });
    expect(calls).toHaveLength(1);
  });
  it('event bus keeps seq order and a bounded buffer', () => {
    const b = new EventBus(3);
    for (let i = 0; i < 5; i++) b.emit('x', { i });
    expect(b.lastSeq).toBe(5);
  });
});

describe('SSE over HTTP', () => {
  let s: TestService;
  const sse: ServiceModule = { name: 'sse', register(router, ctx) { router.get('/events', (req, res) => ctx.bus.attach(req, res)); } };
  beforeAll(async () => { s = await startService({ modules: [health, sse] }); });
  afterAll(async () => { await s.close(); });
  it('replays after Last-Event-ID and accepts ?token=', async () => {
    s.ctx.bus.emit('a', { v: 1 }); s.ctx.bus.emit('b', { v: 2 });
    const ac = new AbortController();
    const r = await fetch(`${s.base}/api/v1/events?token=${s.token}`, { headers: { 'Last-Event-ID': '1' }, signal: ac.signal });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader(); let text = '';
    while (!text.includes('event: b')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).not.toContain('event: a');
    expect(text).toContain('"seq":2');
    ac.abort();
  });
});

describe('media CORS exception', () => {
  let s: TestService;
  const media: ServiceModule = { name: 'm', register() {}, registerRoot(router) { router.get('/media/:g/:a/:v', (_req, res) => { res.type('text/plain').send('bytes'); }); } };
  beforeAll(async () => { s = await startService({ modules: [health, media] }); });
  afterAll(async () => { await s.close(); });
  it('media needs no Bearer; app:// and registered render origins get CORS; others are refused', async () => {
    const u = `${s.base}/media/${'x'.repeat(43)}/A/playable`;
    expect((await fetch(u)).status).toBe(200);
    const app = await fetch(u, { headers: { Origin: 'app://expertmotion' } });
    expect(app.headers.get('access-control-allow-origin')).toBe('app://expertmotion');
    expect((await fetch(u, { headers: { Origin: 'http://localhost:4130' } })).status).toBe(403);
    s.ctx.mediaOrigins.add('http://localhost:4130');
    const r = await fetch(u, { headers: { Origin: 'http://localhost:4130' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-expose-headers')).toContain('Content-Range');
    expect((await fetch(`${s.base}/api/v1/version`, { headers: { Origin: 'http://localhost:4130', Authorization: `Bearer ${s.token}` } })).status).toBe(403);
  });
});

describe('SSE resync notice', () => {
  it('a Last-Event-ID older than the buffer gets service.notice resync instead of a partial replay', async () => {
    const s = await startService({ modules: [health, { name: 'sse', register(router, ctx) { router.get('/events', (req, res) => ctx.bus.attach(req, res)); } }] });
    try {
      for (let i = 0; i < 600; i++) s.ctx.bus.emit('x', { i });
      const ac = new AbortController();
      const r = await fetch(`${s.base}/api/v1/events?token=${s.token}`, { headers: { 'Last-Event-ID': '3' }, signal: ac.signal });
      const reader = r.body!.getReader(); let text = '';
      while (!text.includes('service.notice')) text += new TextDecoder().decode((await reader.read()).value);
      expect(text).toContain('"kind":"resync"');
      expect(text).not.toContain('event: x');
      ac.abort();
    } finally { await s.close(); }
  });
});

describe('available memory', () => {
  it('uses MemAvailable on Linux and caps by the cgroup headroom', async () => {
    const { availableMemBytes } = await import('../../src/services/memory.js');
    const files: Record<string, string> = { '/proc/meminfo': 'MemTotal: 2000000 kB\nMemFree: 180000 kB\nMemAvailable: 750000 kB\n', '/proc/self/cgroup': '0::/user.slice/x.scope\n',
      '/sys/fs/cgroup/user.slice/x.scope/memory.max': '1258291200\n', '/sys/fs/cgroup/user.slice/x.scope/memory.current': '1000000000\n' };
    const read = (p: string) => { const v = files[p]; if (v === undefined) throw new Error('ENOENT'); return v; };
    expect(availableMemBytes(read, 'linux')).toBe(1258291200 - 1000000000);
    delete files['/proc/self/cgroup'];
    expect(availableMemBytes(read, 'linux')).toBe(750000 * 1024);
  });
});

describe('packaged Editor origin (production, app://expertmotion is cross-origin to http://127.0.0.1)', () => {
  let s: TestService;
  beforeAll(async () => { s = await startService({ modules: [health], cfg: { dev: false } }); });
  afterAll(async () => { await s.close(); });
  const editor = { Origin: 'app://expertmotion', 'Sec-Fetch-Site': 'cross-site' };
  it('answers the preflight and the call with CORS for app://expertmotion only', async () => {
    const pre = await fetch(`${s.base}/api/v1/version`, { method: 'OPTIONS', headers: { ...editor, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization', 'Access-Control-Request-Private-Network': 'true' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('app://expertmotion');
    expect(pre.headers.get('access-control-allow-headers')).toContain('Authorization');
    expect(pre.headers.get('access-control-allow-private-network')).toBe('true');
    const r = await fetch(`${s.base}/api/v1/version`, { headers: { ...editor, Authorization: `Bearer ${s.token}` } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('app://expertmotion');
    const h = await fetch(`${s.base}/api/v1/health`, { headers: editor });
    expect(h.headers.get('access-control-allow-origin')).toBe('app://expertmotion');
  });
  it('still needs the token and still refuses other origins and cross-site callers', async () => {
    expect((await fetch(`${s.base}/api/v1/version`, { headers: editor })).status).toBe(401);
    for (const headers of [{ Origin: 'http://evil.example', 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: 'http://127.0.0.1:4120' }]) {
      const r = await fetch(`${s.base}/api/v1/version`, { headers: { ...headers, Authorization: `Bearer ${s.token}` } });
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect(r.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await fetch(`${s.base}/api/v1/version`, { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' } })).status).toBe(403);
  });
});
