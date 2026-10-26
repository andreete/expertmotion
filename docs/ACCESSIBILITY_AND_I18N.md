# Accessibility and Internationalisation

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, ELEMENT_IDS.md, DECISIONS.md (ADR-012), UXRD.md (UX-040 … UX-054), UI_UX_SPECIFICATION.md (tokens), EDITOR_INTERACTION_MODEL.md (shortcuts, focus), DESIGN_CATALOGUE.md (labels EN/ID, fonts), PERFORMANCE.md |
| Used by | UI_UX_SPECIFICATION.md, ONBOARDING_TOUR.md, ERROR_CATALOGUE.md, FRD.md, TEST_PLAN.md, BLUEPRINT.md (apps/ui, packages/shared) |
| Owner of | accessibility targets, screen-reader labelling rules, the i18n key scheme, locale file layout, string rules, locale formats, font fallback stack, generated-content language rule, a11y/i18n testing checklist |
| ID range | A11Y-01 … A11Y-30, I18N-01 … I18N-30 |

## 1. Scope and targets

| Target | Value | Verification |
|---|---|---|
| Standard | WCAG 2.1 Level AA for the Editor and all `scr.*` screens; the Player's **content** (the Creator's video) is exempt, the Player's **controls** are not | axe-core in UI tests + manual audit per Roadmap Stage |
| Contrast | text ≥ 4.5:1; large text (≥ 18.66 px bold or ≥ 24 px) and UI component boundaries ≥ 3:1; verified for every token pair in UI_UX_SPECIFICATION.md §1.2 (`--em-muted` on `--em-panel` = 7.1:1; `--em-accent-ink` on `--em-accent` = 9.3:1; `--em-warn` text is used only ≥ 14 px 600) | token contrast test in CI |
| Focus visible | 2 px `--em-focus` ring, 2 px offset, on every focusable element; never `outline: none` without replacement | visual regression |
| Keyboard | every P0 flow (USER_FLOWS.md F1–F10) operable with keyboard alone; shortcuts in EDITOR_INTERACTION_MODEL.md §7; no keyboard traps except intentional modal traps with Esc | UX-051 test |
| Reduced motion | `prefers-reduced-motion: reduce` → UI transitions 0 ms, catalogue loops paused (poster frame) until hover/focus, pulses become static outlines, skeleton shimmer off; progress animation kept | UX-054 test |
| Target size | pointer targets ≥ 24×24 CSS px (AA 2.5.8); primary controls ≥ 32 px | lint on component sizes |
| Zoom | UI usable at Windows 150 % scaling and browser zoom 200 % at 1280 px (panels collapse per EDITOR_INTERACTION_MODEL.md §10) | manual |
| Colour independence | every state uses a word or icon in addition to colour (UXRD §4 badges, Intent Queue chips, preflight ✓/⚠ with text) | review |
| Timing | no auto-dismiss for errors needing action; toast hover pauses timers; no time limits in onboarding | review |
| Flashing | catalogue loops and effects previews ≤ 3 flashes/s; `preset:effect.glitch-blocks` (P2) preview is static | build check on loops |

## 2. Screen-reader labels for custom controls

Rules: every control has an accessible name from visible text, `aria-label`, or `aria-labelledby`; names use GLOSSARY.md terms; element ids are also the stable `data-el`. i18n keys for names: `a11y.<element id>`.

