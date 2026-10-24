/**
 * Shell log file sink (SECURITY.md SEC-101, FR-175): `logs/shell-YYYY-MM-DD.log` (the name the Service's diagnostics bundle
 * collects), each file ≤ 20 MB — a full file is moved to `.old` (replacing the previous one) so the oldest lines go first —
 * and files older than 7 days deleted at start. Lines arrive already redacted (SEC-100). No `electron` import (unit-tested).
 */
import { appendFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_MAX_BYTES, LOG_RETENTION_DAYS } from './constants.js';

export interface RotatingLog { write(line: string): void; currentFile(): string }

export function createRotatingLog(dir: string, prefix: 'shell' | 'engine', opts: { maxBytes?: number; now?: () => Date } = {}): RotatingLog {
  const max = opts.maxBytes ?? LOG_MAX_BYTES;
  const now = opts.now ?? (() => new Date());
  let file = '';
  let bytes = 0;
  const fileFor = () => join(dir, `${prefix}-${now().toISOString().slice(0, 10)}.log`);
  return {
    currentFile: fileFor,
    write(line: string): void {
      const text = line.endsWith('\n') ? line : `${line}\n`;
      try {
        const f = fileFor();
        if (f !== file) { file = f; try { bytes = statSync(f).size; } catch { bytes = 0; } }
        const len = Buffer.byteLength(text);
        if (bytes > 0 && bytes + len > max) { renameSync(f, `${f}.old`); bytes = 0; }
        appendFileSync(f, text, { mode: 0o600 });
        bytes += len;
      } catch { /* logging never crashes the Shell */ }
    },
  };
}

/** Deletes `service|engine|shell-YYYY-MM-DD.log[.old]` older than `keepDays`; returns the names removed. */
export function pruneOldLogs(dir: string, keepDays: number = LOG_RETENTION_DAYS, nowMs: number = Date.now()): string[] {
  const removed: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return removed; }
  for (const f of names) {
    const m = /^(?:service|engine|shell)-(\d{4}-\d{2}-\d{2})\.log(?:\.old)?$/.exec(f);
    if (m && nowMs - Date.parse(m[1]!) > keepDays * 86_400_000) { try { rmSync(join(dir, f)); removed.push(f); } catch { /* in use */ } }
  }
  return removed;
}
