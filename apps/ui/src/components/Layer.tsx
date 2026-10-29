// QA P1 2026-10-29 (round 1): the Hardware Monitor popover was clipped under the update banner and crossed by the agent-panel
// divider: popovers lived inside the header / panel stacking contexts (z-20 / z-30), below the banners (z-50) and splitters.
// Every popover, menu and parameter panel now renders into ONE portal layer at the end of <body>, above the Editor, banners,
// dividers and dialogs (a popover opened inside a dialog stays on top of it); only tooltips are higher. Positions are computed
// from the anchor's rectangle and kept inside the viewport (flipped above when there is no room below).
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** z-index of the floating layer: above banners (50), dialogs (60), onboarding (65), toasts / tour (70), failed toasts (80); below the splash (90), fatal screen (100) and tooltips (1000). */
export const FLOATING_LAYER_Z = 85;
export const FLOATING_LAYER_ID = 'em-floating-layer';

/** The single layer element (created once, reused by every popover / menu). */
export function floatingLayer(): HTMLElement {
  let n = document.getElementById(FLOATING_LAYER_ID);
  if (!n) {
    n = document.createElement('div'); n.id = FLOATING_LAYER_ID;
    Object.assign(n.style, { position: 'fixed', inset: '0', zIndex: String(FLOATING_LAYER_Z), pointerEvents: 'none' });
    document.body.appendChild(n);
  }
  return n;
}
export function FloatingPortal({ children }: { children: React.ReactNode }) { return createPortal(children, floatingLayer()); }

export interface Rect { left: number; top: number; right: number; bottom: number }
/** Fixed position of a box of `w`×`h` under (or, without room, above) `anchor`, aligned left / right, inside the viewport (8 px margin). */
export function placeBelow(anchor: Rect, w: number, h: number, align: 'left' | 'right', vw: number, vh: number, gap = 4): { left: number; top: number; maxHeight: number } {
  const m = 8;
  let left = align === 'right' ? anchor.right - w : anchor.left;
  left = Math.max(m, Math.min(left, vw - w - m));
  const below = vh - anchor.bottom - gap - m, above = anchor.top - gap - m;
  if (h <= below || below >= above) return { left, top: anchor.bottom + gap, maxHeight: Math.max(120, below) };
  return { left, top: Math.max(m, anchor.top - gap - Math.min(h, above)), maxHeight: Math.max(120, above) };
}

/** Keeps a floating box placed next to the `anchor()` rectangle (recomputed on resize / scroll / content size). */
export function useAnchoredStyle(anchor: () => Rect | null, boxRef: RefObject<HTMLElement | null>, align: 'left' | 'right', width?: number): CSSProperties {
  const [st, setSt] = useState<CSSProperties>({ position: 'fixed', left: 0, top: 0, visibility: 'hidden' });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor(); if (!r) return;
      const b = boxRef.current?.getBoundingClientRect();
      const p = placeBelow(r, width ?? b?.width ?? 0, b?.height ?? 0, align, window.innerWidth, window.innerHeight);
      setSt({ position: 'fixed', left: p.left, top: p.top, maxHeight: p.maxHeight, overflowY: 'auto' });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const ro = typeof ResizeObserver !== 'undefined' && boxRef.current ? new ResizeObserver(place) : null;
    if (ro && boxRef.current) ro.observe(boxRef.current);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); ro?.disconnect(); };
  }, [align, width]); // eslint-disable-line react-hooks/exhaustive-deps
  return st;
}
