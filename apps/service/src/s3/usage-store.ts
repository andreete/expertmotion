// Usage Records and budgets (AI_WORKFLOW §11, FR-117). Spend is month-to-date (UTC month of `created_at`), computed from
// usage_records joined to agent_runs.connection_id. Provisional rule (doc gap): the per-project limit is also a monthly cap.
// FR-117 caps are per Provider Connection: `project_connection_budgets` (project × connection) and
// `provider_connections.budget_month_usd`; the older project-wide row in `project_budgets` (all connections) still applies.
import { EmError } from '@expertmotion/shared';
import { estimateCost, type ChatUsage, type PriceTable } from '@expertmotion/agents';
import type { ServiceContext } from '../context.js';
import { monthOf, type CapabilityRowT } from './dto.js';

export interface Spend { inputTokens: number; outputTokens: number; costUsd: number; approximate: boolean; runs: number }
const EMPTY: Spend = { inputTokens: 0, outputTokens: 0, costUsd: 0, approximate: false, runs: 0 };
interface SpendRow { i: number | null; o: number | null; c: number | null; a: number | null; n: number | null; nulls: number | null }
const toSpend = (r: SpendRow | undefined): Spend => (r ? { inputTokens: r.i ?? 0, outputTokens: r.o ?? 0, costUsd: Math.round((r.c ?? 0) * 1e6) / 1e6, approximate: (r.a ?? 0) > 0 || (r.nulls ?? 0) > 0, runs: r.n ?? 0 } : { ...EMPTY });
const SUMS = 'SUM(u.input_tokens) i, SUM(u.output_tokens) o, SUM(u.cost_usd) c, MAX(u.approximate) a, COUNT(DISTINCT u.agent_run_id) n, SUM(CASE WHEN u.cost_usd IS NULL THEN 1 ELSE 0 END) nulls';

export function connectionMonthSpend(ctx: ServiceContext, connectionId: string, month: string): Spend {
  return toSpend(ctx.db.prepare(`SELECT ${SUMS} FROM usage_records u JOIN agent_runs r ON r.id = u.agent_run_id WHERE r.connection_id = ? AND substr(u.created_at,1,7) = ?`).get(connectionId, month) as SpendRow);
}
export function projectMonthSpend(ctx: ServiceContext, projectId: string, month: string, agent?: string): Spend {
  if (agent) return toSpend(ctx.db.prepare(`SELECT ${SUMS} FROM usage_records u JOIN agent_runs r ON r.id = u.agent_run_id WHERE u.project_id = ? AND r.agent = ? AND substr(u.created_at,1,7) = ?`).get(projectId, agent, month) as SpendRow);
  return toSpend(ctx.db.prepare(`SELECT ${SUMS} FROM usage_records u WHERE u.project_id = ? AND substr(u.created_at,1,7) = ?`).get(projectId, month) as SpendRow);
}
export function projectConnectionMonthSpend(ctx: ServiceContext, projectId: string, connectionId: string, month: string): Spend {
  return toSpend(ctx.db.prepare(`SELECT ${SUMS} FROM usage_records u JOIN agent_runs r ON r.id = u.agent_run_id WHERE u.project_id = ? AND r.connection_id = ? AND substr(u.created_at,1,7) = ?`).get(projectId, connectionId, month) as SpendRow);
}
export function projectByModel(ctx: ServiceContext, projectId: string, month: string) {
  const rows = ctx.db.prepare(`SELECT r.connection_id cid, u.model_id mid, ${SUMS} FROM usage_records u JOIN agent_runs r ON r.id = u.agent_run_id WHERE u.project_id = ? AND substr(u.created_at,1,7) = ? GROUP BY r.connection_id, u.model_id ORDER BY c DESC`).all(projectId, month) as Array<SpendRow & { cid: string | null; mid: string }>;
  return rows.map((r) => ({ connectionId: r.cid, modelId: r.mid, ...toSpend(r) }));
}
export function runUsage(ctx: ServiceContext, runId: string): Spend | null {
  const r = ctx.db.prepare(`SELECT ${SUMS} FROM usage_records u WHERE u.agent_run_id = ?`).get(runId) as SpendRow;
  return r && (r.i !== null || r.o !== null) ? toSpend(r) : null;
}
export function projectLimit(ctx: ServiceContext, projectId: string): number | null {
  const r = ctx.db.prepare('SELECT limit_usd FROM project_budgets WHERE project_id = ?').get(projectId) as { limit_usd: number | null } | undefined;
  return r?.limit_usd ?? null;
}
/** Per-connection caps of one project (FR-117), keyed by connection id. */
export function projectConnectionLimits(ctx: ServiceContext, projectId: string): Map<string, number> {
  const rows = ctx.db.prepare('SELECT connection_id c, limit_usd l FROM project_connection_budgets WHERE project_id = ? AND limit_usd IS NOT NULL AND limit_usd > 0').all(projectId) as Array<{ c: string; l: number }>;
  return new Map(rows.map((r) => [r.c, r.l]));
}
export function cachedModels(ctx: ServiceContext, connectionId: string): CapabilityRowT[] | null {
  const r = ctx.db.prepare('SELECT models_json FROM provider_connections WHERE id = ?').get(connectionId) as { models_json: string | null } | undefined;
  return r?.models_json ? (JSON.parse(r.models_json) as CapabilityRowT[]) : null;
}

export interface BudgetState { projectLimitUsd: number | null; monthLimitUsd: number | null; spentMonthUsd: number; warn80: boolean; exceeded: boolean;
  breach: null | { scope: 'project' | 'month'; limitUsd: number; spentUsd: number; connectionId?: string } }

