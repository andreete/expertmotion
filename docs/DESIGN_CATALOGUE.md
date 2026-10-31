# Design Catalogue (closed preset registry)

| Field | Value |
|---|---|
| Status | baseline (P0 set frozen; P1/P2 entries may gain params) |
| Owner | Engine lead + UI/UX lead |
| Last updated | 2026-10-31 (ADR-039: Reels infographic shapes, caption keyword params, Poppins, reels-navy) |
| Depends on | GLOSSARY.md, PRD.md (PRD-013), REMOTION_CAPABILITY_MAP.md, PERFORMANCE.md, ASSESSMENT.md §3 (book) |
| Used by | AI_WORKFLOW.md (Compile table), SYSTEM_PROMPT.md, UI_UX_SPECIFICATION.md, FRD.md, TEST_PLAN.md, GOLDEN_SCENARIOS.md |
| Owner of | every `preset:` id, its parameters, defaults, property class, hardware/licence flags, preview asset path |

## 1. Rules

1. A preset id is `preset:<category>.<name>` and never changes once shipped; renaming creates a new id and deprecates the old.
2. Every preset has: label (EN / ID), category, Property Class behaviour, params schema (Zod in `packages/engine/src/catalogue/<category>.ts`), defaults, Remotion mapping (REMOTION_CAPABILITY_MAP.md row), preview asset `catalogue/<category>/<name>.webm` (2 s loop, 480 px, built at package time) + poster `<name>.jpg` (the frame at 1 s, shown on the paused card; frame 0 is the demo before its entrance — Entry 36), flags: `p0|p1|p2`, `gpu` (needs WebGL on T0 → slower), `webgpu` (T2 only), `model:<id>` (needs a local model), `licence:paid` (excluded).
3. The Intent Compiler, the Editor Agent's capability list and the Preview Catalogue all read this registry; nothing else enumerates presets.
4. Labels are shown in English in MVP; Indonesian labels are stored for later UI localisation and used in Indonesian chat replies.
5. Params use milliseconds and normalised units (0–1) where possible; colours are hex; sizes are in `u` (layout unit = min(width,height)/1080) so presets fit every ratio.

## 2. Transitions (`transition`) — exclusive-group per Cut

Mapping: `@remotion/transitions` presentations + `linearTiming`/`springTiming`. Common params: `durationMs` (default 500, 100–2000), `timing` (`linear` default | `spring`), `easingId` (for linear).

| id | Label EN / ID | Params | P | Flags | Book/docs |
|---|---|---|---|---|---|
| `preset:transition.fade` | Fade / Pudar | — | P0 | | fade |
| `preset:transition.slide` | Slide / Geser | `direction: from-left|from-right|from-top|from-bottom` (default from-right) | P0 | | slide |
| `preset:transition.wipe` | Wipe / Sapu | `direction` (default from-left) | P0 | | wipe |
| `preset:transition.push-cut` | Push cut / Dorong potong | — (punch-in + flash hard cut; no direction) | P0 | | pushCut |
| `preset:transition.clock-wipe` | Clock wipe / Sapu jam | — | P0 | | clockWipe |
| `preset:transition.iris` | Iris / Iris | — | P0 | | iris |
| `preset:transition.flip` | Flip / Balik | `direction: from-left|from-right|from-top|from-bottom` | P1 | | flip |
| `preset:transition.zoom-blur` | Zoom blur / Kabur zoom | — | P1 | gpu | zoomBlur |
| `preset:transition.dreamy-zoom` | Dreamy zoom / Zoom lembut | — | P1 | gpu | dreamyZoom |
| `preset:transition.film-burn` | Film burn / Film terbakar | — | P1 | gpu | filmBurn |
| `preset:transition.linear-blur` | Linear blur / Kabur searah | — | P1 | gpu | linearBlur |
| `preset:transition.book-flip` | Book flip / Balik buku | — | P1 | gpu | bookFlip |
| `preset:transition.zoom-in-out` | Zoom in-out / Zoom masuk-keluar | — | P1 | | zoomInOut |
| `preset:transition.dissolve` | Dissolve / Larut | — | P1 | gpu | dissolve |
| `preset:transition.ripple` | Ripple / Riak | — | P1 | gpu | ripple |
| `preset:transition.crosswarp` | Crosswarp / Silang lengkung | — | P1 | gpu | crosswarp |
| `preset:transition.cross-zoom` | Cross zoom / Zoom silang | — | P1 | gpu | crossZoom |
| `preset:transition.swap` | Swap / Tukar | — | P1 | gpu | swap |
| `preset:transition.blur-slide` | Blur slide / Geser kabur | `direction` | P1 | gpu | blurSlide |
| `preset:transition.none` | Hard cut / Potong langsung | — | P0 | | none |
| ~~cube~~ | — | — | — | licence:paid, excluded | remotion.pro |

