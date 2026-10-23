# UI/UX Specification

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md §7, §13, §16, GLOSSARY.md, ELEMENT_IDS.md, UXRD.md, USER_FLOWS.md, EDITOR_INTERACTION_MODEL.md, DESIGN_CATALOGUE.md (palettes, labels), PERFORMANCE.md (profiles tooltip, pixel table), AI_WORKFLOW.md (Plan Card, Intent Queue), DECISIONS.md (ADR-010, 011, 012), docs/assets/expertmotion-editor-mockup.png |
| Used by | FRD.md, TEST_PLAN.md, ACCESSIBILITY_AND_I18N.md, ONBOARDING_TOUR.md, ERROR_CATALOGUE.md, BLUEPRINT.md (apps/ui) |
| Owner of | design tokens, layout grid, component library, screen specifications, copy deck (UI strings), notification rules, Catalogue Card / Plan Card / Intent Queue item anatomy |
| ID range | CMP-01 … CMP-20 (components), SCR- sections keyed by element id |

The mockup (`docs/assets/expertmotion-editor-mockup.png`) says "Remason Editor" and uses a purple accent and placeholder values (480p, 768×768); this specification translates its structure into Expertmotion and replaces every placeholder with values owned by PERFORMANCE.md and DESIGN_CATALOGUE.md. Element ids are from ELEMENT_IDS.md and are never redefined here. Each string is EN / ID; the MVP UI renders EN (ADR-012). i18n keys follow ACCESSIBILITY_AND_I18N.md (`ui.<region>.<element>.<state>`).

## 1. Design system

### 1.1 Identity notes (what makes Expertmotion look like itself)

| Choice | Rationale |
|---|---|
| Dark, warm-neutral canvas with one warm accent (`#E8913A`, from `preset:palette.editorial-dark`) and a cool secondary (`#4FD1A5`) | The accent is the same colour the default Theme puts in the Creator's video, so the UI and the output feel related. CapCut-style apps use cool purples/cyans; we deliberately do not. |
| Content first: thumbnails and the Player are the only saturated areas; chrome is flat, no gradients, no glass | Keeps attention on the Creator's footage. |
| Typography carries hierarchy, not boxes: 13 px body, 11 px labels in upper-case tracking, 16/20/24 for headings | Low visual noise at 1280×720. |
| "Receipts" as a recurring motif: every AI action leaves a compact, bordered receipt (Intent Queue item, Plan Card, toast with version) | Makes P3 (visible and reversible) part of the look. |
| State badges use words, not just colour (Queued / Proposed / Executing / Applied) | Accessibility and the five-state model (UXRD §4). |
| Rounded 8 px cards, 6 px controls, 999 px chips; never pill-shaped primary buttons | Distinct from the mockup's pill buttons; calmer. |
| Lucide icons, 16 px in controls, 20 px in rails, 1.75 px stroke | One stroke weight everywhere. |

### 1.2 Colour tokens (CSS variables on `:root[data-theme="dark"]`, the default)

| Token | Value | Use |
|---|---|---|
| `--em-bg` | `#0E0F12` | Window background, Stage background |
| `--em-panel` | `#16181D` | Panels, cards, popovers |
| `--em-panel-2` | `#1C1F26` | Raised surfaces inside panels (chat bubbles assistant, inputs) |
| `--em-line` | `#262A33` | Borders, dividers, rulers |
| `--em-line-strong` | `#343946` | Hover borders, focus-adjacent |
| `--em-text` | `#F4F5F7` | Primary text |
| `--em-text-2` | `#C7CCD6` | Secondary text |
| `--em-muted` | `#9AA3B2` | Labels, placeholders, disabled text (never below 4.5:1 on `--em-panel`: 7.1:1) |
| `--em-accent` | `#E8913A` | Primary actions, selection, active states, playhead |
| `--em-accent-hover` | `#F0A458` | Hover on primary |
| `--em-accent-ink` | `#1A1206` | Text on accent (contrast 9.3:1) |
| `--em-accent-2` | `#4FD1A5` | Secondary emphasis: "applied directly", modified diff, success-adjacent info |
| `--em-success` | `#3DBE7A` | Applied, done, validated |
| `--em-warn` | `#F2C14E` | Warnings, approximate cost, T0 gating, stale |
| `--em-danger` | `#E5534B` | Errors, destructive actions, blocked |
| `--em-info` | `#6AA7F8` | Informational notices, update chip |
| `--em-overlay` | `rgba(14,15,18,0.72)` | Modal scrim |
| `--em-focus` | `#FFD27A` | Focus ring (2 px outside, 2 px offset) |
| `--em-private` | `#B48CFF` | Private Mode banner/icon only (reserved so it is recognisable) |

Light theme (P1, `data-theme="light"`) inverts bg/panel/text while keeping accent values; not specified further here.

### 1.3 Spacing, radii, shadows, motion

