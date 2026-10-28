// @vitest-environment jsdom
// QA 2026-10-26 (Windows, Claude Haiku 4.5): #3 pasted / new keys (normalizeKey, EM-4002 automatic retry), #5 agent progress and
// failure bubbles with one next action, #6 pointing at assets / Timeline elements (chips → `targets`), plan generator steps.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createEmptyModel } from '@expertmotion/composition-model';
import { el, els, chatComposer } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { PlanCard, toolStepText, planChanges } from '../src/agent/PlanCard.js';
import { errorActions, progressText } from '../src/agent/Chat.js';
import { elementTarget, mergeTargets, assetTarget, firstWords, targetKey } from '../src/agent/targets.js';
import { KEY_RETRY_MAX, KEY_RETRY_MS, isRecentKey, keyRetryDelay, normalizeKey } from '../src/state/key-retry.js';
import { translate } from '../src/i18n/index.js';
import type { PlanDto } from '../src/api/types.js';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });

async function boot(): Promise<{ runtime: Runtime; bus: MockBus }> {
  try { localStorage.clear(); } catch { /* ignore */ }
  const bus = new MockBus();
  const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [], outputCollapsed: false }}><App /></StoreProvider>);
  await until(() => el('stage.timeline') && el('agent.chat'), 'boot');
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} }, defaultConnectionId: c.id });
    await runtime.api.listConnections();
  });
  // the store reloads providers on settings.changed; the mock emits it on add, so wait for the composer to unlock
  await act(async () => { bus.emit('settings.changed', { scope: 'providers' }); });
  await until(() => !chatComposer('editor')?.hasAttribute('readonly'), 'composer enabled');
  return { runtime, bus };
}

