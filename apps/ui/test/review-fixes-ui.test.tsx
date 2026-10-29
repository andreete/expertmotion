// @vitest-environment jsdom
// Review 2026-10-29 (UI): U1 a stale plan is re-planned with its own picks + message (not the whole queue / EM-9002); U2 Stop while a
// message is still "sending" cancels THAT run once its id is known and never the previous plan; A4 the Diskusi hand-off card derives
// its state from the run's plan; U4 one toast per failed plan step; U5 needs-model / resumed step words (no endless spinner); U6 the
// voice list is not refetched on every download tick; U7 Cut removes only what reaches the clipboard; U8 plan preview times include
// transitions; U9 queue events are normalised; U10 a hand-off plans only its own picks; U11 a crashed toast stack stays visible;
// U12 "1:60"; U13 menu Paste uses the live playhead; U3 "Kirim ke Editor" while the Editor works says so instead of wiping its run.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { applyOperations, createEmptyModel, type CompositionModelT } from '@expertmotion/composition-model';
import { renderEditor, el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { replanRequest } from '../src/state/store.js';
import { initialState, reducer, PENDING_RUN } from '../src/state/reducer.js';
import { handoffStateOf } from '../src/agent/Handoff.js';
import { previewRows, previewDurationMs } from '../src/agent/plan-preview.js';
import { cutRefs, runCut } from '../src/stage/items.js';
import { mmss } from '../src/screens/MusicLibrary.js';
import { TOASTS_FAILED_CLS } from '../src/App.js';
import { SectionBoundary } from '../src/startup/ErrorBoundary.js';
import { timelineClipboard } from '../src/stage/clipboard.js';
import { playerBus } from '../src/stage/playerBus.js';
import { translate } from '../src/i18n/index.js';
import en from '../src/i18n/en.json';
import id from '../src/i18n/id.json';
import type { IntentQueueDto, PlanDto } from '../src/api/types.js';

afterEach(() => { cleanup(); timelineClipboard.clear(); vi.restoreAllMocks(); });
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });
const toasts = () => els('sys.toast').map((x) => x.textContent ?? '').join(' | ');
const bars = (kind: string) => [...document.querySelectorAll<HTMLElement>(`[data-el="stage.timeline.element"][data-kind="${kind}"]`)];
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);

async function connect(runtime: Runtime) {
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
  });
  await openProvidersFromChat();
  await until(() => el('scr.providers')?.textContent?.includes('OpenRouter'), 'providers');
  fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
  await until(() => !chatComposer('editor')?.hasAttribute('readonly'), 'composer enabled');
}
/** renderEditor with a MockBus the test can emit Service events on. */
async function editorWithBus(): Promise<{ runtime: Runtime; bus: MockBus; pid: string }> {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const bus = new MockBus();
  const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, outputCollapsed: false }}><App /></StoreProvider>);
  await until(() => el('stage.timeline') && el('hdr.title')?.textContent?.trim(), 'editor');
  return { runtime, bus, pid: runtime.seededProjectId! };
}
const plan = (o: Partial<PlanDto>): PlanDto => ({ id: 'p-old', projectId: 'x', baseVersion: 'h0', origin: 'editor-agent', goal: 'buat judul pembuka yang kuat', steps: [], touchesLockedKeys: [], risks: [], status: 'valid', validation: [], ...o });
const queue = (ids: Array<[string, string]>): IntentQueueDto => ({ projectId: 'x', headHash: 'h', lockedKeys: [], items: ids.map(([i, status]) => ({ id: i, status } as never)) });

