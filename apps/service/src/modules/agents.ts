// Agents module: R-080…R-085 (per-project conversations for the Brainstorming and Editor Agents, messages, runs with cancel).
// Brainstorm replies come from runBrainstorm; editor messages go through ctx.hooks.createPlan (intents module owns plans).
// R-082 turns proposed intents into EditIntent objects (createIntents) and hands them to the intents module via the optional
// `enqueueIntents` hook; without it the payload is stored in brainstorm_handoffs for the intents module to pick up.
import fs from 'node:fs';
import path from 'node:path';
import type { Router } from 'express';
import { z } from 'zod';
import { EmError, errorMessage, normalizeMessageBlocks, stripToolMarkup } from '@expertmotion/shared';
import { ElementRef, hashModel, summarizeForAgent, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import { BrainstormTurn, createIntents, resolvePointedTargets, runBrainstorm, type PointedTarget, type RunProgress, type ChatImage, type ChatMessage, type ChatUsage, type DesignPick, type EditIntentT, type IntentCategory, type ToolHandlers } from '@expertmotion/agents';
import { availableOnTier, searchPresets, type Category } from '@expertmotion/catalogue';
const SEARCH_CATEGORIES: readonly Category[] = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio', 'text', 'texteffect', 'font', 'palette', 'fontpair'];
import { renderServiceOf } from '../s2/render-service.js';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { Agent, emit, Id, ProjectParams, requireProject, type AgentT } from '../s3/dto.js';
import { cachedModels, runUsage } from '../s3/usage-store.js';
import { s3, track } from '../s3/state.js';
import { getAssignment } from './providers.js';
import { recentEditsFor } from '../s3/shared-context.js';
import { keyIsRecent } from '../s3/keys.js';

/** Hook the intents module is asked to install (see report): enqueue already-validated intents, return the IntentQueueDto. */
export interface HandoffHooks { enqueueIntents(projectId: string, intents: EditIntentT[]): { queue: unknown } }

type Proposal = NonNullable<z.infer<typeof BrainstormTurn>['proposedIntents']>[number] & { id: string };
type Block = { type: 'text'; text: string } | { type: 'tool_call'; name: string; input: unknown } | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'proposed_intents'; intents: Proposal[]; handoffState: 'pending' | 'sent' | 'dismissed' }
  /** `sent`: FR-213 — `image` = the picture went to the model; `name` = the model cannot read images, only the file name was sent. */
  | { type: 'attachment'; assetId?: string; mime: string; name: string; sent?: 'image' | 'name' }
  | { type: 'targets'; items: PointedTarget[] };
interface MsgRow { id: string; conversation_id: string; role: 'user' | 'assistant' | 'system' | 'tool'; blocks_json: string; agent_run_id: string | null; created_at: string }
interface RunRow { id: string; project_id: string; agent: AgentT; connection_id: string | null; model_id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; error_code: string | null; started_at: string; finished_at: string | null; plan_id: string | null }

/** FR-212: blocks as stored, made safe to read (a proposal stored without `params` by an older build crashed the chat on every open). */
const blocksOf = (json: string): Block[] => normalizeMessageBlocks(json) as Block[];
const msgDto = (m: MsgRow) => ({ id: m.id, role: m.role, blocks: blocksOf(m.blocks_json), agentRunId: m.agent_run_id, createdAt: m.created_at });
const contextLengthOf = (ctx: ServiceContext, connId: string | null, modelId: string): number | null => (connId ? cachedModels(ctx, connId)?.find((m) => m.modelId === modelId)?.contextLength ?? null : null);

function runDto(ctx: ServiceContext, r: RunRow) {
  const u = runUsage(ctx, r.id);
  return { id: r.id, projectId: r.project_id, agent: r.agent, status: r.status, modelId: r.model_id, connectionId: r.connection_id, planId: r.plan_id, errorCode: r.error_code,
    usage: u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUsd, approximate: u.approximate, contextLength: contextLengthOf(ctx, r.connection_id, r.model_id) } : null,
    startedAt: r.started_at, finishedAt: r.finished_at };
}
const getRun = (ctx: ServiceContext, id: string): RunRow | undefined => ctx.db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as RunRow | undefined;

function conversationId(ctx: ServiceContext, projectId: string, agent: AgentT): string {
  const r = ctx.db.prepare('SELECT id FROM conversations WHERE project_id = ? AND agent = ?').get(projectId, agent) as { id: string } | undefined;
  if (r) return r.id;
  const id = ctx.newId(); const now = ctx.now();
  ctx.db.prepare('INSERT INTO conversations(id, project_id, agent, created_at, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(project_id, agent) DO NOTHING').run(id, projectId, agent, now, now);
  return (ctx.db.prepare('SELECT id FROM conversations WHERE project_id = ? AND agent = ?').get(projectId, agent) as { id: string }).id;
}
function insertMessage(ctx: ServiceContext, convId: string, role: MsgRow['role'], blocks: Block[], runId: string | null): MsgRow {
  const row: MsgRow = { id: ctx.newId(), conversation_id: convId, role, blocks_json: JSON.stringify(blocks), agent_run_id: runId, created_at: ctx.now() };
  ctx.db.prepare('INSERT INTO messages(id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,?,?,?,?)').run(row.id, row.conversation_id, row.role, row.blocks_json, row.agent_run_id, row.created_at);
  ctx.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(row.created_at, convId);
  return row;
}
const activeRun = (ctx: ServiceContext, projectId: string, agent: AgentT): boolean =>
  [...s3(ctx).runs.values()].some((r) => r.projectId === projectId && r.agent === agent) || !!ctx.db.prepare("SELECT 1 FROM agent_runs WHERE project_id = ? AND agent = ? AND status = 'running'").get(projectId, agent);