| Token group | Values |
|---|---|
| Spacing (4-pt) | `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 · `--sp-12` 48 |
| Radii | `--r-1` 4 (badges) · `--r-2` 6 (controls, inputs) · `--r-3` 8 (cards, popovers) · `--r-4` 12 (modals, Player frame) · `--r-pill` 999 (chips) |
| Shadows | `--sh-1` `0 1px 2px rgba(0,0,0,.4)` (cards) · `--sh-2` `0 6px 20px rgba(0,0,0,.45)` (popovers, raised card) · `--sh-3` `0 16px 48px rgba(0,0,0,.6)` (modals) |
| Motion | `--t-fast` 120 ms (hover, press, mode crossfade) · `--t-base` 200 ms (panel slide, toast in/out, element pulse) · `--t-slow` 320 ms (modal, Player aspect change) · easing `cubic-bezier(.2,.8,.2,1)`; reduced motion → all 0 ms except progress bars |
| Z-index | 10 panels · 20 dividers · 30 popovers · 40 toasts · 50 banners (`sys.privatemode.banner`, `sys.offline`) · 60 modals · 70 tour overlay |

### 1.4 Typography

| Style | Font | Size / line | Weight | Use |
|---|---|---|---|---|
| `t-label` | Inter | 11 / 16, +0.04 em, upper-case | 600 | Section labels ("PREVIEW", "ASSETS", "OUTPUT") |
| `t-body-s` | Inter | 13 / 18 | 400/500 | Default UI text, chat, table cells |
| `t-body` | Inter | 14 / 20 | 400/500 | Composer, dialogs |
| `t-title-s` | Inter | 16 / 22 | 600 | Card titles, Plan Card goal |
| `t-title` | Inter | 20 / 28 | 600 | Screen titles, onboarding step title |
| `t-display` | Inter | 24 / 32 | 700 | Onboarding welcome, success moment |
| `t-mono` | JetBrains Mono | 12 / 16 | 400 | Time display, pixel labels, version hashes, `EM-` codes |

Inter and JetBrains Mono are bundled (same woff2 as the Engine, DESIGN_CATALOGUE.md §10). Fallback stack in ACCESSIBILITY_AND_I18N.md §6.

### 1.5 Iconography (Lucide)

| Meaning | Icon | Meaning | Icon |
|---|---|---|---|
| File / Home / Design / Tools / Help | `folder`, `type`, `sparkles`, `wrench`, `circle-help` | Save / Backup / Restore | `save`, `archive`, `archive-restore` |
| Hardware Monitor | `activity` | Model Manager | `boxes` |
| Licence (trial / licensed) | `key-round` / `badge-check` | Export | `download` |
| Play / Pause / Fullscreen / Menu | `play`, `pause`, `maximize`, `menu` | Scrub frame | `chevron-left/right` |
| Insert | `list-plus` | Sequence Badge | numeral in circle (custom) |
| Transition / Caption / Background / Motion / Shape / Easing / Effect / Audio | `shuffle`, `captions`, `image`, `move`, `shapes`, `spline`, `wand-2`, `music-2` | Text | `type` |
| Queued / Proposed / Executing / Applied / Failed / Stale | `bookmark`, `lightbulb`, `loader` (spin), `check-circle-2`, `x-circle`, `history` | Undo / Redo | `undo-2`, `redo-2` |
| Private Mode | `shield` (`shield-check` when on) | Offline | `wifi-off` |
| GPU badge / Model badge | `cpu` / `download-cloud` | Info / Warn / Danger | `info`, `triangle-alert`, `octagon-alert` |
| Brainstorming Agent / Editor Agent | `message-circle` / `bot` | Handoff | `send-horizontal` |

Icons never appear without a text label or tooltip (UX-043).

## 2. Layout grid

```
┌ Header 48 px ──────────────────────────────────────────────────────────────┐
├ Library 300 ─┬ Stage flex (min 560) ───────────────────┬ Agent 360 ────────┤
│ search 36    │ Player frame (aspect-fit, padding 16)   │ Model Bar 44      │
│ mode hdr 32  │                                          │ Brainstorming ~40%│
│ catalogue /  │                                          │ Editor Chat ~60%  │
│ text / tools │                                          │  (incl. Intent    │
│ (scroll)     ├ Timeline View 220 min (resizable) ───────┤   Queue, Plan Card)│
│ Assets (≥160)│ ruler 24 · 5 tracks × 36 · inspector     │ Output Settings   │
└──────────────┴──────────────────────────────────────────┴───────────────────┘
 toasts bottom-right · banners under Header · render chip in Header
```

| Rule | Value |
|---|---|
| Header | 48 px, `--em-panel`, bottom border `--em-line`; left: logo + menu tabs; centre: title; right: actions + window controls |
| Columns | 300 / flex / 360 px at ≥ 1280; ranges and collapse in EDITOR_INTERACTION_MODEL.md §9–10 |
| Gutters | 16 px panel padding; 8 px between cards; 12 px between sections |
| Timeline View | 220 px minimum: ruler 24 + 5 Track lanes 36 each + 16 padding; inspector docks to the right of the lanes (260 px) when an element is selected, else hidden |
| Player frame | letterboxed inside the Stage with 16 px padding; aspect from the current ratio; frame border 1 px `--em-line`, radius `--r-4` |
| Baseline | 4 px; text sizes from §1.4 |

## 3. Component library

| ID | Component | Variants / props | States |
|---|---|---|---|
| CMP-01 | **Button** | primary (accent), secondary (panel-2 + line), ghost, danger; sizes 28/32/36; leading icon; loading | default, hover (+6 % lightness), active (−4 %), focus ring, disabled (40 % opacity + `cursor:not-allowed` + tooltip with reason), loading (spinner replaces icon, label stays) |
| CMP-02 | **IconButton** | 28/32; toggle variant | as Button; toggle-on uses `--em-accent` icon on `--em-panel-2`; always has `aria-label` + tooltip |
| CMP-03 | **Card** | padded surface, optional header, selectable | default, hover border `--em-line-strong`, selected 2 px accent inset, disabled |
| CMP-04 | **CatalogueCard** | see §11.1 | default, hover (raised, loop playing, live preview), selected, disabled-gated (gpu/model badge), loading (skeleton) |
| CMP-05 | **AssetCard** | thumb 96×54 (16:9) or 54×96; name; duration chip; kind icon; Sequence Badge; checkbox | default, hover, selected, ingesting (progress bar + step label), unsupported (danger border + reason), in-timeline (chip), dragging (ghost 80 %) |
| CMP-06 | **Badge** | neutral, accent, accent-2, success, warn, danger, info, private; icon optional; 11 px | — |
| CMP-07 | **Toggle** | with label and optional help icon | off, on (accent; Private Mode uses `--em-private`), disabled, focus |
| CMP-08 | **Segmented control** | 2–8 segments; optional sublabel (mono) under each; optional orientation glyph | default, active (panel-2 + accent text + 1 px accent border), disabled segment (muted + reason tooltip), warn segment (warn dot) |
| CMP-09 | **Tooltip** | text ≤ 2 sentences; optional shortcut; 400 ms delay; also on focus | — |
| CMP-10 | **Modal** | sizes 420/560/720; title; body; actions right-aligned; destructive variant (danger primary) | default; focus trapped; Esc closes unless `blocking` (export quit prompt) |
| CMP-11 | **Toast** | info, success, warn, danger; optional action; optional version chip; progress variant | enter/exit 200 ms; stack ≤ 3 (older collapse into "+2 more") |
| CMP-12 | **Progress** | bar (determinate/indeterminate), ring 16/24, with label and ETA slot | normal, paused (striped), error (danger) |
| CMP-13 | **Chat bubble** | user (right, accent-ink on `--em-panel-2` with accent left border), assistant (left, panel-2), system (centred, muted, 12 px); markdown subset (bold, lists, code spans); attachments thumb | streaming (caret), error (danger border + actions), cancelled (muted) |
| CMP-14 | **PlanCard** | see §11.2 | draft/valid (Proposed), executing, executed, failed, stale, invalid, cancelled |
| CMP-15 | **IntentItem** | see §11.3 | queued, compiled/applied, planned, executed, superseded, rejected, restored |
| CMP-16 | **TrackLane** | header 96 px (icon + name + mute/visibility toggles P1) + lane | default, focused, drop-target |
| CMP-17 | **ElementBar** | per element kind colour stripe: clip accent, overlay accent-2, text `#F4F5F7`, caption info, audio `#8FB3FF`, transition diamond on the Cut, effect/motion as small glyphs stacked above the bar, background full-width faint band, generated with `sparkles` glyph | default, hover (tooltip with name + times), selected (2 px accent), pulse-added/-modified/-removed, dimmed (outside playhead's Clip when "focus mode" on, P1) |
| CMP-18 | **Inspector** | property sheet: key/value rows in `t-body-s`, section headers, "Ask Editor Agent to change" button | default, multi-select summary, empty |
| CMP-19 | **Banner** | full-width under Header; private (private colour), offline (warn), update (info) | — |
| CMP-20 | **Field** | text, number with unit, select, colour swatch row, key (masked with reveal) | default, focus, error (danger line + message below), disabled, read-only |

## 4. Header (`hdr.*`)

Implements PRD-002, PRD-003, PRD-014, PRD-017, PRD-019.

