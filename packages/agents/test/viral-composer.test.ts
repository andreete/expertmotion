// ADR-041 (viral explainer Reels from internet assets): the `image` role (pictures on their blurred copy / paper, rounded + shadow,
// tilted stacks, arrows / boxes / X marks / rings / labels inside the picture, chips, caption, source tag), footage.grade dark-grain,
// the watermark, mood viral (boxed keywords, caption look, sfx), the normaliser's tolerance, the talking-head cutaways and the
// web.images / web.screenshot tools. Fixtures: viral-spec.json (Sample 1) and satu-persen-spec.json (Sampel 4).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, createEmptyModel, frameInUnits, qualityCheck, validate, type AssetFacts, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { annotationMark, BRAINSTORM_TOOL_INPUTS, chipColours, composeScenes, EDITOR_TOOL_NAMES, gradeEffects, normalizeVideoSpec, pictureBoxes, PROMPT_SET_VERSION, runTool, sourcesOfToolCalls, TOOL_DEFINITIONS, unionBox, VideoSpec, WEB_TOOL_NAMES,
  type AnalysisCut, type ComposeOk, type FootageAnalysisLike, type TimedWord, type VideoSpecT } from '../src/index.js';
import { BRAINSTORM_SYSTEM, EDITOR_SYSTEM } from '../src/prompts.generated.js';

const fixture = (name: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as VideoSpecT;
const VIRAL = fixture('viral-spec.json'), SATU = fixture('satu-persen-spec.json');
const SFX = { whoosh: 'SFX-whoosh', pop: 'SFX-pop', click: 'SFX-click', tick: 'SFX-tick', ding: 'SFX-ding', rise: 'SFX-rise' } as const;
const ASSETS: AssetFacts[] = [
  { id: 'IMG-poster', kind: 'image', status: 'ready', name: 'poster.jpg', width: 1080, height: 1350 },
  { id: 'IMG-post', kind: 'image', status: 'ready', name: 'Tangkapan layar · instagram.com', width: 1080, height: 1920 },
  { id: 'IMG-news', kind: 'image', status: 'ready', name: 'kompas-card.jpg', width: 1200, height: 630 },
  { id: 'IMG-photo', kind: 'image', status: 'ready', name: 'kompas-foto.jpg', width: 1600, height: 1067 },
  { id: 'IMG-comment', kind: 'image', status: 'ready', name: 'komentar.png', width: 1080, height: 1400 },
  { id: 'LOGO', kind: 'image', status: 'ready', name: 'logo.png', width: 600, height: 200 },
  { id: 'CLIP-crowd', kind: 'video', status: 'ready', name: 'pexels-crowd.mp4', durationMs: 12_000, width: 1080, height: 1920, hasAudio: false },
  { id: 'CLIP-factory', kind: 'video', status: 'ready', name: 'pexels-factory.mp4', durationMs: 15_000, width: 1920, height: 1080, hasAudio: false },
  { id: 'CLIP-port', kind: 'video', status: 'ready', name: 'pexels-port.mp4', durationMs: 20_000, width: 1920, height: 1080, hasAudio: false },
  ...Object.entries(SFX).map(([k, id]): AssetFacts => ({ id, kind: 'audio', status: 'ready', name: `SFX · ${k}`, durationMs: 300, hasAudio: true })),
];
let n = 0; const newId = () => `v${++n}`;
const empty = () => createEmptyModel('p', { autoRatio: false, ratio: '9:16', fps: 30, resolution: '1080p' });
const args = (o: OperationT) => o.args as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- test reads
const f = frameInUnits('9:16');
function composed(spec: VideoSpecT, o: { tier?: 'T0' | 'T1'; sfx?: boolean; assets?: AssetFacts[] } = {}): { r: ComposeOk; m: CompositionModelT } {
  const model = empty(), assets = o.assets ?? ASSETS;
  const r = composeScenes(spec, { model, assets, tier: o.tier ?? 'T1', ...(o.sfx === false ? {} : { sfxAssets: SFX }) });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets, tier: o.tier ?? 'T1', newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues.slice(0, 5)));
  return { r, m: a.value.model };
}
/** The ops of scene i: those whose atMs falls inside the scene's window (overlay / text / shape adds). */
const sceneOps = (r: ComposeOk, i: number, op: string) => { const s = r.scenes[i]!; return r.ops.filter((o) => o.op === op && typeof args(o)['atMs'] === 'number' && args(o)['atMs'] >= s.startMs && args(o)['atMs'] < s.startMs + s.durationMs); };
const boxOf = (o: OperationT, w: number, h: number) => { const p = args(o)['position'] as { x: number; y: number }; return { x0: f.w / 2 + p.x - w / 2, y0: f.h / 2 + p.y - h / 2, x1: f.w / 2 + p.x + w / 2, y1: f.h / 2 + p.y + h / 2 }; };
const inside = (a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }, tol = 2) => a.x0 >= b.x0 - tol && a.y0 >= b.y0 - tol && a.x1 <= b.x1 + tol && a.y1 <= b.y1 + tol;

