// @vitest-environment jsdom
// Library Panel gap closure (FRD §3–§5): Text Panel picks, Catalogue Search / suggestions / empty state, Asset Panel
// selection badges, live reorder, missing media, import-level banner and search filter. Mock Local Service.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { renderEditor, el, els } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime } from '../src/state/runtime.js';
import { contrastRatio } from '../src/library/contrast.js';
import { reorderPreview } from '../src/library/Assets.js';
import { resetGpuWarning } from '../src/library/Catalogue.js';
import { listPresets } from '@expertmotion/catalogue';
import type { AssetDto } from '../src/api/types.js';

afterEach(() => { cleanup(); delete (window as { expertmotion?: unknown }).expertmotion; });
const home = () => fireEvent.click(el('hdr.menu.home')!);
const search = (v: string) => fireEvent.change(el('lib.search.input')!, { target: { value: v } });
const card = (id: string) => document.querySelector<HTMLElement>(`[data-preset-id="${id}"]`);

describe('Text Panel', () => {
  it('FR-027 Add Text: "Your text" at the playhead for 3000 ms, selected, content field focused; content edits apply', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createIntent');
    home();
    await act(async () => { fireEvent.click(el('lib.text.add')!); });
    await waitFor(() => { if (!el('lib.text.add.input')) throw new Error('no content field'); });
    expect(spy.mock.calls[0]![1]).toMatchObject({ presetId: 'preset:text.title', text: 'Your text', target: { kind: 'playhead' } });
    const head = (await runtime.api.getComposition(runtime.seededProjectId!)).head.model!;
    expect(head.tracks.text[0]).toMatchObject({ text: 'Your text', timing: { atMs: 0, durationMs: 3000 } });
    expect(document.querySelector('[data-el="stage.timeline.element"][data-kind="text"]')?.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement).toBe(el('lib.text.add.input')));
    fireEvent.change(el('lib.text.add.input')!, { target: { value: 'Promo hari ini' } });
    await act(async () => { fireEvent.click(el('lib.text.add.confirm')!); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ field: 'content', value: 'Promo hari ini' });
    await waitFor(async () => expect((await runtime.api.getComposition(runtime.seededProjectId!)).head.model!.tracks.text[0]!.text).toBe('Promo hari ini'));
  });

  it('FR-020/021/022/023/028: font samples, size presets and range, Bold Italic, hex + contrast hint, opacity needs a selection', async () => {
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createIntent');
    home();
    expect(els('lib.text.font.sample').map((b) => b.dataset['font'])).toEqual(['Inter', 'Plus Jakarta Sans', 'Archivo', 'JetBrains Mono', 'Poppins', 'Playfair Display']);
    expect(els('lib.text.font.sample')[2]!.querySelector('span')!.getAttribute('style')).toContain('Archivo');
    await act(async () => { fireEvent.click(els('lib.text.font.sample')[2]!); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ field: 'fontFamily', value: 'Archivo' });
    expect(els('lib.text.size.preset').map((b) => b.textContent)).toEqual(['Display110', 'Heading72', 'Body48', 'Small36']);
    const size = el('lib.text.size')!.querySelector('input')!;
    fireEvent.change(size, { target: { value: '250' } });
    const calls = spy.mock.calls.length;
    fireEvent.keyDown(size, { key: 'Enter' });
    expect(el('lib.text.size')!.querySelector('[role="alert"]')?.textContent).toBe('Use a size from 16 to 200');
    expect(spy.mock.calls.length).toBe(calls);
    fireEvent.change(size, { target: { value: '16' } });
    await act(async () => { fireEvent.keyDown(size, { key: 'Enter' }); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ field: 'fontSize', value: 16 });
    await act(async () => { fireEvent.click(el('lib.text.weight.regular')!); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ field: 'weight', value: 400 });
    await waitFor(() => expect(el('lib.text.weight.regular')!.getAttribute('aria-checked')).toBe('true'));
    await act(async () => { fireEvent.click(el('lib.text.weight.bolditalic')!); });
    expect(spy.mock.calls.slice(-2).map((c) => [c[1].field, c[1].value])).toEqual([['weight', 800], ['italic', true]]);
    await waitFor(async () => expect((await runtime.api.getComposition(runtime.seededProjectId!)).head.model!.theme.textDefaults).toMatchObject({ weight: 800, italic: true, fontSize: 16, fontFamily: 'Archivo' }));
    fireEvent.change(el('lib.text.colour.hex')!, { target: { value: '#14120F' } });
    await act(async () => { fireEvent.keyDown(el('lib.text.colour.hex')!, { key: 'Enter' }); });
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ field: 'colour', value: '#14120F' });
    await waitFor(() => { if (!el('lib.text.colour.contrast')) throw new Error('no contrast hint'); });
    expect(el('lib.text.colour.contrast')!.textContent).toMatch(/^Low contrast/);
    const opacity = el('lib.text.opacity') as HTMLInputElement;
    expect(opacity.disabled).toBe(true);
    expect(opacity.parentElement!.getAttribute('title')).toBe('Select an element first');
  });

  it('FR-021: the size row warns when the selected text cannot keep its size inside the safe area (the renderer\'s own fit)', async () => {
    const { runtime } = await renderEditor('sample');
    home();
    await act(async () => { fireEvent.click(el('lib.text.add')!); });
    await waitFor(() => { if (!el('lib.text.add.input')) throw new Error('no content field'); });
    expect(el('lib.text.size.overflow')).toBeNull();                                         // "Your text" fits
    fireEvent.change(el('lib.text.add.input')!, { target: { value: 'Diskon besar untuk semua menu kopi susu setiap hari Jumat sore di semua cabang kami, khusus member baru yang daftar minggu ini' } });
    await act(async () => { fireEvent.click(el('lib.text.add.confirm')!); });
    await act(async () => { fireEvent.click(els('lib.text.size.preset')[0]!); });           // Display 110
    await waitFor(() => expect(el('lib.text.size.overflow')?.getAttribute('data-kind')).toBe('shrunk'));
    expect(el('lib.text.size.overflow')!.textContent).toMatch(/^Too large for this text at 9:16: shown at \d+ so it stays inside the safe area$/);
    const head = (await runtime.api.getComposition(runtime.seededProjectId!)).head;
    const textId = head.model!.tracks.text[0]!.id;
    await act(async () => { await runtime.api.createIntent(runtime.seededProjectId!, { source: 'ui', category: 'text', field: 'content', value: 'kata '.repeat(100).trim(), target: { kind: 'text', id: textId }, selection: [{ kind: 'text', id: textId }], baseVersion: head.hash, plan: 'auto' }); });
    await waitFor(() => expect(el('lib.text.size.overflow')?.getAttribute('data-kind')).toBe('overflow'));
    expect(el('lib.text.size.overflow')!.textContent).toContain('does not fit inside the safe area at 9:16, even at 34');
  });

  it('FR-026 a text effect with nothing selected is queued for the Editor Agent', async () => {
    await renderEditor('sample');
    home();
    expect(el('lib.text.effect')!.textContent).toContain('the Editor Agent will place the effect');
    await act(async () => { fireEvent.click(el('lib.text.effect')!.querySelector<HTMLElement>('[data-preset-id="preset:texteffect.highlight"]')!); });
    await waitFor(() => { if (!els('agent.editor.intentqueue.item').some((i) => i.getAttribute('data-status') === 'queued')) throw new Error('not queued'); });
  });

  it('contrast ratio helper', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 0);
    expect(contrastRatio('#14120F', '#14120F')).toBe(1);
    expect(contrastRatio('red', '#000000')).toBeNull();
  });
});