| Element | Role | Accessible name EN / ID | State exposure |
|---|---|---|---|
| `hdr.menu.home/.design/.tools` | `tab` in `tablist` "Library mode" / "Mode Pustaka" | Home / Beranda · Design / Desain · Tools / Alat | `aria-selected` |
| `hdr.title` | `textbox` | "Project title" / "Judul proyek" | `aria-describedby` → dirty indicator "Unsaved changes" / "Perubahan belum disimpan" |
| `hdr.action.*` | `button` | tooltip text (UI_UX_SPECIFICATION.md §4) | `aria-disabled` + description with the reason (never `disabled` attribute so the reason is reachable) |
| `lib.search.input` | `searchbox` | "Search the catalogue" / "Cari di katalog" | results count announced politely: "{n} results" / "{n} hasil" |
| `lib.catalogue.tab` | `tab` | category label | `aria-selected` |
| `lib.catalogue.card` | `button` inside `grid` (roving tabindex) | "{label}, {category} preset{, in your picks}{, slower without GPU}{, needs model {model}}" / "{label}, preset {category}{, dalam pilihan kamu}{, lebih lambat tanpa GPU}{, perlu model {model}}" | `aria-pressed` for selected; description: params summary; focus triggers the same live preview as hover (announced "Previewing {label}" / "Mencoba {label}") |
| `lib.catalogue.card.thumb` | `img` (video element `aria-hidden`) | "" (decorative; label carries meaning) | — |
| `lib.text.size` number | `spinbutton` | "Font size in layout units" / "Ukuran font dalam satuan tata letak" | `aria-valuemin/max/now` |
| `lib.text.colour` swatch | `radio` in `radiogroup` "Text colour" / "Warna teks" | colour name from palette ("Accent orange" / "Oranye aksen") + hex | `aria-checked` |
| `lib.assets.card` | `group` with checkbox and button | "{name}, {kind}, {duration}{, order {n}}{, preparing {percent} percent}{, unsupported: {reason}}" | ingesting progress via `aria-valuenow` on an inner `progressbar` |
| `lib.assets.card.badge.sequence` | `button` | "Order {n}; click to change" / "Urutan {n}; klik untuk mengubah"; no order: "Set order" / "Atur urutan" | — |
| `lib.assets.card.select` | `checkbox` | "Select {name} for Insert" / "Pilih {name} untuk Insert" | `aria-checked` |
| `lib.assets.insert` | `button` | "Insert {n} assets into the timeline" / "Sisipkan {n} aset ke lini masa" | `aria-disabled` + reason |
| `stage.player.controls.play` | `button` | "Play" / "Putar" ↔ "Pause" / "Jeda" | `aria-pressed` not used; label toggles |
| `stage.player.controls.scrubber` | `slider` | "Playhead" / "Playhead" | `aria-valuetext` "{mm}:{ss}.{ff} of {total}"; arrow keys = frame, Shift = 1 s |
| `stage.player.controls.time` | `status` (`aria-live="off"`; updated on pause only) | — | — |
| `stage.player.canvas` | `region` | "Preview" / "Pratinjau" | loading/error states announced via live region |
| `stage.timeline` | `region` | "Timeline" / "Lini masa" | — |
| `stage.timeline.track.*` | `row` in `grid` | "Video track, {n} clips" / "Trek video, {n} klip" etc. | — |
| `stage.timeline.element` | `gridcell` + `button` | "{kind} {label}, {start} to {end}{, selected}" / "{kind} {label}, {start} sampai {end}{, terpilih}" | `aria-selected`; description lists effects/motion/transitions |
| `stage.timeline.inspector` | `complementary` | "Inspector for {label}" / "Inspektur untuk {label}" | rows as `dl`/`dt`/`dd` |
| `agent.chat.model` | `button` | "AI provider and default model: {provider}, {model}. Status: {status}" / "Penyedia AI dan model bawaan: {provider}, {model}. Status: {status}" | — |
| `agent.chat.thread` / `agent.chat.thread` | `log` (`aria-live="polite"`, `aria-relevant="additions"`) | "Brainstorming conversation" / "Percakapan Brainstorming" · "Editor Agent conversation" / "Percakapan Editor Agent" | streaming text announced at the end of the message, not per token |
| `agent.*.composer` | `textbox` (multiline) | "Message to the Brainstorming Agent" / "Pesan untuk Brainstorming Agent" etc. | `aria-describedby` → disabled reason (Private Mode / not configured) |
| `agent.*.footer.ctx` | `status` | "Context used: {used} of {limit} tokens" / "Konteks terpakai: {used} dari {limit} token" | — |
| `agent.brainstorm.handoff` | `group` | "Proposed changes from the Brainstorming Agent, {n} items" / "Usulan perubahan dari Brainstorming Agent, {n} item" | row checkboxes labelled by their title |
| `agent.editor.intentqueue` | `list` | "Your picks, {n} items" / "Pilihan kamu, {n} item" | each `listitem` name = title + status chip text; superseded items say "replaced by {label}; Restore available" / "diganti oleh {label}; Pulihkan tersedia" (line-through alone is not announced) |
| `agent.editor.plancard` | `region` | "Plan: {goal}. Status: {status}. Based on version {v}" / "Rencana: {goal}. Status: {status}. Berdasarkan versi {v}" | steps as ordered `list`; risks as `list` with severity word |
| `agent.editor.execute` | `button` | "Execute plan (Control Enter)" / "Jalankan rencana (Control Enter)" | `aria-disabled` + reason |
| `agent.output.profile.*` / `.ratio.*` / `.resolution.*` | `radio` in `radiogroup` ("Performance profile" / "Profil performa", "Aspect ratio, width to height" / "Rasio aspek, lebar banding tinggi", "Resolution" / "Resolusi") | e.g. "9 by 16, portrait, 1080 by 1920 pixels" / "9 banding 16, potret, 1080 kali 1920 piksel" | `aria-checked`; disabled radios keep focusable with reason in description |
| `agent.output.private` | `switch` | "Private Mode" / "Mode Privat" | `aria-checked`; description = help text |
| `sys.toast` | `status` (info/success) or `alert` (danger) | message text | action buttons labelled with the verb + object ("Undo apply version 13" / "Batalkan penerapan versi 13") |
| `sys.offline`, `sys.privatemode.banner`, `sys.update` | `region` with `aria-live="polite"` (`assertive` for offline) | banner text | — |
| `sys.render.progress` | `progressbar` + `button` | "Export progress {percent} percent, about {eta} left; open export dialog" / "Progres ekspor {percent} persen, sekitar {eta} lagi; buka dialog ekspor" | `aria-valuenow` |
| Modals | `dialog` `aria-modal` | `aria-labelledby` title | focus trapped; Esc |
| Tour step | `dialog` (non-modal, `aria-live` off) | "Tour step {n} of 10: {title}" / "Langkah tur {n} dari 10: {title}" | target element gets `aria-describedby` → step body |

