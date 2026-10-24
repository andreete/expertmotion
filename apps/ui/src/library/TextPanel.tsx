// Text Panel (lib.text.*, Home mode): deterministic picks only (IX-03, IX-04). With a Text Layer selected the pick targets
// it (op:text.setStyle); with nothing selected it sets the Theme defaults for new text (op:theme.setTextDefaults, EM-2403).
// FR-020 font sample cards, FR-021 size presets 110/72/48/36 + 16–200, FR-022 Regular/Bold/Italic/Bold Italic, FR-023 hex +
// contrast hint, FR-025 variant on the selected layer, FR-026 effect queued without a selection, FR-027 Add Text placeholder,
// FR-028 opacity for Text, Shape and overlay image, FR-029/FR-030 Insert Image/Video import and then insert.
import { useEffect, useRef, useState } from 'react';
import { AlignCenter, AlignLeft, AlignRight, Plus } from 'lucide-react';
import { getPreset, listPresets } from '@expertmotion/catalogue';
import { useStore } from '../state/store.js';
import { Button, IconButton, Segmented, inputCls, cx } from '../components/ui.js';
import { CatalogueCard } from './Catalogue.js';
import { HEX_RE, MIN_CONTRAST, contrastRatio } from './contrast.js';

export const SIZE_PRESETS = [{ key: 'display', size: 110 }, { key: 'heading', size: 72 }, { key: 'body', size: 48 }, { key: 'small', size: 36 }] as const;
export const MIN_FONT_SIZE = 16, MAX_FONT_SIZE = 200;
const STYLES = [{ key: 'regular', weight: 400, italic: false }, { key: 'bold', weight: 800, italic: false }, { key: 'italic', weight: 400, italic: true }, { key: 'bolditalic', weight: 800, italic: true }] as const;
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif';
const VIDEO_ACCEPT = '.mp4,.mov,.webm,.mkv';

/** FR-029 / FR-030: import through the Asset Panel picker, then insert once ingest is ready. */
export const requestImportAndInsert = (accept: string, insert: 'overlay' | 'clip', atMs: number) =>
  window.dispatchEvent(new CustomEvent('em:import', { detail: { accept, insert, atMs } }));

