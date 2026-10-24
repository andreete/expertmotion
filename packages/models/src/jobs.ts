// Small generator-job runner (docs/LOCAL_AI_MODELS.md §8 job envelope; docs/DATABASE_SCHEMA.md `generator_jobs`).
// Concurrency 1 by default (§3.3 "one generator job at a time"); pause() holds the queue while a Render Job runs.
import { EmError, newId as ulid } from '@expertmotion/shared';
import { CancelledError } from './errors.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobSnapshot {
  id: string;
  kind: string;
  projectId: string | null;
  modelKey: string | null;
  status: JobStatus;
  /** 0..1 (generator_jobs.progress). */
  progress: number;
  stage: string | null;
  etaMs: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: { code: string; message: string } | null;
}

export type JobEvent =
  | { type: 'queued'; job: JobSnapshot }
  | { type: 'running'; job: JobSnapshot }
  | { type: 'progress'; job: JobSnapshot }
  | { type: 'done'; job: JobSnapshot; result: unknown }
  | { type: 'failed'; job: JobSnapshot }
  | { type: 'cancelled'; job: JobSnapshot };

export interface JobContext {
  jobId: string;
  signal: AbortSignal;
  /** fraction 0..1 (clamped, never decreasing), optional stage label and ETA. */
  progress(fraction: number, stage?: string, etaMs?: number): void;
}

export interface JobSpec<R> {
  id?: string;
  kind: string;
  projectId?: string;
  modelKey?: string;
  run: (ctx: JobContext) => Promise<R>;
}

export type JobOutcome<R> = { status: 'done'; result: R } | { status: 'failed'; error: EmError } | { status: 'cancelled' };
export interface JobHandle<R> { id: string; outcome: Promise<JobOutcome<R>> }

export interface JobRunnerOptions {
  emit: (e: JobEvent) => void;
  concurrency?: number;
  now?: () => Date;
  newId?: () => string;
  /** Minimum ms between progress events per job (0 = every change). */
  progressIntervalMs?: number;
  /** Finished jobs kept for get()/list(). */
  keepFinished?: number;
}

interface Entry {
  snap: JobSnapshot;
  spec: JobSpec<unknown>;
  ctrl: AbortController;
  resolve: (o: JobOutcome<unknown>) => void;
  lastProgressAt: number;
}

/** Non-EmError failures are reported as EM-7101 (engine stopped unexpectedly). */
export function toEmError(err: unknown): EmError {
  if (err instanceof EmError) return err;
  return new EmError('EM-7101', err instanceof Error ? err.message : String(err), { cause: err });
}

