import React from 'react';
import { AbsoluteFill, Img, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { noise2D, noise3D } from '@remotion/noise';
import type { CompositionModelT } from '@expertmotion/composition-model';
import { useTheme } from '../theme.js';

type Background = CompositionModelT['background'];
type Overlay = CompositionModelT['tracks']['overlay'][number];

/**
 * ADR-041 `preset:background.blurred-image`: the asset the background shows — `params.assetId` when given, else the first image
 * overlay (by start) that is on screen inside `windowMs` (a scene clip's window; the whole composition for the project
 * background). Pure; undefined when there is no picture (the renderer falls back to a solid colour).
 */
export function blurredImageAssetId(background: Background, overlays: readonly Overlay[], windowMs?: { fromMs: number; toMs: number }): string | undefined {
  if (background?.presetId !== 'preset:background.blurred-image') return undefined;
  const explicit = (background.params as Record<string, unknown>)['assetId'];
  if (typeof explicit === 'string' && explicit) return explicit;
  const inWindow = (o: Overlay) => !windowMs || (o.timing.atMs < windowMs.toMs && o.timing.atMs + o.timing.durationMs > windowMs.fromMs);
  const first = overlays.filter((o): o is Extract<Overlay, { kind: 'image' }> => o.kind === 'image' && inWindow(o)).sort((a, b) => a.timing.atMs - b.timing.atMs)[0];
  return first?.assetId;
}

/**
 * Backgrounds behind the video track (DESIGN_CATALOGUE §4, book §4.6). `video-dim` is drawn above the video by VideoDim.
 * `imageSrc` (ADR-041): the URL of the picture a `blurred-image` background copies, resolved by the timeline (blurredImageAssetId
 * + the asset URLs); without one the background is the solid colour A.
 */
export const BackgroundLayer: React.FC<{ background: Background; imageSrc?: string | undefined }> = ({ background, imageSrc }) => {
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
    case 'preset:background.paper': return <Paper base={typeof p['colourA'] === 'string' ? p['colourA'] : undefined} grain={Number(p['grain'] ?? 0.35)} warm={Number(p['warm'] ?? 0.5)} u={u} width={width} height={height} />;
    case 'preset:background.blurred-image': return <BlurredImage src={imageSrc} fallback={typeof p['colourA'] === 'string' ? p['colourA'] : '#000000'} blurPx={Number(p['blurPx'] ?? 48) * u} dim={Number(p['dim'] ?? 0.45)} zoom={Number(p['zoom'] ?? 1.25)} />;
    default: style = { backgroundColor: a };
  }
  return <AbsoluteFill style={style} />;
};

const Clouds: React.FC<{ a: string; b: string; k: number }> = ({ a, b, k }) => {
  const frame = useCurrentFrame();
  const blobs = Array.from({ length: 6 }, (_, i) => ({ x: 50 + 40 * noise3D('cx', i, 0, frame / 300), y: 50 + 40 * noise3D('cy', i, 1, frame / 300), r: 30 + 15 * noise3D('cr', i, 2, frame / 200) }));
  return <AbsoluteFill style={{ backgroundColor: a, background: [...blobs.map((c) => `radial-gradient(circle at ${c.x}% ${c.y}%, color-mix(in srgb, ${b} ${Math.round(25 * k)}%, transparent) 0%, transparent ${c.r}%)`), a].join(', ') }} />;
};

/**
 * ADR-041 `preset:background.blurred-image` (the "screenshot on a blurred copy of itself" look of viral news Reels): the picture
 * cover-fitted to the frame, enlarged `zoom`×, CSS-blurred `blurPx` (already scaled by u), under a black layer of `dim` opacity.
 * The enlargement hides the blur's soft edges. CPU only (CSS filter). Without a picture: the solid fallback colour.
 */
const BlurredImage: React.FC<{ src: string | undefined; fallback: string; blurPx: number; dim: number; zoom: number }> = ({ src, fallback, blurPx, dim, zoom }) => (
  <AbsoluteFill data-em-bg="blurred-image" style={{ backgroundColor: fallback, overflow: 'hidden' }}>
    {src ? <Img data-em-bg-image src={src} style={{ width: '100%', height: '100%', objectFit: 'cover', scale: `${zoom}`, filter: `blur(${Math.round(blurPx * 100) / 100}px)`, transformOrigin: '50% 50%' }} /> : null}
    <AbsoluteFill data-em-bg-dim style={{ backgroundColor: `rgba(0,0,0,${Math.round(Math.max(0, Math.min(1, dim)) * 1000) / 1000})` }} />
  </AbsoluteFill>
);

