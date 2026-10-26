// Child-process runner for Engine Binaries (docs/LOCAL_AI_MODELS.md §3.2/§3.3; docs/SECURITY.md SEC-060…066).
// Argument arrays only, shell: false, scrubbed env, cwd = per-job temp dir, timeout and abort kill the process tree,
// stdout/stderr capped at 1 MB each (oldest dropped).
import { spawn as nodeSpawnImpl } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { CancelledError, emError } from '../errors.js';
import type { Tier } from '../types.js';

export interface StreamLike { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdout: StreamLike | null;
  readonly stderr: StreamLike | null;
  once(event: 'error', listener: (err: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: string | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface SpawnOptionsStrict {
  cwd: string;
  env: Record<string, string>;
  stdio: ['ignore', 'pipe', 'pipe'];
  shell: false;
  windowsHide: true;
}
export type SpawnLike = (command: string, args: readonly string[], options: SpawnOptionsStrict) => ChildLike;

/** Default spawn: node:child_process with the strict options (never a shell). */
export const nodeSpawn: SpawnLike = (command, args, options) => nodeSpawnImpl(command, [...args], options) as unknown as ChildLike;

/** Kill the whole tree: `taskkill /PID <pid> /T /F` on Windows (absolute path, no PATH lookup), SIGKILL elsewhere. */
export function defaultKillTree(child: ChildLike, opts: { platform?: NodeJS.Platform; systemRoot?: string; spawn?: SpawnLike } = {}): void {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' && child.pid !== undefined) {
    const root = opts.systemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    try {
      const k = (opts.spawn ?? nodeSpawn)(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { cwd: root, env: { SYSTEMROOT: root }, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      k.once('error', () => child.kill('SIGKILL'));
      return;
    } catch { /* fall through */ }
  }
  child.kill('SIGKILL');
}

/**
 * SEC-065 / LOCAL_AI_MODELS §3.2 `minimalEnv`. Nothing else from the parent environment is inherited.
 * Per platform (DEPLOYMENT_AND_PACKAGING §17): Windows finds the engine DLLs through PATH (= the engine folder) and needs SYSTEMROOT;
 * Linux gets LD_LIBRARY_PATH = the engine folder (the shipped binaries also carry RUNPATH $ORIGIN, this covers a library loaded
 * by name with dlopen) and TMPDIR = the job folder; macOS relies on the binaries' LC_RPATH @loader_path / @executable_path and
 * gets no DYLD_* variable (the hardened runtime strips them, and they would let a planted library in) — only TMPDIR.
 */
export function buildChildEnv(opts: { engineDir: string; jobDir: string; parentEnv?: Readonly<Record<string, string | undefined>>; extra?: Record<string, string>; platform?: NodeJS.Platform }): Record<string, string> {
  const parent = opts.parentEnv ?? process.env;
  const platform = opts.platform ?? process.platform;
  const env: Record<string, string> = {
    TEMP: opts.jobDir, TMP: opts.jobDir, PATH: opts.engineDir, NO_PROXY: '*', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1',
  };
  if (platform === 'win32') {
    const systemRoot = parent.SYSTEMROOT ?? parent.SystemRoot;
    if (systemRoot) env.SYSTEMROOT = systemRoot;
  } else {
    env.TMPDIR = opts.jobDir;
    if (platform === 'linux') env.LD_LIBRARY_PATH = opts.engineDir;
  }
  if (parent.LANG) env.LANG = parent.LANG;
  return { ...env, ...(opts.extra ?? {}) };
}

/** LOCAL_AI_MODELS §3.2: threads = max(1, min(8, cpus − 2)) on T0; GPU variants use the same CPU budget for host threads. */
export const defaultThreads = (cpuCount: number): number => Math.max(1, Math.min(8, cpuCount - 2));

/** LOCAL_AI_MODELS §3.3 timeouts. */
export const ENGINE_TIMEOUTS = Object.freeze({
  captions: (audioMs: number): number => 10 * Math.max(0, audioMs) + 60_000,
  ttsChunk: 60_000,
  thumbnail: (tier: Tier): number => (tier === 'T0' ? 15 * 60_000 : 3 * 60_000),
  music: 20 * 60_000,
});

export const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Is `p` inside `root` (after resolution)? */
export function isInside(root: string, p: string): boolean {
  const rel = relative(resolve(root), resolve(p));
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel);
}
export function assertInside(root: string, p: string, what: string): void {
  if (!isAbsolute(p) || !isInside(root, p)) throw emError('EM-7101', `${what} path is outside its allowed folder`, { reason: 'path-outside-root', what });
}
export function assertAbsolute(p: string, what: string): void {
  if (!isAbsolute(p)) throw emError('EM-7101', `${what} path must be absolute`, { reason: 'path-not-absolute', what });
}

/** A value that starts with '-' would be read as a flag by the engine's option parser; a leading space neutralises it. */
export const safeArgValue = (s: string): string => (s.startsWith('-') ? ` ${s}` : s);

export const exeName = (base: string, platform: NodeJS.Platform = process.platform): string => (platform === 'win32' ? `${base}.exe` : base);

class TailBuffer {
  private chunks: string[] = []; private size = 0; private partial = '';
  constructor(private readonly max: number, private readonly onLine?: (line: string) => void) {}
  push(chunk: Buffer | string): void {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.chunks.push(s); this.size += s.length;
    while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.max) { const only = this.chunks[0]!; this.chunks[0] = only.slice(only.length - this.max); this.size = this.max; }
    if (this.onLine) {
      const parts = (this.partial + s).split(/\r\n|\n|\r/);
      this.partial = parts.pop() ?? '';
      if (this.partial.length > this.max) this.partial = this.partial.slice(-this.max);
      for (const line of parts) this.onLine(line);
    }
  }
  flush(): void { if (this.onLine && this.partial !== '') { this.onLine(this.partial); this.partial = ''; } }
  text(): string { return this.chunks.join(''); }
}

export interface RunSpec {
  engine: string;
  exe: string;
  args: readonly string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  spawn?: SpawnLike;
  killTree?: (child: ChildLike) => void;
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  maxOutputBytes?: number;
  /** After a kill, how long to wait for 'close' before settling anyway. */
  killGraceMs?: number;
}
export interface RunResult { exitCode: number; stdout: string; stderr: string }

export const lastLines = (s: string, n: number): string[] => s.split(/\r?\n/).filter((l) => l.trim() !== '').slice(-n);
/**
 * Engine stderr lines as they go into error details and the engine log: positional argument values that are not paths (the text
 * to speak, a prompt) are replaced by `<arg>` because some engines echo their command line; lines are cut at 400 characters.
 * Secrets and the Windows user name are removed later by the logger's redaction (SEC-100).
 */
export function redactEngineLines(lines: readonly string[], args: readonly string[]): string[] {
  const values = args.filter((a) => !/^-[A-Za-z-]/.test(a)).map((a) => a.trim()).filter((a) => a.length >= 3 && !isAbsolute(a) && !/^[\d.,:x-]+$/.test(a))
    .sort((a, b) => b.length - a.length);
  return lines.map((l) => {
    let s = l;
    for (const v of values) s = s.split(v).join('<arg>');
    return s.length > 400 ? `${s.slice(0, 400)}…` : s;
  });
}

/** Spawns one Engine Binary. Errors: EM-7101 (spawn failure / non-zero exit), EM-7102 (timeout), CancelledError (abort). */
export function runProcess(spec: RunSpec): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, reject) => {
    if (spec.signal?.aborted) { reject(new CancelledError()); return; }
    assertAbsolute(spec.exe, 'engine executable');
    const max = spec.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    const out = new TailBuffer(max, spec.onStdoutLine);
    const err = new TailBuffer(max, spec.onStderrLine);
    const tail = (): string[] => redactEngineLines(lastLines(err.text(), 20), spec.args);
    let child: ChildLike;
    try {
      child = (spec.spawn ?? nodeSpawn)(spec.exe, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (e) {
      reject(emError('EM-7101', `${spec.engine} could not be started`, { engine: spec.engine, cause: 'spawn', message: e instanceof Error ? e.message : String(e) }, e));
      return;
    }
    let settled = false; let killedFor: 'timeout' | 'abort' | null = null; let graceTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const failKilled = (): void => {
      if (killedFor === 'timeout') finish(() => reject(emError('EM-7102', `${spec.engine} did not finish in time and was stopped`, { engine: spec.engine, cause: 'timeout', timeoutMs: spec.timeoutMs, stderrTail: tail() })));
      else finish(() => reject(new CancelledError()));
    };
    const kill = (why: 'timeout' | 'abort'): void => {
      if (killedFor || settled) return;
      killedFor = why;
      try { (spec.killTree ?? defaultKillTree)(child); } catch { /* best effort */ }
      graceTimer = setTimeout(failKilled, spec.killGraceMs ?? 5000);
    };
    const onAbort = (): void => kill('abort');
    const timer = setTimeout(() => kill('timeout'), spec.timeoutMs);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));
    child.once('error', (e) => {
      if (killedFor) { failKilled(); return; }
      finish(() => reject(emError('EM-7101', `${spec.engine} could not be started`, { engine: spec.engine, cause: 'spawn', message: e.message }, e)));
    });
    child.once('close', (code, signal) => {
      out.flush(); err.flush();
      if (killedFor) { failKilled(); return; }
      if (code === 0) finish(() => resolvePromise({ exitCode: 0, stdout: out.text(), stderr: err.text() }));
      else finish(() => reject(emError('EM-7101', `${spec.engine} stopped unexpectedly`, { engine: spec.engine, cause: signal ? 'crash' : 'exit', exitCode: code, signal, stderrTail: tail() })));
    });
  });
}

