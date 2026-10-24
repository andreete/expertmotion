import { EmError, type EmCode } from '@expertmotion/shared';

/** Thrown when an AbortSignal stops a download, a process or a job. Not an EmError: cancellation is not a failure. */
export class CancelledError extends Error {
  constructor(message = 'cancelled') { super(message); this.name = 'CancelledError'; }
}
export const isCancelled = (err: unknown): err is CancelledError => err instanceof CancelledError;

export const emError = (code: EmCode, message: string, details?: Record<string, unknown>, cause?: unknown): EmError =>
  new EmError(code, message, { ...(details === undefined ? {} : { details }), ...(cause === undefined ? {} : { cause }) });

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}
