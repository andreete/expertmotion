// SEC-016 (round 2, QA 2026-10-29): the SSE routes take the Service Token only from the Authorization header; `?token=` is
// refused (401) and the token never reaches a Service / Engine log line, even when a request or a message carries it.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactLiterals } from '@expertmotion/shared';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import type { ServiceModule } from '../../src/modules/types.js';

const sse: ServiceModule = { name: 'sse', register(router, ctx) { router.get('/events', (req, res) => ctx.bus.attach(req, res)); router.get('/renders/:id/events', (req, res) => ctx.bus.attach(req, res)); } };
function allLogText(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(fs.readFileSync(p, 'utf8')); } };
  walk(dir); return out.join('\n');
}

describe('SSE without the token in the URL (SEC-016 round 2)', () => {
  let s: TestService;
  beforeAll(async () => { s = await startService({ modules: [health, sse] }); });
  afterAll(async () => { await s.close(); });

  it('?token= is refused on both SSE routes; the Bearer header works (with the editor Origin preflight headers)', async () => {
    expect((await fetch(`${s.base}/api/v1/events?token=${s.token}`)).status).toBe(401);
    expect((await fetch(`${s.base}/api/v1/renders/J/events?token=${encodeURIComponent(s.token)}`)).status).toBe(401);
    const pre = await fetch(`${s.base}/api/v1/events`, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:4120', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization,last-event-id' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Authorization/);
    expect(pre.headers.get('access-control-allow-headers')).toMatch(/Last-Event-ID/);
    const ac = new AbortController();
    const r = await fetch(`${s.base}/api/v1/events`, { headers: { Authorization: `Bearer ${s.token}`, Origin: 'http://127.0.0.1:4120' }, signal: ac.signal });
    expect(r.status).toBe(200);
    const reader = r.body!.getReader(); let text = '';
    setTimeout(() => s.ctx.bus.emit('probe.event', { v: 1 }), 100);
    const stop = setTimeout(() => ac.abort(), 3000);
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); if (text.includes('probe.event')) break; } } catch { /* aborted */ }
    clearTimeout(stop); ac.abort();
    expect(text).toContain('probe.event');
  });
  it('a foreign Host / Origin is still refused on the SSE route', async () => {
    expect((await fetch(`${s.base}/api/v1/events`, { headers: { Authorization: `Bearer ${s.token}`, Origin: 'https://evil.example' } })).status).toBe(403);
  });
  it('no Service log line contains the token, even when a log call carries it', async () => {
    s.ctx.log.warn({ url: `/api/v1/events?x=1&tok=${s.token}`, raw: s.token }, `oops ${s.token}`);
    await s.api('/version');
    const text = allLogText(path.join(s.cfg.dataDir, 'logs'));
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('oops [REDACTED]');
    expect(text).not.toContain(s.token);
  });
  it('redactLiterals replaces every literal occurrence and ignores short / empty values', () => {
    expect(redactLiterals('a SECRET123 b SECRET123', ['SECRET123', null, 'abc'])).toBe('a [REDACTED] b [REDACTED]');
  });
});
