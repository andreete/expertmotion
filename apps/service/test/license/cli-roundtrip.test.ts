/**
 * Round trip: the Operator CLI (tools/license-cli, plain JS) issues keys and revoked.json with a DEV-ONLY
 * key pair generated in a temp directory; the Local Service module verifies them. Proves the two agree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeFingerprint, verifyLicense, verifyRevocationList, type PublicKeyEntry, type TrustedRevocationList } from '../../src/license/index.js';
import { fpA, fpB, MACHINE_A, memoryLastSeen } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../tools/license-cli/src/cli.mjs');
let dir = '';
let keyFile = '';
let keys: PublicKeyEntry[] = [];

interface Run { status: number; stdout: string; stderr: string }
function cli(...args: string[]): Run {
  const r = spawnSync(process.execPath, [CLI, ...args, '--dev-allow-network', '--key-file', keyFile, '--audit', path.join(dir, 'audit.csv'), '--out-dir', path.join(dir, 'out')], {
    cwd: dir, encoding: 'utf8', timeout: 30000,
  });
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}
function cliJson(...args: string[]): Record<string, unknown> {
  const r = cli(...args, '--json');
  if (r.status !== 0) throw new Error(`cli ${args[0]} failed (${r.status}): ${r.stderr}`);
  return JSON.parse(r.stdout) as Record<string, unknown>;
}
function ctx(fingerprint = fpA, revocations: TrustedRevocationList | null = null, buildDate = '2026-01-01') {
  return { keys, fingerprint, buildDate, revocations, now: () => new Date(), lastSeen: memoryLastSeen() };
}
function exportedList(): TrustedRevocationList {
  cliJson('export-revocations', '--out', path.join(dir, 'dist', 'revoked.json'));
  const r = verifyRevocationList(readFileSync(path.join(dir, 'dist', 'revoked.json')), readFileSync(path.join(dir, 'dist', 'revoked.json.sig'), 'utf8'), keys);
  if (!r.ok) throw new Error(`revoked.json did not verify: ${r.reason}`);
  return r.trusted;
}
const issue = (mc: string, order: string) =>
  cliJson('issue', '--name', 'Septi Rahayu', '--email', 'septi@example.com', '--tier', 'standard', '--fingerprint', mc, '--order', order);

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'em-license-rt-'));
  keyFile = path.join(dir, 'DEV-ONLY-signing-key.json');
  const out = execFileSync(process.execPath, [CLI, 'keygen', '--kid', 'Z9', '--out', keyFile, '--dev-allow-network', '--json'], { encoding: 'utf8' });
  const k = JSON.parse(out) as { kid: string; publicKeyHex: string };
  keys = [{ kid: k.kid, publicKeyHex: k.publicKeyHex, status: 'active', since: '2026-10-24' }];
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('CLI → service round trip', () => {
  it('--help works', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('export-revocations');
  });

  it('issue → service verify: active on the bound machine only', () => {
    const r = issue(fpA.machineCode, 'ORD-1');
    const key = r.key as string;
    expect(key).toMatch(/^EM1-Z9-[A-Z2-7]+-[A-Z2-7]{103}$/);
    const ok = verifyLicense(key, ctx());
    expect(ok).toMatchObject({ status: 'active', tier: 'standard' });
    // 1 component drift on the same machine still OK
    expect(verifyLicense(key, ctx(computeFingerprint({ ...MACHINE_A, machineGuid: 'reinstalled' }))).status).toBe('active');
    // the same key on a second computer
    expect(verifyLicense(key, ctx(fpB)).code).toBe('EM-5003');
    // the .emlicense file verifies too (drag-and-drop path)
    expect(verifyLicense(readFileSync(r.file as string, 'utf8'), ctx()).status).toBe('active');
  });

  it('issue refuses without a Machine Code and with a mistyped one', () => {
    const none = cli('issue', '--name', 'A', '--email', 'a@example.com');
    expect(none.status).toBe(2);
    expect(none.stderr).toMatch(/requires the Creator's Machine Code/);
    const mc = fpA.machineCode;
    const typo = `${mc.slice(0, 12)}${mc[12] === 'A' ? 'B' : 'A'}${mc.slice(13)}`;
    const bad = cli('issue', '--name', 'A', '--email', 'a@example.com', '--fingerprint', typo);
    expect(bad.status).toBe(3);
    expect(bad.stderr).toMatch(/checksum/);
  });

  it('rebind → new key on new machine; old key EM-5004 once revoked.json arrives; 4th rebind refused (EM-5008)', () => {
    const first = issue(fpA.machineCode, 'ORD-2');
    const lid = first.lid as string;
    const oldKey = first.key as string;
    const r1 = cliJson('rebind', '--lid', lid, '--fingerprint', fpB.machineCode);
    expect(r1).toMatchObject({ rev: 1, revocationEpoch: 1 });
    const newKey = r1.key as string;
    expect(verifyLicense(newKey, ctx(fpB)).status).toBe('active');
    expect(verifyLicense(newKey, ctx(fpA)).code).toBe('EM-5003');
    // old machine before the list arrives: still active (accepted one-release leakage)
    expect(verifyLicense(oldKey, ctx(fpA)).status).toBe('active');
    const list = exportedList();
    expect(verifyLicense(oldKey, ctx(fpA, list))).toMatchObject({ status: 'revoked', code: 'EM-5004' });
    expect(verifyLicense(newKey, ctx(fpB, list)).status).toBe('active');

    // two more moves are allowed (3 per rolling 12 months), the 4th is refused
    const fpC = computeFingerprint({ machineGuid: 'c', diskSerial: 'C', cpuModel: 'C' });
    const fpD = computeFingerprint({ machineGuid: 'd', diskSerial: 'D', cpuModel: 'D' });
    const fpE = computeFingerprint({ machineGuid: 'e', diskSerial: 'E', cpuModel: 'E' });
    cliJson('rebind', '--lid', lid, '--fingerprint', fpC.machineCode);
    const r3 = cliJson('rebind', '--lid', lid, '--fingerprint', fpD.machineCode);
    const fourth = cli('rebind', '--lid', lid, '--fingerprint', fpE.machineCode);
    expect(fourth.status).toBe(3);
    expect(fourth.stderr).toMatch(/EM-5008 Transfer limit reached.*3 times in the last 12 months/);
    // nothing was issued: the latest key is still r3, and it is valid on machine D after export
    const list2 = exportedList();
    expect(verifyLicense(r3.key as string, ctx(fpD, list2)).status).toBe('active');
    expect(verifyLicense(newKey, ctx(fpB, list2)).code).toBe('EM-5004');
    // Operator override is possible and recorded
    const forced = cliJson('rebind', '--lid', lid, '--fingerprint', fpE.machineCode, '--override', 'mainboard replaced under warranty');
    expect(forced.rev).toBe(4);
    expect(readFileSync(path.join(dir, 'audit.csv'), 'utf8')).toContain('mainboard replaced under warranty');
  });

  it('L-6 via CLI: --updates-months 0 → EM-5005 for a later build; renew fixes it and revokes the old key', () => {
    const r = cliJson('issue', '--name', 'Budi', '--email', 'budi@example.com', '--fingerprint', fpA.machineCode, '--updates-months', '0', '--order', 'ORD-3');
    const later = '2999-01-01';
    expect(verifyLicense(r.key as string, ctx(fpA, null, later))).toMatchObject({ status: 'updates-expired', code: 'EM-5005' });
    const renewed = cliJson('renew', '--lid', r.lid as string, '--updates-months', '12', '--order', 'ORD-4');
    expect(renewed.rev).toBe(1);
    const list = exportedList();
    expect(verifyLicense(renewed.key as string, ctx(fpA, list)).status).toBe('active');
    expect(verifyLicense(r.key as string, ctx(fpA, list)).code).toBe('EM-5004');
  });

  it('revoke (refund) → EM-5004 for every key of the lid', () => {
    const r = cliJson('issue', '--name', 'Rina', '--email', 'rina@example.com', '--fingerprint', fpA.machineCode, '--order', 'ORD-5');
    cliJson('revoke', '--lid', r.lid as string, '--reason', 'refund');
    expect(verifyLicense(r.key as string, ctx(fpA, exportedList())).code).toBe('EM-5004');
    expect(cli('rebind', '--lid', r.lid as string, '--fingerprint', fpB.machineCode).status).toBe(3);
  });

  it('export-revocations is idempotent (byte-identical list and signature)', () => {
    cliJson('export-revocations', '--out', path.join(dir, 'a.json'));
    cliJson('export-revocations', '--out', path.join(dir, 'b.json'));
    expect(readFileSync(path.join(dir, 'a.json'))).toEqual(readFileSync(path.join(dir, 'b.json')));
    expect(readFileSync(path.join(dir, 'a.json.sig'), 'utf8')).toBe(readFileSync(path.join(dir, 'b.json.sig'), 'utf8'));
  });

  it('CLI verify agrees with the service for valid, tampered, wrong-machine, unknown-kid and malformed keys', () => {
    const r = issue(fpA.machineCode, 'ORD-6');
    const key = r.key as string;
    const parts = key.split('-');
    const p = parts[2] as string;
    const i = Math.floor(p.length / 2);
    const tampered = [parts[0], parts[1], p.slice(0, i) + (p[i] === 'A' ? 'B' : 'A') + p.slice(i + 1), parts[3]].join('-');
    const cases: [string, string, TrustedRevocationList | null][] = [
      [key, fpA.machineCode, null],
      [tampered, fpA.machineCode, null],
      [key, fpB.machineCode, null],
      ['EM1-XX-AAAA-BBBB', fpA.machineCode, null],
      ['garbage', fpA.machineCode, null],
    ];
    for (const [k, mc] of cases) {
      const v = cli('verify', '--key', k, '--fingerprint', mc, '--json', '--allow-network');
      const cliCode = (JSON.parse(v.stdout) as { code: string | null }).code;
      const svc = verifyLicense(k, ctx(mc === fpA.machineCode ? fpA : fpB));
      expect(cliCode ?? undefined).toBe(svc.code);
      expect(v.status).toBe(svc.code ? 1 : 0);
    }
  });

  it('refuses a private key file inside the repository', () => {
    const inside = path.resolve(path.dirname(CLI), '..', 'not-a-key.json');
    const r = spawnSync(process.execPath, [CLI, 'export-revocations', '--key-file', inside, '--dev-allow-network', '--audit', path.join(dir, 'audit.csv')], { cwd: dir, encoding: 'utf8' });
    expect(r.status).toBe(4);
    expect(r.stderr).toMatch(/inside the repository/);
  });
});