Validator: a transition's `durationMs` ≤ 50 % of the shorter adjacent Clip; total duration = Σ clips − Σ transitions (book §5.8).

## 3. Captions (`caption`) — exclusive-group per project (style); pages are data

Mapping: `@remotion/captions` (`createTikTokStyleCaptions`, `parseSrt`, `parseVtt`), rendered by `CaptionPage` components; fonts bundled. Common params: `position: bottom|center|top` (default bottom), `fontSize` (u, default 56), `combineTokensWithinMs` (default 1200), `maxLines` (1–3, default 2), `highlightColour` (theme accent).

| id | Label EN / ID | Look (book §7.7) | P | Flags |
|---|---|---|---|---|
| `preset:caption.editorial` | Editorial / Editorial | clean text, active word in accent colour | P0 | |
| `preset:caption.karaoke` | Karaoke / Karaoke | words fill left-to-right as spoken | P0 | |
| `preset:caption.box` | Box / Kotak | dark rounded box, white text, active word accent | P0 | |
| `preset:caption.pop` | Pop / Pop | active word scales with spring | P1 | |
| `preset:caption.moving-pill` | Moving pill / Pil bergerak | pill slides under active word (Elements) | P1 | |
| `preset:caption.none` | No captions / Tanpa caption | — | P0 | |

P0 caption data comes from `op:caption.importSrt` (SRT/VTT import) or manual pages; P1 adds `captions.generate` (whisper.cpp, flag `model:whisper`).

ADR-039 optional params on every style (absent = the behaviour above): `keywords` (`[{words[], colour}]`, ≤ 12 groups; a word matches after lower-casing and stripping punctuation and keeps its colour spoken or not), `yU` (top of the caption block from the frame top in u; wins over `position`), `fontSizeU` (u, 34–200; wins over `fontSize`), `fontFamily` / `weight` (default: theme heading font, 800), `maxWordsPerPage` (1–12: the renderer shows a page in chunks of at most N words, the chunk holding the current time). A page without tokens renders nothing (silent cards have no captions).

## 4. Backgrounds (`background`) — exclusive-group per project

Mapping: CSS backgrounds on an `AbsoluteFill` behind the video track (book §4.6), `@remotion/noise` for organic ones, `@remotion/effects` generators for textures. Params: `colourA`, `colourB` (theme defaults), `intensity` (0–1), `animate` (bool; angle/position driven by frame).

| id | Label EN / ID | Implementation | P | Flags |
|---|---|---|---|---|
| `preset:background.solid` | Solid / Polos | `backgroundColor` | P0 | |
| `preset:background.gradient` | Gradient / Gradasi | `linear-gradient(angle, A, B)`; `angle` param | P0 | |
| `preset:background.spotlight` | Spotlight / Sorot | `radial-gradient(circle at 50% 18%, …)` | P0 | |
| `preset:background.grid` | Grid / Kisi | two repeating linear gradients; `cellPx` | P0 | |
| `preset:background.dots` | Dots / Titik | repeating radial gradient | P0 | |
| `preset:background.moving-gradient` | Moving gradient / Gradasi bergerak | angle interpolated by frame | P1 | |
| `preset:background.noise-clouds` | Clouds / Awan | `@remotion/noise` | P1 | |
| `preset:background.video-dim` | Dim video / Video redup | gradient layer rendered **above** the video track (an overlay, listed here because the Creator picks it from Backgrounds; book §6.3) | P0 | |
| `preset:background.paper` | Paper / Kertas | effects texture generator | P2 | gpu |
| `preset:background.none` | None / Tanpa latar | transparent (alpha export) | P0 | |

