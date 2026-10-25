import { describe, expect, it } from 'vitest';
import { assessModelQuality, parameterCountB, type QualityCapabilityRow } from '../src/index.js';

const row = (modelId: string, o: Partial<QualityCapabilityRow> = {}): QualityCapabilityRow => ({ modelId, label: modelId, contextLength: 128_000, structuredOutput: true, ...o });
const q = (modelId: string, o: Partial<QualityCapabilityRow> = {}) => assessModelQuality(row(modelId, o));

describe('model quality hint (FR-115, Operator decision 2026-10-25)', () => {
  it('strong mainstream models are ok', () => {
    for (const id of ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-flash', 'google/gemini-2.5-pro', 'openai/gpt-4.1', 'qwen/qwen3-235b-a22b', 'qwen/qwen3-30b-a3b',
      'meta-llama/llama-3.3-70b-instruct', 'mistralai/mistral-small', 'minimax/minimax-m1', 'google/gemma-3-27b-it', 'mistralai/mixtral-8x7b-instruct'])
      expect(q(id), id).toEqual({ level: 'ok', reasons: [] });
  });
  it('structuredOutput false is unsupported (no-json); unknown (null) is not flagged', () => {
    expect(q('x/strong-model', { structuredOutput: false })).toEqual({ level: 'unsupported', reasons: ['no-json'] });
    expect(q('x/strong-model', { structuredOutput: null })).toEqual({ level: 'ok', reasons: [] });
    expect(q('meta-llama/llama-3.1-8b-instruct', { structuredOutput: false })).toEqual({ level: 'unsupported', reasons: ['no-json', 'small-params'] });
  });
  it('small-variant names are weak (nano / tiny / micro), mini/lite are not; no false hits inside words', () => {
    for (const id of ['openai/gpt-4.1-nano', 'amazon/nova-micro-v1', 'x/tiny-model'])
      expect(q(id).reasons, id).toContain('small-name');
    expect(assessModelQuality(row('openai/gpt-4o-mini', { label: 'GPT-4o mini' })).level).toBe('ok');
    expect(assessModelQuality(row('google/gemini-2.5-flash-lite')).level).toBe('ok');
    for (const id of ['google/gemini-2.5-pro', 'minimax/minimax-01', 'microsoft/wizardlm-2-8x22b', 'x/satellite-70b']) expect(q(id).reasons, id).not.toContain('small-name');
  });
  it('parameter counts ≤ 9B are weak; MoE active counts and context suffixes are ignored', () => {
    expect(['1b', '3b', '7b', '8b'].map((s) => q(`x/model-${s}-instruct`).reasons)).toEqual([['small-params'], ['small-params'], ['small-params'], ['small-params']]);
    expect(q('qwen/qwen-2.5-7b-instruct').level).toBe('weak');
    expect(q('qwen/qwen3-4b-a1b').reasons).toEqual(['small-params']);
    expect(q('x/model', { label: 'Llama 3.2 3B' }).reasons).toEqual(['small-params']);
    expect(q('qwen/qwen-2.5-14b-instruct').level).toBe('ok');
    expect([parameterCountB('qwen3-30b-a3b'), parameterCountB('qwen2.5-1.5b'), parameterCountB('smol-360m'), parameterCountB('qwen-turbo-1m'), parameterCountB('gemma-3n-e4b-it'), parameterCountB('gpt-4.1')])
      .toEqual([30, 1.5, 0.36, null, 4, null]);
  });
  it('context below 32K is weak (32 768 is fine; unknown is not flagged)', () => {
    expect(q('x/model', { contextLength: 8_192 })).toEqual({ level: 'weak', reasons: ['small-context'] });
    expect(q('x/model', { contextLength: 32_768 }).level).toBe('ok');
    expect(q('x/model', { contextLength: null }).level).toBe('ok');
  });
  it('known small open-weight families are weak', () => {
    for (const id of ['microsoft/phi-4', 'huggingfacetb/smollm2-1.7b', 'mistralai/ministral-8b', 'tinyllama/tinyllama-chat', 'google/gemma-3n-e4b-it']) expect(q(id).reasons, id).toContain('small-family');
  });
  it('free models are not weak by being free; deterministic for both agents', () => {
    expect(q('google/gemini-2.0-flash-exp:free').level).toBe('ok');
    expect(q('meta-llama/llama-3.2-3b-instruct:free').level).toBe('weak');
    const r = row('openai/gpt-4.1-nano', { contextLength: 16_000 });
    expect(assessModelQuality(r, 'editor')).toEqual(assessModelQuality(r, 'brainstorm'));
    expect(assessModelQuality(r)).toEqual({ level: 'weak', reasons: ['small-name', 'small-context'] });
  });
});
