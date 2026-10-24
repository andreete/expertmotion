// Local Service entry. Packaged: started by the Desktop Shell as a utilityProcess; config arrives over parentPort (SEC-002).
// Development: `EM_DEV=1 node dist/service.cjs` (or tsx src/main.ts) with EM_* env (SEC-014).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { devConfig, prodConfig, type Bootstrap, type ServiceConfig } from './config.js';
import { boot } from './boot.js';

interface ParentPort { on(ev: 'message', fn: (e: { data: unknown }) => void): void; postMessage(m: unknown): void }
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
const send = (m: object) => { if (parentPort) parentPort.postMessage(m); else if (process.send) process.send(m); else process.stdout.write(`${JSON.stringify(m)}\n`); };

async function start(cfg: ServiceConfig) {
  const { app, stop, ctx } = await boot(cfg);
  const server = http.createServer(app);
  server.keepAliveTimeout = 5_000;
  server.requestTimeout = 0;               // SSE and long uploads
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '127.0.0.1', () => resolve()); });
  const addr = server.address() as AddressInfo;
  if (addr.address !== '127.0.0.1') { send({ type: 'fatal', code: 'EM-8001', message: 'bound to a non-loopback address' }); process.exit(1); }
  // Self-check: health answers through the real stack.
  const ok = await fetch(`http://127.0.0.1:${addr.port}/api/v1/health`).then((r) => r.ok).catch(() => false);
  if (!ok) { send({ type: 'fatal', code: 'EM-9001', message: 'self-check failed' }); process.exit(1); }
  send({ type: 'ready', port: addr.port, version: cfg.version });
  ctx.log.info({ port: addr.port }, 'service ready');
  let closing = false;
  const shutdown = async (why: string) => {
    if (closing) return; closing = true; ctx.log.info({ why }, 'shutting down');
    server.close(); ctx.bus.closeAll(); await stop(); process.exit(0);
  };
  parentPort?.on('message', (e) => { if ((e.data as { type?: string })?.type === 'shutdown') void shutdown('parent'); });
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function fatal(e: unknown): never {
  const err = e as { code?: string; message?: string };
  send({ type: 'fatal', code: err.code?.startsWith('EM-') ? err.code : (err.code === 'EADDRINUSE' ? 'EM-9007' : 'EM-9001'), message: String(err.message ?? e) });
  process.exit(1);
}
process.on('uncaughtException', fatal);

if (parentPort && process.env['EM_DEV'] !== '1') {
  parentPort.on('message', (e) => { const d = e.data as Bootstrap; if (d?.type === 'bootstrap') start(prodConfig(d)).catch(fatal); });
  send({ type: 'hello' });
} else {
  start(devConfig()).catch(fatal);
}
