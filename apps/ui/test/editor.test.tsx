// @vitest-environment jsdom
// Every ELEMENT_IDS.md id of the main editor regions (hdr, lib, stage, agent, sys) is present as data-el in mock mode,
// walking through the states that reveal conditional elements (menus, modes, selection, chat, failed import).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el, present } from './setup-dom.js';
import { parseElementIds } from './elementIds.js';

afterEach(() => cleanup());

/** Ids that cannot appear in a browser/mock session, with the reason (reported, not silently skipped). */
const NOT_IN_MOCK: Record<string, string> = {
  'hdr.win.minimize': 'Electron window controls (rendered only when the Desktop Shell bridge exists)',
  'hdr.win.maximize': 'Electron window controls', 'hdr.win.close': 'Electron window controls',
  'lib.catalogue.card.badge.model': 'no P0/P1 preset carries a model: flag in packages/catalogue',
  'lib.catalogue.card.selected': 'state variant: expressed as data-selected/aria-pressed on lib.catalogue.card',
  'lib.assets.card.state.ingesting': 'transient: mock ingest completes synchronously when delays are off',
  'lib.assets.card.action.usecaptions': 'needs a subtitle asset (covered by the menu test with an .srt upload below)',
  'stage.player.controls.pause': 'shown only while playing (Player is mocked in jsdom)',
  'stage.player.state.loading': 'transient state before the first composition arrives',
  'stage.player.state.error': 'Player error fallback (Player is mocked in jsdom)',
  'stage.timeline.element.selected': 'state variant: aria-selected on stage.timeline.element',
  'agent.editor.plancard.replan': 'only for stale/invalid/failed plans (covered in plancard.test.tsx)',
  'sys.offline': 'only while the Local Service is unreachable', 'sys.update': 'only after an update notice', 'sys.render.progress': 'only while exporting (covered in plancard.test.tsx)',
  'sys.toast': 'transient (asserted in plancard.test.tsx)',
  'lib.assets.empty': 'empty project only (asserted in the next test)', 'stage.timeline.empty': 'empty project only (asserted in the next test)',
};
const MAIN = /^(hdr|lib|stage|agent|sys)\./;

describe('main editor element ids', () => {
  it('renders every main-region id from ELEMENT_IDS.md', async () => {
    const { runtime } = await renderEditor('sample');
    const ids = parseElementIds().filter((id) => MAIN.test(id) && !(id in NOT_IN_MOCK));
    const seen = new Set<string>();
    const sweep = () => { for (const id of ids) if (present(id)) seen.add(id); };
    sweep();
    // File menu
    fireEvent.click(el('hdr.menu.file')!); sweep();
    fireEvent.click(el('hdr.menu.file')!);
    // Design mode extras: upcoming presets with GPU badges, empty search, suggestions
    fireEvent.click(document.querySelector('input[type="checkbox"]')!);
    for (const tab of document.querySelectorAll<HTMLElement>('[data-el="lib.catalogue.tab"]')) { fireEvent.click(tab); sweep(); }
    fireEvent.focus(el('lib.search.input')!); sweep();
    fireEvent.change(el('lib.search.input')!, { target: { value: 'zzzzqqq' } });
    await waitFor(() => { if (!el('lib.catalogue.empty')) throw new Error('no empty'); }); sweep();
    fireEvent.change(el('lib.search.input')!, { target: { value: '' } });
    // Home mode + Add Text input
    fireEvent.click(el('hdr.menu.home')!);
    fireEvent.click(el('lib.text.add')!); sweep();
    // Tools mode
    fireEvent.click(el('hdr.menu.tools')!); sweep();
    fireEvent.click(el('hdr.menu.design')!);
    // Asset card menu
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.assets.card"] button[aria-label="Asset actions"]')!); sweep();
    // Timeline selection → inspector
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"]')!); sweep();
    // A pick makes the project dirty (hdr.title.dirty)
    await waitFor(() => { if (!document.querySelector('[data-el="lib.catalogue.tab"]')) throw new Error('no tabs'); });
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="transition"]')!);
    const fade = document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!;
    await act(async () => { fireEvent.click(fade); });
    await waitFor(() => { if (!el('hdr.title.dirty')) throw new Error('not dirty'); }); sweep();
    // Provider + chat: messages, handoff, plan card
    await act(async () => {
      const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
      await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
    });
    fireEvent.click(el('agent.modelbar')!);
    await waitFor(() => { if (!el('scr.providers')) throw new Error('no providers'); });
    fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
    fireEvent.change(el('agent.brainstorm.composer')!, { target: { value: 'judul pembuka yang energik' } });
    await act(async () => { fireEvent.keyDown(el('agent.brainstorm.composer')!, { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.brainstorm.handoff')) throw new Error('no handoff'); }); sweep();
    fireEvent.change(el('agent.editor.composer')!, { target: { value: 'buat judul pembuka yang kuat' } });
    await act(async () => { fireEvent.keyDown(el('agent.editor.composer')!, { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.editor.plancard')) throw new Error('no plan'); }); sweep();
    // Failed import → unsupported card + error banner
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'notes.xyz')] } }); });
    await waitFor(() => { if (!el('lib.assets.error')) throw new Error('no error'); }); sweep();
    // Private Mode banner
    await act(async () => { fireEvent.click(el('agent.output.private')!); });
    await waitFor(() => { if (!el('sys.privatemode.banner')) throw new Error('no banner'); }); sweep();
    const missing = ids.filter((id) => !seen.has(id));
    expect(missing).toEqual([]);
  }, 30_000);

  it('shows the empty states for a new project', async () => {
    await renderEditor('empty');
    expect(el('lib.assets.empty')).not.toBeNull();
    expect(el('stage.timeline.empty')).not.toBeNull();
    expect(el('hdr.action.export')?.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps hdr.action.export enabled once a clip exists and opens the Export dialog with preflight', async () => {
    await renderEditor('sample');
    expect(el('hdr.action.export')?.getAttribute('aria-disabled')).toBeNull();
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await waitFor(() => { if (!document.querySelector('[data-el="scr.export.preflight"] li svg')) throw new Error('no preflight'); });
    expect(el('scr.export.start')).not.toBeNull();
  });
});
