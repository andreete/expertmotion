// @vitest-environment jsdom
// QA 2026-10-28 #8 (choose the narrator, many voices), #7 / #11 (voice + captions in one action), #9 / #10 (CC0 music library),
// FR-245 (download failure says what to do), FR-252 (plan step waiting for a model offers Install). ADR-035.
import { vi, describe, it, expect, afterEach } from 'vitest';
vi.mock('@remotion/player', () => import('./player-mock.js'));
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderEditor, el } from './setup-dom.js';
import { matchVoice, voiceCost } from '../src/screens/VoicePicker.js';
import { reduceEvent } from '../src/state/reducer.js';
import type { VoiceDto } from '../src/api/types.js';

afterEach(() => cleanup());
const rows = () => [...document.querySelectorAll<HTMLElement>('[data-el="scr.generate.voice.row"]')];

describe('voice picker (FR-246)', () => {
  it('lists local and cloud voices, explains why a voice cannot run, filters by description, sends the chosen voice + captions', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    const gen = vi.spyOn(runtime.api, 'createGeneratorJob');
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (rows().length < 4) throw new Error('no voices'); });
    expect(rows().map((r) => r.dataset['voiceId'])).toEqual(expect.arrayContaining(['local:piper-id-news', 'openai:gpt-4o-mini-tts:coral', 'gemini:gemini-3.8-flash-tts:Sulafat']));
    const coral = rows().find((r) => r.dataset['voiceId'] === 'openai:gpt-4o-mini-tts:coral')!;
    expect(coral.textContent).toContain('Connect OpenAI first');           // no OpenAI connection in the mock
    expect(coral.textContent).toMatch(/\$0\.018\/1k/);
    const piper = rows().find((r) => r.dataset['voiceId'] === 'local:piper-id-news')!;
    expect(piper.textContent).toContain('Needs its voice model');
    expect(piper.querySelector('[data-el="scr.generate.voice.install"]')).toBeTruthy();
    // description search ranks / filters: "hangat" keeps the warm voices
    fireEvent.change(el('scr.generate.voice.search')!, { target: { value: 'hangat' } });
    expect(rows().map((r) => r.dataset['voiceId'])).toEqual(expect.arrayContaining(['openai:gpt-4o-mini-tts:coral', 'gemini:gemini-3.8-flash-tts:Sulafat']));
    expect(rows().some((r) => r.dataset['voiceId'] === 'gemini:gemini-3.8-flash-tts:Charon')).toBe(false);
    fireEvent.change(el('scr.generate.voice.search')!, { target: { value: '' } });
    // install the local voice from its row, then generate with "Voice + captions"
    await act(async () => { fireEvent.click(rows().find((r) => r.dataset['voiceId'] === 'local:piper-id-news')!.querySelector('[data-el="scr.generate.voice.install"]')!); });
    await waitFor(async () => { if ((await runtime.api.getModel('piper-id-news')).status !== 'installed') throw new Error('installing'); }, { timeout: 6000 });
    await waitFor(() => { if (rows().find((r) => r.dataset['voiceId'] === 'local:piper-id-news')!.textContent!.includes('Needs')) throw new Error('not ready'); }, { timeout: 6000 });
    await act(async () => { fireEvent.click(rows().find((r) => r.dataset['voiceId'] === 'local:piper-id-news')!.querySelector('button + button')!); });
    expect((el('scr.generate.voice.voice.captions') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(el('scr.generate.voice.input')!, { target: { value: 'Energi bersih melimpah.' } });
    await act(async () => { fireEvent.click(el('scr.generate.voice.run')!); });
    expect(gen.mock.calls.at(-1)![2]).toMatchObject({ voiceId: 'local:piper-id-news', captions: true, text: 'Energi bersih melimpah.' });
  });

  it('Private Mode: cloud voices say why they are off; the preview button plays a sample blob', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    await runtime.api.installModel('piper-id-news');
    await waitFor(async () => { if ((await runtime.api.getModel('piper-id-news')).status !== 'installed') throw new Error('installing'); }, { timeout: 6000 });
    await runtime.api.putSettings({ privateMode: true });
    const prev = vi.spyOn(runtime.api, 'voicePreview');
    const play = vi.fn(async () => undefined);
    vi.stubGlobal('Audio', vi.fn(() => ({ play, pause: vi.fn(), onended: null })));
    URL.createObjectURL = vi.fn(() => 'blob:mock'); URL.revokeObjectURL = vi.fn();
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.voice')!); });
    await waitFor(() => { if (!el('scr.generate.voice.private')) throw new Error('no private note'); });
    expect(rows().find((r) => r.dataset['voiceId']?.startsWith('gemini:'))!.textContent).toContain('Off in Private Mode');
    const local = rows().find((r) => r.dataset['voiceId'] === 'local:piper-id-news')!;
    await act(async () => { fireEvent.click(local.querySelector('[data-el="scr.generate.voice.preview"]')!); });
    await waitFor(() => { if (!play.mock.calls.length) throw new Error('not played'); });
    expect(prev).toHaveBeenCalledWith('local:piper-id-news', expect.any(String));
    vi.unstubAllGlobals();
  });

  it('description matching and cost estimate', () => {
    const v = { id: 'openai:gpt-4o-mini-tts:coral', provider: 'openai', name: 'Coral', gender: 'female', traits: { id: ['hangat'], en: ['warm'] }, languages: ['id'], cloud: true, supports: { speed: true, pitch: false, style: true }, usdPer1kChars: 0.018, availability: 'ready', installed: true } as VoiceDto;
    expect(matchVoice(v, 'perempuan hangat')).toBe(2);
    expect(matchVoice(v, 'laki')).toBe(0);
    expect(voiceCost(v, 2000)).toBeCloseTo(0.036);
    expect(voiceCost({ ...v, cloud: false }, 2000)).toBeNull();
  });
});

