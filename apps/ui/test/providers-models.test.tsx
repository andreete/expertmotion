// @vitest-environment jsdom
// Providers screen (FR-109…FR-119), Model Manager (FR-120…FR-126) and Hardware Monitor (FR-127…FR-130) against the mock.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el, els, renderEditor, openProvidersFromChat } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import type { ModelStateDto } from '../src/api/types.js';

afterEach(() => cleanup());
const until = async (f: () => unknown, what = 'condition') => waitFor(() => { if (!f()) throw new Error(`waiting for ${what}`); }, { timeout: 4000 });
const KEY = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123';

async function openProviders() {
  await openProvidersFromChat();
  await until(() => el('scr.providers'), 'providers');
}

describe('Providers screen (FR-109…FR-119)', () => {
  it('Add form: P1 providers greyed, disclosure + terms, show/hide, sections unlock after a dry-run Validate, nothing saved before Save', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    const add = vi.spyOn(runtime.api, 'addConnection'); const dry = vi.spyOn(runtime.api, 'validateDraft'); const probe = vi.spyOn(runtime.api, 'testProviders');
    await openProviders();
    await until(() => (el('scr.providers.provider.select') as HTMLSelectElement | null)?.querySelector('option[value="openai"]')?.hasAttribute('disabled'), 'kinds');
    const openai = el('scr.providers.provider.select')!.querySelector('option[value="openai"]')!;
    expect(openai.textContent).toContain('Coming in a later version');
    expect(el('scr.providers.provider.disclosure')!.textContent).toMatch(/Sent to OpenRouter/);
    expect(el('scr.providers.provider.disclosure')!.querySelector('a')!.getAttribute('href')).toBe('https://openrouter.ai/terms');
    const input = el('scr.providers.key.input') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.click(el('scr.providers.key.toggle')!);
    expect((el('scr.providers.key.input') as HTMLInputElement).type).toBe('text');
    fireEvent.paste(input, { clipboardData: { getData: () => `  ${KEY}  ` } });
    expect((el('scr.providers.key.input') as HTMLInputElement).value).toBe(KEY);
    expect(el('scr.providers.models.list')).toBeNull();
    expect(el('scr.providers.locked')).not.toBeNull();
    expect(el('scr.providers.save')!.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.providers.models.list'), 'capability table');
    expect(dry).toHaveBeenCalledWith('openrouter', KEY);
    expect(add).not.toHaveBeenCalled();
    expect((await runtime.api.listConnections()).items).toHaveLength(0);
    // FR-114: unknown capability shown as "?", searchable
    const mistral = el('scr.providers.models.list')!.querySelector('[data-model-id="mistralai/mistral-small"]')!;
    expect(mistral.textContent).toContain('?');
    fireEvent.change(el('scr.providers.models.search')!, { target: { value: 'llama' } });
    expect(els('scr.providers.models.row')).toHaveLength(1);
    fireEvent.change(el('scr.providers.models.search')!, { target: { value: '' } });
    // FR-115: unknown capabilities → EM-4005 note, still selectable; no JSON output is selectable too, with a ⚠ warning (Operator 2026-10-25)
    fireEvent.click(el('scr.providers.assign.agent.editor')!);
    expect(el('scr.providers.models.filter.json')!.getAttribute('aria-pressed')).toBe('false');   // off for both agents: unknown rows shown
    const llama = el('scr.providers.models.list')!.querySelector('[data-model-id="meta-llama/llama-3.1-8b-instruct"]')!;
    expect(llama.getAttribute('aria-disabled')).toBeNull();
    expect(llama.getAttribute('data-quality')).toBe('unsupported');
    expect(llama.querySelector('[data-el="scr.providers.models.row.warn"]')!.getAttribute('title')).toMatch(/the Editor Agent may fail/);
    fireEvent.click(el('scr.providers.models.list')!.querySelector('[data-model-id="mistralai/mistral-small"]')!);
    expect(el('scr.providers.assign.agent.editor')!.getAttribute('data-model-id')).toBe('mistralai/mistral-small');
    await until(() => els('scr.providers.assign.note').some((n) => n.getAttribute('data-code') === 'EM-4005'), 'EM-4005 note');
    // FR-116: real probe through R-102 with the draft
    await act(async () => { fireEvent.click(el('scr.providers.test')!); });
    await until(() => el('scr.providers.test.result'), 'test result');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ draft: { provider: 'openrouter', secret: KEY }, editor: 'mistralai/mistral-small' }));
    expect(el('scr.providers.test.result')!.textContent).toMatch(/OK · 1\.2 s · 38 tokens/);
    expect(add).not.toHaveBeenCalled();
    // FR-118 Save stores it; FR-109 row shows default, model count, usage
    await act(async () => { fireEvent.click(el('scr.providers.save')!); });
    await until(() => el('scr.providers.row'), 'row');
    expect(add).toHaveBeenCalledTimes(1);
    expect(el('scr.providers.row.isdefault')).not.toBeNull();
    await until(() => el('scr.providers.row.usage')?.textContent?.includes('6 models') && el('scr.providers.row.usage')?.textContent?.includes('$0.12'), `usage: ${el('scr.providers.row.usage')?.textContent}`);
    expect((await runtime.api.getAssignments()).editor?.modelId).toBe('mistralai/mistral-small');
  });

  it('a rejected key shows EM-4002 inline and focuses the key field; Remove asks for confirmation (FR-113, FR-119)', async () => {
    const { runtime } = await renderEditor('sample');
    await openProviders();
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: 'sk-or-v1-bad-key-000000000000000000' } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('EM-4002'), 'EM-4002');
    expect(document.activeElement?.getAttribute('data-el')).toBe('scr.providers.key.input');
    cleanup();
    const r2 = await renderEditor('sample');
    await act(async () => { await r2.runtime.api.addConnection({ provider: 'openrouter', label: 'Utama', secret: KEY, validateNow: true }); });
    const del = vi.spyOn(r2.runtime.api, 'deleteConnection');
    await openProviders();
    await until(() => el('scr.providers.row'), 'row');
    fireEvent.click(el('scr.providers.row.remove')!);
    expect(el('scr.providers.row.remove.confirm')!.textContent).toMatch(/Remove Utama\?/);
    expect(del).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(el('scr.providers.row.remove.yes')!); });
    await until(() => !el('scr.providers.row'), 'row removed');
    expect(del).toHaveBeenCalledWith(expect.any(String), true);
    void runtime;
  });
});

