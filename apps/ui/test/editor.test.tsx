// @vitest-environment jsdom
// Every ELEMENT_IDS.md id of the main editor regions (hdr, lib, stage, agent, sys) is present as data-el in mock mode,
// walking through the states that reveal conditional elements (menus, modes, selection, chat, failed import).
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el, present, chatComposer, openProvidersFromChat } from './setup-dom.js';
import { parseElementIds } from './elementIds.js';

afterEach(() => cleanup());

/** Ids that cannot appear in a browser/mock session, with the reason (reported, not silently skipped). */
const NOT_IN_MOCK: Record<string, string> = {
  'sys.fatal': 'Desktop Shell push only (EM-8002 / EM-6001; covered in service-restart.test.tsx)', 'sys.fatal.diagnostics': 'Desktop Shell push only', 'sys.fatal.quit': 'Desktop Shell push only',
  'sys.fatal.retry': 'Desktop Shell push only (EM-8002 with retryStartup; service-restart.test.tsx)',
  'lib.assets.importing': 'transient: mock ingest completes synchronously when delays are off (busy-feedback.test.tsx)',
  'sys.splash': 'startup only, before the Editor is booted (startup.test.tsx)', 'sys.splash.placeholder': 'static index.html first paint (csp-meta.test.ts)',
  'sys.splash.step': 'startup (startup.test.tsx)', 'sys.splash.progress': 'startup (startup.test.tsx)', 'sys.splash.elapsed': 'startup after 5 s (startup.test.tsx)',
  'sys.splash.slow': 'startup after 20 s', 'sys.splash.error': 'startup failure (startup.test.tsx)', 'sys.splash.code': 'startup failure (startup.test.tsx)',
  'sys.splash.retry': 'startup failure (startup.test.tsx)', 'sys.splash.logs': 'startup failure (startup.test.tsx)',
  'sys.crash': 'error boundary after a render exception (startup.test.tsx)', 'sys.crash.code': 'error boundary (startup.test.tsx)',
  'sys.crash.message': 'error boundary (startup.test.tsx)', 'sys.crash.reload': 'error boundary (startup.test.tsx)',
  'lib.catalogue.card.badge.model': 'no P0/P1 preset carries a model: flag in packages/catalogue',
  'lib.catalogue.card.selected': 'state variant: expressed as data-selected/aria-pressed on lib.catalogue.card',
  'lib.assets.card.state.ingesting': 'transient: mock ingest completes synchronously when delays are off',
  'lib.assets.card.action.usecaptions': 'needs a subtitle asset (covered by the menu test with an .srt upload below)',
  'stage.player.controls.pause': 'shown only while playing (Player is mocked in jsdom)',
  'stage.player.state.loading': 'transient state before the first composition arrives',
  'stage.player.state.loading.retry': 'only after 8 s without a composition (qa-2026-10-25.test.tsx)',
  'stage.player.state.empty': 'empty project only (qa-2026-10-25.test.tsx)', 'stage.player.state.empty.import': 'empty project only (qa-2026-10-25.test.tsx)',
  'stage.player.state.noproject': 'no project open (qa-2026-10-25.test.tsx)', 'stage.player.state.noproject.new': 'no project open', 'stage.player.state.noproject.open': 'no project open',
  'stage.player.state.error': 'Player error fallback (Player is mocked in jsdom)',
  'stage.player.state.error.reload': 'Player error fallback', 'stage.player.state.error.recovery': 'Player error fallback',
  'stage.timeline.element.generated': 'needs a generator result on the timeline (covered in stage-agent.test.tsx)',
  'stage.timeline.lane.layer': 'needs a text, image or shape on the timeline (the sample has clips only; covered in timeline-lanes.test.tsx)',
  'stage.timeline.lane.audio': 'needs an audio layer (covered in timeline-lanes.test.tsx)',
  'stage.player.canvas.guide': 'shown only while a canvas drag snaps (canvas-split.test.tsx)',
  'stage.timeline.ghost': 'shown only while dragging a bar (timeline-lanes.test.tsx)', 'stage.timeline.snap': 'shown only while a drag snaps (timeline-lanes.test.tsx)',
  'agent.chat.message.copy': 'needs a reply with text (stage-agent.test.tsx)', 'agent.chat.streaming': 'transient while a reply streams (stage-agent.test.tsx)',
  'agent.chat.message.retry': 'saved failure only (stage-agent.test.tsx)', 'agent.editor.plancard.undo': 'needs an executed plan that is the head (assistant-chat.test.tsx)',
  'agent.editor.message.applied': 'needs a compiled pick (stage-agent.test.tsx)',
  'agent.chat.progress': 'only while an agent runs or a plan executes (pointing-progress.test.tsx)', 'agent.chat.error.action': 'failure bubble (pointing-progress.test.tsx)',
  'agent.chat.error.keyhint': 'EM-4002 on a new key (pointing-progress.test.tsx)', 'agent.chat.error.reason': 'failure bubble (pointing-progress.test.tsx)',
  'agent.editor.plancard.toolstep': 'plan with a generator step (pointing-progress.test.tsx)', 'agent.editor.plancard.models': 'model-missing risk (pointing-progress.test.tsx)',
  'agent.editor.plancard.toolnote': 'executed plan with a started generator step (pointing-progress.test.tsx)',
  'agent.chat.targets': 'only with pointed items (pointing-progress.test.tsx)', 'agent.chat.target': 'pointed item (pointing-progress.test.tsx)', 'agent.chat.target.remove': 'pointed item (pointing-progress.test.tsx)',
  'agent.chat.message.targets': 'message sent with targets (pointing-progress.test.tsx)', 'lib.assets.card.action.ask': 'asset card menu (pointing-progress.test.tsx)', 'stage.timeline.inspector.ask': 'selected element (stage-chat-gaps.test.tsx)',
  'lib.text.size.overflow': 'needs a selected Text Layer that does not keep its size (library.test.tsx, FR-021)',
  'agent.chat.attach.file': 'attach menu (stage-agent.test.tsx)',
  'agent.chat.attach.error': 'attachment notice (stage-agent.test.tsx)',
  'agent.editor.plancard.step.ops': 'needs a plan with steps (stage-agent.test.tsx)', 'agent.editor.plancard.model': 'needs plan usage', 'agent.editor.plancard.result': 'needs an executed plan',
  'agent.output.ratio.help.table': 'help popover (stage-agent.test.tsx)', 'agent.output.ratio.auto.hint': 'Auto on with no clip (stage-agent.test.tsx)',
  'stage.timeline.element.selected': 'state variant: aria-selected on stage.timeline.element',
  'stage.timeline.quickparams': 'needs a selected element with motion, effect or transition (stage-agent.test.tsx FR-098)', 'stage.timeline.quickparams.field': 'quick params (stage-agent.test.tsx)', 'stage.timeline.quickparams.apply': 'quick params (stage-agent.test.tsx)',
  'agent.editor.plancard.replan': 'only for stale/invalid/failed plans (covered in plancard.test.tsx)',
  'agent.editor.plancard.step.dropped': 'only when EM-2302 removed steps (plancard.test.tsx)', 'agent.editor.plancard.locked': 'only for a plan touching Locked Keys (plancard.test.tsx)',
  'agent.brainstorm.handoff.item.reason': 'only for an invalid proposed change (covered in stage-agent.test.tsx, FR-076)',
  'sys.offline': 'only while the Local Service is unreachable', 'sys.update': 'only after an update notice', 'sys.update.download': 'update banner (export-licence-help.test.tsx)', 'sys.update.restart': 'update banner (export-licence-help.test.tsx)', 'sys.update.later': 'update banner (export-licence-help.test.tsx)', 'sys.render.progress': 'only while exporting (covered in plancard.test.tsx)',
  'sys.toast': 'transient (asserted in plancard.test.tsx)',
  'sys.update.retry': 'only for EM-8104/EM-8102/EM-8101 (export-licence-help.test.tsx)', 'agent.chat.budget': 'only for EM-4201 (providers-models.test.tsx)',
  'hdr.title.sample': 'only on the R-025 sample project (covered in tour.test.tsx)',
  'sys.tour': 'only while the tour runs (covered in tour.test.tsx)', 'sys.tour.next': 'tour (tour.test.tsx)', 'sys.tour.back': 'tour (tour.test.tsx)', 'sys.tour.end': 'tour (tour.test.tsx)',
  'sys.tour.choice.current': 'tour re-run choice (tour.test.tsx)', 'sys.tour.choice.sample': 'tour re-run choice (tour.test.tsx)', 'sys.tour.sampleplan': 'TOUR-7 without a provider (tour.test.tsx)',
  'sys.tour.done.keep': 'tour closing card (tour.test.tsx)', 'sys.tour.done.own': 'tour closing card (tour.test.tsx)',
  'lib.catalogue.params': 'only while a ⓘ Details popover is open (covered in params.test.tsx)', 'lib.catalogue.params.field': 'popover (params.test.tsx)',
  'lib.catalogue.params.apply': 'popover (params.test.tsx)', 'lib.catalogue.params.reset': 'popover (params.test.tsx)',
  'agent.editor.intentqueue.group': 'needs executed picks in an older version (covered in intentqueue.test.tsx)',
  'lib.text.colour.contrast': 'only for a low-contrast text colour (covered in library.test.tsx)',
  'lib.assets.card.state.missing': 'only when an original is missing on disk (covered in library.test.tsx)', 'lib.assets.card.action.locate': 'missing asset (library.test.tsx)',
  'stage.timeline.element.missing': 'missing asset (library.test.tsx)',
  'stage.timeline.inspector.missing': 'missing asset with the element selected (library.test.tsx FR-048)', 'stage.timeline.inspector.locate': 'missing asset (library.test.tsx FR-048)', 'stage.timeline.inspector.remove': 'missing asset (library.test.tsx FR-048)',
  'lib.assets.card.action.importagain': 'only on an EM-1201 card (library.test.tsx FR-042)', 'lib.assets.error.diagnostics': 'only for EM-6401 (library.test.tsx FR-053)',
  'lib.text.ratio.menu': 'Home ▸ Ratio popover (library.test.tsx FR-031)', 'lib.text.ratio.option': 'Ratio popover (library.test.tsx FR-031)',
  'lib.text.videosize.menu': 'Home ▸ Video Size popover (library.test.tsx FR-031)', 'lib.text.videosize.option': 'Video Size popover (library.test.tsx FR-031)',
  'lib.assets.empty': 'empty project only (asserted in the next test)', 'stage.timeline.empty': 'empty project only (asserted in the next test)',
};
const MAIN = /^(hdr|lib|stage|agent|sys)\./;
/** The chat header model popover (`agent.chat.model.popover` and its parts) opens only on click (assistant-chat.test.tsx). */
const IN_FOOTER_POPOVER = /^agent\.chat\.model\./;