describe('golden GS-24 "berita viral dari internet" (viral-spec.json, Sample 1 look)', () => {
  const { r, m } = composed(VIRAL);
  it('is a valid VideoSpec: 7 scenes, 4 of them image scenes; the model applies and validates', () => {
    expect(VideoSpec.safeParse(VIRAL).success).toBe(true);
    expect(r.scenes.map((s) => s.role)).toEqual(['hook', 'image', 'image', 'image', 'image', 'stat', 'cta-handle']);
    expect(m.tracks.video).toHaveLength(7);
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    expect(r.risks.find((x) => x.code === 'compose-invalid')).toBeUndefined();
  });
  it('viral look: high-contrast palette + Poppins/Inter font pair, near-black background, yellow boxed keywords on the hook, sfx whoosh per scene', () => {
    const theme = r.ops.find((o) => o.op === 'op:theme.set');
    expect(args(theme!)['paletteId']).toBe('preset:palette.high-contrast');
    expect(args(theme!)['fontPairId']).toBe('preset:fontpair.poppins-inter');
    expect(args(r.ops.find((o) => o.op === 'op:background.set')!)['params']).toEqual({ colourA: '#0E0E10' });
    const hook = sceneOps(r, 0, 'op:text.add').find((o) => args(o)['text'] === 'BOIKOT! Brand dan acara dibatalkan')!;
    expect(args(hook)['effect']).toEqual({ presetId: 'preset:texteffect.boxed', params: { words: ['BOIKOT!'], boxColour: '#FFD400', textColour: '#111111', padU: 14, radiusU: 8 } });
    expect(args(hook)['styleOverrides']['fontFamily']).toBe('Poppins');
    const whoosh = r.ops.filter((o) => o.op === 'op:audio.addLayer' && args(o)['role'] === 'sfx' && args(o)['assetId'] === 'SFX-whoosh');
    expect(whoosh.map((o) => args(o)['atMs'])).toEqual(r.scenes.map((s) => s.startMs));
    expect(r.ops.filter((o) => o.op === 'op:audio.addLayer' && args(o)['assetId'] === 'SFX-pop').length).toBeGreaterThanOrEqual(5);      // one pop per annotation
  });
  it('image scene backgrounds: blurred copy of images[0] by default, paper when asked', () => {
    const adds = r.ops.filter((o) => o.op === 'op:scene.add');
    expect(args(adds[1]!)['background']).toBe('preset:background.blurred-image');
    expect(args(adds[1]!)['backgroundParams']).toEqual({ assetId: 'IMG-poster', blurPx: 48, dim: 0.45, zoom: 1.25 });
    expect(args(adds[2]!)['backgroundParams']['assetId']).toBe('IMG-post');
    expect(args(adds[3]!)['backgroundParams']['assetId']).toBe('IMG-news');
    expect(args(adds[4]!)['background']).toBe('preset:background.paper');
    expect(args(adds[4]!)['backgroundParams']).toEqual({ grain: 0.35, warm: 0.5 });
    expect(args(adds[0]!)['background']).toBe('preset:background.solid');
  });
  it('pictures: one op:overlay.addImage per picture with radius 24 u (phone 40), shadow, contain, a zoom drift; stacks tilted −6° / +5°; all inside the safe area', () => {
    const single = sceneOps(r, 1, 'op:overlay.addImage'), phone = sceneOps(r, 2, 'op:overlay.addImage'), stack = sceneOps(r, 3, 'op:overlay.addImage'), pair = sceneOps(r, 4, 'op:overlay.addImage');
    expect(single).toHaveLength(1); expect(phone).toHaveLength(1); expect(stack).toHaveLength(2); expect(pair).toHaveLength(2);
    for (const o of [...single, ...phone, ...stack, ...pair]) { expect(args(o)['shadow']).toBe(true); expect(args(o)['objectFit']).toBe('contain'); }
    expect(args(single[0]!)['radius']).toBe(24); expect(args(phone[0]!)['radius']).toBe(40);
    expect(args(single[0]!)['motion']['presetId']).toBe('preset:motion.zoom-drift');
    expect(args(single[0]!)['motion']['params']['toScale']).toBe(1.08);
    expect(stack.map((o) => args(o)['rotation'])).toEqual([-6, 5]);
    expect(args(single[0]!)['rotation']).toBeUndefined();
    // single: 86 % of the content width; phone: 46 % of the frame width; side-by-side: two 45 % columns
    const W = f.w - r.safeArea.left - r.safeArea.right;
    expect(args(single[0]!)['size']).toBe(Math.round(W * 0.86));
    expect(args(phone[0]!)['size']).toBe(Math.round(f.w * 0.46));
    expect(pair.map((o) => args(o)['size'])).toEqual([Math.round(W * 0.45), Math.round(W * 0.45)]);
    const safeBox = { x0: r.safeArea.left, y0: r.safeArea.top, x1: f.w - r.safeArea.right, y1: f.h - r.safeArea.bottom };
    for (const el of r.elements.filter((e) => e.kind === 'image' && e.scene >= 0)) expect(inside(el.box, safeBox), el.key).toBe(true);
  });
  it('annotations: red highlight-box / x-mark / arrow / ring / label pill, at their anchors, inside the picture box; the arrow comes from the nearest free side', () => {
    const picOf = (i: number) => unionBox(r.elements.filter((e) => e.kind === 'image' && e.scene === i).map((e) => e.box));
    const box = sceneOps(r, 1, 'op:shape.add').find((o) => args(o)['presetId'] === 'preset:shape.highlight-box')!;
    expect(args(box)['fill']).toBe('#E53935'); expect(args(box)['stroke']).toBe('#E53935');
    expect(args(box)['params']).toEqual({ strokeU: 8, radiusU: 12, pulse: true });
    expect(args(box)['motion']['presetId']).toBe('preset:motion.draw-on');
    expect(inside(boxOf(box, args(box)['size'], args(box)['height']), picOf(1))).toBe(true);
    // anchored at 40 % of v2 (the scene's only clip starts with the scene; elements enter after the incoming transition, ≤ 300 ms)
    const v2 = r.voice.find((v) => v.clipId === 'v2')!;
    expect(args(box)['atMs']).toBeGreaterThanOrEqual(v2.atMs + Math.round(0.4 * v2.durationMs));
    expect(args(box)['atMs']).toBeLessThanOrEqual(v2.atMs + Math.round(0.4 * v2.durationMs) + 300);
    const label = sceneOps(r, 1, 'op:text.add').find((o) => args(o)['text'] === '31 Okt – 1 Nov')!;
    expect(label).toBeDefined(); expect(label.args['styleOverrides']).toMatchObject({ box: expect.objectContaining({ colour: '#E53935' }) });
    const x = sceneOps(r, 2, 'op:shape.add').find((o) => args(o)['presetId'] === 'preset:shape.x-mark')!;
    expect(args(x)['params']).toEqual({ strokeU: 18 }); expect(args(x)['motion']['presetId']).toBe('preset:motion.pop');
    expect(inside(boxOf(x, args(x)['size'], args(x)['height']), picOf(2))).toBe(true);
    const arrow = sceneOps(r, 3, 'op:shape.add').find((o) => args(o)['presetId'] === 'preset:shape.arrow')!;
    const pic3 = picOf(3), ab = boxOf(arrow, args(arrow)['size'], args(arrow)['height']);
    expect(inside(ab, pic3)).toBe(true);
    expect(args(arrow)['fill']).toBe('#E53935'); expect(args(arrow)['motion']['presetId']).toBe('preset:motion.draw-on');
    // the arrow points at (0.78, 0.3) of the picture from a free side: its box never covers the target point
    const tx = pic3.x0 + 0.78 * (pic3.x1 - pic3.x0), ty = pic3.y0 + 0.3 * (pic3.y1 - pic3.y0);
    expect(tx >= ab.x0 && tx <= ab.x1 && ty >= ab.y0 && ty <= ab.y1).toBe(false);
    expect(['left', 'right', 'up', 'down']).toContain(args(arrow)['params']['direction']);
    const pill = sceneOps(r, 3, 'op:text.add').find((o) => args(o)['text'] === 'sponsor utama')!;
    expect(pill).toBeDefined();
    const ring = sceneOps(r, 4, 'op:shape.add').find((o) => args(o)['presetId'] === 'preset:shape.ring')!;
    expect(ring).toBeDefined(); expect(inside(boxOf(ring, args(ring)['size'], args(ring)['height']), picOf(4))).toBe(true);
    // every annotation shape of every image scene sits inside its scene's picture box
    for (const i of [1, 2, 3, 4]) for (const o of sceneOps(r, i, 'op:shape.add').filter((o) => /arrow|x-mark|highlight-box|ring/.test(String(args(o)['presetId'])))) expect(inside(boxOf(o, args(o)['size'], args(o)['height']), picOf(i)), `scene ${i} ${args(o)['presetId']}`).toBe(true);
  });
  it('chips: AFTER red top-right; BEFORE / AFTER guessed from the text (SEBELUM green, SESUDAH red), upper case, inside the picture corners', () => {
    const picOf = (i: number) => unionBox(r.elements.filter((e) => e.kind === 'image' && e.scene === i).map((e) => e.box));
    const after = sceneOps(r, 2, 'op:text.add').find((o) => args(o)['text'] === 'DIBATALKAN')!;
    expect(after.args['styleOverrides']).toMatchObject({ box: expect.objectContaining({ colour: '#C62828' }), colour: '#FFFFFF' });
    const pic2 = picOf(2);
    expect(f.w / 2 + (args(after)['position'] as { x: number }).x).toBeGreaterThan((pic2.x0 + pic2.x1) / 2);      // top-right
    const before = sceneOps(r, 4, 'op:text.add').find((o) => args(o)['text'] === 'SEBELUM')!, sesudah = sceneOps(r, 4, 'op:text.add').find((o) => args(o)['text'] === 'SESUDAH')!;
    expect(before.args['styleOverrides']).toMatchObject({ box: expect.objectContaining({ colour: '#2E7D32' }) });
    expect(sesudah.args['styleOverrides']).toMatchObject({ box: expect.objectContaining({ colour: '#C62828' }) });
    expect(chipColours(undefined, 'Before')).toEqual({ fill: '#2E7D32', text: '#FFFFFF' });
    expect(chipColours('warning', 'x')).toEqual({ fill: '#F59E0B', text: '#FFFFFF' });
  });
  it('caption line only when captions are off; source → preset:shape.source-tag at the bottom of every image scene', () => {
    expect(sceneOps(r, 2, 'op:text.add').find((o) => args(o)['text'] === 'semua penyanyi di sana itu cabut')).toBeUndefined();      // captions: true → the voice captions carry the words
    const off = composed({ ...VIRAL, captions: false });
    const cap = sceneOps(off.r, 2, 'op:text.add').find((o) => args(o)['text'] === 'semua penyanyi di sana itu cabut')!;
    expect(cap).toBeDefined();
    expect(cap.args['styleOverrides']).toMatchObject({ fontSize: 48, colour: '#FFFFFF', box: expect.objectContaining({ colour: '#111111' }) });
    expect(f.h / 2 + (args(cap)['position'] as { y: number }).y).toBeLessThan(f.h - off.r.safeArea.bottom);                      // above the caption band
    for (const i of [1, 2, 3, 4]) {
      const tag = sceneOps(r, i, 'op:shape.add').find((o) => args(o)['presetId'] === 'preset:shape.source-tag')!;
      expect(tag, `scene ${i}`).toBeDefined();
      expect(String(args(tag)['params']['text'])).toMatch(/^Sumber/);
      expect(f.h / 2 + (args(tag)['position'] as { y: number }).y + args(tag)['height'] / 2).toBeLessThanOrEqual(f.h - r.safeArea.bottom + 1);
    }
  });
  it('watermark: one overlay over the whole video, 220 u wide, opacity 0.9, top-centre, no scene picture under the caption band', () => {
    const wm = r.ops.filter((o) => o.op === 'op:overlay.addImage' && args(o)['assetId'] === 'LOGO');
    expect(wm).toHaveLength(1);
    expect(args(wm[0]!)['atMs']).toBe(0); expect(args(wm[0]!)['durationMs']).toBe(r.totalMs);
    expect(args(wm[0]!)['size']).toBe(220); expect(args(wm[0]!)['opacity']).toBe(0.9);
    expect((args(wm[0]!)['position'] as { x: number }).x).toBe(0);
    expect(f.h / 2 + (args(wm[0]!)['position'] as { y: number }).y).toBeLessThan(r.safeArea.top);
    for (const el of r.elements.filter((e) => e.kind === 'image' && e.scene >= 0)) expect(el.box.y1).toBeLessThanOrEqual(f.h - r.safeArea.bottom + 1);
  });
  it('captions: viral default = preset:caption.editorial, white 800 on the dark box, the scene keywords coloured; the step spec carries the style', () => {
    const cs = r.ops.find((o) => o.op === 'op:caption.setStyle')!;
    expect(args(cs)['presetId']).toBe('preset:caption.editorial');
    expect(args(cs)['params']).toMatchObject({ position: 'bottom', weight: 800, fontFamily: 'Poppins', keywords: [{ words: ['BOIKOT!'], colour: '#FFD400' }] });
    expect(r.spec.captionStyle).toBe('preset:caption.editorial');
  });
  it('quality gate: no warn-level issue remains; the stat has its source; the total stays under 60 s and voice clips are placed', () => {
    expect(r.quality.remaining.filter((q) => q.severity === 'warn')).toEqual([]);
    expect(qualityCheck(m, { safeArea: r.safeArea }).filter((q) => q.severity === 'warn')).toEqual([]);
    expect(r.risks.filter((x) => x.code === 'no-source' || x.code === 'image-missing' || x.code === 'watermark-missing')).toEqual([]);
    expect(r.totalMs).toBeLessThanOrEqual(60_000);
    expect(r.voice).toHaveLength(7);
  });
  it('a missing picture or logo is skipped with a risk, never invented', () => {
    const { r: r2 } = composed(VIRAL, { assets: ASSETS.filter((a) => a.id !== 'IMG-comment' && a.id !== 'LOGO') });
    expect(r2.risks.some((x) => x.code === 'image-missing')).toBe(true);
    expect(r2.risks.some((x) => x.code === 'watermark-missing')).toBe(true);
    expect(sceneOps(r2, 4, 'op:overlay.addImage')).toHaveLength(1);
    expect(r2.ops.some((o) => o.op === 'op:overlay.addImage' && args(o)['assetId'] === 'LOGO')).toBe(false);
  });
});

describe('golden GS-25 "footage stok + caption penekanan" (satu-persen-spec.json, Sampel 4 look)', () => {
  const { r, m } = composed(SATU);
  it('three footage clips with the dark-grain grade: vignette + film grain 0.3 on the insert (two effects, also on T0) and a full-frame 0.5 dim', () => {
    const clips = r.ops.filter((o) => o.op === 'op:clip.insert');
    expect(clips).toHaveLength(3);
    for (const c of clips) expect(args(c)['effects']).toEqual([{ presetId: 'preset:effect.vignette', params: { intensity: 0.55 } }, { presetId: 'preset:effect.film-grain', params: { intensity: 0.3 } }]);
    const dims = r.ops.filter((o) => o.op === 'op:shape.add' && args(o)['presetId'] === 'preset:shape.rect' && args(o)['opacity'] === 0.5 && args(o)['size'] === f.w && args(o)['height'] === f.h);
    expect(dims).toHaveLength(3);
    for (const d of dims) expect(args(d)['motion']).toEqual({ presetId: 'preset:motion.none' });
    expect(gradeEffects('dark-grain')).toHaveLength(2); expect(gradeEffects('warm')).toHaveLength(2); expect(gradeEffects('none')).toEqual([]); expect(gradeEffects(undefined)).toEqual([]);
    const t0 = composed(SATU, { tier: 'T0' });
    for (const c of t0.r.ops.filter((o) => o.op === 'op:clip.insert')) expect((args(c)['effects'] as unknown[]).length).toBeLessThanOrEqual(2);
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
  });
  it('captions: preset:caption.emphasis with the scene keywords in the accent and emphasisColour; the watermark on top; the headlines carry the keywords', () => {
    const cs = r.ops.find((o) => o.op === 'op:caption.setStyle')!;
    expect(args(cs)['presetId']).toBe('preset:caption.emphasis');
    expect(args(cs)['params']).toMatchObject({ emphasisColour: '#FFD400', keywords: [{ words: ['bayangin', 'elit-elit', 'Diekspor'], colour: '#FFD400' }] });
    expect(r.spec.captionStyle).toBe('preset:caption.emphasis');
    expect(r.ops.filter((o) => o.op === 'op:overlay.addImage' && args(o)['assetId'] === 'LOGO')).toHaveLength(1);
    expect(r.quality.remaining.filter((q) => q.severity === 'warn')).toEqual([]);
  });
});

