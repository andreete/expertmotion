import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeProvider, type ChatRequest, type EditIntentT } from '@expertmotion/agents';
import { tempDir } from '../helpers.js';
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

const planReply = (req: ChatRequest) => JSON.stringify({ goal: 'Judul', steps: [{ n: 1, tool: 'composition.applyOps', ops: [{ op: 'op:text.add', args: { text: 'Halo', variant: 'preset:text.title', atMs: 0, durationMs: 2000 } }], expectedDiff: 'judul' }], risks: [], baseVersion: (JSON.parse(req.messages[0]!.content) as { baseVersion: string }).baseVersion });
const brainstorm = (id: string, over: Partial<EditIntentT>): EditIntentT => ({ id, projectId: 'x', source: 'brainstorm', createdAt: new Date().toISOString(), category: 'text', params: {}, target: { kind: 'project' },
  resolvedTargets: [], propertyKey: `instruction:${id}`, propertyClass: 'list', needsInterpretation: true, instruction: 'judul energik', status: 'queued', supersedes: [], baseVersion: 'old', ...over });

describe('hooks for S3: enqueueIntents, createPlan with runId/intentIds, baseVersion as version id', () => {
  let s: S1Service; let pid: string;
  beforeAll(async () => { s = await startS1(); pid = (await newProject(s)).id; insertClips(s, pid, ['a1', 'a2']); });
  afterAll(async () => { await s.close(); });

  it('enqueueIntents queues brainstorm intents, never over a Locked Key, and emits intent.updated', async () => {
    await s.json(`/projects/${pid}/intents`, { method: 'POST', json: { source: 'ui', category: 'transition', presetId: 'preset:transition.fade', baseVersion: await headHash(s, pid) } });
    const a = s.ctx.newId(), b = s.ctx.newId();
    const { queue } = s.ctx.hooks.enqueueIntents!(pid, [brainstorm(a, {}), brainstorm(b, { category: 'transition', presetId: 'preset:transition.slide', propertyKey: 'cut:0.transition', propertyClass: 'exclusive-group', needsInterpretation: false })]);
    expect(queue.find((i) => i.id === a)).toMatchObject({ status: 'queued', projectId: pid, baseVersion: await headHash(s, pid) });
    expect(queue.find((i) => i.id === b)?.status).toBe('rejected');
    const q = (await s.json(`/projects/${pid}/intents`)).body;
    expect(q.lockedKeys).toContain('cut:0.transition');
    expect(q.items.filter((i: any) => i.propertyKey === 'cut:0.transition' && i.status === 'executed')).toHaveLength(1);
    expect(s.events.some((e) => e.name === 'intent.updated' && (e.data['changed'] as string[]).includes(a))).toBe(true);
  });
  it('createPlan with a caller-owned runId links plan_id and emits no run events of its own; intentIds limit the plan', async () => {
    const prov = fakeProvider([planReply]);
    s.ctx.hooks.providerFor = () => prov;
    const queued = (await s.json(`/projects/${pid}/intents?status=queued`)).body.items.map((i: any) => i.id);
    s.ctx.db.prepare("INSERT INTO agent_runs (id, project_id, agent, model_id, status, started_at) VALUES ('S3RUN', ?, 'editor', 'fake/model', 'running', 'now')").run(pid);
    s.events.length = 0;
    const plan = await s.ctx.hooks.createPlan(pid, { runId: 'S3RUN', intentIds: queued });
    expect(plan).toMatchObject({ status: 'valid', runId: 'S3RUN' });
    expect((await s.json(`/plans/${plan.planId}`)).body.intentIds).toEqual(queued);
    expect(s.ctx.db.prepare("SELECT status, plan_id FROM agent_runs WHERE id = 'S3RUN'").get()).toEqual({ status: 'running', plan_id: plan.planId });
    expect(s.events.filter((e) => e.name.startsWith('agent.run.'))).toEqual([]);
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM agent_runs WHERE project_id = ?').get(pid) as { n: number }).n).toBe(1);
  });
  it('accepts the head version id as baseVersion', async () => {
    const vid = (await s.json(`/projects/${pid}`)).body.headVersionId;
    const r = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: { source: 'ui', category: 'transition', presetId: 'preset:transition.slide', selection: [{ kind: 'cut', index: 0 }], baseVersion: vid } });
    expect(r.status).toBe(201);
    expect((await s.json(`/projects/${pid}/composition/validate`, { method: 'POST', json: { baseVersion: (await s.json(`/projects/${pid}`)).body.headVersionId, ops: [] } })).body.ok).toBe(true);
  });
});

describe('pending brainstorm_handoffs are drained on start', () => {
  it('enqueues pending rows and marks them enqueued', async () => {
    const key = crypto.randomBytes(32).toString('hex'), dataDir = tempDir('em-s1-handoff-');
    let s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    const pid = (await newProject(s)).id; const iid = s.ctx.newId();
    s.ctx.db.prepare("INSERT INTO conversations (id, project_id, agent, created_at, updated_at) VALUES ('C1', ?, 'brainstorm', 't', 't')").run(pid);
    s.ctx.db.prepare("INSERT INTO messages (id, conversation_id, role, blocks_json, created_at) VALUES ('M1', 'C1', 'assistant', '[]', 't')").run();
    s.ctx.db.prepare("INSERT INTO brainstorm_handoffs (id, project_id, message_id, intents_json, status, created_at) VALUES ('H1', ?, 'M1', ?, 'pending', 't')").run(pid, JSON.stringify([brainstorm(iid, {})]));
    await s.close();
    s = await startS1({ dataDir, cfg: { dbKeyHex: key } });
    try {
      expect(s.ctx.db.prepare("SELECT status FROM brainstorm_handoffs WHERE id = 'H1'").get()).toEqual({ status: 'enqueued' });
      expect((await s.json(`/projects/${pid}/intents`)).body.items.map((i: any) => i.id)).toContain(iid);
    } finally { await s.close(); }
  });
});
