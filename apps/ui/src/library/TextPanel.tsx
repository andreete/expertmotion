// Text Panel (lib.text.*, Home mode): deterministic picks only (IX-03, IX-04). With a Text Layer selected the pick targets
// it (op:text.setStyle); with nothing selected it sets the Theme defaults for new text (op:theme.setTextDefaults, EM-2403).
import { useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Bold, Italic, Plus } from 'lucide-react';
import { getPreset, listPresets } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { Button, IconButton, Segmented, inputCls, cx } from '../components/ui.js';
import { CatalogueCard } from './Catalogue.js';
import { requestImport } from '../header/Header.js';

const SIZES = [34, 48, 64, 90, 110] as const;

export function TextPanel() {
  const { state, actions, t, lang } = useStore();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [textError, setTextError] = useState<string | null>(null);
  const [variant, setVariant] = useState('preset:text.title');
  const [customSize, setCustomSize] = useState('');
  const selText = state.selection.find((s) => s.kind === 'text');
  const selected = state.selection[0];
  const model = state.head?.model;
  const layer = selText ? model?.tracks.text.find((x) => x.id === selText.id) : undefined;
  const defaults = model?.theme.textDefaults;
  const cur = { fontFamily: layer?.style.fontFamily ?? defaults?.fontFamily, fontSize: layer?.style.fontSize ?? defaults?.fontSize, weight: layer?.style.weight ?? defaults?.weight, colour: layer?.style.colour ?? defaults?.colour, align: layer?.style.align ?? defaults?.align };
  const appliesNote = !selText && <p className="text-[11px] text-em-muted">{t('ui.lib.text.appliesnew')}</p>;
  const palette = getPreset(model?.theme.paletteId ?? 'preset:palette.editorial-dark')?.data ?? {};
  const swatches = (['text', 'accent', 'accent2', 'bg'] as const).map((k) => ({ key: k, hex: String(palette[k] ?? '#FFFFFF') }));
  const variants = listPresets({ category: 'text', priority: ['p0'] });
  const fonts = listPresets({ category: 'font' });
  const effects = listPresets({ category: 'texteffect', priority: ['p0'] });
  const ratio = model?.settings.ratio ?? '9:16';

  const submit = () => {
    const v = text.trim();
    if (!v) { setTextError(t('ui.lib.text.add.empty')); return; }
    if (v.length > 200) { setTextError(t('ui.lib.text.add.toolong')); return; }
    setTextError(null); setText(''); setAdding(false);
    void actions.addText(v, variant);
  };
  const row = (label: string, children: React.ReactNode, el?: string) => (
    <div data-el={el} className="flex flex-col gap-1.5 border-b border-em-line pb-3">
      <span className="t-label">{label}</span>{children}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 border-b border-em-line pb-3">
        <Button el="lib.text.add" variant="primary" icon={<Plus size={16} />} onClick={() => setAdding((a) => !a)} disabledReason={state.project ? null : t('ui.common.noproject')}>{t('ui.lib.text.add')}</Button>
        {adding && (
          <div className="flex flex-col gap-1.5">
            <input data-el="lib.text.add.input" autoFocus value={text} placeholder={t('ui.lib.text.add.placeholder')} aria-label={t('ui.lib.text.add.placeholder')} maxLength={500}
              onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); } }} className={cx(inputCls, textError && 'border-em-danger')} />
            {textError && <span role="alert" className="text-[12px] text-em-danger">{textError}</span>}
            <div className="flex gap-2"><Button el="lib.text.add.confirm" variant="primary" size={28} onClick={submit}>{t('ui.lib.text.add.confirm')}</Button>
              <button type="button" className="text-[12px] text-em-accent underline" onClick={() => { setAdding(false); actions.setLibMode('home'); window.dispatchEvent(new CustomEvent('em:ask-editor', { detail: { text: t('ui.lib.text.add.suggest.stem') } })); }}>{t('ui.lib.text.add.suggest')}</button></div>
          </div>
        )}
      </div>
      {row(t('ui.lib.text.variant'), (
        <Segmented label={t('ui.lib.text.variant')} cols={2} value={variant} onChange={setVariant}
          options={variants.map((v) => ({ value: v.id, label: v.label[lang], el: 'lib.text.variant' }))} />
      ))}
      {row(t('ui.lib.text.font'), (
        <select data-el="lib.text.font" aria-label={t('ui.lib.text.font')} className={inputCls} value={cur.fontFamily ?? ''} onChange={(e) => void actions.textPick({ fontFamily: e.target.value })}>
          <option value="">{t('ui.lib.text.font.theme')}</option>
          {fonts.map((f) => <option key={f.id} value={String(f.data?.['family'])} style={{ fontFamily: String(f.data?.['family']) }}>{f.label[lang]}</option>)}
        </select>
      ))}
      {row(t('ui.lib.text.size'), (
        <div data-el="lib.text.size" className="flex flex-col gap-1.5">
          <Segmented label={t('ui.lib.text.size')} value={SIZES.includes(cur.fontSize as (typeof SIZES)[number]) ? String(cur.fontSize) : null} onChange={(v) => void actions.textPick({ fontSize: Number(v) })} size="sm"
            options={SIZES.map((s) => ({ value: String(s), label: String(s), el: 'lib.text.size.preset' }))} />
          <input type="number" role="spinbutton" min={34} max={400} aria-label={t('a11y.lib.text.size')} aria-valuemin={34} aria-valuemax={400} aria-valuenow={Number(customSize) || cur.fontSize}
            placeholder={t('ui.lib.text.size.custom')} value={customSize} className={inputCls}
            onChange={(e) => setCustomSize(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { const n = Number(customSize); if (n >= 34 && n <= 400) void actions.textPick({ fontSize: n }); } }} />
          <p className="text-[11px] text-em-muted">{t('ui.lib.text.size.help')}</p>
        </div>
      ))}
      {row(t('ui.lib.text.weight'), (
        <div className="flex items-center gap-2">
          <IconButton el="lib.text.weight" label={t('ui.lib.text.bold')} icon={<Bold size={16} />} active={(cur.weight ?? 400) >= 700} onClick={() => void actions.textPick({ weight: (cur.weight ?? 400) >= 700 ? 400 : 800 })} />
          <IconButton el="lib.text.weight.italic" label={t('ui.lib.text.italic')} icon={<Italic size={16} />} disabledReason={t('ui.lib.text.italic.later')} />
          <input type="range" min={400} max={800} step={100} aria-label={t('ui.lib.text.weight')} value={cur.weight ?? 400} onChange={(e) => void actions.textPick({ weight: Number(e.target.value) })} className="flex-1 accent-[var(--em-accent)]" />
        </div>
      ))}
      {row(t('ui.lib.text.colour'), (
        <div data-el="lib.text.colour" role="radiogroup" aria-label={t('a11y.lib.text.colour')} className="flex items-center gap-1.5">
          {swatches.map((s) => (
            <button key={s.key} type="button" role="radio" aria-checked={cur.colour?.toUpperCase() === s.hex.toUpperCase()} aria-label={`${t(`ui.lib.text.colour.${s.key}`)} ${s.hex}`}
              onClick={() => void actions.textPick({ colour: s.hex })} className={cx('h-6 w-6 rounded-full border-2', cur.colour?.toUpperCase() === s.hex.toUpperCase() ? 'border-em-accent' : 'border-em-line')} style={{ background: s.hex }} />
          ))}
          <input type="color" aria-label={t('ui.lib.text.colour.custom')} className="h-6 w-8 bg-transparent" value={cur.colour ?? '#ffffff'} onChange={(e) => void actions.textPick({ colour: e.target.value.toUpperCase() })} />
        </div>
      ))}
      {row(t('ui.lib.text.align'), (
        <div data-el="lib.text.align" className="flex gap-1">
          {([['left', <AlignLeft key="l" size={16} />], ['center', <AlignCenter key="c" size={16} />], ['right', <AlignRight key="r" size={16} />]] as const).map(([a, icon]) => (
            <IconButton key={a} label={t(`ui.lib.text.align.${a}`)} icon={icon} active={cur.align === a} onClick={() => void actions.textPick({ align: a })} />
          ))}
        </div>
      ))}
      {appliesNote}
      {row(t('ui.lib.text.effect'), (
        <div className="grid grid-cols-2 gap-2">
          {effects.map((p) => <CatalogueCard key={p.id} preset={p} item={undefined} selected={false} compact />)}
        </div>
      ), 'lib.text.effect')}
      {row(t('ui.lib.text.opacity'), (
        <input data-el="lib.text.opacity" type="range" min={0} max={100} aria-label={t('ui.lib.text.opacity')} disabled={!selText} title={selText ? undefined : t('ui.lib.text.opacity.disabled')}
          defaultValue={Math.round((layer?.style.opacity ?? 1) * 100)} onMouseUp={(e) => void actions.textPick({ opacity: Number((e.target as HTMLInputElement).value) / 100 })}
          onKeyUp={(e) => void actions.textPick({ opacity: Number((e.target as HTMLInputElement).value) / 100 })} className="accent-[var(--em-accent)] disabled:opacity-40" />
      ))}
      <button type="button" data-el="lib.text.ratio" className="text-left text-em-text-2 hover:text-em-text" onClick={() => document.querySelector<HTMLElement>('[data-el^="agent.output.ratio."][aria-checked="true"]')?.focus()}>{t('ui.lib.text.ratio', { ratio })}</button>
      <button type="button" data-el="lib.text.videosize" className="text-left text-em-text-2 hover:text-em-text" onClick={() => document.querySelector<HTMLElement>('[data-el^="agent.output.resolution."][aria-checked="true"]')?.focus()}>{t('ui.lib.text.videosize', { resolution: model?.settings.resolution ?? '1080p' })}</button>
      <div className="flex gap-2">
        <Button el="lib.text.insert.image" onClick={() => requestImport('image/*')}>{t('ui.lib.text.insert.image')}</Button>
        <Button el="lib.text.insert.video" onClick={() => requestImport('video/*')}>{t('ui.lib.text.insert.video')}</Button>
      </div>
      {selected && <span className="sr-only">{selected.kind}</span>}
    </div>
  );
}
