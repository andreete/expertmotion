// @vitest-environment jsdom
// Operator decisions 2026-10-25 (beginner audience): Local Models show product names; LLM models are chosen from one searchable
// model table (ModelPicker) and shown by their label, never by a tier name ("Fast" / "Balanced" / "Best" are gone from the UI).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { el, els, renderEditor } from './setup-dom.js';
import { localModelByRef, localModelName, llmModelName } from '../src/state/model-names.js';
import { PAGE, defaultModelFor, formatContext, pickerRows, recommendedIds } from '../src/components/ModelPicker.js';
import type { CapabilityRow, ModelStateDto } from '../src/api/types.js';

afterEach(() => cleanup());
const until = async (f: () => unknown, what = 'condition') => waitFor(() => { if (!f()) throw new Error(`waiting for ${what}`); }, { timeout: 4000 });
const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';
const row = (modelId: string, label: string, p: number | null, o: Partial<CapabilityRow> = {}): CapabilityRow =>
  ({ modelId, label, contextLength: 128_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: p, pricePerMOutput: p, ...o });
const ROWS: CapabilityRow[] = [
  row('anthropic/claude-sonnet', 'Anthropic: Claude Sonnet', 9, { contextLength: 200_000 }),
  row('openai/gpt-mini', 'OpenAI: GPT Mini', 1, { contextLength: 1_048_576 }),
  row('google/gemini-flash', 'Google: Gemini Flash', 2, { contextLength: 1_000_000 }),
  row('meta-llama/llama-8b', 'Meta: Llama 8B', null, { structuredOutput: false, toolCalling: false, imageInput: false }),
  row('qwen/qwen-7b', 'Qwen: Qwen 7B', 0.1, { contextLength: 32_768, imageInput: false }),
  row('google/gemma-3:free', 'Google: Gemma 3 (free)', 0, { contextLength: 96_000 }),
  row('mistralai/mistral-small', 'Mistral: Small', 0.2, { structuredOutput: null, toolCalling: null, imageInput: null }),
];
const NO = { query: '', free: false, json: false, images: false };
const REC = { sort: 'recommended' as const, dir: 'asc' as const };
const ids = (r: CapabilityRow[]) => r.map((x) => x.modelId);

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
  it('names an LLM model by its label (never a tier), else by its id', () => {
    expect([llmModelName(ROWS, 'openai/gpt-mini'), llmModelName(ROWS, 'google/gemini-flash'), llmModelName(ROWS, 'zz'), llmModelName(ROWS, null)])
      .toEqual(['OpenAI: GPT Mini', 'Google: Gemini Flash', 'zz', '']);
  });
});

