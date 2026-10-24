// Providers module: R-090…R-100 (connections, validation, Capability Table cache, Model Assignments, budgets) and the
// providerFor / recordUsage / budgetCheck hooks. Keys are AES-256-GCM sealed (s3/crypto.ts), decrypted only at call time,
// never returned (secretHint only) and never logged. All outbound traffic goes through ctx.egress.fetch.
import type { Router } from 'express';
import { z } from 'zod';
import { EmError, type Issue } from '@expertmotion/shared';
import type { ChatProvider } from '@expertmotion/agents';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { createSecretBox, secretHint, type SecretBox } from '../s3/crypto.js';
import { chatProviderFor, DEFAULT_CALL_TIMEOUT_MS, listModels, validateKey } from '../s3/adapters.js';
import { Agent, AssignmentDto, AssignmentSettings, audit, emit, Id, monthOf, ProviderKind, requireProject, type AgentT, type AssignmentDtoT, type CapabilityRowT, type ProviderKindT } from '../s3/dto.js';
import { budgetCheck, budgetState, cachedModels, connectionMonthSpend, projectMonthSpend, recordUsage } from '../s3/usage-store.js';
import { s3, track } from '../s3/state.js';

interface ConnRow { id: string; provider: ProviderKindT; label: string; base_url: string | null; secret_enc: Buffer; secret_hint: string; status: 'unvalidated' | 'valid' | 'invalid';
  validated_at: string | null; models_json: string | null; models_fetched_at: string | null; budget_month_usd: number | null; created_at: string; updated_at: string }

const STALE_MS = 7 * 86_400_000;
const aadFor = (id: string) => `provider_connections:${id}`;
const boxes = new WeakMap<ServiceContext, SecretBox>();
const box = (ctx: ServiceContext): SecretBox => { let b = boxes.get(ctx); if (!b) { b = createSecretBox(ctx.cfg.dbKeyHex); boxes.set(ctx, b); } return b; };
/** Late-bound egress so a replaced ctx.egress (tests, proxy settings) is always used. */
const egressFetch = (ctx: ServiceContext): typeof fetch => (input, init) => ctx.egress.fetch(input, init);

const toDto = (r: ConnRow) => ({ id: r.id, provider: r.provider, label: r.label, baseUrl: r.base_url, secretHint: r.secret_hint, status: r.status, validatedAt: r.validated_at,
  modelsFetchedAt: r.models_fetched_at, budgetMonthUsd: r.budget_month_usd, createdAt: r.created_at, updatedAt: r.updated_at });

function getConn(ctx: ServiceContext, id: string): ConnRow {
  const r = ctx.db.prepare('SELECT * FROM provider_connections WHERE id = ?').get(id) as ConnRow | undefined;
  if (!r) throw new EmError('EM-9003', 'This provider connection no longer exists.');
  return r;
}
const keyOf = (ctx: ServiceContext, r: ConnRow): string => box(ctx).open(r.secret_enc, aadFor(r.id));
const changed = (ctx: ServiceContext, scope: string) => emit(ctx, 'settings.changed', { scope });

