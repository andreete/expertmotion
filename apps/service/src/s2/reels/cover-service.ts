// Cover still (FR-289, R-153 `POST /projects/:id/cover`): a 1080x1920 JPG of a one-still cover Composition Model — built by the
// composer (`ctx.hooks.composeCover(spec, analysis, masterAssetId)`, packages/agents) or supplied as `model` (tests) — rendered
// with the Engine (renderStill, JPEG q92) and saved as an Output `kind: 'still'` named `<project>-cover.jpg` in the output folder.
import fs from 'node:fs';
import path from 'node:path';
import { composeCover } from '@expertmotion/agents';
import { CompositionModel, type CompositionModelT } from '@expertmotion/composition-model';
import { sanitizeFilename } from '@expertmotion/shared';
import type { ServiceContext } from '../../context.js';
import { em, parseOrThrow } from '../common.js';
import { generatorsServiceOf } from '../generators-service.js';
import { defaultOutputFolder, getOutput, outputRelPath, profileDims, toOutputDto, type OutputProfileT } from '../render-repo.js';
import { latestAnalysis } from './footage-prep.js';

export interface CoverSpec { cutId?: string | undefined; atMs?: number | undefined; hookWord: string; kicker?: string | undefined; line: string; subline?: string | undefined; pills?: Array<{ text: string; tone?: string | undefined }> | undefined; icons?: string[] | undefined; source?: string | undefined; handle?: string | undefined;
  /** plan step `cover.render`: the master to take the face frame from (default: the analysis' master). */ masterAssetId?: string | undefined }

/** Where a still Output goes: the project's own folder (R-018 `outputFolder`), the app setting, else the default folder. */
export function stillFolder(ctx: ServiceContext, projectId: string): string {
  let project: string | undefined;
  try { const r = ctx.db.prepare("SELECT json_extract(settings_json, '$.outputFolder') AS f FROM projects WHERE id = ?").get(projectId) as { f: unknown } | undefined; project = typeof r?.f === 'string' && r.f ? r.f : undefined; } catch { /* none */ }
  const chosen = project ?? ctx.settings.get().outputFolder;
  const folder = chosen ? path.resolve(chosen) : defaultOutputFolder(ctx, projectId);
  try { fs.mkdirSync(folder, { recursive: true }); fs.accessSync(folder, fs.constants.W_OK); } catch { throw em('EM-3206', 'Expertmotion cannot save files in this folder.', { details: { folder: path.basename(folder) } }); }
  return folder;
}

/** Records a still file as an Output (with a synthetic `done` Render Job row, like R-136) and returns the OutputDto. */
export function recordStillOutput(ctx: ServiceContext, projectId: string, file: string, profile: Record<string, unknown>, versionId: string, dims: { width: number | null; height: number | null }): Record<string, unknown> {
  const jobId = ctx.newId(); const outputId = ctx.newId(); const at = ctx.now();
  ctx.db.transaction(() => {
    ctx.db.prepare("INSERT INTO render_jobs (id, project_id, version_id, output_profile_json, performance_profile, status, progress, created_at, started_at, finished_at) VALUES (?,?,?,?,'standard','done',1,?,?,?)")
      .run(jobId, projectId, versionId, JSON.stringify(profile), at, at, at);
    ctx.db.prepare(`INSERT INTO outputs (id, project_id, render_job_id, path, thumb_path, kind, bytes, width, height, fps, duration_ms, validated, watermarked, created_at)
      VALUES (?,?,?,?,NULL,'still',?,?,?,NULL,NULL,1,0,?)`).run(outputId, projectId, jobId, outputRelPath(ctx, file), fs.statSync(file).size, dims.width, dims.height, at);
    ctx.db.prepare('UPDATE render_jobs SET output_id = ? WHERE id = ?').run(outputId, jobId);
  })();
  return toOutputDto(ctx, getOutput(ctx, outputId)!);
}

/** R-153 and the plan step `cover.render` share this: spec (+ optional model) → one JPEG still saved as an Output. */
export async function renderCover(ctx: ServiceContext, projectId: string, body: CoverSpec & { model?: unknown }, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const analysis = latestAnalysis(ctx, projectId);
  let model: CompositionModelT;
  if (body.model !== undefined) model = parseOrThrow(CompositionModel, body.model, 'body.model');
  else {
    const master = body.masterAssetId ?? analysis?.masterAssetId;
    if (!analysis || !master) throw em('EM-9003', 'No analysed footage in this project; run the footage prep first.');
    const { model: _m, masterAssetId: _a, ...spec } = body;
    const atMs = spec.atMs ?? (spec.cutId ? analysis.cuts.find((c) => c.id === spec.cutId)?.startMs : undefined) ?? analysis.cuts[0]?.startMs ?? 0;
    // the composer's one-still cover model (packages/agents auto-motion-reels.ts) from the spec, the cuts and the master's facts
    model = composeCover({ ...spec, atMs, hookWord: spec.hookWord || '—', line: spec.line || ' ', handle: spec.handle ?? '' } as Parameters<typeof composeCover>[0], analysis, master, ctx.hooks.assetFacts(projectId));
  }
  const svc = generatorsServiceOf(ctx);
  const tmpDir = path.join(ctx.paths.tmp, `cover-${ctx.newId()}`); fs.mkdirSync(tmpDir, { recursive: true });
  const tmp = path.join(tmpDir, 'cover.jpg');
  try {
    await svc.renderStill(projectId, model, 0, tmp, 'jpeg', signal);
    const folder = stillFolder(ctx, projectId);
    const project = ctx.db.prepare('SELECT name FROM projects WHERE id = ?').get(projectId) as { name: string } | undefined;
    const stem = sanitizeFilename(`${project?.name ?? 'video'}-cover`, 'cover');
    let file = path.join(folder, `${stem}.jpg`);
    for (let i = 2; fs.existsSync(file); i++) file = path.join(folder, `${stem}-${i}.jpg`);
    fs.copyFileSync(tmp, file);
    const versionId = ctx.hooks.composition(projectId).versionId;
    const profile = { ...model.settings, format: 'jpg', codec: 'jpg', alpha: false, stillAtMs: 0 };
    let dims: { width: number | null; height: number | null } = { width: null, height: null };
    try { dims = profileDims(profile as unknown as OutputProfileT); } catch { /* custom ratio without sizes */ }
    const output = recordStillOutput(ctx, projectId, file, profile, versionId, dims);
    return { ...output, analysisId: analysis?.id ?? null };
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
}
