// Diagnostics module: R-180 bundle (TR-103, SEC-102: redacted logs + versions + hardware + settings + licence status; never the
// database, keys, tokens or media), R-181 log tail, and R-002 POST /service/shutdown (trusted caller). Shutdown answers 202 and then
// raises SIGTERM in-process, so main.ts runs its normal shutdown (every module's stop(): checkpoints, render cancel, run cancel).
import { availableMemBytes } from '../services/memory.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { EmError, redact } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { emit } from '../s3/dto.js';
import { createZip, type ZipEntry } from '../s3/zip.js';
import { cancelAllRuns } from './agents.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const MAX_LOG_BYTES = 4 * 1024 * 1024;
const TEXT_KEYS = new Set(['text', 'content', 'title', 'caption', 'label', 'words', 'instruction', 'name']);

export interface DiagnosticsOptions { onShutdown?: () => void; shutdownDelayMs?: number }

/** Redaction for anything leaving the service: SEC-100 patterns plus the user's home directory. */
export function scrub(text: string): string {
  const home = os.homedir();
  let out = redact(text);
  if (home && home.length > 3) { out = out.split(home).join('~'); out = out.split(home.replaceAll('\\', '\\\\')).join('~'); }
  return out.replace(/x'[0-9a-fA-F]{64}'/g, "x'[REDACTED]'").replace(/("(?:apiKey|secret|dbKey|dbKeyHex|key|token)"\s*:\s*")[^"]+"/gi, '$1[REDACTED]"');
}
function tail(file: string, maxBytes = MAX_LOG_BYTES): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; const len = Math.min(size, maxBytes); const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const s = buf.toString('utf8'); return size > len ? s.slice(s.indexOf('\n') + 1) : s;
  } finally { fs.closeSync(fd); }
}
const logFiles = (ctx: ServiceContext) => fs.readdirSync(ctx.paths.logs).filter((f) => /^(service|shell|engine)-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
const all = <T>(ctx: ServiceContext, sql: string, ...args: unknown[]): T[] => { try { return ctx.db.prepare(sql).all(...args) as T[]; } catch { return []; } };
const one = <T>(ctx: ServiceContext, sql: string, ...args: unknown[]): T | undefined => { try { return ctx.db.prepare(sql).get(...args) as T | undefined; } catch { return undefined; } };

function textLengthsOnly(v: unknown, key = ''): unknown {
  if (typeof v === 'string') return TEXT_KEYS.has(key) ? `[${[...v].length} chars]` : v;
  if (Array.isArray(v)) return v.map((x) => textLengthsOnly(x, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, textLengthsOnly(x, k)]));
  return v;
}
function versions(ctx: ServiceContext) {
  const req = createRequire(import.meta.url);
  const pkg = (n: string) => { try { return (req(`${n}/package.json`) as { version?: string }).version ?? null; } catch { return null; } };
  return { app: ctx.cfg.version, node: process.versions.node, v8: process.versions.v8, electron: process.versions['electron'] ?? null, remotion: pkg('@remotion/renderer'),
    schemaVersion: one<{ v: number }>(ctx, 'SELECT max(version) v FROM schema_migrations')?.v ?? null, dev: ctx.cfg.dev };
}

