// @vitest-environment jsdom
// QA 2026-10-27 (Windows, Claude Sonnet 5.5): FR-212 a stored Diskusi answer whose proposal has no `params` crashed the chat on every
// open; FR-211 tool-call markup in an answer was shown raw; FR-214 the running agent looked like an error (no state between Send
// and the answer); FR-215 an Anthropic key validated as OpenAI, and the Models step without a model list.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el, els, chatComposer } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { initialState, reducer, PENDING_RUN, safeMessage } from '../src/state/reducer.js';
import { providerOfKey } from '../src/screens/Providers.js';
import type { ConversationDto, MessageDto } from '../src/api/types.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });
const QA_INVOKE = '<invoke>\n<parameter name="input">{"query": "gradient", "category": "backgrounds"}</parameter>\n<parameter name="tool">catalogue.search</parameter>\n</invoke>';
/** The message the QA's database held: proposals without params, an answer with tool-call markup. */
const badMessage = (id: string): MessageDto => ({ id, role: 'assistant', agentRunId: null, createdAt: '2026-10-27T07:29:59.500Z', blocks: [
  { type: 'text', text: `${QA_INVOKE}\nCTA: "Bangun Bersama Kami" dengan logo kamu.` },
  { type: 'proposed_intents', handoffState: 'pending', intents: [
    { id: '01M5Y4763PWR5JSNT0P476WH7J', category: 'asset', needsInterpretation: true, instruction: 'pakai gambar ini sebagai CTA', source: 'brainstorm' },
    { id: '01M5Y4763PWR5JSNT0P476WH7K', category: 'text', needsInterpretation: true, instruction: 'teks CTA di akhir', source: 'brainstorm', params: null },
  ] } as never,
] });

async function boot(opts: { conversation?: (agent: string) => MessageDto[] } = {}): Promise<{ runtime: Runtime; bus: MockBus }> {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const bus = new MockBus();
  const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
  if (opts.conversation) {
    const real = runtime.api.getConversation.bind(runtime.api);
    vi.spyOn(runtime.api, 'getConversation').mockImplementation(async (id, agent, q) => {
      const c = await real(id, agent, q) as ConversationDto;
      const extra = opts.conversation!(agent);
      return { ...c, messages: { ...c.messages, items: [...c.messages.items, ...extra], total: (c.messages.total ?? 0) + extra.length } };
    });
  }
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [], outputCollapsed: false }}><App /></StoreProvider>);
  await until(() => (el('stage.timeline') && el('agent.chat')) || el('scr.start.item.open'), 'editor or start screen');
  if (!el('agent.chat')) { await act(async () => { fireEvent.click(els('scr.start.item.open')[0]!); }); await until(() => el('agent.chat'), 'project open'); }
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} }, defaultConnectionId: c.id });
  });
  await act(async () => { bus.emit('settings.changed', { scope: 'providers' }); });
  await until(() => !chatComposer('brainstorm')?.hasAttribute('readonly'), 'composer enabled');
  return { runtime, bus };
}

describe('FR-212: a stored message with a proposal without params renders (no crash on open)', () => {
  it('the reducer normalises messages from every path (list, added, run done) and queue intents', () => {
    const m = safeMessage(badMessage('m1'));
    const card = m.blocks.find((b) => b.type === 'proposed_intents');
    expect(card && card.type === 'proposed_intents' && card.intents.map((i) => i.params)).toEqual([{}, {}]);
    let s = reducer(initialState, { type: 'messages', agent: 'brainstorm', messages: [badMessage('m2'), { id: 'm3', role: 'assistant', agentRunId: null, createdAt: 'x' } as never] });
    expect(s.messages.brainstorm[1]!.blocks).toEqual([]);
    s = reducer(s, { type: 'queue', queue: { projectId: 'p', headHash: 'h', lockedKeys: [], items: [{ id: 'i1', category: 'text', status: 'queued' } as never] } });
    expect(s.queue!.items[0]!.params).toEqual({});
    expect(s.queue!.items[0]!.resolvedTargets).toEqual([]);
  });
  it('opening a project whose Diskusi holds that message shows the answer without markup and the proposal card', { timeout: 30_000 }, async () => {
    const errors: unknown[] = [];
    const onErr = (e: ErrorEvent) => errors.push(e.error);
    window.addEventListener('error', onErr);
    await boot({ conversation: (agent) => (agent === 'brainstorm' ? [badMessage('01M5Y4763PWR5JSNT0P476WH7Z')] : []) });
    await until(() => el('agent.brainstorm.handoff'), 'proposal card');
    expect(els('agent.brainstorm.handoff.item')).toHaveLength(2);
    expect(el('sys.section.error')).toBeNull();
    const thread = el('agent.chat.thread')!.textContent ?? '';
    expect(thread).toContain('Bangun Bersama Kami');
    expect(thread).not.toMatch(/invoke|parameter|catalogue\.search/);
    window.removeEventListener('error', onErr);
    expect(errors).toEqual([]);
  });
  it('the same message arriving live (agent.run.done) renders too', { timeout: 30_000 }, async () => {
    const { bus } = await boot();
    await act(async () => { bus.emit('agent.run.done', { run: { id: 'r1', projectId: 'p', agent: 'brainstorm', status: 'done', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: '', finishedAt: null }, message: badMessage('01M5Y4763PWR5JSNT0P476WH7Y'), usage: null, contextUsage: null }); });
    await until(() => el('agent.brainstorm.handoff'), 'proposal card');
    expect(el('sys.section.error')).toBeNull();
    expect(el('agent.chat.thread')!.textContent).not.toMatch(/<invoke|parameter name/);
  });
});

