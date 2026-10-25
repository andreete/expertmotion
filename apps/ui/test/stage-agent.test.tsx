// @vitest-environment jsdom
// Stage + Agent Panel + Output Settings gaps (FRD FR-055…FR-099): Auto ratio through the Intent Queue, Reset to the Project
// defaults as one version, pixel table, Learn more, Private Mode confirm, Player quality label and per-Project choices,
// Timeline bars/zoom/inspector provenance, chat copy/recovery/attach/model picker/context counter, Plan Card details.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react';
import { createEmptyModel, applyOperations, type CompositionModelT } from '@expertmotion/composition-model';
import { renderEditor, el, els } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { initialState } from '../src/state/reducer.js';
import { buildBars, clipDragEdit, provenanceOf } from '../src/stage/Timeline.js';
import { executeDisabledReason, diffSummary } from '../src/agent/PlanCard.js';
import { ctxTone, systemCode, MAX_ATTACH_BYTES } from '../src/agent/Chat.js';
import { appliedDirectly } from '../src/agent/EditorChat.js';
import { playerPrefsFor, playerPrefsPatch, loadPrefs } from '../src/prefs.js';
import { translate } from '../src/i18n/index.js';
import type { EditIntent, PlanDto } from '../src/api/types.js';

afterEach(() => cleanup());
// jsdom has no PointerEvent: testing-library then builds a plain Event without clientX.
if (typeof window !== 'undefined' && !('PointerEvent' in window)) (window as unknown as Record<string, unknown>)['PointerEvent'] = MouseEvent;
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);

async function connect(runtime: Runtime, editorModel = 'anthropic/claude-sonnet-4.5') {
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: editorModel, settings: {} } });
  });
  fireEvent.click(el('agent.modelbar')!);
  await waitFor(() => { if (!el('scr.providers')?.textContent?.includes('OpenRouter')) throw new Error('providers'); });
  fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
  await waitFor(() => { if (el('agent.editor.composer')?.hasAttribute('readonly')) throw new Error('composer disabled'); });
}
const queueTitles = () => els('agent.editor.intentqueue.item').map((n) => n.textContent ?? '');

