/**
 * Main-process handlers of Expertmotion License Admin: key creation/unlock, issue → verify round trip
 * against the Local Service's verifier, rebind/renew/revoke/export, Machine Code validation, auto-lock,
 * network policy and IPC argument validation. Keys are DEV-ONLY, generated into a temp dir.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeFingerprint, verifyLicense, verifyRevocationList, type PublicKeyEntry, type TrustedRevocationList } from '../../service/src/license/index.js';
import { fpA, fpB, MACHINE_A, memoryLastSeen } from '../../service/test/license/helpers.js';
import { checkMachineCode, createAdmin, type Platform } from '../src/core/admin.js';
import { CHANNEL_NAMES } from '../src/core/channels.js';
import { DEFAULT_IDLE_MS } from '../src/core/session.js';
import { validateArgs } from '../src/core/validate.js';
import { passphraseStrength } from '../src/core/strength.js';

const PASS = 'correct horse battery staple';
let dir = '';
let keyDir = '';
let clipboard = '';
const shown: string[] = [];
let nextFolder: string | null = null;
let nextFile: string | null = null;
const platform: Platform = {
  pickFolder: async () => nextFolder,
  pickKeyFile: async () => nextFile,
  writeClipboard: (t) => { clipboard = t; },
  showInFolder: (p) => { shown.push(p); },
};

type Ok<T = Record<string, unknown>> = { ok: true; result: T };
async function ok<T = Record<string, unknown>>(admin: ReturnType<typeof createAdmin>, ch: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await admin.invoke(`em-admin:${ch}`, args, platform);
  if (!r.ok) throw new Error(`${ch}: ${r.error.code} ${r.error.message}`);
  return (r as Ok<T>).result;
}
async function err(admin: ReturnType<typeof createAdmin>, ch: string, args: unknown = {}) {
  const r = await admin.invoke(`em-admin:${ch}`, args, platform);
  if (r.ok) throw new Error(`${ch} unexpectedly succeeded`);
  return r.error;
}

function makeAdmin(over: Partial<Parameters<typeof createAdmin>[0]> = {}, name = 'ws') {
  const ws = path.join(dir, name);
  mkdirSync(ws, { recursive: true });
  return createAdmin({ settingsFile: path.join(dir, `${name}-settings.json`), defaultWorkspace: ws, upInterfaces: () => [], ...over });
}

async function unlockedAdmin(name: string, kid = 'Z9', over: Partial<Parameters<typeof createAdmin>[0]> = {}) {
  const admin = makeAdmin(over, name);
  const folder = path.join(keyDir, name);
  mkdirSync(folder, { recursive: true });
  nextFolder = folder;
  const picked = await ok<string>(admin, 'dialog.pickFolder', { purpose: 'keyFolder' });
  const k = await ok<{ kid: string; publicKeyHex: string; file: string; keyTableEntry: string }>(admin, 'key.create', { kid, passphrase: PASS, passphraseConfirm: PASS, folder: picked });
  return { admin, key: k };
}

const ctx = (keys: PublicKeyEntry[], fingerprint = fpA, revocations: TrustedRevocationList | null = null, buildDate = '2026-01-01') =>
  ({ keys, fingerprint, buildDate, revocations, now: () => new Date(), lastSeen: memoryLastSeen() });
/** accepted by the Local Service: no EM- code and none of the rejection states (status names are owned by apps/service) */
function expectAccepted(r: { code?: string; status: string }): void {
  expect(r.code).toBeUndefined();
  expect(['invalid', 'revoked', 'machine-mismatch', 'unlicensed']).not.toContain(r.status);
}
const entry = (k: { kid: string; publicKeyHex: string }): PublicKeyEntry[] => [{ kid: k.kid, publicKeyHex: k.publicKeyHex, status: 'active', since: '2026-10-24' }];

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'em-admin-'));
  keyDir = path.join(dir, 'usb');
  mkdirSync(keyDir);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('keys', () => {
  it('creates a sealed key (0600, no seed in the file), unlocks it and returns the key-table entry', async () => {
    const { admin, key } = await unlockedAdmin('create');
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.keyTableEntry).toContain(`kid: 'Z9', publicKeyHex: '${key.publicKeyHex}', status: 'active'`);
    const file = JSON.parse(readFileSync(key.file, 'utf8')) as Record<string, unknown>;
    expect(file.sealed).toBe(true);
    expect(file.seedHex).toBeUndefined();
    if (process.platform !== 'win32') expect(statSync(key.file).mode & 0o777).toBe(0o600);
    const st = await ok<{ key: { unlocked: boolean; kid: string } }>(admin, 'state.get');
    expect(st.key).toMatchObject({ unlocked: true, kid: 'Z9' });
    // settings never hold a passphrase or seed
    const settings = readFileSync(path.join(dir, 'create-settings.json'), 'utf8');
    expect(settings).not.toContain(PASS);
    expect(settings).toContain(key.publicKeyHex);
  });

  it('refuses mismatched / short passphrases, unapproved folders, folders inside a git repo, and overwriting', async () => {
    const admin = makeAdmin({}, 'refuse');
    const folder = path.join(keyDir, 'refuse');
    mkdirSync(folder, { recursive: true });
    expect((await err(admin, 'key.create', { kid: 'A1', passphrase: PASS, passphraseConfirm: PASS, folder })).code).toBe('PATH'); // not from a dialog
    nextFolder = folder;
    await ok(admin, 'dialog.pickFolder', { purpose: 'keyFolder' });
    expect((await err(admin, 'key.create', { kid: 'A1', passphrase: PASS, passphraseConfirm: `${PASS}!`, folder })).code).toBe('PASSPHRASE');
    expect((await err(admin, 'key.create', { kid: 'A1', passphrase: 'short pass', passphraseConfirm: 'short pass', folder })).code).toBe('PASSPHRASE');
    await ok(admin, 'key.create', { kid: 'A1', passphrase: PASS, passphraseConfirm: PASS, folder });
    expect((await err(admin, 'key.create', { kid: 'A1', passphrase: PASS, passphraseConfirm: PASS, folder })).message).toMatch(/overwrite/);
    const repo = path.join(dir, 'somerepo');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirSync(path.join(repo, 'keys'));
    nextFolder = path.join(repo, 'keys');
    await ok(admin, 'dialog.pickFolder', { purpose: 'keyFolder' });
    expect((await err(admin, 'key.create', { kid: 'A2', passphrase: PASS, passphraseConfirm: PASS, folder: nextFolder })).message).toMatch(/git repository/);
  });

  it('opens a sealed key with the passphrase; wrong passphrase and unsealed key files are refused', async () => {
    const { key } = await unlockedAdmin('open', 'Q1');
    const admin = makeAdmin({}, 'open2');
    nextFile = key.file;
    await ok(admin, 'dialog.pickKeyFile');
    const bad = await err(admin, 'key.open', { file: key.file, passphrase: 'wrong passphrase!!' });
    expect(bad.code).toBe('PASSPHRASE');
    expect(bad.message).not.toContain('wrong passphrase!!');
    const r = await ok<{ kid: string; publicKeyHex: string }>(admin, 'key.open', { file: key.file, passphrase: PASS });
    expect(r).toMatchObject({ kid: 'Q1', publicKeyHex: key.publicKeyHex });
    const unsealed = path.join(keyDir, 'unsealed.json');
    writeFileSync(unsealed, JSON.stringify({ format: 'expertmotion-license-private-key/1', kid: 'U1', sealed: false, seedHex: '00'.repeat(32) }), { mode: 0o600 });
    nextFile = unsealed;
    await ok(admin, 'dialog.pickKeyFile');
    expect((await err(admin, 'key.open', { file: unsealed, passphrase: PASS })).message).toMatch(/not sealed/);
  });
});

