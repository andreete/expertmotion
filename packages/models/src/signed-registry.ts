// SEC-072: the model registry manifest (`models.json`: ids, URLs, sizes, sha256) is signed with the Operator's Ed25519
// **manifest key** (separate from the licence key; LICENSE_OPERATIONS.md key inventory). The Service verifies the detached
// signature (`models.json.sig`) with the embedded public key(s) before using any entry; an unsigned, tampered, stale or
// unverifiable manifest is ignored and the built-in registry is used (EM-7111). Only PUBLIC keys live here (AGENTS.md rule 7).
import { createPublicKey, verify } from 'node:crypto';
import { z } from 'zod';
import { DOWNLOAD_HOSTS, type ModelDef, type ModelFileDef } from './registry.js';

export type ManifestKeyStatus = 'active' | 'retiring' | 'revoked';
export interface ManifestKeyEntry { readonly kid: string; readonly publicKeyHex: string; readonly status: ManifestKeyStatus; readonly since: string }

/**
 * PRODUCTION MANIFEST PUBLIC KEY — PLACEHOLDER (Operator item). Replace with the hex of the Operator's offline manifest
 * signing key before release. Until then no downloaded manifest can verify: placeholder entries are filtered out, so every
 * `models.json` is refused with reason `no-keys` and the built-in registry is used.
 */
declare const __EM_MANIFEST_PUBLIC_KEY_M1_HEX__: string | undefined;
/** Build-time key from EM_MANIFEST_PUBLIC_KEY_M1_HEX (the service bundle's define) wins over the source constant. */
const INJECTED_M1 = typeof __EM_MANIFEST_PUBLIC_KEY_M1_HEX__ === 'string' && /^[0-9a-f]{64}$/.test(__EM_MANIFEST_PUBLIC_KEY_M1_HEX__) ? __EM_MANIFEST_PUBLIC_KEY_M1_HEX__ : null;
export const MANIFEST_PUBLIC_KEY_M1_HEX = INJECTED_M1 ?? 'PLACEHOLDER_REPLACE_WITH_OPERATOR_MANIFEST_PUBLIC_KEY_M1_HEX';
const MANIFEST_KEY_TABLE: readonly ManifestKeyEntry[] = [
  { kid: 'M1', publicKeyHex: MANIFEST_PUBLIC_KEY_M1_HEX, status: 'active', since: '2026-10-24' },
];
export const isWellFormedManifestKey = (e: ManifestKeyEntry): boolean => /^[A-Z0-9]{2}$/.test(e.kid) && /^[0-9a-f]{64}$/.test(e.publicKeyHex);
/** The table compiled into this build, without placeholders and revoked keys. */
export function embeddedManifestKeys(): readonly ManifestKeyEntry[] { return MANIFEST_KEY_TABLE.filter((e) => isWellFormedManifestKey(e) && e.status !== 'revoked'); }

export const SIGNED_REGISTRY_FILE = 'models.json';
export const SIGNED_REGISTRY_SIG_FILE = 'models.json.sig';
/** The built-in registry counts as sequence 0; a downloaded manifest must be newer than the last one accepted (monotonic). */
export const BUILTIN_REGISTRY_SEQ = 0;

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const SignedFile = z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/), bytes: z.number().int().positive(), sha256: Sha256, url: z.string().url().startsWith('https://'), revision: z.string().min(1).max(80) }).strict();
export const SignedRegistry = z.object({
  schema: z.literal(1),
  seq: z.number().int().positive(),
  issuedAt: z.string().datetime({ offset: true }),
  models: z.array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/), version: z.string().min(1).max(40).optional(), files: z.array(SignedFile).min(1).max(16) }).strict()).max(200),
}).strict();
export type SignedRegistryT = z.infer<typeof SignedRegistry>;
const SigEnvelope = z.object({ kid: z.string().regex(/^[A-Z0-9]{2}$/), sig: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).strict();

export type SignedRegistryRefusal = 'no-keys' | 'malformed-signature' | 'unknown-kid' | 'bad-signature' | 'malformed' | 'stale';
export type SignedRegistryResult = { ok: true; registry: SignedRegistryT; kid: string } | { ok: false; reason: SignedRegistryRefusal };

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Ed25519 verify over the exact file bytes; never throws. */
export function ed25519VerifyDetached(message: Uint8Array, signature: Uint8Array, publicKeyHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex) || signature.length !== 64) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return verify(null, message, key, signature);
  } catch { return false; }
}

/**
 * Verifies `models.json` bytes against `models.json.sig` (`{"kid":"M1","sig":"<base64 64 bytes>"}`): key table not empty,
 * kid known, signature valid, then schema, then `seq` ≥ `lastSeq` (never older than the last accepted manifest). The signature is checked before the JSON is parsed.
 */
export function verifySignedRegistry(fileBytes: Uint8Array, sigText: string, opts: { keys?: readonly ManifestKeyEntry[]; lastSeq?: number } = {}): SignedRegistryResult {
  const keys = opts.keys ?? embeddedManifestKeys();
  if (!keys.length) return { ok: false, reason: 'no-keys' };
  let env: z.infer<typeof SigEnvelope>;
  try { env = SigEnvelope.parse(JSON.parse(sigText)); } catch { return { ok: false, reason: 'malformed-signature' }; }
  const key = keys.find((k) => k.kid === env.kid && k.status !== 'revoked');
  if (!key) return { ok: false, reason: 'unknown-kid' };
  if (!ed25519VerifyDetached(fileBytes, Buffer.from(env.sig, 'base64'), key.publicKeyHex)) return { ok: false, reason: 'bad-signature' };
  let reg: SignedRegistryT;
  try { reg = SignedRegistry.parse(JSON.parse(Buffer.from(fileBytes).toString('utf8'))); } catch { return { ok: false, reason: 'malformed' }; }
  if (reg.seq < (opts.lastSeq ?? BUILTIN_REGISTRY_SEQ)) return { ok: false, reason: 'stale' };   // re-reading the accepted file (equal seq) is fine
  return { ok: true, registry: reg, kid: key.kid };
}

/**
 * Overlays a verified manifest on registry entries: for a known key, the pinned files (URL, size, sha256, revision) and
 * optionally the version replace the built-in ones. Unknown keys are ignored (the registry rows — licence, tier — ship
 * with the build); a file on a host outside the SEC-071 allow-list drops that entry.
 */
export function applySignedRegistry(defs: readonly ModelDef[], reg: SignedRegistryT, hosts: readonly string[] = DOWNLOAD_HOSTS): ModelDef[] {
  const byKey = new Map(reg.models.map((m) => [m.key, m]));
  return defs.map((d) => {
    const m = byKey.get(d.key);
    if (!m || d.availability !== 'download') return d;
    if (!m.files.every((f) => hosts.includes(new URL(f.url).hostname.toLowerCase()))) return d;
    const files: ModelFileDef[] = m.files.map((f) => ({ name: f.name, bytes: f.bytes, bytesExact: true, sha256: f.sha256, url: f.url, revision: f.revision }));
    return { ...d, ...(m.version ? { version: m.version } : {}), files, bytes: files.reduce((a, f) => a + f.bytes, 0) };
  });
}
