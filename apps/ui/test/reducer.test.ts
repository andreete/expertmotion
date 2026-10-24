import { describe, expect, it } from 'vitest';
import { createEmptyModel } from '@expertmotion/composition-model';
import { initialState, reducer, visibleQueue, type AppState } from '../src/state/reducer.js';
import type { EditIntent, IntentQueueDto, PlanDto, ServiceEvent, VersionDto } from '../src/api/types.js';

const version = (id: string, hash: string): VersionDto => ({ id, projectId: 'P', parentId: null, hash, cause: 'compile', planId: null, durationMs: 15000, createdAt: '2026-10-24T00:00:00Z', model: createEmptyModel('P') });
const intent = (id: string, status: EditIntent['status'], extra: Partial<EditIntent> = {}): EditIntent => ({
  id, projectId: 'P', source: 'ui', createdAt: '2026-10-24T00:00:00Z', category: 'transition', presetId: 'preset:transition.fade', params: {}, target: { kind: 'selection' },
  resolvedTargets: [], propertyKey: 'cut:0.transition', propertyClass: 'exclusive-group', needsInterpretation: false, status, supersedes: [], baseVersion: 'h1', ...extra,
});
const plan = (status: PlanDto['status'], baseVersion = 'h1'): PlanDto => ({ id: 'PL', projectId: 'P', baseVersion, origin: 'editor-agent', goal: 'g', steps: [], touchesLockedKeys: [], risks: [], status, validation: [] });
const ev = (e: { name: string; data: Record<string, unknown> }): ServiceEvent => ({ name: e.name, data: { seq: 1, at: '', ...e.data } }) as unknown as ServiceEvent;
const withProject = (): AppState => ({
  ...initialState, project: { id: 'P', name: 'x', settings: createEmptyModel('P').settings, language: 'id', headVersionId: 'v1', headHash: 'h1', durationMs: 1000, assetCount: 0, createdAt: '', updatedAt: '', openedAt: null, dirty: false },
  head: version('v1', 'h1'),
});