describe('normaliser: the Editor\'s likely slips in a viral spec', () => {
  it('numbers as strings, percentages, missing tones, kind / layout / bg / pan / grade / role aliases, images as ids; labels are never numbers', () => {
    const raw = {
      mood: 'Viral', titleStyle: 'Boxed', watermark: { assetId: 'LOGO', position: 'top', widthU: '220', opacity: '0.9' },
      scenes: [
        { role: 'screenshot', images: ['IMG-post'], layout: 'Stacked', bg: 'blurred', pan: 'ken burns',
          annotations: [{ type: 'rectangle', x: '45%', y: 60, w: '0.3', h: '0.2', text: '2026', colour: 'E53935' }, { kind: 'cross', x: '0.5', y: '0.5' }],
          chips: [{ text: 'Before' }, { text: 'Sesudah renovasi' }, { text: 'AWAS hoaks', tone: 'amber' }] },
        { role: 'image', assetId: 'IMG-news', images: undefined, annotations: [{ kind: 'pointer', x: 0.2, y: 0.3 }] },
        { role: 'footage', footage: { assetId: 'CLIP-crowd', grade: 'dark grain' } },
      ],
    };
    const { value, fixes } = normalizeVideoSpec(raw);
    const v = value as any;   // eslint-disable-line @typescript-eslint/no-explicit-any -- test reads
    expect(v.watermark).toEqual({ assetId: 'LOGO', position: 'top-center', widthU: 220, opacity: 0.9 });
    const s0 = v.scenes[0];
    expect(s0.role).toBe('image'); expect(s0.images).toEqual([{ assetId: 'IMG-post' }]); expect(s0.layout).toBe('stack'); expect(s0.bg).toBe('blur'); expect(s0.pan).toBe('zoom-in');
    expect(s0.annotations[0]).toEqual({ kind: 'box', x: 0.45, y: 0.6, w: 0.3, h: 0.2, text: '2026', color: '#E53935' });
    expect(s0.annotations[1]).toEqual({ kind: 'x', x: 0.5, y: 0.5 });
    expect(s0.chips.map((c: { tone?: string }) => c.tone)).toEqual(['before', 'after', 'warning']);
    expect(v.scenes[1].images).toEqual([{ assetId: 'IMG-news' }]); expect(v.scenes[1].assetId).toBeUndefined();
    expect(v.scenes[1].annotations[0].kind).toBe('arrow');
    expect(v.scenes[2].footage.grade).toBe('dark-grain');
    expect(fixes.length).toBeGreaterThan(8);
    const parsed = VideoSpec.safeParse({ ...v, mood: 'viral', titleStyle: 'boxed', scenes: v.scenes.map((s: Record<string, unknown>) => ({ ...s, images: s['images'] })) });
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues.slice(0, 3))).toBe(true);
  });
  it('an image scene without pictures is refused with a clear message; rotationDeg beyond ±15 and a bad kind are refused', () => {
    const r1 = VideoSpec.safeParse({ scenes: [{ role: 'image' }] });
    expect(r1.success).toBe(false); expect(JSON.stringify(r1.success ? '' : r1.error.issues)).toContain('image scene needs images');
    expect(VideoSpec.safeParse({ scenes: [{ role: 'image', images: [{ assetId: 'a', rotationDeg: 40 }] }] }).success).toBe(false);
    expect(VideoSpec.safeParse({ scenes: [{ role: 'image', images: [{ assetId: 'a' }], annotations: [{ kind: 'star', x: 0, y: 0 }] }] }).success).toBe(false);
  });
});

