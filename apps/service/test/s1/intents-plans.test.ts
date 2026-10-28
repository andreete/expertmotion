import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeProvider, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
import { EmError } from '@expertmotion/shared';
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

const fade = (base: string, extra: Record<string, unknown> = {}) => ({ source: 'ui', category: 'transition', presetId: 'preset:transition.fade', target: { kind: 'selection' }, baseVersion: base, ...extra });
const envOf = (req: ChatRequest) => JSON.parse(req.messages[0]!.content) as { baseVersion: string; lockedKeys: string[]; creatorNotes: string };
const planReply = (ops: unknown[]) => (req: ChatRequest) => JSON.stringify({ goal: 'Judul pembuka', steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: 'Teks judul ditambahkan' }], risks: [], baseVersion: envOf(req).baseVersion });
const TITLE = { op: 'op:text.add', args: { text: 'Kopi Pagi', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } };

describe('intents R-060…R-064', () => {
  let s: S1Service; let pid: string;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });
  beforeEach(async () => { pid = (await newProject(s)).id; insertClips(s, pid, ['a1', 'a2', 'a3']); s.events.length = 0; });

  it('a fully specified pick compiles and applies at once, locks its keys, events in causal order', async () => {
    const r = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid)) });
    expect(r.status).toBe(201);
    expect(r.body.intent).toMatchObject({ status: 'executed', category: 'transition', needsInterpretation: false });
    expect(r.body.appliedVersion).toMatchObject({ cause: 'compile' });
    expect(r.body.planId).toBeTruthy();
    expect(r.body.queue.lockedKeys.sort()).toEqual(['cut:0.transition', 'cut:1.transition']);
    expect(r.body.queue.headHash).toBe(r.body.appliedVersion.hash);
    const executed = (r.body.queue.items as Array<{ status: string; appliedVersion?: number }>).filter((i) => i.status === 'executed');
    expect(executed.length).toBeGreaterThan(0);
    expect(executed.every((i) => typeof i.appliedVersion === 'number' && i.appliedVersion >= 2)).toBe(true);
    const m = (await s.json(`/projects/${pid}/composition`)).body.head.model;
    expect(m.transitions.map((t: any) => t.presetId)).toEqual(['preset:transition.fade', 'preset:transition.fade']);
    const names = s.events.map((e) => e.name);
    expect(names.indexOf('intent.updated')).toBeLessThan(names.indexOf('composition.updated'));
    expect(names.indexOf('composition.updated')).toBeLessThan(names.indexOf('plan.ready'));
    const plan = await s.json(`/plans/${r.body.planId}`);
    expect(plan.body).toMatchObject({ origin: 'compile', status: 'executed' });
  });
  it('rejects stale base (409 EM-2301), unknown presets (EM-2101), bad params (400 EM-2102), no clips (EM-2202)', async () => {
    const st = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade('nope') });
    expect([st.status, st.body.error.code]).toEqual([409, 'EM-2301']);
    const h = await headHash(s, pid);
    expect((await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(h, { presetId: 'preset:transition.nope' }) })).body.error.code).toBe('EM-2101');
    const bp = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(h, { presetId: 'preset:transition.slide', params: { direction: 'diagonal' } }) });
    expect([bp.status, bp.body.error.code]).toEqual([400, 'EM-2102']);
    const empty = await newProject(s);
    const nc = await s.json(`/projects/${empty.id}/intents`, { method: 'POST', json: fade(empty.headHash) });
    expect([nc.status, nc.body.error.code]).toEqual([422, 'EM-2202']);
  });
  it('supersedes per cut and restores (the replacing intent is superseded in turn)', async () => {
    const a = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid), { selection: [{ kind: 'cut', index: 0 }] }) });
    const b = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid), { presetId: 'preset:transition.slide', selection: [{ kind: 'cut', index: 0 }] }) });
    expect(b.body.superseded).toEqual([a.body.intent.id]);
    expect((await s.json(`/projects/${pid}/composition`)).body.head.model.transitions[0].presetId).toBe('preset:transition.slide');
    const q = await s.json(`/projects/${pid}/intents?status=superseded`);
    expect(q.body.items.map((i: any) => i.id)).toEqual([a.body.intent.id]);
    const r = await s.json(`/projects/${pid}/intents/${a.body.intent.id}/restore`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body.intent).toMatchObject({ id: a.body.intent.id, status: 'executed' });
    expect(r.body.intent.restoredAt).toBeTruthy();
    expect(r.body.superseded).toContain(b.body.intent.id);
    expect((await s.json(`/projects/${pid}/composition`)).body.head.model.transitions[0].presetId).toBe('preset:transition.fade');
    expect((await s.json(`/projects/${pid}/intents/${b.body.intent.id}/restore`, { method: 'POST' })).status).toBe(200);
    expect((await s.json(`/projects/${pid}/intents/01JAZK0000000000000000000Z/restore`, { method: 'POST' })).body.error.code).toBe('EM-9003');
  });
  it('remove: executed picks stay (422 EM-9002), queued ones go; clear empties the queue', async () => {
    const ex = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid)) });
    const del = await s.json(`/projects/${pid}/intents/${ex.body.intent.id}`, { method: 'DELETE' });
    expect([del.status, del.body.error.code, del.body.error.details.reason]).toEqual([422, 'EM-9002', 'executed']);
    const h = await headHash(s, pid);
    const q1 = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(h, { presetId: 'preset:transition.slide', selection: [{ kind: 'cut', index: 1 }], plan: 'none' }) });
    expect(q1.body).toMatchObject({ intent: { status: 'queued' }, appliedVersion: null });
    expect(await headHash(s, pid)).toBe(h);
    const rm = await s.json(`/projects/${pid}/intents/${q1.body.intent.id}`, { method: 'DELETE' });
    expect(rm.body.items.some((i: any) => i.id === q1.body.intent.id)).toBe(false);
    expect(s.events.some((e) => e.name === 'intent.updated' && e.data['reason'] === 'removed')).toBe(true);
    await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(h, { selection: [{ kind: 'cut', index: 1 }], plan: 'none' }) });
    const cl = await s.json(`/projects/${pid}/intents`, { method: 'DELETE' });
    expect(cl.body.items.filter((i: any) => i.status === 'queued')).toEqual([]);
    expect(cl.body.items.some((i: any) => i.status === 'executed')).toBe(true);
  });
});

