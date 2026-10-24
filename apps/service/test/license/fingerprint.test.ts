import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  componentHash, computeFingerprint, decodeMachineCode, FP_SALTS, firstLine, matchFingerprint, normaliseCpuModel,
  normaliseDiskSerial, normaliseMachineGuid, parseRegQueryMachineGuid, PosixFingerprintSource, WindowsFingerprintSource,
  type ExecFn,
} from '../../src/license/index.js';
import { fpA, fpB, MACHINE_A } from './helpers.js';

describe('normalisation (§5.1)', () => {
  it('machine GUID: trim + lower-case', () => {
    expect(normaliseMachineGuid('  6F1C2B3A-AB  ')).toBe('6f1c2b3a-ab');
    expect(normaliseMachineGuid('   ')).toBeNull();
  });
  it('disk serial: upper-case, strip non-alphanumerics', () => {
    expect(normaliseDiskSerial(' s4evnx0n  12-34_56 ')).toBe('S4EVNX0N123456');
    expect(normaliseDiskSerial('')).toBeNull();
  });
  it('CPU model: strip (R)/(TM)/®/™, collapse whitespace, upper-case', () => {
    expect(normaliseCpuModel(' Intel(R)  Core(TM) i5-1235U ')).toBe('INTEL CORE I5-1235U');
    expect(normaliseCpuModel('AMD Ryzen™ 7 5800H with Radeon®  Graphics')).toBe('AMD RYZEN 7 5800H WITH RADEON GRAPHICS');
  });
});

describe('hashing (§5.2)', () => {
  it('c_i = first 8 bytes of SHA-256(salt ‖ 0x00 ‖ value); missing → 8 zero bytes', () => {
    const expected = createHash('sha256').update(Buffer.concat([Buffer.from(FP_SALTS[0]), Buffer.from([0]), Buffer.from('abc')])).digest().subarray(0, 8);
    expect(Buffer.from(componentHash(FP_SALTS[0], 'abc'))).toEqual(expected);
    expect(componentHash(FP_SALTS[1], null)).toEqual(new Uint8Array(8));
  });
  it('fp is SHA-256 of c1‖c2‖c3 and the Machine Code decodes to the same components', () => {
    expect(fpA.fpHex).toBe(createHash('sha256').update(Buffer.concat(fpA.components.map((c) => Buffer.from(c)))).digest('hex'));
    const d = decodeMachineCode(fpA.machineCode);
    expect(d.ok && d.components).toEqual(fpA.components);
    expect(fpA.fpc.every((s) => /^[A-Z2-7]{13}$/.test(s))).toBe(true);
  });
  it('salting makes the same value hash differently per component', () => {
    expect(componentHash(FP_SALTS[0], 'X')).not.toEqual(componentHash(FP_SALTS[1], 'X'));
  });
});

describe('2-of-3 tolerance (§5.4) — drift on the SAME machine only', () => {
  it('all 3 equal → ok', () => {
    expect(matchFingerprint(fpA, fpA.fpc)).toMatchObject({ ok: true, compared: 3, matched: 3 });
  });
  it('1 component changed (disk replaced) → ok', () => {
    const drift = computeFingerprint({ ...MACHINE_A, diskSerial: 'NEWDISK999' });
    expect(matchFingerprint(drift, fpA.fpc)).toMatchObject({ ok: true, matched: 2 });
  });
  it('2 components changed (disk replaced AND Windows reinstalled) → mismatch', () => {
    const drift = computeFingerprint({ ...MACHINE_A, diskSerial: 'NEWDISK999', machineGuid: 'aaaa-new' });
    expect(matchFingerprint(drift, fpA.fpc)).toMatchObject({ ok: false, matched: 1 });
  });
  it('a different computer of the same model (only CPU equal) → mismatch', () => {
    expect(matchFingerprint(fpB, fpA.fpc)).toMatchObject({ ok: false, compared: 3, matched: 1 });
  });
  it('2 readable: both must match', () => {
    const noDisk = computeFingerprint({ ...MACHINE_A, diskSerial: null });
    expect(matchFingerprint(noDisk, fpA.fpc)).toMatchObject({ ok: true, compared: 2, matched: 2, unreadableLocal: [1] });
    const noDiskNewGuid = computeFingerprint({ ...MACHINE_A, diskSerial: null, machineGuid: 'other' });
    expect(matchFingerprint(noDiskNewGuid, fpA.fpc)).toMatchObject({ ok: false, compared: 2, matched: 1 });
  });
  it('component missing in the Payload counts as not comparable', () => {
    const payloadFpc = [fpA.fpc[0], 'AAAAAAAAAAAAA', fpA.fpc[2]];
    expect(matchFingerprint(fpA, payloadFpc)).toMatchObject({ ok: true, compared: 2 });
  });
  it('≤ 1 readable → mismatch even if that one matches', () => {
    const one = computeFingerprint({ machineGuid: MACHINE_A.machineGuid, diskSerial: null, cpuModel: null });
    expect(matchFingerprint(one, fpA.fpc)).toMatchObject({ ok: false, compared: 1, matched: 1 });
  });
});

describe('OS collection (parsers with injected exec)', () => {
  it('parses reg query output', () => {
    const out = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    6f1c2b3a-1111-4c5d-9e8f-0123456789ab\r\n\r\n';
    expect(parseRegQueryMachineGuid(out)).toBe('6f1c2b3a-1111-4c5d-9e8f-0123456789ab');
    expect(parseRegQueryMachineGuid('ERROR: not found')).toBeNull();
    expect(firstLine('\r\n  ABC  \r\nDEF')).toBe('ABC');
  });
  it('Windows source uses argument arrays (no shell) and survives failures', async () => {
    const calls: { file: string; args: readonly string[]; timeout: number }[] = [];
    const exec: ExecFn = async (file, args, timeout) => {
      calls.push({ file, args, timeout });
      if (file === 'reg') return '    MachineGuid    REG_SZ    6F1C2B3A-1111-4C5D-9E8F-0123456789AB\r\n';
      throw new Error('powershell missing');
    };
    const raw = await new WindowsFingerprintSource(exec, () => 'Intel(R) Core(TM) i5').read();
    expect(raw).toEqual({ machineGuid: '6F1C2B3A-1111-4C5D-9E8F-0123456789AB', diskSerial: null, cpuModel: 'Intel(R) Core(TM) i5' });
    expect(calls[0]).toMatchObject({ file: 'reg', args: ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'] });
    expect(calls.every((c) => c.timeout > 0 && c.timeout <= 10000)).toBe(true);
  });
  it('Linux fallback reads machine-id and the root disk serial', async () => {
    const exec: ExecFn = async (file, args) => {
      if (file === 'findmnt') return '/dev/nvme0n1p2\n';
      if (file === 'lsblk' && args[0] === '-no') return 'nvme0n1\n';
      if (file === 'lsblk') return 'S4EVNX0N123456\n';
      throw new Error('unexpected');
    };
    const src = new PosixFingerprintSource('linux', exec, async () => 'abcdef0123\n', () => 'AMD Ryzen 5');
    expect(await src.read()).toEqual({ machineGuid: 'abcdef0123', diskSerial: 'S4EVNX0N123456', cpuModel: 'AMD Ryzen 5' });
  });
});
