// R-003 restart recovery summary (FR-171, FR-172): what the start-up recovery steps of every module corrected, so the Editor can
// tell the Creator once, in one toast, with links. The modules mark rows during their own start(); this reads those marks back
// (codes EM-3203 / EM-4304 / EM-1201 and plans failed by recovery) within a short window after this Service run began.
import type { ServiceContext } from '../context.js';

export interface RecoverySummary {
  /** This Service run's start; the Editor shows the toast once per value. */
  startedAt: string;
  /** The previous run did not shut down cleanly (running flag left behind). */
  unclean: boolean;
  renders: Array<{ jobId: string; projectId: string }>;
  agentRuns: Array<{ runId: string; projectId: string; agent: string }>;
  ingests: Array<{ assetId: string; projectId: string; name: string }>;
  plans: Array<{ planId: string; projectId: string }>;
  /** Projects whose newest checkpoint is newer than the stored head (offered on open) and checkpoint folders imported as projects. */
  checkpoints: { offered: string[]; imported: string[] };
}

/** Rows touched by start-up recovery carry a timestamp within this window after the run began. */
export const RECOVERY_WINDOW_MS = 60_000;

export function buildRecoverySummary(ctx: ServiceContext, startedAt: string, ck: { unclean: boolean; offered: string[]; imported: string[] }): RecoverySummary {
  const from = startedAt, to = new Date(Date.parse(startedAt) + RECOVERY_WINDOW_MS).toISOString();
  const db = ctx.db;
  const renders = db.prepare("SELECT id AS jobId, project_id AS projectId FROM render_jobs WHERE status = 'failed' AND error_code = 'EM-3203' AND finished_at BETWEEN ? AND ? ORDER BY finished_at")
    .all(from, to) as RecoverySummary['renders'];
  const agentRuns = db.prepare("SELECT id AS runId, project_id AS projectId, agent FROM agent_runs WHERE status = 'cancelled' AND error_code = 'EM-4304' AND finished_at BETWEEN ? AND ? ORDER BY finished_at")
    .all(from, to) as RecoverySummary['agentRuns'];
  const ingests = db.prepare("SELECT id AS assetId, project_id AS projectId, name FROM assets WHERE status = 'failed' AND error_code = 'EM-1201' AND updated_at BETWEEN ? AND ? ORDER BY updated_at")
    .all(from, to) as RecoverySummary['ingests'];
  const plans = db.prepare("SELECT id AS planId, project_id AS projectId FROM edit_plans WHERE status = 'failed' AND updated_at BETWEEN ? AND ? AND instr(plan_json, 'Execute was interrupted') > 0")
    .all(from, to) as RecoverySummary['plans'];
  return { startedAt, unclean: ck.unclean, renders, agentRuns, ingests, plans, checkpoints: { offered: [...ck.offered], imported: [...ck.imported] } };
}
