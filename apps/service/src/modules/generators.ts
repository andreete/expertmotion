// Generators module: R-130…R-133 (API_SPECIFICATION §6.13); jobs live in s2/generators-service.ts.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { ULID, decodeCursor, em, encodeCursor, parseOrThrow, requireProject } from '../s2/common.js';
import { voicesServiceOf, PREVIEW_TEXT } from '../s2/voices-service.js';
import { musicLibraryOf } from '../s2/music-library-service.js';
import { sendFile } from './media.js';
import { MUSIC_MOODS, transcriptToSrt } from '@expertmotion/models';
import { musicBedOp } from '../s2/generators-service.js';
import { GENERATOR_KINDS, HASHTAG_TONES, THUMBNAIL_STYLES, generatorsServiceOf, toGenDto, type GeneratorKind, type GeneratorsOptions } from '../s2/generators-service.js';
import { contactSheet, frameTimes, latestAnalysis, prepDir } from '../s2/reels/footage-prep.js';
import { renderCover } from '../s2/reels/cover-service.js';
import { ensureSfxAssets } from '../s2/sfx-service.js';
import { s2 } from '../s2/state.js';

const Id = z.string().regex(ULID, 'expected an id');
const Lang = z.string();   // id|en checked by the service so unsupported languages answer EM-7105
const insert = { insert: z.boolean().default(false) };
/** FR-251 (R-138): several voice clips in one request. */
const VoiceBatch = z.object({
  clips: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/), text: z.string().min(1).max(2000), written: z.string().max(4000).optional() }).strict()).min(1).max(40),
  voiceId: z.string().min(1).max(200), language: z.enum(['id', 'en']).default('id'), speed: z.number().min(0.5).max(2).optional(), style: z.string().max(200).optional(),
  maxTotalMs: z.number().int().min(1000).max(1_800_000).optional(), startMs: z.number().int().min(0).optional(), gapMs: z.number().int().min(0).max(10_000).optional(),
  sceneGapMs: z.number().int().min(0).max(10_000).optional(), scenes: z.array(z.array(z.string().max(32)).max(40)).max(40).optional(), captions: z.boolean().optional(), insert: z.boolean().default(false),
}).strict();
const BODIES: Record<GeneratorKind, z.ZodType<Record<string, unknown>>> = {
  captions: z.object({ assetId: Id.optional(), source: z.enum(['asset', 'sequence']).optional(), language: Lang, modelKey: z.string().max(64).optional(), ...insert }),
  // FR-246: voiceId = a voice id (local:… / openai:… / gemini:… / elevenlabs:…), a legacy model key, or a description ("suara perempuan hangat")
  voice: z.object({ text: z.string().min(1).max(20_000), voiceId: z.string().min(1).max(200), language: Lang, speed: z.number().min(0.5).max(2).optional(), style: z.string().max(200).optional(),
    atMs: z.number().int().min(0).optional(), captions: z.boolean().optional(), captionText: z.string().max(20_000).optional(), ...insert }),
  music: z.object({ trackId: z.string().max(80).optional(), prompt: z.string().min(1).max(300), durationMs: z.number().int().min(5000).max(300_000), style: z.string().max(100).optional(), instrumental: z.boolean().optional(), language: Lang.optional(),
    modelKey: z.string().max(64).optional(), ...insert }),
  thumbnail: z.object({ frameMs: z.number().int().min(0).optional(), titleText: z.string().max(500).optional(), prompt: z.string().min(1).max(1000).optional(), count: z.number().int().min(1).max(4).optional(),
    style: z.enum(THUMBNAIL_STYLES).optional(), language: Lang.optional(), modelKey: z.string().max(64).optional(), size: z.object({ w: z.number().int().min(256).max(2048), h: z.number().int().min(256).max(2048) }).optional() }),
  hashtags: z.object({ language: Lang, platform: z.enum(['tiktok', 'instagram', 'youtube']), tone: z.enum(HASHTAG_TONES).optional(), count: z.number().int().min(5).max(30) }),
  // FR-285 (Reels footage prep): the recorder's voice file (or a video with speech) and the optional camera file; `offsetMs` / `sync` /
  // `resumedFrom` are what R-148 carries over from a job that stopped for the rotation confirmation
  prep: z.object({ voiceAssetId: Id, cameraAssetId: Id.optional(), script: z.string().max(20_000).optional(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
    targetFps: z.union([z.literal(24), z.literal(25), z.literal(30)]).optional(), maxTotalMs: z.number().int().min(5000).max(600_000).optional(), sttModelKey: z.string().max(64).optional(),
    offsetMs: z.number().int().min(-60_000).max(60_000).optional(), sync: z.record(z.string(), z.unknown()).optional(), resumedFrom: Id.optional(), shortSide: z.number().int().min(240).max(2160).optional(), confirmRotation: z.boolean().optional() }),
};
const Rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
/** FR-289 (R-153): cover spec (composer builds the model) or, for tests and custom covers, a Composition Model. */
const CoverBody = z.object({ cutId: z.string().max(64).optional(), atMs: z.number().int().min(0).optional(), hookWord: z.string().max(40).default(''), kicker: z.string().max(80).optional(), line: z.string().max(200).default(''),
  subline: z.string().max(200).optional(), pills: z.array(z.object({ text: z.string().max(40), tone: z.string().max(20).optional() })).max(6).optional(), icons: z.array(z.string().max(40)).max(6).optional(),
  source: z.string().max(200).optional(), handle: z.string().max(60).optional(), model: z.record(z.string(), z.unknown()).optional() }).strict();

export function createGeneratorsModule(opts: GeneratorsOptions = {}): ServiceModule {
  return {
    name: 'generators',
    start(ctx) {
      const svc = generatorsServiceOf(ctx, opts);
      const n = svc.recover(); if (n) ctx.log.info({ jobs: n }, 'interrupted generator jobs marked failed');
      // ADR-030: plan generator steps (voice-over, captions) for the Editor Agent and Execute.
      ctx.hooks.planToolModels = async (language) => {
        const enabled = opts.enabledKinds ?? GENERATOR_KINDS;
        return { tts: enabled.includes('voice') ? await svc.planToolModel('tts', language) : null, stt: enabled.includes('captions') ? await svc.planToolModel('stt', language) : null };
      };
      ctx.hooks.runPlanSteps = (projectId, planId, steps) => svc.runPlanSteps(projectId, planId, steps);
      ctx.hooks.readFootage = (projectId, assetIds, o) => svc.readFootage(projectId, assetIds, o);
      // FR-251 / FR-246 / FR-249 (ADR-035): voice clips, the voice list and transcripts for the agent runtime (auto motion, plans).
      ctx.hooks.voiceBatch = (projectId, input, opts) => svc.voiceBatch(projectId, input, opts);
      ctx.hooks.voiceCatalog = async (language) => (await voicesServiceOf(ctx).list(language)).map((v) => ({ id: v.id, name: v.name, provider: v.provider, gender: v.gender,
        traits: [...v.traits.id, ...v.traits.en], cloud: v.cloud, availability: v.availability, usdPer1kChars: v.usdPer1kChars ?? null }));
      ctx.hooks.voiceTranscript = (assetId) => svc.transcriptOf(assetId);
      // FR-288 (Reels): the project's procedural SFX Assets for the Execute path (plan steps that place SFX)
      ctx.hooks.sfxAssets = (projectId) => ensureSfxAssets(ctx, projectId);
    },
    register(router, ctx) {
      const svc = generatorsServiceOf(ctx, opts);
      route(router, 'get', '/generators', {}, async () => ({ items: await svc.cards() }));   // R-135 (FR-100, FR-107)
      route(router, 'post', '/projects/:id/generators/voice-batch', { params: z.object({ id: Id }), body: VoiceBatch, status: 202 }, async ({ params, body }) => {   // R-138 (FR-251)
        requireProject(ctx, params.id);
        if (new Set(body.clips.map((c) => c.id)).size !== body.clips.length) throw em('EM-9002', 'Invalid request: clip ids must be unique.', { status: 400, path: 'body.clips' });
        return svc.create(params.id, 'voice', body as unknown as Record<string, unknown>);
      });
      route(router, 'post', '/projects/:id/generators/:kind', { params: z.object({ id: Id, kind: z.enum(GENERATOR_KINDS) }), status: 202 }, ({ params, req }) => {   // R-130
        requireProject(ctx, params.id);
        if (!(opts.enabledKinds ?? GENERATOR_KINDS).includes(params.kind)) throw em('EM-9004', `"${params.kind}" is not available in this version of Expertmotion yet.`, { status: 422, details: { feature: `generator.${params.kind}` } });
        const raw = (req.body ?? {}) as Record<string, unknown>;
        if (params.kind === 'voice' && typeof raw['text'] === 'string' && [...raw['text']].length > 2000) throw em('EM-7106', 'Voice generation accepts up to 2,000 characters at a time.', { details: { chars: [...raw['text']].length, limit: 2000 } });
        return svc.create(params.id, params.kind, parseOrThrow(BODIES[params.kind], raw, 'body'));
      });
      // FR-246 (R-215 … R-218): narrator voices, previews, the ElevenLabs key
      route(router, 'get', '/voices', { query: z.object({ language: z.enum(['id', 'en']).default('id'), refresh: z.enum(['1']).optional() }) }, async ({ query }) => {
        const vs = voicesServiceOf(ctx);
        return { items: await vs.list(query.language, { refresh: query.refresh === '1' }), privateMode: ctx.settings.get().privateMode, elevenLabsKey: vs.elevenLabsKeyHint(),
          ...(() => { const k = vs.voiceKeys(); return { azureKey: k.azure.hint, azureRegion: k.azure.region ?? null, googleCloudKey: k['google-cloud'].hint }; })() };   // FR-269
      });
      route(router, 'get', '/voices/:voiceId/preview', { params: z.object({ voiceId: z.string().min(3).max(200) }), query: z.object({ language: z.enum(['id', 'en']).default('id') }) }, async ({ params, query, req, res }) => {
        const vs = voicesServiceOf(ctx);
        const file = vs.previewPath(params.voiceId, query.language);
        if (!fs.existsSync(file)) {
          const v = await svc.resolveVoice(params.voiceId, query.language);
          if (v.id !== params.voiceId) throw em('EM-9003', 'Not found.');
          await svc.previewVoice(v, query.language, file, PREVIEW_TEXT[query.language]);
        }
        await sendFile(req, res, file, { 'Cache-Control': 'private, max-age=86400' });
      });
      route(router, 'put', '/voice-keys/elevenlabs', { body: z.object({ key: z.string().min(10).max(400) }).strict() }, ({ body }) => voicesServiceOf(ctx).setElevenLabsKey(body.key));
      route(router, 'delete', '/voice-keys/elevenlabs', {}, () => { voicesServiceOf(ctx).removeElevenLabsKey(); return undefined; });
      // FR-269 (R-217b / R-217c): Azure AI Speech key + region, Google Cloud Text-to-Speech key; GET lists the hints
      route(router, 'get', '/voice-keys', {}, () => voicesServiceOf(ctx).voiceKeys());
      route(router, 'put', '/voice-keys/azure', { body: z.object({ key: z.string().min(10).max(400), region: z.string().min(3).max(40) }).strict() }, ({ body }) => voicesServiceOf(ctx).setAzureKey(body.key, body.region));
      route(router, 'delete', '/voice-keys/azure', {}, () => { voicesServiceOf(ctx).removeVoiceKey('azure'); return undefined; });
      route(router, 'put', '/voice-keys/google-cloud', { body: z.object({ key: z.string().min(10).max(400) }).strict() }, ({ body }) => voicesServiceOf(ctx).setGoogleCloudKey(body.key));
      route(router, 'delete', '/voice-keys/google-cloud', {}, () => { voicesServiceOf(ctx).removeVoiceKey('google-cloud'); return undefined; });
      // FR-249 (R-139): the timed transcript of a voice Asset (JSON, or SubRip with ?format=srt; ?offsetMs= shifts the SRT)
      route(router, 'get', '/projects/:id/assets/:assetId/transcript', { params: z.object({ id: Id, assetId: Id }), query: z.object({ format: z.enum(['json', 'srt']).default('json'), offsetMs: z.coerce.number().int().min(0).max(86_400_000).optional() }) }, ({ params, query, res }) => {
        requireProject(ctx, params.id);
        const t = svc.transcriptOf(params.assetId, params.id);
        if (!t) throw em('EM-9003', 'Not found.');
        if (query.format === 'srt') { res.setHeader('Content-Type', 'application/x-subrip; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="voice.srt"'); res.status(200).send(transcriptToSrt(t.cues, query.offsetMs ?? 0)); return undefined; }
        return t;
      });
      // FR-247 (R-219 … R-222): the CC0 music library
      route(router, 'get', '/music-library', { query: z.object({ mood: z.enum(MUSIC_MOODS).optional(), q: z.string().max(200).optional() }) }, ({ query }) => ({ items: musicLibraryOf(ctx).list({ ...(query.mood ? { mood: query.mood } : {}), ...(query.q ? { q: query.q } : {}) }), moods: MUSIC_MOODS }));
      route(router, 'post', '/music-library/:trackId/download', { params: z.object({ trackId: z.string().max(80) }), status: 202 }, ({ params }) => {
        const lib = musicLibraryOf(ctx); lib.require(params.trackId);
        void lib.download(params.trackId).catch(() => undefined);                 // progress and the result arrive as service.notice {kind: 'music-library'}
        return lib.dto(lib.require(params.trackId));
      });
      route(router, 'get', '/music-library/:trackId/audio', { params: z.object({ trackId: z.string().max(80) }) }, async ({ params, req, res }) => { await sendFile(req, res, await musicLibraryOf(ctx).readyFile(params.trackId)); });
      route(router, 'post', '/projects/:id/music-library/:trackId/insert', { params: z.object({ id: Id, trackId: z.string().max(80) }) }, async ({ params }) => {
        requireProject(ctx, params.id);
        const { assetId } = await svc.importLibraryTrack(params.id, params.trackId);
        const versionId = ctx.hooks.applyOps(params.id, [musicBedOp(assetId)], { kind: 'generator', ref: params.trackId, summary: 'Inserted library music' });
        return { assetId, versionId };
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
      route(router, 'post', '/generator-jobs/:jobId/insert', { params: z.object({ jobId: Id }), body: z.object({ pages: z.array(z.record(z.string(), z.unknown())).max(5000).optional(), assetId: Id.optional(), atMs: z.number().int().min(0).optional() }).strict().default({}) }, ({ params, body }) => {   // R-134
        const r = svc.insertResult(params.jobId, { ...(body.pages ? { pages: body.pages } : {}), ...(body.assetId ? { assetId: body.assetId } : {}), ...(body.atMs !== undefined ? { atMs: body.atMs } : {}) }); if (!r) throw em('EM-9003', 'Not found.'); return r;
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
      // FR-285 … FR-289 (Reels pipeline, ADR-039): the stored analysis, rotation confirmation, contact sheet and cover still
      route(router, 'get', '/projects/:id/footage-analysis', { params: z.object({ id: Id }) }, ({ params }) => {   // R-145
        requireProject(ctx, params.id);
        const a = latestAnalysis(ctx, params.id); if (!a) throw em('EM-9003', 'Not found.'); return a;
      });
      route(router, 'post', '/projects/:id/footage-prep/:jobId/continue', { params: z.object({ id: Id, jobId: Id }), body: z.object({ rotation: Rotation }).strict(), status: 202 }, ({ params, body }) => {   // R-148
        requireProject(ctx, params.id);
        return svc.continuePrep(params.id, params.jobId, body.rotation);
      });
      route(router, 'get', '/projects/:id/footage-prep/:jobId/thumbs/:deg', { params: z.object({ id: Id, jobId: Id, deg: z.enum(['0', '90', '180', '270']) }) }, async ({ params, req, res }) => {   // R-154
        requireProject(ctx, params.id);
        const r = svc.get(params.jobId); if (!r || r.project_id !== params.id) throw em('EM-9003', 'Not found.');
        const file = path.join(prepDir(ctx, params.jobId), `rot-${params.deg}.jpg`);
        if (!fs.existsSync(file)) throw em('EM-9003', 'Not found.');
        await sendFile(req, res, file, { 'Cache-Control': 'private, max-age=3600' });
      });
      // R-149: `cutIds=a,b` → one frame per cut (its middle); `atMs=<ms>&count=<n>` → the middles of the first n cuts from that time on
      // (evenly spaced frames without cuts); `atMs=a,b,c` → exactly those times. Grid: ceil(sqrt(n)) columns, row-major; cells in the header.
      const Frames = z.object({ atMs: z.array(z.number().int().min(0)).max(12).optional(), cutIds: z.array(z.string().max(64)).max(12).optional(), count: z.number().int().min(1).max(12).optional(), rotation: Rotation.optional() });
      route(router, 'get', '/projects/:id/footage-analysis/frames', { params: z.object({ id: Id }), query: z.object({ atMs: z.string().max(400).optional(), cutIds: z.string().max(800).optional(), count: z.coerce.number().optional(), rotation: z.coerce.number().optional() }) }, async ({ params, query, req, res }) => {   // R-149
        requireProject(ctx, params.id);
        const atMs = query.atMs ? query.atMs.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0) : undefined;
        const cutIds = query.cutIds ? query.cutIds.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
        const q = parseOrThrow(Frames, { ...(atMs?.length ? { atMs } : {}), ...(cutIds?.length ? { cutIds } : {}), ...(query.count !== undefined ? { count: query.count } : {}), ...(query.rotation !== undefined ? { rotation: query.rotation } : {}) }, 'query');
        const a = latestAnalysis(ctx, params.id);
        const times = q.count !== undefined || (q.atMs?.length === 1 && !q.cutIds) ? frameTimes(a, { count: q.count ?? 1, fromMs: q.atMs?.[0] ?? 0 }) : frameTimes(a, { ...(q.atMs ? { atMs: q.atMs } : {}), ...(q.cutIds ? { cutIds: q.cutIds } : {}) });
        if (!times.length) throw em('EM-9002', 'Invalid request: atMs, count or cutIds is required.', { status: 400, path: 'query.atMs' });
        const sheet = await contactSheet(ctx, params.id, { atMs: times, ...(q.rotation !== undefined ? { rotation: q.rotation } : {}), heavy: (fn) => s2(ctx).heavy.run(fn) });
        try { res.setHeader('X-Expertmotion-Cells', JSON.stringify({ cols: sheet.cols, rows: sheet.rows, cells: sheet.cells })); await sendFile(req, res, sheet.file); } finally { fs.rmSync(sheet.dir, { recursive: true, force: true }); }
      });
      route(router, 'post', '/projects/:id/cover', { params: z.object({ id: Id }), body: CoverBody }, async ({ params, body }) => {   // R-153
        requireProject(ctx, params.id);
        return renderCover(ctx, params.id, body);
      });
    },
  };
}
export const generatorsModule: ServiceModule = createGeneratorsModule();