async function validateConn(ctx: ServiceContext, id: string): Promise<{ status: 'valid' | 'invalid'; validatedAt: string; errorCode?: string }> {
  const r = getConn(ctx, id);
  if (r.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
  if (ctx.egress.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so "Validate key" was not sent to the internet.');
  const at = ctx.now();
  try {
    await validateKey(r.provider, keyOf(ctx, r), egressFetch(ctx));
  } catch (e) {
    const em = e instanceof EmError ? e : new EmError('EM-4003', 'Could not reach the AI provider.', { cause: e });
    if (em.code === 'EM-4002') {
      ctx.db.prepare("UPDATE provider_connections SET status='invalid', validated_at=?, updated_at=? WHERE id=?").run(at, at, id);
      changed(ctx, 'providers');
      throw new EmError('EM-4002', `${r.provider} did not accept this key. Check that it was copied completely and is still active.`, { status: 422, details: { connectionId: id, status: 'invalid' } });
    }
    throw em;
  }
  ctx.db.prepare("UPDATE provider_connections SET status='valid', validated_at=?, updated_at=? WHERE id=?").run(at, at, id);
  changed(ctx, 'providers');
  return { status: 'valid', validatedAt: at };
}

async function refreshModels(ctx: ServiceContext, id: string): Promise<{ items: CapabilityRowT[]; fetchedAt: string }> {
  const r = getConn(ctx, id);
  if (r.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
  if (ctx.egress.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so "List models" was not sent to the internet.');
  const items = await listModels(r.provider, keyOf(ctx, r), egressFetch(ctx));
  const at = ctx.now();
  ctx.db.prepare('UPDATE provider_connections SET models_json=?, models_fetched_at=?, updated_at=? WHERE id=?').run(JSON.stringify(items), at, at, id);
  return { items, fetchedAt: at };
}

function assignmentOf(ctx: ServiceContext, agent: AgentT): AssignmentDtoT | null {
  const a = ctx.db.prepare('SELECT agent, connection_id, model_id, settings_json FROM model_assignments WHERE agent = ?').get(agent) as { agent: AgentT; connection_id: string; model_id: string; settings_json: string } | undefined;
  return a ? { agent: a.agent, connectionId: a.connection_id, modelId: a.model_id, settings: AssignmentSettings.parse(JSON.parse(a.settings_json)) } : null;
}
export function getAssignment(ctx: ServiceContext, agent: AgentT): AssignmentDtoT | null { return assignmentOf(ctx, agent); }
const defaultConnection = (ctx: ServiceContext): string | null => (ctx.db.prepare('SELECT default_connection_id d FROM provider_defaults WHERE id = 1').get() as { d: string | null } | undefined)?.d ?? null;
function setDefault(ctx: ServiceContext, id: string | null) {
  ctx.db.prepare('INSERT INTO provider_defaults(id, default_connection_id, updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET default_connection_id=excluded.default_connection_id, updated_at=excluded.updated_at').run(id, ctx.now());
}
const assignmentsView = (ctx: ServiceContext) => ({ brainstorm: assignmentOf(ctx, 'brainstorm'), editor: assignmentOf(ctx, 'editor'), defaultConnectionId: defaultConnection(ctx) });

/** Capability gating for an assignment (AGENT_DESIGN §2.3, AGD-004). */
function checkAssignment(ctx: ServiceContext, a: AssignmentDtoT): Issue[] {
  const conn = getConn(ctx, a.connectionId);
  if (conn.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
  const models = cachedModels(ctx, a.connectionId);
  const path = `body.${a.agent}.modelId`;
  if (!models) return [{ code: 'EM-4006', path, message: 'The model list has not been loaded yet, so capabilities were not checked.', severity: 'info' }];
  const m = models.find((x) => x.modelId === a.modelId);
  if (!m) throw new EmError('EM-4004', `The model "${a.modelId}" is not offered by ${conn.provider}. Choose another model.`, { status: 422, path });
  if (!m.structuredOutput) throw new EmError('EM-9002', `"${a.modelId}" cannot return JSON output, which the ${a.agent === 'editor' ? 'Editor Agent' : 'Brainstorming Agent'} needs.`, { status: 422, path, details: { reason: 'no-json-output' } });
  const w: Issue[] = [];
  if (!m.toolCalling) w.push({ code: 'EM-4005', path, message: `"${a.modelId}" does not support tool calling, so Expertmotion asks it for plans in simple mode.`, severity: 'info' });
  if (m.contextLength !== null && m.contextLength < 32_000) w.push({ code: 'EM-4306', path, message: `"${a.modelId}" has a small context (${m.contextLength} tokens); 32k or more is recommended.`, severity: 'warn' });
  return w;
}

/** providerFor hook: a ChatProvider for the agent's Model Assignment. Keys are decrypted per call; Private Mode aborts in-flight calls. */
function providerFor(ctx: ServiceContext, agent: AgentT): ChatProvider {
  if (ctx.egress.isPrivate()) throw new EmError('EM-4401', 'Private Mode blocks all internet use, so the agents are unavailable.');
  const a = assignmentOf(ctx, agent);
  if (!a) {
    const any = ctx.db.prepare('SELECT 1 FROM provider_connections LIMIT 1').get();
    if (!any) throw new EmError('EM-4001', 'Connect an AI provider to use the Brainstorming and Editor Agents.', { status: 503 });
    throw new EmError('EM-4007', `The ${agent === 'editor' ? 'Editor Agent' : 'Brainstorming Agent'} has no model yet. Choose one to start chatting.`, { status: 422 });
  }
  const conn = ctx.db.prepare('SELECT id, provider FROM provider_connections WHERE id = ?').get(a.connectionId) as { id: string; provider: ProviderKindT } | undefined;
  if (!conn) throw new EmError('EM-4001', 'Connect an AI provider to use the Brainstorming and Editor Agents.', { status: 503 });
  if (conn.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
  const st = s3(ctx);
  return {
    id: conn.provider, model: a.modelId,
    async complete(req) {
      if (ctx.egress.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so the agent request was not sent to the internet.');
      const ac = new AbortController(); st.providerCalls.add(ac);
      const signal = req.signal ? AbortSignal.any([req.signal, ac.signal]) : ac.signal;
      try {
        const inner = chatProviderFor(conn.provider, keyOf(ctx, getConn(ctx, conn.id)), a.modelId, egressFetch(ctx));
        return await inner.complete({ ...req, signal, timeoutMs: req.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
          ...(a.settings.temperature !== undefined ? { temperature: a.settings.temperature } : {}), ...(a.settings.maxTokens !== undefined ? { maxTokens: a.settings.maxTokens } : {}) });
      } catch (e) {
        if (ac.signal.aborted && !req.signal?.aborted) throw new EmError('EM-8202', 'Private Mode is on, so the agent request was stopped.');
        throw e;
      } finally { st.providerCalls.delete(ac); }
    },
  };
}

function budgetView(ctx: ServiceContext, month = monthOf(ctx.now())) {
  const conns = ctx.db.prepare('SELECT id, budget_month_usd b FROM provider_connections ORDER BY created_at').all() as Array<{ id: string; b: number | null }>;
  const projects = ctx.db.prepare('SELECT project_id p, limit_usd l FROM project_budgets ORDER BY project_id').all() as Array<{ p: string; l: number | null }>;
  return {
    connections: conns.map((c) => { const s = connectionMonthSpend(ctx, c.id, month); return { connectionId: c.id, budgetMonthUsd: c.b, spentMonthUsd: s.costUsd, approximate: s.approximate }; }),
    projects: projects.map((p) => ({ projectId: p.p, limitUsd: p.l, spentUsd: projectMonthSpend(ctx, p.p, month).costUsd })), month,
  };
}

const AddBody = z.object({ provider: ProviderKind, label: z.string().trim().min(1).max(60), secret: z.string().trim().min(8).max(512), baseUrl: z.string().url().startsWith('https://').optional(),
  budgetMonthUsd: z.number().positive().nullable().default(null), validateNow: z.boolean().default(true) }).strict();
const PatchBody = z.object({ label: z.string().trim().min(1).max(60).optional(), secret: z.string().trim().min(8).max(512).optional(), baseUrl: z.string().url().startsWith('https://').nullable().optional(),
  budgetMonthUsd: z.number().positive().nullable().optional() }).strict();
const ConnParams = z.object({ connId: Id });
const AssignBody = z.object({ brainstorm: AssignmentDto.nullable().optional(), editor: AssignmentDto.nullable().optional(), defaultConnectionId: Id.nullable().optional() }).strict();
const BudgetBody = z.object({ connections: z.array(z.object({ connectionId: Id, budgetMonthUsd: z.number().min(0).nullable() })).max(50).optional(),
  projects: z.array(z.object({ projectId: Id, limitUsd: z.number().min(0).nullable() })).max(500).optional() }).strict();

export const providersModule: ServiceModule = {
  name: 'providers',
  start(ctx) {
    ctx.hooks.providerFor = (agent) => providerFor(ctx, agent);
    ctx.hooks.recordUsage = (projectId, agent, runId, usage) => recordUsage(ctx, projectId, agent, runId, usage);
    ctx.hooks.budgetCheck = (projectId) => budgetCheck(ctx, projectId);
    ctx.settings.onChange((s, keys) => {
      if (keys.includes('privateMode') && s.privateMode) for (const ac of s3(ctx).providerCalls) ac.abort();
    });
  },
  async stop(ctx) { for (const ac of s3(ctx).providerCalls) ac.abort(); await Promise.allSettled([...s3(ctx).background]); },
  register(router: Router, ctx) {
    route(router, 'get', '/providers/connections', {}, () => ({ items: (ctx.db.prepare('SELECT * FROM provider_connections ORDER BY created_at').all() as ConnRow[]).map(toDto) }));

    route(router, 'post', '/providers/connections', { body: AddBody, status: 201 }, async ({ body, res }) => {
      if (body.baseUrl && body.provider !== 'custom') throw new EmError('EM-9002', 'Invalid request: baseUrl is only for custom providers.', { status: 400, path: 'body.baseUrl' });
      if (body.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
      const id = ctx.newId(); const now = ctx.now();
      const sealed = box(ctx).seal(body.secret, aadFor(id));
      ctx.db.prepare("INSERT INTO provider_connections(id, provider, label, base_url, secret_enc, secret_hint, status, budget_month_usd, created_at, updated_at) VALUES (?,?,?,?,?,?,'unvalidated',?,?,?)")
        .run(id, body.provider, body.label, body.baseUrl ?? null, sealed, secretHint(body.secret), body.budgetMonthUsd, now, now);
      if (!defaultConnection(ctx)) setDefault(ctx, id);
      audit(ctx, 'provider.added', { connectionId: id, provider: body.provider });
      res.setHeader('Location', `/api/v1/providers/connections/${id}`);
      const notices: string[] = [];
      if (body.validateNow) {
        if (ctx.egress.isPrivate()) notices.push('EM-8202');
        else {
          await validateConn(ctx, id);       // EM-4002 → 422, connection stays stored as invalid
          void track(ctx, refreshModels(ctx, id).catch((e: unknown) => ctx.log.warn({ connectionId: id, code: (e as EmError).code ?? 'EM-4006' }, 'model refresh after add failed')));
        }
      }
      changed(ctx, 'providers');
      return { ...toDto(getConn(ctx, id)), ...(notices.length ? { notices } : {}) };
    });

    route(router, 'patch', '/providers/connections/:connId', { params: ConnParams, body: PatchBody }, ({ params, body }) => {
      const r = getConn(ctx, params.connId); const now = ctx.now();
      if (body.baseUrl !== undefined && r.provider !== 'custom') throw new EmError('EM-9002', 'Invalid request: baseUrl is only for custom providers.', { status: 400, path: 'body.baseUrl' });
      ctx.db.transaction(() => {
        if (body.label !== undefined) ctx.db.prepare('UPDATE provider_connections SET label=? WHERE id=?').run(body.label, r.id);
        if (body.budgetMonthUsd !== undefined) ctx.db.prepare('UPDATE provider_connections SET budget_month_usd=? WHERE id=?').run(body.budgetMonthUsd, r.id);
        if (body.baseUrl !== undefined) ctx.db.prepare('UPDATE provider_connections SET base_url=? WHERE id=?').run(body.baseUrl, r.id);
        if (body.secret !== undefined) ctx.db.prepare("UPDATE provider_connections SET secret_enc=?, secret_hint=?, status='unvalidated', validated_at=NULL WHERE id=?").run(box(ctx).seal(body.secret, aadFor(r.id)), secretHint(body.secret), r.id);
        ctx.db.prepare('UPDATE provider_connections SET updated_at=? WHERE id=?').run(now, r.id);
      })();
      if (body.secret !== undefined) audit(ctx, 'provider.key-replaced', { connectionId: r.id });
      changed(ctx, 'providers');
      return toDto(getConn(ctx, r.id));
    });

    route(router, 'delete', '/providers/connections/:connId', { params: ConnParams, query: z.object({ force: z.enum(['true', 'false']).optional() }) }, ({ params, query }) => {
      const r = getConn(ctx, params.connId);
      const used = (ctx.db.prepare('SELECT agent FROM model_assignments WHERE connection_id = ?').all(r.id) as Array<{ agent: string }>).map((x) => x.agent);
      if (used.length && query.force !== 'true') throw new EmError('EM-2309', 'This connection is used by an agent. Change the Model Assignment first, or remove it anyway.', { status: 409, details: { assignments: used } });
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM model_assignments WHERE connection_id = ?').run(r.id);
        ctx.db.prepare('UPDATE agent_runs SET connection_id = NULL WHERE connection_id = ?').run(r.id);
        ctx.db.prepare('DELETE FROM provider_connections WHERE id = ?').run(r.id);
      })();
      audit(ctx, 'provider.removed', { connectionId: r.id, clearedAssignments: used });
      changed(ctx, 'providers');
      if (used.length) changed(ctx, 'assignments');
      return undefined;
    });

    route(router, 'post', '/providers/connections/:connId/validate', { params: ConnParams }, ({ params }) => validateConn(ctx, params.connId));

    route(router, 'get', '/providers/connections/:connId/models', { params: ConnParams }, ({ params }) => {
      const r = getConn(ctx, params.connId);
      if (!r.models_json) return { items: [], fetchedAt: null, stale: true, notice: 'EM-4006' };
      return { items: JSON.parse(r.models_json) as CapabilityRowT[], fetchedAt: r.models_fetched_at, stale: !r.models_fetched_at || Date.parse(ctx.now()) - Date.parse(r.models_fetched_at) > STALE_MS };
    });

    route(router, 'post', '/providers/connections/:connId/models/refresh', { params: ConnParams }, ({ params }) => refreshModels(ctx, params.connId));

    route(router, 'get', '/providers/assignments', {}, () => assignmentsView(ctx));

    route(router, 'put', '/providers/assignments', { body: AssignBody }, ({ body }) => {
      const warnings: Issue[] = [];
      for (const agent of Agent.options) {
        const a = body[agent];
        if (a && a.agent !== agent) throw new EmError('EM-9002', `Invalid request: ${agent}.agent must be "${agent}".`, { status: 400, path: `body.${agent}.agent` });
        if (a) warnings.push(...checkAssignment(ctx, a));
      }
      if (body.defaultConnectionId) getConn(ctx, body.defaultConnectionId);
      const now = ctx.now();
      ctx.db.transaction(() => {
        for (const agent of Agent.options) {
          const a = body[agent];
          if (a === null) ctx.db.prepare('DELETE FROM model_assignments WHERE agent = ?').run(agent);
          else if (a) ctx.db.prepare('INSERT INTO model_assignments(agent, connection_id, model_id, settings_json, updated_at) VALUES (?,?,?,?,?) ON CONFLICT(agent) DO UPDATE SET connection_id=excluded.connection_id, model_id=excluded.model_id, settings_json=excluded.settings_json, updated_at=excluded.updated_at')
            .run(agent, a.connectionId, a.modelId, JSON.stringify(a.settings), now);
        }
        if (body.defaultConnectionId !== undefined) setDefault(ctx, body.defaultConnectionId);
      })();
      changed(ctx, 'assignments');
      return { ...assignmentsView(ctx), warnings };
    });

    route(router, 'get', '/providers/budget', {}, () => budgetView(ctx));

    route(router, 'put', '/providers/budget', { body: BudgetBody }, ({ body }) => {
      for (const c of body.connections ?? []) getConn(ctx, c.connectionId);
      for (const p of body.projects ?? []) requireProject(ctx, p.projectId);
      const now = ctx.now();
      ctx.db.transaction(() => {
        for (const c of body.connections ?? []) ctx.db.prepare('UPDATE provider_connections SET budget_month_usd=?, updated_at=? WHERE id=?').run(c.budgetMonthUsd && c.budgetMonthUsd > 0 ? c.budgetMonthUsd : null, now, c.connectionId);
        for (const p of body.projects ?? []) ctx.db.prepare('INSERT INTO project_budgets(project_id, limit_usd, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET limit_usd=excluded.limit_usd, updated_at=excluded.updated_at').run(p.projectId, p.limitUsd && p.limitUsd > 0 ? p.limitUsd : null, now);
      })();
      changed(ctx, 'budget');
      return budgetView(ctx);
    });
  },
};
export { budgetState };
