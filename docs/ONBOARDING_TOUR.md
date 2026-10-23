# Onboarding Wizard and In-App Tour

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, ELEMENT_IDS.md, UXRD.md (UX-001, UX-002, UX-003, UX-024, UX-025), USER_FLOWS.md (F1), UI_UX_SPECIFICATION.md (§8 `scr.onboarding`, tokens), ACCESSIBILITY_AND_I18N.md (`onb.*`, `tour.*` keys, §7 language switch), PERFORMANCE.md (tier copy), DECISIONS.md (ADR-008, 012, 014) |
| Used by | FRD.md, TEST_PLAN.md, UI_UX_SPECIFICATION.md |
| Owner of | onboarding wizard copy and skip rules, the 10-step tour (targets, copy, triggers), re-run rules, first-project nudges, success-moment copy |
| ID range | ONB-1 … ONB-6 (wizard steps), TOUR-1 … TOUR-10 (tour steps), NUDGE-1 … NUDGE-8 |

Copy is EN / ID. Keys follow ACCESSIBILITY_AND_I18N.md §4 (`onb.<step>.<field>`, `tour.<n>.<field>`, `nudge.<id>`). The MVP shows EN; the welcome step offers a one-click switch of **onboarding and tour copy only** to Indonesian (ACCESSIBILITY_AND_I18N.md §7, I18N-09). Element ids are from ELEMENT_IDS.md; `scr.onboarding.hardware` is proposed (USER_FLOWS.md notes).

## 1. Principles

| # | Rule |
|---|---|
| 1 | The wizard asks only for what the first export needs: licence or trial, one provider (skippable), model assignment (defaults), hardware check (informational). Nothing else. |
| 2 | Every step is skippable except the licence/trial choice (which has a one-click "Continue with trial"). Skipping never blocks the Editor; skipped items are reachable later and the Editor nudges once. |
| 3 | The wizard never uses the forbidden words (UX-040). "Engine", "model", "provider" are allowed and explained on first use. |
| 4 | Copy is short: title ≤ 6 words, body ≤ 2 sentences, one primary action, one ghost action. |
| 5 | Progress is visible (step n of 6) and the Creator can go back. State is saved per step so a crash mid-wizard resumes at the same step. |
| 6 | The tour runs on the real Editor with a real (sample) project so every pointer points at something that works. |

## 2. Onboarding wizard (`scr.onboarding`)

Layout: full-window, 720 px centred column (UI_UX_SPECIFICATION.md §8); step indicator top; "Skip setup" / "Lewati pengaturan" ghost top-right (visible from ONB-2 onward); Back / Next bottom.

