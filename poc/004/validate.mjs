// POC-004 deterministic validator: schema → closed vocabularies (read from the docs) → Locked Keys → CM rules → dry-run applyOps.
import fs from 'node:fs';
import { EditPlan } from './schemas.mjs';
const DOCS = new URL('../../docs/', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, DOCS), 'utf8');
export const OPS = new Set([...read('AI_WORKFLOW.md').split('## 5.')[1].split('## 6.')[0].matchAll(/`(op:[a-z]+\.[a-zA-Z]+)`/g)].map((m) => m[1]));
export const PRESETS = new Set([...read('DESIGN_CATALOGUE.md').matchAll(/preset:[a-z]+\.[a-z0-9-]+/g)].map((m) => m[0]));

// Which property key does an operation write? (Locked Keys are property keys: AI_WORKFLOW §2, §6.)
export function propertyKeys(o) {
  const t = o.target ?? {}, a = o.args ?? {}, id = t.id ?? t.index;
  switch (o.op) {
    case 'op:transition.set': case 'op:transition.clear': return [`cut:${t.index ?? a.cutIndex}.transition`];
    case 'op:caption.setStyle': case 'op:caption.clear': return ['project.captionStyle'];
    case 'op:background.set': case 'op:background.clear': return ['project.background'];
    case 'op:output.setRatio': return ['project.ratio']; case 'op:output.setResolution': return ['project.resolution']; case 'op:project.setFps': return ['project.fps'];
    case 'op:text.setStyle': return Object.keys(a).filter((k) => ['fontFamily','fontSize','weight','colour','align','opacity'].includes(k)).map((k) => `text:${id}.${k}`);
    case 'op:theme.setTextDefaults': return Object.keys(a).map((k) => `theme.textDefaults.${k}`);
    case 'op:motion.set': case 'op:motion.clear': return [`${t.kind}:${id}.motion`];
    case 'op:clip.setTrim': return [`clip:${id}.trim`];
    default: return [];
  }
}

export function validatePlan(raw, ctx) {                       // → { ok, issues[], predictedDurationMs }
  const issues = [], add = (code, message, severity = 'block', path = '') => issues.push({ code, message, severity, path });
  const parsed = EditPlan.safeParse(raw);
  if (!parsed.success) { for (const i of parsed.error.issues) add('schema', i.message, 'block', i.path.join('.')); return { ok: false, issues }; }
  const plan = parsed.data;
  if (plan.baseVersion !== ctx.baseVersion) add('stale', `baseVersion ${plan.baseVersion} ≠ head ${ctx.baseVersion}`);
  const ops = plan.steps.flatMap((s) => s.ops);
  if (ops.length > 200) add('too-many-ops', `${ops.length} > 200`);
  const model = structuredClone(ctx.model);
  const locked = new Set(ctx.lockedKeys);
  ops.forEach((o, i) => {
    const p = `steps.ops[${i}]`;
    if (!OPS.has(o.op)) { add('unknown-op', `${o.op} is not in the operation vocabulary`, 'block', p); return; }
    for (const [k, v] of Object.entries(o.args)) if (typeof v === 'string' && /^preset:/.test(v) && !PRESETS.has(v)) add('unknown-preset', `${v} is not in the Design Catalogue`, 'block', `${p}.args.${k}`);
    if (o.args.presetId && !PRESETS.has(o.args.presetId)) add('unknown-preset', `${o.args.presetId} is not in the Design Catalogue`, 'block', `${p}.args.presetId`);
    for (const key of propertyKeys(o)) if (locked.has(key)) add('locked-key', `${o.op} would change locked key ${key}`, 'block', p);
    for (const f of ['atMs', 'durationMs', 'trimBeforeMs']) if (f in o.args && !(Number.isInteger(o.args[f]) && o.args[f] >= (f === 'durationMs' ? 100 : 0))) add('time-units', `${f} must be an integer in ms (durationMs ≥ 100)`, 'block', `${p}.args.${f}`);
    // dry-run applyOps on the fixture model (subset of ops; others are schema-validated only)
    if (o.op === 'op:transition.set') {
      const n = model.tracks.video.length - 1, idx = o.target?.index;
      if (!Number.isInteger(idx) || idx < 0 || idx >= n) { add('cut-range', `cut index ${idx} outside 0..${n - 1}`, 'block', p); return; }
      const shorter = Math.min(model.tracks.video[idx].durationMs, model.tracks.video[idx + 1].durationMs);
      let d = o.args.durationMs ?? 500;
      if (d > shorter * 0.5) { d = Math.floor(shorter * 0.5); add('transition-clamped', `transition clamped to ${d} ms (50 % of the shorter clip)`, 'warn', p); }
      model.transitions = model.transitions.filter((t) => t.cutIndex !== idx).concat({ cutIndex: idx, presetId: o.args.presetId, durationMs: d });
    } else if (o.op === 'op:text.add') model.tracks.text.push({ ...o.args });
    else if (o.op === 'op:audio.addBed' || o.op === 'op:audio.addLayer') { if (!ctx.assets.some((a) => a.id === o.args.assetId)) add('asset-missing', `asset ${o.args.assetId} does not exist (CM-001)`, 'block', `${p}.args.assetId`); }
  });
  const dur = model.tracks.video.reduce((s, c) => s + c.durationMs, 0) - model.transitions.reduce((s, t) => s + t.durationMs, 0);
  if (dur < 1000 || dur > 1_800_000) add('duration', `total duration ${dur} ms outside 1 000…1 800 000`);
  return { ok: !issues.some((i) => i.severity === 'block'), issues, plan, predictedDurationMs: dur };
}

// Retry loop (AI_WORKFLOW §12): up to 2 corrections, then EM-4301. `provider(messages)` → string.
export async function planWithRetries(provider, envelope, ctx, maxRetries = 2) {
  const messages = [{ role: 'user', content: JSON.stringify(envelope) }]; const trace = [];
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const { text, usage } = await provider(messages, attempt);
    let json; try { json = JSON.parse(text.trim().replace(/^```json\s*|```$/g, '')); } catch (e) {
      trace.push({ attempt, outcome: 'invalid-json', usage }); messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'Your reply was not valid JSON. Reply with the EditPlan JSON only.' }); continue; }
    const v = validatePlan(json, ctx); trace.push({ attempt, outcome: v.ok ? 'valid' : 'invalid', issues: v.issues.map((i) => i.code), usage });
    if (v.ok) return { ok: true, plan: v.plan, warnings: v.issues, attempts: attempt + 1, trace, predictedDurationMs: v.predictedDurationMs };
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'The plan was rejected: ' + JSON.stringify(v.issues) + '. Fix it and reply with JSON only.' });
  }
  return { ok: false, error: 'EM-4301', attempts: maxRetries + 1, trace };
}