function contextUsage(ctx: ServiceContext, projectId: string, agent: AgentT) {
  const last = ctx.db.prepare('SELECT u.input_tokens i, u.output_tokens o, r.connection_id c, r.model_id m FROM usage_records u JOIN agent_runs r ON r.id = u.agent_run_id WHERE u.project_id = ? AND r.agent = ? ORDER BY u.id DESC LIMIT 1').get(projectId, agent) as { i: number; o: number; c: string | null; m: string } | undefined;
  return last ? { usedTokens: last.i + last.o, contextLength: contextLengthOf(ctx, last.c, last.m) } : null;
}

/** Ends a run exactly once (a cancel and a late provider answer never both write). Returns false when it was already finished. */
function finishRun(ctx: ServiceContext, runId: string, status: 'done' | 'failed' | 'cancelled', code: string | null, planId?: string): boolean {
  const r = ctx.db.prepare("UPDATE agent_runs SET status = ?, error_code = ?, finished_at = ?, plan_id = COALESCE(?, plan_id) WHERE id = ? AND status = 'running'").run(status, code, ctx.now(), planId ?? null, runId);
  s3(ctx).runs.delete(runId);
  return r.changes > 0;
}
/** FR-190: what the chat shows and the log keeps for a failure: the reason, HTTP status / provider reason, and for EM-4002 whether the key is new. */
function failureDetails(ctx: ServiceContext, run: RunRow, em: EmError): Record<string, unknown> {
  const d = (em.details ?? {}) as Record<string, unknown>;
  return { ...(typeof d['status'] === 'number' ? { providerStatus: d['status'] } : {}), ...(typeof d['reason'] === 'string' ? { reason: d['reason'] } : {}),
    ...(em.code === 'EM-4002' ? { recentKey: keyIsRecent(ctx, run.connection_id) } : {}), ...(Array.isArray(d['lastIssues']) ? { lastIssues: d['lastIssues'] } : {}), ...(d['daily'] === true ? { daily: true } : {}), ...(typeof d['retries'] === 'number' ? { retries: d['retries'] } : {}) };
}
/** FR-190: one log line per agent run outcome (never prompt text, Creator text or keys). The Editor's plan details come from S1. */
export function logAgentRun(ctx: ServiceContext, run: RunRow, x: { status: 'done' | 'failed'; code?: string; details?: Record<string, unknown>; extra?: Record<string, unknown> }) {
  const line = { agent: run.agent, mode: run.agent === 'brainstorm' ? 'diskusi' : 'edit', projectId: run.project_id, runId: run.id, connectionId: run.connection_id, model: run.model_id,
    durationMs: Date.now() - Date.parse(run.started_at), status: x.status, ...(x.code ? { code: x.code } : {}), ...(x.details ?? {}), ...(x.extra ?? {}) };
  if (x.status === 'failed') ctx.log.warn(line, 'agent run failed'); else ctx.log.info(line, 'agent run');
}
function failRun(ctx: ServiceContext, run: RunRow, convId: string, e: unknown) {
  const em = e instanceof EmError ? e : new EmError('EM-9001', 'Something went wrong.');
  if (!(e instanceof EmError)) ctx.log.error({ runId: run.id, err: errorMessage(e) }, 'agent run crashed');
  if (!finishRun(ctx, run.id, 'failed', em.code)) return;
  const details = failureDetails(ctx, run, em);
  logAgentRun(ctx, run, { status: 'failed', code: em.code, details });
  const hint = em.code === 'EM-4002' && details['recentKey'] ? ' New keys can take 1–2 minutes to become active.' : '';
  insertMessage(ctx, convId, 'system', [{ type: 'text', text: `${em.code}: ${em.message}${hint}` }], run.id);
  emit(ctx, 'agent.run.failed', { projectId: run.project_id, runId: run.id, agent: run.agent, code: em.code, message: `${em.message}${hint}`, details,
    retryable: ['EM-4101', 'EM-4102', 'EM-4103', 'EM-4003', 'EM-4301', 'EM-4105'].includes(em.code) || (em.code === 'EM-4002' && details['recentKey'] === true) });
}
const progressEmitter = (ctx: ServiceContext, projectId: string, runId: string, agent: AgentT) => (p: RunProgress) => emit(ctx, 'agent.run.progress', { projectId, runId, agent, ...p });
function cancelRun(ctx: ServiceContext, runId: string, code: 'EM-4303' | 'EM-4304' | 'EM-8202'): void {
  const live = s3(ctx).runs.get(runId);
  const row = getRun(ctx, runId);
  live?.controller.abort();
  if (row && finishRun(ctx, runId, 'cancelled', code)) emit(ctx, 'agent.run.failed', { projectId: row.project_id, runId, agent: row.agent, code, retryable: true });
}

/** Cancels every in-flight run (shutdown, Private Mode). */
export function cancelAllRuns(ctx: ServiceContext, code: 'EM-4303' | 'EM-4304' | 'EM-8202'): number {
  const ids = [...s3(ctx).runs.keys()]; for (const id of ids) cancelRun(ctx, id, code); return ids.length;
}

