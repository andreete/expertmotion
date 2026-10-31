// @vitest-environment jsdom
// ADR-041 ("viral explainer" Reels from internet assets): pure helpers (blurred-image source choice, emphasis layout, x-mark path,
// pulse, boxed word css, image look css) and the real ExpertmotionTimeline (Remotion Thumbnail in jsdom): the blurred-image and
// paper backgrounds, the emphasis caption page, the boxed headline, the x-mark / highlight-box annotations and the picture look
// (radius, shadow, border) of image overlays. Style assertions = what the Player and the export both draw.
import { describe, expect, it, afterEach, beforeAll, afterAll } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Thumbnail } from '@remotion/player';
import { applyOperations, createEmptyModel, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { getPreset } from '@expertmotion/catalogue';
import { ExpertmotionTimeline, EMPTY_INPUT, blurredImageAssetId, emphasisLayout, emphasisWordWidth, EMPHASIS_BIG_RATIO, EMPHASIS_MIN_SCALE, xMarkPath, pulseScale, boxedWordStyle, imageLookStyle, IMAGE_SHADOW_DEFAULT, paperBaseColour, PAPER_SPECKLES, PAPER_FOLDS, missingImplementations, NOT_IMPLEMENTED, type EngineInputProps, type EmphasisWord } from '../src/index.js';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;
let root: Root | null = null;
const realFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = (() => new Promise<Response>(() => undefined)) as typeof fetch; });
afterAll(() => { globalThis.fetch = realFetch; });
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ''; });

const ASSETS = [
  { id: 'pic', kind: 'image' as const, status: 'ready' as const, width: 1080, height: 1350 },
  { id: 'pic2', kind: 'image' as const, status: 'ready' as const, width: 1200, height: 800 },
];
const URLS = {
  pic: { kind: 'image' as const, playable: 'http://127.0.0.1:4199/media/x/pic/playable', proxy: 'http://127.0.0.1:4199/media/x/pic/proxy', width: 1080, height: 1350 },
  pic2: { kind: 'image' as const, playable: 'http://127.0.0.1:4199/media/x/pic2/playable', width: 1200, height: 800 },
};
function model(ops: OperationT[]): CompositionModelT {
  let n = 0;
  const r = applyOperations(createEmptyModel('p', { autoRatio: false, ratio: '9:16' }), ops, { assets: ASSETS, tier: 'T1', newId: () => `e${++n}` });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
function render(m: CompositionModelT, frame = 15, quality: 'draft' | 'full' = 'full'): HTMLElement {
  const host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  const props: EngineInputProps = { ...EMPTY_INPUT, model: m, assets: URLS, quality };
  act(() => root!.render(<Thumbnail component={ExpertmotionTimeline} inputProps={props} compositionWidth={1080} compositionHeight={1920} durationInFrames={360} fps={30} frameToDisplay={frame} />));
  return host;
}
const theme: OperationT = { op: 'op:theme.set', args: { paletteId: 'preset:palette.high-contrast', fontPairId: 'preset:fontpair.poppins-inter' } };   // accent #FFE600, bg #000000
const scene = (background: string, params: Record<string, unknown>, extra: OperationT[] = []): CompositionModelT => model([theme, { op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 6000, background, backgroundParams: params } }, ...extra]);
const picture = (assetId: string, atMs: number, extra: Record<string, unknown> = {}): OperationT => ({ op: 'op:overlay.addImage', args: { assetId, atMs, durationMs: 3000, size: 800, motion: { presetId: 'preset:motion.none' }, ...extra } });