export function buildBundle(ctx: ServiceContext, includeStructure: boolean): { path: string; bytes: number; contents: string[] } {
  const entries: ZipEntry[] = [];
  const json = (name: string, v: unknown) => entries.push({ name, data: scrub(JSON.stringify(v, null, 2)) });
  const recentFiles = logFiles(ctx).slice(-7);
  const emEvents: string[] = [];
  for (const f of recentFiles) {
    const text = scrub(tail(path.join(ctx.paths.logs, f)));
    entries.push({ name: `logs/${f}`, data: text });
    for (const line of text.split('\n')) if (/"code":"EM-\d{4}"/.test(line)) emEvents.push(line);
  }
  json('versions.json', versions(ctx));
  const hw = one<Record<string, unknown>>(ctx, 'SELECT detected_at, tier, cpu_model, cpu_threads, ram_total_mb, gpu_vendor, gpu_model, vram_mb, nvenc FROM hardware_profiles WHERE is_current = 1 ORDER BY detected_at DESC LIMIT 1');
  json('hardware.json', { profile: hw ?? null, tier: ctx.hooks.tier(), ramTotalMb: Math.round(os.totalmem() / 1048576), ramFreeMb: Math.round(availableMemBytes() / 1048576), cpus: os.cpus().length });
  const settings = ctx.settings.get();
  json('settings.json', { ...settings, outputFolder: settings.outputFolder ? '[set]' : null });
  const lic = one<{ status: string; tier: string | null; updates_until: string | null; fingerprint_hash: string }>(ctx, 'SELECT status, tier, updates_until, fingerprint_hash FROM license WHERE id = 1');
  json('license.json', lic ? { status: lic.status, tier: lic.tier, updatesUntil: lic.updates_until, fingerprintPrefix: lic.fingerprint_hash.slice(0, 8), trialExports: ctx.hooks.isTrial() } : { status: 'unknown' });
  json('projects.json', all<Record<string, unknown>>(ctx, `SELECT p.id, p.name, p.language, p.created_at createdAt, p.deleted_at deletedAt, (SELECT count(*) FROM composition_versions v WHERE v.project_id = p.id) versions,
    (SELECT r.error_code FROM render_jobs r WHERE r.project_id = p.id AND r.error_code IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) lastRenderError FROM projects p ORDER BY p.created_at DESC LIMIT 200`));
  json('render-jobs.json', all(ctx, 'SELECT id, project_id projectId, status, performance_profile performanceProfile, progress, error_code errorCode, error_detail errorDetail, created_at createdAt, finished_at finishedAt FROM render_jobs ORDER BY created_at DESC LIMIT 20'));
  json('agent-runs.json', all(ctx, 'SELECT id, project_id projectId, agent, model_id modelId, status, error_code errorCode, started_at startedAt, finished_at finishedAt FROM agent_runs ORDER BY started_at DESC LIMIT 20'));
  json('migrations.json', all(ctx, 'SELECT version, name, applied_at appliedAt FROM schema_migrations ORDER BY version'));
  json('events.json', emEvents.slice(-50));
  json('env.json', { platform: process.platform, arch: os.arch(), release: os.release(), locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    flags: Object.keys(process.env).filter((k) => k.startsWith('EM_')).sort() });
  if (includeStructure) {
    for (const p of all<{ id: string }>(ctx, 'SELECT id FROM projects WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT 20')) {
      const v = one<{ model_json: string }>(ctx, 'SELECT v.model_json FROM projects p JOIN composition_versions v ON v.id = p.head_version_id WHERE p.id = ?', p.id);
      if (v) json(`structure/${p.id}.json`, textLengthsOnly(JSON.parse(v.model_json)));
    }
  }
  const stamp = ctx.now().replace(/[:.]/g, '-');
  const file = path.join(ctx.paths.logs, `diagnostics-${stamp}.zip`);
  let zip: Buffer;
  try { zip = createZip(entries); fs.writeFileSync(file, zip, { mode: 0o600 }); } catch (e) { throw new EmError('EM-9006', 'The diagnostics bundle could not be created. The log files are in the folder below.', { status: 500, cause: e }); }
  return { path: file, bytes: zip.length, contents: entries.map((e) => e.name) };
}

export function createDiagnosticsModule(opts: DiagnosticsOptions = {}): ServiceModule {
  const onShutdown = opts.onShutdown ?? (() => { (process.emit as unknown as (ev: string, sig: string) => boolean)('SIGTERM', 'SIGTERM'); });
  return {
    name: 'diagnostics',
    register(router, ctx) {
      route(router, 'post', '/diagnostics/bundle', { body: z.object({ includeStructure: z.boolean().default(false) }).strict() }, ({ body }) => {
        const r = buildBundle(ctx, body.includeStructure);
        ctx.log.info({ bytes: r.bytes, files: r.contents.length }, 'diagnostics bundle written');
        return r;
      });

      route(router, 'get', '/diagnostics/logs', { query: z.object({ lines: z.coerce.number().int().min(1).max(2000).default(200), level: z.enum(LEVELS).default('info') }) }, ({ query }) => {
        const min = LEVELS.indexOf(query.level); const out: string[] = [];
        for (const f of logFiles(ctx).reverse()) {
          const lines = tail(path.join(ctx.paths.logs, f), 2 * 1024 * 1024).split('\n').filter(Boolean);
          for (let i = lines.length - 1; i >= 0 && out.length < query.lines; i--) {
            const m = /"level":"(debug|info|warn|error)"/.exec(lines[i]!);
            if (LEVELS.indexOf((m?.[1] ?? 'info') as (typeof LEVELS)[number]) >= min) out.push(scrub(lines[i]!));
          }
          if (out.length >= query.lines) break;
        }
        return { lines: out.reverse() };
      });

      route(router, 'post', '/service/shutdown', { body: z.object({ reason: z.enum(['window-closed', 'update', 'uninstall']), timeoutMs: z.number().int().min(1000).max(10_000).optional(), force: z.boolean().optional() }).strict(), status: 202 }, ({ body, req }) => {
        if (req.headers['x-expertmotion-caller'] !== 'shell') throw new EmError('EM-8005', 'Request refused.', { status: 403 });
        const rendering = one<{ n: number }>(ctx, "SELECT count(*) n FROM render_jobs WHERE status = 'rendering'")?.n ?? 0;
        if (rendering > 0 && body.force !== true) throw new EmError('EM-8304', 'A render is still running. Closing now will cancel it.', { status: 409, details: { rendering } });
        const acceptedAt = ctx.now();
        cancelAllRuns(ctx, 'EM-4304');
        emit(ctx, 'service.notice', { kind: 'shutting-down', reason: body.reason });
        ctx.log.info({ reason: body.reason }, 'shutdown requested');
        setTimeout(onShutdown, opts.shutdownDelayMs ?? 250);
        return { acceptedAt };
      });
    },
  };
}
export const diagnosticsModule: ServiceModule = createDiagnosticsModule();
