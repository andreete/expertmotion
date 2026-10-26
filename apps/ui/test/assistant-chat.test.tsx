// @vitest-environment jsdom
// One assistant chat with two modes (Operator decision 2026-10-26): mode switch (buttons, Ctrl+1 / Ctrl+2, Tab in an empty
// composer, remembered per Project), one thread with agent tags, "Apply to video" hand-off from Diskusi to Edit, the header
// model popover (search, sections, price chips, ⚠, per-mode selection) and the simplified Providers screen.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { renderEditor, el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import type { Runtime } from '../src/state/runtime.js';
import type { CapabilityRow, PlanDto } from '../src/api/types.js';
import { modelSections, priceChip, providerShort } from '../src/agent/ModelPopover.js';
import { applyRequest, editorQuestions, APPLY_MAX_CHARS } from '../src/agent/AssistantChat.js';
import { chatModeFor, chatModePatch, loadPrefs } from '../src/prefs.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => cleanup());
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const mode = () => el('agent.chat')!.getAttribute('data-mode');

async function connect(runtime: Runtime) {
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
  });
  await openProvidersFromChat();
  await waitFor(() => { if (!el('scr.providers')?.textContent?.includes('OpenRouter')) throw new Error('providers'); });
  fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
  await waitFor(() => { if (chatComposer('brainstorm').hasAttribute('readonly')) throw new Error('composer disabled'); });
}
async function say(m: 'brainstorm' | 'editor', text: string) {
  fireEvent.change(chatComposer(m), { target: { value: text } });
  await act(async () => { fireEvent.keyDown(chatComposer(m), { key: 'Enter' }); });
}

describe('mode switch', () => {
  it('starts in Diskusi; buttons, Ctrl+1 / Ctrl+2 and Tab in an empty composer switch; remembered per Project', async () => {
    const { runtime } = await renderEditor('sample');
    expect(mode()).toBe('brainstorm');
    expect(el('agent.chat.mode.brainstorm')!.getAttribute('aria-checked')).toBe('true');
    expect(el('agent.chat.mode.brainstorm')!.textContent).toBe('Discuss');
    expect(el('agent.chat.composer')!.getAttribute('placeholder')).toBe(t('ui.agent.composer.noprovider'));   // no provider yet
    fireEvent.click(el('agent.chat.mode.editor')!);
    expect(mode()).toBe('editor');
    expect(el('agent.chat.header')!.getAttribute('data-mode')).toBe('editor');
    fireEvent.keyDown(el('agent.chat.composer')!, { key: '1', ctrlKey: true });
    expect(mode()).toBe('brainstorm');
    fireEvent.keyDown(el('agent.chat.composer')!, { key: '2', ctrlKey: true });
    expect(mode()).toBe('editor');
    fireEvent.keyDown(el('agent.chat.composer')!, { key: 'Tab' });                  // empty composer: Tab toggles
    expect(mode()).toBe('brainstorm');
    fireEvent.change(el('agent.chat.composer')!, { target: { value: 'draft' } });
    fireEvent.keyDown(el('agent.chat.composer')!, { key: 'Tab' });                  // with text: Tab is left alone
    expect(mode()).toBe('brainstorm');
    fireEvent.click(el('agent.chat.mode.editor')!);
    expect((el('agent.chat.composer') as HTMLTextAreaElement).value).toBe('draft'); // the draft survives a mode switch
    const stored = JSON.parse(localStorage.getItem('expertmotion.prefs.v1') ?? '{}') as { chatModeByProject?: Record<string, string> };
    expect(stored.chatModeByProject?.[runtime.seededProjectId!]).toBe('editor');      // remembered for this Project
    cleanup();                                                                       // a new window on the same Service
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('agent.chat') || !document.querySelector('[data-el="hdr.title"]')?.textContent?.trim()) throw new Error('not booted'); });
    await waitFor(() => { if (mode() !== 'editor') throw new Error(`mode ${mode()}`); });
  });

  it('prefs helpers keep the last mode per Project (at most 50)', () => {
    let p = loadPrefs();
    expect(chatModeFor(p, 'p1')).toBe('brainstorm');
    expect(chatModeFor(p, undefined)).toBe('brainstorm');
    p = { ...p, ...chatModePatch(p, 'p1', 'editor') };
    expect(chatModeFor(p, 'p1')).toBe('editor');
    for (let i = 0; i < 60; i++) p = { ...p, ...chatModePatch(p, `x${i}`, 'editor') };
    expect(Object.keys(p.chatModeByProject)).toHaveLength(50);
    expect(chatModePatch(p, undefined, 'editor')).toEqual({});
  });
});