Live announcements (visually hidden `aria-live="polite"` region `sys.live`, ELEMENT_IDS.md): plan ready, applied with version, export done/failed, reconnected, ingest complete ("{name} ready" / "{name} siap"). At most one announcement per 2 s; coalesced.

## 3. Caption and preview accessibility

| Topic | Rule |
|---|---|
| Captions in the Creator's video | Caption presets (`preset:caption.*`) default to ≥ 56 u font, ≥ 4.5:1 text/background (box style guarantees it; editorial/karaoke add a text shadow or scrim on `preset:background.video-dim` suggestion when contrast on the frame is low — the Layout sub-agent warns `warn` "Captions may be hard to read on bright footage" / "Caption mungkin sulit dibaca pada rekaman terang") |
| Caption safe area | captions never render outside the platform-safe area for the ratio (ported safe-area tables); `stage.player.menu` "Safe area overlay" shows it |
| Player controls | always visible (no auto-hide) except in fullscreen where they appear on pointer move or any key |
| Audio | mute toggle in `stage.player.menu`; waveform shown for audio layers (visual equivalent); no autoplay with sound on project open |
| Flashing content | preview of effects/transitions limited per §1; the Creator is responsible for their footage, and the Export preflight does not analyse it (stated in About ▸ Known limitations) |
| Text alternatives | asset thumbnails `alt` = file name; generated thumbnails `alt` = title text used |
| Transcript | P1 Generate Captions produces editable pages that are also the transcript; the `.result` view is a plain table (screen-reader friendly) |