describe('Budget used up (FR-117, AI-016)', () => {
  it('EM-4201 "Change budget" opens Providers focused on the per-project budget field of the connection', { timeout: 20_000 }, async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const bus = new MockBus();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [], outputCollapsed: false }}><App /></StoreProvider>);
    await until(() => el('stage.timeline') && el('agent.output.ratio.9x16'), 'boot');
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'Utama', secret: KEY, validateNow: true });
    await runtime.api.putAssignments({ editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} }, defaultConnectionId: c.id });
    await act(async () => { bus.emit('agent.run.failed', { runId: 'r1', agent: 'editor', code: 'EM-4201', retryable: false }); });
    await until(() => el('agent.chat.budget'), 'Change budget');
    expect(el('agent.chat.budget')!.textContent).toBe('Change budget');
    await act(async () => { fireEvent.click(el('agent.chat.budget')!); });
    await until(() => el('scr.providers') && document.activeElement?.getAttribute('data-el') === 'scr.providers.budget.project', 'focused budget field');
    const put = vi.spyOn(runtime.api, 'putBudget');
    fireEvent.change(el('scr.providers.budget.project')!, { target: { value: '5' } });
    await act(async () => { fireEvent.click(els('scr.providers.save').at(-1)!); });
    await until(() => put.mock.calls.length > 0, 'saved');
    expect(put.mock.calls[0]![0].projects?.[0]).toMatchObject({ connectionId: c.id, limitUsd: 5 });
  });
});