describe('issue → verify round trip (service verifier)', () => {
  it('issues a key the Local Service accepts on the bound machine only; email EN+ID; audit appended; key never in settings', async () => {
    const { admin, key } = await unlockedAdmin('issue');
    const r = await ok<{ lid: string; rev: number; key: string; keyGrouped: string; emailText: string; file: string; updatesUntil: string }>(admin, 'licence.issue', {
      name: 'Septi Rahayu', email: 'septi@example.com', orderId: 'ORD-10231', updatesMonths: 12, machineCode: fpA.machineCode,
    });
    expect(r.key).toMatch(/^EM1-Z9-[A-Z2-7]+-[A-Z2-7]{103}$/);
    expect(r.rev).toBe(0);
    expectAccepted(verifyLicense(r.key, ctx(entry(key))));
    expectAccepted(verifyLicense(r.key, ctx(entry(key), computeFingerprint({ ...MACHINE_A, machineGuid: 'reinstalled' }))));
    expect(verifyLicense(r.key, ctx(entry(key), fpB)).code).toBe('EM-5003');
    expect(readFileSync(r.file, 'utf8').trim()).toBe(r.key);
    expect(r.emailText).toContain('Subject: Your Expertmotion licence key');
    expect(r.emailText).toContain('Subjek: Kunci lisensi Expertmotion Anda');
    expect(r.emailText).toContain(r.keyGrouped);
    expect(r.emailText).toContain(fpA.machineCode);
    const list = await ok<{ licences: { lid: string; status: string; orderRef: string }[] }>(admin, 'licence.list', { query: 'septi' });
    expect(list.licences).toHaveLength(1);
    expect(list.licences[0]).toMatchObject({ lid: r.lid, status: 'active', orderRef: 'ORD-10231' });
    expect((await ok<{ licences: unknown[] }>(admin, 'licence.list', { query: 'nobody' })).licences).toHaveLength(0);
    // duplicate order refused unless an override reason is given (same policy as the CLI)
    const dup = await err(admin, 'licence.issue', { name: 'Septi', email: 'septi@example.com', orderId: 'ORD-10231', updatesMonths: 12, machineCode: fpA.machineCode });
    expect(dup).toMatchObject({ code: 'POLICY' });
    expect(dup.message).toMatch(/already has a licence/);
    await ok(admin, 'licence.issue', { name: 'Septi', email: 'septi@example.com', orderId: 'ORD-10231', updatesMonths: 12, machineCode: fpA.machineCode, override: 'second seat' });
    // admin verify agrees with the service
    const v = await ok<{ valid: boolean; code: string | null; payload: { lid: string } }>(admin, 'licence.verify', { key: r.key, machineCode: fpA.machineCode });
    expect(v).toMatchObject({ valid: true, code: null });
    expect(v.payload.lid).toBe(r.lid);
    expect((await ok<{ code: string }>(admin, 'licence.verify', { key: r.key, machineCode: fpB.machineCode })).code).toBe('EM-5003');
    expect((await ok<{ code: string }>(admin, 'licence.verify', { key: 'garbage' })).code).toBe('EM-5006');
    expect(readFileSync(path.join(dir, 'issue-settings.json'), 'utf8')).not.toContain(r.key);
  });

  it('refuses a mistyped Machine Code (CRC) and a missing one; nothing is written', async () => {
    const { admin } = await unlockedAdmin('typo');
    const mc = fpA.machineCode;
    const typo = `${mc.slice(0, 12)}${mc[12] === 'A' ? 'B' : 'A'}${mc.slice(13)}`;
    const e1 = await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 12, machineCode: typo });
    expect(e1.message).toMatch(/checksum/);
    const e2 = await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 12, machineCode: '' });
    expect(e2.message).toMatch(/requires the Creator's Machine Code/);
    expect((await ok<{ licences: unknown[] }>(admin, 'licence.list')).licences).toHaveLength(0);
  });

  it('rebind, renew, revoke and export revoked.json: the service sees the right state', async () => {
    const { admin, key } = await unlockedAdmin('lifecycle');
    const keys = entry(key);
    const first = await ok<{ lid: string; key: string }>(admin, 'licence.issue', { name: 'Budi', email: 'budi@example.com', updatesMonths: 0, machineCode: fpA.machineCode });
    const moved = await ok<{ key: string; rev: number; revocationEpoch: number; emailText: string }>(admin, 'licence.rebind', { lid: first.lid, machineCode: fpB.machineCode });
    expect(moved).toMatchObject({ rev: 1, revocationEpoch: 1 });
    expect(moved.emailText).toContain('Your updated licence key');
    expectAccepted(verifyLicense(moved.key, ctx(keys, fpB)));
    const renewed = await ok<{ key: string; rev: number; updatesUntil: string }>(admin, 'licence.renew', { lid: first.lid, updatesMonths: 12, orderId: 'ORD-R1' });
    expect(renewed.rev).toBe(2);
    expect(verifyLicense(renewed.key, ctx(keys, fpB, null, '2999-01-01')).code).toBe('EM-5005');
    const exported = await ok<{ out: string; sig: string; entries: number }>(admin, 'revocations.export');
    const list = verifyRevocationList(readFileSync(exported.out), readFileSync(exported.sig, 'utf8'), keys);
    if (!list.ok) throw new Error(list.reason);
    expect(verifyLicense(first.key, ctx(keys, fpA, list.trusted)).code).toBe('EM-5004');
    expect(verifyLicense(moved.key, ctx(keys, fpB, list.trusted)).code).toBe('EM-5004');
    expectAccepted(verifyLicense(renewed.key, ctx(keys, fpB, list.trusted)));
    // verify in the admin app uses the workspace revoked.json too
    expect((await ok<{ code: string }>(admin, 'licence.verify', { key: first.key })).code).toBe('EM-5004');
    // revoke → every key of the lid is dead after export; further rebind refused
    expect(await ok(admin, 'licence.revoke', { lid: first.lid, reason: 'refund', note: 'order refunded' })).toMatchObject({ lid: first.lid, epoch: 3, reason: 'refund' });
    expect((await err(admin, 'licence.revoke', { lid: first.lid, reason: 'refund' })).message).toMatch(/already revoked/);
    expect((await err(admin, 'licence.rebind', { lid: first.lid, machineCode: fpA.machineCode })).code).toBe('POLICY');
    const ex2 = await ok<{ out: string; sig: string }>(admin, 'revocations.export');
    const list2 = verifyRevocationList(readFileSync(ex2.out), readFileSync(ex2.sig, 'utf8'), keys);
    if (!list2.ok) throw new Error(list2.reason);
    expect(verifyLicense(renewed.key, ctx(keys, fpB, list2.trusted)).code).toBe('EM-5004');
    const hist = await ok<{ rows: { action: string }[] }>(admin, 'licence.history', { lid: first.lid.toLowerCase() });
    expect(hist.rows.map((r) => r.action)).toEqual(['issue', 'rebind', 'renew', 'revoke']);
    const listed = await ok<{ licences: { status: string }[] }>(admin, 'licence.list');
    expect(listed.licences[0]!.status).toBe('revoked');
    // reveal-in-folder only for files this app produced
    await ok(admin, 'dialog.openPath', { path: ex2.out });
    expect(shown).toContain(ex2.out);
    expect((await err(admin, 'dialog.openPath', { path: '/etc/passwd' })).code).toBe('PATH');
  });

  it('4th rebind in 12 months is refused with EM-5008 unless an override reason is given', async () => {
    const { admin } = await unlockedAdmin('limit');
    const issued = await ok<{ lid: string }>(admin, 'licence.issue', { name: 'Citra', email: 'citra@example.com', updatesMonths: 12, machineCode: fpA.machineCode });
    const codes = ['c', 'd', 'e', 'f'].map((s) => computeFingerprint({ machineGuid: s, diskSerial: s.toUpperCase(), cpuModel: s }).machineCode);
    for (const mc of codes.slice(0, 3)) await ok(admin, 'licence.rebind', { lid: issued.lid, machineCode: mc });
    const fourth = await err(admin, 'licence.rebind', { lid: issued.lid, machineCode: codes[3] });
    expect(fourth).toMatchObject({ code: 'POLICY', emCode: 'EM-5008' });
    expect(fourth.message).not.toMatch(/--override/);
    expect((await ok<{ rev: number }>(admin, 'licence.rebind', { lid: issued.lid, machineCode: codes[3], override: 'mainboard replaced' })).rev).toBe(4);
  });
});

