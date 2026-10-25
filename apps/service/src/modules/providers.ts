// Providers module: R-090…R-103 (connections, validation incl. dry-run, Test probe, Capability Table cache, Model Assignments, budgets) and the
// providerFor / recordUsage / budgetCheck hooks. Keys are AES-256-GCM sealed (s3/crypto.ts), decrypted only at call time,
// never returned (secretHint only) and never logged. All outbound traffic goes through ctx.egress.fetch.
import type { Router } from 'express';
import { z } from 'zod';
import { EmError, type Issue } from '@expertmotion/shared';
import { extractJson, mapProviderError, type ChatProvider } from '@expertmotion/agents';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { customBaseUrlProblem } from '../services/egress.js';
import { createSecretBox, secretHint, type SecretBox } from '../s3/crypto.js';
import { chatProviderFor, DEFAULT_CALL_TIMEOUT_MS, listModels, VALIDATE_TIMEOUT_MS, validateKey } from '../s3/adapters.js';
import { Agent, AssignmentDto, AssignmentSettings, audit, emit, Id, monthOf, ProviderKind, requireProject, type AgentT, type AssignmentDtoT, type CapabilityRowT, type ProviderKindT } from '../s3/dto.js';
import { budgetCheck, budgetState, cachedModels, connectionMonthSpend, projectConnectionMonthSpend, projectMonthSpend, recordUsage } from '../s3/usage-store.js';
import { s3, track } from '../s3/state.js';

interface ConnRow { id: string; provider: ProviderKindT; label: string; base_url: string | null; secret_enc: Buffer; secret_hint: string; status: 'unvalidated' | 'valid' | 'invalid';
  validated_at: string | null; models_json: string | null; models_fetched_at: string | null; budget_month_usd: number | null; created_at: string; updated_at: string }

const STALE_MS = 7 * 86_400_000;
const aadFor = (id: string) => `provider_connections:${id}`;
const boxes = new WeakMap<ServiceContext, SecretBox>();
const box = (ctx: ServiceContext): SecretBox => { let b = boxes.get(ctx); if (!b) { b = createSecretBox(ctx.cfg.dbKeyHex); boxes.set(ctx, b); } return b; };
/** Late-bound egress so a replaced ctx.egress (tests, proxy settings) is always used. */
const egressFetch = (ctx: ServiceContext, purpose: 'provider' | 'provider-models' = 'provider'): typeof fetch => (input, init) => ctx.egress.for(purpose)(input, init);

const modelCount = (r: ConnRow): number | null => { if (!r.models_json) return null; try { const a = JSON.parse(r.models_json) as unknown; return Array.isArray(a) ? a.length : null; } catch { return null; } };
const toDto = (r: ConnRow) => ({ id: r.id, provider: r.provider, label: r.label, baseUrl: r.base_url, secretHint: r.secret_hint, status: r.status, validatedAt: r.validated_at,
  modelsFetchedAt: r.models_fetched_at, modelCount: modelCount(r), budgetMonthUsd: r.budget_month_usd, createdAt: r.created_at, updatedAt: r.updated_at });

/** FR-111/FR-112 per-provider facts shown on the Add form: build priority, terms link and the expected key shape (warn only). */
export const PROVIDER_INFO: Record<Exclude<ProviderKindT, 'custom'>, { priority: 'P0' | 'P1'; termsUrl: string; keyPattern: string; keyExample: string }> = {
  openrouter: { priority: 'P0', termsUrl: 'https://openrouter.ai/terms', keyPattern: '^sk-or-v1-[A-Za-z0-9]{20,}$', keyExample: 'sk-or-v1-…' },
  openai: { priority: 'P1', termsUrl: 'https://openai.com/policies/terms-of-use', keyPattern: '^sk-[A-Za-z0-9_-]{20,}$', keyExample: 'sk-…' },
  anthropic: { priority: 'P1', termsUrl: 'https://www.anthropic.com/legal/commercial-terms', keyPattern: '^sk-ant-[A-Za-z0-9_-]{20,}$', keyExample: 'sk-ant-…' },
  google: { priority: 'P1', termsUrl: 'https://ai.google.dev/gemini-api/terms', keyPattern: '^AIza[0-9A-Za-z_-]{30,}$', keyExample: 'AIza…' },
};
export const ALL_PROVIDERS = Object.keys(PROVIDER_INFO) as Array<Exclude<ProviderKindT, 'custom'>>;
export interface ProvidersOptions {
  /** Providers enabled in this build; the others answer EM-9004 (FR-111). Default: OpenRouter, OpenAI, Anthropic and Gemini
   *  (PRD-032 pulled forward on 2026-10-25 at the Operator's request); `custom` stays P2. */
  enabledProviders?: readonly ProviderKindT[];
}
export const P0_PROVIDERS: readonly ProviderKindT[] = ['openrouter'];
export const DEFAULT_PROVIDERS: readonly ProviderKindT[] = ['openrouter', 'openai', 'anthropic', 'google'];
function requireEnabled(enabled: readonly ProviderKindT[], p: ProviderKindT): void {
  if (p === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422, details: { feature: 'provider.custom', plannedPriority: 'P2' } });
  if (!enabled.includes(p)) throw new EmError('EM-9004', `"${p} connections" is not available in this version of Expertmotion yet.`, { status: 422, details: { feature: `provider.${p}`, plannedPriority: PROVIDER_INFO[p].priority } });
}

