// Projects, checkpoints, backup/restore, Sample Project: R-010…R-025 (API_SPECIFICATION §6.2–6.3). Installs hooks.headChanged (autosave).
import { EmError } from '@expertmotion/shared';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { BackupInput, CheckpointInput, CheckpointParams, DiskUsageQuery, DuplicateInput, ProjectCreateInput, ProjectDeleteQuery, ProjectListQuery, ProjectParams, ProjectPatchInput, ProjectSettingsInput, RestoreInput, SampleCreateInput } from '../s1/dto.js';
import { recoverOnce, s1 } from '../s1/index.js';
import { buildRecoverySummary, type RecoverySummary } from '../s1/recovery.js';

export const projectsModule: ServiceModule = {
  name: 'projects',
  start(ctx) {
    const r = s1(ctx);
    const prev = ctx.hooks.headChanged;
    ctx.hooks.headChanged = (projectId, versionId) => { r.checkpoints.autosave.touch(projectId); prev(projectId, versionId); };
    // FR-165: checkpoint immediately before a render starts (Execute writes its own pre-execute checkpoint in the workflow).
    ctx.hooks.checkpoint = (projectId, reason) => {
      try { r.checkpoints.autosave.cancel(projectId); r.checkpoints.write(projectId, reason); } catch (e) { ctx.log.warn({ projectId, err: String(e) }, `${reason} checkpoint failed`); }
    };
    recoverOnce(ctx);
  },
  stop(ctx) { s1(ctx).sample.shutdown(); s1(ctx).checkpoints.shutdown(); },
  register(router, ctx) {
    const { projects, store, checkpoints, backups, sample } = s1(ctx);
    // R-010 / R-011 / R-012 (recent before :id)
    route(router, 'get', '/projects', { query: ProjectListQuery }, ({ query }) => projects.list(query));
    route(router, 'post', '/projects', { body: ProjectCreateInput, status: 201 }, ({ body, res }) => {
      const p = projects.create(body); res.setHeader('Location', `/api/v1/projects/${p.id}`);
      sample.removeExcept(p.id);                                           // ONBOARDING_TOUR §2: another project replaces the sample
      return p;
    });
    // R-025 Sample Project (idempotent: 200 with the existing one, 201 when created; media ingests in the background)
    route(router, 'post', '/projects/sample', { body: SampleCreateInput }, async ({ body, res }) => {
      const r = await sample.create(body.language);
      if (r.created) res.setHeader('Location', `/api/v1/projects/${r.project.id}`);
      res.status(r.created ? 201 : 200).json(r.project);
    });
    route(router, 'get', '/projects/recent', {}, () => projects.recent());
    // R-026 disk usage per project + total + free space (FR-178, FR-017 size estimate)
    route(router, 'get', '/projects/disk-usage', { query: DiskUsageQuery }, ({ query }) => projects.diskUsage(query.projectId));
    // R-003 restart recovery summary (FR-171, FR-172); computed once, on the first call after start
    let summary: RecoverySummary | null = null;
    route(router, 'get', '/service/recovery', {}, () => (summary ??= buildRecoverySummary(ctx, checkpoints.bootAt, checkpoints.lastRecovery)));
    // R-021 restore (trusted caller, API §2.3)
    route(router, 'post', '/projects/restore', { body: RestoreInput, status: 202 }, ({ body, req }) => {
      if (req.headers['x-expertmotion-caller'] !== 'shell') throw new EmError('EM-8005', 'Request refused.');
      return { jobId: backups.startRestore(body).jobId };
    });
    // R-013 … R-016
    route(router, 'get', '/projects/:id', { params: ProjectParams }, ({ params }) => store.projectDto(params.id));
    // R-014; isSample:false keeps the sample (is_sample = 0, "Contoh · " / "Sample · " dropped unless a name is given) in one transaction
    route(router, 'patch', '/projects/:id', { params: ProjectParams, body: ProjectPatchInput }, ({ params, body }) => {
      const { isSample, ...rest } = body;
      if (isSample === undefined) return projects.patch(params.id, rest);
      return ctx.db.transaction(() => {
        const name = sample.keep(params.id);
        return projects.patch(params.id, rest.name === undefined && name ? { ...rest, name } : rest);
      })();
    });
    route(router, 'delete', '/projects/:id', { params: ProjectParams, query: ProjectDeleteQuery }, ({ params, query }) => {
      if (query.permanent) projects.deletePermanently(params.id, query.keepOutputs); else projects.softDelete(params.id);
    });
    // R-027 Open dialog thumbnail (JPEG, 204 when the project has none)
    route(router, 'get', '/projects/:id/thumbnail', { params: ProjectParams }, async ({ params, res }) => {
      const file = projects.thumbnailFile(params.id);
      if (!file) return undefined;
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.type(file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : 'image/jpeg');
      await new Promise<void>((resolve, reject) => res.sendFile(file, (err) => (err ? reject(err) : resolve())));
      return undefined;
    });
    route(router, 'post', '/projects/:id/open', { params: ProjectParams }, ({ params }) => {
      const out = projects.open(params.id);
      sample.removeExcept(params.id);
      ctx.hooks.mediaCheck?.(params.id).catch((e: unknown) => ctx.log.warn({ err: String(e) }, 'media check failed'));   // FR-048, async: never delays open
      return out;
    });
    // R-017 / R-018
    route(router, 'get', '/projects/:id/settings', { params: ProjectParams }, ({ params }) => projects.getSettings(params.id));
    route(router, 'put', '/projects/:id/settings', { params: ProjectParams, body: ProjectSettingsInput }, ({ params, body }) => projects.putSettings(params.id, body));
    // R-019 / R-020
    route(router, 'post', '/projects/:id/duplicate', { params: ProjectParams, body: DuplicateInput, status: 201 }, ({ params, body, res }) => {
      const p = projects.duplicate(params.id, body); res.setHeader('Location', `/api/v1/projects/${p.id}`); return p;
    });
    route(router, 'post', '/projects/:id/backup', { params: ProjectParams, body: BackupInput, status: 202 }, ({ params, body }) => ({ jobId: backups.startBackup(params.id, body).jobId }));
    // R-022 … R-024
    route(router, 'get', '/projects/:id/checkpoints', { params: ProjectParams }, ({ params }) => {
      store.projectRow(params.id);
      const items = checkpoints.list(params.id);
      return items.length ? { items } : { items, notice: 'EM-6202' };
    });
    route(router, 'post', '/projects/:id/checkpoints', { params: ProjectParams, body: CheckpointInput, status: 201 }, ({ params }) => {
      store.projectRow(params.id);
      checkpoints.autosave.cancel(params.id);
      return checkpoints.write(params.id, 'manual');
    });
    route(router, 'post', '/projects/:id/checkpoints/:checkpointId/restore', { params: CheckpointParams }, ({ params }) => {
      store.projectRow(params.id);
      return { version: checkpoints.restore(params.id, params.checkpointId).version };
    });
  },
};
