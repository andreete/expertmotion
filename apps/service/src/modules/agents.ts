// Agents module: R-080…R-085 (per-project conversations for the Brainstorming and Editor Agents, messages, runs with cancel).
// Brainstorm replies come from runBrainstorm; editor messages go through ctx.hooks.createPlan (intents module owns plans).
// R-082 turns proposed intents into EditIntent objects (createIntents) and hands them to the intents module via the optional
// `enqueueIntents` hook; without it the payload is stored in brainstorm_handoffs for the intents module to pick up.
import type { Router } from 'express';
import { z } from 'zod';
import { EmError, errorMessage } from '@expertmotion/shared';
import { hashModel, summarizeForAgent, type CompositionModelT, type ElementRefT } from '@expertmotion/composition-model';
import { BrainstormTurn, createIntents, runBrainstorm, type ChatMessage, type ChatUsage, type DesignPick, type EditIntentT, type IntentCategory } from '@expertmotion/agents';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { Agent, emit, Id, ProjectParams, requireProject, type AgentT } from '../s3/dto.js';
import { cachedModels, runUsage } from '../s3/usage-store.js';
import { s3, track } from '../s3/state.js';
import { getAssignment } from './providers.js';

/** Hook the intents module is asked to install (see report): enqueue already-validated intents, return the IntentQueueDto. */
export interface HandoffHooks { enqueueIntents(projectId: string, intents: EditIntentT[]): { queue: unknown } }

type Proposal = NonNullable<z.infer<typeof BrainstormTurn>['proposedIntents']>[number] & { id: string };
type Block = { type: 'text'; text: string } | { type: 'tool_call'; name: string; input: unknown } | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'proposed_intents'; intents: Proposal[]; handoffState: 'pending' | 'sent' | 'dismissed' } | { type: 'attachment'; assetId?: string; mime: string; name: string };
interface MsgRow { id: string; conversation_id: string; role: 'user' | 'assistant' | 'system' | 'tool'; blocks_json: string; agent_run_id: string | null; created_at: string }
interface RunRow { id: string; project_id: string; agent: AgentT; connection_id: string | null; model_id: string; status: 'running' | 'done' | 'failed' | 'cancelled'; error_code: string | null; started_at: string; finished_at: string | null; plan_id: string | null }

const msgDto = (m: MsgRow) => ({ id: m.id, role: m.role, blocks: JSON.parse(m.blocks_json) as Block[], agentRunId: m.agent_run_id, createdAt: m.created_at });
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
function failRun(ctx: ServiceContext, run: RunRow, convId: string, e: unknown) {
  const em = e instanceof EmError ? e : new EmError('EM-9001', 'Something went wrong.');
  if (!(e instanceof EmError)) ctx.log.error({ runId: run.id, err: errorMessage(e) }, 'agent run crashed');
  if (!finishRun(ctx, run.id, 'failed', em.code)) return;
  insertMessage(ctx, convId, 'system', [{ type: 'text', text: `${em.code}: ${em.message}` }], run.id);
  emit(ctx, 'agent.run.failed', { projectId: run.project_id, runId: run.id, agent: run.agent, code: em.code, retryable: ['EM-4101', 'EM-4102', 'EM-4103', 'EM-4003', 'EM-4301'].includes(em.code) });
}
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
    const text = (JSON.parse(r.blocks_json) as Block[]).flatMap((b) => (b.type === 'text' ? [b.text] : b.type === 'proposed_intents' ? [`(proposed ${b.intents.length} change(s); ${b.handoffState})`] : [])).join('\n');
    return text ? [{ role: r.role, content: text }] : [];
  });
}

function brainstormContext(ctx: ServiceContext, project: { id: string; name: string; language: 'id' | 'en' }) {
  let composition: unknown = null;
  try { const head = ctx.hooks.composition(project.id); composition = summarizeForAgent(head.model, ctx.hooks.assetFacts(project.id), 2000); } catch { /* no head yet */ }
  return { project: { name: project.name, language: project.language }, tier: ctx.hooks.tier(), composition };
}

async function executeBrainstorm(ctx: ServiceContext, run: RunRow, convId: string, project: { id: string; name: string; language: 'id' | 'en' }, signal: AbortSignal) {
  const provider = ctx.hooks.providerFor('brainstorm', project.id);
  const r = await runBrainstorm(historyOf(ctx, convId), brainstormContext(ctx, project), project.language, provider, { signal, budgetCheck: () => ctx.hooks.budgetCheck(project.id) });
  record(ctx, project.id, 'brainstorm', run.id, r.usage);
  if (signal.aborted) return;
  if (!r.ok) return failRun(ctx, run, convId, r.error);
  const blocks: Block[] = [{ type: 'text', text: r.turn.reply }];
  if (r.turn.questions?.length) blocks.push({ type: 'text', text: r.turn.questions.join('\n') });
  if (r.turn.proposedIntents?.length) blocks.push({ type: 'proposed_intents', intents: r.turn.proposedIntents.map((p) => ({ ...p, id: ctx.newId() })), handoffState: 'pending' });
  const msg = insertMessage(ctx, convId, 'assistant', blocks, run.id);
  if (!finishRun(ctx, run.id, 'done', null)) return;
  const done = getRun(ctx, run.id)!;
  emit(ctx, 'agent.run.done', { projectId: project.id, run: runDto(ctx, done), message: msgDto(msg), usage: runDto(ctx, done).usage, contextUsage: contextUsage(ctx, project.id, 'brainstorm') });
}