describe('blurredImageAssetId (pure)', () => {
  const bg = (params: Record<string, unknown> = {}) => ({ presetId: 'preset:background.blurred-image', params });
  const ov = (id: string, assetId: string, atMs: number, durationMs = 3000) => ({ kind: 'image' as const, id, assetId, timing: { atMs, durationMs }, layer: 0, position: { x: 0, y: 0 }, size: { w: 800, h: 1000 }, objectFit: 'contain' as const, opacity: 1, motion: null, effects: [] });
  it('params.assetId wins; else the first image overlay on screen inside the window; undefined for other backgrounds or no picture', () => {
    expect(blurredImageAssetId(bg({ assetId: 'pic2' }), [ov('a', 'pic', 0)])).toBe('pic2');
    expect(blurredImageAssetId(bg(), [ov('b', 'pic2', 7000), ov('a', 'pic', 6500)], { fromMs: 6000, toMs: 12_000 })).toBe('pic');
    expect(blurredImageAssetId(bg(), [ov('a', 'pic', 0)], { fromMs: 6000, toMs: 12_000 })).toBeUndefined();          // ended before the scene
    expect(blurredImageAssetId(bg(), [ov('a', 'pic', 5000, 2000)], { fromMs: 6000, toMs: 12_000 })).toBe('pic');       // overlaps the start
    expect(blurredImageAssetId(bg(), [ov('a', 'pic', 0)])).toBe('pic');                                                  // project background: whole composition
    expect(blurredImageAssetId({ presetId: 'preset:background.solid', params: {} }, [ov('a', 'pic', 0)])).toBeUndefined();
    expect(blurredImageAssetId(bg(), [])).toBeUndefined();
  });
});

describe('ExpertmotionTimeline draws the ADR-041 backgrounds', () => {
  it('blurred-image: the scene picture cover-fitted, scaled by zoom, CSS-blurred blurPx × u, under a black dim layer; proxy in draft', () => {
    const m = scene('preset:background.blurred-image', { blurPx: 40, dim: 0.5, zoom: 1.3 }, [picture('pic', 500)]);
    const host = render(m, 30);
    const bg = host.querySelector<HTMLElement>('[data-em-bg="blurred-image"]')!;
    expect(bg).not.toBeNull(); expect(bg.style.overflow).toBe('hidden'); expect(bg.style.backgroundColor).toBe('rgb(0, 0, 0)');
    const img = bg.querySelector<HTMLImageElement>('img[data-em-bg-image]')!;
    expect(img.getAttribute('src')).toBe(URLS.pic.playable);
    expect(img.style.objectFit).toBe('cover'); expect(img.style.scale).toBe('1.3'); expect(img.style.filter).toBe('blur(40px)');   // u = 1 at 1080 × 1920
    expect(bg.querySelector<HTMLElement>('[data-em-bg-dim]')!.style.backgroundColor).toBe('rgba(0, 0, 0, 0.5)');
    expect(render(m, 30, 'draft').querySelector<HTMLImageElement>('img[data-em-bg-image]')!.getAttribute('src')).toBe(URLS.pic.proxy);
  });
  it('blurred-image: an explicit assetId wins over the overlay; a scene without a picture stays a solid colour (no <img>)', () => {
    const host = render(scene('preset:background.blurred-image', { assetId: 'pic2' }, [picture('pic', 0)]), 10);
    expect(host.querySelector<HTMLImageElement>('img[data-em-bg-image]')!.getAttribute('src')).toBe(URLS.pic2.playable);
    const empty = render(scene('preset:background.blurred-image', { colourA: '#112233' }), 10);
    expect(empty.querySelector('img[data-em-bg-image]')).toBeNull();
    expect(empty.querySelector<HTMLElement>('[data-em-bg="blurred-image"]')!.style.backgroundColor).toBe('rgb(17, 34, 51)');
  });
  it('blurred-image on the project background (media-less composition) takes the first image overlay of the composition', () => {
    const m = model([theme, { op: 'op:background.set', target: { kind: 'project' }, args: { presetId: 'preset:background.blurred-image', params: {} } }, picture('pic2', 0)]);
    expect(render(m, 5).querySelector<HTMLImageElement>('img[data-em-bg-image]')!.getAttribute('src')).toBe(URLS.pic2.playable);
  });
  it('paper: light warm base, fold gradients, one SVG of noise speckles at grain opacity; static; no gpu flag; implemented', () => {
    const host = render(scene('preset:background.paper', { grain: 0.4, warm: 1 }), 20);
    const bg = host.querySelector<HTMLElement>('[data-em-bg="paper"]')!;
    expect(bg).not.toBeNull();
    // jsdom's cssstyle drops gradient images, so the folds are checked as the pure list + the fold count the element declares
    expect(PAPER_FOLDS.filter((f) => f.startsWith('linear-gradient(')).length).toBe(3); expect(PAPER_FOLDS.some((f) => f.startsWith('radial-gradient('))).toBe(true);
    expect(bg.getAttribute('data-em-paper-folds')).toBe(String(PAPER_FOLDS.length));
    expect(bg.style.backgroundColor).toBe('color-mix(in srgb, rgb(244, 242, 238) 0%, rgb(235, 220, 192) 100%)');   // warm 1 = the cream end
    expect(paperBaseColour(1)).toBe('color-mix(in srgb, #F4F2EE 0%, #EBDCC0 100%)');
    const svg = bg.querySelector<SVGElement>('svg[data-em-paper-grain]')!;
    expect(svg.style.opacity).toBe('0.4');
    expect(svg.querySelectorAll('circle').length).toBe(PAPER_SPECKLES);
    const first = svg.querySelector('circle')!;
    const again = render(scene('preset:background.paper', { grain: 0.4, warm: 1 }), 120).querySelector('svg[data-em-paper-grain] circle')!;
    expect(again.getAttribute('cx')).toBe(first.getAttribute('cx'));                       // seeded noise: the same grain at every frame
    expect(paperBaseColour(0.5, '#ABCDEF')).toBe('#ABCDEF');
    expect(getPreset('preset:background.paper')!.flags).toEqual([]);
    expect(NOT_IMPLEMENTED).not.toHaveProperty('preset:background.paper');
    expect(missingImplementations().sort()).toEqual(Object.keys(NOT_IMPLEMENTED).sort());
  });
});

