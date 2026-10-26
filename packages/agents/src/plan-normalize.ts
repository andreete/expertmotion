// Lenient reading of a model-authored Edit Plan (QA 2026-10-26 #4/#5, Claude Haiku 4.5 on Windows). Real models wrap the plan,
// drop optional fields, write op names without "op:", put args at the op's top level, use near-miss argument names, point at an
// asset id instead of the clip that shows it, or return intents instead of ops. Everything here is a deterministic repair of an
// UNAMBIGUOUS slip; anything ambiguous is left for validation, whose message goes back to the model (correction loop).
// The runtime never trusts the model's baseVersion: staleness is decided by the Local Service against the head (AI-013).
import { getPreset, type Category } from '@expertmotion/catalogue';
import { OPERATIONS, isOpName, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import { PLAN_STEP_TOOLS } from './schemas.js';

export interface NormalizeContext { model: CompositionModelT; baseVersion: string; assets?: readonly AssetFacts[]; language?: 'id' | 'en' }
export interface Normalized { value?: Record<string, unknown>; fixes: string[]; intents?: unknown[]; problem?: string }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const OP_ALIASES: Record<string, string> = {
  'op:transition.add': 'op:transition.set', 'op:transition.apply': 'op:transition.set', 'op:transition.remove': 'op:transition.clear',
  'op:background.add': 'op:background.set', 'op:background.apply': 'op:background.set', 'op:background.remove': 'op:background.clear',
  'op:text.create': 'op:text.add', 'op:text.insert': 'op:text.add', 'op:title.add': 'op:text.add',
  'op:text.update': 'op:text.setContent', 'op:text.edit': 'op:text.setContent', 'op:text.setText': 'op:text.setContent', 'op:text.delete': 'op:text.remove',
  'op:clip.add': 'op:clip.insert', 'op:clip.delete': 'op:clip.remove', 'op:clip.trim': 'op:clip.setTrim', 'op:clip.speed': 'op:clip.setPlaybackRate', 'op:clip.setSpeed': 'op:clip.setPlaybackRate',
  'op:clip.volume': 'op:clip.setVolume', 'op:clip.reorder': 'op:clip.move', 'op:clip.split': 'op:element.split', 'op:text.split': 'op:element.split', 'op:audio.split': 'op:element.split',
  'op:element.transform': 'op:element.setTransform', 'op:clip.setTransform': 'op:element.setTransform', 'op:element.timing': 'op:element.setTiming', 'op:element.layer': 'op:element.setLayer',
  'op:image.add': 'op:overlay.addImage', 'op:overlay.add': 'op:overlay.addImage', 'op:overlay.image': 'op:overlay.addImage', 'op:image.remove': 'op:overlay.remove',
  'op:caption.style': 'op:caption.setStyle', 'op:captions.setStyle': 'op:caption.setStyle', 'op:music.add': 'op:audio.addBed', 'op:audio.addMusic': 'op:audio.addBed', 'op:voice.add': 'op:audio.addLayer',
  'op:scene.create': 'op:scene.add', 'op:scene.insert': 'op:scene.add', 'op:scene.append': 'op:scene.add', 'op:scene.background': 'op:scene.setBackground',
  'op:effect.set': 'op:effect.add', 'op:motion.add': 'op:motion.set', 'op:motion.apply': 'op:motion.set', 'op:shape.create': 'op:shape.add', 'op:ratio.set': 'op:output.setRatio',
};
const OP_LOWER = new Map(Object.keys(OPERATIONS).map((n) => [n.toLowerCase(), n]));
const TOOL_ALIASES: Record<string, string> = {
  'composition.applyops': 'composition.applyOps', applyops: 'composition.applyOps', apply_ops: 'composition.applyOps', 'composition.apply': 'composition.applyOps', 'composition_applyops': 'composition.applyOps', composition: 'composition.applyOps',
  'tts.generate': 'tts.generate', tts: 'tts.generate', 'voice.generate': 'tts.generate', 'voiceover.generate': 'tts.generate', 'generate.voice': 'tts.generate', 'tts_generate': 'tts.generate',
  'captions.generate': 'captions.generate', captions: 'captions.generate', 'caption.generate': 'captions.generate', 'generate.captions': 'captions.generate', 'captions_generate': 'captions.generate',
};

/** Which preset category an argument holds, per op (for short preset ids like "fade" → preset:transition.fade). */
const PRESET_ARG: Record<string, Record<string, Category>> = {
  'op:transition.set': { presetId: 'transition' }, 'op:background.set': { presetId: 'background' }, 'op:caption.setStyle': { presetId: 'caption' },
  'op:motion.set': { presetId: 'motion' }, 'op:effect.add': { presetId: 'effect' }, 'op:effect.remove': { presetId: 'effect' }, 'op:effect.setParams': { presetId: 'effect' },
  'op:text.setEffect': { presetId: 'texteffect' }, 'op:shape.add': { presetId: 'shape', motionId: 'motion' }, 'op:audio.setDucking': { presetId: 'audio' }, 'op:audio.addBed': { duckingPresetId: 'audio' },
  'op:text.add': { variant: 'text' }, 'op:text.setStyle': { variant: 'text' }, 'op:easing.setDefault': { easingId: 'easing' }, 'op:theme.set': { paletteId: 'palette', fontPairId: 'fontpair', defaultEasingId: 'easing' },
  'op:scene.add': { background: 'background', titleVariant: 'text', textVariant: 'text', motionId: 'motion', transition: 'transition' }, 'op:scene.setBackground': { presetId: 'background' },
};
function presetFix(v: unknown, cat: Category): unknown {
  if (typeof v !== 'string') return v;
  if (getPreset(v)) return v;
  const bare = v.replace(/^preset:/, '').replace(/^[a-z]+\./, '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  for (const c of [cat, ...(cat === 'text' ? [] : [])]) { const id = `preset:${c}.${bare}`; if (getPreset(id)?.category === cat) return id; }
  const prefixed = v.startsWith('preset:') ? v : `preset:${v}`;
  return getPreset(prefixed) ? prefixed : v;
}

/** Arg name aliases valid for every op (only applied when the op knows the target name and not the alias). */
const COMMON_ARG_ALIASES: Record<string, string[]> = {
  atMs: ['startMs', 'start_ms', 'start', 'fromMs', 'at', 'timeMs', 'positionMs'], durationMs: ['duration', 'duration_ms', 'lengthMs', 'length'],
  presetId: ['preset', 'preset_id', 'presetID', 'style', 'transition', 'background'], assetId: ['asset', 'asset_id', 'assetID', 'media', 'mediaId'],
  text: ['content', 'value', 'caption', 'label', 'title'], variant: ['variantId', 'textVariant', 'type'], colour: ['color', 'fontColor', 'textColor', 'fontColour'], fontSize: ['size', 'font_size'],
  volume: ['level', 'gain'], rate: ['speed', 'playbackRate'], scale: ['zoom'], toIndex: ['index', 'position', 'to'], trimBeforeMs: ['trimStartMs', 'trimMs', 'offsetMs', 'trimBefore'],
  styleOverrides: ['style', 'styles'], fixedMs: ['durationMs', 'lengthMs'], easingId: ['easing'], title: ['heading', 'headline'],
  background: ['backgroundPresetId', 'bg', 'backgroundId'], transition: ['transitionPresetId', 'transitionId'], motionId: ['motion', 'animation'],
};
const argKeysOf = (op: string): string[] => Object.keys((OPERATIONS[op as keyof typeof OPERATIONS].args as unknown as { def: { shape: Obj } }).def.shape);

function normalizeArgs(opName: string, raw: Obj, fixes: string[], n: string): Obj {
  const keys = argKeysOf(opName);
  const a: Obj = { ...raw };
  for (const k of keys) {
    if (a[k] !== undefined) continue;
    for (const alias of COMMON_ARG_ALIASES[k] ?? []) if (a[alias] !== undefined && !keys.includes(alias)) { a[k] = a[alias]; delete a[alias]; fixes.push(`${n}: ${alias} → ${k}`); break; }
  }
  if (a['endMs'] !== undefined && keys.includes('durationMs') && a['durationMs'] === undefined && typeof a['atMs'] === 'number' && typeof a['endMs'] === 'number') { a['durationMs'] = a['endMs'] - (a['atMs'] as number); delete a['endMs']; fixes.push(`${n}: endMs → durationMs`); }
  // Numbers sent as strings, and fractional milliseconds.
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && !['text', 'title', 'assetId', 'jobId', 'voiceId'].includes(k)) { a[k] = Number(v); fixes.push(`${n}: ${k} number`); }
    if (/Ms$/.test(k) && typeof a[k] === 'number' && !Number.isInteger(a[k])) a[k] = Math.round(a[k] as number);
  }
  if (opName === 'op:clip.setVolume' && typeof a['volume'] === 'number' && a['volume'] > 1 && a['volume'] <= 100) { a['volume'] = (a['volume'] as number) / 100; fixes.push(`${n}: volume percent`); }
  if (opName === 'op:element.setTransform' && typeof a['scale'] === 'number' && a['scale'] > 20 && a['scale'] <= 1000) { a['scale'] = (a['scale'] as number) / 100; fixes.push(`${n}: scale percent`); }
  // Defaults for fields every real plan forgets and that have one obvious value.
  if (opName === 'op:text.add') { a['variant'] ??= 'preset:text.title'; a['atMs'] ??= 0; a['durationMs'] ??= 3000; }
  if (opName === 'op:transition.set') a['durationMs'] ??= 500;
  if (opName === 'op:audio.addLayer') a['volume'] ??= 1;
  if (opName === 'op:shape.add') { a['atMs'] ??= 0; a['durationMs'] ??= 3000; }
  if (opName === 'op:overlay.addImage') a['atMs'] ??= 0;
  if (opName === 'op:text.setStyle' || opName === 'op:theme.setTextDefaults') {
    if (a['bold'] === true && a['weight'] === undefined) { a['weight'] = 700; delete a['bold']; }
    if (typeof a['colour'] === 'string' && /^#[0-9a-f]{3}$/i.test(a['colour'] as string)) a['colour'] = `#${[...(a['colour'] as string).slice(1)].map((c) => c + c).join('')}`;
  }
  for (const [k, cat] of Object.entries(PRESET_ARG[opName] ?? {})) if (a[k] !== undefined) { const f = presetFix(a[k], cat); if (f !== a[k]) { fixes.push(`${n}: ${String(a[k])} → ${String(f)}`); a[k] = f; } }
  // Unknown keys are dropped (the op schemas are strict); they are reported so a correction message can name them.
  for (const k of Object.keys(a)) if (!keys.includes(k)) { delete a[k]; fixes.push(`${n}: dropped unknown arg ${k}`); }
  return a;
}

/** Resolves a target the model wrote loosely: a bare id, an asset id shown by exactly one clip, a kind alias, extra keys. */
function normalizeTarget(t: unknown, opName: string, m: CompositionModelT, fixes: string[], n: string): Obj | undefined {
  const kinds = OPERATIONS[opName as keyof typeof OPERATIONS].targets;
  let id: string | undefined, kind: string | undefined, index: number | undefined;
  if (typeof t === 'string') id = t;
  else if (typeof t === 'number') index = t;
  else if (isObj(t)) { id = str(t['id']) ?? str(t['elementId']) ?? str(t['clipId']) ?? str(t['textId']); kind = str(t['kind']) ?? str(t['type']); const ix = t['index'] ?? t['cutIndex']; if (typeof ix === 'number') index = ix; }
  else return undefined;
  const KIND_ALIAS: Record<string, string> = { video: 'clip', scene: 'clip', title: 'text', subtitle: 'text', caption: 'caption', captions: 'caption', overlay: '', music: 'audio', voice: 'audio', sound: 'audio', transition: 'cut', logo: 'image', picture: 'image', photo: 'image' };
  if (kind && KIND_ALIAS[kind] !== undefined) kind = KIND_ALIAS[kind] || undefined;
  if (id !== undefined) {
    const found = m.tracks.video.some((c) => c.id === id) ? 'clip' : m.tracks.text.some((x) => x.id === id) ? 'text' : m.tracks.audio.some((x) => x.id === id) ? 'audio'
      : m.tracks.overlay.find((o) => o.id === id)?.kind;
    if (found) { if (kind !== found) { if (kind) fixes.push(`${n}: target kind ${kind} → ${found}`); kind = found; } }
    else {
      // An asset id where an element is meant: the one clip / layer / overlay that shows it (ambiguous → left as is).
      const clips = m.tracks.video.filter((c) => c.assetId === id), auds = m.tracks.audio.filter((x) => x.assetId === id), imgs = m.tracks.overlay.filter((o) => o.kind === 'image' && o.assetId === id);
      const cands = [...clips.map((c) => ['clip', c.id]), ...auds.map((x) => ['audio', x.id]), ...imgs.map((x) => ['image', x.id])].filter(([k]) => !kinds || kinds.includes(k as never));
      if (cands.length === 1) { fixes.push(`${n}: asset ${id} → ${cands[0]![0]} ${cands[0]![1]}`); kind = cands[0]![0]; id = cands[0]![1]; }
    }
  }
  if (!kind && kinds?.length === 1) kind = kinds[0];
  if (!kind) return { kind: kinds?.[0] ?? 'project', ...(id !== undefined ? { id } : {}), ...(index !== undefined ? { index } : {}) };
  return { kind, ...(id !== undefined && kind !== 'cut' ? { id } : {}), ...(index !== undefined ? { index } : {}) };
}

function normalizeOp(raw: unknown, m: CompositionModelT, fixes: string[], n: string): unknown {
  if (!isObj(raw)) return raw;
  let name = str(raw['op']) ?? str(raw['operation']) ?? str(raw['name']) ?? str(raw['type']);
  if (!name) return raw;
  if (!name.startsWith('op:')) { name = `op:${name}`; }
  if (!isOpName(name)) { const c = OP_LOWER.get(name.toLowerCase()) ?? OP_ALIASES[name] ?? OP_ALIASES[name.toLowerCase()]; if (c) { fixes.push(`${n}: ${name} → ${c}`); name = c; } }
  if (!isOpName(name)) return { ...raw, op: name };
  const top = Object.fromEntries(Object.entries(raw).filter(([k]) => !['op', 'operation', 'name', 'type', 'target', 'args', 'params', 'arguments', 'intentId', 'description', 'note', 'reason', 'id'].includes(k)));
  const argsIn = isObj(raw['args']) ? raw['args'] : isObj(raw['arguments']) ? raw['arguments'] : isObj(raw['params']) && !argKeysOf(name).includes('params') ? raw['params'] : {};
  const merged: Obj = { ...top, ...argsIn };
  if (isObj(raw['params']) && argKeysOf(name).includes('params') && argsIn !== raw['params']) merged['params'] = raw['params'];
  // A target smuggled into args.
  let tRaw: unknown = raw['target'];
  if (tRaw === undefined) for (const k of ['target', 'clipId', 'textId', 'elementId', 'audioId', 'shapeId', 'imageId', 'cutIndex', 'cut']) if (merged[k] !== undefined && !argKeysOf(name).includes(k)) {
    tRaw = k === 'cutIndex' || k === 'cut' ? { kind: 'cut', index: merged[k] } : k === 'target' ? merged[k] : { id: merged[k], kind: k.replace(/Id$/, '').replace('element', '') || undefined }; delete merged[k]; break;
  }
  const args = normalizeArgs(name, merged, fixes, n);
  const target = tRaw === undefined ? (OPERATIONS[name].targets?.length === 1 && ['project', 'sequence'].includes(OPERATIONS[name].targets![0]!) ? { kind: OPERATIONS[name].targets![0] } : undefined) : normalizeTarget(tRaw, name, m, fixes, n);
  return { op: name, ...(target ? { target } : {}), args, ...(typeof raw['intentId'] === 'string' ? { intentId: raw['intentId'] } : {}) };
}

const clip = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? (v.length > max ? `${v.slice(0, max - 1)}…` : v) : undefined);