describe('pure helpers', () => {
  it('normalizeKey removes every space, line break, no-break space and zero-width character', () => {
    expect(normalizeKey('  sk-ant-api03-abc\r\n  def\tghi ​‌‍⁠﻿ jkl  ')).toBe('sk-ant-api03-abcdefghijkl');
    expect(normalizeKey('sk-or-v1-0123')).toBe('sk-or-v1-0123');
    expect(normalizeKey('\n')).toBe('');
  });
  it('keyRetryDelay: only EM-4002 on a recent key, every 20 s, at most 3 times', () => {
    expect(KEY_RETRY_MS).toBe(20_000);
    expect(KEY_RETRY_MAX).toBe(3);
    expect(keyRetryDelay(0, 'EM-4002', true)).toBe(20_000);
    expect(keyRetryDelay(2, 'EM-4002', true)).toBe(20_000);
    expect(keyRetryDelay(3, 'EM-4002', true)).toBeNull();
    expect(keyRetryDelay(0, 'EM-4002', false)).toBeNull();
    expect(keyRetryDelay(0, 'EM-4002', undefined)).toBeNull();
    expect(keyRetryDelay(0, 'EM-4101', true)).toBeNull();
    expect(isRecentKey({ recentKey: true })).toBe(true);
    expect(isRecentKey({ recentKey: 'yes' })).toBe(false);
    expect(isRecentKey(undefined)).toBe(false);
  });
  it('error actions by code', () => {
    expect(errorActions('EM-4002')).toEqual(['retry', 'providers']);
    expect(errorActions('EM-4001')).toEqual(['providers']);
    expect(errorActions('EM-4007')).toEqual(['providers']);
    expect(errorActions('EM-4301')).toEqual(['rephrase', 'switchmodel']);
    expect(errorActions('EM-4302')).toEqual(['rephrase', 'switchmodel']);
    expect(errorActions('EM-4201')).toEqual(['budget']);
    for (const c of ['EM-4101', 'EM-4103', 'EM-4003', 'EM-4105', 'EM-9001']) expect(errorActions(c)).toEqual(['retry']);
    expect(errorActions('EM-4102')).toEqual(['retry', 'switchmodel']);                 // Entry 25b: rate-limited free model
  });
  it('progress phases in words', () => {
    expect(progressText({ phase: 'reading' }, t)).toBe('Reading the project…');
    expect(progressText({ phase: 'planning' }, t)).toBe('Drafting the plan…');
    expect(progressText({ phase: 'checking' }, t)).toBe('Checking the plan…');
    expect(progressText({ phase: 'correcting', attempt: 2 }, t)).toBe('Fixing the plan (attempt 2)…');
    expect(progressText({ phase: 'tool', tool: 'assets.list' }, t)).toBe('Looking at your media…');
    // FR-214: per-tool and per-agent words, and the state between Send and the first event
    expect(progressText({ phase: 'tool', tool: 'catalogue.search' }, t)).toBe('Searching the catalogue…');
    expect(progressText({ phase: 'tool', tool: 'some.newTool' }, t)).toBe('Looking at some.newTool…');
    expect(progressText({ phase: 'planning' }, t, 'brainstorm')).toBe('Looking for content ideas…');
    expect(progressText({ phase: 'thinking' }, t, 'brainstorm')).toBe('Thinking about ideas…');
    expect(progressText({ phase: 'writing' }, t, 'editor')).toBe('Writing the plan…');
    expect(progressText({}, t)).toBe('Sending…');
    expect(progressText({ phase: 'sending', attaching: true }, t)).toBe('Preparing the image…');
    expect(translate('id', 'ui.agent.progress.tool.catalogue')).toBe('Mencari di katalog…');
    expect(translate('id', 'ui.agent.composer.working')).toBe('Agent sedang bekerja…');
    expect(translate('id', 'ui.agent.progress.planning')).toBe('Menyusun rencana…');
    expect(translate('id', 'ui.agent.plan.state.executing.changes', { n: 4 })).toBe('Menjalankan 4 perubahan…');
  });
  it('target labels: "Klip N", "Adegan N" for scene clips, text first words, cuts, assets; merge keeps explicit first without duplicates', () => {
    const m = createEmptyModel('p');
    m.tracks.video.push({ id: 'c1', assetId: 'a1', trimBeforeMs: 0, durationMs: 2000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] },
      { id: 'c2', scene: { presetId: 'preset:background.gradient', params: {} }, trimBeforeMs: 0, durationMs: 2000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] } as never);
    m.tracks.text.push({ id: 'x1', variantId: 'preset:text.title', text: 'Tips hemat listrik di rumah kamu', timing: { atMs: 0, durationMs: 1000 }, layer: 0, position: { x: 0, y: 0 }, style: {}, effect: null, motion: null });
    const id = (k: string, v?: Record<string, string | number>) => translate('id', k, v);
    expect(elementTarget({ kind: 'clip', id: 'c1' }, m, [], id)).toEqual({ kind: 'clip', id: 'c1', label: 'Klip 1' });
    expect(elementTarget({ kind: 'clip', id: 'c2' }, m, [], id)?.label).toBe('Adegan 2');
    expect(elementTarget({ kind: 'text', id: 'x1' }, m, [], id)?.label).toBe(firstWords('Tips hemat listrik di rumah kamu'));
    expect(elementTarget({ kind: 'cut', index: 0 }, m, [], id)).toEqual({ kind: 'cut', index: 0, label: 'Potongan 1' });
    expect(elementTarget({ kind: 'background' }, m, [], id)).toBeNull();
    expect(elementTarget({ kind: 'clip', id: 'gone' }, m, [], id)).toBeNull();
    const a = assetTarget({ id: 'a9', name: 'Reels 14.m4a' });
    expect(a).toEqual({ kind: 'asset', id: 'a9', label: 'Reels 14.m4a' });
    const sel = [{ kind: 'clip' as const, id: 'c1', label: 'Klip 1' }, { kind: 'asset' as const, id: 'a9', label: 'x' }];
    expect(mergeTargets([a], sel).map(targetKey)).toEqual(['asset:a9', 'clip:c1']);
    expect(mergeTargets([a], sel, new Set(['clip:c1'])).map(targetKey)).toEqual(['asset:a9']);
  });
  it('generator steps read as words and count as one change each', () => {
    const p = { steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:scene.add', args: {} }, { op: 'op:scene.add', args: {} }], args: {}, expectedDiff: '', dependsOn: [] },
      { n: 2, tool: 'tts.generate', ops: [], args: { text: 'Matikan lampu saat tidak dipakai.' }, expectedDiff: '', dependsOn: [1] }] } as unknown as PlanDto;
    expect(toolStepText(p.steps[1]!, (k, v) => translate('id', k, v))).toBe('Suara narasi: "Matikan lampu saat tidak dipakai."');
    expect(toolStepText({ ...p.steps[1]!, tool: 'captions.generate', args: { source: 'script' } }, (k, v) => translate('id', k, v))).toBe('Teks layar dari naskah');
    expect(planChanges(p)).toBe(3);
  });
});