describe('picture geometry (auto-motion-image.ts)', () => {
  const area = { x0: 88, y0: 300, x1: 920, y1: 1480 };
  it('phone: the box follows a wide picture, so chips and marks sit on the picture (E2E run 10)', () => {
    const area = { x0: 100, y0: 200, x1: 980, y1: 1400 };
    const [{ box }] = pictureBoxes('phone', [16 / 9], area, 1080) as [{ box: { x0: number; y0: number; x1: number; y1: number } }];
    expect((box.x1 - box.x0) / (box.y1 - box.y0)).toBeCloseTo(16 / 9, 1);
  });
  it('single: 86 % wide in the upper 60 %; stack: cascaded, tilted, inside the area; phone: 46 % of the frame; side-by-side: two columns', () => {
    const one = pictureBoxes('single', [1], area, 1080);
    expect(one).toHaveLength(1); expect(one[0]!.box.x1 - one[0]!.box.x0).toBeCloseTo((920 - 88) * 0.86, 5); expect(one[0]!.rotation).toBe(0);
    expect(one[0]!.box.y1).toBeLessThanOrEqual(area.y0 + (area.y1 - area.y0) * 0.72 + 1);
    const wide = pictureBoxes('single', [1.9], area, 1080);                                                      // a landscape card: centred in the upper 60 %
    expect(wide[0]!.box.y1).toBeLessThanOrEqual(area.y0 + (area.y1 - area.y0) * 0.6 + 1); expect(wide[0]!.box.y0).toBeGreaterThan(area.y0);
    const st = pictureBoxes(undefined, [1.9, 1.5, 1], area, 1080);
    expect(st.map((b) => b.rotation)).toEqual([-6, 5, -3]);
    for (const b of st) expect(inside(b.box, area)).toBe(true);
    expect(st[1]!.box.y0).toBeGreaterThan(st[0]!.box.y0); expect(st[2]!.box.y0).toBeGreaterThan(st[1]!.box.y0);
    const ph = pictureBoxes('phone', [0.5625], area, 1080);
    expect(ph[0]!.box.x1 - ph[0]!.box.x0).toBeCloseTo(1080 * 0.46, 5); expect(inside(ph[0]!.box, area)).toBe(true);
    const sb = pictureBoxes('side-by-side', [1, 1.5], area, 1080);
    expect(sb).toHaveLength(2); expect(sb[1]!.box.x0).toBeGreaterThan(sb[0]!.box.x1);
  });
  it('annotationMark: arrows come from the nearest side (direction + position), everything is clamped into the picture', () => {
    const pic = { x0: 100, y0: 400, x1: 900, y1: 1000 };
    const covers = (m: { cx: number; cy: number; w: number; h: number }, x: number, y: number) => x >= m.cx - m.w / 2 && x <= m.cx + m.w / 2 && y >= m.cy - m.h / 2 && y <= m.cy + m.h / 2;
    // room to the left (240 u) for a 176 u arrow: it comes from the left and points right
    const left = annotationMark({ kind: 'arrow', x: 0.3, y: 0.5 }, pic);
    expect(left.params['direction']).toBe('right'); expect(left.cx).toBeLessThan(pic.x0 + 0.3 * 800); expect(left.clamped).toBe(false);
    // no room above a target near the top edge: the arrow comes from a side that has room and never covers the target
    const top = annotationMark({ kind: 'arrow', x: 0.5, y: 0.1 }, pic);
    expect(top.params['direction']).not.toBe('down'); expect(covers(top, pic.x0 + 0.5 * 800, pic.y0 + 0.1 * 600)).toBe(false); expect(top.clamped).toBe(false);
    const corner = annotationMark({ kind: 'arrow', x: 0.08, y: 0.08 }, pic);
    expect(Math.abs(corner.rotation)).toBe(35); expect(covers(corner, pic.x0 + 0.08 * 800, pic.y0 + 0.08 * 600)).toBe(false);
    const edge = annotationMark({ kind: 'x', x: 1, y: 1, w: 0.5 }, pic);
    expect(edge.clamped).toBe(true); expect(edge.cx + edge.w / 2).toBeLessThanOrEqual(pic.x1 + 0.01); expect(edge.cy + edge.h / 2).toBeLessThanOrEqual(pic.y1 + 0.01);
    const box = annotationMark({ kind: 'box', x: 0.5, y: 0.5 }, pic, '#00FF00');
    expect(box.w).toBeCloseTo(240, 5); expect(box.h).toBeCloseTo(120, 5); expect(box.colour).toBe('#00FF00'); expect(box.presetId).toBe('preset:shape.highlight-box');
  });
});

