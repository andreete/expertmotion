// ADR-039 (Reels production pipeline, FR-280 … FR-299): the talking-head composer on a GENERIC fixture ("Kenapa harga kopi naik?",
// test/fixtures/talkinghead-spec.json) over a fake FootageAnalysis with 6 cuts and timed words; the fuzzy {say} anchors; the cover
// still; the plan expansion (music + cover steps, credits); the media tools; the envelope block; the prompt set v1.8.0.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, createEmptyModel, deriveTiming, frameInUnits, hashModel, qualityCheck, textGeometry, validate, type AssetFacts, type CompositionModelT, type OperationT } from '@expertmotion/composition-model';
import { BRAINSTORM_TOOL_NAMES, buildRewriteEnvelope, captionPagesFromWords, composeCover, composeScenes, COVER_BAND, COVER_BAND_OPACITY, COVER_FACE, coverAtMs, coverOps, cutWordsFor, EditPlan, EDITOR_TOOL_NAMES, finalProfile, findSaid, findSaidIndex, previewProfile, REELS, reelsSafeArea, runTool, TALKING_HEAD_CONSTRAINT, validatePlan, wordMatches, wordSimilarity, type AnalysisCut, type ComposeOk, type FootageAnalysisLike, type TimedWord, type VideoSpecT } from '../src/index.js';
import { BRAINSTORM_SYSTEM, EDITOR_SYSTEM, PROMPT_SET_VERSION } from '../src/prompts.generated.js';

const SPEC = JSON.parse(fs.readFileSync(new URL('./fixtures/talkinghead-spec.json', import.meta.url), 'utf8')) as VideoSpecT;
const FPS = 30, FRAME = 1000 / FPS;

/** A cut whose words are spread from startMs + 120 (the leading pad): 320 ms per word + 60 ms gaps, a 450 ms pause after , . ? */
function cutOf(id: string, lineIndex: number, startMs: number, text: string): AnalysisCut {
  const words: TimedWord[] = [];
  let t = startMs + 120;
  for (const w of text.split(/\s+/)) { words.push({ text: w, fromMs: t, toMs: t + 320 }); t += 320 + (/[,.?]$/.test(w) ? 450 : 60); }
  return { id, lineIndex, startMs, endMs: words[words.length - 1]!.toMs + 150, text, words, quietStartDb: -48, quietEndDb: -47, coverage: 1, confidence: 'ok' };
}
const CUTS: AnalysisCut[] = [
  cutOf('c1', 0, 8140, 'Harga kopi naik lagi, dan bukan cuma karena cuaca.'),
  cutOf('c2', 1, 20_000, 'Ada tiga alasan utama, yaitu cuaca, ongkos kirim, dan permintaan yang terus tumbuh.'),
  cutOf('c3', 2, 33_000, 'Panen di dua negara produsen terbesar turun karena hujan datang tidak menentu.'),
  cutOf('c4', 3, 45_000, 'Di sisi lain, konsumsi kopi di Asia tumbuh paling cepat dalam sepuluh tahun terakhir.'),
  cutOf('c5', 4, 58_000, 'Jadi, kalau kopi favoritmu makin mahal, sekarang kamu tahu alasannya.'),
  cutOf('c6', 5, 70_000, 'Kalau kamu mau tabel lengkapnya, ketik kopi di kolom komentar.'),
];
const ANALYSIS: FootageAnalysisLike = { version: 1, voiceAssetId: 'VOICE', cameraAssetId: 'CAM', masterAssetId: 'MASTER', offsetMs: 3536, rotation: 90, durationMs: 90_000, model: 'whisper-small-q5', cuts: CUTS,
  dropped: [{ startMs: 14_900, endMs: 19_200, text: 'eh, ulang ya', reason: 'false-start' }], warnings: [] };
const SFX = { whoosh: 'SFX-whoosh', pop: 'SFX-pop', click: 'SFX-click', tick: 'SFX-tick', ding: 'SFX-ding', rise: 'SFX-rise' } as const;
const ASSETS: AssetFacts[] = [
  { id: 'MASTER', kind: 'video', status: 'ready', name: 'rekaman · master', durationMs: 90_000, width: 1080, height: 1920, hasAudio: true },
  { id: 'CAM', kind: 'video', status: 'ready', name: 'kamera.mp4', durationMs: 95_000, width: 1920, height: 1080, hasAudio: true },
  { id: 'VOICE', kind: 'audio', status: 'ready', name: 'suara.m4a', durationMs: 95_000, hasAudio: true },
  { id: 'POSTER', kind: 'image', status: 'ready', name: 'poster.png', width: 1080, height: 1920 },
  ...Object.entries(SFX).map(([k, id]): AssetFacts => ({ id, kind: 'audio', status: 'ready', name: `SFX · ${k}`, durationMs: k === 'ding' ? 600 : k === 'whoosh' ? 350 : 100, hasAudio: true })),
];
let n = 0; const newId = () => `r${++n}`;
const empty = () => createEmptyModel('p', { autoRatio: false, ratio: '9:16', fps: 30, resolution: '1080p' });
function composed(spec: VideoSpecT = SPEC, extra: { assets?: AssetFacts[]; analysis?: FootageAnalysisLike; sfx?: Record<string, string> } = {}): { r: ComposeOk; m: CompositionModelT; model: CompositionModelT } {
  const model = empty();
  const r = composeScenes(spec, { model, assets: extra.assets ?? ASSETS, tier: 'T1', footageAnalysis: extra.analysis ?? ANALYSIS, sfxAssets: extra.sfx ?? SFX });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets: extra.assets ?? ASSETS, tier: 'T1', newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues.slice(0, 5)));
  return { r, m: a.value.model, model };
}
const args = (o: OperationT) => o.args as Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any -- test reads
const f = frameInUnits('9:16');

