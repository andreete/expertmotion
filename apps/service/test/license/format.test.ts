import { describe, expect, it } from 'vitest';
import {
  base32Decode, base32Encode, canonicalJson, crc16Ccitt, decodeMachineCode, encodeMachineCode, splitToken, stripAndUpper,
} from '../../src/license/index.js';

const enc = new TextEncoder();

describe('base32 (RFC 4648, no padding)', () => {
  it('matches the RFC 4648 test vectors', () => {
    const vectors: [string, string][] = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'], ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
    for (const [plain, b32] of vectors) {
      expect(base32Encode(enc.encode(plain))).toBe(b32);
      expect(new TextDecoder().decode(base32Decode(b32) ?? new Uint8Array([255]))).toBe(plain);
    }
  });
  it('round-trips random bytes', () => {
    for (let n = 0; n < 70; n++) {
      const b = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      expect(base32Decode(base32Encode(b))).toEqual(b);
    }
  });
  it('rejects non-alphabet characters, impossible lengths and non-zero trailing bits', () => {
    expect(base32Decode('MZXW6YT!')).toBeNull();
    expect(base32Decode('mzxw6')).toBeNull();
    expect(base32Decode('M')).toBeNull();
    expect(base32Decode('MY')).not.toBeNull();
    expect(base32Decode('MZ')).toBeNull(); // trailing bits set: no second encoding of the same bytes
  });
});

describe('input normalisation (§3.3)', () => {
  it('removes whitespace, line breaks and zero-width characters and upper-cases', () => {
    expect(stripAndUpper(' em1-a1-ab cd\r\n ef​gh﻿ ')).toBe('EM1-A1-ABCDEFGH');
  });
  it('maps 0→O, 1→I, 8→B only inside base32 fields, never in prefix or kid', () => {
    const p = splitToken('EM1-A1-MZ0W1Y8B-AB01');
    expect(p).toEqual({ prefix: 'EM1', kid: 'A1', payloadB32: 'MZOWIYBB', signatureB32: 'ABOI' });
  });
  it('requires exactly four non-empty parts', () => {
    expect(splitToken('EM1-A1-AAAA')).toBeNull();
    expect(splitToken('EM1-A1-AAAA-BBBB-CCCC')).toBeNull();
    expect(splitToken('EM1--AAAA-BBBB')).toBeNull();
    expect(splitToken('x'.repeat(20000))).toBeNull();
  });
});

describe('CRC16 and Machine Code (§5.3)', () => {
  it('CRC-16/CCITT-FALSE check value of "123456789" is 0x29B1', () => {
    expect(crc16Ccitt(enc.encode('123456789'))).toBe(0x29b1);
  });
  it('encodes to MC1- + 42 base32 chars and decodes back', () => {
    const c: [Uint8Array, Uint8Array, Uint8Array] = [new Uint8Array(8).fill(1), new Uint8Array(8).fill(2), new Uint8Array(8).fill(3)];
    const mc = encodeMachineCode(c);
    expect(mc).toMatch(/^MC1-[A-Z2-7]{42}$/);
    const d = decodeMachineCode(` ${mc.toLowerCase().replace(/(.{8})/g, '$1 ')} `);
    expect(d.ok).toBe(true);
    if (d.ok) expect(d.components).toEqual(c);
  });
  it('rejects a mistyped Machine Code by CRC', () => {
    const mc = encodeMachineCode([new Uint8Array(8).fill(9), new Uint8Array(8).fill(8), new Uint8Array(8).fill(7)]);
    const i = 10;
    const typo = mc.slice(0, i) + (mc[i] === 'A' ? 'B' : 'A') + mc.slice(i + 1);
    expect(decodeMachineCode(typo)).toEqual({ ok: false, reason: 'crc' });
    expect(decodeMachineCode('MC2-AAAA')).toEqual({ ok: false, reason: 'format' });
  });
});

describe('canonical JSON (§3.1)', () => {
  it('sorts keys, no whitespace, integers only', () => {
    expect(canonicalJson({ v: 1, a: ['x', 2], b: { d: null, c: true } })).toBe('{"a":["x",2],"b":{"c":true,"d":null},"v":1}');
    expect(() => canonicalJson({ x: 1.5 })).toThrow();
  });
});
