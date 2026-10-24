// Builds the ServiceContext and starts modules. Shared by main.ts and tests (tests pass an in-memory data dir).
import path from 'node:path';
import type { ServiceConfig } from './config.js';
import { paths as makePaths } from './config.js';
import { defaultHooks, newId, nowIso, type Resources, type ServiceContext } from './context.js';
import { openDatabase } from './db/open.js';
import { EventBus } from './http/events.js';
import { createApp } from './http/app.js';
import { GrantStore } from './services/grants.js';
import { createEgress } from './services/egress.js';
import { SettingsStore } from './services/settings.js';
import { createLogger, pruneLogs } from './services/logger.js';
import type { ServiceModule } from './modules/types.js';
import { MODULES } from './modules/index.js';

export function defaultResources(env: NodeJS.ProcessEnv = process.env): Resources {
  const root = env['EM_RESOURCES'] ?? path.resolve(process.cwd(), 'resources');
  return {
    engineBundle: env['EM_ENGINE_BUNDLE'] ?? path.join(root, 'engine', 'bundle'),
    ...(env['EM_BROWSER'] ? { browserExecutable: env['EM_BROWSER'] } : {}),
    ...(env['EM_COMPOSITOR'] ? { binariesDirectory: env['EM_COMPOSITOR'] } : {}),
    ffmpeg: env['EM_FFMPEG'] ?? 'ffmpeg', ffprobe: env['EM_FFPROBE'] ?? 'ffprobe',
    loopsDir: path.join(root, 'catalogue', 'loops'),
  };
}

export async function boot(cfg: ServiceConfig, opts: { resources?: Resources; modules?: readonly ServiceModule[]; echoLogs?: boolean } = {}) {
  const p = makePaths(cfg.dataDir);
  const log = createLogger(p.logs, { echo: opts.echoLogs ?? cfg.dev });
  try { pruneLogs(p.logs); } catch { /* ignore */ }
  const { db, openedVia, migrated } = openDatabase(p.db, cfg.dbKeyHex);
  log.info({ openedVia, migrated }, 'database opened');
  const settings = new SettingsStore(db);
  const ctx: ServiceContext = {
    cfg, paths: p, db, bus: new EventBus(), grants: new GrantStore(cfg.mediaGrantTtlMs), settings, log,
    egress: createEgress({ isPrivate: () => settings.get().privateMode }),
    resources: opts.resources ?? defaultResources(), hooks: defaultHooks(), newId, now: nowIso,
  };
  const modules = opts.modules ?? MODULES;
  for (const m of modules) await m.start?.(ctx);
  const app = createApp(ctx, modules);
  const stop = async () => { for (const m of [...modules].reverse()) { try { await m.stop?.(ctx); } catch (e) { log.error({ module: m.name, err: String(e) }, 'stop failed'); } } db.close(); };
  return { ctx, app, stop, openedVia };
}
