import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { ALL_PRESETS, catalogue, CATALOGUE_VERSION, getPreset, listPresets, searchPresets, presetParamsJsonSchema,
  validateParams, compileDefaults, compileRuleFor, availableOnTier, isPresetId, type Category } from '../src/index.js';

const doc = (f: string) => fs.readFileSync(new URL(`../../../docs/${f}`, import.meta.url), 'utf8');
const catalogueDoc = doc('DESIGN_CATALOGUE.md');
const docIds = new Set([...catalogueDoc.matchAll(/`(preset:[a-z]+\.[a-z0-9-]+)`/g)].map((m) => m[1]!));
const opsDoc = new Set([...doc('AI_WORKFLOW.md').split('## 5.')[1]!.split('## 6.')[0]!.matchAll(/`(op:[a-z]+\.[a-zA-Z]+)`/g)].map((m) => m[1]!));

describe('registry matches docs/DESIGN_CATALOGUE.md exactly', () => {
  it('every documented id is in code', () => expect([...docIds].filter((id) => !catalogue.has(id as never))).toEqual([]));
  it('every code id is documented', () => expect(ALL_PRESETS.map((p) => p.id).filter((id) => !docIds.has(id))).toEqual([]));
  it('documented P0 counts (§12)', () => {
    const p0 = (c: Category) => listPresets({ category: c, priority: ['p0'] }).filter((p) => !p.id.endsWith('.none')).length;
    expect({ transition: p0('transition'), caption: p0('caption'), motion: p0('motion'), shape: p0('shape'), easing: p0('easing'), effect: p0('effect'), audio: p0('audio'), text: p0('text'), texteffect: p0('texteffect'), palette: p0('palette'), fontpair: p0('fontpair') })
      .toEqual({ transition: 6, caption: 3, motion: 5, shape: 4, easing: 5, effect: 6, audio: 3, text: 4, texteffect: 2, palette: 7, fontpair: 4 });
    // backgrounds: 5 + video-dim + none
    expect(listPresets({ category: 'background', priority: ['p0'] }).length).toBe(7);
  });
  it('priority and gpu/webgpu flags agree with the doc rows', () => {
    for (const p of ALL_PRESETS) {
      const row = catalogueDoc.split('\n').find((l) => l.startsWith(`| \`${p.id}\``));
      if (!row) continue;                                  // fonts/palettes are listed inline, not as rows
      expect(row.includes(`| ${p.priority.toUpperCase()} |`), `${p.id} priority`).toBe(true);
      expect(/\| gpu \|/.test(row), `${p.id} gpu flag`).toBe(p.flags.includes('gpu'));
      expect(/\| webgpu \|/.test(row), `${p.id} webgpu flag`).toBe(p.flags.includes('webgpu'));
    }
  });
});