| Step | Element id | Title EN / ID | Body EN / ID | Fields / actions (EN / ID) | Skip rule | Completion writes |
|---|---|---|---|---|---|---|
| ONB-1 | `scr.onboarding.welcome` | Welcome to Expertmotion / Selamat datang di Expertmotion | Turn your clips into a polished motion video: pick looks, describe what you want, and export. Setup takes about three minutes. / Ubah klip Anda menjadi video motion yang rapi: pilih tampilan, jelaskan keinginan Anda, lalu ekspor. Pengaturan memakan waktu sekitar tiga menit. | Primary "Get started" / "Mulai"; link "Bahasa Indonesia" (switches onb/tour copy); footnote "Everything runs on this PC. The internet is used only for the AI models you connect." / "Semua berjalan di PC ini. Internet dipakai hanya untuk model AI yang Anda hubungkan." | Cannot skip (one click) | `onboarding.language` |
| ONB-2 | `scr.onboarding.license` | Licence or trial / Lisensi atau uji coba | Paste your licence key, or start a trial. The trial has every feature; exports carry a watermark and are limited to 720p. / Tempel kunci lisensi Anda, atau mulai uji coba. Uji coba punya semua fitur; hasil ekspor diberi watermark dan dibatasi 720p. | `scr.license.input` "Licence key" / "Kunci lisensi" (masked, paste button); `scr.license.activate` "Activate" / "Aktifkan"; `scr.license.trial.continue` "Continue with trial" / "Lanjutkan uji coba"; link "Buy a licence" / "Beli lisensi" (system browser); `scr.license.error` inline (`EM-5xxx`) | Must choose one; "Skip setup" here = trial | licence state |
| ONB-3 | `scr.onboarding.provider` | Connect an AI provider / Hubungkan penyedia AI | The Brainstorming Agent and Editor Agent run on an AI model you bring. OpenRouter gives one key for many models; you pay the provider directly, usually cents per video. / Brainstorming Agent dan Editor Agent berjalan pada model AI yang Anda bawa. OpenRouter memberi satu kunci untuk banyak model; Anda membayar penyedia langsung, biasanya hanya beberapa sen per video. | `scr.providers.provider.select` (OpenRouter default; others P1); `scr.providers.key.input` "API key" / "Kunci API" with "Where do I get a key?" / "Di mana mendapatkan kunci?" link; `scr.providers.validate` "Validate" / "Validasi" → "Checking key…" / "Memeriksa kunci…" → "{n} models available" / "{n} model tersedia"; errors inline (`EM-4xxx`) | "Skip for now" / "Lewati dulu" → agents disabled; Model Bar shows "Connect an AI provider" | Provider Connection (encrypted) |
| ONB-4 | `scr.onboarding.models` | Choose your models / Pilih model Anda | We picked a balanced default for each agent. The Editor Agent needs a model that can follow a strict format; marked ones can. / Kami memilih bawaan yang seimbang untuk tiap agen. Editor Agent perlu model yang bisa mengikuti format ketat; yang bertanda bisa. | `scr.providers.assign.brainstorm` "Brainstorming Agent" with model, context "200k", "≈ $/M" or "n/a"; `scr.providers.assign.editor` "Editor Agent" (tools/structured badge required); `scr.providers.budget.limit` "Monthly budget (optional)" / "Anggaran bulanan (opsional)" default empty, hint "We warn at 80 % and stop at the limit" / "Kami memperingatkan pada 80 % dan berhenti di batas"; `scr.providers.test` "Test both" / "Uji keduanya" → "Test passed" / "Tes berhasil" | Shown only if ONB-3 completed; "Use defaults" / "Pakai bawaan" skips the test | Model Assignments, budget |
| ONB-5 | `scr.onboarding.hardware` (proposed) | Checking your PC / Memeriksa PC Anda | Expertmotion adapts to your hardware. Nothing here needs a fix; it only sets safe defaults. / Expertmotion menyesuaikan diri dengan perangkat Anda. Tidak ada yang perlu diperbaiki; ini hanya mengatur bawaan yang aman. | Read-only card: "Tier {tier} · {ram} GB RAM · GPU: {gpu}" and the consequence line: T0 "Standard profile · exports up to 1080p · effects run slower" / "Profil Standard · ekspor hingga 1080p · efek berjalan lebih lambat"; T1 "Accelerated available · up to 2160p with a warning" / "Accelerated tersedia · hingga 2160p dengan peringatan"; T2 "Turbo available · all presets" / "Turbo tersedia · semua preset". Warning if RAM < 8 GB (USER_FLOWS.md F1.E5). Link "Open Hardware Monitor later from the header" / "Buka Monitor Perangkat Keras nanti dari header" | "Next" only (nothing to decide); never auto-advances (A11Y: no timed steps) | `hardware_profiles` row |
| ONB-6 | `scr.onboarding.tour` → `scr.onboarding.done` | Take the two-minute tour? / Ikuti tur dua menit? | We open a sample project and point at the six things you will use most. You can re-run it any time from Help. / Kami membuka proyek contoh dan menunjukkan enam hal yang paling sering Anda pakai. Anda bisa mengulanginya kapan saja dari Help. | Primary "Start tour" / "Mulai tur"; ghost "Skip, open an empty project" / "Lewati, buka proyek kosong" | Skip → empty project with nudges (§4) | `onboarding.completed`, `tour.completed` |

Behaviour notes:

| Topic | Rule |
|---|---|
| Resume | If the app closes mid-wizard, it resumes at the last incomplete step with saved values (except the API key field, which is re-requested unless already validated and stored). |
| Private Mode | Not offered in the wizard (it would block ONB-3); the tour step TOUR-9 introduces it. |
| Re-run | File ▸ (none). The wizard itself is not re-runnable; its pieces are: Licence (`hdr.action.license`), Providers (`agent.modelbar`), Hardware (`hdr.action.hardware`), Tour (`hdr.menu.help.tour`). |
| Sample project for the tour | "Sample · Kafe Senja" / "Contoh · Kafe Senja": three bundled 5 s clips (CC0), one SRT, Theme `preset:palette.editorial-dark`; created only when the tour starts; deleted when the Creator creates or opens another project unless they saved it under a new name. |