describe('Machine Code validation', () => {
  it('accepts a valid code, flags typos (CRC), bad format, empty input and codes with < 2 readable components', () => {
    expect(checkMachineCode(fpA.machineCode)).toMatchObject({ ok: true, readableComponents: 3 });
    expect(checkMachineCode(` ${fpA.machineCode.toLowerCase()} `).ok).toBe(true);
    const mc = fpA.machineCode;
    expect(checkMachineCode(`${mc.slice(0, -1)}${mc.endsWith('A') ? 'B' : 'A'}`)).toMatchObject({ ok: false, reason: 'crc' });
    expect(checkMachineCode('MC1-HELLO')).toMatchObject({ ok: false, reason: 'format' });
    expect(checkMachineCode('EM1-Z9-AAAA-BBBB')).toMatchObject({ ok: false, reason: 'format' });
    expect(checkMachineCode('')).toMatchObject({ ok: false, reason: 'empty' });
    const oneComponent = computeFingerprint({ machineGuid: 'only-this', diskSerial: null, cpuModel: null }).machineCode;
    expect(checkMachineCode(oneComponent)).toMatchObject({ ok: false, reason: 'components', readableComponents: 1 });
  });
});

describe('auto-lock', () => {
  it('locks after 15 minutes idle, zeroes the seed, refuses signing; activity resets the timer', async () => {
    let t = Date.parse('2026-10-25T08:00:00Z');
    const locks: string[] = [];
    const { admin } = await unlockedAdmin('idle', 'Z9', { now: () => new Date(t), onLock: (r) => locks.push(r) });
    expect(DEFAULT_IDLE_MS).toBe(15 * 60 * 1000);
    const seed = admin.session.require().seed;
    t += 14 * 60 * 1000;
    await ok(admin, 'activity.touch');
    t += 14 * 60 * 1000; // 28 min since unlock, 14 since the last activity
    expect((await ok<{ key: { unlocked: boolean } }>(admin, 'state.get')).key.unlocked).toBe(true);
    t += 61 * 1000;
    expect(admin.session.checkIdle()).toBe(true);
    expect(locks).toEqual(['idle']);
    expect(seed.every((b) => b === 0)).toBe(true);
    expect((await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 12, machineCode: fpA.machineCode })).code).toBe('LOCKED');
    expect((await err(admin, 'revocations.export')).code).toBe('LOCKED');
    expect((await ok<{ key: { unlocked: boolean } }>(admin, 'state.get')).key.unlocked).toBe(false);
  });

  it('also locks lazily on the next request after the idle period (no timer needed) and on manual lock', async () => {
    let t = Date.parse('2026-10-25T09:00:00Z');
    const { admin } = await unlockedAdmin('idle2', 'Z9', { now: () => new Date(t) });
    t += DEFAULT_IDLE_MS;
    expect((await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 12, machineCode: fpA.machineCode })).code).toBe('LOCKED');
    const { admin: b } = await unlockedAdmin('manual');
    await ok(b, 'key.lock');
    expect((await err(b, 'revocations.export')).code).toBe('LOCKED');
  });
});

