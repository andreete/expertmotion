// Shared context between the two runtime agents (Operator decision 2026-10-26: one assistant chat, two modes; AI_WORKFLOW
// §10.1, AGENT_DESIGN §2.3). Pure and deterministic: the Local Service reads the rows, these helpers decide what fits.
//  - The Editor Agent's envelope gets `discussion`: the recent Brainstorming ("Diskusi") messages, newest first, each clipped,
//    within a character budget; what does not fit is summarised in one line, so "do what we discussed" works.
//  - The Brainstorming Agent's CONTEXT gets `recentEdits`: what the Editor changed (plan goals, applied / undone / cancelled),
//    newest first, within its own budget.
// Both blocks are data, never instructions (the prompts say so; ADR-002: the LLM never enforces invariants).

/** One stored chat message as the shared context sees it (text blocks only; proposals as a count). */
export interface DiscussionEntry { role: 'user' | 'assistant'; text: string; at: string }
export interface DiscussionContext {
  /** Newest first. `role` = who said it ("creator" / "brainstorm"). */
  items: Array<{ from: 'creator' | 'brainstorm'; text: string }>;
  /** One line about the older messages that did not fit (null when everything fits). */
  summary: string | null;
  /** Messages left out of `items` (summarised). */
  omitted: number;
}

/** ≈ 1 000 tokens: the Rewrite envelope keeps its ≤ ~4k-token composition (AI_WORKFLOW §7) plus this. */
export const DISCUSSION_BUDGET_CHARS = 4000;
/** ≈ 400 tokens for the Brainstorming Agent's `recentEdits`. */
export const EDITS_BUDGET_CHARS = 1600;
/** Longest single message kept in `discussion` (longer ones are clipped with "…"). */
export const DISCUSSION_ITEM_CHARS = 900;
/** Messages looked at at most (older ones are only counted). */
export const DISCUSSION_MAX_ITEMS = 12;
export const EDITS_MAX_ITEMS = 8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1)).trimEnd()}…` : s);
const squash = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * Recent Diskusi messages for the Editor Agent: newest first; each ≤ DISCUSSION_ITEM_CHARS; the total ≤ `budgetChars`
 * (the newest message is always kept, clipped to the budget). Older messages are summarised as the Creator's asks.
 * Returns null when there is nothing to share.
 */
export function buildDiscussionContext(entries: readonly DiscussionEntry[], budgetChars = DISCUSSION_BUDGET_CHARS): DiscussionContext | null {
  const msgs = entries.map((e) => ({ ...e, text: squash(e.text) })).filter((e) => e.text);
  if (!msgs.length) return null;
  const newestFirst = [...msgs].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const items: DiscussionContext['items'] = [];
  let used = 0; let i = 0;
  for (; i < newestFirst.length && items.length < DISCUSSION_MAX_ITEMS; i++) {
    const m = newestFirst[i]!;
    const room = budgetChars - used;
    const text = clip(m.text, Math.min(DISCUSSION_ITEM_CHARS, items.length ? room : Math.max(80, room)));
    if (items.length && text.length + 20 > room) break;
    items.push({ from: m.role === 'user' ? 'creator' : 'brainstorm', text });
    used += text.length + 20;                                   // + the JSON keys around it
  }
  const rest = newestFirst.slice(i);
  let summary: string | null = null;
  if (rest.length) {
    const asks = rest.filter((m) => m.role === 'user').slice(0, 4).map((m) => `“${clip(m.text.replace(/\s+/g, ' '), 80)}”`);
    summary = clip(`${rest.length} older message(s) left out${asks.length ? `; the Creator had asked: ${asks.join('; ')}` : ''}.`, Math.max(120, Math.min(400, budgetChars - used)));
  }
  return { items, summary, omitted: rest.length };
}

/** One Edit Plan as the Brainstorming Agent sees it. */
export interface EditEntry {
  goal: string; status: string; at: string;
  /** compile = deterministic picks; editor-agent = a chat or queue request. */
  origin: 'compile' | 'editor-agent';
  /** Executed, but its version is no longer in the head's lineage (Undo). */
  undone?: boolean;
  /** "3 added, 1 modified" style counts from the execution result. */
  changes?: { added: number; modified: number; removed: number } | null;
}
export interface EditsContext { items: Array<{ goal: string; status: 'applied' | 'undone' | 'cancelled' | 'failed' | 'proposed'; by: 'picks' | 'editor'; changes?: string }>; omitted: number }

const statusOf = (e: EditEntry): EditsContext['items'][number]['status'] =>
  e.status === 'executed' ? (e.undone ? 'undone' : 'applied') : e.status === 'cancelled' ? 'cancelled' : e.status === 'failed' || e.status === 'invalid' ? 'failed' : 'proposed';

/** Recent Edit actions for the Brainstorming Agent: newest first, ≤ EDITS_MAX_ITEMS and ≤ `budgetChars`. Null when none. */
export function buildEditsContext(entries: readonly EditEntry[], budgetChars = EDITS_BUDGET_CHARS): EditsContext | null {
  const sorted = entries.filter((e) => e.goal.trim()).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  if (!sorted.length) return null;
  const items: EditsContext['items'] = []; let used = 0;
  for (const e of sorted) {
    if (items.length >= EDITS_MAX_ITEMS) break;
    const c = e.changes ? (['added', 'modified', 'removed'] as const).filter((k) => e.changes![k] > 0).map((k) => `${e.changes![k]} ${k}`).join(', ') : '';
    const item = { goal: clip(squash(e.goal), 160), status: statusOf(e), by: e.origin === 'compile' ? 'picks' as const : 'editor' as const, ...(c ? { changes: c } : {}) };
    const size = JSON.stringify(item).length;
    if (items.length && used + size > budgetChars) break;
    items.push(item); used += size;
  }
  return { items, omitted: sorted.length - items.length };
}

/** The `discussion` budget for the Editor Agent's model: 10 % of its context (≈ 4 chars per token), 1 000…4 000 chars. */
export function discussionBudgetChars(contextLength: number | null | undefined): number {
  if (!contextLength || contextLength <= 0) return DISCUSSION_BUDGET_CHARS;
  return Math.max(1000, Math.min(DISCUSSION_BUDGET_CHARS, Math.floor(contextLength * 4 * 0.1)));
}
