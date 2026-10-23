import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { noise3D } from '@remotion/noise';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { useTheme } from '../theme.js';

/** Backgrounds behind the video track (DESIGN_CATALOGUE §4, book §4.6). `video-dim` is drawn above the video by VideoDim. */
export const BackgroundLayer: React.FC<{ background: CompositionModelT['background'] }> = ({ background }) => {
  const t = useTheme(); const frame = useCurrentFrame(); const { durationInFrames, width, height } = useVideoConfig();
  const id = background?.presetId ?? 'preset:background.solid';
  const p = (background?.params ?? {}) as Record<string, unknown>;
  const a = String(p['colourA'] ?? t.bg), b = String(p['colourB'] ?? t.accent), k = Number(p['intensity'] ?? 1);
  const u = Math.min(width, height) / 1080;
  const angle = Number(p['angle'] ?? 160) + (p['animate'] || id === 'preset:background.moving-gradient' ? interpolate(frame, [0, durationInFrames], [0, 180]) : 0);
  const mix = (c: string, alpha: number) => `color-mix(in srgb, ${c} ${Math.round(alpha * 100)}%, transparent)`;
  let style: React.CSSProperties;
  switch (id) {
    case 'preset:background.none': return null;
    case 'preset:background.video-dim': return null;
    case 'preset:background.gradient': case 'preset:background.moving-gradient': style = { background: `linear-gradient(${angle}deg, ${a} 0%, ${mix(b, 0.6 * k)} 130%)`, backgroundColor: a }; break;
    case 'preset:background.spotlight': style = { background: `radial-gradient(circle at 50% 18%, ${mix(b, 0.45 * k)} 0%, ${a} 62%)` }; break;
    case 'preset:background.grid': { const c = Number(p['cellPx'] ?? 50) * u; style = { background: `linear-gradient(${mix(t.text, 0.08 * k)} ${2 * u}px, transparent ${2 * u}px) 0 0/${c}px ${c}px, linear-gradient(90deg, ${mix(t.text, 0.08 * k)} ${2 * u}px, transparent ${2 * u}px) 0 0/${c}px ${c}px, ${a}` }; break; }
    case 'preset:background.dots': { const c = Number(p['cellPx'] ?? 34) * u; style = { background: `radial-gradient(${mix(t.text, 0.19 * k)} ${3 * u}px, transparent ${3.5 * u}px) 0 0/${c}px ${c}px, ${a}` }; break; }
    case 'preset:background.noise-clouds': return <Clouds a={a} b={b} k={k} />;
    default: style = { backgroundColor: a };
  }
  return <AbsoluteFill style={style} />;
};

const Clouds: React.FC<{ a: string; b: string; k: number }> = ({ a, b, k }) => {
  const frame = useCurrentFrame();
  const blobs = Array.from({ length: 6 }, (_, i) => ({ x: 50 + 40 * noise3D('cx', i, 0, frame / 300), y: 50 + 40 * noise3D('cy', i, 1, frame / 300), r: 30 + 15 * noise3D('cr', i, 2, frame / 200) }));
  return <AbsoluteFill style={{ backgroundColor: a, background: [...blobs.map((c) => `radial-gradient(circle at ${c.x}% ${c.y}%, color-mix(in srgb, ${b} ${Math.round(25 * k)}%, transparent) 0%, transparent ${c.r}%)`), a].join(', ') }} />;
};

/** `preset:background.video-dim`: gradient above the video so text stays readable (book §6.3). */
export const VideoDim: React.FC<{ background: CompositionModelT['background'] }> = ({ background }) => {
  if (background?.presetId !== 'preset:background.video-dim') return null;
  const s = Number((background.params as Record<string, unknown>)['strength'] ?? 0.78);
  return <AbsoluteFill style={{ background: `linear-gradient(0deg, rgba(0,0,0,${s}) 0%, rgba(0,0,0,${s * 0.2}) 70%)` }} />;
};
