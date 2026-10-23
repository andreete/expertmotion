import { createEmptyModel, type AssetFacts, type ApplyContext, type CompositionModelT, type OperationT, applyOperations } from '../src/index.js';
export const ASSETS: AssetFacts[] = [
  { id: 'v1', kind: 'video', status: 'ready', durationMs: 10_000, width: 1920, height: 1080, hasAudio: true, name: 'unboxing.mp4' },
  { id: 'v2', kind: 'video', status: 'ready', durationMs: 6_000, width: 1080, height: 1920, hasAudio: false, name: 'fitur.mp4' },
  { id: 'v3', kind: 'video', status: 'ready', durationMs: 5_000, width: 1080, height: 1920, hasAudio: true, name: 'wajah.mp4' },
  { id: 'img', kind: 'image', status: 'ready', width: 1000, height: 1000, name: 'logo.png' },
  { id: 'mus', kind: 'audio', status: 'ready', durationMs: 60_000, name: 'musik.mp3' },
  { id: 'vo', kind: 'audio', status: 'ready', durationMs: 4_000, name: 'suara.wav' },
  { id: 'srt', kind: 'subtitle', status: 'ready', name: 'sub.srt', captionPages: [{ text: ' Halo dunia', startMs: 0, durationMs: 1000, tokens: [{ text: ' Halo', fromMs: 0, toMs: 500 }, { text: ' dunia', fromMs: 500, toMs: 1000 }] }] },
  { id: 'srt-empty', kind: 'subtitle', status: 'ready', name: 'empty.srt', captionPages: [] },
  { id: 'busy', kind: 'video', status: 'ingesting', durationMs: 3000 },
];
let n = 0;
export const ctx = (over: Partial<ApplyContext> = {}): ApplyContext => ({ assets: ASSETS, tier: 'T1', newId: () => `e${++n}`, ...over });
export const op = (o: string, args: Record<string, unknown> = {}, target?: OperationT['target']): OperationT => ({ op: o, args, ...(target ? { target } : {}) });
export function deepFreeze<T>(o: T): T { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; }
/** Applies ops and throws with the issues when blocked (for building fixtures). */
export function must(model: CompositionModelT, ops: OperationT[], c: ApplyContext = ctx()): CompositionModelT {
  const r = applyOperations(model, ops, c);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return r.value.model;
}
/** Three clips v1 (8 s), v2 (6 s), v3 (5 s) in 9:16 1080p, autoRatio off. */
export const base = (): CompositionModelT => must(createEmptyModel('p1', { autoRatio: false }), [
  op('op:clip.insert', { assetId: 'v1', durationMs: 8000 }), op('op:clip.insert', { assetId: 'v2' }), op('op:clip.insert', { assetId: 'v3' }),
]);