describe('one thread, two agents', () => {
  it('tags every message with its agent, and the Edit reply carries the Plan Card inline', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await say('brainstorm', 'ide intro energik');
    await waitFor(() => { if (!el('agent.brainstorm.handoff')) throw new Error('no reply'); });
    await say('editor', 'buat judul pembuka yang kuat');
    await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'valid') throw new Error('no plan'); });
    const msgs = els('agent.chat.message');
    expect(msgs.map((m) => `${m.getAttribute('data-agent')}:${m.getAttribute('data-role')}`)).toEqual(['brainstorm:user', 'brainstorm:assistant', 'editor:user', 'editor:assistant']);
    expect(msgs.map((m) => m.querySelector('[data-el="agent.chat.message.agent"]')?.textContent)).toEqual(['Discuss', 'Discuss', 'Edit', 'Edit']);
    expect(msgs[3]!.querySelector('[data-el="agent.editor.plancard"]')).not.toBeNull();          // the plan is inline in the Edit reply
    expect(msgs[3]!.querySelector('[data-el="agent.editor.execute"]')).not.toBeNull();
    expect(el('agent.chat.usage')).not.toBeNull();                                              // compact usage in the header
  }, 20_000);
});

describe('Apply to video (Kerjakan di video)', () => {
  it('the proposals card hands the ticked changes to Edit and switches the mode', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    const handoff = vi.spyOn(runtime.api, 'handoff');
    await say('brainstorm', 'ide intro energik');
    await waitFor(() => { if (!el('agent.brainstorm.handoff')) throw new Error('no proposals'); });
    const apply = el('agent.brainstorm.handoff')!.querySelector<HTMLElement>('[data-el="agent.chat.apply"]')!;
    expect(apply.textContent).toBe('Apply to video');
    await act(async () => { fireEvent.click(apply); });
    await waitFor(() => { if (!handoff.mock.calls.length) throw new Error('not handed off'); });
    expect(handoff.mock.calls[0]![1].intentIds?.length).toBeGreaterThan(0);
    await waitFor(() => { if (mode() !== 'editor') throw new Error('mode not switched'); });
    await waitFor(() => { if (!el('agent.brainstorm.handoff')?.textContent?.includes('Sent')) throw new Error('card not sent'); });
  }, 20_000);

  it('a Diskusi answer without pending proposals is sent to the Editor Agent as the request', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    const send = vi.spyOn(runtime.api, 'sendMessage');
    await say('brainstorm', 'ide intro energik');
    await waitFor(() => { if (!el('agent.brainstorm.handoff')) throw new Error('no proposals'); });
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="agent.brainstorm.handoff"] button:not([data-el])')!);   // Dismiss
    const answer = els('agent.chat.message').find((m) => m.getAttribute('data-role') === 'assistant')!;
    const apply = [...answer.querySelectorAll<HTMLElement>('[data-el="agent.chat.apply"]')].find((b) => !b.closest('[data-el="agent.brainstorm.handoff"]'))!;
    expect(apply).not.toBeNull();
    await act(async () => { fireEvent.click(apply); });
    await waitFor(() => { if (send.mock.calls.length < 2) throw new Error('not sent'); });
    const [, agent, body] = send.mock.calls[1]!;
    expect(agent).toBe('editor');
    expect(body.text.startsWith('Do this in the video:\n')).toBe(true);
    expect(body.text).toContain('energetic title');
    expect(mode()).toBe('editor');
  }, 20_000);

  it('applyRequest clips long answers; editorQuestions turns a needs-input plan into a message', () => {
    expect(applyRequest('  Pakai judul besar  ', t)).toBe('Do this in the video:\nPakai judul besar');
    expect(applyRequest('x'.repeat(9000), t).length).toBeLessThanOrEqual(APPLY_MAX_CHARS + 30);
    expect(translate('id', 'ui.agent.chat.apply')).toBe('Kerjakan di video');
    const plan = (steps: number, risks: PlanDto['risks']) => ({ steps: Array.from({ length: steps }, (_, n) => ({ n })), risks }) as unknown as PlanDto;
    expect(editorQuestions(plan(0, [{ code: 'needs-input', message: 'Klip mana?', severity: 'block' }]))).toBe('Klip mana?');
    expect(editorQuestions(plan(1, [{ code: 'needs-input', message: 'Klip mana?', severity: 'warn' }]))).toBeNull();
    expect(editorQuestions(plan(0, []))).toBeNull();
    expect(editorQuestions(null)).toBeNull();
  });
});

