// FR-261 / FR-262 / FR-266 (Operator 2026-10-29): the Creator's own footage as the base of an automatic edit — footage scenes
// (full frame with overlays in the thirds, split, picture-in-picture), source trims, anchors to the footage ({footageMs}, {say}),
// ducked footage sound under a voice-over, kinetic captions from the footage audio, a ducked CC0 music bed, and the envelope the
// Editor plans from (transcripts, the footage constraint). Golden: test/fixtures/footage-spec.json over the fixture clips' facts.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, createEmptyModel, deriveTiming, frameInUnits, hashModel, textGeometry, validate, type AssetFacts, type CompositionModelT, type Ratio } from '@expertmotion/composition-model';
import { buildRewriteEnvelope, composeScenes, EditPlan, findSaid, FOOTAGE_CONSTRAINT, normalizeVideoSpec, validatePlan, type ComposeOk, type VideoSpecT } from '../src/index.js';

const SPEC = JSON.parse(fs.readFileSync(new URL('./fixtures/footage-spec.json', import.meta.url), 'utf8')) as VideoSpecT;
const words = (from: number, text: string, step = 400) => text.split(' ').map((w, k) => ({ text: w, fromMs: from + k * step, toMs: from + (k + 1) * step - 40 }));
/** Facts as the Service reports them for the fixture clips (test/fixtures/media) imported as "wawancara.mp4" / "kebun.mp4". */
const ASSETS: AssetFacts[] = [
  { id: 'A1', kind: 'video', status: 'ready', name: 'wawancara.mp4', durationMs: 42_000, width: 640, height: 360, hasAudio: true,
    transcript: { language: 'id', segments: [{ text: 'eh oke mulai ya', fromMs: 0, toMs: 3500 }, { text: 'nama saya Rina saya petani kopi di Temanggung', fromMs: 5000, toMs: 8600 }, { text: 'kebun kami panen seribu dua ratus kilo per musim', fromMs: 25_000, toMs: 29_000 }],
      words: [...words(0, 'eh oke mulai ya'), ...words(5000, 'nama saya Rina saya petani kopi di Temanggung'), ...words(25_000, 'kebun kami panen seribu dua ratus kilo per musim')] } },
  { id: 'A2', kind: 'video', status: 'ready', name: 'kebun.mp4', durationMs: 12_000, width: 360, height: 640, hasAudio: false },
  { id: 'IMG', kind: 'image', status: 'ready', name: 'logo.png', width: 512, height: 512 },
];
let n = 0; const newId = () => `f${++n}`;
const empty = (ratio: Ratio) => createEmptyModel('p', { autoRatio: false, ratio });
function composed(spec: VideoSpecT, ratio: Ratio, assets = ASSETS): { r: ComposeOk; m: CompositionModelT } {
  const model = empty(ratio);
  const r = composeScenes({ ...spec, ratio: ratio as VideoSpecT['ratio'] }, { model, assets, tier: 'T1' });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets, tier: 'T1', newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues));
  return { r, m: a.value.model };
}
function boxes(m: CompositionModelT) {
  const f = frameInUnits(m.settings.ratio);
  return [
    ...m.tracks.text.map((t) => ({ id: t.id, kind: 'text', text: t.text, from: t.timing.atMs, to: t.timing.atMs + t.timing.durationMs, box: textGeometry(t, m.settings.ratio, m.theme.textDefaults).box })),
    ...m.tracks.overlay.map((o) => ({ id: o.id, kind: o.kind, text: '', from: o.timing.atMs, to: o.timing.atMs + o.timing.durationMs,
      box: { x0: f.w / 2 + o.position.x - o.size.w / 2, y0: f.h / 2 + o.position.y - o.size.h / 2, x1: f.w / 2 + o.position.x + o.size.w / 2, y1: f.h / 2 + o.position.y + o.size.h / 2 } })),
  ];
}