## 5. Motion presets (`motion`) — exclusive-group per element (enter+exit pair)

Mapping: `interpolate`/`spring` on separate CSS props `translate`, `scale`, `rotate`, `opacity` (book §5.3); params: `durationMs` (default 600), `delayMs` (0), `easingId` (default from Theme), `exit: boolean` (default true, mirrored).

| id | Label EN / ID | Enter → exit | P | Flags |
|---|---|---|---|---|
| `preset:motion.fade-in` | Fade in / Pudar masuk | opacity 0→1 | P0 | |
| `preset:motion.rise` | Rise / Naik | translateY +40u→0 + fade | P0 | |
| `preset:motion.pop` | Pop / Muncul membesar | spring scale 0→1 (damping 12) | P0 | |
| `preset:motion.slide-in` | Slide in / Geser masuk | translateX from `direction` | P0 | |
| `preset:motion.zoom-drift` | Zoom drift / Zoom pelan | scale 1→1.08 over the whole clip (Ken Burns) | P0 | |
| `preset:motion.spin-in` | Spin in / Putar masuk | rotate -20°→0 + scale | P1 | |
| `preset:motion.bounce` | Bounce / Pantul | Easing.bounce translateY | P1 | |
| `preset:motion.typewriter` | Typewriter / Ketik | text reveals per character (text only) | P1 | |
| `preset:motion.word-stagger` | Word stagger / Kata bergantian | spring per word with delay i×8 frames (book §5.5) | P1 | |
| `preset:motion.blur-in` | Blur in / Kabur masuk | blur `blurU` (16u)→0 + fade + scale 0.96→1 (ADR-034) | P1 | |
| `preset:motion.scale-in` | Scale in / Membesar halus | scale `fromScale` (0.7)→1 + fade, no overshoot (ADR-034; image default) | P1 | |
| `preset:motion.wipe-reveal` | Wipe reveal / Buka sapu | `clip-path: inset()` from `direction` (ADR-034; line accents) | P1 | |
| `preset:motion.draw-on` | Draw on / Gambar garis | shapes: outline stroked on with `@remotion/paths` `evolvePath`, fill fades in at the end (ADR-034) | P1 | |
| `preset:motion.grow` | Grow / Tumbuh | `scale` on one axis from the bar's base, `direction` up / down / left / right (ADR-034; bar charts) | P1 | |
| `preset:motion.none` | Static / Diam | — | P0 | |

ADR-034 optional params on every motion (absent = the behaviour above): `exitMs` (exit length; default = `durationMs`), `exitStyle` (`mirror` = entrance backwards, `fade` = opacity only), `bezier` ([x1, y1, x2, y2], wins over `easingId`), `loop` (`none|float|pulse|sway|spin`, a subtle idle loop after the entrance: float ±6 u via `@remotion/noise` `noise2D`, pulse ±3 %, sway ±2°, spin 45°/s). `rise.distanceU` allows 0–2000 (a bar value label rides up with its bar). Defaults when an add op names no motion: text variant `motionId` (title / subtitle rise, lower-third slide-in, callout pop, quote fade-in), shapes pop (line wipe-reveal; ring / check / chevron draw-on), images scale-in; `preset:motion.none` = static.

## 6. Shapes (`shape`) — list

Mapping: `@remotion/shapes` components; params: `size` (u), `fill` (theme accent), `stroke`, `strokeWidth`, `position` (`center|top-left|…|custom {x,y}` in u), `motionId` (optional motion preset).

