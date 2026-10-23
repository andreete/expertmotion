export interface Logger {
  debug(o: object, msg?: string): void;
  info(o: object, msg?: string): void;
  warn(o: object, msg?: string): void;
  error(o: object, msg?: string): void;
  child(bindings: object): Logger;
}
/** Secret redaction applied to every log line (SECURITY.md SEC-100): provider keys, bearer tokens, query tokens, media grants. */
export const REDACTION_PATTERNS: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{10,}/g, /sk-ant-[A-Za-z0-9_-]{10,}/g, /sk-[A-Za-z0-9_-]{20,}/g, /AIza[0-9A-Za-z_-]{30,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/g, /([?&](?:token|grant)=)[^&\s"]+/g, /(\/media\/)[A-Za-z0-9_-]{43}(?=\/)/g,
];
export function redact(text: string): string {
  let out = text;
  for (const re of REDACTION_PATTERNS) out = out.replace(re, (_m, p1?: string) => (typeof p1 === 'string' ? `${p1}[REDACTED]` : '[REDACTED]'));
  return out;
}
export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return silentLogger; } };
