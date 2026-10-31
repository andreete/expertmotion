// @vitest-environment jsdom
// ADR-041 internet assets in the Editor (FR-301, FR-306, FR-307): the picture candidate card with a Pexels video (kind badge,
// licence line, author), a page picture (owner's-copyright notice), Import for the new sources; the "Riset internet" section of the
// AI providers screen with the Pexels key field (saved → hint, refused → EM-4410, removed); the web.screenshot progress words.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { el, els, chatComposer, openProvidersFromChat } from './setup-dom.js';
import { App } from '../src/App.js';
import { StoreProvider } from '../src/state/store.js';
import { createMockRuntime, type Runtime } from '../src/state/runtime.js';
import { MockBus } from '../src/mock/MockEventSource.js';
import { candidateLicence, progressText } from '../src/agent/Chat.js';
import { translate } from '../src/i18n/index.js';
import type { ImageCandidateDto, MessageDto } from '../src/api/types.js';

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
const PEXELS_PHOTO: ImageCandidateDto = { source: 'pexels', id: '2014422', kind: 'image', title: 'Brown rocks during golden hour', creator: 'Joey Farina', license: 'pexels', licence: 'Pexels License', licenseVersion: null, licenseUrl: 'https://www.pexels.com/license/', landingUrl: 'https://www.pexels.com/photo/2014422/', width: 3024, height: 4032, provider: 'pexels' };
const PEXELS_VIDEO: ImageCandidateDto = { source: 'pexels-video', id: '2499611', kind: 'video', title: 'Pexels video 2499611 (22 s)', creator: 'Joey Farina', license: 'pexels', licence: 'Pexels License', licenseVersion: null, licenseUrl: null, landingUrl: 'https://www.pexels.com/video/2499611/', width: 1080, height: 1920, provider: 'pexels', durationS: 22 };
const PAGE_PIC: ImageCandidateDto = { source: 'page', id: 'pg-0123456789abcdef', kind: 'image', title: 'Poster acara yang dibatalkan', creator: 'kompas.com', license: 'owner', licence: 'Hak cipta pemilik — kutipan/komentar', licenseVersion: null, licenseUrl: null, landingUrl: 'https://www.kompas.com/berita/boikot', width: 1200, height: 800, provider: 'kompas.com' };
const answer = (id: string, items: ImageCandidateDto[]): MessageDto => ({ id, role: 'assistant', agentRunId: 'r1', createdAt: '2026-10-31T10:00:00.000Z', blocks: [{ type: 'text', text: 'Ini kandidat gambarnya.' }, { type: 'image_candidates', items }] });
const done = (bus: MockBus, pid: string, message: MessageDto) => bus.emit('agent.run.done', { projectId: pid, run: { id: 'r1', projectId: pid, agent: 'brainstorm', status: 'done', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: 'x', finishedAt: 'y' }, message, usage: null, contextUsage: null });

