// Assets module: R-030…R-036 (API_SPECIFICATION §6.4), ingest queue (ASSET_INGESTION.md), hooks.assetFacts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { EmError } from '@expertmotion/shared';
import type { OperationT } from '@expertmotion/composition-model';
import type { Request } from 'express';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { ULID, decodeCursor, em, encodeCursor, isInside, parseOrThrow, requireProject } from '../s2/common.js';
import { clearBadges, getAsset, listAssets, requireAsset, setBadge, toAssetDto, toFacts, type AssetRow } from '../s2/assets-repo.js';
import { assetDir, hashFile, ingestOf, inspectSource, MAX_ASSETS_PER_PROJECT } from '../s2/ingest.js';
import { SIZE_LIMIT, kindFromExt, sniffMatches, readHead } from '../s2/probe.js';

const Id = z.string().regex(ULID, 'expected an id');
const P = z.object({ id: Id });
const PA = z.object({ id: Id, assetId: Id });
const PathsBody = z.object({ paths: z.array(z.string().min(1).max(4096)).min(1), copy: z.boolean().default(true) }).strict();
const MAX_PATHS = 50;

export interface AssetsOptions {
  /** Folders imports may come from (TR-081: user profile, removable drives, drop sources). Default: home + EM_IMPORT_ROOTS. */
  importRoots?: () => string[];
}
const defaultRoots = (): string[] => [os.homedir(), ...(process.env['EM_IMPORT_ROOTS'] ?? '').split(path.delimiter).filter(Boolean)];

/** Canonical path inside an allowed root, else EM-1007 (403). UNC/device paths refused; traversal neutralised by realpath. */
export function canonicalImportPath(p: string, roots: readonly string[]): string {
  if (/^\\\\/.test(p) || /^\/\/[^/]/.test(p)) throw new EmError('EM-1007', 'Files from this location cannot be imported.');
  let real: string;
  try { real = fs.realpathSync(path.resolve(p)); } catch { throw new EmError('EM-1010', 'The file was removed before the import finished.', { status: 422 }); }
  const ok = roots.some((r) => { try { return isInside(fs.realpathSync(r), real); } catch { return false; } });
  if (!ok) throw new EmError('EM-1007', 'Files from this location cannot be imported.');
  return real;
}

const isShell = (req: Request) => req.headers['x-expertmotion-caller'] === 'shell';
const dto = (ctx: ServiceContext, r: AssetRow, probe = false) => toAssetDto(r, ingestOf(ctx).progressOf(r.id), probe);

/** Clips/layers of the head model that reference an asset (R-033). */
function references(ctx: ServiceContext, projectId: string, assetId: string): OperationT[] {
  let model;
  try { model = ctx.hooks.composition(projectId).model; } catch { return []; }
  const ops: OperationT[] = [];
  for (const c of model.tracks.video) if (c.assetId === assetId) ops.push({ op: 'op:clip.remove', target: { kind: 'clip', id: c.id }, args: {} });
  for (const a of model.tracks.audio) if (a.assetId === assetId) ops.push({ op: 'op:audio.remove', target: { kind: 'audio', id: a.id }, args: {} });
  return ops;
}

