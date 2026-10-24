// Panel divider (EDITOR_INTERACTION_MODEL.md §9 "Dividers"): 6 px hit area with a 1 px line, drag to resize, focusable
// role="separator" with aria-valuenow/min/max, arrow keys by 16 px, Home/End to the range ends, double-click resets.
import { useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { LAYOUT } from '../layout.js';
import { cx } from './ui.js';

export interface SplitterProps {
  el: string;
  /** 'vertical' splits columns (moves left/right); 'horizontal' splits rows (moves up/down). */
  orientation: 'vertical' | 'horizontal';
  value: number; min: number; max: number; label: string;
  /** true when the sized panel is on the right/bottom of the divider, so moving left/up grows it. */
  invert?: boolean;
  /** Raw (unclamped) size while dragging or after a key press; `commit` is true when the change should be persisted. */
  onChange: (size: number, commit: boolean) => void;
  onReset: () => void;
}

export function Splitter({ el, orientation, value, min, max, label, invert, onChange, onReset }: SplitterProps) {
  const drag = useRef<{ start: number; size: number; last: number } | null>(null);
  const vertical = orientation === 'vertical';
  const sign = invert ? -1 : 1;
  const onMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = vertical ? e.clientX : e.clientY;
    drag.current = { start, size: value, last: value };
    const move = (ev: globalThis.MouseEvent) => {
      const d = drag.current; if (!d) return;
      d.last = d.size + sign * ((vertical ? ev.clientX : ev.clientY) - d.start);
      onChange(d.last, false);
    };
    const up = () => {
      const d = drag.current; drag.current = null;
      window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
      document.body.style.removeProperty('cursor');
      if (d) onChange(d.last, true);
    };
    document.body.style.cursor = vertical ? 'col-resize' : 'row-resize';
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = vertical ? (invert ? 'ArrowLeft' : 'ArrowRight') : (invert ? 'ArrowUp' : 'ArrowDown');
    const shrink = vertical ? (invert ? 'ArrowRight' : 'ArrowLeft') : (invert ? 'ArrowDown' : 'ArrowUp');
    let next: number | null = null;
    if (e.key === grow) next = Math.min(max, value + LAYOUT.keyStep);
    else if (e.key === shrink) next = Math.max(min, value - LAYOUT.keyStep);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onReset(); return; }
    if (next === null) return;
    e.preventDefault(); e.stopPropagation();               // arrows must not step the Player (global shortcuts)
    onChange(next, true);
  };
  return (
    <div data-el={el} role="separator" tabIndex={0} aria-orientation={vertical ? 'vertical' : 'horizontal'} aria-label={label}
      aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={max} title={label}
      onMouseDown={onMouseDown} onKeyDown={onKeyDown} onDoubleClick={onReset}
      className={cx('group relative z-20 flex shrink-0 items-stretch justify-center outline-none', vertical ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize')}>
      <span aria-hidden className={cx('bg-em-line em-trans group-hover:bg-em-line-strong group-focus-visible:bg-em-accent', vertical ? 'w-px' : 'h-px w-full self-center')} />
    </div>
  );
}
