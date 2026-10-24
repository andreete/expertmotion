// FR-048 missing / changed media (ASSET_INGESTION §6): the Project media folder keeps a copy of every original. On project
// open (R-016) and before a render (R-110/R-111) each ready asset's copy is checked: missing → the card and the Timeline
// show the missing state (AssetDto.missing, `service.notice {kind:'media-missing'}`, preflight EM-1301); a copy whose size
// or mtime changed is hashed, and when the hash differs it is re-ingested in place (new sha256, `media-changed` EM-1302).
// Hashing only runs on a size/mtime change, so opening a project never re-reads gigabytes of unchanged media.
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceContext } from '../context.js';
import { listAssets } from './assets-repo.js';
import { emit, isInside } from './common.js';
import { assetDir, hashFile, ingestOf } from './ingest.js';

export interface MediaCheck { missing: string[]; changed: string[] }

export async function checkProjectMedia(ctx: ServiceContext, projectId: string): Promise<MediaCheck> {
  const out: MediaCheck = { missing: [], changed: [] };
  for (const r of listAssets(ctx, projectId)) {
    if (r.status !== 'ready') continue;
    const file = path.resolve(ctx.paths.media, r.original_path);
    if (!isInside(ctx.paths.media, file)) continue;
    let st: fs.Stats;
    try { st = await fs.promises.stat(file); } catch { out.missing.push(r.id); continue; }
    const touchedAfterIngest = st.mtimeMs > Date.parse(r.updated_at) + 2000;
    if (st.size === r.bytes && !touchedAfterIngest) continue;
    let sha: string;
    try { sha = await hashFile(file); } catch { out.missing.push(r.id); continue; }
    if (sha === r.sha256) {
      ctx.db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?').run(ctx.now(), r.id);      // remember the check; mtime is now older
      continue;
    }
    ctx.db.prepare('UPDATE assets SET sha256 = ?, bytes = ?, updated_at = ? WHERE id = ?').run(sha, st.size, ctx.now(), r.id);
    ingestOf(ctx).requeue(r.id);
    out.changed.push(r.id);
    emit(ctx, 'service.notice', { kind: 'media-changed', code: 'EM-1302', projectId, assetId: r.id, name: r.name });
  }
  if (out.missing.length) emit(ctx, 'service.notice', { kind: 'media-missing', code: 'EM-1301', projectId, assetIds: out.missing });
  return out;
}

/** True when the stored original of a ready asset is not on disk (AssetDto.missing). */
export function isMissing(ctx: ServiceContext, r: { status: string; original_path: string }): boolean {
  return r.status === 'ready' && !fs.existsSync(path.resolve(ctx.paths.media, r.original_path));
}

/** FR-050: failed (unsupported) assets stay listed 24 h after they failed, then they and their folder are removed. */
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000;
export function purgeExpiredFailed(ctx: ServiceContext, projectId: string): string[] {
  const cutoff = new Date(Date.parse(ctx.now()) - FAILED_TTL_MS).toISOString();
  const rows = ctx.db.prepare("SELECT id FROM assets WHERE project_id = ? AND status = 'failed' AND updated_at < ?").all(projectId, cutoff) as Array<{ id: string }>;
  for (const { id } of rows) {
    ctx.db.prepare('UPDATE generator_jobs SET result_asset_id = NULL WHERE result_asset_id = ?').run(id);
    ctx.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
    fs.rmSync(assetDir(ctx, projectId, id), { recursive: true, force: true });
  }
  return rows.map((r) => r.id);
}