describe('fuzzy findSaid (ADR-039)', () => {
  const w = CUTS[0]!.words;
  it('exact words win; near spellings match at ≥ 0.75 similarity; words of ≤ 3 letters only exactly', () => {
    expect(findSaid(w, 'harga kopi', 0, 1e9)).toBe(w[0]!.fromMs);
    expect(findSaid(w, 'kopi naik', 0, 1e9, 'end')).toBe(w[2]!.toMs);
    expect(findSaid(w, 'hrga kopy', 0, 1e9)).toBe(w[0]!.fromMs);                       // "hrga" ≈ "harga" (0.8), "kopy" ≈ "kopi" (0.75)
    expect(findSaid(w, 'bukn', 0, 1e9)).toBe(w[5]!.fromMs);
    expect(findSaid(w, 'dn', 0, 1e9)).toBeNull();                                         // "dn" is not "dan": short words need the exact spelling
    expect(findSaid(w, 'karna cuaca', 0, 1e9)).toBe(w[7]!.fromMs);
    expect(findSaid(w, 'harga kopi', 9000, 1e9)).toBeNull();                              // outside the window
    expect(findSaid(w, 'reaktor', 0, 1e9)).toBeNull();
    expect(wordSimilarity('reaktor', 'reaktr')).toBeCloseTo(6 / 7, 3);
    expect(wordMatches('SMR', 'smr')).toBe(true); expect(wordMatches('AI', 'ai')).toBe(true); expect(wordMatches('di', 'ke')).toBe(false);
    expect(findSaidIndex(w, 'naik lagi', 0, 1e9)).toEqual({ index: 2, length: 2, similarity: 1 });
  });
  it('cutWordsFor returns the words of one cut, [] for an unknown id', () => {
    expect(cutWordsFor(CUTS, 'c3').length).toBe(CUTS[2]!.words.length);
    expect(cutWordsFor(CUTS, 'nope')).toEqual([]);
  });
  it('caption pages: ≤ 3 words, split at pauses and punctuation, shifted and clamped to the scene', () => {
    const pages = captionPagesFromWords(CUTS[1]!.words, { shiftMs: -20_000 + 5000, fromMs: 5000, toMs: 5000 + 8000, maxWords: 3 });
    expect(pages.length).toBeGreaterThan(4);
    for (const p of pages) { expect(p.tokens.length).toBeLessThanOrEqual(3); expect(p.startMs).toBeGreaterThanOrEqual(5000); expect(p.startMs + p.durationMs).toBeLessThanOrEqual(13_000); }
    expect(pages[0]!.text).toBe(' Ada tiga alasan');                                       // "utama," ends the next page at the pause
    expect(pages[1]!.tokens.map((t) => t.text.trim())).toEqual(['utama,']);
  });
});

