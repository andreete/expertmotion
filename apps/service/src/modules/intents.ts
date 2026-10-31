// Intents R-060…R-064 and plans R-070…R-075 (API_SPECIFICATION §6.7–6.8). Installs hooks.createPlan.
import type { EditPlanT } from '@expertmotion/agents';
import { getPreset } from '@expertmotion/catalogue';
import type { ServiceContext } from '../context.js';
import type { ServiceModule } from './types.js';
import { modelsServiceOf } from '../s2/models-service.js';
import { route } from '../http/route.js';
import { DesignPickInput, ExecuteInput, IntentBatchInput, IntentClearQuery, IntentListQuery, IntentParams, NotesInput, PlanCreateInput, PlanListQuery, PlanParams, ProjectParams, decodeCursor, encodeCursor, planDto } from '../s1/dto.js';
import { s1 } from '../s1/index.js';
import { updateHandoff } from './agents.js';

/** FR-037: where a preset's `model:<id>` flag comes from (the catalogue; tests substitute it, no P0 preset carries one yet). */
export const modelGate = { flagOf: (presetId: string): string | undefined => getPreset(presetId)?.flags.find((f) => f.startsWith('model:')) };
/** FR-037: the `model:<id>` flag of the picked preset when that model is not installed (the pick is then held with EM-2104). */
async function missingModelFor(ctx: ServiceContext, presetId: string | undefined): Promise<string | null> {
  const flag = presetId ? modelGate.flagOf(presetId) : undefined;
  if (!flag) return null;
  const installed = await modelsServiceOf(ctx).installedFlags().catch(() => new Set<string>());
  return installed.has(flag) ? null : flag;
}