describe('Plan Card generator steps (QA #2)', () => {
  const plan = (extra: Partial<PlanDto> = {}): PlanDto => ({
    id: 'pl1', projectId: 'p', baseVersion: 'h', origin: 'editor-agent', goal: 'Video faceless 30 detik', touchesLockedKeys: [], validation: [], status: 'valid',
    steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:scene.add', args: {} }], args: {}, expectedDiff: '5 adegan', dependsOn: [] },
      { n: 2, tool: 'tts.generate', ops: [], args: { text: 'Hai! Ini 5 tips hemat listrik.', status: 'needs-model', modelKey: 'piper-id', modelLabel: 'Piper Indonesia' }, expectedDiff: 'Suara', dependsOn: [1] },
      { n: 3, tool: 'captions.generate', ops: [], args: { source: 'voice' }, expectedDiff: 'Teks', dependsOn: [2] }],
    risks: [{ code: 'model-missing', severity: 'warn', message: 'Voice needs Piper Indonesia: install it in the Model Manager.' }], ...extra,
  });
  it('lists tool steps readably, marks a needs-model step, links the Model Manager; Execute stays possible without clips', () => {
    render(<StoreProvider runtime={createMockRuntime({ seed: 'empty', delays: false })} initialPrefs={{ onboardingDone: true }}><PlanCard plan={plan()} /></StoreProvider>);
    const steps = els('agent.editor.plancard.toolstep');
    expect(steps).toHaveLength(2);
    expect(steps[0]!.getAttribute('data-status')).toBe('needs-model');
    expect(steps[0]!.textContent).toContain('Voice-over: "Hai! Ini 5 tips hemat listrik."');
    expect(steps[0]!.textContent).toContain('Piper Indonesia');
    expect(steps[1]!.textContent).toContain('On-screen text following the voice-over');
    expect(el('agent.editor.plancard.models')?.textContent).toBe('Open Model Manager');
    fireEvent.click(el('agent.editor.plancard.models')!);
  });
  it('executing shows "Applying N changes…"; executed with a started voice step shows the generator note', () => {
    const r = render(<StoreProvider runtime={createMockRuntime({ seed: 'sample', delays: false })} initialPrefs={{ onboardingDone: true }}><PlanCard plan={plan({ status: 'executing' })} /></StoreProvider>);
    expect(el('agent.chat.progress')?.textContent).toContain('Applying 3 changes…');
    r.unmount();
    render(<StoreProvider runtime={createMockRuntime({ seed: 'sample', delays: false })} initialPrefs={{ onboardingDone: true }}>
      <PlanCard plan={plan({ status: 'executed', result: { ok: true, toVersion: 'v2', appliedOps: 1, added: 3, removed: 0, modified: 0, toolSteps: [{ n: 2, tool: 'tts.generate', status: 'started', jobId: 'j1' }] } })} /></StoreProvider>);
    expect(el('agent.editor.plancard.toolnote')?.textContent).toContain('The voice-over is being made');
  });
});