describe('U1 re-plan keeps the request', () => {
  it('replanRequest: the plan\'s queued picks + the Creator\'s message + agent mode; never an empty body', () => {
    expect(replanRequest(plan({ intentIds: ['a', 'b'] }), queue([['a', 'queued'], ['b', 'executed']]))).toEqual({ intentIds: ['a'], message: 'buat judul pembuka yang kuat', mode: 'agent', replanOf: 'p-old' });
    expect(replanRequest(plan({ intentIds: ['a'] }), queue([]))).toEqual({ message: 'buat judul pembuka yang kuat', mode: 'agent', replanOf: 'p-old' });   // Entry 35: + replanOf (the Service uses the Creator's own message)     // chat intent withdrawn: the message
    expect(replanRequest(plan({ origin: 'compile', goal: 'Apply 2 pick(s)', intentIds: ['a', 'b'] }), queue([['a', 'queued'], ['b', 'queued']]))).toEqual({ intentIds: ['a', 'b'] });
    // nothing of the request is left: the old ids are asked for (the Service says EM-9003), never the whole queue
    expect(replanRequest(plan({ origin: 'compile', goal: 'Apply 1 pick(s)', intentIds: ['gone'] }), queue([['other', 'queued']]))).toEqual({ intentIds: ['gone'] });
    expect(replanRequest(plan({ goal: 'Plan the queued picks', intentIds: ['a'] }), null)).toEqual({ intentIds: ['a'], mode: 'agent', replanOf: 'p-old' });
  });

  it('Execute on a stale Editor-chat plan re-plans with its picks and message (was createPlan({baseVersion}) → EM-9002 / whole queue)', async () => {
    const { runtime, bus, pid } = await editorWithBus();
    await connect(runtime);
    const spy = vi.spyOn(runtime.api, 'createPlan');
    const stalePlan = plan({ id: 'p-stale', projectId: pid, baseVersion: 'not-the-head', intentIds: ['gone-chat-intent'], steps: [{ n: 1, tool: 'composition.applyOps', ops: [], args: {}, expectedDiff: '', dependsOn: [] }] });
    await act(async () => { bus.emit('plan.ready', { projectId: pid, plan: stalePlan }); });
    await until(() => el('agent.editor.plancard'), 'plan card');
    await act(async () => { fireEvent.click(el('agent.editor.execute')!); });
    await until(() => spy.mock.calls.length > 0, 're-plan request');
    expect(spy.mock.calls[0]![1]).toMatchObject({ message: 'buat judul pembuka yang kuat', mode: 'agent' });
    expect(spy.mock.calls[0]![1]).not.toEqual({ baseVersion: expect.any(String) });
  }, 30_000);
});

describe('U2 Stop while the message is still sending', () => {
  it('cancels the run as soon as the send names it, clears the bubble at once and leaves the earlier valid plan alone', async () => {
    const { runtime, bus, pid } = await editorWithBus();
    await connect(runtime);
    const head = (await runtime.api.getComposition(pid)).head.hash;
    const earlier = plan({ id: 'p-earlier', projectId: pid, baseVersion: head, steps: [{ n: 1, tool: 'composition.applyOps', ops: [], args: {}, expectedDiff: '', dependsOn: [] }] });
    await act(async () => { bus.emit('plan.ready', { projectId: pid, plan: earlier }); });
    await until(() => el('agent.editor.plancard'), 'earlier plan card');
    let answer!: (v: { message: never; runId: string }) => void;
    const send = vi.spyOn(runtime.api, 'sendMessage').mockImplementation(() => new Promise((res) => { answer = res as never; }));
    const cancelRun = vi.spyOn(runtime.api, 'cancelAgentRun').mockResolvedValue(undefined as never);
    const cancelPlan = vi.spyOn(runtime.api, 'cancelPlan');
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.chat.progress.stop'), 'sending bubble with Stop');
    expect(send).toHaveBeenCalled();
    await act(async () => { fireEvent.click(el('agent.chat.progress.stop')!); });
    expect(el('agent.chat.streaming')).toBeNull();                                            // the bubble goes at once
    expect(cancelPlan).not.toHaveBeenCalled();                                                // the earlier plan is not touched
    expect(cancelRun).not.toHaveBeenCalledWith(PENDING_RUN);
    const msg = { id: 'm-late', role: 'user', blocks: [{ type: 'text', text: 'buat judul' }], agentRunId: null, createdAt: new Date().toISOString() };
    await act(async () => { answer({ message: msg as never, runId: 'run-late' }); });
    await until(() => cancelRun.mock.calls.some((c) => c[0] === 'run-late'), 'the late run cancelled');
    expect(el('agent.chat.streaming')).toBeNull();
    await act(async () => { bus.emit('agent.run.progress', { projectId: pid, runId: 'run-late', agent: 'editor', phase: 'planning' }); });
    expect(el('agent.chat.streaming')).toBeNull();                                            // its later events are ignored
    expect(el('agent.editor.plancard')?.getAttribute('data-status')).toBe('valid');
  }, 30_000);

  it('reducer: streamingStop with the run id remembers it as done (later events of that run are ignored)', () => {
    let s = reducer(initialState, { type: 'streamingStart', agent: 'editor', runId: 'r9', modelId: 'm' });
    s = reducer(s, { type: 'streamingStop', agent: 'editor', runId: 'r9' });
    expect(s.streaming.editor).toBeNull();
    expect(s.doneRuns).toContain('r9');
    s = reducer(s, { type: 'event', event: { name: 'agent.run.delta', data: { runId: 'r9', agent: 'editor', delta: 'x', at: '' } } as never });
    expect(s.streaming.editor).toBeNull();
  });
});