export function createAssetsModule(opts: AssetsOptions = {}): ServiceModule {
  const roots = opts.importRoots ?? defaultRoots;
  return {
    name: 'assets',
    start(ctx) {
      ctx.hooks.assetFacts = (projectId) => listAssets(ctx, projectId).map(toFacts);
      const r = ingestOf(ctx).recover();
      if (r.requeued.length || r.failed.length) ctx.log.info({ requeued: r.requeued.length, failed: r.failed.length }, 'ingest recovery');
    },
    register(router, ctx) {
      const ingest = ingestOf(ctx);

      // R-030 import: JSON `paths[]` (Shell, T+S) or a raw streamed body (browser development only; deviation from multipart, see report)
      route(router, 'post', '/projects/:id/assets', { params: P, status: 202 }, async ({ params, req }) => {
        requireProject(ctx, params.id);
        const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (type === 'application/json') {
          if (!isShell(req)) throw em('EM-8005', 'Request refused.');
          const raw = (req.body ?? {}) as { paths?: unknown };
          if (Array.isArray(raw.paths) && raw.paths.length > MAX_PATHS) throw em('EM-1010', 'You can import up to 50 files at a time.', { details: { count: raw.paths.length, limit: MAX_PATHS } });
          const body = parseOrThrow(PathsBody, req.body, 'body');
          const files = body.paths.map((p) => canonicalImportPath(p, roots()));   // one path outside the roots refuses the whole request
          const items: AssetRow[] = []; const notices: Array<{ code: string; name: string; index: number; details?: unknown }> = []; const errors: EmError[] = [];
          for (const [index, file] of files.entries()) {
            const name = path.basename(body.paths[index]!.replace(/\\/g, '/'));
            try {
              const s = await inspectSource(file, name);
              await ingest.checkCapacity(params.id, s.bytes);
              items.push(ingest.importFile({ projectId: params.id, source: file, name, kind: s.kind, bytes: s.bytes, ext: s.ext }));
            } catch (e) {
              if (!(e instanceof EmError)) throw e;
              errors.push(e); notices.push({ code: e.code, name, index, ...(e.details === undefined ? {} : { details: e.details }) });
            }
          }
          if (items.length === 0 && errors.length === 1) throw errors[0];
          return { items: items.map((r) => dto(ctx, r)), notices };
        }
        if (type === 'multipart/form-data') throw em('EM-9002', 'Invalid request: send the file as a raw body (application/octet-stream) with X-Expertmotion-Filename.', { status: 400, path: 'body' });
        if (type !== 'application/octet-stream') throw em('EM-9002', 'Invalid request: unsupported content type.', { status: 400, path: 'headers.content-type' });
        if (!ctx.cfg.dev) throw em('EM-8005', 'Request refused.');
        return rawUpload(ctx, params.id, req);
      });

      // R-031
      route(router, 'get', '/projects/:id/assets', {
        params: P, query: z.object({ kind: z.enum(['video', 'image', 'audio', 'subtitle']).optional(), status: z.enum(['ingesting', 'ready', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(400).optional() }),
      }, ({ params, query }) => {
        requireProject(ctx, params.id);
        const where = ['project_id = ?']; const args: unknown[] = [params.id];
        if (query.kind) { where.push('kind = ?'); args.push(query.kind); }
        if (query.status) { where.push('status = ?'); args.push(query.status); }
        const total = (ctx.db.prepare(`SELECT count(*) AS n FROM assets WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
        const cur = decodeCursor(query.cursor);
        if (cur) { where.push('(created_at > ? OR (created_at = ? AND id > ?))'); args.push(cur[0], cur[0], cur[1]); }
        const rows = ctx.db.prepare(`SELECT * FROM assets WHERE ${where.join(' AND ')} ORDER BY created_at, id LIMIT ?`).all(...args, query.limit + 1) as AssetRow[];
        const page = rows.slice(0, query.limit); const last = page[page.length - 1];
        return { items: page.map((r) => dto(ctx, r)), nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null, total };
      });

      // R-032
      route(router, 'get', '/projects/:id/assets/:assetId', { params: PA, query: z.object({ probe: z.enum(['true', 'false']).optional() }) }, ({ params, query }) =>
        dto(ctx, requireAsset(ctx, params.id, params.assetId), query.probe === 'true'));

      // R-033
      route(router, 'delete', '/projects/:id/assets/:assetId', { params: PA, query: z.object({ confirm: z.enum(['true', 'false']).optional() }) }, async ({ params, query }) => {
        const row = requireAsset(ctx, params.id, params.assetId);
        const ops = references(ctx, params.id, row.id);
        let versionId: string | null = null;
        if (ops.length) {
          if (query.confirm !== 'true') throw em('EM-1101', `"${row.name}" is used by ${ops.length} clips.`, { status: 409, details: { clips: ops.length } });
          versionId = ctx.hooks.applyOps(params.id, ops, { kind: 'asset', ref: row.id, summary: `Removed ${row.name}` });
        }
        ingest.cancel(row.id);
        ctx.db.transaction(() => {
          ctx.db.prepare('UPDATE generator_jobs SET result_asset_id = NULL WHERE result_asset_id = ?').run(row.id);
          ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
        })();
        clearBadges(ctx, params.id, []);
        await fs.promises.rm(assetDir(ctx, params.id, row.id), { recursive: true, force: true });
        return versionId ? { version: { id: versionId } } : undefined;
      });

      // R-034
      route(router, 'put', '/projects/:id/assets/:assetId/sequence-badge', { params: PA, body: z.object({ badge: z.number().int().min(1).max(MAX_ASSETS_PER_PROJECT).nullable() }) }, ({ params, body }) => {
        requireAsset(ctx, params.id, params.assetId);
        const changed = setBadge(ctx, params.id, params.assetId, body.badge);
        return { items: changed.map((id) => dto(ctx, getAsset(ctx, id)!)) };
      });

      // R-035 Insert → one version through hooks.applyOps
      route(router, 'post', '/projects/:id/assets/insert', {
        params: P, body: z.object({ assetIds: z.array(Id).min(1).max(50), order: z.enum(['badge', 'given']).default('badge'), atIndex: z.number().int().min(0).optional(), asOverlay: z.boolean().default(false), atMs: z.number().int().min(0).optional() }),
      }, ({ params, body }) => {
        requireProject(ctx, params.id);
        const rows = [...new Set(body.assetIds)].map((id) => requireAsset(ctx, params.id, id));
        const notReady = rows.find((r) => r.status !== 'ready');
        if (notReady) throw em('EM-1301', `"${notReady.name}" is not ready yet.`, { status: 422, details: { assetId: notReady.id } });
        const ordered = body.order === 'given' ? rows : [...rows].sort((a, b) =>
          (a.sequence_badge ?? Infinity) - (b.sequence_badge ?? Infinity) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
        const warnings: Array<{ code: string; path: string; message: string; severity: 'warn' }> = [];
        const ops: OperationT[] = []; let clipIndex = body.atIndex;
        for (const r of ordered) {
          if (r.kind === 'image' && body.asOverlay) ops.push({ op: 'op:overlay.addImage', args: { assetId: r.id, atMs: body.atMs ?? 0 } });   // FR-029 (ADR-020 addition)
          else if (r.kind === 'video' || r.kind === 'image') { ops.push({ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: r.id, ...(clipIndex === undefined ? {} : { atIndex: clipIndex }) } }); if (clipIndex !== undefined) clipIndex++; }
          else if (r.kind === 'audio') ops.push({ op: 'op:audio.addLayer', args: { assetId: r.id, atMs: 0, volume: 1, role: 'voice' } });
          else ops.push({ op: 'op:caption.importSrt', target: { kind: 'project' }, args: { assetId: r.id } });
        }
        const versionId = ctx.hooks.applyOps(params.id, ops, { kind: 'asset', summary: `Inserted ${ordered.length} asset${ordered.length === 1 ? '' : 's'}` });
        clearBadges(ctx, params.id, ordered.map((r) => r.id));
        return { version: { id: versionId }, ops, warnings };
      });

      // R-036 relocate (T+S): the new file must hash to the stored sha256
      route(router, 'post', '/projects/:id/assets/:assetId/relocate', { params: PA, body: z.object({ path: z.string().min(1).max(4096), reingest: z.boolean().default(false) }) }, async ({ params, body, req }) => {
        if (!isShell(req)) throw em('EM-8005', 'Request refused.');
        const row = requireAsset(ctx, params.id, params.assetId);
        const file = canonicalImportPath(body.path, roots());
        const sha = await hashFile(file);
        if (sha !== row.sha256) {
          if (!body.reingest) throw em('EM-1302', `"${row.name}" has changed on disk since it was imported.`, { status: 422 });
          const s = await inspectSource(file, row.name);
          await ingest.checkCapacity(params.id, s.bytes);
          return dto(ctx, ingest.importFile({ projectId: params.id, source: file, name: row.name, kind: s.kind, bytes: s.bytes, ext: s.ext }));
        }
        const dst = path.resolve(ctx.paths.media, row.original_path);
        if (!isInside(ctx.paths.media, dst)) throw em('EM-9003', 'Not found.');
        await fs.promises.mkdir(path.dirname(dst), { recursive: true });
        await fs.promises.copyFile(file, dst);
        ingest.requeue(row.id);
        return dto(ctx, getAsset(ctx, row.id)!);
      });
    },
  };
}

/** Raw-body dev upload: stream to tmp with sha256 and a size cap, sniff, dedupe, then queue from probe. */
async function rawUpload(ctx: ServiceContext, projectId: string, req: Request) {
  let name = '';
  try { name = decodeURIComponent(String(req.headers['x-expertmotion-filename'] ?? '')); } catch { /* invalid encoding */ }
  name = path.basename(name.replace(/\\/g, '/'));
  if (!name) throw em('EM-9002', 'Invalid request: X-Expertmotion-Filename is required.', { status: 400, path: 'headers.x-expertmotion-filename' });
  const kind = kindFromExt(name);
  if (!kind) throw em('EM-1001', 'This file type is not supported.', { details: { name, reason: 'extension' } });
  const limit = SIZE_LIMIT[kind];
  const declared = Number(req.headers['content-length'] ?? NaN);
  if (Number.isFinite(declared) && declared > limit) throw em('EM-1002', 'This file is too large.', { details: { name, size: declared, limit } });
  const ingest = ingestOf(ctx);
  await ingest.checkCapacity(projectId, Number.isFinite(declared) ? declared : 0);
  const ext = path.extname(name).toLowerCase();
  const tmp = path.join(ctx.paths.tmp, `upload-${crypto.randomBytes(8).toString('hex')}${ext}`);
  const hash = crypto.createHash('sha256'); let bytes = 0;
  try {
    await pipeline(req, new Transform({ transform(c: Buffer, _e, cb) {
      bytes += c.length;
      if (bytes > limit) { cb(em('EM-1002', 'This file is too large.', { details: { name, limit } })); return; }
      hash.update(c); cb(null, c);
    } }), fs.createWriteStream(tmp, { flags: 'wx' }));
    if (bytes === 0 || !sniffMatches(kind, await readHead(tmp))) throw em('EM-1001', 'This file type is not supported.', { details: { name, reason: 'content' } });
  } catch (e) { await fs.promises.rm(tmp, { force: true }); throw e; }
  const { row, duplicate } = await ingest.importHashed({ projectId, tmpFile: tmp, name, kind, bytes, ext, sha256: hash.digest('hex') });
  return { items: [toAssetDto(row, ingest.progressOf(row.id))], notices: duplicate ? [{ code: 'EM-1006', assetId: row.id, name }] : [] };
}

export const assetsModule: ServiceModule = createAssetsModule();
