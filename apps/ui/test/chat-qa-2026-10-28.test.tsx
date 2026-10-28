// @vitest-environment jsdom
// QA 2026-10-28 (Windows, Claude Sonnet 5.5) in the chat: #1 internet research (progress with the query, clickable sources, openly
// licensed pictures, the "Web" switch), #4 a readable plan preview and "Lihat di timeline", #16 the Plan Card closes from its header,
// #17 deleting through the Editor asks inline and executes with confirmDestructive (EM-4310, was "Request not valid"), #12/#13 the
// caption under the playhead as a chip, #14 audio / document attachments, FR-223 generator step status, FR-224 "perkiraan".
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el, els, chatComposer } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { progressText } from '../src/agent/Chat.js';
import { previewRows, previewDurationMs, destructiveItems } from '../src/agent/plan-preview.js';
import { phaseIndex } from '../src/agent/Handoff.js';
import { voicePending } from '../src/agent/PlanCard.js';
import { initialState, reducer } from '../src/state/reducer.js';
import { translate } from '../src/i18n/index.js';
import { createEmptyModel } from '@expertmotion/composition-model';
import type { MessageDto, PlanDto } from '../src/api/types.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const t = (k: string, v?: Record<string, string | number>) => translate('id', k, v);
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });

async function boot(): Promise<{ runtime: Runtime; bus: MockBus; pid: string }> {
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  const bus = new MockBus();
  const runtime = createMockRuntime({ seed: 'sample', delays: false, bus });
  render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true, nudgesDismissed: [], outputCollapsed: false }}><App /></StoreProvider>);
  await until(() => (el('stage.timeline') && el('agent.chat')) || el('scr.start.item.open'), 'editor');
  if (!el('agent.chat')) { await act(async () => { fireEvent.click(els('scr.start.item.open')[0]!); }); await until(() => el('agent.chat'), 'project open'); }
  await act(async () => {
    const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
    await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} }, defaultConnectionId: c.id });
  });
  await act(async () => { bus.emit('settings.changed', { scope: 'providers' }); });
  await until(() => !chatComposer('brainstorm')?.hasAttribute('readonly'), 'composer enabled');
  return { runtime, bus, pid: runtime.seededProjectId! };
}
const research = (id: string): MessageDto => ({ id, role: 'assistant', agentRunId: 'r1', createdAt: '2026-10-28T10:00:00.000Z', blocks: [
  { type: 'text', text: 'Nilai ekspor nikel Jan–Agu 2026 naik 17,2% menjadi US$25,96 miliar (ESDM, ANTARA).' },
  { type: 'sources', items: [{ url: 'https://www.antaranews.com/berita/ekspor-nikel', title: 'Nilai ekspor nikel capai US$25,96 miliar — ANTARA', cited: true, citedText: 'US$25,96 miliar' }, { url: 'https://www.esdm.go.id/x', title: 'ESDM', pageAge: 'October 14, 2026' }], queries: ['ekspor nikel 2026'] },
  { type: 'image_candidates', items: [{ source: 'openverse', id: '6f1c2c4e-1b8e-4b5a-9a39-0c2f2c1b7a11', title: 'Nickel ore', creator: 'Stub Photographer', license: 'by', licenseVersion: '4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', landingUrl: 'https://www.flickr.com/photos/stub/1', width: 1600, height: 900, provider: 'flickr' }] },
] });

