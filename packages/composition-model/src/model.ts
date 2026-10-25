import { getPreset } from '@expertmotion/catalogue';
import { fail, issue, ok, sha256Canonical, type Result } from '@expertmotion/shared';
import { CompositionModel, type CompositionModelT, type ProjectSettingsT, type ThemeT } from './schema.js';
import { assignLanesV1 } from './layers.js';

export const DEFAULT_SETTINGS: ProjectSettingsT = Object.freeze({ fps: 30, ratio: '9:16', resolution: '1080p', autoRatio: true, language: 'id' }) as ProjectSettingsT;

export function defaultTheme(paletteId = 'preset:palette.editorial-dark'): ThemeT {
  const text = String(getPreset(paletteId)?.data?.['text'] ?? '#F4EFE6');
  return { paletteId, fontPairId: 'preset:fontpair.jakarta-inter', defaultEasingId: 'preset:easing.out-cubic',
    textDefaults: { fontSize: 64, weight: 700, colour: text, align: 'center', opacity: 1 } };
}

export function createEmptyModel(projectId: string, settings: Partial<ProjectSettingsT> = {}, theme?: ThemeT): CompositionModelT {
  return CompositionModel.parse({
    schemaVersion: 2, projectId, settings: { ...DEFAULT_SETTINGS, ...settings }, theme: theme ?? defaultTheme(),
    tracks: { video: [], overlay: [], text: [], caption: { styleId: null, params: {}, pages: [] }, audio: [] },
    transitions: [], background: null, durationPolicy: 'fit-content',
  });
}

/** composition_versions.hash and plan baseVersion (DATABASE_SCHEMA.md §4.5). */
export const hashModel = (model: CompositionModelT): string => sha256Canonical(model);

export const CURRENT_SCHEMA_VERSION = 2;
/** Lazy migration of stored JSON to the current schema (DATABASE_SCHEMA.md §5). MIGRATIONS[v] turns schema v into v + 1. */
const MIGRATIONS: Record<number, (json: Record<string, unknown>) => Record<string, unknown>> = {
  // ADR-027: v1 → v2 adds `layer` to texts/images/shapes and `lane` to audio layers, keeping the v1 picture (overlays under texts).
  1: (json) => ({ ...assignLanesV1(json), schemaVersion: 2 }),
};
export function migrateModel(json: unknown): Result<CompositionModelT> {
  if (!json || typeof json !== 'object') return fail([issue('EM-2001', 'Stored composition is not an object.', 'block', '')]);
  let cur = json as Record<string, unknown>;
  let v = Number(cur['schemaVersion']);
  if (!Number.isInteger(v) || v < 1) return fail([issue('EM-2001', `Unknown schemaVersion ${String(cur['schemaVersion'])}.`, 'block', 'schemaVersion')]);
  if (v > CURRENT_SCHEMA_VERSION) return fail([issue('EM-2001', `This project was saved by a newer Expertmotion (schema ${v}).`, 'block', 'schemaVersion')]);
  while (v < CURRENT_SCHEMA_VERSION) { const step = MIGRATIONS[v]; if (!step) return fail([issue('EM-2001', `No migration from schema ${v}.`, 'block', 'schemaVersion')]); cur = step(cur); v += 1; }
  const r = CompositionModel.safeParse(cur);
  return r.success ? ok(r.data) : fail(r.error.issues.map((i) => issue('EM-2001', i.message, 'block', i.path.join('.'))));
}
