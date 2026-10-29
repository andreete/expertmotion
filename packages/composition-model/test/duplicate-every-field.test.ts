// Round 2 (QA 2026-10-29): Duplicate and Copy / Paste of a VIDEO clip lost volume, fades, motion, effects and framing (no add op
// carried them) and AUDIO clips could not be duplicated. op:clip.insert / op:scene.add take the clip look and op:audio.addLayer
// takes trim / length / loop / ducking, so duplicate(x) equals x except id and timing for every element kind.
import { describe, expect, it } from 'vitest';
import { copySnapshot, createEmptyModel, DUPLICABLE_KINDS, duplicationSteps, pasteSteps, type CompositionModelT } from '../src/index.js';
import { ctx, must, op } from './helpers.js';

type Clip = CompositionModelT['tracks']['video'][number];
type Audio = CompositionModelT['tracks']['audio'][number];
const clipBody = (c: Clip) => { const { id: _i, ...rest } = c; return rest; };
const audioBody = (a: Audio) => { const { id: _i, atMs: _a, lane: _l, ...rest } = a; return rest; };

/** A media clip and a scene clip with every optional field set, plus a voice and an sfx layer with trim / loop / ducking / fades. */
function rich(): CompositionModelT {
  let m = must(createEmptyModel('p1', { autoRatio: false }), [
    op('op:clip.insert', { assetId: 'v1', trimBeforeMs: 1000, durationMs: 3000 }),
    op('op:scene.add', { durationMs: 2500, background: 'preset:background.solid', backgroundParams: { colourA: '#102030' } }, { kind: 'sequence' }),
    op('op:audio.addLayer', { assetId: 'vo', atMs: 500, volume: 0.8, role: 'voice', fadeInMs: 100, fadeOutMs: 200 }),
    op('op:audio.addLayer', { assetId: 'mus', atMs: 0, volume: 0.4, role: 'sfx' }),
  ]);
  const [c, s] = m.tracks.video; const [vo, sfx] = m.tracks.audio;
  const cl = { kind: 'clip' as const, id: c!.id }, sc = { kind: 'clip' as const, id: s!.id };
  m = must(m, [
    op('op:clip.setPlaybackRate', { rate: 1.5 }, cl), op('op:clip.setVolume', { volume: 0.35, fadeInMs: 300, fadeOutMs: 400 }, cl),
    op('op:clip.setFit', { objectFit: 'contain', crop: { left: 0.1, right: 0.05, top: 0, bottom: 0.2 } }, cl),
    op('op:element.setTransform', { x: 0.1, y: -0.2, scale: 1.4, rotation: 15 }, cl),
    op('op:motion.set', { presetId: 'preset:motion.zoom-drift' }, cl),
    op('op:effect.add', { presetId: 'preset:effect.vignette', params: { intensity: 0.7 } }, cl), op('op:effect.add', { presetId: 'preset:effect.blur', params: { radiusPx: 4 } }, cl),
    op('op:motion.set', { presetId: 'preset:motion.zoom-drift' }, sc), op('op:effect.add', { presetId: 'preset:effect.vignette' }, sc),
    op('op:element.setTransform', { scale: 1.2 }, sc), op('op:clip.setVolume', { volume: 0.5, fadeInMs: 250 }, sc),
    op('op:audio.setDucking', { presetId: 'preset:audio.duck-voice' }, { kind: 'audio', id: sfx!.id }),
    op('op:audio.setFades', { fadeInMs: 150 }, { kind: 'audio', id: vo!.id }),
  ]);
  // a trimmed, shortened voice and a looping sfx of a set length (op:audio.addLayer round-2 args)
  return must(m, [op('op:audio.addLayer', { assetId: 'vo', atMs: 6000, volume: 0.9, role: 'voice', trimBeforeMs: 700, durationMs: 1800, fadeOutMs: 300 }),
    op('op:audio.addLayer', { assetId: 'mus', atMs: 9000, volume: 0.3, role: 'sfx', loop: true, durationMs: 4000, ducking: { presetId: 'preset:audio.duck-voice', params: {} } })]);
}

