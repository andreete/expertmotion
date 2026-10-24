// R-001 GET /health (unauthenticated reduced body, no secrets; with the token it adds build date, tier, Private Mode, engine and db facts)
// and GET /version.
import os from 'node:os';
import { createRequire } from 'node:module';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { makeTokenMatcher } from '../http/guards.js';
import { engineStatus } from '../s2/engine-check.js';
import { BUILD_DATE } from './license.js';

const started = Date.now();
const remotionVersion = (() => { try { return (createRequire(import.meta.url)('@remotion/renderer/package.json') as { version?: string }).version ?? null; } catch { return null; } })();

export const health: ServiceModule = {
  name: 'health',
  register(router, ctx) {
    const matches = makeTokenMatcher(ctx.cfg.token);
    route(router, 'get', '/health', {}, async ({ req }) => {
      const base = { status: 'ok', version: ctx.cfg.version, mode: ctx.cfg.dev ? 'development' : 'production', uptimeMs: Date.now() - started };
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !matches(auth.slice(7))) return base;
      const eng = await engineStatus(ctx);
      let schemaVersion: number | null = null;
      try { schemaVersion = (ctx.db.prepare('SELECT max(version) v FROM schema_migrations').get() as { v: number | null }).v; } catch { /* no table */ }
      return { ...base, buildDate: BUILD_DATE, tier: ctx.hooks.tier(), privateMode: ctx.settings.get().privateMode,
        engine: { bundleVersion: eng.bundleHash ?? 'unverified', remotionVersion, browserReady: eng.browser, ffmpeg: eng.ffmpeg, ok: eng.ok, ...(eng.code ? { code: eng.code } : {}) },
        db: { schemaVersion, ok: true }, seq: ctx.bus.lastSeq };
    });
    route(router, 'get', '/version', {}, () => ({ version: ctx.cfg.version, buildDate: BUILD_DATE, node: process.versions.node, platform: process.platform, arch: os.arch(), schemaVersion: 1, dev: ctx.cfg.dev }));
  },
};
