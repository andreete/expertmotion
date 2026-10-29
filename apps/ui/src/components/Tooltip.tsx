// Tooltips for every icon-only button and key control (FR-264; Operator 2026-10-29 "tooltip/help"). ONE delegated layer for
// the whole Editor instead of a wrapper per button: any element with `data-tip`, a `title`, or an icon-only button with an
// `aria-label` gets a small tooltip
//   • on hover after TIP_DELAY_MS, and AT ONCE on keyboard focus (focus-visible) — native `title` tooltips never show for the
//     keyboard and wait ~1 s;
//   • positioned below the control (above when there is no room), clamped inside the window, never covering the control;
//   • hidden on Escape, pointer leave, blur, scroll, a click and when the control disappears.
// The layer never changes the control's attributes: on HOVER an element with a native `title` keeps the browser's own tooltip
// (no double tooltip) and the layer shows only for `data-tip` / icon-only `aria-label` controls without one; on KEYBOARD focus
// (where browsers show nothing) it shows for every control. Text comes from the element (already translated by the caller).
import { useEffect, useRef, useState } from 'react';

export const TIP_DELAY_MS = 350;
export const TOOLTIP_ID = 'em-tooltip';
const SELECTOR = '[data-tip],[title],[data-tip-title],button[aria-label],[role="button"][aria-label],[role="tab"][aria-label],[role="switch"][aria-label]';

/** The tooltip text of an element (null = none): data-tip, else title, else the aria-label of a control without visible text. */
export function tipOf(el: Element): string | null {
  const tip = el.getAttribute('data-tip') ?? el.getAttribute('title') ?? el.getAttribute('data-tip-title');
  if (tip && tip.trim()) return tip.trim();
  const label = el.getAttribute('aria-label');
  const visible = (el.textContent ?? '').trim();
  if (label && (!visible || (visible.length <= 2 && !/[\p{L}\p{N}]/u.test(visible)))) return label.trim();   // an icon, or a glyph such as ×
  return null;
}
export function tipTarget(from: EventTarget | null): HTMLElement | null {
  const el = from instanceof Element ? from.closest(SELECTOR) : null;
  if (!(el instanceof HTMLElement) || el.closest('[data-no-tip]')) return null;
  return tipOf(el) ? el : null;
}
/** Where the tooltip goes for a control box and a tooltip size inside a viewport (pure; tested). */
export function placeTip(r: { left: number; top: number; width: number; height: number }, tip: { w: number; h: number }, vw: number, vh: number, gap = 6, margin = 8): { left: number; top: number; side: 'below' | 'above' } {
  const below = r.top + r.height + gap;
  const side: 'below' | 'above' = below + tip.h + margin <= vh || r.top - gap - tip.h < margin ? 'below' : 'above';
  const top = side === 'below' ? Math.min(below, vh - margin - tip.h) : r.top - gap - tip.h;
  const left = Math.max(margin, Math.min(r.left + r.width / 2 - tip.w / 2, vw - margin - tip.w));
  return { left: Math.round(left), top: Math.round(Math.max(margin, top)), side };
}

export function TooltipLayer() {
  const [tip, setTip] = useState<{ text: string; el: HTMLElement } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const cur = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const hide = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } if (!cur.current) return; cur.current = null; setTip(null); setPos(null); };
    const show = (el: HTMLElement) => {
      const text = tipOf(el);
      if (!text) return;
      cur.current = el;
      setTip({ text, el });
    };
    const later = (el: HTMLElement) => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => { timer.current = null; show(el); }, TIP_DELAY_MS); };
    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e.target);
      if (el === cur.current) return;
      if (!el || el.hasAttribute('title')) { hide(); return; }       // native title tooltip on hover
      hide(); later(el);
    };
    const out = (e: PointerEvent) => { const to = tipTarget(e.relatedTarget); if (to !== cur.current) hide(); };
    const focus = (e: FocusEvent) => {
      const el = tipTarget(e.target);
      if (!el) return;
      let visible = true;
      try { visible = el.matches(':focus-visible'); } catch { /* old engines: treat as keyboard */ }
      if (visible) { hide(); show(el); }
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && cur.current) hide(); };
    document.addEventListener('pointerover', over, true);
    document.addEventListener('pointerout', out, true);
    document.addEventListener('focusin', focus, true);
    document.addEventListener('focusout', hide, true);
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', over, true);
      document.removeEventListener('pointerout', out, true);
      document.removeEventListener('focusin', focus, true);
      document.removeEventListener('focusout', hide, true);
      document.removeEventListener('pointerdown', hide, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  useEffect(() => {
    if (!tip) return;
    if (!tip.el.isConnected) { setTip(null); return; }
    const r = tip.el.getBoundingClientRect();
    const b = box.current?.getBoundingClientRect();
    setPos(placeTip(r, { w: b?.width || Math.min(280, tip.text.length * 7 + 16), h: b?.height || 24 }, window.innerWidth, window.innerHeight));
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={box} id={TOOLTIP_ID} role="tooltip" data-el="sys.tooltip"
      className="pointer-events-none fixed z-[1000] max-w-[280px] rounded-[6px] border border-em-line bg-em-panel-2 px-2 py-1 text-[12px] leading-[16px] text-em-text"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, boxShadow: 'var(--sh-2)' }}>{tip.text}</div>
  );
}