| id | Label EN / ID | Component | P |
|---|---|---|---|
| `preset:shape.circle` | Circle / Lingkaran | `Circle` | P0 |
| `preset:shape.rect` | Rectangle / Kotak | `Rect` (`cornerRadius`) | P0 |
| `preset:shape.star` | Star / Bintang | `Star` (`points`, `innerRadius`) | P0 |
| `preset:shape.arrow` | Arrow / Panah | `Arrow` (`direction`) | P0 |
| `preset:shape.triangle` | Triangle / Segitiga | `Triangle` | P1 |
| `preset:shape.heart` | Heart / Hati | `Heart` | P1 |
| `preset:shape.pie` | Pie / Pai | `Pie` (`progress`) | P1 |
| `preset:shape.polygon` | Polygon / Poligon | `Polygon` (`points`) | P1 |
| `preset:shape.callout` | Callout / Balon | `Callout` | P2 |
| `preset:shape.spark` | Spark / Percik | `Spark` | P2 |
| `preset:shape.ellipse` | Ellipse / Elips | `Ellipse` | P2 |
| `preset:shape.line` | Line / Garis | `makeRect` w × h, round ends (underline, accent bar) | P1 |
| `preset:shape.ring` | Ring / Cincin | `makeCircle`, stroke only (frame around a number) | P1 |
| `preset:shape.pill` | Pill / Kapsul | `makeRect` w × h, radius h / 2 (button, badge) | P1 |
| `preset:shape.check` | Check / Centang | stroked tick path (list) | P1 |
| `preset:shape.chevron` | Chevron / Panah kecil | stroked chevron path (bullet) | P1 |
| `preset:shape.icon` | Icon / Ikon | flat two-colour inline SVG pictogram: `icon` (reactor, chip-ai, bolt, atom, data-center, shield, check, sun, cloud, moon, solar-panel, factory, card-ace, qr, play, globe, chat, money, clock, warning; default bolt), colours `fill` + `accent` (default theme accent2) (ADR-039) | P1 |
| `preset:shape.rows` | Rows / Baris | stacked rounded row panels with a letter `badge`, `title`, `sub`, `right` value, `rightSub`, `tone`; `rows` (≤ 8), `staggerMs` (120), `radiusU` (28); spring stagger entrance; `fill` = panel colour (theme bg2 when left at the accent) (ADR-039; no preview loop: data-driven) | P1 |
| `preset:shape.day-strip` | Day strip / Garis hari | 0–24 h axis with tick labels `hours` ([0,6,12,18,24]) and rounded `bars` (`label`, `fromH`, `toH`, `colour`, `icon`) growing from their start, optional `note` under the axis (ADR-039; no preview loop) | P1 |
| `preset:shape.browser-card` | Browser card / Kartu peramban | a drawn browser window: title bar with three dots and the `urlText` pill, `title`, optional `inner` pictogram pair (`reactor-datacenter` \| `none`), a progress track `fromLabel` → `toLabel` filling to `progress` (0–1) with a spring, `caption` (ADR-039) | P1 |
| `preset:shape.typing-box` | Typing box / Kotak ketik | a DM input pill: `prefixBadge` ("DM"), `text` typed at 18 chars/s when `typing` (blinking caret), a send button that turns into a check with a small pop at `sendAt` (ms into the element) (ADR-039) | P1 |
| `preset:shape.tag` | Tag / Label | small upper-case pill, `text`, `tone` (`info` accent2 \| `warn` \| `opinion` accent \| `illustration` outlined muted \| `positive` \| `negative` \| `neutral`); auto-fits the text (ADR-039) | P1 |
| `preset:shape.source-tag` | Source tag / Label sumber | muted pill (theme bg2 / muted text, body font 500) for a `text` such as "Sumber · date · checked"; the text auto-fits the width (ADR-039) | P1 |
| `preset:shape.bars-h` | Horizontal bars / Batang mendatar | label \| track \| value rows: `bars` (`label`, `value`, `unit`, `tone`; ≤ 8), `showValues` (true), `max` (default the largest value); bars grow with a stagger, values count in Indonesian number format (ADR-039; no preview loop) | P1 |

ADR-034: every shape is drawn by one SVG path renderer from the `@remotion/shapes` `make*` geometry, inside a w × h box (`op:shape.add` `height` makes it non-square); `preset:shape.rect` takes `outline` (border only, stroke colour, `strokeWidth`, default 8 u) and `dashU` (dashed border, e.g. a target bar); `cornerRadius` is in u.

