// ADR-040 prompt caching: the runner puts every per-call part of a system prompt after SYSTEM_DYNAMIC_MARK so the prefix is
// byte-identical between calls; the OpenRouter message mapping adds Anthropic-style cache breakpoints; the cost estimate prices
// cache reads and writes.
import { describe, expect, it } from 'vitest';
import { estimateCost, fakeProvider, joinSystem, openRouterCaches, splitSystem, SYSTEM_DYNAMIC_MARK, toSdkMessagesWithSystem } from '../src/providers.js';
import { editorSystemPrompt, editorSystemTail, runBrainstorm } from '../src/runner.js';
import type { RewriteEnvelope } from '../src/envelope.js';

describe('splitSystem / joinSystem', () => {
  it('separates the stable prefix from the tail and joins without the marker', () => {
    const s = `A${SYSTEM_DYNAMIC_MARK}B`;
    expect(splitSystem(s)).toEqual({ stable: 'A', dynamic: 'B' });
    expect(splitSystem('A')).toEqual({ stable: 'A', dynamic: null });
    expect(splitSystem(`A${SYSTEM_DYNAMIC_MARK}  `)).toEqual({ stable: 'A', dynamic: null });
    expect(joinSystem(s)).toBe('A\n\nB');
    expect(joinSystem('A')).toBe('A');
  });
});

describe('estimateCost with cache counters', () => {
  const prices = { m: { input: 3, output: 15 } };
  it('prices cache reads at 0.1× and writes at 1.25× of the input price; plain tokens are the rest', () => {
    expect(estimateCost('m', 1000, 100, prices).costUsd).toBeCloseTo((1000 * 3 + 100 * 15) / 1e6, 12);
    // 1000 prompt tokens: 700 read from cache, 100 written, 200 plain
    const c = estimateCost('m', 1000, 100, prices, { read: 700, write: 100 }).costUsd!;
    expect(c).toBeCloseTo(((200 + 70 + 125) * 3 + 100 * 15) / 1e6, 12);
    expect(c).toBeLessThan(estimateCost('m', 1000, 100, prices).costUsd!);
    expect(estimateCost('m', 1000, 100, undefined, { read: 700 })).toEqual({ costUsd: null, approximate: true });
  });
});

describe('toSdkMessagesWithSystem (OpenRouter)', () => {
  const req = { system: `stable${SYSTEM_DYNAMIC_MARK}tail`, messages: [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: 'b' }, { role: 'user' as const, content: 'c' }] };
  it('caching model families: breakpoint on the stable system message and on the last message; the tail is a second system message', () => {
    expect(openRouterCaches('anthropic/claude-sonnet-5-5')).toBe(true);
    expect(openRouterCaches('google/gemini-2.5-pro')).toBe(true);
    expect(openRouterCaches('openai/gpt-5')).toBe(false);
    const m = toSdkMessagesWithSystem(req, 'anthropic/claude-sonnet-5-5') as Array<Record<string, unknown>>;
    expect(m[0]).toEqual({ role: 'system', content: 'stable', providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } } });
    expect(m[1]).toEqual({ role: 'system', content: 'tail' });
    expect(m[4]).toMatchObject({ role: 'user', content: 'c', providerOptions: { openrouter: { cacheControl: { type: 'ephemeral' } } } });
    expect(m[2]).not.toHaveProperty('providerOptions');
  });
  it('other models: plain system messages, no provider options', () => {
    const m = toSdkMessagesWithSystem(req, 'openai/gpt-5') as Array<Record<string, unknown>>;
    expect(m[0]).toEqual({ role: 'system', content: 'stable' });
    expect(m[1]).toEqual({ role: 'system', content: 'tail' });
    expect(m.some((x) => 'providerOptions' in x)).toBe(false);
    expect(toSdkMessagesWithSystem({ system: 'only', messages: [{ role: 'user', content: 'a' }] }, 'openai/gpt-5')).toEqual([{ role: 'system', content: 'only' }, { role: 'user', content: 'a' }]);
  });
});

describe('runner: per-call parts after the marker', () => {
  it('Brainstorm: the CONTEXT block is the tail; the prefix is identical for two different contexts', async () => {
    const p1 = fakeProvider(['Halo!']); const p2 = fakeProvider(['Halo!']);
    await runBrainstorm([{ role: 'user', content: 'halo' }], { assets: [{ id: 'a1' }] }, 'id', p1, { channelProfile: 'Reels 9:16' });
    await runBrainstorm([{ role: 'user', content: 'halo' }], { assets: [{ id: 'a2' }] }, 'id', p2, { channelProfile: 'Reels 9:16' });
    const s1 = splitSystem(p1.calls[0]!.system), s2 = splitSystem(p2.calls[0]!.system);
    expect(s1.stable).toBe(s2.stable);
    expect(s1.stable).toContain('Profil kanal (aturan tetap)');
    expect(s1.stable).not.toContain('{{');
    expect(s1.stable).not.toContain('"a1"');
    expect(s1.dynamic).toBe('CONTEXT\n{"assets":[{"id":"a1"}]}');
    expect(s2.dynamic).toBe('CONTEXT\n{"assets":[{"id":"a2"}]}');
  });
  it('Editor: the base version is the tail; the prompt body names it instead of embedding it', () => {
    const env = { project: { language: 'id' }, baseVersion: 'v9f1' } as unknown as RewriteEnvelope;
    const body = editorSystemPrompt(env);
    expect(body).not.toContain('v9f1');
    expect(body).toContain('"baseVersion": string (the BASE VERSION at the end of this prompt)');
    expect(splitSystem(body + editorSystemTail(env)).dynamic).toBe('BASE VERSION: v9f1\nSet "baseVersion" in the EditPlan to exactly this value.');
  });
});
