// node --test tools/license-cli/test/cli.test.mjs
// CLI-only behaviour. DEV-ONLY keys are generated into a temp directory at test time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { componentHash, decodeMachineCode, encodeMachineCode, FP_SALTS, addMonths, ulid } from '../src/lib/format.mjs';
import { upInterfaces } from '../src/lib/net.mjs';
import { readAudit } from '../src/lib/audit.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.mjs');
const mc = (seed) => encodeMachineCode(FP_SALTS.map((s, i) => componentHash(s, `${seed}-${i}`)));
let dir;
let keyFile;

function run(args, { env = {}, base = true } = {}) {
  const extra = base ? ['--dev-allow-network', '--key-file', keyFile, '--audit', path.join(dir, 'audit.csv'), '--out-dir', path.join(dir, 'out')] : [];
  const r = spawnSync(process.execPath, [CLI, ...args, ...extra], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 30000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const json = (args, opts) => {
  const r = run([...args, '--json'], opts);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'em-license-cli-'));
  keyFile = path.join(dir, 'DEV-ONLY-key.json');
  const r = spawnSync(process.execPath, [CLI, 'keygen', '--kid', 'Z9', '--out', keyFile, '--dev-allow-network'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
after(() => rmSync(dir, { recursive: true, force: true }));

describe('format helpers', () => {
  it('ULID shape and monotonic time prefix', () => {
    const a = ulid(1_700_000_000_000);
    assert.match(a, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(ulid(1_700_000_000_001).slice(0, 10) >= a.slice(0, 10));
  });
  it('addMonths clamps to month end', () => {
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-11-01', 12), '2027-11-01');
    assert.equal(addMonths('2026-11-01', 0), '2026-11-01');
  });
  it('Machine Code round trip and CRC', () => {
    const code = mc('x');
    assert.match(code, /^MC1-[A-Z2-7]{42}$/);
    assert.equal(decodeMachineCode(code).ok, true);
    assert.equal(decodeMachineCode(code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A')).ok, false);
  });
});

describe('expertmotion-license CLI', () => {
  it('--help prints usage and exits 0', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /issue .*--fingerprint MC1-/);
    assert.match(r.stdout, /rebind/);
  });

  it('unknown command / option → exit 2', () => {
    assert.equal(spawnSync(process.execPath, [CLI, 'frobnicate'], { encoding: 'utf8' }).status, 2);
    assert.equal(spawnSync(process.execPath, [CLI, 'issue', '--bogus'], { encoding: 'utf8' }).status, 2);
  });

  it('refuses to run signing commands while a network interface is up (without the dev flag)', { skip: upInterfaces().length === 0 && 'no interface up here' }, () => {
    const r = spawnSync(process.execPath, [CLI, 'export-revocations', '--key-file', keyFile, '--audit', path.join(dir, 'audit.csv')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /network interface/);
  });

  it('issue refuses without the Creator\'s Machine Code (no unbound keys)', () => {
    const r = run(['issue', '--name', 'Septi', '--email', 'septi@example.com']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /requires the Creator's Machine Code.*exactly one computer/);
    assert.equal(readAudit(path.join(dir, 'audit.csv')).length, 0);
  });

  it('issue refuses a mistyped Machine Code (CRC) and a duplicate order', () => {
    const code = mc('a');
    const typo = code.slice(0, 20) + (code[20] === 'A' ? 'B' : 'A') + code.slice(21);
    const bad = run(['issue', '--name', 'Septi', '--email', 'septi@example.com', '--fingerprint', typo]);
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /checksum/);
    json(['issue', '--name', 'Septi', '--email', 'septi@example.com', '--fingerprint', code, '--order', 'ORD-1']);
    assert.equal(run(['issue', '--name', 'Septi', '--email', 'septi@example.com', '--fingerprint', code, '--order', 'ORD-1']).status, 3);
  });

  it('rebind: 3 per rolling 12 months, the 4th is refused with EM-5008 unless --override', () => {
    const issued = json(['issue', '--name', 'Budi', '--email', 'budi@example.com', '--fingerprint', mc('b0'), '--order', 'ORD-2']);
    for (let n = 1; n <= 3; n++) {
      const r = json(['rebind', '--lid', issued.lid, '--fingerprint', mc(`b${n}`)]);
      assert.equal(r.rev, n);
      assert.equal(r.revocationEpoch, n);
    }
    const fourth = run(['rebind', '--lid', issued.lid, '--fingerprint', mc('b4')]);
    assert.equal(fourth.status, 3);
    assert.match(fourth.stderr, /EM-5008 Transfer limit reached/);
    assert.match(fourth.stderr, /--override/);
    const rows = readAudit(path.join(dir, 'audit.csv')).filter((r) => r.lid === issued.lid);
    assert.equal(rows.length, 4, 'refused rebind must not append an audit row');
    const audit = run(['audit', '--lid', issued.lid, '--allow-network']);
    assert.match(audit.stdout, /re-binds in the last 12 months: 3 of 3/);
    assert.equal(json(['rebind', '--lid', issued.lid, '--fingerprint', mc('b4'), '--override', 'support case 17']).rev, 4);
  });

  it('rebind to the Machine Code it is already bound to is refused', () => {
    const issued = json(['issue', '--name', 'Citra', '--email', 'citra@example.com', '--fingerprint', mc('c0'), '--order', 'ORD-3']);
    assert.equal(run(['rebind', '--lid', issued.lid, '--fingerprint', mc('c0')]).status, 3);
  });

  it('export-revocations derives epochs from the audit log; CLI verify honours them', () => {
    const issued = json(['issue', '--name', 'Dewi', '--email', 'dewi@example.com', '--fingerprint', mc('d0'), '--order', 'ORD-4']);
    const moved = json(['rebind', '--lid', issued.lid, '--fingerprint', mc('d1')]);
    const out = path.join(dir, 'dist', 'revoked.json');
    const ex = json(['export-revocations', '--out', out]);
    assert.ok(ex.entries >= 1);
    const list = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(list.entries.find((e) => e.lid === issued.lid), { lid: issued.lid, epoch: 1, reason: 'rebind' });
    assert.match(readFileSync(`${out}.sig`, 'utf8'), /^EMREV1-Z9-[A-Z2-7]{103}\n$/);
    const oldV = run(['verify', '--key', issued.key, '--revoked', out, '--fingerprint', mc('d0'), '--json', '--allow-network']);
    assert.equal(oldV.status, 1);
    assert.equal(JSON.parse(oldV.stdout).code, 'EM-5004');
    const newV = run(['verify', '--key', moved.key, '--revoked', out, '--fingerprint', mc('d1'), '--json', '--allow-network']);
    assert.equal(newV.status, 0, newV.stderr);
    const wrongPc = run(['verify', '--key', moved.key, '--fingerprint', mc('d0'), '--json', '--allow-network']);
    assert.equal(JSON.parse(wrongPc.stdout).code, 'EM-5003');
  });

  it('audit CSV neutralises spreadsheet formulas in untrusted fields', () => {
    json(['issue', '--name', '=HYPERLINK("x")', '--email', 'eve@example.com', '--fingerprint', mc('e0'), '--order', 'ORD-5']);
    const raw = readFileSync(path.join(dir, 'audit.csv'), 'utf8');
    assert.match(raw, /"'=HYPERLINK\(""x""\)"/);
    assert.ok(readAudit(path.join(dir, 'audit.csv')).some((r) => r.name === '=HYPERLINK("x")'));
  });

  it('sealed key: keygen --seal + use with passphrase; wrong passphrase refused; file mode 0600; key never printed', () => {
    const sealed = path.join(dir, 'DEV-ONLY-sealed.json');
    const env = { EXPERTMOTION_LICENSE_PASSPHRASE: 'correct horse battery staple' };
    const k = spawnSync(process.execPath, [CLI, 'keygen', '--kid', 'Z8', '--out', sealed, '--seal', '--dev-allow-network', '--json'], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(k.status, 0, k.stderr);
    const file = JSON.parse(readFileSync(sealed, 'utf8'));
    assert.equal(file.sealed, true);
    assert.equal(file.seedHex, undefined);
    if (process.platform !== 'win32') assert.equal(statSync(sealed).mode & 0o777, 0o600);
    const args = ['export-revocations', '--out', path.join(dir, 'z8.json'), '--dev-allow-network', '--key-file', sealed, '--audit', path.join(dir, 'audit.csv')];
    const ok = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(ok.status, 0, ok.stderr);
    const bad = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, EXPERTMOTION_LICENSE_PASSPHRASE: 'wrong passphrase!!' } });
    assert.equal(bad.status, 4);
    assert.match(bad.stderr, /passphrase/);
    assert.ok(!k.stdout.includes(file.cipher.ctHex));
  });

  it('keygen refuses to write inside the repository or overwrite', () => {
    const inRepo = path.resolve(path.dirname(CLI), '..', 'test', 'should-not-exist.json');
    const r = spawnSync(process.execPath, [CLI, 'keygen', '--kid', 'Z7', '--out', inRepo, '--dev-allow-network'], { encoding: 'utf8' });
    assert.equal(r.status, 4);
    assert.match(r.stderr, /inside the repository/);
    assert.equal(spawnSync(process.execPath, [CLI, 'keygen', '--kid', 'Z9', '--out', keyFile, '--dev-allow-network'], { encoding: 'utf8' }).status, 4);
  });

  it('reissue --all-active re-signs non-revoked licences with the new kid and writes an email batch', () => {
    const newKey = path.join(dir, 'DEV-ONLY-b2.json');
    assert.equal(spawnSync(process.execPath, [CLI, 'keygen', '--kid', 'B2', '--out', newKey, '--dev-allow-network'], { encoding: 'utf8' }).status, 0);
    const victim = json(['issue', '--name', 'Fajar', '--email', 'fajar@example.com', '--fingerprint', mc('f0'), '--order', 'ORD-6']);
    json(['revoke', '--lid', victim.lid, '--reason', 'fraud']);
    const r = spawnSync(process.execPath, [CLI, 'reissue', '--all-active', '--kid', 'B2', '--key-file', newKey, '--dev-allow-network', '--json', '--audit', path.join(dir, 'audit.csv'), '--out-dir', path.join(dir, 'out')], { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.ok(res.count >= 3);
    assert.ok(!res.licences.some((l) => l.lid === victim.lid), 'revoked licence must not be reissued');
    assert.match(readFileSync(res.batchFile, 'utf8'), /Your updated licence key/);
  });
});
