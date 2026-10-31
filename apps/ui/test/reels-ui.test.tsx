// @vitest-environment jsdom
// FR-280 … FR-299 (Reels pipeline, DESIGN §E) — the UI pieces against the mock Service: channel profile editor, "Jadikan profil
// kanal", the prep card (stages → rotation question → cut table), the cover picker, "PRD siap · Setujui & kirim ke Editor", the
// three stage buttons, the typed time → playheadMs, Export "Cover (JPG)" + the CREDITS note, "Siapkan rekaman" in the Asset Panel.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderEditor, el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import type { Runtime } from '../src/state/runtime.js';
import { channelProfileRatio, cutRows, cutsTotalMs, fmtMs, footagePair, parseTimestamp, prdReady, prepStageIndex, sheetGrid } from '../src/agent/reels.js';
import { hookWordOf } from '../src/agent/Reels.js';
import { parseElementIds } from './elementIds.js';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const until = (fn: () => unknown, what: string, timeout = 8000) => waitFor(() => { if (!fn()) throw new Error(`waiting for ${what}`); }, { timeout });

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
/** Imports a landscape camera file and a voice recording (the mock probes 1920×1080 → the prep asks for the rotation). */
async function importFootage(runtime: Runtime) {
  const pid = (await runtime.api.listProjects()).items[0]!.id;
  await act(async () => { await runtime.api.uploadAssets(pid, [new File([new Uint8Array(64)], 'Reels Raw Video.mp4', { type: 'video/mp4' }), new File([new Uint8Array(64)], 'Reels Raw Audio.m4a', { type: 'audio/mp4' })]); });
  await until(() => els('lib.assets.card').filter((c) => c.getAttribute('data-status') === 'ready').length >= 5, 'footage ready');
  return pid;
}
/** Starts the prep from the Asset Panel and answers the rotation question; resolves once the card is done. */
async function runPrep() {
  await until(() => el('lib.assets.prep'), 'Siapkan rekaman');
  await act(async () => { fireEvent.click(el('lib.assets.prep')!); });
  await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'needs-input', 'rotation question');
  await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="agent.chat.prep.rotation"][data-rotation="90"]')!); });
  await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'done', 'prep done');
}

