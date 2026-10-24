// Child-process runner for FFmpeg/ffprobe (SEC-060…065): argument arrays, shell:false, windowsHide, scrubbed env, timeout and
// abort kill the process, stdout/stderr tails capped. Never logs arguments (they contain media paths).
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { Logger } from '@expertmotion/shared';

/** `logs/engine-YYYY-MM-DD.log` (SEC-101, DEPLOYMENT §14): redacted stderr tails of failed Engine Binary runs and renders. */
let engineLog: Logger | null = null;
export function setEngineLog(l: Logger | null): void { engineLog = l; }
export function getEngineLog(): Logger | null { return engineLog; }

export interface ToolRun {
  exe: string; args: readonly string[]; cwd?: string; timeoutMs: number; signal?: AbortSignal;
  /** Raw stdout chunks (e.g. PCM for waveforms). When absent stdout is collected (capped). */
  onStdout?: (chunk: Buffer) => void;
  onStdoutLine?: (line: string) => void;
  maxCollectBytes?: number;
}
export interface ToolResult { code: number; stdout: string; stderrTail: string[] }
export class ToolError extends Error {
  constructor(readonly reason: 'spawn' | 'exit' | 'timeout' | 'cancelled', message: string, readonly code: number | null = null, readonly stderrTail: string[] = []) { super(message); this.name = 'ToolError'; }
}

/** SEC-065 minimal environment: PATH reduced to the binary's own folder (or the parent PATH in development when the binary is a bare name). */
export function toolEnv(exe: string, tmp?: string): Record<string, string> {
  const env: Record<string, string> = { PATH: path.isAbsolute(exe) ? path.dirname(exe) : (process.env['PATH'] ?? '') };
  for (const k of ['SYSTEMROOT', 'LANG']) { const v = process.env[k]; if (v) env[k] = v; }
  if (tmp) { env['TEMP'] = tmp; env['TMP'] = tmp; env['TMPDIR'] = tmp; }
  return env;
}

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    const root = process.env['SYSTEMROOT'] ?? 'C:\\Windows';
    try { spawn(path.join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).once('error', () => child.kill('SIGKILL')); return; } catch { /* fall through */ }
  }
  child.kill('SIGKILL');
}

export function runTool(spec: ToolRun): Promise<ToolResult> {
  return new Promise((resolve, reject) => {
    if (spec.signal?.aborted) { reject(new ToolError('cancelled', 'cancelled')); return; }
    let child: ChildProcess;
    try {
      child = spawn(spec.exe, [...spec.args], { cwd: spec.cwd, env: toolEnv(spec.exe, spec.cwd), stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch (e) { reject(new ToolError('spawn', e instanceof Error ? e.message : String(e))); return; }
    const max = spec.maxCollectBytes ?? 4 * 1024 * 1024;
    const out: Buffer[] = []; let outBytes = 0; let errTail = ''; let partial = '';
    let killedFor: 'timeout' | 'cancelled' | null = null; let settled = false;
    const done = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); spec.signal?.removeEventListener('abort', onAbort); fn(); };
    const kill = (why: 'timeout' | 'cancelled') => { if (killedFor) return; killedFor = why; killTree(child); };
    const onAbort = () => kill('cancelled');
    const timer = setTimeout(() => kill('timeout'), spec.timeoutMs);
    spec.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout!.on('data', (c: Buffer) => {
      if (spec.onStdout) spec.onStdout(c);
      else if (outBytes < max) { out.push(c); outBytes += c.length; }
      if (spec.onStdoutLine) { const parts = (partial + c.toString('utf8')).split(/\r?\n/); partial = parts.pop() ?? ''; for (const l of parts) spec.onStdoutLine(l); }
    });
    child.stderr!.on('data', (c: Buffer) => { errTail = (errTail + c.toString('utf8')).slice(-8192); });
    const tail = () => errTail.split(/\r?\n/).filter((l) => l.trim()).slice(-10);
    child.once('error', (e) => done(() => reject(new ToolError(killedFor ?? 'spawn', e.message))));
    child.once('close', (code) => done(() => {
      if (killedFor || code !== 0) engineLog?.warn({ exe: path.basename(spec.exe), reason: killedFor ?? 'exit', exitCode: code, stderrTail: tail() }, 'engine binary failed');
      if (killedFor) reject(new ToolError(killedFor, killedFor === 'timeout' ? `timed out after ${spec.timeoutMs} ms` : 'cancelled', code, tail()));
      else if (code === 0) resolve({ code: 0, stdout: Buffer.concat(out).toString('utf8'), stderrTail: tail() });
      else reject(new ToolError('exit', `exited with ${code}`, code, tail()));
    }));
  });
}
