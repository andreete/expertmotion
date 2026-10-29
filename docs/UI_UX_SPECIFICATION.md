# UI/UX Specification

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-26 |
| Depends on | MASTER_PROJECT_PROMPT.md §7, §13, §16, GLOSSARY.md, ELEMENT_IDS.md, UXRD.md, USER_FLOWS.md, EDITOR_INTERACTION_MODEL.md, DESIGN_CATALOGUE.md (palettes, labels), PERFORMANCE.md (profiles tooltip, pixel table), AI_WORKFLOW.md (Plan Card, Intent Queue), DECISIONS.md (ADR-010, 011, 012), docs/assets/expertmotion-editor-mockup.png |
| Used by | FRD.md, TEST_PLAN.md, ACCESSIBILITY_AND_I18N.md, ONBOARDING_TOUR.md, ERROR_CATALOGUE.md, BLUEPRINT.md (apps/ui) |
| Owner of | design tokens, layout grid, component library, screen specifications, copy deck (UI strings), notification rules, Catalogue Card / Plan Card / Intent Queue item anatomy |
| ID range | CMP-01 … CMP-20 (components), SCR- sections keyed by element id |

The mockup (`docs/assets/expertmotion-editor-mockup.png`) carries a "Remason" label that is not the product name (GLOSSARY.md), a purple accent and placeholder values (an export button below the 720p minimum, read as the Draft preview quality per ELEMENT_IDS.md assumption 4, and a square size that is not in the pixel table); this specification translates its structure into Expertmotion and replaces every placeholder with values owned by PERFORMANCE.md and DESIGN_CATALOGUE.md. Element ids are from ELEMENT_IDS.md and are never redefined here. Each string is EN / ID; the MVP UI renders EN (ADR-012). i18n keys follow ACCESSIBILITY_AND_I18N.md (`ui.<region>.<element>.<state>`).

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
| Licence (licensed; the Editor is not reachable otherwise) | `badge-check` | Export | `download` |
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
├ Library 300 ─┬ Stage flex (min 640) ───────────────────┬ Agent 420 ────────┤
│ search 36    │ Player frame (aspect-fit, padding 16)   │ Chat header 44    │
│ mode hdr 32  │                                          │ (Model ▾, usage)  │
│ catalogue /  │                                          │ one thread        │
│              │                                          │ (💡 / ✂️ tags,     │
│ text / tools │                                          │  Plan Cards)      │
│ (scroll)     ├ Timeline View 220 min (resizable) ───────┤ picks · composer  │
│ Assets (≥160)│ ruler 24 · 5 tracks × 36 · inspector     │ ▸ Output (header) │
└──────────────┴──────────────────────────────────────────┴───────────────────┘
 toasts bottom-right · banners under Header · render chip in Header