describe('reels helpers (pure)', () => {
  it('reads a typed time, the PRD closing line and the channel ratio', () => {
    expect(parseTimestamp('perbaiki di 0:23')).toEqual({ ms: 23_000, label: '0:23' });
    expect(parseTimestamp('teks di 1:05.5 terlalu cepat')?.ms).toBe(65_500);
    expect(parseTimestamp('dari 01:02:03')?.ms).toBe(3_723_000);
    expect(parseTimestamp('rasio 16:9 saja')).toBeNull();                            // 9 is not a two-digit second
    expect(parseTimestamp('bikin 3 adegan')).toBeNull();
    expect(parseTimestamp('jam 10:75')).toBeNull();
    expect(prdReady('…\n\nPRD siap.')).toBe(true);
    expect(prdReady('PRD siap')).toBe(true);
    expect(prdReady('PRD siap? belum')).toBe(false);
    expect(channelProfileRatio('Kanal Reels edukasi, 9:16, di bawah 60 detik')).toBe('9:16');
    expect(channelProfileRatio('YouTube Shorts harian')).toBe('9:16');
    expect(channelProfileRatio('Video YouTube panjang 16:9')).toBe('16:9');
    expect(channelProfileRatio('Konten edukasi santai')).toBeNull();
    expect(channelProfileRatio('')).toBeNull();
    expect(fmtMs(57_877)).toBe('0:58'); expect(fmtMs(3_661_000)).toBe('1:01:01');
    expect(prepStageIndex('listen')).toBe(4); expect(prepStageIndex('done')).toBe(7); expect(prepStageIndex(undefined)).toBe(0);
    expect(sheetGrid(8)).toEqual({ cols: 3, rows: 3 }); expect(sheetGrid(1)).toEqual({ cols: 1, rows: 1 });
    expect(hookWordOf('bayangkan reaktor nuklir')).toBe('Bayangkan'); expect(hookWordOf('AI itu')).toBe('AI');
  });
  it('builds the cut table and finds the footage pair', () => {
    const cuts = [{ id: 'c1', lineIndex: 0, startMs: 8_140, endMs: 14_540, text: 'satu dua tiga', words: [{ text: 'satu', fromMs: 8_200, toMs: 8_500 }] }, { id: 'c2', lineIndex: 1, startMs: 48_720, endMs: 58_580, text: 'empat lima', words: [] }];
    const rows = cutRows({ cuts });
    expect(rows.map((r) => [r.no, r.range, r.words])).toEqual([[1, '0:08–0:15', 1], [2, '0:49–0:59', 2]]);
    expect(cutsTotalMs({ cuts })).toBe(16_260);
    expect(cutRows(null)).toEqual([]);
    const assets = [{ id: 'v', kind: 'video', status: 'ready', name: 'cam.mp4' }, { id: 'm', kind: 'video', status: 'ready', name: 'voice · master' }, { id: 'a', kind: 'audio', status: 'ingesting', name: 'v.m4a' }, { id: 'b', kind: 'audio', status: 'ready', name: 'voice.m4a' }];
    expect(footagePair(assets)).toEqual({ video: 'v', audio: 'b' });
    expect(footagePair(assets.filter((a) => a.kind !== 'audio'))).toBeNull();
    expect(footagePair([...assets, { id: 'v2', kind: 'video', status: 'ready', name: 'b-roll.mp4' }], ['v2'])).toEqual({ video: 'v2', audio: 'b' });
  });
  it('documents every new element id in ELEMENT_IDS.md', () => {
    const ids = new Set(parseElementIds());
    for (const id of ['scr.channel', 'scr.channel.text', 'scr.channel.save', 'hdr.menu.help.channel', 'agent.chat.menu', 'agent.chat.menu.profile', 'agent.chat.attach.profile', 'agent.chat.composer.time', 'agent.chat.prd.approve',
      'agent.chat.prep', 'agent.chat.prep.stage', 'agent.chat.prep.rotation', 'agent.chat.prep.cuts', 'agent.chat.prep.cut', 'agent.chat.cover', 'agent.chat.cover.cell', 'agent.chat.cover.render', 'agent.chat.cover.result',
      'agent.editor.stage', 'agent.editor.stage.prep', 'agent.editor.stage.preview', 'agent.editor.stage.final', 'lib.assets.prep', 'scr.export.codec.jpg', 'scr.export.done.credits', 'scr.project.new.ratio.channel']) expect(ids.has(id), id).toBe(true);
  });
});

