// Composition: R-050…R-056 (API_SPECIFICATION §6.6). Installs hooks.composition and hooks.applyOps.
import { applyOperations, deriveTiming, diffModels, validate, type OperationT } from '@expertmotion/composition-model';
import { EmError } from '@expertmotion/shared';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { CompositionQuery, DiffQuery, PageQuery, ProjectParams, ValidateInput, VersionParams, decodeCursor, encodeCursor, versionDto, type VersionRow } from '../s1/dto.js';
import { s1 } from '../s1/index.js';

export const compositionModule: ServiceModule = {
  name: 'composition',
  start(ctx) {
    const { store } = s1(ctx);
    ctx.hooks.composition = (projectId) => {
      try { const h = store.head(projectId); return { model: h.model, versionId: h.versionId }; } catch (e) {
        if (e instanceof EmError && e.code === 'EM-6101') throw new EmError('EM-9003', 'Not found.', { details: { route: 'composition', id: projectId } });
        throw e;
      }
    };
    ctx.hooks.applyOps = (projectId, ops, source) => store.applyOps(projectId, ops, { cause: source.kind === 'asset' ? 'insert' : 'system' }, source.jobs).version.id;
  },
  register(router, ctx) {
    const { store } = s1(ctx);
    const state = (projectId: string) => ({ canUndo: store.canUndo(projectId), canRedo: store.canRedo(projectId) });
    // R-050
    route(router, 'get', '/projects/:id/composition', { params: ProjectParams, query: CompositionQuery }, ({ params, query }) => {
      const h = store.head(params.id);
      const t = deriveTiming(h.model);
      return { head: versionDto(store.versionRow(params.id, h.versionId), query.model), ...state(params.id), timing: { durationMs: t.durationMs, cutStartMs: t.cutStartMs },
        issues: validate(h.model, { assets: store.facts(params.id), tier: ctx.hooks.tier() }) };
    });
    // R-051
    route(router, 'get', '/projects/:id/composition/versions', { params: ProjectParams, query: PageQuery }, ({ params, query }) => {
      store.projectRow(params.id);
      const c = decodeCursor(query.cursor);
      const rows = (c?.['c'] && c['id']
        ? ctx.db.prepare('SELECT * FROM composition_versions WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?').all(params.id, c['c'], c['c'], c['id'], query.limit + 1)
        : ctx.db.prepare('SELECT * FROM composition_versions WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(params.id, query.limit + 1)) as VersionRow[];
      const page = rows.slice(0, query.limit), last = page[page.length - 1];
      const total = (ctx.db.prepare('SELECT count(*) AS n FROM composition_versions WHERE project_id = ?').get(params.id) as { n: number }).n;
      return { items: page.map((r) => versionDto(r)), nextCursor: rows.length > query.limit && last ? encodeCursor({ c: last.created_at, id: last.id }) : null, total };
    });
    // R-052
    route(router, 'get', '/projects/:id/composition/versions/:versionId', { params: VersionParams }, ({ params }) => { store.projectRow(params.id); return versionDto(store.versionRow(params.id, params.versionId), true); });
    // R-053 / R-054
    // FR-095 / FR-097: settings intents stamped with the undone / redone version move with it (Reset restores the profile too).
    route(router, 'post', '/projects/:id/composition/undo', { params: ProjectParams }, ({ params }) => { const undone = store.head(params.id).hash; const c = store.undo(params.id); s1(ctx).workflow.syncSettingsWithVersion(params.id, 'undo', undone); return { head: c.version, ...state(params.id) }; });
    route(router, 'post', '/projects/:id/composition/redo', { params: ProjectParams }, ({ params }) => { const c = store.redoOnce(params.id); s1(ctx).workflow.syncSettingsWithVersion(params.id, 'redo', store.head(params.id).hash); return { head: c.version, ...state(params.id) }; });
    // R-055
    route(router, 'get', '/projects/:id/composition/diff', { params: ProjectParams, query: DiffQuery }, ({ params, query }) => {
      store.projectRow(params.id);
      const from = store.versionByRef(params.id, query.from), to = store.versionByRef(params.id, query.to);
      const chain: VersionRow[] = []; let cur: VersionRow | undefined = to; let linear = false;
      for (let i = 0; i < 200 && cur; i++) {
        if (cur.id === from.id) { linear = true; break; }
        chain.unshift(cur);
        cur = cur.parent_id ? store.versionRow(params.id, cur.parent_id) : undefined;
      }
      const ops: OperationT[] = [];
      if (linear) for (const v of chain) for (const r of ctx.db.prepare('SELECT op_json FROM operations_history WHERE version_id = ? ORDER BY seq').all(v.id) as Array<{ op_json: string }>) ops.push(JSON.parse(r.op_json) as OperationT);
      return { from: versionDto(from), to: versionDto(to), diff: diffModels(store.parseModel(from), store.parseModel(to)), ops };
    });
    // R-056
    route(router, 'post', '/projects/:id/composition/validate', { params: ProjectParams, body: ValidateInput }, ({ params, body }) => {
      const h = store.head(params.id);
      if (body.baseVersion !== h.hash && body.baseVersion !== h.versionId) throw new EmError('EM-2301', 'The composition changed; validate against the current version.', { details: { baseVersion: body.baseVersion, headVersion: h.hash }, path: 'body.baseVersion' });
      const assets = store.facts(params.id), tier = ctx.hooks.tier();
      const r = applyOperations(h.model, body.ops, { assets, tier, newId: ctx.newId });
      if (!r.ok) return { ok: false, issues: r.issues, predictedDiff: [], predictedDurationMs: deriveTiming(h.model).durationMs };
      const before = new Set(validate(h.model, { assets, tier }).map((i) => `${i.code}|${i.path}|${i.message}`));
      const fresh = validate(r.value.model, { assets, tier }).filter((i) => !before.has(`${i.code}|${i.path}|${i.message}`));
      const issues = [...r.warnings, ...fresh];
      return { ok: !issues.some((i) => i.severity === 'block'), issues, predictedDiff: r.value.diff, predictedDurationMs: deriveTiming(r.value.model).durationMs };
    });
  },
};