/** FR-116 fixed probe (not a creative run): one tiny request per agent through the same ChatProvider adapters the chats use. */
export const TEST_PROBE = { system: 'You are a connection test for Expertmotion. Answer with one JSON object only.', user: 'Reply with the word OK as JSON: {"reply":"OK"}', maxTokens: 20 } as const;
/** fetch() failing below HTTP (DNS, refused, reset) = offline → EM-8201, as the chats show it (FR-116). */
const isOffline = (e: unknown): boolean => {
  let c: unknown = e;
  for (let i = 0; i < 4 && c; i++) {
    const x = c as { name?: string; message?: string; code?: string; cause?: unknown };
    if ((x.name === 'TypeError' && /fetch failed/i.test(String(x.message))) || /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH)$/.test(String(x.code))) return true;
    c = x.cause;
  }
  return false;
};

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
  const items = await listModels(r.provider, keyOf(ctx, r), egressFetch(ctx, 'provider-models'));   // SEC-084: model lists ≤ 8 MB
  const at = ctx.now();
  ctx.db.prepare('UPDATE provider_connections SET models_json=?, models_fetched_at=?, updated_at=? WHERE id=?').run(JSON.stringify(items), at, at, id);
  changed(ctx, 'providers');                      // the Editor reloads the Capability Table (it may have read an empty one)
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

/** Capability warnings for an assignment (AGENT_DESIGN §2.3, AGD-004): unknown models and custom providers are refused, weak capabilities only warn. */
function checkAssignment(ctx: ServiceContext, a: AssignmentDtoT): Issue[] {
  const conn = getConn(ctx, a.connectionId);
  if (conn.provider === 'custom') throw new EmError('EM-9004', '"Custom provider connections" is not available in this version of Expertmotion yet.', { status: 422 });
  const models = cachedModels(ctx, a.connectionId);
  const path = `body.${a.agent}.modelId`;
  if (!models) return [{ code: 'EM-4006', path, message: 'The model list has not been loaded yet, so capabilities were not checked.', severity: 'info' }];
  const m = models.find((x) => x.modelId === a.modelId);
  if (!m) throw new EmError('EM-4004', `The model "${a.modelId}" is not offered by ${conn.provider}. Choose another model.`, { status: 422, path });
  const w: Issue[] = [];
  // Operator decision 2026-10-25: a model without JSON output is allowed with a warning (never refused). The agents always ask
  // for JSON by prompting (ADR-023): the Brainstorming Agent shows a non-JSON reply as plain text, the Editor Agent re-prompts
  // and ends with EM-4301 ("choose a more capable model") when no valid plan comes back.
  if (m.structuredOutput === false) w.push({ code: 'EM-4005', path, message: `"${a.modelId}" does not confirm JSON output, so the ${a.agent === 'editor' ? 'Editor Agent' : 'Brainstorming Agent'} may fail or give poor results; a stronger model is recommended.`, severity: 'warn' });
  else if (m.toolCalling !== true || m.structuredOutput !== true) w.push({ code: 'EM-4005', path, message: m.toolCalling === false ? `"${a.modelId}" does not support tool calling, so Expertmotion asks it for plans in simple mode.`
    : `${conn.provider} does not report whether "${a.modelId}" supports tool calling and structured output, so Expertmotion asks it for plans in simple mode.`, severity: 'info' });
  if (m.contextLength !== null && m.contextLength < 32_000) w.push({ code: 'EM-4306', path, message: `"${a.modelId}" has a small context (${m.contextLength} tokens); 32k or more is recommended.`, severity: 'warn' });
  return w;
}

