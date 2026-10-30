# Onboarding Wizard and In-App Tour

| Field | Value |
|---|---|
| Status | baseline |
| Owner | UI/UX lead |
| Last updated | 2026-10-30 |
| Depends on | GLOSSARY.md, ELEMENT_IDS.md, UXRD.md (UX-001, UX-002, UX-003, UX-024, UX-025), USER_FLOWS.md (F1), UI_UX_SPECIFICATION.md (§8 `scr.onboarding`, tokens), ACCESSIBILITY_AND_I18N.md (`onb.*`, `tour.*` keys, §7 language switch), PERFORMANCE.md (tier copy), DECISIONS.md (ADR-008, 012, 014) |
| Used by | FRD.md, TEST_PLAN.md, UI_UX_SPECIFICATION.md |
| Owner of | onboarding wizard copy and skip rules, the 8-step tour (targets, copy, triggers; FR-149 ≤ 8), re-run rules, first-project nudges, success-moment copy |
| ID range | ONB-1 … ONB-6 (wizard steps), TOUR-1 … TOUR-8 (tour steps), NUDGE-1 … NUDGE-8 |

Copy is EN / ID. Keys follow ACCESSIBILITY_AND_I18N.md §4 (`onb.<step>.<field>`, `tour.<n>.<field>`, `nudge.<id>`). The MVP shows EN; the welcome step offers a one-click switch of **onboarding and tour copy only** to Indonesian (ACCESSIBILITY_AND_I18N.md §7, I18N-09). Element ids are from ELEMENT_IDS.md. Copy uses the friendly "kamu" register (GLOSSARY.md "Words to avoid").

## 1. Principles

| # | Rule |
|---|---|
| 1 | The wizard asks only for what the first export needs: one provider (skippable), model assignment (defaults), hardware check (informational). Nothing else. The Licence Key is activated before the wizard, on the licence screen (LICENSE_OPERATIONS.md §7: no Trial Mode). |
| 2 | Every step is skippable. Skipping never blocks the Editor; skipped items are reachable later and the Editor nudges once. |
| 3 | The wizard never uses the forbidden words (UX-040). "Engine", "model", "provider" are allowed and explained on first use. |
| 4 | Copy is short: title ≤ 6 words, body ≤ 2 sentences, one primary action, one ghost action. |
| 5 | Progress is visible (step n of 6) and the Creator can go back. State is saved per step so a crash mid-wizard resumes at the same step. |
| 6 | The tour runs on the real Editor with a real (sample) project so every pointer points at something that works. |

## 2. Onboarding wizard (`scr.onboarding`)

Layout: full-window, 720 px centred column (UI_UX_SPECIFICATION.md §8); step indicator top; "Skip setup" / "Lewati pengaturan" ghost top-right (visible from ONB-3 onward); Back / Next bottom.

