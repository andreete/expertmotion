// SEC-101 / FR-175: daily files per prefix, 20 MB cap per file (oldest lines dropped first), 7-day retention for service/engine/shell.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../helpers.js';
import { createLogger, pruneLogs } from '../../src/services/logger.js';
import { getEngineLog, runTool, setEngineLog } from '../../src/s2/proc.js';

describe('SEC-101 log rotation', () => {
  it('writes <prefix>-YYYY-MM-DD.log, redacted, and rolls a full file to .old', () => {
    const dir = tempDir('em-log-');
    const now = () => new Date('2026-10-24T10:00:00Z');
    const log = createLogger(dir, { prefix: 'engine', maxBytes: 400, now });
    for (let i = 0; i < 6; i++) log.child({ i }).info({ auth: 'Bearer abcdefghijklmnop' }, `line ${i} ${'x'.repeat(60)}`);
    const files = fs.readdirSync(dir).sort();
    expect(files).toEqual(['engine-2026-10-24.log', 'engine-2026-10-24.log.old']);
    for (const f of files) {
      expect(fs.statSync(path.join(dir, f)).size).toBeLessThanOrEqual(400);
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('abcdefghijklmnop');
    }
    expect(fs.readFileSync(path.join(dir, 'engine-2026-10-24.log'), 'utf8')).toContain('line 5');
  });

  it('prunes service, engine and shell files older than 7 days, keeps the rest', () => {
    const dir = tempDir('em-log-prune-');
    for (const f of ['service-2026-10-01.log', 'engine-2026-10-01.log', 'shell-2026-10-01.log', 'shell-2026-10-01.log.old', 'shell-2026-10-22.log', 'service-2026-10-23.log', 'diagnostics-x.zip'])
      fs.writeFileSync(path.join(dir, f), 'x');
    expect(pruneLogs(dir, 7, Date.parse('2026-10-24T00:00:00Z'))).toBe(4);
    expect(fs.readdirSync(dir).sort()).toEqual(['diagnostics-x.zip', 'service-2026-10-23.log', 'shell-2026-10-22.log']);
  });

  it('a failed Engine Binary run writes its stderr tail to the engine log', async () => {
    const dir = tempDir('em-log-engine-');
    const prev = getEngineLog();
    setEngineLog(createLogger(dir, { prefix: 'engine' }));
    try {
      await expect(runTool({ exe: process.execPath, args: ['-e', 'process.stderr.write("boom sk-ant-abcdefghijkl\\n"); process.exit(3)'], timeoutMs: 10_000 })).rejects.toThrow();
    } finally { setEngineLog(prev); }
    const f = fs.readdirSync(dir).find((x) => x.startsWith('engine-'))!;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    expect(text).toContain('engine binary failed');
    expect(text).toContain('boom');
    expect(text).not.toContain('sk-ant-abcdefghijkl');
  });
});