| Element | Component | Content EN / ID | States | Notes |
|---|---|---|---|---|
| `hdr.logo` | wordmark (SVG) "Expertmotion" | — | hover underline; click → `scr.about` | Never "Remason" |
| `hdr.menu.file` … `.help` | tab buttons, 13 px 500 | File / Berkas · Home / Beranda · Design / Desain · Tools / Alat · Help / Bantuan | Home/Design/Tools: active tab has 2 px accent underline; File/Help open menus | Shortcuts 1/2/3 |
| `hdr.menu.file.*` | menu | New Video / Video Baru (Ctrl+N) · Open… / Buka… (Ctrl+O) · Recent / Terbaru ▸ · Save / Simpan (Ctrl+S) · Save As… / Simpan Sebagai… · Import… / Impor… (Ctrl+I) · Export… / Ekspor… (Ctrl+E) · Project Settings… / Pengaturan Proyek… · Recover… / Pulihkan… | Export disabled with reason until a Clip exists | Divider before Recover |
| `hdr.menu.help.*` | menu | Tour / Tur · Shortcuts / Pintasan (Shift+?) · Diagnostics / Diagnostik · Licence / Lisensi · Documentation / Dokumentasi · About / Tentang | — | Documentation opens local HTML in system browser |
| `hdr.title` | inline-edit text, `t-body` 500 | "Untitled" / "Tanpa Judul" default | edit (input), error "Name cannot be empty" / "Nama tidak boleh kosong" | ≤ 80 chars |
| `hdr.title.dirty` | 6 px accent dot after title | tooltip "Unsaved changes" / "Perubahan belum disimpan" | shown/hidden | |
| `hdr.action.hardware` | IconButton `activity` | tooltip "Hardware Monitor" / "Monitor Perangkat Keras" | warn dot when free RAM < 2 GB or disk < 1 GB | opens `scr.hardware` popover |
| `hdr.action.save` | IconButton `save` | "Save (Ctrl+S)" / "Simpan (Ctrl+S)" | disabled when clean | |
| `hdr.action.backup` / `.restore` | IconButton `archive` / `archive-restore` | "Back up project to zip" / "Cadangkan proyek ke zip" · "Restore project from zip" / "Pulihkan proyek dari zip" | restore shows info dot when a newer checkpoint exists (tooltip "Newer checkpoint available · File ▸ Recover") | |
| `hdr.action.models` | IconButton `boxes` | "Model Manager" / "Pengelola Model" | progress ring while downloading | |
| `hdr.action.purchase` | Button primary 28 | "Purchase" / "Beli Lisensi" | hidden when licensed | |
| `hdr.action.license` | IconButton `key-round` / `badge-check` | popover: "Trial Mode · watermark and 720p" / "Mode Uji Coba · watermark dan 720p" with Enter key / Purchase; or "Licensed to <name> · updates until <date>" / "Berlisensi atas nama <name> · pembaruan hingga <date>" | trial (warn), licensed (success), expired-updates (info) | |
| `hdr.action.export` | Button primary 32 `download` | "Export" / "Ekspor" | `.disabled` tooltip "Insert at least one clip first" / "Sisipkan minimal satu klip dulu"; while rendering shows `sys.render.progress` ring + "42 %" | |
| `sys.render.progress` | chip in Header | "Exporting 42 % · ≈ 1 min" / "Mengekspor 42 % · ≈ 1 mnt" | click reopens `scr.export` | |
| `hdr.win.*` | window controls | — | standard; close prompts if a render runs | |

## 5. Library Panel (`lib.*`)

Implements PRD-005, PRD-006, PRD-013, brief §7.2.

### 5.1 Common

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `lib.search.input` | Field text with `search` icon, 36 px | placeholder rotates (DESIGN_CATALOGUE.md §13): "Search: smooth transition…" / "Cari: transisi halus…"; `/` focuses | typing filters live; clear ×; empty result "No matches for '<q>'. Try 'fade' or 'karaoke'." / "Tidak ada hasil untuk '<q>'. Coba 'pudar' atau 'karaoke'." |
| `lib.search.suggestion` | chips under the field (first focus only) | the six suggested queries | click fills |
| `lib.mode.header` | `t-label` | PREVIEW / PRATINJAU · TEXT / TEKS · TOOLS / ALAT; right side chip "Picks apply to: clip 2" / "Pilihan berlaku untuk: klip 2" when a selection exists | — |

### 5.2 Design mode (`lib.catalogue.*`)

| Element | Component | Content / behaviour | States |
|---|---|---|---|
| `lib.catalogue.tab` | horizontal scrollable tabs, 28 px | Transitions / Transisi · Captions / Caption · Backgrounds / Latar · Motion / Gerak · Shapes / Bentuk · Easing / Easing · Effects / Efek · Audio / Audio; count badge | active underline; keyboard ←/→ |
| `lib.catalogue.card` | CMP-04 grid, 2 columns at 300 px (3 at ≥ 380), 8 px gap | one per Design Preset in the category, P0 first, then P1/P2 greyed with "Coming later" / "Segera hadir" badge (hidden by default; toggle "Show upcoming" / "Tampilkan yang akan datang" in the tab overflow) | see §11.1 |
| `lib.catalogue.empty` (search; proposed id) | empty pattern | as above | — |

### 5.3 Home mode (`lib.text.*`)

Order top to bottom; every control is a deterministic pick (IX-03/IX-04).

| Element | Component | Content EN / ID | Notes |
|---|---|---|---|
| Add Text block | Field text + `lib.text.add` Button primary | placeholder "Type your text…" / "Ketik teks Anda…"; button "Add Text" / "Tambah Teks" | Enter adds; empty → "or let the Editor Agent suggest one" link |
| `lib.text.variant` | Segmented 2×2 | Title / Judul · Subtitle / Subjudul · Lower third / Nama bawah · Callout / Sorotan (P1 adds Quote / Kutipan) | `preset:text.*` |
| `lib.text.font` | Select with font preview | Plus Jakarta Sans · Inter · Archivo · JetBrains Mono (`preset:font.*`) | bundled only |
| `lib.text.size` | Segmented presets + number field (u) | 34 · 48 · 64 · 90 · 110 · custom; help "Sizes scale with the video; 34 is the smallest readable on phones" / "Ukuran mengikuti video; 34 adalah yang terkecil terbaca di ponsel" | book §4.5 ranges |
| `lib.text.weight` | IconButton toggles | Bold / Tebal · Italic / Miring · weight slider 400–800 | |
| `lib.text.colour` | swatch row from Theme + custom hex | "Theme colours" / "Warna tema" | palette from `preset:palette.*` |
| `lib.text.align` | Segmented 3 | Left / Kiri · Centre / Tengah · Right / Kanan | |
| `lib.text.effect` | small CatalogueCards 1 row | Highlight / Stabilo · Kinetic words / Kata bergerak (P0); Underline, Circle, Counter (P1) | `preset:texteffect.*` |
| `lib.text.opacity` | slider 0–100 % | "Opacity (selected element)" / "Opasitas (elemen terpilih)" | disabled with reason when nothing selected |
| `lib.text.ratio` / `lib.text.videosize` | link rows | "Ratio: 9:16 · change in Output Settings →" / "Rasio: 9:16 · ubah di Output Settings →" | focus moves to `agent.output.ratio.*` |
| `lib.text.insert.image` / `.insert.video` | Button secondary | "Insert Image…" / "Sisipkan Gambar…" · "Insert Video…" / "Sisipkan Video…" | import + Insert (IX-05) |

