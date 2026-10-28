// FR-250 (ADR-035): caption pages inside a voice clip's window move / trim with that clip; other pages stay.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, type CompositionModelT } from '../src/index.js';

let n = 0; const newId = () => `ID${++n}`;
const assets = [{ id: 'V1', kind: 'audio' as const, status: 'ready' as const, durationMs: 3000, hasAudio: true }, { id: 'V2', kind: 'audio' as const, status: 'ready' as const, durationMs: 2000, hasAudio: true }];
const page = (startMs: number, durationMs: number, text: string) => ({ text, startMs, durationMs, tokens: [{ text, fromMs: startMs, toMs: startMs + durationMs }] });
function base(): CompositionModelT {
  const m0 = { ...createEmptyModel('P', { autoRatio: false, ratio: '9:16', resolution: '1080p', fps: 30 }), durationPolicy: 'fixed' as const, fixedDurationMs: 20_000 };
  const r = applyOperations(m0, [
    { op: 'op:audio.addLayer', args: { assetId: 'V1', atMs: 1000, volume: 1, role: 'voice' } },
    { op: 'op:audio.addLayer', args: { assetId: 'V2', atMs: 5000, volume: 1, role: 'voice' } },
    { op: 'op:caption.setPages', target: { kind: 'project' }, args: { pages: [page(1000, 1200, 'Ekspor nikel'), page(2200, 800, 'naik.'), page(5000, 1500, 'Turun.'), page(9000, 500, 'lain')] } },
  ] as never, { assets, tier: 'T0', newId });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
const run = (m: CompositionModelT, ops: unknown[]) => { const r = applyOperations(m, ops as never, { assets, tier: 'T0', newId }); if (!r.ok) throw new Error(JSON.stringify(r.issues)); return r.value.model; };

describe('captions follow their voice clip (FR-250)', () => {
  it('moving the voice clip moves its pages and tokens by the same delta; other pages stay', () => {
    const m = base(); const v1 = m.tracks.audio.find((a) => a.assetId === 'V1')!;
    const out = run(m, [{ op: 'op:element.setTiming', target: { kind: 'audio', id: v1.id }, args: { atMs: 12_000, durationMs: 3000 } }]);
    const p = out.tracks.caption.pages;
    expect(p.map((x) => [x.text, x.startMs])).toEqual([['Turun.', 5000], ['lain', 9000], ['Ekspor nikel', 12_000], ['naik.', 13_200]]);
    expect(p.find((x) => x.text === 'naik.')!.tokens[0]).toMatchObject({ fromMs: 13_200, toMs: 14_000 });
  });
  it('trimming the start drops the pages that are no longer heard and keeps the rest in sync', () => {
    const m = base(); const v1 = m.tracks.audio.find((a) => a.assetId === 'V1')!;
    const out = run(m, [{ op: 'op:element.setTiming', target: { kind: 'audio', id: v1.id }, args: { atMs: 1000, durationMs: 1500, trimBeforeMs: 1500 } }]);
    const texts = out.tracks.caption.pages.map((x) => [x.text, x.startMs]);
    // "naik." is source 1.2–2.0 s: with a 1.5 s trim only 1.5–2.0 s is heard → timeline 1.0–1.5 s; "Ekspor nikel" (source 0–1.2 s) is cut away
    expect(texts).toEqual([['naik.', 1000], ['Turun.', 5000], ['lain', 9000]]);
    expect(out.tracks.caption.pages[0]!.durationMs).toBe(500);
  });
  it('a text edit or a non-audio op never moves captions', () => {
    const m = base();
    const out = run(m, [{ op: 'op:text.add', args: { text: 'x', variant: 'preset:text.title', atMs: 0, durationMs: 1000 } }]);
    expect(out.tracks.caption.pages.map((x) => x.startMs)).toEqual([1000, 2200, 5000, 9000]);
  });
});