/** Deterministic repair of a parsed model reply into the ModelPlanReply shape (or the intents it returned instead). */
export function normalizeModelReply(json: unknown, c: NormalizeContext): Normalized {
  const fixes: string[] = [];
  let j: unknown = json;
  if (Array.isArray(j)) j = j.every((x) => isObj(x) && ('op' in x || 'operation' in x)) ? { steps: [{ ops: j }] } : j.length === 1 ? j[0] : { steps: j };
  if (!isObj(j)) return { fixes, problem: 'Reply with ONE JSON object: {"goal", "steps": [...], "risks": [...]}.' };
  for (const k of ['plan', 'editPlan', 'EditPlan', 'edit_plan', 'result', 'data']) if (isObj(j[k]) && (j[k] as Obj)['steps'] !== undefined) { j = j[k]; fixes.push(`unwrapped ${k}`); break; }
  const o = j as Obj;
  if (o['steps'] === undefined && Array.isArray(o['ops'])) { o['steps'] = [{ ops: o['ops'], expectedDiff: o['expectedDiff'] }]; fixes.push('ops → one step'); }
  if (o['steps'] === undefined && Array.isArray(o['operations'])) { o['steps'] = [{ ops: o['operations'] }]; fixes.push('operations → one step'); }
  const intents = o['intents'] ?? o['proposedIntents'] ?? o['editIntents'];
  if (o['steps'] === undefined && Array.isArray(intents)) return { fixes, intents };
  const rawSteps = Array.isArray(o['steps']) ? o['steps'] : isObj(o['steps']) ? [o['steps']] : [];
  const steps = rawSteps.flatMap((s, i): Obj[] => {
    const n = `step ${i + 1}`;
    if (!isObj(s)) return [];
    // A step that is itself one op.
    const st: Obj = (s['op'] !== undefined && s['ops'] === undefined) ? { ops: [s] } : { ...s };
    let tool = str(st['tool']) ?? (st['ops'] !== undefined ? 'composition.applyOps' : undefined);
    if (tool && !(PLAN_STEP_TOOLS as readonly string[]).includes(tool)) { const t = TOOL_ALIASES[tool.toLowerCase()]; if (t) { fixes.push(`${n}: tool ${tool} → ${t}`); tool = t; } }
    tool ??= 'composition.applyOps';
    const ops = Array.isArray(st['ops']) ? st['ops'].map((op, k) => normalizeOp(op, c.model, fixes, `${n} op ${k + 1}`)) : [];
    const args = isObj(st['args']) ? st['args'] : isObj(st['input']) ? st['input'] : {};
    return [{ n: typeof st['n'] === 'number' && Number.isInteger(st['n']) && st['n'] >= 1 ? st['n'] : i + 1, tool, ops: tool === 'composition.applyOps' ? ops : [], args: tool === 'composition.applyOps' ? {} : args,
      expectedDiff: clip(st['expectedDiff'] ?? st['description'] ?? st['summary'], 200) ?? '', dependsOn: Array.isArray(st['dependsOn']) ? st['dependsOn'].filter((x) => Number.isInteger(x)) : [] }];
  });
  // Renumber when the model repeated or skipped numbers (dependsOn refer to the model's numbers; keep them when unique).
  const nums = steps.map((s) => s['n']);
  if (new Set(nums).size !== nums.length) steps.forEach((s, i) => { s['n'] = i + 1; });
  const goal = clip(o['goal'] ?? o['summary'] ?? o['reply'] ?? o['message'], 300) ?? clip(steps.find((s) => s['expectedDiff'])?.['expectedDiff'], 300) ?? (c.language === 'en' ? 'Edit plan' : 'Rencana edit');
  const risksIn = Array.isArray(o['risks']) ? o['risks'] : [];
  const risks = risksIn.flatMap((r) => typeof r === 'string' ? [{ code: 'note', message: r, severity: 'info' }]
    : isObj(r) ? [{ code: str(r['code']) ?? 'note', message: str(r['message']) ?? str(r['question']) ?? str(r['code']) ?? '', severity: ['info', 'warn', 'block'].includes(String(r['severity'])) ? r['severity'] : 'warn' }] : []);
  if (Array.isArray(o['questions']) && !risks.some((r) => r.code === 'needs-input')) for (const q of o['questions'].filter((x) => typeof x === 'string').slice(0, 1)) risks.push({ code: 'needs-input', message: q as string, severity: steps.length ? 'warn' : 'block' });
  if (o['baseVersion'] !== undefined && o['baseVersion'] !== c.baseVersion) fixes.push('baseVersion replaced by the runtime');
  return { value: { goal, steps, risks, baseVersion: c.baseVersion }, fixes };
}