describe('Output Settings (FR-087…FR-097)', () => {
  it('FR-088: Auto shows the armed hint without clips, routes through the queue, and a manual pick turns it off; it can be turned on again', async () => {
    await renderEditor('empty');
    expect(el('agent.output.ratio.auto')?.getAttribute('aria-checked')).toBe('true');
    expect(el('agent.output.ratio.auto.hint')?.textContent).toMatch(/applies after the first insert/);
    await act(async () => { fireEvent.click(el('agent.output.ratio.1x1')!); });
    await waitFor(() => { if (el('agent.output.ratio.auto')?.getAttribute('aria-checked') !== 'false') throw new Error('auto still on'); });
    expect(el('agent.output.ratio.1x1')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => { fireEvent.click(el('agent.output.ratio.auto')!); });
    await waitFor(() => { if (el('agent.output.ratio.auto')?.getAttribute('aria-checked') !== 'true') throw new Error('auto not re-enabled'); });
    expect(queueTitles().some((x) => x.includes('Auto ratio on'))).toBe(true);
    expect(queueTitles().some((x) => x.includes('Ratio 1:1'))).toBe(true);
  }, 20_000);

  it('FR-095/FR-097: Reset restores the Project defaults in one version (one Undo) and stays visible in the queue', async () => {
    await renderEditor('sample');
    await act(async () => { fireEvent.click(el('agent.output.ratio.1x1')!); });
    await act(async () => { fireEvent.click(el('agent.output.resolution.720p')!); });
    await waitFor(() => { if (el('agent.output.resolution.720p')?.getAttribute('aria-checked') !== 'true') throw new Error('no 720p'); });
    await act(async () => { fireEvent.click(el('agent.output.reset')!); });
    expect(el('scr.confirm')?.textContent).toMatch(/9:16 · 1080p · Standard · Auto off/);
    await act(async () => { fireEvent.click(within(el('scr.confirm')!).getByRole('button', { name: 'Reset to Defaults' })); });
    await waitFor(() => { if (el('agent.output.ratio.9x16')?.getAttribute('aria-checked') !== 'true' || el('agent.output.resolution.1080p')?.getAttribute('aria-checked') !== 'true') throw new Error('not reset'); });
    expect(queueTitles().some((x) => x.includes('Ratio 9:16'))).toBe(true);
    await act(async () => { fireEvent.click(el('hdr.action.undo')!); });
    await waitFor(() => { if (el('agent.output.ratio.1x1')?.getAttribute('aria-checked') !== 'true' || el('agent.output.resolution.720p')?.getAttribute('aria-checked') !== 'true') throw new Error('one undo did not restore both'); });
  }, 20_000);

  it('FR-087/FR-091: the ratio help shows the computed pixel table; Learn more explains the profiles', async () => {
    await renderEditor('sample');
    fireEvent.click(el('agent.output.ratio.help')!);
    const table = el('agent.output.ratio.help.table')!;
    expect(table.textContent).toContain('1080×1350');
    expect(table.textContent).toContain('2160×2700');
    expect(table.textContent).toContain('2700×2160');
    await act(async () => { fireEvent.click(el('agent.output.profile.help.learnmore')!); });
    await waitFor(() => { if (!el('scr.help')) throw new Error('help not open'); });     // FR-091: Learn more → Help ▸ Performance profiles
    expect(document.querySelector('[data-help-section="performance"]')?.hasAttribute('open')).toBe(true);
    expect(el('scr.help.performance.table')?.textContent).toContain('70 % of RAM');
    expect(el('agent.output.profile.help')?.getAttribute('title')).toBe('Profiles change how many frames render in parallel and how much memory Expertmotion may use. Faster profiles need more RAM and a GPU; the video itself is identical.');
  }, 20_000);

  it('FR-094: turning Private Mode on while an agent streams asks first, then cancels', async () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: true });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!document.querySelector('[data-el="agent.output.ratio.9x16"][aria-checked]')) throw new Error('no project'); }, { timeout: 8000 });
    await connect(runtime);
    fireEvent.change(el('agent.brainstorm.composer')!, { target: { value: 'ide intro energik untuk video kopi' } });
    await act(async () => { fireEvent.keyDown(el('agent.brainstorm.composer')!, { key: 'Enter' }); });
    await waitFor(() => { if (!document.body.textContent?.includes('Asking')) throw new Error('not streaming'); });
    await act(async () => { fireEvent.click(el('agent.output.private')!); });
    expect(el('scr.confirm')?.textContent).toContain('This stops the current request.');
    await act(async () => { fireEvent.click(within(el('scr.confirm')!).getByRole('button', { name: 'Turn on and stop' })); });
    await waitFor(() => { if (!el('sys.privatemode.banner')) throw new Error('no banner'); });
  }, 20_000);
});

describe('Player (FR-058, FR-060)', () => {
  it('shows "W×H · Draft/Full" and keeps the Player menu choices per Project', async () => {
    await renderEditor('sample');
    expect(el('stage.player.controls.res')?.textContent).toBe('1080×1920 · Draft');
    fireEvent.click(el('stage.player.menu')!);
    await act(async () => { fireEvent.click(el('stage.player.menu.draft')!); });
    await waitFor(() => { if (el('stage.player.controls.res')?.textContent !== '1080×1920 · Full') throw new Error(String(el('stage.player.controls.res')?.textContent)); });
    const prefs = loadPrefs();
    expect(Object.values(prefs.playerByProject).some((p) => p.draft === false)).toBe(true);
    expect(prefs.draft).toBe(true);                                   // the global default is untouched
  }, 20_000);
  it('per-Project player prefs fall back to the globals', () => {
    const base = { ...loadPrefs(), safeArea: false, draft: true, loop: false, muted: false, playerByProject: {} };
    const p = { ...base, ...playerPrefsPatch(base, 'p1', { loop: true }) };
    expect(playerPrefsFor(p, 'p1')).toEqual({ safeArea: false, draft: true, loop: true, muted: false });
    expect(playerPrefsFor(p, 'p2').loop).toBe(false);
  });
});

