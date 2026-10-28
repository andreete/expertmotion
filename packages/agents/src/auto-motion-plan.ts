// ADR-034 wiring of the scene composer and the quality gate into Edit Plans (AI_WORKFLOW §8). Kept in its own module so the plan
// runtime (plan.ts) only calls two functions:
//   expandSceneCompose(plan, ctx)  — a `scene.compose` step (args = VideoSpec), or an `op:scene.compose` op inside a
//                                    composition.applyOps step, becomes ordinary operations (+ tts.generate steps for voice clips
//                                    that do not exist yet, + captions.generate when asked) BEFORE validation, so Execute, Undo,
//                                    Locked Keys and the predicted diff work unchanged.
//   qualityGatePlan(...)           — after the dry run: what the plan made worse on screen is repaired where unambiguous (the add
//                                    op of a new element is rewritten; an existing element gets a fix op in an extra step) and the
//                                    rest is reported as a short checklist of plan risks.
import { applyOperations, autoFixOps, frameInUnits, qualityCheck, qualityChecklist, type ApplyContext, type AssetFacts, type CompositionModelT, type OperationT, type QualityIssue, type Tier } from '@expertmotion/composition-model';
import { issue, type Issue } from '@expertmotion/shared';
import { composeScenes } from './auto-motion.js';
import type { EditPlanT } from './schemas.js';

export const SCENE_COMPOSE_TOOL = 'scene.compose';
export const SCENE_COMPOSE_OP = 'op:scene.compose';
export interface ComposeStepContext { model: CompositionModelT; assets: readonly AssetFacts[]; tier: Tier; lockedKeys: readonly string[]; language?: 'id' | 'en' }
type Step = EditPlanT['steps'][number];
type Risk = EditPlanT['risks'][number];

/** Expands every scene.compose step / op:scene.compose op. Unchanged plan (same object) when there is nothing to expand. */
export function expandSceneCompose(plan: EditPlanT, ctx: ComposeStepContext): { plan: EditPlanT; issues: Issue[] } {
  const has = plan.steps.some((s) => s.tool === SCENE_COMPOSE_TOOL || s.ops.some((o) => o.op === SCENE_COMPOSE_OP));
  if (!has) return { plan, issues: [] };
  const id = (ctx.language ?? ctx.model.settings.language) !== 'en';
  const issues: Issue[] = [], risks: Risk[] = [...plan.risks];
  const addRisk = (r: Risk) => { if (!risks.some((x) => x.code === r.code && x.message === r.message)) risks.push(r); };
  let nextN = Math.max(0, ...plan.steps.map((s) => s.n)) + 1;
  const steps: Step[] = [];
  plan.steps.forEach((s, i) => {
    const composeArgs = s.tool === SCENE_COMPOSE_TOOL ? [s.args] : s.ops.filter((o) => o.op === SCENE_COMPOSE_OP).map((o) => o.args);
    if (!composeArgs.length) { steps.push(s); return; }
    const ops: OperationT[] = s.tool === SCENE_COMPOSE_TOOL ? [] : [];
    const generated: Step[] = [];
    let summary = '';
    let composed: unknown;                                                       // FR-224: kept for the voice-first Execute
    const expandOne = (args: unknown) => {
      const r = composeScenes(args, { model: ctx.model, assets: ctx.assets, tier: ctx.tier, lockedKeys: ctx.lockedKeys, ...(ctx.language ? { language: ctx.language } : {}) });
      if (!r.ok) { issues.push(issue('EM-2102', `Step ${s.n} (scene.compose): ${r.problem} Expected args: a VideoSpec (see capabilities.stepTools['scene.compose']).`, 'block', `steps[${i}].args`)); return []; }
      for (const x of r.risks) addRisk({ code: x.code, message: x.message, severity: x.severity });
      composed = r.spec;
      const secs = ((r.totalMs - (r.scenes[0]?.startMs ?? 0)) / 1000).toFixed(1);
      summary = id ? `${r.scenes.length} adegan bergerak (±${secs.replace('.', ',')} dtk) dengan transisi dan animasi otomatis` : `${r.scenes.length} animated scenes (~${secs} s) with automatic transitions and motion`;
      // voice clips that do not exist yet: one tts.generate step each, placed where the composer timed them
      if (r.spec.voice?.generate !== false) {
        const pending = r.voice.filter((v) => !v.assetId);
        if (pending.length) for (const v of pending) generated.push({ n: nextN++, tool: 'tts.generate', ops: [], args: { clipId: v.clipId, text: v.text.slice(0, 2000), atMs: v.atMs, ...(r.spec.voice?.voiceId ? { voiceId: r.spec.voice.voiceId } : {}), ...(r.spec.voice?.speed ? { speed: r.spec.voice.speed } : {}), language: r.spec.language ?? ctx.model.settings.language }, expectedDiff: (id ? `Suara ${v.clipId}` : `Voice ${v.clipId}`).slice(0, 200), dependsOn: [s.n] });
        else if (!r.spec.voice) {
          const script = r.spec.scenes.map((x) => x.narration ?? '').filter(Boolean).join(' ').trim();
          if (script) generated.push({ n: nextN++, tool: 'tts.generate', ops: [], args: { text: script.slice(0, 2000), atMs: r.scenes[0]?.startMs ?? 0, language: r.spec.language ?? ctx.model.settings.language }, expectedDiff: id ? 'Narasi dari naskah adegan' : 'Voice-over from the scene script', dependsOn: [s.n] });
        }
      }
      if (r.spec.captions) generated.push({ n: nextN++, tool: 'captions.generate', ops: [], args: { source: 'voice' }, expectedDiff: id ? 'Teks dari suara' : 'Captions from the voice', dependsOn: generated.filter((g) => g.tool === 'tts.generate').map((g) => g.n) });
      return r.ops;
    };
    if (s.tool === SCENE_COMPOSE_TOOL) ops.push(...expandOne(s.args));
    else for (const o of s.ops) { if (o.op === SCENE_COMPOSE_OP) ops.push(...expandOne(o.args)); else ops.push(o); }
    // FR-224 (voice-first Execute, workflow.ts): the VideoSpec stays on the step so Execute can generate the voice clips first, measure
    // them and compose again with the real durations (the expanded ops use estimated timing until then).
    steps.push({ n: s.n, tool: 'composition.applyOps', ops, args: composed && s.tool === SCENE_COMPOSE_TOOL ? { sceneCompose: composed } : {}, expectedDiff: (s.expectedDiff || summary).slice(0, 200), dependsOn: s.dependsOn });
    steps.push(...generated);
  });
  return { plan: { ...plan, steps, risks }, issues };
}

