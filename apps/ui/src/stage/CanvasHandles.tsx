// ADR-028 / FR-180 / IX-27: selection box and handles over the Player for the selected clip, image or shape (CapCut-style canvas
// transform). Drag inside the box to move (snap guides at the frame centre and edges; Alt turns snapping off), drag a corner to
// scale (opposite corner fixed; Shift keeps the centre), drag the top handle to rotate (Shift snaps to 0 / 90 / 180 / 270),
// double-click resets, Esc cancels. The gesture is previewed live (onLive, optimistic, never sent) and compiled to ONE
// op:element.setTransform pick on release (onCommit; no LLM). Geometry is pure (canvas-transform.ts).
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { boxOf, moveXf, rotateXf, sameXf, scaleXf, IDENTITY, type CanvasItem, type Corner, type Guide, type Pt, type Xf } from './canvas-transform.js';

/** Snap distance for the canvas guides in screen pixels. */
export const CANVAS_SNAP_PX = 6;
export type CanvasGesture = 'move' | 'scale' | 'rotate' | 'reset';
const CORNERS: Corner[] = ['nw', 'ne', 'se', 'sw'];
const CURSOR: Record<Corner, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };

export function CanvasHandles({ item, xf, screenW, label, hint, onLive, onCommit }: {
  item: CanvasItem; xf: Xf; screenW: number; label: string; hint: string;
  onLive: (xf: Xf | null) => void; onCommit: (xf: Xf, gesture: CanvasGesture) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [active, setActive] = useState<CanvasGesture | null>(null);
  const k = screenW / item.frame.w;                                              // screen px per u
  const b = boxOf(item, xf);
  const toU = (e: { clientX: number; clientY: number }): Pt => { const r = host.current?.getBoundingClientRect(); return { x: (e.clientX - (r?.left ?? 0)) / k, y: (e.clientY - (r?.top ?? 0)) / k }; };

  const begin = (mode: 'move' | 'rotate' | Corner, e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const start = xf, p0 = toU(e);
    let last = start, moved = false;
    const gesture: CanvasGesture = mode === 'move' ? 'move' : mode === 'rotate' ? 'rotate' : 'scale';
    const move = (ev: PointerEvent) => {
      const p = toU(ev);
      if (!moved && Math.hypot((p.x - p0.x) * k, (p.y - p0.y) * k) < 3) return;   // a click is not a drag
      moved = true; setActive(gesture);
      if (mode === 'move') { const r = moveXf(item, start, { x: p.x - p0.x, y: p.y - p0.y }, !ev.altKey, CANVAS_SNAP_PX / k); last = r.xf; setGuides(r.guides); }
      else if (mode === 'rotate') last = rotateXf(item, start, p0, p, ev.shiftKey);
      else last = scaleXf(item, start, mode, p, ev.shiftKey);
      onLive(last);
    };
    const end = (commit: boolean) => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('keydown', esc, true);
      setGuides([]); setActive(null);
      if (commit && moved && !sameXf(last, start)) onCommit(last, gesture); else onLive(null);
    };
    const up = () => end(true);
    // Esc cancels the gesture (and only the gesture: the global Esc would also clear the selection).
    const esc = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); end(false); } };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('keydown', esc, true);
  };
  const reset = () => { if (!sameXf(xf, IDENTITY)) onCommit(IDENTITY, 'reset'); };

  return (
    <div ref={host} data-el="stage.player.canvas.layer" className="pointer-events-none absolute inset-0 overflow-hidden">
      {guides.map((g) => (
        <div key={`${g.axis}${g.at}`} data-el="stage.player.canvas.guide" data-axis={g.axis} data-at={Math.round(g.at)} aria-hidden
          className="absolute bg-em-warn" style={g.axis === 'x' ? { left: g.at * k, top: 0, bottom: 0, width: 1 } : { top: g.at * k, left: 0, right: 0, height: 1 }} />
      ))}
      <div data-el="stage.player.canvas.box" data-kind={item.kind} data-element-id={item.id} data-gesture={active ?? undefined} role="group" aria-label={label} title={hint}
        data-x={xf.x.toFixed(4)} data-y={xf.y.toFixed(4)} data-scale={xf.scale.toFixed(4)} data-rotation={xf.rotation.toFixed(2)}
        className="pointer-events-auto absolute cursor-move touch-none border-2 border-em-accent shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
        style={{ left: (b.c.x - b.w / 2) * k, top: (b.c.y - b.h / 2) * k, width: b.w * k, height: b.h * k, transform: `rotate(${xf.rotation}deg)` }}
        onPointerDown={(e) => begin('move', e)} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => { e.stopPropagation(); reset(); }}>
        {CORNERS.map((c) => (
          <span key={c} data-el="stage.player.canvas.handle" data-handle={c} aria-hidden onPointerDown={(e) => begin(c, e)}
            className="absolute h-3 w-3 rounded-[2px] border border-black/60 bg-white"
            style={{ cursor: CURSOR[c], ...(c.includes('n') ? { top: -7 } : { bottom: -7 }), ...(c.includes('w') ? { left: -7 } : { right: -7 }) }} />
        ))}
        <span aria-hidden className="absolute left-1/2 top-[-22px] h-[16px] w-px bg-em-accent" />
        <span data-el="stage.player.canvas.handle" data-handle="rotate" aria-hidden onPointerDown={(e) => begin('rotate', e)}
          className="absolute left-1/2 top-[-30px] h-3.5 w-3.5 -translate-x-1/2 cursor-grab rounded-full border border-black/60 bg-white" />
      </div>
    </div>
  );
}
