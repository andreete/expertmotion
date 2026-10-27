// Builds the ServiceContext and starts modules. Shared by main.ts and tests (tests pass an in-memory data dir).
import path from 'node:path';
import type { ServiceConfig } from './config.js';
import { paths as makePaths } from './config.js';
import { defaultHooks, newId, nowIso, type Resources, type ServiceContext } from './context.js';
import { openDatabase } from './db/open.js';
import { EventBus } from './http/events.js';
import { createApp } from './http/app.js';
import { GrantStore } from './services/grants.js';
import { createEgress, customBaseUrlHost } from './services/egress.js';
import { devProviderStubOrigin, withDevProviderStub } from './s3/dev-provider-stub.js';
import { SettingsStore } from './services/settings.js';
import { createLogger, pruneLogs } from './services/logger.js';
import type { ServiceModule } from './modules/types.js';
import { MODULES } from './modules/index.js';
import { setEngineLog } from './s2/proc.js';

/**
 * Resource locations. Packaged (Electron utilityProcess): `process.resourcesPath` holds engine/bundle, engine/chrome,
 * engine/compositor and bin/ (DEPLOYMENT_AND_PACKAGING §3, staged by scripts/stage-desktop.mjs). Development: repo `resources/`
 * plus Remotion's own Chrome Headless Shell and compositor from node_modules. Every path can be overridden with EM_* env vars.
 */
export function defaultResources(env: NodeJS.ProcessEnv = process.env): Resources {
  const packaged = (process as { resourcesPath?: string }).resourcesPath;
  const root = env['EM_RESOURCES'] ?? (packaged && !env['EM_DEV'] ? packaged : path.resolve(process.cwd(), 'resources'));
  const win = process.platform === 'win32';
  const exe = (n: string) => (win ? `${n}.exe` : n);
  const isPackaged = root === packaged;
  const chrome = isPackaged ? path.join(root, 'engine', 'chrome', exe('chrome-headless-shell')) : undefined;
  const compositor = isPackaged ? path.join(root, 'engine', 'compositor') : undefined;
  const ffmpegDir = isPackaged ? path.join(root, 'bin') : undefined;
  const browser = env['EM_BROWSER'] ?? chrome;
  const binaries = env['EM_COMPOSITOR'] ?? compositor;
  return {
    engineBundle: env['EM_ENGINE_BUNDLE'] ?? path.join(root, 'engine', 'bundle'),
    ...(browser ? { browserExecutable: browser } : {}),
    ...(binaries ? { binariesDirectory: binaries } : {}),
    ffmpeg: env['EM_FFMPEG'] ?? (ffmpegDir ? path.join(ffmpegDir, exe('ffmpeg')) : 'ffmpeg'),
    ffprobe: env['EM_FFPROBE'] ?? (ffmpegDir ? path.join(ffmpegDir, exe('ffprobe')) : 'ffprobe'),
    loopsDir: path.join(root, 'catalogue'),
    licenseDir: env['EM_LICENSE_DIR'] ?? path.join(root, 'license'),
    enginesDir: env['EM_ENGINES'] ?? path.join(root, 'engines'),
    sampleDir: env['EM_SAMPLE_DIR'] ?? path.join(root, 'sample'),
  };
}

/** SEC-082: hosts of saved custom (OpenRouter-compatible) base URLs join the provider allow-list; IP literals/localhost never do. */
function customProviderHosts(db: { prepare(sql: string): { all(): unknown[] } }): string[] {
  try {
    return (db.prepare("SELECT base_url FROM provider_connections WHERE provider = 'custom' AND base_url IS NOT NULL").all() as Array<{ base_url: string }>)
      .map((r) => customBaseUrlHost(r.base_url)).filter((h): h is string => h !== null);
  } catch { return []; }
}

export async function boot(cfg: ServiceConfig, opts: { resources?: Resources; modules?: readonly ServiceModule[]; echoLogs?: boolean } = {}) {
  const p = makePaths(cfg.dataDir);
  const log = createLogger(p.logs, { echo: opts.echoLogs ?? cfg.dev });
  setEngineLog(createLogger(p.logs, { prefix: 'engine' }));
  try { pruneLogs(p.logs); } catch { /* ignore */ }
  const dbStart = Date.now();
  const { db, openedVia, migrated } = openDatabase(p.db, cfg.dbKeyHex);
  log.info({ openedVia, migrated, ms: Date.now() - dbStart }, 'database opened');
  const settings = new SettingsStore(db);
  // Dev-only provider stub (Entry 28): dead code in release builds (build.mjs defines EM_DEV_PROVIDER_STUB as undefined).
  const stub = devProviderStubOrigin(cfg.dev, process.env.EM_DEV_PROVIDER_STUB);
  if (stub) log.warn({ stub }, 'DEV provider stub active: provider calls go to the local stub server');
  const ctx: ServiceContext = {
    cfg, paths: p, db, bus: new EventBus(), grants: new GrantStore(cfg.mediaGrantTtlMs), settings, log,
    egress: createEgress({ isPrivate: () => settings.get().privateMode, customProviderHosts: () => customProviderHosts(db), ...(stub ? { impl: withDevProviderStub(globalThis.fetch, stub) } : {}) }),
    resources: opts.resources ?? defaultResources(), hooks: defaultHooks(), newId, now: nowIso, mediaOrigins: new Set<string>(),
  };
  const modules = opts.modules ?? MODULES;
  // Startup timing (QA 2026-10-26: ~38 s to `ready` on a T0 laptop): slow module starts are logged so the next QA log shows where.
  const bootStart = Date.now();
  for (const m of modules) {
    const t0 = Date.now();
    await m.start?.(ctx);
    const ms = Date.now() - t0;
    if (ms >= 250) log.info({ module: m.name, ms }, 'module start slow');
  }
  log.info({ ms: Date.now() - bootStart, modules: modules.length }, 'modules started');
  const app = createApp(ctx, modules);
  const stop = async () => { for (const m of [...modules].reverse()) { try { await m.stop?.(ctx); } catch (e) { log.error({ module: m.name, err: String(e) }, 'stop failed'); } } db.close(); };
  return { ctx, app, stop, openedVia };
}