describe('Timeline View (FR-063, FR-064, FR-067)', () => {
  const facts = [{ id: 'v1', kind: 'video' as const, status: 'ready' as const, durationMs: 5000, width: 1080, height: 1920 }, { id: 'vo', kind: 'audio' as const, status: 'ready' as const, durationMs: 2000 }];
  const model = (): CompositionModelT => {
    const r = applyOperations(createEmptyModel('p', { autoRatio: false }), [
      { op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: 'v1' } }, { op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId: 'v1' } },
      { op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.gradient' } },
      { op: 'op:audio.addLayer', args: { assetId: 'vo', atMs: 0, volume: 1 } },
    ], { assets: facts, tier: 'T1', newId: (() => { let n = 0; return () => `e${++n}`; })() });
    if (!r.ok) throw new Error(JSON.stringify(r.issues));
    const m = r.value.model;
    m.tracks.video[0]!.effects.push({ presetId: 'preset:effect.blur', params: {}, motion: 'static' });
    return m;
  };
  it('FR-064: background spans the whole duration, effects get bars, generated assets are marked', () => {
    const bars = buildBars(model(), (id) => id, 'en', new Set(['vo']));
    const bg = bars.find((b) => b.kind === 'background')!;
    expect([bg.fromMs, bg.toMs]).toEqual([0, 10_000]);
    expect(bars.find((b) => b.kind === 'effect')).toMatchObject({ fromMs: 0, toMs: 5000, ref: { kind: 'effect' } });
    expect(bars.find((b) => b.kind === 'audio')?.generated).toBe(true);
    expect(bars.find((b) => b.kind === 'clip')?.generated).toBe(false);
  });
  it('FR-067: provenance names the newest applied intent and the executed plan that touched the element', () => {
    const m = model(); const clip = m.tracks.video[1]!;
    const intent = { id: 'int-1', status: 'executed', createdAt: '2026-10-24T08:00:00Z', resolvedTargets: [{ kind: 'clip', id: clip.id }] } as unknown as EditIntent;
    const plan = { id: 'plan-12', status: 'executed', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:motion.set', target: { kind: 'clip', id: clip.id }, args: {} }], args: {}, expectedDiff: '', dependsOn: [] }] } as unknown as PlanDto;
    const st = { ...initialState, queue: { projectId: 'p', headHash: 'abcdef123', items: [intent], lockedKeys: [] }, plan, head: { hash: 'abcdef123' } as never };
    expect(provenanceOf({ kind: 'clip', id: clip.id }, st)).toEqual({ intentId: 'int-1', planId: 'plan-12', version: 'abcdef' });
    expect(provenanceOf({ kind: 'clip', id: m.tracks.video[0]!.id }, st)).toMatchObject({ intentId: null, planId: null });
  });
  it('FR-068: drag edits are frame-snapped, kept inside the source media and become clip.move / clip.setTrim picks', () => {
    const m = model(); const [a, b] = m.tracks.video;
    const asset = (id: string) => (id === 'v1' ? { kind: 'video', durationMs: 5000 } : null);
    expect(clipDragEdit(m, a!.id, 'move', 6000, asset)).toEqual({ clipId: a!.id, toIndex: 1 });
    expect(clipDragEdit(m, a!.id, 'move', 1000, asset)).toBeNull();
    expect(clipDragEdit(m, b!.id, 'end', -2010, asset)).toEqual({ clipId: b!.id, trimBeforeMs: 0, durationMs: 3000 });   // 30 fps: snapped to 3000
    expect(clipDragEdit(m, b!.id, 'end', 9000, asset)).toBeNull();                                                         // cannot pass the source end
    expect(clipDragEdit(m, b!.id, 'start', 1000, asset)).toEqual({ clipId: b!.id, trimBeforeMs: 1000, durationMs: 4000 });
  });
  it('FR-068: dragging a clip on the video Track reorders it through the Intent Queue', async () => {
    await renderEditor('sample');
    const clips = () => [...document.querySelectorAll<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]')].filter((n) => n.closest('[data-el="stage.timeline.track.video"]'));
    const first = clips()[0]!; const firstId = first.getAttribute('data-element-id');
    first.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 28, width: 100, height: 28, x: 0, y: 0, toJSON: () => ({}) });
    await act(async () => {
      fireEvent.pointerDown(first, { clientX: 50, button: 0 });
      window.dispatchEvent(new MouseEvent('pointermove', { clientX: 5000 }));
      window.dispatchEvent(new MouseEvent('pointerup', { clientX: 5000 }));
    });
    await waitFor(() => { if (clips().at(-1)?.getAttribute('data-element-id') !== firstId) throw new Error(`not moved ${queueTitles().join(' | ')} || ${[...document.querySelectorAll('[data-el="sys.toast"]')].map((n) => n.textContent).join(' | ')} || ${clips().map((c) => c.getAttribute('data-element-id')).join(',')} ${firstId}`); });
    expect(queueTitles().some((x) => x.includes('Insert'))).toBe(true);
  }, 20_000);
  it('FR-063: Ctrl+wheel zooms the lanes; FR-067 inspector shows provenance rows', async () => {
    await renderEditor('sample');
    const lanes = document.querySelector<HTMLElement>('[data-el="stage.timeline"] [role="grid"]')!;
    const inner = lanes.firstElementChild as HTMLElement;
    const before = parseFloat(inner.style.width);
    await act(async () => { lanes.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })); });
    await waitFor(() => { if (!(parseFloat(inner.style.width) > before)) throw new Error(`no zoom ${inner.style.width} vs ${before}`); });
    fireEvent.click(document.querySelector('[data-el="stage.timeline.element"][data-kind="clip"]')!);
    const insp = el('stage.timeline.inspector')!;
    expect(insp.textContent).toContain('From pick');
    expect(insp.textContent).toContain('Version');
    expect(insp.textContent).toContain('Asset');
  }, 20_000);
});

