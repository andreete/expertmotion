// FR-037 held picks (EM-2104) persisted server-side and resumed on model.installed; FR-049 asset Insert recorded in the Intent
// Queue ("Insert N clips", applied directly); FR-012 Save persists UI state per project; FR-013 Save As copies conversations.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { modelGate } from '../../src/modules/intents.js';
import { headHash, insertClips, newProject, startS1, type S1Service } from './helpers.js';

const fade = (base: string) => ({ source: 'ui', category: 'transition', presetId: 'preset:transition.fade', target: { kind: 'selection' }, baseVersion: base });

describe('S1 gap closure', () => {
  let s: S1Service;
  const realFlag = modelGate.flagOf;
  beforeAll(async () => { s = await startS1(); });
  afterAll(async () => { await s.close(); });
  afterEach(() => { modelGate.flagOf = realFlag; });

  it('FR-037 a pick whose model is missing is held (EM-2104), survives a reload, and resumes when the model is installed', async () => {
    const pid = (await newProject(s)).id; insertClips(s, pid, ['a1', 'a2']);
    modelGate.flagOf = (id) => (id === 'preset:transition.fade' ? 'model:whisper' : undefined);
    const before = await headHash(s, pid);
    const r = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(before) });
    expect(r.status).toBe(201);
    expect(r.body.intent.status).toBe('held');
    expect(r.body.notices).toEqual([{ code: 'EM-2104' }]);
    expect(r.body.appliedVersion).toBeNull();
    expect(await headHash(s, pid)).toBe(before);                                        // nothing applied while held
    const q = await s.json(`/projects/${pid}/intents`);                                 // persisted (what a reload reads)
    expect(q.body.items.some((i: { id: string; status: string }) => i.id === r.body.intent.id && i.status === 'held')).toBe(true);
    s.ctx.hooks.onModelInstalled!('model:whisper');
    const after = await s.json(`/projects/${pid}/intents`);
    expect(after.body.items.find((i: { id: string }) => i.id === r.body.intent.id).status).toBe('executed');
    const m = (await s.json(`/projects/${pid}/composition`)).body.head.model;
    expect(m.transitions.map((t: { presetId: string }) => t.presetId)).toEqual(['preset:transition.fade']);
  });

  it('FR-037 a held pick can be removed from the queue', async () => {
    const pid = (await newProject(s)).id; insertClips(s, pid, ['a1', 'a2']);
    modelGate.flagOf = () => 'model:whisper';
    const r = await s.json(`/projects/${pid}/intents`, { method: 'POST', json: fade(await headHash(s, pid)) });
    expect((await s.json(`/projects/${pid}/intents/${r.body.intent.id}`, { method: 'DELETE' })).status).toBe(200);
    s.ctx.hooks.onModelInstalled!('model:whisper');
    expect((await s.json(`/projects/${pid}/composition`)).body.head.model.transitions).toEqual([]);
  });

  it('FR-049 an Insert is one queue item "Insert N clips" applied directly in one Composition Version', async () => {
    const pid = (await newProject(s)).id;
    const ops = ['a1', 'a2', 'a3'].map((assetId) => ({ op: 'op:clip.insert', target: { kind: 'sequence' as const }, args: { assetId } }));
    const res = s.ctx.hooks.insertIntent!(pid, ops, { label: 'Insert 3 clips', assetIds: ['a1', 'a2', 'a3'] });
    const head = (await s.json(`/projects/${pid}/composition`)).body.head;
    expect(head.id).toBe(res.versionId);
    expect(head.model.tracks.video.map((c: { assetId: string }) => c.assetId)).toEqual(['a1', 'a2', 'a3']);
    const q = (await s.json(`/projects/${pid}/intents`)).body.items as Array<{ id: string; status: string; category: string; params: Record<string, unknown>; appliedVersion?: number }>;
    const it = q.find((i) => i.id === res.intentId)!;
    expect(it).toMatchObject({ status: 'executed', category: 'asset', params: { targetLabel: 'Insert 3 clips' } });
    expect(typeof it.appliedVersion).toBe('number');
  });

  it('FR-012 Save stores the UI state on the project row; FR-013 Save As copies it and the conversations', async () => {
    const p = await newProject(s);
    const ui = { libMode: 'home', playheadMs: 1200, selection: [{ kind: 'clip', id: 'c1' }] };
    expect((await s.json(`/projects/${p.id}`, { method: 'PATCH', json: { uiState: ui } })).status).toBe(200);
    expect((await s.json(`/projects/${p.id}`)).body.uiState).toEqual(ui);
    expect((await s.json(`/projects/${p.id}`, { method: 'PATCH', json: { uiState: { big: 'x'.repeat(20_000) } } })).status).toBe(400);
    const conv = s.ctx.newId();
    s.ctx.db.prepare("INSERT INTO conversations (id, project_id, agent, summary_json, created_at, updated_at) VALUES (?,?,'editor',NULL,'t','t')").run(conv, p.id);
    for (const [i, text] of ['Buat judul', 'Siap'].entries()) s.ctx.db.prepare('INSERT INTO messages (id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,?,?,NULL,?)')
      .run(s.ctx.newId(), conv, i ? 'assistant' : 'user', JSON.stringify([{ type: 'text', text }]), `2026-10-24T00:00:0${i}.000Z`);
    const d = await s.json(`/projects/${p.id}/duplicate`, { method: 'POST', json: { name: `${p.name} B` } });
    expect(d.status).toBe(201);
    expect((await s.json(`/projects/${d.body.id}`)).body.uiState).toEqual(ui);
    const copied = s.ctx.db.prepare("SELECT m.role, m.blocks_json FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ? AND c.agent = 'editor' ORDER BY m.created_at").all(d.body.id) as Array<{ role: string; blocks_json: string }>;
    expect(copied.map((m) => [m.role, JSON.parse(m.blocks_json)[0].text])).toEqual([['user', 'Buat judul'], ['assistant', 'Siap']]);
    expect((s.ctx.db.prepare('SELECT count(*) AS n FROM messages WHERE conversation_id = ?').get(conv) as { n: number }).n).toBe(2);   // original untouched
  });
});