### 5.4 Tools mode (`lib.generator.card.*`)

| Card | Title EN / ID | Subtitle EN / ID | Availability badge |
|---|---|---|---|
| `.voice` | Generate Voice / Buat Suara | "Indonesian and English voices, offline" / "Suara Indonesia dan Inggris, offline" | P1; model badge if not installed |
| `.captions` | Generate Captions / Buat Caption | "From your video's audio, offline" / "Dari audio video Anda, offline" | P1; model badge |
| `.music` | Generate Music / Buat Musik | "Needs a GPU with 4 GB" / "Perlu GPU 4 GB" on T0 | P2 "Coming later" |
| `.thumbnail` | Generate Thumbnail / Buat Thumbnail | "Cover image from a frame and your title" / "Gambar sampul dari frame dan judul Anda" | P2 |
| `.hashtags` | Suggest Hashtags / Saran Hashtag | "Uses your connected AI model" / "Memakai model AI yang terhubung" | P1; disabled in Private Mode with reason |

### 5.5 Asset Panel (`lib.assets.*`)

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `lib.assets.panel` | section, `t-label` "ASSETS" / "ASET" + count + Import IconButton | — | min height 160; grows with the panel |
| `lib.assets.drop` | whole panel | drag-over overlay "Drop to import" / "Lepas untuk mengimpor" | |
| `lib.assets.empty` | empty pattern `upload` icon | "Drop video, image or audio here" / "Letakkan video, gambar, atau audio di sini" · "MP4, MOV, WebM, MKV · PNG, JPG, WebP, GIF · MP3, WAV, AAC, M4A, OGG" · button "Import files…" / "Impor berkas…" · footnote "Then number them and press Insert." / "Lalu beri nomor dan tekan Insert." | — |
| `lib.assets.card` | CMP-05, 2 columns | name (truncate middle), duration `t-mono`, kind icon | see CMP-05 |
| `lib.assets.card.meta` | tooltip / inspector row | "1920×1080 · 30 fps · 0:15 · stereo · 48 MB" | |
| `lib.assets.card.badge.sequence` | 20 px circle top-left | number or "+" | hover "Click to set order" / "Klik untuk mengatur urutan" |
| `lib.assets.card.select` | checkbox top-right | — | |
| `lib.assets.card.state.ingesting` | progress bar + step | "Probing… / Making proxy… / Thumbnails…" / "Memeriksa… / Membuat proxy… / Thumbnail…" | |
| `lib.assets.card.state.unsupported` | danger border | reason + "Remove" / "Hapus" | |
| `lib.assets.insert` | Button primary full-width 36 | "Insert" / "Sisipkan" → "Insert 3" / "Sisipkan 3" | disabled "Select assets to insert" / "Pilih aset untuk disisipkan" |
| `lib.assets.error` | inline banner danger | "2 files could not be imported · Details" / "2 berkas tidak dapat diimpor · Rincian" | dismiss |

## 6. Stage (`stage.*`)

Implements PRD-007, PRD-009.

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `stage.player.frame` | Card radius 12, aspect-fit | header row: "Player" `t-label` left (mockup) is **dropped**; instead a slim 28 px bar with `stage.player.controls.ratio` "9:16", `.res` "1080×1920", version chip "v13 ✓" (mono) and `stage.player.menu` right | — |
| `stage.player.canvas` | Remotion Player surface | — | playing, paused, previewing chip "Previewing Fade" / "Mencoba Pudar" (accent, top-left), Draft chip "Draft" bottom-right when proxy quality |
| `stage.player.controls` | 40 px bar under canvas | `.play`/`.pause` (Space) · `.scrubber` (full width, accent fill, hover shows time) · `.time` "00:12.08" / `.duration` "00:42.00" `t-mono` · `.fullscreen` | hover thumb enlarges; keyboard ←/→ |
| `stage.player.menu` | popover menu | Safe area overlay / Garis aman · Draft quality / Kualitas Draft (toggle; disabled "Turbo uses full quality" on Turbo) · Loop / Ulang · Mute / Bisu · Seek on select / Lompat saat memilih | checkmarks |
| `stage.player.state.loading` | skeleton canvas + spinner + label | "Loading preview…" / "Memuat pratinjau…"; after 8 s "This is taking longer than usual" / "Ini lebih lama dari biasanya" | |
| `stage.player.state.error` | error card inside canvas | "Preview could not load clip 2 · EM-1xxx" / "Pratinjau tidak dapat memuat klip 2 · EM-1xxx" · Rebuild preview / Bangun ulang pratinjau · Details / Rincian | |
| `stage.timeline` | panel under Player | header row: `t-label` "TIMELINE" / "LINI MASA", zoom −/+ (fit, 1 s/100 px … 10 s/100 px), total duration | |
| `stage.timeline.ruler` / `.head` | 24 px ruler `t-mono` ticks; playhead 2 px accent line with triangle head | click/drag seeks | |
| `stage.timeline.track.video/.overlay/.text/.caption/.audio` | CMP-16 lanes; names Video / Video · Overlay / Lapisan · Text / Teks · Captions / Caption · Audio / Audio | project-wide items (caption style, background) show as a chip in the lane header: "Karaoke" / "Spotlight" | drop-target |
| `stage.timeline.element.*` | CMP-17 | label = asset name / text content / preset label; times on hover | selected, pulses |
| `stage.timeline.inspector` | CMP-18 docked right 260 px | header "Clip 2 · beach.mp4" / "Klip 2 · beach.mp4"; rows: Start, Duration, Trim, Playback rate, Volume, Fit, Motion, Effects (chips), Transition in/out; button "Ask Editor Agent to change" / "Minta Editor Agent mengubah" (A); P1 adds editable trim | empty "Select an element to inspect it" / "Pilih elemen untuk melihat rinciannya" |
| `stage.timeline.empty` | empty pattern over lanes | "Insert assets, then your picks and the Editor Agent fill this timeline." / "Sisipkan aset, lalu pilihan Anda dan Editor Agent mengisi lini masa ini." | hidden once a Clip exists |

## 7. Agent Panel (`agent.*`)

Implements PRD-010, PRD-011, PRD-012, PRD-008, PRD-020.