describe('Catalogue Search', () => {
  it('FR-034 filters from 2 characters (EN/ID tags); FR-040 empty state with Clear search', async () => {
    await renderEditor('sample');
    search('l');
    expect(el('lib.catalogue.tab')).not.toBeNull();                                   // 1 character: no filtering yet
    expect(document.body.textContent).toContain('Type at least 2 characters');
    search('lembut');
    await waitFor(() => { if (!card('preset:transition.fade') || card('preset:transition.slide')) throw new Error('not filtered'); });
    search('xyz');
    await waitFor(() => { if (!el('lib.catalogue.empty')) throw new Error('no empty'); });
    expect(el('lib.catalogue.empty')!.textContent).toContain("No designs match 'xyz'");
    fireEvent.click(el('lib.catalogue.empty.clear')!);
    expect((el('lib.search.input') as HTMLInputElement).value).toBe('');
    await waitFor(() => { if (!card('preset:transition.slide')) throw new Error('not cleared'); });
  });

  it('FR-035 rotating registry suggestions; choosing one runs it and opens its tab', async () => {
    await renderEditor('sample');
    expect((el('lib.search.input') as HTMLInputElement).placeholder).toBe('Search: smooth transition…');
    fireEvent.focus(el('lib.search.input')!);
    const sug = els('lib.search.suggestion').find((b) => b.textContent === 'karaoke captions')!;
    fireEvent.click(sug);
    await waitFor(() => { if (!card('preset:caption.karaoke')) throw new Error('no karaoke'); });
    fireEvent.change(el('lib.search.input')!, { target: { value: '' } });
    await waitFor(() => { if (!document.querySelector('[data-el="lib.catalogue.tab"][data-category="caption"][aria-selected="true"]')) throw new Error('captions tab not selected'); });
  });

  it('FR-038: a P0 preset flagged gpu shows the GPU badge on T0, still applies, and EM-2103 appears once per session', async () => {
    const fixture = listPresets({ priority: ['p0'] }).find((p) => p.flags.includes('gpu') && p.category === 'effect');
    expect(fixture, 'fixture: a P0 effect preset flagged gpu').toBeDefined();
    resetGpuWarning();
    const { runtime } = await renderEditor('sample');
    const spy = vi.spyOn(runtime.api, 'createIntent');
    fireEvent.click(document.querySelector('[data-el="lib.catalogue.tab"][data-category="effect"]')!);
    await waitFor(() => { if (!card(fixture!.id)) throw new Error('no fixture card'); });
    expect(card(fixture!.id)!.querySelector('[data-el="lib.catalogue.card.badge.gpu"]')).not.toBeNull();
    expect(card(fixture!.id)!.getAttribute('aria-label')).toContain('GPU');
    const gpuToasts = () => els('sys.toast').filter((x) => x.textContent?.includes('EM-2103'));
    await act(async () => { fireEvent.click(card(fixture!.id)!); });
    await waitFor(() => expect(gpuToasts()).toHaveLength(1));
    expect(spy.mock.calls.at(-1)![1]).toMatchObject({ presetId: fixture!.id });                 // the pick still works
    await act(async () => { fireEvent.click(card(fixture!.id)!); });
    await waitFor(() => expect(spy.mock.calls.filter((c) => c[1].presetId === fixture!.id)).toHaveLength(2));
    expect(gpuToasts()).toHaveLength(1);
    expect(gpuToasts()[0]!.textContent).not.toContain('×2');                                      // shown once, not repeated
  });

  it('FR-038 GPU badge on T0; FR-054 the search filters assets in Home mode', async () => {
    await renderEditor('sample');
    fireEvent.click(document.querySelector('input[type="checkbox"]')!);              // show upcoming (gpu transitions are P1)
    await waitFor(() => { if (!card('preset:transition.zoom-blur')?.querySelector('[data-el="lib.catalogue.card.badge.gpu"]')) throw new Error('no gpu badge'); });
    home();
    search('kafe-2');
    await waitFor(() => { if (els('lib.assets.card').length !== 1) throw new Error(`cards ${els('lib.assets.card').length}`); });
    expect(el('lib.assets.panel')!.textContent).toContain("1 of 3 assets match 'kafe-2'");
  });
});

