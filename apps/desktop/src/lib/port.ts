/**
 * Loopback port selection for the Local Service (SECURITY.md SEC-008, TRD TR-003).
 * The Shell probes a random free port in 47600–47699, hands it to the Service, and on
 * `EADDRINUSE` (reported by the Service) picks another. Never a fixed well-known port.
 */
import { createServer } from 'node:net';
import { randomInt } from 'node:crypto';
import { PORT_MAX_ATTEMPTS, PORT_RANGE } from './constants.js';

export type PortProbe = (port: number) => Promise<boolean>;
export type RandomInt = (minInclusive: number, maxExclusive: number) => number;

export interface PickPortOptions {
  probe?: PortProbe;
  random?: RandomInt;
  /** Ports already tried (e.g. the Service reported EADDRINUSE for them). */
  exclude?: ReadonlySet<number>;
  maxAttempts?: number;
  range?: { min: number; max: number };
}

export class NoFreePortError extends Error {
  constructor(readonly tried: readonly number[]) {
    super(`no free loopback port after ${tried.length} attempts`);
    this.name = 'NoFreePortError';
  }
}

/** True when `port` can be bound on 127.0.0.1 right now (the socket is closed again immediately). */
export const probeLoopbackPort: PortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

export function isInPortRange(port: number, range: { min: number; max: number } = PORT_RANGE): boolean {
  return Number.isInteger(port) && port >= range.min && port <= range.max;
}

/** Random candidate from the range that is neither excluded nor tried yet; `null` when exhausted. */
export function nextCandidate(range: { min: number; max: number }, skip: ReadonlySet<number>, random: RandomInt): number | null {
  const free: number[] = [];
  for (let p = range.min; p <= range.max; p += 1) if (!skip.has(p)) free.push(p);
  if (free.length === 0) return null;
  return free[random(0, free.length)] ?? null;
}

/** Picks a free port, probing at most `maxAttempts` (default 10) random candidates. */
export async function pickPort(opts: PickPortOptions = {}): Promise<number> {
  const probe = opts.probe ?? probeLoopbackPort;
  const random = opts.random ?? randomInt;
  const range = opts.range ?? PORT_RANGE;
  const maxAttempts = opts.maxAttempts ?? PORT_MAX_ATTEMPTS;
  const skip = new Set<number>(opts.exclude ?? []);
  const tried: number[] = [];
  while (tried.length < maxAttempts) {
    const candidate = nextCandidate(range, skip, random);
    if (candidate === null) break;
    skip.add(candidate);
    tried.push(candidate);
    if (await probe(candidate)) return candidate;
  }
  throw new NoFreePortError(tried);
}