/** baseVersion is the head hash (S1 convention, API examples); the version id is accepted too. */
function headOf(ctx: ServiceContext, projectId: string): { model: CompositionModelT; versionId: string; hash: string } {
  const h = ctx.hooks.composition(projectId);
  return { ...h, hash: hashModel(h.model) };
}
const matchesBase = (h: { versionId: string; hash: string }, base: string) => base === h.hash || base === h.versionId;

function historyOf(ctx: ServiceContext, convId: string): ChatMessage[] {
  const rows = ctx.db.prepare("SELECT role, blocks_json FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at, id").all(convId) as Array<{ role: 'user' | 'assistant'; blocks_json: string }>;
  return rows.flatMap((r) => {
    // Tool-call markup an older build stored in an answer is not sent back (it taught the model to write more of it).
    const text = blocksOf(r.blocks_json).flatMap((b) => (b.type === 'text' ? [r.role === 'assistant' ? stripToolMarkup(b.text) : b.text] : b.type === 'proposed_intents' ? [`(proposed ${b.intents.length} change(s); ${b.handoffState})`]
      : b.type === 'targets' ? [`(pointed at: ${b.items.map((t) => `@${t.label}`).join(', ')})`]
      : b.type === 'attachment' ? [b.sent === 'name' ? `(attached image "${b.name}" — this model cannot see images, so only the file name was sent; ask the Creator to describe it if needed)` : `(attached ${b.mime.startsWith('image') ? 'image' : 'file'} "${b.name}"${b.assetId ? `, asset id ${b.assetId}` : ''})`] : [])).join('\n');
    return text ? [{ role: r.role, content: text }] : [];
  });
}

export function brainstormContext(ctx: ServiceContext, project: { id: string; name: string; language: 'id' | 'en' }, targets: PointedTarget[] = []) {
  let composition: unknown = null; let pointed: unknown[] = [];
  try {
    const head = ctx.hooks.composition(project.id); const facts = ctx.hooks.assetFacts(project.id);
    composition = summarizeForAgent(head.model, facts, 2000);
    if (targets.length) pointed = resolvePointedTargets(targets, head.model, facts);
  } catch { /* no head yet */ }
  // AI_WORKFLOW §10.1: what the Editor changed in the same project chat (plan goals, applied / undone), token-budgeted.
  const recentEdits = recentEditsFor(ctx, project.id);
  // QA 2026-10-26 #2: the asset list is always in CONTEXT (an empty list means "build from scenes", never "upload first").
  const assets = (() => { try { return ctx.hooks.assetFacts(project.id).filter((a) => a.status === 'ready').slice(0, 40).map((a) => ({ id: a.id, kind: a.kind, name: a.name ?? a.id, ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}) })); } catch { return []; } })();
  return { project: { name: project.name, language: project.language }, tier: ctx.hooks.tier(), composition, assets, ...(pointed.length ? { targets: pointed } : {}), ...(recentEdits ? { recentEdits } : {}) };
}

/**
 * FR-075 / AI_WORKFLOW §9: the Brainstorming Agent's read-only tools. Every handler only reads (no composition mutation, no
 * render start, no egress); results are compact so they fit the context window.
 */
export function brainstormTools(ctx: ServiceContext, projectId: string, language: 'id' | 'en'): ToolHandlers {
  return {
    'composition.get': () => { try { const h = ctx.hooks.composition(projectId); return summarizeForAgent(h.model, ctx.hooks.assetFacts(projectId), 2000); } catch { return null; } },
    'assets.list': () => ctx.hooks.assetFacts(projectId).filter((a) => a.status === 'ready').slice(0, 100)
      .map((a) => ({ id: a.id, kind: a.kind, name: a.name ?? a.id, ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}), ...(a.width ? { width: a.width, height: a.height } : {}), ...(a.hasAudio !== undefined ? { hasAudio: a.hasAudio } : {}) })),
    'assets.probe': (i) => {
      const r = ctx.db.prepare('SELECT id, kind, duration_ms, width, height, fps, has_audio, probe_json FROM assets WHERE id = ? AND project_id = ?').get(String(i['assetId']), projectId) as { id: string; kind: string; duration_ms: number | null; width: number | null; height: number | null; fps: number | null; has_audio: number | null; probe_json: string | null } | undefined;
      if (!r) return { error: { code: 'EM-1301', message: 'No asset with that id in this project.' } };
      let streams: Array<Record<string, unknown>> = [];
      try {
        const j = r.probe_json ? JSON.parse(r.probe_json) as { streams?: Array<Record<string, unknown>> } : {};
        streams = (j.streams ?? []).slice(0, 4).map((st) => ({ type: st['codec_type'], codec: st['codec_name'], ...(st['channels'] !== undefined ? { channels: st['channels'], sampleRate: st['sample_rate'] } : {}), ...(st['width'] !== undefined ? { width: st['width'], height: st['height'], frameRate: st['avg_frame_rate'] } : {}) }));
      } catch { /* probe unreadable: facts only */ }
      return { id: r.id, kind: r.kind, durationMs: r.duration_ms, width: r.width, height: r.height, fps: r.fps, hasAudio: r.has_audio === null ? null : r.has_audio === 1, streams };
    },
    'catalogue.search': (i) => {
      const tier = ctx.hooks.tier();
      // Live QA 2026-10-26: free models ask for "backgrounds" / "Transitions"; a plural or case slip names the same category,
      // anything else searches every category (an empty result made the model call the tool again and again).
      const raw = typeof i['category'] === 'string' ? i['category'].trim().toLowerCase() : '';
      const cat = (SEARCH_CATEGORIES as readonly string[]).find((c) => c === raw || `${c}s` === raw || (c === 'text' && raw === 'texts') || (c === 'texteffect' && raw === 'text-effects')) as Category | undefined;
      return searchPresets(String(i['query'] ?? ''), language, cat).filter((p) => p.priority !== 'p2' && availableOnTier(p, tier)).slice(0, 20)
        .map((p) => ({ id: p.id, category: p.category, label: p.label[language], tags: p.tags.slice(0, 6), ...(p.flags.includes('gpu') && tier === 'T0' ? { slowWithoutGpu: true } : {}) }));
    },
    'hardware.profile': () => {
      const r = ctx.db.prepare('SELECT tier, cpu_threads, ram_total_mb, gpu_model, vram_mb FROM hardware_profiles WHERE is_current = 1').get() as { tier: string; cpu_threads: number | null; ram_total_mb: number | null; gpu_model: string | null; vram_mb: number | null } | undefined;
      return r ? { tier: r.tier, cpuThreads: r.cpu_threads, ramTotalMb: r.ram_total_mb, gpuModel: r.gpu_model, vramMb: r.vram_mb } : { tier: ctx.hooks.tier() };
    },
    'project.settings.get': () => { try { return ctx.hooks.composition(projectId).model.settings; } catch { return null; } },
    'render.estimate': async (i) => {
      const s = ctx.hooks.composition(projectId).model.settings;
      const prep = await renderServiceOf(ctx).prepare({ projectId, performanceProfile: (i['performanceProfile'] as 'standard' | 'accelerated' | 'turbo' | undefined) ?? 'standard',
        outputProfile: { ratio: s.ratio, ...(s.customRatio ? { customRatio: s.customRatio } : {}), resolution: (i['resolution'] as typeof s.resolution | undefined) ?? s.resolution, fps: s.fps, format: 'mp4', codec: 'h264', crf: 18, alpha: false } });
      return { seconds: prep.estimate.seconds, bytes: prep.estimate.bytes, confidence: prep.estimate.confidence, dimensions: prep.dims, warnings: prep.warnings.map((w) => w.code) };
    },
  };
}