describe('talking-head composer on the generic "harga kopi" fixture (6 cuts, 9 scenes)', () => {
  const { r, m } = composed();
  const speech = r.scenes.map((s, i) => ({ ...s, i })).filter((s) => s.role === 'talk' || s.role === 'explain');
  const silent = r.scenes.map((s, i) => ({ ...s, i })).filter((s) => s.role === 'card' || s.role === 'hold' || s.role === 'poster');
  it('one scene per cut + card + hold + poster, in order; speech scenes are exactly their cuts in whole frames; ≤ 200 ops', () => {
    expect(r.scenes.map((s) => s.role)).toEqual(['talk', 'explain', 'card', 'explain', 'explain', 'hold', 'talk', 'talk', 'poster']);
    expect(m.tracks.video.map((c) => c.assetId ?? 'scene')).toEqual(['MASTER', 'scene', 'scene', 'scene', 'scene', 'scene', 'MASTER', 'MASTER', 'scene']);
    expect(r.reels?.cutIds).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    const cutLen = (id: string) => { const c = CUTS.find((x) => x.id === id)!; return Math.round((Math.floor(((c.endMs - c.startMs) * FPS) / 1000) * 1000) / FPS); };
    expect(r.scenes[0]!.durationMs).toBe(cutLen('c1')); expect(r.scenes[1]!.durationMs).toBe(cutLen('c2')); expect(r.scenes[7]!.durationMs).toBe(cutLen('c6'));
    expect(r.scenes[2]!.durationMs).toBe(3000); expect(r.scenes[5]!.durationMs).toBe(1200); expect(r.scenes[8]!.durationMs).toBe(3500);
    expect(r.totalMs).toBe(r.scenes.reduce((a, s) => a + s.durationMs, 0));
    expect(deriveTiming(m).durationMs).toBe(r.totalMs);
    expect(r.totalMs).toBeLessThan(60_000);
    expect(r.ops.length).toBeLessThanOrEqual(200);
    expect(m.transitions).toEqual([]);                                                    // hard cuts, as the reference
  });
  it('audio approach: every clip / bubble muted, ONE voice layer per speech scene from the one source, trimmed to the cut, 2-frame fades', () => {
    const voices = m.tracks.audio.filter((a) => a.role === 'voice');
    expect(voices.length).toBe(6);
    expect(r.reels?.audioAssetId).toBe('VOICE');
    expect(r.reels?.fadeMs).toBe(Math.round(2000 / FPS));
    speech.forEach((s, k) => {
      const v = voices[k]!, cut = CUTS.find((c) => c.id === r.reels!.cutIds[k])!;
      expect(v).toMatchObject({ assetId: 'VOICE', atMs: s.startMs, trimBeforeMs: cut.startMs, durationMs: s.durationMs, volume: 1, fadeInMs: 67, fadeOutMs: 67 });
    });
    for (const c of m.tracks.video.filter((x) => x.assetId)) expect(c.muted).toBe(true);
    expect(r.voice.map((v) => v.clipId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(r.voice.every((v) => v.measured && v.assetId === 'VOICE')).toBe(true);
  });
  it('talk scenes: the master trimmed to the cut with alternating punch-ins and zoom pops on the spoken word', () => {
    const talks = m.tracks.video.filter((c) => c.assetId === 'MASTER');
    expect(talks.map((c) => c.trimBeforeMs)).toEqual([CUTS[0]!.startMs, CUTS[4]!.startMs, CUTS[5]!.startMs]);
    expect(talks.map((c) => [c.zoom?.from, c.zoom?.to])).toEqual([[1.12, 1.2], [1.28, 1.36], [1.12, 1.2]]);
    const naik = CUTS[0]!.words.find((w) => w.text === 'naik')!;
    expect(talks[0]!.zoom?.pops).toEqual([{ atMs: naik.fromMs - CUTS[0]!.startMs, amount: 0.1, durationMs: 400 }]);
    const mahal = CUTS[4]!.words.find((w) => w.text.startsWith('mahal'))!;
    expect(talks[1]!.zoom?.pops?.[0]?.atMs).toBe(mahal.fromMs - CUTS[4]!.startMs);
    expect(r.footage.map((x) => x.scene)).toEqual([0, 6, 7]);
  });
  it('explain scenes: a navy scene + the speaker bubble (circle 260 u, yellow 6 u ring, top at 1640, muted, focus) for exactly the cut', () => {
    const bubbles = r.ops.filter((o) => o.op === 'op:overlay.addVideo');
    expect(bubbles.length).toBe(3);
    const explains = speech.filter((s) => s.role === 'explain');
    bubbles.forEach((o, k) => {
      const s = explains[k]!, cut = CUTS.find((c) => c.id === r.reels!.cutIds[speech.indexOf(s)])!;
      expect(args(o)).toMatchObject({ assetId: 'MASTER', atMs: s.startMs, durationMs: s.durationMs, trimBeforeMs: cut.startMs, muted: true, shape: 'circle', size: 260, position: { x: 0, y: 1640 + 130 - f.h / 2 }, ring: { colour: '#FFD43B', widthU: 6 }, focus: { x: 0.5, y: 0.33, zoom: 1.6 } });
    });
    // the bubble enters once (scale-in on the first explain after a talk / card) and stays put when explain scenes follow each other
    expect(bubbles.map((o) => args(o).motion.presetId)).toEqual(['preset:motion.scale-in', 'preset:motion.scale-in', 'preset:motion.none']);
    const vids = m.tracks.overlay.filter((o) => o.kind === 'video');
    expect(vids.length).toBe(3);
    for (const v of vids) { expect(v.size).toEqual({ w: 260, h: 260 }); expect(f.h / 2 + v.position.y - 130).toBe(1640); }
  });
  it('graphics of explain scenes stay inside y 110 … 1250; source tags sit at y 1285 on every scene with a source; the hold keeps the previous graphics', () => {
    const safe = reelsSafeArea(f);
    expect(safe).toEqual({ top: 110, left: 88, right: 160, bottom: f.h - 1250 });
    const explainIdx = new Set(speech.filter((s) => s.role === 'explain').map((s) => s.i));
    const graphics = r.elements.filter((e) => explainIdx.has(e.scene) && !e.key.includes(':source:'));
    expect(graphics.length).toBeGreaterThan(8);
    for (const e of graphics) { expect(e.box.y0).toBeGreaterThanOrEqual(110 - 1); expect(e.box.y1).toBeLessThanOrEqual(1250 + 1); expect(e.box.x0).toBeGreaterThanOrEqual(88 - 1); expect(e.box.x1).toBeLessThanOrEqual(f.w - 160 + 1); }
    const tags = r.ops.filter((o) => o.op === 'op:shape.add' && args(o).presetId === 'preset:shape.source-tag');
    expect(tags.length).toBe(4);                                                          // explain c2 (source block), card, explain c3, explain c4 (scene.source): one per scene with a source
    for (const t of tags) expect(f.h / 2 + args(t).position.y - args(t).height / 2).toBe(1285);
    expect(tags.map((t) => r.scenes.findIndex((s) => args(t).atMs >= s.startMs && args(t).atMs < s.startMs + s.durationMs))).toEqual([1, 2, 3, 4]);
    // the hold (scene 5) continues the graphics of explain c4 (scene 4) to its own end
    const hold = r.scenes[5]!;
    const kept = r.elements.filter((e) => e.scene === 4 && !e.key.includes(':source:'));
    expect(kept.length).toBeGreaterThan(0);
    for (const e of kept) expect(e.toMs).toBe(hold.startMs + hold.durationMs);
    expect(m.tracks.text.some((t) => t.text === 'Permintaan tumbuh' && t.timing.atMs + t.timing.durationMs === hold.startMs + hold.durationMs)).toBe(true);
    expect(r.reels?.credits).toContain('Sumber: Laporan pasar kopi 2026 · dicek 30 Okt 2026');
    expect(r.reels?.credits).toContain('Musik: pustaka CC0, trek cc0-calm-01');
  });
  it('talk chips: one unit each (pill holds icon + label), staggered left / centre / right in the lower band, never overlapping; the gate reports no overlap', () => {
    const chips = r.elements.filter((e) => e.scene === 0 && e.key.includes(':chip:'));
    expect(chips.length).toBe(3);
    expect(chips.every((e) => e.holds?.startsWith('chip:'))).toBe(true);
    const sorted = [...chips].sort((a, b) => a.box.y0 - b.box.y0);
    for (let k = 1; k < sorted.length; k++) expect(sorted[k]!.box.y0).toBeGreaterThanOrEqual(sorted[k - 1]!.box.y1);
    expect(sorted[sorted.length - 1]!.box.y1).toBeLessThanOrEqual(1250);
    expect(sorted[0]!.box.y0).toBeGreaterThan(f.h * 0.4);
    expect(chips.map((e) => Math.round(e.box.x0))).toEqual([88, expect.any(Number), expect.any(Number)]);
    expect(chips[2]!.box.x1).toBeCloseTo(f.w - 160, 0);
    const labels = r.elements.filter((e) => e.scene === 0 && e.key.includes(':chip-text:'));
    for (const l of labels) { const pill = chips.find((p) => p.fromMs === l.fromMs)!; expect(l.box.y0).toBeGreaterThanOrEqual(pill.box.y0); expect(l.box.y1).toBeLessThanOrEqual(pill.box.y1 + 0.5); expect(l.box.x1).toBeLessThanOrEqual(pill.box.x1); expect(l.box.y1 - l.box.y0).toBeLessThan(60); }
    expect(qualityCheck(m, { safeArea: reelsSafeArea(f) }).filter((q) => q.code === 'overlap')).toEqual([]);
    expect(r.risks.filter((x) => x.code === 'quality')).toEqual([]);
  });
  it('talk heading: a rounded dark pill (bg2, radius 28, padding 28 / 40) with the keyword in yellow, ≤ 2 lines in the top band, no exit; nothing animates out at the end', () => {
    const h = m.tracks.text.find((t) => t.text === 'Kenapa kopi makin mahal?' && t.timing.atMs === r.scenes[0]!.startMs)!;
    expect(h.style.box).toEqual({ colour: '#121F38', padX: 40, padY: 28, radius: 28 });
    expect(h.effect).toMatchObject({ presetId: 'preset:texteffect.keyword', params: { words: ['mahal'], colour: '#FFD43B' } });
    const el = r.elements.find((e) => e.scene === 0 && e.key.includes(':talk-heading:'))!;
    expect(el.box.y0).toBeGreaterThanOrEqual(110); expect(el.box.y1).toBeLessThanOrEqual(340);
    expect(h.motion?.exit).toBe(false);
    // the Reel ends on the poster: no element that reaches the composition end animates out
    const end = r.totalMs;
    const last = [...m.tracks.text, ...m.tracks.overlay].filter((x) => x.timing.atMs + x.timing.durationMs >= end - 1);
    expect(last.length).toBeGreaterThanOrEqual(2);
    for (const x of last) expect(x.motion === null || x.motion.exit === false).toBe(true);
  });
  it('a long chip label (explain scene) shrinks or wraps inside its own pill: no overlap, no quality warning', () => {
    const longSpec = { ...SPEC, scenes: SPEC.scenes.map((s, i) => (i === 1 ? { ...s, blocks: [{ kind: 'chip', icon: 'bolt', text: '+ pasokan stabil sepanjang hari, emisi sangat rendah sekali', at: { say: 'cuaca' } }, { kind: 'chip', icon: 'warning', text: '? biaya dan waktu bangun belum terbukti di lapangan', at: { say: 'kirim' } }, ...(s.blocks ?? [])] } : s)) } as VideoSpecT;
    const { r: r2, m: m2 } = composed(longSpec);
    const pills = r2.elements.filter((e) => e.scene === 1 && e.key.includes(':chip:')), labels = r2.elements.filter((e) => e.scene === 1 && e.key.includes(':chip-text:'));
    expect(pills.length).toBe(2);
    for (const l of labels) { const p = pills.find((x) => x.fromMs === l.fromMs)!; expect(l.box.x1).toBeLessThanOrEqual(p.box.x1 + 0.5); expect(l.box.y0).toBeGreaterThanOrEqual(p.box.y0 - 0.5); expect(l.box.y1).toBeLessThanOrEqual(p.box.y1 + 0.5); }
    expect(qualityCheck(m2, { safeArea: reelsSafeArea(f) }).filter((q) => q.code === 'overlap')).toEqual([]);
    expect(r2.risks.filter((x) => x.severity === 'warn')).toEqual([]);
  });
  it('captions: karaoke pages only inside speech scenes, ≤ 3 words each, keyword colours and the block position in the style params', () => {
    const style = r.ops.find((o) => o.op === 'op:caption.setStyle')!, pages = r.ops.find((o) => o.op === 'op:caption.setPages')!;
    expect(args(style)).toMatchObject({ presetId: 'preset:caption.karaoke', params: { keywords: [{ words: ['naik', 'mahal'], colour: '#FFA94D' }, { words: ['tumbuh', 'tahu'], colour: '#4DD4C4' }], yU: 1455, fontSizeU: 68, fontFamily: 'Poppins', weight: 800, maxWordsPerPage: 3 } });
    const list = args(pages).pages as Array<{ startMs: number; durationMs: number; tokens: unknown[] }>;
    expect(list.length).toBe(r.reels?.captionPages);
    expect(list.length).toBeGreaterThan(20);
    for (const p of list) {
      expect(p.tokens.length).toBeLessThanOrEqual(3);
      const inSpeech = speech.some((s) => p.startMs >= s.startMs && p.startMs + p.durationMs <= s.startMs + s.durationMs + 1);
      expect(inSpeech).toBe(true);
      for (const s of silent) expect(p.startMs >= s.startMs + s.durationMs || p.startMs + p.durationMs <= s.startMs).toBe(true);
    }
    expect(m.tracks.caption.pages.length).toBe(list.length);
    expect(m.tracks.caption.styleId).toBe('preset:caption.karaoke');
  });
  it('SFX: every effect of a speech scene lands ≤ 4 frames BEFORE a spoken word (≥ 90 % of all), level 0.55, whoosh before the first word / at a silent scene start, no time grids', () => {
    const sfx = r.reels!.sfx;
    const layers = m.tracks.audio.filter((a) => a.role === 'sfx');
    expect(sfx.length).toBeGreaterThanOrEqual(24);                                           // 6 cuts; an 8-cut Reel lands ≥ 30
    expect(layers.length).toBe(sfx.length);
    for (const l of layers) expect(l.volume).toBe(0.55);
    const wordStarts = new Set<number>();
    for (const s of speech) { const cut = CUTS.find((c) => c.id === r.reels!.cutIds[speech.indexOf(s)])!; for (const w of cut.words) wordStarts.add(s.startMs + (w.fromMs - cut.startMs)); }
    const onWord = sfx.filter((x) => wordStarts.has(x.anchorMs) && x.anchorMs - x.atMs <= 4 * FRAME + 0.01 && x.atMs < x.anchorMs);
    expect(onWord.length / sfx.length).toBeGreaterThanOrEqual(0.9);
    for (const x of sfx) expect(x.anchorMs - x.atMs).toBe(Math.round(2 * FRAME) === x.anchorMs - x.atMs || x.anchorMs === x.atMs ? x.anchorMs - x.atMs : -1);
    // the ones not on a word are exactly the whooshes of the silent card and poster, at their scene starts
    expect(sfx.filter((x) => !wordStarts.has(x.anchorMs)).map((x) => [x.kind, x.atMs])).toEqual([['whoosh', r.scenes[2]!.startMs], ['whoosh', r.scenes[8]!.startMs]]);
    const whooshes = sfx.filter((x) => x.kind === 'whoosh');
    expect(whooshes.length).toBe(8);                                                        // every scene but the hold
    for (const s of speech) { const cut = CUTS.find((c) => c.id === r.reels!.cutIds[speech.indexOf(s)])!; expect(whooshes.some((x) => x.anchorMs === s.startMs + (cut.words[0]!.fromMs - cut.startMs))).toBe(true); }
    expect(sfx.filter((x) => x.kind === 'pop').length).toBe(9);                             // 3 chips + 3 rows (next words) + 3 bars (next words)
    const ticks = sfx.filter((x) => x.kind === 'tick');
    expect(ticks.length).toBe(3);                                                           // typing: the 3 words after "ketik", the ding on the 4th
    expect(sfx.filter((x) => x.kind === 'ding').length).toBe(1);
    expect(new Set(ticks.map((x, i, arr) => (i ? x.anchorMs - arr[i - 1]!.anchorMs : 0))).size).toBeGreaterThan(1);   // never an even grid
    expect(sfx.filter((x) => x.kind === 'rise').length).toBeGreaterThanOrEqual(3);
    // a chip pops when its word is said: "cuaca" of c1
    const cuaca = CUTS[0]!.words.find((w) => w.text.startsWith('cuaca'))!;
    const chip = sfx.find((x) => x.what === 'chip "Cuaca tak menentu"')!;
    expect(chip.anchorMs).toBe(r.scenes[0]!.startMs + (cuaca.fromMs - CUTS[0]!.startMs));
    expect(chip.atMs).toBe(chip.anchorMs - Math.round(2 * FRAME));
  });
  it('music: a 0.3 bed lifted 1.5× over exactly the silent scenes (card, hold, poster), 0.5 s in / 2.5 s out, as the music.generate step', () => {
    const mu = r.reels!.music!;
    expect(mu).toMatchObject({ volume: 0.3, liftOverSilent: 1.5, fadeInMs: 500, fadeOutMs: 2500, trackId: 'cc0-calm-01' });
    expect(mu.gain.map((g) => [g.atMs, g.durationMs, g.mul])).toEqual(silent.map((s) => [s.startMs, s.durationMs, 1.5]));
    expect(r.ops.some((o) => o.op === 'op:audio.addBed')).toBe(false);                   // the bed id is only known at Execute
  });
  it('poster: the image unchanged at 78 % of the width (fade-in, no scale) with the handle under it, last; the cover is resolved', () => {
    const img = m.tracks.overlay.find((o) => o.kind === 'image')!;
    expect(img.motion?.presetId).toBe('preset:motion.fade-in'); expect(img.motion!.durationMs).toBeLessThanOrEqual(Math.round(10 * FRAME));
    const last = r.scenes[8]!;
    expect(img.timing).toEqual({ atMs: last.startMs, durationMs: last.durationMs });
    expect(img.size.w).toBe(Math.round(f.w * 0.78));
    expect(img.size.w / f.w).toBeCloseTo(0.78, 3);
    const handle = m.tracks.text.find((t) => t.text === '@kopi.cerita' && t.timing.atMs >= last.startMs)!;
    const hb = textGeometry(handle, '9:16', m.theme.textDefaults).box, posterBottom = f.h / 2 + img.position.y + img.size.h / 2;
    expect(hb.y0).toBeGreaterThanOrEqual(posterBottom + 30 - 0.5);                      // fully under the poster, a small gap
    expect(hb.y1).toBeLessThanOrEqual(1850);
    expect(hb.x0).toBeGreaterThanOrEqual(0); expect(f.h / 2 + img.position.y - img.size.h / 2).toBeGreaterThanOrEqual(60);
    expect(r.reels?.cover).toMatchObject({ hookWord: 'NAIK', atMs: Math.round((CUTS[0]!.words[CUTS[0]!.words.length - 1]!.fromMs + CUTS[0]!.words[CUTS[0]!.words.length - 1]!.toMs) / 2) });
  });
  it('validation: the ops apply and validate without errors, the quality gate leaves no warning, risks carry no warn', () => {
    expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    expect(r.quality.remaining.filter((q) => q.severity === 'warn')).toEqual([]);
    expect(qualityCheck(m, { safeArea: reelsSafeArea(f) }).filter((q) => q.severity === 'warn' && !(q.code === 'outside-safe-area' && m.tracks.text.find((t) => t.id === q.ids[0])?.text === '@kopi.cerita'))).toEqual([]);
    expect(r.risks.filter((x) => x.severity === 'warn')).toEqual([]);
  });
  it('degrades honestly: unknown cut → scene skipped with a risk; no SFX assets → a warn risk and no sfx layers; no analysis → master-missing', () => {
    const bad = { ...SPEC, scenes: [{ role: 'talk', cut: 'zz' } as VideoSpecT['scenes'][number], ...SPEC.scenes.slice(1)] } as VideoSpecT;
    const { r: r2 } = composed(bad);
    expect(r2.scenes.length).toBe(8);
    expect(r2.risks.some((x) => x.code === 'unknown-cut')).toBe(true);
    const r3 = composeScenes(SPEC, { model: empty(), assets: ASSETS, tier: 'T1', footageAnalysis: ANALYSIS, sfxAssets: {} });
    expect(r3.ok && r3.risks.some((x) => x.code === 'sfx-unavailable') && r3.reels?.sfx.length === 0).toBe(true);
    const r4 = composeScenes({ ...SPEC, talkingHead: {} }, { model: empty(), assets: ASSETS.filter((a) => a.id !== 'MASTER'), tier: 'T1' });
    expect(r4.ok && r4.risks.some((x) => x.code === 'master-missing') && r4.scenes.length === 3).toBe(true);   // card, hold, poster stay
    const r5 = composeScenes({ ...SPEC, talkingHead: undefined }, { model: empty(), assets: ASSETS, tier: 'T1' });
    expect(r5.ok).toBe(false);
  });
});

describe('plan expansion: scene.compose (talking-head) → applyOps + music.generate (gain) + cover.render, credits on the step', () => {
  it('validatePlan yields a valid plan with the three steps and the credits', () => {
    const model = empty();
    const plan = EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'reel', status: 'draft', steps: [{ n: 1, tool: 'scene.compose', args: SPEC, expectedDiff: '' }] });
    const v = validatePlan(plan, { model, baseVersion: hashModel(model), assets: ASSETS, tier: 'T1', lockedKeys: [], newId, footageAnalysis: ANALYSIS, sfxAssets: SFX });
    expect(v.issues.filter((i) => i.severity === 'block')).toEqual([]);
    expect(v.plan.status).toBe('valid');
    expect(v.plan.steps.map((s) => s.tool)).toEqual(['composition.applyOps', 'music.generate', 'cover.render']);
    expect(v.plan.steps[0]!.args['credits']).toEqual(['Musik: pustaka CC0, trek cc0-calm-01']);
    const mu = v.plan.steps[1]!.args as { gain: Array<{ mul: number }>; fadeInMs: number; fadeOutMs: number; volume: number; trackId: string; status: string };
    expect(mu).toMatchObject({ volume: 0.3, fadeInMs: 500, fadeOutMs: 2500, trackId: 'cc0-calm-01', status: 'ready' });
    expect(mu.gain.length).toBe(3); expect(mu.gain.every((g) => g.mul === 1.5)).toBe(true);
    expect(v.plan.steps[2]!.args).toMatchObject({ spec: { hookWord: 'NAIK', line: 'Kenapa kopi makin mahal?', handle: '@kopi.cerita' }, masterAssetId: 'MASTER', status: 'ready' });
    expect(v.plan.steps[0]!.expectedDiff).toMatch(/6 potongan bicara/);
    expect(v.plan.steps.some((s) => s.tool === 'captions.generate' || s.tool === 'tts.generate')).toBe(false);   // pages are ops, no voice-over
  });
  it('explicit music.generate / cover.render steps beside the VideoSpec are merged into the generated ones (explicit args win), dependsOn follows', () => {
    const model = empty();
    const plan = EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'reel', status: 'draft', steps: [
      { n: 1, tool: 'scene.compose', args: SPEC, expectedDiff: '' },
      { n: 2, tool: 'music.generate', args: { prompt: 'tenang', trackId: 'cc0-other-07', volume: 0.25 }, expectedDiff: 'musik', dependsOn: [1] },
      { n: 3, tool: 'cover.render', args: { spec: { ...SPEC.cover, hookWord: 'MAHAL' } }, expectedDiff: 'cover', dependsOn: [1, 2] },
      { n: 4, tool: 'composition.applyOps', ops: [], args: {}, expectedDiff: 'after', dependsOn: [2, 3] }] });
    const v = validatePlan(plan, { model, baseVersion: hashModel(model), assets: ASSETS, tier: 'T1', lockedKeys: [], newId, footageAnalysis: ANALYSIS, sfxAssets: SFX });
    expect(v.plan.steps.map((s) => s.tool)).toEqual(['composition.applyOps', 'music.generate', 'cover.render', 'composition.applyOps']);
    const mu = v.plan.steps[1]!, cv = v.plan.steps[2]!;
    expect(mu.args).toMatchObject({ trackId: 'cc0-other-07', volume: 0.25, fadeInMs: 500, fadeOutMs: 2500, prompt: 'tenang' });
    expect((mu.args as { gain: unknown[] }).gain.length).toBe(3);
    expect((cv.args as { spec: { hookWord: string; atMs: number } }).spec).toMatchObject({ hookWord: 'MAHAL', atMs: Math.round((CUTS[0]!.words[CUTS[0]!.words.length - 1]!.fromMs + CUTS[0]!.words[CUTS[0]!.words.length - 1]!.toMs) / 2) });
    expect(v.plan.steps[3]!.dependsOn.sort()).toEqual([mu.n, cv.n].sort());
    expect(v.plan.risks.filter((x) => x.code === 'step-merged').length).toBe(2);
    expect(v.plan.status).toBe('valid');
  });
  it('a cover.render step with a bad spec is rejected with EM-2102', () => {
    const model = empty();
    const plan = EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'cover', status: 'draft', steps: [{ n: 1, tool: 'cover.render', args: { spec: { line: 'x' } }, expectedDiff: '' }] });
    const v = validatePlan(plan, { model, baseVersion: hashModel(model), assets: ASSETS, tier: 'T1', lockedKeys: [], newId });
    expect(v.issues.some((i) => i.code === 'EM-2102' && i.message.includes('cover.render'))).toBe(true);
  });
});

