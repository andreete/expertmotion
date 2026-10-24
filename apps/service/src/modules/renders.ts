// Renders module: R-110…R-119 (API_SPECIFICATION §6.11). Queue, preflight and Outputs live in s2/render-service.ts.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { ULID, decodeCursor, em, encodeCursor, requireProject } from '../s2/common.js';
import { getJob, getOutput, outputAbsPath, toJobDto, toOutputDto, type OutputRow, type RenderJobRow } from '../s2/render-repo.js';
import { renderServiceOf, type RenderOptions } from '../s2/render-service.js';
import { s2 } from '../s2/state.js';

const Id = z.string().regex(ULID, 'expected an id');
export const OutputProfile = z.object({
  ratio: z.enum(['16:9', '9:16', '1:1', '4:5', '5:4', '4:3', '3:4', 'custom']), customRatio: z.object({ w: z.number().int().min(1), h: z.number().int().min(1) }).optional(),
  resolution: z.enum(['720p', '1080p', '2k', '2160p']), fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(50), z.literal(60)]),
  format: z.enum(['mp4', 'webm', 'gif', 'png', 'wav']), codec: z.enum(['h264', 'vp9', 'gif', 'png', 'pcm']).optional(), crf: z.number().int().min(1).max(51).optional(),
  alpha: z.boolean().default(false), stillAtMs: z.number().int().min(0).optional(),
});
export const RenderCreateInput = z.object({ projectId: Id, versionId: Id.optional(), outputProfile: OutputProfile, performanceProfile: z.enum(['standard', 'accelerated', 'turbo']),
  fileName: z.string().max(80).optional(), folder: z.string().max(1024).optional() });
const Page = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(400).optional() });
const FINAL = new Set(['done', 'failed', 'cancelled']);

