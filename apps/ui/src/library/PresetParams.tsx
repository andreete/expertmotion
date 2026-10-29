// Catalogue Card ⓘ "Details" (UI_UX_SPECIFICATION.md §11.1 CMP-04): the preset's parameters with their defaults
// (packages/catalogue presetParamsJsonSchema + preset.defaults), editable before the pick. "Apply with these settings" sends
// a fully specified Design Pick (R-060 `params`), so it is still the Compile path. Focus is trapped; Esc closes.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { floatingLayer } from '../components/Layer.js';
import { X } from 'lucide-react';
import { listPresets, presetParamsJsonSchema, validateParams, type PresetDef } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { Button, IconButton, inputCls } from '../components/ui.js';
import { hasKey } from '../i18n/index.js';

interface Prop { type?: string; enum?: unknown[]; default?: unknown; minimum?: number; maximum?: number; pattern?: string; anyOf?: Array<{ const?: unknown; type?: string }> }
type FieldKind = 'number' | 'integer' | 'boolean' | 'enum' | 'colour' | 'preset' | 'text';

export function fieldKind(p: Prop): FieldKind {
  if (p.enum || p.anyOf?.every((a) => a.const !== undefined)) return 'enum';
  if (p.type === 'boolean') return 'boolean';
  if (p.type === 'integer') return 'integer';
  if (p.type === 'number') return 'number';
  if (p.pattern?.includes('#[0-9A-Fa-f]{6}')) return 'colour';
  if (p.pattern?.startsWith('^preset:')) return 'preset';
  return 'text';
}
const humanize = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Parameters of a preset in schema order with their kind (exported for tests). */
export function presetFields(preset: PresetDef): Array<{ name: string; prop: Prop; kind: FieldKind }> {
  const js = presetParamsJsonSchema(preset.id) as { properties?: Record<string, Prop> };
  return Object.entries(js.properties ?? {}).map(([name, prop]) => ({ name, prop, kind: fieldKind(prop) }));
}