describe('preset:caption.emphasis', () => {
  const W = (text: string, big = false): EmphasisWord => ({ text, big, active: false, spoken: false });
  it('emphasisLayout: big words 92/34 × the small size; shrinks both until the widest line fits and the block ≤ half the frame; floor 45 %', () => {
    const fit = emphasisLayout([W('LO'), W('Bayangin', true), W('NIH')], 980, 1920, 34, 'Inter', 'Playfair Display');
    expect(fit.scale).toBe(1); expect(fit.smallPx).toBe(34); expect(fit.bigPx).toBeCloseTo(34 * EMPHASIS_BIG_RATIO, 6);
    expect(fit.lines.map((l) => l.map((w) => w.text))).toEqual([['LO', 'Bayangin', 'NIH']]);
    const wide = emphasisLayout([W('TAPI'), W('PARA'), W('Pembangunan-Pembangunan', true)], 700, 1920, 34, 'Inter', 'Playfair Display');
    expect(wide.lines.length).toBe(2);                                                     // the long serif word takes its own line …
    expect(wide.scale).toBeLessThan(1); expect(wide.scale).toBeGreaterThanOrEqual(EMPHASIS_MIN_SCALE);
    const widest = Math.max(...wide.lines.map((l) => l.reduce((s, w, i) => s + (i ? 0.3 * wide.smallPx : 0) + emphasisWordWidth(w, wide.smallPx, wide.bigPx, 'Inter', 'Playfair Display', 600), 0)));
    expect(widest).toBeLessThanOrEqual(700);                                               // … and still fits the room after shrinking
    const tall = emphasisLayout(Array.from({ length: 14 }, (_, i) => W(`Kata${i}`, true)), 600, 1920, 34, 'Inter', 'Playfair Display');
    expect(tall.heightPx).toBeLessThanOrEqual(1920 * 0.5 + 1e-6);
    const impossible = emphasisLayout([W('Supercalifragilisticexpialidocious-Supercalifragilisticexpialidocious', true)], 300, 1920, 34, 'Inter', 'Playfair Display');
    expect(impossible.scale).toBe(EMPHASIS_MIN_SCALE); expect(impossible.lines[0]![0]!.text).toContain('Supercali');   // never cut, even when it cannot fit
  });
  it('renders centred lines: small words upper-case in the body font with letter-spacing, keyword words big italic Playfair in the accent; page rises + fades in', () => {
    const pages = [{ text: ' Lo bayangin nih', startMs: 0, durationMs: 2000, tokens: [{ text: ' Lo', fromMs: 0, toMs: 300 }, { text: ' bayangin', fromMs: 300, toMs: 900 }, { text: ' nih', fromMs: 900, toMs: 2000 }] }];
    const m = scene('preset:background.solid', {}, [
      { op: 'op:caption.setStyle', args: { presetId: 'preset:caption.emphasis', params: { keywords: [{ words: ['bayangin'], colour: '#FFD43B' }] } } },
      { op: 'op:caption.setPages', args: { pages } },
    ]);
    const host = render(m, 20);
    const cap = host.querySelector<HTMLElement>('[data-em-caption]')!;
    expect(cap).not.toBeNull();
    expect(cap.parentElement!.style.justifyContent).toBe('center');                       // centred (position default is ignored)
    expect(cap.style.opacity).toBe('1'); expect(cap.style.translate).toBe('0px 0px');     // risen and faded in after 0.3 s
    const spans = [...cap.querySelectorAll<HTMLElement>('span')];
    expect(spans.map((s) => s.getAttribute('data-em-emphasis'))).toEqual(['small', 'big', 'small']);
    expect(spans.map((s) => s.textContent)).toEqual(['LO', 'bayangin', 'NIH']);
    expect(spans[0]!.style.fontFamily).toBe('"Inter", sans-serif'); expect(spans[0]!.style.fontSize).toBe('34px'); expect(spans[0]!.style.letterSpacing).toBe('0.08em'); expect(spans[0]!.style.textTransform).toBe('uppercase');
    expect(spans[1]!.style.fontFamily).toBe('"Playfair Display", Georgia, "Times New Roman", serif'); expect(spans[1]!.style.fontStyle).toBe('italic'); expect(spans[1]!.style.fontSize).toBe('92px');
    expect(spans[1]!.style.color).toBe('rgb(255, 230, 0)');                               // emphasisColour default = theme accent (high-contrast #FFE600)
    expect(spans.map((s) => s.getAttribute('data-em-token'))).toEqual(['spoken', 'active', 'next']);   // 667 ms: "bayangin" active
    const early = render(m, 1).querySelector<HTMLElement>('[data-em-caption]')!;
    expect(parseFloat(early.style.opacity)).toBeLessThan(0.5); expect(parseFloat(early.style.translate.split(' ')[1]!)).toBeGreaterThan(10);   // rising in
  });
  it('emphasisColour / emphasisFont / position top / fontSizeU params are honoured', () => {
    const pages = [{ text: ' Yang kelas', startMs: 0, durationMs: 2000, tokens: [{ text: ' Yang', fromMs: 0, toMs: 500 }, { text: ' kelas', fromMs: 500, toMs: 2000 }] }];
    const m = scene('preset:background.solid', {}, [
      { op: 'op:caption.setStyle', args: { presetId: 'preset:caption.emphasis', params: { keywords: [{ words: ['kelas'], colour: '#FFD43B' }], emphasisColour: '#4DD4C4', emphasisFont: 'Georgia', position: 'top', fontSizeU: 40 } } },
      { op: 'op:caption.setPages', args: { pages } },
    ]);
    const host = render(m, 20);
    const cap = host.querySelector<HTMLElement>('[data-em-caption]')!;
    expect(cap.parentElement!.style.justifyContent).toBe('flex-start');
    const big = host.querySelector<HTMLElement>('[data-em-emphasis="big"]')!;
    expect(big.style.color).toBe('rgb(77, 212, 196)'); expect(big.style.fontFamily).toContain('"Georgia"'); expect(parseFloat(big.style.fontSize)).toBeCloseTo(40 * EMPHASIS_BIG_RATIO, 1);
    expect(host.querySelector<HTMLElement>('[data-em-emphasis="small"]')!.style.fontSize).toBe('40px');
  });
});

