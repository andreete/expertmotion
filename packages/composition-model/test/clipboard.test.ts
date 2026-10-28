// FR-255 / FR-256: Copy snapshots (copySnapshot) and Paste at the playhead (pasteSlot / pasteSteps): items keep their relative
// timing, clips are inserted at the cut at / after the playhead, a scene keeps its own title, the lane rule places overlapping
// copies on free lanes, and nothing on the clipboard depends on the originals still existing (Cut).
import { describe, expect, it } from 'vitest';
import { PASTE_OPS, copySnapshot, createEmptyModel, laneConflicts, pasteSlot, pasteSteps, removalSteps, type ClipboardEntry, type CompositionModelT } from '../src/index.js';
import { base, ctx, must, op } from './helpers.js';

const empty = () => createEmptyModel('p1', { autoRatio: false });
/** Scenes A (3 s), B (4 s), C (2 s), one title each. */
const faceless = (): CompositionModelT => must(empty(), [
  op('op:scene.add', { durationMs: 3000, title: 'A' }, { kind: 'sequence' }),
  op('op:scene.add', { durationMs: 4000, title: 'B' }, { kind: 'sequence' }),
  op('op:scene.add', { durationMs: 2000, title: 'C' }, { kind: 'sequence' }),
], { ...ctx(), assets: [] });
const apply = (m: CompositionModelT, steps: ReturnType<typeof pasteSteps>) => must(m, steps.map((s) => s.op), { ...ctx(), assets: [] });

describe('copySnapshot (FR-255)', () => {
  it('texts keep their offsets from the earliest copied item; items that no longer exist are ignored', () => {
    const m = must(faceless(), [op('op:text.add', { text: 'Extra', variant: 'preset:text.title', atMs: 4500, durationMs: 1000 })], { ...ctx(), assets: [] });
    const b = m.tracks.text.find((x) => x.text === 'B')!; const extra = m.tracks.text.find((x) => x.text === 'Extra')!;
    const { entries, skipped } = copySnapshot(m, [{ kind: 'text', id: extra.id }, { kind: 'text', id: b.id }, { kind: 'background' }, { kind: 'text', id: 'gone' }]);
    expect(skipped).toBe(0);
    expect(entries.map((e) => [e.kind, e.offsetMs, e.op.op, e.op.args['text']])).toEqual([['text', 0, 'op:text.add', 'B'], ['text', 1500, 'op:text.add', 'Extra']]);
    expect(entries.every((e) => PASTE_OPS[e.kind] === e.op.op)).toBe(true);
  });
  it('a scene clip brings its own title (like Duplicate); a snapshot is plain data', () => {
    const m = faceless();
    const { entries } = copySnapshot(m, [{ kind: 'clip', id: m.tracks.video[1]!.id }]);
    expect(entries.map((e) => [e.kind, e.offsetMs, e.op.op])).toEqual([['scene', 0, 'op:scene.add'], ['text', 0, 'op:text.add']]);
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
  });
});

describe('pasteSteps (FR-256)', () => {
  it('pasteSlot: inside a clip → after it; at a clip start → before it; past the end → appended', () => {
    const m = faceless();
    expect(pasteSlot(m, 1000)).toEqual({ index: 1, startMs: 3000 });
    expect(pasteSlot(m, 3000)).toEqual({ index: 1, startMs: 3000 });
    expect(pasteSlot(m, 9000)).toEqual({ index: 3, startMs: 9000 });
    expect(pasteSlot(empty(), 500)).toEqual({ index: 0, startMs: 0 });
  });
  it('texts only: placed at the playhead + offset, overlapping copies go to free lanes', () => {
    const m = faceless();
    const { entries } = copySnapshot(m, m.tracks.text.slice(0, 2).map((x) => ({ kind: 'text' as const, id: x.id })));
    const steps = pasteSteps(m, entries, 1000);
    expect(steps.map((s) => s.target)).toEqual([{ kind: 'project', index: 0 }, { kind: 'project', index: 1 }]);
    const r = apply(m, steps);
    expect(r.tracks.text.filter((x) => x.text === 'A').map((x) => x.timing.atMs).sort((a, b) => a - b)).toEqual([0, 1000]);
    expect(r.tracks.text.filter((x) => x.text === 'B').map((x) => x.timing.atMs).sort((a, b) => a - b)).toEqual([3000, 4000]);
    expect(laneConflicts(r)).toEqual([]);
  });
  it('Cut then Paste of scene B (with its title) inside scene A: inserted after A, the title stays on its scene', () => {
    const m = faceless();
    const b = m.tracks.video[1]!;
    const { entries } = copySnapshot(m, [{ kind: 'clip', id: b.id }]);
    const cut = must(m, removalSteps(m, [{ kind: 'clip', id: b.id }]).map((s) => s.op), { ...ctx(), assets: [] });
    expect(cut.tracks.video).toHaveLength(2);
    const r = apply(cut, pasteSteps(cut, entries, 1000));
    expect(r.tracks.video.map((c) => c.durationMs)).toEqual([3000, 4000, 2000]);
    expect(r.tracks.text.find((x) => x.text === 'B')!.timing).toEqual({ atMs: 3000, durationMs: 4000 });
    expect(r.tracks.text.find((x) => x.text === 'C')!.timing.atMs).toBe(7000);   // the later scene's title moved with its scene
  });
  it('drops entries whose op is not the add op of their kind, and caps the list', () => {
    const m = faceless();
    const bad = { kind: 'text', offsetMs: 0, durationMs: 1000, op: { op: 'op:clip.remove', target: { kind: 'clip', id: m.tracks.video[0]!.id }, args: {} } } as ClipboardEntry;
    expect(pasteSteps(m, [bad], 0)).toEqual([]);
    const { entries } = copySnapshot(m, [{ kind: 'text', id: m.tracks.text[0]!.id }]);
    expect(pasteSteps(m, Array.from({ length: 80 }, () => entries[0]!), 0)).toHaveLength(50);
  });
  it('media clip + voice layer: the clip goes in at the cut, the voice keeps its offset; music beds are skipped', () => {
    const m = must(base(), [op('op:audio.addLayer', { assetId: 'vo', atMs: 9000, volume: 0.8, role: 'voice' }), op('op:audio.addBed', { assetId: 'mus', volume: 0.2 })]);
    const v2 = m.tracks.video[1]!; const voice = m.tracks.audio.find((a) => a.role === 'voice')!; const bed = m.tracks.audio.find((a) => a.role === 'bed')!;
    const { entries, skipped } = copySnapshot(m, [{ kind: 'clip', id: v2.id }, { kind: 'audio', id: voice.id }, { kind: 'audio', id: bed.id }]);
    expect(skipped).toBe(1);
    expect(entries.map((e) => [e.kind, e.offsetMs])).toEqual([['clip', 0], ['audio', 1000]]);
    const r = must(m, pasteSteps(m, entries, 0).map((s) => s.op));
    expect(r.tracks.video.map((c) => c.assetId)).toEqual(['v2', 'v1', 'v2', 'v3']);
    expect(r.tracks.audio.filter((a) => a.role === 'voice').map((a) => [a.atMs, a.volume]).sort((x, y) => x[0]! - y[0]!)).toEqual([[1000, 0.8], [9000, 0.8]]);
  });
});