describe('plans R-070…R-075', () => {
  let s: S1Service; let pid: string;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });
  beforeEach(async () => { pid = (await newProject(s)).id; insertClips(s, pid, ['a1', 'a2', 'a3']); s.events.length = 0; s.ctx.settings.update({ privateMode: false }); });
  const queuePick = async (extra: Record<string, unknown>) => (await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid), { plan: 'none', ...extra }) })).body;

  it('compile plan (201, valid) → Execute (one version, intents executed) → idempotent repeat EM-2308', async () => {
    const i1 = await queuePick({ selection: [{ kind: 'cut', index: 0 }] });
    const i2 = await queuePick({ presetId: 'preset:transition.slide', selection: [{ kind: 'cut', index: 1 }] });
    const h = await headHash(s, pid);
    const p = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: h } });
    expect(p.status).toBe(201);
    expect(p.body).toMatchObject({ origin: 'compile', status: 'valid', baseVersion: h });
    expect(p.body.intentIds.sort()).toEqual([i1.intent.id, i2.intent.id].sort());
    const ex = await s.json(`/plans/${p.body.id}/execute`, { method: 'POST', json: {}, headers: { 'Idempotency-Key': 'k-1' } });
    expect(ex.status).toBe(200);
    expect(ex.body).toMatchObject({ ok: true, fromVersion: h, appliedOps: 2 });
    expect(ex.body.toVersion).toBe(await headHash(s, pid));
    const versions = (await s.json(`/projects/${pid}/composition/versions?limit=1`)).body.items;
    expect(versions[0]).toMatchObject({ cause: 'compile', planId: p.body.id });
    const q = await s.json(`/projects/${pid}/intents`);
    expect(q.body.items.filter((i: any) => [i1.intent.id, i2.intent.id].includes(i.id)).map((i: any) => i.status)).toEqual(['executed', 'executed']);
    const again = await s.json(`/plans/${p.body.id}/execute`, { method: 'POST', json: {} });
    expect(again.body).toMatchObject({ ok: true, notice: 'EM-2308', toVersion: ex.body.toVersion });
    const list = await s.json(`/projects/${pid}/plans`);
    expect(list.body.items[0].steps[0].ops).toEqual([]);
    expect((await s.json(`/plans/${p.body.id}`)).body.steps[0].ops).toHaveLength(2);
    // FR-167: after Undo the executed items show "undone"; Redo brings them back.
    const mine = (b: any) => b.items.filter((i: any) => [i1.intent.id, i2.intent.id].includes(i.id));
    expect(mine(q.body).every((i: any) => i.undone === undefined)).toBe(true);
    await s.json(`/projects/${pid}/composition/undo`, { method: 'POST' });
    expect(mine((await s.json(`/projects/${pid}/intents`)).body).map((i: any) => [i.status, i.undone])).toEqual([['executed', true], ['executed', true]]);
    await s.json(`/projects/${pid}/composition/redo`, { method: 'POST' });
    expect(mine((await s.json(`/projects/${pid}/intents`)).body).every((i: any) => i.undone === undefined)).toBe(true);
  });
  it('a plan goes stale when the head moves; Execute then answers 409 EM-2301 and applies nothing', async () => {
    await queuePick({ selection: [{ kind: 'cut', index: 0 }] });
    const p = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid) } });
    await s.json(`/projects/${pid}/composition/undo`, { method: 'POST' });
    expect(s.events.some((e) => e.name === 'plan.invalid' && e.data['planId'] === p.body.id && e.data['code'] === 'EM-2301')).toBe(true);
    const g = await s.json(`/plans/${p.body.id}`);
    expect(g.body).toMatchObject({ status: 'stale', stale: true });
    const h = await headHash(s, pid);
    const ex = await s.json(`/plans/${p.body.id}/execute`, { method: 'POST', json: {} });
    expect([ex.status, ex.body.error.code]).toEqual([409, 'EM-2301']);
    expect(await headHash(s, pid)).toBe(h);
    expect((await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: 'x' } })).body.error.code).toBe('EM-2301');
  });
  it('Execute failure rolls back (ExecutionResult ok:false EM-2307) and leaves head and intents unchanged', async () => {
    const i = await queuePick({ selection: [{ kind: 'cut', index: 0 }] });
    const h = await headHash(s, pid);
    const p = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: h } });
    s.ctx.db.exec("CREATE TRIGGER t_fail BEFORE INSERT ON operations_history BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
    try {
      const ex = await s.json(`/plans/${p.body.id}/execute`, { method: 'POST', json: {} });
      expect(ex.status).toBe(200);
      expect(ex.body).toMatchObject({ ok: false, error: { code: 'EM-2307' }, rollback: { performed: true, toVersion: h }, appliedOps: 0 });
    } finally { s.ctx.db.exec('DROP TRIGGER t_fail'); }
    expect(await headHash(s, pid)).toBe(h);
    expect((await s.json(`/projects/${pid}/composition/versions?limit=200`)).body.items.some((v: any) => v.planId === p.body.id)).toBe(false);
    expect((await s.json(`/projects/${pid}/intents`)).body.items.find((x: any) => x.id === i.intent.id).status).toBe('queued');
    expect((await s.json(`/plans/${p.body.id}`)).body.status).toBe('failed');
    const retry = await s.json(`/plans/${p.body.id}/execute`, { method: 'POST', json: {} });
    expect(retry.body.ok).toBe(true);
  });
  it('Editor Agent path: 202 + runId, plan.ready, usage recorded, Execute applies the agent ops', async () => {
    const prov = fakeProvider([planReply([TITLE])]);
    const usage: unknown[] = [];
    s.ctx.hooks.providerFor = () => prov;
    s.ctx.hooks.recordUsage = (_p, agent, runId, u) => { usage.push({ agent, runId, n: u.length }); };
    const h = await headHash(s, pid);
    const r = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: h, message: 'buat judul pembuka yang kuat' } });
    expect(r.status).toBe(202);
    expect(r.body.plan).toMatchObject({ status: 'draft', origin: 'editor-agent', agentRunId: r.body.runId });
    await s.waitFor((e) => e.name === 'plan.ready' && (e.data['plan'] as any).id === r.body.plan.id);
    expect(s.events.some((e) => e.name === 'agent.run.started')).toBe(true);
    expect(s.events.some((e) => e.name === 'agent.run.done')).toBe(true);
    expect(usage).toEqual([{ agent: 'editor', runId: r.body.runId, n: 1 }]);
    const plan = (await s.json(`/plans/${r.body.plan.id}`)).body;
    expect(plan).toMatchObject({ status: 'valid', goal: 'Judul pembuka', usage: { model: 'fake/model' } });
    expect((s.ctx.db.prepare('SELECT status FROM agent_runs WHERE id = ?').get(r.body.runId) as any).status).toBe('done');
    const ex = await s.json(`/plans/${plan.id}/execute`, { method: 'POST', json: {} });
    expect(ex.body).toMatchObject({ ok: true, appliedOps: 1 });
    expect((await s.json(`/projects/${pid}/composition`)).body.head.model.tracks.text[0].text).toBe('Kopi Pagi');
    expect((await s.json(`/projects/${pid}/composition/versions?limit=1`)).body.items[0].cause).toBe('execute');
  });
  it('interpretive pick with autoPlan starts a plan run; Locked Keys are sent and violating ops are dropped', async () => {
    await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid), { selection: [{ kind: 'cut', index: 0 }] }) });
    const touch = { op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.slide', durationMs: 500 } };
    const prov = fakeProvider([planReply([touch, TITLE])]);
    s.ctx.hooks.providerFor = () => prov;
    const r = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: { source: 'chat', category: 'text', target: { kind: 'project' }, instruction: 'tambahkan judul', baseVersion: await headHash(s, pid) } });
    expect(r.status).toBe(201);
    expect(r.body.intent).toMatchObject({ status: 'queued', needsInterpretation: true });
    expect(r.body.planId).toBeTruthy();
    await s.waitFor((e) => e.name === 'plan.ready' && (e.data['plan'] as any).id === r.body.planId);
    expect(envOf(prov.calls[0]!).lockedKeys).toEqual(['cut:0.transition']);
    expect(prov.calls).toHaveLength(2);                                   // one re-prompt, then the locked op is dropped
    const plan = (await s.json(`/plans/${r.body.planId}`)).body;
    expect(plan.steps.flatMap((st: any) => st.ops).map((o: any) => o.op)).toEqual(['op:text.add']);
    expect(plan.risks.some((x: any) => x.code === 'locked-key')).toBe(true);
    const ex = await s.json(`/plans/${plan.id}/execute`, { method: 'POST', json: {} });
    expect(ex.body.ok).toBe(true);
    expect((await s.json(`/projects/${pid}/intents`)).body.items.find((i: any) => i.id === r.body.intent.id).status).toBe('executed');
    expect((await s.json(`/projects/${pid}/composition`)).body.head.model.transitions[0].presetId).toBe('preset:transition.fade');
  });
  it('destructive ops need confirmDestructive; notes are forwarded as creatorNotes next time', async () => {
    const clipId = (await s.json(`/projects/${pid}/composition`)).body.head.model.tracks.video[2].id;
    const prov = fakeProvider([planReply([{ op: 'op:clip.remove', target: { kind: 'clip', id: clipId }, args: {} }]), planReply([TITLE])]);
    s.ctx.hooks.providerFor = () => prov;
    const r = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'hapus klip terakhir' } });
    await s.waitFor((e) => e.name === 'plan.ready' && (e.data['plan'] as any).id === r.body.plan.id);
    const n = await s.json(`/plans/${r.body.plan.id}/notes`, { method: 'PATCH', json: { notes: 'jangan terlalu ramai' } });
    expect(n.body.notes).toBe('jangan terlalu ramai');
    const no = await s.json(`/plans/${r.body.plan.id}/execute`, { method: 'POST', json: {} });
    expect([no.status, no.body.error.code, no.body.error.details.destructive]).toEqual([409, 'EM-4310', ['op:clip.remove']]);
    const yes = await s.json(`/plans/${r.body.plan.id}/execute`, { method: 'POST', json: { confirmDestructive: true } });
    expect(yes.body.ok).toBe(true);
    const r2 = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'judul' } });
    await s.waitFor((e) => e.name === 'plan.ready' && (e.data['plan'] as any).id === r2.body.plan.id);
    expect(envOf(prov.calls[1]!).creatorNotes).toBe('jangan terlalu ramai');
  });
  it('Private Mode blocks the agent path (423 EM-4401) but compile still works; missing provider is EM-4001', async () => {
    s.ctx.settings.update({ privateMode: true });
    const r = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'judul' } });
    expect([r.status, r.body.error.code]).toEqual([423, 'EM-4401']);
    await queuePick({ selection: [{ kind: 'cut', index: 0 }] });
    expect((await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid) } })).status).toBe(201);
    s.ctx.settings.update({ privateMode: false });
    s.ctx.hooks.providerFor = () => { throw new EmError('EM-4001', 'No provider.'); };
    expect((await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'x' } })).body.error.code).toBe('EM-4001');
    expect((await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), mode: 'compile-only', message: 'x' } })).body.error.code).toBe('EM-2303');
  });
  it('cancel aborts a running plan (EM-4303); a second run meanwhile is 409 EM-4305', async () => {
    const hanging: ChatProvider = { id: 'hang', model: 'hang/model', complete: (req) => new Promise((_res, rej) => { req.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); }) };
    s.ctx.hooks.providerFor = () => hanging;
    const r = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'judul' } });
    expect(r.status).toBe(202);
    const second = await s.json(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: await headHash(s, pid), message: 'lagi' } });
    expect([second.status, second.body.error.code]).toEqual([409, 'EM-4305']);
    const c = await s.json(`/plans/${r.body.plan.id}/cancel`, { method: 'POST' });
    expect(c.body.status).toBe('cancelled');
    await s.waitFor((e) => e.name === 'agent.run.failed' && e.data['code'] === 'EM-4303');
    expect((s.ctx.db.prepare('SELECT status, error_code FROM agent_runs WHERE id = ?').get(r.body.runId) as any)).toEqual({ status: 'cancelled', error_code: 'EM-4303' });
    expect((await s.json(`/plans/${r.body.plan.id}/execute`, { method: 'POST', json: {} })).body.error.code).toBe('EM-2303');
  });
  it('hooks.createPlan runs to completion and returns the validated plan', async () => {
    s.ctx.hooks.providerFor = () => fakeProvider([planReply([TITLE])]);
    const plan = await s.ctx.hooks.createPlan(pid, { instruction: 'judul pembuka' });
    expect(plan).toMatchObject({ status: 'valid', origin: 'editor-agent' });
    expect(plan.planId).toBe(plan.id);
    const bad = fakeProvider(['tidak bisa', 'masih tidak', 'maaf']);
    s.ctx.hooks.providerFor = () => bad;
    const failed = await s.ctx.hooks.createPlan(pid, { instruction: 'x' });
    expect(failed.status).toBe('invalid');
    expect(failed.validation[0]!.code).toBe('EM-4301');
  });
});
