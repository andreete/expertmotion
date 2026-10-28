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
  'op:caption.replace': 'op:caption.replaceText', 'op:captions.replaceText': 'op:caption.replaceText', 'op:caption.fix': 'op:caption.replaceText', 'op:caption.fixText': 'op:caption.replaceText',
  'op:caption.replaceWord': 'op:caption.replaceText', 'op:caption.editText': 'op:caption.replaceText', 'op:caption.correct': 'op:caption.replaceText',
  'op:caption.setText': 'op:caption.editPage', 'op:caption.setPageText': 'op:caption.editPage', 'op:caption.updatePage': 'op:caption.editPage', 'op:captions.editPage': 'op:caption.editPage',
  'op:caption.style': 'op:caption.setStyle', 'op:captions.setStyle': 'op:caption.setStyle', 'op:music.add': 'op:audio.addBed', 'op:audio.addMusic': 'op:audio.addBed', 'op:voice.add': 'op:audio.addLayer',
  'op:scene.create': 'op:scene.add', 'op:scene.insert': 'op:scene.add', 'op:scene.append': 'op:scene.add', 'op:scene.background': 'op:scene.setBackground',
  'op:effect.set': 'op:effect.add', 'op:motion.add': 'op:motion.set', 'op:motion.apply': 'op:motion.set', 'op:shape.create': 'op:shape.add', 'op:ratio.set': 'op:output.setRatio',
};
const OP_LOWER = new Map(Object.keys(OPERATIONS).map((n) => [n.toLowerCase(), n]));
const TOOL_ALIASES: Record<string, string> = {
  'composition.applyops': 'composition.applyOps', applyops: 'composition.applyOps', apply_ops: 'composition.applyOps', 'composition.apply': 'composition.applyOps', 'composition_applyops': 'composition.applyOps', composition: 'composition.applyOps',
  'tts.generate': 'tts.generate', tts: 'tts.generate', 'voice.generate': 'tts.generate', 'voiceover.generate': 'tts.generate', 'generate.voice': 'tts.generate', 'tts_generate': 'tts.generate',
  'scene.compose': 'scene.compose', 'scenes.compose': 'scene.compose', compose: 'scene.compose', 'scene_compose': 'scene.compose', 'video.compose': 'scene.compose', 'scene.composer': 'scene.compose',
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

/**
 * Where an op keeps a preset's params: [params arg, preset id arg, default preset id]. The preset's own schema (Design Catalogue)
 * decides which params exist; apply merges some op args into the params (transition durationMs / timing, shape size / fill).
 */
const PARAMS_ARG: Record<string, [string, string, string?]> = {
  'op:transition.set': ['params', 'presetId'], 'op:scene.add': ['backgroundParams', 'background', 'preset:background.gradient'], 'op:scene.setBackground': ['params', 'presetId'],
  'op:background.set': ['params', 'presetId'], 'op:text.setEffect': ['params', 'presetId'], 'op:caption.setStyle': ['params', 'presetId'], 'op:motion.set': ['params', 'presetId'],
  'op:effect.add': ['params', 'presetId'], 'op:effect.setParams': ['params', 'presetId'], 'op:shape.add': ['params', 'presetId'], 'op:audio.setDucking': ['params', 'presetId'],
};
type ZDef = { type: string; innerType?: unknown; entries?: Record<string, string>; checks?: Array<{ _zod: { def: { check: string; value?: unknown; format?: string; pattern?: RegExp } } }> };
const zdef = (s: unknown): ZDef => (s as { def: ZDef }).def;
const unwrap = (s: unknown): { inner: unknown; optional: boolean } => {
  let cur = s, optional = false;
  for (let i = 0; i < 5; i++) { const d = zdef(cur); if (d.type === 'optional' || d.type === 'default' || d.type === 'nullable') { optional = true; cur = d.innerType; } else break; }
  return { inner: cur, optional };
};
const keyNorm = (k: string) => k.toLowerCase().replace(/colou?r/g, 'colour').replace(/[^a-z0-9]/g, '');
/** The params shape of a preset (strict Zod object from the catalogue), or null. */
export function presetParamShape(presetId: unknown): Record<string, unknown> | null {
  const p = typeof presetId === 'string' ? getPreset(presetId) : undefined;
  return (p?.params as unknown as { shape?: Record<string, unknown> } | undefined)?.shape ?? null;
}
/**
 * Repairs one preset's params where the slip is unambiguous (AI_WORKFLOW §7.1): an unknown name that matches a known one up to
 * case / separators / colour spelling is renamed, otherwise dropped; numbers sent as strings are converted and clamped into the
 * allowed range; a near-miss enum value ("left" → "from-left", case) is mapped; #abc becomes #aabbcc. A value that still does
 * not fit is dropped only when the param is optional (the preset default applies). Everything is reported in `fixes`.
 */
export function repairPresetParams(presetId: unknown, params: Obj, fixes: string[], n: string, keep: readonly string[] = []): Obj {
  const shape = presetParamShape(presetId);
  if (!shape) return params;
  const known = Object.keys(shape);
  const out: Obj = {};
  // `color` / `colors: [a, b]` (live QA 2026-10-26, nemotron-3-ultra) where the preset has colourA / colourB: first and second colour.
  const src: Obj = { ...params };
  if (known.includes('colourA')) {
    const list = src['colors'] ?? src['colours'];
    if (Array.isArray(list) && src['colourA'] === undefined && src['colorA'] === undefined) {
      delete src['colors']; delete src['colours'];
      if (list[0] !== undefined) src['colourA'] = list[0];
      if (list[1] !== undefined && known.includes('colourB') && src['colourB'] === undefined && src['colorB'] === undefined) src['colourB'] = list[1];
      fixes.push(`${n}: param colors → colourA${list[1] !== undefined ? ', colourB' : ''}`);
    }
    for (const one of ['color', 'colour']) if (src[one] !== undefined && src['colourA'] === undefined) { src['colourA'] = src[one]; delete src[one]; fixes.push(`${n}: param ${one} → colourA`); }
  }
  for (const [k0, v0] of Object.entries(src)) {
    let k = k0;
    if (keep.includes(k)) { out[k] = v0; continue; }
    if (!known.includes(k)) {
      const m = known.find((x) => keyNorm(x) === keyNorm(k) || keyNorm(x) === keyNorm(k).replace(/1$/, 'a').replace(/2$/, 'b'));
      if (!m) { fixes.push(`${n}: dropped unknown param ${k} (${String(presetId)})`); continue; }
      fixes.push(`${n}: param ${k} → ${m}`); k = m;
    }
    const field = shape[k] as { safeParse: (v: unknown) => { success: boolean } };
    let v = v0;
    if (field.safeParse(v).success) { out[k] = v; continue; }
    const { inner, optional } = unwrap(field);
    const d = zdef(inner);
    if (d.type === 'number') {
      if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
      if (typeof v === 'number' && Number.isFinite(v)) {
        let lo = -Infinity, hi = Infinity, int = false;
        for (const c of d.checks ?? []) { const x = c._zod.def; if (x.check === 'greater_than') lo = Number(x.value); if (x.check === 'less_than') hi = Number(x.value); if (x.check === 'number_format') int = true; }
        const c = Math.min(hi, Math.max(lo, int ? Math.round(v) : v));
        if (c !== v0) fixes.push(`${n}: param ${k} ${String(v0)} → ${c}`);
        v = c;
      }
    } else if (d.type === 'enum' && typeof v === 'string') {
      const opts = Object.values(d.entries ?? {});
      const w = v.trim().toLowerCase().replace(/[\s_]+/g, '-');
      const hit = opts.find((o) => o === w) ?? opts.find((o) => o === `from-${w}`) ?? opts.find((o) => o.replace(/^from-/, '') === w.replace(/^(to|from)-/, ''));
      if (hit) { if (hit !== v) fixes.push(`${n}: param ${k} ${v} → ${hit}`); v = hit; }
    } else if (d.type === 'boolean' && (v === 'true' || v === 'false')) v = v === 'true';
    else if (d.type === 'string' && typeof v === 'string' && /^#?[0-9a-f]{3}$/i.test(v.trim())) { const h = v.trim().replace('#', ''); v = `#${[...h].map((c) => c + c).join('')}`; }
    else if (d.type === 'string' && typeof v === 'string' && /^[0-9a-f]{6}$/i.test(v.trim())) v = `#${v.trim()}`;
    if (field.safeParse(v).success) { out[k] = v; continue; }
    if (optional) { fixes.push(`${n}: dropped invalid param ${k}=${JSON.stringify(v0).slice(0, 40)} (${String(presetId)} default used)`); continue; }
    out[k] = v0;                                                       // required and still wrong: validation reports it
  }
  return out;
}

/** Arg name aliases valid for every op (only applied when the op knows the target name and not the alias). */
const COMMON_ARG_ALIASES: Record<string, string[]> = {
  atMs: ['startMs', 'start_ms', 'start', 'fromMs', 'at', 'timeMs', 'positionMs'], durationMs: ['duration', 'duration_ms', 'lengthMs', 'length'],
  presetId: ['preset', 'preset_id', 'presetID', 'style', 'transition', 'background'], assetId: ['asset', 'asset_id', 'assetID', 'media', 'mediaId'],
  text: ['content', 'value', 'caption', 'label', 'title'], variant: ['variantId', 'textVariant', 'type'], colour: ['color', 'fontColor', 'textColor', 'fontColour'], fontSize: ['size', 'font_size'],
  volume: ['level', 'gain'], rate: ['speed', 'playbackRate'], scale: ['zoom'], toIndex: ['index', 'position', 'to'], trimBeforeMs: ['trimStartMs', 'trimMs', 'offsetMs', 'trimBefore'],
  styleOverrides: ['style', 'styles'], fixedMs: ['durationMs', 'lengthMs'], easingId: ['easing'], title: ['heading', 'headline'],
  find: ['search', 'from', 'old', 'oldText', 'match', 'wrong', 'original'], replace: ['with', 'to', 'new', 'newText', 'replacement', 'correct', 'fixed'], pageIndex: ['page', 'index', 'pageNo'],
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
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()) && !['text', 'title', 'assetId', 'jobId', 'voiceId', 'find', 'replace'].includes(k)) { a[k] = Number(v); fixes.push(`${n}: ${k} number`); }
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
  // Preset params: params written at the op's top level move into the params object; then the params are repaired.
  const pa = PARAMS_ARG[opName];
  if (pa) {
    const [pk, idk, dflt] = pa;
    const pid = a[idk] ?? dflt;
    const shape = presetParamShape(pid);
    if (shape) {
      const loose = Object.keys(a).filter((k) => !keys.includes(k) && Object.keys(shape).includes(k));
      if (loose.length) { a[pk] = { ...(isObj(a[pk]) ? a[pk] as Obj : {}), ...Object.fromEntries(loose.map((k) => [k, a[k]])) }; loose.forEach((k) => delete a[k]); fixes.push(`${n}: ${loose.join(', ')} → ${pk}`); }
      // Args that apply merges into the params themselves are not the model's params (kept as is).
      const merged = opName === 'op:transition.set' ? ['durationMs', 'timing'] : opName === 'op:shape.add' ? ['size', 'fill', 'stroke', 'strokeWidth'] : [];
      if (isObj(a[pk])) { a[pk] = repairPresetParams(pid, a[pk] as Obj, fixes, n, merged); if (!Object.keys(a[pk] as Obj).length && opName !== 'op:effect.setParams') delete a[pk]; }
      else if (a[pk] !== undefined) { fixes.push(`${n}: dropped ${pk} (not an object)`); delete a[pk]; }
    }
  }
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

/** Step tool args (live QA 2026-10-26: captions.generate {stylePreset}): near-miss names renamed, unknown keys dropped. */
const STEP_ARGS: Record<string, { keys: string[]; alias: Record<string, string[]> }> = {
  'tts.generate': { keys: ['text', 'atMs', 'voiceId', 'language', 'speed'], alias: { text: ['script', 'content', 'narration', 'voiceover', 'voiceOver'], voiceId: ['voice'], atMs: ['startMs', 'start'], language: ['lang'], speed: ['rate'] } },
  'captions.generate': { keys: ['source', 'text', 'atMs', 'durationMs', 'presetId', 'language'], alias: { presetId: ['stylePreset', 'style', 'styleId', 'captionStyle', 'preset', 'stylePresetId'], text: ['script', 'content', 'captionText'], atMs: ['startMs', 'start'], durationMs: ['duration'], language: ['lang'] } },
};
function normalizeStepArgs(tool: string, raw: Obj, fixes: string[], n: string): Obj {
  const spec = STEP_ARGS[tool];
  if (!spec) return raw;
  const a: Obj = { ...raw };
  for (const k of spec.keys) {
    if (a[k] !== undefined) continue;
    for (const al of spec.alias[k] ?? []) if (a[al] !== undefined) { a[k] = a[al]; delete a[al]; fixes.push(`${n}: ${al} → ${k}`); break; }
  }
  if (tool === 'captions.generate' && a['presetId'] !== undefined) { const f = presetFix(a['presetId'], 'caption'); if (f !== a['presetId']) { fixes.push(`${n}: ${String(a['presetId'])} → ${String(f)}`); a['presetId'] = f; } }
  for (const k of Object.keys(a)) if (!spec.keys.includes(k) && !['status', 'modelKey', 'modelLabel'].includes(k)) { delete a[k]; fixes.push(`${n}: dropped unknown arg ${k}`); }
  return a;
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
    // ADR-034: a scene.compose step whose VideoSpec was written next to tool / n instead of inside args
    const specInline = tool === 'scene.compose' && !isObj(st['args']) && Array.isArray(st['scenes']) ? Object.fromEntries(Object.entries(st).filter(([k]) => !['n', 'tool', 'ops', 'expectedDiff', 'dependsOn', 'description', 'summary'].includes(k))) : undefined;
    if (specInline) fixes.push(`${n}: VideoSpec moved into args`);
    const args = tool === 'composition.applyOps' ? {} : normalizeStepArgs(tool, isObj(st['args']) ? st['args'] : isObj(st['input']) ? st['input'] : specInline ?? {}, fixes, n);
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
