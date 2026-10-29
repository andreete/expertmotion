// Media module: R-040/R-041 file serving with Range under /media/<grant>/… (root router; the grant in the path is the credential,
// SEC-010; CORS for app://, the dev UI and render origins is answered by hostOriginGuard) and R-042/R-043 preview grants.
// Paths come from the DB only; a realpath check keeps them inside the media/outputs roots. Files are streamed, never cached.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { GRANT_RE } from '../services/grants.js';
import { ULID, contentTypeFor, realInside, requireProject } from '../s2/common.js';
import { VARIANTS, getAsset, variantColumn, type Variant } from '../s2/assets-repo.js';
import { getOutput, outputAbsPath, outputRoots } from '../s2/render-repo.js';

const notFound = (res: Response, code = 'EM-9003', message = 'Not found.') => { res.status(404).json({ error: { code, message } }); };
const bad = (res: Response) => { res.status(400).json({ error: { code: 'EM-9002', message: 'Invalid request.' } }); };

/** Streams `file` honouring a single `Range: bytes=` (206/416); HEAD sends headers only. The promise settles when the
 *  response has finished or closed, and `res.locals.emStreaming` tells `route()` not to end the response itself: before the
 *  first chunk `headersSent` is still false, and route() used to answer 204 while the stream was starting (QA P1 2026-10-29). */
export function sendFile(req: Request, res: Response, file: string, extra: Record<string, string> = {}): Promise<void> {
  let size: number;
  try { size = fs.statSync(file).size; } catch { notFound(res, 'EM-1301', 'The media file is missing.'); return Promise.resolve(); }
  res.setHeader('Content-Type', contentTypeFor(file));
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Content-Disposition', 'inline');
  // `same-site` (spec) would block no-cors loads from the Remotion page on localhost:<port> (a different site than 127.0.0.1).
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  const range = req.headers.range;
  let start = 0, end = size - 1, status = 200;
  if (typeof range === 'string' && !range.includes(',')) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') start = Math.max(0, size - Number(m[2]));
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), size - 1); }
      if (start >= size || start > end || (m[1] === '' && Number(m[2]) === 0)) { res.setHeader('Content-Range', `bytes */${size}`); res.status(416).end(); return Promise.resolve(); }
      status = 206; res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
  }
  res.status(status);
  res.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1));
  if (req.method === 'HEAD' || size === 0) { res.end(); return Promise.resolve(); }
  res.locals['emStreaming'] = true;
  return new Promise<void>((resolve) => {
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => { res.destroy(); resolve(); });
    res.on('close', () => { stream.destroy(); resolve(); });
    res.on('finish', () => resolve());
    stream.pipe(res);
  });
}

function serveAsset(ctx: ServiceContext, req: Request, res: Response): void {
  const { grant, assetId, variant } = req.params as { grant: string; assetId: string; variant: string };
  if (!GRANT_RE.test(grant) || !ULID.test(assetId)) return bad(res);
  if (!(VARIANTS as readonly string[]).includes(variant)) return notFound(res);
  const row = getAsset(ctx, assetId);
  if (!row || !ctx.grants.check(grant, row.project_id, assetId)) return notFound(res);
  const relPath = row[variantColumn[variant as Variant]] as string | null;
  if (!relPath) {
    if (row.status === 'ingesting' && variant !== 'original') { res.status(409).json({ error: { code: 'EM-6004', message: 'This file is still being prepared.' } }); return; }
    return notFound(res);
  }
  const candidate = path.resolve(ctx.paths.media, relPath);
  if (!fs.existsSync(candidate)) return notFound(res, 'EM-1301', 'The media file is missing.');
  const file = realInside(path.join(ctx.paths.media, row.project_id), candidate);
  if (!file) return notFound(res);
  void sendFile(req, res, file, variant === 'filmstrip' ? { 'X-Filmstrip-Frames': '8' } : {});
}

function serveOutput(ctx: ServiceContext, req: Request, res: Response): void {
  const { grant, outputId, variant } = req.params as { grant: string; outputId: string; variant: string };
  if (!GRANT_RE.test(grant) || !ULID.test(outputId)) return bad(res);
  if (variant !== 'file' && variant !== 'thumb') return notFound(res);
  const out = getOutput(ctx, outputId);
  const g = out ? ctx.grants.lookup(grant) : undefined;
  if (!out || !g || g.kind !== 'preview' || !ctx.grants.check(grant, out.project_id, outputId)) return notFound(res);
  const relPath = variant === 'file' ? out.path : out.thumb_path;
  if (!relPath) return notFound(res);
  const candidate = outputAbsPath(ctx, relPath);
  if (!fs.existsSync(candidate)) return notFound(res, 'EM-1301', 'The output file is missing.');
  const file = outputRoots(ctx).map((r) => realInside(r, candidate)).find((f) => f !== null);
  if (!file) return notFound(res);
  void sendFile(req, res, file);
}

export const mediaModule: ServiceModule = {
  name: 'media',
  registerRoot(router, ctx) {
    router.get('/media/:grant/outputs/:outputId/:variant', (req, res) => serveOutput(ctx, req, res));   // GET routes also answer HEAD
    router.get('/media/:grant/:assetId/:variant', (req, res) => serveAsset(ctx, req, res));
    router.all('/media/*', (req, res) => {
      if (req.method === 'GET' || req.method === 'HEAD') return notFound(res);
      res.setHeader('Allow', 'GET, HEAD'); res.status(405).json({ error: { code: 'EM-9002', message: 'Method not allowed.' } });
    });
  },
  register(router, ctx) {
    // R-042: a fresh preview grant; the previous preview grant of the project is revoked
    route(router, 'post', '/projects/:id/media-grants', { params: z.object({ id: z.string().regex(ULID) }), status: 201 }, ({ params }) => {
      requireProject(ctx, params.id);
      ctx.grants.revoke(ctx.grants.issuePreview(params.id).token);
      const g = ctx.grants.issuePreview(params.id);
      return { grant: g.token, projectId: params.id, kind: 'preview', expiresAt: new Date(g.expiresAt).toISOString(), baseUrl: `http://127.0.0.1:${ctx.cfg.port}/media/${g.token}` };
    });
    // R-043: idempotent; render grants cannot be addressed over the API
    route(router, 'delete', '/media-grants/:grant', { params: z.object({ grant: z.string().regex(GRANT_RE) }) }, ({ params }) => {
      if (ctx.grants.lookup(params.grant)?.kind === 'preview') ctx.grants.revoke(params.grant);
      return undefined;
    });
  },
};
