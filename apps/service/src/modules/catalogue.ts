// Catalogue module: R-120/R-121 (API_SPECIFICATION §6.12) from packages/catalogue with per-machine availability
// (Hardware Tier via hooks.tier, installed models via the Model Manager state).
import crypto from 'node:crypto';
import { z } from 'zod';
import { CATALOGUE_VERSION, availableOnTier, listPresets, presetParamsJsonSchema, searchPresets, type Category, type PresetDef, type Priority } from '@expertmotion/catalogue';
import type { ServiceModule } from './types.js';
import { route } from '../http/route.js';
import { modelsServiceOf } from '../s2/models-service.js';

const CATEGORIES = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio', 'text', 'texteffect', 'font', 'palette', 'fontpair'] as const;
const SUGGESTIONS = ['transisi halus', 'judul tebal', 'caption karaoke', 'latar gradasi', 'zoom pelan', 'musik santai', 'smooth transition', 'bold title'];

function availability(p: PresetDef, tier: 'T0' | 'T1' | 'T2', installedFlags: ReadonlySet<string>): { ok: boolean; reason?: 'gpu' | 'webgpu' | 'model-missing' | 'licence'; code?: string } {
  if (p.flags.includes('licence:paid')) return { ok: false, reason: 'licence', code: 'EM-2101' };
  if (!availableOnTier(p, tier)) return { ok: false, reason: 'webgpu', code: 'EM-2103' };
  const model = p.flags.find((f) => f.startsWith('model:'));
  if (model && !installedFlags.has(model)) return { ok: false, reason: 'model-missing', code: 'EM-2104' };
  if (p.flags.includes('gpu') && tier === 'T0') return { ok: true, reason: 'gpu', code: 'EM-2103' };
  return { ok: true };
}
const schemaCache = new Map<string, Record<string, unknown>>();   // small, static (derived from code, not media)
function item(p: PresetDef, tier: 'T0' | 'T1' | 'T2', flags: ReadonlySet<string>) {
  let paramsSchema = schemaCache.get(p.id);
  if (!paramsSchema) { paramsSchema = presetParamsJsonSchema(p.id); schemaCache.set(p.id, paramsSchema); }
  return { id: p.id, category: p.category, label: p.label, tags: [...p.tags], propertyClass: p.propertyClass, priority: p.priority, flags: [...p.flags],
    preview: p.preview, paramsSchema, defaults: p.defaults, availability: availability(p, tier, flags) };
}

export const catalogueModule: ServiceModule = {
  name: 'catalogue',
  register(router, ctx) {
    const state = async () => {
      const tier = ctx.hooks.tier();
      const flags = await modelsServiceOf(ctx).installedFlags();
      const etag = `"${CATALOGUE_VERSION}-${tier}-${crypto.createHash('sha256').update([...flags].sort().join(',')).digest('hex').slice(0, 12)}"`;
      return { tier, flags, etag };
    };
    // R-120
    route(router, 'get', '/catalogue', {
      query: z.object({ category: z.enum(CATEGORIES).optional(), priority: z.string().regex(/^(p[012])(,p[012])*$/).optional() }),
    }, async ({ query, req, res }) => {
      const { tier, flags, etag } = await state();
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
      const priority = (query.priority ?? 'p0').split(',') as Priority[];
      const items = listPresets({ ...(query.category ? { category: query.category as Category } : {}), priority }).map((p) => item(p, tier, flags));
      return { items, catalogueVersion: CATALOGUE_VERSION };
    });
    // R-121
    route(router, 'get', '/catalogue/search', {
      query: z.object({ q: z.string().max(200).default(''), category: z.enum(CATEGORIES).optional(), lang: z.enum(['en', 'id']).default('en') }),
    }, async ({ query }) => {
      const { tier, flags } = await state();
      if (query.q.trim() === '') return { items: [], suggestions: SUGGESTIONS };
      const found = searchPresets(query.q, query.lang, query.category as Category | undefined);
      return { items: found.map((p, i) => ({ ...item(p, tier, flags), score: Math.round((1 - i / Math.max(1, found.length)) * 1000) / 1000 })), catalogueVersion: CATALOGUE_VERSION };
    });
  },
};