describe('Pointing (QA #6): chips from the Library and the Timeline go into the request as targets', () => {
  it('Ask assistant on an asset + the selected clip → chips; × removes; Send carries targets; chips clear; the message shows them', { timeout: 30_000 }, async () => {
    const { runtime } = await boot();
    const spy = vi.spyOn(runtime.api, 'sendMessage');
    const card = el('lib.assets.card')!;
    const assetId = card.getAttribute('data-asset-id')!;
    const assetName = card.querySelector('[data-el="lib.assets.card.meta"]')!.textContent!;
    fireEvent.click(within(card).getByRole('button', { name: t('ui.lib.assets.card.menu') }));
    await until(() => el('lib.assets.card.action.ask'), 'ask menu item');
    fireEvent.click(el('lib.assets.card.action.ask')!);
    await until(() => els('agent.chat.target').length === 1, 'asset chip');
    expect(el('agent.chat.target')!.getAttribute('data-kind')).toBe('asset');
    expect(el('agent.chat.target')!.textContent).toContain(assetName);
    // the Timeline selection is pointed at too
    const clips = document.querySelectorAll<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]');
    const clip = clips[1]!;
    const clipId = clip.getAttribute('data-element-id')!;
    fireEvent.click(clip);
    await until(() => els('agent.chat.target').length === 2, 'clip chip');
    expect(els('agent.chat.target')[1]!.textContent).toContain('Clip 2');
    // remove the clip chip with ×, then bring it back by re-selecting another clip and removing with Backspace
    fireEvent.click(within(els('agent.chat.target')[1]!).getByRole('button'));
    await until(() => els('agent.chat.target').length === 1, 'clip chip removed');
    fireEvent.click(clips[0]!);
    await until(() => els('agent.chat.target').length === 2, 'first clip chip');
    expect(els('agent.chat.target')[1]!.textContent).toContain('Clip 1');
    fireEvent.keyDown(chatComposer('editor'), { key: 'Backspace' });
    await until(() => els('agent.chat.target').length === 1, 'backspace removes the last chip');
    fireEvent.click(clip);
    await until(() => els('agent.chat.target').length === 2, 'clip 2 chip again');
    fireEvent.change(chatComposer('editor'), { target: { value: 'pakai musik ini di klip ini' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => spy.mock.calls.length > 0, 'sent');
    const body = spy.mock.calls[0]![2];
    expect(body.targets).toEqual([{ kind: 'asset', id: assetId, label: assetName }, { kind: 'clip', id: clipId, label: 'Clip 2' }]);
    await until(() => els('agent.chat.target').length === 0, 'chips cleared after send');
    await until(() => el('agent.chat.message.targets'), 'targets on the sent message');
    expect(el('agent.chat.message.targets')!.textContent).toContain('Clip 2');
  });
});

describe('Progress and failures (QA #5, #3)', () => {
  it('agent.run.progress phases replace "Asking…"; a failure is a bubble with its reason and the right action', { timeout: 30_000 }, async () => {
    const { bus } = await boot();
    await act(async () => { bus.emit('agent.run.started', { run: { id: 'r9', projectId: 'p', agent: 'editor', status: 'running', modelId: 'anthropic/claude-sonnet-4.5', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: '', finishedAt: null }, agent: 'editor', modelId: 'anthropic/claude-sonnet-4.5' }); });
    await act(async () => { bus.emit('agent.run.progress', { runId: 'r9', agent: 'editor', phase: 'planning' }); });
    await until(() => el('agent.chat.progress')?.getAttribute('data-phase') === 'planning', 'planning');
    expect(el('agent.chat.progress')!.textContent).toContain('Drafting the plan…');
    await act(async () => { bus.emit('agent.run.progress', { runId: 'r9', agent: 'editor', phase: 'correcting', attempt: 2 }); });
    await until(() => el('agent.chat.progress')?.textContent?.includes('attempt 2'), 'correcting');
    await act(async () => { bus.emit('agent.run.failed', { runId: 'r9', agent: 'editor', code: 'EM-4301', retryable: true, message: 'The model could not produce a valid plan.' }); });
    await until(() => document.querySelector('[data-el="agent.chat.message"][data-code="EM-4301"]'), 'error bubble');
    const bubble = document.querySelector<HTMLElement>('[data-el="agent.chat.message"][data-code="EM-4301"]')!;
    expect(within(bubble).getByText('The model could not produce a valid plan.')).toBeTruthy();
    const acts = [...bubble.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'));
    expect(acts).toEqual(['rephrase', 'switchmodel']);
    expect(el('agent.chat.progress')).toBeNull();
  });
  it('EM-4002 on a new key: hint, automatic retry countdown, Try again and Open AI providers', { timeout: 30_000 }, async () => {
    const { bus } = await boot();
    chatComposer('brainstorm');                                                   // ADR-033: the Diskusi failure shows in the Diskusi tab
    await act(async () => { bus.emit('agent.run.failed', { runId: 'r7', agent: 'brainstorm', code: 'EM-4002', retryable: false, message: 'anthropic did not accept this key.', details: { recentKey: true, providerStatus: 401 } }); });
    await until(() => el('agent.chat.error.keyhint'), 'key hint');
    expect(el('agent.chat.error.keyhint')!.textContent).toMatch(/New keys can take 1–2 minutes to become active\. Trying again in 20 s\./);
    const bubble = document.querySelector<HTMLElement>('[data-el="agent.chat.message"][data-code="EM-4002"]')!;
    expect([...bubble.querySelectorAll('[data-action]')].map((b) => b.getAttribute('data-action'))).toEqual(['retry', 'providers']);
    expect(bubble.textContent).toContain('anthropic did not accept this key.');
    await act(async () => { fireEvent.click(bubble.querySelector('[data-action="providers"]')!); });
    await until(() => el('scr.providers'), 'providers screen');
  });
});

describe('Pasted and new keys (QA #3) in onboarding', () => {
  it('the key is sent without whitespace; EM-4002 on the new key shows the hint and "Try again" validates the stored connection again', { timeout: 30_000 }, async () => {
    const { renderEditor } = await import('./setup-dom.js');
    const { runtime } = await renderEditor('sample', { prefs: { onboardingDone: false } });
    await until(() => el('scr.onboarding.welcome'), 'wizard');
    fireEvent.click([...document.querySelectorAll('button')].find((b) => b.textContent === 'Get started')!);
    await until(() => el('scr.onboarding.provider'), 'provider step');
    const add = vi.spyOn(runtime.api, 'addConnection');
    const validate = vi.spyOn(runtime.api, 'validateConnection');
    fireEvent.change(el('scr.providers.key.input')!, { target: { value: '  sk-or-v1-bad key\r\n​' } });
    await act(async () => { fireEvent.click(el('scr.providers.validate')!); });
    await until(() => add.mock.calls.length > 0, 'add');
    expect(add.mock.calls[0]![0].secret).toBe('sk-or-v1-badkey');
    await until(() => el('scr.providers.keyhint'), 'key hint');
    expect(el('scr.providers.keyhint')!.textContent).toContain('New keys can take 1–2 minutes to become active.');
    await act(async () => { fireEvent.click(within(el('scr.providers.keyhint')!).getByRole('button')); });
    await until(() => validate.mock.calls.length > 0, 'validated again');
    expect(add).toHaveBeenCalledTimes(1);                                        // no second connection
  });
});