## 3. In-app tour (10 steps)

Mechanics: spotlight overlay (scrim `--em-overlay`, 8 px rounded cut-out around the target with 8 px padding), a 320 px card anchored to the target (auto-flip), step counter "n / 10", buttons Back / Next (or the "next trigger" action), "End tour" ghost. Keyboard: Enter = Next, Esc = End tour (asks "End the tour? You can re-run it from Help." / "Akhiri tur? Anda bisa mengulanginya dari Help."). Each step waits for the **next trigger** (a real action) or Next; triggers are preferred so the Creator learns by doing. Reduced motion: no spotlight animation.

| Step | Target element id | Title EN / ID | Body EN / ID | Next trigger |
|---|---|---|---|---|
| TOUR-1 | `hdr.menu.design` (whole menu row highlighted, Design emphasised) | Three places to work / Tiga tempat bekerja | **Home** is text, **Design** is looks, **Tools** is generators. The left panel changes with each. / **Home** untuk teks, **Design** untuk tampilan, **Tools** untuk generator. Panel kiri berubah mengikutinya. | Click `hdr.menu.design` (or Next) |
| TOUR-2 | `lib.assets.panel` (sample clips already inserted) | Your assets live here / Aset Anda ada di sini | Drop clips, images and audio here. Number them with the badges, then press Insert to put them in the timeline. The sample's three clips are already in. / Letakkan klip, gambar, dan audio di sini. Beri nomor lewat lencana, lalu tekan Insert untuk memasukkannya ke lini masa. Tiga klip contoh sudah masuk. | Next |
| TOUR-3 | `lib.catalogue.card` (first transition, Fade) | Preview before you pick / Lihat dulu sebelum memilih | Hover a card to try it on your own video in the player. Click to pick it. / Arahkan kursor ke kartu untuk mencobanya di video Anda pada player. Klik untuk memilihnya. | Hover ≥ 1 s then click the card → the pick is applied directly (Compile) |
| TOUR-4 | `agent.editor.intentqueue.item` (the item just created) | Every pick is a receipt / Setiap pilihan adalah tanda terima | Your pick appears here. Simple picks apply directly, with no AI involved. Pick another transition and the old one is struck through, not lost; Restore brings it back. / Pilihan Anda muncul di sini. Pilihan sederhana langsung diterapkan, tanpa AI. Pilih transisi lain dan yang lama dicoret, bukan hilang; Pulihkan mengembalikannya. | Click a second transition card (shows supersede) or Next |
| TOUR-5 | `stage.timeline` | Everything on the timeline / Semua ada di lini masa | Each lane is a track: video, overlay, text, captions, audio. Click any element to inspect it; your next picks then apply to it. / Tiap jalur adalah trek: video, lapisan, teks, caption, audio. Klik elemen mana pun untuk melihat rinciannya; pilihan berikutnya berlaku untuknya. | Click a `stage.timeline.element` or Next |
| TOUR-6 | `agent.brainstorm.composer` | Think out loud here / Berpikir keras di sini | The Brainstorming Agent helps with ideas and structure. It never changes your video; it proposes, and you decide what to send on. Try: "judul pembuka yang energik". / Brainstorming Agent membantu ide dan struktur. Ia tidak pernah mengubah video Anda; ia mengusulkan, Anda yang memutuskan apa yang dikirim. Coba: "judul pembuka yang energik". | Send a message (if a provider is configured) or Next. Without a provider: body gains "Connect a provider from the Model Bar to try this." / "Hubungkan penyedia dari Model Bar untuk mencobanya." |
| TOUR-7 | `agent.editor.plancard` (a prepared sample plan is shown if the agent is unavailable: "Add title 'Kafe Senja' 0–3 s · Rise motion") | Nothing changes until Execute / Tidak ada yang berubah sampai Execute | The Editor Agent turns requests into a plan: steps, what will change, and any risks. Read it, add a note if you like, then press Execute. Only then does the video change, and you can undo it. / Editor Agent mengubah permintaan menjadi rencana: langkah, apa yang berubah, dan risikonya. Baca, tambahkan catatan jika mau, lalu tekan Execute. Baru saat itu video berubah, dan Anda bisa membatalkannya. | Press `agent.editor.execute` (Ctrl+Enter) → version created; toast with Undo highlighted for 3 s |
| TOUR-8 | `agent.output.ratio.9x16` (whole Output Settings block) | Shape, size, speed / Bentuk, ukuran, kecepatan | Pick the platform shape (width:height) and resolution; the exact pixels are shown. Performance profiles change how much of your PC is used, never the video itself. / Pilih bentuk platform (lebar:tinggi) dan resolusi; piksel pastinya ditampilkan. Profil performa mengatur seberapa banyak PC Anda dipakai, bukan videonya. | Click any ratio (applied directly) or Next |
| TOUR-9 | `agent.output.private` | Private Mode / Mode Privat | Switch this on and Expertmotion makes no internet connections at all: agents pause, downloads pause, editing and export keep working. A banner reminds you while it is on. / Nyalakan ini dan Expertmotion tidak membuat koneksi internet sama sekali: agen dijeda, unduhan dijeda, penyuntingan dan ekspor tetap berjalan. Spanduk mengingatkan Anda selama aktif. | Next (toggling is optional; if toggled on, the step adds "Switch it off to keep using the agents in this tour." / "Matikan agar tetap bisa memakai agen di tur ini.") |
| TOUR-10 | `hdr.action.export` | Export when you are ready / Ekspor saat siap | Export checks disk, memory and size first, then renders on this PC with progress and cancel. Your file lands in the project's output folder. / Ekspor memeriksa disk, memori, dan ukuran dulu, lalu merender di PC ini dengan progres dan tombol batal. Berkas Anda tersimpan di folder keluaran proyek. | Click Export → `scr.export` opens with preflight; tour ends with the closing card below (export itself is not forced) |

