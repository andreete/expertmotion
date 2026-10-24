// Data retention housekeeping at start (FR-175, DATABASE_SCHEMA §8). Checkpoints (20 per project) are pruned on write and logs
// (7 days) by the logger; this covers the two time-based rules that have no other owner:
//  - generator results that were never inserted into the composition: 7 days after the job finished (row + result asset when no
//    Composition Version of the project references it);
//  - Usage Records: 12 months.
// Outputs, diagnostics bundles and conversations are kept until the Creator deletes them (or the project).
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceContext } from '../context.js';

export const GENERATED_RESULT_TTL_MS = 7 * 24 * 3_600_000;
export const USAGE_RETENTION_MONTHS = 12;
const ASSET_FILE_COLS = ['original_path', 'playable_path', 'proxy_path', 'thumb_path', 'filmstrip_path', 'waveform_path'] as const;

export interface RetentionResult { generatorJobs: number; assets: number; usageRecords: number }

export function purgeRetention(ctx: ServiceContext, nowMs: number = Date.now()): RetentionResult {
  const db = ctx.db;
  const out: RetentionResult = { generatorJobs: 0, assets: 0, usageRecords: 0 };
  const cutoff = new Date(nowMs - GENERATED_RESULT_TTL_MS).toISOString();
  const jobs = db.prepare("SELECT id, project_id, result_asset_id, result_json FROM generator_jobs WHERE status = 'done' AND finished_at IS NOT NULL AND finished_at < ?")
    .all(cutoff) as Array<{ id: string; project_id: string; result_asset_id: string | null; result_json: string | null }>;
  const files: string[] = [];
  for (const j of jobs) {
    let inserted = false;
    try { inserted = typeof (JSON.parse(j.result_json ?? '{}') as Record<string, unknown>)['versionId'] === 'string'; } catch { /* unreadable result: not inserted */ }
    if (inserted) continue;
    try {
      db.transaction(() => {
        db.prepare('DELETE FROM generator_jobs WHERE id = ?').run(j.id);
        out.generatorJobs++;
        if (!j.result_asset_id) return;
        const used = db.prepare("SELECT 1 FROM composition_versions WHERE project_id = ? AND instr(model_json, ?) > 0 LIMIT 1").get(j.project_id, `"${j.result_asset_id}"`);
        const other = db.prepare('SELECT 1 FROM generator_jobs WHERE result_asset_id = ? LIMIT 1').get(j.result_asset_id);
        if (used || other) return;
        const a = db.prepare(`SELECT ${ASSET_FILE_COLS.join(', ')} FROM assets WHERE id = ? AND project_id = ?`).get(j.result_asset_id, j.project_id) as Record<string, string | null> | undefined;
        if (!a) return;
        db.prepare('DELETE FROM assets WHERE id = ?').run(j.result_asset_id);
        out.assets++;
        for (const c of ASSET_FILE_COLS) if (a[c]) files.push(a[c]!);
      })();
    } catch (e) { ctx.log.warn({ jobId: j.id, err: String(e) }, 'retention: generator result purge failed'); }
  }
  const root = path.resolve(ctx.paths.media);
  for (const rel of files) {
    const abs = path.resolve(root, rel);
    if (abs.startsWith(root + path.sep)) { try { fs.rmSync(abs, { force: true, recursive: true }); } catch { /* ignore */ } }
  }
  const d = new Date(nowMs); d.setUTCMonth(d.getUTCMonth() - USAGE_RETENTION_MONTHS);
  try { out.usageRecords = db.prepare('DELETE FROM usage_records WHERE created_at < ?').run(d.toISOString()).changes; } catch (e) { ctx.log.warn({ err: String(e) }, 'retention: usage purge failed'); }
  if (out.generatorJobs || out.usageRecords) ctx.log.info({ ...out }, 'retention housekeeping');
  return out;
}
