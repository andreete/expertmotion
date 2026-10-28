// @vitest-environment jsdom
// ADR-031 / FR-192…FR-195 (Operator 2026-10-26: "human + AI agent collaboration", CapCut-style): Delete / Backspace as ONE
// undoable pick, the item context menu (mouse + keyboard), the inspector Delete button, click → chip for every kind, Add Text in a
// project without clips, and a stale Editor plan that re-plans instead of overwriting a manual edit.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { applyOperations, createEmptyModel, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import { renderEditor, el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import type { Runtime } from '../src/state/runtime.js';
import { duplicableRefs, itemRefs, itemsCategory, refExists } from '../src/stage/items.js';
import { itemMenuState, isMenuKey } from '../src/stage/ItemMenu.js';
import { selectionTargets } from '../src/agent/targets.js';
import { translate } from '../src/i18n/index.js';

afterEach(() => cleanup());
const t = (k: string, v?: Record<string, string | number>) => translate('en', k, v);
const until = async (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });
const bars = (kind: string) => [...document.querySelectorAll<HTMLElement>(`[data-el="stage.timeline.element"][data-kind="${kind}"]`)];
const chips = () => els('agent.chat.target').map((x) => x.textContent ?? '');
const toasts = () => els('sys.toast').map((x) => x.textContent ?? '').join(' | ');

let n = 0; const newId = () => `m${++n}`;
const ASSETS: AssetFacts[] = [{ id: 'img', kind: 'image', status: 'ready', width: 100, height: 100, name: 'logo.png' }, { id: 'vo', kind: 'audio', status: 'ready', durationMs: 3000, name: 'suara.wav' }];
function faceless(): CompositionModelT {
  const r = applyOperations(createEmptyModel('p', { autoRatio: false }), [
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Tagihan listrik' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 3000, title: 'Tips hemat' } },
    { op: 'op:overlay.addImage', args: { assetId: 'img', atMs: 0, durationMs: 1000 } },
    { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 1000 } },
    { op: 'op:audio.addLayer', args: { assetId: 'vo', atMs: 0, volume: 1 } }], { assets: ASSETS, tier: 'T1', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model;
}

describe('pure helpers', () => {
  it('itemRefs keeps deletable refs once; duplicable refs and the category follow the kinds', () => {
    const sel = [{ kind: 'clip' as const, id: 'c1' }, { kind: 'clip' as const, id: 'c1' }, { kind: 'cut' as const, index: 0 }, { kind: 'caption' as const }, { kind: 'playhead' as const }, { kind: 'audio' as const, id: 'a1' }];
    expect(itemRefs(sel)).toEqual([{ kind: 'clip', id: 'c1' }, { kind: 'cut', index: 0 }, { kind: 'audio', id: 'a1' }]);
    expect(duplicableRefs(sel)).toEqual([{ kind: 'clip', id: 'c1' }]);
    expect(itemsCategory([{ kind: 'text', id: 'x' }])).toBe('text');
    expect(itemsCategory([{ kind: 'text', id: 'x' }, { kind: 'clip', id: 'y' }])).toBe('asset');
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'ContextMenu', shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: false })).toBe(false);
  });
  it('chips for scene clips ("Scene N"), texts, images, shapes and audio; refExists drops gone items', () => {
    const m = faceless();
    const sel = [{ kind: 'clip' as const, id: m.tracks.video[1]!.id }, { kind: 'text' as const, id: m.tracks.text[0]!.id },
      ...m.tracks.overlay.map((o) => ({ kind: o.kind, id: o.id })), { kind: 'audio' as const, id: m.tracks.audio[0]!.id }];
    const assets = ASSETS.map((a) => ({ id: a.id, name: a.name ?? '' })) as never;
    expect(selectionTargets(sel, m, assets, t).map((x) => [x.kind, x.label])).toEqual([['clip', 'Scene 2'], ['text', 'Tagihan listrik'], ['image', 'logo.png'], ['shape', 'Shape 1'], ['audio', 'suara.wav']]);
    expect(selectionTargets(sel, m, assets, (k, v) => translate('id', k, v))[0]!.label).toBe('Adegan 2');
    expect(refExists(m, { kind: 'text', id: m.tracks.text[0]!.id })).toBe(true);
    expect(refExists(m, { kind: 'text', id: 'gone' })).toBe(false);
  });
  it('menu state: split needs the playhead inside the item; duplicate needs a duplicable kind; ask is off in Private Mode', () => {
    const m = faceless();
    const clip = [{ kind: 'clip' as const, id: m.tracks.video[0]!.id }];
    expect(itemMenuState({ refs: clip, model: m, playheadMs: 1500, privateMode: false, t })).toEqual({ copy: null, cut: null, paste: t('ui.stage.itemmenu.paste.empty'), delete: null, split: null, duplicate: null, ask: null });
    const off = itemMenuState({ refs: [{ kind: 'audio', id: m.tracks.audio[0]!.id }], model: m, playheadMs: 5900, privateMode: true, t });
    expect(off.split).toBe(t('ui.stage.itemmenu.split.outside'));
    expect(off.duplicate).toBe(t('ui.stage.itemmenu.duplicate.none'));
    expect(off.ask).toBeTruthy();
    expect(off.delete).toBeNull();
  });
});