## 4. Internationalisation: key scheme

ADR-012: English UI in MVP; every string behind a key; Indonesian variants for everything from day one; full Indonesian UI toggle later (Project Settings or Help ▸ Language, P1).

| Namespace | Pattern | Example | Owner of the text |
|---|---|---|---|
| UI strings | `ui.<region>.<element>.<state>` where `<region>` ∈ `hdr, lib, stage, agent, scr, sys, modal, window` (mirrors ELEMENT_IDS.md regions, plus `modal`/`window`), `<element>` = element id tail with dots kept, `<state>` optional (`label, tooltip, placeholder, empty, disabled, loading, error, help, a11y`) | `ui.agent.output.profile.help`, `ui.lib.assets.insert.disabled`, `ui.hdr.export.disabled` | UI_UX_SPECIFICATION.md |
| Accessibility names | `a11y.<element id>` | `a11y.lib.catalogue.card` | this document §2 |
| Errors | `err.<code>` with sub-keys `.title`, `.body`, `.action` | `err.EM-3102.title`, `err.EM-3102.body`, `err.EM-3102.action` | ERROR_CATALOGUE.md |
| Tour and onboarding | `tour.<step>` with `.title`, `.body`, `.next`; `onb.<step>.<field>` | `tour.3.title`, `onb.provider.validate` | ONBOARDING_TOUR.md |
| Catalogue | `preset.<id>.label`, `preset.<id>.tags`, `preset.<id>.param.<name>` | `preset.transition.fade.label` | DESIGN_CATALOGUE.md (labels EN/ID), generated into locale files at build |
| Shortcuts | `key.<action>` | `key.execute` → "Ctrl+Enter" (platform-mapped) | EDITOR_INTERACTION_MODEL.md |
| Agent-facing | `agent.reply.<id>` only for deterministic system bubbles (handoff receipt, interrupted, cancelled); model output is not localised by keys | `agent.reply.handoff.sent` | AI_WORKFLOW.md §12 copy |
| Units and formats | `fmt.<kind>` | `fmt.duration.short` | this document §6 |

Rules for keys: lower-case, dots only, no indexes in keys (use ICU arguments), stable once shipped (renames go through a deprecation alias file `aliases.json`), no key may be used for two meanings.

## 5. Locale files and string rules

| Item | Rule |
|---|---|
| Files | `apps/ui/src/i18n/en.json`, `apps/ui/src/i18n/id.json`; flat keys (dotted strings), UTF-8, sorted; `packages/shared/i18n/` holds the ICU formatter and the shared `err.*` messages so the Local Service can return localised error copy to the Editor (`Accept-Language` from project language) |
| Completeness | **I18N-01** build fails if `id.json` lacks any key present in `en.json` (UX-041); extra keys in `id.json` fail too |
| Format | ICU MessageFormat (`@formatjs/intl` or `intl-messageformat`); plurals via `{count, plural, one {…} other {…}}` (Indonesian uses `other` only; the formatter handles it); selects via `{kind, select, clip {…} text {…} other {…}}` |
| No concatenation | **I18N-02** strings are complete sentences with named arguments; never `t('a') + x + t('b')`; lint forbids string `+` adjacent to `t(` |
| No HTML in strings | rich text via components `<b>…</b>` using ICU tag syntax; links as arguments |
| Capitalisation | sentence case for EN and ID; product terms keep their capitalisation (Editor Agent, Private Mode, Execute) and are not translated when they are product terms (Execute, Insert, Draft, Standard/Accelerated/Turbo, Private Mode → "Mode Privat" is the one translated term; the ID glossary lives in `id.json` comments) |
| Forbidden words | **I18N-03** lint rejects the UX-040 list in `ui.*`, `tour.*`, `onb.*`, `err.*` (exempt: `ui.scr.diagnostics.*`, `ui.scr.about.*` third-party notices) |
| Length | ID strings may be up to 40 % longer; components truncate with ellipsis + tooltip (UX-053); buttons wrap to two lines at most; segmented controls use short labels with sublabels |
| Placeholders | `{model}`, `{version}`, `{count}`, `{name}` names are shared across locales; a key's argument set is validated to match between files |
| Pseudo-locale | `qps-ploc` (bracketed, 40 % longer) available in development to catch truncation |
| Numbers inside strings | always formatted via `fmt.*` before insertion, never raw |

