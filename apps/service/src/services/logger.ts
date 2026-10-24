// JSON-lines logger with secret redaction (SEC-100) and rotation (SEC-101): one date-stamped file per day
// (`<prefix>-YYYY-MM-DD.log`, prefix service | engine | shell), each ≤ 20 MB (the full file is moved to `.old`, replacing the
// previous `.old`, so the oldest lines go first), files older than 7 days deleted at start (pruneLogs).
import fs from 'node:fs';
import path from 'node:path';
import { redact, type Logger } from '@expertmotion/shared';

export const LOG_MAX_BYTES = 20 * 1024 * 1024;
export const LOG_KEEP_DAYS = 7;
export type LogPrefix = 'service' | 'engine' | 'shell';

interface Sink { file: string; bytes: number }

export function createLogger(dir: string, opts: { echo?: boolean; bindings?: object; prefix?: LogPrefix; maxBytes?: number; now?: () => Date } = {}): Logger {
  const prefix = opts.prefix ?? 'service';
  const max = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  const sink: Sink = { file: '', bytes: 0 };
  return makeLogger(dir, opts, prefix, max, now, sink);
}

function makeLogger(dir: string, opts: { echo?: boolean; bindings?: object }, prefix: LogPrefix, max: number, now: () => Date, sink: Sink): Logger {
  const write = (level: string, o: object, msg?: string) => {
    const d = now();
    const line = `${redact(JSON.stringify({ t: d.toISOString(), level, ...(opts.bindings ?? {}), ...o, ...(msg ? { msg } : {}) }))}\n`;
    try {
      const file = path.join(dir, `${prefix}-${d.toISOString().slice(0, 10)}.log`);
      if (sink.file !== file) { sink.file = file; try { sink.bytes = fs.statSync(file).size; } catch { sink.bytes = 0; } }
      const len = Buffer.byteLength(line);
      if (sink.bytes > 0 && sink.bytes + len > max) { fs.renameSync(file, `${file}.old`); sink.bytes = 0; }
      fs.appendFileSync(file, line);
      sink.bytes += len;
    } catch { /* disk full: logging must never crash the service */ }
    if (opts.echo) process.stderr.write(line);
  };
  return { debug: (o, m) => write('debug', o, m), info: (o, m) => write('info', o, m), warn: (o, m) => write('warn', o, m), error: (o, m) => write('error', o, m),
    // children share the sink so the size accounting stays exact
    child: (b) => makeLogger(dir, { ...opts, bindings: { ...(opts.bindings ?? {}), ...b } }, prefix, max, now, sink) };
}

/** Deletes `service|engine|shell-YYYY-MM-DD.log[.old]` older than `keepDays` (SEC-101, FR-175). Returns the number removed. */
export function pruneLogs(dir: string, keepDays = LOG_KEEP_DAYS, now = Date.now()): number {
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = /^(?:service|engine|shell)-(\d{4}-\d{2}-\d{2})\.log(?:\.old)?$/.exec(f);
    if (m && now - Date.parse(m[1]!) > keepDays * 86_400_000) { try { fs.rmSync(path.join(dir, f)); n++; } catch { /* in use */ } }
  }
  return n;
}