describe('reducer', () => {
  it('replaces optimistic intents with the server queue on intent.updated', () => {
    let s = reducer(withProject(), { type: 'optimisticIntent', intent: intent('pending-1', 'queued') });
    expect(visibleQueue(s).map((i) => i.id)).toEqual(['pending-1']);
    const queue: IntentQueueDto = { projectId: 'P', headHash: 'h2', items: [intent('I1', 'executed')], lockedKeys: ['cut:0.transition'] };
    s = reducer(s, { type: 'event', event: ev({ name: 'intent.updated', data: { projectId: 'P', queue, changed: ['I1'], reason: 'compiled' } }) });
    expect(visibleQueue(s).map((i) => i.id)).toEqual(['I1']);
    expect(s.queue?.lockedKeys).toEqual(['cut:0.transition']);
  });

  it('marks a valid plan stale when composition.updated moves the head', () => {
    let s = reducer(withProject(), { type: 'plan', plan: plan('valid', 'h1') });
    s = reducer(s, { type: 'event', event: ev({ name: 'composition.updated', data: { projectId: 'P', version: version('v2', 'h2'), previousHash: 'h1', diff: [], cause: 'undo', canUndo: true, canRedo: true, durationMs: 1000, issues: [] } }) });
    expect(s.plan?.status).toBe('stale');
    expect(s.canRedo).toBe(true);
    expect(s.project?.dirty).toBe(false);                               // FR-173: versions are persisted, never "unsaved"
    expect(s.project?.headHash).toBe('h2');
  });

  it('does not mark the executing plan stale on its own execute version', () => {
    let s = reducer(withProject(), { type: 'plan', plan: plan('valid', 'h1') });
    s = reducer(s, { type: 'event', event: ev({ name: 'composition.updated', data: { projectId: 'P', version: version('v2', 'h2'), previousHash: 'h1', diff: [{ elementId: 't1', change: 'added', fields: [] }], cause: 'execute', canUndo: true, canRedo: false, durationMs: 1000, issues: [] } }) });
    expect(s.plan?.status).toBe('valid');
    expect(s.pulse?.diff).toHaveLength(1);
  });

  it('applies plan.invalid to the current plan and keeps previous plans when a new one arrives', () => {
    let s = reducer(withProject(), { type: 'plan', plan: plan('valid') });
    s = reducer(s, { type: 'event', event: ev({ name: 'plan.invalid', data: { projectId: 'P', planId: 'PL', status: 'invalid', code: 'EM-2302', validation: [{ code: 'EM-2302', path: 'x', message: 'locked', severity: 'block' }], touchesLockedKeys: ['cut:0.transition'] } }) });
    expect(s.plan?.status).toBe('invalid');
    expect(s.plan?.touchesLockedKeys).toEqual(['cut:0.transition']);
    s = reducer(s, { type: 'plan', plan: { ...plan('draft'), id: 'PL2' } });
    expect(s.plan?.id).toBe('PL2');
    expect(s.previousPlans.map((p) => p.id)).toEqual(['PL']);
  });

  it('never regresses a plan to draft when the HTTP response arrives after plan.ready', () => {
    let s = reducer(withProject(), { type: 'plan', plan: plan('valid') });
    s = reducer(s, { type: 'plan', plan: plan('draft') });
    expect(s.plan?.status).toBe('valid');
  });

  it('ignores compiled-and-executed plans (they are queue receipts, not Plan Cards)', () => {
    const s = reducer(withProject(), { type: 'plan', plan: { ...plan('executed'), origin: 'compile' } });
    expect(s.plan).toBeNull();
  });

  it('shows one toast per EM- code with a counter, and at most three toasts', () => {
    let s = initialState;
    s = reducer(s, { type: 'toast', toast: { kind: 'danger', textKey: 'err.EM-3201.title', code: 'EM-3201', sticky: true } });
    s = reducer(s, { type: 'toast', toast: { kind: 'danger', textKey: 'err.EM-3201.title', code: 'EM-3201', sticky: true } });
    expect(s.toasts).toHaveLength(1);
    expect(s.toasts[0]!.count).toBe(2);
    for (let i = 0; i < 5; i++) s = reducer(s, { type: 'toast', toast: { kind: 'info', textKey: `k${i}`, sticky: false } });
    expect(s.toasts).toHaveLength(3);
  });

  it('tracks render progress, done and failure', () => {
    const job = { id: 'J', projectId: 'P', versionId: 'v1', outputProfile: { ratio: '9:16', resolution: '720p', fps: 30, format: 'mp4' }, performanceProfile: 'standard', status: 'queued', progress: 0, renderedFrames: null, totalFrames: 300, etaMs: null, outputId: null, errorCode: null, width: 720, height: 1280, createdAt: '', startedAt: null, finishedAt: null } as const;
    let s = reducer(withProject(), { type: 'event', event: ev({ name: 'render.queued', data: { projectId: 'P', job: { ...job, outputProfile: { ...job.outputProfile } } } }) });
    s = reducer(s, { type: 'event', event: ev({ name: 'render.progress', data: { projectId: 'P', jobId: 'J', progress: 0.5, renderedFrames: 150, totalFrames: 300, etaMs: 2000, stage: 'rendering' } }) });
    expect(s.renders[0]).toMatchObject({ status: 'rendering', progress: 0.5, etaMs: 2000 });
    s = reducer(s, { type: 'event', event: ev({ name: 'render.failed', data: { projectId: 'P', jobId: 'J', code: 'EM-3203', percent: 50, frame: 150 } }) });
    expect(s.renders[0]).toMatchObject({ status: 'failed', errorCode: 'EM-3203', progress: 0.5, failedFrame: 150 });   // FR-143
  });

  it('streams agent deltas and appends the final message', () => {
    let s = reducer(withProject(), { type: 'event', event: ev({ name: 'agent.run.started', data: { projectId: 'P', run: { id: 'R', projectId: 'P', agent: 'brainstorm', status: 'running', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: '', finishedAt: null }, agent: 'brainstorm', modelId: 'm' } }) });
    s = reducer(s, { type: 'event', event: ev({ name: 'agent.run.delta', data: { projectId: 'P', runId: 'R', agent: 'brainstorm', delta: 'Hal' } }) });
    s = reducer(s, { type: 'event', event: ev({ name: 'agent.run.delta', data: { projectId: 'P', runId: 'R', agent: 'brainstorm', delta: 'o' } }) });
    expect(s.streaming.brainstorm?.text).toBe('Halo');
    const message = { id: 'M', role: 'assistant' as const, blocks: [{ type: 'text' as const, text: 'Halo' }], agentRunId: 'R', createdAt: '' };
    s = reducer(s, { type: 'event', event: ev({ name: 'agent.run.done', data: { projectId: 'P', run: { id: 'R', projectId: 'P', agent: 'brainstorm', status: 'done', modelId: 'm', connectionId: null, planId: null, errorCode: null, usage: null, startedAt: '', finishedAt: '' }, message, usage: null, contextUsage: { usedTokens: 10, contextLength: 100 } } }) });
    expect(s.streaming.brainstorm).toBeNull();
    expect(s.messages.brainstorm).toHaveLength(1);
    expect(s.contextUsage.brainstorm).toEqual({ usedTokens: 10, contextLength: 100 });
  });

  it('ignores project-scoped events for another project and applies Private Mode changes', () => {
    const s0 = withProject();
    const s1 = reducer(s0, { type: 'event', event: ev({ name: 'intent.updated', data: { projectId: 'OTHER', queue: { projectId: 'OTHER', headHash: 'x', items: [], lockedKeys: [] }, changed: [], reason: 'created' } }) });
    expect(s1).toBe(s0);
    const withSettings = reducer(s0, { type: 'settings', settings: { privateMode: false, outputFolder: '', autoPlan: false, uiLanguage: 'en', theme: 'dark', defaultPerformanceProfile: 'standard', defaultRatio: '9:16', defaultResolution: '1080p', defaultFps: 30, checkUpdates: true, diagnosticsIncludeStructure: false } });
    const s2 = reducer(withSettings, { type: 'event', event: ev({ name: 'settings.changed', data: { scope: 'privateMode', privateMode: true } }) });
    expect(s2.settings?.privateMode).toBe(true);
  });

  it('prunes the selection when a new head removes the element', () => {
    let s = reducer(withProject(), { type: 'select', selection: [{ kind: 'clip', id: 'gone' }] });
    s = reducer(s, { type: 'head', head: version('v3', 'h3'), canUndo: true, canRedo: false });
    expect(s.selection).toEqual([]);
  });
});