## 6. Dates, numbers, units, fonts

| Kind | en-US (MVP UI) | id-ID | Notes |
|---|---|---|---|
| Decimal / thousands | 1,234.5 | 1.234,5 | `Intl.NumberFormat`; never `toLocaleString` without locale |
| File size | 1.6 GB · 812 MB | 1,6 GB · 812 MB | binary-ish display with 1 decimal ≥ 1 GB |
| Money | $0.004 · ≈ $0.004 · n/a | $0,004 · ≈ $0,004 · n/a | always USD (provider currency); "≈" prefix rule in UXRD UX-020 |
| Tokens | 1 240 / 200 000 | 1.240 / 200.000 | EN uses thin space grouping in `t-mono` for readability |
| Duration (short) | 0:42 · 1:05:00 | 0:42 · 1:05:00 | m:ss or h:mm:ss |
| Timecode | 00:12.08 (mm:ss.ff) | 00:12.08 | frames two digits; fps from Project Settings |
| ETA | ≈ 1 min 30 s · ≈ 1 min left | ≈ 1 mnt 30 d · ≈ 1 mnt lagi | rounded to 10 s; "Estimating…" / "Memperkirakan…" before data |
| Dates | 24 Oct 2026, 14:32 | 24 Okt 2026, 14.32 | `Intl.DateTimeFormat` medium; 24-hour in id-ID |
| Pixels | 1080×1920 | 1080×1920 | "×" (U+00D7), width first |
| Percent | 42 % | 42 % | thin space before % in both (house style) |
| Ratios | 9:16 | 9:16 | colon, never "9x16" in UI (element ids use `9x16`) |
| Fonts | UI: `Inter, "Segoe UI", system-ui, -apple-system, Roboto, sans-serif`; mono: `"JetBrains Mono", Consolas, "Courier New", monospace` | same | bundled Inter and JetBrains Mono (woff2) load via `@font-face` with `font-display: swap`; Indonesian needs no extra glyphs beyond Latin-1; Segoe UI fallback renders before fonts load |
| Writing direction | LTR only | LTR only | RTL is **not required** (no RTL target locale); layout still uses logical properties (`margin-inline-start`) so RTL is not precluded |
| Sorting | `Intl.Collator('en')` | `Intl.Collator('id')` | asset lists, recent projects |

## 7. Language of generated content

| Rule | Detail |
|---|---|
| **I18N-10** Project language | `scr.project.settings` language ∈ {`id`, `en`}; default from the OS display language (`id-*` → `id`, else `en`); shown as "Indonesian / English" (UI_UX_SPECIFICATION.md §8). |
| Agents | the Rewrite envelope carries `project.language`; the system prompt instructs both agents to reply in that language; Design Preset labels in replies use the matching column of DESIGN_CATALOGUE.md (rule 4). The Creator may write in either language; the agent follows the project language unless the Creator asks otherwise in the message. |
| Generators | `scr.generate.*.language` defaults to the project language; whisper language hint, Piper voice set, hashtag language all follow it; the Creator can override per run. |
| Text the agent writes into the video (`op:text.add`) | in the project language; the Plan Card shows the text so the Creator can change it before Execute. |
| Error copy | from `err.*` in the **UI language** (EN in MVP), not the project language; the `EM-` code is language-neutral. The Indonesian error copy ships in `id.json` for the later Indonesian UI and for the diagnostics bundle (both languages included). |
| Onboarding and tour | UI language (EN in MVP) with an inline "Bahasa Indonesia" link on the welcome step that switches the **onboarding and tour only** to Indonesian (`onb.*`, `tour.*` keys), since ADR-012 names these as day-one Indonesian content; the Editor stays EN until the Indonesian UI release. |