export function createRendersModule(opts: RenderOptions = {}): ServiceModule {
  return {
    name: 'renders',
    start(ctx) {
      const n = renderServiceOf(ctx, opts).recover();
      if (n) ctx.log.info({ jobs: n }, 'interrupted render jobs marked failed');
    },
    async stop(ctx) { await renderServiceOf(ctx, opts).stopAll(); },
    register(router, ctx) {
      const svc = renderServiceOf(ctx, opts);
      route(router, 'post', '/renders/estimate', { body: RenderCreateInput }, async ({ body }) => svc.estimateResponse(await svc.prepare(body)));   // R-110

      route(router, 'post', '/renders', { body: RenderCreateInput, status: 202 }, async ({ body, req, res }) => {     // R-111
        const key = req.headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || key.length > 128)) throw em('EM-9002', 'Invalid request: Idempotency-Key', { status: 400, path: 'headers.idempotency-key' });
        const r = await svc.create(body, key);
        if (r.repeat) { res.status(200).json({ ...r.job, notice: 'EM-2308', notices: r.notices }); return; }
        return { ...r.job, notices: r.notices };
      });

      route(router, 'get', '/renders', { query: Page.extend({ projectId: Id.optional(), status: z.enum(['queued', 'rendering', 'done', 'failed', 'cancelled']).optional() }) }, ({ query }) => {   // R-112
        const where: string[] = []; const args: unknown[] = [];
        if (query.projectId) { where.push('project_id = ?'); args.push(query.projectId); }
        if (query.status) { where.push('status = ?'); args.push(query.status); }
        const total = (ctx.db.prepare(`SELECT count(*) AS n FROM render_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...args) as { n: number }).n;
        const cur = decodeCursor(query.cursor);
        if (cur) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(cur[0], cur[0], cur[1]); }
        const rows = ctx.db.prepare(`SELECT * FROM render_jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, query.limit + 1) as RenderJobRow[];
        const page = rows.slice(0, query.limit); const last = page[page.length - 1];
        return { items: page.map(toJobDto), nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null, total };
      });

      const job = (id: string) => { const j = getJob(ctx, id); if (!j) throw em('EM-9003', 'Not found.'); return j; };
      route(router, 'get', '/renders/:jobId', { params: z.object({ jobId: Id }) }, ({ params }) => toJobDto(job(params.jobId)));        // R-113
      route(router, 'post', '/renders/:jobId/cancel', { params: z.object({ jobId: Id }) }, ({ params }) => {                          // R-114
        job(params.jobId);
        return toJobDto(svc.cancel(params.jobId)!);
      });

      // R-115 per-job SSE: current state first, then render.* of this job; closes after the final event
      route(router, 'get', '/renders/:jobId/events', { params: z.object({ jobId: Id }) }, ({ params, req, res }) => {
        const j = job(params.jobId);
        ctx.bus.attach(req, res, (e) => e.name.startsWith('render.') && e.data['jobId'] === j.id);
        const snapshot = (name: string, data: Record<string, unknown>) => res.write(`event: ${name}\ndata: ${JSON.stringify({ seq: ctx.bus.lastSeq, at: ctx.now(), projectId: j.project_id, jobId: j.id, ...data })}\n\n`);
        if (FINAL.has(j.status)) {
          const o = j.output_id ? getOutput(ctx, j.output_id) : undefined;
          if (j.status === 'done') snapshot('render.done', { output: o ? toOutputDto(ctx, o) : null, notices: [] });
          else if (j.status === 'failed') snapshot('render.failed', { code: j.error_code, percent: Math.round(j.progress * 100) });
          else snapshot('render.cancelled', { percent: Math.round(j.progress * 100) });
          res.end(); return;
        }
        if (j.status === 'queued') snapshot('render.queued', { job: toJobDto(j) });
        else snapshot('render.progress', { progress: j.progress, renderedFrames: j.rendered_frames, totalFrames: j.total_frames, etaMs: j.eta_ms, stage: 'rendering' });
        const onFinal = (id: string) => { if (id === j.id) setImmediate(() => res.end()); };
        s2(ctx).events.on('render.final', onFinal);
        res.on('close', () => s2(ctx).events.off('render.final', onFinal));
      });

      route(router, 'get', '/projects/:id/outputs', { params: z.object({ id: Id }), query: Page }, ({ params, query }) => {           // R-116
        requireProject(ctx, params.id);
        const where = ['project_id = ?']; const args: unknown[] = [params.id];
        const total = (ctx.db.prepare('SELECT count(*) AS n FROM outputs WHERE project_id = ?').get(params.id) as { n: number }).n;
        const cur = decodeCursor(query.cursor);
        if (cur) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(cur[0], cur[0], cur[1]); }
        const rows = ctx.db.prepare(`SELECT * FROM outputs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, query.limit + 1) as OutputRow[];
        const page = rows.slice(0, query.limit); const last = page[page.length - 1];
        return { items: page.map((o) => toOutputDto(ctx, o)), nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null, total };
      });
      const output = (id: string) => { const o = getOutput(ctx, id); if (!o) throw em('EM-9003', 'Not found.'); return o; };
      route(router, 'get', '/outputs/:outputId', { params: z.object({ outputId: Id }) }, ({ params }) => toOutputDto(ctx, output(params.outputId)));   // R-117
      route(router, 'delete', '/outputs/:outputId', { params: z.object({ outputId: Id }) }, async ({ params }) => {                                  // R-118
        const o = output(params.outputId);
        try {
          await fs.promises.rm(outputAbsPath(ctx, o.path), { force: true });
          if (o.thumb_path) await fs.promises.rm(outputAbsPath(ctx, o.thumb_path), { force: true });
        } catch (e) { throw em('EM-6004', 'The file is in use.', { cause: e }); }
        ctx.db.transaction(() => {
          ctx.db.prepare('UPDATE render_jobs SET output_id = NULL WHERE output_id = ?').run(o.id);
          ctx.db.prepare('DELETE FROM outputs WHERE id = ?').run(o.id);
        })();
        return undefined;
      });
      route(router, 'post', '/outputs/:outputId/reveal', { params: z.object({ outputId: Id }) }, ({ params }) => {                        // R-119 (path only; the Shell opens it)
        const file = outputAbsPath(ctx, output(params.outputId).path);
        if (!fs.existsSync(file)) throw em('EM-1301', 'The output file is missing.');
        return { path: file, folder: path.dirname(file) };
      });
    },
  };
}

export const rendersModule: ServiceModule = createRendersModule();
