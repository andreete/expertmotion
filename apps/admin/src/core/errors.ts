/** Errors returned to the renderer as {ok:false, error}. Never carries a passphrase or key material. */
export type AdminErrorCode = 'EINVAL' | 'LOCKED' | 'NETWORK' | 'PATH' | 'PASSPHRASE' | 'POLICY' | 'ENV' | 'INTERNAL';

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  constructor(code: AdminErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface WireError {
  code: string;
  message: string;
  /** EM- code from the licence policy, e.g. EM-5008 */
  emCode?: string;
}

/** CliError from tools/license-cli: exitCode 2 usage, 3 policy, 4 environment/key. */
interface CliLike { exitCode?: unknown; code?: unknown; message: string }

export function toWireError(e: unknown): WireError {
  if (e instanceof AdminError) return { code: e.code, message: e.message };
  if (e instanceof Error && typeof (e as CliLike).exitCode === 'number') {
    const c = e as CliLike;
    const code = c.exitCode === 2 ? 'EINVAL' : c.exitCode === 3 ? 'POLICY' : 'ENV';
    // The shared ops speak CLI ("--name must be…"); drop the flag dashes for the GUI.
    const message = c.message.replace(/(^|[\s(])--([a-z][a-z-]*)/g, '$1$2');
    return typeof c.code === 'string' ? { code, message, emCode: c.code } : { code, message };
  }
  return { code: 'INTERNAL', message: 'Unexpected error. Details are not shown to avoid leaking key material; check the input and try again.' };
}