describe('Delete / Backspace (FR-192)', () => {
  it('deletes the selected clip as one pick; Ctrl+Z restores it; selection and inspector are cleared', async () => {
    await renderEditor('sample');
    expect(bars('clip')).toHaveLength(3);
    fireEvent.click(bars('clip')[1]!);
    await until(() => el('stage.timeline.inspector'), 'inspector');
    await act(async () => { fireEvent.keyDown(window, { key: 'Delete' }); });
    await until(() => bars('clip').length === 2, 'clip deleted');
    expect(el('stage.timeline.inspector')).toBeNull();
    expect(toasts()).toMatch(/Deleted 1 item/);
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await until(() => bars('clip').length === 3, 'undo restores the clip');
  }, 20_000);

  it('Ctrl-click selects several items → several chips (no duplicates with Shift); Backspace deletes them all at once; one undo brings both back', async () => {
    await renderEditor('sample');
    fireEvent.click(bars('clip')[0]!);
    fireEvent.click(bars('clip')[2]!, { ctrlKey: true });
    await until(() => chips().length === 2, 'two chips');
    fireEvent.click(bars('clip')[2]!, { shiftKey: true });
    expect(chips()).toHaveLength(2);
    expect(chips().join(' ')).toMatch(/Clip 1.*Clip 3/);
    await act(async () => { fireEvent.keyDown(window, { key: 'Backspace' }); });
    await until(() => bars('clip').length === 1, 'both deleted');
    await until(() => chips().length === 0, 'chips dropped');
    await act(async () => { fireEvent.keyDown(window, { key: 'z', ctrlKey: true }); });
    await until(() => bars('clip').length === 3, 'one undo for both');
  }, 20_000);

  it('is ignored while typing in an input, a textarea or a contenteditable', async () => {
    await renderEditor('sample');
    fireEvent.click(bars('clip')[0]!);
    await until(() => el('stage.timeline.inspector'), 'inspector');
    await act(async () => { fireEvent.keyDown(el('lib.search.input')!, { key: 'Delete' }); });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Backspace' }); });
    const ce = document.createElement('div'); ce.setAttribute('contenteditable', 'true'); document.body.appendChild(ce);
    await act(async () => { fireEvent.keyDown(ce, { key: 'Delete' }); });
    await new Promise((r) => setTimeout(r, 50));
    expect(bars('clip')).toHaveLength(3);
    ce.remove();
  }, 20_000);

  it('the inspector Delete button deletes the selected text (Add Text works in a project without clips)', async () => {
    await renderEditor('empty');
    fireEvent.click(el('hdr.menu.home')!);
    expect(el('lib.text.add')?.getAttribute('aria-disabled')).toBeNull();            // ADR-031: no clip needed (faceless projects)
    await act(async () => { fireEvent.click(el('lib.text.add')!); });
    await until(() => bars('text').length === 1, 'text added without clips');
    await until(() => el('stage.timeline.inspector.delete'), 'inspector delete');
    await act(async () => { fireEvent.click(el('stage.timeline.inspector.delete')!); });
    await until(() => bars('text').length === 0, 'text deleted');
  }, 20_000);
});

