/**
 * Embedded Ed25519 public-key table (LICENSE_OPERATIONS.md §4) and the Ed25519 primitive.
 * Only PUBLIC keys live here. No private key is ever committed (AGENTS.md rule 7).
 */
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { hexToBytes } from './format.js';

// @noble/ed25519 v2: the sync API needs a SHA-512 implementation; use Node's (no extra dependency).
if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array =>
    new Uint8Array(createHash('sha512').update(ed.etc.concatBytes(...messages)).digest());
}

export type KeyStatus = 'active' | 'retiring' | 'revoked';

export interface PublicKeyEntry {
  /** two characters, e.g. "A1" */
  readonly kid: string;
  /** 32-byte Ed25519 public key, lower-case hex (64 chars) */
  readonly publicKeyHex: string;
  readonly status: KeyStatus;
  /** ISO date the key entered service */
  readonly since: string;
}

/**
 * PRODUCTION PUBLIC KEY — PLACEHOLDER.
 * Replace with the hex printed by `expertmotion-license keygen --kid A1 --seal` on the Operator's offline
 * signing machine before Stage 4. Until then no production Licence Key can verify: every key reports
 * EM-5009 (unknown kid) because placeholder entries are filtered out of the table.
 */
export const PRODUCTION_PUBLIC_KEY_A1_HEX = 'PLACEHOLDER_REPLACE_WITH_OPERATOR_PUBLIC_KEY_A1_HEX';

const PRODUCTION_KEY_TABLE: readonly PublicKeyEntry[] = [
  { kid: 'A1', publicKeyHex: PRODUCTION_PUBLIC_KEY_A1_HEX, status: 'active', since: '2026-10-24' },
];

export function isWellFormedKeyEntry(e: PublicKeyEntry): boolean {
  return /^[A-Z0-9]{2}$/.test(e.kid) && /^[0-9a-f]{64}$/.test(e.publicKeyHex);
}

/** The table compiled into this build, with placeholder entries removed. */
export function embeddedKeyTable(): readonly PublicKeyEntry[] {
  return PRODUCTION_KEY_TABLE.filter(isWellFormedKeyEntry);
}

export function findKey(table: readonly PublicKeyEntry[], kid: string): PublicKeyEntry | undefined {
  return table.find((e) => e.kid === kid);
}

/** Ed25519 verify; never throws (malformed points or lengths → false). */
export function ed25519Verify(signature: Uint8Array, message: Uint8Array, publicKeyHex: string): boolean {
  const pk = hexToBytes(publicKeyHex);
  if (!pk || pk.length !== 32 || signature.length !== 64) return false;
  try {
    return ed.verify(signature, message, pk, { zip215: false }); // strict RFC 8032 (rejects non-canonical encodings)
  } catch {
    return false;
  }
}

/** Test/CLI helper: sign with a 32-byte seed. Never used by the Local Service at runtime. */
export function ed25519Sign(message: Uint8Array, privateKeySeed: Uint8Array): Uint8Array {
  return ed.sign(message, privateKeySeed);
}

/** Test helper: derive the public key hex from a 32-byte seed. */
export function ed25519PublicKeyHex(privateKeySeed: Uint8Array): string {
  return Buffer.from(ed.getPublicKey(privateKeySeed)).toString('hex');
}

/** Test helper: random 32-byte seed for a DEV-ONLY key pair (generated at test time, never stored). */
export function generateDevPrivateKey(): Uint8Array {
  return ed.utils.randomPrivateKey();
}
