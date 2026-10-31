// @vitest-environment jsdom
// ADR-039 (Reels pipeline, section B): pure helpers (zoom keyframes, bubble focus transform, gain segments, caption keywords /
// chunks) and the real ExpertmotionTimeline (Remotion Thumbnail in jsdom): the face bubble's mask + ring + focus transform, the
// clip punch-in on the media wrapper, caption keyword colours / yU, silent pages, and every infographic shape preset mounting.
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Thumbnail } from '@remotion/player';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { getPreset, listPresets } from '@expertmotion/catalogue';
import { ExpertmotionTimeline, EMPTY_INPUT, clipZoomScale, focusTransform, gainMultiplier, captionKeywordColour, captionChunk, ICON_IDS, missingImplementations, NOT_IMPLEMENTED, typedChars, toneColours, tokensFor, fitRun, fontStack, symbolRuns, TEXT_FLOORS_U, type EngineInputProps } from '../src/index.js';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

const ASSETS = [{ id: 'cam', kind: 'video' as const, status: 'ready' as const, durationMs: 60_000, width: 1080, height: 1920, hasAudio: true }, { id: 'mus', kind: 'audio' as const, status: 'ready' as const, durationMs: 90_000 }];
const URLS = { cam: { kind: 'video' as const, playable: 'http://127.0.0.1:4199/media/x/cam/playable', width: 1080, height: 1920, hasAudio: true }, mus: { kind: 'audio' as const, playable: 'http://127.0.0.1:4199/media/x/mus/playable' } };
function model(ops: OperationT[]): CompositionModelT {
  let n = 0;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '9:16' }), ops, { assets: ASSETS, tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
function render(m: CompositionModelT, frame = 15): HTMLElement {
  const host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  const props: EngineInputProps = { ...EMPTY_INPUT, model: m, assets: URLS };
  act(() => root!.render(<Thumbnail component={ExpertmotionTimeline} inputProps={props} compositionWidth={1080} compositionHeight={1920} durationInFrames={180} fps={30} frameToDisplay={frame} />));
  return host;
}

describe('clipZoomScale (pure, frame-based)', () => {
  it('1 without a zoom; linear from → to across the clip; a pop adds its amount at once and settles back', () => {
    expect(clipZoomScale(undefined, 10, 90, 30)).toBe(1);
    const z = { from: 1.12, to: 1.2 };
    expect(clipZoomScale(z, 0, 91, 30)).toBe(1.12);
    expect(clipZoomScale(z, 45, 91, 30)).toBe(1.16);
    expect(clipZoomScale(z, 90, 91, 30)).toBe(1.2);
    expect(clipZoomScale(z, 200, 91, 30)).toBe(1.2);                                   // clamped past the end
    const pop = { from: 1, to: 1, pops: [{ atMs: 1000, amount: 0.1 }] };
    expect(clipZoomScale(pop, 29, 300, 30)).toBe(1);                                   // before the pop
    expect(clipZoomScale(pop, 30, 300, 30)).toBe(1.1);                                 // the pop frame: + amount
    const mid = clipZoomScale(pop, 36, 300, 30);
    expect(mid).toBeGreaterThan(1); expect(mid).toBeLessThan(1.1);                      // settling
    expect(clipZoomScale(pop, 30 + 14, 300, 30)).toBe(1);                              // settled after 450 ms (14 frames)
    expect(clipZoomScale({ from: 1, to: 1, pops: [{ atMs: 0, amount: 0.2, durationMs: 1000 }] }, 15, 300, 30)).toBeGreaterThan(1.005);  // a slower pop is still settling at 500 ms
  });
});

describe('focusTransform (face bubble)', () => {
  it('empty without focus or at the identity; moves the source point to the box centre then zooms there (cover fit)', () => {
    expect(focusTransform(undefined, 260, 260)).toBe('');
    expect(focusTransform({ x: 0.5, y: 0.5, zoom: 1 }, 260, 260, 1080, 1920)).toBe('');
    // 1080 × 1920 source cover-fitted in a 260 × 260 box: scale 260 / 1080, rendered 260 × 462.2; y = 0.32 → 147.9 px from the top of the rendered picture, (462.2 − 260) / 2 = 101.1 cropped above → 46.8 px in the box → move down 83.2 px
    expect(focusTransform({ x: 0.5, y: 0.32, zoom: 0.62 }, 260, 260, 1080, 1920)).toBe('scale(0.62) translate(0px, 83.2px)');
    // without the source size the box aspect stands in: y 0.32 of 260 = 83.2 → 46.8 px up to the centre
    expect(focusTransform({ x: 0.5, y: 0.32, zoom: 1 }, 260, 260)).toBe('scale(1) translate(0px, 46.8px)');
  });
});

describe('gainMultiplier (composition time, ramps, overlapping segments multiply)', () => {
  const seg = [{ atMs: 10_000, durationMs: 3000, mul: 1.5 }];
  it('1 outside, mul inside, linear ramps of 300 ms before the start and after the end', () => {
    expect(gainMultiplier(undefined, 0)).toBe(1); expect(gainMultiplier([], 0)).toBe(1);
    expect(gainMultiplier(seg, 9000)).toBe(1); expect(gainMultiplier(seg, 9850)).toBe(1.25); expect(gainMultiplier(seg, 10_000)).toBe(1.5);
    expect(gainMultiplier(seg, 12_999)).toBe(1.5); expect(gainMultiplier(seg, 13_150)).toBe(1.25); expect(gainMultiplier(seg, 13_300)).toBe(1);
    expect(gainMultiplier([{ atMs: 0, durationMs: 1000, mul: 0.5, rampMs: 0 }], 0)).toBe(0.5);
    expect(gainMultiplier([{ atMs: 0, durationMs: 1000, mul: 2 }, { atMs: 500, durationMs: 1000, mul: 0.5 }], 700)).toBe(1);
  });
});

describe('caption helpers', () => {
  const kw = [{ words: ['SMR', 'reaktor'], colour: '#FFD43B' }, { words: ['AI'], colour: '#4DD4C4' }];
  it('captionKeywordColour matches normalised words, first group wins, undefined otherwise or on bad params', () => {
    expect(captionKeywordColour(' SMR,', kw)).toBe('#FFD43B'); expect(captionKeywordColour('Reaktor', kw)).toBe('#FFD43B'); expect(captionKeywordColour('ai', kw)).toBe('#4DD4C4');
    expect(captionKeywordColour('nuklir', kw)).toBeUndefined(); expect(captionKeywordColour('SMR', undefined)).toBeUndefined(); expect(captionKeywordColour('SMR', [{ words: 'SMR' }])).toBeUndefined();
  });
  it('captionChunk shows the ≤ N-word chunk holding the time', () => {
    const toks = Array.from({ length: 7 }, (_, i) => ({ text: ` w${i}`, fromMs: i * 100, toMs: i * 100 + 100 }));
    expect(captionChunk(toks, undefined, 0)).toHaveLength(7);
    expect(captionChunk(toks, 3, -50).map((t) => t.text)).toEqual([' w0', ' w1', ' w2']);
    expect(captionChunk(toks, 3, 350).map((t) => t.text)).toEqual([' w3', ' w4', ' w5']);
    expect(captionChunk(toks, 3, 999).map((t) => t.text)).toEqual([' w6']);
  });
});

describe('ExpertmotionTimeline renders the ADR-039 pieces (preview = render)', () => {
  const scene = (extra: OperationT[] = []): CompositionModelT => model([
    { op: 'op:theme.set', args: { paletteId: 'preset:palette.reels-navy', fontPairId: 'preset:fontpair.poppins-inter' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 6000, background: 'preset:background.solid' } },
    ...extra,
  ]);
  it('face bubble: circle mask (50 %), overflow hidden, 6 u yellow ring as box-shadow, muted <video> with the focus transform', () => {
    const m = scene([{ op: 'op:overlay.addVideo', args: { assetId: 'cam', atMs: 0, durationMs: 6000, trimBeforeMs: 8140, size: 260, shape: 'circle', ring: { colour: '#FFD43B', widthU: 6 }, focus: { x: 0.5, y: 0.32, zoom: 0.62 }, position: { x: 0, y: 810 }, motion: { presetId: 'preset:motion.none' } } }]);
    const host = render(m);
    const bubble = host.querySelector<HTMLElement>('[data-em-bubble="circle"]');
    expect(bubble).not.toBeNull();
    expect(bubble!.style.borderRadius).toBe('50%'); expect(bubble!.style.overflow).toBe('hidden');
    expect(bubble!.style.boxShadow).toBe('0 0 0 6px #FFD43B');                        // u = 1 at 1080 × 1920
    const box = host.querySelector<HTMLElement>('[data-em-video]')!;
    expect(box.style.width).toBe('260px'); expect(box.style.height).toBe('260px'); expect(box.style.left).toBe('540px'); expect(box.style.top).toBe('1770px');
    const video = bubble!.querySelector<HTMLVideoElement>('video');
    expect(video).not.toBeNull();
    expect(video!.muted).toBe(true);
    expect(video!.style.transform).toBe('scale(0.62) translate(0px, 83.2px)');
  });
  it('rect bubble: radius in u, no ring, no transform without focus', () => {
    const m = scene([{ op: 'op:overlay.addVideo', args: { assetId: 'cam', atMs: 0, durationMs: 3000, size: 400, radius: 32, motion: { presetId: 'preset:motion.none' } } }]);
    const bubble = render(m).querySelector<HTMLElement>('[data-em-bubble="rect"]')!;
    expect(bubble.style.borderRadius).toBe('32px'); expect(bubble.style.boxShadow).toBe('');
    expect(bubble.querySelector<HTMLVideoElement>('video')!.style.transform).toBe('');
  });
  it('clip punch-in: the media wrapper carries scale(from→to × pops) at the frame', () => {
    const m = model([{ op: 'op:clip.insert', args: { assetId: 'cam', durationMs: 6000, zoom: { from: 1.12, to: 1.2, pops: [{ atMs: 500, amount: 0.1 }] } } }]);
    const wrap = render(m, 15).querySelector<HTMLElement>('[data-em-transform="clip"]')!;
    expect(wrap).not.toBeNull();
    const expected = clipZoomScale(m.tracks.video[0]!.zoom, 15, 180, 30), css = Math.round(expected * 1000) / 1000;
    expect(expected).toBeGreaterThan(1.12);                                             // 500 ms pop still settling at frame 15
    expect(wrap.getAttribute('data-em-zoom')).toBe(String(expected));
    expect(wrap.style.transform).toBe(`translate(0px, 0px) rotate(0deg) scale(${css})`);
  });
  it('captions: keyword colours, yU block top, fontSizeU, Poppins family; a page without tokens renders nothing', () => {
    const pages = [
      { text: ' Reaktor SMR kecil', startMs: 0, durationMs: 2000, tokens: [{ text: ' Reaktor', fromMs: 0, toMs: 400 }, { text: ' SMR', fromMs: 400, toMs: 900 }, { text: ' kecil', fromMs: 900, toMs: 2000 }] },
      { text: '', startMs: 2000, durationMs: 1000, tokens: [] },
    ];
    const m = scene([
      { op: 'op:caption.setStyle', args: { presetId: 'preset:caption.karaoke', params: { keywords: [{ words: ['SMR'], colour: '#4DD4C4' }], yU: 1455, fontSizeU: 68, maxWordsPerPage: 3 } } },
      { op: 'op:caption.setPages', args: { pages } },
    ]);
    const host = render(m, 15);                                                         // 500 ms: "SMR" active, "Reaktor" spoken
    const cap = host.querySelector<HTMLElement>('[data-em-caption]')!;
    expect(cap).not.toBeNull();
    expect(cap.style.fontSize).toBe('68px'); expect(cap.style.fontFamily).toBe('"Poppins", Inter, sans-serif');
    expect(cap.parentElement!.style.paddingTop).toBe('1455px'); expect(cap.parentElement!.style.justifyContent).toBe('flex-start');
    const spans = [...cap.querySelectorAll<HTMLElement>('span')];
    expect(spans.map((s) => s.getAttribute('data-em-token'))).toEqual(['spoken', 'active', 'next']);
    expect(spans.map((s) => s.style.color)).toEqual(['rgb(255, 212, 59)', 'rgb(77, 212, 196)', 'rgb(244, 246, 251)']);   // accent (spoken), keyword cyan, text
    expect(render(m, 75).querySelector('[data-em-caption]')).toBeNull();               // 2.5 s: the empty page shows nothing
  });
  it('every infographic shape preset mounts from its catalogue defaults plus sample data', () => {
    const data: Record<string, Record<string, unknown>> = {
      'preset:shape.rows': { rows: [{ badge: 'A', title: 'Alpha', sub: 'first', right: '12', rightSub: 'unit', tone: 'positive' }, { title: 'Beta' }] },
      'preset:shape.day-strip': { bars: [{ label: 'siang', fromH: 6, toH: 18, icon: 'sun' }, { label: 'malam', fromH: 18, toH: 24 }], note: 'catatan' },
      'preset:shape.browser-card': { title: 'Judul', fromLabel: 'A', toLabel: 'B', caption: 'ket', inner: 'reactor-datacenter' },
      'preset:shape.typing-box': { text: 'halo dunia', sendAt: 300 },
      'preset:shape.bars-h': { bars: [{ label: 'x', value: 3, unit: 'GW' }, { label: 'y', value: 1.5, tone: 'negative' }] },
      'preset:shape.tag': { text: 'opini', tone: 'opinion' }, 'preset:shape.source-tag': { text: 'Sumber · 2026' }, 'preset:shape.icon': { icon: 'reactor' },
    };
    const marks: Record<string, string> = { 'preset:shape.icon': '[data-em-icon="reactor"]', 'preset:shape.rows': '[data-em-row="1"]', 'preset:shape.day-strip': '[data-em-day-strip]', 'preset:shape.browser-card': '[data-em-progress]', 'preset:shape.typing-box': '[data-em-typing-box][data-em-sent="true"]', 'preset:shape.tag': '[data-em-tag="opinion"]', 'preset:shape.source-tag': '[data-em-source-tag]', 'preset:shape.bars-h': '[data-em-bar="1"]' };
    for (const id of Object.keys(marks)) {
      const m = scene([{ op: 'op:shape.add', args: { presetId: id, atMs: 0, durationMs: 3000, size: 800, height: 400, params: data[id], motion: { presetId: 'preset:motion.none' } } }]);
      const host = render(m, 30);
      expect(host.querySelector(marks[id]!), id).not.toBeNull();
      act(() => root?.unmount()); root = null; document.body.innerHTML = '';
    }
    const iconEnum = (getPreset('preset:shape.icon')!.defaults as Record<string, unknown>)['icon'];
    expect(ICON_IDS).toContain(iconEnum);
    expect(ICON_IDS.length).toBe(20);
  });
  it('catalogue coverage stays complete and the new presets are P1 / data-only', () => {
    expect(missingImplementations().sort()).toEqual(Object.keys(NOT_IMPLEMENTED).sort());
    expect(listPresets({ category: 'shape' }).filter((p) => /^preset:shape\.(icon|rows|day-strip|browser-card|typing-box|tag|source-tag|bars-h)$/.test(p.id)).length).toBe(8);
    expect(getPreset('preset:fontpair.poppins-inter')?.data).toEqual({ heading: 'preset:font.poppins', body: 'preset:font.inter' });
    const t = tokensFor({ paletteId: 'preset:palette.reels-navy', fontPairId: 'preset:fontpair.poppins-inter', defaultEasingId: 'preset:easing.out-cubic', textDefaults: { fontSize: 64, weight: 700, colour: '#F4F6FB', align: 'center', opacity: 1 } });
    expect(t).toMatchObject({ bg: '#0B1526', bg2: '#121F38', accent: '#FFD43B', accent2: '#4DD4C4', muted: '#8A97B3', negative: '#FF5C5C', warn: '#FFA94D', headingFont: 'Poppins', bodyFont: 'Inter' });
    expect(toneColours('opinion', t)).toEqual({ fill: '#FFD43B', text: '#0B1526' });
    expect(typedChars('halo dunia', 250 + 500, true)).toBe(9); expect(typedChars('halo', 0, false)).toBe(4);
  });
});

describe('QA A16 "no cut-off text": infographic runs shrink to a floor, then wrap; panels grow; symbols fall back to Inter', () => {
  const scene = (extra: OperationT[]): CompositionModelT => model([
    { op: 'op:theme.set', args: { paletteId: 'preset:palette.reels-navy', fontPairId: 'preset:fontpair.poppins-inter' } },
    { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 6000, background: 'preset:background.solid' } },
    ...extra,
  ]);
  const shape = (presetId: string, size: number, height: number, params: Record<string, unknown>) => scene([{ op: 'op:shape.add', args: { presetId, atMs: 0, durationMs: 3000, size, height, params, motion: { presetId: 'preset:motion.none' } } }]);
  const txt = (e: Element | null) => (e?.textContent ?? '').replace(/\s+/g, ' ');   // explicit line breaks and glued spaces → one space
  const noEllipsis = (host: HTMLElement) => { expect([...host.querySelectorAll<HTMLElement>('*')].some((e) => e.style.textOverflow === 'ellipsis')).toBe(false); expect(host.textContent).not.toContain('…'); };
  it('fitRun: short text stays one line at the preferred size; long text shrinks to the floor, then wraps (never truncates)', () => {
    expect(fitRun('OPINI', 500, 30, 22, 2, 800, 'Poppins')).toMatchObject({ fontSize: 30, lines: ['OPINI'], overflow: false });
    const long = fitRun('IEA: listrik data center dunia naik lebih dari dua kali lipat sampai 2030', 600, 30, 22, 2, 800, 'Poppins');
    expect(long.fontSize).toBe(22); expect(long.lines.length).toBe(2); expect(long.lines.join(' ').replace(/\u00A0/g, ' ')).toBe('IEA: listrik data center dunia naik lebih dari dua kali lipat sampai 2030'); expect(long.overflow).toBe(false);
    const tooLong = fitRun('kata '.repeat(40).trim(), 300, 30, 22, 2, 800, 'Poppins');
    expect(tooLong.overflow).toBe(true); expect(tooLong.lines.join(' ').split(' ').length).toBe(40);   // still every word, no cut
    expect(TEXT_FLOORS_U.tag).toBe(22);
  });
  it('tag: the full upper-case text in ≥ 22 u, two lines when needed, pill grows (minHeight)', () => {
    const text = 'IEA: listrik data center dunia naik lebih dari dua kali lipat sampai 2030';
    const host = render(shape('preset:shape.tag', 679, 60, { text, tone: 'info' }), 30);
    const run = host.querySelector<HTMLElement>('[data-em-run="tag"]')!;
    expect(txt(run)).toBe(text.toUpperCase());
    expect(parseFloat(run.style.fontSize)).toBeGreaterThanOrEqual(22);
    expect(Number(run.getAttribute('data-em-lines'))).toBe(2);
    const pill = host.querySelector<HTMLElement>('[data-em-pill="tag"]')!;
    expect(pill.style.minHeight).toBe('60px'); expect(pill.style.height).toBe('');
    noEllipsis(host);
  });
  it('source-tag: up to 3 lines, may widen to 90 % of the frame, letter-spacing normal, nothing clipped', () => {
    const text = 'UNECE & IPCC via ANS (30 Nov 2021) · WNA 23 Okt 2026 · NNN 1 Okt 2026 · ilustrasi bar · dicek 30 Okt 2026';
    const host = render(shape('preset:shape.source-tag', 500, 94, { text }), 30);
    const run = host.querySelector<HTMLElement>('[data-em-run="source-tag"]')!;
    expect(txt(run)).toBe(text);
    expect(Number(run.getAttribute('data-em-lines'))).toBeLessThanOrEqual(3);
    expect(parseFloat(run.style.fontSize)).toBeGreaterThanOrEqual(22);
    expect(run.style.letterSpacing).toBe('');
    const pill = host.querySelector<HTMLElement>('[data-em-pill="source-tag"]')!;
    expect(parseFloat(pill.style.width)).toBeLessThanOrEqual(1080 * 0.9);
    noEllipsis(host);
  });
  it('rows: the title keeps ≥ 55 % of the row and is never cut; right / rightSub shrink or wrap', () => {
    const rows = [{ badge: 'A', title: 'Amazon · X-energy', sub: '± 320 MW', right: 'awal 2030-an', rightSub: 'fase 1', tone: 'warn' }];
    const host = render(shape('preset:shape.rows', 832, 140, { rows }), 30);
    expect(txt(host.querySelector('[data-em-run="row-title"]'))).toBe('Amazon · X-energy');
    expect(txt(host.querySelector('[data-em-run="row-right"]'))).toBe('awal 2030-an');
    const col = host.querySelector<HTMLElement>('[data-em-row-title]')!;
    const basis = parseFloat(col.style.flex.split(' ')[2]!);
    const row = host.querySelector<HTMLElement>('[data-em-row="0"]')!;
    const pad = parseFloat(row.style.paddingRight), badge = 140 * 0.62, inner = 832 - 2 * pad - badge - pad;
    expect(basis / inner).toBeGreaterThanOrEqual(0.55);
    expect(row.style.minHeight).toBe('140px');
    noEllipsis(host);
  });
  it('bars-h and day-strip labels keep every word (shrink to 24 u / 22 u, then wrap), rows grow', () => {
    const bars = render(shape('preset:shape.bars-h', 832, 336, { bars: [{ label: 'angin lepas pantai', value: 12, unit: 'g/kWh' }, { label: 'surya skala besar', value: 48 }] }), 30);
    expect([...bars.querySelectorAll<HTMLElement>('[data-em-run="bar-label"]')].map(txt)).toEqual(['angin lepas pantai', 'surya skala besar']);
    noEllipsis(bars);
    act(() => root?.unmount()); root = null; document.body.innerHTML = '';
    const day = render(shape('preset:shape.day-strip', 832, 320, { bars: [{ label: 'panel surya (tanpa baterai)', fromH: 6, toH: 18, icon: 'sun' }], note: 'cuaca & waktu' }), 30);
    const label = day.querySelector<HTMLElement>('[data-em-run="day-label"]')!;
    expect(txt(label)).toBe('panel surya (tanpa baterai)');
    expect(Number(label.getAttribute('data-em-lines'))).toBeLessThanOrEqual(2);
    expect(parseFloat(label.style.fontSize)).toBeGreaterThanOrEqual(22);
    noEllipsis(day);
  });
  it('browser-card: the caption is rendered whole and the card grows (minHeight, no fixed height)', () => {
    const host = render(shape('preset:shape.browser-card', 832, 560, { urlText: 'youtube.com · EBS', title: 'SMR di dekat data center AI', fromLabel: '03:40', toLabel: '03:48', progress: 1, caption: 'topik video: SMR di dekat data center AI', inner: 'reactor-datacenter' }), 30);
    const card = host.querySelector<HTMLElement>('[data-em-browser-card]')!;
    expect(card.style.minHeight).toBe('560px'); expect(card.style.height).toBe('');
    expect(txt(host.querySelector('[data-em-run="card-caption"]'))).toBe('topik video: SMR di dekat data center AI');
    expect(txt(host.querySelector('[data-em-run="card-title"]'))).toBe('SMR di dekat data center AI');
    noEllipsis(host);
  });
  it('"≤ 300 MWe" in Poppins: the text run uses the stack "Poppins", Inter, sans-serif and the ≤ sits in an Inter span', () => {
    expect(fontStack('Poppins')).toBe('"Poppins", Inter, sans-serif'); expect(fontStack('Inter')).toBe('"Inter", sans-serif');
    expect(symbolRuns('abc')).toBe('abc');
    const m = scene([{ op: 'op:text.add', args: { text: '≤ 300 MWe', variant: 'preset:text.title', atMs: 0, durationMs: 3000, styleOverrides: { fontFamily: 'Poppins' }, motion: { presetId: 'preset:motion.none' } } }]);
    const host = render(m, 30);
    const sym = host.querySelector<HTMLElement>('[data-em-symbol]')!;
    expect(sym).not.toBeNull(); expect(sym.textContent).toBe('≤'); expect(sym.style.fontFamily).toBe('Inter, sans-serif');
    expect(sym.closest<HTMLElement>('[data-em-text]')!.querySelector('span')!.style.fontFamily).toBe('"Poppins", Inter, sans-serif');
    expect(host.querySelector('[data-em-text]')!.textContent).toBe('≤ 300 MWe');
  });
});
