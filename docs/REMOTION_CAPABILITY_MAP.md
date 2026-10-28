# Remotion Capability Map (feature → Remotion API, with sources)

| Field | Value |
|---|---|
| Status | baseline (API names verified against remotion.dev on 2026-10-24 unless marked **[UNVERIFIED]**) |
| Owner | Engine lead |
| Last updated | 2026-10-25 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-001, 004, 008, 011, 016, 017), ARCHITECTURE.md §7, DESIGN_CATALOGUE.md, PERFORMANCE.md, AI_WORKFLOW.md §8, ASSESSMENT.md §3–4, MASTER_PROJECT_PROMPT.md §10 |
| Used by | DESIGN_CATALOGUE.md (mapping column), BLUEPRINT.md, TRD.md, POC_PLAN.md, TEST_PLAN.md, DEPLOYMENT_AND_PACKAGING.md, ERROR_CATALOGUE.md, RISKS_AND_ASSUMPTIONS.md |
| Owner of | the mapping of every menu item and every `preset:` id to a Remotion package/API; the Remotion Adapter contract; the render-option policy per Performance Profile; the Engine version policy; the "deliberately not used" list |

Conventions: Remotion version baseline is **4.0.535** (installed in the predecessor repo) with **4.0.537** (the book's version) as the evaluated target. Every remotion.dev URL below was accessed on 2026-10-24. Terms in bold-capital (Creator, Clip, Cut, Composition Model, Engine, Player, Stage …) are defined in GLOSSARY.md and are not redefined here. Milliseconds are the unit of the Composition Model; frames exist only inside the Engine.

Error codes quoted as `EM-3xxx` are **proposed** for ERROR_CATALOGUE.md (which owns them); codes already used by PERFORMANCE.md §7 (`EM-3001`, `EM-3101` … `EM-3104`, `EM-1301`, `EM-5001`) are referenced as-is.

---

## A. Pipeline: Editor → Edit Intent → Edit Plan → Composition Model → Remotion Adapter → preview/render

### A.1 Where Remotion starts and stops

| Stage (brief §10) | Owner | Remotion involved? |
|---|---|---|
| Editor (Design Pick, chat) | Editor | no |
| Edit Intent → Intent Queue | `intents` (AI_WORKFLOW.md) | no |
| Edit Plan (Compile or Editor Agent) → Execute → Operations | `intents`, `composition` | no |
| Composition Model version (JSON, ms) | `composition` (DATABASE_SCHEMA.md) | no |
| **Remotion Adapter** | `packages/engine` | **yes**: turns the Composition Model into React render output |
| Preview | Editor Stage (`@remotion/player`) | yes |
| Render | Local Service render queue (`@remotion/renderer`) | yes |
| Output validation | render queue (ffprobe) | no (FFmpeg only) |

The Remotion Adapter is one React component tree, `ExpertmotionTimeline`, plus one `calculateMetadata`. Nothing else in Expertmotion imports Remotion (ADR-001).

### A.2 `ExpertmotionTimeline`: the single composition

```ts
// packages/engine/src/Root.tsx (bundled at package time, see §E.1)
import {Composition} from 'remotion';
import {ExpertmotionTimeline, timelineSchema} from './timeline/ExpertmotionTimeline';
import {computeMetadata} from './timeline/metadata';   // React-free, also used by the Local Service

export const Root = () => (
  <Composition
    id="ExpertmotionTimeline"
    component={ExpertmotionTimeline}
    schema={timelineSchema}                 // Zod 4 via @remotion/zod-types (≥ 4.0.426)
    defaultProps={emptyTimelineProps}
    width={1920} height={1080} fps={30} durationInFrames={30}   // placeholders, overwritten below
    calculateMetadata={({props}) => computeMetadata(props)}
  />
);
```

`inputProps` shape (the Composition Model version plus resolved media URLs, ≤ 2 MB per ARCHITECTURE.md §7):

```ts
type TimelineProps = {
  model: CompositionModel;                 // schema owned by DATABASE_SCHEMA.md; times in ms
  assets: Record<AssetId, { url: string; proxyUrl?: string; durationMs: number; width: number; height: number; hasAudio: boolean; kind: 'video'|'image'|'audio'|'animated-image' }>;
  quality: 'draft' | 'full';               // Draft swaps proxyUrl for url (PERFORMANCE.md §2)
  theme: ResolvedTheme;                    // palette + font pair, already resolved by the Local Service
};
```

`computeMetadata` (pure, React-free, shared with the Local Service for `render.estimate` and preflight):

| Output | Rule | Source |
|---|---|---|
| `width`, `height` | PERFORMANCE.md §3 pixel table from `model.output.ratio` × `model.output.resolution`; Draft uses the 720p row | ADR-010 |
| `fps` | `model.project.fps` ∈ {24, 25, 30, 50, 60} | PERFORMANCE.md §4 |
| `durationInFrames` | `fit-content`: Σ Clip frames − Σ Transition frames on the video track, then `max(…, longest end of any other Track)`; `fixed`: `msToFrames(fixedMs)`. Clamped to 1 s … 30 min (`EM-3104`) | book §5.8 ("105 not 120"), https://www.remotion.dev/docs/transitions/transitionseries |
| `props` | unchanged (no fetch inside `calculateMetadata`; all data is already in `inputProps`) | https://www.remotion.dev/docs/calculate-metadata |

### A.3 Time conversion rule (one function, used everywhere)

```ts
export const msToFrames = (ms: number, fps: number) => Math.round((ms / 1000) * fps);
export const framesToMs = (f: number, fps: number) => (f / fps) * 1000;
```

Rules:
1. The Composition Model never stores frames. Changing `fps` re-derives every frame count (`op:project.setFps`).
2. Each Timeline Element converts its own `atMs`/`durationMs` with `msToFrames`; a duration of ≥ 1 frame is enforced (`Math.max(1, …)`), mirroring the book's caption page code (§7.7).
3. Transition `durationMs` is converted once and the same frame count is used in `linearTiming({durationInFrames})` and in `computeMetadata`, so preview and render agree to the frame.
4. Rounding is `Math.round`, never `floor`/`ceil`, so a Clip of 1 000 ms at 25 fps is 25 frames and at 30 fps is 30 frames.

### A.4 Track rendering

```tsx
export const ExpertmotionTimeline: React.FC<TimelineProps> = (p) => {
  const {fps} = useVideoConfig();
  const premount = 2 * fps;                                   // 2 s premount, see A.5
  return (
    <AbsoluteFill style={{backgroundColor: p.theme.background}}>
      <BackgroundLayer preset={p.model.background} />        {/* Track: background (part of video track group) */}
      <VideoTrack clips={p.model.tracks.video} transitions={p.model.transitions} assets={p.assets} quality={p.quality} premount={premount} />
      <OverlayTrack elements={p.model.tracks.overlay} … />   {/* Shapes, inserted images, generated thumbnails */}
      <TextTrack elements={p.model.tracks.text} … />
      <CaptionTrack pages={p.model.captions.pages} style={p.model.captions.style} … />
      <AudioTrack layers={p.model.tracks.audio} ducking={…} … />
    </AbsoluteFill>
  );
};
```

| Track | Remotion primitive | Why |
|---|---|---|
| `video` (Clips + Cuts) | `<TransitionSeries>` with `<TransitionSeries.Sequence durationInFrames premountFor>` per Clip and `<TransitionSeries.Transition presentation timing>` per Cut that has a preset ≠ `none` | the only primitive that overlaps two Clips for a transition and recomputes placement automatically |
| `overlay`, `text`, `caption`, `audio` | `<Sequence from durationInFrames premountFor>` per element (default `layout="absolute-fill"`, so every element positions itself absolutely in `u`) | independent timing per element; frames restart at 0 inside each Sequence (book §4.9) |
| stacking | one `AbsoluteFill` per Track, in the order above (later = on top; book §4.3) | deterministic z-order without `zIndex` |

Rules enforced by the Composition Model validator (so the Adapter never throws): two transitions are never adjacent (one per Cut, exclusive group), a transition is shorter than both neighbours (DESIGN_CATALOGUE.md validator: ≤ 50 % of the shorter Clip), a `TransitionSeries` has ≥ 1 Sequence. `TransitionSeries.Sequence` supports `trimBefore` from 4.0.497 but Expertmotion passes trimming to `<Video>` instead (§C) so that Draft/Full and preview/render share one code path.

### A.5 Premount: 2 s everywhere

`premountFor` mounts a Sequence early (hidden) so media is decoded before it becomes visible; the Studio default is 2 s since 4.0.535 but the **Player default is 0 s** (https://www.remotion.dev/docs/sequence). Expertmotion therefore sets it explicitly: `premountFor={2 * fps}` on every `<Sequence>`/`<TransitionSeries.Sequence>` and `defaultPremountInSeconds={2}` on the `<Player>` (§F). During render, premounting costs memory for one extra decoded Clip; this is inside the Performance Profile memory ceiling (PERFORMANCE.md §2) and is re-measured in POC-007.

### A.6 Layout unit and safe areas

Ported from Experthinker Studio (ADR-013): `u = min(width, height) / 1080` from `useVideoConfig()`; every preset param in `u` (DESIGN_CATALOGUE.md rule 5) is multiplied by `u` at render time. Safe areas per Aspect Ratio come from the ported `formats` table extended to the seven ratios; text and lower thirds are placed inside the safe area. Because everything is sized in `u`, rendering the same Composition Model at the 720p row (Draft) or the 2160p row (export) produces the same layout, which is what makes Draft preview honest.

---

## B. Menu items and presets → Remotion

### B.1 Header menu items (brief §7.1, mockup cards; Element IDs from ELEMENT_IDS.md)

| Menu ▸ item | Element ID | Remotion package / API | What the Adapter does | Parameters exposed to the Creator | Preview | Render notes | Source |
|---|---|---|---|---|---|---|---|
| File ▸ New project | `hdr.menu.file.new` | none | creates an empty Composition Model; `computeMetadata` yields 1 s placeholder | name, fps, ratio, resolution | — | — | — |
| File ▸ Open / Recent | `hdr.menu.file.open`, `.recent` | none | loads head Composition Version into `inputProps` | — | Player refresh | — | — |
| File ▸ Save / Save As | `hdr.menu.file.save`, `.saveas` | none | — | — | — | — | — |
| File ▸ Import assets | `hdr.menu.file.import` | none (FFmpeg/ffprobe only) | ASSET_INGESTION.md | — | thumbnails | — | — |
| File ▸ Export video | `hdr.menu.file.export`, `hdr.action.export` | `@remotion/renderer` `selectComposition` + `renderMedia`; `renderStill` for PNG | §E | codec (H.264 default; GIF; PNG still; WebM alpha; MP3), file name, folder | progress via `onProgress` | one job at a time; Performance Profile options | https://www.remotion.dev/docs/renderer/render-media |
| File ▸ Project settings (Frame, FPS, Duration) | `hdr.menu.file.settings` | `calculateMetadata` | `fps`, duration policy, default ratio/resolution feed `computeMetadata` | fps 24/25/30/50/60; `fit-content`/`fixed` | Player re-mounts with new metadata | — | https://www.remotion.dev/docs/calculate-metadata |
| File ▸ Recovery | `hdr.menu.file.recover` | none | loads a checkpoint version | — | — | — | — |
| Home ▸ Add text | `lib.text.add` | `<Sequence>` + `fitText` (`@remotion/layout-utils`) + `@remotion/fonts` | `op:text.add` → Text Layer with variant defaults | text, variant, position | live Player | fonts bundled | §D.1 |
| Home ▸ Font family | `lib.text.font` | `@remotion/fonts` `loadFont` (bundled woff2) | `fontFamily` from `preset:font.*` | 4 families | live Player | no network | https://www.remotion.dev/docs/fonts |
| Home ▸ Font size | `lib.text.size` | CSS `fontSize` in `u`, clamped by `fitText` | `op:text.setStyle {fontSize}` | 34–140 u | live Player | — | book §4.5 |
| Home ▸ Font weight and style | `lib.text.weight` | CSS `fontWeight`, `fontStyle` | `op:text.setStyle` | 400/600/800, italic | live Player | woff2 per weight bundled | book §4.1 |
| Home ▸ Text colour | `lib.text.colour` | CSS `color` | `op:text.setStyle {colour}` | theme swatches + hex | live Player | — | book §4.4 |
| Home ▸ Alignment | `lib.text.align` | CSS `textAlign` + flex alignment in the Sequence | `op:text.setStyle {align}` | left/centre/right | live Player | — | — |
| Home ▸ Text variants | `lib.text.variant` | variant component per `preset:text.*` | `op:text.add {variant}` | title/subtitle/lower-third/callout/quote | live Player | — | §B.10 |
| Home ▸ Text styling presets (Text Effect) | `lib.text.effect` | `@remotion/rough-notation`, ported `KineticText`/`AnimatedNumber` | `op:text.setEffect` | `preset:texteffect.*` | live Player | — | §B.11 |
| Home ▸ Opacity | `lib.text.opacity` | CSS `opacity` on the element's Sequence | `op:text.setStyle {opacity}` | 0–1 | live Player | — | book §5.3 |
| Home ▸ Ratio setting | `lib.text.ratio` → `agent.output.ratio.*` | `calculateMetadata` width/height | `op:output.setRatio` | 7 ratios + Custom + Auto | Player re-mounts | — | PERFORMANCE.md §3 |
| Home ▸ Video size | `lib.text.videosize` → `agent.output.resolution.*` | `calculateMetadata` | `op:output.setResolution` | 720p/1080p/2K/2160p (tier-gated) | Player stays Draft | export dims from table | PERFORMANCE.md §3 |
| Home ▸ Insert image | `lib.text.insert.image` | `<Img>` / `<AnimatedImage>` in an overlay `<Sequence>` | Asset → Overlay element, 5 s default | position, size, duration | live Player | — | §C.3 |
| Home ▸ Insert video | `lib.text.insert.video` | `@remotion/media` `<Video>` | `op:clip.insert` | trim, rate, volume, fit | live Player | — | §C.1 |
| Design ▸ Transitions | `lib.catalogue.tab` (Transitions) | `@remotion/transitions` | `op:transition.set` on a Cut | `durationMs`, `timing`, `direction` | prerendered loop on card; hovered preset applied to the selected Cut in the live Player | GPU-flagged ones use WebGL | §B.2 |
| Design ▸ Captions | Captions tab | `@remotion/captions` + `CaptionPage` components | `op:caption.setStyle`; pages from `op:caption.importSrt` / `captions.generate` | position, fontSize, combine window, maxLines, highlight colour | loop + live | fonts bundled | §B.3, §D.5 |
| Design ▸ Backgrounds | Backgrounds tab | CSS backgrounds on `AbsoluteFill`, `@remotion/noise`, `@remotion/effects/paper` | `op:background.set` | colours, intensity, animate | loop + live | paper = WebGL | §B.4 |
| Design ▸ Motion presets | Motion tab | `interpolate`, `spring`, `Easing` on `translate`/`scale`/`rotate`/`opacity` | `op:motion.set` | `durationMs`, `delayMs`, `easingId`, `exit` | loop + live | CPU-cheap | §B.5 |
| Design ▸ Shapes | Shapes tab | `@remotion/shapes` | `op:shape.add` | size, fill, stroke, position, motionId | loop + live | SVG, cheap | §B.6 |
| Design ▸ Easing | Easing tab | `Easing`, `spring` | `op:easing.setDefault` or per motion | — | loop (ball curve) + live | — | §B.7 |
| Design ▸ Visual effects | Effects tab | `@remotion/effects` `effects` prop | `op:effect.add/remove/setParams` | per effect | loop + live | **WebGL** on all; 3 WebGPU; T0 max 2 | §B.8 |
| Design ▸ Audio options | Audio tab | `@remotion/media` `<Audio>` volume curves; `@remotion/media-utils` `visualizeAudio` | `op:audio.addBed/addLayer/setDucking` | volume, fades, duckTo, rampMs | loop (meter) + live | audio decoded in Chrome | §B.9, §D.6 |
| Tools ▸ Generate Voice | `lib.generator.card.voice` | none in Remotion; result is an Audio Layer | `tts.generate` → `op:generated.insert` | text, voice, language | Player after insert | — | LOCAL_AI_MODELS.md |
| Tools ▸ Generate Music | `.music` | none; result is an audio bed | `music.generate` | prompt, duration, style | — | — | LOCAL_AI_MODELS.md |
| Tools ▸ Generate Thumbnail | `.thumbnail` | `renderStill` for the frame + title composite; sd.cpp for generated art | `thumbnail.generate` | frameMs, titleText, prompt | still shown in result card | PNG via `renderStill`, see §E.4 | https://www.remotion.dev/docs/renderer/render-still |
| Tools ▸ Generate Captions | `.captions` | `@remotion/captions` `createTikTokStyleCaptions` for paging | `captions.generate` → `op:caption.setPages` | language, style | live Player | whisper is **not** `@remotion/install-whisper-cpp` (§H) | §D.5 |
| Tools ▸ Suggest Hashtags | `.hashtags` | none (connected LLM, ADR-009) | — | — | — | — | — |
| Help | `hdr.menu.help.*` | none | — | — | — | — | — |

Preview method legend (ADR-011): **loop** = build-time prerendered `catalogue/<category>/<name>.webm` on the Catalogue Card; **live** = the single `<Player>` in the Stage re-renders with the hovered preset applied to the Creator's current selection (Target Resolution, AI_WORKFLOW.md §4).

### B.2 Transitions (`preset:transition.*`) → `@remotion/transitions`

Common mapping: `<TransitionSeries.Transition presentation={P(params)} timing={T} />` with `T = linearTiming({durationInFrames: msToFrames(durationMs, fps), easing})` or `springTiming({config, durationInFrames})` (https://www.remotion.dev/docs/transitions/timings/lineartiming, …/springtiming). Import path pattern `@remotion/transitions/<kebab-name>` confirmed for `slide`, `push-cut`, `blur-slide`, `fade` (book §5.8); the other paths follow the same pattern **[UNVERIFIED individually]**. Preview: loop + live. Render: CPU presentations are cheap; those flagged `gpu` in DESIGN_CATALOGUE.md draw through canvas/WebGL and are slower on T0 (`swangle`).

| Preset id | Presentation (import) | Exact props used | Creator params | Render notes | Source |
|---|---|---|---|---|---|
| `preset:transition.fade` | `fade()` from `@remotion/transitions/fade` | `{}` (entering scene must be opaque) | `durationMs`, `timing` | CPU | book App. B; https://www.remotion.dev/docs/transitions/presentations |
| `preset:transition.slide` | `slide({direction})` from `@remotion/transitions/slide` | `direction: 'from-left'|'from-right'|'from-top'|'from-bottom'`; optional `enterStyle`, `exitStyle` (≥ 4.0.84) not exposed | `direction` (default `from-right`) | CPU | https://www.remotion.dev/docs/transitions/presentations/slide |
| `preset:transition.wipe` | `wipe({direction})` from `@remotion/transitions/wipe` | `direction` | `direction` (default `from-left`) | CPU | book App. B |
| `preset:transition.push-cut` | `pushCut({…})` from `@remotion/transitions/push-cut` (≥ 4.0.500) | defaults (`cutProgress 5/11`, `outgoingScale 1.04`, `incomingStartScale 1.04`, `incomingEndScale 1.07`, `flashColor '#f5f2ed'`, `flashOpacity 0.2`, `flashFrames 2`); Expertmotion sets `flashColor` = theme background | `direction` is listed in DESIGN_CATALOGUE.md but `pushCut()` has **no direction prop** → see Inconsistencies | CPU | https://www.remotion.dev/docs/transitions/presentations/push-cut |
| `preset:transition.clock-wipe` | `clockWipe({width, height})` from `@remotion/transitions/clock-wipe` | `width`, `height` from `useVideoConfig()` **[prop names UNVERIFIED]** | — | CPU (SVG mask) | book App. B |
| `preset:transition.iris` | `iris({width, height})` from `@remotion/transitions/iris` | as above **[UNVERIFIED]** | — | CPU | book App. B |
| `preset:transition.flip` | `flip({direction})` from `@remotion/transitions/flip` | `direction`, `perspective` default | `direction` | CPU 3D transform | book App. B |
| `preset:transition.zoom-blur` | `zoomBlur()` from `@remotion/transitions/zoom-blur` | `{}` | — | `gpu` | book App. B |
| `preset:transition.dreamy-zoom` | `dreamyZoom()` from `@remotion/transitions/dreamy-zoom` | `{}` | — | `gpu` | book App. B |
| `preset:transition.film-burn` | `filmBurn()` from `@remotion/transitions/film-burn` | `{}` | — | `gpu` | book App. B |
| `preset:transition.linear-blur` | `linearBlur()` from `@remotion/transitions/linear-blur` | `{}` | — | `gpu` | book App. B |
| `preset:transition.book-flip` | `bookFlip()` from `@remotion/transitions/book-flip` | `{}` | — | `gpu` | book App. B |
| `preset:transition.zoom-in-out` | `zoomInOut()` from `@remotion/transitions/zoom-in-out` | `{}` | — | CPU | book App. B |
| `preset:transition.dissolve` | `dissolve()` from `@remotion/transitions/dissolve` | `{}` | — | `gpu` | book App. B |
| `preset:transition.ripple` | `ripple()` from `@remotion/transitions/ripple` | `{}` | — | `gpu` | book App. B |
| `preset:transition.crosswarp` | `crosswarp()` from `@remotion/transitions/crosswarp` | `{}` | — | `gpu` | book App. B |
| `preset:transition.cross-zoom` | `crossZoom()` from `@remotion/transitions/cross-zoom` | `{}` | — | `gpu` | book App. B |
| `preset:transition.swap` | `swap()` from `@remotion/transitions/swap` | `{}` | — | `gpu` (perspective + reflection) | book App. B |
| `preset:transition.blur-slide` | `blurSlide({direction, blur})` from `@remotion/transitions/blur-slide` (≥ 4.0.523) | `direction` (default `from-left`), `blur` 0.5 | `direction` | **requires Chrome `canvas-draw-element` flag; not in Firefox/Safari** → POC must confirm it works in Chrome Headless Shell before P1 ships; otherwise drop | https://www.remotion.dev/docs/transitions/presentations/blur-slide |
| `preset:transition.none` | no `<TransitionSeries.Transition>` emitted (hard cut) | — | — | — | — |
| ~~cube~~ | `cube()` is a paid remotion.pro item | — | — | excluded (`licence:paid`) | ASSESSMENT.md §4 |

`<TransitionSeries.Overlay durationInFrames offset>` (≥ 4.0.415) is reserved for `preset:audio.sfx-hit`'s visual flash companion (P2); it does not change duration.

### B.3 Captions (`preset:caption.*`) → `@remotion/captions` + `CaptionPage` components

Pages are data (`op:caption.setPages`), computed once by the Caption sub-agent with `createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds})` and stored in the Composition Model, so the Adapter only renders. Mapping of the catalogue param `combineTokensWithinMs` → Remotion `combineTokensWithinMilliseconds`. Rendering pattern (book §7.7, https://www.remotion.dev/docs/captions/create-tiktok-style-captions):

```tsx
{pages.map((page, i) => (
  <Sequence key={i} from={msToFrames(page.startMs, fps)} durationInFrames={Math.max(1, msToFrames(page.durationMs, fps))} premountFor={2 * fps}>
    <CaptionPage page={page} style={captionStyle} />
  </Sequence>
))}
// inside CaptionPage: const nowMs = page.startMs + framesToMs(frame, fps);
// token active when token.fromMs <= nowMs && token.toMs > nowMs; container has whiteSpace: 'pre'
```

| Preset id | Component | Exact Remotion use | Creator params | Preview | Render | Source |
|---|---|---|---|---|---|---|
| `preset:caption.editorial` | `CaptionPageEditorial` | active token `color` = accent; `whiteSpace: 'pre'`; `fitText` caps `fontSize` to the safe width | position, fontSize, combine window, maxLines, highlightColour | loop + live | CPU | book §7.7 style 1 |
| `preset:caption.karaoke` | `CaptionPageKaraoke` | per-token `interpolate(nowMs, [fromMs, toMs], [0, 1], {extrapolate clamp})` drives a `linear-gradient` fill width | same | loop + live | CPU | book §7.7 style 2 |
| `preset:caption.box` | `CaptionPageBox` | dark rounded box (`backgroundColor` rgba, `borderRadius` in u) behind the page | same + box colour | loop + live | CPU | book §7.7 style 3 |
| `preset:caption.pop` | `CaptionPagePop` | active token `scale = spring({frame: frame - tokenStartFrame, fps, config:{damping: 12}})` | same | loop + live | CPU | book §7.7 style 4 |
| `preset:caption.moving-pill` | `CaptionPageMovingPill` | pill `translate`/`width` interpolated between token boxes measured with `measureText` | same | loop + live | CPU | Remotion Elements "Moving Pill Captions" (reimplemented, §J) |
| `preset:caption.none` | no `CaptionTrack` output | — | — | — | — | — |

Caption data import: `parseSrt({input, strict?})` (≥ 4.0.216) and `parseVtt({input})` return `{captions: Caption[]}`; `serializeSrt` writes SRT for export (https://www.remotion.dev/docs/captions/parse-srt). `Caption = {text, startMs, endMs, timestampMs, confidence: number | null}` with a leading space on each word token (ASSESSMENT.md §4; book §7.7).

### B.4 Backgrounds (`preset:background.*`)

All render in `BackgroundLayer`, an `AbsoluteFill` below the video track, except `video-dim`, which is an `AbsoluteFill` **above** the video track and below text (book §6.3). Params `colourA`, `colourB`, `intensity`, `animate`.

| Preset id | Exact implementation | Creator params | Preview | Render | Source |
|---|---|---|---|---|---|
| `preset:background.solid` | `style={{backgroundColor: colourA}}` | colourA | loop + live | CPU | book §4.6 |
| `preset:background.gradient` | `background: linear-gradient(${angle}deg, A, B)` | angle, A, B | loop + live | CPU | book §4.6 no. 2 |
| `preset:background.spotlight` | `radial-gradient(circle at 50% 18%, A 0%, B 62%)` | A, B | loop + live | CPU | book §4.6 no. 3 |
| `preset:background.grid` | two repeating `linear-gradient`s sized `cellPx × u` over colourA | cellPx, intensity (line alpha) | loop + live | CPU | book §4.6 no. 5 |
| `preset:background.dots` | `radial-gradient(dot 3px, transparent 3.5px) 0 0/34px 34px` scaled by u | intensity | loop + live | CPU | book §4.6 no. 6 |
| `preset:background.moving-gradient` | `angle = interpolate(frame, [0, durationInFrames], [a0, a0 + 360 × intensity])` | A, B, intensity | loop + live | CPU | book §4.6 no. 8, §5.2 |
| `preset:background.noise-clouds` | `@remotion/noise` `noise3D(seed, x, y, frame × speed)` sampled on a coarse grid of divs (e.g. 24×24) with `opacity`/`scale` per cell; seeded, never `Math.random()` | A, B, intensity | loop + live | CPU (grid ≤ 600 cells) | https://www.remotion.dev/docs/noise, book §5.7 |
| `preset:background.video-dim` | `AbsoluteFill` with `linear-gradient(0deg, rgba(0,0,0,0.78) 0%, rgba(0,0,0,0.15) 70%)`; `intensity` scales the alphas | intensity | live | CPU | book §6.3 |
| `preset:background.paper` | `<Solid color={A} effects={[paper({amount: intensity, colorFront, colorBack})]} />` from `@remotion/effects/paper` | A, B, intensity | loop + live | **WebGL** (`gpu`) | https://www.remotion.dev/docs/effects/paper |
| `preset:background.none` | no background element; composition is transparent → enables alpha export (§E.3) | — | live (checkerboard in Stage) | needs `imageFormat: 'png'` + VP8/VP9 for alpha | https://www.remotion.dev/docs/transparent-videos |

### B.5 Motion presets (`preset:motion.*`)

All motion is a pure function of `useCurrentFrame()` inside the element's Sequence (book ch. 5). Transforms are written as separate CSS properties `translate`, `scale`, `rotate` and `opacity`, never a combined `transform` string (book §5.3). Enter runs over `durationMs` after `delayMs`; when `exit` is true the mirrored curve runs over the last `durationMs` of the element. `interpolate` always uses `extrapolateLeft/Right: 'clamp'` (https://www.remotion.dev/docs/interpolate).

| Preset id | Exact code (enter) | Creator params | Preview | Render | Source |
|---|---|---|---|---|---|
| `preset:motion.fade-in` | `opacity = interpolate(f, [d, d + n], [0, 1], {easing, clamp})` | durationMs, delayMs, easingId, exit | loop + live | CPU | book §5.2 |
| `preset:motion.rise` | `translate = \`0px ${interpolate(f, [d, d+n], [40 * u, 0], …)}px\``; `opacity` as fade-in | same | loop + live | CPU | book §5.2 example |
| `preset:motion.pop` | `scale = spring({frame: f - d, fps, config: {damping: 12}})` | same (damping fixed) | loop + live | CPU | book §5.5 |
| `preset:motion.slide-in` | `translate` X (or Y) from `±width` (or `±height`) → 0 by `direction` | direction + same | loop + live | CPU | book §5.3 |
| `preset:motion.zoom-drift` | `scale = interpolate(f, [0, elementFrames], [1, 1.08], {clamp})` over the whole element (Ken Burns) | — | loop + live | CPU | book §5.3 |
| `preset:motion.spin-in` | `rotate = \`${interpolate(f, [d, d+n], [-20, 0], …)}deg\``; `scale` 0.8 → 1 | same | loop + live | CPU | book §5.3 |
| `preset:motion.bounce` | `translate` Y with `easing: Easing.bounce` | same | loop + live | CPU | book §5.4 |
| `preset:motion.typewriter` | characters shown = `Math.floor(interpolate(f, [d, d+n], [0, text.length], {clamp}))` on a `whiteSpace: 'pre'` span (text only) | durationMs | loop + live | CPU | derived from book §7.7 token pattern |
| `preset:motion.word-stagger` | per word `s = spring({frame: f, fps, delay: i * 8, config: {damping: 14}})`; `opacity: s`, `translate: 0 ${(1 - s) * 60 * u}px` | same | loop + live | CPU | book §5.5 |
| `preset:motion.blur-in` | `filter: blur((1 − p) × blurU × u px)` + `opacity: p` + `scale: 0.96 + 0.04 p` (ADR-034, `packages/engine/src/motion.ts` `motionFrame`) | blurU, durationMs, exitMs, exitStyle, bezier, loop | live | CPU (CSS filter) | https://www.remotion.dev/docs/interpolate |
| `preset:motion.scale-in` | `scale: from + (1 − from) p`, `opacity: min(1, 2p)` | fromScale | live | CPU | https://www.remotion.dev/docs/spring |
| `preset:motion.wipe-reveal` | `clip-path: inset(…)` shrinking from `direction` | direction | live | CPU | https://www.remotion.dev/docs/interpolate |
| `preset:motion.draw-on` | shapes: `evolvePath(p, path)` from `@remotion/paths` → `strokeDasharray` / `strokeDashoffset` on the `make*` path, fill fades in for p > 0.65 | — | live | CPU | https://www.remotion.dev/docs/paths/evolve-path |
| `preset:motion.grow` | `scale: 1 p` (or `p 1`) with `transform-origin` at the base, on an inner wrapper so the box keeps its centre transform; `bezier` via `Easing.bezier` | direction | live | CPU | https://www.remotion.dev/docs/easing |
| idle `loop` param (any motion) | float: `noise2D(seed, t × 0.35, 0) × 6u` from `@remotion/noise` (deterministic, seeded by element id); pulse / sway: `Math.sin(t)`; spin: 45°/s | loop | live | CPU | https://www.remotion.dev/docs/noise/noise-2d |
| `preset:motion.none` | static | — | — | — | — |

### B.6 Shapes (`preset:shape.*`) → `@remotion/shapes`

All components accept `fill`, `stroke`, `strokeWidth`, `style`, `pathStyle`, `debug` and `effects` (https://www.remotion.dev/docs/shapes/circle lists the sibling components). Sizes in `u`; placed in an overlay `<Sequence>` with optional `motionId` applied to the wrapper. Preview loop + live; render CPU (SVG).

| Preset id | Component | Exact props used | Creator params | Source |
|---|---|---|---|---|
| `preset:shape.circle` | `<Circle radius />` | `radius = size × u / 2` | size, fill, stroke, strokeWidth, position, motionId | book §4.7 |
| `preset:shape.rect` | `<Rect width height cornerRadius />` | `width`, `height`, `cornerRadius` in u | + cornerRadius | https://www.remotion.dev/docs/shapes/circle (siblings) |
| `preset:shape.star` | `<Star points innerRadius outerRadius />` | `points` 5, `innerRadius`, `outerRadius` | + points | book §4.7 |
| `preset:shape.arrow` | `<Arrow direction />` (plus `length`, `headWidth` **[prop names UNVERIFIED]**) | direction | + direction | sibling list |
| `preset:shape.triangle` | `<Triangle length direction />` **[props UNVERIFIED]** | — | — | sibling list |
| `preset:shape.heart` | `<Heart />` with `height`/`width` **[UNVERIFIED]** | — | — | sibling list |
| `preset:shape.pie` | `<Pie radius progress />` | `progress` animated by frame when motion present | progress | sibling list |
| `preset:shape.polygon` | `<Polygon points radius />` | `points` | points | sibling list |
| `preset:shape.callout` | `<Callout />` **[props UNVERIFIED]** | — | — | sibling list |
| `preset:shape.spark` | `<Spark />` **[props UNVERIFIED]** | — | — | sibling list |
| `preset:shape.ellipse` | `<Ellipse rx ry />` | `rx`, `ry` | — | sibling list |
| `preset:shape.line` | `makeRect({width, height, cornerRadius: h / 2})` → one `<path>` (ADR-034 renderer `PathShape`, `packages/engine/src/presets/shapes.tsx`) | w × h | — | sibling list |
| `preset:shape.ring` | `makeCircle({radius})`, `fill none`, stroke = colour | w, strokeWidth | — | sibling list |
| `preset:shape.pill` | `makeRect({width, height, cornerRadius: min(w, h) / 2})` | w × h | — | sibling list |
| `preset:shape.check` | stroked path `M .1 .52 L .38 .8 L .9 .2` (× size) | strokeWidth | — | sibling list |
| `preset:shape.chevron` | stroked path `M .3 .12 L .72 .5 L .3 .88` (× size) | strokeWidth | — | sibling list |

### B.7 Easing (`preset:easing.*`) → `Easing` and `spring` from `remotion`

| Preset id | Exact function | Used by | Source |
|---|---|---|---|
| `preset:easing.out-quad` | `Easing.out(Easing.quad)` | enter motions, `linearTiming({easing})` | book §5.4 |
| `preset:easing.out-cubic` | `Easing.out(Easing.cubic)` | enter | book §5.4 |
| `preset:easing.in-quad` | `Easing.in(Easing.quad)` | exit | book §5.4 |
| `preset:easing.in-out-cubic` | `Easing.inOut(Easing.cubic)` | moves | book §5.4 |
| `preset:easing.back` | `Easing.out(Easing.back(2))` | playful enter | book §5.4 |
| `preset:easing.bounce` | `Easing.bounce` | playful | book §5.4 |
| `preset:easing.linear` | `Easing.linear` | technical | https://www.remotion.dev/docs/easing |
| `preset:easing.spring-soft` | `spring({frame, fps, config: {damping: 200}})` (motion) / `springTiming({config: {damping: 200}})` (transition) | — | book §5.5 |
| `preset:easing.spring-bouncy` | `spring({…, config: {damping: 8}})` / `springTiming({config: {damping: 8}})` | — | book §5.5 |
| `preset:easing.snappy` | `Easing.bezier(0.2, 0.8, 0.2, 1)` | — | https://www.remotion.dev/docs/easing |
| `preset:easing.spring-light` | `spring({…, config: {damping: 14}})` | — | https://www.remotion.dev/docs/spring |

Preview: loop (a dot travelling the curve) + live on the selected element. Render: CPU.

### B.8 Visual effects (`preset:effect.*`) → `@remotion/effects`

Mapping: `effects={[e1, e2, …]}` on `<Video>`, `<Img>`, `<AnimatedImage>`, `<Solid>`, `<CanvasImage>`, `<HtmlInCanvas>` and shapes (https://www.remotion.dev/docs/effects; since 4.0.464). Import is per effect: `import {blur} from '@remotion/effects/blur'`. Params that the Creator animates (`motion: in|out`) are driven by `interpolate(frame, …)` as in the book (`blur({radius: interpolate(frame, [0, 30], [40, 0])})`). Every effect needs WebGL2 → `chromiumOptions.gl` per PERFORMANCE.md §2 (`angle` on T1/T2, `swangle` on T0); T0 limits an element to 2 effects. Preview: loop + live (WebGL in the Electron renderer; Electron falls back to software GL on T0). Render: `gpu` cost, slower on T0.

| Preset id | Effect import / function | Exact options used | Creator params | Flags | Source |
|---|---|---|---|---|---|
| `preset:effect.blur` | `@remotion/effects/blur` `blur({radius})` | `radius` px | `radiusPx` 0–40 | gpu | book §5.9 |
| `preset:effect.vignette` | `@remotion/effects/vignette` `vignette({amount, radius, feather, color})` (≥ 4.0.468) | `amount = intensity`; defaults `radius 0.65`, `feather 0.35`, `color '#000000'`, `mode 'color'` | intensity | gpu | https://www.remotion.dev/docs/effects/vignette |
| `preset:effect.film-grain` | `@remotion/effects/grain` **[import path UNVERIFIED; `/docs/effects/film-grain` returned 404]** | `amount = intensity`, seeded | intensity | gpu | book App. A ("butiran halus seperti pada film") |
| `preset:effect.glow` | `@remotion/effects/glow` `glow({radius, intensity, threshold, color})` | `radius 20 × u`, `intensity`, `threshold 0.6` | intensity | gpu | https://www.remotion.dev/docs/effects/glow |
| `preset:effect.colour-grade` | `@remotion/effects/brightness` `brightness({amount})`, `…/contrast` `contrast({amount})`, `…/saturation` `saturation({amount})` applied in that order | `amount` −1…1 each | brightness, contrast, saturation | gpu | https://www.remotion.dev/docs/effects/brightness |
| `preset:effect.greenscreen` | `@remotion/effects/color-key` `colorKey({keyColor, similarity, smoothness, spillSuppression})` (≥ 4.0.472) | `keyColor = colour` (default `'#00ff00'`), `similarity` (catalogue 0.3–0.6; Remotion default 0.18), `smoothness 0.08`, `spillSuppression 0.25` | similarity, colour | gpu | https://www.remotion.dev/docs/effects/color-key |
| `preset:effect.pixelate` | `@remotion/effects/pixelate` `pixelate({blockSize})` | `blockSize = blockPx × u` (default 20) | blockPx | gpu | https://www.remotion.dev/docs/effects/pixelate |
| `preset:effect.halftone` | `@remotion/effects/halftone` `halftone({shape, dotSize, colorMode, dotColor})` | `shape 'circle'`, `dotSize = dotPx × u`, `colorMode 'solid'`, `dotColor` = theme text | dotPx | gpu | https://www.remotion.dev/docs/effects/halftone |
| `preset:effect.chromatic` | `@remotion/effects/chromatic-aberration` `chromaticAberration({amount, angle})` | `amount = offsetPx × u` (default 8), `angle 0` | offsetPx | gpu | https://www.remotion.dev/docs/effects/chromatic-aberration |
| `preset:effect.wave` | `@remotion/effects/wave` `wave({amplitude, wavelength, direction, phase})` | `amplitude × u` (default 60), `wavelength` (default 240) ← `frequency`, `phase = frame × speed` | amplitude, frequency | gpu | https://www.remotion.dev/docs/effects/wave |
| `preset:effect.thermal` | `@remotion/effects/thermal` **[UNVERIFIED: page 404 on 2026-10-24]** | — | — | gpu | book App. A ("seperti kamera panas") |
| `preset:effect.duotone` | `@remotion/effects/duotone` `duotone({darkColor, lightColor, threshold})` | `darkColor = colourA`, `lightColor = colourB`, `threshold 0.5` | colourA, colourB | gpu | https://www.remotion.dev/docs/effects/duotone |
| `preset:effect.light-leak` | `@remotion/effects/light-leak` `lightLeak({seed, hueShift, progress})` | `progress` interpolated by frame when `motion ≠ static`, `seed` from element id hash | intensity (→ `progress` ceiling) | gpu | https://www.remotion.dev/docs/effects/light-leak |
| `preset:effect.scanlines` | `@remotion/effects/scanlines` `scanlines({amount, spacing, thickness})` | `amount = intensity` (default 0.15), `spacing 4 × u` | intensity | gpu | https://www.remotion.dev/docs/effects/scanlines |
| `preset:effect.glitch-blocks` | `@remotion/effects/block-dissolve` **[UNVERIFIED: page 404 on 2026-10-24]** | `progress` by frame | intensity | gpu | book App. A ("kotak kecil yang lenyap … urutan acak") |
| `preset:effect.cylinder` | `@remotion/effects/cylinder` `cylinder({radius, rotationY, shading})` | `radius 250 × u`, `rotationY` by frame, `shading 0.35` | — | **webgpu** (T2 only) | https://www.remotion.dev/docs/effects/cylinder |
| `preset:effect.sphere` | `@remotion/effects/sphere` **[options UNVERIFIED]** | rotation by frame | — | webgpu | book App. A |
| `preset:effect.page-turn` | `@remotion/effects/page-turn` **[import path UNVERIFIED]** | `progress` by frame | — | webgpu | book App. A |

Full inventory for P2 (book Appendix A, 81 effects in 4.0.537), by group — the names below are the book's descriptions; exact function names are confirmed only where a docs URL is cited above:

| Group (book) | Count | Members (descriptive) | Catalogue status |
|---|---|---|---|
| Colour and light | 23 | brightness, contrast, exposure, levels, saturation, vibrance, hue rotate, colour overlay/tint, white balance (temperature/tint), colour correction combo, shadows/highlights, 3D LUT (.cube), grayscale, invert, threshold (two colours), gradient map, thermal, colour key, glow, light leak, light streak, shine/sheen, vignette | 6 in P0/P1 |
| Blur and focus | 6 | gaussian blur, bokeh/lens blur, zoom blur, box/area blur, directional blur, radial blur | blur in P0 |
| Pixel and dots | 7 | pixelate, directional pixelate, radial pixelate, block dissolve, halftone, gradient halftone, dot screen | 3 in P1/P2 |
| Lens and warp | 14 | barrel/CRT bulge, fisheye, ripple, wave, heat shimmer/turbulence, circular noise displace, chromatic aberration, skew, corner pin/perspective, mirror, zoom/scale, relative offset, pixel offset, kaleidoscope-tile, tile | 2 in P1 |
| Edges and shadows | 5 | drop shadow, outline/stroke, bevel/emboss highlight, rough edges, emboss relief | — |
| Textures and generated backgrounds | 19 | burlap, plaid, paper, plastic wrap, checkerboard, grid, diagonal stripes, concentric rings, wave bands, zigzag bands, retro sunburst, liquid two-tone, contour lines, two-colour gradient, layered noise (clouds/smoke), film grain, static noise, pinholes, scanlines | paper, grain, scanlines |
| Reveal and wipe | 4 | directional reveal with soft edge, blinds, zigzag tear, TV test-pattern fade | — |
| 3D (WebGPU) | 3 | cylinder, sphere, page turn | P2 webgpu |

### B.9 Audio treatments (`preset:audio.*`) → `@remotion/media` `<Audio>`

`volume` on `<Audio>`/`<Video>` is a number; the Adapter computes it per frame with `interpolate` inside the element's Sequence (the `(frame) => number` callback form still exists but is "no longer recommended", https://www.remotion.dev/docs/media/audio). Preview loop shows a level meter; live applies to the selected Audio Layer. Render: audio is decoded by Chrome and mixed by FFmpeg; cheap.

| Preset id | Exact implementation | Creator params | Source |
|---|---|---|---|
| `preset:audio.bed-soft` | `<Audio src loop volume={v} />` with `v = volume × interpolate(f, [0, fadeF, endF - fadeF, endF], [0, 1, 1, 0], {clamp})` where `fadeF = msToFrames(fadeMs)` | volume (0.2), fadeMs (1000) | book §6.4 |
| `preset:audio.duck-voice` | for each voice/Clip-audio span `[s, e]` in bed-local frames: `interpolate(f, [s - r, s, e, e + r], [bedVol, duckTo, duckTo, bedVol], {clamp})`, where `r = msToFrames(rampMs)`; spans merged by the Audio sub-agent and stored as `duckRanges` in the Composition Model so the curve is data, not inference | duckTo (0.15), rampMs (500) | book §6.4 (`[60, 75, 180, 195] → [0.5, 0.15, 0.15, 0.5]`) |
| `preset:audio.fade-in-out` | per-layer `interpolate` over `fadeInMs`/`fadeOutMs` | fadeInMs, fadeOutMs | book §6.4 |
| `preset:audio.sfx-hit` | `<Sequence from={cutFrame - hitLeadF}><Audio src={bundledSample} /></Sequence>` at each Cut with a transition; samples from a bundled CC0 pack served like any asset | sampleId | book §6.4 ("klik.mp3" at frame 90) |
| `preset:audio.visualizer-bars` | `useAudioData(src)` + `visualizeAudio({audioData, frame, fps, numberOfSamples: bars, smoothing: true})`; bars rendered as divs; `numberOfSamples` must be a power of two | bars (32/64), colour | https://www.remotion.dev/docs/visualize-audio; book §6.6 |

### B.10 Text variants (`preset:text.*`)

Each variant is a component in an overlay/text `<Sequence>`; font size in `u` is a ceiling, `fitText` (§D.1) shrinks it to the safe width; bundled fonts via `@remotion/fonts`. Preview: live (Text Panel picks are deterministic). Render: CPU.

| Preset id | Exact implementation | Creator params | Source |
|---|---|---|---|
| `preset:text.title` | `fontSize = min(110 u, fitText(...).fontSize)`, `fontWeight 800`, centred, motion `rise` default | text, size, weight, colour, align | book §4.5 (90–140) |
| `preset:text.subtitle` | 64 u, weight 600, centred | same | book §4.5 |
| `preset:text.lower-third` | 48 u, left, bar background (`backgroundColor` accent, `padding` in u), anchored to bottom-left of the safe area | same | Remotion Elements "Name Lower Third" pattern (reimplemented) |
| `preset:text.callout` | 56 u in a rounded box (`borderRadius 24 u`) | same | book §4.1 |
| `preset:text.quote` | 72 u, `fontStyle: 'italic'`, typographic quotes added | same | — |

Fonts: `preset:font.inter`, `preset:font.plus-jakarta-sans`, `preset:font.archivo`, `preset:font.jetbrains-mono` (slugs proposed; DESIGN_CATALOGUE.md writes `preset:font.<name>` without pinning them, see Inconsistencies). Each is `loadFont({family, url: staticFile('fonts/<file>.woff2'), weight, style})` from `@remotion/fonts`, called once at module load of the bundle; it returns a promise and handles render delay itself (https://www.remotion.dev/docs/fonts).

### B.11 Text effects (`preset:texteffect.*`)

| Preset id | Exact implementation | Creator params | Preview | Source |
|---|---|---|---|---|
| `preset:texteffect.highlight` | `<Highlight color={accentRgba} progress={interpolate(f, [d, d + n], [0, 1], {clamp})} iterations={2}>` from `@remotion/rough-notation` | colour, durationMs | loop + live | https://www.remotion.dev/docs/rough-notation/highlight; book §4.8 |
| `preset:texteffect.underline` | `<Underline progress … />` | same | loop + live | same page (component list) |
| `preset:texteffect.circle` | `<Circle progress … />` from `@remotion/rough-notation` (not the shapes `Circle`) | same | loop + live | same |
| `preset:texteffect.kinetic` | ported `KineticText`: per-word `spring({frame, fps, delay: i × 8, config: {damping: 14}})` | durationMs | loop + live | book §5.5; ADR-013 port list |
| `preset:texteffect.counter` | ported `AnimatedNumber`: `interpolate(f, [d, d + n], [from, to], {easing, clamp})` formatted per locale | from, to, durationMs | loop + live | ADR-013 |
| `preset:texteffect.keyword` | per word: listed `words` coloured with the accent + `spring({damping: 10})` scale pop | words, colour | live | ADR-034 |

### B.12 Themes (`preset:palette.*`, `preset:fontpair.*`)

Not Remotion APIs: the Local Service resolves the picked palette and font pair into `inputProps.theme`; the Adapter reads `theme.background / text / accent1 / accent2` and `theme.fonts.heading / body` and passes them to every preset. Preview: live (the whole Player re-themes). Render: no cost. Palette values and contrast ratios come from the book §4.4 table; fonts are the bundled OFL woff2 files loaded with `@remotion/fonts` (§D.1).

| Preset id | Exact values / implementation | Default | Source |
|---|---|---|---|
| `preset:palette.editorial-dark` | background `#14120F`, text `#F4EFE6`, accent1 `#E8913A`, accent2 `#4FD1A5` | yes | book §4.4 |
| `preset:palette.paper-light` | `#F6F1E7` / `#1B1B1B` / `#C8372D` / `#1F5F8B` | — | book §4.4 |
| `preset:palette.neon-tech` | `#0B1020` / `#E8F1FF` / `#00E5FF` / `#FF3DB8` | — | book §4.4 |
| `preset:palette.pastel-friendly` | `#FFF4EA` / `#3A3350` / `#E5546F` / `#2E9C86` (accents fail 4.5:1 for small text → used for shapes/large text only) | — | book §4.4 |
| `preset:palette.high-contrast` | `#000000` / `#FFFFFF` / `#FFE600` / `#FF3B30` | — | book §4.4 |
| `preset:palette.corporate-blue` | `#0D2A4A` / `#F2F7FC` / `#4DA3FF` / `#FFB020` | — | book §4.4 |
| `preset:palette.editorial-teal` | `#0F1A1F` / `#FFFFFF` / `#5DCAA5` / `#EF9F27` (+ negative `#F0997B`, muted `#9FB3B8`, neutral `#888780`, pill `#1D9E75`) | — | QA 2026-10-28 reference (ADR-034) |
| `preset:fontpair.jakarta-inter` | heading `Plus Jakarta Sans` (800), body `Inter` (400/600) via `loadFont` from `@remotion/fonts` | yes | DESIGN_CATALOGUE.md §10–11 |
| `preset:fontpair.archivo-inter` | heading `Archivo`, body `Inter` | — | same |
| `preset:fontpair.inter-mono` | heading `Inter`, body/numbers `JetBrains Mono` (also used by `preset:texteffect.counter`) | — | same |
| `preset:fontpair.inter-inter` | heading and body `Inter` (bundled 400–800) | — | ADR-034 |

---

### B.1 ADR-034 automatic motion and scene composition (installed packages only)

Installed and used: `@remotion/transitions` (fade, slide, wipe, push-cut, iris, clock-wipe, zoom-in-out … chosen per mood by the scene composer, seeded by scene index; `fade` for the editorial crossfade-rise), `@remotion/shapes` (`make*` geometry for every shape), `@remotion/paths` (`evolvePath` draw-on; added to `packages/engine` dependencies — it was already installed as a dependency of `@remotion/shapes`, same pinned 4.0.535), `@remotion/noise` (`noise2D` idle float; `noise3D` clouds), `@remotion/rough-notation` (highlight / underline / circle), `@remotion/effects` (`lightLeak` etc. stay effect presets; not used by the composer because they need WebGL). Not installed here and therefore not used: `@remotion/motion-blur`, `@remotion/light-leaks`, `@remotion/animation-utils` (no new installs). Text measurement: the composer and the Engine share the deterministic glyph-width estimator `textGeometry` (`packages/composition-model/src/text-box.ts`); `@remotion/layout-utils` `measureText` / `fitText` need the DOM (canvas) and cannot run in the Local Service / agents runtime, so they are not the source of layout decisions (the Engine still renders with the real font; single words and counters never wrap).

## C. Media handling

### C.1 Video Clips → `@remotion/media` `<Video>`

`<Video>` from `@remotion/media` is the recommended component for new code; `<OffthreadVideo>` is legacy and `<Html5Video>` is the old tag (https://www.remotion.dev/docs/media/video, /docs/video-tags). Exact usage in `VideoTrack`:

```tsx
<TransitionSeries.Sequence durationInFrames={clipFrames} premountFor={premount}>
  <Video
    src={quality === 'draft' && asset.proxyUrl ? asset.proxyUrl : asset.url}
    trimBefore={msToFrames(clip.trimBeforeMs, fps)}        // frames of the SOURCE to skip (not trimAfter: deprecated)
    durationInFrames={clipFrames}                            // source frames to use from trimBefore
    playbackRate={clip.playbackRate}                         // 0.25 … 4; never negative
    volume={clipVolume}                                      // number per frame from clip.volume + fades + ducking
    muted={clip.volume === 0 || !asset.hasAudio}
    loop={clip.loop}                                         // only for Clips shorter than their slot (images/loops)
    objectFit={clip.objectFit}                               // 'cover' | 'contain' (Remotion also allows fill/none/scale-down)
    cropLeft={crop?.left} cropRight={crop?.right} cropTop={crop?.top} cropBottom={crop?.bottom}  // ratios 0–1 (≥ 4.0.500)
    effects={effectsFor(clip)}                               // §B.8
    onError={() => 'fallback'}                               // falls back to <OffthreadVideo>; 'fail' would abort the render
    style={{width: '100%', height: '100%'}}
  />
</TransitionSeries.Sequence>
```

| Prop | Rule in Expertmotion | Note |
|---|---|---|
| `trimBefore` + `durationInFrames` | from `trimBeforeMs`/`durationMs` of the Clip; the validator keeps `trimBeforeMs + durationMs × playbackRate ≤ asset.durationMs` | `trimAfter` is deprecated → never used |
| `playbackRate` | 0.25–4 (`op:clip.setPlaybackRate`); **reverse playback is not supported** by `@remotion/media` → PRD.md §4.4 out of scope | `preservePitch` (≥ 4.0.538) is not available in the baseline; evaluated with 4.0.537+ |
| `volume` | number computed per frame (§B.9) | the callback form is discouraged |
| `loop` | only when the Clip is a short loop asset | `loopVolumeCurveBehavior` left default |
| `objectFit` | `cover` default; `contain` when the Creator picks it | background colour shows in `contain` |
| `crop*` | `op:clip.setFit {crop}` (P1) | ratios, not pixels |
| `effects` | §B.8 | WebGL |
| `onError` | `'fallback'` → `<OffthreadVideo>` fallback (`fallbackOffthreadVideoProps` left default); render continues; the queue logs a warning and the Output card shows "a clip used the compatibility decoder" | `disallowFallbackToOffthreadVideo` stays `false` |
| `premountFor`/`postmountFor` | set by the wrapping Sequence, not on `<Video>` | — |
| `audioStreamIndex`, `toneFrequency`, `onVideoFrame`, `headless`, `requestInit` | not used | — |

Codecs that reach `<Video>` are always H.264 yuv420p + AAC in MP4 because ingestion transcodes everything else (ASSET_INGESTION.md §3). This is what keeps `@remotion/media`'s WebCodecs path on the fast lane in both Electron and Chrome Headless Shell.

### C.2 Audio Layers → `@remotion/media` `<Audio>`

```tsx
<Sequence from={msToFrames(layer.atMs, fps)} durationInFrames={msToFrames(layer.durationMs, fps)} premountFor={premount}>
  <Audio src={asset.url} trimBefore={msToFrames(layer.trimBeforeMs, fps)} volume={layerVolume} playbackRate={1} loop={layer.loop} muted={false} onError={() => 'fallback'} />
</Sequence>
```

Props available and their use: `trimBefore`, `durationInFrames`, `volume`, `playbackRate` (fixed 1 for voice), `muted`, `loop`, `loopVolumeCurveBehavior` (default), `toneFrequency` (not used), `audioStreamIndex` (not used), `onError` (`'fallback'` → `Html5Audio`). Multiple `<Audio>` elements are mixed by Remotion (book §6.4). Voice from `tts.generate` and music from `music.generate` are ordinary Audio Layers (`op:generated.insert`).

### C.3 Images → `<Img>` and `<AnimatedImage>`

| Asset kind | Component | Exact props | Notes | Source |
|---|---|---|---|---|
| PNG/JPG/WebP/AVIF still | `<Img src style={{width:'100%', height:'100%', objectFit}} effects />` from `remotion` | `src`, `style`, `effects`; `onError` for a placeholder | Remotion waits for decode before capturing the frame (no flicker, book §6.2); default duration 5 s as a Clip or Overlay; `preset:motion.zoom-drift` gives Ken Burns | https://www.remotion.dev/docs/img |
| GIF / animated WebP / APNG / animated AVIF | `<AnimatedImage src width height fit playbackRate loopBehavior effects />` from `remotion` (≥ 4.0.246) | `fit: 'cover'|'contain'`, `loopBehavior: 'loop'`, `playbackRate` = Clip rate | relies on the `ImageDecoder` Web API → works in Chromium (Electron + Headless Shell), which is Expertmotion's only runtime | https://www.remotion.dev/docs/animatedimage |

### C.4 `staticFile` vs served URLs

| Content | How it reaches Chrome | Why |
|---|---|---|
| Bundled, immutable: fonts (woff2), SFX pack, catalogue loop posters | `staticFile('fonts/Inter-800.woff2')` from the bundle's `public/` | shipped inside the Engine bundle; no I/O at runtime |
| Creator media (originals, proxies), generated voice/music/thumbnails | `http://127.0.0.1:<port>/media/<assetId>/<variant>` served by the Local Service (ARCHITECTURE.md §7) | (1) one URL form for Player and renderer gives preview/render parity; (2) `file://` URLs are blocked or inconsistent in Chromium for media fetches and cannot be used from the Editor's `app://` origin; (3) the Local Service can enforce path restrictions, range requests and MIME types centrally; (4) paths under `%APPDATA%` never appear in the Composition Model (portability, backup/restore). Asset ids are random 128-bit; the media listener is loopback-only (ADR-005). |

`inputProps.assets` carries the resolved URLs; the Composition Model stores only `assetId`. Open question ARCHITECTURE.md §11.2 (HTTP vs `file://` for speed) is settled here in favour of HTTP unless POC-007 shows ≥ 20 % render slowdown.

---

## D. Text, shapes, motion, effects, captions, audio: API usage

### D.1 Text fitting and fonts

| API | Package | Exact signature used | Use in Expertmotion | Source |
|---|---|---|---|---|
| `fitText` | `@remotion/layout-utils` | `fitText({text, withinWidth, fontFamily, fontWeight, letterSpacing?, validateFontIsLoaded: true}) → {fontSize}` | caps every Text Layer / caption page to the safe width; font must be loaded first (the bundle awaits `loadFont` promises before `registerRoot` renders) | https://www.remotion.dev/docs/layout-utils/fit-text |
| `fillTextBox` | `@remotion/layout-utils` | `fillTextBox({maxBoxWidth, maxLines}).add({text, fontFamily, fontSize, fontWeight}) → {exceedsBox, newLine}` | Caption sub-agent re-pages long Indonesian lines to `maxLines` before storing pages | https://www.remotion.dev/docs/layout-utils/fill-text-box |
| `measureText` | `@remotion/layout-utils` | measures token boxes for `moving-pill` | — | https://www.remotion.dev/docs/layout-utils |
| ported `fitText` estimator (`fit.ts`) | packages/engine | DOM-free estimate used by the Local Service for `render.estimate` warnings ("title may wrap to 3 lines") | fallback when no DOM (Node) | ADR-013 |
| `loadFont` | `@remotion/fonts` | `loadFont({family, url: staticFile(...), weight, style}) → Promise<void>` | 4 families × needed weights, bundled woff2 (OFL); no `@remotion/google-fonts` | https://www.remotion.dev/docs/fonts |
| rough-notation | `@remotion/rough-notation` | `<Highlight|Underline|Circle|Box|Bracket|StrikeThrough|CrossedOff color progress iterations padding …>` | §B.11 | https://www.remotion.dev/docs/rough-notation/highlight |

### D.2 Shapes

`@remotion/shapes` components: `Arrow`, `Callout`, `Circle`, `Ellipse`, `Heart`, `Pie`, `Polygon`, `Rect`, `Spark`, `Star`, `Triangle` (https://www.remotion.dev/docs/shapes/circle). Each has a `make*` path function (`makeCircle` …) returning SVG path data; Expertmotion uses the components only. `effects` is accepted on shapes (book App. A).

### D.3 Motion primitives

| API | Exact use | Rules | Source |
|---|---|---|---|
| `interpolate(input, inputRange, outputRange, {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing})` | every linear motion | always clamp (book §5.2: unclamped values are the classic "text keeps growing" bug); multi-point ranges allowed | https://www.remotion.dev/docs/interpolate |
| `spring({frame, fps, config: {damping, stiffness, mass, overshootClamping}, delay, durationInFrames, from, to})` | pops, staggers, spring timings | `damping` 8 (bouncy) / 12 (pop) / 14 (stagger) / 200 (soft); `durationInFrames` set only when the Creator fixes `durationMs` | https://www.remotion.dev/docs/spring |
| `Easing.*` | `linearTiming({easing})`, interpolate easing | §B.7 | https://www.remotion.dev/docs/easing |
| `interpolateColors(frame, range, colours)` | `moving-gradient` colour drift (P1) | — | book §5.6 |
| `random(seed)` | noise clouds, grain seeds | never `Math.random()`, `Date.now()`, CSS animations or timers (book §5.7, §8.11) | https://www.remotion.dev/docs/random |
| Separate CSS props `translate`, `scale`, `rotate`, `opacity` | all motion presets | no combined `transform` strings (book §5.3) | — |
| `@remotion/animation-utils` (`makeTransform`, `interpolateStyles`) | not used | separate props cover every preset | https://www.remotion.dev/docs/animation-utils |

### D.4 Effects runtime

| Topic | Rule | Source |
|---|---|---|
| Where | `effects` prop on canvas-based components (§B.8) | https://www.remotion.dev/docs/effects |
| WebGL | all effects use WebGL2; render passes `chromiumOptions.gl` from PERFORMANCE.md §2: `angle` on T1/T2, `swangle` on T0 (software; slow). Remotion 4.0 default is `null`; `angle` has known memory leaks on long renders → the queue splits exports > 10 min into two `frameRange` passes concatenated by FFmpeg when `gl: 'angle'` (P1 mitigation) | https://www.remotion.dev/docs/gl-options |
| WebGPU | `cylinder`, `sphere`, `page-turn` require WebGPU → offered only on T2; render uses `chromiumOptions.gl: 'angle'` and Chrome Headless Shell ≥ the pinned version; verified in POC-005 | https://www.remotion.dev/docs/effects/cylinder |
| Limits | ≤ 3 effects per element (T0: 2); heavy effects flagged on the Catalogue Card (`lib.catalogue.card.badge.gpu`) | DESIGN_CATALOGUE.md §8 |
| Static effects | book §8.6: a never-changing heavy effect can be replaced by a prerendered image → P2 optimisation for backgrounds | book §8.6 |

### D.5 Captions

| API | Exact use | Source |
|---|---|---|
| `Caption` type | `{text, startMs, endMs, timestampMs, confidence}`; stored per project as the raw transcript | https://www.remotion.dev/docs/captions |
| `createTikTokStyleCaptions({captions, combineTokensWithinMilliseconds, breakOnSilenceAfterMilliseconds?}) → {pages: TikTokPage[]}`; `TikTokPage = {text, startMs, durationMs, tokens: {text, fromMs, toMs}[]}` | Caption sub-agent; `combineTokensWithinMilliseconds` = catalogue `combineTokensWithinMs` (1200); `breakOnSilenceAfterMilliseconds` 800 | https://www.remotion.dev/docs/captions/create-tiktok-style-captions |
| `parseSrt({input, strict: false})`, `parseVtt({input})` | `op:caption.importSrt` (P0) | https://www.remotion.dev/docs/captions/parse-srt |
| `serializeSrt({lines})` | "Export captions as SRT" in the Export dialog (P1) **[argument shape UNVERIFIED]** | ASSESSMENT.md §4 |
| Page rendering | one `<Sequence>` per page; active token by `fromMs ≤ nowMs < toMs`; **`whiteSpace: 'pre'`** on the container (leading spaces are the word separators) | book §7.7 |
| Transcription | whisper.cpp as an Expertmotion Engine Binary (LOCAL_AI_MODELS.md), **not** `@remotion/install-whisper-cpp` (compiles on macOS/Linux, Windows prebuilt ≤ 1.6.0) nor `@remotion/whisper-web` (browser WASM) | https://www.remotion.dev/docs/captions/transcribing |

### D.6 Audio

Volume curves and ducking: §B.9. Mixing: Remotion mixes all `<Audio>`/`<Video>` audio during render; the Player mixes in the browser (`numberOfSharedAudioTags` default). `visualizeAudio` needs `useAudioData(src)` which loads the whole file once per Player/render — only for `preset:audio.visualizer-bars` (P2). Remotion does not synthesise speech (book §6.5); TTS is a Tool.

---

## E. Rendering

### E.1 Bundle at build time

| Step | Exact call | Notes | Source |
|---|---|---|---|
| Package time | `await bundle({entryPoint: 'packages/engine/src/index.ts', outDir: 'resources/engine/bundle', publicDir: 'packages/engine/public', publicPath: './', enableCaching: false})` → directory path used as `serveUrl` | `publicPath './'` keeps the bundle relocatable (installed under `%LOCALAPPDATA%\Expertmotion\app\resources\engine\bundle`); `@remotion/bundler` and `@remotion/renderer` versions must match | https://www.remotion.dev/docs/bundle; https://www.remotion.dev/docs/electron |
| Runtime | no webpack, no `@remotion/bundler` in the installed app (ADR-001, ADR-004) | the ported `BundleManager` keeps only its "prebuilt path" branch | ADR-013 |
| Player | the Editor imports `ExpertmotionTimeline` directly from `packages/engine` (Vite build), so Player and bundle are the same source at the same version | parity test POC-002 | ARCHITECTURE.md §7 |

### E.2 `selectComposition` → `renderMedia`

```ts
const composition = await selectComposition({serveUrl, id: 'ExpertmotionTimeline', inputProps, browserExecutable, chromiumOptions, timeoutInMilliseconds: 60_000, logLevel: 'warn', binariesDirectory});
const {cancelSignal, cancel} = makeCancelSignal();
await renderMedia({
  composition, serveUrl, inputProps,                         // inputProps go to BOTH calls (book §7.5)
  codec, crf, videoBitrate, audioCodec: 'aac', audioBitrate: '192k',
  outputLocation, overwrite: true,
  imageFormat, pixelFormat, jpegQuality: 90,
  concurrency, disallowParallelEncoding, hardwareAcceleration,
  chromiumOptions: {gl, headless: true}, chromeMode: 'chrome-headless-shell',
  mediaCacheSizeInBytes, offthreadVideoCacheSizeInBytes,
  browserExecutable, binariesDirectory, licenseKey,
  timeoutInMilliseconds: 60_000, cancelSignal,
  onProgress: ({progress, renderedFrames, encodedFrames, stitchStage}) => queue.progress(jobId, progress),
  onBrowserLog: (log) => logger.debug(log), logLevel: 'warn',
});
```

Options set per Performance Profile (values from PERFORMANCE.md §2, which owns them):

| `renderMedia` option | Standard | Accelerated | Turbo | Source |
|---|---|---|---|---|
| `concurrency` | 1 | `Math.min(2, threads / 2)` | `Math.min(4, threads / 2)` (benchmark may raise) | https://www.remotion.dev/docs/renderer/render-media (default = 50 % of threads) |
| `imageFormat` | `'jpeg'` | `'jpeg'` | `'jpeg'`; `'png'` only for alpha export | same |
| `hardwareAcceleration` | `'disabled'` | `'if-possible'` (T2 only) | `'if-possible'` (T2) | https://www.remotion.dev/docs/hardware-acceleration |
| `chromiumOptions.gl` | T0 `'swangle'`; T1/T2 `'angle'` | `'angle'` | `'angle'` | https://www.remotion.dev/docs/gl-options |
| `mediaCacheSizeInBytes` and `offthreadVideoCacheSizeInBytes` | 256 MB | 512 MB | 1 GB | render-media page |
| `disallowParallelEncoding` | `true` | `false` | `false` | render-media page ("improves memory efficiency") |
| `timeoutInMilliseconds` | 60 000 (default 30 000 is too short for 4K first frames) | 60 000 | 60 000 | render-media page |
| `licenseKey` | from settings when a Company License exists (ADR-017) | same | same | https://www.remotion.dev/docs/licensing |
| `chromeMode` | `'chrome-headless-shell'` ("faster for CPU-bound video rendering") | same | same | https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell |

`hardwareAcceleration` constraints: NVENC on Windows for H.264/H.265 only, NVIDIA driver ≥ 525; **`crf` is incompatible** → Expertmotion passes `videoBitrate` instead (initial table: 720p `5M`, 1080p `8M` [Remotion's own recommendation for Full HD], 2K `14M`, 2160p `30M`; tuned in POC-007), and warns that files are larger. If the encoder is missing, `'if-possible'` falls back silently to software.

### E.3 Codecs, quality, special outputs

| Output (Export dialog) | `codec` | Quality option | `imageFormat` / `pixelFormat` | Extension | Notes | Source |
|---|---|---|---|---|---|---|
| MP4 (default) | `'h264'` | `crf` 18 (default; range 1–51; Expertmotion exposes "Best 16 / Balanced 18 / Small 23") | jpeg / `yuv420p` | `.mp4` | fastest; `x264Preset` left default | https://www.remotion.dev/docs/encoding |
| MP4 (HEVC, P1) | `'h265'` | crf 23 (0–51) | jpeg / `yuv420p` | `.mp4` | smaller, poorer playback compatibility | same |
| WebM (P1) | `'vp9'` | crf 28 (0–63) | jpeg | `.webm` | very slow | same |
| WebM transparent | `'vp8'` or `'vp9'` | crf 9 / 28 | **`'png'` / `'yuva420p'`** | `.webm` | requires `preset:background.none`; only Chrome/Firefox play it; ProRes `4444` + `yuva444p10le` is the NLE-friendly alternative | https://www.remotion.dev/docs/transparent-videos |
| AV1 (P2, evaluate) | `'av1'` | crf 30 (0–63) | jpeg | `.mp4` | very slow; needs the bundled FFmpeg to support it **[UNVERIFIED]** | encoding guide |
| ProRes (P2) | `'prores'` | `proResProfile` (`'4444'` for alpha) | png for alpha | `.mov` | for re-editing in NLEs | book §8.4 |
| GIF | `'gif'` | — | — | `.gif` | `everyNthFrame: 2`, `numberOfGifLoops: null` (infinite), `scale: 0.5` | https://www.remotion.dev/docs/render-as-gif |
| Audio only (P1) | `'mp3'` / `'aac'` / `'wav'` | quality ignored | — | `.mp3` … | `audioCodec` implied | encoding guide |
| PNG still (thumbnail, golden frame) | `renderStill` | — | `imageFormat: 'png'|'jpeg'|'webp'` | `.png` | §E.4 | https://www.remotion.dev/docs/renderer/render-still |

No licence-based cap or watermark applies (Trial Mode removed 2026-10-25; an unlicensed install cannot reach the render routes, EM-5010).

### E.4 `renderStill`

```ts
await renderStill({composition, serveUrl, inputProps, output, frame: msToFrames(frameMs, fps), imageFormat: 'png', scale: 1, browserExecutable, chromiumOptions, timeoutInMilliseconds: 60_000, cancelSignal, binariesDirectory, licenseKey, overwrite: true});
```

Uses: Output thumbnails (frame at 35 % of duration, matching ingest posters), `thumbnail.generate` base frames, catalogue card posters, and golden frames for the parity test (ARCHITECTURE.md §7: pixel diff ≤ 1 % against a Player screenshot). The ported `renderStillCached` keeps a small disk cache keyed by (version hash, frame, size); no in-memory cache (memory budget, PERFORMANCE.md §5). A still counts as a render under the Remotion licence (ASSESSMENT.md §4).

### E.5 Progress, cancellation, failure

| Concern | Mechanism | Source |
|---|---|---|
| Progress + ETA | `onProgress({progress, renderedFrames, encodedFrames, stitchStage})` throttled to 500 ms → SSE `render.progress`; ETA from frames/s over the last 10 s (ported RenderQueue) | render-media page |
| Cancel | `makeCancelSignal()`; `cancel()` on Creator cancel or app close; partial file deleted; job `cancelled` | render-media page (`cancelSignal`) |
| Browser death ("Target closed") | job `failed` with proposed `EM-3201`, recovery hint "lower the Performance Profile"; Chrome is killed by the renderer; the Local Service survives (PRD-015) | book §8.11 |
| `delayRender()` timeout | proposed `EM-3202`; usually a media URL that did not load → the queue re-probes the asset (`EM-1301` if missing) | book §8.11 |
| Service restart during render | job marked `failed` on startup | ARCHITECTURE.md §5 |
| Slowest frames | `renderMedia` returns `slowestFrames` (10 entries) → written to the job log for Diagnostics | render-media page |

### E.6 Output validation (ffprobe)

After `renderMedia` resolves, the queue runs the bundled `ffprobe -v error -print_format json -show_format -show_streams <output>` and checks:

| Check | Rule | On failure |
|---|---|---|
| Dimensions | `streams[v].width/height` equal the Output Profile table values | proposed `EM-3203` "output validation failed", file kept for Diagnostics |
| Duration | `|format.duration − durationInFrames / fps| ≤ 1 / fps + 0.05 s` | `EM-3203` |
| Frame rate | `r_frame_rate` equals project fps (GIF: fps / `everyNthFrame`) | `EM-3203` |
| Streams | 1 video (+ 1 audio unless `muted`/GIF/still); codec name matches | `EM-3203` |
| Size | > 0 bytes and ≥ 10 % of `render.estimate` bytes | `EM-3203` |
| Thumbnail | `renderStill` at 35 % succeeded | warning only |

---

## F. Player (`@remotion/player`) in the Stage

```tsx
<Player
  ref={playerRef}
  component={ExpertmotionTimeline}
  inputProps={{model, assets, quality: draft ? 'draft' : 'full', theme}}
  durationInFrames={meta.durationInFrames} fps={meta.fps}
  compositionWidth={meta.width} compositionHeight={meta.height}   // Draft: 720p row of the pixel table
  controls={false}                 // Expertmotion draws its own controls (stage.player.controls.*)
  loop={loopEnabled} clickToPlay={false} doubleClickToFullscreen={false} spaceKeyToPlayOrPause={false}
  initiallyMuted={false} numberOfSharedAudioTags={5}
  defaultPremountInSeconds={2}
  renderLoading={() => <PlayerLoading />}            // stage.player.state.loading
  errorFallback={({error}) => <PlayerError error={error} />}  // stage.player.state.error
  renderPoster={() => <SafeAreaOverlay />} showPosterWhenPaused={safeAreaVisible}
  acknowledgeRemotionLicense
  style={{width: '100%', height: '100%'}}
/>
```

| Item | Used | Why | Source |
|---|---|---|---|
| Required props | `component`, `durationInFrames`, `fps`, `compositionWidth`, `compositionHeight` from `computeMetadata` (same function as render) | parity | https://www.remotion.dev/docs/player/player |
| `inputProps.quality` | `'draft'` in Standard/Accelerated (proxy URLs + 720p-row dimensions), `'full'` in Turbo or when the Creator toggles "full quality" in `stage.player.menu` | PERFORMANCE.md §2 ("Draft") — note the Player has no `scale` prop; Draft is implemented by metadata + proxies | — |
| Ref methods | `play()`, `pause()`, `toggle()`, `seekTo(frame)`, `getCurrentFrame()`, `isPlaying()`, `mute()/unmute()`, `setVolume()`, `requestFullscreen()`, `addEventListener()` | Stage controls, Timeline View scrubbing, hover-preview seek | same |
| Events | `play`, `pause`, `seeked`, `timeupdate` (~250 ms), `frameupdate` (playhead line), `ended`, `error` (→ error state), `waiting`/`resume` (buffer spinner), `fullscreenchange` | UI state | same |
| `inFrame`/`outFrame` | set while hovering a Catalogue Card to loop only the affected Cut/element | ADR-011 live preview | same |
| `acknowledgeRemotionLicense` | true (the Creator never sees Remotion; licence handled by the Operator, ADR-017) | GLOSSARY "Engine" | same |
| `renderPoster` + `showPosterWhen*` | safe-area overlay and "paused" poster | `stage.player.menu` | same |
| Not used | `controls`, `autoPlay`, `showPlaybackRateControl`, `playbackRate ≠ 1`, `lazyComponent` | custom controls; no reverse | — |

Only one `<Player>` exists in the whole Editor (ADR-011); Catalogue Cards use prerendered webm loops.

---

## G. Chrome Headless Shell, FFmpeg and offline boundaries

| Component | What ships | How it is located at runtime | Source |
|---|---|---|---|
| Chrome Headless Shell | the version pinned by the Remotion version (4.0.534+: Chrome 157.0.8080.0; downloaded at build time into `node_modules/.remotion/chrome-headless-shell/win64/` and copied into `resources/engine/chrome/`); size not stated by Remotion **[UNVERIFIED, ~100 MB estimate]** | at startup `await ensureBrowser({browserExecutable: enginePaths.chrome, chromeMode: 'chrome-headless-shell', logLevel: 'warn'})` (throws if the path is missing → `EM-3001`); the same `browserExecutable` is passed to `selectComposition`, `renderMedia`, `renderStill`; never downloaded on the Creator's PC | https://www.remotion.dev/docs/miscellaneous/chrome-headless-shell; https://www.remotion.dev/docs/renderer/ensure-browser |
| FFmpeg/FFprobe for rendering | Remotion's slim FFmpeg 7.1-line build (H.264, H.265, VP8, VP9, ProRes only) inside the platform compositor package `@remotion/compositor-win32-x64-msvc` (name verified on the npm registry 2026-10-24, ASSESSMENT.md §4; `@remotion/compositor-win32-x64` does not exist) | `binariesDirectory` points at the copied folder when the package is relocated outside `node_modules` | https://www.remotion.dev/docs/cli/ffmpeg |
| FFmpeg/FFprobe for ingestion | a separate **full** FFmpeg build (decodes AV1, HDR, ProRes, FLAC …) bundled by Expertmotion — the slim build "only understands the codecs that Remotion itself supports"; LGPL-configured (no `--enable-gpl`, so no libx264 unless the GPL handling of BRD §6.1 is accepted) | ASSET_INGESTION.md §3; licence handling in DEPLOYMENT_AND_PACKAGING.md B4 | same |
| Fonts | woff2 in the bundle `public/fonts` | `staticFile` | book §4.5 |
| Engine Binaries (AI) | LOCAL_AI_MODELS.md | — | — |

Offline boundaries: previews and renders make **no network calls** — bundle, Chrome, FFmpeg, fonts and SFX are local; media is loopback HTTP. The only Remotion-related egress is `licenseKey` telemetry when a Company License key is configured (voluntary in v4; mandatory for Automators in v5, https://www.remotion.dev/docs/licensing) — Private Mode suppresses it and the conflict is tracked in ADR-017/RISK-001. Chrome Headless Shell is launched with `headless: true` and no proxy; it reaches only `127.0.0.1`.

---

## H. What Expertmotion deliberately does not use

| Not used | Reason |
|---|---|
| Remotion Lambda, Cloud Run, Docker/GitHub Actions renders | local-first (brief §4.1); no cloud (PRD.md §4.4); Cloud Run is alpha (book §8.8) |
| `@remotion/web-renderer` | supports only a subset of HTML, needs WebCodecs; the Local Service already has a full renderer; its telemetry is always on |
| Remotion Studio | the Editor replaces it; the Creator never sees Remotion (GLOSSARY "Engine"); Studio-only features (props editor, canvas drag, `saveDefaultProps`, `writeStaticFile`) are irrelevant to a prebuilt bundle |
| Remotion MCP, Agent Skills in the product | ADR-015; Remotion MCP is deprecated (ASSESSMENT.md §4) |
| `@remotion/google-fonts` | needs internet at preview and render (book §4.5); bundled woff2 instead |
| Dynamic compilation / LLM-authored React | ADR-001; licence forbids users bringing their own Remotion code (https://www.remotion.dev/docs/license/faq) |
| `@remotion/install-whisper-cpp`, `@remotion/whisper-web`, `@remotion/openai-whisper`, `@remotion/elevenlabs` | Windows prebuilt capped at whisper.cpp 1.6.0; WASM is slow; cloud services violate the local-models decision (ADR-009) |
| `<OffthreadVideo>`, `<Html5Video>` as primary | legacy; `@remotion/media` recommended (book §6.3); kept only as `onError` fallback |
| `@remotion/three`, `@remotion/lottie`, `@remotion/motion-blur`, `@remotion/paths`, `@remotion/light-leaks`, `@remotion/gif` | no preset needs them in P0–P2; each would add bundle size and GPU cost; `light-leaks` is covered by `@remotion/effects/light-leak` |
| `Math.random`, CSS animations, timers | non-deterministic across concurrent tabs (book §5.7) |
| Player `playbackRate` < 0, `<Video playbackRate <0>` | reverse playback unsupported |

---

## I. Version policy

1. **One exact version** for `remotion` and every `@remotion/*` package (`bundler`, `renderer`, `player`, `media`, `transitions`, `effects`, `captions`, `shapes`, `layout-utils`, `fonts`, `rough-notation`, `noise`, `media-utils`, `zod-types`) across `packages/engine`, `apps/service`, `apps/ui`; enforced by a lockfile check in CI (ASSESSMENT.md §1 convention). Bundler and renderer must match (https://www.remotion.dev/docs/bundle).
2. Baseline **4.0.535**; **evaluate 4.0.537+** at Stage 2 (PoC) for: `preservePitch` (4.0.538), Studio premount default (4.0.535, informational), `blurSlide` (4.0.523) and the effects inventory of 4.0.537 used by the book. Any newer 4.0.x is adopted only after the checklist below.
3. **Remotion 5** is not adopted until ADR-017 is resolved: v5 changes `gl` default to `angle`, makes `validateFontIsLoaded` default true, changes `visualizeAudio` `optimizeFor` default, and makes licence telemetry mandatory for Automators.
4. Upgrade checklist (one PR, one ADR note): bump all packages together → `npm run typecheck` → unit tests of `computeMetadata`/`msToFrames` → rebuild bundle and catalogue loops → re-pin Chrome Headless Shell (version file) and re-copy into `resources/engine` → run POC-002 parity (golden frames, ≤ 1 % diff) on T0 and T2 → run the P0 render matrix (7 ratios × 2 resolutions × H.264/GIF/PNG) → check `slowestFrames` regression ≤ 10 % → update this document's version fields and ASSESSMENT.md §4 rows that changed.
5. Node/Electron: Electron pins Node; Remotion's documented minimums are Node 20.19+/22.13+/24+ (book §2.1; the official system-requirements page returned 404, ASSESSMENT.md §4 **[UNVERIFIED]**).

---

## J. Remotion Elements and Editor Starter: buy/borrow options

| Item | What it is | Relevance to Expertmotion | Licence implication | Source |
|---|---|---|---|---|
| Remotion Elements | 40+ source React components installed from Studio (copied into the project): Captions (Basic, Rounded, **Moving Pill**, **Popping Word**, **Word Highlight**), Text Effects (Circle Marker, Crossed Off, Cylinder Text, Spinning Text Wheel, Strike Through, Text Marker), Overlays (Name/Location Lower Third, Social Safe Zones), Backgrounds (Paper Texture, Moving Waves, Zigzags, Liquid Contours, Rotating Starburst), Charts (Bar, Line, Pie, Number Counter), Audio (Oscilloscope, Mirrored Spectrum), Layouts, Maps, Storytelling, YouTube | direct seeds for `preset:caption.moving-pill`, `preset:caption.pop`, `preset:text.lower-third`, `preset:texteffect.*`, future chart presets and a Social Safe Zones overlay for the Stage. Because installation requires Studio and copies source, Expertmotion would copy them once into `packages/engine/src/catalogue/` at development time and adapt to `u` units | fall under the Remotion License; no price shown; terms for redistribution inside a sold desktop app **[UNVERIFIED]** — confirm with Remotion together with ADR-017 before copying any Element | https://www.remotion.dev/elements; https://www.remotion.dev/docs/elements |
| Editor Starter | $600 one-time (individuals/small companies; larger companies need the Company License): timeline, canvas, font picker, uploads, 80+ feature flags | a reference for Timeline View interactions (P1 reordering/trimming) and canvas drag (P2); Expertmotion's read-only Timeline View and Composition Model are already designed, so this is a learning purchase, not a dependency | own licence on the Store page in addition to the Remotion License; resale/embedding terms not stated **[UNVERIFIED]** | https://www.remotion.dev/docs/editor-starter; https://www.remotion.pro/store |
| Timeline ($300), Colors and Shapes ($20) | Store components | not needed (shapes via `@remotion/shapes`) | same | https://www.remotion.pro/store |
| `cube()` transition | free item on the Store (listed as paid/pro in DESIGN_CATALOGUE.md) | excluded (`licence:paid`) | separate licence | ASSESSMENT.md §4 |

Rule: nothing from the Store or Elements enters `packages/engine` until its licence for inclusion in a redistributed, sold desktop application is confirmed in writing (BRD compliance section; RISK-001).

---

## K. Open items for POC_PLAN.md (Remotion-specific)

| ID (proposed) | Question | Pass criterion |
|---|---|---|
| POC-002 | Player vs `renderStill` parity | ≤ 1 % pixel diff on 20 golden frames, T0 and T2 |
| POC-005 | WebGL effects and WebGPU effects in Chrome Headless Shell with `gl: 'angle'`/`'swangle'` | all P0 effects render on T0 with `swangle`; cylinder/sphere/page-turn render on T2 |
| POC-006 | `blurSlide` and the `canvas-draw-element` flag in Headless Shell | renders identically to the Player, or the preset is dropped |
| POC-007 | memory per Performance Profile with `premountFor` 2 s and `mediaCacheSizeInBytes` | within PERFORMANCE.md §5 budgets |
| POC-008 | `hardwareAcceleration: 'if-possible'` with NVENC: `videoBitrate` table quality vs `crf 18` | SSIM ≥ 0.95 at the chosen bitrates |
| POC-009 | HTTP media URLs vs `file://` render speed | HTTP within 20 % of `file://` |
