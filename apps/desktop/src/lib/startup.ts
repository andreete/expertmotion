/**
 * Startup phases pushed to the Editor's splash (FR-184; QA 2026-10-26 "sering blackscreen"). Pure module: no `electron`
 * import, no dependencies, so the sandboxed preload can use the same validator (unit-tested on Linux).
 *
 * The Shell pushes `{status:'starting', phase, progress?, sinceMs}` on the existing service-state channel (IPC.serviceState)
 * while it checks the program files (integrity, SEC-133), unwraps the Database Key (keyring, SEC-040) and starts the Local
 * Service (service). `project` is the Editor's own last phase (first project load) and is never pushed by the Shell.
 */

export const STARTUP_PHASES = ['integrity', 'keyring', 'service', 'project'] as const;
export type StartupPhase = (typeof STARTUP_PHASES)[number];
export const SERVICE_STATUSES = ['starting', 'ready', 'offline', 'failed'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export interface ServiceStatePush {
  status: ServiceStatus;
  /** A fresh endpoint after a Service (re)start (API_SPECIFICATION §2.1 rotation). */
  bootstrap?: { port: number; token: string };
  /** EM- code when status is 'failed' (EM-8002, EM-6001) or 'offline' (EM-8001). */
  code?: string;
  /** Logs folder for "Open log folder" on a failure. */
  logsDir?: string;
  /** Current startup step while status is 'starting'. */
  phase?: StartupPhase;
  /** 0…1 within the phase (integrity: bytes hashed / bytes listed). */
  progress?: number;
  /** Milliseconds since the Shell started (the splash shows elapsed seconds after 5 s). */
  sinceMs?: number;
}

const EM_CODE = /^EM-\d{4}$/;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/** One hour: a larger value is not a startup time. */
const MAX_SINCE_MS = 3_600_000;

/** Validates a push (preload, before it reaches the Editor callback). Unknown keys are dropped; anything malformed → null. */
export function parseServiceStatePush(raw: unknown): ServiceStatePush | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (!(SERVICE_STATUSES as readonly unknown[]).includes(r['status'])) return null;
  const out: ServiceStatePush = { status: r['status'] as ServiceStatus };
  const b = r['bootstrap'];
  if (b !== undefined) {
    if (typeof b !== 'object' || b === null) return null;
    const { port, token } = b as Record<string, unknown>;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || typeof token !== 'string' || !TOKEN.test(token)) return null;
    out.bootstrap = { port, token };
  }
  if (r['code'] !== undefined) { if (typeof r['code'] !== 'string' || !EM_CODE.test(r['code'])) return null; out.code = r['code']; }
  if (r['logsDir'] !== undefined) { if (typeof r['logsDir'] !== 'string' || r['logsDir'].length > 1024 || r['logsDir'].includes('\0')) return null; out.logsDir = r['logsDir']; }
  if (r['phase'] !== undefined) { if (!(STARTUP_PHASES as readonly unknown[]).includes(r['phase'])) return null; out.phase = r['phase'] as StartupPhase; }
  if (r['progress'] !== undefined) { const p = r['progress']; if (typeof p !== 'number' || !Number.isFinite(p)) return null; out.progress = Math.min(1, Math.max(0, p)); }
  if (r['sinceMs'] !== undefined) { const s = r['sinceMs']; if (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > MAX_SINCE_MS) return null; out.sinceMs = Math.round(s); }
  return out;
}

/** The `starting` push for a phase. */
export function startingPush(phase: Exclude<StartupPhase, 'project'>, startedAt: number, now: number, progress?: number): ServiceStatePush {
  return { status: 'starting', phase, sinceMs: Math.min(MAX_SINCE_MS, Math.max(0, now - startedAt)), ...(progress === undefined ? {} : { progress: Math.min(1, Math.max(0, progress)) }) };
}

/** Integrity progress pushes are throttled: at most one per `everyMs`, always the first and the last (done === total). */
export function shouldPushProgress(lastAt: number | null, now: number, done: number, total: number, everyMs = 250): boolean {
  return lastAt === null || done >= total || now - lastAt >= everyMs;
}