/** FR-119: on Remove, agents move to another validated connection that offers the same model, else to none (EM-4007). */
function reassignAway(ctx: ServiceContext, removedId: string): { reassigned: Array<{ agent: string; connectionId: string }>; cleared: string[] } {
  const others = (ctx.db.prepare("SELECT id FROM provider_connections WHERE id <> ? AND status = 'valid' ORDER BY created_at").all(removedId) as Array<{ id: string }>).map((x) => x.id);
  const used = ctx.db.prepare('SELECT agent, model_id FROM model_assignments WHERE connection_id = ?').all(removedId) as Array<{ agent: string; model_id: string }>;
  const reassigned: Array<{ agent: string; connectionId: string }> = []; const cleared: string[] = [];
  for (const u of used) {
    const target = others.find((id) => cachedModels(ctx, id)?.some((m) => m.modelId === u.model_id));
    if (target) { ctx.db.prepare('UPDATE model_assignments SET connection_id = ?, updated_at = ? WHERE agent = ?').run(target, ctx.now(), u.agent); reassigned.push({ agent: u.agent, connectionId: target }); }
    else { ctx.db.prepare('DELETE FROM model_assignments WHERE agent = ?').run(u.agent); cleared.push(u.agent); }
  }
  if (defaultConnection(ctx) === removedId) setDefault(ctx, others[0] ?? null);
  return { reassigned, cleared };
}

interface ProbeTarget { provider: ProviderKindT; key: string; modelId: string; connectionId: string | null }
export interface ProbeResult { agent: AgentT; modelId: string; ok: boolean; latencyMs: number; inputTokens: number; outputTokens: number; costUsd: number | null; approximate: boolean; code?: string }
async function runProbe(ctx: ServiceContext, agent: AgentT, t: ProbeTarget): Promise<ProbeResult> {
  const st = s3(ctx); const ac = new AbortController(); st.providerCalls.add(ac);
  const t0 = Date.now();
  const base = { agent, modelId: t.modelId, inputTokens: 0, outputTokens: 0, costUsd: null as number | null, approximate: false };
  try {
    const r = await chatProviderFor(t.provider, t.key, t.modelId, egressFetch(ctx)).complete({ system: TEST_PROBE.system, messages: [{ role: 'user', content: TEST_PROBE.user }],
      maxTokens: TEST_PROBE.maxTokens, temperature: 0, signal: ac.signal, timeoutMs: VALIDATE_TIMEOUT_MS * 2 });
    const latencyMs = Date.now() - t0;
    let costUsd = r.usage.costUsd; let approximate = costUsd !== null ? r.usage.approximate : false;
    if (costUsd === null && t.connectionId) {
      const m = cachedModels(ctx, t.connectionId)?.find((x) => x.modelId === t.modelId);
      if (m && m.pricePerMInput !== null && m.pricePerMOutput !== null) { costUsd = (r.usage.inputTokens * m.pricePerMInput + r.usage.outputTokens * m.pricePerMOutput) / 1_000_000; approximate = true; }
    }
    const json = extractJson(r.text) as { reply?: unknown } | undefined;
    const ok = !!json && typeof json === 'object' && /^ok$/i.test(String(json.reply ?? '').trim());
    return { ...base, ok, latencyMs, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, costUsd, approximate, ...(ok ? {} : { code: 'EM-4301' }) };
  } catch (e) {
    const latencyMs = Date.now() - t0;
    if (ac.signal.aborted) return { ...base, ok: false, latencyMs, code: 'EM-8202' };
    const em = e instanceof EmError ? e : mapProviderError(e);
    return { ...base, ok: false, latencyMs, code: em.code === 'EM-4003' && isOffline(e instanceof EmError ? e.cause ?? e : e) ? 'EM-8201' : em.code };
  } finally { st.providerCalls.delete(ac); }
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
  const perConn = ctx.db.prepare('SELECT project_id p, connection_id c, limit_usd l FROM project_connection_budgets ORDER BY project_id, connection_id').all() as Array<{ p: string; c: string; l: number | null }>;
  return {
    connections: conns.map((c) => { const s = connectionMonthSpend(ctx, c.id, month); return { connectionId: c.id, budgetMonthUsd: c.b, spentMonthUsd: s.costUsd, approximate: s.approximate }; }),
    // FR-117: connectionId null = project-wide cap (all connections); otherwise the per-project cap on that connection
    projects: [...projects.map((p) => ({ projectId: p.p, connectionId: null as string | null, limitUsd: p.l, spentUsd: projectMonthSpend(ctx, p.p, month).costUsd })),
      ...perConn.map((p) => ({ projectId: p.p, connectionId: p.c as string | null, limitUsd: p.l, spentUsd: projectConnectionMonthSpend(ctx, p.p, p.c, month).costUsd }))], month,
  };
}

