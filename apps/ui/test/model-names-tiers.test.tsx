// @vitest-environment jsdom
// Operator decision 2026-10-25 (beginner audience): Local Models show product names; LLM assignment is Fast / Balanced / Best.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { el, els, renderEditor } from './setup-dom.js';
import { localModelByRef, localModelName, llmModelName } from '../src/state/model-names.js';
import type { CapabilityRow, ModelStateDto } from '../src/api/types.js';

afterEach(() => cleanup());
const until = async (f: () => unknown, what = 'condition') => waitFor(() => { if (!f()) throw new Error(`waiting for ${what}`); }, { timeout: 4000 });
const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
const tierOpt = (agent: string, tier: string) => el(`scr.providers.assign.${agent}.tier`)!.querySelector<HTMLButtonElement>(`[data-tier="${tier}"]`)!;

describe('model name helpers', () => {
  const m = (o: Partial<ModelStateDto>): ModelStateDto => ({ key: 'k', engine: 'e', version: '1', task: 'stt', label: 'Upstream', licence: { name: 'MIT', url: 'u' }, tiers: ['T0'], bytesTotal: 1, bytesDone: 0, status: 'not-installed', errorCode: null, installedAt: null, ...o });
  it('picks the product name by UI language and falls back to the label', () => {
    expect(localModelName(m({ displayName: { en: 'Indonesian Voice', id: 'Suara Indonesia' } }), 'id')).toBe('Suara Indonesia');
    expect(localModelName(m({}), 'en')).toBe('Upstream');
  });
  it('resolves a Catalogue flag to the installed model first', () => {
    const list = [m({ key: 'whisper-small', flag: 'model:whisper' }), m({ key: 'whisper-medium', flag: 'model:whisper', status: 'installed' })];
    expect(localModelByRef(list, 'model:whisper')?.key).toBe('whisper-medium');
    expect(localModelByRef(list, 'whisper-small')?.key).toBe('whisper-small');
    expect(localModelByRef(list, 'model:nothing')).toBeUndefined();
  });
  it('names an LLM model by tier, else by its label', () => {
    const t = (k: string) => ({ 'ui.scr.providers.tier.fast': 'Fast', 'ui.scr.providers.tier.balanced': 'Balanced', 'ui.scr.providers.tier.best': 'Best' }[k] ?? k);
    const row = (modelId: string, p: number, o: Partial<CapabilityRow> = {}): CapabilityRow => ({ modelId, label: modelId.toUpperCase(), contextLength: 128_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: p, pricePerMOutput: p, ...o });
    const rows = [row('a', 1), row('b', 2), row('c', 3), row('x', 0.1, { structuredOutput: false })];
    expect([llmModelName(t, rows, 'a'), llmModelName(t, rows, 'b'), llmModelName(t, rows, 'c'), llmModelName(t, rows, 'x'), llmModelName(t, rows, 'zz')]).toEqual(['Fast', 'Balanced', 'Best', 'X', 'zz']);
  });
});

describe('Model Manager product names', () => {
  it('row header shows the product name and size (no upstream name, no v{version}); licence stays in the card', async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.action.models')!); });
    await until(() => els('scr.models.row').length >= 4, 'rows');
    const row = document.querySelector('[data-model-key="piper-id-news"]')!;
    expect(row.querySelector('[data-el="scr.models.row.name"]')!.textContent).toBe('Indonesian Voice');
    expect(row.textContent).not.toMatch(/Piper|v1\.10/);
    fireEvent.click(row.querySelector('[data-el="scr.models.row.expand"]')!);
    expect(row.querySelector('[data-el="scr.models.row.licence"]')!.textContent).toBe('MIT');
    expect(row.querySelector('[data-el="scr.models.row.notice"]')!.textContent).toMatch(/GPL-3\.0-or-later/);
  });
});

describe('LLM tiers in Providers (FR-115)', () => {
  it('Validate → Balanced preselected per agent; Best stores the resolved model id; Advanced keeps exact models; names show the tier', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers'), 'providers');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: KEY } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.assign.editor.tier'), 'tiers');
    for (const a of ['brainstorm', 'editor']) {
      expect(el(`scr.providers.assign.${a}.tier`)!.querySelectorAll('[role="radio"]')).toHaveLength(3);
      expect(tierOpt(a, 'balanced').getAttribute('aria-checked')).toBe('true');
      expect((el(`scr.providers.assign.${a}.advanced`) as HTMLDetailsElement).open).toBe(false);
    }
    expect(el('scr.providers.assign.editor.tier')!.textContent).toMatch(/Fast.*Balanced.*Best/);
    fireEvent.click(tierOpt('editor', 'best'));
    expect(tierOpt('editor', 'best').getAttribute('aria-checked')).toBe('true');
    expect((el('scr.providers.assign.editor') as HTMLSelectElement).value).toBe('anthropic/claude-sonnet-4.5');
    // Advanced exact pick → no tier checked, shown as a custom model
    fireEvent.change(el('scr.providers.assign.brainstorm')!, { target: { value: 'mistralai/mistral-small' } });
    expect(el('scr.providers.assign.brainstorm.tier')!.querySelector('[aria-checked="true"]')).toBeNull();
    expect(el('scr.providers.assign.custom')!.textContent).toBe('Custom model: Mistral Small');
    fireEvent.click(tierOpt('brainstorm', 'fast'));
    await act(async () => { fireEvent.click(el('scr.providers.save')!); });
    await until(() => el('scr.providers.row'), 'saved');
    const a = await runtime.api.getAssignments();
    expect(a.editor?.modelId).toBe('anthropic/claude-sonnet-4.5');                  // the resolved model id is stored as before
    expect(a.brainstorm?.modelId).toBe('openai/gpt-4.1-mini');
    await until(() => el('agent.modelbar')?.textContent?.includes('Best'), 'model bar tier');
    expect(el('agent.modelbar')!.textContent).not.toContain('anthropic/');
  });

  it('without a fetched model list the tiers are disabled with a "Fetch models" hint', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.addConnection({ provider: 'openrouter', label: 'Utama', secret: KEY, validateNow: false }); });
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers.assign.editor.tier'), 'tiers');
    expect(tierOpt('editor', 'fast').disabled).toBe(true);
    expect(tierOpt('editor', 'best').disabled).toBe(true);
    expect(els('scr.providers.assign.tier.empty')[0]!.textContent).toMatch(/Fetch models first/);
  });
});