/** Budget view for one project: its project-wide cap, its per-connection caps and the monthly caps of the connections its
 *  agents are assigned to (FR-117). The first breach found wins; a per-connection breach carries its connectionId. */
export function budgetState(ctx: ServiceContext, projectId: string, month = monthOf(ctx.now())): BudgetState {
  const limit = projectLimit(ctx, projectId);
  const spent = projectMonthSpend(ctx, projectId, month).costUsd;
  const conns = ctx.db.prepare('SELECT DISTINCT c.id, c.budget_month_usd b FROM model_assignments a JOIN provider_connections c ON c.id = a.connection_id').all() as Array<{ id: string; b: number | null }>;
  const perConn = projectConnectionLimits(ctx, projectId);
  let warn = limit !== null && limit > 0 && spent >= 0.8 * limit;
  let breach: BudgetState['breach'] = limit !== null && limit > 0 && spent >= limit ? { scope: 'project', limitUsd: limit, spentUsd: spent } : null;
  let projectLimitUsd = limit !== null && limit > 0 ? limit : null;
  let monthLimit: number | null = null;
  for (const c of conns) {
    const pl = perConn.get(c.id);
    if (pl !== undefined) {
      projectLimitUsd = projectLimitUsd === null ? pl : Math.min(projectLimitUsd, pl);
      const s = projectConnectionMonthSpend(ctx, projectId, c.id, month).costUsd;
      if (s >= 0.8 * pl) warn = true;
      if (!breach && s >= pl) breach = { scope: 'project', limitUsd: pl, spentUsd: s, connectionId: c.id };
    }
    if (c.b === null || c.b <= 0) continue;
    monthLimit = monthLimit === null ? c.b : Math.min(monthLimit, c.b);
    const s = connectionMonthSpend(ctx, c.id, month).costUsd;
    if (s >= 0.8 * c.b) warn = true;
    if (!breach && s >= c.b) breach = { scope: 'month', limitUsd: c.b, spentUsd: s, connectionId: c.id };
  }
  return { projectLimitUsd, monthLimitUsd: monthLimit, spentMonthUsd: spent, warn80: warn, exceeded: breach !== null, breach };
}

export function budgetCheck(ctx: ServiceContext, projectId: string): void {
  const b = budgetState(ctx, projectId);
  if (!b.breach) return;
  const label = b.breach.connectionId ? (ctx.db.prepare('SELECT label FROM provider_connections WHERE id = ?').get(b.breach.connectionId) as { label: string } | undefined)?.label : undefined;
  throw new EmError('EM-4201', `The AI budget for this ${b.breach.scope} ($${b.breach.limitUsd.toFixed(2)})${label ? ` on ${label}` : ''} is used up. Raise the per-project or monthly budget in Providers to continue.`,
    { status: 422, details: { scope: b.breach.scope, limitUsd: b.breach.limitUsd, spentUsd: b.breach.spentUsd, ...(b.breach.connectionId ? { connectionId: b.breach.connectionId } : {}), ...(label ? { connection: label } : {}) } });
}

/** Writes Usage Records. OpenRouter reports cost; otherwise the Capability Table price gives an approximate cost; otherwise NULL (EM-4203). */
export function recordUsage(ctx: ServiceContext, projectId: string, agent: 'brainstorm' | 'editor', runId: string, usage: readonly ChatUsage[]): void {
  if (!usage.length) return;
  let run = ctx.db.prepare('SELECT connection_id cid, model_id mid FROM agent_runs WHERE id = ?').get(runId) as { cid: string | null; mid: string } | undefined;
  if (!run) {   // runs started by other modules (R-070 agent mode) get a row so usage stays attributable
    const a = ctx.db.prepare('SELECT connection_id cid, model_id mid FROM model_assignments WHERE agent = ?').get(agent) as { cid: string; mid: string } | undefined;
    const now = ctx.now();
    ctx.db.prepare("INSERT INTO agent_runs(id, project_id, agent, connection_id, model_id, status, started_at, finished_at) VALUES (?,?,?,?,?,'done',?,?)").run(runId, projectId, agent, a?.cid ?? null, a?.mid ?? usage[0]!.model, now, now);
    run = { cid: a?.cid ?? null, mid: a?.mid ?? usage[0]!.model };
  }
  const conn = run.cid ? ctx.db.prepare('SELECT provider FROM provider_connections WHERE id = ?').get(run.cid) as { provider: string } | undefined : undefined;
  const prices: PriceTable = {};
  for (const m of (run.cid ? cachedModels(ctx, run.cid) : null) ?? []) if (m.pricePerMInput !== null && m.pricePerMOutput !== null) prices[m.modelId] = { input: m.pricePerMInput, output: m.pricePerMOutput };
  const ins = ctx.db.prepare('INSERT INTO usage_records(agent_run_id, project_id, provider, model_id, input_tokens, output_tokens, cost_usd, approximate, created_at) VALUES (?,?,?,?,?,?,?,?,?)');
  ctx.db.transaction(() => {
    for (const u of usage) {
      const est = u.costUsd === null ? estimateCost(u.model, u.inputTokens, u.outputTokens, prices, { read: u.cacheReadTokens, write: u.cacheWriteTokens }) : { costUsd: u.costUsd, approximate: u.approximate };
      ins.run(runId, projectId, conn?.provider ?? 'unknown', u.model, Math.trunc(u.inputTokens), Math.trunc(u.outputTokens), est.costUsd, est.costUsd === null || est.approximate ? 1 : 0, ctx.now());
    }
  })();
}
