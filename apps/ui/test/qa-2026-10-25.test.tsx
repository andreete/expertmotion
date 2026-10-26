// @vitest-environment jsdom
// Human QA on Windows 2026-10-25: File ▸ New Project (#5), clean agent replies with safe markdown (#16), error copy without
// "…" gaps, and the Player empty / no-project / slow states.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { Bubble } from '../src/agent/Chat.js';
import { ModelText, inlineNodes, markdownBlocks } from '../src/agent/ModelText.js';
import { isEmptyComposition, previewWaitCause } from '../src/stage/Player.js';
import { LOCALES, formatErrorMessage, translate } from '../src/i18n/index.js';
import type { MessageDto } from '../src/api/types.js';

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

const msg = (role: MessageDto['role'], ...texts: string[]): MessageDto => ({ id: `m-${role}`, role, blocks: texts.map((text) => ({ type: 'text' as const, text })), agentRunId: null, createdAt: '2026-10-25T10:00:00.000Z' });
function renderInStore(node: React.ReactNode) {
  return render(<StoreProvider runtime={createMockRuntime({ delays: false })} initialPrefs={{ onboardingDone: true }}>{node}</StoreProvider>);
}

describe('#16 agent replies: no JSON wrapper, safe markdown subset', () => {
  const RAW = '{"reply": "Siap! Untuk kelas …\\n\\n**Hook (0-3 detik):** sapa penonton\\n- satu\\n- *dua*\\n1. `kode`\\n2. __tebal__"}';
  it('the Brainstorming bubble shows the decoded reply as formatted text (stored raw JSON too)', () => {
    const { container } = renderInStore(<Bubble m={msg('assistant', RAW, 'Untuk siapa videonya?')} agent="brainstorm" />);
    const bubble = container.querySelector('[data-el="agent.brainstorm.message"]')!;
    expect(bubble.textContent).not.toMatch(/"reply"|\{|\\n|\*\*/);
    expect(bubble.querySelector('strong')?.textContent).toBe('Hook (0-3 detik):');
    expect([...bubble.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['satu', 'dua']);
    expect(bubble.querySelector('ul em')?.textContent).toBe('dua');
    expect([...bubble.querySelectorAll('ol > li')].map((li) => li.textContent)).toEqual(['kode', 'tebal']);
    expect(bubble.querySelector('ol code')?.textContent).toBe('kode');
    expect(bubble.textContent).toContain('Untuk siapa videonya?');
  });
  it('fenced, truncated and double-encoded replies render clean in the Editor bubble as well', () => {
    for (const raw of ['```json\n{"reply": "Rencana: **potong** klip 2"}\n```', '{"reply": "Rencana: **potong** klip 2', JSON.stringify(JSON.stringify({ reply: 'Rencana: **potong** klip 2' }))]) {
      const { container, unmount } = renderInStore(<Bubble m={msg('assistant', raw)} agent="editor" />);
      const b = container.querySelector('[data-el="agent.editor.message"]')!;
      expect(b.querySelector('[data-md]')?.textContent, raw).toBe('Rencana: potong klip 2');
      expect(b.querySelector('strong')?.textContent).toBe('potong');
      unmount();
    }
  });
  it('model text is never interpreted as HTML (React text nodes only); user text stays verbatim', () => {
    const evil = '<img src=x onerror="alert(1)"> <script>alert(2)</script> **ok** [link](javascript:alert(3))';
    const { container } = renderInStore(<><ModelText text={evil} /><Bubble m={msg('user', '**not markdown** \\n')} agent="brainstorm" /></>);
    expect(container.querySelector('img, script, a')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.textContent).toContain('[link](javascript:alert(3))');
    expect(container.querySelector('strong')?.textContent).toBe('ok');
    expect(container.querySelector('[data-role="user"]')?.textContent).toContain('**not markdown** \\n');
  });
  it('markdown blocks and inline rules (snake_case and unmatched markers stay literal)', () => {
    expect(markdownBlocks('# Judul\nBaris 1\nBaris 2\n\n- a\n* b\n• c\n\n3) x\n4) y')).toEqual([
      { kind: 'h', text: 'Judul' }, { kind: 'p', lines: ['Baris 1', 'Baris 2'] }, { kind: 'ul', items: ['a', 'b', 'c'] }, { kind: 'ol', start: 3, items: ['x', 'y'] }]);
    const text = (nodes: React.ReactNode[]) => { const { container, unmount } = render(<span>{nodes}</span>); const s = container.innerHTML; unmount(); return s; };
    expect(text(inlineNodes('file_name_here dan 5 * 3 * 2'))).toBe('<span>file_name_here dan 5 * 3 * 2</span>');
    expect(text(inlineNodes('**Hook'))).toBe('<span>**Hook</span>');
    expect(text(inlineNodes('**tebal *miring* lagi**'))).toBe('<span><strong class="font-semibold">tebal <em>miring</em> lagi</strong></span>');
    expect(text(inlineNodes('`**x**`'))).toContain('>**x**</code>');
  });
});

describe('error copy placeholders never render as "…"', () => {
  it('EM-4003 names the provider when known, else a sensible fallback (en / id)', () => {
    expect(translate('en', 'err.EM-4003.body', { provider: 'OpenRouter' })).toBe('Expertmotion could not reach OpenRouter. Check your internet connection and try again.');
    expect(translate('en', 'err.EM-4003.body')).toBe('Expertmotion could not reach the AI provider. Check your internet connection and try again.');
    expect(translate('id', 'err.EM-4003.body')).toBe('Expertmotion tidak dapat menghubungi penyedia AI. Periksa koneksi internet kamu lalu coba lagi.');
    expect(translate('en', 'err.EM-4102.body')).toBe('The AI provider is limiting requests right now. Wait a moment and try again.');
    expect(translate('en', 'err.EM-4101.body', { model: 'Recursive: Flint (free)' })).toBe('Recursive: Flint (free) did not answer in time. Try again, or switch to a faster model.');
  });
  it('sentences with unknown values are left out; quoted fallbacks lose their quotes', () => {
    expect(translate('en', 'err.EM-1002.body')).toBe('Trim or compress it, then import again.');
    expect(translate('en', 'err.EM-3101.body')).toBe('Close other programs or choose the Standard profile, then try again.');
    expect(translate('en', 'err.EM-2103.body')).toBe('This design needs a graphics card to render at normal speed. On this computer it will work but render slowly.');
    expect(translate('en', 'err.EM-9004.body')).toBe('This item is not available in this version of Expertmotion yet.');
    expect(formatErrorMessage('{x} ok', { x: 'A' })).toBe('A ok');
  });
  it('every err.* string renders without "…", braces or leftover notes in both locales, with and without values', () => {
    for (const lang of ['en', 'id'] as const) for (const k of Object.keys(LOCALES.en).filter((x) => x.startsWith('err.'))) {
      const out = translate(lang, k);
      const dots = (x: string) => x.split('…').length;
      expect(out, `${lang} ${k}`).not.toMatch(/\{|\}/);
      expect(dots(out), `${lang} ${k}: ${out}`).toBe(dots(LOCALES[lang][k]!));
      expect(out.trim().length, `${lang} ${k}`).toBeGreaterThan(0);
    }
    expect(translate('en', 'err.EM-4201.body', { scope: 'project', limit: '$5.00', connection: 'OpenRouter' })).toBe('The AI budget for this project ($5.00) on OpenRouter is used up. Raise the per-project or monthly budget in Providers to continue.');
  });
});

describe('#5 File ▸ New Project', () => {
  it('creates a Project with default settings at once and opens it (unique "Untitled 2" next to "Untitled")', async () => {
    const { runtime } = await renderEditor('empty');
    const before = (await runtime.api.listProjects()).items.length;
    fireEvent.click(el('hdr.menu.file')!);
    expect(el('hdr.menu.file.new')?.textContent).toContain('New Project');
    expect(el('hdr.menu.file.newcustom')).not.toBeNull();
    fireEvent.click(el('hdr.menu.file.new')!);
    await waitFor(() => { if (el('hdr.title')?.textContent !== 'Untitled 2') throw new Error(`title ${el('hdr.title')?.textContent}`); });
    const list = (await runtime.api.listProjects()).items;
    expect(list.length).toBe(before + 1);
    const p = list.find((x) => x.name === 'Untitled 2')!;
    expect(p.settings).toMatchObject({ fps: 30, ratio: '9:16', resolution: '1080p' });
    expect(el('scr.project.new')).toBeNull();                              // no dialog
    expect(el('stage.player.state.empty')).not.toBeNull();
  });
  it('Ctrl+N asks to save first when the Project has unsaved changes; the dialog stays under "with Settings…"', async () => {
    await renderEditor('empty');
    fireEvent.click(el('hdr.title')!);
    const input = el('hdr.title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Kelas Online' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => { if (!el('hdr.title.dirty')) throw new Error('not dirty'); });
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    await waitFor(() => { if (!el('scr.unsaved')) throw new Error('no unsaved prompt'); });
    fireEvent.click(el('scr.unsaved.discard')!);
    await waitFor(() => { if (el('hdr.title')?.textContent !== 'Untitled') throw new Error(`title ${el('hdr.title')?.textContent}`); });
    fireEvent.click(el('hdr.menu.file')!);
    fireEvent.click(el('hdr.menu.file.newcustom')!);
    await waitFor(() => { if (!el('scr.project.new')) throw new Error('no dialog'); });
  });
});

describe('Player states', () => {
  it('an empty composition shows the empty state, not a loading spinner', async () => {
    await renderEditor('empty');
    expect(el('stage.player.state.empty')).not.toBeNull();
    expect(el('stage.player.state.loading')).toBeNull();
    expect(document.querySelector('[data-testid="remotion-player"]')).toBeNull();
    const base = { tracks: { video: [], text: [], overlay: [], audio: [], caption: { pages: [] } }, background: null } as unknown as Parameters<typeof isEmptyComposition>[0];
    expect(isEmptyComposition(base)).toBe(true);
    expect(isEmptyComposition({ ...base, tracks: { ...base.tracks, text: [{}] } } as never)).toBe(false);
    expect(isEmptyComposition({ ...base, background: { kind: 'color' } } as never)).toBe(false);
  });
  it('no Project open: an empty state with New Project and Open', async () => {
    const runtime = createMockRuntime({ delays: false });
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('stage.player.state.noproject')) throw new Error('no state'); });
    expect(el('stage.player.state.loading')).toBeNull();
    fireEvent.click(el('stage.player.state.noproject.new')!);
    await waitFor(() => { if (el('hdr.title')?.textContent !== 'Untitled') throw new Error('not created'); });
    expect(el('stage.player.state.empty')).not.toBeNull();
  });
  it('"taking longer than usual" offers Retry, logs the cause and recovers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const runtime = createMockRuntime({ seed: 'empty', delays: false });
    const realGet = runtime.api.getComposition.bind(runtime.api);
    const realOpen = runtime.api.openProject.bind(runtime.api);
    let hang = true;
    vi.spyOn(runtime.api, 'openProject').mockImplementation(async (id: string) => { const o = await realOpen(id); return hang ? { ...o, head: { ...o.head, model: null } } as unknown as typeof o : o; });
    vi.spyOn(runtime.api, 'getComposition').mockImplementation((id: string) => (hang ? new Promise(() => undefined) : realGet(id)) as ReturnType<typeof realGet>);
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('stage.player.state.loading')) throw new Error('not loading'); });
    expect(el('stage.player.state.loading.retry')).toBeNull();
    await act(async () => { vi.advanceTimersByTime(8100); });
    await waitFor(() => { if (!el('stage.player.state.loading.retry')) throw new Error('no retry'); });
    expect(el('stage.player.state.loading')?.textContent).toContain('This is taking longer than usual');
    expect(warn.mock.calls.map((c) => String(c[0])).filter((c) => c.startsWith('[em]'))).toEqual(['[em] player: preview still loading after 8 s (head-without-model)']);
    hang = false;
    fireEvent.click(el('stage.player.state.loading.retry')!);
    await waitFor(() => { if (!el('stage.player.state.empty')) throw new Error('not recovered'); });
    expect(previewWaitCause({ project: null, head: null, headLoading: false, grant: null })).toBe('no-project');
  });
});
