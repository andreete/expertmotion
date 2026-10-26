// ADR-028 / FR-180: Inspector numeric controls for the picture of the selected clip, image or shape — X / Y (% of the frame),
// Scale (%), Rotation (°), Fit / Fill / Reset and quick align (centre, top, bottom, left, right). The keyboard alternative to the
// Player handles. Every change is one op:element.setTransform pick with all four values (Compile path, no LLM, undoable).
import { useEffect, useState } from 'react';
import { AlignCenter, ArrowDownToLine, ArrowLeftToLine, ArrowRightToLine, ArrowUpToLine } from 'lucide-react';
import type { CompositionModelT, ElementRefT } from '@expertmotion/composition-model';
import { useStore } from '../state/store.js';
import { Button, IconButton, inputCls } from '../components/ui.js';
import { alignXf, canvasItemOf, fitXf, IDENTITY, sameXf, transformEditOf, type Align, type Xf } from './canvas-transform.js';

const r1 = (v: number) => Math.round(v * 10) / 10;
function NumField({ el, label, value, unit, min, max, onCommit }: { el: string; label: string; value: number; unit: string; min: number; max: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const v = Number(draft.replace(',', '.'));
    if (!Number.isFinite(v) || draft.trim() === '') { setDraft(String(value)); return; }
    const c = Math.max(min, Math.min(max, v));
    setDraft(String(c));
    if (c !== value) onCommit(c);
  };
  return (
    <label className="flex items-center gap-1 text-[12px]">
      <span className="w-14 shrink-0 text-em-muted">{label}</span>
      <input data-el={el} type="text" inputMode="decimal" aria-label={label} value={draft} className={`${inputCls} h-7 w-16 px-1 text-right`}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') { e.stopPropagation(); setDraft(String(value)); } }} />
      <span className="text-em-muted">{unit}</span>
    </label>
  );
}

const ALIGN_ICON: Record<Align, typeof AlignCenter> = { center: AlignCenter, top: ArrowUpToLine, bottom: ArrowDownToLine, left: ArrowLeftToLine, right: ArrowRightToLine };

export function TransformFields({ model, target }: { model: CompositionModelT; target: ElementRefT }) {
  const { t, state, actions } = useStore();
  const item = canvasItemOf(model, target, (id) => { const a = state.assets.find((x) => x.id === id); return a ? { width: a.width, height: a.height } : null; });
  if (!item) return null;
  const xf = item.xf;
  const L = (k: string) => t(`ui.stage.timeline.inspector.transform.${k}`);
  const send = (next: Xf, what: string) => { if (!sameXf(next, xf)) void actions.transformEdit(transformEditOf(item, next), t('ui.stage.timeline.inspector.transform.done', { what })); };
  return (
    <section data-el="stage.timeline.inspector.transform" aria-label={L('title')} className="flex flex-col gap-1 rounded-[6px] border border-em-line p-1.5">
      <span className="t-label">{L('title')}</span>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        <NumField el="stage.timeline.inspector.transform.x" label={L('x')} unit="%" value={r1(xf.x * 100)} min={-200} max={200} onCommit={(v) => send({ ...xf, x: v / 100 }, L('x'))} />
        <NumField el="stage.timeline.inspector.transform.y" label={L('y')} unit="%" value={r1(xf.y * 100)} min={-200} max={200} onCommit={(v) => send({ ...xf, y: v / 100 }, L('y'))} />
        <NumField el="stage.timeline.inspector.transform.scale" label={L('scale')} unit="%" value={r1(xf.scale * 100)} min={item.scaleMin * 100} max={item.scaleMax * 100} onCommit={(v) => send({ ...xf, scale: v / 100 }, L('scale'))} />
        <NumField el="stage.timeline.inspector.transform.rotation" label={L('rotation')} unit="°" value={r1(xf.rotation)} min={-360} max={360} onCommit={(v) => send({ ...xf, rotation: v }, L('rotation'))} />
      </div>
      <div className="flex flex-wrap gap-1">
        <Button el="stage.timeline.inspector.transform.fit" size={28} onClick={() => send(fitXf(item, 'fit', xf), L('fit'))}>{L('fit')}</Button>
        <Button el="stage.timeline.inspector.transform.fill" size={28} onClick={() => send(fitXf(item, 'fill', xf), L('fill'))}>{L('fill')}</Button>
        <Button el="stage.timeline.inspector.transform.reset" size={28} variant="ghost" disabledReason={sameXf(xf, IDENTITY) ? L('reset.none') : null} onClick={() => send(IDENTITY, L('reset'))}>{L('reset')}</Button>
      </div>
      <div role="group" aria-label={L('align')} className="flex gap-0.5">
        {(['center', 'top', 'bottom', 'left', 'right'] as const).map((a) => { const I = ALIGN_ICON[a]; return (
          <IconButton key={a} el="stage.timeline.inspector.transform.align" data-align={a} size={28} label={L(`align.${a}`)} icon={<I size={14} />} onClick={() => send(alignXf(item, a, xf), L(`align.${a}`))} />
        ); })}
      </div>
    </section>
  );
}
