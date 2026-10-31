// ExpertmotionTimeline: the ONE composition (ADR-001). Renders a Composition Model; never code from a model.
import React, { useMemo } from 'react';
import { AbsoluteFill, Img, Sequence, interpolate, useCurrentFrame, useVideoConfig } from 'remotion';
import { Audio, Video } from '@remotion/media';
import { TransitionSeries, linearTiming, springTiming } from '@remotion/transitions';
import { deriveFrameTiming, framesOf, visualStack, type AudioLayerT, type ClipT, type CompositionModelT, type OverlayVideoT } from '@expertmotion/composition-model';
import type { EngineInputProps, AssetUrls } from '../inputs.js';
import { ThemeProvider, useTheme } from '../theme.js';
import { useLayout, type Layout } from '../layout.js';
import { ensureFontsLoaded } from '../fonts.js';
import { motionCss, motionFrame, motionStyle } from '../motion.js';
import { easingFn } from '../easing.js';
import { TRANSITIONS } from '../presets/transitions.js';
import { effectsFor } from '../presets/effects.js';
import { BackgroundLayer, VideoDim } from '../presets/backgrounds.js';
import { SHAPES } from '../presets/shapes.js';
import { TextElement } from '../presets/text.js';
import { CaptionPageView } from '../presets/captions.js';
import { clipTransformStyle, clipZoomScale, focusTransform, overlayTransform } from '../transform.js';
import { duckedVolume } from '../audio-duck.js';
import { gainMultiplier } from '../audio-gain.js';

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

export const ExpertmotionTimeline: React.FC<EngineInputProps> = (props) => {
  ensureFontsLoaded();
  return <ThemeProvider theme={props.model.theme}><TimelineInner {...props} /></ThemeProvider>;
};

const TimelineInner: React.FC<EngineInputProps> = ({ model, assets, quality }) => {
  const layout = useLayout(model.settings.ratio);
  const { fps, durationInFrames } = useVideoConfig();
  const ft = useMemo(() => deriveFrameTiming(model), [model]);
  const duckWindows = useMemo(() => voiceWindows(model, assets, fps), [model, assets, fps]);
  const stack = useMemo(() => visualStack(model), [model]);       // ADR-027: texts, images and shapes back → front by layer
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
                <ClipView clip={clip} urls={clip.assetId === undefined ? undefined : assets[clip.assetId]} quality={quality} layout={layout} durationInFrames={ft.clipFrames[i]!} />
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
      {/* DOM order is the stacking order (no z-index): later siblings paint in front; captions stay on top. */}
      {stack.map((x) => 'kind' in x ? (
        <Sequence key={x.id} name={`layer-${x.layer}`} from={framesOf(x.timing.atMs, fps)} durationInFrames={Math.max(1, framesOf(x.timing.durationMs, fps))} premountFor={premountFor}>
          <OverlayView element={x} urls={x.kind === 'shape' ? undefined : assets[x.assetId]} layout={layout} quality={quality} durationInFrames={Math.max(1, framesOf(x.timing.durationMs, fps))} />
        </Sequence>
      ) : (
        <Sequence key={x.id} name={`layer-${x.layer}`} from={framesOf(x.timing.atMs, fps)} durationInFrames={Math.max(1, framesOf(x.timing.durationMs, fps))} layout="none">
          <TextElement layer={x} layout={layout} durationInFrames={Math.max(1, framesOf(x.timing.durationMs, fps))} />
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
        const dur = a.durationMs === undefined ? Math.max(1, durationInFrames - from) : Math.max(1, framesOf(a.durationMs, fps));   // v2: a looping layer with a length stops there
        return <Sequence key={a.id} from={from} durationInFrames={dur} premountFor={premountFor}><AudioLayerView layer={a} src={urls.playable} startFrame={from} durationInFrames={dur} duck={a.ducking ? duckWindows : []} /></Sequence>;
      })}
    </AbsoluteFill>
  );
};