describe('A4 hand-off card state comes from the run\'s plan', () => {
  it('planning card with no live run: ready / applied from its plan, failed without one (never "ready" for nothing)', () => {
    expect(handoffStateOf('r1', [plan({ agentRunId: 'r1', status: 'valid' })], false)).toBe('ready');
    expect(handoffStateOf('r1', [null, plan({ agentRunId: 'r1', status: 'executed' })], false)).toBe('applied');
    expect(handoffStateOf('r1', [plan({ agentRunId: 'r1', status: 'cancelled' })], false)).toBe('failed');
    expect(handoffStateOf('r1', [plan({ agentRunId: 'other', status: 'valid' })], false)).toBe('failed');
    expect(handoffStateOf('r1', [], false)).toBe('failed');
  });
});

describe('U4 / U5 plan step notices', () => {
  it('a failed generator step shows ONE danger toast naming its tool', async () => {
    const { bus, pid } = await editorWithBus();
    const before = els('sys.toast').length;
    await act(async () => { bus.emit('service.notice', { kind: 'plan-step', projectId: pid, planId: 'p', step: 2, tool: 'tts.generate', status: 'failed', code: 'EM-7101' }); });
    await until(() => els('sys.toast').length > before, 'toast');
    await new Promise((r) => setTimeout(r, 50));
    expect(els('sys.toast').length - before).toBe(1);
    expect(toasts()).toContain(t('ui.agent.plan.tool.tts.short'));
  }, 20_000);

  it('needs-model and resumed have words in en and id (no raw key)', () => {
    for (const k of ['ui.agent.plan.step.status.needs-model', 'ui.agent.plan.step.status.resumed', 'ui.stage.itemmenu.cut.partial', 'ui.stage.itemmenu.cut.toomany', 'ui.agent.plan.close.executing', 'ui.scr.generate.music.library.play.needsdownload']) {
      expect((en as Record<string, string>)[k], k).toBeTruthy();
      expect((id as Record<string, string>)[k], k).toBeTruthy();
    }
  });
});

describe('U7 Cut removes only what reaches the clipboard', () => {
  const withBed = (): CompositionModelT => {
    let n = 0;
    const r = applyOperations(createEmptyModel('p', { autoRatio: false }), [
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Satu' } },
      { op: 'op:audio.addBed', args: { assetId: 'bed', volume: 0.3 } },
      { op: 'op:audio.addLayer', args: { assetId: 'vo', atMs: 0, volume: 1 } }],
    { assets: [{ id: 'bed', kind: 'audio', status: 'ready', durationMs: 9000, name: 'bed.mp3' }, { id: 'vo', kind: 'audio', status: 'ready', durationMs: 2000, name: 'vo.wav' }], tier: 'T1', newId: () => `e${++n}` });
    if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model;
  };
  it('a music bed in the selection stays on the timeline; only the copied items are removed', async () => {
    const m = withBed();
    const bed = m.tracks.audio.find((a) => a.role === 'bed')!; const vo = m.tracks.audio.find((a) => a.role !== 'bed')!;
    const sel = [{ kind: 'audio' as const, id: bed.id }, { kind: 'audio' as const, id: vo.id }];
    expect(cutRefs(m, sel)).toEqual([{ kind: 'audio', id: vo.id }]);
    const edits: unknown[] = []; const shown: string[] = [];
    expect(runCut({ model: m, selection: sel, itemsEdit: async (e) => { edits.push(e); return true; }, toast: (_k, key) => { shown.push(key); }, t })).toBe(true);
    expect(edits).toEqual([{ action: 'remove', items: [{ kind: 'audio', id: vo.id }] }]);
    expect(timelineClipboard.get()?.entries).toHaveLength(1);
    expect(shown).toContain('ui.stage.itemmenu.cut.partial');
    // only a bed: nothing is cut (it could never be pasted back)
    edits.length = 0;
    expect(runCut({ model: m, selection: [{ kind: 'audio', id: bed.id }], itemsEdit: async (e) => { edits.push(e); return true; }, toast: () => undefined, t })).toBe(false);
    expect(edits).toEqual([]);
  });
});

