// JSON-lines logger with secret redaction (SEC-100) and 7-day rotation by date-stamped files.
import fs from 'node:fs';
import path from 'node:path';
import { redact, type Logger } from '@expertmotion/shared';

export function createLogger(dir: string, opts: { echo?: boolean; bindings?: object } = {}): Logger {
  const file = () => path.join(dir, `service-${new Date().toISOString().slice(0, 10)}.log`);
  const write = (level: string, o: object, msg?: string) => {
    const line = redact(JSON.stringify({ t: new Date().toISOString(), level, ...(opts.bindings ?? {}), ...o, ...(msg ? { msg } : {}) }));
    try { fs.appendFileSync(file(), `${line}\n`); } catch { /* disk full: logging must never crash the service */ }
    if (opts.echo) process.stderr.write(`${line}\n`);
  };
  return { debug: (o, m) => write('debug', o, m), info: (o, m) => write('info', o, m), warn: (o, m) => write('warn', o, m), error: (o, m) => write('error', o, m),
    child: (b) => createLogger(dir, { ...opts, bindings: { ...(opts.bindings ?? {}), ...b } }) };
}
export function pruneLogs(dir: string, keepDays = 7, now = Date.now()): number {
  let n = 0;
  for (const f of fs.readdirSync(dir)) { const m = /^service-(\d{4}-\d{2}-\d{2})\.log$/.exec(f); if (m && now - Date.parse(m[1]!) > keepDays * 86_400_000) { fs.rmSync(path.join(dir, f)); n++; } }
  return n;
}
