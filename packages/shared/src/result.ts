export type Severity = 'info' | 'warn' | 'block';
/** A validation finding: CM-xxx (Composition Model), AI plan validation, preset params, ingest. */
export interface Issue { code: string; path: string; message: string; severity: Severity }
export type Result<T> = { ok: true; value: T; warnings: Issue[] } | { ok: false; issues: Issue[] };

export const ok = <T>(value: T, warnings: Issue[] = []): Result<T> => ({ ok: true, value, warnings });
export const fail = <T = never>(issues: Issue[]): Result<T> => ({ ok: false, issues });
export const issue = (code: string, message: string, severity: Severity = 'block', path = ''): Issue => ({ code, path, message, severity });
export const hasBlocking = (issues: readonly Issue[]): boolean => issues.some((i) => i.severity === 'block');