describe('Agent Panel (FR-071…FR-086)', () => {
  it('FR-074/FR-077/FR-083/FR-086 helpers', () => {
    expect([ctxTone(0.5), ctxTone(0.6), ctxTone(0.79), ctxTone(0.8)]).toEqual(['muted', 'warn', 'warn', 'danger']);
    expect(systemCode('EM-4101: The AI provider took too long to answer.')).toBe('EM-4101');
    expect(systemCode('Nothing to see')).toBeNull();
    expect(MAX_ATTACH_BYTES).toBe(10 * 1024 * 1024);
    const plan = { id: 'p', status: 'valid', baseVersion: 'h', risks: [] } as unknown as PlanDto;
    expect(executeDisabledReason(plan, 'h', t)).toBeNull();
    expect(executeDisabledReason(plan, 'h', t, { hasClip: false })).toBe('Insert at least one clip first');
    expect(executeDisabledReason(plan, 'h', t, { running: true })).toBe('Wait for the current request to finish');
    expect(executeDisabledReason(null, 'h', t)).toBe('No plan yet');
    expect(diffSummary({ ok: true, toVersion: 'x', appliedOps: 4, added: 3, modified: 1, removed: 0 }, t)).toBe('3 added, 1 modified');
    const ui = { id: 'a', source: 'ui', status: 'executed', needsInterpretation: false, params: {} } as unknown as EditIntent;
    const agent = { id: 'b', source: 'chat', status: 'executed', needsInterpretation: true, params: {} } as unknown as EditIntent;
    const sys = { id: 'c', source: 'system', status: 'executed', needsInterpretation: false, params: { __output: { kind: 'ratio', value: '1:1' } } } as unknown as EditIntent;
    expect(appliedDirectly([ui, agent, sys]).map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('FR-071: hollow dot when not connected', async () => {
    await renderEditor('sample');
    expect(el('agent.modelbar.status')?.getAttribute('data-status')).toBe('none');
    expect(el('agent.modelbar.status')?.querySelector('.border')).not.toBeNull();
  }, 20_000);

  it('FR-075/FR-077/FR-074: streamed reply, copy action, counter tooltip with summarisation and cost', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    fireEvent.change(el('agent.brainstorm.composer')!, { target: { value: 'ide intro energik untuk video kopi' } });
    await act(async () => { fireEvent.keyDown(el('agent.brainstorm.composer')!, { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.brainstorm.message.copy')) throw new Error('no reply'); });
    const ctx = el('agent.brainstorm.footer.ctx')!;
    await waitFor(() => { if (!ctx.getAttribute('title')?.includes('$0.002')) throw new Error(String(ctx.getAttribute('title'))); });
    expect(ctx.getAttribute('title')).toContain('60 %');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await act(async () => { fireEvent.click(els('agent.brainstorm.message.copy').at(-1)!); });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('energetic title'));
  }, 20_000);

  it('FR-073: the footer picker switches only the Editor model; FR-072 image attach is refused for a text-only model', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    expect(el('agent.editor.footer.model')?.textContent).toBe('Claude Sonnet 4.5 ▾');                // the model's label, never a tier name
    fireEvent.click(el('agent.editor.footer.model')!);
    await waitFor(() => { if (els('agent.editor.footer.model.picker.row').length < 2) throw new Error('no rows'); });
    expect(el('agent.editor.footer.model.picker.filter.json')?.getAttribute('aria-pressed')).toBe('false'); // nothing is refused: JSON chip off
    expect(el('agent.editor.footer.model.picker.category.all')?.getAttribute('aria-checked')).toBe('true');
    expect(el('agent.editor.footer.model.picker')!.querySelector('[data-model-id="anthropic/claude-sonnet-4.5"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(el('agent.editor.footer.model.picker.search'));
    fireEvent.change(el('agent.editor.footer.model.picker.search')!, { target: { value: 'QWEN' } });
    const rows = els('agent.editor.footer.model.picker.row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain('Qwen 2.5 7B');
    expect(rows[0]!.textContent).toContain('32K');                    // context column
    expect(rows[0]!.querySelector('[data-cap="image"]')).toBeNull();  // no image input
    await act(async () => { fireEvent.keyDown(el('agent.editor.footer.model.picker.search')!, { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.editor.footer.model')?.querySelector('[title="qwen/qwen-2.5-7b-instruct"]')) throw new Error('editor not switched'); });
    // a 7B model is allowed but warned: the popover stays open with the warning and "Use recommended instead"
    expect(el('agent.editor.footer.model.picker.warning')?.textContent).toMatch(/May give poor results/);
    expect(el('agent.editor.footer.model.picker.warning.recommended')).not.toBeNull();
    fireEvent.keyDown(el('agent.editor.footer.model.picker.search')!, { key: 'Escape' });
    expect(el('agent.editor.footer.model.popover')).toBeNull();
    expect(el('agent.editor.footer.model')?.textContent).toBe('Qwen 2.5 7B ▾');
    expect(el('agent.brainstorm.footer.model')?.querySelector('[title]')?.getAttribute('title')).toBe('openai/gpt-4.1-mini');
    expect(el('agent.brainstorm.footer.model')?.textContent).toBe('GPT-4.1 mini ▾');
    expect((await runtime.api.getAssignments()).brainstorm?.modelId).toBe('openai/gpt-4.1-mini');
    // attach an image from disk: > 10 MB → EM-1002; a small PNG → EM-4307 for the text-only model
    fireEvent.click(el('agent.editor.attach')!);
    const input = el('agent.editor.panel')!.querySelector<HTMLInputElement>('input[type="file"]')!;
    const big = new File(['x'], 'big.png', { type: 'image/png' }); Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 });
    await act(async () => { fireEvent.change(input, { target: { files: [big] } }); });
    expect(el('agent.editor.attach.error')?.textContent).toContain('EM-1002');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] } }); });
    await waitFor(() => { if (!el('agent.editor.attach.error')?.textContent?.includes('EM-4307')) throw new Error(String(el('agent.editor.attach.error')?.textContent)); });
    expect(el('agent.editor.send')?.getAttribute('aria-disabled')).toBe('true');
  }, 20_000);

  it('FR-081/FR-085: plan steps show ops counts and the model; a direct pick appears as an "Applied directly" line', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await act(async () => { fireEvent.click(el('agent.output.ratio.1x1')!); });
    await waitFor(() => { if (!el('agent.editor.message.applied')) throw new Error('no applied line'); });
    expect(el('agent.editor.message.applied')?.textContent).toMatch(/Applied directly: Ratio 1:1/);
    const hash = (await runtime.api.getComposition(runtime.seededProjectId!)).head.hash;
    expect(el('agent.editor.message.applied')?.textContent).toContain(`· ${hash.slice(0, 6)}`);       // FR-085: the short version hash, not v{n}
    fireEvent.change(el('agent.editor.composer')!, { target: { value: 'buat judul pembuka yang kuat' } });
    await act(async () => { fireEvent.keyDown(el('agent.editor.composer')!, { key: 'Enter' }); });
    await waitFor(() => { if (el('agent.editor.plancard')?.getAttribute('data-status') !== 'valid') throw new Error('no plan'); });
    expect(el('agent.editor.plancard.step.ops')?.textContent).toBe('1 op');
    expect(el('agent.editor.plancard.model')?.textContent).toBe('Claude Sonnet 4.5');                 // the model's label
    expect(el('agent.editor.plancard.model')?.getAttribute('title')).toBe('anthropic/claude-sonnet-4.5');
    await act(async () => { fireEvent.click(within(el('agent.editor.plancard')!).getByRole('button', { name: /Execute plan/ })); });
    await waitFor(() => { if (!el('agent.editor.plancard.result')) throw new Error(`no result ${el('agent.editor.plancard')?.getAttribute('data-status')} ${el('agent.editor.plancard')?.textContent}`); });
    expect(el('agent.editor.plancard.result')?.textContent).toMatch(/1 added/);
  }, 20_000);
});

describe('FR-090 / FR-097 Performance Profile through the Intent Queue', () => {
  const bootOn = async (tier: 'T1' | 'T2') => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const hw = runtime.api.hardwareProfile.bind(runtime.api);
    vi.spyOn(runtime.api, 'hardwareProfile').mockImplementation(async () => ({ ...(await hw()), tier }));
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('agent.output.ratio.9x16')?.hasAttribute('aria-checked') || el('agent.output.profile.turbo')?.getAttribute('aria-disabled') === 'true') throw new Error('not booted'); });
    return runtime;
  };
  it('FR-090: Turbo on T1 shows EM-3106 once, with Use Standard', async () => {
    await bootOn('T1');
    await act(async () => { fireEvent.click(el('agent.output.profile.turbo')!); });
    await waitFor(() => { if (!els('sys.toast').some((x) => x.textContent?.includes('Profile may be slow here'))) throw new Error('no EM-3106'); });
    const use = els('sys.toast').find((x) => x.textContent?.includes('Profile may be slow here'))!.querySelector<HTMLElement>('[data-el="sys.toast.action"]')!;
    await act(async () => { fireEvent.click(use); });
    await waitFor(() => expect(el('agent.output.profile.standard')?.getAttribute('aria-checked')).toBe('true'));
    for (const x of els('sys.toast')) { const d = x.querySelector<HTMLElement>('button[aria-label="Dismiss"]'); if (d) fireEvent.click(d); }
    await act(async () => { fireEvent.click(el('agent.output.profile.turbo')!); });   // second time: no EM-3106 again
    await waitFor(() => expect(el('agent.output.profile.turbo')?.getAttribute('aria-checked')).toBe('true'));
    expect(els('sys.toast').some((x) => x.textContent?.includes('Profile may be slow here'))).toBe(false);
    await act(async () => { fireEvent.click(el('agent.output.profile.standard')!); });
    await waitFor(() => expect(el('agent.output.profile.standard')?.getAttribute('aria-checked')).toBe('true'));
  }, 20_000);
  it('FR-095/FR-097: Reset restores ratio, resolution and profile as one queue-recorded unit; one Undo restores all three', async () => {
    const runtime = await bootOn('T2');
    const batch = vi.spyOn(runtime.api, 'createIntentBatch');
    await act(async () => { fireEvent.click(el('agent.output.ratio.1x1')!); });
    await act(async () => { fireEvent.click(el('agent.output.resolution.720p')!); });
    await act(async () => { fireEvent.click(el('agent.output.profile.turbo')!); });
    await waitFor(() => { if (el('agent.output.profile.turbo')?.getAttribute('aria-checked') !== 'true' || el('agent.output.resolution.720p')?.getAttribute('aria-checked') !== 'true') throw new Error('not set'); });
    await act(async () => { fireEvent.click(el('agent.output.reset')!); });
    await act(async () => { fireEvent.click(within(el('scr.confirm')!).getByRole('button', { name: 'Reset to Defaults' })); });
    await waitFor(() => { if (el('agent.output.ratio.9x16')?.getAttribute('aria-checked') !== 'true' || el('agent.output.profile.standard')?.getAttribute('aria-checked') !== 'true') throw new Error('not reset'); });
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]![1].picks.map((p) => p.output?.kind)).toEqual(['ratio', 'resolution', 'performanceProfile']);
    expect((await runtime.api.getSettings()).defaultPerformanceProfile).toBe('standard');
    await waitFor(() => { if (!els('agent.editor.intentqueue.item.superseded').some((i) => i.textContent?.includes('Turbo'))) throw new Error('turbo pick not superseded'); });
    await act(async () => { fireEvent.click(el('hdr.action.undo')!); });
    await waitFor(() => { if (el('agent.output.ratio.1x1')?.getAttribute('aria-checked') !== 'true' || el('agent.output.resolution.720p')?.getAttribute('aria-checked') !== 'true' || el('agent.output.profile.turbo')?.getAttribute('aria-checked') !== 'true') throw new Error('one undo did not restore all three'); });
    expect((await runtime.api.getSettings()).defaultPerformanceProfile).toBe('turbo');
  }, 20_000);

  it('a profile pick is a queue item (applied directly, no model), the next pick supersedes it, Undo restores the previous profile', async () => {
    try { localStorage.clear(); } catch { /* ignore */ }
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const hw = runtime.api.hardwareProfile.bind(runtime.api);
    vi.spyOn(runtime.api, 'hardwareProfile').mockImplementation(async () => ({ ...(await hw()), tier: 'T2' }));
    const spy = vi.spyOn(runtime.api, 'createIntent');
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('agent.output.ratio.9x16')?.hasAttribute('aria-checked') || el('agent.output.profile.turbo')?.getAttribute('aria-disabled') === 'true') throw new Error('not booted on T2'); });
    const queue = () => [...els('agent.editor.intentqueue.item'), ...els('agent.editor.intentqueue.item.superseded')];
    await act(async () => { fireEvent.click(el('agent.output.profile.turbo')!); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ category: 'output', output: { kind: 'performanceProfile', value: 'turbo' } });
    await waitFor(async () => expect((await runtime.api.getSettings()).defaultPerformanceProfile).toBe('turbo'));
    await waitFor(() => { if (!queue().some((i) => i.textContent?.includes('Performance profile Turbo') && i.getAttribute('data-status') === 'executed')) throw new Error(queue().map((i) => i.textContent).join('|')); });
    await waitFor(() => { if (!els('agent.editor.message.applied').some((x) => /Applied directly: Performance profile Turbo/.test(x.textContent ?? ''))) throw new Error('no applied line'); });
    await act(async () => { fireEvent.click(el('agent.output.profile.accelerated')!); });
    await waitFor(() => { if (!els('agent.editor.intentqueue.item.superseded').some((i) => i.textContent?.includes('Turbo'))) throw new Error('turbo not superseded'); });
    expect(el('agent.output.profile.accelerated')?.getAttribute('aria-checked')).toBe('true');
    const undo = els('sys.toast').filter((x) => x.textContent?.includes('Accelerated')).at(-1)!.querySelector<HTMLElement>('[data-el="sys.toast.action"]')!;
    await act(async () => { fireEvent.click(undo); });
    await waitFor(() => expect(el('agent.output.profile.turbo')?.getAttribute('aria-checked')).toBe('true'));
    expect((await runtime.api.getSettings()).defaultPerformanceProfile).toBe('turbo');
    await waitFor(() => { if (!els('agent.editor.intentqueue.item.superseded').some((i) => i.textContent?.includes('Accelerated'))) throw new Error('accelerated not superseded'); });
  }, 20_000);
});