// ───────────── talking-head cutaways ─────────────
function cutOf(id: string, lineIndex: number, startMs: number, text: string): AnalysisCut {
  const words: TimedWord[] = [];
  let t = startMs + 120;
  for (const w of text.split(/\s+/)) { words.push({ text: w, fromMs: t, toMs: t + 320 }); t += 320 + (/[,.?]$/.test(w) ? 450 : 60); }
  return { id, lineIndex, startMs, endMs: words[words.length - 1]!.toMs + 150, text, words, quietStartDb: -48, quietEndDb: -47, coverage: 1, confidence: 'ok' };
}
const CUTS = [cutOf('c1', 0, 0, 'Berita ini dibagikan puluhan ribu kali dalam semalam, lihat sendiri unggahannya.'), cutOf('c2', 1, 12_000, 'Ada tiga alasan utama, yaitu cuaca, ongkos kirim, dan permintaan yang terus tumbuh.')];
const ANALYSIS: FootageAnalysisLike = { version: 1, masterAssetId: 'MASTER', voiceAssetId: 'VOICE', durationMs: 30_000, cuts: CUTS, dropped: [], warnings: [] };
const TH_ASSETS: AssetFacts[] = [...ASSETS,
  { id: 'MASTER', kind: 'video', status: 'ready', name: 'master', durationMs: 30_000, width: 1080, height: 1920, hasAudio: true },
  { id: 'VOICE', kind: 'audio', status: 'ready', name: 'voice', durationMs: 30_000, hasAudio: true }];