describe('network policy', () => {
  it('strict: signing refused while an interface is up; read-only verify/list still work; warn: allowed', async () => {
    let up: string[] = [];
    const { admin, key } = await unlockedAdmin('net', 'Z9', { upInterfaces: () => up });
    const issued = await ok<{ key: string }>(admin, 'licence.issue', { name: 'Dewi', email: 'dewi@example.com', updatesMonths: 12, machineCode: fpA.machineCode });
    up = ['Wi-Fi'];
    const st = await ok<{ network: { online: boolean; policy: string; up: string[] } }>(admin, 'state.get');
    expect(st.network).toEqual({ online: true, policy: 'strict', up: ['Wi-Fi'] });
    const refused = await err(admin, 'licence.issue', { name: 'Eko', email: 'eko@example.com', updatesMonths: 12, machineCode: fpB.machineCode });
    expect(refused.code).toBe('NETWORK');
    expect(refused.message).toMatch(/Wi-Fi/);
    expect((await err(admin, 'revocations.export')).code).toBe('NETWORK');
    nextFile = key.file;
    await ok(admin, 'dialog.pickKeyFile');
    expect((await err(admin, 'key.open', { file: key.file, passphrase: PASS })).code).toBe('NETWORK');
    expect((await ok<{ valid: boolean }>(admin, 'licence.verify', { key: issued.key })).valid).toBe(true);
    expect((await ok<{ licences: unknown[] }>(admin, 'licence.list')).licences).toHaveLength(1);
    await ok(admin, 'settings.update', { networkPolicy: 'warn' });
    await ok(admin, 'licence.issue', { name: 'Eko', email: 'eko@example.com', updatesMonths: 12, machineCode: fpB.machineCode });
    // the policy persists
    const again = makeAdmin({ upInterfaces: () => up }, 'net');
    expect((await ok<{ network: { policy: string } }>(again, 'state.get')).network.policy).toBe('warn');
  });
});