export const intentsModule: ServiceModule = {
  name: 'intents',
  start(ctx) {
    const { workflow, store } = s1(ctx);
    ctx.hooks.createPlan = async (projectId, input) => {
      const head = store.head(projectId);
      const mode = input.mode === 'compile' ? 'compile-only' : input.mode ?? 'auto';
      const started = workflow.createPlan(projectId, { intentIds: input.intentIds ?? [], message: input.instruction, baseVersion: head.hash, mode, signal: input.signal, runId: input.runId,
        extras: { selection: input.selection, playheadMs: input.playheadMs, attachments: input.attachments, images: input.images, toolImages: input.toolImages, onDelta: input.onDelta, chat: input.chat, targets: input.targets, onProgress: input.onProgress, onSources: input.onSources } });
      const plan = await started.done;
      return { ...(plan as unknown as EditPlanT), planId: plan.id, ...(started.runId ? { runId: started.runId } : {}) };
    };
    ctx.hooks.enqueueIntents = (projectId, intents) => workflow.enqueueExternal(projectId, intents);
    ctx.hooks.insertIntent = (projectId, ops, meta) => workflow.insertIntent(projectId, ops, meta);       // FR-049
    ctx.hooks.onModelInstalled = (modelFlag) => { workflow.resumeHeld(modelFlag); };                       // FR-037
    workflow.drainHandoffs();
  },
  stop(ctx) { s1(ctx).workflow.stop(); },
  register(router, ctx) {
    const { workflow, store } = s1(ctx);
    // R-060 … R-064
    route(router, 'post', '/projects/:id/intents', { params: ProjectParams, body: DesignPickInput, status: 201 }, async ({ params, body }) => workflow.createIntent(params.id, body, { holdFor: await missingModelFor(ctx, body.presetId) }));
    // R-065: Reset to Defaults and other multi-pick units (one Composition Version, every pick recorded in the queue)
    route(router, 'post', '/projects/:id/intents/batch', { params: ProjectParams, body: IntentBatchInput, status: 201 }, ({ params, body }) => { store.projectRow(params.id); return workflow.createIntentBatch(params.id, { baseVersion: body.baseVersion, picks: body.picks.map((p) => ({ ...p, baseVersion: body.baseVersion })) }); });
    route(router, 'get', '/projects/:id/intents', { params: ProjectParams, query: IntentListQuery }, ({ params, query }) => { store.projectRow(params.id); return workflow.queueDto(params.id, query); });
    route(router, 'post', '/projects/:id/intents/:intentId/restore', { params: IntentParams }, ({ params }) => { store.projectRow(params.id); return workflow.restoreIntent(params.id, params.intentId); });
    route(router, 'delete', '/projects/:id/intents/:intentId', { params: IntentParams }, ({ params }) => { store.projectRow(params.id); return workflow.removeIntent(params.id, params.intentId); });
    route(router, 'delete', '/projects/:id/intents', { params: ProjectParams, query: IntentClearQuery }, ({ params, query }) => { store.projectRow(params.id); return workflow.clearIntents(params.id, query.status); });
    // R-070 / R-071
    route(router, 'post', '/projects/:id/plans', { params: ProjectParams, body: PlanCreateInput, status: 201 }, ({ params, body, res }) => {
      store.projectRow(params.id);
      const { replanOf, ...input } = body;
      const original = replanOf ? replanMessage(ctx, params.id, replanOf) : null;
      const r = workflow.createPlan(params.id, { ...input, ...(original ? { message: original, mode: 'agent' as const } : {}) });
      r.done.catch(() => {});
      if (r.runId) { res.status(202).json({ plan: r.plan, runId: r.runId }); return undefined; }
      res.setHeader('Location', `/api/v1/plans/${r.plan.id}`);
      return r.plan;
    });
    route(router, 'get', '/projects/:id/plans', { params: ProjectParams, query: PlanListQuery }, ({ params, query }) => {
      store.projectRow(params.id);
      const { rows, more } = workflow.listPlans(params.id, query, decodeCursor(query.cursor));
      const last = rows[rows.length - 1];
      return { items: rows.map((r) => planDto(r, { withOps: false })), nextCursor: more && last ? encodeCursor({ c: last.created_at, id: last.id }) : null };
    });
    // R-072 … R-075
    route(router, 'get', '/plans/:planId', { params: PlanParams }, ({ params }) => workflow.planDtoFor(params.planId));
    route(router, 'post', '/plans/:planId/execute', { params: PlanParams, body: ExecuteInput }, ({ params, body, req }) => {
      const key = req.headers['idempotency-key'];
      const k = typeof key === 'string' && key.length > 0 && key.length <= 128 ? key : undefined;
      return workflow.execute(params.planId, { confirmDestructive: body.confirmDestructive, idempotencyKey: k }).then((r) => {
        // FR-219: the Brainstorm draft that produced this plan shows "applied" (its hand-off card follows the Editor run).
        if (r.ok) { const row = ctx.db.prepare('SELECT project_id p, agent_run_id a FROM edit_plans WHERE id = ?').get(params.planId) as { p: string; a: string | null } | undefined; if (row?.a) updateHandoff(ctx, row.p, row.a, 'applied'); }
        return r;
      });
    });
    route(router, 'post', '/plans/:planId/cancel', { params: PlanParams }, ({ params }) => workflow.cancel(params.planId));
    route(router, 'patch', '/plans/:planId/notes', { params: PlanParams, body: NotesInput }, ({ params, body }) => workflow.setNotes(params.planId, body.notes));
  },
};

/** Entry 35: the Creator's own chat message behind a plan (the user message of the plan's agent run), for a re-plan; null when none. */
function replanMessage(ctx: ServiceContext, projectId: string, planId: string): string | null {
  const row = ctx.db.prepare('SELECT agent_run_id a FROM edit_plans WHERE id = ? AND project_id = ?').get(planId, projectId) as { a: string | null } | undefined;
  if (!row?.a) return null;
  const m = ctx.db.prepare("SELECT blocks_json b FROM messages WHERE agent_run_id = ? AND role = 'user' ORDER BY created_at LIMIT 1").get(row.a) as { b: string } | undefined;
  if (!m) return null;
  try {
    const blocks = JSON.parse(m.b) as Array<{ type?: unknown; text?: unknown; instruction?: unknown }>;
    const list = Array.isArray(blocks) ? blocks : [];
    const handoff = list.find((x) => x?.type === 'origin' && typeof x.instruction === 'string')?.instruction as string | undefined;   // a "Kirim ke Editor" hand-off
    const text = handoff ?? list.filter((x) => x?.type === 'text' && typeof x.text === 'string').map((x) => x.text as string).join('\n').trim();
    return text ? text.slice(0, 8000) : null;
  } catch { return null; }
}
