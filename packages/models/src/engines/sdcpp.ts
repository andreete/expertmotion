// thumbnail.generate engine step: stable-diffusion.cpp `sd` (docs/LOCAL_AI_MODELS.md §3.2 row 4).
import { join } from 'node:path';
import { emError } from '../errors.js';
import type { Tier } from '../types.js';
import { ENGINE_TIMEOUTS, assertAbsolute, buildChildEnv, exeName, runProcess, safeArgValue } from './process.js';
import { adapterFrom, jobFile, nodeFs, reporter, type EngineAdapter, type EngineContext } from './common.js';

export const PNG_MAX_BYTES = 50 * 1024 * 1024;
export const PROMPT_MAX_CHARS = 1000;

export type ImageModel =
  | { kind: 'sd15'; modelPath: string }
  | { kind: 'flux'; diffusionModelPath: string; clipLPath: string; t5xxlPath: string; vaePath: string };

export interface ImageInput {
  model: ImageModel;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  seed: number;
  threads: number;
  /** Decides the timeout (T0 15 min, GPU 3 min). */
  tier: Tier;
  steps?: number;
  cfgScale?: number;
}
export interface ImageResult { pngPath: string }

/**
 * Argv per LOCAL_AI_MODELS §3.2. FLUX: the doc lists `-m … ` plus `--diffusion-model --clip_l --t5xxl --vae`; sd.cpp loads a
 * FLUX GGUF only through `--diffusion-model`, so `-m` is omitted for FLUX (recorded as a spec gap).
 */
export function sdArgs(input: ImageInput, outPath: string): string[] {
  const flux = input.model.kind === 'flux';
  const steps = input.steps ?? (flux ? 4 : 20);
  const cfg = input.cfgScale ?? (flux ? 1.0 : 7.0);
  const modelArgs = input.model.kind === 'flux'
    ? ['--diffusion-model', input.model.diffusionModelPath, '--clip_l', input.model.clipLPath, '--t5xxl', input.model.t5xxlPath, '--vae', input.model.vaePath]
    : ['-m', input.model.modelPath];
  return ['-M', 'txt2img', ...modelArgs, '-p', safeArgValue(input.prompt), '-n', safeArgValue(input.negativePrompt ?? ''),
    '-W', String(input.width), '-H', String(input.height), '--steps', String(steps), '--cfg-scale', cfg.toFixed(1), '-s', String(input.seed),
    '--vae-tiling', '--clip-on-cpu', '-o', outPath, '-t', String(Math.max(1, Math.floor(input.threads)))];
}

/** sd.cpp step progress lines look like `|=====>    | 3/20 - 1.23s/it`. */
export function parseSdProgress(line: string): number | null {
  const m = /\|\s*(\d+)\/(\d+)\s*-/.exec(line) ?? /\b(\d+)\/(\d+)\b.*(?:s\/it|it\/s)/.exec(line);
  if (!m) return null;
  const a = Number(m[1]), b = Number(m[2]);
  return b > 0 ? Math.min(1, a / b) : null;
}

export async function generateImage(input: ImageInput, ctx: EngineContext): Promise<ImageResult> {
  if (input.prompt.trim() === '') throw emError('EM-9002', 'Prompt is empty', { tool: 'thumbnail.generate' });
  if (input.prompt.length > PROMPT_MAX_CHARS || (input.negativePrompt ?? '').length > PROMPT_MAX_CHARS) throw emError('EM-9002', 'Prompt too long', { limit: PROMPT_MAX_CHARS });
  for (const d of [input.width, input.height]) if (!Number.isInteger(d) || d < 64 || d > 2048 || d % 64 !== 0) throw emError('EM-9002', 'Image size must be a multiple of 64 between 64 and 2048', { width: input.width, height: input.height });
  if (!Number.isInteger(input.seed) || input.seed < 0) throw emError('EM-9002', 'seed must be a non-negative integer', { seed: input.seed });
  const paths = input.model.kind === 'flux' ? [input.model.diffusionModelPath, input.model.clipLPath, input.model.t5xxlPath, input.model.vaePath] : [input.model.modelPath];
  for (const p of paths) assertAbsolute(p, 'image model');
  const fs = ctx.fs ?? nodeFs;
  const report = reporter(ctx);
  report(0);
  const outPath = jobFile(ctx, 'out.png');
  await fs.remove(outPath);
  const onLine = (line: string): void => { const p = parseSdProgress(line); if (p !== null) report(p * 0.98); };
  await runProcess({
    engine: 'stable-diffusion.cpp', exe: join(ctx.engineDir, exeName('sd', ctx.platform)), args: sdArgs(input, outPath),
    cwd: ctx.jobDir, env: buildChildEnv({ engineDir: ctx.engineDir, jobDir: ctx.jobDir, ...(ctx.parentEnv ? { parentEnv: ctx.parentEnv } : {}) }),
    timeoutMs: ctx.timeoutMs ?? ENGINE_TIMEOUTS.thumbnail(input.tier), onStdoutLine: onLine, onStderrLine: onLine,
    ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.killTree ? { killTree: ctx.killTree } : {}),
  });
  const size = await fs.size(outPath).catch(() => -1);
  if (size <= 0) throw emError('EM-7103', 'Image engine produced no image', { engine: 'stable-diffusion.cpp' });
  if (size > PNG_MAX_BYTES) throw emError('EM-7101', 'Image output is too large', { engine: 'stable-diffusion.cpp', cause: 'output-too-large', bytes: size });
  const head = (await fs.readFile(outPath)).subarray(0, 8);
  if (!(head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)) throw emError('EM-7101', 'Image output is not a PNG', { engine: 'stable-diffusion.cpp', cause: 'output' });
  report(1);
  return { pngPath: outPath };
}

export const sdCppAdapter = (engineDir: string, defaults: Partial<EngineContext> = {}): EngineAdapter<ImageInput, ImageResult> => adapterFrom('generateImage', engineDir, generateImage, defaults);