describe('FR-098 inspector quick params', () => {
  it('validates against the preset params schema inline (EM-2102, nothing sent) and applies a valid value as a Compile pick', async () => {
    const { runtime } = await renderEditor('sample');
    const clip = () => document.querySelector<HTMLElement>('[data-el="stage.timeline.track.video"] [data-el="stage.timeline.element"][data-kind="clip"]')!;
    await act(async () => { fireEvent.click(clip()); });
    expect(el('stage.timeline.quickparams')).toBeNull();                     // nothing tweakable yet
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="effect"]')!); });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-preset-id="preset:effect.blur"]')!); });
    await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline.quickparams.field"][data-param="radiusPx"]')) throw new Error('no quick params'); });
    const spy = vi.spyOn(runtime.api, 'createIntent');
    const field = () => document.querySelector<HTMLInputElement>('[data-el="stage.timeline.quickparams.field"][data-param="radiusPx"]')!;
    fireEvent.change(field(), { target: { value: '80' } });
    await act(async () => { fireEvent.click(el('stage.timeline.quickparams.apply')!); });
    expect(el('stage.timeline.quickparams')!.textContent).toContain('EM-2102');
    expect(spy).not.toHaveBeenCalled();
    fireEvent.change(field(), { target: { value: '12' } });
    await act(async () => { fireEvent.click(el('stage.timeline.quickparams.apply')!); });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0]![1]).toMatchObject({ presetId: 'preset:effect.blur', params: { radiusPx: 12 }, target: { kind: 'clip' } });
    await waitFor(() => { if (field().value !== '12') throw new Error(`radius ${field().value}`); });
  }, 20_000);

  it('quickGroups: transition duration, motion duration/delay, effect values', async () => {
    const { quickGroups } = await import('../src/stage/QuickParams.js');
    const m = createEmptyModel('p1', { fps: 30, ratio: '9:16', resolution: '1080p', autoRatio: false, language: 'id' } as never);
    m.tracks.video = [0, 1].map((i) => ({ id: `c${i}`, assetId: 'a', trimBeforeMs: 0, durationMs: 3000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', effects: i === 0 ? [{ presetId: 'preset:effect.vignette', params: { intensity: 0.4 }, motion: 'static' }] : [], motion: i === 0 ? { presetId: 'preset:motion.rise', durationMs: 600, delayMs: 0, exit: true, params: { distanceU: 40 } } : null })) as never;
    m.transitions = [{ cutIndex: 0, presetId: 'preset:transition.fade', durationMs: 500, timing: 'linear', params: {} }] as never;
    expect(quickGroups(m, { kind: 'cut', index: 0 })).toMatchObject([{ presetId: 'preset:transition.fade', fields: ['durationMs'] }]);
    const g = quickGroups(m, { kind: 'clip', id: 'c0' });
    expect(g.map((x) => [x.presetId, x.fields])).toEqual([['preset:motion.rise', ['durationMs', 'delayMs']], ['preset:effect.vignette', ['intensity']]]);
  });
});
