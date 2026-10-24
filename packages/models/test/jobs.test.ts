import { describe, expect, it } from 'vitest';
import { EmError } from '@expertmotion/shared';
import { CancelledError, JobRunner, toEmError, type JobEvent } from '../src/index.js';

const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
function runner(extra: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}): { r: JobRunner; events: JobEvent[] } {
  const events: JobEvent[] = [];
  let n = 0;
  const r = new JobRunner({ emit: (e) => events.push(e), newId: () => `j${++n}`, now: () => new Date('2026-10-24T10:00:00Z'), ...extra });
  return { r, events };
}
const deferred = <T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void; let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

describe('JobRunner', () => {
  it('queued → running → progress → done, with monotonic progress', async () => {
    const { r, events } = runner();
    const h = r.submit({ kind: 'captions', projectId: 'p1', modelKey: 'whisper-small', run: async (ctx) => { ctx.progress(0.2, 'transcribe'); ctx.progress(0.1); ctx.progress(0.6); ctx.progress(Number.NaN); return { pages: 3 }; } });
    expect(await h.outcome).toEqual({ status: 'done', result: { pages: 3 } });
    expect(events.map((e) => e.type)).toEqual(['queued', 'running', 'progress', 'progress', 'done']);
    expect(events.filter((e) => e.type === 'progress').map((e) => e.job.progress)).toEqual([0.2, 0.6]);
    const done = events.at(-1)!;
    expect(done.job).toMatchObject({ id: 'j1', kind: 'captions', projectId: 'p1', modelKey: 'whisper-small', status: 'done', progress: 1, stage: 'transcribe', startedAt: '2026-10-24T10:00:00.000Z' });
    expect(r.get('j1')?.status).toBe('done');
  });

  it('runs one job at a time by default and keeps order', async () => {
    const { r } = runner();
    const order: string[] = [];
    const d1 = deferred<void>();
    const a = r.submit({ kind: 'voice', run: async () => { order.push('a-start'); await d1.promise; order.push('a-end'); } });
    const b = r.submit({ kind: 'voice', run: async () => { order.push('b'); } });
    await tick();
    expect(r.get(b.id)?.status).toBe('queued');
    d1.resolve();
    await Promise.all([a.outcome, b.outcome]);
    expect(order).toEqual(['a-start', 'a-end', 'b']);
    await r.idle();
  });

  it('failures become EmError (non-EmError → EM-7101)', async () => {
    const { r, events } = runner();
    const a = await r.submit({ kind: 'thumbnail', run: async () => { throw new EmError('EM-7102', 'too slow'); } }).outcome;
    const b = await r.submit({ kind: 'thumbnail', run: async () => { throw new Error('boom'); } }).outcome;
    expect(a.status === 'failed' && a.error.code).toBe('EM-7102');
    expect(b.status === 'failed' && b.error.code).toBe('EM-7101');
    expect(events.filter((e) => e.type === 'failed').map((e) => e.job.error?.code)).toEqual(['EM-7102', 'EM-7101']);
    expect(toEmError('x').code).toBe('EM-7101');
  });

  it('cancel: queued job never runs; running job sees its signal aborted', async () => {
    const { r, events } = runner();
    let sawAbort = false;
    const a = r.submit({ kind: 'music', run: (ctx) => new Promise((_, reject) => { ctx.signal.addEventListener('abort', () => { sawAbort = true; reject(new CancelledError()); }); }) });
    let ranB = false;
    const b = r.submit({ kind: 'music', run: async () => { ranB = true; } });
    await tick();
    expect(r.cancel(b.id)).toBe(true);
    expect(r.cancel(a.id)).toBe(true);
    expect(await a.outcome).toEqual({ status: 'cancelled' });
    expect(await b.outcome).toEqual({ status: 'cancelled' });
    expect(sawAbort).toBe(true); expect(ranB).toBe(false);
    expect(r.cancel('nope')).toBe(false);
    expect(events.filter((e) => e.type === 'cancelled').length).toBe(2);
    // a job that resolves after abort still counts as cancelled
    const c = r.submit({ kind: 'music', run: async (ctx) => { await tick(); return ctx.signal.aborted; } });
    r.cancel(c.id);
    expect((await c.outcome).status).toBe('cancelled');
  });

  it('pause holds the queue (render running), resume continues', async () => {
    const { r } = runner();
    r.pause();
    expect(r.isPaused).toBe(true);
    let ran = false;
    const h = r.submit({ kind: 'voice', run: async () => { ran = true; } });
    await tick(); await tick();
    expect(ran).toBe(false);
    expect(r.list().map((j) => j.status)).toEqual(['queued']);
    r.resume();
    await h.outcome;
    expect(ran).toBe(true);
  });

  it('throttles progress events, keeps a bounded history, rejects duplicate ids', async () => {
    let t = 0;
    const { r, events } = runner({ progressIntervalMs: 1000, now: () => new Date(t), keepFinished: 2 });
    await r.submit({ id: 'x', kind: 'voice', run: async (ctx) => { ctx.progress(0.1); t += 10; ctx.progress(0.2); t += 2000; ctx.progress(0.3); ctx.progress(1); } }).outcome;
    expect(events.filter((e) => e.type === 'progress').map((e) => e.job.progress)).toEqual([0.1, 0.3, 1]);
    const d = deferred<void>();
    r.submit({ id: 'y', kind: 'voice', run: () => d.promise });
    expect(() => r.submit({ id: 'y', kind: 'voice', run: async () => undefined })).toThrow(RangeError);
    d.resolve();
    await r.idle();
    await r.submit({ id: 'z', kind: 'voice', run: async () => undefined }).outcome;
    await r.submit({ id: 'w', kind: 'voice', run: async () => undefined }).outcome;
    expect(r.list().map((j) => j.id)).toEqual(['z', 'w']);
    expect(r.get('x')).toBeUndefined();
  });

  it('concurrency > 1 runs jobs in parallel', async () => {
    const { r } = runner({ concurrency: 2 });
    const d = deferred<void>();
    let running = 0; let peak = 0;
    const run = async (): Promise<void> => { running++; peak = Math.max(peak, running); await d.promise; running--; };
    const hs = [r.submit({ kind: 'a', run }), r.submit({ kind: 'b', run }), r.submit({ kind: 'c', run })];
    await tick();
    expect(peak).toBe(2);
    d.resolve();
    await Promise.all(hs.map((h) => h.outcome));
  });
});
