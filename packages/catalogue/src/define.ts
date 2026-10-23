import { z } from 'zod';
import type { Category, Flag, PresetDef, PresetId, Priority, PropertyClass } from './types.js';

const CLASS_BY_CATEGORY: Record<Category, PropertyClass> = {
  transition: 'exclusive-group', caption: 'exclusive-group', background: 'exclusive-group', motion: 'exclusive-group',
  shape: 'list', easing: 'scalar', effect: 'list', audio: 'list', text: 'exclusive-group', texteffect: 'exclusive-group',
  font: 'scalar', palette: 'scalar', fontpair: 'scalar',
};

export interface Row {
  name: string; en: string; id: string; p: Priority;
  flags?: Flag[]; params?: z.ZodRawShape; tags?: string[]; propertyClass?: PropertyClass; data?: Record<string, unknown>; preview?: boolean;
}

export function define(category: Category, common: z.ZodRawShape, rows: Row[]): PresetDef[] {
  return rows.map((r) => {
    const schema = z.object({ ...common, ...(r.params ?? {}) }).strict();
    const defaults = schema.parse({}) as Record<string, unknown>;
    const words = `${r.en} ${r.id} ${r.name.replace(/-/g, ' ')}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
    const def: PresetDef = {
      id: `preset:${category}.${r.name}` as PresetId,
      category,
      label: { en: r.en, id: r.id },
      tags: Object.freeze([...new Set([...words, ...(r.tags ?? [])])]),
      params: schema as unknown as PresetDef['params'],
      defaults: Object.freeze(defaults),
      propertyClass: r.propertyClass ?? CLASS_BY_CATEGORY[category],
      priority: r.p,
      flags: Object.freeze([...(r.flags ?? [])]),
      preview: r.preview === false ? '' : `catalogue/${category}/${r.name}.webm`,
      ...(r.data ? { data: Object.freeze({ ...r.data }) } : {}),
    };
    return Object.freeze(def);
  });
}

// Reusable parameter pieces (DESIGN_CATALOGUE.md §1 rule 5: ms, 0–1, hex, layout units u)
export const ms = (def: number, min = 0, max = 60_000) => z.number().int().min(min).max(max).default(def);
export const unit = (def: number) => z.number().min(0).max(1).default(def);
export const hex = (def: string) => z.string().regex(/^#[0-9A-Fa-f]{6}$/).default(def);
export const optionalHex = () => z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional();
export const easingRef = () => z.string().regex(/^preset:easing\.[a-z0-9-]+$/).optional();
export const direction = (def: 'from-left' | 'from-right' | 'from-top' | 'from-bottom') => z.enum(['from-left', 'from-right', 'from-top', 'from-bottom']).default(def);
