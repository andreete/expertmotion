// Review 2026-10-29 A1 / A2: Cancel during the voice phase of a voice-first Execute cancels the plan (was EM-2309 while paid synthesis
// went on) and aborts the voice batch; a plan whose base already moved is refused as stale BEFORE any voice is generated (paid).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hashModel } from '@expertmotion/composition-model';
import { fakeProvider } from '@expertmotion/agents';
import { startService, type TestService } from '../helpers.js';
import { health } from '../../src/modules/health.js';
import { settingsModule } from '../../src/modules/settings.js';
import { providersModule } from '../../src/modules/providers.js';
import { usageModule } from '../../src/modules/usage.js';
import { agentsModule } from '../../src/modules/agents.js';
import { projectsModule } from '../../src/modules/projects.js';
import { compositionModule } from '../../src/modules/composition.js';
import { intentsModule } from '../../src/modules/intents.js';
import { body, waitFor } from './s3-helpers.js';

describe('review A1/A2: voice-first Execute can be cancelled and never voices a stale plan', () => {
  let s: TestService; let pid = '';
  const events: Array<{ name: string; data: Record<string, unknown> }> = [];
  let batches = 0; let seen: AbortSignal | undefined; let release: (() => void) | null = null;
  beforeAll(async () => {
    const spec = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/agents/test/fixtures/nikel-spec.json'), 'utf8')) as Record<string, unknown>;
    const { assetsModule } = await import('../../src/modules/assets.js');
    s = await startService({ modules: [health, settingsModule, providersModule, usageModule, projectsModule, compositionModule, assetsModule, intentsModule, agentsModule] });
    const emit = s.ctx.bus.emit.bind(s.ctx.bus);
    s.ctx.bus.emit = (name, data) => { events.push({ name, data: data as Record<string, unknown> }); return emit(name, data); };
    pid = (await body<{ id: string }>(await s.api('/projects', { method: 'POST', json: { name: 'Nikel', settings: { ratio: '9:16', resolution: '1080p', fps: 30, language: 'id' } } }))).id;
    s.ctx.hooks.providerFor = () => fakeProvider([JSON.stringify({ goal: 'Video ekspor nikel', steps: [{ n: 1, tool: 'scene.compose', args: spec, expectedDiff: '6 adegan' }], risks: [] })], 'claude-sonnet-5-5');
    // a voice batch that runs until it is cancelled (a long cloud synthesis)
    s.ctx.hooks.voiceBatch = async (_projectId, _input, opts) => {
      batches++; seen = opts?.signal;
      await new Promise<void>((res) => { release = res; opts?.signal?.addEventListener('abort', () => res(), { once: true }); });
      throw Object.assign(new (await import('@expertmotion/shared')).EmError('EM-4303', 'cancelled'), {});
    };
  });
  afterAll(async () => { await s.close(); });
  const plan = async () => {
    const head = hashModel(s.ctx.hooks.composition(pid).model);
    const r = await body<{ plan: { id: string } }>(await s.api(`/projects/${pid}/plans`, { method: 'POST', json: { baseVersion: head, message: 'Buat video ekspor nikel' } }));
    await waitFor(() => events.some((e) => e.name === 'plan.ready' && (e.data['plan'] as { id: string }).id === r.plan.id), 8000);
    return r.plan.id;
  };

  it('A1: Cancel while the voices are generated → plan cancelled, voice batch aborted, Execute answers EM-4303, head unchanged', async () => {
    const id = await plan();
    const before = s.ctx.hooks.composition(pid).versionId;
    const exec = s.api(`/plans/${id}/execute`, { method: 'POST', json: {} });
    await waitFor(() => events.some((e) => e.name === 'plan.progress' && e.data['planId'] === id && e.data['phase'] === 'voice') && release !== null, 8000);
    const c = await s.api(`/plans/${id}/cancel`, { method: 'POST' });
    expect(c.status).toBe(200);
    expect((await body<{ status: string }>(c)).status).toBe('cancelled');
    expect(seen?.aborted).toBe(true);
    const r = await exec;
    expect(r.status).toBe(409);
    expect((await r.json() as { error: { code: string } }).error.code).toBe('EM-4303');
    expect((await body<{ status: string }>(await s.api(`/plans/${id}`))).status).toBe('cancelled');
    expect(s.ctx.hooks.composition(pid).versionId).toBe(before);
    expect(events.some((e) => e.name === 'plan.invalid' && e.data['planId'] === id && e.data['status'] === 'cancelled')).toBe(true);
  });

  it('A2: a voice-first plan whose base moved is refused as stale (EM-2301) before any voice is generated', async () => {
    const id = await plan();
    const n = batches;
    // the Creator edits by hand meanwhile: a new head
    s.ctx.hooks.applyOps(pid, [{ op: 'op:scene.add', target: { kind: 'sequence' }, args: { durationMs: 2000, title: 'Manual' } }] as never, { kind: 'system', summary: 'manual edit' });
    const r = await s.api(`/plans/${id}/execute`, { method: 'POST', json: {} });
    expect((await r.json() as { error: { code: string } }).error.code).toBe('EM-2301');
    expect(batches).toBe(n);                                                     // nothing synthesised (or paid)
  });
});
