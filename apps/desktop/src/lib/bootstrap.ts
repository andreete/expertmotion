/**
 * The bootstrap message sent to the Local Service over `utilityProcess.postMessage` (SEC-002,
 * TRD TR-002). Nothing secret ever goes through argv, env, stdin or a file. The Service replies
 * `{type:'ready', port}` or `{type:'fatal', code}`. These are pure builders/parsers (unit-tested).
 */
export interface BootstrapMessage {
  readonly type: 'bootstrap';
  readonly token: string;
  readonly port: number;
  readonly dataDir: string;
  readonly dbKeyHex: string;
  /** Half B of the prompt-assets key (release builds only; SEC-133). */
  readonly promptKeyHalf?: string;
}

export interface ShutdownMessage {
  readonly type: 'shutdown';
}

export type ShellToService = BootstrapMessage | ShutdownMessage;

export type ServiceToShell = { type: 'ready'; port: number } | { type: 'fatal'; code: string };

const HEX32 = /^[0-9a-f]{64}$/;

export function buildBootstrap(args: { token: string; port: number; dataDir: string; dbKeyHex: string; promptKeyHalf?: string }): BootstrapMessage {
  if (args.token.length < 16) throw new Error('bootstrap: token too short');
  if (!Number.isInteger(args.port) || args.port <= 0 || args.port > 65535) throw new Error('bootstrap: bad port');
  if (args.dataDir.length === 0) throw new Error('bootstrap: empty dataDir');
  if (!HEX32.test(args.dbKeyHex)) throw new Error('bootstrap: dbKeyHex must be 64 lowercase hex chars (32 bytes)');
  if (args.promptKeyHalf !== undefined && args.promptKeyHalf !== '' && !HEX32.test(args.promptKeyHalf)) throw new Error('bootstrap: promptKeyHalf must be 64 lowercase hex chars');
  return { type: 'bootstrap', token: args.token, port: args.port, dataDir: args.dataDir, dbKeyHex: args.dbKeyHex, ...(args.promptKeyHalf ? { promptKeyHalf: args.promptKeyHalf } : {}) };
}

export const shutdownMessage: ShutdownMessage = { type: 'shutdown' };

/** Parses an untrusted message from the Service's parent port; returns null if it is not well-formed. */
export function parseServiceMessage(value: unknown): ServiceToShell | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type === 'ready' && Number.isInteger(v.port)) return { type: 'ready', port: v.port as number };
  if (v.type === 'fatal' && typeof v.code === 'string') return { type: 'fatal', code: v.code };
  return null;
}