export class JobRunner {
  private readonly queue: Entry[] = [];
  private readonly running = new Map<string, Entry>();
  private readonly finished = new Map<string, JobSnapshot>();
  private paused = false;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly makeId: () => string;
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly opts: JobRunnerOptions) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.now = opts.now ?? (() => new Date());
    this.makeId = opts.newId ?? (() => ulid());
  }

  submit<R>(spec: JobSpec<R>): JobHandle<R> {
    const id = spec.id ?? this.makeId();
    if (this.running.has(id) || this.queue.some((e) => e.snap.id === id)) throw new RangeError(`job ${id} already exists`);
    let resolve!: (o: JobOutcome<unknown>) => void;
    const outcome = new Promise<JobOutcome<unknown>>((r) => { resolve = r; });
    const snap: JobSnapshot = { id, kind: spec.kind, projectId: spec.projectId ?? null, modelKey: spec.modelKey ?? null, status: 'queued', progress: 0, stage: null, etaMs: null,
      createdAt: this.now().toISOString(), startedAt: null, finishedAt: null, error: null };
    const entry: Entry = { snap, spec: spec as JobSpec<unknown>, ctrl: new AbortController(), resolve, lastProgressAt: -Infinity };
    this.queue.push(entry);
    this.opts.emit({ type: 'queued', job: { ...snap } });
    queueMicrotask(() => this.pump());
    return { id, outcome: outcome as Promise<JobOutcome<R>> };
  }

  /** Cancels a queued or running job (running: aborts its signal; the engine adapter kills the process tree). */
  cancel(id: string): boolean {
    const qi = this.queue.findIndex((e) => e.snap.id === id);
    if (qi >= 0) {
      const [e] = this.queue.splice(qi, 1);
      this.settle(e!, { status: 'cancelled' });
      return true;
    }
    const r = this.running.get(id);
    if (!r) return false;
    r.ctrl.abort(new CancelledError());
    return true;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; this.pump(); }
  get isPaused(): boolean { return this.paused; }

  get(id: string): JobSnapshot | undefined {
    const e = this.running.get(id) ?? this.queue.find((x) => x.snap.id === id);
    return e ? { ...e.snap } : this.finished.get(id);
  }
  list(): JobSnapshot[] {
    return [...this.running.values(), ...this.queue].map((e) => ({ ...e.snap })).concat([...this.finished.values()]);
  }
  /** Resolves when nothing is queued or running. */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running.size === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump(): void {
    while (!this.paused && this.running.size < this.concurrency && this.queue.length > 0) {
      const e = this.queue.shift()!;
      this.running.set(e.snap.id, e);
      void this.start(e);
    }
    if (this.queue.length === 0 && this.running.size === 0) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f()); }
  }

  private async start(e: Entry): Promise<void> {
    e.snap.status = 'running'; e.snap.startedAt = this.now().toISOString();
    this.opts.emit({ type: 'running', job: { ...e.snap } });
    const interval = this.opts.progressIntervalMs ?? 0;
    const ctx: JobContext = {
      jobId: e.snap.id, signal: e.ctrl.signal,
      progress: (fraction, stage, etaMs) => {
        if (e.snap.status !== 'running') return;
        const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
        const changedStage = stage !== undefined && stage !== e.snap.stage;
        if (f <= e.snap.progress && !changedStage) return;
        e.snap.progress = Math.max(e.snap.progress, f);
        if (stage !== undefined) e.snap.stage = stage;
        e.snap.etaMs = etaMs ?? null;
        const t = this.now().getTime();
        if (!changedStage && f < 1 && t - e.lastProgressAt < interval) return;
        e.lastProgressAt = t;
        this.opts.emit({ type: 'progress', job: { ...e.snap } });
      },
    };
    let outcome: JobOutcome<unknown>;
    try {
      const result = await e.spec.run(ctx);
      outcome = e.ctrl.signal.aborted ? { status: 'cancelled' } : { status: 'done', result };
    } catch (err) {
      outcome = e.ctrl.signal.aborted || err instanceof CancelledError ? { status: 'cancelled' } : { status: 'failed', error: toEmError(err) };
    }
    this.running.delete(e.snap.id);
    this.settle(e, outcome);
    this.pump();
  }

  private settle(e: Entry, outcome: JobOutcome<unknown>): void {
    e.snap.status = outcome.status; e.snap.finishedAt = this.now().toISOString();
    if (outcome.status === 'done') { e.snap.progress = 1; this.opts.emit({ type: 'done', job: { ...e.snap }, result: outcome.result }); }
    else if (outcome.status === 'failed') { e.snap.error = { code: outcome.error.code, message: outcome.error.message }; this.opts.emit({ type: 'failed', job: { ...e.snap } }); }
    else this.opts.emit({ type: 'cancelled', job: { ...e.snap } });
    this.finished.set(e.snap.id, { ...e.snap });
    const keep = this.opts.keepFinished ?? 100;
    while (this.finished.size > keep) this.finished.delete(this.finished.keys().next().value!);
    e.resolve(outcome);
    if (this.queue.length === 0 && this.running.size === 0) { const w = this.idleWaiters; this.idleWaiters = []; w.forEach((f) => f()); }
  }
}