ADR-039 (Reels infographics, `packages/engine/src/presets/infographics.tsx`): the eight data-driven presets above are HTML + inline SVG drawn with the theme fonts (heading / body) and the palette roles `bg2`, `muted`, `negative`, `warn` (fallbacks derived from bg / text when a palette lacks them); their text params are generic strings supplied by the composer (no project copy in the Engine). `rows`, `day-strip` and `bars-h` have no preview loop (`preview: false`): without data there is nothing to show.

No cut-off text (QA A16, 2026-10-31): none of these presets truncates or clips a text. Every run first shrinks from its preferred size to a floor on one line (tag / source tag 22 u, rows title 30 u, rows sub 20 u, rows right value 24 u, bars label 24 u, day-strip label 22 u, browser-card title 30 u / caption 22 u), then wraps at the floor into at most 2 lines (3 for `source-tag`), measured with the shared estimator (`fitTextWidth` / `balancedLineTexts`, `fitRun` in the Engine) so the quality gate sees the same lines; the pill / row / bar / card grows with its text (the stored box is the minimum height). `source-tag` may widen up to 90 % of the frame before adding a line and uses normal letter-spacing; `rows` keeps ≥ 55 % of the row for the title and lets `right` / `rightSub` shrink or wrap; a `day-strip` label that does not fit its bar runs past it over the track in the text colour. Text limits: `tag.text` ≤ 120, `source-tag.text` ≤ 300, row title / sub ≤ 120, `right` ≤ 40, bar / day labels ≤ 80. Every text run uses the font stack `"<family>", Inter, sans-serif` and math symbols (≤ ≥ ± × ÷ ≈ ≠ → ∞) are set in Inter, so they render at the heading size in Poppins (`packages/engine/src/font-stack.ts`; the same applies to Text Layers and captions).

## 7. Easing (`easing`) — scalar (Theme default) or per motion

Mapping: `Easing` from `remotion` (book §5.4 guide).

| id | Label EN / ID | Function | Use | P |
|---|---|---|---|---|
| `preset:easing.out-quad` | Smooth stop / Berhenti halus | `Easing.out(Easing.quad)` | enter | P0 |
| `preset:easing.out-cubic` | Soft landing / Mendarat lembut | `Easing.out(Easing.cubic)` | enter | P0 |
| `preset:easing.in-quad` | Speed away / Pergi cepat | `Easing.in(Easing.quad)` | exit | P0 |
| `preset:easing.in-out-cubic` | Glide / Meluncur | `Easing.inOut(Easing.cubic)` | move | P0 |
| `preset:easing.back` | Overshoot / Lewat sedikit | `Easing.out(Easing.back(2))` | playful enter | P0 |
| `preset:easing.bounce` | Bounce / Pantul | `Easing.bounce` | playful | P1 |
| `preset:easing.linear` | Linear / Linear | `Easing.linear` | technical | P1 |
| `preset:easing.spring-soft` | Spring soft / Pegas lembut | `spring({damping: 200})` | — | P1 |
| `preset:easing.spring-bouncy` | Spring bouncy / Pegas memantul | `spring({damping: 8})` | — | P1 |
| `preset:easing.snappy` | Snappy / Sigap | `Easing.bezier(0.2, 0.8, 0.2, 1)` | bars, charts (ADR-034) | P1 |
| `preset:easing.spring-light` | Spring light / Pegas ringan | `spring({damping: 14})` (slight overshoot) | pills, CTA (ADR-034) | P1 |

## 8. Visual effects (`effect`) — list (max 3 per element; T0 max 2)

Mapping: `@remotion/effects` via the `effects` prop on `<Video>`, `<Img>`, `<Solid>`, shapes (book App. A). All need WebGL (`gpu`); three need WebGPU (`webgpu`). Params per effect below; `intensity` 0–1 where applicable; animatable by frame via `motion` param (`static|in|out`).