describe('candidate cards for stock and page pictures (FR-306, FR-307)', () => {
  it('candidateLicence words', () => {
    expect(candidateLicence(PEXELS_PHOTO, t)).toBe('Pexels License');
    expect(candidateLicence(PAGE_PIC, t)).toBe('Hak cipta pemilik — kutipan/komentar');
    { const { licence: _l, ...open } = PEXELS_PHOTO; expect(candidateLicence({ ...open, source: 'openverse', license: 'by', licenseVersion: '4.0' }, t)).toBe('CC BY 4.0'); expect(candidateLicence({ ...open, source: 'wikimedia', license: 'pdm' }, t)).toBe('Domain publik'); }
    expect(progressText({ phase: 'tool', tool: 'web.screenshot', url: 'https://www.kompas.com/a' }, t)).toBe('Memotret halaman: kompas.com…');
    expect(progressText({ phase: 'tool', tool: 'web.screenshot' }, t)).toBe('Memotret halaman web…');
  });

  it('a stock block shows the video badge, licence lines and author; Import of the clip marks it in the Library', { timeout: 30_000 }, async () => {
    const { bus, pid } = await boot();
    await act(async () => { done(bus, pid, answer('01M61TESTSTOCK000000000001', [PEXELS_PHOTO, PEXELS_VIDEO])); });
    await until(() => el('agent.chat.message.images'), 'cards');
    expect(el('agent.chat.message.images')!.getAttribute('data-source')).toBe('stock');
    expect(el('agent.chat.message.images')!.textContent).toContain('Stock photos and videos (2)');   // the mock Editor runs in English
    const rows = els('agent.chat.message.image');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['image', 'video']);
    expect(rows[1]!.querySelector('[data-el="agent.chat.message.image.kind"]')!.textContent).toBe('Video · 22 s');
    expect(rows[0]!.querySelector('[data-el="agent.chat.message.image.kind"]')).toBeNull();
    expect(els('agent.chat.message.image.licence').map((x) => x.textContent)).toEqual(['Pexels License · 3024×4032', 'Pexels License · 1080×1920']);
    expect(rows[1]!.textContent).toContain('Joey Farina');
    expect(el('agent.chat.message.images.owner')).toBeNull();
    expect(el('agent.chat.message.images')!.textContent).toContain('Pexels License: free to use');
    const importBtn = rows[1]!.querySelector('[data-el="agent.chat.message.image.import"]') as HTMLElement;
    await act(async () => { fireEvent.click(importBtn); });
    await until(() => els('agent.chat.message.image')[1]!.getAttribute('data-imported') === 'true', 'clip imported');
    expect(els('agent.chat.message.image')[1]!.textContent).toContain('In Library');
    await until(() => els('lib.assets.card').some((c) => c.textContent?.includes('Pexels video')), 'clip in the Library');
  });

  it('a page block says "Gambar dari <host>", the owner notice and the licence line; Import works', { timeout: 30_000 }, async () => {
    const { bus, pid } = await boot();
    await act(async () => { done(bus, pid, answer('01M61TESTPAGE0000000000002', [PAGE_PIC, { ...PAGE_PIC, id: 'pg-fedcba9876543210', title: 'Komentar netizen', width: 900, height: 1600 }])); });
    await until(() => el('agent.chat.message.images'), 'cards');
    expect(el('agent.chat.message.images')!.getAttribute('data-source')).toBe('page');
    expect(el('agent.chat.message.images')!.textContent).toContain('Pictures from kompas.com (2)');
    expect(el('agent.chat.message.images.owner')!.textContent).toBe("Owner's copyright — use for quotation / commentary and name the source.");
    expect(translate('id', 'ui.agent.research.images.owner')).toBe('Hak cipta pemilik — pakai untuk kutipan/komentar, cantumkan sumber.');
    expect(els('agent.chat.message.image.licence')[0]!.textContent).toBe("Owner's copyright — quotation / commentary · 1200×800 · kompas.com");
    expect(el('agent.chat.message.images')!.textContent).not.toMatch(/Openly licensed pictures|free to use/);
    expect(el('agent.chat.message.images')!.textContent).toContain('not openly licensed');
    await act(async () => { fireEvent.click(els('agent.chat.message.image.import')[0]!); });
    await until(() => els('agent.chat.message.image')[0]!.getAttribute('data-imported') === 'true', 'picture imported');
  });
});

describe('Settings ▸ Riset internet ▸ Kunci API Pexels (FR-301)', () => {
  it('saves a key (hint shown), refuses a bad one with EM-4410, removes it; the research switch mirrors the chat setting', { timeout: 30_000 }, async () => {
    await boot();
    await openProvidersFromChat();
    await until(() => el('scr.providers.research'), 'research section');
    expect(el('scr.providers.research')!.textContent).toContain('Internet research');
    expect(translate('id', 'ui.scr.providers.research.pexels.label')).toBe('Kunci API Pexels (opsional)');
    expect(el('scr.providers.research.pexels')!.getAttribute('data-connected')).toBe('false');
    expect(el('scr.providers.research.pexels.status')!.textContent).toContain('free Pexels key');
    expect((el('scr.providers.research.toggle') as HTMLInputElement).checked).toBe(true);
    const input = el('scr.providers.research.pexels.key') as HTMLInputElement;
    expect(input.type).toBe('password');
    expect(el('scr.providers.research.pexels.save')!.getAttribute('aria-disabled')).toBe('true');
    fireEvent.paste(input, { clipboardData: { getData: () => ' badkey0000000000000000000000 ' } });
    expect(input.value).toBe('badkey0000000000000000000000');
    await act(async () => { fireEvent.click(el('scr.providers.research.pexels.save')!); });
    await until(() => el('scr.providers.research.pexels.error'), 'refused');
    expect(el('scr.providers.research.pexels.error')!.getAttribute('data-code')).toBe('EM-4410');
    fireEvent.change(input, { target: { value: 'goodkey0123456789abcdef' } });
    await act(async () => { fireEvent.click(el('scr.providers.research.pexels.save')!); });
    await until(() => el('scr.providers.research.pexels')?.getAttribute('data-connected') === 'true', 'connected');
    expect(el('scr.providers.research.pexels.status')!.textContent).toContain('Pexels connected (…cdef)');
    expect((el('scr.providers.research.pexels.key') as HTMLInputElement).value).toBe('');
    await act(async () => { fireEvent.click(el('scr.providers.research.pexels.remove')!); });
    await until(() => el('scr.providers.research.pexels')?.getAttribute('data-connected') === 'false', 'removed');
    await act(async () => { fireEvent.click(el('scr.providers.research.toggle')!); });
    await until(() => el('agent.chat.research')?.getAttribute('aria-checked') === 'false', 'research off everywhere');
    await act(async () => { fireEvent.click(el('scr.providers.research.toggle')!); });
    await until(() => el('agent.chat.research')?.getAttribute('aria-checked') === 'true', 'research on again');
  });
});