describe('IPC argument validation', () => {
  it('rejects unknown channels, non-objects, unknown keys, wrong types, out-of-range numbers and oversize strings', async () => {
    const admin = makeAdmin({}, 'ipc');
    expect((await admin.invoke('em-admin:shell.exec', {}, platform)).ok).toBe(false);
    expect((await admin.invoke(42, {}, platform)).ok).toBe(false);
    expect((await err(admin, 'licence.verify', 'EM1-…')).code).toBe('EINVAL');
    expect((await err(admin, 'licence.verify', ['EM1-…'])).code).toBe('EINVAL');
    expect((await err(admin, 'licence.verify', { key: 'x', extra: 1 })).message).toMatch(/Unexpected field extra/);
    expect((await err(admin, 'licence.verify', { key: 7 })).message).toMatch(/must be text/);
    expect((await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 1.5, machineCode: 'x' })).code).toBe('EINVAL');
    expect((await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 1000, machineCode: 'x' })).code).toBe('EINVAL');
    expect((await err(admin, 'licence.issue', { name: 'A', email: 'a@example.com', updatesMonths: 12 })).message).toMatch(/Missing machineCode/);
    expect((await err(admin, 'licence.revoke', { lid: '01JB5X0000000000000000000A', reason: 'bored' })).message).toMatch(/one of: refund, fraud/);
    expect((await err(admin, 'licence.history', { lid: '../../etc/passwd' })).code).toBe('EINVAL');
    expect((await err(admin, 'clipboard.write', { text: 'x'.repeat(70000) })).message).toMatch(/too long/);
    expect((await err(admin, 'key.create', { kid: 'a1', passphrase: PASS, passphraseConfirm: PASS, folder: dir })).code).toBe('EINVAL');
    expect((await err(admin, 'dialog.pickFolder', { purpose: 'anywhere' })).code).toBe('EINVAL');
    const polluted = JSON.parse('{"__proto__": {"x": 1}, "key": "EM1"}') as unknown;
    expect((await err(admin, 'licence.verify', polluted)).code).toBe('EINVAL');
    await ok(admin, 'clipboard.write', { text: 'EM1-key' });
    expect(clipboard).toBe('EM1-key');
  });

  it('validateArgs returns only schema keys; every channel has a schema the preload exposes', () => {
    expect(validateArgs('em-admin:licence.list', undefined)).toEqual({});
    expect(validateArgs('em-admin:licence.verify', { key: 'EM1' })).toEqual({ key: 'EM1' });
    expect(CHANNEL_NAMES.every((c) => c.startsWith('em-admin:'))).toBe(true);
    expect(CHANNEL_NAMES).toContain('em-admin:licence.issue');
  });

  it('settings.update accepts only a workspace folder chosen in a dialog', async () => {
    const admin = makeAdmin({}, 'set');
    const other = path.join(dir, 'other-ws');
    mkdirSync(other);
    expect((await err(admin, 'settings.update', { workspaceDir: other })).code).toBe('PATH');
    nextFolder = other;
    await ok(admin, 'dialog.pickFolder', { purpose: 'workspace' });
    await ok(admin, 'settings.update', { workspaceDir: other, signature: 'Andre\nInjected', lang: 'id' });
    const st = await ok<{ settings: { workspaceDir: string; signature: string; lang: string }; paths: { auditPath: string } }>(admin, 'state.get');
    expect(st.settings).toMatchObject({ workspaceDir: other, signature: 'Andre Injected', lang: 'id' });
    expect(st.paths.auditPath).toBe(path.join(other, 'audit', 'licences.csv'));
  });
});

describe('passphrase strength hint', () => {
  it('grades length and variety', () => {
    expect(passphraseStrength('short').level).toBe('too-short');
    expect(passphraseStrength('aaaaaaaaaaaaaaaa').level).toBe('weak');
    expect(passphraseStrength('password1234').level).toBe('weak');
    expect(passphraseStrength('correct horse battery staple').level).toBe('strong');
  });
});