/** SEC-082: https only, a DNS hostname (no IP literal, no localhost); the host joins the provider allow-list once saved. */
const CustomBaseUrl = z.string().max(512).superRefine((v, c) => { const p = customBaseUrlProblem(v); if (p) c.addIssue({ code: 'custom', message: `baseUrl: ${p}` }); });
const AddBody = z.object({ provider: ProviderKind, label: z.string().trim().min(1).max(60), secret: z.string().trim().min(8).max(512), baseUrl: CustomBaseUrl.optional(),
  budgetMonthUsd: z.number().positive().nullable().default(null), validateNow: z.boolean().default(true) }).strict();
const PatchBody = z.object({ label: z.string().trim().min(1).max(60).optional(), secret: z.string().trim().min(8).max(512).optional(), baseUrl: CustomBaseUrl.nullable().optional(),
  budgetMonthUsd: z.number().positive().nullable().optional() }).strict();
const ConnParams = z.object({ connId: Id });
const AssignBody = z.object({ brainstorm: AssignmentDto.nullable().optional(), editor: AssignmentDto.nullable().optional(), defaultConnectionId: Id.nullable().optional() }).strict();
const DryRunBody = z.object({ provider: ProviderKind, secret: z.string().trim().min(8).max(512) }).strict();
const TestBody = z.object({ connectionId: Id.optional(), draft: DryRunBody.optional(), brainstorm: z.string().min(1).max(200).nullable().optional(), editor: z.string().min(1).max(200).nullable().optional() }).strict();
const BudgetBody = z.object({ connections: z.array(z.object({ connectionId: Id, budgetMonthUsd: z.number().min(0).max(10_000).nullable() })).max(50).optional(),
  projects: z.array(z.object({ projectId: Id, connectionId: Id.nullable().optional(), limitUsd: z.number().min(0).max(10_000).nullable() })).max(500).optional() }).strict();