describe('U8 plan preview times include transitions', () => {
  it('3 × 3 s scenes with two 0.5 s transitions: starts 0 / 2.5 / 5.0 s, total 8.0 s (was 9.0 s)', () => {
    const p = plan({ steps: [{ n: 1, tool: 'composition.applyOps', args: {}, expectedDiff: '', dependsOn: [], ops: [
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'A' } },
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'B', transition: 'preset:transition.fade', transitionMs: 500 } },
      { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'C' } },
      { op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } },
    ] as never }] });
    const rows = previewRows(p, createEmptyModel('p', { autoRatio: false }), 'id');
    expect(rows.filter((r) => r.kind === 'scene').map((r) => r.startMs)).toEqual([0, 2500, 5000]);
    expect(previewDurationMs(rows)).toBe(8000);
  });
});

describe('U9 queue events are normalised', () => {
  it('intent.updated with an intent stored by an older build (no resolvedTargets / params) is made safe', () => {
    const s = reducer(initialState, { type: 'event', event: { name: 'intent.updated', data: { projectId: undefined, queue: { projectId: 'x', headHash: 'h', lockedKeys: [], items: [{ id: 'i1', status: 'queued' }] }, changed: [], reason: 'created', at: '' } } as never });
    expect(s.queue?.items[0]).toMatchObject({ params: {}, resolvedTargets: [] });
  });
});

describe('U11 / U12 small UI fixes', () => {
  it('a crashed toast stack shows its error card (not className "hidden")', () => {
    expect(TOASTS_FAILED_CLS).not.toMatch(/\bhidden\b/);
    const Boom = () => { throw new Error('toast crash'); };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<SectionBoundary section="toasts" className={TOASTS_FAILED_CLS}><Boom /></SectionBoundary>);
    const card = document.querySelector('[data-el="sys.section.error"][data-section="toasts"]') as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.className).toContain('fixed');
    expect(el('sys.section.reload')).not.toBeNull();
  });
  it('music duration rounds first: 119.6 s is 2:00, 59.5 s is 1:00, 61 s is 1:01', () => {
    expect(mmss(119.6)).toBe('2:00'); expect(mmss(59.5)).toBe('1:00'); expect(mmss(61)).toBe('1:01'); expect(mmss(0)).toBe('0:00');
  });
});

describe('U13 menu Paste uses the live playhead', () => {
  it('Paste from the item menu lands at player.currentMs() (while playing the settled state.playheadMs is stale)', async () => {
    const { runtime } = await renderEditor('sample');
    await until(() => bars('clip').length === 3 && playerBus.get(), 'player ready');
    fireEvent.contextMenu(bars('clip')[0]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu');
    await act(async () => { fireEvent.click(el('stage.itemmenu.copy')!); });
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const ctl = playerBus.get()!;
    playerBus.set({ ...ctl, currentMs: () => 4321 });
    fireEvent.contextMenu(bars('clip')[2]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu again');
    await act(async () => { fireEvent.click(el('stage.itemmenu.paste')!); });
    await until(() => spy.mock.calls.length > 0, 'paste pick');
    expect((spy.mock.calls[0]![1] as { itemsEdit?: { paste?: { atMs: number } } }).itemsEdit?.paste?.atMs).toBe(4321);
    playerBus.set(ctl);
  }, 20_000);
});