describe('golden: "Kopi dari lereng Sindoro" from two clips of footage', () => {
  for (const ratio of ['9:16', '16:9'] as Ratio[]) {
    it(`${ratio}: footage is the base (trimmed clips in story order, designed scenes intercut), transitions on every cut, valid`, () => {
      const { r, m } = composed(SPEC, ratio);
      expect(validate(m, { assets: ASSETS, tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
      // hook (scene) · A1 3.5 s… · A2 split · A1 24 s… · A2 pip · cta (scene)
      expect(m.tracks.video.map((c) => c.assetId ?? 'scene')).toEqual(['scene', 'A1', 'A2', 'A1', 'A2', 'scene']);
      expect(m.tracks.video.map((c) => c.trimBeforeMs)).toEqual([0, 3500, 0, 24_000, 8000, 0]);
      // every footage clip stays inside its window of the source (incl. the outgoing transition)
      const win: Record<number, number> = { 1: 15_500, 2: 8000, 3: 16_000, 4: 4000 };
      for (const [i, max] of Object.entries(win)) expect(m.tracks.video[Number(i)]!.durationMs).toBeLessThanOrEqual(max);
      expect(m.transitions.map((t) => t.cutIndex)).toEqual([0, 1, 2, 3, 4]);
      // no voice-over: the footage keeps its own sound
      expect(m.tracks.video[1]!.volume).toBe(1);
      expect(r.footage.map((x) => [x.assetId, x.hasAudio])).toEqual([['A1', true], ['A2', false], ['A1', true], ['A2', false]]);
      expect(deriveTiming(m).durationMs).toBe(r.totalMs);
      expect(r.risks.filter((x) => x.severity === 'warn')).toEqual([]);
    });
    it(`${ratio}: overlays on full-frame footage stay in the top / bottom third, a few seconds each, inside the frame`, () => {
      const { r, m } = composed(SPEC, ratio);
      const f = frameInUnits(m.settings.ratio);
      const footageScenes = r.scenes.map((s, i) => ({ ...s, i })).filter((s) => s.role === 'footage');
      const on = boxes(m).filter((b) => footageScenes.some((s) => b.from >= s.startMs - 1 && b.from < s.startMs + s.durationMs));
      expect(on.length).toBeGreaterThan(5);
      for (const b of on) {
        const inThirds = b.box.y1 <= f.h * 0.42 || b.box.y0 >= f.h * 0.58;
        expect({ text: b.text, kind: b.kind, inThirds }).toEqual({ text: b.text, kind: b.kind, inThirds: true });
        expect(b.to - b.from).toBeLessThanOrEqual(6000);
        expect(b.box.x0).toBeGreaterThanOrEqual(-1); expect(b.box.x1).toBeLessThanOrEqual(f.w + 1);
        expect(b.box.y0).toBeGreaterThanOrEqual(-1); expect(b.box.y1).toBeLessThanOrEqual(f.h + 1);
      }
      // nothing is on screen over the footage centre band for long
      const centre = on.filter((b) => b.box.y0 < f.h * 0.58 && b.box.y1 > f.h * 0.42);
      expect(centre).toEqual([]);
    });
    it(`${ratio}: the lower-third appears when the speaker says "nama saya" (transcript anchor), the stat callout carries its source`, () => {
      const { r, m } = composed(SPEC, ratio);
      const clip = r.scenes[1]!;
      const name = m.tracks.text.find((t) => t.text === 'Rina')!;
      // "nama" is said at 5.0 s of the source; the clip starts at 3.5 s → 1.5 s into the scene (+200 ms text after its panel)
      expect(name.timing.atMs).toBe(clip.startMs + 1500 + 200);
      expect(m.tracks.text.find((t) => t.text === 'Petani kopi, Temanggung')).toBeDefined();
      const stat = m.tracks.text.find((t) => t.text === '1.200')!;
      expect(stat.effect?.presetId).toBe('preset:texteffect.counter');
      const src = m.tracks.text.find((t) => t.text.startsWith('Sumber: wawancara'))!;
      expect(src.timing.atMs).toBeLessThanOrEqual(stat.timing.atMs);
      expect(src.style.fontSize).toBeGreaterThanOrEqual(34);
    });
  }
  it('9:16 split: footage on the top half (crop + offset), texts on the bottom half; pip: a window with an outline frame, texts below it', () => {
    const { r, m } = composed(SPEC, '9:16');
    const f = frameInUnits('9:16');
    expect(m.tracks.video[2]!.crop).toEqual({ left: 0, right: 0, top: 0.25, bottom: 0.25 });
    expect(m.tracks.video[2]!.transform).toMatchObject({ y: -0.25, scale: 1 });
    const s2 = r.scenes[2]!, s4 = r.scenes[4]!;
    const during = (s: typeof s2) => boxes(m).filter((b) => b.from >= s.startMs - 1 && b.from < s.startMs + s.durationMs);
    for (const b of during(s2)) expect(b.box.y0).toBeGreaterThanOrEqual(f.h / 2);
    const pip = m.tracks.video[4]!;
    expect(pip.transform?.scale).toBeCloseTo(0.42, 2);
    const win = { y1: f.h / 2 + pip.transform!.y * f.h + (f.h * 0.42) / 2 };
    for (const b of during(s4).filter((x) => x.kind === 'text')) expect(b.box.y0).toBeGreaterThanOrEqual(win.y1);
    expect(m.tracks.overlay.some((o) => o.kind === 'shape' && o.params['outline'] === true && o.timing.atMs >= s4.startMs && o.timing.atMs < s4.startMs + 1000)).toBe(true);
  });
  it('16:9 split: footage on the left half, texts on the right half', () => {
    const { r, m } = composed(SPEC, '16:9');
    const f = frameInUnits('16:9');
    expect(m.tracks.video[2]!.crop).toEqual({ left: 0.25, right: 0.25, top: 0, bottom: 0 });
    expect(m.tracks.video[2]!.transform).toMatchObject({ x: -0.25 });
    const s2 = r.scenes[2]!;
    for (const b of boxes(m).filter((x) => x.from >= s2.startMs - 1 && x.from < s2.startMs + s2.durationMs)) expect(b.box.x0).toBeGreaterThanOrEqual(f.w / 2);
  });
  it('a voice-over ducks the footage sound to 0.2 and the captions follow the voice; captions without a voice come from the footage audio', () => {
    const voiced: VideoSpecT = { ...SPEC, voice: { clips: [{ id: 'v1', text: 'Ini cerita Rina, petani kopi di Temanggung.' }] }, scenes: SPEC.scenes.map((s, i) => (i === 1 ? { ...s, clips: ['v1'] } : s)) };
    const { m } = composed(voiced, '9:16');
    expect(m.tracks.video[1]!.volume).toBe(0.2);
    const model = empty('9:16');
    const plan = (spec: VideoSpecT) => EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'footage', status: 'draft', steps: [{ n: 1, tool: 'scene.compose', args: spec, expectedDiff: '' }] });
    const ctx = { model, baseVersion: hashModel(model), assets: ASSETS, tier: 'T1' as const, lockedKeys: [], newId };
    const a = validatePlan(plan(SPEC), ctx);
    expect(a.plan.status).toBe('valid');
    expect(a.plan.steps.map((s) => s.tool)).toEqual(['composition.applyOps', 'captions.generate', 'music.generate']);
    expect(a.plan.steps[1]!.args).toMatchObject({ source: 'sequence', presetId: 'preset:caption.karaoke' });
    expect(a.plan.steps[2]!.args).toMatchObject({ prompt: 'calm, akustik hangat', status: 'ready' });
    expect(a.plan.steps[2]!.args['durationMs']).toBeGreaterThan(20_000);
    const b = validatePlan(plan(voiced), ctx);
    expect(b.plan.steps.map((s) => s.tool)).toEqual(['composition.applyOps', 'tts.generate', 'captions.generate', 'music.generate']);
    expect(b.plan.steps[2]!.args['source']).toBe('voice');
  });
  it('missing / wrong assets and footage shorter than the voice are risks, never invented clips', () => {
    const r = composeScenes({ scenes: [{ role: 'footage', footage: { assetId: 'NOPE' }, headline: 'Halo' }, { role: 'footage', footage: { assetId: 'IMG' } }] }, { model: empty('9:16'), assets: ASSETS });
    expect(r.ok && r.ops.filter((o) => o.op === 'op:clip.insert')).toEqual([]);
    expect(r.ok && r.risks.filter((x) => x.code === 'footage-missing')).toHaveLength(2);
    const long = composeScenes({ voice: { clips: [{ id: 'v1', text: Array(60).fill('kata').join(' ') }] }, scenes: [{ role: 'footage', clips: ['v1'], footage: { assetId: 'A2', fromMs: 0, toMs: 4000 } }] }, { model: empty('9:16'), assets: ASSETS });
    expect(long.ok && long.risks.map((x) => x.code)).toContain('footage-shorter');
    expect(long.ok && long.ops.find((o) => o.op === 'op:clip.insert')!.args['durationMs']).toBeLessThanOrEqual(4000);
    const nosrc = composeScenes({ scenes: [{ role: 'footage', footage: { assetId: 'A1' }, stats: [{ value: '45%' }] }] }, { model: empty('9:16'), assets: ASSETS });
    expect(nosrc.ok && nosrc.risks.map((x) => x.code)).toContain('no-source');
  });
  it('anchors: {footageMs} maps source time onto the timeline; {say} not in the transcript falls back with an info risk', () => {
    const r = composeScenes({ scenes: [{ role: 'footage', footage: { assetId: 'A1', fromMs: 10_000, toMs: 30_000 }, lowerThird: { name: 'Rina', at: { footageMs: 12_500 } }, headline: { text: 'Judul', at: { say: 'tidak ada' } } }] }, { model: empty('9:16'), assets: ASSETS });
    if (!r.ok) throw new Error(r.problem);
    const name = r.ops.find((o) => o.op === 'op:text.add' && o.args['text'] === 'Rina')!;
    expect(name.args['atMs']).toBe(2500 + 200);
    expect(r.risks.map((x) => x.code)).toContain('say-not-found');
    expect(findSaid(ASSETS[0]!.transcript!.words!, 'Nama saya', 0, 42_000)).toBe(5000);
    expect(findSaid(ASSETS[0]!.transcript!.words!, 'nama saya', 6000, 20_000)).toBeNull();
  });
  it('normalises model slips for footage: role aliases, string trims', () => {
    const v = normalizeVideoSpec({ scenes: [{ role: 'picture-in-picture', footage: { assetId: 'A1', fromMs: '1500', toMs: '9000' } }, { role: 'b-roll' }, { role: 'split footage' }] });
    expect(v.value).toMatchObject({ scenes: [{ role: 'footage-pip', footage: { fromMs: 1500, toMs: 9000 } }, { role: 'footage' }, { role: 'footage-split' }] });
  });
  it('the Editor envelope lists what the footage says (source time) and the footage rule', () => {
    const env = buildRewriteEnvelope({ model: empty('9:16'), baseVersion: 'h', assets: ASSETS, intents: [], lockedKeys: [], tier: 'T1', creatorMessage: 'buat video dari footage ini dengan teks dan grafik yang sesuai' });
    const a1 = env.assets.find((a) => a.id === 'A1')!;
    expect(a1.transcript?.[1]).toBe('[0:05.0–0:08.6] nama saya Rina saya petani kopi di Temanggung');
    expect(env.assets.find((a) => a.id === 'A2')!.transcript).toBeUndefined();
    expect(env.constraints).toContain(FOOTAGE_CONSTRAINT);
    expect(env.capabilities.sceneCompose).toMatch(/footage-pip/);
  });
});
