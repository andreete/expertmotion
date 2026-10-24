import { describe, expect, it } from 'vitest';
import { BYTECODE_EXCLUSIONS, isExcludedFromBytecode, planHardening } from '../src/lib/harden-plan.js';
import { isRenderSafe, obfuscationConfig } from '../src/lib/obfuscation.js';
import { deriveAssetKey, KeyHalfError } from '../src/lib/keysplit.js';
import { createHash } from 'node:crypto';

const sha = (b: Uint8Array) => new Uint8Array(createHash('sha256').update(b).digest());

describe('harden pipeline planning (hardening items 1–4)', () => {
  it('on Windows runs bytecode for both service and main, then obfuscation, encryption, integrity last', () => {
    const steps = planHardening({ bytecode: true, obfuscate: true, encryptPrompts: true, integrity: true, isWindows: true });
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual(['bytecode:service', 'bytecode:main', 'obfuscate:editor', 'obfuscate:engine', 'encrypt:prompts', 'integrity:manifest']);
    expect(steps.every((s) => !s.skipped)).toBe(true);
    expect(ids.indexOf('integrity:manifest')).toBe(ids.length - 1);
  });

  it('off Windows marks the bytecode steps skipped with a reason (POC-006)', () => {
    const steps = planHardening({ bytecode: true, obfuscate: true, encryptPrompts: false, integrity: true, isWindows: false });
    const byteSteps = steps.filter((s) => s.id.startsWith('bytecode:'));
    expect(byteSteps).toHaveLength(2);
    expect(byteSteps.every((s) => s.skipped && /Windows build machine/.test(s.skipReason ?? ''))).toBe(true);
    // obfuscation and integrity still run on Linux.
    expect(steps.find((s) => s.id === 'obfuscate:engine')?.skipped).toBe(false);
  });

  it('--no-bytecode escape hatch drops the bytecode steps', () => {
    const steps = planHardening({ bytecode: false, obfuscate: true, encryptPrompts: false, integrity: false, isWindows: true });
    expect(steps.some((s) => s.id.startsWith('bytecode:'))).toBe(false);
  });

  it('excludes the Remotion/engine path and the Editor from bytecode (Function.prototype.toString)', () => {
    expect(isExcludedFromBytecode('resources/engine/bundle/897.bundle.js')).toBe(true);
    expect(isExcludedFromBytecode('dist/ui/assets/app.js')).toBe(true);
    expect(isExcludedFromBytecode('dist/service/service.cjs')).toBe(false);
    expect(BYTECODE_EXCLUSIONS.some((g) => g.includes('engine/bundle'))).toBe(true);
  });
});

describe('obfuscation config (hardening item 2)', () => {
  it('editor keeps debugProtection on; engine turns it off (headless)', () => {
    expect(obfuscationConfig('editor').debugProtection).toBe(true);
    expect(obfuscationConfig('engine').debugProtection).toBe(false);
  });

  it('uses the Operator-fixed strong options', () => {
    const c = obfuscationConfig('engine');
    expect(c.stringArrayEncoding).toEqual(['rc4']);
    expect(c.stringArrayThreshold).toBe(1);
    expect(c.controlFlowFlatteningThreshold).toBe(0.5);
    expect(c.deadCodeInjectionThreshold).toBe(0.2);
    expect(c.identifierNamesGenerator).toBe('hexadecimal');
    expect(c.selfDefending).toBe(true);
    expect(c.splitStrings).toBe(true);
    expect(c.transformObjectKeys).toBe(true);
    expect(c.sourceMap).toBe(false);
  });

  it('is render-safe (no sourcemaps, stringArray on)', () => {
    expect(isRenderSafe(obfuscationConfig('editor'))).toBe(true);
    expect(isRenderSafe(obfuscationConfig('engine'))).toBe(true);
  });
});

describe('prompt key split (hardening item 3, SEC-132)', () => {
  it('derives a 32-byte key deterministically from two halves', () => {
    const k1 = deriveAssetKey('a'.repeat(64), 'b'.repeat(64), sha);
    const k2 = deriveAssetKey('a'.repeat(64), 'b'.repeat(64), sha);
    expect(k1).toEqual(k2);
    expect(k1).toHaveLength(32);
  });

  it('different halves give a different key', () => {
    const k1 = deriveAssetKey('a'.repeat(64), 'b'.repeat(64), sha);
    const k2 = deriveAssetKey('a'.repeat(64), 'c'.repeat(64), sha);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(false);
  });

  it('rejects non-32-byte halves', () => {
    expect(() => deriveAssetKey('aa', 'b'.repeat(64), sha)).toThrow(KeyHalfError);
  });
});
