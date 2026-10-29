// Round 2 (QA 2026-10-29, nikel): every voice clip starts on its scene's first frame. Scene starts come from the Engine's frame
// math (deriveFrameTiming: clip frames rounded one by one, minus the rounded transition overlaps); the voice layer's start frame
// is framesOf(atMs). Both must agree within one frame at 30 fps, for estimated AND measured (odd-millisecond) voice lengths.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyOperations, createEmptyModel, deriveFrameTiming, framesOf, type CompositionModelT, type AssetFacts } from '@expertmotion/composition-model';
import { composeScenes, type VideoSpecT } from '../src/index.js';

const NIKEL = JSON.parse(fs.readFileSync(new URL('./fixtures/nikel-spec.json', import.meta.url), 'utf8')) as VideoSpecT;
let n = 0; const newId = () => `v${++n}`;

function composeWith(spec: VideoSpecT, assets: AssetFacts[] = []): { m: CompositionModelT; voice: Array<{ clipId: string; atMs: number }>; scenes: Array<{ startMs: number }> } {
  const model = createEmptyModel('p', { autoRatio: false, ratio: '9:16' });
  const r = composeScenes(spec, { model, assets, tier: 'T1' });
  if (!r.ok) throw new Error(r.problem);
  const a = applyOperations(model, r.ops, { assets, tier: 'T1', newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues));
  return { m: a.value.model, voice: r.voice, scenes: r.scenes };
}
/** Offset (ms) between each scene's first voice clip and the scene's first frame, as the Engine renders them. */
function offsets(spec: VideoSpecT, assets: AssetFacts[] = []): number[] {
  const { m } = composeWith(spec, assets);
  const ft = deriveFrameTiming(m);
  const voices = m.tracks.audio.filter((a) => a.role === 'voice');
  const firstOf = spec.scenes.map((s) => s.clips?.[0]);
  const out: number[] = [];
  firstOf.forEach((cid, i) => {
    if (!cid) return;
    const asset = assets.find((x) => x.id === `asset-${cid}`);
    const layer = voices.find((v) => v.assetId === asset?.id);
    if (!layer) throw new Error(`no voice layer for ${cid}`);
    out.push(((framesOf(layer.atMs, ft.fps) - ft.clipStartFrames[i]!) * 1000) / ft.fps);
  });
  return out;
}
const withAssets = (spec: VideoSpecT, lengths: Record<string, number>) => {
  const assets: AssetFacts[] = spec.voice!.clips.map((c) => ({ id: `asset-${c.id}`, kind: 'audio', status: 'ready', durationMs: lengths[c.id] ?? c.durationMs ?? 2000 }));
  const s = { ...spec, voice: { ...spec.voice!, clips: spec.voice!.clips.map((c) => ({ ...c, assetId: `asset-${c.id}` })) } } as VideoSpecT;
  return { s, assets };
};

describe('voice clips start on their scene frame (nikel)', () => {
  it('real nikel run lengths (odd ms): |offset| <= 1 frame for every scene', () => {
    // voice lengths measured in the QA run (2026-10-29, Piper id)
    const { s, assets } = withAssets(NIKEL, { v1: 3332, v2: 3727, v3: 6280, v4: 3896, v5: 2856, v6: 2972, v7: 2207, v8: 4261, v9: 3952 });
    const o = offsets(s, assets);
    expect(o.length).toBe(NIKEL.scenes.filter((x) => x.clips?.length).length);
    for (const x of o) expect(Math.abs(x)).toBeLessThanOrEqual(1000 / 30 + 1e-6);
  });
  it('300 random length sets: every scene start equals its voice start frame', () => {
    let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let worst = 0;
    for (let k = 0; k < 300; k++) {
      const lens: Record<string, number> = {};
      for (const c of NIKEL.voice!.clips) lens[c.id] = 1200 + Math.floor(rnd() * 5000);
      const { s, assets } = withAssets(NIKEL, lens);
      for (const x of offsets(s, assets)) worst = Math.max(worst, Math.abs(x));
    }
    expect(worst).toBeLessThanOrEqual(1000 / 30 + 1e-6);
  });
  it('the composer reports scene starts on whole frames, equal to the Engine frame math', () => {
    const { s, assets } = withAssets(NIKEL, { v1: 3333, v2: 3721, v3: 6287, v4: 3899, v5: 2851, v6: 2977, v7: 2203, v8: 4269, v9: 3955 });
    const { m, scenes } = composeWith(s, assets);
    const ft = deriveFrameTiming(m);
    scenes.forEach((sc, i) => expect(framesOf(sc.startMs, ft.fps)).toBe(ft.clipStartFrames[i]));
  });
});
