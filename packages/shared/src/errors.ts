// EmError: the one error type that crosses package boundaries. Codes and copy are owned by docs/ERROR_CATALOGUE.md;
// HTTP status mapping by docs/API_SPECIFICATION.md §2.6.
export type EmCode = `EM-${number}`;
export const EM_CODE_RE = /^EM-\d{4}$/;

/** Explicit status per code where API_SPECIFICATION.md §2.6 assigns one; otherwise statusForCode() falls back by range. */
export const HTTP_STATUS_BY_CODE: Readonly<Record<string, number>> = Object.freeze({
  'EM-9002': 400, 'EM-2102': 400, 'EM-2402': 400,
  'EM-8004': 401,
  'EM-8005': 403, 'EM-8302': 403, 'EM-1007': 403, 'EM-5010': 403,
  'EM-9003': 404, 'EM-6101': 404, 'EM-2401': 404, 'EM-1301': 404,
  'EM-2301': 409, 'EM-2309': 409, 'EM-1101': 409, 'EM-4305': 409, 'EM-6004': 409, 'EM-6103': 409, 'EM-6303': 409, 'EM-7104': 409,
  'EM-8006': 413, 'EM-1002': 413, 'EM-1008': 413, 'EM-1010': 413,
  'EM-2001': 422, 'EM-2002': 422, 'EM-2101': 422, 'EM-2104': 422, 'EM-2105': 422, 'EM-2201': 422, 'EM-2202': 422, 'EM-2302': 422,
  'EM-2303': 422, 'EM-2304': 422, 'EM-2306': 422, 'EM-3101': 422, 'EM-3102': 422, 'EM-3103': 422, 'EM-3104': 422, 'EM-3105': 422,
  'EM-3106': 422, 'EM-1001': 422, 'EM-1003': 422, 'EM-1009': 422, 'EM-4002': 422, 'EM-4004': 422, 'EM-5002': 422, 'EM-5003': 422,
  'EM-9004': 422, 'EM-1302': 422, 'EM-1011': 422, 'EM-7110': 422, 'EM-5004': 422, 'EM-5005': 422, 'EM-5006': 422, 'EM-5007': 422, 'EM-5008': 422, 'EM-7004': 422, 'EM-7105': 422, 'EM-7106': 422,
  'EM-8202': 423, 'EM-4401': 423,
  'EM-9005': 429, 'EM-5011': 429,
  'EM-9001': 500,
  'EM-4103': 502, 'EM-4104': 502,
  'EM-6001': 503, 'EM-6002': 503, 'EM-6005': 503, 'EM-8201': 503, 'EM-3001': 503, 'EM-4003': 503,
  'EM-4101': 504,
});

export function statusForCode(code: EmCode): number {
  const explicit = HTTP_STATUS_BY_CODE[code];
  if (explicit !== undefined) return explicit;
  switch (code.charAt(3)) {
    case '1': case '2': case '3': case '5': case '7': return 422;   // validation-type failures of a well-formed request
    case '4': return 502;                                            // provider side
    case '6': return 503;                                            // storage
    case '8': return 503;                                            // shell / service / network
    default: return 500;
  }
}

export class EmError extends Error {
  readonly code: EmCode;
  readonly status: number;
  readonly details?: unknown;
  readonly path?: string;
  constructor(code: EmCode, message: string, opts: { status?: number; details?: unknown; path?: string; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    if (!EM_CODE_RE.test(code)) throw new TypeError(`invalid EM code ${code}`);
    this.name = 'EmError';
    this.code = code;
    this.status = opts.status ?? statusForCode(code);
    if (opts.details !== undefined) this.details = opts.details;
    if (opts.path !== undefined) this.path = opts.path;
  }
  /** API error envelope (API_SPECIFICATION.md §2.6): never stack traces or installation paths. */
  toEnvelope(): { error: { code: EmCode; message: string; details?: unknown; path?: string } } {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }), ...(this.path === undefined ? {} : { path: this.path }) } };
  }
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
export const truncate = (s: string, max = 4000): string => (s.length > max ? `${s.slice(0, max)}…` : s);
