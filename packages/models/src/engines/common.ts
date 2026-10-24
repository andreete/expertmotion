import { readFile as fsReadFile, rm as fsRm, stat as fsStat, writeFile as fsWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChildLike, SpawnLike } from './process.js';

/** Context every adapter receives from the job runner (LOCAL_AI_MODELS §3.2: files in, files out, one job dir). */
export interface EngineContext {
  /** Absolute folder of the Engine Binary (`resources/engines/<engine>/<version>/`); becomes PATH. */
  engineDir: string;
  /** Absolute per-job temp dir; cwd, TEMP and the only place outputs are read from. */
  jobDir: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
  spawn?: SpawnLike;
  killTree?: (child: ChildLike) => void;
  parentEnv?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** Overrides the LOCAL_AI_MODELS §3.3 timeout. */
  timeoutMs?: number;
  fs?: EngineFs;
}
export interface EngineFs {
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  size(path: string): Promise<number>;
  /** Removes a stale output before the engine runs (no error when absent). */
  remove(path: string): Promise<void>;
}
export const nodeFs: EngineFs = {
  readFile: (p) => fsReadFile(p),
  writeFile: (p, d) => fsWriteFile(p, d),
  size: async (p) => (await fsStat(p)).size,
  remove: (p) => fsRm(p, { force: true }),
};

/** BLUEPRINT.md §3.5 adapter shape. */
export interface EngineAdapter<I, O> {
  kind: 'transcribe' | 'synthesize' | 'generateImage' | 'generateMusic';
  run(input: I, opts: Omit<EngineContext, 'engineDir' | 'jobDir'> & { cwd: string }): Promise<O>;
}
export function adapterFrom<I, O>(kind: EngineAdapter<I, O>['kind'], engineDir: string, fn: (input: I, ctx: EngineContext) => Promise<O>, defaults: Partial<EngineContext> = {}): EngineAdapter<I, O> {
  return { kind, run: (input, { cwd, ...rest }) => fn(input, { ...defaults, ...rest, engineDir, jobDir: cwd }) };
}

export const jobFile = (ctx: EngineContext, name: string): string => join(ctx.jobDir, name);
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
export const reporter = (ctx: EngineContext): ((f: number) => void) => {
  let last = -1;
  return (f) => { const v = clamp01(f); if (v > last) { last = v; ctx.onProgress?.(v); } };
};