/** Light paper base between a neutral off-white and a warm cream (`warm` 0…1); `colourA` replaces the base when given. */
export const paperBaseColour = (warm: number, base?: string): string => base ?? `color-mix(in srgb, #F4F2EE ${Math.round((1 - Math.max(0, Math.min(1, warm))) * 100)}%, #EBDCC0 ${Math.round(Math.max(0, Math.min(1, warm)) * 100)}%)`;
export const PAPER_SPECKLES = 260;
/** Three soft fold bands (diagonal light / shadow pairs) and a faint vignette, layered over the base colour. */
export const PAPER_FOLDS: readonly string[] = Object.freeze([
  'linear-gradient(112deg, rgba(0,0,0,0) 38%, rgba(0,0,0,0.045) 50%, rgba(255,255,255,0.05) 53%, rgba(0,0,0,0) 66%)',
  'linear-gradient(28deg, rgba(0,0,0,0) 56%, rgba(0,0,0,0.035) 68%, rgba(255,255,255,0.045) 71%, rgba(0,0,0,0) 82%)',
  'linear-gradient(170deg, rgba(255,255,255,0.06) 0%, rgba(0,0,0,0) 22%, rgba(0,0,0,0) 78%, rgba(0,0,0,0.04) 100%)',
  'radial-gradient(ellipse at 50% 50%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.07) 100%)',
]);
/**
 * ADR-041 `preset:background.paper`, CPU only (no WebGL, no `gpu` flag): a light base, three soft fold gradients (diagonal light /
 * shadow bands), a faint vignette and `@remotion/noise` grain — PAPER_SPECKLES static speckles placed and sized by seeded noise2D
 * (never Math.random, so preview = render), drawn as one inline SVG at `grain` opacity. Static: nothing depends on the frame.
 */
const Paper: React.FC<{ base: string | undefined; grain: number; warm: number; u: number; width: number; height: number }> = ({ base, grain, warm, u, width, height }) => {
  const colour = paperBaseColour(warm, base);
  const speckles = Array.from({ length: PAPER_SPECKLES }, (_, i) => {
    const x = (0.5 + 0.5 * noise2D('paper-x', i * 0.37, 1.3)) * width, y = (0.5 + 0.5 * noise2D('paper-y', i * 0.41, 7.1)) * height;
    const r = (0.6 + 0.9 * (0.5 + 0.5 * noise2D('paper-r', i * 0.53, 3.7))) * u, o = 0.25 + 0.55 * (0.5 + 0.5 * noise2D('paper-o', i * 0.29, 9.9));
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, r: Math.round(r * 100) / 100, o: Math.round(o * 100) / 100, dark: i % 3 !== 0 };
  });
  return (
    <AbsoluteFill data-em-bg="paper" data-em-paper-folds={PAPER_FOLDS.length} style={{ backgroundColor: colour, backgroundImage: PAPER_FOLDS.join(', ') }}>
      <svg data-em-paper-grain width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ position: 'absolute', inset: 0, opacity: Math.max(0, Math.min(1, grain)) }}>
        {speckles.map((s, i) => <circle key={i} cx={s.x} cy={s.y} r={s.r} fill={s.dark ? '#5A4A33' : '#FFFFFF'} fillOpacity={s.o} />)}
      </svg>
    </AbsoluteFill>
  );
};

/** `preset:background.video-dim`: gradient above the video so text stays readable (book §6.3). */
export const VideoDim: React.FC<{ background: Background }> = ({ background }) => {
  if (background?.presetId !== 'preset:background.video-dim') return null;
  const s = Number((background.params as Record<string, unknown>)['strength'] ?? 0.78);
  return <AbsoluteFill style={{ background: `linear-gradient(0deg, rgba(0,0,0,${s}) 0%, rgba(0,0,0,${s * 0.2}) 70%)` }} />;
};