describe('Asset Panel', () => {
  it('FR-045 checking assigns the next badge, unchecking renumbers; Shift-click selects a range', async () => {
    await renderEditor('sample');
    const boxes = () => els('lib.assets.card.select') as HTMLInputElement[];
    const badges = () => els('lib.assets.card.badge.sequence').map((b) => b.textContent);
    await act(async () => { fireEvent.click(boxes()[2]!); });
    await act(async () => { fireEvent.click(boxes()[0]!); });
    await waitFor(() => expect(badges()).toEqual(['2', '+', '1']));
    await act(async () => { fireEvent.click(boxes()[2]!); });                        // uncheck C → A becomes 1
    await waitFor(() => expect(badges()).toEqual(['1', '+', '+']));
    await act(async () => { fireEvent.click(boxes()[0]!); });                        // uncheck A
    await waitFor(() => expect(badges()).toEqual(['+', '+', '+']));
    await act(async () => { fireEvent.click(boxes()[0]!); });                        // check A (anchor) …
    await act(async () => { fireEvent.click(boxes()[2]!, { shiftKey: true }); });     // … Shift-click C selects the range A..C
    await waitFor(() => expect(badges()).toEqual(['1', '2', '3']));
    expect(boxes().every((b) => b.checked)).toBe(true);
  });

  it('FR-046 reorder preview: dragging 3 onto 1 gives 2,3,1 and is announced', async () => {
    const a = (id: string, badge: number | null) => ({ id, sequenceBadge: badge }) as AssetDto;
    expect(reorderPreview([a('A', 1), a('B', 2), a('C', 3)], 'C', 'A')).toEqual(['C', 'A', 'B']);
    await renderEditor('sample');
    const boxes = () => els('lib.assets.card.select') as HTMLInputElement[];
    await act(async () => { fireEvent.click(boxes()[0]!); }); await act(async () => { fireEvent.click(boxes()[1]!); }); await act(async () => { fireEvent.click(boxes()[2]!); });
    const cards = els('lib.assets.card');
    fireEvent.dragStart(cards[2]!);
    fireEvent.dragOver(cards[0]!);
    expect(els('lib.assets.card.badge.sequence').map((b) => b.textContent)).toEqual(['2', '3', '1']);
    await waitFor(() => expect(el('sys.live')!.textContent).toBe('Order: kafe-3.png, kafe-1.png, kafe-2.png'));
    await act(async () => { fireEvent.drop(cards[0]!); });
    await waitFor(() => expect(els('lib.assets.card.badge.sequence').map((b) => b.textContent)).toEqual(['2', '3', '1']));
  });

  it('FR-048 a missing original shows the missing state on the card and the Timeline; Locate calls R-036', async () => {
    const runtime = createMockRuntime({ seed: 'sample', delays: false });
    const list = runtime.api.listAssets.bind(runtime.api);
    let missing = true;
    vi.spyOn(runtime.api, 'listAssets').mockImplementation(async (...args) => { const p = await list(...args); return { ...p, items: p.items.map((x, i) => (i === 0 && missing ? { ...x, missing: true } : x)) }; });
    const relocate = vi.spyOn(runtime.api, 'relocateAsset').mockImplementation(async (_p, assetId) => { missing = false; const p = await list(runtime.seededProjectId!); return { ...p.items.find((x) => x.id === assetId)!, missing: false }; });
    (window as { expertmotion?: unknown }).expertmotion = { pickFiles: async () => ['/home/me/kafe-1.png'] };
    render(<StoreProvider runtime={runtime} initialPrefs={{ onboardingDone: true }}><App /></StoreProvider>);
    await waitFor(() => { if (!el('lib.assets.card.state.missing')) throw new Error('no missing state'); });
    expect(el('stage.timeline.element.missing')).not.toBeNull();
    await act(async () => { fireEvent.click(el('lib.assets.card.action.locate')!); });
    expect(relocate).toHaveBeenCalledWith(runtime.seededProjectId, expect.any(String), '/home/me/kafe-1.png');
    await waitFor(() => { if (el('lib.assets.card.state.missing')) throw new Error('still missing'); });
  });

  it('FR-029 Insert Image imports, then places the image on the overlay at the playhead; FR-049 Insert goes after the selected Clip', async () => {
    const { runtime } = await renderEditor('sample');
    const ins = vi.spyOn(runtime.api, 'insertAssets');
    home();
    fireEvent.click(el('lib.text.insert.image')!);
    await new Promise((r) => setTimeout(r, 5));
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept).toBe('.png,.jpg,.jpeg,.webp,.gif');
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'logo.png', { type: 'image/png' })] } }); });
    await waitFor(() => { if (!ins.mock.calls.length) throw new Error(`not inserted ${els('lib.assets.card').map((c) => c.getAttribute('aria-label')).join(' | ')}`); });
    expect(ins.mock.calls[0]![1]).toMatchObject({ asOverlay: true, atMs: 0 });
    await waitFor(() => { if (!document.querySelector('[data-el="stage.timeline.lane.layer"] [data-el="stage.timeline.element"][data-kind="image"]')) throw new Error('no overlay element'); });
    // FR-049: with clip 1 selected, Insert places the new Clip after it (atIndex 1)
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.track.video"] [data-el="stage.timeline.element"]')!); });
    await act(async () => { fireEvent.click((els('lib.assets.card.select') as HTMLInputElement[])[1]!); });
    await act(async () => { fireEvent.click(el('lib.assets.insert')!); });
    expect(ins.mock.calls.at(-1)![1]).toMatchObject({ atIndex: 1 });
  });

  it('FR-053 import-level errors show the banner with a recovery action', async () => {
    await renderEditor('sample');
    await act(async () => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code: 'EM-6401' } })); });
    expect(el('lib.assets.error')!.getAttribute('data-code')).toBe('EM-6401');
    expect(el('lib.assets.error.action')!.textContent).toBe('Try again');
    await act(async () => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code: 'EM-1401' } })); });
    expect(el('lib.assets.error.action')!.textContent).toBe('OK');
    fireEvent.click(el('lib.assets.error.action')!);
    expect(el('lib.assets.error')).toBeNull();
  });
});