const row = (p: Partial<CapabilityRow> & { modelId: string }): CapabilityRow => ({ label: p.modelId, contextLength: 128_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: false, pricePerMInput: 1, pricePerMOutput: 2, ...p });
describe('header model popover', () => {
  it('sections Recommended / Free / Paid without repeats; search; price chip; short provider', () => {
    const rows = [
      row({ modelId: 'anthropic/claude-sonnet-4.5', label: 'Anthropic: Claude Sonnet 4.5', pricePerMInput: 3, pricePerMOutput: 15, contextLength: 200_000 }),
      row({ modelId: 'openai/gpt-4.1-mini', label: 'OpenAI: GPT-4.1 mini', pricePerMInput: 0.4, pricePerMOutput: 1.6 }),
      row({ modelId: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (free)', pricePerMInput: 0, pricePerMOutput: 0 }),
      row({ modelId: 'qwen/qwen-2.5-7b-instruct', label: 'Qwen 2.5 7B', pricePerMInput: 0.04, pricePerMOutput: 0.1, contextLength: 32_768 }),
    ];
    const s = modelSections(rows, 'editor', '');
    const all = [...s.recommended, ...s.free, ...s.paid].map((r) => r.modelId);
    expect(new Set(all).size).toBe(all.length);                                         // no row twice
    expect(all.sort()).toEqual(rows.map((r) => r.modelId).sort());
    expect(s.recommended.length).toBeGreaterThan(0);
    expect(s.free.every((r) => r.modelId.endsWith(':free'))).toBe(true);
    expect(s.paid.some((r) => r.modelId === 'qwen/qwen-2.5-7b-instruct')).toBe(true);    // weak models are listed, never hidden
    expect(modelSections(rows, 'editor', 'QWEN').paid.map((r) => r.modelId)).toEqual(['qwen/qwen-2.5-7b-instruct']);
    expect(priceChip(rows[1]!, 'Free')).toBe('$0.40/1M');
    expect(priceChip(rows[0]!, 'Free')).toBe('$3.00/1M');
    expect(priceChip(rows[2]!, 'Free')).toBe('Free');
    expect(priceChip(row({ modelId: 'x', pricePerMInput: null, pricePerMOutput: null }), 'Free')).toBeNull();
    expect(providerShort('anthropic/claude-sonnet-4.5', 'OpenRouter')).toBe('anthropic');
    expect(providerShort('gpt-4o', 'OpenAI')).toBe('OpenAI');
  });

  it('opens from "Model: … ▾" with search first, sections, price chips, ⚠ and the current pick selected', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    expect(el('agent.chat.model')!.textContent).toContain('Model: GPT-4.1 mini');
    fireEvent.click(el('agent.chat.model')!);
    await waitFor(() => { if (!els('agent.chat.model.row').length) throw new Error('no rows'); });
    expect(document.activeElement).toBe(el('agent.chat.model.search'));
    const sections = els('agent.chat.model.section').map((x) => x.getAttribute('data-section'));
    expect(sections[0]).toBe('recommended');
    expect(sections).toContain('paid');
    expect(els('agent.chat.model.section')[0]!.textContent).toContain('Recommended');
    expect(el('agent.chat.model.popover')!.querySelector('[data-model-id="openai/gpt-4.1-mini"]')!.getAttribute('aria-selected')).toBe('true');
    expect(els('agent.chat.model.row.price').map((x) => x.textContent)).toContain('$0.40/1M');
    expect(el('agent.chat.model.popover')!.querySelector('[data-model-id="meta-llama/llama-3.1-8b-instruct"] [data-el="agent.chat.model.row.warn"]')).not.toBeNull();   // no JSON → ⚠
    expect(el('agent.chat.model.popover')!.querySelector('table')).toBeNull();                                                                                       // a list, not a table
    // a clean pick (no warning) closes the popover and changes only this mode's model
    await act(async () => { fireEvent.click(el('agent.chat.model.popover')!.querySelector<HTMLElement>('[data-model-id="google/gemini-2.5-flash"]')!); });
    await waitFor(() => { if (el('agent.chat.model.popover')) throw new Error('still open'); });
    const a = await runtime.api.getAssignments();
    expect(a.brainstorm?.modelId).toBe('google/gemini-2.5-flash');
    expect(a.editor?.modelId).toBe('anthropic/claude-sonnet-4.5');
    expect(el('agent.chat.model')!.textContent).toContain('Gemini 2.5 Flash');
    // "Switch model" on an error opens the same popover for that agent
    fireEvent.click(el('agent.chat.mode.editor')!);
    expect(el('agent.chat.model')!.textContent).toContain('Claude Sonnet 4.5');
  }, 20_000);
});

describe('Providers screen (simplified, 2026-10-26)', () => {
  it('keeps connections and budget; models sit under "See all models" with the hint "Pick models in the chat"', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await openProvidersFromChat();
    await waitFor(() => { if (!el('scr.providers.row')) throw new Error('no row'); });
    expect(el('scr.providers.hint')!.textContent).toBe('Pick models in the chat');
    const all = el('scr.providers.models.all') as HTMLDetailsElement;
    expect(all.tagName).toBe('DETAILS');
    expect(all.open).toBe(false);                                                    // collapsed by default
    expect(all.querySelector('summary')!.textContent).toBe('See all models');
    expect(all.querySelector('[data-el="scr.providers.models.list"]')).not.toBeNull();   // the table is inside the disclosure
    expect(el('scr.providers.budget.month')).not.toBeNull();
    expect(el('scr.providers.row.test')).not.toBeNull();
    expect(el('scr.providers.row.remove')).not.toBeNull();
    expect(translate('id', 'ui.scr.providers.hint')).toBe('Pilih model di chat');
    expect(translate('id', 'ui.scr.providers.models.all')).toBe('Lihat semua model');
  }, 20_000);
});