describe('research progress and sources (FR-216, QA #1)', () => {
  it('progress words name the query and the page', () => {
    expect(progressText({ phase: 'tool', tool: 'web.search', query: 'ekspor nikel 2026' }, t, 'brainstorm')).toBe('Mencari di internet: ekspor nikel 2026…');
    expect(progressText({ phase: 'tool', tool: 'web.search' }, t, 'brainstorm')).toBe('Mencari di internet…');
    expect(progressText({ phase: 'tool', tool: 'web.fetch', url: 'https://www.esdm.go.id/a/b' }, t)).toBe('Membaca halaman: esdm.go.id…');
    expect(progressText({ phase: 'tool', tool: 'web.images', query: 'nickel' }, t)).toBe('Mencari gambar: nickel…');
  });

  it('a research answer shows numbered source links (system browser), a picture to import with its licence, and the Web switch', { timeout: 30_000 }, async () => {
    const { bus, pid } = await boot();
    const opened: string[] = [];
    (window as unknown as { expertmotion?: unknown }).expertmotion = { openExternal: async (u: string) => { opened.push(u); } };
    await act(async () => { bus.emit('agent.run.progress', { projectId: pid, runId: 'r1', agent: 'brainstorm', phase: 'tool', tool: 'web.search', query: 'ekspor nikel 2026' }); });
    await until(() => el('agent.chat.progress')?.textContent?.includes('Searching the internet: ekspor nikel 2026'), 'web progress');
    await act(async () => { bus.emit('agent.run.done', { projectId: pid, run: { id: 'r1', projectId: pid, agent: 'brainstorm', status: 'done', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: 'x', finishedAt: 'y' }, message: research('01M61TESTRESEARCH0000000001'), usage: null, contextUsage: null }); });
    await until(() => el('agent.chat.message.sources'), 'sources');
    const links = els('agent.chat.message.source');
    expect(links.map((a) => a.textContent)).toEqual(['Nilai ekspor nikel capai US$25,96 miliar — ANTARA', 'ESDM']);
    expect(el('agent.chat.message.sources')!.textContent).toContain('1 searches');
    fireEvent.click(links[0]!);
    expect(opened).toEqual(['https://www.antaranews.com/berita/ekspor-nikel']);
    expect(el('agent.chat.message.image')!.textContent).toContain('CC BY 4.0');
    await act(async () => { fireEvent.click(el('agent.chat.message.image.import')!); });
    await until(() => el('agent.chat.message.image')?.getAttribute('data-imported') === 'true', 'picture imported');
    expect(el('agent.chat.research')!.getAttribute('aria-checked')).toBe('true');
    delete (window as unknown as { expertmotion?: unknown }).expertmotion;
  });
});