```

| Rule | Value |
|---|---|
| Header | 48 px, `--em-panel`, bottom border `--em-line`; left: logo + menu tabs; centre: title; right: actions (no window controls: the native Windows frame draws them, 2026-10-26) |
| Columns | 300 / flex / 420 px at 1280–1599 (Agent 360 below 1280, 480 from 1600; resizable 320–900 px, Stage ≥ 640 px); ranges and collapse in EDITOR_INTERACTION_MODEL.md §9–10 |
| Agent Panel inside | Since 2026-10-26 one assistant chat (FR-181): header 44 px (status, "Model: <label> ▾", compact usage, help, `agent.chat.maximize`), the thread (scrolls internally), the "Your picks" strip in Edit mode, the composer (always visible, with the Diskusi / Edit switch); then Output Settings collapsed to its header by default; maximized, the chat fills the panel and Output Settings is hidden. The split layout with `agent.chat.divider` is retired. |
| Gutters | 16 px panel padding; 8 px between cards; 12 px between sections |
| Timeline View | 220 px minimum: ruler 24 + lanes 36 each (at least captions, one layer lane, video, one audio lane; more lanes scroll vertically, ADR-027) + 16 padding; inspector docks to the right of the lanes (260 px) when an element is selected, else hidden |
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
| CMP-13 | **Chat bubble** | user (right, accent-ink on `--em-panel-2` with accent left border), assistant (left, panel-2), system (centred, muted, 12 px); markdown subset (bold, lists, code spans); attachments thumb. Assistant text (QA 2026-10-25): the reply is first unwrapped from any JSON wrapper (`extractReplyText`: fenced, with prose around it, truncated, double-encoded, literal `\n`) so `{"reply": …}` is never shown, then rendered by `ModelText` as React nodes: **bold** / __bold__, *italic* / _italic_ (underscores only at word boundaries), `code`, line breaks, paragraphs, `-` / `*` / `•` bullets, `1.` / `1)` numbered lists, `#` headings as bold lines; no links, no raw HTML (never `dangerouslySetInnerHTML`). User text stays verbatim. Plan Card goal, step and risk lines use the inline subset | streaming (caret), error (danger border + actions), cancelled (muted) |
| CMP-14 | **PlanCard** | see §11.2 | draft/valid (Proposed), executing, executed, failed, stale, invalid, cancelled |
| CMP-15 | **IntentItem** | see §11.3 | queued (incl. restored, marked via `restoredAt`), compiled/applied, planned, executed, superseded, rejected; `removed` items leave the list |
| CMP-16 | **TrackLane** | header 96 px (icon + name + mute/visibility toggles P1) + lane | default, focused, drop-target |
| CMP-17 | **ElementBar** | per element kind colour stripe: clip accent, overlay accent-2, text `#F4F5F7`, caption info, audio `#8FB3FF`, transition diamond on the Cut, effect/motion as small glyphs stacked above the bar, background full-width faint band, generated with `sparkles` glyph | default, hover (tooltip with name + times), selected (2 px accent), pulse-added/-modified/-removed, dimmed (outside playhead's Clip when "focus mode" on, P1) |
| CMP-18 | **Inspector** | property sheet: key/value rows in `t-body-s`, section headers, "Ask Editor Agent to change" button | default, multi-select summary, empty |
| CMP-19 | **Banner** | full-width under Header; private (private colour), offline (warn), update (info) | — |
| CMP-20 | **Field** | text, number with unit, select, colour swatch row, key (masked with reveal) | default, focus, error (danger line + message below), disabled, read-only |

## 4. Header (`hdr.*`)

Implements PRD-002, PRD-003, PRD-014, PRD-017, PRD-019.

| Element | Component | Content EN / ID | States | Notes |
|---|---|---|---|---|
| `hdr.logo` | app mark (22 px SVG `AppMark`: rounded square, gradient #F09C48 → #B05218 around the accent #E8913A, white play triangle with a faint motion echo) + wordmark "Expertmotion". The same mark is the favicon, tray icon, app / installer icon and the License Admin header; geometry source `apps/desktop/scripts/make-tray-icon.mjs` → `apps/desktop/build/expertmotion-mark.svg` (Operator 2026-10-26) | — | hover background; click → `scr.about` | The mockup's "Remason" label is not the product name |
| `hdr.menu.file` … `.help` | tab buttons, 13 px 500 | File / Berkas · Home / Beranda · Design / Desain · Tools / Alat · Help / Bantuan | Home/Design/Tools: active tab has 2 px accent underline; File/Help open menus | Shortcuts 1/2/3 |
| `hdr.menu.file.*` | menu | New Project / Proyek Baru (Ctrl+N; creates a Project with the default settings at once and opens it, unsaved prompt first) · New Project with Settings… / Proyek Baru dengan Pengaturan… (`hdr.menu.file.newcustom`, the `scr.project.new` dialog) · Open… / Buka… (Ctrl+O) · Recent / Terbaru ▸ · Save / Simpan (Ctrl+S) · Save As… / Simpan Sebagai… · Import… / Impor… (Ctrl+I) · Export… / Ekspor… (Ctrl+E) · Project Settings… / Pengaturan Proyek… · Recover… / Pulihkan… | Export disabled with reason until a Clip exists; Recover carries a badge when a checkpoint newer than the saved state exists | Divider before Recover |
| `hdr.menu.help.*` | menu | Tour / Tur · Shortcuts / Pintasan (Shift+?) · Diagnostics / Diagnostik · Licence / Lisensi · Documentation / Dokumentasi · About / Tentang | — | Documentation opens local HTML in system browser |
| `hdr.title` | inline-edit text, `t-body` 500 | "Untitled" / "Tanpa Judul" default | edit (input), error "Name cannot be empty" / "Nama tidak boleh kosong" | ≤ 80 chars |
| `hdr.title.dirty` | 6 px accent dot after title | tooltip "Unsaved changes" / "Perubahan belum disimpan" | shown/hidden | |
| `hdr.action.hardware` | IconButton `activity` | tooltip "Hardware Monitor" / "Monitor Perangkat Keras" | warn dot when free RAM < 2 GB or disk < 1 GB | opens `scr.hardware` popover |
| `hdr.action.save` | IconButton `save` | "Save (Ctrl+S)" / "Simpan (Ctrl+S)" | disabled when clean | |
| `hdr.action.undo` / `.redo` | IconButton `undo-2` / `redo-2` | "Undo (Ctrl+Z)" / "Batalkan (Ctrl+Z)" · "Redo (Ctrl+Shift+Z)" / "Ulangi (Ctrl+Shift+Z)" (Ctrl+Y also works; FR-153) | disabled when `canUndo` / `canRedo` is false (`composition.updated`) | |
| `hdr.action.backup` / `.restore` | IconButton `archive` / `archive-restore` | "Back up project to zip" / "Cadangkan proyek ke zip" · "Restore project from zip" / "Pulihkan proyek dari zip" | no badge (the newer-checkpoint badge sits on `hdr.menu.file.recover`); both open `scr.backup` | |
| `hdr.action.models` | IconButton `boxes` | "Model Manager" / "Pengelola Model" | progress ring while downloading | |
| `hdr.action.license` | IconButton `badge-check` | popover: "Licensed · <tier> · updates until <date> · MC1-7Q4K…8PZD" / "Berlisensi · <tier> · pembaruan sampai <date> · MC1-7Q4K…8PZD" (short Machine Code; the licensee's name is never shown anywhere in the Editor, Operator 2026-10-26) with "Manage licence" / "Kelola lisensi" → `scr.license` | licensed (success); EM-5007 badge | |
| `hdr.action.export` | Button primary 32 `download` | "Export" / "Ekspor" | `.disabled` tooltip "Insert at least one clip first" / "Sisipkan minimal satu klip dulu"; while rendering shows `sys.render.progress` ring + "42 %" | |
| `sys.render.progress` | chip in Header | "Exporting 42 % · ≈ 1 min" / "Mengekspor 42 % · ≈ 1 mnt" | click reopens `scr.export` | |
| (window controls) | native Windows frame | — | The header has no minimize / maximize / close buttons (removed 2026-10-26: they duplicated the native frame and the first two did nothing); closing through the frame runs the unsaved / render prompts (FR-002, FR-174). The Desktop Shell shows no native menu bar inside the window on Windows / Linux (QA 2026-10-25: Electron's default "File Edit View Window" bar doubled the header); a hidden Edit-roles menu keeps Ctrl+Z / Y / X / C / V / A working in text fields (`apps/desktop/src/lib/window-chrome.ts`) | |

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
| `lib.catalogue.empty` (search) | empty pattern | as above | — |

### 5.3 Home mode (`lib.text.*`)

Order top to bottom; every control is a deterministic pick (IX-03/IX-04).

| Element | Component | Content EN / ID | Notes |
|---|---|---|---|
| Add Text block | `lib.text.add` Button primary opens `lib.text.add.input` (text + variant) with `lib.text.add.confirm` | placeholder "Type your text…" / "Ketik teks kamu…"; button "Add Text" / "Tambah Teks"; confirm "Add" / "Tambah" | Enter adds; empty → "or let the Editor Agent suggest one" link |
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
| `.captions` | Generate Captions / Buat Caption | "From your video's audio, offline" / "Dari audio video kamu, offline" | P1; model badge |
| `.music` | Generate Music / Buat Musik | "Needs a GPU with 4 GB" / "Perlu GPU 4 GB" on T0 | P2 "Coming later" |
| `.thumbnail` | Generate Thumbnail / Buat Thumbnail | "Cover image from a frame and your title" / "Gambar sampul dari frame dan judul kamu" | P2 |
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
| `lib.assets.card.action.usecaptions` / `.action.remove` | card menu (⋯) | "Use as captions" / "Pakai sebagai caption" (SRT/VTT assets only; `op:caption.importSrt`) · "Remove" / "Hapus" | Remove asks for confirmation when a Clip uses the asset (`EM-1101`) |
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
| `stage.player.canvas.layer`, `.box`, `.handle`, `.guide` | ADR-028 canvas handles over the surface for the selected clip, image or shape while it plays: 2 px accent box (rotated with the picture) with a 1 px dark halo, four 12 px white corner squares (resize cursors) and a 14 px round rotation handle on a 16 px stem above the top edge; snap guides 1 px warn colour across the frame; tooltip "Drag to move · corners zoom (Shift keeps the centre) · top handle rotates (Shift snaps to 90°) · double-click resets · Alt turns snapping off · Esc cancels" / "Seret untuk memindah · sudut untuk zoom (Shift menjaga titik tengah) · pegangan atas untuk memutar (Shift ke kelipatan 90°) · klik dua kali untuk atur ulang · Alt mematikan snap · Esc membatalkan" | idle, dragging (`data-gesture` move / scale / rotate; the picture follows live), hidden when nothing transformable is selected or it does not play at the playhead |
| `stage.player.controls` | 40 px bar under canvas | `.play`/`.pause` (Space) · `.scrubber` (full width, accent fill, hover shows time) · `.time` "00:12.08" / `.duration` "00:42.00" `t-mono` · `.fullscreen` | hover thumb enlarges; keyboard ←/→ |
| `stage.player.menu` | popover menu | Safe area overlay / Garis aman · Draft quality / Kualitas Draft (toggle; disabled "Turbo uses full quality" on Turbo) · Loop / Ulang · Mute / Bisu · Seek on select / Lompat saat memilih | checkmarks |
| `stage.player.state.loading` | skeleton canvas + spinner + label | "Loading preview…" / "Memuat pratinjau…"; after 8 s "This is taking longer than usual" / "Ini lebih lama dari biasanya" and `stage.player.state.loading.retry` "Try again" / "Coba lagi" (refetches the head version and the media grant; the wait cause is logged as an `[em]` console warning, kept in the Shell log) | |
| `stage.player.state.empty` | centred text + button inside the canvas (no Player mounted) | "Nothing to preview yet" / "Belum ada yang bisa dipratinjau" · "Import video, images or audio, or add a text, and the preview appears here." / "Impor video, gambar atau audio, atau tambahkan teks, lalu pratinjau muncul di sini." · `stage.player.state.empty.import` Import… / Impor… | shown for a Composition Version with no clips, texts, overlays, captions, audio or background; a preset hover preview still plays (QA 2026-10-25) |
| `stage.player.state.noproject` | centred text + two buttons | "No project open" / "Belum ada proyek yang terbuka" · "Start a new project or open one you made earlier." / "Mulai proyek baru atau buka proyek yang pernah kamu buat." · `.new` New Project / Proyek Baru · `.open` Open… / Buka… | no Project open |
| `stage.player.state.error` | error card inside canvas | "Preview could not load clip 2 · EM-1xxx" / "Pratinjau tidak dapat memuat klip 2 · EM-1xxx" · Rebuild preview / Bangun ulang pratinjau · Details / Rincian | |
| `stage.timeline` | panel under Player | header row: `t-label` "TIMELINE" / "LINI MASA", `stage.timeline.split` scissors icon button 28 px "Split at the playhead (S)" / "Potong di playhead (S)" (ADR-028), zoom −/+ (fit, 1 s/100 px … 10 s/100 px), total duration | scissors disabled on an empty project |
| `stage.timeline.ruler` / `.head` | 24 px ruler `t-mono` ticks; playhead 2 px accent line with triangle head | click/drag seeks | |
| `stage.timeline.track.caption`, `stage.timeline.lane.new`, `stage.timeline.lane.layer` (× layers, front-most on top), `stage.timeline.track.video`, `stage.timeline.lane.audio` (× lanes), `stage.timeline.lane.new` | CMP-16 lanes, top to bottom (CapCut order, ADR-027); names Captions / Caption · New layer / Lapisan baru · Layer n / Lapisan n · Video / Video · Audio n / Audio n · New audio lane / Jalur audio baru; new lanes have a dashed bottom border and, while dragging, the hint "Drop here for a new layer in front" / "Lepas di sini untuk lapisan baru paling depan" | project-wide items (caption style, background) show as a chip in the lane header: "Karaoke" / "Spotlight" | drop-target (2 px accent inset while a drag targets it) |
| `stage.timeline.element.*` | CMP-17 | label = asset name / text content / preset label; times on hover, plus for editable bars "drag to move, edges to trim · ←/→ one frame, Shift one second · Alt+↑/↓ layer" / "seret untuk memindah, tepi untuk memangkas · ←/→ satu frame, Shift satu detik · Alt+↑/↓ lapisan"; 6 px `stage.timeline.element.handle` at both edges (ew-resize cursor) | selected, pulses, dragging (40 % opacity; `stage.timeline.ghost` dashed accent box on the target lane with start time; `stage.timeline.snap` 1 px warn-colour guide at the snapped ms) |
| `stage.timeline.inspector` | CMP-18 docked right 260 px | header "Clip 2 · beach.mp4" / "Klip 2 · beach.mp4"; rows: Start, Duration, Layer / Lapisan (texts, images, shapes) or Audio lane / Jalur audio, Trim, Playback rate, Volume, Fit, Motion, Effects (chips), Transition in/out; button "Ask Editor Agent to change" / "Minta Editor Agent mengubah" (A); P1 adds editable trim | empty "Select an element to inspect it" / "Pilih elemen untuk melihat rinciannya" |
| `stage.timeline.inspector.transform` | section inside the inspector for one selected clip, image or shape (ADR-028): title "Position & zoom" / "Posisi & zoom"; 2 × 2 grid of 64 px right-aligned text fields X % · Y % · Scale / Skala % · Rotation / Rotasi °; buttons Fit / Pas · Fill / Penuhi · Reset / Atur ulang (ghost; disabled "Already at the original position" / "Sudah di posisi awal" at the identity); five 28 px align icon buttons centre / top / bottom / left / right ("Centre in the frame" / "Tengahkan di frame", "Align to the top" / "Ratakan ke atas", …) | Enter or blur applies, Esc reverts the field |
| `stage.timeline.inspector.delete` | 28 px danger-ghost button with trash icon next to "Ask assistant" / "Tanya asisten" (ADR-031) | "Delete" / "Hapus"; tooltip "Delete the selected items (Del). Ctrl+Z brings them back." / "Hapus item yang dipilih (Del). Ctrl+Z mengembalikannya."; same pick as the Delete key, no dialog | |
| `stage.itemmenu` | context menu, min 200 px, 8 px radius, `bg-em-panel`, strong border, shadow; 12 px rows with a 14 px icon and the shortcut hint right-aligned `t-mono` (ADR-031, IX-30) | "Delete" / "Hapus" (danger tone, Del) · "Split at playhead" / "Belah di playhead" (S) · "Duplicate" / "Duplikat" · "Ask Editor Agent" / "Tanya Editor Agent"; disabled rows muted with the reason as tooltip ("Move the playhead onto the item first." / "Geser playhead ke item ini dulu."; "Audio, captions, transitions and effects can't be duplicated." / "Audio, caption, transisi, dan efek tidak bisa diduplikat."); opens at the pointer (keyboard: under the bar), kept inside the window | toasts "Deleted 2 items" / "2 item dihapus", "Duplicated 1 item" / "1 item diduplikat" with Undo; a stale plan's Execute: "Timeline changed — re-planning" / "Timeline berubah — rencana disusun ulang" |
| `stage.timeline.empty` | empty pattern over lanes | "Insert assets, then your picks and the Editor Agent fill this timeline." / "Sisipkan aset, lalu pilihan kamu dan Editor Agent mengisi lini masa ini." | hidden once a Clip exists |

## 7. Agent Panel (`agent.*`)

Implements PRD-010, PRD-011, PRD-012, PRD-008, PRD-020.

### 7.1 Assistant chat (`agent.chat.*`; Operator decision 2026-10-26)

One thread per Project, two modes, like common AI tools (FR-181 … FR-183). Copy stays short: labels, not sentences; hints in tooltips.

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.chat.header` | 44 px row | left: `agent.chat.status` (8 px dot; Private Mode `shield-check`), `agent.chat.model` "Model: Claude Sonnet 4.5 ▾" / "Model: …" (the current mode's model label; id and agent name in the tooltip; ⚠ when warned); right: `agent.chat.usage` `t-mono` "1,2K / 200K" (tooltip: tokens, last cost, summarisation note; amber ≥ 60 %, red ≥ 80 %), "JSON" chip for an Editor model without tool calling, help ⓘ (the mode's agent help), `agent.chat.maximize` | no provider: "Connect an AI provider" / "Hubungkan penyedia AI" (accent, opens `scr.providers`) |
| `agent.chat.model.popover` | Popover 340 px, list | search "Search models" / "Cari model" (focused; ↑/↓ + Enter), refresh icon, connection select (only with several validated connections); sections "Recommended" / "Disarankan", "Free" / "Gratis", "Paid" / "Berbayar" with counts; row = name · provider (short, muted) · price chip "$0.30/1M" or "Free" / "Gratis" · ⚠ (tooltip "May give weak results (small model or no JSON)" / "Mungkin kurang bagus (model kecil atau tanpa JSON)"); "N more" / "N lagi" per section; "Manage providers…" link | selected row accent; a warned pick keeps it open with "{model} may give weak results" + "Use recommended instead" |
| `agent.chat.thread` | scroll area; CMP-13 bubbles | both agents in time order; every bubble starts with its tag `agent.chat.message.agent`: 💡 "Discuss" / "Diskusi" (warn tone) or ✂️ "Edit" (accent tone), also on the Creator's own bubbles (mode it was sent in); first-run hint per mode: "Tell me what the video is for and who will watch it." / "Ceritakan video ini untuk apa dan siapa penontonnya." · "Say what to change in the video." / "Bilang apa yang mau diubah di video." | streaming (`agent.chat.streaming`, "Asking <model>…" + Cancel), error bubble with Try again / Switch model (opens the popover for that agent) or Change budget |
| Diskusi answer | bubble + footer | time, copy, `agent.chat.apply` "Apply to video" / "Kerjakan di video" (tooltip "Send to Edit mode" / "Kirim ke mode Edit") | hidden while the answer still has a pending proposals card (the card carries the same action) |
| `agent.brainstorm.handoff` | Card accent-dashed border inside the answer | title "Proposed changes" / "Usulan perubahan"; rows with checkbox + category icon + "Caption style · Editorial → project"; buttons `agent.chat.apply` "Apply to video" / "Kerjakan di video" (primary; switches to Edit) · "Dismiss" / "Abaikan" (ghost) | collapsed receipt after action |
| Edit reply | tag + Plan Card | the plan goal is the reply sentence (CMP-14, §11.2); a question from the Editor (only `needs-input` risks) is a normal bubble; after Execute a one-line summary "✓ goal · Executed · v1a2b3c · 1 added · Undo · Details" | older plans collapsed (`PlanSummary`), Undo while their version is the head |
| `agent.editor.picks` | strip above the composer, Edit mode only | `agent.editor.intentqueue.toggle` "Your picks" / "Pilihanmu" + count badge `agent.editor.intentqueue.count` (accent while picks wait) + chevron; expanded: Plan / Clear / Cancel and the CMP-15 list (max 40 % of the chat) | collapsed by default (prefs) |
| `agent.chat.composer` | textarea auto-grow 1–6 lines; toolbar below: `agent.chat.mode` segmented 💡 "Discuss" / "Diskusi" · ✂️ "Edit" (tooltips "Ideas, scripts, hooks, captions · Ctrl+1" / "Ide, naskah, hook, caption · Ctrl+1", "Change the video · Ctrl+2" / "Ubah video · Ctrl+2"), `agent.chat.attach` `paperclip`, `agent.chat.send` `send-horizontal` | placeholder per mode: "Describe your idea…" / "Jelaskan ide kamu…" · "Tell the Editor Agent what to change…"; target chip "clip 2" (Edit, from the inspector); Tab in an empty composer switches the mode | disabled note in Private Mode (UX-024) or when not configured "Connect a provider to chat" / "Hubungkan penyedia untuk mengobrol" |
| `agent.editor.execute` | Button primary 36 inside the Plan Card footer | "Execute" / "Jalankan" (tooltip "Apply this plan (Ctrl+Enter outside the chat box)" / "Terapkan rencana ini (Ctrl+Enter di luar kotak chat)"; inside the composer Ctrl+Enter sends (FR-153)) | disabled reasons: "No plan yet" / "Belum ada rencana" · "Composition changed; re-plan" / "Komposisi berubah; susun ulang" (shown next to Re-plan) · "Plan has a blocking issue" / "Rencana punya masalah pemblokir" |
| `agent.editor.cancel` | Button ghost in the picks strip | "Cancel" / "Batal" | enabled while running |

### 7.4 Output Settings (`agent.output.*`)

| Element | Component | Content EN / ID | States |
|---|---|---|---|
| `agent.output` | header button `agent.output.toggle` (`aria-expanded`): `t-label` "OUTPUT" / "KELUARAN" + `agent.output.summary` when collapsed "9:16 · 1080p · 30 fps · Standard" | — | collapsible; collapsed by default (FR-099), state persisted |
| Performance Profile row | label "Performance profile" / "Profil performa" + `agent.output.profile.help` ⓘ (PERFORMANCE.md §2 tooltip verbatim) | `agent.output.profile.standard/.accelerated/.turbo` Segmented 3: Standard / Standard · Accelerated / Accelerated · Turbo / Turbo; sublabels "1 frame at a time · Draft preview" / "Accelerated: 2 in parallel" / "Turbo: up to 4 · Full preview" (short EN: "1× · Draft", "2× parallel", "4× · Full") | disabled with reason "Needs a GPU with 4 GB" / "Perlu GPU 4 GB"; Turbo on T1 warn dot "May use a lot of memory" / "Bisa memakai banyak memori" |
| Aspect Ratio row | label "Aspect ratio (width:height)" / "Rasio aspek (lebar:tinggi)" + ⓘ (`agent.output.ratio.help`: "Width first, then height. The preview frame changes shape; your clips are fitted inside." / "Lebar dulu, lalu tinggi. Bingkai pratinjau berubah bentuk; klip kamu disesuaikan di dalamnya.") + `agent.output.ratio.auto` sticky Toggle "Auto" / "Otomatis" (tooltip "Use the first clip's shape" / "Pakai bentuk klip pertama"; a manual ratio pick turns it off) | `agent.output.ratio.16x9/.9x16/.1x1/.4x5/.5x4/.4x3/.3x4/.custom` Segmented 4×2, each with orientation glyph (rectangle outline in true proportion) + label + `t-mono` pixel sublabel from PERFORMANCE.md §3 for the current Resolution, e.g. "9:16 · 1080×1920" | active; Custom opens `scr.ratio.custom` (`.width`, `.height`, `.preview`, `.apply`; clamped 1:3…3:1, ≥ 240 px) |
| Resolution row | label "Resolution" / "Resolusi" | `agent.output.resolution.720p/.1080p/.2k/.2160p` Segmented 4: "720p" · "1080p" · "2K" · "2160p (4K)" with pixel sublabels for the current ratio | `.disabled` sublabel "Needs a GPU tier" / "Perlu GPU"; 2160p on T1 warn dot (no licence-based lock: single edition) |
| `agent.output.private` | Toggle private colour + label "Private Mode" / "Mode Privat" + ⓘ (`agent.output.private.help`: "Blocks all internet use: AI agents, model downloads, update checks. Editing and export keep working." / "Memblokir semua penggunaan internet: agen AI, unduhan model, pemeriksaan pembaruan. Penyuntingan dan ekspor tetap berjalan.") | — | on/off |
| `agent.output.reset` | Button ghost `rotate-ccw` | "Reset to Defaults" / "Kembalikan ke Bawaan" | confirmation (IX-19) |

Frame rate and duration are **not** here (ADR-010); a link row "Frame rate 30 fps · Project Settings →" / "Laju bingkai 30 fps · Pengaturan Proyek →" sits under Resolution.

## 8. Screens and dialogs (`scr.*`)

| Screen | Layout | Content EN / ID (key items) | States | Implements |
|---|---|---|---|---|
| `scr.onboarding` | full-window, 720 px centred column, step indicator 1–6, "Skip setup" ghost top-right | copy in ONBOARDING_TOUR.md §2 | per step | PRD-018 |
| `scr.license` | Not licensed: full window, 640 px centred column (`data-gate`), the only screen of the product; licensed: Modal 560 "Manage licence" | gate header "Activate Expertmotion" / "Aktifkan Expertmotion" with `.lang` switch and `.steps` (copy code · send · paste and activate); `.status` card (hidden on a fresh install); `.machinecode` "Machine code" / "Kode mesin" (`MC1-…`) with `.machinecode.copy`; `.input` masked key field with paste button and `.emlicense` drop; `.activate` primary "Activate" / "Aktifkan" (Enter submits); `.buy` link "Get a licence key (opens browser)" / "Dapatkan kunci lisensi (membuka browser)" (not licensed only); `.help` link "Activation help" / "Bantuan aktivasi" (opens the browser); `.remove` "Deactivate on this computer" / "Nonaktifkan di komputer ini" (modal only, confirmation; the install locks again); `.rebind` steps on EM-5003; `.error` inline with the catalogue copy (EM-5002…5006, EM-5009, EM-5011 with the wait). Formal "Anda" register is allowed on this screen (licence text) | idle, validating, success → onboarding/Editor without restart, error, rebind, rate-limited | PRD-017, F13, LICENSE_OPERATIONS §7 |
| `scr.providers` | Sheet 560 from right; `.list` of Provider Connections; `.add` | `.provider.select` (OpenRouter default; OpenAI, Anthropic, Google Gemini P1) · `.key.input` masked · `.validate` "Validate" / "Validasi" · ModelPicker `.models` right below the key once Validate succeeds (and on the stored connection): two-option toggle `.assign.agent` "Brainstorming Agent \| Editor Agent" (same in id) (each option shows the chosen model label; "No model" / "Tanpa model"), search `.models.search` "Search models by name or id" / "Cari model (nama atau id)", category `.models.category` segmented "All · Free · Paid" / "Semua · Gratis · Berbayar" (default All; Paid includes models without a reported price), chips `.models.filter.json/.images` "JSON · Images" / "JSON · Gambar" (both off by default for both agents), count "{shown} of {total}" / "{shown} dari {total}", sortable headers Model · Context · "$ / 1M in · out" ("$ / 1 jt masuk · keluar"), rows: label + muted id, "128K", "$3.00 · $15.00", "Free" / "Gratis" badge or "price n/a" / "harga n/a", JSON / Tools / Image badges ("?" = not reported), "Recommended" / "Disarankan" on 1–3 rows, selected row highlighted with a check; every row is selectable (Operator decision 2026-10-25): weak models (small name / ≤ 9B / context < 32K / small open family, FR-115) carry `.models.row.warn` "⚠ May be weak" / "⚠ Mungkin lemah" with the tooltip "May give poor results — choose a stronger model for good results" / "Hasil mungkin kurang bagus — pilih model yang lebih kuat untuk hasil bagus", models without JSON output "⚠ No JSON" / "⚠ Tanpa JSON" with "Doesn't confirm JSON output; the {agent} may fail" / "Tidak mendukung JSON; {agent} bisa gagal"; when the selected model carries a warning, `.models.warning` (amber box under the table) repeats it with the reasons and `.models.warning.recommended` "Use recommended instead" / "Pakai yang disarankan"; 100 rows at a time with `.models.more` "Show {count} more ({rest} left)" / "Tampilkan {count} lagi (sisa {rest})"; empty table: "No model list yet." / "Daftar model belum ada." + `.models.fetch` "Fetch models" / "Ambil daftar model"; `.assign.both` "Also use for the Editor Agent" / "Pakai juga untuk Editor Agent"; defaults for both agents preselected (Balanced resolution, never labelled as a tier) · `.budget.project` / `.budget.month` ($, per connection; 0 = unlimited) with "Warn at 80 %" · `.test` "Test both" / "Uji keduanya" · `.save` primary | validating, error `EM-4xxx`, saved | PRD-010, PRD-011, brief §9 |
| `scr.models` | Sheet 640 | `.tier` header "Your PC: T0 · CPU only" / "PC kamu: T0 · hanya CPU"; `.list` grouped by engine; `.row`: product name (`.row.name`, e.g. "Auto Captions — Fast" / "Teks Otomatis — Cepat"; no upstream name, no engine version), size, min tier, state; languages, licence name + link (`.row.licence`) and component licences (licence name only, no engine / tool names, `.row.notice`) in the expanded card; no engine names, folder paths, checksums, developer notes or per-engine "Open folder" buttons anywhere (Operator 2026-10-26); the min-tier badge only when the model needs more than T0; `.row.install` / `.row.remove`; `.row.progress` "312 MB / 1.6 GB · ≈ 10 min" | installed, downloading, paused (Private Mode), failed `EM-7xxx` | ADR-008, F11 |
| `scr.hardware` | Popover 320 anchored to `hdr.action.hardware` | `.cpu` "CPU 23 %" · `.ram` "RAM 9.1 / 16 GB" · `.procmem` "Expertmotion 612 MB" · `.disk` "Disk free 48 GB" · `.gpu` "GPU: present / not detected" (percent only with nvidia-smi) · `.workload` "Rendering 42 % · Ingest idle" / "Merender 42 % · Impor diam"; footer "Tier T0 · readings stay on this PC" / "Tier T0 · data tetap di PC ini" | refreshing every 2 s while open | PRD-019 |
| `scr.project.new` | Modal 420 | `.name`; fps select (default 30); ratio default Auto; resolution default 1080p; "Create" / "Buat" | — | PRD-003 |
| `scr.project.open` | Modal 560 | `.list` (name, last opened, duration, thumbnail, disk usage) + "Browse…" / "Telusuri…"; `.delete` per row (confirmation; typed name when Outputs exist) | empty "No projects yet" / "Belum ada proyek" | PRD-003 |
| `scr.project.settings` | Modal 560 | `.name` · `.fps` 24/25/30/50/60 · `.ratio` · `.resolution` · `.duration.policy` "Fit content" / "Sesuai isi" · "Fixed" / "Tetap" + ms · `.output.folder` path + Browse · language "Indonesian / English" (project language for agents and generators) | fps change note "Timing stays the same; frame counts are recalculated" / "Waktu tetap sama; jumlah frame dihitung ulang" | PRD-008 |
| `scr.project.recover` | Modal 560 | `.list` of checkpoints: time, version, "3 changes after last save"; actions `.restore` "Restore" / "Pulihkan" · Open last saved / Buka simpanan terakhir · Show both / Tampilkan keduanya | auto-opens on relaunch when newer checkpoint exists | PRD-003, F9 |
| `scr.backup` | Modal 480, Backup or Restore mode | **Backup:** `.backup.passphrase` "Passphrase (recommended)" / "Frasa sandi (disarankan)" with confirm field and strength hint; `.backup.plain` checkbox "Save without a passphrase" / "Simpan tanpa frasa sandi" with warning "Anyone with this file can read your clips, text and chats. Provider keys and the licence are never included." / "Siapa pun yang punya berkas ini bisa membaca klip, teks, dan percakapan kamu. Kunci penyedia dan lisensi tidak pernah disertakan."; include Outputs checkbox; `.backup.start` primary "Back up" / "Cadangkan". **Restore:** `.restore.file` picker; `.restore.passphrase` (shown when the manifest says encrypted); preview card (name, versions, assets, size) with note "Restored as a new project. Nothing is overwritten." / "Dipulihkan sebagai proyek baru. Tidak ada yang ditimpa."; `.restore.start` primary "Restore" / "Pulihkan"; `.progress` | idle, running, done, failed (`EM-6301…6305`) | SECURITY.md SEC-052, DATABASE_SCHEMA.md §6, F14 |
| `scr.history` | Sheet 480 | `.list` of Composition Versions (time, origin compile / plan / insert / restore, diff summary); `.item` row, current head highlighted; `.item.restore` "Go to this version" / "Ke versi ini" (creates a new head entry, undoable) | empty, loading | FR-169 (P1 UI) |
| `scr.export` | Modal 560, two phases | **Setup:** `.profile.summary` "9:16 · 1080×1920 · 30 fps · 0:42 · Standard"; `.codec` Segmented "MP4 (H.264)" / "GIF" / "PNG still"; `.quality` select Standard/High (CRF); `.filename`; `.folder` + Browse; `.preflight` checklist rows (Disk, Memory, Dimensions, Duration, Assets, Engine, Licence) each ✓ / ⚠ / ℹ with message; estimate line "≈ 1 min 30 s · ≈ 35 MB" (from `render.estimate`); `.start` primary "Start export" / "Mulai ekspor". **Running:** `.progress` bar + "Frame 412 / 1260 · 33 %"; `.eta` "Estimating…" → "≈ 1 min left" / "≈ 1 mnt lagi"; `.cancel` danger ghost; "You can close this and keep editing" / "Kamu bisa menutup ini dan terus menyunting". **Done:** `.done` thumbnail, name, size, duration; `.open.folder` primary "Open folder" / "Buka folder"; "Export again" / "Ekspor lagi"; share hint none (no cloud) | blocked, running, done, failed (`EM-3xxx` + Try again / Details), cancelled | PRD-014, F8 |
| `scr.generate.*` | Sheet 480 | `.input` (script / prompt / source) · `.language` id/en · `.model` installed models (+ Install link) · `.run` primary "Generate" / "Buat" · `.progress` · `.result` (player / editable pages / image grid / hashtag chips with copy) · `.insert` primary "Insert into video" / "Sisipkan ke video" | model missing, running, done, failed `EM-7xxx` | PRD-031/033 (P1), PRD-051/052 (P2) |
| `scr.diagnostics` | Sheet 640 | tabs Logs / Versions / Hardware; "Copy diagnostics bundle" / "Salin bundel diagnostik" (zip path shown); note "Secrets are redacted" / "Rahasia disamarkan" | — | PRD-015, PRD-021 |
| `scr.about` | Modal 420 | wordmark, version, licence state, "Third-party notices" / "Pemberitahuan pihak ketiga" (incl. GPL source offer for the TTS engine), "Known limitations" / "Keterbatasan yang diketahui", "Update checks paused (Private Mode)" when applicable | — | PRD §7.5 |

## 8a. Automatic-first Editor (Operator 2026-10-29; FR-260 … FR-269)

The product is an AUTOMATIC video maker first; manual tools are second. These rules apply on top of §6 / §7:

- **Launch** (FR-260, ADR-037): the window opens on an empty project ("Tanpa judul"), never on the Start screen or the last project. The empty Player (`stage.player.state.empty`) reads "Mulai dari ide — videonya dibuat otomatis" / "Tulis ide atau tempel prompt lengkap di chat Editor. Punya footage? Impor dulu, lalu minta “buat video dari footage ini”." with **Tulis ide** (primary; focuses the Editor composer) and **Impor footage**, then the small row "Terakhir dibuka: [project] [project] [project] Semua…" (`stage.recent`). File ▸ Tutup proyek closes into an empty project. A crash-loop / abnormal-end notice (`sys.launch.notice`) is a single bar under the header (danger / warn left border) with one action and Tutup — never a modal.
- **Chat starter** (FR-265): an empty thread shows the first-run hint row (accent tint, lightbulb, × to hide for good) and up to four example chips (rounded pills, one line each, truncated with the full text in the tooltip): "Video 30 detik: 3 tips hemat listrik", "Video dari footage saya, dengan teks dan grafik" (only with an imported video), "Video data (isi angkamu)", "Tambahkan musik latar yang tenang". A chip fills the Editor composer and switches to the Editor tab; it never sends.
- **Tooltips** (FR-264): every icon-only button and key control shows a tooltip — `--em-panel-2` background, 1 px line, 12 px text, max 280 px wide, 6 px below the control (above when there is no room), clamped 8 px inside the window, never covering its control; hover after 350 ms, keyboard focus at once, Escape hides it. Copy is a verb phrase in the UI language ("Buka chat Editor: jelaskan videonya, Expertmotion yang menyusun"); disabled controls show their reason instead.
- **Voices** (FR-268 / FR-269): the picker lists the most natural voices that can run now first and marks one "Disarankan" (accent badge), which is preselected; Azure AI Speech and Google Cloud TTS keys sit under ElevenLabs as collapsed rows (key, region for Azure, Save, Remove, a one-line cost note).
- **No clutter**: nothing here adds a panel; at 1280×720 the starter, the empty state and the recent row fit without overlap (the chips wrap; the recent row wraps under the buttons).

## 9. Empty, loading and error patterns

| Pattern | Anatomy | Rules (UXRD §6) |
|---|---|---|
| Empty | icon 32 px muted · `t-title-s` headline · `t-body-s` sentence · one primary button · optional footnote | ≤ 2 sentences; teaches the next step |
| Skeleton | panel-2 blocks with 1.2 s shimmer (disabled under reduced motion) | layout-stable regions: catalogue grid, asset grid, Player canvas |
| Spinner | ring 16/24 + verb label | "Loading preview…", "Asking <model>…", "Preparing proxy…"; after 8 s add "This is taking longer than usual"; cancel when supported |
| Inline error | danger left border 2 px · `EM-` code in `t-mono` · one sentence · 1–2 actions · "Details" disclosure (copies code, time, context) | shown at the origin; no technical words |
| Error card | inside the region (Player, sheet) with same anatomy | for regions that cannot show content |
| Degraded | control visible, disabled, reason adjacent or in tooltip; badge where applicable | never hide |
| Startup splash (`sys.splash`, FR-184) | full window `--em-bg` · app mark 64 px · "Expertmotion" · 3 px determinate bar (accent on panel-2, 280 px) · step line in `--em-text-2` with elapsed seconds in mono after 5 s · "still working" line after 20 s; same geometry as the static `index.html` placeholder so the first paint does not jump | rendered before any await; step text comes from the Shell's `phase`; failure replaces the bar with an inline error (danger left border, EM- code, one sentence, Try again + Open log folder); covers the Editor (z 90) until the first project is open |
| Crash screen (`sys.crash`, FR-185) | full window · app mark 48 px · inline error card: "Something went wrong" / "Ada yang tidak beres", EM-8009, error message in mono (≤ 300 chars, selectable), primary "Reload" / "Muat ulang" | replaces the React tree only; the Local Service keeps running; the error is logged to the Shell log |
| In-place busy line (FR-186) | Spinner 14 px + one short verb line ("Mengimpor 2/5…", "Membuat suara… 45 %", "Membuka proyek…", "Menunggu giliran…"), optional bar under it | shown where the action started; an error is a different state (danger colour + code + retry), never the spinner turning red |

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
| Selected (`.selected`) | 2 px accent inset + `bookmark` glyph top-left; tooltip "In your picks" / "Dalam pilihan kamu" |
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
│ [Discard]                              [Re-plan]        [ Execute  ⌃↵ ]     │  footer: ghost · secondary (agent.editor.plancard.replan) · primary (agent.editor.execute); .cancel replaces Execute while running
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
| Status chip (right) | queued `bookmark` muted "Queued" / "Antre" · compiled `check` accent-2 "applied directly · v3" / "langsung diterapkan · v3" · planned `lightbulb` "in plan" / "dalam rencana" · executed `check-circle-2` success "applied · v5" / "diterapkan · v5" · rejected `octagon-alert` danger reason + code · a queued item with `restoredAt` set adds `history` "restored" / "dipulihkan" beside its Queued chip (status stays `queued`) |
| Superseded (`.item.superseded`) | whole title struck through (`text-decoration: line-through`), 60 % opacity, chip "replaced by <label>" / "diganti oleh <label>", `.item.restore` ghost button "Restore" / "Pulihkan" always visible (not hover-only) |
| Actions | `.item.remove` × (queued/rejected only; 5 s Undo toast); click on an executed item scrolls the Timeline View to the element and flashes it |
| Grouping | items executed in the same version collapse under "Applied in v5 (3)" / "Diterapkan di v5 (3)" after 30 s; expandable |
| Hover | tooltip with full `propertyKey`, time, and (for compile) "No AI model was used" / "Tidak memakai model AI" |
| Data attributes | `data-el="agent.editor.intentqueue.item" data-intent-id` |

## 12. Copy deck (strings not already listed above)

**Copy rules (Operator feedback 2026-10-26, "less wordy")**: labels instead of sentences; at most one short hint under a field; longer explanations go into a tooltip or a (?) popover; passed checks collapse ("7 checks passed"); no internal tags (P1 / P2), engine names or paths in the Editor; no person names anywhere (sample data, placeholders, licence status: "Licensed" / "Berlisensi" + short Machine Code). Legally required notices (third-party notices, GPL source offer, Remotion licence notice, the honest security statement) and error codes stay. en and id change together; the locale files are edited key by key, never rewritten.

| Key (ACCESSIBILITY_AND_I18N.md scheme) | EN | ID |
|---|---|---|
| `ui.sys.offline.title` | Expertmotion's local service is not responding | Layanan lokal Expertmotion tidak merespons |
| `ui.sys.offline.body` | Reconnecting… {n}/3. Your work is checkpointed. | Menyambung ulang… {n}/3. Pekerjaan kamu sudah di-checkpoint. |
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
| `ui.stage.player.sample` | Sample · insert a clip to preview on your video | Contoh · sisipkan klip untuk melihat di video kamu |
| `ui.stage.player.version.ok` | Preview up to date · v{version} | Pratinjau sudah terbaru · v{version} |
| `ui.lib.assets.intimeline` | In timeline | Di lini masa |
| `ui.lib.text.appliesnew` | applies to new text | berlaku untuk teks baru |
| `ui.lib.text.applythis` | Apply to this text | Terapkan ke teks ini |
| `ui.hdr.export.disabled` | Insert at least one clip first | Sisipkan minimal satu klip dulu |
| `ui.scr.export.keepediting` | You can close this and keep editing | Kamu bisa menutup ini dan terus menyunting |
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

## Notes (resolved)

1. The ⓘ icons on "Video Dimensions" and "Private Mode" are `agent.output.ratio.help` and `agent.output.private.help` in ELEMENT_IDS.md (added 2026-10-24).
2. PERFORMANCE.md §3 is short-side based: the preset number is the short side, so 4:5 at 720p is 720×900, 5:4 at 720p is 900×720 and 2K means short side 1440. Pixel sublabels are computed from that table (FR-096); nothing is hard-coded here.