describe('cover still', () => {
  it('every text of the cover lies inside y 285 … 1635; the model applies (one muted master clip at the cut)', () => {
    const b = coverOps(SPEC.cover!, { cuts: CUTS, masterAssetId: 'MASTER' });
    expect(b.atMs).toBe(Math.round((CUTS[0]!.words[CUTS[0]!.words.length - 1]!.fromMs + CUTS[0]!.words[CUTS[0]!.words.length - 1]!.toMs) / 2));   // default 'end-of-line': inside the hook's last word
    expect(b.texts.map((t) => t.key)).toEqual(expect.arrayContaining(['kicker', 'line', 'hook', 'subline', 'pill:cuaca', 'handle']));
    for (const t of b.texts) { expect(t.box.y0).toBeGreaterThanOrEqual(COVER_BAND.top); expect(t.box.y1).toBeLessThanOrEqual(COVER_BAND.bottom); expect(t.box.x0).toBeGreaterThanOrEqual(0); expect(t.box.x1).toBeLessThanOrEqual(f.w); }
    // the face band (y 700 … 1300) is free: kicker / line / hook above it, subline / pills / handle below it
    for (const t of b.texts) expect(t.box.y1 <= COVER_FACE.bandTop + 0.5 || t.box.y0 >= COVER_FACE.bandBottom - 0.5).toBe(true);
    for (const k of ['kicker', 'line', 'hook']) expect(b.texts.find((t) => t.key === k)!.box.y1).toBeLessThanOrEqual(COVER_FACE.bandTop + 0.5);
    for (const k of ['subline', 'pill:cuaca', 'handle']) expect(b.texts.find((t) => t.key === k)!.box.y0).toBeGreaterThanOrEqual(COVER_FACE.bandBottom - 0.5);
    const hook = b.texts.find((t) => t.key === 'hook')!;
    expect(hook.box.y1 - hook.box.y0).toBeGreaterThanOrEqual(96);
    const model = composeCover(SPEC.cover!, ANALYSIS, 'MASTER');
    expect(model.tracks.video.length).toBe(1);
    expect(model.tracks.video[0]).toMatchObject({ assetId: 'MASTER', trimBeforeMs: Math.round((CUTS[0]!.words[CUTS[0]!.words.length - 1]!.fromMs + CUTS[0]!.words[CUTS[0]!.words.length - 1]!.toMs) / 2), muted: true, transform: { x: 0, scale: COVER_FACE.scale } });
    // the face (source y 0.33) lands at the band centre: centre + (0.33 − 0.5) × h × scale + shift = 1000
    expect(f.h / 2 + (COVER_FACE.y - 0.5) * f.h * COVER_FACE.scale + model.tracks.video[0]!.transform!.y * f.h).toBeCloseTo(COVER_FACE.bandCentre, 0);
    const bands = model.tracks.overlay.filter((o) => o.kind === 'shape' && o.presetId === 'preset:shape.rect');
    expect(bands.length).toBe(2);
    for (const o of bands) expect(o).toMatchObject({ fill: '#121F38', opacity: COVER_BAND_OPACITY });
    for (const o of bands) { const y0 = f.h / 2 + o.position.y - o.size.h / 2, y1 = y0 + o.size.h; expect(y1 <= COVER_FACE.bandTop + 0.5 || y0 >= COVER_FACE.bandBottom - 0.5).toBe(true); }
    expect(model.tracks.text.length).toBe(b.texts.length);
    expect(model.tracks.overlay.filter((o) => o.kind === 'shape' && o.presetId === 'preset:shape.icon').length).toBe(3);
    expect(validate(model, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
    expect(previewProfile()).toMatchObject({ resolution: '720p', ratio: '9:16', fps: 30, format: 'mp4' });
    expect(finalProfile({ fps: 25 })).toMatchObject({ resolution: '1080p', fps: 25 });
  });
});

describe('cover frame choice (QA A22: never mid-word)', () => {
  it("default 'end-of-line' = the middle of the last word; 'start' = 600 ms in; a number or atMs wins; no words → cut end − 100; unknown cut → null", () => {
    const c1 = CUTS[0]!, lastW = c1.words[c1.words.length - 1]!, lastMid = Math.round((lastW.fromMs + lastW.toMs) / 2);
    expect(coverAtMs({ cutId: 'c1' }, CUTS)).toBe(lastMid);
    expect(coverAtMs({ cutId: 'c1', frame: 'end-of-line' }, CUTS)).toBe(lastMid);
    expect(coverAtMs({ cutId: 'c1', frame: 'start' }, CUTS)).toBe(c1.startMs + 600);
    expect(coverAtMs({ cutId: 'c1', frame: 9000 }, CUTS)).toBe(9000);
    expect(coverAtMs({ cutId: 'c1', atMs: 8800, frame: 'start' }, CUTS)).toBe(8800);
    expect(coverAtMs({ cutId: 'c1' }, [{ ...c1, words: [] }])).toBe(c1.endMs - 100);
    expect(coverAtMs({ cutId: 'c1' }, [{ ...c1, endMs: lastMid - 40 }])).toBe(lastMid - 40);   // clamped inside the cut
    expect(coverAtMs({ cutId: 'zz' }, CUTS)).toBeNull();
    expect(coverAtMs({}, CUTS)).toBe(lastMid);                                              // no cutId: the first cut
    const { r: r2 } = composed({ ...SPEC, cover: { ...SPEC.cover!, frame: 'start' } } as VideoSpecT);
    expect(r2.reels?.cover?.atMs).toBe(c1.startMs + 600);
  });
});

describe('media tools, envelope block and prompt set', () => {
  it('media.frames belongs to the Brainstorming Agent, media.analyze and media.analysis.get to both; a picture in a tool result becomes an image part', async () => {
    expect(BRAINSTORM_TOOL_NAMES).toEqual(expect.arrayContaining(['media.analyze', 'media.frames', 'media.analysis.get']));
    expect(EDITOR_TOOL_NAMES).toContain('media.analysis.get');
    expect(EDITOR_TOOL_NAMES).toContain('media.analyze');   // QA 2026-10-30: a sync / rotation request to the Editor starts the prep instead of guessing
    expect(EDITOR_TOOL_NAMES).not.toContain('media.frames');
    const rec = await runTool('media.frames', { cutIds: ['c1', 'c2'] }, { 'media.frames': () => ({ imageBase64: 'QUJD', cells: [{ atMs: 8740, x: 0, y: 0 }] }) }, BRAINSTORM_TOOL_NAMES);
    expect(rec.ok).toBe(true);
    expect(rec.image).toEqual({ mediaType: 'image/jpeg', data: 'QUJD', name: 'contact-sheet.jpg' });
    expect(JSON.stringify(rec.output)).not.toContain('QUJD');
    const bad = await runTool('media.frames', {}, { 'media.frames': () => ({}) }, BRAINSTORM_TOOL_NAMES);
    expect(bad.ok).toBe(false);
    const denied = await runTool('media.frames', { cutIds: ['c1'] }, { 'media.frames': () => ({}) }, EDITOR_TOOL_NAMES);
    expect(denied.ok).toBe(false);
  });
  it('the envelope carries the compact analysis, the talking-head constraint + signature and the channel profile', () => {
    const model = empty();
    const env = buildRewriteEnvelope({ model, baseVersion: 'v', assets: ASSETS, intents: [], lockedKeys: [], tier: 'T1', creatorMessage: 'buat reelnya', footageAnalysis: ANALYSIS, channelProfile: 'Reels 9:16, handle @kopi.cerita, nada santai' });
    expect(env.footageAnalysis?.cuts.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    expect(env.footageAnalysis?.cuts[0]).toMatchObject({ startMs: 8140, text: CUTS[0]!.text, words: CUTS[0]!.words.length });
    expect(env.footageAnalysis?.dropped[0]?.reason).toBe('false-start');
    expect(env.constraints).toContain(TALKING_HEAD_CONSTRAINT);
    expect(env.capabilities.sceneCompose).toContain('TALKING-HEAD MODE');
    expect(env.channelProfile).toBe('Reels 9:16, handle @kopi.cerita, nada santai');
    const plain = buildRewriteEnvelope({ model, baseVersion: 'v', assets: ASSETS, intents: [], lockedKeys: [], tier: 'T1' });
    expect(plain.footageAnalysis).toBeUndefined(); expect(plain.capabilities.sceneCompose).not.toContain('TALKING-HEAD MODE');
  });
  it('prompt set v1.8.1: P-1 has the channel profile block and the PRD-first flow, P-2 the talking-head mode and cover.render', () => {
    expect(PROMPT_SET_VERSION).toBe('1.8.1');
    expect(BRAINSTORM_SYSTEM).toContain('{{channel_profile}}');
    expect(BRAINSTORM_SYSTEM).toContain('media.analyze');
    expect(BRAINSTORM_SYSTEM).toContain('PRD siap');
    expect(EDITOR_SYSTEM).toContain('TALKING-HEAD');
    expect(EDITOR_SYSTEM).toContain('cover.render');
    expect(EDITOR_SYSTEM).toContain('media.analysis.get');
    expect(EDITOR_SYSTEM).not.toMatch(/nuklir|SMR/i);
  });
});
