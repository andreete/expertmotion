// ADR-034 (FR-230 … FR-244): the deterministic scene composer, its plan step and the quality gate.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, autoFixOps, boxesOverlap, createEmptyModel, deriveTiming, frameInUnits, hashModel, qualityCheck, textGeometry, validate, type CompositionModelT, type Ratio } from '@expertmotion/composition-model';
import { composeScenes, EditPlan, narrationMs, normalizeVideoSpec, parseLoose, formatIdNumber, validatePlan, type ComposeOk, type VideoSpecT } from '../src/index.js';

const fixture = (f: string) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8')) as VideoSpecT;
const DATA_CENTER = fixture('data-center-spec.json');
const NIKEL = fixture('nikel-spec.json');
let n = 0; const newId = () => `m${++n}`;
const empty = (ratio: Ratio = '9:16') => createEmptyModel('p', { autoRatio: false, ratio });
function composed(spec: VideoSpecT, ratio: Ratio = '9:16'): { r: ComposeOk; m: CompositionModelT } {
  const model = empty(ratio);
  const r = composeScenes({ ...spec, ratio: ratio as VideoSpecT['ratio'] }, { model, assets: [], tier: 'T1' });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets: [], tier: 'T1', newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues));
  return { r, m: a.value.model };
}
/** Painted boxes of the model's texts / shapes per scene window (the same estimator the Engine renders with). */
function boxesOf(m: CompositionModelT) {
  const f = frameInUnits(m.settings.ratio);
  return [
    ...m.tracks.text.map((t) => ({ id: t.id, kind: 'text' as const, from: t.timing.atMs, to: t.timing.atMs + t.timing.durationMs, box: textGeometry(t, m.settings.ratio, m.theme.textDefaults).box, motion: t.motion })),
    ...m.tracks.overlay.map((o) => ({ id: o.id, kind: o.kind, from: o.timing.atMs, to: o.timing.atMs + o.timing.durationMs, motion: o.motion,
      box: { x0: f.w / 2 + o.position.x - o.size.w / 2, y0: f.h / 2 + o.position.y - o.size.h / 2, x1: f.w / 2 + o.position.x + o.size.w / 2, y1: f.h / 2 + o.position.y + o.size.h / 2 } })),
  ];
}