describe('Model Manager (FR-120…FR-126)', () => {
  async function openModels() {
    const r = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.action.models')!); });
    await until(() => els('scr.models.row').length >= 4, 'rows');
    return r;
  }
  it('groups by purpose, filters, expands the model card with the GPL engine notice, marks recommended', async () => {
    await openModels();
    expect([...document.querySelectorAll('[data-el="scr.models.list"] [data-purpose]')].map((g) => g.getAttribute('data-purpose'))).toEqual(['stt', 'tts', 'image']);
    expect(document.querySelector('[data-model-key="whisper-small"] [data-el="scr.models.row.recommended"]')).not.toBeNull();
    expect(document.querySelector('[data-model-key="whisper-large-v3-turbo"] [data-el="scr.models.row.tier"]')!.textContent).toMatch(/Needs GPU tier T1/);
    fireEvent.click(document.querySelector('[data-model-key="piper-id-news"] [data-el="scr.models.row.expand"]')!);
    expect(el('scr.models.row.notice')!.textContent).toMatch(/GPL-3\.0-or-later/);
    expect(el('scr.models.row.card')!.textContent).toMatch(/not pinned yet/);
    fireEvent.change(el('scr.models.filter.purpose')!, { target: { value: 'stt' } });
    expect(els('scr.models.row').map((r) => r.getAttribute('data-model-key'))).toEqual(['whisper-small', 'whisper-large-v3-turbo']);
    fireEvent.click(el('scr.models.filter.fits')!);
    expect(els('scr.models.row').map((r) => r.getAttribute('data-model-key'))).toEqual(['whisper-small']);
    fireEvent.change(el('scr.models.filter.installed')!, { target: { value: 'installed' } });
    expect(els('scr.models.row')).toHaveLength(0);
    expect(el('scr.models.footer')!.textContent).toMatch(/Models use .* · 48 GB free/);
  });

  it('EM-7005 confirm above the tier, pause keeps / cancel discards, remove asks first, open folder falls back to EM-8303', { timeout: 20_000 }, async () => {
    const { runtime } = await openModels();
    const install = vi.spyOn(runtime.api, 'installModel').mockImplementation(async (key) => runtime.api.getModel(key));   // mock downloads finish instantly
    const cancel = vi.spyOn(runtime.api, 'cancelModel'); const remove = vi.spyOn(runtime.api, 'removeModel');
    const list = runtime.api.listModels.bind(runtime.api);
    let fake: Partial<ModelStateDto> | null = null;
    vi.spyOn(runtime.api, 'listModels').mockImplementation(async () => { const r = await list(); return { ...r, items: r.items.map((m) => (m.key === 'whisper-large-v3-turbo' && fake ? { ...m, ...fake } : m)) }; });
    const row = () => document.querySelector('[data-model-key="whisper-large-v3-turbo"]')!;
    fireEvent.click(row().querySelector('[data-el="scr.models.row.install"]')!);
    expect(install).not.toHaveBeenCalled();
    expect(row().querySelector('[data-el="scr.models.row.install.confirm"]')!.textContent).toMatch(/EM-7005/);
    fake = { status: 'downloading', bytesDone: 400_000_000 };
    await act(async () => { fireEvent.click(row().querySelector('[data-el="scr.models.row.install.anyway"]')!); });
    expect(install).toHaveBeenCalledWith('whisper-large-v3-turbo');
    await until(() => row().querySelector('[data-el="scr.models.row.pause"]'), 'downloading');
    fake = { status: 'not-installed', bytesDone: 400_000_000 };
    await act(async () => { fireEvent.click(row().querySelector('[data-el="scr.models.row.pause"]')!); });
    expect(cancel).toHaveBeenLastCalledWith('whisper-large-v3-turbo');
    await until(() => row().querySelector('[data-el="scr.models.row.cancel"]'), 'partial cancel');
    expect(row().querySelector('[data-el="scr.models.row.status"]')!.textContent).toMatch(/Paused at 25 %/);
    expect(row().querySelector('[data-el="scr.models.row.install"]')!.textContent).toBe('Resume');
    fake = { status: 'paused', pausedReason: 'render', bytesDone: 400_000_000 };
    await act(async () => { fireEvent.click(row().querySelector('[data-el="scr.models.row.cancel"]')!); });
    expect(cancel).toHaveBeenLastCalledWith('whisper-large-v3-turbo', true);
    await until(() => row().querySelector('[data-el="scr.models.row.status"]')!.textContent?.includes('Paused during render'), 'paused during render');
    install.mockRestore();
    await act(async () => { await runtime.api.installModel('piper-id-news'); });
    await act(async () => { fireEvent.change(el('scr.models.filter.purpose')!, { target: { value: 'tts' } }); });
    await act(async () => { fireEvent.click(el('hdr.action.models')!); });
    await until(() => document.querySelector('[data-model-key="piper-id-news"] [data-el="scr.models.row.remove"]'), 'remove button');
    fireEvent.click(document.querySelector('[data-model-key="piper-id-news"] [data-el="scr.models.row.remove"]')!);
    expect(remove).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(el('scr.models.row.remove.yes')!); });
    expect(remove).toHaveBeenCalledWith('piper-id-news');
    await act(async () => { fireEvent.click(els('scr.models.folder')[0]!); });
    await until(() => el('scr.models.footer')!.textContent?.includes('EM-8303'), 'EM-8303');
    expect(el('scr.models.footer')!.textContent).toMatch(/models\\whisper\.cpp/);
  });
});