describe('sample project notice (R-025)', () => {
  it('marks the sample settled on ready:true and on ready:false (partial), once', () => {
    let s = reducer(initialState, { type: 'event', event: ev({ name: 'service.notice', data: { kind: 'sample', projectId: 'P1', ready: false, failed: ['kafe-senja-2.mp4'], code: 'EM-1001' } }) });
    expect(s.sampleReady).toEqual(['P1']);
    s = reducer(s, { type: 'event', event: ev({ name: 'service.notice', data: { kind: 'sample', projectId: 'P1', ready: true } }) });
    expect(s.sampleReady).toEqual(['P1']);
    expect(reducer(initialState, { type: 'event', event: ev({ name: 'service.notice', data: { kind: 'sample', projectId: 'P2' } }) }).sampleReady).toEqual([]);
  });
});

describe('FR-171 reload after a Service restart', () => {
  const open = (s: AppState) => ({ project: s.project!, head: { ...version('v1', 'h1'), model: undefined }, mediaGrant: { token: 'g', baseUrl: 'http://127.0.0.1:1/media/g', expiresAt: '' },
    checkpointNewerThanSave: null, intentQueue: { projectId: 'P', headHash: 'h1', items: [], lockedKeys: [] }, latestPlan: null, renderJobs: [] }) as never;
  it('keeps playhead and selection when the same Project is reloaded (keepView), resets them on a normal open', () => {
    let s: AppState = { ...withProject(), playheadMs: 4200, selection: [{ kind: 'cut', index: 0 }] as AppState['selection'] };
    const kept = reducer(s, { type: 'projectOpened', open: open(s), assets: [], keepView: true });
    expect(kept.playheadMs).toBe(4200);
    expect(kept.selection).toEqual([{ kind: 'cut', index: 0 }]);
    s = reducer(s, { type: 'projectOpened', open: open(s), assets: [] });
    expect(s.playheadMs).toBe(0);
    expect(s.selection).toEqual([]);
  });
  it('service action stores the epoch and the fatal code', () => {
    const s = reducer(initialState, { type: 'service', epoch: 2, fatal: { code: 'EM-8002' } });
    expect([s.serviceEpoch, s.fatal?.code]).toEqual([2, 'EM-8002']);
  });
});
