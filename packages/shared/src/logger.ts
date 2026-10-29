export interface Logger {
  debug(o: object, msg?: string): void;
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
  child(bindings: object): Logger;
}
/**
 * Secret redaction applied to every log line (SECURITY.md SEC-100 table): provider keys, bearer tokens, query tokens, media grants,
 * `x-api-key` headers, `"apiKey"` JSON fields, labelled 64-hex Database Keys, `x'<hex>'` SQL key literals, and the user name in
 * Windows (`C:\Users\<name>`), Linux (`/home/<name>`) and macOS (`/Users/<name>`) paths. A pattern with a capture group keeps group 1 (the label) and redacts the rest.
 */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  /\bsk-or-v1-[A-Za-z0-9]{8,}/g, /\bsk-ant-[A-Za-z0-9_-]{8,}/g, /\bsk-[A-Za-z0-9_-]{8,}/g, /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /([?&](?:token|grant)=)[^&\s"]+/gi, /(\/media\/)[A-Za-z0-9_-]{43}(?=\/)/g,
  /(x-api-key\\?["']?\s*[:=]\s*\\?["']?)[^\s"'\\,}]+/gi,
  /(\\?"api_?key\\?"\s*:\s*\\?")[^"\\]+/gi,
  /(\b(?:db_?key(?:_?hex)?|key)\\?["']?\s*[:=]\s*\\?["']?(?:x')?)[0-9a-f]{64}\b/gi,
  /(x')[0-9a-f]{64}(?=')/gi,
];
/** Windows user profile segment in paths (`C:\Users\<name>\`, JSON-escaped or with `/`) → `%USER%` (SEC-100). */
const WINDOWS_USER_PATH = /([A-Za-z]:(?:\\{1,2}|\/)Users(?:\\{1,2}|\/))(?!%USER%)[^\\/"'\r\n\t:*?<>|]+/gi;
/** POSIX home segment (`/home/<name>/`, `/Users/<name>/`) at the start of a path token → `%USER%` (SEC-100, Linux/macOS builds). */
const POSIX_USER_PATH = /((?:^|[\s"'=(,[])\/(?:home|Users)\/)(?!%USER%)[^/"'\s\\:*?<>|]+/g;
export function redact(text: string): string {
  let out = text;
  for (const re of REDACTION_PATTERNS) out = out.replace(re, (_m, p1?: string) => (typeof p1 === 'string' ? `${p1}[REDACTED]` : '[REDACTED]'));
  return out.replace(WINDOWS_USER_PATH, (_m, p1: string) => `${p1}%USER%`).replace(POSIX_USER_PATH, (_m, p1: string) => `${p1}%USER%`);
}
/** SEC-016 (round 2): replaces literal secret values (the Service Token of this run) wherever they appear; values < 8 chars are ignored. */
export function redactLiterals(text: string, secrets: readonly (string | null | undefined)[]): string {
  let out = text;
  for (const x of secrets) if (typeof x === 'string' && x.length >= 8) out = out.split(x).join('[REDACTED]');
  return out;
}
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };
