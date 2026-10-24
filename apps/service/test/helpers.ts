// Test harness: boots the real service stack on a free loopback port with a temp data dir.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { boot } from '../src/boot.js';
import type { ServiceConfig } from '../src/config.js';
import type { ServiceModule } from '../src/modules/types.js';

export async function freePort(): Promise<number> {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}
export function tempDir(prefix = 'em-svc-'): string { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export interface TestService {
  base: string; token: string; cfg: ServiceConfig; ctx: Awaited<ReturnType<typeof boot>>['ctx'];
  api(p: string, init?: RequestInit & { json?: unknown; auth?: boolean }): Promise<Response>;
  close(): Promise<void>;
}

export async function startService(opts: { modules?: readonly ServiceModule[]; dataDir?: string; cfg?: Partial<ServiceConfig> } = {}): Promise<TestService> {
  const port = await freePort();
  const dataDir = opts.dataDir ?? tempDir();
  const cfg: ServiceConfig = { port, token: crypto.randomBytes(32).toString('base64url'), dataDir, dbKeyHex: crypto.randomBytes(32).toString('hex'), dev: true,
    uiOrigin: 'http://127.0.0.1:4120', version: '0.1.0-test', mediaGrantTtlMs: 60_000, ...opts.cfg };
  const b = await boot(cfg, { echoLogs: false, ...(opts.modules ? { modules: opts.modules } : {}),
    resources: { engineBundle: path.join(dataDir, 'no-bundle'), ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', loopsDir: path.join(dataDir, 'loops'), licenseDir: path.join(dataDir, 'license'), enginesDir: path.join(dataDir, 'engines') } });
  const server = http.createServer(b.app);
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${port}`;
  return {
    base, token: cfg.token, cfg, ctx: b.ctx,
    api(p, init = {}) {
      const headers = new Headers(init.headers);
      if (init.auth !== false) headers.set('Authorization', `Bearer ${cfg.token}`);
      let body = init.body;
      if (init.json !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(init.json); }
      return fetch(`${base}/api/v1${p}`, { ...init, headers, body: body ?? null });
    },
    async close() { b.ctx.bus.closeAll(); server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await b.stop(); },
  };
}