describe('item context menu (FR-193, FR-194)', () => {
  it('right-click opens Delete / Split / Duplicate / Ask; ↑/↓ move, Esc closes and returns focus; Duplicate copies the clip', async () => {
    await renderEditor('sample');
    const bar = bars('clip')[0]!;
    fireEvent.contextMenu(bar, { clientX: 100, clientY: 100 });
    await until(() => el('stage.itemmenu'), 'menu');
    const menu = el('stage.itemmenu')!;
    expect(menu.getAttribute('role')).toBe('menu');
    // FR-255 / FR-256: Copy / Cut / Paste come first (Paste disabled until something was copied)
    expect([...menu.querySelectorAll('[role="menuitem"]')].map((x) => x.getAttribute('data-el'))).toEqual(['stage.itemmenu.copy', 'stage.itemmenu.cut', 'stage.itemmenu.paste', 'stage.itemmenu.delete', 'stage.itemmenu.split', 'stage.itemmenu.duplicate', 'stage.itemmenu.ask']);
    expect(el('stage.itemmenu.delete')?.textContent).toMatch(/Delete/);
    expect(document.activeElement).toBe(el('stage.itemmenu.copy'));
    for (let i = 0; i < 3; i++) fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(el('stage.itemmenu.delete'));
    expect(bar.getAttribute('aria-selected')).toBe('true');                          // the right-clicked bar became the selection
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(el('stage.itemmenu.split'));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(el('stage.itemmenu.ask'));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    expect(el('stage.itemmenu')).toBeNull();
    expect(document.activeElement).toBe(bar);
    expect(bars('clip')[0]!.getAttribute('aria-selected')).toBe('true');            // Esc closed the menu only
    // keyboard path: Shift+F10 on the focused bar, then Duplicate
    fireEvent.keyDown(bar, { key: 'F10', shiftKey: true });
    await until(() => el('stage.itemmenu'), 'menu by keyboard');
    await act(async () => { fireEvent.click(el('stage.itemmenu.duplicate')!); });
    await until(() => bars('clip').length === 4, 'clip duplicated');
    expect(toasts()).toMatch(/Duplicated 1 item/);
  }, 20_000);

  it('Split is disabled when the playhead is outside the item; Delete from the menu works; Ask adds a chip and switches to Edit', async () => {
    await renderEditor('sample');
    fireEvent.click(el('agent.chat.tab.brainstorm')!);
    fireEvent.contextMenu(bars('clip')[2]!, { clientX: 10, clientY: 10 });          // playhead at 0, clip 3 starts later
    await until(() => el('stage.itemmenu'), 'menu');
    expect(el('stage.itemmenu.split')?.getAttribute('aria-disabled')).toBe('true');
    expect(el('stage.itemmenu.split')?.getAttribute('title')).toBe(t('ui.stage.itemmenu.split.outside'));
    await act(async () => { fireEvent.click(el('stage.itemmenu.split')!); });
    expect(el('stage.itemmenu')).not.toBeNull();                                      // a disabled entry does nothing
    await act(async () => { fireEvent.click(el('stage.itemmenu.ask')!); });
    await until(() => el('agent.chat')?.getAttribute('data-mode') === 'editor', 'Edit mode');
    expect(chips()).toEqual(['Clip 3']);
    expect(document.activeElement).toBe(el('agent.chat.composer'));
    fireEvent.contextMenu(bars('clip')[0]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu again');
    await act(async () => { fireEvent.click(el('stage.itemmenu.delete')!); });
    await until(() => bars('clip').length === 2, 'deleted from the menu');
    fireEvent.click(document.body);
  }, 20_000);

  it('a click outside closes the menu', async () => {
    await renderEditor('sample');
    fireEvent.contextMenu(bars('clip')[0]!, { clientX: 10, clientY: 10 });
    await until(() => el('stage.itemmenu'), 'menu');
    await act(async () => { fireEvent.pointerDown(el('stage.timeline.ruler')!); });
    expect(el('stage.itemmenu')).toBeNull();
  }, 20_000);
});

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

describe('collaboration safety (FR-195)', () => {
  it('a manual Delete while a plan is pending makes it stale; Execute re-plans on the new head instead of applying the old plan', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul pembuka yang kuat' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'valid', 'valid plan');
    const oldBase = el('agent.editor.plancard.baseversion')?.textContent;
    fireEvent.click(bars('clip')[0]!);
    await act(async () => { fireEvent.keyDown(window, { key: 'Delete' }); });             // the Creator edits by hand meanwhile
    await until(() => bars('clip').length === 2, 'manual delete');
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'stale', 'stale card');
    const texts = bars('text').length;
    await act(async () => { fireEvent.click(el('agent.editor.execute')!); });
    await until(() => toasts().includes('Timeline changed — re-planning'), 're-planning toast');
    const last = () => els('agent.editor.plancard').at(-1);
    await until(() => last()?.getAttribute('data-status') === 'valid', 'new valid plan');
    expect(last()?.querySelector('[data-el="agent.editor.plancard.baseversion"]')?.textContent).not.toBe(oldBase);   // based on the new head
    expect(bars('clip')).toHaveLength(2);                                                  // the manual delete was not overwritten
    expect(bars('text')).toHaveLength(texts);                                              // nothing applied without a new Execute
  }, 30_000);
});