Closing card (`tour.done`): "That is the whole loop: insert, pick, describe, Execute, export. Help ▸ Tour brings this back any time." / "Itulah seluruh alurnya: sisipkan, pilih, jelaskan, Execute, ekspor. Help ▸ Tur mengembalikan ini kapan saja." Buttons: "Keep the sample project" / "Simpan proyek contoh" · "Start my own project" / "Mulai proyek saya sendiri" (→ `scr.project.new`).

Tour rules:

| Rule | Detail |
|---|---|
| Re-run | `hdr.menu.help.tour` → "Re-run the tour on this project or the sample?" / "Ulangi tur di proyek ini atau proyek contoh?" If the current project lacks a Clip, the sample is used so TOUR-3/5 have targets. |
| Interruptions | If a target is missing (collapsed panel), the tour expands the panel; if an action fails (provider error), the step shows the error inline and allows Next. |
| State | `tour.completed` and `tour.lastStep` in settings.json; a tour abandoned at step ≥ 3 offers "Resume tour?" / "Lanjutkan tur?" once on next launch. |
| Analytics | None (no telemetry). |
| Timing target | ≤ 2 min 30 s on the reference laptop with the sample project (UT measures). |

## 4. First-project nudges (empty states and one-time hints)

Nudges are one-time (per installation) inline hints with a dismiss ×; they use the empty-state pattern (UXRD §6) where the region is empty, and a small accent-bordered hint card otherwise. They never stack more than one at a time; priority order below. After dismissal they are gone; the underlying empty states (UI_UX_SPECIFICATION.md §9) remain.