describe('CC0 music library (FR-247)', () => {
  it('browse by mood → download → use as music (one version with a music bed); credit + CC0 licence shown', { timeout: 20_000 }, async () => {
    const { runtime } = await renderEditor('sample');
    const ins = vi.spyOn(runtime.api, 'insertMusicTrack');
    await act(async () => { fireEvent.click(el('hdr.menu.tools')!); });
    await act(async () => { fireEvent.click(el('lib.generator.card.music')!); });
    await waitFor(() => { if (!el('scr.generate.music.library.track')) throw new Error('no tracks'); });
    expect(el('scr.generate.music.ai')!.textContent).toContain('not available in this version');
    const moods = el('scr.generate.music.library.moods')!;
    await act(async () => { fireEvent.click([...moods.querySelectorAll('button')].find((b) => b.textContent === 'Calm')!); });
    await waitFor(() => { const ts = document.querySelectorAll('[data-el="scr.generate.music.library.track"]'); if (ts.length !== 1) throw new Error(`${ts.length}`); });
    const tr = el('scr.generate.music.library.track')!;
    expect(tr.textContent).toContain('Infinite Peace');
    expect(tr.textContent).toContain('CC0 1.0');
    await act(async () => { fireEvent.click(tr.querySelector('[data-el="scr.generate.music.library.download"]')!); });
    await waitFor(() => { if (!document.querySelector('[data-el="scr.generate.music.library.insert"]')) throw new Error('not downloaded'); }, { timeout: 5000 });
    await act(async () => { fireEvent.click(document.querySelector('[data-el="scr.generate.music.library.insert"]')!); });
    expect(ins).toHaveBeenCalledWith(runtime.seededProjectId, 'infinite-peace');
    await waitFor(async () => { const c = await runtime.api.getComposition(runtime.seededProjectId!); if (!c.head.model?.tracks.audio.some((a) => a.role === 'bed')) throw new Error('no bed'); });
  });
});

describe('download failures say what to do (FR-245)', () => {
  it('model.progress retry and model.failed reason land on the model row state', () => {
    const base = { models: [{ key: 'm', status: 'downloading', bytesDone: 10, bytesTotal: 100 }] } as unknown as Parameters<typeof reduceEvent>[0];
    const a = reduceEvent(base, { name: 'model.progress', data: { key: 'm', bytesDone: 10, bytesTotal: 100, status: 'downloading', retry: { attempt: 2, reason: 'rate-limited', delayMs: 42_000 } } } as never);
    expect(a.models[0]).toMatchObject({ retry: { attempt: 2, reason: 'rate-limited', delayMs: 42_000 } });
    const b = reduceEvent(a, { name: 'model.failed', data: { key: 'm', code: 'EM-7002', reason: 'tls' } } as never);
    expect(b.models[0]).toMatchObject({ status: 'failed', errorCode: 'EM-7002', failReason: 'tls', retry: null });
  });
});
