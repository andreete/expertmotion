// JS port of apps/service/src/license/format.ts (encoding half) + payload helpers.
// Keep byte-for-byte compatible with the service; the Vitest round trip in
// apps/service/test/license/cli-roundtrip.test.ts proves the two agree.
import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'EM1';
export const REVOCATION_SIGNING_PREFIX = 'EMREV1';
export const MACHINE_CODE_PREFIX = 'MC1';
export const FP_SALTS = ['expertmotion.fp.v1.machineguid', 'expertmotion.fp.v1.diskserial', 'expertmotion.fp.v1.cpumodel'];

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32, upper case, no padding. */
export function base32Encode(bytes) {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32[(buffer << (5 - bits)) & 31];
  return out;
}

/** Strict decode; null on invalid input. */
export function base32Decode(text) {
  const rem = text.length % 8;
  if (rem === 1 || rem === 3 || rem === 6) return null;
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const ch of text) {
    const value = B32.indexOf(ch);
    if (value < 0) return null;
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (buffer >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
    buffer &= (1 << bits) - 1;
  }
  if (buffer !== 0) return null;
  return out;
}

export function stripAndUpper(s) {
  return s.replace(/[\s​-‍⁠﻿]+/gu, '').toUpperCase();
}
export function normaliseBase32Field(f) {
  return f.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF). */
export function crc16Ccitt(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function signingMessage(prefix, kid, body) {
  return Buffer.concat([Buffer.from(prefix, 'utf8'), Buffer.from([0]), Buffer.from(kid, 'utf8'), Buffer.from([0]), Buffer.from(body)]);
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export function isMissing(c) {
  return c.every((b) => b === 0);
}

/**
 * Decode + CRC-check a Machine Code. Returns {ok, components, fpc, fp, present, reason}.
 */
export function decodeMachineCode(input) {
  if (typeof input !== 'string' || input.length > 256) return { ok: false, reason: 'format' };
  const s = stripAndUpper(input);
  const dash = s.indexOf('-');
  if (dash < 0 || s.slice(0, dash) !== MACHINE_CODE_PREFIX) return { ok: false, reason: 'format' };
  const bytes = base32Decode(normaliseBase32Field(s.slice(dash + 1)));
  if (!bytes || bytes.length !== 26) return { ok: false, reason: 'format' };
  const crc = crc16Ccitt(bytes.subarray(0, 24));
  if (bytes[24] !== crc >>> 8 || bytes[25] !== (crc & 0xff)) return { ok: false, reason: 'crc' };
  const components = [bytes.slice(0, 8), bytes.slice(8, 16), bytes.slice(16, 24)];
  return {
    ok: true,
    components,
    present: components.map((c) => !isMissing(c)),
    fpc: components.map(base32Encode),
    fp: createHash('sha256').update(Buffer.concat(components)).digest('hex'),
    machineCode: encodeMachineCode(components),
  };
}

export function encodeMachineCode(components) {
  const body = Buffer.concat([...components, Buffer.alloc(2)]);
  const crc = crc16Ccitt(body.subarray(0, 24));
  body[24] = crc >>> 8;
  body[25] = crc & 0xff;
  return `${MACHINE_CODE_PREFIX}-${base32Encode(body)}`;
}

/** Test helper mirroring the service's componentHash (§5.2) on already-normalised values. */
export function componentHash(salt, normalisedValue) {
  if (normalisedValue === null) return new Uint8Array(8);
  return new Uint8Array(createHash('sha256').update(salt, 'utf8').update(Buffer.from([0])).update(normalisedValue, 'utf8').digest().subarray(0, 8));
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** ULID: 48-bit ms timestamp + 80 random bits, Crockford base32, 26 chars. */
export function ulid(nowMs = Date.now()) {
  let t = BigInt(nowMs);
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[Number(t % 32n)] + timePart;
    t /= 32n;
  }
  const rnd = randomBytes(10);
  let r = 0n;
  for (const b of rnd) r = (r << 8n) | BigInt(b);
  let randPart = '';
  for (let i = 0; i < 16; i++) {
    randPart = CROCKFORD[Number(r % 32n)] + randPart;
    r /= 32n;
  }
  return timePart + randPart;
}

/** eh = base64url(no padding) of the first 16 bytes of SHA-256(lower-case trimmed email). */
export function emailHash(email) {
  return createHash('sha256').update(email.trim().toLowerCase(), 'utf8').digest().subarray(0, 16).toString('base64url');
}

export function isoSeconds(d) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
export function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Add whole calendar months to a YYYY-MM-DD date (day clamped to month end). */
export function addMonths(isoDay, months) {
  const [y, m, d] = isoDay.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total % 12;
  const lastDay = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(ny, nm, Math.min(d, lastDay))));
}

/** Display grouping (§3.3): spaces every 8 chars inside a field, 8 groups per line. */
export function groupKey(key) {
  const fields = key.split('-').map((f) => f.match(/.{1,8}/g)?.join(' ') ?? f);
  const joined = fields.join(' - ');
  const words = joined.split(' ');
  const lines = [];
  for (let i = 0; i < words.length; i += 8) lines.push(words.slice(i, i + 8).join(' '));
  return lines.join('\n');
}
