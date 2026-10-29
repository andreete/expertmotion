// S3 test helpers: fake outbound fetch through the real egress guard, project rows, SSE reader. No real network.
import { newId } from '@expertmotion/shared';
import { createEgress } from '../../src/services/egress.js';
import type { TestService } from '../helpers.js';

export interface FakeCall { url: string; method: string; headers: Record<string, string>; body: unknown }
export type FakeRoute = (call: FakeCall) => Response | Promise<Response> | undefined;

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Installs a fake fetch behind the real egress guard (Private Mode and the host allow-list still apply). */
export function fakeEgress(s: TestService, routes: FakeRoute[]): FakeCall[] {
  const calls: FakeCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const headers: Record<string, string> = {}; h.forEach((v, k) => { headers[k] = v; });
    let body: unknown = init?.body ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* keep text */ } }
    const call = { url, method: (init?.method ?? 'GET').toUpperCase(), headers, body };
    calls.push(call);
    const signal = init?.signal ?? undefined;
    const answer = (async () => { for (const r of routes) { const res = await r(call); if (res) return res; } return json(404, { error: 'no fake route' }); })();
    if (!signal) return answer;
    if (signal.aborted) throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    return Promise.race([answer, new Promise<Response>((_r, rej) => signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })), { once: true }))]);
  }) as typeof fetch;
  s.ctx.egress = createEgress({ isPrivate: () => s.ctx.settings.get().privateMode, impl });
  return calls;
}

export function addProject(s: TestService, language: 'id' | 'en' = 'id'): string {
  const id = newId(); const now = new Date().toISOString();
  s.ctx.db.prepare('INSERT INTO projects(id, name, settings_json, language, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(id, 'Proyek Contoh', '{}', language, now, now);
  return id;
}

export async function body<T = Record<string, unknown>>(r: Response): Promise<T> { return (await r.json()) as T; }

/** Opens an SSE stream and collects events until `until` returns true (or timeout). */
/** SEC-016: the token goes in the Authorization header (pass it), never in the URL. */
export async function collectSse(url: string, until: (events: Array<{ event: string; data: Record<string, unknown> }>) => boolean, timeoutMs = 4000, token?: string) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  try {
    const r = await fetch(url, { signal: ac.signal, headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const reader = r.body!.getReader(); let buf = '';
    while (!until(events)) {
      const { value, done } = await reader.read(); if (done) break;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1]; const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (ev && data) events.push({ event: ev, data: JSON.parse(data) as Record<string, unknown> });
      }
    }
  } catch { /* aborted */ } finally { clearTimeout(t); ac.abort(); }
  return events;
}

export const waitFor = async (fn: () => boolean | Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('waitFor timed out');
};