export function createProvidersModule(opts: ProvidersOptions = {}): ServiceModule {
  const enabled = opts.enabledProviders ?? DEFAULT_PROVIDERS;
  return {
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

      route(router, 'get', '/providers/kinds', {}, () => ({                                                                  // R-103
        items: [...ALL_PROVIDERS.map((p) => ({ provider: p, enabled: enabled.includes(p), ...PROVIDER_INFO[p] })),
          { provider: 'custom' as const, enabled: false, priority: 'P2' as const, termsUrl: null, keyPattern: null, keyExample: null }],
      }));

      route(router, 'post', '/providers/connections', { body: AddBody, status: 201 }, async ({ body, res }) => {
        if (body.baseUrl && body.provider !== 'custom') throw new EmError('EM-9002', 'Invalid request: baseUrl is only for custom providers.', { status: 400, path: 'body.baseUrl' });
        requireEnabled(enabled, body.provider);
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
            // Awaited: the response already carries a filled Capability Table, so the model pickers are never empty after Add.
            await refreshModels(ctx, id).catch((e: unknown) => ctx.log.warn({ connectionId: id, code: (e as EmError).code ?? 'EM-4006' }, 'model refresh after add failed'));
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
        const used = (ctx.db.prepare('SELECT agent FROM model_assignments WHERE connection_id = ? ORDER BY agent').all(r.id) as Array<{ agent: string }>).map((x) => x.agent);
        if (used.length && query.force !== 'true') throw new EmError('EM-2309', 'This connection is used by an agent. Change the Model Assignment first, or remove it anyway.', { status: 409, details: { assignments: used } });
        let moved: ReturnType<typeof reassignAway> = { reassigned: [], cleared: [] };
        ctx.db.transaction(() => {
          moved = reassignAway(ctx, r.id);                                                    // FR-119: another validated connection, else none
          ctx.db.prepare('UPDATE agent_runs SET connection_id = NULL WHERE connection_id = ?').run(r.id);   // Usage Records stay for history
          ctx.db.prepare('DELETE FROM provider_connections WHERE id = ?').run(r.id);
        })();
        audit(ctx, 'provider.removed', { connectionId: r.id, clearedAssignments: moved.cleared, reassigned: moved.reassigned });
        changed(ctx, 'providers');
        if (used.length) changed(ctx, 'assignments');
        return undefined;
      });

      route(router, 'post', '/providers/connections/:connId/validate', { params: ConnParams }, ({ params }) => validateConn(ctx, params.connId));

      // R-101 dry run (FR-113/FR-118): validate a key and list its models without storing anything; Save (R-091) stores.
      route(router, 'post', '/providers/validate', { body: DryRunBody }, async ({ body }) => {
        requireEnabled(enabled, body.provider);
        if (ctx.egress.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so "Validate key" was not sent to the internet.', { details: { action: 'Validate key' } });
        try { await validateKey(body.provider, body.secret, egressFetch(ctx)); } catch (e) {
          const em = e instanceof EmError ? e : new EmError('EM-4003', 'Could not reach the AI provider.', { cause: e });
          if (em.code === 'EM-4002') throw new EmError('EM-4002', `${body.provider} did not accept this key. Check that it was copied completely and is still active.`, { status: 422, details: { provider: body.provider, status: 'invalid' } });
          if (em.code === 'EM-4003' && isOffline(em.cause ?? e)) throw new EmError('EM-8201', 'No internet connection.', { status: 503 });
          throw em;
        }
        try { return { status: 'valid' as const, validatedAt: ctx.now(), models: await listModels(body.provider, body.secret, egressFetch(ctx)) }; }
        catch (e) { return { status: 'valid' as const, validatedAt: ctx.now(), models: [] as CapabilityRowT[], modelsCode: e instanceof EmError ? e.code : 'EM-4006' }; }
      });

      // R-102 Test (FR-116): the fixed probe per agent; per-agent EM codes are reported in the rows, never thrown.
      route(router, 'post', '/providers/test', { body: TestBody }, async ({ body }) => {
        if (ctx.egress.isPrivate()) throw new EmError('EM-8202', 'Private Mode is on, so "Test" was not sent to the internet.', { details: { action: 'Test' } });
        const items: ProbeResult[] = [];
        for (const agent of Agent.options) {
          let target: ProbeTarget | null = null;
          const modelId = body[agent];
          if (modelId === null) continue;
          if (body.draft) { requireEnabled(enabled, body.draft.provider); if (modelId) target = { provider: body.draft.provider, key: body.draft.secret, modelId, connectionId: null }; }
          else {
            const saved = assignmentOf(ctx, agent);
            const connId = body.connectionId ?? saved?.connectionId;
            const mid = modelId ?? (saved && (!body.connectionId || saved.connectionId === body.connectionId) ? saved.modelId : undefined);
            if (connId && mid) { const c = getConn(ctx, connId); requireEnabled(enabled, c.provider); target = { provider: c.provider, key: keyOf(ctx, c), modelId: mid, connectionId: c.id }; }
          }
          if (target) items.push(await runProbe(ctx, agent, target));
        }
        if (!items.length) throw new EmError('EM-4007', 'No agent has a model to test yet. Choose one first.', { status: 422 });
        return { items };
      });

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
        for (const p of body.projects ?? []) { requireProject(ctx, p.projectId); if (p.connectionId) getConn(ctx, p.connectionId); }
        const now = ctx.now();
        ctx.db.transaction(() => {
          for (const c of body.connections ?? []) ctx.db.prepare('UPDATE provider_connections SET budget_month_usd=?, updated_at=? WHERE id=?').run(c.budgetMonthUsd && c.budgetMonthUsd > 0 ? c.budgetMonthUsd : null, now, c.connectionId);
          for (const p of body.projects ?? []) {
            const lim = p.limitUsd && p.limitUsd > 0 ? p.limitUsd : null;
            if (p.connectionId) ctx.db.prepare('INSERT INTO project_connection_budgets(project_id, connection_id, limit_usd, updated_at) VALUES (?,?,?,?) ON CONFLICT(project_id, connection_id) DO UPDATE SET limit_usd=excluded.limit_usd, updated_at=excluded.updated_at').run(p.projectId, p.connectionId, lim, now);
            else ctx.db.prepare('INSERT INTO project_budgets(project_id, limit_usd, updated_at) VALUES (?,?,?) ON CONFLICT(project_id) DO UPDATE SET limit_usd=excluded.limit_usd, updated_at=excluded.updated_at').run(p.projectId, lim, now);
          }
        })();
        changed(ctx, 'budget');
        return budgetView(ctx);
      });
    },
  };
}
export const providersModule: ServiceModule = createProvidersModule();
export { budgetState };