describe('round 2: duplicate(x) equals x except id and timing, for every element kind', () => {
  it('clips (media + scene) keep volume, fades, rate, fit, crop, transform, motion and effects', () => {
    const m = rich();
    const before = m.tracks.video;
    expect(before[0]!.effects).toHaveLength(2);
    const r = must(m, duplicationSteps(m, before.map((c) => ({ kind: 'clip' as const, id: c.id }))).map((s) => s.op));
    expect(r.tracks.video).toHaveLength(4);
    for (const x of before) {
      const copies = r.tracks.video.filter((y) => y.id !== x.id && JSON.stringify(clipBody(y)) === JSON.stringify(clipBody(x)));
      expect(copies, `copy of ${x.assetId ?? 'scene'}`).toHaveLength(1);
      expect(clipBody(copies[0]!)).toEqual(clipBody(x));
    }
    expect(r.tracks.video.map((c) => c.assetId ?? 'scene')).toEqual(['v1', 'v1', 'scene', 'scene']);   // each copy right after its original
  });
  it('voice / sfx layers are duplicable: trim, length, volume, loop, fades and ducking; the copy starts where the original ends', () => {
    expect(DUPLICABLE_KINDS.has('audio')).toBe(true);
    const m = rich();
    const src = m.tracks.audio;
    const r = must(m, duplicationSteps(m, src.map((a) => ({ kind: 'audio' as const, id: a.id }))).map((s) => s.op));
    expect(r.tracks.audio).toHaveLength(src.length * 2);
    for (const x of src) {
      const copy = r.tracks.audio.find((y) => !src.some((o) => o.id === y.id) && JSON.stringify(audioBody(y)) === JSON.stringify(audioBody(x)));
      expect(copy, `copy of ${x.role} ${x.atMs}`).toBeDefined();
      expect(audioBody(copy!)).toEqual(audioBody(x));
      expect(copy!.atMs).toBe(x.atMs + x.durationMs!);
    }
  });
  it('a bed is not duplicated (one bed per project; op:audio.addLayer is voice / sfx)', () => {
    const m = must(createEmptyModel('p1', { autoRatio: false }), [op('op:audio.addBed', { assetId: 'mus', volume: 0.2 }, { kind: 'project' })]);
    expect(duplicationSteps(m, [{ kind: 'audio', id: m.tracks.audio[0]!.id }])).toEqual([]);
  });
  it('copy then paste rebuilds clips and audio layers with every field', () => {
    const m = rich();
    const refs = [...m.tracks.video.map((c) => ({ kind: 'clip' as const, id: c.id })), ...m.tracks.audio.map((a) => ({ kind: 'audio' as const, id: a.id }))];
    const { entries, skipped } = copySnapshot(m, refs);
    expect(skipped).toBe(0);
    const r = must(m, pasteSteps(m, entries, 60_000).map((s) => s.op));
    const freshClips = r.tracks.video.filter((y) => !m.tracks.video.some((o) => o.id === y.id)).map(clipBody);
    expect(freshClips).toEqual(m.tracks.video.map(clipBody));
    const freshAudio = r.tracks.audio.filter((y) => !m.tracks.audio.some((o) => o.id === y.id)).map(audioBody);
    expect(freshAudio.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(m.tracks.audio.map(audioBody).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  });
  it('the new add args are validated (crop leaving nothing, a non-ducking preset, a trim past the file)', () => {
    const e = createEmptyModel('p1', { autoRatio: false });
    const bad = (o: ReturnType<typeof op>) => { try { must(e, [o], ctx()); return null; } catch (x) { return String((x as Error).message); } };
    expect(bad(op('op:clip.insert', { assetId: 'v1', crop: { left: 0.5, right: 0.5, top: 0, bottom: 0 } }))).toContain('EM-2102');
    expect(bad(op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1, ducking: { presetId: 'preset:motion.rise' } }))).toContain('EM-2101');
    expect(bad(op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1, trimBeforeMs: 5000 }))).toContain('EM-2306');
    // absent args: exactly the layer / clip as before
    const plain = must(e, [op('op:clip.insert', { assetId: 'v2' }), op('op:audio.addLayer', { assetId: 'vo', atMs: 0, volume: 1 })]);
    expect(clipBody(plain.tracks.video[0]!)).toEqual({ assetId: 'v2', trimBeforeMs: 0, durationMs: 6000, playbackRate: 1, volume: 1, muted: false, fadeInMs: 0, fadeOutMs: 0, objectFit: 'cover', motion: null, effects: [] });
    expect(audioBody(plain.tracks.audio[0]!)).toEqual({ assetId: 'vo', role: 'voice', durationMs: 4000, trimBeforeMs: 0, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ducking: null });
  });
});
