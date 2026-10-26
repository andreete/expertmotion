// QA 2026-10-26 with the real S1 + S3 modules: a project with ZERO assets gets a faceless video from a prompt (GS-23, ADR-030):
// no EM-2202 gate, run phases (FR-190), one diagnostic log line per run without user text, Execute starts the generator steps;
// pointing chips arrive as `targets` (FR-189); a failed run is an error with its reason; new keys are trimmed and flagged (FR-191).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashModel, validate, deriveTiming, type AssetFacts } from '@expertmotion/composition-model';
import { fakeProvider, type ChatProvider, type ChatRequest } from '@expertmotion/agents';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule } from '../../src/modules/agents.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { intentsModule } from '../../src/modules/intents.js';
import { normalizeKey } from '../../src/s3/keys.js';
import { body, fakeEgress, json, waitFor } from './s3-helpers.js';

const GS23 = fs.readFileSync(path.resolve(__dirname, '../../../../packages/agents/test/golden/fixtures/gs-23-editor-reply.json'), 'utf8');
const envOf = (req: ChatRequest) => JSON.parse(req.messages[0]!.content) as Record<string, any>;
type Ev = { name: string; data: Record<string, any> };
type Run = { id: string; status: string; errorCode: string | null; planId: string | null };
const SECRET_TEXT = 'Buat video faceless 30 detik tentang tips hemat listrik';

describe('faceless video from a prompt, pointing, failures (QA 2026-10-26)', () => {
  let s: TestService; let pid = ''; const events: Ev[] = []; const logs: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  let assets: AssetFacts[] = [];
  let provider: ChatProvider = fakeProvider(['```json\n' + GS23 + '\n```']);
  const stepCalls: unknown[] = [];
  const head = () => hashModel(s.ctx.hooks.composition(pid).model);
  const send = (text: string, extra: Record<string, unknown> = {}) => s.api(`/projects/${pid}/conversations/editor/messages`, { method: 'POST', json: { text, baseVersion: head(), ...extra } });
  const finished = async (runId: string) => { await waitFor(async () => (await body<Run>(await s.api(`/agent-runs/${runId}`))).status !== 'running', 5000); return body<Run>(await s.api(`/agent-runs/${runId}`)); };
  beforeAll(async () => {
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, intentsModule, agentsModule] });
    s.ctx.hooks.assetFacts = () => assets;
    s.ctx.hooks.providerFor = () => provider;
    s.ctx.hooks.planToolModels = async () => ({ tts: { installed: true, modelKey: 'piper-id', label: 'Suara Indonesia' }, stt: null });
    s.ctx.hooks.runPlanSteps = (_p, _plan, steps) => { stepCalls.push(steps); return steps.map((x) => ({ n: x.n, tool: x.tool, status: 'started' as const })); };
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, any> }); return emit(name, data); };
    for (const level of ['info', 'warn'] as const) { const orig = s.ctx.log[level].bind(s.ctx.log); (s.ctx.log as any)[level] = (obj: any, msg?: string) => { if (typeof obj === 'object') logs.push({ obj, msg: String(msg) }); return orig(obj, msg); }; }
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Hemat Listrik' } }))).id;
    const now = new Date().toISOString();
    s.ctx.db.prepare("INSERT INTO provider_connections (id, provider, label, secret_enc, secret_hint, status, created_at, updated_at) VALUES ('C1','anthropic','Claude',x'00','abcd','valid',?,?)").run(now, now);
    s.ctx.db.prepare("INSERT INTO model_assignments (agent, connection_id, model_id, settings_json, updated_at) VALUES ('editor','C1','claude-haiku-4-5','{}',?)").run(now);
  });
  afterAll(async () => { await s.close(); });

  it('empty project, no assets: the Editor plans scene clips (no EM-2202); phases are streamed; the log line has codes but no user text', async () => {
    expect(s.ctx.hooks.composition(pid).model.tracks.video).toHaveLength(0);
    const r = await send(SECRET_TEXT);
    expect(r.status).toBe(202);
    const run = await finished((await body<{ runId: string }>(r)).runId);
    expect(run).toMatchObject({ status: 'done', errorCode: null });
    const plan = await body<Record<string, any>>(await s.api(`/plans/${run.planId}`));
    expect(plan.status).toBe('valid');
    expect(plan.steps.map((x: any) => x.tool)).toEqual(['composition.applyOps', 'tts.generate', 'captions.generate']);
    const phases = events.filter((e) => e.name === 'agent.run.progress' && e.data['runId'] === run.id).map((e) => e.data['phase']);
    expect(phases).toEqual(expect.arrayContaining(['reading', 'planning', 'checking']));
    const line = logs.find((l) => l.msg === 'agent run' && l.obj['planId'] === run.planId && l.obj['agent'] === 'editor' && 'ops' in l.obj)!;
    expect(line.obj).toMatchObject({ mode: 'edit', provider: 'fake', model: 'fake/model', status: 'valid', steps: 3, ops: 7, attempts: 1 });
    expect(typeof line.obj['durationMs']).toBe('number');
    expect(JSON.stringify(logs.map((l) => l.obj))).not.toContain('hemat listrik');
    // Execute: one Composition Version with the scenes; the generator steps are handed to the generators module.
    const ex = await s.api(`/plans/${run.planId}/execute`, { method: 'POST', json: { confirmDestructive: false } });
    const res = await body<Record<string, any>>(ex);
    expect(res).toMatchObject({ ok: true, appliedOps: 7 });
    expect(res['toolSteps'].map((x: any) => [x.n, x.tool, x.status])).toEqual([[2, 'tts.generate', 'started'], [3, 'captions.generate', 'started']]);
    expect(stepCalls).toHaveLength(1);
    const m = s.ctx.hooks.composition(pid).model;
    expect(m.tracks.video.length).toBe(5);
    expect(m.transitions.length).toBe(4);
    expect(deriveTiming(m).durationMs).toBeGreaterThan(20_000);
    expect(validate(m, { assets: [], tier: 'T1' }).filter((i) => i.severity === 'block')).toEqual([]);
  });

  it('a Library asset pointed at with a chip goes into the envelope as a target with facts, and the sent message keeps the chips', async () => {
    assets = [{ id: 'A1', kind: 'audio', status: 'ready', durationMs: 14_000, name: 'Reels 14.m4a' }];
    let seen: Record<string, any> | null = null;
    provider = fakeProvider([(req) => { seen = envOf(req); return JSON.stringify({ goal: 'Menambah suara', steps: [{ ops: [{ op: 'audio.addLayer', args: { asset: 'A1', startMs: 0 } }] }] }); }]);
    const r = await send('pakai ini sebagai narasi', { targets: [{ kind: 'asset', id: 'A1', label: 'Reels 14.m4a' }] });
    const run = await finished((await body<{ runId: string }>(r)).runId);
    expect(run.status).toBe('done');
    expect(seen!['targets']).toEqual([expect.objectContaining({ kind: 'asset', id: 'A1', label: 'Reels 14.m4a', facts: expect.objectContaining({ assetKind: 'audio', onTimeline: [] }) })]);
    const plan = await body<Record<string, any>>(await s.api(`/plans/${run.planId}`));
    expect(plan.status).toBe('valid');
    expect(plan.steps[0].ops[0]).toMatchObject({ op: 'op:audio.addLayer', args: { assetId: 'A1', atMs: 0, volume: 1 } });   // repaired, not refused
    const th = await body<{ messages: { items: Array<{ role: string; blocks: Array<Record<string, any>> }> } }>(await s.api(`/projects/${pid}/conversations/editor`));
    const user = th.messages.items.filter((x) => x.role === 'user').at(-1)!;
    expect(user.blocks.find((b) => b['type'] === 'targets')).toEqual({ type: 'targets', items: [{ kind: 'asset', id: 'A1', label: 'Reels 14.m4a' }] });
  });

  it('a provider 401 on a key added minutes ago fails the run with the reason, recentKey and a retry hint; the log keeps status and reason', async () => {
    provider = fakeProvider([Object.assign(new Error('provider HTTP 401: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'), { statusCode: 401 })]);
    const r = await send('ubah judul');
    const run = await finished((await body<{ runId: string }>(r)).runId);
    expect(run).toMatchObject({ status: 'failed', errorCode: 'EM-4002' });
    const ev = events.filter((e) => e.name === 'agent.run.failed' && e.data['runId'] === run.id).at(-1)!;
    expect(ev.data).toMatchObject({ code: 'EM-4002', retryable: true, details: { recentKey: true } });
    expect(String(ev.data['message'])).toContain('1–2 minutes');
    const line = logs.find((l) => l.msg === 'agent run failed' && l.obj['runId'] === run.id && l.obj['providerStatus'] === 401)!;
    expect(line.obj).toMatchObject({ code: 'EM-4002', providerReason: 'invalid x-api-key' });
  });
});

