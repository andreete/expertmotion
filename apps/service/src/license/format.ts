/**
 * Licence Key and Machine Code string formats (LICENSE_OPERATIONS.md §3, §5.3).
 * Pure functions, no I/O. The Operator CLI (tools/license-cli/src/lib/format.mjs) carries a JS port
 * of the encoding half; the round-trip test in apps/service/test/license keeps the two in agreement.
 */

/** Format prefix of a Licence Key (§3.3). */
export const TOKEN_PREFIX = 'EM1';
/** Prefix bound into the signed message of a Licence Key (§3.2). */
export const TOKEN_SIGNING_PREFIX = 'EM1';
/** Prefix bound into the signed message of revoked.json (§8.2). */
export const REVOCATION_SIGNING_PREFIX = 'EMREV1';
/** Machine Code prefix (§5.3). */
export const MACHINE_CODE_PREFIX = 'MC1';
/** Upper bound for the decoded Payload (§6 step 4). */
export const MAX_PAYLOAD_BYTES = 4096;
/** Ed25519 signature length (§3.2). */
export const SIGNATURE_BYTES = 64;
/** Hard bound on the raw input string, checked before any other work (threat note "malicious .emlicense"). */
export const MAX_INPUT_CHARS = 16384;

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const B32_LOOKUP: ReadonlyMap<string, number> = new Map([...B32_ALPHABET].map((c, i) => [c, i]));

/** RFC 4648 base32, upper case, no padding (§3.3). */
export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += B32_ALPHABET[(buffer << (5 - bits)) & 31];
  return out;
}

/**
 * Strict RFC 4648 base32 decode (no padding). Returns null on any character outside the alphabet,
 * an impossible length, or non-zero trailing bits (so every byte string has exactly one encoding).
 */
export function base32Decode(text: string): Uint8Array | null {
  const rem = text.length % 8;
  if (rem === 1 || rem === 3 || rem === 6) return null;
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const ch of text) {
    const value = B32_LOOKUP.get(ch);
    if (value === undefined) return null;
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

const WHITESPACE_RE = /[\s​-‍⁠﻿]+/gu;

/** Remove all whitespace including zero-width characters, then upper-case (§3.3 "Normalisation on input"). */
export function stripAndUpper(input: string): string {
  return input.replace(WHITESPACE_RE, '').toUpperCase();
}

/** OCR/typing slip map applied only inside base32 fields (§3.3): 0→O, 1→I, 8→B. */
export function normaliseBase32Field(field: string): string {
  return field.replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
}

export interface TokenParts {
  readonly prefix: string;
  readonly kid: string;
  readonly payloadB32: string;
  readonly signatureB32: string;
}

/** §6 steps 1: normalise and split on '-'. Returns null unless there are exactly four non-empty parts. */
export function splitToken(input: string): TokenParts | null {
  if (input.length > MAX_INPUT_CHARS) return null;
  const parts = stripAndUpper(input).split('-');
  if (parts.length !== 4) return null;
  const [prefix, kid, payload, sig] = parts as [string, string, string, string];
  if (!prefix || !kid || !payload || !sig) return null;
  return { prefix, kid, payloadB32: normaliseBase32Field(payload), signatureB32: normaliseBase32Field(sig) };
}

/** Build the Licence Key string from its parts (§3.3). */
export function encodeToken(kid: string, payloadBytes: Uint8Array, signature: Uint8Array): string {
  return `${TOKEN_PREFIX}-${kid}-${base32Encode(payloadBytes)}-${base32Encode(signature)}`;
}

const encoder = new TextEncoder();

/** Signed message: UTF8(prefix) ‖ 0x00 ‖ UTF8(kid) ‖ 0x00 ‖ body (§3.2, §8.2). */
export function signingMessage(prefix: string, kid: string, body: Uint8Array): Uint8Array {
  const p = encoder.encode(prefix);
  const k = encoder.encode(kid);
  const out = new Uint8Array(p.length + 1 + k.length + 1 + body.length);
  out.set(p, 0);
  out[p.length] = 0;
  out.set(k, p.length + 1);
  out[p.length + 1 + k.length] = 0;
  out.set(body, p.length + k.length + 2);
  return out;
}

export type CanonicalJson = string | number | boolean | null | readonly CanonicalJson[] | { readonly [k: string]: CanonicalJson };

/** Canonical JSON (§3.1): sorted keys, no whitespace, minimal escaping, integers in decimal. */
export function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers are allowed');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map((v: CanonicalJson) => canonicalJson(v)).join(',')}]`;
  const obj = value as { readonly [k: string]: CanonicalJson };
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k] as CanonicalJson)}`).join(',')}}`;
}

/**
 * CRC-16/CCITT-FALSE: polynomial 0x1021, init 0xFFFF, no reflection, no final XOR.
 * (§5.3 names "CRC16-CCITT" without parameters; this is the common CCITT variant, also in the CLI port.)
 */
export function crc16Ccitt(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Component hash length (§5.2). */
export const COMPONENT_BYTES = 8;

export type ComponentTriple = readonly [Uint8Array, Uint8Array, Uint8Array];

/** Machine Code = MC1-BASE32(c1 ‖ c2 ‖ c3 ‖ CRC16(c1 ‖ c2 ‖ c3)) (§5.3), 42 base32 chars. */
export function encodeMachineCode(components: ComponentTriple): string {
  const body = new Uint8Array(COMPONENT_BYTES * 3 + 2);
  components.forEach((c, i) => {
    if (c.length !== COMPONENT_BYTES) throw new Error('component hash must be 8 bytes');
    body.set(c, i * COMPONENT_BYTES);
  });
  const crc = crc16Ccitt(body.subarray(0, COMPONENT_BYTES * 3));
  body[24] = crc >>> 8;
  body[25] = crc & 0xff;
  return `${MACHINE_CODE_PREFIX}-${base32Encode(body)}`;
}

export type MachineCodeDecode =
  | { readonly ok: true; readonly components: ComponentTriple }
  | { readonly ok: false; readonly reason: 'format' | 'crc' };

/** Decode and CRC-check a Machine Code (the CLI refuses a mismatching CRC, RISK-022). */
export function decodeMachineCode(input: string): MachineCodeDecode {
  if (input.length > 256) return { ok: false, reason: 'format' };
  const s = stripAndUpper(input);
  const dash = s.indexOf('-');
  if (dash < 0 || s.slice(0, dash) !== MACHINE_CODE_PREFIX) return { ok: false, reason: 'format' };
  const bytes = base32Decode(normaliseBase32Field(s.slice(dash + 1)));
  if (!bytes || bytes.length !== 26) return { ok: false, reason: 'format' };
  const crc = crc16Ccitt(bytes.subarray(0, 24));
  if (bytes[24] !== crc >>> 8 || bytes[25] !== (crc & 0xff)) return { ok: false, reason: 'crc' };
  return { ok: true, components: [bytes.slice(0, 8), bytes.slice(8, 16), bytes.slice(16, 24)] };
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
