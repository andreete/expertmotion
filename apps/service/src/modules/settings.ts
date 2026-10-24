// Settings module: R-170/R-171 (SettingsStore, Private Mode, output folder check) and R-172 regenerable-cache clearing.
// Deletions stay inside ctx.paths (media variants listed in the assets table, and tmp/); originals and outputs are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { SettingsSchema, type Settings } from '../services/settings.js';
import { audit, emit } from '../s3/dto.js';

const SCOPES = ['proxies', 'thumbs', 'stills', 'filmstrips', 'waveforms'] as const;
const COLUMN: Record<Exclude<(typeof SCOPES)[number], 'stills'>, string> = { proxies: 'proxy_path', thumbs: 'thumb_path', filmstrips: 'filmstrip_path', waveforms: 'waveform_path' };

/** `p` resolved strictly inside `root` (no traversal, no symlink escape), or null. */
export function inside(root: string, p: string): string | null {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try { const real = fs.realpathSync(abs); const realRoot = fs.realpathSync(root); const r2 = path.relative(realRoot, real); if (!r2 || r2.startsWith('..') || path.isAbsolute(r2)) return null; return real; } catch { return abs; }
}
function sizeOf(p: string, depth = 0): number {
  try {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) return 0;
    if (!st.isDirectory()) return st.size;
    if (depth > 8) return 0;
    return fs.readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f), depth + 1), 0);
  } catch { return 0; }
}

/** Output folder must be absolute and inside the user's profile (EM-8302, SEC/TR-081). Returns the canonical form. */
export function checkOutputFolder(folder: string, home = os.homedir()): string {
  if (!path.isAbsolute(folder)) throw new EmError('EM-8302', 'Expertmotion can only save to folders inside your user profile or removable drives. Choose another folder.', { status: 403, path: 'body.outputFolder' });
  let abs = path.resolve(folder);
  try { abs = fs.realpathSync(abs); } catch { /* created later by the renders module */ }
  const rel = path.relative(fs.realpathSync(home), abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new EmError('EM-8302', 'Expertmotion can only save to folders inside your user profile or removable drives. Choose another folder.', { status: 403, path: 'body.outputFolder' });
  return abs;
}

export function clearCaches(ctx: ServiceContext, scope: readonly (typeof SCOPES)[number][]): number {
  if (ctx.db.prepare("SELECT 1 FROM render_jobs WHERE status = 'rendering' LIMIT 1").get() || ctx.db.prepare("SELECT 1 FROM assets WHERE status = 'ingesting' LIMIT 1").get())
    throw new EmError('EM-2309', 'Another change is being applied. Wait for it to finish, then try again.', { status: 409 });
  let freed = 0;
  const cols = scope.filter((s): s is keyof typeof COLUMN => s !== 'stills').map((s) => COLUMN[s]);
  if (cols.length) {
    const rows = ctx.db.prepare(`SELECT id, ${cols.join(', ')} FROM assets`).all() as Array<Record<string, string | null>>;
    const clear = ctx.db.prepare(`UPDATE assets SET ${cols.map((c) => `${c} = NULL`).join(', ')}, updated_at = ? WHERE id = ?`);
    for (const r of rows) {
      let touched = false;
      for (const c of cols) {
        const rel = r[c]; if (!rel) continue;
        const abs = inside(ctx.paths.media, rel); touched = true;
        if (!abs) { ctx.log.warn({ assetId: r['id'], column: c }, 'cache path outside media root ignored'); continue; }
        freed += sizeOf(abs); fs.rmSync(abs, { force: true, recursive: true });
      }
      if (touched) clear.run(ctx.now(), r['id']);
    }
  }
  if (scope.includes('stills')) {
    for (const f of fs.readdirSync(ctx.paths.tmp)) { const abs = inside(ctx.paths.tmp, f); if (!abs) continue; freed += sizeOf(abs); fs.rmSync(abs, { force: true, recursive: true }); }
  }
  return freed;
}

export const settingsModule: ServiceModule = {
  name: 'settings',
  register(router, ctx) {
    route(router, 'get', '/settings', {}, () => ctx.settings.get());

    route(router, 'put', '/settings', { body: z.record(z.string(), z.unknown()) }, ({ body }) => {
      const patch = Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Record<string, unknown>;
      for (const k of Object.keys(patch)) if (!(k in SettingsSchema.shape)) throw new EmError('EM-9002', `Invalid request: unknown setting "${k}".`, { status: 400, path: `body.${k}` });
      if (typeof patch['outputFolder'] === 'string') patch['outputFolder'] = checkOutputFolder(patch['outputFolder']);
      const parsed = SettingsSchema.safeParse({ ...ctx.settings.get(), ...patch });
      if (!parsed.success) { const i = parsed.error.issues[0]; throw new EmError('EM-9002', `Invalid request: ${i?.message ?? 'bad setting'}`, { status: 400, path: ['body', ...(i?.path ?? []).map(String)].join('.') }); }
      const before = ctx.settings.get().privateMode;
      const next: Settings = ctx.settings.update(Object.fromEntries(Object.keys(patch).map((k) => [k, (parsed.data as Record<string, unknown>)[k]])) as Partial<Settings>);
      if (before !== next.privateMode) {
        audit(ctx, next.privateMode ? 'privatemode.on' : 'privatemode.off');
        emit(ctx, 'settings.changed', { scope: 'privateMode', privateMode: next.privateMode, settings: next });
      } else emit(ctx, 'settings.changed', { scope: 'settings', settings: next });
      return next;
    });

    route(router, 'post', '/settings/caches/clear', { body: z.object({ scope: z.array(z.enum(SCOPES)).min(1).default([...SCOPES]) }).strict() }, ({ body }) => ({ freedBytes: clearCaches(ctx, [...new Set(body.scope)]) }));
  },
};