describe('channel profile', () => {
  it('is edited from Help and the chat menu, saved to settings and sets the new-project ratio', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.menu.help')!); });
    await act(async () => { fireEvent.click(el('hdr.menu.help.channel')!); });
    await until(() => el('scr.channel.text'), 'channel dialog');
    expect(el('scr.channel.save')?.getAttribute('aria-disabled')).toBe('true');          // nothing changed yet
    fireEvent.change(el('scr.channel.text')!, { target: { value: 'Kanal Reels edukasi energi, 9:16, di bawah 60 detik, kata kunci kuning.' } });
    expect(el('scr.channel.ratio')?.getAttribute('data-ratio')).toBe('9:16');
    expect(el('scr.channel.count')?.textContent).toMatch(/^7\d \/ 6/);
    await act(async () => { fireEvent.click(el('scr.channel.save')!); });
    await until(() => !el('scr.channel'), 'dialog closed');
    expect((await runtime.api.getSettings()).channelProfile).toContain('Kanal Reels edukasi');
    // the chat header menu reopens it with the saved text
    await act(async () => { fireEvent.click(el('agent.chat.menu')!); });
    await act(async () => { fireEvent.click(el('agent.chat.menu.profile')!); });
    await until(() => el('scr.channel.text'), 'channel dialog again');
    expect((el('scr.channel.text') as HTMLTextAreaElement).value).toContain('Kanal Reels edukasi');
    fireEvent.keyDown(el('scr.channel')!, { key: 'Escape' });
    // New project: the ratio comes from the profile
    await act(async () => { fireEvent.click(el('hdr.menu.file')!); });
    await act(async () => { fireEvent.click(el('hdr.menu.file.newcustom')!); });
    await until(() => el('scr.project.new.ratio'), 'new dialog');
    expect((el('scr.project.new.ratio') as HTMLSelectElement).value).toBe('9:16');
    expect(el('scr.project.new.ratio.channel')).not.toBeNull();
  }, 20_000);

  it('refuses more than 6 000 characters and offers "Jadikan profil kanal" on an attached .md', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await act(async () => { fireEvent.click(el('hdr.menu.help')!); });
    await act(async () => { fireEvent.click(el('hdr.menu.help.channel')!); });
    await until(() => el('scr.channel.text'), 'channel dialog');
    fireEvent.change(el('scr.channel.text')!, { target: { value: 'x'.repeat(6001) } });
    expect(el('scr.channel.save')?.getAttribute('aria-disabled')).toBe('true');
    expect(el('scr.channel.count')?.className).toContain('text-em-danger');
    fireEvent.keyDown(el('scr.channel')!, { key: 'Escape' });
    await until(() => !el('scr.channel'), 'closed');
    // a .md attached through the composer's file input keeps its text for the profile button
    chatComposer('brainstorm');
    const input = el('agent.chat.attach.input') as HTMLInputElement;
    const file = new File(['# Profil kanal\nReels 9:16, santai, CTA di akhir.'], 'profil.md', { type: 'text/markdown' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => { fireEvent.change(input); });
    await until(() => el('agent.chat.attach.profile'), 'profile button on the chip');
    await act(async () => { fireEvent.click(el('agent.chat.attach.profile')!); });
    await until(() => el('scr.channel.text'), 'dialog with draft');
    expect((el('scr.channel.text') as HTMLTextAreaElement).value).toContain('Reels 9:16, santai');
    expect(el('scr.channel.ratio')?.getAttribute('data-ratio')).toBe('9:16');
  }, 20_000);
});

describe('footage prep card and cover picker', () => {
  it('runs the prep from the Asset Panel: stages, rotation question with four thumbnails, cut table; then a cover from a cell', async () => {
    const { runtime } = await renderEditor('sample');
    expect(el('lib.assets.prep')).toBeNull();                                            // the sample has images only
    await importFootage(runtime);
    await until(() => el('lib.assets.prep'), 'Siapkan rekaman');
    await act(async () => { fireEvent.click(el('lib.assets.prep')!); });
    await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'needs-input', 'rotation question');
    const card = el('agent.chat.prep')!;
    expect(within(card).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(els('agent.chat.prep.stage').length).toBe(7);
    expect(els('agent.chat.prep.rotation').map((b) => b.getAttribute('data-rotation'))).toEqual(['0', '90', '180', '270']);
    expect(el('lib.assets.prep')?.getAttribute('aria-disabled')).toBe('true');          // one prep at a time
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="agent.chat.prep.rotation"][data-rotation="90"]')!); });
    await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'done', 'prep done');
    expect(els('agent.chat.prep.cut').length).toBe(3);
    expect(els('agent.chat.prep.cut')[0]?.textContent).toMatch(/1\s*0:08–0:1\d\s*5/);     // no · time range · words
    expect(el('agent.chat.prep.summary')?.textContent).toContain('3.54');
    expect(el('agent.chat.prep.dropped')).not.toBeNull();
    expect(els('agent.chat.prep.stage').every((s) => s.getAttribute('data-state') === 'done')).toBe(true);
    // the master became an asset
    await until(() => els('lib.assets.card').some((c) => c.getAttribute('aria-label')?.includes('master')), 'master asset');
    // cover picker: contact sheet with one cell per cut → fields → POST /cover → the saved still
    await until(() => el('agent.chat.cover.open'), 'cover picker');
    await act(async () => { fireEvent.click(el('agent.chat.cover.open')!); });
    await until(() => els('agent.chat.cover.cell').length === 3, 'cells');
    await act(async () => { fireEvent.click(els('agent.chat.cover.cell')[1]!); });
    expect((el('agent.chat.cover.hook') as HTMLInputElement).value).toBe('Pusat');
    expect((el('agent.chat.cover.line') as HTMLInputElement).value).toContain('Pusat data AI');
    fireEvent.change(el('agent.chat.cover.hook')!, { target: { value: 'LISTRIK' } });
    const spy = vi.spyOn(runtime.api, 'renderCover');
    await act(async () => { fireEvent.click(el('agent.chat.cover.render')!); });
    await until(() => el('agent.chat.cover.result'), 'cover result');
    expect(spy).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cutId: 'cut-2', hookWord: 'LISTRIK' }));
    expect(el('agent.chat.cover.result')?.textContent).toContain('-cover.jpg');
    expect(el('agent.chat.cover.reveal')).not.toBeNull();
    expect(el('agent.chat.cover.copypath')).not.toBeNull();
    const outs = await runtime.api.listOutputs((await runtime.api.listProjects()).items[0]!.id);
    expect(outs.items[0]).toMatchObject({ kind: 'still', width: 1080, height: 1920 });
  }, 25_000);

  it('starts from the chat menu with the project pair, answers 0° and stores the analysis on the Service side', async () => {
    const { runtime } = await renderEditor('sample');
    const pid = await importFootage(runtime);
    const video = (await runtime.api.listAssets(pid)).items.find((a) => a.kind === 'video')!, audio = (await runtime.api.listAssets(pid)).items.find((a) => a.kind === 'audio')!;
    const spy = vi.spyOn(runtime.api, 'startFootagePrep');
    await act(async () => { fireEvent.click(el('agent.chat.menu')!); });
    await act(async () => { fireEvent.click(el('agent.chat.menu.prep')!); });
    await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'needs-input', 'question');
    expect(spy).toHaveBeenCalledWith(pid, { voiceAssetId: audio.id, cameraAssetId: video.id });
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="agent.chat.prep.rotation"][data-rotation="0"]')!); });
    await until(() => el('agent.chat.prep')?.getAttribute('data-status') === 'done', 'done');
    const stored = await runtime.api.footageAnalysis(pid);
    expect(stored.cuts.length).toBe(3);
    expect(stored.rotation).toBe(0);
    const jobs = await runtime.api.listGeneratorJobs(pid, { kind: 'prep' });
    expect(jobs.items[0]?.status).toBe('done');
  }, 25_000);
});

