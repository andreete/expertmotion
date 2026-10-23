// ExecutionResult.diff rows (AI_WORKFLOW.md §3): which elements were added, removed or modified, and which fields.
import { canonicalJson } from '@expertmotion/shared';
import type { CompositionModelT } from './schema.js';

export interface ElementDiff { elementId: string; change: 'added' | 'removed' | 'modified'; fields: string[] }

function index(m: CompositionModelT): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  for (const c of m.tracks.video) map.set(c.id, c as unknown as Record<string, unknown>);
  for (const t of m.tracks.text) map.set(t.id, t as unknown as Record<string, unknown>);
  for (const o of m.tracks.overlay) map.set(o.id, o as unknown as Record<string, unknown>);
  for (const a of m.tracks.audio) map.set(a.id, a as unknown as Record<string, unknown>);
  for (const t of m.transitions) map.set(`cut:${t.cutIndex}`, t as unknown as Record<string, unknown>);
  map.set('project.settings', m.settings as unknown as Record<string, unknown>);
  map.set('project.theme', m.theme as unknown as Record<string, unknown>);
  map.set('project.caption', m.tracks.caption as unknown as Record<string, unknown>);
  map.set('project.background', (m.background ?? {}) as Record<string, unknown>);
  map.set('project.duration', { policy: m.durationPolicy, fixedMs: m.fixedDurationMs });
  map.set('sequence.order', { ids: m.tracks.video.map((c) => c.id) });
  return map;
}

export function diffModels(a: CompositionModelT, b: CompositionModelT): ElementDiff[] {
  const A = index(a), B = index(b), out: ElementDiff[] = [];
  for (const [id, x] of A) {
    const y = B.get(id);
    if (!y) { out.push({ elementId: id, change: 'removed', fields: [] }); continue; }
    const fields = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => canonicalJson(x[k] ?? null) !== canonicalJson(y[k] ?? null)).sort();
    if (fields.length) out.push({ elementId: id, change: 'modified', fields });
  }
  for (const id of B.keys()) if (!A.has(id)) out.push({ elementId: id, change: 'added', fields: [] });
  return out;
}
