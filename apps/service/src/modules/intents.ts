// Intents R-060…R-064 and plans R-070…R-075 (API_SPECIFICATION §6.7–6.8). Installs hooks.createPlan.
import type { EditPlanT } from '@expertmotion/agents';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { DesignPickInput, ExecuteInput, IntentClearQuery, IntentListQuery, IntentParams, NotesInput, PlanCreateInput, PlanListQuery, PlanParams, ProjectParams, decodeCursor, encodeCursor, planDto } from '../s1/dto.js';
import { s1 } from '../s1/index.js';

export const intentsModule: ServiceModule = {
  name: 'intents',
  start(ctx) {
    const { workflow, store } = s1(ctx);
    ctx.hooks.createPlan = async (projectId, input) => {
      const head = store.head(projectId);
      const mode = input.mode === 'compile' ? 'compile-only' : input.mode ?? 'auto';
      const started = workflow.createPlan(projectId, { intentIds: input.intentIds ?? [], message: input.instruction, baseVersion: head.hash, mode, signal: input.signal, runId: input.runId });
      const plan = await started.done;
      return { ...(plan as unknown as EditPlanT), planId: plan.id, ...(started.runId ? { runId: started.runId } : {}) };
    };
    ctx.hooks.enqueueIntents = (projectId, intents) => workflow.enqueueExternal(projectId, intents);
    workflow.drainHandoffs();
  },
  stop(ctx) { s1(ctx).workflow.stop(); },
  register(router, ctx) {
    const { workflow, store } = s1(ctx);
    // R-060 … R-064
    route(router, 'post', '/projects/:id/intents', { params: ProjectParams, body: DesignPickInput, status: 201 }, ({ params, body }) => workflow.createIntent(params.id, body));
    route(router, 'get', '/projects/:id/intents', { params: ProjectParams, query: IntentListQuery }, ({ params, query }) => { store.projectRow(params.id); return workflow.queueDto(params.id, query); });
    route(router, 'post', '/projects/:id/intents/:intentId/restore', { params: IntentParams }, ({ params }) => { store.projectRow(params.id); return workflow.restoreIntent(params.id, params.intentId); });
    route(router, 'delete', '/projects/:id/intents/:intentId', { params: IntentParams }, ({ params }) => { store.projectRow(params.id); return workflow.removeIntent(params.id, params.intentId); });
    route(router, 'delete', '/projects/:id/intents', { params: ProjectParams, query: IntentClearQuery }, ({ params, query }) => { store.projectRow(params.id); return workflow.clearIntents(params.id, query.status); });
    // R-070 / R-071
    route(router, 'post', '/projects/:id/plans', { params: ProjectParams, body: PlanCreateInput, status: 201 }, ({ params, body, res }) => {
      store.projectRow(params.id);
      const r = workflow.createPlan(params.id, body);
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
      return workflow.execute(params.planId, { confirmDestructive: body.confirmDestructive, idempotencyKey: k });
    });
    route(router, 'post', '/plans/:planId/cancel', { params: PlanParams }, ({ params }) => workflow.cancel(params.planId));
    route(router, 'patch', '/plans/:planId/notes', { params: PlanParams, body: NotesInput }, ({ params, body }) => workflow.setNotes(params.planId, body.notes));
  },
};
