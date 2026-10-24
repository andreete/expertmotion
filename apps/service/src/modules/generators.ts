// Generators module: R-130…R-133 (API_SPECIFICATION §6.13); jobs live in s2/generators-service.ts.
import { z } from 'zod';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { ULID, decodeCursor, em, encodeCursor, parseOrThrow, requireProject } from '../s2/common.js';
import { GENERATOR_KINDS, generatorsServiceOf, toGenDto, type GeneratorKind, type GeneratorsOptions } from '../s2/generators-service.js';

const Id = z.string().regex(ULID, 'expected an id');
const Lang = z.string();   // id|en checked by the service so unsupported languages answer EM-7105
const insert = { insert: z.boolean().default(false) };
const BODIES: Record<GeneratorKind, z.ZodType<Record<string, unknown>>> = {
  captions: z.object({ assetId: Id, language: Lang, modelKey: z.string().max(64).optional(), ...insert }),
  voice: z.object({ text: z.string().min(1).max(20_000), voiceId: z.string().min(1).max(64), language: Lang, speed: z.number().min(0.8).max(1.2).optional(), atMs: z.number().int().min(0).optional(), ...insert }),
  music: z.object({ prompt: z.string().min(1).max(300), durationMs: z.number().int().min(5000).max(300_000), style: z.string().max(100).optional(), instrumental: z.boolean().optional(),
    modelKey: z.string().max(64).optional(), ...insert }),
  thumbnail: z.object({ frameMs: z.number().int().min(0).optional(), titleText: z.string().max(500).optional(), prompt: z.string().min(1).max(1000).optional(), count: z.number().int().min(1).max(4).optional(),
    size: z.object({ w: z.number().int().min(256).max(2048), h: z.number().int().min(256).max(2048) }).optional() }),
  hashtags: z.object({ language: Lang, platform: z.enum(['tiktok', 'instagram', 'youtube']), count: z.number().int().min(5).max(30) }),
};

export function createGeneratorsModule(opts: GeneratorsOptions = {}): ServiceModule {
  return {
    name: 'generators',
    start(ctx) { const n = generatorsServiceOf(ctx, opts).recover(); if (n) ctx.log.info({ jobs: n }, 'interrupted generator jobs marked failed'); },
    register(router, ctx) {
      const svc = generatorsServiceOf(ctx, opts);
      route(router, 'get', '/generators', {}, async () => ({ items: await svc.cards() }));   // R-135 (FR-100, FR-107)
      route(router, 'post', '/projects/:id/generators/:kind', { params: z.object({ id: Id, kind: z.enum(GENERATOR_KINDS) }), status: 202 }, ({ params, req }) => {   // R-130
        requireProject(ctx, params.id);
        if (!(opts.enabledKinds ?? GENERATOR_KINDS).includes(params.kind)) throw em('EM-9004', `"${params.kind}" is not available in this version of Expertmotion yet.`, { status: 422, details: { feature: `generator.${params.kind}` } });
        const raw = (req.body ?? {}) as Record<string, unknown>;
        if (params.kind === 'voice' && typeof raw['text'] === 'string' && [...raw['text']].length > 2000) throw em('EM-7106', 'Voice generation accepts up to 2,000 characters at a time.', { details: { chars: [...raw['text']].length, limit: 2000 } });
        return svc.create(params.id, params.kind, parseOrThrow(BODIES[params.kind], raw, 'body'));
      });
      route(router, 'get', '/projects/:id/generator-jobs', { params: z.object({ id: Id }), query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: z.string().max(400).optional(),
        kind: z.enum(GENERATOR_KINDS).optional() }) }, ({ params, query }) => {   // R-131
        requireProject(ctx, params.id);
        svc.purge();
        const where = ['project_id = ?']; const args: unknown[] = [params.id];
        if (query.kind) { where.push('kind = ?'); args.push(query.kind); }
        const total = (ctx.db.prepare(`SELECT count(*) AS n FROM generator_jobs WHERE ${where.join(' AND ')}`).get(...args) as { n: number }).n;
        const cur = decodeCursor(query.cursor);
        if (cur) { where.push('(created_at < ? OR (created_at = ? AND id < ?))'); args.push(cur[0], cur[0], cur[1]); }
        const rows = ctx.db.prepare(`SELECT * FROM generator_jobs WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`).all(...args, query.limit + 1) as Parameters<typeof toGenDto>[0][];
        const page = rows.slice(0, query.limit); const last = page[page.length - 1];
        return { items: page.map(toGenDto), nextCursor: rows.length > query.limit && last ? encodeCursor(last.created_at, last.id) : null, total };
      });
      route(router, 'get', '/generator-jobs/:jobId', { params: z.object({ jobId: Id }) }, ({ params }) => {   // R-132
        const r = svc.get(params.jobId); if (!r) throw em('EM-9003', 'Not found.'); return toGenDto(r);
      });
      route(router, 'post', '/generator-jobs/:jobId/insert', { params: z.object({ jobId: Id }), body: z.object({ pages: z.array(z.record(z.string(), z.unknown())).max(5000).optional() }).strict().default({}) }, ({ params, body }) => {   // R-134
        const r = svc.insertResult(params.jobId, body.pages ? { pages: body.pages } : {}); if (!r) throw em('EM-9003', 'Not found.'); return r;
      });
      route(router, 'post', '/generator-jobs/:jobId/save-output', { params: z.object({ jobId: Id }), body: z.object({ assetId: Id }).strict() }, ({ params, body }) => {   // R-136 (FR-103)
        const r = svc.saveOutput(params.jobId, body.assetId); if (!r) throw em('EM-9003', 'Not found.'); return r;
      });
      route(router, 'delete', '/generator-jobs/:jobId', { params: z.object({ jobId: Id }) }, ({ params }) => {   // R-137 (FR-108)
        if (!svc.remove(params.jobId)) throw em('EM-9003', 'Not found.'); return undefined;
      });
      route(router, 'post', '/generator-jobs/:jobId/cancel', { params: z.object({ jobId: Id }) }, ({ params }) => {   // R-133
        const r = svc.cancel(params.jobId); if (!r) throw em('EM-9003', 'Not found.'); return r;
      });
    },
  };
}
export const generatorsModule: ServiceModule = createGeneratorsModule();