### 7.1 Model Bar

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.modelbar` | 44 px row, clickable | "Model: OpenRouter · claude-3.5-sonnet" / "Model: OpenRouter · claude-3.5-sonnet" + chevron → `scr.providers` | not configured: "Connect an AI provider" / "Hubungkan penyedia AI" (accent text) |
| `agent.modelbar.status` | 8 px dot + icon | validated (success) · error (danger, tooltip `EM-4xxx`) · Private Mode (`shield-check`, private colour, "Private Mode: agents paused" / "Mode Privat: agen dijeda") | |

### 7.2 Brainstorming Chat (`agent.brainstorm.*`)

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.brainstorm.panel` | section header `t-label` "BRAINSTORMING AGENT" + help icon (tooltip "Ideas and planning. Never changes your video directly." / "Ide dan perencanaan. Tidak pernah mengubah video Anda secara langsung.") | — | collapsible |
| `agent.brainstorm.thread` | scroll area; CMP-13 bubbles | first-run system bubble: "Tell me what the video is for and who will watch it." / "Ceritakan video ini untuk apa dan siapa penontonnya." | empty, streaming, error |
| `agent.brainstorm.handoff` | Card accent-dashed border inside the thread | title "Proposed changes" / "Usulan perubahan"; rows with checkbox + category icon + "Caption style · Editorial → project"; buttons "Send to Editor Agent" / "Kirim ke Editor Agent" (primary) · "Dismiss" / "Abaikan" (ghost) | collapsed receipt after action |
| `agent.brainstorm.composer` | textarea auto-grow 1–6 lines, `.attach` IconButton `paperclip`, `.send` IconButton `send-horizontal` | placeholder "Describe your idea…" / "Jelaskan ide Anda…"; disabled note in Private Mode (UX-024) or when not configured "Connect a provider to chat" / "Hubungkan penyedia untuk mengobrol" | status line above: "Asking <model>…" + Cancel |
| `agent.brainstorm.footer.model` | select-like text button | "claude-3.5-sonnet ▾" | opens per-agent Model Assignment |
| `agent.brainstorm.footer.ctx` | `t-mono` | "1 240 / 200 000" + tooltip "Context used in the last request / model limit" / "Konteks terpakai pada permintaan terakhir / batas model" | amber ≥ 60 %, red ≥ 85 % |

### 7.3 Editor Chat (`agent.editor.*`)

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.editor.panel` | header `t-label` "EDITOR AGENT" + help ("Turns your picks and instructions into a plan. Nothing changes until you press Execute." / "Mengubah pilihan dan instruksi Anda menjadi rencana. Tidak ada yang berubah sampai Anda menekan Execute.") | — | |
| `agent.editor.intentqueue` | list pinned at the top of the thread area; header "Your picks (3)" / "Pilihan Anda (3)" + `.clear` ghost "Clear" / "Bersihkan" | CMP-15 items, newest first | empty: "Your picks and requests appear here." / "Pilihan dan permintaan Anda muncul di sini." |
| `agent.editor.thread` | CMP-13 bubbles between queue and composer | system bubbles for handoffs and results | |
| `agent.editor.plancard` | CMP-14 (§11.2) | — | — |
| `agent.editor.execute` | Button primary 36 inside the Plan Card footer | "Execute" / "Execute" (kept as a product term; tooltip "Apply this plan (Ctrl+Enter)" / "Terapkan rencana ini (Ctrl+Enter)") | disabled reasons: "No plan yet" / "Belum ada rencana" · "Composition changed; re-plan" / "Komposisi berubah; susun ulang" · "Plan has a blocking issue" / "Rencana punya masalah pemblokir" |
| `agent.editor.cancel` | Button ghost | "Cancel" / "Batal" | enabled while running |
| `agent.editor.composer` / `.send` / `.attach` | as brainstorm | placeholder "Tell the Editor Agent what to change…" / "Katakan pada Editor Agent apa yang harus diubah…"; target chip "clip 2" removable | |
| `agent.editor.footer.model` / `.footer.ctx` | as brainstorm | + badge "JSON mode" when the model lacks tool calling | |

### 7.4 Output Settings (`agent.output.*`)

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.output` | section header `t-label` "OUTPUT" / "KELUARAN" + summary when collapsed "9:16 · 1080p · Standard" | — | collapsible |
| Performance Profile row | label "Performance profile" / "Profil performa" + `agent.output.profile.help` ⓘ (PERFORMANCE.md §2 tooltip verbatim) | `agent.output.profile.standard/.accelerated/.turbo` Segmented 3: Standard / Standard · Accelerated / Accelerated · Turbo / Turbo; sublabels "1 frame at a time · Draft preview" / "Accelerated: 2 in parallel" / "Turbo: up to 4 · Full preview" (short EN: "1× · Draft", "2× parallel", "4× · Full") | disabled with reason "Needs a GPU with 4 GB" / "Perlu GPU 4 GB"; Turbo on T1 warn dot "May use a lot of memory" / "Bisa memakai banyak memori" |
| Aspect Ratio row | label "Aspect ratio (width:height)" / "Rasio aspek (lebar:tinggi)" + ⓘ (proposed `agent.output.ratio.help`: "Width first, then height. The preview frame changes shape; your clips are fitted inside." / "Lebar dulu, lalu tinggi. Bingkai pratinjau berubah bentuk; klip Anda disesuaikan di dalamnya.") + `agent.output.ratio.auto` Toggle "Auto" / "Otomatis" (tooltip "Use the first clip's shape" / "Pakai bentuk klip pertama") | `agent.output.ratio.16x9/.9x16/.1x1/.4x5/.5x4/.4x3/.3x4/.custom` Segmented 4×2, each with orientation glyph (rectangle outline in true proportion) + label + `t-mono` pixel sublabel from PERFORMANCE.md §3 for the current Resolution, e.g. "9:16 · 1080×1920" | active; Custom opens W:H fields (clamped 1:3…3:1, ≥ 240 px) |
| Resolution row | label "Resolution" / "Resolusi" | `agent.output.resolution.720p/.1080p/.2k/.2160p` Segmented 4: "720p" · "1080p" · "2K" · "2160p (4K)" with pixel sublabels for the current ratio | `.disabled` sublabel "Needs a GPU tier" / "Perlu GPU"; 2160p on T1 warn dot; Trial Mode: 1080p+ shows lock glyph "Trial exports at 720p" / "Uji coba mengekspor 720p" (still selectable; export forces 720p) |
| `agent.output.private` | Toggle private colour + label "Private Mode" / "Mode Privat" + ⓘ (proposed `agent.output.private.help`: "Blocks all internet use: AI agents, model downloads, update checks. Editing and export keep working." / "Memblokir semua penggunaan internet: agen AI, unduhan model, pemeriksaan pembaruan. Penyuntingan dan ekspor tetap berjalan.") | — | on/off |
| `agent.output.reset` | Button ghost `rotate-ccw` | "Reset to Defaults" / "Kembalikan ke Bawaan" | confirmation (IX-19) |

Frame rate and duration are **not** here (ADR-010); a link row "Frame rate 30 fps · Project Settings →" / "Laju bingkai 30 fps · Pengaturan Proyek →" sits under Resolution.

## 8. Screens and dialogs (`scr.*`)