| id | Label EN / ID | Effect | Params | P | Flags |
|---|---|---|---|---|---|
| `preset:effect.blur` | Blur / Kabur | blur | `radiusPx` (0–40) | P0 | gpu |
| `preset:effect.vignette` | Vignette / Vignet | vignette | `intensity` | P0 | gpu |
| `preset:effect.film-grain` | Film grain / Butir film | grain | `intensity` | P0 | gpu |
| `preset:effect.glow` | Glow / Cahaya lembut | glow/bloom | `intensity` | P0 | gpu |
| `preset:effect.colour-grade` | Colour grade / Gradasi warna | brightness+contrast+saturation | `brightness`, `contrast`, `saturation` | P0 | gpu |
| `preset:effect.greenscreen` | Green screen / Layar hijau | colorKey | `similarity` (0.3–0.6), `colour` | P0 | gpu |
| `preset:effect.pixelate` | Pixelate / Piksel | pixelate | `blockPx` | P1 | gpu |
| `preset:effect.halftone` | Halftone / Cetakan koran | halftone | `dotPx` | P1 | gpu |
| `preset:effect.chromatic` | Chromatic / Pendar warna | chromatic aberration | `offsetPx` | P1 | gpu |
| `preset:effect.wave` | Wave / Gelombang | wave distortion | `amplitude`, `frequency` | P1 | gpu |
| `preset:effect.thermal` | Thermal / Kamera panas | thermal map | — | P1 | gpu |
| `preset:effect.duotone` | Duotone / Dua warna | duotone | `colourA`, `colourB` | P1 | gpu |
| `preset:effect.light-leak` | Light leak / Bocor cahaya | light leak | `intensity` | P1 | gpu |
| `preset:effect.scanlines` | Scanlines / Garis TV | scanlines | `intensity` | P2 | gpu |
| `preset:effect.glitch-blocks` | Glitch / Glitch | block dissolve | `intensity` | P2 | gpu |
| `preset:effect.cylinder` | Cylinder / Tabung | cylinder (WebGPU) | `rotation` | P2 | webgpu |
| `preset:effect.sphere` | Sphere / Bola | sphere (WebGPU) | `rotation` | P2 | webgpu |
| `preset:effect.page-turn` | Page turn / Balik halaman | pageTurn (WebGPU) | `progress` | P2 | webgpu |

The remaining ~60 effects from Appendix A are added in P2 using the same row format; REMOTION_CAPABILITY_MAP.md lists the full group inventory.

## 9. Audio treatments (`audio`) — ducking exclusive per audio layer; others list

Mapping: `@remotion/media` `<Audio>` with `volume` curves via `interpolate` (book §6.4); `@remotion/media-utils` `visualizeAudio` for the visualiser (P2).

| id | Label EN / ID | Behaviour | Params | P |
|---|---|---|---|---|
| `preset:audio.bed-soft` | Soft music bed / Musik latar pelan | loop, volume 0.2, fade in/out 1 s | `volume`, `fadeMs` | P0 |
| `preset:audio.duck-voice` | Duck under voice / Redam saat suara | bed volume 0.5→0.15 during voice/clip audio with 500 ms ramps | `duckTo`, `rampMs` | P0 |
| `preset:audio.fade-in-out` | Fade in/out / Pudar masuk-keluar | per layer fades | `fadeInMs`, `fadeOutMs` | P0 |
| `preset:audio.sfx-hit` | Impact SFX / Efek hentakan | short sample at transitions (bundled CC0 pack) | `sampleId` | P1 |
| `preset:audio.visualizer-bars` | Visualizer / Visualisasi | `visualizeAudio` bars | `bars` (32/64), `colour` | P2 |

## 10. Text styles (`text`) — scalar per field; variant exclusive per Text Layer

Mapping: `fitText` from `@remotion/layout-utils` (fallback to the ported estimator), bundled fonts via `@remotion/fonts`, `@remotion/rough-notation` for highlights, `KineticText` (ported) for word animation. Size guide from book §4.5 in u: display 90–140, heading 64–90, body 44–56, small ≥ 34.

Variants:

| id | Label EN / ID | Defaults | P |
|---|---|---|---|
| `preset:text.title` | Title / Judul | 110u, weight 800, centre, motion rise | P0 |
| `preset:text.subtitle` | Subtitle / Subjudul | 64u, weight 600, centre | P0 |
| `preset:text.lower-third` | Lower third / Nama bawah | 48u, left, bar background, bottom-left safe area | P0 |
| `preset:text.callout` | Callout / Sorotan | 56u, box background | P0 |
| `preset:text.quote` | Quote / Kutipan | 72u, italic, quotes | P1 |