const TH_SPEC: VideoSpecT = {
  ratio: '9:16', fps: 30, talkingHead: { masterAssetId: 'MASTER', voiceAssetId: 'VOICE' }, captions: { from: 'analysis' }, sfx: { enabled: true, level: 0.55 },
  scenes: [
    { role: 'talk', cut: 'c1', blocks: [{ kind: 'chip', text: 'viral', at: { say: 'dibagikan' } }, { kind: 'video', assetId: 'CLIP-crowd', fromMs: 1000, toMs: 5000, at: { say: 'lihat' } }] },
    { role: 'explain', cut: 'c2', heading: '3 alasan', blocks: [
      { kind: 'rows', at: { say: 'tiga' }, rows: [{ badge: '1', title: 'Cuaca' }, { badge: '2', title: 'Ongkos kirim' }] },
      { kind: 'image', assetId: 'IMG-news', at: { say: 'ongkos' }, ms: 2500, annotations: [{ kind: 'box', x: 0.5, y: 0.3, w: 0.8, h: 0.2 }, { kind: 'label', x: 0.5, y: 0.8, text: 'KOMPAS.com' }] },
      { kind: 'source', text: 'Sumber: KOMPAS.com · 1 Nov 2026' },
    ] },
  ],
};
describe('talking-head cutaways (ADR-041): image / video blocks cover the speaker; the bubble is not placed under them', () => {
  const model = empty();
  const r = composeScenes(TH_SPEC, { model, assets: TH_ASSETS, tier: 'T1', footageAnalysis: ANALYSIS, sfxAssets: SFX });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets: TH_ASSETS, tier: 'T1', newId });
  it('applies; the video cutaway is a muted full-frame op:overlay.addVideo from its word to the cut end with the source trim', () => {
    expect(a.ok, JSON.stringify(a.ok ? null : a.issues.slice(0, 4))).toBe(true);
    const talk = r.scenes[0]!;
    const vid = r.ops.find((o) => o.op === 'op:overlay.addVideo' && args(o)['assetId'] === 'CLIP-crowd')!;
    expect(vid).toBeDefined();
    expect(args(vid)).toMatchObject({ muted: true, shape: 'rect', size: f.w, height: f.h, trimBeforeMs: 1000, position: { x: 0, y: 0 } });
    const lihat = CUTS[0]!.words.find((w) => w.text === 'lihat')!;
    expect(args(vid)['atMs']).toBe(talk.startMs + lihat.fromMs - CUTS[0]!.startMs);
    expect(args(vid)['atMs'] + args(vid)['durationMs']).toBeLessThanOrEqual(talk.startMs + talk.durationMs);
    expect(args(vid)['durationMs']).toBeLessThanOrEqual(4000);                                                      // toMs − fromMs
    // the chip stays: cutaway ops are added after it (in front)
    expect(r.ops.findIndex((o) => o === vid)).toBeGreaterThan(r.ops.findIndex((o) => o.op === 'op:text.add' && args(o)['text'] === 'viral'));
  });
  it('the image cutaway: backdrop + frame-wide picture (radius 24, shadow) for `ms`, annotations inside it; the bubble has two segments around the window', () => {
    const ex = r.scenes[1]!;
    const img = r.ops.find((o) => o.op === 'op:overlay.addImage' && args(o)['assetId'] === 'IMG-news')!;
    expect(img).toBeDefined();
    expect(args(img)).toMatchObject({ size: f.w, radius: 24, shadow: true, objectFit: 'contain', durationMs: 2500 });
    const ongkos = CUTS[1]!.words.find((w) => w.text === 'ongkos')!;
    const from = ex.startMs + ongkos.fromMs - CUTS[1]!.startMs;
    expect(args(img)['atMs']).toBe(from);
    const picH = f.w * 630 / 1200, pic = { x0: 0, y0: f.h / 2 + (args(img)['position'] as { y: number }).y - picH / 2, x1: f.w, y1: f.h / 2 + (args(img)['position'] as { y: number }).y + picH / 2 };
    const box = r.ops.find((o) => o.op === 'op:shape.add' && args(o)['presetId'] === 'preset:shape.highlight-box')!;
    expect(box).toBeDefined(); expect(inside(boxOf(box, args(box)['size'], args(box)['height']), pic)).toBe(true);
    expect(args(box)['atMs'] + args(box)['durationMs']).toBe(from + 2500);                                            // gone with the cutaway
    expect(r.ops.find((o) => o.op === 'op:text.add' && args(o)['text'] === 'KOMPAS.com')).toBeDefined();
    const bubbles = r.ops.filter((o) => o.op === 'op:overlay.addVideo' && args(o)['assetId'] === 'MASTER' && args(o)['shape'] === 'circle');
    expect(bubbles).toHaveLength(2);
    const [b1, b2] = bubbles.map(args) as [Record<string, number>, Record<string, number>];
    expect(b1['atMs']).toBe(ex.startMs); expect(b1['atMs']! + b1['durationMs']!).toBe(from);
    expect(b2['atMs']).toBe(from + 2500); expect(b2['atMs']! + b2['durationMs']!).toBe(ex.startMs + ex.durationMs);
    expect(b2['trimBeforeMs']).toBe(CUTS[1]!.startMs + (from + 2500 - ex.startMs));                                   // the speaker continues from the right moment
    expect(r.ops.filter((o) => o.op === 'op:overlay.addVideo' && args(o)['assetId'] === 'MASTER').some((o) => args(o)['atMs'] < from + 2500 && args(o)['atMs'] + args(o)['durationMs'] > from)).toBe(false);
    expect(r.reels?.sfx.some((s) => s.what.startsWith('cutaway'))).toBe(true);
  });
  it('a cutaway whose asset is missing is skipped with a risk', () => {
    const r2 = composeScenes({ ...TH_SPEC, scenes: [{ role: 'talk', cut: 'c1', blocks: [{ kind: 'image', assetId: 'NOPE', at: { ms: 500 } }] }] }, { model: empty(), assets: TH_ASSETS, tier: 'T1', footageAnalysis: ANALYSIS });
    expect(r2.ok && r2.risks.some((x) => x.code === 'cutaway-missing')).toBe(true);
    expect(r2.ok && r2.ops.some((o) => o.op === 'op:overlay.addImage')).toBe(false);
  });
});