const ClipView: React.FC<{ clip: ClipT; urls: AssetUrls | undefined; quality: 'draft' | 'full'; layout: Layout; durationInFrames: number }> = ({ clip, urls, quality, layout, durationInFrames }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig(); const t = useTheme();
  const zoomScale = clipZoomScale(clip.zoom, frame, durationInFrames, fps);     // ADR-039: punch-in keyframes multiply the canvas scale
  // ADR-030: a scene clip (no media) paints its own background preset; motion, transform and transitions apply as for media.
  if (clip.scene) return (
    <AbsoluteFill style={{ ...motionStyle(clip.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId), overflow: 'hidden', backgroundColor: t.bg }} data-em-scene={clip.scene.presetId}>
      <AbsoluteFill style={clipTransformStyle(clip.transform, layout.width, layout.height, zoomScale)}><BackgroundLayer background={clip.scene} /></AbsoluteFill>
    </AbsoluteFill>
  );
  if (!urls) return <AbsoluteFill style={{ backgroundColor: '#000' }} />;
  const src = quality === 'draft' && urls.proxy ? urls.proxy : urls.playable;
  const effects = effectsFor(clip.effects, frame, durationInFrames, fps);
  const crop = clip.crop ? { clipPath: `inset(${clip.crop.top * 100}% ${clip.crop.right * 100}% ${clip.crop.bottom * 100}% ${clip.crop.left * 100}%)` } : {};
  const style: React.CSSProperties = { width: '100%', height: '100%', ...crop };   // objectFit goes through the prop (Remotion warns on style.objectFit for <Video>)
  const fadeIn = clip.fadeInMs ? interpolate(frame, [0, framesOf(clip.fadeInMs, fps)], [0, 1], clampOpts) : 1;
  const fadeOut = clip.fadeOutMs ? interpolate(frame, [durationInFrames - framesOf(clip.fadeOutMs, fps), durationInFrames], [1, 0], clampOpts) : 1;
  // ADR-028: the media is moved / zoomed / rotated inside the clip's frame, which clips it (also during a transition).
  return (
    <AbsoluteFill style={{ ...motionStyle(clip.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId), overflow: 'hidden' }}>
      <AbsoluteFill data-em-transform={clip.transform || clip.zoom ? 'clip' : undefined} data-em-zoom={clip.zoom ? zoomScale : undefined} style={clipTransformStyle(clip.transform, layout.width, layout.height, zoomScale)}>
        {urls.kind === 'image'
          ? <Img src={src} style={{ ...style, objectFit: clip.objectFit }} effects={effects} />
          : <Video src={src} trimBefore={framesOf(clip.trimBeforeMs, fps)} playbackRate={clip.playbackRate} muted={clip.muted} volume={clip.volume * fadeIn * fadeOut} objectFit={clip.objectFit} style={style} effects={effects} />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

const OverlayView: React.FC<{ element: CompositionModelT['tracks']['overlay'][number]; urls: AssetUrls | undefined; layout: Layout; quality: 'draft' | 'full'; durationInFrames: number }> = ({ element, urls, layout, quality, durationInFrames }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig(); const t = useTheme();
  const { left, top } = layout.toPx(element.position.x, element.position.y);
  const w = element.size.w * layout.u, h = element.size.h * layout.u;
  // ADR-034: the positioned box keeps its centre transform; the motion (scale / grow / reveal / loops) acts on an inner wrapper.
  const mf = motionFrame(element.motion, frame, durationInFrames, fps, layout.u, t.defaultEasingId, element.id);
  const box: React.CSSProperties = { position: 'absolute', left, top, width: w, height: h, transform: overlayTransform(element) };
  const inner: React.CSSProperties = { width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', ...motionCss(mf) };
  if (element.kind === 'shape') {
    const Shape = SHAPES[element.presetId];
    return Shape ? <div data-em-shape={element.id} style={{ ...box, ...(element.opacity === undefined ? {} : { opacity: element.opacity }) }}><div style={inner}><Shape w={w} h={h} u={layout.u} fill={element.fill} stroke={element.stroke} strokeWidth={element.strokeWidth === undefined ? undefined : element.strokeWidth * layout.u} params={element.params} draw={mf.draw} /></div></div> : null;
  }
  if (!urls) return null;
  if (element.kind === 'video') return <div data-em-video={element.id} style={{ ...box, ...(element.opacity === undefined ? {} : { opacity: element.opacity }) }}><div style={inner}><OverlayVideoView element={element} urls={urls} w={w} h={h} u={layout.u} quality={quality} /></div></div>;
  return <div style={{ ...box, opacity: element.opacity }}><div style={inner}><Img src={quality === 'draft' && urls.proxy ? urls.proxy : urls.playable} style={{ width: '100%', height: '100%', objectFit: element.objectFit }} effects={effectsFor(element.effects, frame, durationInFrames, fps)} /></div></div>;
};

/**
 * ADR-039 face bubble: the video is cover-fitted inside a box masked to a circle (50 %) or rounded rectangle (`radius` u), with
 * `overflow: hidden`; the ring is a `box-shadow` spread of `ring.widthU` u outside the mask (a shadow is never clipped by its own
 * element); `focus` moves the source point (x, y fractions) to the box centre and zooms there (focusTransform, exact with the
 * asset size from AssetUrls, approximate without). Muted by default; an unmuted bubble plays its own sound.
 */
const OverlayVideoView: React.FC<{ element: OverlayVideoT; urls: AssetUrls; w: number; h: number; u: number; quality: 'draft' | 'full' }> = ({ element, urls, w, h, u, quality }) => {
  const { fps } = useVideoConfig();
  const radius = element.shape === 'circle' ? '50%' : `${Math.round((element.radius ?? 0) * u * 100) / 100}px`;
  const ring = element.ring && element.ring.widthU > 0 ? `0 0 0 ${Math.round(element.ring.widthU * u * 100) / 100}px ${element.ring.colour}` : undefined;
  const tf = focusTransform(element.focus, w, h, urls.width, urls.height);
  const src = quality === 'draft' && urls.proxy ? urls.proxy : urls.playable;
  return (
    <div data-em-bubble={element.shape} style={{ width: '100%', height: '100%', borderRadius: radius, overflow: 'hidden', backgroundColor: '#000', ...(ring ? { boxShadow: ring } : {}) }}>
      <Video src={src} trimBefore={framesOf(element.trimBeforeMs, fps)} muted={element.muted} volume={element.muted ? 0 : 1} objectFit="cover" style={{ width: '100%', height: '100%', ...(tf ? { transform: tf, transformOrigin: '50% 50%' } : {}) }} />
    </div>
  );
};

/** Frames (absolute) where speech plays: voice layers, Clips with audio that are not muted and unmuted video overlays. Used by preset:audio.duck-voice. */
function voiceWindows(model: CompositionModelT, assets: Record<string, AssetUrls>, fps: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const a of model.tracks.audio) if (a.role === 'voice') out.push([framesOf(a.atMs, fps), framesOf(a.atMs + (a.durationMs ?? 0), fps)]);
  const ft = deriveFrameTiming(model);
  model.tracks.video.forEach((c, i) => { if (!c.muted && c.volume > 0 && c.assetId !== undefined && assets[c.assetId]?.hasAudio) out.push([ft.clipStartFrames[i]!, ft.clipStartFrames[i]! + ft.clipFrames[i]!]); });
  for (const o of model.tracks.overlay) if (o.kind === 'video' && !o.muted && assets[o.assetId]?.hasAudio) out.push([framesOf(o.timing.atMs, fps), framesOf(o.timing.atMs + o.timing.durationMs, fps)]);
  return out;
}

const AudioLayerView: React.FC<{ layer: AudioLayerT; src: string; startFrame: number; durationInFrames: number; duck: Array<[number, number]> }> = ({ layer, src, startFrame, durationInFrames, duck }) => {
  const frame = useCurrentFrame(); const { fps } = useVideoConfig();
  const fadeIn = layer.fadeInMs ? interpolate(frame, [0, framesOf(layer.fadeInMs, fps)], [0, 1], clampOpts) : 1;
  const fadeOut = layer.fadeOutMs ? interpolate(frame, [durationInFrames - framesOf(layer.fadeOutMs, fps), durationInFrames], [1, 0], clampOpts) : 1;
  let vol = layer.volume;
  if (layer.ducking && duck.length) {
    const p = layer.ducking.params as Record<string, unknown>;
    const ramp = Math.max(1, framesOf(Number(p['rampMs'] ?? 500), fps));
    const abs = startFrame + frame;
    const k = Math.max(0, ...duck.map(([a, b]) => Math.min(interpolate(abs, [a - ramp, a], [0, 1], clampOpts), interpolate(abs, [b, b + ramp], [1, 0], clampOpts))));
    vol = duckedVolume(layer.volume, p, k);                                    // FR-266: the bed's own level, dipped by the preset's ratio
  }
  vol *= gainMultiplier(layer.gain, ((startFrame + frame) / fps) * 1000);        // ADR-039: lift / dip segments in composition time
  return <Audio src={src} trimBefore={framesOf(layer.trimBeforeMs, fps)} loop={layer.loop} volume={vol * fadeIn * fadeOut} />;
};