describe('preset definitions', () => {
  it('defaults equal params.parse({}) and objects are frozen', () => {
    for (const p of ALL_PRESETS) {
      expect(p.params.parse({})).toEqual(p.defaults);
      expect(Object.isFrozen(p) && Object.isFrozen(p.defaults) && Object.isFrozen(p.tags)).toBe(true);
    }
  });
  it('labels exist in both languages', () => { for (const p of ALL_PRESETS) expect(p.label.en.length * p.label.id.length).toBeGreaterThan(0); });
  it('transition durations obey 100–2000 ms', () => {
    expect(validateParams('preset:transition.fade', { durationMs: 99 }).ok).toBe(false);
    expect(validateParams('preset:transition.fade', { durationMs: 2001 }).ok).toBe(false);
    expect(validateParams('preset:transition.fade', { durationMs: 750 })).toMatchObject({ ok: true, value: { durationMs: 750, timing: 'linear' } });
  });
  it('unknown preset → EM-2101; bad params → EM-2102 with path; unknown keys rejected', () => {
    expect(validateParams('preset:transition.cube')).toMatchObject({ ok: false, issues: [{ code: 'EM-2101' }] });
    const r = validateParams('preset:effect.greenscreen', { similarity: 0.9 });
    expect(r).toMatchObject({ ok: false, issues: [{ code: 'EM-2102', path: 'params.similarity' }] });
    expect(validateParams('preset:effect.blur', { radius: 3 }).ok).toBe(false);
  });
  it('palettes carry four colours from the book', () => {
    expect(getPreset('preset:palette.editorial-dark')!.data).toEqual({ bg: '#14120F', text: '#F4EFE6', accent: '#E8913A', accent2: '#4FD1A5' });
    for (const p of listPresets({ category: 'palette' })) for (const k of ['bg', 'text', 'accent', 'accent2']) expect(String(p.data?.[k])).toMatch(/^#[0-9A-F]{6}$/);
  });
  it('JSON schema is produced for the inspector form', () => {
    const js = presetParamsJsonSchema('preset:transition.slide') as { properties: Record<string, unknown> };
    expect(Object.keys(js.properties)).toEqual(expect.arrayContaining(['durationMs', 'timing', 'direction']));
  });
  it('version is stable and short', () => expect(CATALOGUE_VERSION).toMatch(/^[0-9a-f]{16}$/));
  it('isPresetId', () => { expect(isPresetId('preset:transition.fade')).toBe(true); expect(isPresetId('preset:transition.cube')).toBe(false); });
});

describe('tiers', () => {
  it('webgpu only on T2; gpu presets stay available on T0', () => {
    expect(availableOnTier(getPreset('preset:effect.sphere')!, 'T0')).toBe(false);
    expect(availableOnTier(getPreset('preset:effect.sphere')!, 'T2')).toBe(true);
    expect(availableOnTier(getPreset('preset:effect.vignette')!, 'T0')).toBe(true);
    expect(listPresets({ tier: 'T0' }).some((p) => p.flags.includes('webgpu'))).toBe(false);
  });
});

describe('search (§13)', () => {
  it('finds by English and Indonesian words', () => {
    expect(searchPresets('karaoke captions')[0]?.id).toBe('preset:caption.karaoke');
    expect(searchPresets('transisi halus', 'id').map((p) => p.id)).toContain('preset:transition.fade');
    expect(searchPresets('judul besar', 'id')[0]?.id).toBe('preset:text.title');
    expect(searchPresets('pudar', 'id', 'transition')[0]?.id).toBe('preset:transition.fade');
  });
  it('empty query lists the category; nonsense returns nothing', () => {
    expect(searchPresets('', 'en', 'shape').length).toBe(listPresets({ category: 'shape' }).length);
    expect(searchPresets('qwertyzzz')).toEqual([]);
  });
});

describe('Compile table (AI_WORKFLOW §7)', () => {
  it('every non-P2 preset has a rule whose operation exists in AI_WORKFLOW §5', () => {
    const missing = ALL_PRESETS.filter((p) => p.priority !== 'p2' && !compileRuleFor(p.id)).map((p) => p.id);
    expect(missing).toEqual([]);
    const unknownOps = ALL_PRESETS.map((p) => compileRuleFor(p.id)?.op).filter((op): op is string => !!op && !opsDoc.has(op));
    expect([...new Set(unknownOps)]).toEqual([]);
  });
  it('transition rule carries duration and timing at top level and direction in params', () => {
    expect(compileDefaults('preset:transition.slide')).toEqual({ op: 'op:transition.set', args: { presetId: 'preset:transition.slide', durationMs: 500, timing: 'linear', params: { direction: 'from-right' } }, requires: [] });
  });
  it('music bed requires an asset (needs interpretation without one)', () => expect(compileDefaults('preset:audio.bed-soft')?.requires).toContain('assetId'));
  it('text variants require text', () => expect(compileDefaults('preset:text.title')?.requires).toEqual(['text', 'atMs']));
  it('palettes and font pairs compile to op:theme.set', () => {
    expect(compileDefaults('preset:palette.neon-tech')).toMatchObject({ op: 'op:theme.set', args: { paletteId: 'preset:palette.neon-tech' } });
    expect(compileDefaults('preset:fontpair.inter-mono')).toMatchObject({ op: 'op:theme.set', args: { fontPairId: 'preset:fontpair.inter-mono' } });
  });
});

describe('suggested queries (FR-035, DESIGN_CATALOGUE §13)', () => {
  it('every suggestion finds at least one P0 preset of its category in EN or ID', async () => {
    const { SUGGESTED_QUERIES, searchPresets } = await import('../src/index.js');
    expect(SUGGESTED_QUERIES.length).toBeGreaterThanOrEqual(4);
    const empty = SUGGESTED_QUERIES.filter((s) => ![...searchPresets(s.query, 'en'), ...searchPresets(s.query, 'id')].some((p) => p.category === s.category && p.priority === 'p0'));
    expect(empty).toEqual([]);
  });
});