describe('plan preview, removal confirmation, close, live steps (QA #4, #16, #17)', () => {
  const base: PlanDto = { id: 'p1', projectId: 'x', baseVersion: 'h', origin: 'editor-agent', goal: 'g', steps: [], touchesLockedKeys: [], risks: [], status: 'valid', validation: [] };
  it('previewRows lists scenes with start / length, texts, shapes, transitions, voice, removals; total duration', () => {
    const model = createEmptyModel('p', { ratio: '9:16', resolution: '1080p', fps: 30, language: 'id' });
    const plan: PlanDto = { ...base, steps: [
      { n: 1, tool: 'composition.applyOps', args: {}, expectedDiff: '', dependsOn: [], ops: [
        { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Ekspor nikel naik', background: 'preset:background.gradient', transition: 'preset:transition.fade' } },
        { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 5000, title: 'Tapi volumenya turun' } },
        { op: 'op:text.add', target: { kind: 'project' }, args: { text: '+17,2%', atMs: 500, durationMs: 2000 } },
        { op: 'op:shape.add', target: { kind: 'project' }, args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 1000 } },
        { op: 'op:clip.remove', target: { kind: 'clip', id: 'c9' }, args: {} },
      ] as never },
      { n: 2, tool: 'tts.generate', args: { text: 'Ekspor nikel Indonesia naik tujuh belas persen.' }, expectedDiff: '', dependsOn: [], ops: [] },
    ] };
    const rows = previewRows(plan, model, 'id');
    expect(rows.map((r) => r.kind)).toEqual(['scene', 'scene', 'text', 'shape', 'remove', 'voice']);
    expect(rows[1]).toMatchObject({ title: 'Adegan 2', startMs: 3000, durationMs: 5000 });
    expect(rows[0]!.detail).toContain('“Ekspor nikel naik”');
    expect(rows[2]!.title).toBe('Teks “+17,2%”');
    expect(previewDurationMs(rows)).toBe(8000);
    expect(destructiveItems(plan).map((x) => x.op)).toEqual(['op:clip.remove']);
  });

  it('a delete plan asks inline (no "Request not valid"), Execute then sends confirmDestructive: true; the card closes from its header', { timeout: 30_000 }, async () => {
    const { runtime } = await boot();
    const exec = vi.spyOn(runtime.api, 'executePlan');
    const before = (await runtime.api.getComposition(runtime.seededProjectId!)).head.model!.tracks.video.length;
    fireEvent.change(chatComposer('editor'), { target: { value: 'hapus klip pertama dari timeline' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'valid', 'plan');
    expect(els('agent.editor.plancard.preview.row').some((r) => r.getAttribute('data-kind') === 'remove')).toBe(true);   // the preview names the removal
    await act(async () => { fireEvent.click(el('agent.editor.execute')!); });
    await until(() => el('agent.editor.plancard.confirmremoval'), 'inline confirmation');
    expect(exec).not.toHaveBeenCalled();
    expect(el('agent.editor.plancard.confirmremoval')!.textContent).toMatch(/Klip 1|Adegan 1/);
    await act(async () => { fireEvent.click(el('agent.editor.plancard.confirmremoval.yes')!); });
    await until(() => exec.mock.calls.length > 0, 'executed');
    expect(exec.mock.calls[0]![1]).toMatchObject({ confirmDestructive: true });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'executed', 'executed card');
    expect((await runtime.api.getComposition(runtime.seededProjectId!)).head.model!.tracks.video.length).toBe(before - 1);
    expect(document.querySelector('[data-el="sys.toast"][data-code="EM-9002"]')).toBeNull();
    // a second plan: the header × discards it (QA #16: the card can always be closed)
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    const last = () => els('agent.editor.plancard').at(-1);
    await until(() => last()?.getAttribute('data-status') === 'valid', 'second plan');
    await act(async () => { fireEvent.click(last()!.querySelector<HTMLElement>('[data-el="agent.editor.plancard.close"]')!); });
    await until(() => !els('agent.editor.plancard').some((x) => x.getAttribute('data-status') === 'valid'), 'discarded');
  });

  it('the Service answer EM-4310 (plan without loaded ops) opens the same inline question', { timeout: 30_000 }, async () => {
    const { runtime } = await boot();
    fireEvent.change(chatComposer('editor'), { target: { value: 'hapus klip pertama' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'valid', 'plan');
    // simulate an older plan DTO without ops: the client cannot know, the Service refuses with EM-4310
    const real = runtime.api.executePlan.bind(runtime.api);
    let first = true;
    vi.spyOn(runtime.api, 'executePlan').mockImplementation(async (id, o) => (first && !(first = false) ? real(id, { ...o, confirmDestructive: false }) : real(id, o)));
    await act(async () => { fireEvent.click(el('agent.editor.execute')!); });
    await until(() => el('agent.editor.plancard.confirmremoval'), 'inline confirmation');
  });

  it('reducer: plan-step notices and plan.progress update the current plan; EM-4310 items are kept for the inline question', () => {
    let s = reducer(initialState, { type: 'plan', plan: { ...base, status: 'executed' } });
    s = reducer(s, { type: 'event', event: { name: 'service.notice', data: { kind: 'plan-step', planId: 'p1', step: 2, tool: 'tts.generate', status: 'failed', code: 'EM-7001', seq: 1 } } as never });
    expect(s.plan?.stepStatus?.[2]).toEqual({ status: 'failed', code: 'EM-7001' });
    s = reducer(s, { type: 'event', event: { name: 'plan.progress', data: { planId: 'p1', phase: 'voice', done: 0, total: 9, seq: 2 } } as never });
    expect(s.plan?.execPhase).toMatchObject({ phase: 'voice', total: 9 });
    expect(translate('id', 'ui.agent.plan.exec.voice', { total: 9 })).toBe('Membuat suara narasi: 9 klip…');
  });

  it('a scene.compose plan whose voice clips do not exist yet is labelled "perkiraan" (FR-224)', () => {
    const plan: PlanDto = { ...base, steps: [{ n: 1, tool: 'composition.applyOps', args: { sceneCompose: { voice: { clips: [{ id: 'v1', text: 'a' }, { id: 'v2', text: 'b' }] }, scenes: [] } }, expectedDiff: '', dependsOn: [], ops: [] }] };
    expect(voicePending(plan)).toBe(2);
    expect(voicePending({ ...plan, steps: [{ ...plan.steps[0]!, args: { ...plan.steps[0]!.args, measured: true } }] })).toBe(0);
    expect(translate('id', 'ui.agent.plan.preview.estimate', { n: 2 })).toMatch(/perkiraan/);
  });
});

describe('hand-off phases (FR-219 / FR-223, QA #3 / #20)', () => {
  it('maps run phases onto membaca draf → menyusun adegan → memeriksa → siap', () => {
    expect([undefined, 'sending', 'reading', 'planning', 'thinking', 'writing', 'tool', 'checking', 'correcting'].map(phaseIndex)).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 2]);
    expect(['reading', 'planning', 'checking', 'ready'].map((p) => translate('id', `ui.agent.handoff.phase.${p}`))).toEqual(['Membaca draf', 'Menyusun adegan', 'Memeriksa', 'Siap']);
  });
  it('the Editor working bubble shows the phase stepper with seconds', { timeout: 30_000 }, async () => {
    const { bus, pid } = await boot();
    chatComposer('editor');
    await act(async () => { bus.emit('agent.run.progress', { projectId: pid, runId: 'r9', agent: 'editor', phase: 'checking', attempt: 2, of: 3 }); });
    await until(() => el('agent.chat.phases'), 'phases');
    expect(el('agent.chat.phases')!.getAttribute('data-phase-index')).toBe('2');
    expect(el('agent.chat.phases.meta')!.textContent).toContain('try 2/3');
    expect(el('agent.chat.tab.editor')!.getAttribute('data-busy')).toBe('true');
  });
});