describe('FR-214: the agent is visibly working for the whole run', () => {
  it('Send shows the working bubble at once (before the Service answers), Stop replaces Send, the composer says "working"; Stop ends it', { timeout: 30_000 }, async () => {
    const { runtime, bus } = await boot();
    let release: () => void = () => undefined;
    vi.spyOn(runtime.api, 'sendMessage').mockImplementation(() => new Promise((resolve) => { release = () => resolve({ message: { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'ide' }], agentRunId: 'r5', createdAt: new Date().toISOString() }, runId: 'r5' }); }));
    fireEvent.change(chatComposer('brainstorm'), { target: { value: 'Carikan ide konten data center' } });
    await act(async () => { fireEvent.keyDown(chatComposer('brainstorm'), { key: 'Enter' }); });
    expect(el('agent.chat.streaming')).not.toBeNull();                                         // no silent gap
    expect(el('agent.chat.progress')!.getAttribute('data-phase')).toBe('sending');
    expect(el('agent.chat.progress')!.textContent).toContain('Sending…');
    expect(el('agent.chat.typing')).not.toBeNull();
    expect(el('agent.chat.stop')).not.toBeNull();
    expect(el('agent.chat.send')).toBeNull();
    expect(el('agent.chat.composer')!.getAttribute('placeholder')).toBe('The agent is working…');
    await act(async () => { release(); });
    await act(async () => { bus.emit('agent.run.started', { run: { id: 'r5', projectId: 'p', agent: 'brainstorm', status: 'running', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: '', finishedAt: null }, agent: 'brainstorm', modelId: 'm' }); });
    await act(async () => { bus.emit('agent.run.progress', { runId: 'r5', agent: 'brainstorm', phase: 'planning' }); });
    expect(el('agent.chat.progress')!.textContent).toContain('Looking for content ideas…');
    await act(async () => { bus.emit('agent.run.progress', { runId: 'r5', agent: 'brainstorm', phase: 'tool', tool: 'catalogue.search' }); });
    expect(el('agent.chat.progress')!.textContent).toContain('Searching the catalogue…');
    await act(async () => { bus.emit('agent.run.delta', { runId: 'r5', agent: 'brainstorm', delta: `Ide 1: hook data.\n${QA_INVOKE}` }); });
    expect(el('agent.chat.streaming')!.textContent).toContain('Ide 1: hook data.');
    expect(el('agent.chat.streaming')!.textContent).not.toMatch(/invoke|parameter/);
    const cancel = vi.spyOn(runtime.api, 'cancelAgentRun').mockResolvedValue({} as never);
    await act(async () => { fireEvent.click(el('agent.chat.stop')!); });
    expect(cancel).toHaveBeenCalledWith('r5');
    expect(el('agent.chat.streaming')).toBeNull();
    expect(el('agent.chat.send')).not.toBeNull();
  });
  it('a refused send ends the working state and shows the error (never both)', { timeout: 30_000 }, async () => {
    const { runtime } = await boot();
    const { EmError } = await import('@expertmotion/shared');
    vi.spyOn(runtime.api, 'sendMessage').mockRejectedValue(new EmError('EM-4308', 'The attached image is still being prepared.', { status: 409 }));
    fireEvent.change(chatComposer('brainstorm'), { target: { value: 'pakai gambar ini' } });
    await act(async () => { fireEvent.keyDown(chatComposer('brainstorm'), { key: 'Enter' }); });
    await until(() => document.querySelector('[data-el="agent.chat.message"][data-code="EM-4308"]'), 'error card');
    expect(el('agent.chat.streaming')).toBeNull();
    expect(document.querySelector('[data-code="EM-4308"]')!.textContent).toContain('Image still being prepared');
  });
  it('PENDING_RUN is adopted by the real run id and keeps the start time', () => {
    let s = reducer(initialState, { type: 'streamingStart', agent: 'editor', runId: PENDING_RUN, modelId: 'm' });
    const since = s.streaming.editor!.since;
    s = reducer(s, { type: 'event', event: { name: 'agent.run.progress', data: { runId: 'r1', agent: 'editor', phase: 'reading' } } } as never);
    expect(s.streaming.editor).toMatchObject({ runId: 'r1', phase: 'reading', since });
    s = reducer(s, { type: 'streamingStart', agent: 'editor', runId: 'r1', modelId: 'm' });
    expect(s.streaming.editor).toMatchObject({ runId: 'r1', phase: 'reading', since });
  });
});

