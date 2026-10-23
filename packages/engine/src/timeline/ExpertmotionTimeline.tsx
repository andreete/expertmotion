// ExpertmotionTimeline: the ONE composition (ADR-001). Renders a Composition Model; never code from a model.
import React, { useMemo } from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { TransitionSeries, linearTiming, springTiming } from '@remotion/transitions';
import { deriveFrameTiming, framesOf, type AudioLayerT, type ClipT, type CompositionModelT } from '@expertmotion/composition-model';
import type { EngineInputProps, AssetUrls } from '../inputs.js';
import { ThemeProvider, useTheme } from '../theme.js';
import { useLayout, type Layout } from '../layout.js';
import { ensureFontsLoaded } from '../fonts.js';
import { motionStyle } from '../motion.js';
import { easingFn } from '../easing.js';
import { TRANSITIONS } from '../presets/transitions.js';
import { effectsFor } from '../presets/effects.js';
import { BackgroundLayer, VideoDim } from '../presets/backgrounds.js';
import { SHAPES } from '../presets/shapes.js';
import { TextElement } from '../presets/text.js';
import { CaptionPageView } from '../presets/captions.js';

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const ExpertmotionTimeline: React.FC<EngineInputProps> = (props) => {
  ensureFontsLoaded();
  return <ThemeProvider theme={props.model.theme}><TimelineInner {...props} /></ThemeProvider>;
};

const TimelineInner: React.FC<EngineInputProps> = ({ model, assets, quality, watermark }) => {
  const layout = useLayout(model.settings.ratio);
  const { fps, durationInFrames } = useVideoConfig();
  const ft = useMemo(() => deriveFrameTiming(model), [model]);
  const duckWindows = useMemo(() => voiceWindows(model, assets, fps), [model, assets, fps]);
  const premountFor = 2 * fps;                                 // Player default is 0; render default 2 s (REMOTION_CAPABILITY_MAP §A)
  const t = useTheme();
  return (
    <AbsoluteFill style={{ backgroundColor: t.bg, overflow: 'hidden' }}>
      <BackgroundLayer background={model.background} />
      {model.tracks.video.length > 0 && (
        <TransitionSeries>
          {model.tracks.video.flatMap((clip, i) => {
            const nodes: React.ReactNode[] = [
              <TransitionSeries.Sequence key={clip.id} durationInFrames={ft.clipFrames[i]!} premountFor={premountFor}>
                <ClipView clip={clip} urls={assets[clip.assetId]} quality={quality} layout={layout} durationInFrames={ft.clipFrames[i]!} />
              </TransitionSeries.Sequence>,
            ];
            const tr = model.transitions.find((x) => x.cutIndex === i);
            const make = tr ? TRANSITIONS[tr.presetId] : undefined;
            if (tr && make && i < model.tracks.video.length - 1) {
              const frames = ft.transitionFrames[i]!;
              const easingId = typeof tr.params['easingId'] === 'string' ? (tr.params['easingId'] as string) : undefined;
              nodes.push(<TransitionSeries.Transition key={`t${i}`} presentation={make(tr.params, layout)}
                timing={tr.timing === 'spring' ? springTiming({ config: { damping: 200 }, durationInFrames: frames, durationRestThreshold: 0.001 }) : linearTiming({ durationInFrames: frames, easing: easingFn(easingId ?? 'preset:easing.in-out-cubic') })} />);
            }
            return nodes;
          })}
        </TransitionSeries>
      )}
      <VideoDim background={model.background} />
      {model.tracks.overlay.map((o) => (
        <Sequence key={o.id} from={framesOf(o.timing.atMs, fps)} durationInFrames={Math.max(1, framesOf(o.timing.durationMs, fps))} premountFor={premountFor}>
          <OverlayView element={o} urls={o.kind === 'image' ? assets[o.assetId] : undefined} layout={layout} quality={quality} durationInFrames={Math.max(1, framesOf(o.timing.durationMs, fps))} />
        </Sequence>
      ))}
      {model.tracks.text.map((l) => (
        <Sequence key={l.id} from={framesOf(l.timing.atMs, fps)} durationInFrames={Math.max(1, framesOf(l.timing.durationMs, fps))} layout="none">
          <TextElement layer={l} layout={layout} durationInFrames={Math.max(1, framesOf(l.timing.durationMs, fps))} />
        </Sequence>
      ))}
      {model.tracks.caption.styleId && model.tracks.caption.pages.map((p, i) => (
        <Sequence key={`cap${i}`} from={framesOf(p.startMs, fps)} durationInFrames={Math.max(1, framesOf(p.durationMs, fps))}>
          <CaptionPageView page={p} styleId={model.tracks.caption.styleId!} params={model.tracks.caption.params} layout={layout} />
        </Sequence>
      ))}
      {model.tracks.audio.map((a) => {
        const urls = assets[a.assetId]; if (!urls) return null;
        const from = framesOf(a.atMs, fps);
        const dur = a.loop || a.durationMs === undefined ? Math.max(1, durationInFrames - from) : Math.max(1, framesOf(a.durationMs, fps));
        return <Sequence key={a.id} from={from} durationInFrames={dur} premountFor={premountFor}><AudioLayerView layer={a} src={urls.playable} startFrame={from} durationInFrames={dur} duck={a.ducking ? duckWindows : []} /></Sequence>;
      })}
      {watermark && <Watermark layout={layout} />}
    </AbsoluteFill>
  );
};