/**
 * Quality gate on a dry-run result (ADR-034). Only problems the plan introduces count. Fixes for elements the plan adds rewrite
 * their add op (ids of new elements differ between the dry run and Execute); fixes for existing elements become one extra step.
 */
export function qualityGatePlan(plan: EditPlanT, before: CompositionModelT, after: CompositionModelT, ctx: { assets: readonly AssetFacts[]; tier: Tier; newId: () => string; jobs?: ApplyContext['jobs']; language?: 'id' | 'en' }): { plan: EditPlanT; predicted?: CompositionModelT; changed: number } {
  const key = (q: QualityIssue) => `${q.code}|${[...q.ids].sort().join(',')}`;
  const old = new Set(qualityCheck(before).map(key));
  const fresh = qualityCheck(after).filter((q) => !old.has(key(q)));
  if (!fresh.length) return { plan, changed: 0 };
  const fixes = autoFixOps(after, fresh);
  const baseIds = new Set([...before.tracks.text.map((t) => t.id), ...before.tracks.overlay.map((o) => o.id)]);
  const newTexts = after.tracks.text.filter((t) => !baseIds.has(t.id)), newOverlays = after.tracks.overlay.filter((o) => !baseIds.has(o.id));
  const steps = plan.steps.map((s) => ({ ...s, ops: s.ops.map((o) => ({ ...o, args: { ...o.args } })) }));
  const flat = steps.flatMap((s) => s.ops);
  const textAdds = flat.filter((o) => o.op === 'op:text.add'), overlayAdds = flat.filter((o) => o.op === 'op:shape.add' || o.op === 'op:overlay.addImage');
  const f = frameInUnits(after.settings.ratio, after.settings.customRatio);
  const extra: OperationT[] = [];
  let changed = 0;
  for (const fx of fixes) {
    const tid = fx.target?.id ?? '';
    const ti = newTexts.findIndex((t) => t.id === tid), oi = newOverlays.findIndex((o) => o.id === tid);
    const add = ti >= 0 ? textAdds[ti] : oi >= 0 ? overlayAdds[oi] : undefined;
    if (!add) { if (baseIds.has(tid)) { extra.push(fx); changed++; } continue; }
    const a = add.args as Record<string, unknown>, x = fx.args as Record<string, unknown>;
    if (fx.op === 'op:element.setTransform') {
      const pos = (typeof a['position'] === 'object' && a['position'] ? a['position'] : (ti >= 0 ? newTexts[ti]!.position : newOverlays[oi]!.position)) as { x: number; y: number };
      a['position'] = { x: x['x'] === undefined ? pos.x : Math.round(Number(x['x']) * f.w * 10) / 10, y: x['y'] === undefined ? pos.y : Math.round(Number(x['y']) * f.h * 10) / 10 };
      changed++;
    } else if (fx.op === 'op:text.setStyle' && ti >= 0) { a['styleOverrides'] = { ...((a['styleOverrides'] as object | undefined) ?? {}), ...x }; changed++; }
  }
  const id = (ctx.language ?? after.settings.language) !== 'en';
  if (extra.length) steps.push({ n: Math.max(0, ...steps.map((s) => s.n)) + 1, tool: 'composition.applyOps', ops: extra, args: {}, expectedDiff: id ? 'Rapikan tata letak otomatis' : 'Automatic layout clean-up', dependsOn: [] });
  let predicted: CompositionModelT | undefined;
  let next: EditPlanT = { ...plan, steps };
  if (changed) {
    const r = applyOperations(before, steps.flatMap((s) => s.ops), { assets: ctx.assets, tier: ctx.tier, newId: ctx.newId, ...(ctx.jobs ? { jobs: ctx.jobs } : {}) });
    if (r.ok) predicted = r.value.model; else next = plan;             // a fix that does not apply is dropped, never blocks the plan
  }
  const remaining = qualityCheck(predicted ?? after).filter((q) => !old.has(key(q)) && q.severity === 'warn');
  const risks = [...next.risks];
  for (const line of qualityChecklist(remaining, id ? 'id' : 'en', 4)) if (!risks.some((r) => r.code === 'quality' && r.message === line)) risks.push({ code: 'quality', message: line, severity: 'warn' });
  return { plan: { ...next, risks }, ...(predicted && next !== plan ? { predicted } : {}), changed: next === plan ? 0 : changed };
}
