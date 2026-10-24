import { z } from 'zod';
import { canonicalJson, sha256Hex, ok, fail, issue, type Result } from '@expertmotion/shared';
import { ALL_PRESETS } from './presets.js';
import { AUDIO_RULES, COMPILE_RULES, type CompileRule } from './compile-defaults.js';
import type { Category, CatalogueRegistry, PresetDef, PresetId, Priority } from './types.js';

export * from './types.js';
export { COMPILE_RULES, AUDIO_RULES, type CompileRule } from './compile-defaults.js';
export { ALL_PRESETS } from './presets.js';

export const catalogue: CatalogueRegistry = (() => {
  const m = new Map<PresetId, PresetDef>();
  for (const p of ALL_PRESETS) { if (m.has(p.id)) throw new Error(`duplicate preset id ${p.id}`); m.set(p.id, p); }
  return m;
})();

/** Changes whenever any row changes (ids, priority, flags, defaults, labels): used as part of the API ETag. */
export const CATALOGUE_VERSION: string = sha256Hex(canonicalJson(ALL_PRESETS.map((p) => ({ id: p.id, l: p.label, p: p.priority, f: p.flags, d: p.defaults, c: p.propertyClass, x: p.data ?? null })))).slice(0, 16);

export const PRESET_ID_RE = /^preset:[a-z]+\.[a-z0-9-]+$/;
export const isPresetId = (v: unknown): v is PresetId => typeof v === 'string' && catalogue.has(v as PresetId);
export const getPreset = (id: string): PresetDef | undefined => catalogue.get(id as PresetId);

export type Tier = 'T0' | 'T1' | 'T2';
/** WebGPU presets are T2-only; `gpu` presets stay available on T0 (rendered with swangle, shown with a badge). */
export function availableOnTier(p: PresetDef, tier: Tier): boolean {
  if (p.flags.includes('licence:paid')) return false;
  if (p.flags.includes('webgpu')) return tier === 'T2';
  return true;
}

export function listPresets(filter: { category?: Category; priority?: Priority[]; tier?: Tier } = {}): PresetDef[] {
  return ALL_PRESETS.filter((p) => (!filter.category || p.category === filter.category)
    && (!filter.priority || filter.priority.includes(p.priority))
    && (!filter.tier || availableOnTier(p, filter.tier)));
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');
const stem = (w: string) => (w.length > 4 && w.endsWith('es') && !w.endsWith('ses') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);
/** Category words in both languages so "transisi halus" or "captions" find the right category. */
const CATEGORY_WORDS: Record<Category, string> = {
  transition: 'transition transisi peralihan', caption: 'caption subtitle teks takarir', background: 'background latar backdrop',
  motion: 'motion gerak animasi animation', shape: 'shape bentuk', easing: 'easing kecepatan speed curve', effect: 'effect efek filter',
  audio: 'audio musik music suara sound', text: 'text teks title judul', texteffect: 'text teks effect efek emphasis',
  font: 'font huruf typeface', palette: 'palette palet colour color warna', fontpair: 'font huruf pair pasangan',
};
/** DESIGN_CATALOGUE.md §13: labels + tags in both languages; every query word must match something; ranked by label hits. */
export function searchPresets(query: string, lang: 'en' | 'id' = 'en', category?: Category): PresetDef[] {
  const words = norm(query).split(/[^a-z0-9]+/).filter((w) => w.length > 1).map(stem);
  if (!words.length) return listPresets(category ? { category } : {});
  const scored: Array<{ p: PresetDef; score: number }> = [];
  for (const p of ALL_PRESETS) {
    if (category && p.category !== category) continue;
    const label = norm(lang === 'id' ? p.label.id : p.label.en), other = norm(lang === 'id' ? p.label.en : p.label.id);
    const hay = [label, other, p.category, CATEGORY_WORDS[p.category], ...p.tags.map(norm)].join(' ');
    if (!words.every((w) => hay.includes(w))) continue;
    scored.push({ p, score: words.reduce((s, w) => s + (label.includes(w) ? 3 : 0) + (p.category.startsWith(w) ? 2 : 0) + 1, 0) + (p.priority === 'p0' ? 0.5 : 0) });
  }
  return scored.sort((a, b) => b.score - a.score || a.p.id.localeCompare(b.p.id)).map((x) => x.p);
}

/**
 * DESIGN_CATALOGUE §13 suggested queries (FR-035): the search placeholder rotates through them and the suggestion list
 * shows them on focus; choosing one selects `category`'s tab and runs the query. Each returns ≥ 1 preset of `category`.
 */
export const SUGGESTED_QUERIES: ReadonlyArray<{ query: string; category: Category }> = Object.freeze([
  { query: 'smooth transition', category: 'transition' }, { query: 'karaoke captions', category: 'caption' }, { query: 'energetic motion', category: 'motion' },
  { query: 'calm background', category: 'background' }, { query: 'transisi halus', category: 'transition' }, { query: 'teks karaoke', category: 'caption' },
]);

export function presetParamsJsonSchema(id: PresetId): Record<string, unknown> {
  const p = catalogue.get(id);
  if (!p) throw new Error(`unknown preset ${id}`);
  return z.toJSONSchema(p.params as z.ZodType, { io: 'input' }) as Record<string, unknown>;
}

/** Used by CM-007 and intent validation: unknown id → EM-2101; params outside schema → EM-2102. Returns params with defaults applied. */
export function validateParams(id: string, params: unknown = {}): Result<Record<string, unknown>> {
  const p = getPreset(id);
  if (!p) return fail([issue('EM-2101', `Unknown design preset ${id}.`, 'block', 'presetId')]);
  const r = (p.params as z.ZodType).safeParse(params ?? {});
  if (!r.success) return fail(r.error.issues.map((i) => issue('EM-2102', i.message, 'block', ['params', ...i.path.map(String)].join('.'))));
  return ok(r.data as Record<string, unknown>);
}

export function compileRuleFor(id: string): CompileRule | undefined {
  const p = getPreset(id);
  if (!p) return undefined;
  return p.category === 'audio' ? AUDIO_RULES[p.id] : COMPILE_RULES[p.category];
}
export function compileDefaults(id: string): { op: string; args: Record<string, unknown>; requires: readonly string[] } | undefined {
  const p = getPreset(id); const rule = compileRuleFor(id);
  return p && rule ? { op: rule.op, args: rule.argsFrom(p), requires: rule.requires } : undefined;
}