describe('main editor element ids', () => {
  it('renders every main-region id from ELEMENT_IDS.md', async () => {
    const { runtime } = await renderEditor('sample');
    const ids = parseElementIds().filter((id) => MAIN.test(id) && !(id in NOT_IN_MOCK) && !IN_FOOTER_POPOVER.test(id));
    const seen = new Set<string>();
    const sweep = () => { for (const id of ids) if (present(id)) seen.add(id); };
    sweep();
    // Output Settings collapsed (FR-099): header summary
    fireEvent.click(el('agent.output.toggle')!); sweep();
    fireEvent.click(el('agent.output.toggle')!);
    // File menu
    fireEvent.click(el('hdr.menu.file')!); sweep();
    if (el('hdr.menu.file.recent')) { fireEvent.click(el('hdr.menu.file.recent')!); await waitFor(() => { if (!el('hdr.menu.file.recent.item')) throw new Error('no recent'); }); sweep(); }
    fireEvent.click(el('hdr.menu.file')!);
    // Help menu
    fireEvent.click(el('hdr.menu.help')!); sweep();
    fireEvent.click(el('hdr.menu.help')!);
    // Player menu
    fireEvent.click(el('stage.player.menu')!); sweep();
    fireEvent.click(el('stage.player.menu')!);
    // Design mode extras: upcoming presets with GPU badges, empty search, suggestions
    fireEvent.click(document.querySelector('input[type="checkbox"]')!);
    for (const tab of document.querySelectorAll<HTMLElement>('[data-el="lib.catalogue.tab"]')) { fireEvent.click(tab); sweep(); }
    fireEvent.focus(el('lib.search.input')!); sweep();
    fireEvent.change(el('lib.search.input')!, { target: { value: 'zzzzqqq' } });
    await waitFor(() => { if (!el('lib.catalogue.empty')) throw new Error('no empty'); }); sweep();
    fireEvent.change(el('lib.search.input')!, { target: { value: '' } });
    // Home mode + Add Text input
    fireEvent.click(el('hdr.menu.home')!);
    await act(async () => { fireEvent.click(el('lib.text.add')!); });
    await waitFor(() => { if (!el('lib.text.add.input')) throw new Error('no content field'); }); sweep();
    // Tools mode
    fireEvent.click(el('hdr.menu.tools')!); sweep();
    fireEvent.click(el('hdr.menu.design')!);
    // Asset card menu
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.assets.card"] button[aria-label="Asset actions"]')!); sweep();
    // Timeline selection → inspector
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"]')!); sweep();
    // ADR-028: a selected clip shows the canvas handles on the Player and the transform fields in the inspector
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="stage.timeline.element"][data-kind="clip"]')!); sweep();
    // FR-173: a pick creates a persisted Composition Version — no dirty dot
    await waitFor(() => { if (!document.querySelector('[data-el="lib.catalogue.tab"]')) throw new Error('no tabs'); });
    fireEvent.click(document.querySelector<HTMLElement>('[data-el="lib.catalogue.tab"][data-category="transition"]')!);
    const fade = document.querySelector<HTMLElement>('[data-preset-id="preset:transition.fade"]')!;
    await act(async () => { fireEvent.click(fade); });
    await waitFor(() => { if (!document.querySelector('[data-el="agent.editor.intentqueue.item"]')) throw new Error('no queue item'); });
    expect(el('hdr.title.dirty')).toBeNull(); sweep();
    // ...a rename is UI-level state: the dot shows until Save/autosave
    fireEvent.click(el('hdr.title')!);
    fireEvent.change(el('hdr.title')!, { target: { value: 'Promo baru' } });
    await act(async () => { fireEvent.keyDown(el('hdr.title')!, { key: 'Enter' }); });
    await waitFor(() => { if (!el('hdr.title.dirty')) throw new Error('not dirty'); }); sweep();
    // Provider + chat: messages, handoff, plan card
    await act(async () => {
      const c = await runtime.api.addConnection({ provider: 'openrouter', label: 'OpenRouter', secret: 'sk-or-v1-test-key', validateNow: true });
      await runtime.api.putAssignments({ brainstorm: { agent: 'brainstorm', connectionId: c.id, modelId: 'openai/gpt-4.1-mini', settings: {} }, editor: { agent: 'editor', connectionId: c.id, modelId: 'anthropic/claude-sonnet-4.5', settings: {} } });
    });
    await openProvidersFromChat();
    await waitFor(() => { if (!el('scr.providers')) throw new Error('no providers'); });
    fireEvent.keyDown(el('scr.providers')!, { key: 'Escape' });
    fireEvent.change(chatComposer('brainstorm'), { target: { value: 'judul pembuka yang energik' } });
    await act(async () => { fireEvent.keyDown(chatComposer('brainstorm'), { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.brainstorm.handoff')) throw new Error('no handoff'); }); sweep();
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul pembuka yang kuat' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await waitFor(() => { if (!el('agent.editor.plancard')) throw new Error('no plan'); }); sweep();
    // Failed import → unsupported card + error banner
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await act(async () => { fireEvent.change(input, { target: { files: [new File(['x'], 'notes.xyz')] } }); });
    await waitFor(() => { if (!el('lib.assets.card.state.unsupported')) throw new Error('no unsupported card'); });
    // FR-053: an import-level error (limit reached) shows the banner with a recovery action
    await act(async () => { window.dispatchEvent(new CustomEvent('em:import-error', { detail: { code: 'EM-1401' } })); });
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
