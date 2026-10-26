// music.generate engine step: embedded Python + our `expertmotion_music` wrapper around ACE-Step (docs/LOCAL_AI_MODELS.md §3.2 row 3, §9).
import { dirname, sep } from 'node:path';
import { EmError } from '@expertmotion/shared';
import { emError } from '../errors.js';
import { ENGINE_TIMEOUTS, assertAbsolute, buildChildEnv, runProcess, safeArgValue } from './process.js';
import { adapterFrom, jobFile, nodeFs, reporter, type EngineAdapter, type EngineContext } from './common.js';

export const MUSIC_PROMPT_MAX = 300;

export interface MusicInput {
  /** Absolute path of the venv interpreter (`python.exe`); its folder becomes PATH. Hash-checked by the service (SEC-061). */
  pythonExe: string;
  /** `<models>/ace-step/<model>/` */
  modelDir: string;
  prompt: string;
  durationMs: number;
  seed: number;
  device: 'cuda' | 'cpu';
  /** `--offload` (CPU offload, T1). */
  offload: boolean;
}
export interface MusicResult { wavPath: string }

export function aceStepArgs(input: MusicInput, outPath: string): string[] {
  const dir = input.modelDir.endsWith(sep) ? input.modelDir : `${input.modelDir}${sep}`;
  const seconds = Number((input.durationMs / 1000).toFixed(3));
  return ['-I', '-m', 'expertmotion_music', '--model', dir, '--prompt', safeArgValue(input.prompt), '--duration', String(seconds),
    '--seed', String(input.seed), '--out', outPath, '--device', input.device, ...(input.offload ? ['--offload'] : [])];
}

/** Wrapper protocol: one JSON object per stdout line; `{"progress": 0..1}` or `{"percent": 0..100}`. */
export function parseMusicProgress(line: string): number | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t) as { progress?: unknown; percent?: unknown };
    if (typeof o.progress === 'number' && Number.isFinite(o.progress)) return Math.min(1, Math.max(0, o.progress));
    if (typeof o.percent === 'number' && Number.isFinite(o.percent)) return Math.min(1, Math.max(0, o.percent / 100));
  } catch { /* not a progress line */ }
  return null;
}

export async function generateMusic(input: MusicInput, ctx: EngineContext): Promise<MusicResult> {
  if (input.prompt.trim() === '' || input.prompt.length > MUSIC_PROMPT_MAX) throw emError('EM-9002', `prompt must be 1..${MUSIC_PROMPT_MAX} characters`, { tool: 'music.generate' });
  if (!Number.isInteger(input.durationMs) || input.durationMs < 5000 || input.durationMs > 300_000) throw emError('EM-9002', 'durationMs must be 5000..300000', { durationMs: input.durationMs });
  if (!Number.isInteger(input.seed) || input.seed < 0) throw emError('EM-9002', 'seed must be a non-negative integer', { seed: input.seed });
  assertAbsolute(input.pythonExe, 'python'); assertAbsolute(input.modelDir, 'music model');
  const fs = ctx.fs ?? nodeFs;
  const report = reporter(ctx);
  report(0);
  const outPath = jobFile(ctx, 'out.wav');
  const engineDir = dirname(input.pythonExe);
  await fs.remove(outPath);
  try {
    await runProcess({
      engine: 'ace-step', exe: input.pythonExe, args: aceStepArgs(input, outPath), cwd: ctx.jobDir,
      env: buildChildEnv({ engineDir, jobDir: ctx.jobDir, ...(ctx.parentEnv ? { parentEnv: ctx.parentEnv } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}), extra: { PYTHONNOUSERSITE: '1' } }),
      timeoutMs: ctx.timeoutMs ?? ENGINE_TIMEOUTS.music, onStdoutLine: (l) => { const p = parseMusicProgress(l); if (p !== null) report(p * 0.98); },
      ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.killTree ? { killTree: ctx.killTree } : {}),
    });
  } catch (e) {
    // The interpreter itself missing means the music runtime is not set up → EM-7107 (offer the loop library).
    if (e instanceof EmError && e.code === 'EM-7101' && (e.details as { cause?: unknown } | undefined)?.cause === 'spawn') {
      throw emError('EM-7107', 'Music engine not available', { engine: 'ace-step', cause: 'spawn' }, e);
    }
    throw e;
  }
  const size = await fs.size(outPath).catch(() => -1);
  if (size <= 44) throw emError('EM-7103', 'Music engine produced no audio', { engine: 'ace-step' });
  if (size > 500 * 1024 * 1024) throw emError('EM-7101', 'Music output is too large', { engine: 'ace-step', cause: 'output-too-large', bytes: size });
  report(1);
  return { wavPath: outPath };
}

export const aceStepAdapter = (defaults: Partial<EngineContext> = {}): EngineAdapter<MusicInput, MusicResult> =>
  adapterFrom('generateMusic', '', (input, ctx) => generateMusic(input, ctx), defaults);