describe('golden: "Peluang Bisnis Data Center di Indonesia" (~80 words) → composed ops', () => {
  const words = DATA_CENTER.scenes.map((s) => s.narration ?? '').join(' ').split(/\s+/).filter(Boolean).length;
  it('the script is about 80 words', () => expect(words).toBeGreaterThanOrEqual(70));
  for (const ratio of ['9:16', '16:9', '1:1', '4:5'] as Ratio[]) {
    it(`${ratio}: valid model, no overlap within a scene, inside the safe area, entrances everywhere, transitions on every cut, duration follows the narration`, () => {
      const { r, m } = composed(DATA_CENTER, ratio);
      // valid (no blocking issue) and 6 scene clips with a transition on every cut
      expect(validate(m, { assets: [], tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
      expect(m.tracks.video).toHaveLength(6);
      expect(m.transitions.map((t) => t.cutIndex)).toEqual([0, 1, 2, 3, 4]);
      expect(new Set(m.transitions.map((t) => t.presetId)).size).toBeGreaterThan(1);       // varied, not the same every time
      for (let i = 1; i < m.transitions.length; i++) expect(m.transitions[i]!.presetId).not.toBe(m.transitions[i - 1]!.presetId);
      // every text / shape enters with motion; nothing piles up: pairwise no overlap of elements visible together
      const items = boxesOf(m);
      expect(items.length).toBeGreaterThan(12);
      for (const x of items) expect(x.motion, x.id).not.toBeNull();
      for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
        const a = items[i]!, b = items[j]!;
        if (Math.min(a.to, b.to) - Math.max(a.from, b.from) <= 600) continue;          // different scenes (crossfade < 600 ms)
        expect(boxesOverlap(a.box, b.box, -2), `${a.id} vs ${b.id}`).toBe(false);
      }
      // inside the content safe area
      const f = frameInUnits(ratio), s = r.safeArea;
      for (const x of items) {
        expect(x.box.x0, x.id).toBeGreaterThanOrEqual(s.left - 4); expect(x.box.y0, x.id).toBeGreaterThanOrEqual(s.top - 4);
        expect(x.box.x1, x.id).toBeLessThanOrEqual(f.w - s.right + 4); expect(x.box.y1, x.id).toBeLessThanOrEqual(f.h - s.bottom + 4);
      }
      // elements live inside their scene's time span (+ the exit overlap into the next scene's transition)
      for (const x of items) expect(x.to).toBeLessThanOrEqual(r.totalMs);
      // duration: every scene at least as long as its narration (~150 wpm); total = Σ scenes = the derived video length
      for (const sc of r.scenes) expect(sc.durationMs).toBeGreaterThanOrEqual(sc.narrationMs);
      expect(deriveTiming(m).durationMs).toBe(r.totalMs);
      expect(r.totalMs).toBe(r.scenes.reduce((a, sc) => a + sc.durationMs, 0));
      expect(r.narrationEstimateMs).toBe(DATA_CENTER.scenes.reduce((a, sc) => a + narrationMs(sc.narration), 0));
      expect(r.totalMs).toBeLessThan(r.narrationEstimateMs * 1.6 + 6 * 2500);
      // the quality gate leaves no warning
      expect(qualityCheck(m, { safeArea: s }).filter((q) => q.severity === 'warn')).toEqual([]);
    });
  }
  it('is deterministic (same spec → same ops)', () => {
    const a = composeScenes(DATA_CENTER, { model: empty(), assets: [] }), b = composeScenes(DATA_CENTER, { model: empty(), assets: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('explicit spec mode: the "Ekspor Nikel Indonesia 2026" prompt (QA 2026-10-28 reference)', () => {
  const { r, m } = composed(NIKEL);
  const text = (t: string) => m.tracks.text.find((x) => x.text === t)!;
  it('scene length = Σ clip durations + 0.3 s gaps + 0.5 s tail (1 s after the last clip); 6 scenes, crossfades of 14 frames', () => {
    expect(r.scenes.map((s) => s.durationMs)).toEqual([2600 + 300 + 2900 + 500, 5200 + 500, 3100 + 300 + 2500 + 500, 2700 + 300 + 2000 + 500, 4300 + 500, 3300 + 1000]);
    expect(m.transitions.every((t) => t.presetId === 'preset:transition.fade' && t.durationMs === 467)).toBe(true);
    expect(r.voice.map((v) => v.atMs)).toEqual([0, 2900, 6300, 12000, 15400, 18400, 21400, 23900, 28700]);
    expect(r.risks.map((x) => x.code)).not.toContain('timing-estimated');   // durations given (measured) → no estimate
    const est = composeScenes({ ...NIKEL, voice: { clips: NIKEL.voice!.clips.map(({ durationMs: _d, ...c }) => c) } }, { model: empty(), assets: [] });
    expect(est.ok && est.risks.map((x) => x.code)).toContain('timing-estimated');
  });
  it('exact sizes, weights and colours win over the defaults; Inter, solid #0F1A1F background', () => {
    expect(text('+17,2%').style).toMatchObject({ fontSize: 240, weight: 500, colour: '#5DCAA5', fontFamily: 'Inter' });
    expect(text('−3,8%').style).toMatchObject({ fontSize: 176, colour: '#F0997B' });
    expect(text('nilai ekspor naik').style).toMatchObject({ fontSize: 72, colour: '#FFFFFF' });
    expect(text('Ini benar-benar nilai tambah, atau sekadar harga naik?').style).toMatchObject({ fontSize: 104, weight: 500, lineHeight: 1.3 });
    expect(m.background).toEqual({ presetId: 'preset:background.solid', params: expect.objectContaining({ colourA: '#0F1A1F' }) });
    expect(m.tracks.video.every((c) => c.scene?.params['colourA'] === '#0F1A1F')).toBe(true);
  });
  it('counters: +0,0% → +17,2% in 42 frames out-cubic; 0,00 → 25,96 in 54 frames', () => {
    expect(text('+17,2%').effect).toMatchObject({ presetId: 'preset:texteffect.counter', params: { from: 0, durationMs: 1400, easingId: 'preset:easing.out-cubic' } });
    expect(text('25,96').effect).toMatchObject({ presetId: 'preset:texteffect.counter', params: { from: 0, durationMs: 1800 } });
    expect(text('−3,8%').effect).toBeNull();
  });
  it('audio anchors: "saat v2 mulai" and "60% durasi v3"', () => {
    expect(text('−3,8%').timing.atMs).toBe(2900);
    expect(text('tapi volumenya turun').timing.atMs).toBe(2900);
    expect(text('setara Rp472 triliun').timing.atMs).toBe(6300 + Math.round(0.6 * 5200));
    expect(text('@septianusanggaw').timing.atMs).toBe(28700);
  });
  it('bars: heights 60 / 460 / 800 on one baseline, gap 56, target dashed 8 px border, grow with bezier(0.2, 0.8, 0.2, 1) over 36 frames', () => {
    const bars = m.tracks.overlay.filter((o) => o.kind === 'shape' && o.timing.atMs >= 12_000 && o.timing.atMs < 18_400);
    expect(bars.map((b) => b.size.h)).toEqual([60, 460, 800]);
    const bottoms = bars.map((b) => b.position.y + b.size.h / 2);
    expect(new Set(bottoms.map((x) => Math.round(x))).size).toBe(1);
    expect(bars[1]!.position.x - bars[0]!.position.x - bars[0]!.size.w).toBeCloseTo(56, 0);
    expect(bars[2]).toMatchObject({ stroke: '#EF9F27', strokeWidth: 8, params: { outline: true, dashU: 24 } });
    expect(bars[0]!.motion).toMatchObject({ presetId: 'preset:motion.grow', durationMs: 1200, params: { direction: 'up', bezier: [0.2, 0.8, 0.2, 1] } });
    expect(bars[2]!.timing.atMs).toBe(15_400);
    expect(r.risks.map((x) => x.code)).not.toContain('bars-scaled');
  });
  it('safe zone 88 / 160 / 120 / 440: everything inside; every source line ends 440 px above the bottom; CTA pill', () => {
    const f = frameInUnits('9:16');
    for (const x of boxesOf(m)) { expect(x.box.x0).toBeGreaterThanOrEqual(88 - 1); expect(x.box.x1).toBeLessThanOrEqual(f.w - 160 + 1); expect(x.box.y0).toBeGreaterThanOrEqual(120 - 1); expect(x.box.y1).toBeLessThanOrEqual(f.h - 440 + 1); }
    for (const src of m.tracks.text.filter((t) => t.text.startsWith('Sumber') || t.text.startsWith('Hitungan'))) {
      const g = textGeometry(src, '9:16', m.theme.textDefaults);
      expect(g.box.y1).toBeCloseTo(f.h - 440, 0);
      expect(g.fontSizeU).toBeGreaterThanOrEqual(34);
      const scene = r.scenes.find((s) => src.timing.atMs >= s.startMs && src.timing.atMs < s.startMs + s.durationMs)!;
      expect(src.timing.atMs).toBe(scene.startMs);                                         // visible for the whole scene
    }
    expect(text('@septianusanggaw').style.box).toEqual({ colour: '#1D9E75', padX: 72, padY: 40, radius: 999 });
    expect(text('@septianusanggaw').motion).toMatchObject({ presetId: 'preset:motion.pop', params: { damping: 14 } });
  });
  it('crossfade-rise: every element rises 56 px over 14 frames and fades out on the next scene\'s first frames', () => {
    const k = text('Ekspor nikel Indonesia, Jan–Agu 2026');
    expect(k.motion).toMatchObject({ presetId: 'preset:motion.rise', durationMs: 467, easingId: 'preset:easing.out-cubic', params: { distanceU: 56, exitStyle: 'fade', exitMs: 467 } });
    expect(k.timing.atMs + k.timing.durationMs).toBe(6300 + 467);
  });
  it('never invents a figure: a stat scene without stats renders no number and reports it', () => {
    const r2 = composeScenes({ scenes: [{ role: 'stat', kicker: 'Pertumbuhan ekonomi digital' }] }, { model: empty(), assets: [] });
    expect(r2.ok && r2.ops.filter((o) => o.op === 'op:text.add').map((o) => o.args['text'])).toEqual(['Pertumbuhan ekonomi digital']);
    expect(r2.ok && r2.risks.map((x) => x.code)).toEqual(expect.arrayContaining(['no-figure']));
  });
});

describe('scene.compose plan step', () => {
  it('expands into composition.applyOps + one tts.generate per voice clip, validates, and is idempotent on re-validation (Execute)', () => {
    const model = empty();
    const plan = EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'Video nikel', status: 'draft',
      steps: [{ n: 1, tool: 'scene.compose', args: NIKEL, expectedDiff: '' }] });
    const ctx = { model, baseVersion: hashModel(model), assets: [], tier: 'T1' as const, lockedKeys: [], newId };
    const v = validatePlan(plan, ctx);
    expect(v.plan.status).toBe('valid');
    expect(v.plan.steps.map((s) => s.tool)).toEqual(['composition.applyOps', ...Array(9).fill('tts.generate')]);
    expect(v.plan.steps[1]!.args).toMatchObject({ text: 'Ekspor nikel Indonesia naik tujuh belas persen.', atMs: 0 });
    expect(v.plan.steps[0]!.expectedDiff).toMatch(/6 adegan/);
    const again = validatePlan({ ...v.plan, status: 'draft' }, ctx);
    expect(again.plan.status).toBe('valid');
    expect(again.plan.steps[0]!.ops).toEqual(v.plan.steps[0]!.ops);
  });
  it('op:scene.compose inside composition.applyOps is expanded in place; a bad spec blocks with a correction message', () => {
    const model = empty();
    const mk = (args: unknown) => EditPlan.parse({ id: 'pl', projectId: 'p', baseVersion: hashModel(model), origin: 'editor-agent', goal: 'x', status: 'draft',
      steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:scene.compose', args }], expectedDiff: '' }] });
    const ctx = { model, baseVersion: hashModel(model), assets: [], tier: 'T1' as const, lockedKeys: [], newId };
    expect(validatePlan(mk({ scenes: [{ role: 'hook', headline: 'Halo' }], voice: { clips: [], generate: false } }), ctx).plan.status).toBe('valid');
    const bad = validatePlan(mk({ scenes: [] }), ctx);
    expect(bad.plan.status).toBe('invalid');
    expect(bad.issues[0]!.message).toMatch(/VideoSpec/);
  });
  it('normalises model slips: string numbers, "#"-less colours, bezier strings, role aliases', () => {
    const n2 = normalizeVideoSpec({ style: { background: '0f1a1f' }, scenes: [{ role: 'stat-counter', topPx: '280', stats: [{ value: '+1%', easing: 'bezier(0.2, 0.8, 0.2, 1)' }] }] });
    expect(n2.value).toMatchObject({ style: { background: '#0f1a1f' }, scenes: [{ role: 'stat', topPx: 280, stats: [{ easing: [0.2, 0.8, 0.2, 1] }] }] });
  });
  it('Indonesian number helpers', () => {
    expect(parseLoose('+0,0%')).toBe(0); expect(parseLoose('1.200 MW')).toBe(1200); expect(parseLoose('−3,8%')).toBe(-3.8); expect(parseLoose('25,96')).toBe(25.96);
    expect(formatIdNumber(25.96)).toBe('25,96'); expect(formatIdNumber(1200)).toBe('1.200');
  });
});

describe('quality gate (qualityCheck + autoFixOps) and automatic text stacking', () => {
  const ctx = { assets: [], tier: 'T1' as const, newId };
  it('two texts added without a position at the same time no longer pile up in the middle (QA #19)', () => {
    const r = applyOperations(empty(), [
      { op: 'op:text.add', args: { text: 'Kunci Baterai Dunia: Nikel', variant: 'preset:text.title', atMs: 0, durationMs: 3000 } },
      { op: 'op:text.add', args: { text: 'Ekspor Nikel Indonesia 2026', variant: 'preset:text.title', atMs: 0, durationMs: 3000 } },
      { op: 'op:text.add', args: { text: 'Indonesia pegang kunci baterai', variant: 'preset:text.title', atMs: 500, durationMs: 3000 } }], ctx);
    expect(r.ok).toBe(true);
    const m = r.ok ? r.value.model : empty();
    expect(qualityCheck(m).filter((q) => q.code === 'overlap')).toEqual([]);
    expect(m.tracks.text.every((t) => t.motion !== null)).toBe(true);                    // default entrance from the variant
  });
  it('detects overlap, low contrast, a missing font and off-safe text; autoFixOps repairs them and the check passes', () => {
    const r = applyOperations(empty(), [
      { op: 'op:text.add', args: { text: 'Judul pertama', variant: 'preset:text.title', atMs: 0, durationMs: 3000, position: { x: 0, y: 0 } } },
      { op: 'op:text.add', args: { text: 'Judul kedua', variant: 'preset:text.subtitle', atMs: 200, durationMs: 3000, position: { x: 0, y: 10 }, styleOverrides: { colour: '#15130F', fontFamily: 'Comic Sans' } } },
      { op: 'op:text.add', args: { text: 'Di pojok', variant: 'preset:text.subtitle', atMs: 0, durationMs: 3000, position: { x: 0, y: 900 } } }], ctx);
    expect(r.ok).toBe(true);
    const m = r.ok ? r.value.model : empty();
    const issues = qualityCheck(m);
    expect(new Set(issues.map((q) => q.code))).toEqual(new Set(['overlap', 'low-contrast', 'font-missing', 'outside-safe-area']));
    const fixed = applyOperations(m, autoFixOps(m, issues), ctx);
    expect(fixed.ok).toBe(true);
    expect(qualityCheck(fixed.ok ? fixed.value.model : m).filter((q) => q.severity === 'warn')).toEqual([]);
  });
  it('a shape added without motion gets the automatic entrance; preset:motion.none keeps it static', () => {
    const r = applyOperations(empty(), [
      { op: 'op:shape.add', args: { presetId: 'preset:shape.circle', atMs: 0, durationMs: 2000 } },
      { op: 'op:shape.add', args: { presetId: 'preset:shape.ring', atMs: 0, durationMs: 2000, position: { x: 0, y: 400 } } },
      { op: 'op:shape.add', args: { presetId: 'preset:shape.rect', atMs: 0, durationMs: 2000, position: { x: 0, y: -400 }, motion: { presetId: 'preset:motion.none' } } }], ctx);
    expect(r.ok && r.value.model.tracks.overlay.map((o) => o.motion?.presetId ?? null)).toEqual(['preset:motion.pop', 'preset:motion.draw-on', null]);
  });
});