| ID | Where | When shown | Copy EN / ID | Primary action |
|---|---|---|---|---|
| NUDGE-1 | `lib.assets.empty` | Empty project, no assets | Drop video, image or audio here. Then number them and press Insert. / Letakkan video, gambar, atau audio di sini. Lalu beri nomor dan tekan Insert. | "Import files…" / "Impor berkas…" |
| NUDGE-2 | hint card above `lib.assets.insert` | ≥ 2 assets ready, none inserted, 20 s elapsed | Set the order with the number badges, then Insert. Order 2-3-1 inserts as 1-2-3. / Atur urutan lewat lencana angka, lalu Insert. Urutan 2-3-1 masuk sebagai 1-2-3. | Focus first badge |
| NUDGE-3 | `stage.timeline.empty` | No Clip | Insert assets, then your picks and the Editor Agent fill this timeline. / Sisipkan aset, lalu pilihan Anda dan Editor Agent mengisi lini masa ini. | — |
| NUDGE-4 | hint card at top of `lib.catalogue` | First Clip inserted, Design mode never opened | Hover a look to try it on your video; click to pick it. / Arahkan ke sebuah tampilan untuk mencobanya di video Anda; klik untuk memilihnya. | "Open Design" / "Buka Design" |
| NUDGE-5 | `agent.editor.intentqueue` empty | No intents yet | Your picks and requests appear here. Simple picks apply directly; the rest become a plan you approve. / Pilihan dan permintaan Anda muncul di sini. Pilihan sederhana langsung diterapkan; sisanya menjadi rencana yang Anda setujui. | — |
| NUDGE-6 | `agent.modelbar` | Provider skipped in ONB-3; shown on first visit to the Agent Panel | Connect an AI provider to use the agents. Picks and export work without one. / Hubungkan penyedia AI untuk memakai agen. Pilihan dan ekspor tetap berjalan tanpanya. | "Connect" / "Hubungkan" |
| NUDGE-7 | first Plan Card | First plan ever | Read the steps and risks. Nothing changes until you press Execute, and you can undo it after. / Baca langkah dan risikonya. Tidak ada yang berubah sampai Anda menekan Execute, dan Anda bisa membatalkannya setelahnya. | Highlights `agent.editor.execute` |
| NUDGE-8 | `scr.export` preflight, Trial Mode | First export in Trial Mode | Trial exports carry a watermark and are 720p. Everything else is identical. / Ekspor uji coba diberi watermark dan 720p. Selebihnya sama persis. | "Purchase" / "Beli Lisensi" · "Continue" / "Lanjutkan" |

Nudges are suppressed while the tour is running and while `sys.offline` or a modal is shown.

## 5. Success moments

| Moment | Where | Copy EN / ID | Actions |
|---|---|---|---|
| First Insert | `sys.toast` success | Your clips are in. Now pick a look in Design, or ask the Brainstorming Agent. / Klip Anda sudah masuk. Sekarang pilih tampilan di Design, atau tanya Brainstorming Agent. | "Open Design" / "Buka Design" |
| First Execute | Plan Card badge + toast | Applied · version {v}. Undo is always one step away. / Diterapkan · versi {v}. Batalkan selalu satu langkah saja. | "Undo" / "Batalkan" |
| **First export** (`scr.export.done`, first ever on this installation) | Done phase of the Export dialog, `t-display` title | Your first video is ready. / Video pertama Anda sudah jadi. · Body: "{filename} · {duration} · {w}×{h} · {size}. It was rendered on this PC; nothing was uploaded." / "{filename} · {duration} · {w}×{h} · {size}. Dirender di PC ini; tidak ada yang diunggah." · In Trial Mode add: "This export has a watermark and is 720p. A licence removes both." / "Ekspor ini berwatermark dan 720p. Lisensi menghapus keduanya." | "Open folder" / "Buka folder" (primary) · "Export another size" / "Ekspor ukuran lain" (reopens setup with the next common ratio suggested: 9:16 → 1:1) · Trial: "Purchase" / "Beli Lisensi" |
| First export (later ones) | Standard done phase | Export complete. / Ekspor selesai. | as UI_UX_SPECIFICATION.md §8 |
| First recovery | `scr.project.recover` after Restore | Recovered version {v}. Expertmotion checkpoints your work every few seconds. / Versi {v} dipulihkan. Expertmotion menyimpan checkpoint pekerjaan Anda tiap beberapa detik. | — |

Success moments use `--em-success` and the `check-circle-2` icon, no confetti, no sound (identity notes, UI_UX_SPECIFICATION.md §1.1). Reduced motion: no animation.

## 6. Verification

| Item | Criterion | Method |
|---|---|---|
| Wizard completion time | ≤ 3 min median with provider; ≤ 1 min with "Skip setup" | UT round 5 (UXRD §8) |
| Tour duration | ≤ 2 min 30 s | UT |
| UX-001 | first export ≤ 10 min including wizard and tour | UT |
| UX-002 | Insert found without the tour by ≥ 4/5 | UT with tour skipped |
| UX-003 | Execute understood after TOUR-7 or NUDGE-7 | UT think-aloud |
| Strings | every `onb.*`, `tour.*`, `nudge.*` key present in `en.json` and `id.json`; no forbidden words | lint (I18N-01, I18N-03) |
| Targets | every tour target id exists in the DOM as `data-el` at that step | UI test |
| Resume | kill during ONB-3 → relaunch resumes at ONB-3 | UI test |
