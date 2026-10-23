import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { sha256Hex, canonicalJson, sha256Canonical, newId, isUlid, sanitizeFilename, timestamp, shortId,
  EmError, statusForCode, HTTP_STATUS_BY_CODE, errorMessage, truncate, ok, fail, issue, hasBlocking, emKey, redact,
  fitText, estimateLines, fitSingleLine } from '../src/index.js';

describe('sha256Hex', () => {
  const nodeSha = (s: string | Uint8Array) => crypto.createHash('sha256').update(s).digest('hex');
  it('matches node:crypto for edge lengths and unicode', () => {
    for (const s of ['', 'a', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(1000), 'Harga cabai naik 🌶️ — kamu']) expect(sha256Hex(s)).toBe(nodeSha(s));
  });
  it('matches node:crypto for random byte arrays', () => {
    for (let i = 0; i < 50; i++) { const b = crypto.randomBytes(i * 13); expect(sha256Hex(new Uint8Array(b))).toBe(nodeSha(b)); }
  });
});

describe('canonicalJson', () => {
  it('sorts keys recursively and omits undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe('{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  it('is key-order independent for hashing', () => {
    expect(sha256Canonical({ a: 1, b: [1, 2] })).toBe(sha256Canonical({ b: [1, 2], a: 1 }));
    expect(sha256Canonical({ a: 1 })).not.toBe(sha256Canonical({ a: 2 }));
  });
  it('rejects non-finite numbers and functions', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: () => 1 })).toThrow();
  });
  it('turns undefined array members into null like JSON.stringify', () => expect(canonicalJson([1, undefined])).toBe('[1,null]'));
});

describe('ids', () => {
  it('produces valid, unique, sortable ULIDs', () => {
    const ids = Array.from({ length: 2000 }, () => newId());
    expect(ids.every(isUlid)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);                         // monotonic even within the same millisecond
  });
  it('encodes the timestamp in the first 10 chars', () => {
    expect(newId(0).slice(0, 10)).toBe('0000000000');
    expect(newId(2 ** 48 - 1).slice(0, 10)).toBe('7ZZZZZZZZZ');
    expect(() => newId(-1)).toThrow();
  });
  it('shortId is display-only', () => expect(shortId('prj', '01J9ZZZZZZZZZZZZZZZZZZZZZZ')).toBe('prj_ZZZZZZZZ'));
  it('sanitizeFilename collapses traversal and separators (ported behaviour)', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeFilename('C:\\Users\\x\\video.mp4')).toBe('C-Users-x-video');
    expect(sanitizeFilename('Harga Cabai ñ.mov')).toBe('Harga-Cabai-n');
    expect(sanitizeFilename('...')).toBe('video');
  });
  it('timestamp format', () => expect(timestamp(new Date(2026, 9, 24, 3, 4, 5))).toBe('20261024-030405'));
});

describe('errors', () => {
  it('EmError maps status and builds the envelope without stack', () => {
    const e = new EmError('EM-2301', 'stale', { details: { a: 1 }, path: 'body.baseVersion' });
    expect(e.status).toBe(409);
    expect(e.toEnvelope()).toEqual({ error: { code: 'EM-2301', message: 'stale', details: { a: 1 }, path: 'body.baseVersion' } });
    expect(JSON.stringify(e.toEnvelope())).not.toContain('at ');
    expect(() => new EmError('EM-12' as never, 'x')).toThrow();
  });
  it('range fallback', () => {
    expect(statusForCode('EM-1004')).toBe(422);
    expect(statusForCode('EM-6203')).toBe(503);
    expect(statusForCode('EM-9007')).toBe(500);
  });
  it('every code in the HTTP table exists in docs/ERROR_CATALOGUE.md', () => {
    const cat = fs.readFileSync(new URL('../../../docs/ERROR_CATALOGUE.md', import.meta.url), 'utf8');
    const missing = Object.keys(HTTP_STATUS_BY_CODE).filter((c) => !cat.includes(c));
    expect(missing).toEqual([]);
  });
  it('helpers', () => {
    expect(errorMessage(new Error('x'))).toBe('x');
    expect(errorMessage(5)).toBe('5');
    expect(truncate('abcdef', 3)).toBe('abc…');
    expect(emKey('EM-1001', 'title')).toBe('err.EM-1001.title');
  });
});

describe('result', () => {
  it('ok / fail / hasBlocking', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1, warnings: [] });
    expect(fail([issue('CM-001', 'x')])).toEqual({ ok: false, issues: [{ code: 'CM-001', path: '', message: 'x', severity: 'block' }] });
    expect(hasBlocking([issue('a', 'b', 'warn')])).toBe(false);
    expect(hasBlocking([issue('a', 'b', 'warn'), issue('c', 'd')])).toBe(true);
  });
});

describe('redact', () => {
  it('removes keys, bearer tokens, query tokens and media grants', () => {
    const grant = 'A'.repeat(43);
    const line = `key sk-or-v1-abcdefghij123 auth Bearer abcdefghijklmnopqrstu /api/v1/events?token=SECRET&x=1 /media/${grant}/01J/proxy AIza${'b'.repeat(35)}`;
    const out = redact(line);
    for (const s of ['sk-or-v1-abcdefghij123', 'abcdefghijklmnopqrstu', 'SECRET', grant, 'AIza']) expect(out).not.toContain(s);
    expect(out).toContain('token=[REDACTED]');
    expect(out).toContain('/media/[REDACTED]/01J/proxy');
  });
});

describe('fit (ported)', () => {
  it('fits long Indonesian copy inside the box', () => {
    const r = fitText('Harga cabai naik terus selama tiga minggu berturut-turut di pasar tradisional', { width: 900, height: 400, maxSize: 120, minSize: 34 });
    expect(r.overflow).toBe(false);
    expect(r.lines * r.fontSize * 1.15).toBeLessThanOrEqual(400);
  });
  it('flags overflow at minSize', () => expect(fitText('x '.repeat(500), { width: 200, height: 100, maxSize: 60, minSize: 34 }).overflow).toBe(true));
  it('empty text', () => expect(fitText('  ', { width: 1, height: 1, maxSize: 50, minSize: 10 })).toEqual({ fontSize: 50, lines: 0, overflow: false }));
  it('long word breaks', () => expect(estimateLines('a'.repeat(30), 10, 100, 1)).toBe(3));
  it('single line clamps', () => { expect(fitSingleLine('1.234', 1000, 300, 40)).toBe(300); expect(fitSingleLine('x'.repeat(100), 100, 300, 40)).toBe(40); });
});