describe('preset:texteffect.boxed', () => {
  it('boxedWordStyle: accent box, bg text, padU / radiusU in px, spring pop per word', () => {
    const css = boxedWordStyle({ padU: 14, radiusU: 8 }, 1, { accent: '#FFE600', bg: '#000000' }, 60, 30, 0, 0);
    expect(css).toMatchObject({ display: 'inline-block', background: '#FFE600', color: '#000000', padding: '4.2px 14px', borderRadius: '8px', scale: '1', opacity: 1 });
    expect(boxedWordStyle({ boxColour: '#E53935', textColour: '#FFFFFF' }, 2, { accent: '#FFE600', bg: '#000000' }, 60, 30, 0, 0)).toMatchObject({ background: '#E53935', color: '#FFFFFF', padding: '8.4px 28px', borderRadius: '16px' });
    const early = boxedWordStyle({}, 1, { accent: '#FFE600', bg: '#000000' }, 2, 30, 1, 0);   // the second box has not started (0.12 s stagger)
    expect(early.opacity).toBe(0); expect(parseFloat(String(early.scale))).toBe(0);
  });
  it('the listed words of a title sit on solid boxes; the other words stay plain', () => {
    const m = scene('preset:background.solid', {}, [{ op: 'op:text.add', args: { text: 'NETIZEN BOIKOT! BRAND & ACARA', variant: 'preset:text.title', atMs: 0, durationMs: 4000, effect: { presetId: 'preset:texteffect.boxed', params: { words: ['BOIKOT'] } }, motion: { presetId: 'preset:motion.none' } } }]);
    const host = render(m, 60);
    const boxed = [...host.querySelectorAll<HTMLElement>('[data-em-boxed]')];
    expect(boxed.map((b) => b.textContent)).toEqual(['BOIKOT!']);
    expect(boxed[0]!.style.background).toBe('rgb(255, 230, 0)'); expect(boxed[0]!.style.color).toBe('rgb(0, 0, 0)'); expect(boxed[0]!.style.borderRadius).toBe('8px'); expect(boxed[0]!.style.display).toBe('inline-block');
    expect(host.querySelector<HTMLElement>('[data-em-text]')!.textContent!.replace(/\s+/g, ' ')).toBe('NETIZEN BOIKOT! BRAND & ACARA');   // nothing cut (explicit line breaks)
  });
});

