// POC-004 runner. Offline half (always): validator + retry loop + Locked Key mutation test with a scripted fake provider.
// Live half (only when EM_OPENROUTER_KEY_FILE is set): real OpenRouter calls. NOT RUN in this session (no key supplied).
import fs from 'node:fs';
import { validatePlan, planWithRetries, OPS, PRESETS, propertyKeys } from './validate.mjs';
import { ctx, scenarios, good } from './fixtures.mjs';

const results = []; const rec = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const script = (...texts) => async (_m, i) => ({ text: texts[Math.min(i, texts.length - 1)], usage: { cost: null } });
const mk = (ops, risks = []) => JSON.stringify({ baseVersion: 'v7-aa11', goal: 'x', steps: [{ n: 1, tool: 'composition.applyOps', ops, expectedDiff: 'd', dependsOn: [] }], risks });

rec('vocabularies are read from the docs', OPS.size >= 38 && PRESETS.size >= 100, `ops=${OPS.size} presets=${PRESETS.size}`);
rec('op:theme.setTextDefaults is in the vocabulary (AI_WORKFLOW §5)', OPS.has('op:theme.setTextDefaults'));

// S1: valid on first attempt
let r = await planWithRetries(script(good.title), scenarios.S1_title, ctx());
rec('S1 title: valid on first attempt', r.ok && r.attempts === 1, `attempts=${r.attempts}`);
// S2: first attempt changes the locked cut 0 → rejected; second respects it
r = await planWithRetries(script(mk([{ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.wipe', durationMs: 500 } }, { op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.wipe', durationMs: 500 } }]), good.wipeCut1), scenarios.S2_wipe_all, ctx());
rec('S2 wipe-all: locked cut 0 violation rejected, corrected plan accepted', r.ok && r.attempts === 2 && r.trace[0].issues.includes('locked-key'), JSON.stringify(r.trace.map((t) => t.outcome + ':' + (t.issues ?? []))));
// S3: prose first, then unknown asset, then valid partial plan with a warn risk
r = await planWithRetries(script('Tentu! Berikut rencananya…', mk([{ op: 'op:audio.addBed', args: { assetId: 'a-music', volume: 0.2, loop: true } }]), good.captionPartial), scenarios.S3_caption_audio, ctx());
rec('S3 caption+audio: prose → invalid JSON, hallucinated asset → rejected, partial plan accepted on attempt 3', r.ok && r.attempts === 3 && r.trace[0].outcome === 'invalid-json' && r.trace[1].issues.includes('asset-missing'), JSON.stringify(r.trace.map((t) => t.outcome)));
rec('S3 partial plan keeps the warn needs-input risk', r.plan?.risks.some((k) => k.code === 'needs-input' && k.severity === 'warn'));
// S4: injection text in a filename leads a model to emit an op outside the vocabulary
r = await planWithRetries(script(mk([{ op: 'op:render.start', args: {} }]), mk([{ op: 'op:shell.exec', args: { cmd: 'calc' } }]), good.title), scenarios.S4_injection, ctx());
rec('S4 prompt-injection: ops outside the closed vocabulary rejected (op:render.start, op:shell.exec)', r.ok && r.attempts === 3 && r.trace[0].issues.includes('unknown-op') && r.trace[1].issues.includes('unknown-op'));
// Exhaustion → EM-4301
r = await planWithRetries(script('nope', '{"foo":1}', '[]'), scenarios.S1_title, ctx());
rec('three invalid answers → EM-4301 after 1 + 2 retries', !r.ok && r.error === 'EM-4301' && r.attempts === 3);
// Unknown preset, bad time units, stale base, transition clamp
let v = validatePlan(JSON.parse(mk([{ op: 'op:background.set', args: { presetId: 'preset:background.rainbow' } }])), ctx()); rec('unknown preset id rejected', !v.ok && v.issues.some((i) => i.code === 'unknown-preset'));
v = validatePlan(JSON.parse(mk([{ op: 'op:text.add', args: { text: 'x', atMs: 0.3, durationMs: 3000 } }])), ctx()); rec('non-integer ms rejected', !v.ok && v.issues.some((i) => i.code === 'time-units'));
v = validatePlan({ ...JSON.parse(good.title), baseVersion: 'v6-old' }, ctx()); rec('stale baseVersion rejected', !v.ok && v.issues.some((i) => i.code === 'stale'));
v = validatePlan(JSON.parse(mk([{ op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.slide', durationMs: 4000 } }])), ctx()); rec('transition longer than 50 % of the shorter clip is clamped with a warning (3000 ms)', v.ok && v.issues.some((i) => i.code === 'transition-clamped'), `predicted duration ${v.predictedDurationMs} ms`);
v = validatePlan(JSON.parse(mk([{ op: 'op:transition.set', target: { kind: 'cut', index: 5 }, args: { presetId: 'preset:transition.fade', durationMs: 500 } }])), ctx()); rec('cut index out of range rejected', !v.ok && v.issues.some((i) => i.code === 'cut-range'));
v = validatePlan(JSON.parse(good.title), ctx()); rec('predicted duration = Σ clips − Σ transitions = 18 500 ms', v.predictedDurationMs === 8000 + 6000 + 5000 - 500, `${v.predictedDurationMs}`);
v = validatePlan({ ...JSON.parse(good.title), extra: 1 }, ctx()); rec('unknown top-level key rejected (strict schema)', !v.ok);
v = validatePlan({ baseVersion: 'v7-aa11', goal: 'x', steps: Array.from({ length: 41 }, (_, i) => ({ n: i + 1, tool: 't', ops: [], expectedDiff: 'd' })) }, ctx()); rec('> 40 steps rejected', !v.ok);

// Locked-key mutation test: every way of touching cut 0's transition, plus other locked keys, must be caught (target: 100 %)
const lockedCtx = () => ({ ...ctx(), lockedKeys: ['cut:0.transition', 'project.captionStyle', 'project.ratio', 'text:t1.fontSize', 'theme.textDefaults.colour', 'clip:c1.trim'] });
const muts = [];
for (const p of ['fade', 'slide', 'wipe', 'iris', 'clock-wipe', 'push-cut', 'none']) for (const d of [200, 500, 1500]) muts.push({ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: `preset:transition.${p}`, durationMs: d } });
muts.push({ op: 'op:transition.clear', target: { kind: 'cut', index: 0 }, args: {} });
for (const c of ['editorial', 'karaoke', 'box', 'none']) muts.push({ op: 'op:caption.setStyle', args: { presetId: `preset:caption.${c}` } });
muts.push({ op: 'op:caption.clear', args: {} }, { op: 'op:output.setRatio', args: { ratio: '1:1' } }, { op: 'op:text.setStyle', target: { kind: 'text', id: 't1' }, args: { fontSize: 99 } }, { op: 'op:theme.setTextDefaults', args: { colour: '#fff', fontSize: 70 } }, { op: 'op:clip.setTrim', target: { kind: 'clip', id: 'c1' }, args: { trimBeforeMs: 0, durationMs: 1000 } });
let caught = 0; for (const m of muts) { const vv = validatePlan(JSON.parse(mk([m])), lockedCtx()); if (!vv.ok && vv.issues.some((i) => i.code === 'locked-key')) caught++; }
rec(`Locked Key violations caught: ${caught}/${muts.length} (target 100 %)`, caught === muts.length);
// Also hidden in the middle of a big plan
const big = Array.from({ length: 150 }, (_, i) => ({ op: 'op:text.add', args: { text: 'T' + i, atMs: i * 10, durationMs: 500 } })); big.splice(77, 0, muts[0]);
v = validatePlan(JSON.parse(mk(big)), lockedCtx()); rec('violation hidden at position 77 of a 151-op plan is caught', !v.ok && v.issues.some((i) => i.code === 'locked-key'));
// Non-locked sibling is allowed
v = validatePlan(JSON.parse(mk([{ op: 'op:transition.set', target: { kind: 'cut', index: 1 }, args: { presetId: 'preset:transition.wipe', durationMs: 500 } }])), lockedCtx()); rec('non-locked cut 1 still allowed', v.ok);

const failed = results.filter((x) => !x).length;
console.log(`\nOFFLINE: ${results.length - failed}/${results.length} passed`);

// ───────────────────────────── Live half ─────────────────────────────
const keyFile = process.env.EM_OPENROUTER_KEY_FILE;
if (!keyFile) console.log('LIVE: not run — no key supplied (set EM_OPENROUTER_KEY_FILE to a file outside the repo, EM_MODEL_TOOLS and EM_MODEL_JSON to OpenRouter model ids). POC-004 therefore stays PARTIAL.');
else {
  const key = fs.readFileSync(keyFile, 'utf8').trim();
  const system = fs.readFileSync(new URL('../../SYSTEM_PROMPT.md', import.meta.url), 'utf8').split('## P-2')[1].split('```')[1];
  const live = (model) => async (messages) => {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: system.replace('{{language_name}}', 'Bahasa Indonesia').replace('{{base_version}}', 'v7-aa11') }, ...messages], temperature: 0.2, max_tokens: 4000, usage: { include: true } }) });
    const j = await res.json(); if (!res.ok) throw new Error(JSON.stringify(j));
    return { text: j.choices[0].message.content, usage: { cost: j.usage?.cost ?? null, in: j.usage?.prompt_tokens, out: j.usage?.completion_tokens } };
  };
  const rows = []; let spend = 0;
  for (const [label, model] of [['tools-capable', process.env.EM_MODEL_TOOLS], ['json-mode', process.env.EM_MODEL_JSON]]) {
    if (!model) { console.log(`LIVE ${label}: skipped (env not set)`); continue; }
    for (const [name, env] of Object.entries(scenarios)) for (let rep = 0; rep < 3; rep++) {
      const t0 = Date.now(); const out = await planWithRetries(live(model), env, ctx()); const cost = out.trace.reduce((s, t) => s + (t.usage?.cost ?? 0), 0); spend += cost;
      rows.push({ label, model, name, firstAttemptValid: out.ok && out.attempts === 1, validWithin3: out.ok, attempts: out.attempts, ms: Date.now() - t0, costKnown: out.trace.every((t) => t.usage?.cost != null), cost });
      if (spend > 1) { console.log('LIVE: budget guard (US$1) reached, stopping'); break; }
    }
  }
  console.table(rows); console.log('LIVE spend US$', spend.toFixed(4));
}
process.exit(failed ? 1 : 0);