describe('web tools (ADR-041): web.images sources and web.screenshot', () => {
  it('web.images takes source open | stock | page (+ url), web.screenshot {url, viewport}; both agents offer them; descriptions ≤ 60 words', async () => {
    expect(WEB_TOOL_NAMES).toContain('web.screenshot');
    expect(EDITOR_TOOL_NAMES).toContain('web.screenshot'); expect(BRAINSTORM_TOOL_INPUTS['web.screenshot']).toBeDefined();
    expect(BRAINSTORM_TOOL_INPUTS['web.images'].safeParse({ query: 'poster', source: 'page', url: 'https://example.com/a' }).success).toBe(true);
    expect(BRAINSTORM_TOOL_INPUTS['web.images'].safeParse({ query: 'poster', source: 'page' }).success).toBe(false);
    expect(BRAINSTORM_TOOL_INPUTS['web.images'].safeParse({ query: 'crowd', source: 'stock' }).success).toBe(true);
    expect(BRAINSTORM_TOOL_INPUTS['web.screenshot'].safeParse({ url: 'https://example.com/a', viewport: 'phone' }).success).toBe(true);
    expect(BRAINSTORM_TOOL_INPUTS['web.screenshot'].safeParse({ url: 'x' }).success).toBe(false);
    for (const t of ['web.images', 'web.screenshot'] as const) expect(TOOL_DEFINITIONS[t].description.split(/\s+/).length).toBeLessThanOrEqual(60);
    const rec = await runTool('web.screenshot', { url: 'https://www.kompas.com/x' }, { 'web.screenshot': () => ({ assetId: 'A9', title: 'Kompas', host: 'kompas.com', width: 1080, height: 1920 }) }, EDITOR_TOOL_NAMES);
    expect(rec.ok).toBe(true);
    // the page a screenshot pictured is a source like a fetched page; a 'page' image search names its page too
    const src = sourcesOfToolCalls([rec, { name: 'web.images', input: { query: 'q', source: 'page', url: 'https://news.example/b' }, output: { candidates: [] }, ok: true }]);
    expect(src.map((s) => s.url)).toEqual(['https://www.kompas.com/x', 'https://news.example/b']);
  });
  it('prompt set 1.9.1: P-1 has the viral explainer flow with the honesty rule, P-2 the image role, cutaways and the web tools', () => {
    expect(PROMPT_SET_VERSION).toBe('1.9.1');
    expect(BRAINSTORM_SYSTEM).toContain('VIRAL EXPLAINER FLOW'); expect(BRAINSTORM_SYSTEM).toContain('web.screenshot'); expect(BRAINSTORM_SYSTEM).toMatch(/quoted material/);
    expect(EDITOR_SYSTEM).toContain('VIRAL EXPLAINER'); expect(EDITOR_SYSTEM).toContain('"image"'); expect(EDITOR_SYSTEM).toContain('CUTAWAYS'); expect(EDITOR_SYSTEM).toContain('web.screenshot'); expect(EDITOR_SYSTEM).toContain('dark-grain');
  });
});