// SEC-062: one temp directory per job under `<tmpRoot>/jobs/<jobId>/`, removed on completion, cancellation or next start.
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function jobDirPath(tmpRoot: string, jobId: string): string {
  if (!JOB_ID_RE.test(jobId)) throw new RangeError(`invalid job id ${jobId}`);
  return join(resolve(tmpRoot), 'jobs', jobId);
}
export async function createJobDir(tmpRoot: string, jobId: string): Promise<string> {
  const dir = jobDirPath(tmpRoot, jobId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  return dir;
}
export async function removeJobDir(tmpRoot: string, jobId: string): Promise<void> {
  await rm(jobDirPath(tmpRoot, jobId), { recursive: true, force: true });
}
/** Runs `fn` with a fresh job dir and always removes it afterwards. */
export async function withJobDir<T>(tmpRoot: string, jobId: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await createJobDir(tmpRoot, jobId);
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Orphan sweep at service start: removes every job dir except `keep`. Returns the removed ids. */
export async function sweepJobDirs(tmpRoot: string, keep: readonly string[] = []): Promise<string[]> {
  const base = join(resolve(tmpRoot), 'jobs');
  const names = await readdir(base).catch(() => [] as string[]);
  const removed: string[] = [];
  for (const n of names) {
    if (keep.includes(n) || !JOB_ID_RE.test(n)) continue;
    await rm(join(base, n), { recursive: true, force: true });
    removed.push(n);
  }
  return removed;
}
