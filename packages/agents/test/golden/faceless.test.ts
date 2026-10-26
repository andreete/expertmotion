// GS-23 "Buat video faceless 30 detik tentang tips hemat listrik" on a project with ZERO assets (QA 2026-10-26 #2, ADR-030):
// Diskusi proposes hook / scenes / CTA → "Kerjakan di video" → the Editor Agent (fake provider replaying a recorded reply)
// builds scene clips, texts, transitions, a voice-over step and captions → apply → a valid, non-empty composition.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOperations, deriveTiming, hashModel, validate } from '@expertmotion/composition-model';
import { buildRewriteEnvelope, fakeProvider, planOps, runBrainstorm, runEditorAgent, type EditPlanT } from '../../src/index.js';
import { Scenario } from './harness.js';

export const GS23_REPLY = fs.readFileSync(new URL('./fixtures/gs-23-editor-reply.json', import.meta.url), 'utf8');
const MSG = 'Buat video faceless 30 detik tentang tips hemat listrik';
const TTS = { installed: true, modelKey: 'piper-id-news', label: 'Suara Indonesia (Piper)' };

async function plan(toolModels: { tts: typeof TTS }, reply = GS23_REPLY) {
  const s = new Scenario({ ratio: '9:16', assets: [] });
  const env = buildRewriteEnvelope({ model: s.model, baseVersion: s.head, assets: [], intents: [], lockedKeys: [], creatorMessage: MSG, tier: s.tier,
    stepTools: { 'tts.generate': { available: toolModels.tts.installed, model: toolModels.tts.label }, 'captions.generate': { script: true, sequence: false } } });
  const prov = fakeProvider(['Berikut rencananya:\n```json\n' + reply + '\n```']);
  const r = await runEditorAgent(env, prov, { model: s.model, baseVersion: s.head, assets: [], tier: s.tier, lockedKeys: [], newId: s.newId, planId: 'pl', projectId: 'gs', toolModels, language: 'id' });
  return { s, env, r, prov };
}
function applyPlan(s: Scenario, p: EditPlanT) {
  const a = applyOperations(s.model, planOps(p), { assets: [], tier: s.tier, newId: s.newId });
  if (!a.ok) throw new Error(JSON.stringify(a.issues));
  return a.value.model;
}

describe('GS-23 faceless video from a prompt, no assets', () => {
  it('Brainstorming proposes the structure as intents and never asks to upload first (prompt contract)', async () => {
    const turn = JSON.stringify({ reply: 'Struktur 30 detik: hook 3 dtk, 3 tips @7 dtk, ajakan 6 dtk. Mau aku buatkan?', proposedIntents: [
      { category: 'text', needsInterpretation: true, instruction: "Adegan 1 (3s): judul 'Tagihan listrik bengkak?', latar preset:background.spotlight", source: 'brainstorm' },
      { category: 'text', needsInterpretation: true, instruction: "Adegan 2 (7s): judul 'Tips 1', teks 'Cabut charger', transisi preset:transition.slide", source: 'brainstorm' },
      { category: 'generate', needsInterpretation: true, instruction: 'Narasi dari naskah', source: 'brainstorm' }], suggestedNextStep: 'send-to-editor' });
    const prov = fakeProvider([turn]);
    const b = await runBrainstorm([{ role: 'user', content: MSG }], { composition: null, assets: [] }, 'id', prov);
    expect(b.ok && b.turn.proposedIntents?.length).toBe(3);
    expect(prov.calls[0]!.system).toContain('A video needs NO imported media');
    expect(prov.calls[0]!.system).toContain('Never tell the Creator to upload');
  });
  it('the Editor plan builds ≥ 3 scene clips with text on every scene, transitions, a voice-over step and captions after it', async () => {
    const { s, env, r } = await plan({ tts: TTS });
    expect(env.constraints.join(' ')).toContain('op:scene.add');
    expect(env.capabilities.opArgs['op:scene.add']).toContain('durationMs');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.status).toBe('valid');
    expect(r.plan.baseVersion).toBe(s.head);                                // the model's "{{base_version}}" echo is replaced
    expect(r.plan.steps.map((x) => [x.tool, x.args['status']])).toEqual([['composition.applyOps', undefined], ['tts.generate', 'ready'], ['captions.generate', 'ready']]);
    const m = applyPlan(s, r.plan);
    const scenes = m.tracks.video;
    expect(scenes.length).toBeGreaterThanOrEqual(3);
    expect(scenes.every((c) => c.scene && c.assetId === undefined)).toBe(true);
    const t = deriveTiming(m);
    scenes.forEach((c, i) => {
      const from = t.clipStartMs[i]!, to = from + c.durationMs;
      expect(m.tracks.text.some((x) => x.timing.atMs >= from && x.timing.atMs < to)).toBe(true);   // text on every scene
    });
    expect(m.transitions.length).toBe(scenes.length - 1);
    expect(t.durationMs).toBe(30000 - 3 * 400 - 500);
    expect(t.durationMs).toBeGreaterThan(0);
    expect(validate(m, { assets: [], tier: s.tier }).filter((i) => i.severity === 'block')).toEqual([]);
    expect(hashModel(m)).not.toBe(s.head);
  });
  it('without the voice model the voice step waits for the Model Manager, captions come from the script now, the rest still runs', async () => {
    const { s, r } = await plan({ tts: { ...TTS, installed: false } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.status).toBe('valid');
    expect(r.plan.steps[1]).toMatchObject({ tool: 'tts.generate', args: { status: 'needs-model', modelKey: 'piper-id-news' } });
    expect(r.plan.risks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'model-missing', severity: 'warn' })]));
    expect(r.plan.risks.find((x) => x.code === 'model-missing')!.message).toContain('Model Manager');
    expect(r.plan.steps[2]!.tool).toBe('composition.applyOps');            // script captions became ops in the same version
    const m = applyPlan(s, r.plan);
    expect(m.tracks.caption.pages.length).toBeGreaterThan(5);
    expect(m.tracks.caption.styleId).toBe('preset:caption.editorial');
    const end = deriveTiming(m).durationMs;
    expect(m.tracks.caption.pages.at(-1)!.startMs + m.tracks.caption.pages.at(-1)!.durationMs).toBeLessThanOrEqual(end);
  });
});
