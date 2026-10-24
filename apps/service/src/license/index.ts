/**
 * Licence module public surface (LICENSE_OPERATIONS.md, ADR-014, SEC-120…122).
 * Bytecode-protected in production builds (ADR-007); embeds only public keys.
 */
export * from './format.js';
export * from './fingerprint.js';
export * from './keys.js';
export * from './revocations.js';
export * from './verify.js';