describe('ADR-041 annotation shapes', () => {
  it('xMarkPath: both diagonals in one path, inset by half the stroke; pulseScale breathes 1 → 1.04 → 1 over 2 s', () => {
    expect(xMarkPath(100, 60, 10)).toEqual({ path: 'M 5 5 L 95 55 M 95 5 L 5 55', width: 100, height: 60 });
    expect(pulseScale(0, 30, true)).toBe(1); expect(pulseScale(30, 30, true)).toBe(1.04); expect(pulseScale(60, 30, true)).toBe(1); expect(pulseScale(45, 30, false)).toBe(1);
  });
  it('x-mark: stroked path in the stroke colour, strokeU × u wide, no fill; highlight-box: stroke-only rounded rect that pulses', () => {
    const m = scene('preset:background.solid', {}, [
      { op: 'op:shape.add', args: { presetId: 'preset:shape.x-mark', atMs: 0, durationMs: 3000, size: 400, height: 300, fill: '#E53935', params: { strokeU: 18 }, motion: { presetId: 'preset:motion.none' } } },
      { op: 'op:shape.add', args: { presetId: 'preset:shape.highlight-box', atMs: 0, durationMs: 3000, size: 500, height: 200, fill: '#FFFFFF', stroke: '#E53935', params: { strokeU: 8, radiusU: 12, pulse: true }, motion: { presetId: 'preset:motion.none' } } },
    ]);
    const host = render(m, 30);
    const x = host.querySelector<HTMLElement>('[data-em-x-mark] path')!;
    expect(x).not.toBeNull();
    expect(x.getAttribute('d')).toBe('M 9 9 L 391 291 M 391 9 L 9 291'); expect(x.getAttribute('stroke')).toBe('#E53935'); expect(x.getAttribute('stroke-width')).toBe('18'); expect(x.getAttribute('fill')).toBe('none');
    const hb = host.querySelector<HTMLElement>('[data-em-highlight-box]')!;
    expect(hb.getAttribute('data-em-pulse')).toBe('1.04'); expect(hb.style.scale).toBe('1.04');            // frame 30 of a 2 s period = the peak
    const p = hb.querySelector('path')!;
    expect(p.getAttribute('fill')).toBe('none'); expect(p.getAttribute('stroke')).toBe('#E53935'); expect(p.getAttribute('stroke-width')).toBe('8'); expect(p.getAttribute('stroke-linecap')).toBe('butt');
  });
  it('x-mark draws on with preset:motion.draw-on (dash offset at the start of the motion)', () => {
    const m = scene('preset:background.solid', {}, [{ op: 'op:shape.add', args: { presetId: 'preset:shape.x-mark', atMs: 0, durationMs: 3000, size: 300, fill: '#E53935', motion: { presetId: 'preset:motion.draw-on', durationMs: 1000 } } }]);
    const p = render(m, 3).querySelector<HTMLElement>('[data-em-x-mark] path')!;
    expect(p.getAttribute('stroke-dasharray')).not.toBeNull(); expect(Number(p.getAttribute('stroke-dashoffset'))).toBeGreaterThan(0);
  });
});

