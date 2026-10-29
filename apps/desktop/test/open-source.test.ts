import { describe, expect, it } from 'vitest';
import { BRIDGE_KEYS, IPC, isAllowedExternal } from '../src/lib/constants.js';
import { decideOpenSource, OpenSourceArg, OPEN_SOURCE_REFUSED, sourceUrlProblem } from '../src/lib/open-source.js';

// R1 (review 2026-10-29): research citations were refused by openExternal (storefront host only) and bypassed Private Mode.
describe('openSource IPC route (R1, FR-216, SEC-140)', () => {
  const off = async () => false; const on = async () => true;
  it('is its own channel and bridge key; openExternal keeps the storefront-only rule', () => {
    expect(IPC.openSource).toBe('em:open-source');
    expect(BRIDGE_KEYS).toContain('openSource');
    expect(isAllowedExternal('https://www.bps.go.id/id/statistics-table')).toBe(false);
  });
  it('opens any public https source page (http is upgraded)', async () => {
    expect(await decideOpenSource('https://www.bps.go.id/id/statistics-table/2/MTk1NSMy', off)).toEqual({ ok: true, url: 'https://www.bps.go.id/id/statistics-table/2/MTk1NSMy' });
    expect(await decideOpenSource('http://commons.wikimedia.org/wiki/File:X.jpg', off)).toEqual({ ok: true, url: 'https://commons.wikimedia.org/wiki/File:X.jpg' });
  });
  it('refuses in Private Mode with the Indonesian message (EM-8202)', async () => {
    const r = await decideOpenSource('https://www.bps.go.id/', on);
    expect(r).toEqual({ ok: false, code: 'EM-8202', message: OPEN_SOURCE_REFUSED.private });
    expect(OPEN_SOURCE_REFUSED.private).toMatch(/Private Mode aktif/);
  });
  it('refuses non-public or malformed URLs before reading Private Mode (EM-8203)', async () => {
    let asked = 0; const probe = async () => { asked++; return false; };
    for (const u of ['file:///C:/Windows/system32/calc.exe', 'javascript:alert(1)', 'ms-settings:', 'https://user:pw@example.com/', 'https://127.0.0.1/', 'https://[::1]/', 'https://localhost/',
      'https://router.lan/', 'https://printer.local/', 'https://intranet/', 'https://example.com:8443/', 'ftp://example.com/', '', 42, null, { url: 'https://example.com' }, `https://example.com/${'a'.repeat(2100)}`]) {
      const r = await decideOpenSource(u, probe);
      expect(r).toMatchObject({ ok: false, code: 'EM-8203' });
    }
    expect(asked).toBe(0);
  });
  it('the Zod schema and the problem function agree', () => {
    expect(OpenSourceArg.safeParse('https://data.worldbank.org/indicator').success).toBe(true);
    expect(OpenSourceArg.safeParse('https://10.0.0.1/').success).toBe(false);
    expect(sourceUrlProblem('https://example.com')).toBeNull();
    expect(sourceUrlProblem('https://192.168.1.1/')).toMatch(/IP/);
  });
});
