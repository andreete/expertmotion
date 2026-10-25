import { describe, expect, it } from 'vitest';
import { nameHint, rankForTiers, recommendedFor, resolveModelTiers, tierCandidates, tierOfModel, type TierCapabilityRow } from '../src/index.js';

const row = (modelId: string, o: Partial<TierCapabilityRow> = {}): TierCapabilityRow => ({
  modelId, label: modelId, contextLength: 128_000, toolCalling: true, structuredOutput: true, imageInput: true, pricePerMInput: 1, pricePerMOutput: 1, ...o,
});

describe('LLM model tiers (FR-115)', () => {
  it('Fast = cheapest, Best = most expensive, Balanced = middle of the JSON-capable rows', () => {
    const rows = [row('mid', { pricePerMInput: 0.4, pricePerMOutput: 1.6 }), row('top', { pricePerMInput: 3, pricePerMOutput: 15 }), row('cheap', { pricePerMInput: 0.04, pricePerMOutput: 0.1 }),
      row('nojson', { structuredOutput: false, pricePerMInput: 0, pricePerMOutput: 0 }), row('unknown', { structuredOutput: null, pricePerMInput: 0.01, pricePerMOutput: 0.01 })];
    expect(resolveModelTiers(rows)).toEqual({ fast: 'cheap', balanced: 'mid', best: 'top' });
  });
  it('is deterministic and independent of input order', () => {
    const rows = [row('a', { pricePerMInput: 1, pricePerMOutput: 2 }), row('b', { pricePerMInput: 2, pricePerMOutput: 2 }), row('c', { pricePerMInput: 5, pricePerMOutput: 5 }), row('d', { pricePerMInput: 9, pricePerMOutput: 9 })];
    const r1 = resolveModelTiers(rows); const r2 = resolveModelTiers([...rows].reverse());
    expect(r1).toEqual(r2);
    expect(r1).toEqual({ fast: 'a', balanced: 'b', best: 'd' });
  });
  it('falls back to rows not known to fail when the provider reports no capability facts, ranked by name', () => {
    const anthropic = ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-sonnet-4', 'claude-3-5-haiku'].map((id) =>
      row(id, { structuredOutput: null, toolCalling: null, imageInput: null, contextLength: null, pricePerMInput: null, pricePerMOutput: null }));
    expect(resolveModelTiers(anthropic)).toEqual({ fast: 'claude-haiku-4-5', balanced: 'claude-sonnet-4-5', best: 'claude-opus-4-1' });
    expect(nameHint(row('gemini-2.5-flash-lite'))).toBe(0);
    expect(nameHint(row('gemini-2.5-flash'))).toBe(1);
    expect(nameHint(row('gemini-2.5-pro'))).toBe(3);
  });
  it('prefers rows that fit the agent, and drops :free variants when a paid one exists', () => {
    const rows = [row('vision', { toolCalling: false, pricePerMInput: 1, pricePerMOutput: 1 }), row('tools', { imageInput: false, pricePerMInput: 2, pricePerMOutput: 2 }), row('x:free', { pricePerMInput: 0, pricePerMOutput: 0 })];
    expect(tierCandidates(rows, 'editor').map((r) => r.modelId)).toEqual(['tools']);
    expect(tierCandidates(rows, 'brainstorm').map((r) => r.modelId)).toEqual(['vision']);
    expect(tierCandidates([row('only:free')]).map((r) => r.modelId)).toEqual(['only:free']);
    expect(recommendedFor(rows[1]!)).toEqual(['editor']);
  });
  it('an empty or JSON-incapable table resolves to no model; one row gives every tier that model', () => {
    expect(resolveModelTiers([])).toEqual({ fast: null, balanced: null, best: null });
    expect(resolveModelTiers([row('n', { structuredOutput: false })])).toEqual({ fast: null, balanced: null, best: null });
    expect(resolveModelTiers([row('one')])).toEqual({ fast: 'one', balanced: 'one', best: 'one' });
  });
  it('tierOfModel maps a stored id back to its tier, or null for an Advanced pick', () => {
    const rows = [row('cheap', { pricePerMInput: 0.1, pricePerMOutput: 0.1 }), row('mid'), row('top', { pricePerMInput: 9, pricePerMOutput: 9 }), row('other', { structuredOutput: false })];
    expect(tierOfModel(rows, 'cheap')).toBe('fast');
    expect(tierOfModel(rows, 'mid')).toBe('balanced');
    expect(tierOfModel(rows, 'top')).toBe('best');
    expect(tierOfModel(rows, 'other')).toBeNull();
    expect(tierOfModel(rows, null)).toBeNull();
    expect(tierOfModel([row('one')], 'one')).toBe('balanced');
    expect(rankForTiers(rows.slice(0, 3)).map((r) => r.modelId)).toEqual(['cheap', 'mid', 'top']);
  });
});