Text effects (`op:text.setEffect`, exclusive):

| id | Label EN / ID | Implementation | P |
|---|---|---|---|
| `preset:texteffect.highlight` | Highlight / Stabilo | rough-notation `Highlight` progress by frame | P0 |
| `preset:texteffect.underline` | Underline / Garis bawah | rough-notation underline | P1 |
| `preset:texteffect.circle` | Circle / Lingkari | rough-notation circle | P1 |
| `preset:texteffect.kinetic` | Kinetic words / Kata bergerak | `KineticText` spring per word | P0 |
| `preset:texteffect.counter` | Number counter / Angka berjalan | `AnimatedNumber` (ported, `packages/engine/src/format-number.ts`): the first number in the text counts from `from` (0) over `durationMs` (1200) after `delayMs` with `easingId` / `bezier`, written like the text (sign, Indonesian separators, decimals: "+17,2%", "US$ 25,96", "1.200"); never wraps | P1 |
| `preset:texteffect.keyword` | Keyword colour / Warna kata kunci | the `words` (≤ 8) in the accent colour (or `colour`) with a small spring pop (ADR-034) | P1 |

Fonts (bundled, OFL): `preset:font.inter` (Inter), `preset:font.plus-jakarta-sans` (Plus Jakarta Sans), `preset:font.archivo` (Archivo), `preset:font.jetbrains-mono` (JetBrains Mono) as woff2 (latin subset, 400–800, normal + italic, from `@fontsource`); `preset:font.poppins` (Poppins, ADR-039) as **TTF**, upright weights 500 / 600 / 700 / 800 / 900 only (no italics), files `packages/engine/public/fonts/poppins-<weight>-normal.ttf` taken unmodified from github.com/google/fonts at commit `8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5` (`ofl/poppins`, "Copyright 2020 The Poppins Project Authors", SIL Open Font License 1.1, `LICENSE-poppins.txt` beside the files; no woff2 converter is installed on the build host, so the loader uses `format("truetype")` from the preset's `format` data). Google Fonts are not used at runtime (offline rule).

## 11. Themes (`theme`) — scalar

Palettes from the book §4.4 (contrast-checked): `preset:palette.editorial-dark` (#14120F / #F4EFE6 / #E8913A / #4FD1A5, default), `preset:palette.paper-light`, `preset:palette.neon-tech`, `preset:palette.pastel-friendly`, `preset:palette.high-contrast`, `preset:palette.corporate-blue`, `preset:palette.editorial-teal` (ADR-034, editorial data journalism: #0F1A1F / #FFFFFF / #5DCAA5 / #EF9F27, plus roles read by the scene composer: negative #F0997B, muted #9FB3B8, neutral #888780, pill #1D9E75), `preset:palette.reels-navy` (ADR-039, Reels explainer: bg #0B1526 / text #F4F6FB / accent #FFD43B yellow / accent2 #4DD4C4 cyan, plus bg2 #121F38 (panels), negative #FF5C5C, warn #FFA94D, muted #8A97B3). Font pairs: `preset:fontpair.jakarta-inter` (default), `preset:fontpair.archivo-inter`, `preset:fontpair.inter-mono`, `preset:fontpair.inter-inter` (ADR-034, Inter only), `preset:fontpair.poppins-inter` (ADR-039, Poppins headings + Inter body).

## 12. P0 summary (must exist for v1.0; PRD-013)

Transitions 6 (+none) · Captions 3 (+none) · Backgrounds 5 (+video-dim, none) · Motion 5 (+none) · Shapes 4 · Easing 5 · Effects 6 · Audio 3 · Text variants 4 · Text effects 2 · Palettes 8 · Font pairs 5.

## 13. Catalogue search tags

Each preset carries `tags: string[]` in EN and ID (e.g. fade: `["soft","gentle","lembut","pudar"]`) used by `lib.search.input` and `catalogue.search`. Suggested queries shown in the search placeholder rotate through `SUGGESTED_QUERIES` in `packages/catalogue` (FR-035; each names the tab it opens and must return ≥ 1 P0 preset, enforced by the catalogue test): "smooth transition", "karaoke captions", "energetic motion", "calm background", "transisi halus", "teks karaoke".
