// Shared context between the Brainstorming and Editor Agents (one assistant chat, two modes; AI_WORKFLOW §10.1). This file
// only reads rows; packages/agents (buildDiscussionContext / buildEditsContext) decides what fits the token budget.
import { buildDiscussionContext, buildEditsContext, discussionBudgetChars, type DiscussionContext, type DiscussionEntry, type EditEntry, type EditsContext } from '@expertmotion/agents';
import { stripToolMarkup } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';

type Block = { type: string; text?: string; intents?: unknown[]; handoffState?: string };

/** Text of a stored message as the other agent sees it: text blocks, proposed changes as a count. */
export function messageText(blocksJson: string): string {
  let blocks: Block[] = [];
  try { blocks = JSON.parse(blocksJson) as Block[]; } catch { return ''; }
  if (!Array.isArray(blocks)) return '';
  return blocks.flatMap((b) => (b && b.type === 'text' && typeof b.text === 'string' ? [stripToolMarkup(b.text)]
    : b && b.type === 'proposed_intents' && Array.isArray(b.intents) ? [`(proposed ${b.intents.length} change(s); ${b.handoffState ?? 'pending'})`] : [])).join('\n').trim();
}

/** The Editor Agent's `discussion`: the newest Brainstorming messages of the project (at most 40 read). */
export function discussionFor(ctx: ServiceContext, projectId: string, contextLength?: number | null): DiscussionContext | null {
  try {
    const conv = ctx.db.prepare("SELECT id FROM conversations WHERE project_id = ? AND agent = 'brainstorm'").get(projectId) as { id: string } | undefined;
    if (!conv) return null;
    const rows = ctx.db.prepare("SELECT role, blocks_json, created_at FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC, id DESC LIMIT 40")
      .all(conv.id) as Array<{ role: 'user' | 'assistant'; blocks_json: string; created_at: string }>;
    const entries: DiscussionEntry[] = rows.map((r) => ({ role: r.role, text: messageText(r.blocks_json), at: r.created_at }));
    return buildDiscussionContext(entries, discussionBudgetChars(contextLength));
  } catch (e) { ctx.log.warn({ projectId, err: String(e) }, 'discussion context unavailable'); return null; }
}

/** Hashes of the head and its parent chain: an executed plan whose version left it was undone (FR-167). */
function lineageHashes(ctx: ServiceContext, projectId: string): Set<string> | null {
  try {
    const head = ctx.hooks.composition(projectId);
    const rows = ctx.db.prepare(`WITH RECURSIVE chain(id, parent_id, hash, depth) AS (
        SELECT id, parent_id, hash, 0 FROM composition_versions WHERE id = ? AND project_id = ?
        UNION ALL SELECT v.id, v.parent_id, v.hash, c.depth + 1 FROM composition_versions v JOIN chain c ON v.id = c.parent_id WHERE c.depth < 5000)
      SELECT hash FROM chain`).all(head.versionId, projectId) as Array<{ hash: string }>;
    return new Set(rows.map((r) => r.hash));
  } catch { return null; }
}

/** The Brainstorming Agent's `recentEdits`: the newest Edit Plans (not drafts), applied / undone / cancelled / failed / proposed. */
export function recentEditsFor(ctx: ServiceContext, projectId: string): EditsContext | null {
  try {
    const rows = ctx.db.prepare("SELECT origin, status, plan_json, result_json, updated_at FROM edit_plans WHERE project_id = ? AND status IN ('executed','cancelled','failed','invalid','valid') ORDER BY updated_at DESC LIMIT 20")
      .all(projectId) as Array<{ origin: 'compile' | 'editor-agent'; status: string; plan_json: string; result_json: string | null; updated_at: string }>;
    if (!rows.length) return null;
    const live = rows.some((r) => r.status === 'executed') ? lineageHashes(ctx, projectId) : null;
    const entries: EditEntry[] = rows.map((r) => {
      const plan = JSON.parse(r.plan_json) as { goal?: string };
      const result = r.result_json ? JSON.parse(r.result_json) as { toVersion?: string; diff?: Array<{ change?: string }> } : null;
      const n = (c: string) => (result?.diff ?? []).filter((d) => d.change === c).length;
      return { goal: plan.goal ?? '', status: r.status, at: r.updated_at, origin: r.origin,
        ...(r.status === 'executed' && result?.toVersion && live ? { undone: !live.has(result.toVersion) } : {}),
        ...(result?.diff ? { changes: { added: n('added'), modified: n('modified'), removed: n('removed') } } : {}) };
    });
    return buildEditsContext(entries);
  } catch (e) { ctx.log.warn({ projectId, err: String(e) }, 'recent edits unavailable'); return null; }
}