| Step | Element id | Title EN / ID | Body EN / ID | Fields / actions (EN / ID) | Skip rule | Completion writes |
|---|---|---|---|---|---|---|
| ONB-1 | `scr.onboarding.welcome` | Welcome to Expertmotion / Selamat datang di Expertmotion | Turn clips into a motion video. Setup takes about 3 minutes. / Ubah klip jadi video motion. Pengaturan sekitar 3 menit. | Primary "Get started" / "Mulai"; link "Bahasa Indonesia" (switches onb/tour copy); footnote "Runs on this PC. Internet only for the AI you connect." / "Berjalan di PC ini. Internet hanya untuk AI yang kamu hubungkan." | Cannot skip (one click) | `onboarding.language` |
| ONB-2 | — (retired 2026-10-25) | — | The Licence step was removed with Trial Mode: an install that is not licensed shows only the licence screen (`scr.license`, `data-gate`) and the wizard starts after activation. | — | — | — |
| ONB-3 | `scr.onboarding.provider` | Connect an AI provider / Hubungkan penyedia AI | The agents use an AI key you bring; you pay the provider directly. OpenRouter: one key, many models. / Agen memakai kunci AI milikmu; bayar langsung ke penyedia. OpenRouter: satu kunci, banyak model. | `scr.providers.provider.select` (OpenRouter default; others P1); `scr.providers.key.input` "API key" / "Kunci API" with "Where do I get a key?" / "Di mana mendapatkan kunci?" link; `scr.providers.validate` "Validate" / "Validasi" → "Checking key…" / "Memeriksa kunci…" → "{n} models available" / "{n} model tersedia"; errors inline (`EM-4xxx`) | "Skip for now" / "Lewati dulu" → "Agents stay off until connected" / "Agen nonaktif sampai terhubung"; the chat header shows "Connect an AI provider" | Provider Connection (encrypted) |
| ONB-4 | `scr.onboarding.models` | Choose your models / Pilih model kamu | A balanced default per agent. Marked models suit the Editor Agent. / Bawaan seimbang per agen. Model bertanda cocok untuk Editor Agent. | `scr.providers.assign.agent` toggle "Brainstorming Agent \| Editor Agent" over the model table `scr.providers.models` (label, context "200K", "$ / 1M in · out" or "Free", JSON / Tools / Image badges; the Editor Agent's JSON chip on); `scr.providers.budget.month` "Monthly budget (optional)" / "Anggaran bulanan (opsional)" default empty, hint "We warn at 80 % and stop at the limit" / "Kami memperingatkan pada 80 % dan berhenti di batas"; `scr.providers.test` "Test both" / "Uji keduanya" → "Test passed" / "Tes berhasil" | Shown only if ONB-3 completed; "Use defaults" / "Pakai bawaan" skips the test | Model Assignments, budget |
| ONB-5 | `scr.onboarding.hardware` | Checking your PC / Memeriksa PC kamu | Safe defaults for this PC. Nothing to fix. / Bawaan aman untuk PC ini. Tidak ada yang perlu diperbaiki. | Read-only card: "Tier {tier} · {ram} GB RAM · GPU: {gpu}" and the consequence line: T0 "Standard profile · exports up to 1080p · effects run slower" / "Profil Standard · ekspor hingga 1080p · efek berjalan lebih lambat"; T1 "Accelerated available · up to 2160p with a warning" / "Accelerated tersedia · hingga 2160p dengan peringatan"; T2 "Turbo available · all presets" / "Turbo tersedia · semua preset". Warning if RAM < 8 GB (USER_FLOWS.md F1.E5). Note "Hardware Monitor: header, any time" / "Monitor Perangkat Keras: di header, kapan saja" | "Next" only (nothing to decide); never auto-advances (A11Y: no timed steps) | `hardware_profiles` row |
| ONB-6 | `scr.onboarding.tour` → `scr.onboarding.done` | Take the two-minute tour? / Ikuti tur dua menit? | A sample project and the six things you use most. Re-run from Help. / Proyek contoh dan enam hal yang paling sering dipakai. Ulangi dari Help. | Primary "Start tour" / "Mulai tur"; ghost "Skip, open an empty project" / "Lewati, buka proyek kosong" | Skip → empty project with nudges (§4) | `onboarding.completed`, `tour.completed` |

Behaviour notes:

| Topic | Rule |
|---|---|
| Resume | If the app closes mid-wizard, it resumes at the last incomplete step with saved values (except the API key field, which is re-requested unless already validated and stored). |
| Private Mode | Not offered in the wizard (it would block ONB-3); the tour step TOUR-7 introduces it. |
| Re-run | File ▸ (none). The wizard itself is not re-runnable; its pieces are: Licence (`hdr.action.license` → Manage licence), Providers (`agent.chat.model`), Hardware (`hdr.action.hardware`), Tour (`hdr.menu.help.tour`). |
| Sample project for the tour | "Sample · Kafe Senja" / "Contoh · Kafe Senja": three bundled 5 s clips (CC0), one SRT, Theme `preset:palette.editorial-dark`; created only when the tour starts; deleted when the Creator creates or opens another project unless they chose "Keep the sample project" on the closing card (it then becomes an ordinary project named "Kafe Senja") or saved it under a new name. |
| Sample implementation | Created by API R-025 `POST /projects/sample` (idempotent; `isSample: true` in `ProjectDto`; hard-deleted by the Service when R-011 creates or R-016 opens another project; Save As keeps a normal copy). "Keep the sample project" sends R-014 `PATCH /projects/:id {isSample:false}`: `is_sample = 0`, the "Contoh · " / "Sample · " marker is dropped from the name ("Kafe Senja", " (2)" if taken), and the project stays in Recent and Open like any other; "Start my own project", End tour and Esc leave it a sample, so it is removed on the next new or opened project. Media: `resources/sample/` (three 5 s 1280×720 clips and `kafe-senja.srt`, CC0 1.0, rendered by our own Engine) built by `packages/engine/scripts/build-sample.mjs` and shipped as `extraResources` `sample/`. |

## 3. In-app tour (8 steps)

Mechanics: spotlight overlay (scrim `--em-overlay`, 8 px rounded cut-out around the target with 8 px padding), a 320 px card anchored to the target (auto-flip), step counter "n / 8", buttons Back / Next (or the "next trigger" action), "End tour" ghost. Keyboard: Enter = Next, Esc = skip: the tour ends at once at any step, without a confirmation (FR-149; Help ▸ Tour re-runs it). Each step waits for the **next trigger** (a real action) or Next; triggers are preferred so the Creator learns by doing. Reduced motion: no spotlight animation.

| Step | Target element id | Title EN / ID | Body EN / ID | Next trigger |
|---|---|---|---|---|
| TOUR-1 | `hdr.menu.design` (whole menu row highlighted, Design emphasised) | Three places to work / Tiga tempat bekerja | **Home** is text, **Design** is looks, **Tools** is generators. The left panel changes with each. / **Beranda** untuk teks, **Desain** untuk tampilan, **Alat** untuk generator. Panel kiri berubah mengikutinya. | Click `hdr.menu.design` (or Next) |
| TOUR-2 | `lib.assets.panel` (sample clips already inserted) | Your assets live here / Aset kamu ada di sini | Drop clips, images and audio here. Number them with the badges, then press Insert to put them in the timeline. The sample's three clips are already in. / Letakkan klip, gambar, dan audio di sini. Beri nomor lewat lencana, lalu tekan Sisipkan untuk memasukkannya ke lini masa. Tiga klip contoh sudah masuk. | Next |
| TOUR-3 | `lib.catalogue.card` (first transition, Fade); the receipt appears in `agent.editor.intentqueue.item` | Preview, pick, keep a receipt / Lihat, pilih, simpan tanda terima | Hover a card to try it on your video in the player; click to pick it. Each pick lands in the Intent Queue as a receipt: simple picks apply directly with no AI, and a second pick strikes the old one through instead of losing it. / Arahkan kursor ke kartu untuk mencobanya di video kamu pada player; klik untuk memilihnya. Tiap pilihan masuk ke Intent Queue sebagai tanda terima: pilihan sederhana langsung diterapkan tanpa AI, dan pilihan kedua mencoret yang lama, bukan menghilangkannya. | Click the card → the pick is applied directly (Compile) |
| TOUR-4 | `stage.timeline` | Everything on the timeline / Semua ada di lini masa | Each lane is a track: video, overlay, text, captions, audio. Click any element to inspect it; your next picks then apply to it. / Tiap jalur adalah trek: video, lapisan, teks, caption, audio. Klik elemen mana pun untuk melihat rinciannya; pilihan berikutnya berlaku untuknya. | Click a `stage.timeline.element` or Next |
| TOUR-5 | `agent.chat.composer` | Think out loud here / Berpikir keras di sini | The Brainstorming Agent helps with ideas and structure. It never changes your video; it proposes, and you decide what to send on. Try: "judul pembuka yang energik". / Brainstorming Agent membantu ide dan struktur. Ia tidak pernah mengubah video kamu; ia mengusulkan, kamu yang memutuskan apa yang dikirim. Coba: "judul pembuka yang energik". | Send a message (if a provider is configured) or Next. Without a provider: body gains "Connect a provider from the Model Bar to try this." / "Hubungkan penyedia dari Model Bar untuk mencobanya." |
| TOUR-6 | `agent.editor.plancard` (a prepared sample plan is shown if the agent is unavailable: "Add title 'Kafe Senja' 0–3 s · Rise motion") | Nothing changes until Execute / Tidak ada yang berubah sampai kamu menekan Jalankan | The Editor Agent turns requests into a plan: steps, what will change, and any risks. Read it, add a note if you like, then press Execute. Only then does the video change, and you can undo it. / Editor Agent mengubah permintaan menjadi rencana: langkah, apa yang berubah, dan risikonya. Baca, tambahkan catatan jika mau, lalu tekan Jalankan. Baru saat itu video berubah, dan kamu bisa membatalkannya. | Press `agent.editor.execute` → version created; toast with Undo highlighted for 3 s |
| TOUR-7 | `agent.output` (whole Output Settings block, incl. `agent.output.private`) | Shape, size, speed, privacy / Bentuk, ukuran, kecepatan, privasi | Pick the platform shape (width:height) and resolution; the exact pixels are shown. Performance profiles change how much of your PC is used, never the video. Private Mode here stops every internet connection; editing and export keep working. / Pilih bentuk platform (lebar:tinggi) dan resolusi; piksel pastinya ditampilkan. Profil performa mengatur seberapa banyak PC kamu dipakai, bukan videonya. Mode Privat di sini menghentikan semua koneksi internet; penyuntingan dan ekspor tetap berjalan. | Click any ratio (applied directly) or Next; if Private Mode is on, the step adds "Switch Private Mode off to keep using the agents in this tour." / "Matikan Mode Privat agar tetap bisa memakai agen di tur ini." |
| TOUR-8 | `hdr.action.export` | Export when you are ready / Ekspor saat siap | Export checks disk, memory and size first, then renders on this PC with progress and cancel. Your file lands in the project's output folder. / Ekspor memeriksa disk, memori, dan ukuran dulu, lalu merender di PC ini dengan progres dan tombol batal. Berkas kamu tersimpan di folder keluaran proyek. | Click Export → `scr.export` opens with preflight; tour ends with the closing card below (export itself is not forced) |

FR-149 coverage: Header (TOUR-1, TOUR-8), Library Panel (TOUR-3), Asset Panel (TOUR-2), Stage (TOUR-4), Agent Panel (TOUR-5, TOUR-6), Output Settings (TOUR-7). Compared with the earlier 10-step draft, "Every pick is a receipt" is now part of TOUR-3 and "Private Mode" part of TOUR-7.

Closing card (`tour.done`): "That is the whole loop: insert, pick, describe, Execute, export. Help ▸ Tour brings this back any time." / "Itulah seluruh alurnya: sisipkan, pilih, jelaskan, Execute, ekspor. Help ▸ Tur mengembalikan ini kapan saja." Buttons: "Keep the sample project" / "Simpan proyek contoh" (ends the tour and keeps the sample as an ordinary project "Kafe Senja" via R-014 `isSample:false`; the header's sample marker disappears and it is no longer deleted when another project is created or opened) · "Start my own project" / "Mulai proyek saya sendiri" (→ `scr.project.new`; the sample stays a sample and is removed when the new project is created).

Tour rules:

| Rule | Detail |
|---|---|
| Re-run | `hdr.menu.help.tour` → "Re-run the tour on this project or the sample?" / "Ulangi tur di proyek ini atau proyek contoh?" If the current project lacks a Clip, the sample is used so TOUR-3/4 have targets. |
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
| NUDGE-3 | `stage.timeline.empty` | No Clip | Insert assets, then your picks and the Editor Agent fill this timeline. / Sisipkan aset, lalu pilihan kamu dan Editor Agent mengisi lini masa ini. | — |
| NUDGE-4 | hint card at top of `lib.catalogue` | First Clip inserted, Design mode never opened | Hover a look to try it on your video; click to pick it. / Arahkan ke sebuah tampilan untuk mencobanya di video kamu; klik untuk memilihnya. | "Open Design" / "Buka Design" |
| NUDGE-5 | `agent.editor.intentqueue` empty | No intents yet | Your picks and requests appear here. Simple picks apply directly; the rest become a plan you approve. / Pilihan dan permintaan kamu muncul di sini. Pilihan sederhana langsung diterapkan; sisanya menjadi rencana yang kamu setujui. | — |
| NUDGE-6 | `agent.chat.model` | Provider skipped in ONB-3; shown on first visit to the Agent Panel | Connect an AI provider to use the agents. Picks and export work without one. / Hubungkan penyedia AI untuk memakai agen. Pilihan dan ekspor tetap berjalan tanpanya. | "Connect" / "Hubungkan" |
| NUDGE-7 | first Plan Card | First plan ever | Read the steps and risks. Nothing changes until you press Execute, and you can undo it after. / Baca langkah dan risikonya. Tidak ada yang berubah sampai kamu menekan Execute, dan kamu bisa membatalkannya setelahnya. | Highlights `agent.editor.execute` |
| NUDGE-8 | — (retired 2026-10-25) | — | Trial Mode no longer exists, so there is no trial export nudge. | — |

Nudges are suppressed while the tour is running and while `sys.offline` or a modal is shown.

## 5. Success moments

| Moment | Where | Copy EN / ID | Actions |
|---|---|---|---|
| First Insert | `sys.toast` success | Your clips are in. Now pick a look in Design, or ask the Brainstorming Agent. / Klip kamu sudah masuk. Sekarang pilih tampilan di Design, atau tanya Brainstorming Agent. | "Open Design" / "Buka Design" |
| First Execute | Plan Card badge + toast | Applied · version {v}. Undo is always one step away. / Diterapkan · versi {v}. Batalkan selalu satu langkah saja. | "Undo" / "Batalkan" |
| **First export** (`scr.export.done`, first ever on this installation) | Done phase of the Export dialog, `t-display` title | Your first video is ready. / Video pertama kamu sudah jadi. · Body: "{filename} · {duration} · {w}×{h} · {size}. It was rendered on this PC; nothing was uploaded." / "{filename} · {duration} · {w}×{h} · {size}. Dirender di PC ini; tidak ada yang diunggah." | "Open folder" / "Buka folder" (primary) · "Export another size" / "Ekspor ukuran lain" (reopens setup with the next common ratio suggested: 9:16 → 1:1) |
| First export (later ones) | Standard done phase | Export complete. / Ekspor selesai. | as UI_UX_SPECIFICATION.md §8 |
| First recovery | `scr.project.recover` after Restore | Recovered version {v}. Expertmotion checkpoints your work every few seconds. / Versi {v} dipulihkan. Expertmotion menyimpan checkpoint pekerjaan kamu tiap beberapa detik. | — |

Success moments use `--em-success` and the `check-circle-2` icon, no confetti, no sound (identity notes, UI_UX_SPECIFICATION.md §1.1). Reduced motion: no animation.

## 6. Verification

| Item | Criterion | Method |
|---|---|---|
| Wizard completion time | ≤ 3 min median with provider; ≤ 1 min with "Skip setup" | UT round 5 (UXRD §8) |
| Tour duration | ≤ 2 min 30 s | UT |
| UX-001 | first export ≤ 10 min including wizard and tour | UT |
| UX-002 | Insert found without the tour by ≥ 4/5 | UT with tour skipped |
| UX-003 | Execute understood after TOUR-6 or NUDGE-7 | UT think-aloud |
| Strings | every `onb.*`, `tour.*`, `nudge.*` key present in `en.json` and `id.json`; no forbidden words | lint (I18N-01, I18N-03) |
| Targets | every tour target id exists in the DOM as `data-el` at that step | UI test |
| Resume | kill during ONB-3 → relaunch resumes at ONB-3 | UI test |