describe('FR-215: key of another provider, onboarding defaults', () => {
  it('providerOfKey recognises the obvious prefixes only', () => {
    expect(providerOfKey('sk-ant-api03-abcdefghijklmnop')).toBe('anthropic');
    expect(providerOfKey('sk-or-v1-abcdefghijklmnop')).toBe('openrouter');
    expect(providerOfKey('AIzaSyAbcdefghijklmnop')).toBe('google');
    expect(providerOfKey('sk-proj-abcdefghijklmnop')).toBe('openai');
    expect(providerOfKey('sk-abcdefghijklmnopqrst')).toBe('openai');
    expect(providerOfKey('hello')).toBeNull();
  });
  it('onboarding: an Anthropic key on OpenAI offers a one-click switch; the Models step stores the defaults with "Use defaults"', { timeout: 30_000 }, async () => {
    try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    // the packaged Service enables all four providers (R-103); the mock enables OpenRouter only
    vi.spyOn(runtime.api, 'providerKinds').mockResolvedValue({ items: (['openrouter', 'openai', 'anthropic', 'google', 'custom'] as const).map((provider) => ({ provider, enabled: provider !== 'custom', priority: 'P1' as const, termsUrl: null, keyPattern: null, keyExample: null })) });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: false }}><App /></StoreProvider>);
    await until(() => el('scr.onboarding.welcome'), 'wizard');
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Get started')!);
    await until(() => el('scr.onboarding.provider'), 'provider step');
    fireEvent.change(el('scr.providers.provider.select')!, { target: { value: 'openai' } });
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: 'sk-ant-api03-0123456789abcdefghij' } });
    await until(() => el('scr.providers.key.mismatch'), 'mismatch hint');
    expect(el('scr.providers.key.mismatch')!.textContent).toContain('This key belongs to Anthropic');
    expect(el('scr.providers.key.mismatch')!.getAttribute('data-provider')).toBe('anthropic');
    fireEvent.click(el('scr.providers.key.mismatch.switch')!);
    expect((el('scr.providers.provider.select') as HTMLSelectElement).value).toBe('anthropic');
    expect(el('scr.providers.key.mismatch')).toBeNull();
    // the mock serves OpenRouter: validate an OpenRouter key and land on the Models step with a filled table
    fireEvent.change(el('scr.providers.provider.select')!, { target: { value: 'openrouter' } });
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: 'sk-or-v1-0123456789abcdef' } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => el('scr.onboarding.models'), 'models step');
    await until(() => els('scr.providers.models.row').length > 0, 'model rows');
    expect(el('scr.providers.models.empty')).toBeNull();
    const put = vi.spyOn(runtime.api, 'putAssignments');
    await act(async () => { fireEvent.click(el('scr.providers.defaults')!); });
    await until(() => el('scr.onboarding.hardware'), 'hardware step');
    const body = put.mock.calls[0]![0];
    expect(body.brainstorm?.modelId).toBeTruthy();
    expect(body.editor?.modelId).toBeTruthy();
  });
});
