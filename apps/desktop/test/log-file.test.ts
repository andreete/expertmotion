import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRotatingLog, pruneOldLogs } from '../src/lib/log-file.js';

describe('shell log rotation (SEC-101)', () => {
  it('writes shell-YYYY-MM-DD.log and keeps every file within the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-shell-log-'));
    let day = '2026-10-24';
    const log = createRotatingLog(dir, 'shell', { maxBytes: 300, now: () => new Date(`${day}T12:00:00Z`) });
    for (let i = 0; i < 8; i++) log.write(`{"msg":"line ${i} ${'y'.repeat(50)}"}`);
    day = '2026-10-25';
    log.write('{"msg":"next day"}');
    const files = readdirSync(dir).sort();
    expect(files).toEqual(['shell-2026-10-24.log', 'shell-2026-10-24.log.old', 'shell-2026-10-25.log']);
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(300);
    expect(readFileSync(join(dir, 'shell-2026-10-24.log'), 'utf8')).toContain('line 7');
  });

  it('deletes logs older than 7 days, oldest first, and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'em-shell-prune-'));
    for (const f of ['shell-2026-10-10.log', 'engine-2026-10-10.log.old', 'shell-2026-10-20.log', 'crash-shell-20261010-000000.txt']) writeFileSync(join(dir, f), 'x');
    expect(pruneOldLogs(dir, 7, Date.parse('2026-10-24T00:00:00Z')).sort()).toEqual(['engine-2026-10-10.log.old', 'shell-2026-10-10.log']);
    expect(readdirSync(dir).sort()).toEqual(['crash-shell-20261010-000000.txt', 'shell-2026-10-20.log']);
  });
});