describe('image overlay look (radius, shadow, border)', () => {
  it('imageLookStyle (pure): radius → rounded + clipped; shadow default / custom; border inside the box; empty when plain', () => {
    expect(imageLookStyle({}, 1)).toEqual({});
    expect(imageLookStyle({ radius: 24 }, 0.5)).toEqual({ borderRadius: '12px', overflow: 'hidden' });
    expect(imageLookStyle({ shadow: true }, 1)).toEqual({ boxShadow: `0 ${IMAGE_SHADOW_DEFAULT.blurU / 3}px ${IMAGE_SHADOW_DEFAULT.blurU}px rgba(0,0,0,${IMAGE_SHADOW_DEFAULT.opacity})` });
    expect(imageLookStyle({ shadow: { blurU: 30, opacity: 0.6 }, border: { colour: '#FFFFFF', widthU: 6 } }, 2)).toEqual({ boxShadow: '0 20px 60px rgba(0,0,0,0.6)', border: '12px solid #FFFFFF', boxSizing: 'border-box', overflow: 'hidden' });
  });
  it('the timeline draws the look on a wrapper around the <img> (the positioned box keeps its size and transform)', () => {
    const m = scene('preset:background.blurred-image', {}, [picture('pic', 0, { radius: 24, shadow: true, border: { colour: '#FFFFFF', widthU: 6 }, rotation: -6 })]);
    const host = render(m, 30);
    const box = host.querySelector<HTMLElement>('[data-em-image]')!;
    expect(box).not.toBeNull(); expect(box.style.width).toBe('800px'); expect(box.style.height).toBe('1000px'); expect(box.style.transform).toContain('rotate(354deg)');   // rotation stored normalised
    const img = box.querySelector<HTMLImageElement>('img')!;
    const look = img.parentElement!;
    expect(look.style.borderRadius).toBe('24px'); expect(look.style.overflow).toBe('hidden'); expect(look.style.boxShadow).toBe('0 8px 24px rgba(0,0,0,0.45)'); expect(look.style.border).toBe('6px solid rgb(255, 255, 255)'); expect(look.style.boxSizing).toBe('border-box');
    expect(img.getAttribute('src')).toBe(URLS.pic.playable); expect(img.style.objectFit).toBe('contain');
    const plain = render(scene('preset:background.solid', {}, [picture('pic2', 0)]), 30).querySelector<HTMLImageElement>('[data-em-image] img')!.parentElement!;
    expect(plain.style.borderRadius).toBe(''); expect(plain.style.boxShadow).toBe(''); expect(plain.style.border).toBe('');
  });
});