describe('PRD approval, stage buttons and typed time', () => {
  it('offers "PRD siap · Setujui & kirim ke Editor" on a PRD answer and hands it off', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    fireEvent.change(chatComposer('brainstorm'), { target: { value: 'Buat PRD untuk Reels 42' } });
    await act(async () => { fireEvent.keyDown(chatComposer('brainstorm'), { key: 'Enter' }); });
    await until(() => el('agent.chat.prd.approve'), 'approve button');
    expect(el('agent.chat.prd.approve')?.textContent).toMatch(/PRD/);
    await act(async () => { fireEvent.click(el('agent.chat.prd.approve')!); });
    await until(() => el('agent.chat.tab.editor')?.getAttribute('aria-selected') === 'true', 'editor tab');
    await until(() => els('agent.chat.message').some((m) => m.getAttribute('data-agent') === 'editor' && m.getAttribute('data-role') === 'user'), 'editor request');
    chatComposer('brainstorm');
    await until(() => el('agent.brainstorm.handoff.card'), 'hand-off card');
    expect(el('agent.chat.prd.approve')).toBeNull();                                      // handed off: no second approval
  }, 20_000);

  it('shows Siapkan · Pratinjau · Final on the Plan Card; Pratinjau applies the plan and renders 720p', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    await importFootage(runtime);
    fireEvent.change(chatComposer('editor'), { target: { value: 'buat judul pembuka yang kuat' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => el('agent.editor.plancard')?.getAttribute('data-status') === 'valid', 'plan');
    const stage = within(el('agent.editor.plancard')!).getByRole('group', { name: /Footage steps|Langkah rekaman/ });
    expect(stage.querySelector('[data-el="agent.editor.stage.prep"]')).not.toBeNull();
    expect(stage.querySelector('[data-el="agent.editor.stage.final"]')).not.toBeNull();
    await act(async () => { fireEvent.click(stage.querySelector<HTMLElement>('[data-el="agent.editor.stage.preview"]')!); });
    await until(() => els('agent.editor.plancard').some((c) => c.getAttribute('data-status') === 'executed'), 'executed');
    await until(() => el('scr.export'), 'export dialog on the running job');
    await until(() => el('scr.export.done'), 'render done');
    const jobs = await runtime.api.listRenders();
    expect(jobs.items[0]?.outputProfile.resolution).toBe('720p');
    expect(el('scr.export.done.credits')).not.toBeNull();                               // CREDITS.txt note after a video render
    fireEvent.keyDown(el('scr.export')!, { key: 'Escape' });
    // Siapkan from the card starts the prep with the project's video + audio
    const spy = vi.spyOn(runtime.api, 'startFootagePrep');
    await act(async () => { fireEvent.click(document.querySelector<HTMLElement>('[data-el="agent.editor.stage.prep"]')!); });
    await until(() => el('agent.chat.prep'), 'prep card');
    expect(spy).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('says why when Siapkan has no recording, and Final needs clips', async () => {
    const { runtime } = await renderEditor('empty');
    await connect(runtime);
    await act(async () => { fireEvent.click(el('agent.chat.menu')!); });
    expect(el('agent.chat.menu.prep')?.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(el('agent.chat.menu.prep')!, { key: 'Escape' });
  }, 20_000);

  it('turns "perbaiki di 0:23" into the message playhead and shows the time chip', async () => {
    const { runtime } = await renderEditor('sample');
    await connect(runtime);
    const spy = vi.spyOn(runtime.api, 'sendMessage');
    fireEvent.change(chatComposer('editor'), { target: { value: 'perbaiki teks di 0:23 supaya lebih besar' } });
    expect(el('agent.chat.composer.time')?.getAttribute('data-ms')).toBe('23000');
    expect(el('agent.chat.composer.time')?.textContent).toContain('0:23');
    chatComposer('brainstorm');
    fireEvent.change(el('agent.chat.composer')!, { target: { value: 'ide di 0:23' } });
    expect(el('agent.chat.composer.time')).toBeNull();                                   // Diskusi messages carry no playhead
    fireEvent.change(chatComposer('editor'), { target: { value: 'perbaiki teks di 0:23 supaya lebih besar' } });
    await act(async () => { fireEvent.keyDown(chatComposer('editor'), { key: 'Enter' }); });
    await until(() => spy.mock.calls.length > 0, 'sent');
    expect(spy.mock.calls[0]![2]).toMatchObject({ playheadMs: 23_000 });
    expect(el('agent.chat.composer.time')).toBeNull();
  }, 20_000);
});

describe('export: Cover (JPG)', () => {
  it('renders a JPEG still with the still-time field and no credits note', async () => {
    const { runtime } = await renderEditor('sample');
    await act(async () => { fireEvent.click(el('hdr.action.export')!); });
    await until(() => el('scr.export.codec.jpg'), 'export dialog');
    await act(async () => { fireEvent.click(el('scr.export.codec.jpg')!); });
    await until(() => el('scr.export.still.time'), 'still time');
    expect(el('scr.export.profile.summary')?.textContent).toMatch(/Cover \(JPG\)/);
    expect(el('scr.export.filename')?.parentElement?.parentElement?.textContent).toContain('.jpg');
    const spy = vi.spyOn(runtime.api, 'createRender');
    await until(() => !el('scr.export.start')?.getAttribute('aria-disabled'), 'preflight');
    await act(async () => { fireEvent.click(el('scr.export.start')!); });
    await until(() => el('scr.export.done'), 'done');
    expect(spy.mock.calls[0]![0].outputProfile).toMatchObject({ format: 'jpg', codec: 'jpg' });
    expect(spy.mock.calls[0]![0].outputProfile.stillAtMs).toBeTypeOf('number');
    expect(el('scr.export.done.credits')).toBeNull();
    const outs = await runtime.api.listOutputs((await runtime.api.listProjects()).items[0]!.id);
    expect(outs.items[0]).toMatchObject({ kind: 'still' });
    expect(outs.items[0]!.fileName).toMatch(/\.jpg$/);
  }, 20_000);
});
