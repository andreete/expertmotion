// @vitest-environment jsdom
// FR-059 fullscreen frame with controls overlay, FR-066 ruler drag-to-scrub, FR-069 empty state hides lanes, FR-067 inspector
// target + FR-080 selection/playhead + FR-072 attachments on the Editor message, FR-076 invalid proposals greyed with reason,
// FR-079 Remove on planned items, FR-081 EM-2302 dropped steps struck through, FR-084 Cancel while executing.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createEmptyModel } from '@expertmotion/composition-model';
import { renderEditor, el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { PlanCard, lockedSteps } from '../src/agent/PlanCard.js';
import { proposalIssue, proposalTarget } from '../src/agent/proposals.js';
import { translate } from '../src/i18n/index.js';
import type { EditIntent, PlanDto } from '../src/api/types.js';

afterEach(() => cleanup());
if (typeof window !== 'undefined' && !('PointerEvent' in window)) (window as unknown as Record<string, unknown>)['PointerEvent'] = MouseEvent;
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);

async function connect(runtime: Runtime) {
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
  });
  await openProvidersFromChat();
  await waitFor(() => { if (!el('scr.providers')?.textContent?.includes('OpenRouter')) throw new Error('providers'); });
  fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
  await waitFor(() => { if (chatComposer('editor')?.hasAttribute('readonly')) throw new Error('composer disabled'); });
}

describe('Stage (FR-059, FR-066, FR-069)', () => {
  it('FR-059: fullscreen puts the whole Player frame in fullscreen with our controls as an overlay; leaving restores the bar', async () => {
    const proto = HTMLElement.prototype as unknown as { requestFullscreen?: () => Promise<void> };
    const docAny = document as unknown as { exitFullscreen?: () => Promise<void> };
    let full: Element | null = null;
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => full });
    proto.requestFullscreen = function (this: HTMLElement) { full = this; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
    docAny.exitFullscreen = () => { full = null; document.dispatchEvent(new Event('fullscreenchange')); return Promise.resolve(); };
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('stage.player.controls.fullscreen')!); });
    expect(full).toBe(el('stage.player.frame'));
    expect(el('stage.player.frame')?.getAttribute('data-fullscreen')).toBe('true');
    expect(el('stage.player.controls')?.className).toContain('absolute');
    expect(el('stage.player.controls.fullscreen')?.getAttribute('aria-label')).toMatch(/Exit fullscreen/);
    await act(async () => { fireEvent.click(el('stage.player.controls.fullscreen')!); });
    expect(el('stage.player.frame')?.hasAttribute('data-fullscreen')).toBe(false);
    expect(el('stage.player.controls')?.className).not.toContain('absolute');
  });

  it('FR-066: click and drag on the ruler scrub the playhead and the Player time; releasing stops scrubbing', async () => {
    await renderEditor('sample');
    const time = () => el('stage.player.controls.time')!.textContent;
    const ruler = el('stage.timeline.ruler')!;
    await act(async () => { fireEvent.pointerDown(ruler, { button: 0, clientX: 60 }); });
    const atDown = time();
    expect(atDown).not.toBe('00:00.00');
    await act(async () => { fireEvent.pointerMove(window, { clientX: 300 }); });
    const atMove = time();
    expect(atMove).not.toBe(atDown);
    await act(async () => { fireEvent.pointerUp(window, { clientX: 300 }); fireEvent.pointerMove(window, { clientX: 10 }); });
    expect(time()).toBe(atMove);
  });

  it('FR-069: a new project shows only the empty state; lanes and ruler are hidden', async () => {
    await renderEditor('empty');
    expect(el('stage.timeline.empty')?.textContent).toBe(t('ui.stage.timeline.empty'));
    expect(el('stage.timeline.track.video')).toBeNull();
    expect(el('stage.timeline.ruler')).toBeNull();
  });
});

describe('Editor Chat message envelope (FR-067, FR-072, FR-080) and queue (FR-079)', () => {
  it('Ask Editor Agent → the next message carries target {kind,id}, selection, playhead and the attachments; the chat intent has the target', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    const spy = vi.spyOn(runtime.api, 'sendMessage');
    const clip = document.querySelectorAll<HTMLElement>('[data-el="stage.timeline.track.video"] [data-el="stage.timeline.element"][data-kind="clip"]')[1]!;
    const clipId = clip.getAttribute('data-element-id')!;
    fireEvent.click(clip);
    await act(async () => { fireEvent.click(within(el('stage.timeline.inspector')!).getByRole('button', { name: t('ui.stage.timeline.inspector.ask') })); });
    await waitFor(() => { if (!chatComposer('editor')?.closest('div')) throw new Error('no composer'); });
    // attach an image from disk (Claude Sonnet has image input in the mock Capability Table)
    const input = el('agent.chat')!.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } }); });
    await waitFor(() => { if (!el('agent.chat')?.textContent?.includes('logo.png')) throw new Error('no chip'); });
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat klip ini lebih cepat' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await waitFor(() => { if (!spy.mock.calls.length) throw new Error('not sent'); });
    const bodySent = spy.mock.calls[0]![2];
    expect(bodySent.target).toEqual({ kind: 'clip', id: clipId });
    expect(bodySent.selection).toEqual([{ kind: 'clip', id: clipId }]);
    expect(typeof bodySent.playheadMs).toBe('number');
    expect(bodySent.attachments).toHaveLength(1);
    await waitFor(() => { if (!els('agent.chat.message').some((m) => m.textContent?.includes('logo.png'))) throw new Error('no attachment in thread'); });
    // FR-079: the planned chat intent can be removed
    await waitFor(() => { if (!document.querySelector('[data-el="agent.editor.intentqueue.item"][data-status="planned"]')) throw new Error('no planned item'); });
    const planned = document.querySelector<HTMLElement>('[data-el="agent.editor.intentqueue.item"][data-status="planned"]')!;
    expect(planned.querySelector('[data-el="agent.editor.intentqueue.item.remove"]')).not.toBeNull();
  }, 20_000);
});

