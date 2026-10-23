// POC-005 (Linux part: steps 1, 2, 5 + DB side of 3) — kill -9 scenarios, 3 consecutive runs. Exit 0 = all pass.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3-multiple-ciphers';

const RUNS = Number(process.env.POC_RUNS ?? 3);
const results = [];
const rec = (run, name, ok, detail = '') => { results.push({ run, name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  run${run}  ${name}${detail ? '  — ' + detail : ''}`); };
const svc = (mode, dir, env = {}) => spawn(process.execPath, ['service.mjs', mode, dir], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const lines = (child) => { const q = []; let buf = '', err = ''; const waiters = [];
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); q.push(o); waiters.splice(0).forEach((w) => w()); } catch {} } });
  child.stderr.on('data', (d) => { err += d; });
  return { next: (pred, ms = 40000) => new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout waiting for line; stderr=' + err)), ms); const look = () => { const i = q.findIndex(pred); if (i >= 0) { clearTimeout(t); res(q.splice(i, 1)[0]); } else waiters.push(look); }; look(); }), err: () => err }; };
const run1 = (mode, dir, env) => { const r = spawnSync(process.execPath, ['service.mjs', mode, dir], { env: { ...process.env, ...env }, encoding: 'utf8' }); const l = r.stdout.trim().split('\n').pop(); try { return { ...JSON.parse(l), stderr: r.stderr }; } catch { return { error: r.stdout + r.stderr }; } };
const killed = (child) => new Promise((res) => { child.once('exit', (c, s) => res(s)); child.kill('SIGKILL'); });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'poc005-'));

for (let run = 1; run <= RUNS; run++) {
  // ── Step 1: kill -9 in the middle of Execute (transaction with 100/200 ops written)
  { const dir = tmp(); const init = run1('init', dir); const c = svc('execute', dir); const L = lines(c);
    await L.next((o) => o.inTx); const sig = await killed(c);
    const s = run1('check', dir);
    rec(run, 'Execute killed (SIGKILL) mid-transaction', sig === 'SIGKILL');
    rec(run, 'head version unchanged = base version', s.head === init.v0, `head=${s.head}`);
    rec(run, 'no half-applied version, no operation rows', s.versions === 1 && s.opsHistory === 0, `versions=${s.versions} ops=${s.opsHistory}`);
    rec(run, "plan status still 'valid'", s.planStatus === 'valid', s.planStatus);
    rec(run, 'integrity_check ok, no FK violations', s.integrity === 'ok' && s.fkViolations === 0);
    rec(run, 'restart-to-ready ≤ 5 s', s.readyMs <= 5000, `${s.readyMs.toFixed(0)} ms`);
    rec(run, 'no "database is locked" on restart', !/locked/i.test(s.stderr ?? '') && !s.error);
    // And the same plan can then be executed completely (retry is safe)
    const ok = run1('execute', dir, { POC_HOLD_MS: '1' }); const s2 = run1('check', dir);
    rec(run, 'retry after crash applies the plan completely', ok.executed === true && s2.versions === 2 && s2.opsHistory === 200 && s2.planStatus === 'executed', `versions=${s2.versions} ops=${s2.opsHistory}`);
    fs.rmSync(dir, { recursive: true, force: true }); }

  // ── Step 2: autosave ≤ 10 s, kill -9, recovery from checkpoint
  { const dir = tmp(); const init = run1('init', dir); const c = svc('serve', dir); const L = lines(c);
    await L.next((o) => o.ready); const edited = await L.next((o) => o.edited);
    await new Promise((r) => setTimeout(r, 12000)); const killAt = Date.now(); await killed(c);
    const ck = path.join(dir, 'checkpoints'); const files = fs.existsSync(ck) ? fs.readdirSync(ck).filter((f) => f.endsWith('.json')) : [];
    const latest = files.sort().pop(); const data = latest ? JSON.parse(fs.readFileSync(path.join(ck, latest), 'utf8')) : null;
    rec(run, 'a checkpoint file exists after 12 s of dirty state', !!data);
    rec(run, 'checkpoint contains the unsaved edit', JSON.stringify(data?.model).includes('unsaved-edit'));
    const ageMs = data ? killAt - new Date(data.at).getTime() : Infinity;
    rec(run, 'checkpoint age at kill ≤ 10 s (PRD-003)', ageMs <= 10000, `${ageMs} ms`);
    rec(run, 'no .tmp checkpoint left behind (atomic rename)', !fs.readdirSync(ck).some((f) => f.endsWith('.tmp')));
    const s = run1('check', dir);
    rec(run, 'reopen after kill: integrity ok, recovery_checkpoints row present', s.integrity === 'ok');
    const dbq = new Database(path.join(dir, 'expertmotion.db')); dbq.pragma("cipher='chacha20'"); dbq.pragma(`key="x'${fs.readFileSync(path.join(dir, 'key.hex'), 'utf8').trim()}'"`);
    rec(run, 'recovery_checkpoints table has the row', dbq.prepare('SELECT count(*) c FROM recovery_checkpoints').get().c >= 1); dbq.close();
    fs.rmSync(dir, { recursive: true, force: true }); }

  // ── Step 3 (DB side): kill during render → job failed EM-3203, partial deleted
  { const dir = tmp(); run1('init', dir); const c = svc('render', dir); const L = lines(c); const r = await L.next((o) => o.rendering); await killed(c);
    rec(run, 'partial output exists before restart', fs.existsSync(r.out));
    const s = run1('start', dir);
    rec(run, "interrupted render marked 'failed' with EM-3203", s.jobs?.[0]?.status === 'failed' && s.jobs[0].error_code === 'EM-3203' && s.swept === 1, JSON.stringify(s.jobs));
    rec(run, 'partial output deleted on startup sweep', s.partialLeft === false);
    fs.rmSync(dir, { recursive: true, force: true }); }

  // ── Step 5: corrupted database header → .bak fallback; both corrupted → checkpoint import
  { const dir = tmp(); const init = run1('init', dir); const file = path.join(dir, 'expertmotion.db');
    const zero = (f) => { const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.alloc(200, 0), 0, 200, 0); fs.closeSync(fd); };
    zero(file); const s = run1('check', dir);
    rec(run, 'corrupt main DB → opens via .bak copy', s.openedVia === 'bak' && s.integrity === 'ok' && s.head === init.v0, `via=${s.openedVia} cause=${s.cause}`);
    rec(run, 'corrupt file kept for diagnostics (.corrupt)', fs.existsSync(file + '.corrupt'));
    // produce a checkpoint, then corrupt both DB and .bak
    const c = svc('serve', dir, { POC_AUTOSAVE_MS: '1500' }); const L = lines(c); await L.next((o) => o.ready); await L.next((o) => o.checkpoint); await killed(c);
    zero(file); zero(file + '.bak-1'); const s2 = run1('check', dir);
    rec(run, 'main and .bak corrupt → fresh DB + newest checkpoint imported', s2.openedVia === 'checkpoint-import' && s2.integrity === 'ok' && s2.versions === 1, `via=${s2.openedVia} head=${s2.head}`);
    fs.rmSync(dir, { recursive: true, force: true }); }

  // ── Encryption sanity (POC-003 Linux half, cheap to include): wrong key / no key / stock sqlite3
  { const dir = tmp(); run1('init', dir); const file = path.join(dir, 'expertmotion.db');
    let noKey = 'opened'; try { const d = new Database(file); d.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (e) { noKey = e.code ?? e.message; }
    let wrong = 'opened'; try { const d = new Database(file); d.pragma("cipher='chacha20'"); d.pragma(`key="x'${'ab'.repeat(32)}'"`); d.prepare('SELECT count(*) FROM sqlite_master').get(); } catch (e) { wrong = e.code ?? e.message; }
    const raw = fs.readFileSync(file).subarray(0, 16).toString('latin1');
    rec(run, 'open without key fails (SQLITE_NOTADB)', /NOTADB/.test(noKey), noKey);
    rec(run, 'open with wrong key fails (SQLITE_NOTADB)', /NOTADB/.test(wrong), wrong);
    rec(run, 'file does not start with the plaintext SQLite header', raw !== 'SQLite format 3\0');
    const sq = spawnSync('sqlite3', [file, 'select 1'], { encoding: 'utf8' });
    if (sq.error) console.log('INFO  sqlite3 CLI not installed here; stock-sqlite3 check covered by the no-key open above');
    else rec(run, 'stock sqlite3 CLI cannot read the file', /not a database/i.test(sq.stderr), sq.stderr.trim());
    fs.rmSync(dir, { recursive: true, force: true }); }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed over ${RUNS} runs`);
process.exit(failed.length ? 1 : 0);