const ClipView: React.FC<{ clip: ClipT; urls: AssetUrls | undefined; quality: 'draft' | 'full'; layout: Layout; durationInFrames: number }> = ({ clip, urls, quality, layout, durationInFrames }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig(); const t = useTheme();
  if (!urls) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const src = quality === 'draft' && urls.proxy ? urls.proxy : urls.playable;
  const effects = effectsFor(clip.effects, frame, durationInFrames, fps);
  const crop = clip.crop ? { clipPath: `inset(${clip.crop.top * 100}% ${clip.crop.right * 100}% ${clip.crop.bottom * 100}% ${clip.crop.left * 100}%)` } : {};
  const style: React.CSSProperties = { width: '100%', height: '100%', ...crop };   // objectFit goes through the prop (Remotion warns on style.objectFit for <Video>)
  const fadeIn = clip.fadeInMs ? interpolate(frame, [0, framesOf(clip.fadeInMs, fps)], [0, 1], clampOpts) : 1;
  const fadeOut = clip.fadeOutMs ? interpolate(frame, [durationInFrames - framesOf(clip.fadeOutMs, fps), durationInFrames], [1, 0], clampOpts) : 1;
  return (
    <AbsoluteFill style={motionStyle(clip.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId)}>
      {urls.kind === 'image'
        ? <Img src={src} style={{ ...style, objectFit: clip.objectFit }} effects={effects} />
        : <Video src={src} trimBefore={framesOf(clip.trimBeforeMs, fps)} playbackRate={clip.playbackRate} muted={clip.muted} volume={clip.volume * fadeIn * fadeOut} objectFit={clip.objectFit} style={style} effects={effects} />}
    </AbsoluteFill>
  );
};

const OverlayView: React.FC<{ element: CompositionModelT['tracks']['overlay'][number]; urls: AssetUrls | undefined; layout: Layout; quality: 'draft' | 'full'; durationInFrames: number }> = ({ element, urls, layout, quality, durationInFrames }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig(); const t = useTheme();
  const { left, top } = layout.toPx(element.position.x, element.position.y);
  const w = element.size.w * layout.u, h = element.size.h * layout.u;
  const m = motionStyle(element.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId);
  const box: React.CSSProperties = { position: 'absolute', left, top, width: w, height: h, transform: 'translate(-50%, -50%)', display: 'flex', alignItems: 'center', justifyContent: 'center', ...m };
  if (element.kind === 'shape') {
    const Shape = SHAPES[element.presetId];
    return Shape ? <div style={box}><Shape size={Math.min(w, h)} fill={element.fill} stroke={element.stroke} strokeWidth={element.strokeWidth === undefined ? undefined : element.strokeWidth * layout.u} params={element.params} /></div> : null;
  }
  if (!urls) return null;
  return <div style={{ ...box, opacity: element.opacity * (typeof m.opacity === 'number' ? m.opacity : 1) }}><Img src={quality === 'draft' && urls.proxy ? urls.proxy : urls.playable} style={{ width: '100%', height: '100%', objectFit: element.objectFit }} effects={effectsFor(element.effects, frame, durationInFrames, fps)} /></div>;
};

/** Frames (absolute) where speech plays: voice layers and Clips with audio that are not muted. Used by preset:audio.duck-voice. */
function voiceWindows(model: CompositionModelT, assets: Record<string, AssetUrls>, fps: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const a of model.tracks.audio) if (a.role === 'voice') out.push([framesOf(a.atMs, fps), framesOf(a.atMs + (a.durationMs ?? 0), fps)]);
  const ft = deriveFrameTiming(model);
  model.tracks.video.forEach((c, i) => { if (!c.muted && c.volume > 0 && assets[c.assetId]?.hasAudio) out.push([ft.clipStartFrames[i]!, ft.clipStartFrames[i]! + ft.clipFrames[i]!]); });
  return out;
}

const AudioLayerView: React.FC<{ layer: AudioLayerT; src: string; startFrame: number; durationInFrames: number; duck: Array<[number, number]> }> = ({ layer, src, startFrame, durationInFrames, duck }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const fadeIn = layer.fadeInMs ? interpolate(frame, [0, framesOf(layer.fadeInMs, fps)], [0, 1], clampOpts) : 1;
  const fadeOut = layer.fadeOutMs ? interpolate(frame, [durationInFrames - framesOf(layer.fadeOutMs, fps), durationInFrames], [1, 0], clampOpts) : 1;
  let vol = layer.volume;
  if (layer.ducking && duck.length) {
    const p = layer.ducking.params as Record<string, unknown>;
    const full = Number(p['volume'] ?? layer.volume), low = Number(p['duckTo'] ?? 0.15), ramp = Math.max(1, framesOf(Number(p['rampMs'] ?? 500), fps));
    const abs = startFrame + frame;
    const k = Math.max(0, ...duck.map(([a, b]) => Math.min(interpolate(abs, [a - ramp, a], [0, 1], clampOpts), interpolate(abs, [b, b + ramp], [1, 0], clampOpts))));
    vol = full + (low - full) * k;
  }
  return <Audio src={src} trimBefore={framesOf(layer.trimBeforeMs, fps)} loop={layer.loop} volume={vol * fadeIn * fadeOut} />;
};

/** Trial Mode watermark (LICENSE_OPERATIONS.md): "Expertmotion Trial", bottom-right, 4 % of the frame height. */
const Watermark: React.FC<{ layout: Layout }> = ({ layout }) => (
  <div style={{ position: 'absolute', right: layout.safe.right, bottom: layout.safe.bottom * 0.5, fontFamily: 'Inter', fontWeight: 700, fontSize: layout.height * 0.04 * 0.6, color: 'rgba(255,255,255,0.7)', textShadow: '0 1px 4px rgba(0,0,0,0.6)' }}>Expertmotion Trial</div>
);