describe('Hand-off card (FR-076)', () => {
  const model = (() => { const m = createEmptyModel('p'); m.tracks.video.push({ id: 'c1' } as never, { id: 'c2' } as never, { id: 'c3' } as never); return m; })();
  const pi = (o: Partial<EditIntent>): EditIntent => ({ id: 'x', projectId: 'p', source: 'brainstorm', createdAt: '', category: 'transition', params: {}, target: { kind: 'selection' }, resolvedTargets: [], propertyKey: '', propertyClass: 'exclusive-group', needsInterpretation: false, status: 'queued', supersedes: [], baseVersion: '', ...o });
  it('flags unknown presets, out-of-range params and a project without clips; valid ones pass', () => {
    expect(proposalIssue(pi({ presetId: 'preset:transition.fade' }), model, t)).toBeNull();
    expect(proposalIssue(pi({ presetId: 'preset:transition.nope' }), model, t)?.code).toBe('EM-2101');
    expect(proposalIssue(pi({ category: 'effect', presetId: 'preset:effect.blur', params: { radius: 999 } }), model, t)?.code).toBe('EM-2102');
    expect(proposalIssue(pi({ presetId: 'preset:transition.fade' }), createEmptyModel('p'), t)?.code).toBe('EM-2202');
  });
  it('says where a change lands in plain words', () => {
    expect(proposalTarget(pi({ presetId: 'preset:transition.fade' }), model, t)).toBe('all 2 cuts');
    expect(proposalTarget(pi({ category: 'text', target: { kind: 'project' } }), model, t)).toBe('project');
    expect(proposalTarget(pi({ category: 'motion', target: { kind: 'clip', id: 'c2' } }), model, t)).toBe(t('ui.common.target.clip', { n: 2 }));
    expect(proposalTarget(pi({ category: 'text' }), model, t)).toBe('new text');
  });
});

describe('Plan Card (FR-081, FR-084)', () => {
  const plan = (o: Partial<PlanDto>): PlanDto => ({ id: 'pl', projectId: 'p', baseVersion: 'h', origin: 'editor-agent', goal: 'Transisi', status: 'valid', touchesLockedKeys: [], risks: [], validation: [],
    steps: [{ n: 2, tool: 'composition.applyOps', ops: [{ op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.fade', durationMs: 400 } }], args: {}, expectedDiff: 'Fade cut 2', dependsOn: [] }], ...o } as PlanDto);
  it('lists steps EM-2302 removed struck through with the inline notice', () => {
    const p = plan({ validation: [{ path: 'droppedSteps[1]', code: 'EM-2302', message: '1. Fade cut 1 (cut:0.transition)' }] });
    expect(lockedSteps(p).dropped).toEqual([{ n: 1, text: 'Fade cut 1 (cut:0.transition)' }]);
    render(<StoreProvider runtime={createMockRuntime({ seed: 'sample', delays: false })} initialPrefs={{ onboardingDone: true }}><PlanCard plan={p} /></StoreProvider>);
    const dropped = el('agent.editor.plancard.step.dropped')!;
    expect(dropped.className).toContain('line-through');
    expect(dropped.textContent).toContain('Fade cut 1');
    expect(el('agent.editor.plancard.locked')?.textContent).toContain('EM-2302');
    expect(el('agent.editor.plancard.locked')?.textContent).toContain('cut:0.transition');
    expect(document.querySelectorAll('[data-el="agent.editor.plancard.risk"]')).toHaveLength(0);
  });
  it('a plan that still touches a Locked Key strikes those steps through', () => {
    const p = plan({ status: 'invalid', touchesLockedKeys: ['cut:1.transition'] });
    expect([...lockedSteps(p).touching]).toEqual([2]);
    render(<StoreProvider runtime={createMockRuntime({ seed: 'sample', delays: false })} initialPrefs={{ onboardingDone: true }}><PlanCard plan={p} /></StoreProvider>);
    expect(el('agent.editor.plancard.step')?.getAttribute('data-locked')).toBe('true');
    expect(el('agent.editor.plancard.locked')).not.toBeNull();
  });
  it('FR-084: an executing plan offers Cancel', () => {
    render(<StoreProvider runtime={createMockRuntime({ seed: 'sample', delays: false })} initialPrefs={{ onboardingDone: true }}><PlanCard plan={plan({ status: 'executing' })} /></StoreProvider>);
    expect(document.querySelector(`button[aria-label="${t('ui.agent.plan.cancelexecute')}"]`)).not.toBeNull();
  });
});
