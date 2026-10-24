// Inspector quick params (FR-098, P1): the few numbers a Creator tweaks most on the selected element — transition duration,
// motion duration / delay, effect intensity-like values — edited next to the inspector. Fields and ranges come from the
// preset's params schema (library/PresetParams.tsx presetFields); values are validated with validateParams before anything is
// sent (EM-2102 inline, no Composition Version). Apply is a fully specified Design Pick (Compile path, no LLM).
import { useEffect, useMemo, useState } from 'react';
import { getPreset, validateParams } from '@expertmotion/catalogue';
import type { CompositionModelT, ElementRefT } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import { Button, inputCls } from '../components/ui.js';
import { hasKey } from '../i18n/index.js';
import { presetFields } from '../library/PresetParams.js';

export interface QuickGroup { presetId: string; target: ElementRefT; current: Record<string, unknown>; fields: string[] }

const MOTION_FIELDS = ['durationMs', 'delayMs'];
/** Numeric params worth a quick field, per preset (every number except the transition easing / effect motion choices). */
function numericFields(presetId: string, only?: readonly string[]): string[] {
  const p = getPreset(presetId);
  if (!p) return [];
  return presetFields(p).filter((f) => (f.kind === 'number' || f.kind === 'integer') && (!only || only.includes(f.name))).map((f) => f.name);
}

/** The quick-param groups for one Timeline Element (exported for tests). */
export function quickGroups(model: CompositionModelT, ref: ElementRefT): QuickGroup[] {
  const out: QuickGroup[] = [];
  const motionOf = (target: ElementRefT, m: { presetId: string; durationMs: number; delayMs: number; easingId?: string | undefined; exit: boolean; params: Record<string, unknown> } | null | undefined) => {
    if (!m || m.presetId === 'preset:motion.none') return;
    const fields = numericFields(m.presetId, MOTION_FIELDS);
    if (fields.length) out.push({ presetId: m.presetId, target, current: { ...m.params, durationMs: m.durationMs, delayMs: m.delayMs, exit: m.exit, ...(m.easingId ? { easingId: m.easingId } : {}) }, fields });
  };
  if (ref.kind === 'cut' && ref.index !== undefined) {
    const tr = model.transitions.find((x) => x.cutIndex === ref.index);
    if (tr) { const fields = numericFields(tr.presetId, ['durationMs']); if (fields.length) out.push({ presetId: tr.presetId, target: ref, current: { ...tr.params, durationMs: tr.durationMs, timing: tr.timing }, fields }); }
  }
  if (ref.kind === 'clip' && ref.id) {
    const c = model.tracks.video.find((x) => x.id === ref.id);
    if (c) {
      motionOf(ref, c.motion);
      for (const e of c.effects) { const fields = numericFields(e.presetId); if (fields.length) out.push({ presetId: e.presetId, target: ref, current: { ...e.params, motion: e.motion }, fields }); }
    }
  }
  if (ref.kind === 'effect' && ref.id) {
    const [clipId, presetId] = ref.id.split('|');
    const e = model.tracks.video.find((c) => c.id === clipId)?.effects.find((x) => x.presetId === presetId);
    if (e && clipId) { const fields = numericFields(e.presetId); if (fields.length) out.push({ presetId: e.presetId, target: { kind: 'clip', id: clipId }, current: { ...e.params, motion: e.motion }, fields }); }
  }
  if (ref.kind === 'text' && ref.id) motionOf(ref, model.tracks.text.find((x) => x.id === ref.id)?.motion);
  if (ref.kind === 'shape' && ref.id) { const o = model.tracks.overlay.find((x) => x.id === ref.id); if (o?.kind === 'shape') motionOf(ref, o.motion); }
  return out;
}

export function QuickParams({ model, target }: { model: CompositionModelT; target: ElementRefT }) {
  const { actions, t, lang, state } = useStore();
  const groups = useMemo(() => quickGroups(model, target), [model, target]);
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const key = JSON.stringify(target);
  useEffect(() => { setValues({}); setErrors({}); }, [key, state.head?.hash]);
  if (!groups.length) return null;
  const label = (name: string) => (hasKey(`ui.lib.params.${name}`) ? t(`ui.lib.params.${name}`) : name);
  const apply = async () => {
    const picks: Array<{ g: QuickGroup; params: Record<string, unknown> }> = [];
    const errs: Record<string, string> = {};
    for (const g of groups) {
      const edits = values[g.presetId];
      if (!edits || !Object.keys(edits).length) continue;
      const merged: Record<string, unknown> = { ...g.current };
      for (const [k, v] of Object.entries(edits)) merged[k] = v.trim() === '' ? undefined : Number(v);
      const r = validateParams(g.presetId, merged);
      if (!r.ok) { for (const i of r.issues) errs[`${g.presetId}:${String(i.path ?? '').replace(/^params\./, '')}`] = `${i.message} · ${i.code}`; continue; }
      picks.push({ g, params: r.value });
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;                                   // FR-098: rejected inline, nothing sent, no version
    for (const p of picks) await actions.pick(p.g.presetId, { params: p.params, target: p.g.target });
    setValues({});
  };
  const dirty = Object.values(values).some((v) => Object.keys(v).length > 0);
  return (
    <div data-el="stage.timeline.quickparams" role="group" aria-label={t('ui.stage.timeline.quickparams')} className="flex flex-col gap-1.5 border-t border-em-line pt-2">
      <span className="t-label">{t('ui.stage.timeline.quickparams')}</span>
      {groups.map((g) => {
        const p = getPreset(g.presetId)!;
        const props = Object.fromEntries(presetFields(p).map((f) => [f.name, f.prop]));
        return (
          <div key={`${g.presetId}:${JSON.stringify(g.target)}`} className="flex flex-col gap-1">
            <span className="text-[11px] text-em-muted">{p.label[lang]}</span>
            {g.fields.map((name) => {
              const id = `em-quick-${g.presetId.replace(/\W/g, '-')}-${name}`;
              const err = errors[`${g.presetId}:${name}`];
              const prop = props[name];
              const shown = values[g.presetId]?.[name] ?? String(g.current[name] ?? prop?.default ?? '');
              return (
                <div key={name} className="grid grid-cols-[1fr_88px] items-center gap-x-2">
                  <label htmlFor={id} className="truncate text-[12px] text-em-text-2">{label(name)}</label>
                  <input id={id} type="number" data-el="stage.timeline.quickparams.field" data-param={name} data-preset-id={g.presetId} className={inputCls} value={shown}
                    min={prop?.minimum} max={prop?.maximum} step={name.endsWith('Ms') ? 50 : 'any'} aria-invalid={err ? true : undefined} aria-describedby={`${id}-hint`}
                    onChange={(e) => { const v = e.target.value; setValues((x) => ({ ...x, [g.presetId]: { ...(x[g.presetId] ?? {}), [name]: v } })); setErrors((x) => { const { [`${g.presetId}:${name}`]: _d, ...rest } = x; return rest; }); }}
                    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void apply(); }} />
                  <span id={`${id}-hint`} role={err ? 'alert' : undefined} className={err ? 'col-span-2 text-[11px] text-em-danger' : 'col-span-2 text-[10px] text-em-muted'}>
                    {err ?? (prop?.minimum !== undefined && prop.maximum !== undefined ? t('ui.lib.params.range', { min: prop.minimum, max: prop.maximum }) : '')}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
      <Button el="stage.timeline.quickparams.apply" size={28} disabledReason={dirty ? null : t('ui.stage.timeline.quickparams.nochange')} onClick={() => void apply()}>{t('ui.lib.params.apply')}</Button>
    </div>
  );
}