| Screen | Layout | Content EN / ID (key items) | States | Implements |
|---|---|---|---|---|
| `scr.onboarding` | full-window, 720 px centred column, step indicator 1–6, "Skip setup" ghost top-right | copy in ONBOARDING_TOUR.md §2 | per step | PRD-018 |
| `scr.license` | Modal 560 | status card; `.input` masked key field with paste button; `.activate` primary "Activate" / "Aktifkan"; `.trial.continue` ghost "Continue with trial" / "Lanjutkan uji coba"; purchase link "Buy a licence (opens browser)" / "Beli lisensi (membuka browser)"; `.error` inline; proposed `.rebind` confirm card | idle, validating, success, error, rebind | PRD-017, F13 |
| `scr.providers` | Sheet 560 from right; `.list` of Provider Connections; `.add` | `.provider.select` (OpenRouter default; OpenAI, Anthropic, Google Gemini P1) · `.key.input` masked · `.validate` "Validate" / "Validasi" · `.models.list` table: model, context (k), tools ✓, structured ✓, streaming ✓, price "≈ $/M in · out" or "n/a" · `.assign.brainstorm` / `.assign.editor` selects · `.budget.limit` per project and per month ($) with "Warn at 80 %" · `.test` "Test both" / "Uji keduanya" · `.save` primary | validating, error `EM-4xxx`, saved | PRD-010, PRD-011, brief §9 |
| `scr.models` | Sheet 640 | `.tier` header "Your PC: T0 · CPU only" / "PC Anda: T0 · hanya CPU"; `.list` grouped by engine; `.row`: name, task, size, licence (link to notice), min tier, state; `.row.install` / `.row.remove`; `.row.progress` "312 MB / 1.6 GB · ≈ 10 min" | installed, downloading, paused (Private Mode), failed `EM-7xxx` | ADR-008, F11 |
| `scr.hardware` | Popover 320 anchored to `hdr.action.hardware` | `.cpu` "CPU 23 %" · `.ram` "RAM 9.1 / 16 GB" · `.procmem` "Expertmotion 612 MB" · `.disk` "Disk free 48 GB" · `.gpu` "GPU: present / not detected" (percent only with nvidia-smi) · `.workload` "Rendering 42 % · Ingest idle" / "Merender 42 % · Impor diam"; footer "Tier T0 · readings stay on this PC" / "Tier T0 · data tetap di PC ini" | refreshing every 2 s while open | PRD-019 |
| `scr.project.new` | Modal 420 | `.name`; fps select (default 30); ratio default Auto; resolution default 1080p; "Create" / "Buat" | — | PRD-003 |
| `scr.project.open` | Modal 560 | recent list (name, last opened, duration, thumbnail) + "Browse…" / "Telusuri…" | empty "No projects yet" / "Belum ada proyek" | PRD-003 |
| `scr.project.settings` | Modal 560 | `.name` · `.fps` 24/25/30/50/60 · `.ratio` · `.resolution` · `.duration.policy` "Fit content" / "Sesuai isi" · "Fixed" / "Tetap" + ms · `.output.folder` path + Browse · language "Indonesian / English" (project language for agents and generators) | fps change note "Timing stays the same; frame counts are recalculated" / "Waktu tetap sama; jumlah frame dihitung ulang" | PRD-008 |
| `scr.project.recover` | Modal 560 | list of checkpoints: time, version, "3 changes after last save"; actions Restore / Pulihkan · Open last saved / Buka simpanan terakhir · Show both / Tampilkan keduanya | auto-opens on relaunch when newer checkpoint exists | PRD-003, F9 |
| `scr.export` | Modal 560, two phases | **Setup:** `.profile.summary` "9:16 · 1080×1920 · 30 fps · 0:42 · Standard"; `.codec` Segmented "MP4 (H.264)" / "GIF" / "PNG still"; `.quality` select Standard/High (CRF); `.filename`; `.folder` + Browse; `.preflight` checklist rows (Disk, Memory, Dimensions, Duration, Assets, Engine, Licence) each ✓ / ⚠ / ℹ with message; estimate line "≈ 1 min 30 s · ≈ 35 MB" (from `render.estimate`); `.start` primary "Start export" / "Mulai ekspor". **Running:** `.progress` bar + "Frame 412 / 1260 · 33 %"; `.eta` "Estimating…" → "≈ 1 min left" / "≈ 1 mnt lagi"; `.cancel` danger ghost; "You can close this and keep editing" / "Anda bisa menutup ini dan terus menyunting". **Done:** `.done` thumbnail, name, size, duration; `.open.folder` primary "Open folder" / "Buka folder"; "Export again" / "Ekspor lagi"; share hint none (no cloud) | blocked, running, done, failed (`EM-3xxx` + Try again / Details), cancelled | PRD-014, F8 |
| `scr.generate.*` | Sheet 480 | `.input` (script / prompt / source) · `.language` id/en · `.model` installed models (+ Install link) · `.run` primary "Generate" / "Buat" · `.progress` · `.result` (player / editable pages / image grid / hashtag chips with copy) · `.insert` primary "Insert into video" / "Sisipkan ke video" | model missing, running, done, failed `EM-7xxx` | PRD-031/033 (P1), PRD-051/052 (P2) |
| `scr.diagnostics` | Sheet 640 | tabs Logs / Versions / Hardware; "Copy diagnostics bundle" / "Salin bundel diagnostik" (zip path shown); note "Secrets are redacted" / "Rahasia disamarkan" | — | PRD-015, PRD-021 |
| `scr.about` | Modal 420 | wordmark, version, licence state, "Third-party notices" / "Pemberitahuan pihak ketiga" (incl. GPL source offer for the TTS engine), "Known limitations" / "Keterbatasan yang diketahui", "Update checks paused (Private Mode)" when applicable | — | PRD §7.5 |

## 9. Empty, loading and error patterns

| Pattern | Anatomy | Rules (UXRD §6) |
|---|---|---|
| Empty | icon 32 px muted · `t-title-s` headline · `t-body-s` sentence · one primary button · optional footnote | ≤ 2 sentences; teaches the next step |
| Skeleton | panel-2 blocks with 1.2 s shimmer (disabled under reduced motion) | layout-stable regions: catalogue grid, asset grid, Player canvas |
| Spinner | ring 16/24 + verb label | "Loading preview…", "Asking <model>…", "Preparing proxy…"; after 8 s add "This is taking longer than usual"; cancel when supported |
| Inline error | danger left border 2 px · `EM-` code in `t-mono` · one sentence · 1–2 actions · "Details" disclosure (copies code, time, context) | shown at the origin; no technical words |
| Error card | inside the region (Player, sheet) with same anatomy | for regions that cannot show content |
| Degraded | control visible, disabled, reason adjacent or in tooltip; badge where applicable | never hide |

## 10. Notification rules