describe('Hardware Monitor (FR-127…FR-130)', () => {
  it('shows output drive, VRAM, tier consequences with Re-check, workload with Cancel; low-disk banner opens it (FR-128)', { timeout: 20_000 }, async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const bus = new MockBus();
    const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, outputCollapsed: false }}><App /></StoreProvider>);
    await until(() => el('stage.timeline') && el('agent.output.ratio.9x16'), 'boot');
    const refresh = vi.spyOn(runtime.api, 'refreshHardware');
    await act(async () => { bus.emit('service.notice', { kind: 'low-disk', code: 'EM-6402', freeBytes: 1.5 * 1024 ** 3, have: 1.5 }); });
    await until(() => els('sys.toast').some((t) => t.textContent?.includes('Disk space is getting low')), 'banner');
    await act(async () => { fireEvent.click(el('sys.toast.action')!); });
    await until(() => el('scr.hardware.output')?.textContent?.includes('GB'), 'popover');
    expect(el('scr.hardware.vram')!.textContent).toMatch(/not detected/);
    expect(el('scr.hardware.tier')!.textContent).toMatch(/T0 · Standard rendering on the processor/);
    await act(async () => { fireEvent.click(el('scr.hardware.recheck')!); });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(el('scr.hardware.workload')!.textContent).toMatch(/Nothing is running/);
    const live = runtime.api.hardwareLive.bind(runtime.api);
    vi.spyOn(runtime.api, 'hardwareLive').mockImplementation(async () => { const k = await live(); return { ...k, workload: { ...k.workload, items: [
      { kind: 'render', id: 'r1', label: 'Promo', status: 'rendering', progress: 0.42, cancellable: true, pausedReason: null },
      { kind: 'download', id: 'whisper-small', label: 'Whisper small', status: 'paused', progress: 0.4, cancellable: true, pausedReason: 'render' },
      { kind: 'ingest', id: 'a1', label: 'clip.mp4', status: 'ingesting', progress: null, cancellable: false, pausedReason: null },
    ] } }; });
    const cancel = vi.spyOn(runtime.api, 'cancelModel').mockResolvedValue(await runtime.api.getModel('whisper-small'));
    await until(() => els('scr.hardware.workload.item').length === 3, 'workload items', );
    const items = els('scr.hardware.workload.item');
    expect(items[0]!.textContent).toMatch(/Rendering 'Promo' 42 %/);
    expect(items[1]!.textContent).toMatch(/Whisper small · paused during render/);
    expect(items[2]!.querySelector('[data-el="scr.hardware.workload.cancel"]')).toBeNull();      // ingest: no cancellation
    await act(async () => { fireEvent.click(items[1]!.querySelector('[data-el="scr.hardware.workload.cancel"]')!); });
    expect(cancel).toHaveBeenCalledWith('whisper-small');
  });
});
