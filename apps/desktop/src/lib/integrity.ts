/**
 * Startup integrity manifest (SECURITY.md SEC-061, SEC-133; coordinator hardening item 4).
 * The build generates a manifest listing sha256 of the protected artefacts (service.jsc, the
 * Engine bundle index, resources/bin binaries) and signs it with the Operator's Ed25519 release
 * key. The embedded public key verifies it at startup; a mismatch refuses to start (EM-8002).
 *
 * This module is pure: hashing and verification math only, no filesystem and no `electron`.
 * The caller supplies the already-computed file digests. Ed25519 uses Node's WebCrypto-free
 * `crypto.verify`/`crypto.sign` via injected functions so the module stays testable on Linux.
 */
export interface ManifestEntry {
  /** Logical path, e.g. `dist/service/service.jsc` or `engine/bundle/index.html`. */
  path: string;
  /** Lowercase hex sha256 of the file's bytes. */
  sha256: string;
  /** Size in bytes (a cheap first check before hashing at runtime). */
  bytes: number;
}

export interface IntegrityManifest {
  readonly version: 1;
  /** App semver this manifest was built for. */
  readonly appVersion: string;
  /** ISO-8601 build time. */
  readonly builtAt: string;
  /** Sorted by path for a stable canonical form. */
  readonly entries: readonly ManifestEntry[];
}

export interface SignedManifest {
  readonly manifest: IntegrityManifest;
  /** base64 Ed25519 signature over `canonicalManifestBytes(manifest)`. */
  readonly signature: string;
  /** Signature algorithm label, always `ed25519`. */
  readonly alg: 'ed25519';
}

/** Canonical, signature-stable serialisation: entries sorted by path, no insignificant whitespace. */
export function canonicalManifestBytes(manifest: IntegrityManifest): Uint8Array {
  const entries = [...manifest.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = { version: manifest.version, appVersion: manifest.appVersion, builtAt: manifest.builtAt, entries };
  return new TextEncoder().encode(JSON.stringify(canonical));
}

export function buildManifest(args: { appVersion: string; builtAt: string; entries: readonly ManifestEntry[] }): IntegrityManifest {
  const entries = [...args.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { version: 1, appVersion: args.appVersion, builtAt: args.builtAt, entries };
}

export type Ed25519Verify = (message: Uint8Array, signatureB64: string, publicKey: Uint8Array) => boolean;

export type VerifyResult =
  | { ok: true }
  | { ok: false; code: 'bad-signature' | 'missing' | 'hash-mismatch' | 'size-mismatch'; path?: string; expected?: string; actual?: string };

/**
 * Verifies a signed manifest against the runtime digests of the files it names.
 * `actualDigests` maps each manifest path to `{sha256, bytes}` read at startup.
 */
export function verifyManifest(
  signed: SignedManifest,
  publicKey: Uint8Array,
  actualDigests: ReadonlyMap<string, { sha256: string; bytes: number }>,
  verify: Ed25519Verify,
): VerifyResult {
  if (!verify(canonicalManifestBytes(signed.manifest), signed.signature, publicKey)) {
    return { ok: false, code: 'bad-signature' };
  }
  for (const entry of signed.manifest.entries) {
    const actual = actualDigests.get(entry.path);
    if (actual === undefined) return { ok: false, code: 'missing', path: entry.path };
    if (actual.bytes !== entry.bytes) return { ok: false, code: 'size-mismatch', path: entry.path, expected: String(entry.bytes), actual: String(actual.bytes) };
    if (actual.sha256 !== entry.sha256) return { ok: false, code: 'hash-mismatch', path: entry.path, expected: entry.sha256, actual: actual.sha256 };
  }
  return { ok: true };
}
