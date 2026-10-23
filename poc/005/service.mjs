// POC-005 "Local Service" stand-in. Modes: init | execute | serve | render | start | check   (usage: node service.mjs <mode> <dir>)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb, migrate, openWithRecovery, sweepInterrupted, writeCheckpoint, keyFor, now, sha, canon, sleepSync } from './db.mjs';

const [mode, dir] = process.argv.slice(2);
fs.mkdirSync(dir, { recursive: true });
const emit = (o) => console.log(JSON.stringify(o));
const P = 'p1';
const model0 = { schemaVersion: 1, durationMs: 14000, tracks: { video: [{ id: 'c1', durationMs: 8000 }, { id: 'c2', durationMs: 6000 }], text: [] } };

if (mode === 'init') {
  const file = path.join(dir, 'expertmotion.db'); const key = keyFor(dir);
  const db = openDb(file, key); migrate(db);
  const v0 = 'v0-' + sha(canon(model0)).slice(0, 8);
  db.transaction(() => {
    db.prepare('INSERT INTO projects(id,name,settings_json,created_at,updated_at) VALUES (?,?,?,?,?)').run(P, 'Demo', '{"fps":30}', now(), now());
    db.prepare('INSERT INTO composition_versions(id,project_id,parent_id,hash,model_json,cause,duration_ms,created_at) VALUES (?,?,NULL,?,?,?,?,?)').run(v0, P, sha(canon(model0)), JSON.stringify(model0), 'insert', 14000, now());
    db.prepare('UPDATE projects SET head_version_id=? WHERE id=?').run(v0, P);
    const ops = Array.from({ length: 200 }, (_, i) => ({ op: 'op:text.add', args: { text: 'T' + i, atMs: i * 10, durationMs: 500 } }));
    db.prepare('INSERT INTO edit_plans VALUES (?,?,?,?,?,?,?,?,?)').run('plan1', P, v0, 'editor-agent', JSON.stringify({ steps: [{ n: 1, ops }] }), 'valid', null, now(), now());
  })();
  db.pragma('wal_checkpoint(TRUNCATE)'); db.close();
  fs.copyFileSync(file, file + '.bak-1');                       // pre-migration style backup copy (DATABASE_SCHEMA §5)
  emit({ ok: true, v0 });
} else if (mode === 'execute') {
  const { db } = openWithRecovery(dir);
  const plan = db.prepare("SELECT * FROM edit_plans WHERE id='plan1'").get();
  const ops = JSON.parse(plan.plan_json).steps[0].ops;
  const head = db.prepare('SELECT head_version_id h FROM projects WHERE id=?').get(P).h;
  const exec = db.transaction(() => {                           // ONE transaction: ops + version + head + plan status (AI_WORKFLOW §2 step 10)
    const model = JSON.parse(db.prepare('SELECT model_json m FROM composition_versions WHERE id=?').get(head).m);
    const vNew = 'v1-' + crypto.randomBytes(4).toString('hex');
    db.prepare('INSERT INTO composition_versions(id,project_id,parent_id,hash,model_json,cause,plan_id,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(vNew, P, head, sha(vNew), JSON.stringify({ ...model, tracks: { ...model.tracks, text: ops.map((o, i) => ({ id: 't' + i, ...o.args })) } }), 'execute', 'plan1', 14000, now());
    ops.forEach((o, i) => {
      db.prepare('INSERT INTO operations_history(project_id,version_id,plan_id,seq,op_json,applied_at) VALUES (?,?,?,?,?,?)').run(P, vNew, 'plan1', i, JSON.stringify(o), now());
      if (i === 99) { emit({ inTx: true, applied: i + 1 }); sleepSync(Number(process.env.POC_HOLD_MS ?? 30000)); }   // kill -9 target
    });
    db.prepare('UPDATE projects SET head_version_id=? WHERE id=?').run(vNew, P);
    db.prepare("UPDATE edit_plans SET status='executed', updated_at=? WHERE id='plan1'").run(now());
  });
  exec(); emit({ executed: true }); db.close();
} else if (mode === 'serve') {
  const { db } = openWithRecovery(dir);
  const head = db.prepare('SELECT head_version_id h FROM projects WHERE id=?').get(P).h;
  let model = JSON.parse(db.prepare('SELECT model_json m FROM composition_versions WHERE id=?').get(head).m);
  const INTERVAL = Number(process.env.POC_AUTOSAVE_MS ?? 10000); let dirty = false, editedAt = 0;
  emit({ ready: true });
  setTimeout(() => { model = { ...model, tracks: { ...model.tracks, text: [{ id: 'unsaved-edit', text: 'hello' }] } }; dirty = true; editedAt = Date.now(); emit({ edited: editedAt }); }, 1000);
  setInterval(() => { if (!dirty) return; const f = writeCheckpoint(db, dir, P, head, model); dirty = false; emit({ checkpoint: path.basename(f), at: Date.now(), editedAt }); }, INTERVAL);
} else if (mode === 'render') {
  const { db } = openWithRecovery(dir); const head = db.prepare('SELECT head_version_id h FROM projects WHERE id=?').get(P).h;
  const out = path.join(dir, 'outputs', 'job1.mp4.partial'); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, Buffer.alloc(1024 * 1024, 1));
  db.prepare("INSERT INTO render_jobs(id,project_id,version_id,output_profile_json,performance_profile,status,progress,output_path,created_at,started_at) VALUES ('job1',?,?,?,?,'rendering',0.4,?,?,?)").run(P, head, '{"ratio":"9:16"}', 'standard', out, now(), now());
  emit({ rendering: true, out }); setInterval(() => {}, 1000);
} else if (mode === 'start' || mode === 'check') {
  const t0 = process.hrtime.bigint();
  const r = openWithRecovery(dir); const db = r.db;
  const swept = sweepInterrupted(db);
  const out = {
    ready: true, readyMs: Number(process.hrtime.bigint() - t0) / 1e6, openedVia: r.path, cause: r.cause, swept,
    integrity: db.pragma('integrity_check', { simple: true }), fkViolations: db.pragma('foreign_key_check').length,
    head: db.prepare('SELECT head_version_id h FROM projects WHERE id=?').get(P)?.h,
    versions: db.prepare('SELECT count(*) c FROM composition_versions').get().c,
    opsHistory: db.prepare('SELECT count(*) c FROM operations_history').get().c,
    planStatus: db.prepare("SELECT status s FROM edit_plans WHERE id='plan1'").get()?.s,
    jobs: db.prepare('SELECT id,status,error_code FROM render_jobs').all(),
    partialLeft: fs.existsSync(path.join(dir, 'outputs', 'job1.mp4.partial')),
    journalMode: db.pragma('journal_mode', { simple: true }),
  };
  emit(out); db.close();
}
