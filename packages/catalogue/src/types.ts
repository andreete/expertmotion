import type { z } from 'zod';
export type Category = 'transition' | 'caption' | 'background' | 'motion' | 'shape' | 'easing' | 'effect' | 'audio' | 'text' | 'texteffect' | 'font' | 'palette' | 'fontpair';
export type PresetId = `preset:${Category}.${string}`;
export type PropertyClass = 'scalar' | 'list' | 'exclusive-group';
export type Priority = 'p0' | 'p1' | 'p2';
export type Flag = 'gpu' | 'webgpu' | 'licence:paid' | `model:${string}`;
export interface PresetDef<P extends Record<string, unknown> = Record<string, unknown>> {
  id: PresetId;
  category: Category;
  label: { en: string; id: string };
  tags: readonly string[];
  /** Zod object schema; every field has a default, so `params.parse({})` yields `defaults`. */
  params: z.ZodType<P>;
  defaults: P;
  propertyClass: PropertyClass;
  priority: Priority;
  flags: readonly Flag[];
  /** Prerendered loop path relative to resources/ (ADR-011); empty for presets without a visual preview (font, palette, easing use generated swatches). */
  preview: string;
  /** Extra static data a preset needs (palette colours, font family names, easing function name). Never code. */
  data?: Readonly<Record<string, unknown>>;
}
export type CatalogueRegistry = ReadonlyMap<PresetId, PresetDef>;