export function TextPanel() {
  const { state, actions, t, lang } = useStore();
  const [variant, setVariant] = useState('preset:text.title');
  const [customSize, setCustomSize] = useState('');
  const [sizeError, setSizeError] = useState(false);
  const [hex, setHex] = useState('');
  const [content, setContent] = useState<string | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [focusContent, setFocusContent] = useState(false);
  const contentRef = useRef<HTMLInputElement>(null);
  const selText = state.selection.length === 1 ? state.selection.find((s) => s.kind === 'text') : undefined;
  const model = state.head?.model;
  const layer = selText ? model?.tracks.text.find((x) => x.id === selText.id) : undefined;
  const defaults = model?.theme.textDefaults;
  const vdata = (getPreset(layer?.variantId ?? '')?.data ?? {}) as Record<string, unknown>;
  const cur = {
    fontFamily: layer?.style.fontFamily ?? defaults?.fontFamily, fontSize: layer?.style.fontSize ?? (typeof vdata['fontSize'] === 'number' ? vdata['fontSize'] : defaults?.fontSize),
    weight: layer?.style.weight ?? (typeof vdata['weight'] === 'number' ? vdata['weight'] : defaults?.weight), italic: layer?.style.italic ?? defaults?.italic ?? false,
    colour: layer?.style.colour ?? defaults?.colour, align: layer?.style.align ?? defaults?.align,
  };
  const appliesNote = !selText && <p className="text-[11px] text-em-muted">{t('ui.lib.text.appliesnew')}</p>;
  const palette = getPreset(model?.theme.paletteId ?? 'preset:palette.editorial-dark')?.data ?? {};
  const swatches = (['text', 'accent', 'accent2', 'bg'] as const).map((k) => ({ key: k, hex: String(palette[k] ?? '#FFFFFF') }));
  const bgParam = model?.background?.params?.['colour'];
  const bg = typeof bgParam === 'string' && HEX_RE.test(bgParam) ? bgParam : String(palette['bg'] ?? '#000000');
  const variants = listPresets({ category: 'text', priority: ['p0'] });
  const fonts = listPresets({ category: 'font' });
  const effects = listPresets({ category: 'texteffect', priority: ['p0'] });
  const ratio = model?.settings.ratio ?? '9:16';
  // FR-028: opacity applies to the selected Text Layer, Shape or overlay image.
  const opSel = state.selection.find((s) => (s.kind === 'text' || s.kind === 'shape' || s.kind === 'image') && s.id);
  const opEl = opSel ? (opSel.kind === 'text' ? model?.tracks.text.find((x) => x.id === opSel.id) : model?.tracks.overlay.find((o) => o.id === opSel.id)) : undefined;
  const opValue = opEl ? ('style' in opEl ? opEl.style.opacity ?? defaults?.opacity ?? 1 : opEl.opacity ?? 1) : 1;
  const styleKey = STYLES.find((s) => s.italic === Boolean(cur.italic) && (s.weight >= 700) === ((cur.weight ?? 400) >= 700))?.key ?? null;
  const contrast = cur.colour ? contrastRatio(cur.colour, bg) : null;

  useEffect(() => { setContent(null); setContentError(null); }, [layer?.id]);
  useEffect(() => { if (focusContent && layer) { contentRef.current?.focus(); contentRef.current?.select(); setFocusContent(false); } }, [focusContent, layer]);

  const addText = async () => {
    const id = await actions.addText(t('ui.lib.text.add.default'), variant);
    if (id) setFocusContent(true);
  };
  const submitContent = () => {
    const v = (content ?? layer?.text ?? '').trim();
    if (!v) { setContentError(t('ui.lib.text.add.empty')); return; }
    if (v.length > 200) { setContentError(t('ui.lib.text.add.toolong')); return; }
    setContentError(null);
    if (v !== layer?.text) void actions.textPick({ content: v });
    setContent(null);
  };
  const applySize = () => {
    if (!customSize.trim()) return;
    const n = Number(customSize);
    if (!Number.isFinite(n) || n < MIN_FONT_SIZE || n > MAX_FONT_SIZE) { setSizeError(true); return; }
    setSizeError(false); setCustomSize('');
    void actions.textPick({ fontSize: Math.round(n) });
  };
  const applyHex = () => {
    const v = hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`;
    if (!HEX_RE.test(v)) return;
    setHex('');
    void actions.textPick({ colour: v.toUpperCase() });
  };
  const pickStyle = (key: string) => {
    const s = STYLES.find((x) => x.key === key); if (!s) return;
    const patch: Record<string, unknown> = {};
    if ((s.weight >= 700) !== ((cur.weight ?? 400) >= 700)) patch['weight'] = s.weight;
    if (s.italic !== Boolean(cur.italic)) patch['italic'] = s.italic;
    if (Object.keys(patch).length) void actions.textPick(patch);
  };
  const row = (label: string, children: React.ReactNode, el?: string) => (
    <div data-el={el} className="flex flex-col gap-1.5 border-b border-em-line pb-3">
      <span className="t-label">{label}</span>{children}
    </div>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 border-b border-em-line pb-3">
        <Button el="lib.text.add" variant="primary" icon={<Plus size={16} />} onClick={() => void addText()} disabledReason={state.project ? (model?.tracks.video.length ? null : t('err.EM-2202.title')) : t('ui.common.noproject')}>{t('ui.lib.text.add')}</Button>
        {layer && (
          <div className="flex flex-col gap-1.5">
            <label className="t-label" htmlFor="lib-text-content">{t('ui.lib.text.content')}</label>
            <input id="lib-text-content" ref={contentRef} data-el="lib.text.add.input" value={content ?? layer.text} placeholder={t('ui.lib.text.add.placeholder')} maxLength={500}
              onChange={(e) => setContent(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submitContent(); if (e.key === 'Escape') { e.stopPropagation(); setContent(null); } }}
              className={cx(inputCls, contentError && 'border-em-danger')} />
            {contentError && <span role="alert" className="text-[12px] text-em-danger">{contentError}</span>}
            <div className="flex gap-2"><Button el="lib.text.add.confirm" variant="primary" size={28} onClick={submitContent}>{t('ui.lib.text.add.confirm')}</Button>
              <button type="button" className="text-[12px] text-em-accent underline" onClick={() => { window.dispatchEvent(new CustomEvent('em:ask-editor', { detail: { text: t('ui.lib.text.add.suggest.stem') } })); }}>{t('ui.lib.text.add.suggest')}</button></div>
          </div>
        )}
      </div>
      {row(t('ui.lib.text.variant'), (
        <>
          <Segmented label={t('ui.lib.text.variant')} cols={2} value={layer?.variantId ?? variant} onChange={(v) => { if (layer) void actions.pick(v); else setVariant(v); }}
            options={variants.map((v) => ({ value: v.id, label: v.label[lang], el: 'lib.text.variant' }))} />
          {!layer && <p className="text-[11px] text-em-muted">{t('ui.lib.text.variant.fornew')}</p>}
        </>
      ))}
      {row(t('ui.lib.text.font'), (
        <div data-el="lib.text.font" role="radiogroup" aria-label={t('ui.lib.text.font')} className="grid grid-cols-2 gap-1.5">
          {fonts.map((f) => {
            const family = String(f.data?.['family']);
            const on = (cur.fontFamily ?? '') === family;
            return (
              <button key={f.id} type="button" role="radio" aria-checked={on} data-el="lib.text.font.sample" data-font={family} onClick={() => void actions.textPick({ fontFamily: family })}
                className={cx('flex flex-col items-start rounded-[6px] border px-2 py-1.5 text-left em-trans', on ? 'border-em-accent bg-em-panel-2' : 'border-em-line hover:border-em-line-strong')}>
                <span aria-hidden className="text-[20px] leading-6" style={{ fontFamily: `"${family}"`, fontWeight: 700 }}>{t('ui.lib.text.font.sample')}</span>
                <span className="text-[11px] text-em-muted">{f.label[lang]}</span>
              </button>
            );
          })}
        </div>
      ))}
      {row(t('ui.lib.text.size'), (
        <div data-el="lib.text.size" className="flex flex-col gap-1.5">
          <Segmented label={t('ui.lib.text.size')} value={SIZE_PRESETS.some((s) => s.size === cur.fontSize) ? String(cur.fontSize) : null} onChange={(v) => void actions.textPick({ fontSize: Number(v) })} size="sm"
            options={SIZE_PRESETS.map((s) => ({ value: String(s.size), label: t(`ui.lib.text.size.${s.key}`), sub: String(s.size), el: 'lib.text.size.preset' }))} />
          <input type="number" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} aria-label={t('a11y.lib.text.size')} aria-invalid={sizeError || undefined}
            placeholder={t('ui.lib.text.size.custom', { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE })} value={customSize} className={cx(inputCls, sizeError && 'border-em-danger')}
            onChange={(e) => { setCustomSize(e.target.value); setSizeError(false); }} onBlur={applySize} onKeyDown={(e) => { if (e.key === 'Enter') applySize(); }} />
          <p className={cx('text-[11px]', sizeError ? 'text-em-danger' : 'text-em-muted')} role={sizeError ? 'alert' : undefined}>{sizeError ? t('ui.lib.text.size.range', { min: MIN_FONT_SIZE, max: MAX_FONT_SIZE }) : t('ui.lib.text.size.help')}</p>
        </div>
      ))}
      {row(t('ui.lib.text.weight'), (
        <div data-el="lib.text.weight" className="flex flex-col gap-1.5">
          <Segmented label={t('ui.lib.text.weight')} cols={2} size="sm" value={styleKey} onChange={pickStyle}
            options={STYLES.map((s) => ({ value: s.key, label: t(`ui.lib.text.style.${s.key}`), el: `lib.text.weight.${s.key}` }))} />
          <input type="range" min={400} max={800} step={100} aria-label={t('ui.lib.text.weight.fine')} value={cur.weight ?? 400} onChange={(e) => void actions.textPick({ weight: Number(e.target.value) })} className="accent-[var(--em-accent)]" />
        </div>
      ))}
      {row(t('ui.lib.text.colour'), (
        <div className="flex flex-col gap-1.5">
          <div data-el="lib.text.colour" role="radiogroup" aria-label={t('a11y.lib.text.colour')} className="flex items-center gap-1.5">
            {swatches.map((s) => (
              <button key={s.key} type="button" role="radio" aria-checked={cur.colour?.toUpperCase() === s.hex.toUpperCase()} aria-label={`${t(`ui.lib.text.colour.${s.key}`)} ${s.hex}`}
                onClick={() => void actions.textPick({ colour: s.hex })} className={cx('h-6 w-6 rounded-full border-2', cur.colour?.toUpperCase() === s.hex.toUpperCase() ? 'border-em-accent' : 'border-em-line')} style={{ background: s.hex }} />
            ))}
            <input type="color" aria-label={t('ui.lib.text.colour.custom')} className="h-6 w-8 bg-transparent" value={cur.colour ?? '#ffffff'} onChange={(e) => void actions.textPick({ colour: e.target.value.toUpperCase() })} />
            <input data-el="lib.text.colour.hex" aria-label={t('ui.lib.text.colour.hex')} placeholder={cur.colour ?? '#RRGGBB'} value={hex} maxLength={7}
              aria-invalid={hex.trim() !== '' && !HEX_RE.test(hex.trim().startsWith('#') ? hex.trim() : `#${hex.trim()}`) ? true : undefined}
              onChange={(e) => setHex(e.target.value)} onBlur={applyHex} onKeyDown={(e) => { if (e.key === 'Enter') applyHex(); }} className={cx(inputCls, 't-mono h-7 w-[92px]')} />
          </div>
          {contrast !== null && contrast < MIN_CONTRAST && (
            <p data-el="lib.text.colour.contrast" role="status" className="text-[11px] text-em-warn">{t('ui.lib.text.colour.contrast.low', { ratio: contrast.toFixed(1) })}</p>
          )}
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
        <>
          <div className="grid grid-cols-2 gap-2">
            {effects.map((p) => <CatalogueCard key={p.id} preset={p} item={undefined} selected={Boolean(layer?.effect && layer.effect.presetId === p.id)} compact />)}
          </div>
          {!selText && <p className="text-[11px] text-em-muted">{t('ui.lib.text.effect.queued')}</p>}
        </>
      ), 'lib.text.effect')}
      {row(t('ui.lib.text.opacity'), (
        <span title={opSel ? undefined : t('ui.lib.text.opacity.disabled')} className="flex items-center gap-2">
          <input key={opSel?.id ?? 'none'} data-el="lib.text.opacity" type="range" min={0} max={100} aria-label={t('ui.lib.text.opacity')} disabled={!opSel}
            defaultValue={Math.round(opValue * 100)} onMouseUp={(e) => void actions.textPick({ opacity: Number((e.target as HTMLInputElement).value) / 100 })}
            onKeyUp={(e) => void actions.textPick({ opacity: Number((e.target as HTMLInputElement).value) / 100 })} className="flex-1 accent-[var(--em-accent)] disabled:opacity-40" />
          {!opSel && <span className="text-[11px] text-em-muted">{t('ui.lib.text.opacity.disabled')}</span>}
        </span>
      ))}
      <button type="button" data-el="lib.text.ratio" className="text-left text-em-text-2 hover:text-em-text" onClick={() => document.querySelector<HTMLElement>('[data-el^="agent.output.ratio."][aria-checked="true"]')?.focus()}>{t('ui.lib.text.ratio', { ratio })}</button>
      <button type="button" data-el="lib.text.videosize" className="text-left text-em-text-2 hover:text-em-text" onClick={() => document.querySelector<HTMLElement>('[data-el^="agent.output.resolution."][aria-checked="true"]')?.focus()}>{t('ui.lib.text.videosize', { resolution: model?.settings.resolution ?? '1080p' })}</button>
      <div className="flex gap-2">
        <Button el="lib.text.insert.image" onClick={() => requestImportAndInsert(IMAGE_ACCEPT, 'overlay', state.playheadMs)} disabledReason={state.project ? null : t('ui.common.noproject')}>{t('ui.lib.text.insert.image')}</Button>
        <Button el="lib.text.insert.video" onClick={() => requestImportAndInsert(VIDEO_ACCEPT, 'clip', state.playheadMs)} disabledReason={state.project ? null : t('ui.common.noproject')}>{t('ui.lib.text.insert.video')}</Button>
      </div>
    </div>
  );
}