async function executeEditor(ctx: ServiceContext, run: RunRow, convId: string, projectId: string, text: string, signal: AbortSignal) {
  const plan = await ctx.hooks.createPlan(projectId, { instruction: text, mode: 'agent', signal }) as Awaited<ReturnType<ServiceContext['hooks']['createPlan']>> & { runId?: string };
  // The intents module records usage under its own run when it reports one (S1 behaviour); otherwise record here once.
  if (plan.usage && !plan.runId) record(ctx, projectId, 'editor', run.id, [plan.usage]);
  if (signal.aborted) return;
  const msg = insertMessage(ctx, convId, 'assistant', [{ type: 'text', text: plan.goal }, { type: 'tool_result', name: 'plan', output: { planId: plan.planId, planRunId: plan.runId ?? null, status: plan.status, steps: plan.steps.length, risks: plan.risks } }], run.id);
  if (!finishRun(ctx, run.id, 'done', null, plan.planId)) return;
  const done = getRun(ctx, run.id)!;
  emit(ctx, 'agent.run.done', { projectId, run: runDto(ctx, done), message: msgDto(msg), usage: runDto(ctx, done).usage, contextUsage: contextUsage(ctx, projectId, 'editor'), planId: plan.planId });
}

function record(ctx: ServiceContext, projectId: string, agent: AgentT, runId: string, usage: ChatUsage[]) {
  try { ctx.hooks.recordUsage(projectId, agent, runId, usage); } catch (e) { ctx.log.warn({ runId, code: (e as EmError).code ?? 'EM-9001' }, 'usage not recorded'); }
}

const AgentParams = z.object({ id: Id, agent: Agent });
const SendBody = z.object({ text: z.string().min(1).max(8000), attachments: z.array(z.object({ assetId: Id })).max(4).default([]), intentIds: z.array(Id).max(100).optional(), baseVersion: z.string().min(1).max(128) }).strict();
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

    route(router, 'post', '/projects/:id/conversations/:agent/messages', { params: AgentParams, body: SendBody, status: 202 }, ({ params, body }) => {
      const project = requireProject(ctx, params.id);
      const agent = params.agent;
      if (ctx.egress.isPrivate()) throw new EmError('EM-4401', 'Private Mode blocks all internet use, so the agents are unavailable.');
      if (activeRun(ctx, project.id, agent)) throw new EmError('EM-4305', 'Wait for the current answer to finish, or cancel it, before sending another message.', { status: 409 });
      const provider = ctx.hooks.providerFor(agent, project.id);
      ctx.hooks.budgetCheck(project.id);
      const a = getAssignment(ctx, agent);
      const cap = a ? cachedModels(ctx, a.connectionId)?.find((m) => m.modelId === a.modelId) : undefined;
      if (cap?.contextLength && Math.ceil(body.text.length / 4) > 0.6 * cap.contextLength) throw new EmError('EM-4306', `This message does not fit the model's memory (${cap.contextLength} tokens). Shorten it or start a new chat.`, { status: 422 });
      if (body.attachments.length && cap && !cap.imageInput) throw new EmError('EM-4307', `"${provider.model}" cannot read images. Describe the image in words, or switch to a model that can.`, { status: 422 });
      if (agent === 'editor') {
        let head: { versionId: string; hash: string } | null = null;
        try { head = headOf(ctx, project.id); } catch { /* composition module absent: createPlan checks the base */ }
        if (head !== null && !matchesBase(head, body.baseVersion)) throw new EmError('EM-2301', 'The composition changed after this message was written. Send it again.', { status: 409, details: { baseVersion: body.baseVersion, headVersion: head.hash }, path: 'body.baseVersion' });
      }
      const attachments: Block[] = body.attachments.map((x) => {
        const as = ctx.db.prepare('SELECT name, kind FROM assets WHERE id = ? AND project_id = ?').get(x.assetId, project.id) as { name: string; kind: string } | undefined;
        if (!as) throw new EmError('EM-9003', 'An attached asset no longer exists.', { path: 'body.attachments' });
        return { type: 'attachment', assetId: x.assetId, mime: as.kind === 'image' ? 'image/*' : `${as.kind}/*`, name: as.name };
      });
      const convId = conversationId(ctx, project.id, agent);
      const runId = ctx.newId(); const now = ctx.now();
      const run: RunRow = { id: runId, project_id: project.id, agent, connection_id: a?.connectionId ?? null, model_id: provider.model, status: 'running', error_code: null, started_at: now, finished_at: null, plan_id: null };
      const msg = ctx.db.transaction(() => {
        ctx.db.prepare("INSERT INTO agent_runs(id, project_id, agent, connection_id, model_id, status, started_at) VALUES (?,?,?,?,?,'running',?)").run(runId, project.id, agent, run.connection_id, run.model_id, now);
        return insertMessage(ctx, convId, 'user', [{ type: 'text', text: body.text }, ...attachments], runId);
      })();
      const controller = new AbortController();
      s3(ctx).runs.set(runId, { controller, projectId: project.id, agent });
      emit(ctx, 'agent.run.started', { projectId: project.id, run: runDto(ctx, run), agent, modelId: run.model_id });
      const work = agent === 'brainstorm' ? executeBrainstorm(ctx, run, convId, project, controller.signal) : executeEditor(ctx, run, convId, project.id, body.text, controller.signal);
      void track(ctx, work.catch((e: unknown) => { if (!controller.signal.aborted) failRun(ctx, run, convId, e); }));
      return { message: msgDto(msg), runId, planId: null };
    });

    route(router, 'post', '/projects/:id/conversations/brainstorm/handoff', { params: ProjectParams, body: HandoffBody }, ({ params, body }) => {
      const project = requireProject(ctx, params.id);
      const convId = conversationId(ctx, project.id, 'brainstorm');
      const m = ctx.db.prepare("SELECT * FROM messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'").get(body.messageId, convId) as MsgRow | undefined;
      const blocks = m ? (JSON.parse(m.blocks_json) as Block[]) : [];
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