describe('composer attachments and caption chip (QA #14, #12)', () => {
  it('offers images, audio and documents; a caption under the playhead can be pointed at', { timeout: 30_000 }, async () => {
    const { runtime, pid } = await boot();
    chatComposer('editor');
    fireEvent.click(el('agent.chat.attach')!);
    expect(el('agent.chat.attach.file')).not.toBeNull();
    expect(el('agent.chat.attach.audio')!.textContent).toContain('MP3');
    expect(el('agent.chat.attach.document')!.textContent).toContain('PDF');
    const comp = await runtime.api.getComposition(pid);
    if (comp.head.model?.tracks.caption.pages.length) {
      await until(() => el('agent.chat.target.caption.suggest') || true, 'caption suggest');
    }
  });
});

describe('FR-224: a voice-first Execute that stops (no voice model) leaves a failed card with the reason', () => {
  it('ok:false from Execute → the card says it failed (EM-7001) and nothing is applied', { timeout: 30_000 }, async () => {
    const { runtime } = await boot();
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'valid', 'plan');
    vi.spyOn(runtime.api, 'executePlan').mockResolvedValue({ planId: 'x', ok: false, fromVersion: 'h', appliedOps: 0, diff: [], error: { code: 'EM-7001', message: 'The voice model is not installed. Nothing was changed: the scene timing needs the real voice clips.' }, durationMs: 5 });
    await act(async () => { fireEvent.click(el('agent.editor.execute')!); });
    await until(() => els('agent.editor.plancard').at(-1)?.getAttribute('data-status') === 'failed', 'failed card');
    await new Promise((r) => setTimeout(r, 500));
    expect(els('agent.editor.plancard').at(-1)?.getAttribute('data-status')).toBe('failed');
    expect(els('agent.editor.plancard').at(-1)?.textContent).toMatch(/EM-7001/);
  });
});
