import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Highlight, Underline, Circle as RoughCircle } from '@remotion/rough-notation';
import { getPreset } from '@expertmotion/catalogue';
import type { TextLayerT } from '@expertmotion/composition-model';
import { fitText } from '@expertmotion/shared';
import { useTheme } from '../theme.js';
import type { Layout } from '../layout.js';
import { motionStyle } from '../motion.js';

const charWidthFor = (weight: number) => (weight >= 700 ? 0.6 : weight >= 600 ? 0.57 : 0.54);

/** One Text Layer inside its own <Sequence> (frame 0 = layer start). Deterministic fitting (shared estimator) keeps preview = render. */
export const TextElement: React.FC<{ layer: TextLayerT; layout: Layout; durationInFrames: number }> = ({ layer, layout, durationInFrames }) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const v = (getPreset(layer.variantId)?.data ?? {}) as Record<string, unknown>;
  const weight = layer.style.weight ?? Number(v['weight'] ?? t.textDefaults.weight);
  const wantU = layer.style.fontSize ?? Number(v['fontSize'] ?? t.textDefaults.fontSize);
  // The box is centred on its anchor. Keep it inside the safe area wherever the anchor is (lower thirds, corner callouts):
  // its width is limited to twice the room between the anchor and the nearer safe edge; when that room is very small
  // (anchor close to an edge) a minimum width is kept and the box is shifted inward instead.
  const anchor = layout.toPx(layer.position.x, layer.position.y);
  const room = 2 * Math.max(0, Math.min(anchor.left - layout.safe.left, layout.width - layout.safe.right - anchor.left));
  const minW = 0.3 * layout.contentW;
  const boxW = Math.max(minW, Math.min((layer.maxWidth ?? Infinity) * layout.u, layout.contentW, room));
  const boxLeft = Math.min(Math.max(anchor.left, layout.safe.left + boxW / 2), layout.width - layout.safe.right - boxW / 2);
  const fit = fitText(layer.text, { width: boxW, height: layout.contentH * 0.5, maxSize: wantU * layout.u, minSize: Math.min(34, wantU) * layout.u, charWidth: charWidthFor(weight), maxLines: 6 });
  const align = layer.style.align ?? (v['align'] as 'left' | 'center' | 'right' | undefined) ?? t.textDefaults.align;
  const colour = layer.style.colour ?? t.textDefaults.colour;
  const family = layer.style.fontFamily ?? t.textDefaults.fontFamily ?? (layer.variantId === 'preset:text.lower-third' ? t.bodyFont : t.headingFont);
  const left = boxLeft, top = anchor.top;
  const mStyle = motionStyle(layer.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId);
  const box: React.CSSProperties = v['box'] ? { background: 'rgba(0,0,0,0.72)', padding: `${0.3 * fit.fontSize}px ${0.5 * fit.fontSize}px`, borderRadius: 0.3 * fit.fontSize } : {};
  const bar: React.CSSProperties = v['bar'] ? { borderLeft: `${0.18 * fit.fontSize}px solid ${t.accent}`, paddingLeft: 0.4 * fit.fontSize, background: 'rgba(0,0,0,0.55)', paddingTop: 0.15 * fit.fontSize, paddingBottom: 0.15 * fit.fontSize, paddingRight: 0.4 * fit.fontSize } : {};
  const content = renderContent(layer, frame, fps, t.accent);
  return (
    <div style={{ position: 'absolute', left, top, width: boxW, transform: 'translate(-50%, -50%)', textAlign: align, ...mStyle }}>
      <span style={{ display: 'inline-block', fontFamily: family, fontWeight: weight, fontSize: fit.fontSize, lineHeight: 1.15, color: colour, opacity: layer.style.opacity ?? t.textDefaults.opacity,
        fontStyle: (layer.style.italic ?? t.textDefaults.italic ?? v['italic']) ? 'italic' : 'normal', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...box, ...bar }}>
        {v['italic'] ? '“' : ''}{content}{v['italic'] ? '”' : ''}
      </span>
    </div>
  );
};

function renderContent(layer: TextLayerT, frame: number, fps: number, accent: string): React.ReactNode {
  const words = layer.text.split(/(\s+)/);
  // Motion presets that work per character / per word (DESIGN_CATALOGUE §5, P1)
  if (layer.motion?.presetId === 'preset:motion.typewriter') {
    const cps = 20; const shown = Math.floor((frame / fps) * cps);
    return layer.text.slice(0, shown);
  }
  if (layer.motion?.presetId === 'preset:motion.word-stagger' || layer.effect?.presetId === 'preset:texteffect.kinetic') {
    const stagger = Number(layer.motion?.params['staggerFrames'] ?? 8);
    let wi = 0;
    return words.map((w, i) => {
      if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
      const s = spring({ frame: frame - (wi++) * stagger, fps, config: { damping: 14 } });
      return <span key={i} style={{ display: 'inline-block', opacity: s, translate: `0px ${(1 - s) * 0.4}em` }}>{w}</span>;
    });
  }
  const colour = String(layer.effect?.params['colour'] ?? accent);
  const progress = interpolate(frame, [Math.round(0.3 * fps), Math.round(1.1 * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  // rough-notation annotates one box per element and keeps it on one line, so long text would overflow (seen in the slice-v0
  // golden frame). Annotating word by word keeps normal line wrapping; the stroke progresses across words in reading order.
  const perWord = (Mark: typeof Highlight, color: string) => {
    const ws = words.filter((w) => !/^\s+$/.test(w)); let k = 0;
    return words.map((w, i) => {
      if (/^\s+$/.test(w)) return <span key={i}>{w}</span>;
      const local = Math.min(1, Math.max(0, progress * ws.length - k++));
      return <Mark key={i} progress={local} color={color}>{w}</Mark>;
    });
  };
  switch (layer.effect?.presetId) {
    case 'preset:texteffect.highlight': return perWord(Highlight, `color-mix(in srgb, ${colour} 70%, transparent)`);
    case 'preset:texteffect.underline': return perWord(Underline as typeof Highlight, colour);
    case 'preset:texteffect.circle': return <RoughCircle progress={progress} color={colour}>{layer.text}</RoughCircle>;
    case 'preset:texteffect.counter': {
      const m = layer.text.match(/-?\d+(?:[.,]\d+)?/);
      if (!m) return layer.text;
      const target = Number(m[0].replace(',', '.')); const decimals = (m[0].split(/[.,]/)[1] ?? '').length;
      const value = interpolate(frame, [0, Math.round(1.2 * fps)], [0, target], { extrapolateRight: 'clamp' });
      return layer.text.replace(m[0], value.toFixed(decimals).replace('.', m[0].includes(',') ? ',' : '.'));
    }
    default: return layer.text;
  }
}
