/**
 * Prompt-asset key split (SECURITY.md SEC-132; coordinator hardening item 3). The AES-256-GCM
 * key that decrypts the prompts module is never stored whole: half lives inside the
 * bytecode-compiled Service module, half is a build-time constant injected with esbuild `define`.
 * At start the Service combines the halves in memory only. Combining is HKDF-free XOR-then-SHA256
 * of the two 32-byte halves so neither half alone reveals the key.
 *
 * Pure: the caller provides a sha256 function so the module tests on Linux without node:crypto
 * import coupling. This raises extraction cost; a debugger on the running Service can still read
 * the combined key from memory (ADR-007 boundary — stated honestly in the README).
 */
export type Sha256 = (input: Uint8Array) => Uint8Array;

export class KeyHalfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyHalfError';
  }
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) throw new KeyHalfError('key half must be hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Derives the 32-byte AES key from two 32-byte halves (hex). The halves are XORed and the result
 * is hashed, so recovering one half does not reveal the key and both must be present.
 */
export function deriveAssetKey(halfA: string, halfB: string, sha256: Sha256): Uint8Array {
  const a = fromHex(halfA);
  const b = fromHex(halfB);
  if (a.length !== 32 || b.length !== 32) throw new KeyHalfError('each key half must be 32 bytes (64 hex chars)');
  const mixed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) mixed[i] = a[i]! ^ b[i]!;
  return sha256(mixed);
}