describe('FR-191 pasted keys', () => {
  it('normalizeKey removes spaces, line breaks and zero-width characters anywhere', () => {
    expect(normalizeKey(' sk-ant-api03-abc\r\n def​﻿ ghi\t ')).toBe('sk-ant-api03-abcdefghi');
  });
  it('the dry run and Add send the cleaned key; EM-4002 on a just-pasted key says it may need a minute and carries the provider reason', async () => {
    const s = await startService({ modules: [health, settingsModule, providersModule, usageModule] });
    try {
      const GOOD = `sk-or-v1-${'a1b2c3d4'.repeat(5)}WXYZ`;
      let accept = false;
      const calls = fakeEgress(s, [(c) => {
        if (!c.url.startsWith('https://openrouter.ai/')) return undefined;
        if (!accept || c.headers['authorization'] !== `Bearer ${GOOD}`) return json(401, { error: { message: 'User not found.', code: 401 } });
        if (c.url.endsWith('/api/v1/key')) return json(200, { data: { label: 'x' } });
        if (c.url.endsWith('/api/v1/models')) return json(200, { data: [] });
        return undefined;
      }]);
      const pasted = `​${GOOD.slice(0, 20)}\n${GOOD.slice(20)}  `;
      const first = await s.api('/providers/validate', { method: 'POST', json: { provider: 'openrouter', secret: pasted } });
      expect(first.status).toBe(422);
      const e = (await body<{ error: { code: string; message: string; details: Record<string, unknown> } }>(first)).error;
      expect(e).toMatchObject({ code: 'EM-4002', details: { recentKey: true, providerStatus: 401, reason: 'User not found.' } });
      expect(e.message).toContain('1–2 minutes');
      expect(calls.at(-1)!.headers['authorization']).toBe(`Bearer ${GOOD}`);
      accept = true;                                                   // the key became active a moment later: retry succeeds
      expect((await s.api('/providers/validate', { method: 'POST', json: { provider: 'openrouter', secret: pasted } })).status).toBe(200);
      const add = await s.api('/providers/connections', { method: 'POST', json: { provider: 'openrouter', label: 'Utama', secret: pasted } });
      expect(add.status).toBe(201);
      expect((await body<{ secretHint: string }>(add)).secretHint).toBe(`…${GOOD.slice(-4)}`);
    } finally { await s.close(); }
  });
});
