// One assistant chat, two modes (Operator decision 2026-10-26; AI_WORKFLOW §10.1): what each agent sees of the other.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, hashModel, type AssetFacts } from '@expertmotion/composition-model';
import { buildDiscussionContext, buildEditsContext, buildRewriteEnvelope, discussionBudgetChars, DISCUSSION_BUDGET_CHARS, DISCUSSION_ITEM_CHARS, prompts, type DiscussionEntry } from '../src/index.js';

const at = (n: number) => `2026-10-26T10:${String(n).padStart(2, '0')}:00.000Z`;
const msg = (n: number, role: 'user' | 'assistant', text: string): DiscussionEntry => ({ role, text, at: at(n) });

describe('Editor Agent discussion (recent Diskusi messages)', () => {
  it('lists the newest first with who said it', () => {
    const d = buildDiscussionContext([msg(1, 'user', 'Ide hook 3 detik?'), msg(2, 'assistant', 'Coba judul besar "HP ini worth it?"'), msg(3, 'user', 'Oke yang itu')])!;
    expect(d.items.map((i) => i.from)).toEqual(['creator', 'brainstorm', 'creator']);
    expect(d.items[0]!.text).toBe('Oke yang itu');
    expect(d.summary).toBeNull();
    expect(d.omitted).toBe(0);
  });
  it('stays within the token budget, clips long messages and summarises the rest', () => {
    const long = 'kata '.repeat(800);
    const entries = Array.from({ length: 30 }, (_, i) => msg(i, i % 2 ? 'assistant' : 'user', `${i}: ${long}`));
    const d = buildDiscussionContext(entries, 3000)!;
    const size = d.items.reduce((s, i) => s + i.text.length + 20, 0);
    expect(size).toBeLessThanOrEqual(3000);
    expect(d.items.every((i) => i.text.length <= DISCUSSION_ITEM_CHARS)).toBe(true);
    expect(d.items[0]!.text.startsWith('29:')).toBe(true);                       // newest first
    expect(d.items[0]!.text.endsWith('…')).toBe(true);
    expect(d.omitted).toBe(30 - d.items.length);
    expect(d.summary).toMatch(/older message\(s\) left out; the Creator had asked/);
    expect(JSON.stringify(d).length).toBeLessThan(3000 + 600);
  });
  it('keeps the newest message even when it alone is over the budget; empty input → null', () => {
    const d = buildDiscussionContext([msg(1, 'user', 'x'.repeat(5000))], 500)!;
    expect(d.items).toHaveLength(1);
    expect(d.items[0]!.text.length).toBeLessThanOrEqual(500);
    expect(buildDiscussionContext([])).toBeNull();
    expect(buildDiscussionContext([msg(1, 'user', '   ')])).toBeNull();
  });
  it('budget follows the model context (10 %, 1 000…4 000 chars)', () => {
    expect(discussionBudgetChars(null)).toBe(DISCUSSION_BUDGET_CHARS);
    expect(discussionBudgetChars(4000)).toBe(1600);
    expect(discussionBudgetChars(1000)).toBe(1000);
    expect(discussionBudgetChars(200_000)).toBe(4000);
  });
  it('goes into the Rewrite envelope with a data-only constraint, and the Editor prompt explains it', () => {
    const assets: AssetFacts[] = [{ id: 'a1', kind: 'video', status: 'ready', durationMs: 5000, name: 'a.mp4' }];
    let n = 0;
    const r = applyOperations(createEmptyModel('p1', { autoRatio: false }), [{ op: 'op:clip.insert', args: { assetId: 'a1' } }], { assets, tier: 'T1', newId: () => `e${++n}` });
    if (!r.ok) throw new Error('fixture');
    const model = r.value.model;
    const discussion = buildDiscussionContext([msg(1, 'assistant', 'Pakai transisi slide')]);
    const env = buildRewriteEnvelope({ model, baseVersion: hashModel(model), assets, intents: [], lockedKeys: [], tier: 'T1', creatorMessage: 'kerjakan yang tadi', discussion });
    expect(env.discussion?.items[0]).toEqual({ from: 'brainstorm', text: 'Pakai transisi slide' });
    expect(env.constraints.some((c) => c.startsWith('discussion is earlier chat'))).toBe(true);
    const none = buildRewriteEnvelope({ model, baseVersion: hashModel(model), assets, intents: [], lockedKeys: [], tier: 'T1', discussion: null });
    expect(none.discussion).toBeUndefined();
    expect(none.constraints.some((c) => c.startsWith('discussion'))).toBe(false);
    expect(prompts().EDITOR_SYSTEM).toContain('discussion');
    expect(prompts().BRAINSTORM_SYSTEM).toContain('recentEdits');
  });
});

describe('Brainstorming Agent recentEdits (what the Editor changed)', () => {
  it('newest first with applied / undone / cancelled and change counts', () => {
    const e = buildEditsContext([
      { goal: 'Tambah transisi fade', status: 'executed', at: at(1), origin: 'editor-agent', undone: true, changes: { added: 2, modified: 0, removed: 0 } },
      { goal: 'Caption editorial', status: 'executed', at: at(3), origin: 'compile', changes: { added: 1, modified: 1, removed: 0 } },
      { goal: 'Judul pembuka', status: 'cancelled', at: at(2), origin: 'editor-agent' },
      { goal: '   ', status: 'executed', at: at(4), origin: 'compile' },
    ])!;
    expect(e.items).toEqual([
      { goal: 'Caption editorial', status: 'applied', by: 'picks', changes: '1 added, 1 modified' },
      { goal: 'Judul pembuka', status: 'cancelled', by: 'editor' },
      { goal: 'Tambah transisi fade', status: 'undone', by: 'editor', changes: '2 added' },
    ]);
    expect(buildEditsContext([])).toBeNull();
  });
  it('is capped by count and by the character budget', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ goal: `Perubahan ${i} ${'x'.repeat(150)}`, status: 'executed', at: at(i), origin: 'editor-agent' as const }));
    const e = buildEditsContext(many, 600)!;
    expect(JSON.stringify(e.items).length).toBeLessThanOrEqual(600 + 200);
    expect(e.items.length).toBeGreaterThan(0);
    expect(e.items.length).toBeLessThan(8);
    expect(e.omitted).toBe(20 - e.items.length);
    expect(buildEditsContext(many.map((m) => ({ ...m, goal: m.goal.slice(0, 14) })))!.items).toHaveLength(8);   // EDITS_MAX_ITEMS
  });
});