describe('ModelPicker rows (pure)', () => {
  it('searches name or id, case-insensitive', () => {
    expect(ids(pickerRows(ROWS, 'brainstorm', { ...NO, query: 'GEMINI' }, REC))).toEqual(['google/gemini-flash']);
    expect(ids(pickerRows(ROWS, 'brainstorm', { ...NO, query: 'qwen/' }, REC))).toEqual(['qwen/qwen-7b']);
    expect(ids(pickerRows(ROWS, 'brainstorm', { ...NO, query: 'google' }, REC)).sort()).toEqual(['google/gemini-flash', 'google/gemma-3:free']);
  });
  it('filters Free (:free or price 0), JSON (known true; not-known-false when nothing is reported) and Images', () => {
    expect(ids(pickerRows(ROWS, 'brainstorm', { ...NO, free: true }, REC))).toEqual(['google/gemma-3:free']);
    const json = ids(pickerRows(ROWS, 'editor', { ...NO, json: true }, REC));
    expect(json).not.toContain('meta-llama/llama-8b');
    expect(json).not.toContain('mistralai/mistral-small');
    const unreported = ROWS.map((r) => ({ ...r, structuredOutput: r.structuredOutput === false ? false : null }));
    expect(ids(pickerRows(unreported, 'editor', { ...NO, json: true }, REC))).toHaveLength(6);
    expect(ids(pickerRows(ROWS, 'brainstorm', { ...NO, images: true }, REC))).not.toContain('qwen/qwen-7b');
  });
  it('marks 1–3 recommended rows first (Balanced, Best, Fast), unusable rows last; sorts by name / price / context', () => {
    const rec = recommendedIds(ROWS, 'editor');
    expect(rec.length).toBeGreaterThanOrEqual(1); expect(rec.length).toBeLessThanOrEqual(3);
    expect(rec[0]).toBe(defaultModelFor(ROWS, 'editor'));
    const order = ids(pickerRows(ROWS, 'editor', NO, REC));
    expect(order.slice(0, rec.length)).toEqual(rec);
    expect(order.at(-1)).toBe('meta-llama/llama-8b');
    expect(ids(pickerRows(ROWS, 'editor', NO, { sort: 'name', dir: 'asc' }))[0]).toBe('anthropic/claude-sonnet');
    const byPrice = ids(pickerRows(ROWS, 'editor', NO, { sort: 'price', dir: 'asc' }));
    expect(byPrice[0]).toBe('google/gemma-3:free'); expect(byPrice.at(-1)).toBe('meta-llama/llama-8b');   // unknown price last
    expect(ids(pickerRows(ROWS, 'editor', NO, { sort: 'price', dir: 'desc' })).at(-1)).toBe('meta-llama/llama-8b');
    expect(ids(pickerRows(ROWS, 'editor', NO, { sort: 'context', dir: 'desc' }))[0]).toBe('openai/gpt-mini');
    expect(recommendedIds(ROWS, 'editor', true)).toEqual(['google/gemma-3:free']);
    expect(defaultModelFor(ROWS, 'brainstorm', true)).toBe('google/gemma-3:free');
  });
  it('formats context as K / M', () => {
    expect([formatContext(128_000), formatContext(32_768), formatContext(1_048_576), formatContext(1_000_000), formatContext(null)]).toEqual(['128K', '32K', '1M', '1M', '—']);
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

const rowOf = (id: string) => el('scr.providers.models.list')!.querySelector<HTMLElement>(`[data-model-id="${id}"]`);
const assigned = (agent: string) => el(`scr.providers.assign.agent.${agent}`)!.getAttribute('data-model-id');

describe('Model table in Providers (FR-114, FR-115)', () => {
  it('Validate → table with one default per agent, no tier labels; toggle agent, search, keyboard, disabled rows, Save stores exact ids; names show the label', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers'), 'providers');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: KEY } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.models.list'), 'model table');
    // defaults (Balanced resolution) preselected for both agents; nothing says Fast / Balanced / Best
    expect(assigned('brainstorm')).toBe('google/gemini-2.5-flash');
    expect(assigned('editor')).toBe('google/gemini-2.5-flash');
    expect(el('scr.providers')!.textContent).not.toMatch(/\b(Fast|Balanced|Best)\b/);
    expect(el('scr.providers.assign.brainstorm.tier')).toBeNull();
    expect(el('scr.providers.assign.agent.brainstorm')!.getAttribute('aria-checked')).toBe('true');
    expect(rowOf('google/gemini-2.5-flash')!.getAttribute('aria-selected')).toBe('true');
    const recommended = els('scr.providers.models.row.recommended');
    expect(recommended.length).toBeGreaterThanOrEqual(1); expect(recommended.length).toBeLessThanOrEqual(3);
    expect(els('scr.providers.models.row')[0]!.getAttribute('data-model-id')).toBe('google/gemini-2.5-flash');  // recommended first
    expect(rowOf('anthropic/claude-sonnet-4.5')!.textContent).toMatch(/200K/);
    expect(rowOf('anthropic/claude-sonnet-4.5')!.textContent).toMatch(/\$3\.00 · \$15\.00/);
    // Brainstorming Agent: JSON chip off; a model without JSON output is shown but disabled with a reason
    expect(el('scr.providers.models.filter.json')!.getAttribute('aria-pressed')).toBe('false');
    const llama = rowOf('meta-llama/llama-3.1-8b-instruct')!;
    expect(llama.getAttribute('aria-disabled')).toBe('true');
    expect(llama.querySelector('[data-el="scr.providers.models.row.reason"]')!.textContent).toMatch(/No JSON output/);
    fireEvent.click(llama);
    expect(assigned('brainstorm')).toBe('google/gemini-2.5-flash');
    // search + keyboard: ↓ moves, Enter selects
    const search = el('scr.providers.models.search')!;
    fireEvent.change(search, { target: { value: 'gpt' } });
    expect(els('scr.providers.models.row').map((r) => r.getAttribute('data-model-id'))).toEqual(['openai/gpt-4.1-mini']);
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(assigned('brainstorm')).toBe('openai/gpt-4.1-mini');
    fireEvent.change(search, { target: { value: '' } });
    // Editor Agent: JSON chip on by default (structured output required); ↓ ↓ Enter from the selected row
    fireEvent.click(el('scr.providers.assign.agent.editor')!);
    expect(el('scr.providers.models.filter.json')!.getAttribute('aria-pressed')).toBe('true');
    expect(rowOf('meta-llama/llama-3.1-8b-instruct')).toBeNull();
    expect(rowOf('mistralai/mistral-small')).toBeNull();
    const order = els('scr.providers.models.row').map((r) => r.getAttribute('data-model-id'));
    const start = order.indexOf('google/gemini-2.5-flash');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(assigned('editor')).toBe(order[start + 2]);
    // sort by price: cheapest first
    fireEvent.click(el('scr.providers.models.sort.price')!);
    expect(el('scr.providers.models.sort.price')!.getAttribute('aria-sort')).toBe('ascending');
    expect(els('scr.providers.models.row')[0]!.getAttribute('data-model-id')).toBe('qwen/qwen-2.5-7b-instruct');
    fireEvent.click(rowOf('anthropic/claude-sonnet-4.5')!);
    expect(assigned('editor')).toBe('anthropic/claude-sonnet-4.5');
    expect(el('scr.providers.assign.agent.editor')!.textContent).toContain('Claude Sonnet 4.5');
    await act(async () => { fireEvent.click(el('scr.providers.save')!); });
    await until(() => el('scr.providers.row'), 'saved');
    const a = await runtime.api.getAssignments();
    expect(a.editor?.modelId).toBe('anthropic/claude-sonnet-4.5');                  // the exact model id is stored as before
    expect(a.brainstorm?.modelId).toBe('openai/gpt-4.1-mini');
    await until(() => el('agent.modelbar')?.textContent?.includes('Claude Sonnet 4.5'), 'model bar label');
    expect(el('agent.modelbar')!.textContent).not.toContain('anthropic/');
  });

  it('"Also use for" copies a pick to the other agent; each agent keeps its own pick', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers'), 'providers');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: KEY } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.models.list'), 'model table');
    expect(el('scr.providers.assign.both')).toBeNull();                              // both agents already on the same default
    fireEvent.click(rowOf('qwen/qwen-2.5-7b-instruct')!);
    fireEvent.click(el('scr.providers.assign.both')!);
    expect(assigned('editor')).toBe('qwen/qwen-2.5-7b-instruct');
    fireEvent.click(el('scr.providers.assign.agent.editor')!);
    fireEvent.click(rowOf('google/gemini-2.5-flash')!);
    await act(async () => { fireEvent.click(el('scr.providers.save')!); });
    await until(() => el('scr.providers.row'), 'saved');
    const a = await runtime.api.getAssignments();
    expect([a.brainstorm?.modelId, a.editor?.modelId]).toEqual(['qwen/qwen-2.5-7b-instruct', 'google/gemini-2.5-flash']);
  });

  it('Save without touching the table stores the Balanced defaults', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers'), 'providers');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: KEY } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.models.list'), 'model table');
    await act(async () => { fireEvent.click(el('scr.providers.save')!); });
    await until(() => el('scr.providers.row'), 'saved');
    const a = await runtime.api.getAssignments();
    expect([a.brainstorm?.modelId, a.editor?.modelId]).toEqual(['google/gemini-2.5-flash', 'google/gemini-2.5-flash']);
  });

  it('a long list renders at most one page with "Show more"; the Free chip switches untouched defaults to the free pick', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    const many: CapabilityRow[] = Array.from({ length: 450 }, (_, i) => row(`vendor${i % 9}/model-${i}`, `Vendor ${i % 9}: Model ${i}`, 0.5 + i / 100));
    many.push(row('google/gemma-3-27b-it:free', 'Google: Gemma 3 27B (free)', 0), row('openai/gpt-4.1-mini', 'OpenAI: GPT-4.1 mini', 2));
    vi.spyOn(runtime.api, 'validateDraft').mockResolvedValue({ status: 'valid', validatedAt: '2026-10-25T00:00:00.000Z', models: many });
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers'), 'providers');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: KEY } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.models.list'), 'model table');
    expect(els('scr.providers.models.row')).toHaveLength(PAGE);
    expect(el('scr.providers.models.count')!.textContent).toBe('452 of 452');
    fireEvent.click(el('scr.providers.models.more')!);
    expect(els('scr.providers.models.row')).toHaveLength(2 * PAGE);
    expect(assigned('brainstorm')).toBe('openai/gpt-4.1-mini');
    fireEvent.click(el('scr.providers.models.filter.free')!);
    expect(els('scr.providers.models.row').map((r) => r.getAttribute('data-model-id'))).toEqual(['google/gemma-3-27b-it:free']);
    expect(assigned('brainstorm')).toBe('google/gemma-3-27b-it:free');
    expect(assigned('editor')).toBe('google/gemma-3-27b-it:free');
    expect(el('scr.providers.models.row')!.textContent).toContain('Free');
    fireEvent.click(el('scr.providers.models.filter.free')!);
    expect(assigned('editor')).toBe('openai/gpt-4.1-mini');
  });

  it('without a fetched model list the table shows "Fetch models", which loads it', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { await runtime.api.addConnection({ provider: 'openrouter', label: 'Utama', secret: KEY, validateNow: false }); });
    const conns = (await runtime.api.listConnections()).items;
    vi.spyOn(runtime.api, 'connectionModels').mockResolvedValue({ items: [] } as never);
    const refresh = vi.spyOn(runtime.api, 'refreshConnectionModels');
    await act(async () => { fireEvent.click(el('agent.modelbar')!); });
    await until(() => el('scr.providers.models.empty'), 'empty table');
    expect(el('scr.providers.models.empty')!.textContent).toMatch(/No model list yet/);
    await act(async () => { fireEvent.click(el('scr.providers.models.fetch')!); });
    expect(refresh).toHaveBeenCalledWith(conns[0]!.id);
    await until(() => els('scr.providers.models.row').length > 0, 'rows after fetch');
  });
});