/** Streamed deltas are coalesced (≥ 40 chars or 80 ms) so a fast provider cannot flood the SSE stream. */
export function deltaEmitter(ctx: ServiceContext, projectId: string, runId: string, agent: AgentT) {
  let buf = ''; let timer: NodeJS.Timeout | null = null;
  const flush = () => { if (timer) { clearTimeout(timer); timer = null; } if (buf) { const delta = buf; buf = ''; emit(ctx, 'agent.run.delta', { projectId, runId, agent, delta }); } };
  return { push(d: string) { buf += d; if (buf.length >= 40) flush(); else if (!timer) timer = setTimeout(flush, 80); }, flush };
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** FR-072: an attached image Asset as an image part (base64 of the stored original, ≤ 10 MB, PNG/JPEG/WebP/GIF). */
function imagePart(ctx: ServiceContext, projectId: string, assetId: string): ChatImage {
  const r = ctx.db.prepare('SELECT name, original_path, bytes FROM assets WHERE id = ? AND project_id = ?').get(assetId, projectId) as { name: string; original_path: string; bytes: number } | undefined;
  if (!r) throw new EmError('EM-9003', 'An attached asset no longer exists.', { path: 'body.attachments' });
  const mediaType = IMAGE_MIME[path.extname(r.original_path || r.name).toLowerCase()];
  if (!mediaType) throw new EmError('EM-1002', `This file is ${r.name}; the limit is PNG/JPEG/WebP.`, { status: 422, path: 'body.attachments', details: { fileName: r.name, bytes: r.bytes, limitBytes: MAX_IMAGE_BYTES } });
  if (r.bytes > MAX_IMAGE_BYTES) throw new EmError('EM-1002', `This file is ${(r.bytes / 1048576).toFixed(1)} MB; the limit is 10 MB.`, { status: 422, path: 'body.attachments', details: { fileName: r.name, bytes: r.bytes, limitBytes: MAX_IMAGE_BYTES } });
  let data: Buffer;
  try { data = fs.readFileSync(path.resolve(ctx.paths.media, r.original_path)); } catch { throw new EmError('EM-9003', 'An attached image is missing on disk.', { path: 'body.attachments' }); }
  if (data.length > MAX_IMAGE_BYTES) throw new EmError('EM-1002', `This file is ${(data.length / 1048576).toFixed(1)} MB; the limit is 10 MB.`, { status: 422, path: 'body.attachments', details: { fileName: r.name, bytes: data.length, limitBytes: MAX_IMAGE_BYTES } });
  return { mediaType, data: data.toString('base64'), name: r.name };
}

/** FR-213: how long a send waits for a just-uploaded attachment to finish importing before it answers EM-4308. */
export const ATTACHMENT_READY_WAIT_MS = 20_000;
type AttRow = { id: string; name: string; kind: string; status: string; error_code: string | null };
/** The attached assets once they are ready: missing → EM-9003, failed import → its code, still importing after the wait → EM-4308. */
async function waitForAttachments(ctx: ServiceContext, projectId: string, ids: readonly string[], waitMs = ATTACHMENT_READY_WAIT_MS): Promise<AttRow[]> {
  const read = () => ids.map((id) => ctx.db.prepare('SELECT id, name, kind, status, error_code FROM assets WHERE id = ? AND project_id = ?').get(id, projectId) as AttRow | undefined);
  const until = Date.now() + waitMs;
  for (;;) {
    const rows = read();
    if (rows.some((r) => !r)) throw new EmError('EM-9003', 'An attached asset no longer exists.', { path: 'body.attachments' });
    const failed = rows.find((r) => r!.status === 'failed');
    if (failed) throw new EmError((failed.error_code && /^EM-1\d{3}$/.test(failed.error_code) ? failed.error_code : 'EM-1003') as EmError['code'], `"${failed.name}" could not be imported, so it was not attached.`, { status: 422, path: 'body.attachments', details: { fileName: failed.name } });
    if (rows.every((r) => r!.status === 'ready')) return rows as AttRow[];
    if (Date.now() >= until) throw new EmError('EM-4308', 'The attached image is still being prepared. Send the message again in a moment.', { status: 409, path: 'body.attachments', details: { assetIds: rows.filter((r) => r!.status !== 'ready').map((r) => r!.id) } });
    await new Promise((r) => setTimeout(r, 200));
  }
}
/** A provider refusal that names the image part (model without vision behind an unknown capability). */
const isImageRefusal = (e: unknown): boolean => { const x = e as { code?: unknown; details?: { reason?: unknown } } | undefined; return x?.code === 'EM-4105' && /image|vision|multimodal|media[_ ]?type|inline_?data|image_url/i.test(String(x?.details?.reason ?? '')); };
/** FR-213: after such a refusal the stored user message says the image was sent as its name only, and the cached row learns imageInput false. */
function markImagesNotRead(ctx: ServiceContext, runId: string, connectionId: string | null, modelId: string) {
  try {
    const m = ctx.db.prepare("SELECT id, blocks_json FROM messages WHERE agent_run_id = ? AND role = 'user'").get(runId) as { id: string; blocks_json: string } | undefined;
    if (m) ctx.db.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run(JSON.stringify(blocksOf(m.blocks_json).map((b) => (b.type === 'attachment' && b.sent === 'image' ? { ...b, sent: 'name' } : b))), m.id);
    if (connectionId) {
      const r = ctx.db.prepare('SELECT models_json FROM provider_connections WHERE id = ?').get(connectionId) as { models_json: string | null } | undefined;
      const rows = r?.models_json ? JSON.parse(r.models_json) as Array<{ modelId: string; imageInput: boolean | null }> : null;
      if (rows?.some((x) => x.modelId === modelId)) ctx.db.prepare('UPDATE provider_connections SET models_json = ? WHERE id = ?').run(JSON.stringify(rows.map((x) => (x.modelId === modelId ? { ...x, imageInput: false } : x))), connectionId);
    }
  } catch (e) { ctx.log.warn({ runId, err: errorMessage(e) }, 'image fallback not recorded'); }
}

async function executeBrainstorm(ctx: ServiceContext, run: RunRow, convId: string, project: { id: string; name: string; language: 'id' | 'en' }, signal: AbortSignal, images: ChatImage[] = [], targets: PointedTarget[] = []) {
  const provider = ctx.hooks.providerFor('brainstorm', project.id);
  const deltas = deltaEmitter(ctx, project.id, run.id, 'brainstorm');
  const progress = progressEmitter(ctx, project.id, run.id, 'brainstorm');
  progress({ phase: 'reading' });
  const ask = (imgs: ChatImage[]) => runBrainstorm(historyOf(ctx, convId), brainstormContext(ctx, project, targets), project.language, provider, {
    signal, budgetCheck: () => ctx.hooks.budgetCheck(project.id), contextLength: contextLengthOf(ctx, run.connection_id, run.model_id),
    tools: brainstormTools(ctx, project.id, project.language), onDelta: (d) => { if (!signal.aborted) deltas.push(d); }, ...(imgs.length ? { images: imgs } : {}), onProgress: progress,
  });
  let r = await ask(images);
  if (!r.ok && images.length && isImageRefusal(r.error) && !signal.aborted) {      // FR-213: the model refused the picture → names only
    record(ctx, project.id, 'brainstorm', run.id, r.usage);
    markImagesNotRead(ctx, run.id, run.connection_id, run.model_id);
    r = await ask([]);
  }
  deltas.flush();
  record(ctx, project.id, 'brainstorm', run.id, r.usage);
  if (signal.aborted) return;
  if (!r.ok) return failRun(ctx, run, convId, r.error);
  if (r.summary) ctx.db.prepare('UPDATE conversations SET summary_json = ? WHERE id = ?').run(JSON.stringify(r.summary), convId);
  const blocks: Block[] = r.toolCalls.map((c): Block => ({ type: 'tool_result', name: c.name, output: { ok: c.ok, input: c.input, ...(c.ok ? {} : { output: c.output }) } }));
  blocks.push({ type: 'text', text: r.turn.reply });
  if (r.turn.questions?.length) blocks.push({ type: 'text', text: r.turn.questions.join('\n') });
  if (r.turn.proposedIntents?.length) blocks.push({ type: 'proposed_intents', intents: r.turn.proposedIntents.map((p) => ({ ...p, id: ctx.newId() })), handoffState: 'pending' });
  const msg = insertMessage(ctx, convId, 'assistant', blocks, run.id);
  if (!finishRun(ctx, run.id, 'done', null)) return;
  logAgentRun(ctx, run, { status: 'done', extra: { provider: provider.id, toolCalls: r.toolCalls.length, proposals: r.turn.proposedIntents?.length ?? 0, questions: r.turn.questions?.length ?? 0, targets: targets.length } });
  const done = getRun(ctx, run.id)!;
  emit(ctx, 'agent.run.done', { projectId: project.id, run: runDto(ctx, done), message: msgDto(msg), usage: runDto(ctx, done).usage, contextUsage: contextUsage(ctx, project.id, 'brainstorm') });
}

/** FR-080: the intents module enqueues the message as a chat Edit Intent once the run can start; the Editor Agent plans every queued intent with it. */
interface EditorTurn { messageId: string; text: string; target?: ElementRefT | undefined; selection?: ElementRefT[] | undefined; playheadMs?: number | undefined; images: ChatImage[]; attachments: string[]; targets: PointedTarget[] }
async function executeEditor(ctx: ServiceContext, run: RunRow, convId: string, projectId: string, turn: EditorTurn, signal: AbortSignal) {
  const deltas = deltaEmitter(ctx, projectId, run.id, 'editor');
  const ask = (images: ChatImage[]) => ctx.hooks.createPlan(projectId, { instruction: turn.text, mode: 'agent', signal, runId: run.id, chat: { messageId: turn.messageId, ...(turn.target ? { target: turn.target } : {}) },
    ...(turn.selection?.length || turn.target ? { selection: turn.target ? [turn.target, ...(turn.selection ?? [])] : turn.selection! } : {}), ...(turn.playheadMs !== undefined ? { playheadMs: turn.playheadMs } : {}),
    ...(turn.attachments.length ? { attachments: turn.attachments } : {}), ...(images.length ? { images } : {}), onDelta: (d) => { if (!signal.aborted) deltas.push(d); },
    ...(turn.targets.length ? { targets: turn.targets } : {}), onProgress: progressEmitter(ctx, projectId, run.id, 'editor') }) as Promise<Awaited<ReturnType<ServiceContext['hooks']['createPlan']>> & { runId?: string }>;
  let plan = await ask(turn.images);
  const refused = plan.validation?.[0];
  if (turn.images.length && plan.steps.length === 0 && refused?.code === 'EM-4105' && /image|vision|multimodal|media[_ ]?type|inline_?data|image_url/i.test(refused.message ?? '') && !signal.aborted) {
    markImagesNotRead(ctx, run.id, run.connection_id, run.model_id);                // FR-213: the model refused the picture → names only
    plan = await ask([]);
  }
  deltas.flush();
  // Usage is recorded by the intents module under this run (FR-074); only a module without a run id leaves it to us.
  if (plan.usage && !plan.runId) record(ctx, projectId, 'editor', run.id, [plan.usage]);
  if (signal.aborted) return;
  // QA 2026-10-26 #5: a run that produced no plan (provider error, EM-4301, …) is a failure with its reason and next action in the
  // chat — never the Creator's own message echoed back as the "reply" with an empty Plan Card.
  if ((plan.status === 'failed' || plan.status === 'invalid' || plan.status === 'stale') && plan.steps.length === 0) {
    const v = plan.validation?.[0];
    const code = (v?.code && /^EM-\d{4}$/.test(v.code) ? v.code : 'EM-4301') as EmError['code'];
    ctx.db.prepare('UPDATE agent_runs SET plan_id = COALESCE(plan_id, ?) WHERE id = ?').run(plan.planId, run.id);
    return failRun(ctx, run, convId, new EmError(code, v?.message ?? 'The model could not produce a valid plan.'));
  }
  const msg = insertMessage(ctx, convId, 'assistant', [{ type: 'text', text: plan.goal }, { type: 'tool_result', name: 'plan', output: { planId: plan.planId, planRunId: plan.runId ?? null, status: plan.status, steps: plan.steps.length, risks: plan.risks } }], run.id);
  if (!finishRun(ctx, run.id, 'done', null, plan.planId)) return;
  logAgentRun(ctx, run, { status: 'done', extra: { planId: plan.planId, planStatus: plan.status, steps: plan.steps.length } });
  const done = getRun(ctx, run.id)!;
  emit(ctx, 'agent.run.done', { projectId, run: runDto(ctx, done), message: msgDto(msg), usage: runDto(ctx, done).usage, contextUsage: contextUsage(ctx, projectId, 'editor'), planId: plan.planId });
}

function record(ctx: ServiceContext, projectId: string, agent: AgentT, runId: string, usage: ChatUsage[]) {
  try { ctx.hooks.recordUsage(projectId, agent, runId, usage); } catch (e) { ctx.log.warn({ runId, code: (e as EmError).code ?? 'EM-9001' }, 'usage not recorded'); }
}

const AgentParams = z.object({ id: Id, agent: Agent });
const SendBody = z.object({ text: z.string().min(1).max(8000), attachments: z.array(z.object({ assetId: Id })).max(4).default([]), intentIds: z.array(Id).max(100).optional(), baseVersion: z.string().min(1).max(128),
  /** FR-067: the element "Ask Editor Agent" referenced; FR-080: the Timeline selection and playhead at send time (Editor only). */
  target: ElementRef.optional(), selection: z.array(ElementRef).max(50).optional(), playheadMs: z.number().int().min(0).max(36_000_000).optional(),
  /** FR-189: what the Creator pointed at (composer chips): explicit targets with a friendly label, both modes. */
  targets: z.array(z.object({ kind: z.enum(['asset', 'clip', 'text', 'image', 'shape', 'audio', 'cut']), id: z.string().min(1).max(64).optional(), index: z.number().int().min(0).optional(), label: z.string().trim().min(1).max(80) }).strict()).max(12).default([]) }).strict();
const HandoffBody = z.object({ messageId: Id, intentIds: z.array(Id).max(12).optional(), baseVersion: z.string().min(1).max(128) }).strict();

export const agentsModule: ServiceModule = {
  name: 'agents',
  start(ctx) {
    // Service restart during a run → cancelled with EM-4304 (AI_WORKFLOW §12).
    const n = ctx.db.prepare("UPDATE agent_runs SET status = 'cancelled', error_code = 'EM-4304', finished_at = ? WHERE status = 'running'").run(ctx.now()).changes;
    if (n) ctx.log.info({ interrupted: n }, 'agent runs marked interrupted');
    ctx.settings.onChange((s, keys) => { if (keys.includes('privateMode') && s.privateMode) cancelAllRuns(ctx, 'EM-8202'); });
  },
  async stop(ctx) {
    cancelAllRuns(ctx, 'EM-4304');
    await Promise.allSettled([...s3(ctx).background]);
  },
  register(router: Router, ctx) {
    route(router, 'get', '/projects/:id/conversations/:agent', { params: AgentParams, query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), cursor: Id.optional() }) }, ({ params, query }) => {
      requireProject(ctx, params.id);
      const convId = conversationId(ctx, params.id, params.agent);
      const conv = ctx.db.prepare('SELECT summary_json FROM conversations WHERE id = ?').get(convId) as { summary_json: string | null };
      const rows = (query.cursor
        ? ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND id < ? ORDER BY id DESC LIMIT ?').all(convId, query.cursor, query.limit + 1)
        : ctx.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?').all(convId, query.limit + 1)) as MsgRow[];
      const more = rows.length > query.limit; const page = rows.slice(0, query.limit).reverse();
      const total = (ctx.db.prepare('SELECT count(*) n FROM messages WHERE conversation_id = ?').get(convId) as { n: number }).n;
      return { conversationId: convId, agent: params.agent, summary: conv.summary_json ? JSON.parse(conv.summary_json) : null, assignment: getAssignment(ctx, params.agent),
        contextUsage: contextUsage(ctx, params.id, params.agent), messages: { items: page.map(msgDto), nextCursor: more && page[0] ? page[0].id : null, total } };
    });

    route(router, 'post', '/projects/:id/conversations/:agent/messages', { params: AgentParams, body: SendBody, status: 202 }, async ({ params, body }) => {
      const project = requireProject(ctx, params.id);
      const agent = params.agent;
      if (ctx.egress.isPrivate()) throw new EmError('EM-4401', 'Private Mode blocks all internet use, so the agents are unavailable.');
      if (activeRun(ctx, project.id, agent)) throw new EmError('EM-4305', 'Wait for the current answer to finish, or cancel it, before sending another message.', { status: 409 });
      const provider = ctx.hooks.providerFor(agent, project.id);
      ctx.hooks.budgetCheck(project.id);
      const a = getAssignment(ctx, agent);
      const cap = a ? cachedModels(ctx, a.connectionId)?.find((m) => m.modelId === a.modelId) : undefined;
      if (cap?.contextLength && Math.ceil(body.text.length / 4) > 0.6 * cap.contextLength) throw new EmError('EM-4306', `This message does not fit the model's memory (${cap.contextLength} tokens). Shorten it or start a new chat.`, { status: 422 });
      // FR-072 / FR-213: an attached image must be imported (ready) first; the composer uploads it, so the route waits briefly for
      // ingest. It goes to the model as an image part unless the Capability Table says the model cannot read images (imageInput
      // false): then only the file name is sent and the chat says so. Unknown (null) is tried; a provider that refuses the image
      // part gets the request again with the names only (executeBrainstorm / executeEditor).
      const attRows = await waitForAttachments(ctx, project.id, body.attachments.map((x) => x.assetId));
      if (activeRun(ctx, project.id, agent)) throw new EmError('EM-4305', 'Wait for the current answer to finish, or cancel it, before sending another message.', { status: 409 });
      const sendImages = cap?.imageInput !== false;
      if (agent === 'editor') {
        let head: { versionId: string; hash: string } | null = null;
        try { head = headOf(ctx, project.id); } catch { /* composition module absent: createPlan checks the base */ }
        if (head !== null && !matchesBase(head, body.baseVersion)) throw new EmError('EM-2301', 'The composition changed after this message was written. Send it again.', { status: 409, details: { baseVersion: body.baseVersion, headVersion: head.hash }, path: 'body.baseVersion' });
      }
      const attachments: Block[] = attRows.map((as) => ({ type: 'attachment', assetId: as.id, mime: as.kind === 'image' ? 'image/*' : `${as.kind}/*`, name: as.name, ...(as.kind === 'image' ? { sent: sendImages ? 'image' as const : 'name' as const } : {}) }));
      const images = sendImages ? attRows.filter((a) => a.kind === 'image').map((a) => imagePart(ctx, project.id, a.id)) : [];
      const convId = conversationId(ctx, project.id, agent);
      const runId = ctx.newId(); const now = ctx.now();
      const run: RunRow = { id: runId, project_id: project.id, agent, connection_id: a?.connectionId ?? null, model_id: provider.model, status: 'running', error_code: null, started_at: now, finished_at: null, plan_id: null };
      const msg = ctx.db.transaction(() => {
        ctx.db.prepare("INSERT INTO agent_runs(id, project_id, agent, connection_id, model_id, status, started_at) VALUES (?,?,?,?,?,'running',?)").run(runId, project.id, agent, run.connection_id, run.model_id, now);
        return insertMessage(ctx, convId, 'user', [{ type: 'text', text: body.text }, ...attachments, ...(body.targets.length ? [{ type: 'targets' as const, items: body.targets as PointedTarget[] }] : [])], runId);
      })();
      const controller = new AbortController();
      s3(ctx).runs.set(runId, { controller, projectId: project.id, agent });
      emit(ctx, 'agent.run.started', { projectId: project.id, run: runDto(ctx, run), agent, modelId: run.model_id });
      const names = attachments.flatMap((b) => (b.type === 'attachment' ? [b.name] : []));
      const targets = body.targets as PointedTarget[];
      const work = agent === 'brainstorm' ? executeBrainstorm(ctx, run, convId, project, controller.signal, images, targets)
        : executeEditor(ctx, run, convId, project.id, { messageId: msg.id, text: body.text, target: body.target, selection: body.selection, playheadMs: body.playheadMs, images, attachments: names, targets }, controller.signal);
      void track(ctx, work.catch((e: unknown) => { if (!controller.signal.aborted) failRun(ctx, run, convId, e); }));
      return { message: msgDto(msg), runId, planId: null };
    });

    route(router, 'post', '/projects/:id/conversations/brainstorm/handoff', { params: ProjectParams, body: HandoffBody }, ({ params, body }) => {
      const project = requireProject(ctx, params.id);
      const convId = conversationId(ctx, project.id, 'brainstorm');
      const m = ctx.db.prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'").get(body.messageId, convId) as MsgRow | undefined;
      const blocks = m ? blocksOf(m.blocks_json) : [];
      const block = blocks.find((b): b is Extract<Block, { type: 'proposed_intents' }> => b.type === 'proposed_intents');
      if (!m || !block || block.handoffState !== 'pending') throw new EmError('EM-9003', 'These suggestions are no longer available.', { path: 'body.messageId' });
      const head = headOf(ctx, project.id);
      if (!matchesBase(head, body.baseVersion)) throw new EmError('EM-2301', 'The composition changed after these suggestions were made. Ask again; nothing was sent.', { status: 409, details: { baseVersion: body.baseVersion, headVersion: head.hash }, path: 'body.baseVersion' });
      const wanted = body.intentIds ? new Set(body.intentIds) : null;
      const accepted: string[] = []; const rejected: Array<{ id: string; code: string }> = []; const intents: EditIntentT[] = [];
      for (const id of wanted ?? []) if (!block.intents.some((p) => p.id === id)) rejected.push({ id, code: 'EM-9003' });
      for (const p of block.intents) {
        if (wanted && !wanted.has(p.id)) continue;
        const pick: DesignPick = { projectId: project.id, source: 'brainstorm', category: p.category as IntentCategory, ...(p.presetId ? { presetId: p.presetId } : {}), ...(p.params ? { params: p.params } : {}),
          ...(p.instruction ? { instruction: p.instruction } : {}), ...(p.target ? { selection: [p.target as ElementRefT] } : {}) };
        const r = createIntents(pick, { model: head.model, baseVersion: head.hash, newId: ctx.newId, now: ctx.now });
        if (!r.ok) { rejected.push({ id: p.id, code: r.issues[0]?.code ?? 'EM-2201' }); continue; }
        accepted.push(p.id);
        intents.push(...r.value.map((i) => (p.needsInterpretation && !i.needsInterpretation ? { ...i, needsInterpretation: true } : i)));
      }
      const enqueue = ctx.hooks.enqueueIntents?.bind(ctx.hooks);
      let queue: unknown = null;
      if (intents.length && enqueue) queue = enqueue(project.id, intents).queue;
      const now = ctx.now();
      block.handoffState = 'sent';
      ctx.db.transaction(() => {
        ctx.db.prepare('UPDATE messages SET blocks_json = ? WHERE id = ?').run(JSON.stringify(blocks), m.id);
        if (intents.length) ctx.db.prepare('INSERT INTO brainstorm_handoffs(id, project_id, message_id, intents_json, status, created_at) VALUES (?,?,?,?,?,?)').run(ctx.newId(), project.id, m.id, JSON.stringify(intents), enqueue ? 'enqueued' : 'pending', now);
      })();
      return { queue, accepted, rejected, planId: null, ...(enqueue ? {} : { pendingEnqueue: true, intents }) };
    });

    route(router, 'delete', '/projects/:id/conversations/:agent', { params: AgentParams }, ({ params }) => {
      requireProject(ctx, params.id);
      if (activeRun(ctx, params.id, params.agent)) throw new EmError('EM-4305', 'Wait for the current answer to finish, or cancel it, before clearing the chat.', { status: 409 });
      const convId = conversationId(ctx, params.id, params.agent);
      ctx.db.transaction(() => { ctx.db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId); ctx.db.prepare('UPDATE conversations SET summary_json = NULL, updated_at = ? WHERE id = ?').run(ctx.now(), convId); })();
      return undefined;
    });

    const RunParams = z.object({ runId: Id });
    route(router, 'get', '/agent-runs/:runId', { params: RunParams }, ({ params }) => {
      const r = getRun(ctx, params.runId); if (!r) throw new EmError('EM-9003', 'This agent request no longer exists.');
      return runDto(ctx, r);
    });
    route(router, 'post', '/agent-runs/:runId/cancel', { params: RunParams }, ({ params }) => {
      const r = getRun(ctx, params.runId); if (!r) throw new EmError('EM-9003', 'This agent request no longer exists.');
      if (r.status === 'running') cancelRun(ctx, r.id, 'EM-4303');
      return runDto(ctx, getRun(ctx, r.id)!);
    });
  },
};