| Type | Component | Duration | Stack | Examples |
|---|---|---|---|---|
| Success receipt | Toast success with version chip + Undo | 6 s (hover pauses) | ≤ 3 | "Applied: 3 changes · v13 · Undo" / "Diterapkan: 3 perubahan · v13 · Batalkan" |
| Info | Toast info | 4 s | ≤ 3 | "Saved" / "Tersimpan" (1.5 s) · "Private Mode off. Agents available." |
| Warning | Toast warn | 8 s | ≤ 3 | "Shortened transition to 400 ms to fit clip 2" |
| Error needing action | Toast danger, **persistent** until dismissed or action taken | ∞ | ≤ 3 | "Export failed · EM-3xxx · Try again · Details" |
| Progress | Toast progress (background jobs: backup, model download) or Header chip (render) | until done | 1 per job | "Backing up… 3 of 12" |
| Banner | CMP-19 under Header | while condition holds | 1 per kind | Private Mode, offline, update |
| Live region (a11y) | visually hidden `aria-live="polite"` | — | — | "Plan ready: …", "Applied, version 13" |

Rules: errors originating in a visible region are inline, not toasts; toasts never cover the Player controls (bottom-right, above the Timeline View's bottom edge); only one toast with the same `EM-` code is shown at a time (counter badge "×3"); `sys.offline` suppresses all other error toasts; no sound.

## 11. Anatomy of the three signature components

### 11.1 Catalogue Card (CMP-04, `lib.catalogue.card`) — ADR-011

```
┌───────────────────────────────┐
│ ┌───────────────────────────┐ │  .thumb  16:9 (or ratio of project), radius 6
│ │  prerendered 2 s webm     │ │  loop: paused until hover/focus (reduced motion: static poster)
│ │  loop (480 px, ≤ 400 KB)  │ │  overlay bottom-left: duration/params chip when hovered ("500 ms")
│ │                      [GPU]│ │  .badge.gpu top-right (T0 only) · .badge.model top-right
│ └───────────────────────────┘ │
│ Fade                      ⓘ   │  .label t-body-s 500 (EN; ID via i18n) · ⓘ opens params "Details"
└───────────────────────────────┘
```

| Part | Spec |
|---|---|
| Size | 2-column grid: 134×(75+28) at 300 px panel; 3-column at ≥ 380 px |
| Hover | raise 2 px + `--sh-2`, border `--em-line-strong`; thumb loop plays; **live preview** request to the Player after 150 ms (EDITOR_INTERACTION_MODEL.md IX-01); Player shows chip "Previewing Fade" / "Mencoba Pudar" |
| Selected (`.selected`) | 2 px accent inset + `bookmark` glyph top-left; tooltip "In your picks" / "Dalam pilihan Anda" |
| Badges | `.badge.gpu` `cpu` glyph warn: "Slower without GPU" / "Lebih lambat tanpa GPU"; `.badge.model` `download-cloud` info: "Needs <model> · click to install" / "Perlu <model> · klik untuk memasang"; P1/P2: "Coming later" / "Segera hadir" (card 50 % opacity, not clickable) |
| Details (ⓘ) | popover with param fields (defaults from DESIGN_CATALOGUE.md) and "Apply with these settings" / "Terapkan dengan pengaturan ini"; still a Compile path (fully specified) |
| Keyboard | focus = hover behaviour; Enter = click; Space = Details |
| Loading | skeleton thumb + label bar |
| Data attributes | `data-el="lib.catalogue.card" data-preset-id="preset:transition.fade"` |

### 11.2 Plan Card (CMP-14, `agent.editor.plancard`) — AI_WORKFLOW.md §3 `EditPlan`

```
┌ [lightbulb] PROPOSED · Editor Agent · based on v12 ──────────── [history] ┐  header: state badge (S2/S3/S4/failed/stale), origin, .baseversion
│ .goal  "Add an energetic opening title"                                      │  t-title-s
│ ─────────────────────────────────────────────────────────────────────────── │
│ .step 1  [composition.applyOps]  Add Title 'Liburan Seru!' 0.0–3.0 s        │  .step.tool chip (muted) · .step.diff t-body-s
│ .step 2  [composition.applyOps]  Rise motion + Highlight on the title       │  dependsOn shown as indent
│ .step 3  [captions.generate]     Transcribe 0:42 (whisper, offline)         │  sub-agent steps show engine + "offline"
│ ─────────────────────────────────────────────────────────────────────────── │
│ .risk  ⚠ Title overlaps caption area for 0.4 s · info                        │  severity icon/colour: info/warn/block
│ .risk  ⛔ Skipped: would change transition on cut 1 (your pick)              │  Locked Key notice
│ .notes [ Notes for the next plan… / Catatan untuk rencana berikutnya… ]      │  textarea; never parsed; sent as creatorNotes
│ usage  1 240 in · 310 out · ≈ $0.004  ⓘ                                      │  "≈" when computed; "n/a" when unknown
│ ────────────────────────────────────────────────────────────────────────── │
│ [Discard]                              [Re-plan]        [ Execute  ⌃↵ ]     │  footer: ghost · secondary · primary (agent.editor.execute); .cancel replaces Execute while running
└──────────────────────────────────────────────────────────────────────────────┘
```

| State | Header badge EN / ID | Border | Footer |
|---|---|---|---|
| draft/valid | "Proposed · nothing applied yet" / "Usulan · belum diterapkan" | dashed accent | Execute enabled (valid) |
| invalid | "Needs changes" / "Perlu perubahan" (danger) | dashed danger | Execute disabled; validation rows shown |
| stale (`.baseversion.stale`) | "Composition changed; re-plan" / "Komposisi berubah; susun ulang" (warn) | dashed warn | Re-plan primary |
| executing | "Executing… step 2 of 3" / "Menjalankan… langkah 2 dari 3" | solid accent | Cancel |
| executed | "Applied · version 13" / "Diterapkan · versi 13" (success) | solid success, collapses to one line after 10 s | Undo |
| failed | "Not applied · EM-2xxx" / "Tidak diterapkan · EM-2xxx" | solid danger | Try again · Details |
| cancelled | "Cancelled" / "Dibatalkan" (muted) | muted | Re-run |
| interrupted | "Interrupted · re-run" / "Terputus · jalankan ulang" | muted | Re-run |

Previous plans collapse under "Previous plans (2)" / "Rencana sebelumnya (2)". A compiled plan (`origin: compile`) is **not** shown as a Plan Card; it appears as an Intent Queue item "applied directly" plus a toast (UX-013).

### 11.3 Intent Queue item (CMP-15, `agent.editor.intentqueue.item`) — AI_WORKFLOW.md §6

```
┌ [shuffle] Transition · Slide → all 2 cuts            ● applied directly · v3   [×] ┐  queued/compiled
├ [shuffle] ~~Transition · Fade → all 2 cuts~~         replaced by Slide   [Restore] ┤  .item.superseded
├ [type]    Font size 72 (replaced 96) → Title "Diskon 50%"   ● applied · v5       ┤  scalar supersede text
├ [wand-2]  Effects: Vignette, Film grain → clip 2    ● applied · v6               ┤  list accumulation
├ [bot]     "buat judul pembuka yang kuat"            ◐ needs the Editor Agent      ┤  chat/brainstorm source, S1
├ [move]    Motion · Pop → ?                          ⛔ Select a clip · EM-2201 [×] ┤  rejected with reason
└───────────────────────────────────────────────────────────────────────────────────┘
```

| Part | Spec |
|---|---|
| Left | category icon (§1.5); source glyph when not `ui`: `message-circle` (brainstorm) / `bot` (chat) |
| Title | "<Category> · <Preset label> → <resolved target>" from `resolvedTargets` ("all 2 cuts", "cut 2", "project", "Title 'Diskon 50%'", "new text"); truncate with tooltip |
| Status chip (right) | queued `bookmark` muted "Queued" / "Antre" · compiled `check` accent-2 "applied directly · v3" / "langsung diterapkan · v3" · planned `lightbulb` "in plan" / "dalam rencana" · executed `check-circle-2` success "applied · v5" / "diterapkan · v5" · rejected `octagon-alert` danger reason + code · restored `history` "restored" / "dipulihkan" |
| Superseded (`.item.superseded`) | whole title struck through (`text-decoration: line-through`), 60 % opacity, chip "replaced by <label>" / "diganti oleh <label>", `.item.restore` ghost button "Restore" / "Pulihkan" always visible (not hover-only) |
| Actions | `.item.remove` × (queued/rejected only; 5 s Undo toast); click on an executed item scrolls the Timeline View to the element and flashes it |
| Grouping | items executed in the same version collapse under "Applied in v5 (3)" / "Diterapkan di v5 (3)" after 30 s; expandable |
| Hover | tooltip with full `propertyKey`, time, and (for compile) "No AI model was used" / "Tidak memakai model AI" |
| Data attributes | `data-el="agent.editor.intentqueue.item" data-intent-id` |

## 12. Copy deck (strings not already listed above)

| Key (ACCESSIBILITY_AND_I18N.md scheme) | EN | ID |
|---|---|---|
| `ui.sys.offline.title` | Expertmotion's local service is not responding | Layanan lokal Expertmotion tidak merespons |
| `ui.sys.offline.body` | Reconnecting… {n}/3. Your work is checkpointed. | Menyambung ulang… {n}/3. Pekerjaan Anda sudah di-checkpoint. |
| `ui.sys.privatemode.banner` | Private Mode is on. Agents, model downloads and update checks are paused; everything else works. | Mode Privat aktif. Agen, unduhan model, dan pemeriksaan pembaruan dijeda; fitur lain tetap berjalan. |
| `ui.sys.update.available` | Update {version} available | Pembaruan {version} tersedia |
| `ui.sys.update.restart` | Restart to update | Mulai ulang untuk memperbarui |
| `ui.sys.toast.applied` | Applied: {count, plural, one {# change} other {# changes}} · v{version} | Diterapkan: {count} perubahan · v{version} |
| `ui.sys.toast.undo` | Undo | Batalkan |
| `ui.sys.toast.details` | Details | Rincian |
| `ui.sys.toast.tryagain` | Try again | Coba lagi |
| `ui.agent.common.asking` | Asking {model}… | Bertanya ke {model}… |
| `ui.agent.common.switchmodel` | Switch model | Ganti model |
| `ui.agent.common.cost.approx` | Approximate: computed from the model's listed price, not reported by the provider | Perkiraan: dihitung dari harga model yang tercantum, bukan dari penyedia |
| `ui.agent.common.cost.na` | n/a — this provider does not report cost | n/a — penyedia ini tidak melaporkan biaya |
| `ui.stage.player.previewing` | Previewing {preset} | Mencoba {preset} |
| `ui.stage.player.sample` | Sample · insert a clip to preview on your video | Contoh · sisipkan klip untuk melihat di video Anda |
| `ui.stage.player.version.ok` | Preview up to date · v{version} | Pratinjau sudah terbaru · v{version} |
| `ui.lib.assets.intimeline` | In timeline | Di lini masa |
| `ui.lib.text.appliesnew` | applies to new text | berlaku untuk teks baru |
| `ui.lib.text.applythis` | Apply to this text | Terapkan ke teks ini |
| `ui.hdr.export.disabled` | Insert at least one clip first | Sisipkan minimal satu klip dulu |
| `ui.scr.export.trial` | Trial: watermark and 720p. Purchase to remove. | Uji coba: watermark dan 720p. Beli lisensi untuk menghapusnya. |
| `ui.scr.export.keepediting` | You can close this and keep editing | Anda bisa menutup ini dan terus menyunting |
| `ui.scr.export.cancelled` | Export cancelled. No file was saved. | Ekspor dibatalkan. Tidak ada berkas tersimpan. |
| `ui.scr.export.quit.title` | An export is running | Ekspor sedang berjalan |
| `ui.scr.export.quit.body` | Cancel it and quit? | Batalkan dan keluar? |
| `ui.modal.unsaved.title` | Save changes to "{project}"? | Simpan perubahan ke "{project}"? |
| `ui.modal.unsaved.save` / `.discard` / `.cancel` | Save / Don't save / Cancel | Simpan / Jangan simpan / Batal |
| `ui.modal.remove.clip` | Remove clip {n} ({asset}) and its transition? | Hapus klip {n} ({asset}) beserta transisinya? |
| `ui.modal.reset.output` | Reset to {ratio} · {resolution} · {profile} · Auto off? Private Mode is unchanged. | Kembalikan ke {ratio} · {resolution} · {profile} · Auto nonaktif? Mode Privat tidak berubah. |
| `ui.modal.clear.intents` | Clear {count} queued picks? Applied changes stay. | Hapus {count} pilihan antre? Perubahan yang sudah diterapkan tetap ada. |
| `ui.window.small` | Expertmotion works best at 1280×720 or wider | Expertmotion bekerja paling baik pada 1280×720 atau lebih lebar |

Strings for onboarding and the tour live in ONBOARDING_TOUR.md; error strings live in ERROR_CATALOGUE.md under `err.<code>`.

## 13. Traceability (region → PRD)

| Region / screen | PRD | FR (FRD.md, planned) |
|---|---|---|
| Header | PRD-002, 003, 014, 017, 019 | FR-hdr-* |
| Library Panel Design/Home/Tools | PRD-013, 005, 006, 031, 033 | FR-lib-* |
| Asset Panel | PRD-005, 006 | FR-lib-assets-* |
| Stage | PRD-007, 009 | FR-stage-* |
| Agent Panel chats | PRD-010, 011, 012 | FR-agent-* |
| Output Settings | PRD-008, 019, 020 | FR-output-* |
| Export | PRD-014, 015, 017 | FR-export-* |
| Onboarding / tour | PRD-018 | FR-onb-* |
| Providers / Models / Hardware | PRD-010, 019; ADR-008 | FR-scr-* |

## Notes (observed, not fixed here)

1. The mockup shows ⓘ icons on "Video Dimensions" and "Private Mode"; ELEMENT_IDS.md has only `agent.output.profile.help`. This document proposes `agent.output.ratio.help` and `agent.output.private.help`.
2. PERFORMANCE.md §3: 4:5 at 720p is 864×1080 and 5:4 is 1080×864, which keeps the long side at 1080 while 9:16 at 720p (720×1280) keeps the short side at 720; the pixel sublabels will show whatever the table says, but the convention sentence ("the preset name refers to the long side so that 9:16 1080p = 1080×1920") reads as the short side. Worth a check by the Engine lead.