## 8. Requirements

| ID | Requirement | Verification |
|---|---|---|
| A11Y-01 | All text/background token pairs used in components meet §1 contrast | automated token test |
| A11Y-02 | Every focusable element shows the `--em-focus` ring | visual regression |
| A11Y-03 | F1–F10 keyboard-only completion | UI test (UX-051) |
| A11Y-04 | Every custom control has role, name and state per §2 | axe + manual NVDA pass |
| A11Y-05 | Live announcements for plan ready, applied, export done/failed, reconnected | UI test |
| A11Y-06 | Reduced motion honoured per §1 | UI test (UX-054) |
| A11Y-07 | No keyboard trap outside modals; modals trap and release focus to opener | UI test |
| A11Y-08 | Disabled controls expose their reason (`aria-disabled` + description) | axe rule + review |
| A11Y-09 | Target sizes ≥ 24 px | lint |
| A11Y-10 | Superseded Intent Queue items are announced as replaced, not only struck through | UI test |
| I18N-01 | `id.json` complete vs `en.json`; argument sets match | build |
| I18N-02 | No string concatenation; ICU for plurals/selects | lint |
| I18N-03 | Forbidden-word lint on Creator-facing namespaces | lint |
| I18N-04 | All numbers, dates, sizes via `fmt.*`/`Intl` with explicit locale | lint (`toLocaleString()` without args forbidden) |
| I18N-05 | Preset labels EN/ID sourced from DESIGN_CATALOGUE.md at build (no hand copies) | build script test |
| I18N-06 | Error copy returned by the Local Service is keyed (`err.<code>`) and resolvable in both locales | API test |
| I18N-07 | Pseudo-locale run shows no clipped or overlapping text at 1280×720 | manual per stage |
| I18N-08 | Fonts bundled; no network font requests | network test |
| I18N-09 | Onboarding/tour switchable to Indonesian independently of the UI language | UI test |
| I18N-10 | Generated content follows project language (§7) | agent eval + generator test |

## 9. Testing checklist (per Roadmap Stage, before the gate)

| # | Check | Tool | Pass criterion |
|---|---|---|---|
| 1 | axe-core on every `scr.*` and the main Editor in all three Library modes | Playwright + axe | 0 serious/critical |
| 2 | Keyboard walk of F1–F10 with a recorded key log | Playwright | every step reachable; focus order matches EDITOR_INTERACTION_MODEL.md §11 |
| 3 | NVDA + Chrome manual pass: Catalogue Card, Intent Queue (incl. superseded), Plan Card, Output Settings radios, Export progress | manual | names/states read as §2 |
| 4 | Contrast of token pairs; screenshot sampling of Player chips over footage (chips have a scrim) | script + manual | ≥ 4.5:1 |
| 5 | Reduced motion: OS setting on → loops static, no pulses | manual | matches §1 |
| 6 | 150 % Windows scaling at 1280×720 and 1024 px collapsed layout | manual | no overlap/clipping |
| 7 | Pseudo-locale and `id.json` at 1280×720: Output Settings, Plan Card, Intent Queue, Export preflight | Playwright screenshots | no clipping; ellipsis + tooltip where truncated |
| 8 | Lint: I18N-01…04, UX-040 words | CI | 0 violations |
| 9 | `id-ID` formatting snapshots: sizes, money, durations, dates | unit | match §6 |
| 10 | Agent replies language: 10 golden scenarios in `id`, 5 in `en` | agent eval | ≥ 95 % in the right language |
| 11 | Tour in Indonesian end to end | manual | all 8 steps |
| 12 | Diagnostics bundle contains error copy in both languages and no secrets | unit | pass |