export function PresetParams({ preset, anchor, onClose, disabledReason }: { preset: PresetDef; anchor: HTMLElement | null; onClose: () => void; disabledReason: string | null }) {
  const { actions, t, lang } = useStore();
  const fields = presetFields(preset);
  const [values, setValues] = useState<Record<string, unknown>>({ ...preset.defaults });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 80, left: 320 });
  const ref = useRef<HTMLDivElement>(null);
  const label = (k: string, fallback: string) => (hasKey(k) ? t(k) : fallback);
  const title = t('ui.lib.params.title', { preset: preset.label[lang] });

  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    const h = ref.current?.offsetHeight ?? 320, w = 300;
    if (!r) return;
    const left = r.right + 8 + w <= window.innerWidth - 8 ? r.right + 8 : Math.max(8, r.left - w - 8);
    setPos({ top: Math.max(8, Math.min(r.top - 8, window.innerHeight - h - 8)), left });
  }, [anchor]);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    (ref.current?.querySelector<HTMLElement>('[data-el="lib.catalogue.params.field"]') ?? ref.current?.querySelector<HTMLElement>('button'))?.focus();
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node) && !anchor?.contains(e.target as Node)) closeRef.current(); };
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('mousedown', onDown); anchor?.focus(); };   // focus returns to ⓘ
  }, [anchor]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();                                    // keep Space/arrows away from the Player shortcuts
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const set = (name: string, v: unknown) => { setValues((x) => { const n = { ...x }; if (v === undefined) delete n[name]; else n[name] = v; return n; }); setErrors((x) => { const { [name]: _d, ...rest } = x; return rest; }); };
  const apply = () => {
    const r = validateParams(preset.id, values);
    if (!r.ok) {
      setErrors(Object.fromEntries(r.issues.map((i) => [String(i.path ?? '').replace(/^params\./, ''), i.message])));
      return;
    }
    onClose();
    void actions.pick(preset.id, { params: r.value });
  };
  const options = (prefix: string) => listPresets().filter((p) => p.id.startsWith(prefix) && p.priority === 'p0');

  return createPortal(
    <div ref={ref} data-el="lib.catalogue.params" role="dialog" aria-modal="true" aria-label={title} onKeyDown={onKey}
      className="pointer-events-auto fixed flex max-h-[80vh] w-[300px] flex-col rounded-[8px] border border-em-line bg-em-panel text-em-text" style={{ ...pos, boxShadow: 'var(--sh-2)' }}>
      <div className="flex items-center gap-2 border-b border-em-line px-3 py-2">
        <span className="flex-1 font-semibold">{title}</span>
        <IconButton label={t('ui.common.close')} icon={<X size={14} />} size={28} onClick={onClose} />
      </div>
      <div className="flex flex-col gap-2 overflow-y-auto px-3 py-2">
        {fields.length === 0 && <p className="text-em-muted">{t('ui.lib.params.none')}</p>}
        {fields.map(({ name, prop, kind }) => {
          const id = `em-param-${preset.id.replace(/\W/g, '-')}-${name}`;
          const v = values[name];
          const def = prop.default;
          const common = { id, 'data-el': 'lib.catalogue.params.field', 'data-param': name, 'aria-invalid': errors[name] ? true : undefined, 'aria-describedby': `${id}-hint` } as const;
          const choices = prop.enum ?? prop.anyOf?.map((a) => a.const) ?? [];
          return (
            <div key={name} className="flex flex-col gap-0.5">
              <label htmlFor={id} className="text-[12px] font-medium text-em-text-2">{label(`ui.lib.params.${name}`, humanize(name))}</label>
              {kind === 'boolean' ? <input type="checkbox" {...common} checked={Boolean(v)} onChange={(e) => set(name, e.target.checked)} className="h-4 w-4" />
                : kind === 'enum' ? (
                  <select {...common} className={inputCls} value={String(v ?? '')} onChange={(e) => { const c = choices.find((x) => String(x) === e.target.value); set(name, c); }}>
                    {choices.map((c) => <option key={String(c)} value={String(c)}>{label(`ui.lib.params.value.${String(c)}`, humanize(String(c)))}</option>)}
                  </select>
                ) : kind === 'preset' ? (
                  <select {...common} className={inputCls} value={String(v ?? '')} onChange={(e) => set(name, e.target.value || undefined)}>
                    <option value="">{t('ui.lib.params.default')}</option>
                    {options(prop.pattern!.slice(1).split('\\.')[0]!).map((p) => <option key={p.id} value={p.id}>{p.label[lang]}</option>)}
                  </select>
                ) : kind === 'number' || kind === 'integer' ? (
                  <input type="number" {...common} className={inputCls} value={v === undefined ? '' : String(v)} min={prop.minimum} max={prop.maximum} step={kind === 'integer' ? 1 : 'any'}
                    onChange={(e) => set(name, e.target.value === '' ? undefined : Number(e.target.value))} />
                ) : (
                  <input type="text" {...common} className={inputCls} value={String(v ?? '')} placeholder={kind === 'colour' ? t('ui.lib.params.colour.placeholder') : ''} onChange={(e) => set(name, e.target.value || undefined)} />
                )}
              <span id={`${id}-hint`} className={errors[name] ? 'text-[11px] text-em-danger' : 'text-[11px] text-em-muted'}>
                {errors[name] ?? [def !== undefined ? t('ui.lib.params.defaultvalue', { value: String(def) }) : t('ui.lib.params.optional'), prop.minimum !== undefined && prop.maximum !== undefined ? t('ui.lib.params.range', { min: prop.minimum, max: prop.maximum }) : ''].filter(Boolean).join(' · ')}
              </span>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-2 border-t border-em-line px-3 py-2">
        <Button el="lib.catalogue.params.reset" size={28} variant="ghost" onClick={() => { setValues({ ...preset.defaults }); setErrors({}); }}>{t('ui.lib.params.reset')}</Button>
        <span className="flex-1" />
        <Button el="lib.catalogue.params.apply" size={28} variant="primary" disabledReason={disabledReason} onClick={apply}>{t('ui.lib.params.apply')}</Button>
      </div>
    </div>,
    floatingLayer(),                                         // QA P1 2026-10-29: the one floating layer above banners and dividers
  );
}
