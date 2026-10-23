# Business Requirements Document (BRD)

| Field | Value |
|---|---|
| Status | draft (for Operator review; prices and channel choices are Operator decisions) |
| Owner | Product/business analyst |
| Last updated | 2026-10-24 |
| Depends on | MASTER_PROJECT_PROMPT.md (§4.1, §4.3, §12, §17, §22), GLOSSARY.md, PRD.md, ASSESSMENT.md (§4, §5, §7, §10, §11), DECISIONS.md (ADR-004, 006, 007, 008, 009, 012, 014, 016, 017), RISKS_AND_ASSUMPTIONS.md, LICENSE_OPERATIONS.md |
| Used by | ROADMAP.md, STAGE_MANAGEMENT.md, LICENSE_OPERATIONS.md, DEPLOYMENT_AND_PACKAGING.md, SECURITY.md, THREAT_MODEL.md, LOCAL_AI_MODELS.md, TEST_PLAN.md, README.md |
| Owner of | business objectives and KPIs, business model, pricing inputs, cost structure, Remotion licence decision tree, **Licensing and compliance** (third-party licences, Creator-facing terms, legal/privacy obligations), go-to-market assumptions, stakeholder list |
| ID range | BRD-001 … BRD-099 |

Conventions: every requirement has a statement, rationale, priority (MoSCoW + P0/P1/P2 as defined in PRD.md), dependencies, acceptance criteria, verification method and status (`planned` until implemented and verified). Facts come from ASSESSMENT.md (URLs there, accessed 2026-10-24). Anything not confirmed against a primary source is marked **[UNVERIFIED]**. Monetary amounts in US$ are quoted from the source; Indonesian rupiah prices are the Operator's decision and are written as `IDR [Operator decision]`. User-facing strings carry an Indonesian variant (ADR-012).

## 1. Business context

| Item | Statement |
|---|---|
| Problem | Indonesian beginner creators and small businesses need animated, captioned short videos in several aspect ratios but cannot afford an editor or learn After Effects / Remotion (PRD §2). |
| Product | Expertmotion: a one-time-purchase Windows desktop application; local-first editing and rendering; AI agents using the Creator's own provider keys; local open-source generative Tools (PRD §1, ADR-001…017). |
| Operator | One person (Andre) who builds, signs, licences and supports the product (GLOSSARY "Operator"). |
| Why a desktop product and not SaaS | Zero per-user infrastructure and inference cost; Creator data stays local (brief §4.1); no accounts or servers to run (ADR-014). |
| Why Indonesia first | Persona "Septi" (PRD §2); the reference book "Remotion untuk Pemula" and its readership are an existing audience (ASSESSMENT §3); content generation is Indonesian/English from day one (ADR-012). |

## 2. Business objectives and KPIs

### 2.1 Objectives

| ID | Objective | Measured by |
|---|---|---|
| BO-1 | Ship a sellable, reliable v1.0 Windows release that a Creator can install and use without technical help | PRD §5 metrics; PRD §7 release criteria |
| BO-2 | Earn revenue with no marginal cost per Creator (no Operator-paid inference, no servers) | §4 cost structure; KPI "Operator variable cost per licence = 0" |
| BO-3 | Keep the support load within what one Operator can handle | KPIs K-05, K-06, K-07 |
| BO-4 | Launch legally clean: Remotion licence confirmed, third-party licences honoured, personal-data handling minimal | §5 decision tree, §6 compliance, BRD-010, BRD-020 |
| BO-5 | Build a defensible position through catalogue quality and the Indonesian-first experience rather than through secrecy (ADR-007 boundaries) | PRD §5 "Edit Plan validity", catalogue growth per release |

### 2.2 KPI table

Targets are for the first 6 months after v1.0. Product KPIs are the PRD §5 metrics; business KPIs are new here.

| KPI | Target | Source / method | Tied to |
|---|---|---|---|
| K-01 Time to first export for a new Creator | ≤ 10 min | PRD §5 (usability test, 5 participants) | BO-1 |
| K-02 Render success rate on reference hardware | ≥ 98 % | PRD §5 (QA render matrix) | BO-1 |
| K-03 Crash-free sessions | ≥ 99 % | PRD §5 (local diagnostics logs voluntarily shared in beta; no telemetry) | BO-1, BO-3 |
| K-04 Agent cost per typical 60 s project (paid by the Creator) | ≤ US$0.10 with a mid-tier model | PRD §5 (Usage Records) | BO-2 |
| K-05 Support tickets per 100 active licences per month | ≤ 10 | Operator support mailbox log | BO-3 |
| K-06 "Licence not accepted" tickets as share of activations | ≤ 2 % | LICENSE_OPERATIONS.md audit log vs tickets | BO-3 |
| K-07 Licence issuance turnaround (payment confirmed → key delivered) | ≤ 24 h (manual process at launch) | audit log CSV timestamps | BO-3 |
| K-08 Trial → paid conversion | `[Operator decision]`; proposed planning value 5 % **[ASSUMPTION]** | installer downloads (store/landing analytics, not in-app) vs licences issued | BO-2 |
| K-09 Refund rate | ≤ 5 % of licences within the refund window | audit log | BO-2, BO-3 |
| K-10 Operator variable cost per licence sold | US$0 (excluding payment-gateway fee) | §4 | BO-2 |
| K-11 Legal readiness at launch | Remotion written confirmation on file; Third-Party Notices complete; ToS and privacy notice published (EN/ID) | checklist BRD-010, BRD-020, BRD-022 | BO-4 |

No telemetry is sent to the Operator (PRD §4.4). Every KPI above is measured outside the app (sales records, support mailbox, voluntary diagnostics bundles, moderated tests). This is a deliberate trade: less data, no privacy exposure (RISK-023).

## 3. Business model

### 3.1 Offer

| Element | Decision | Status |
|---|---|---|
| Licence type | One-time, perpetual Licence Key bound to one Machine Fingerprint (ADR-014); the Creator keeps using every build released up to `updatesUntil` forever | proposed, aligns with ADR-014 |
| Updates | 12 months of updates included (`updatesUntil = issuedAt + 12 months`); after that, the installed build keeps working; newer builds require an update renewal (new Licence Key with a later `updatesUntil`) | proposed |
| Tiers | `standard` (sold at launch): all features, one computer. `pro` (reserved in the token format, not sold at launch): candidate differentiators are a second computer, priority support and early access; it must never gate P0 functionality behind a higher tier (Trial Mode already defines the only functional restriction) | `pro` content = Operator decision |
| Trial Mode | Free, unlimited in time: full Editor, exports watermarked and capped at 720p (GLOSSARY "Trial Mode"; rules in LICENSE_OPERATIONS.md §7). A soft reminder appears after 14 days; the trial never expires functionally | Operator decision on the 14-day reminder |
| Re-bind | Creator may move the licence to another computer up to 3 times per rolling 12 months by requesting a new Licence Key (LICENSE_OPERATIONS.md §8) | proposed |
| Refunds | 14-day refund window for first purchase, provided the Licence Key is revoked (LICENSE_OPERATIONS.md §11) | Operator decision (consumer-law minimums **[UNVERIFIED]**, §7) |
| Payment | External storefront / payment gateway; the app contains only a "Buy" link to the Operator's store URL (no in-app payment) | Operator decision on provider |
| Accounts | None. The licence is a signed token; the Operator keeps an issuance ledger (audit log CSV) | ADR-014 |

### 3.2 Price (Operator decision)

| Input | Value / note |
|---|---|
| Launch price `standard` | `IDR [Operator decision]`. Inputs: Indonesian creator purchasing power, perceived value against subscription editors (which charge monthly), zero marginal cost, one-person support capacity (a higher price lowers ticket volume per rupiah) |
| Update renewal (after 12 months) | proposed 40–50 % of the current `standard` price; `IDR [Operator decision]` |
| Re-bind beyond 3/12 months | proposed small administrative fee or free at Operator discretion; `[Operator decision]` |
| `pro` | not priced; reserved |
| Currency and tax | IDR for Indonesian buyers; US$ for international buyers via a merchant-of-record storefront if chosen (fees **[UNVERIFIED]**, §7); PPN/VAT treatment of digital goods to be confirmed with an accountant **[UNVERIFIED]** |
| Launch discount for the book's readers | `[Operator decision]` (see §8) |

### 3.3 Revenue inputs (planning only, no forecast claimed)

Revenue = licences sold × net price (after gateway fee) + renewals × renewal price. The only variable costs are payment fees and the Operator's support time. Fixed costs are in §4. No figures are forecast in this document because no market data has been gathered yet (ASM-012 in RISKS_AND_ASSUMPTIONS.md).

## 4. Cost structure

| Cost | Who pays | Amount | Source / status |
|---|---|---|---|
| LLM inference for agents | Creator (own provider key; OpenRouter first, PRD-010) | ≈ US$0.10 per 60 s project with a mid-tier model (target, PRD §5) | Operator cost **US$0** |
| Local generative Tools (whisper.cpp, Piper/sherpa-onnx, stable-diffusion.cpp, ACE-Step) | Creator's hardware | 0 | ADR-009; weights hosted by third parties (Hugging Face) at no cost to the Operator; mirror cost only if the Operator chooses to host (RISK-013, RISK-024) |
| Remotion | Operator | US$0 while the Operator's company has ≤ 3 people; Company License for 4+ people: Automators US$0.01 per render, US$100/month minimum | ASSESSMENT §4; ADR-017; §5 below |
| Windows code-signing certificate (OV) | Operator | annual fee from a CA; Azure Artifact Signing (~US$9.99/month) is not available because of the country restriction (Indonesia not listed) | ASSESSMENT §5; exact OV price **[UNVERIFIED]**, typically a few hundred US$ per year **[UNVERIFIED]** |
| Build machine / CI | Operator | the current Linux dev server (1.9 GB RAM, no display) cannot build or run Electron; a Windows PC or paid Windows CI minutes are needed | ASSESSMENT §1, §10; RISK-015 |
| Storefront / payment gateway | Operator | percentage + fixed fee per transaction **[UNVERIFIED]** | §3.1 |
| Domain, landing page, support mailbox | Operator | small fixed annual cost | — |
| Support | Operator | time; KPI K-05 | BO-3 |
| macOS signing (P2, PRD-055) | Operator | Apple Developer Program US$99/year + notarization | plan Appendix; not in v1 |
| Remotion Store items (e.g. `cube` transition) | not purchased | excluded from the catalogue (DESIGN_CATALOGUE.md `licence:paid`) | — |

Result: the business has zero marginal cost per Creator except payment fees; all costs are fixed and small, which is what makes a one-time price viable for a one-person Operator.

## 5. Remotion licence decision tree

Facts (ASSESSMENT §4; https://www.remotion.pro/license, https://www.remotion.dev/docs/license/faq, https://www.remotion.dev/docs/licensing, accessed 2026-10-24): the Remotion License is free for individuals, companies of up to 3 people, non-profits and evaluation, with unlimited commercial use; companies of 4 or more need a Company License (Creators US$25/seat/month; Automators US$0.01 per successful render with a US$100/month minimum; Enterprise from US$500/month). A render is a successful video/audio/GIF/still/image-sequence output; previews do not count. End customers do not need a licence. Users may not bring their own Remotion code into the product; modified Remotion may not be resold. `@remotion/licensing` and the `licenseKey` option exist; usage reporting becomes mandatory in v5.

```
Is the Operator's company (everyone who works on Expertmotion) ≤ 3 people?
├─ yes → Free licence. No key, no reporting required on v4.
│        Keep: Player `acknowledgeRemotionLicense`, notices in About, no user-supplied Remotion code (ADR-001).
│        Still required before commercial launch: written confirmation from Remotion (BRD-010), because
│        "renders executed on the Creator's own PC by a sold desktop editor" is not described in public docs.
└─ no (4+ people) → Company License required.
         ├─ Which plan? The product is an editor/"prompt-to-video" app → Automators (US$0.01/render, US$100/month minimum).
         ├─ How are renders on the Creator's PC counted and reported?  UNDEFINED publicly → ask Remotion (BRD-010).
         │     Possible answers to prepare for: (a) count via `@remotion/licensing` reports from each install;
         │     (b) self-declared estimate; (c) per-seat Creators plan instead. Each has a Private Mode consequence.
         └─ Engine passes `licenseKey` (ADR-017); Private Mode conflict handled per BRD-012.
Remotion v5 (mandatory telemetry) → open question regardless of company size: BRD-012.
```

Operating rule: stay on the free path, re-evaluate the headcount question at every Roadmap Stage gate (RISKS_AND_ASSUMPTIONS.md §5), and treat any contractor who contributes code as a "person" for this count until Remotion confirms otherwise **[UNVERIFIED interpretation]**.

## 6. Licensing and compliance

This is the `LICENSING_AND_COMPLIANCE` section referenced by ADR-009.

### 6.1 Engine Binaries and the GPL-3 phonemizer in the TTS engine

| Component | Licence | Handling |
|---|---|---|
| sherpa-onnx (`sherpa-onnx-offline-tts`, runs the Piper VITS voices and Kokoro; ADR-009) | Apache-2.0 | ship as a separate Engine Binary; notice |
| espeak-ng phonemizer (library + `espeak-ng-data`) inside the sherpa-onnx TTS binary | **GPL-3.0-or-later** | this is the GPL component Expertmotion actually ships: run only as a **separate process** (files in / files out, LOCAL_AI_MODELS.md §3.4); never linked into Expertmotion code; include the GPL-3 text and a **written offer of the corresponding source** in Third-Party Notices; the aggregate/mere-aggregation position is **[UNVERIFIED legal position; counsel review before launch]** |
| Piper engine (`piper1-gpl`) | GPL-3 | **not shipped in MVP** (ADR-009; voices run on sherpa-onnx). If ever adopted: same separate-process handling, unmodified binary, GPL-3 text and source offer as the row above |
| Piper voice `id_ID-news_tts-medium` | repository labelled MIT on Hugging Face; the voice card cites a training dataset of unclear licence **[UNVERIFIED]** (RISK-002) | LOCAL_AI_MODELS.md §2.2 must record the dataset licence before the voice is offered in the Model Manager |
| whisper.cpp + ggml Whisper weights | MIT (engine), MIT (OpenAI weights) | notice |
| stable-diffusion.cpp | MIT | notice |
| ACE-Step runtime (embedded Python, PyTorch) | Python PSF, PyTorch BSD-3, ACE-Step Apache-2.0 | notices; downloaded on demand (ADR-008) |

### 6.2 Model licences (decision table; registry details in LOCAL_AI_MODELS.md)

| Model | Task | Licence | Commercial use in Expertmotion | Decision |
|---|---|---|---|---|
| ACE-Step 1.5 | music | Apache-2.0 | yes | allowed (P2, T1/T2) |
| FLUX.1-schnell | image | Apache-2.0 | yes | allowed (T2 default) |
| Kokoro-82M | TTS (EN) | Apache-2.0 | yes | allowed (English only) |
| Whisper large-v3 / medium / small (ggml) | STT | MIT | yes | allowed |
| Stable Audio Open | music | Stability AI Community License (free below US$1M annual revenue; registration terms apply) | yes while under the revenue threshold; Operator must track revenue and terms | allowed as alternative; re-check terms annually **[UNVERIFIED threshold details]** |
| Stable Diffusion 1.5 | image | CreativeML OpenRAIL-M | yes with use-based restrictions that must be passed on to Creators | allowed (T0/T1 default); restrictions summarised in ToS §6.5 |
| SDXL-Turbo | image | to re-check (Community License?) | unknown | **[UNVERIFIED]** — excluded until verified |
| Piper `id_ID-news_tts-medium` | TTS (ID) | voice card **[UNVERIFIED]** | pending | allowed only after LOCAL_AI_MODELS.md records the licence |
| MusicGen | music | CC-BY-NC-4.0 | no | **excluded** |
| XTTS-v2 | TTS | Coqui Public Model License (non-commercial) | no | **excluded** |
| F5-TTS | TTS | CC-BY-NC-4.0 | no | **excluded** |
| Fish/OpenAudio S1, OmniVoice | TTS | non-commercial | no | **excluded** |

Rule: the Model Manager shows the licence name for every Local Model (GLOSSARY "Model Manager"); only models with a verified, commercially usable licence appear in the registry (BRD-021).

### 6.3 Fonts

Bundled fonts are limited to SIL Open Font License 1.1 families (OFL permits bundling and commercial use; the Reserved Font Name rule forbids renaming). Each font's OFL text ships in Third-Party Notices. `@remotion/google-fonts` is not used at runtime (fonts are local, PERFORMANCE §8).

### 6.4 Framework and library licences

| Component | Licence | Obligation |
|---|---|---|
| Remotion (`remotion`, `@remotion/*`) | Remotion License (source-available; free tier conditions in §5) | notice in About; `acknowledgeRemotionLicense` in the Player; no user-supplied Remotion code; written confirmation (BRD-010) |
| Electron | MIT | notice |
| Chromium (inside Electron and Chrome Headless Shell) | BSD-3-Clause plus many third-party licences (Electron ships `LICENSES.chromium.html`) | ship that file in Third-Party Notices |
| Chrome Headless Shell (downloaded by Remotion) | Chromium licences as above **[UNVERIFIED packaging terms for redistribution inside an installer]** | confirm redistribution terms with the Remotion confirmation request (BRD-010) |
| FFmpeg, Remotion slim build (`@remotion/compositor-win32-x64-msvc`, output only) | LGPL-2.1+ or GPL-2+ depending on Remotion's build flags **[UNVERIFIED which configuration Remotion ships]** | notice; if GPL build, same separate-process handling as §6.1 (it already is a separate process) |
| FFmpeg, Expertmotion full build for ingestion (`resources/bin/ffmpeg-full/`) | **LGPL-2.1+** (LGPL-configured: no `--enable-gpl`, no `--enable-nonfree`, hence no libx264 unless the §6.1 GPL handling is accepted for it) | notice with exact build flags, source URL and sha256 (DEPLOYMENT_AND_PACKAGING.md B4, ASSET_INGESTION.md §3) |
| Node.js (inside Electron) | MIT + bundled third-party notices | notice |
| React, Vite, Tailwind, Zod, Express, Vercel AI SDK, `systeminformation` | MIT | notice |
| `better-sqlite3-multiple-ciphers`, SQLite3MultipleCiphers | MIT; SQLite public domain | notice |
| libsodium or `@noble/ed25519` (licence verification) | ISC / MIT | notice |
| Catalogue preview loops, sample media, icons | produced by the Operator or CC0 **[ASSUMPTION]** | record provenance in DESIGN_CATALOGUE.md |

Third-Party Notices are generated at build time from the lockfile (licence checker in CI) and shown under `scr.about` (ELEMENT_IDS.md); hand-maintained entries cover binaries that are not npm packages (Engine Binaries, Chrome Headless Shell, FFmpeg, fonts, models).

### 6.5 Creator-facing terms (points the Terms of Service and Privacy Notice must contain)

| # | Point (EN) | Variant (ID) |
|---|---|---|
| T-1 | Expertmotion runs on your computer. Your projects, media and renders stay on your computer unless you move them. | Expertmotion berjalan di komputer Anda. Proyek, media, dan hasil render tetap berada di komputer Anda kecuali Anda memindahkannya. |
| T-2 | When you connect an AI provider, the text you type, your Intent Queue and a summary of your project are sent to that provider under your own account and key. Expertmotion never sends them anywhere else. | Saat Anda menghubungkan penyedia AI, teks yang Anda ketik, Intent Queue, dan ringkasan proyek dikirim ke penyedia tersebut dengan akun dan kunci Anda sendiri. Expertmotion tidak pernah mengirimnya ke tempat lain. |
| T-3 | Provider fees are billed by the provider to you. Expertmotion shows approximate usage but does not control provider pricing. | Biaya penyedia ditagih oleh penyedia kepada Anda. Expertmotion menampilkan perkiraan pemakaian tetapi tidak mengendalikan harga penyedia. |
| T-4 | Expertmotion sends no telemetry or analytics to the maker. Private Mode blocks every outbound connection. | Expertmotion tidak mengirim telemetri atau analitik kepada pembuatnya. Private Mode memblokir semua koneksi keluar. |
| T-5 | Local AI models are downloaded on first use from their publishers; each model has its own licence shown in the Model Manager. Some models (for example Stable Diffusion 1.5) forbid specific uses such as generating unlawful or harmful content. | Model AI lokal diunduh saat pertama digunakan dari penerbitnya; setiap model memiliki lisensi sendiri yang ditampilkan di Model Manager. Beberapa model (misalnya Stable Diffusion 1.5) melarang penggunaan tertentu seperti membuat konten melanggar hukum atau berbahaya. |
| T-6 | Your Licence Key is bound to one computer. You can move it up to three times in twelve months by requesting a new key. | Licence Key Anda terikat pada satu komputer. Anda dapat memindahkannya hingga tiga kali dalam dua belas bulan dengan meminta kunci baru. |
| T-7 | The licence is perpetual for all versions released before your update date. Later versions need an update renewal. | Lisensi berlaku selamanya untuk semua versi yang dirilis sebelum tanggal pembaruan Anda. Versi setelahnya memerlukan perpanjangan pembaruan. |
| T-8 | Trial Mode is free without time limit; exports carry a watermark and are capped at 720p. | Trial Mode gratis tanpa batas waktu; hasil ekspor diberi watermark dan dibatasi 720p. |
| T-9 | You own the videos you create. Expertmotion claims no rights to your content. | Video yang Anda buat adalah milik Anda. Expertmotion tidak mengklaim hak apa pun atas konten Anda. |
| T-10 | The maker stores only what is needed to issue your licence: your name, your email address and your computer's Machine Code. See the Privacy Notice. | Pembuat hanya menyimpan yang diperlukan untuk menerbitkan lisensi Anda: nama, alamat email, dan Machine Code komputer Anda. Lihat Pemberitahuan Privasi. |
| T-11 | Encryption of your project database protects it from other users and stolen disks, not from an administrator of your own computer. | Enkripsi basis data proyek melindunginya dari pengguna lain dan disk yang dicuri, bukan dari administrator komputer Anda sendiri. |
| T-12 | Refunds: within 14 days of first purchase, after the key is revoked. | Pengembalian dana: dalam 14 hari sejak pembelian pertama, setelah kunci dicabut. |

## 7. Legal and privacy obligations (high level; counsel review required before launch)

| Area | Obligation (high level) | Status |
|---|---|---|
| Indonesian personal data protection | Indonesia's Personal Data Protection Law (UU PDP, Law No. 27 of 2022) applies to the Operator as a controller of Creator names, email addresses and Machine Codes collected for licensing. Minimum practice: lawful basis (contract), purpose limitation (licensing and support only), retention policy, right to deletion on request, breach handling, and a published Privacy Notice (EN/ID). | specifics (deadlines, registration, DPO thresholds, cross-border rules) **[UNVERIFIED]** |
| Consumer protection and electronic transactions | Indonesian consumer protection (UU 8/1999) and electronic information and transactions law (UU ITE) obligations for clear terms, refund handling and electronic contracts | **[UNVERIFIED]** — counsel to confirm applicable articles |
| Tax | PPN/VAT on digital goods and income tax on sales; merchant-of-record storefronts may collect tax on the Operator's behalf | **[UNVERIFIED]** — accountant |
| Export of the Creator's data to providers | Disclosed in ToS T-2; the Operator is not the controller for provider processing (the Creator contracts with the provider) | position **[UNVERIFIED]** |
| Trademark | "Expertmotion" name and logo availability in Indonesia and key markets | not checked **[UNVERIFIED]**; RISK-025 |
| Open-source compliance | §6; Third-Party Notices; GPL source offer | planned (BRD-020) |
| Remotion licence | §5; BRD-010 | open (ADR-017) |

Privacy by design is already in the product decisions: no accounts, no telemetry (PRD §4.4), hashed email in the Licence Key (LICENSE_OPERATIONS.md §3), Machine Code derived from salted hashes so raw hardware identifiers never leave the computer, Private Mode (PRD-020).

## 8. Go-to-market assumptions

| # | Assumption | Basis | Risk |
|---|---|---|---|
| G-1 | Indonesian creators (persona Septi) are the first market; English-speaking creators second via the English UI (ADR-012) | PRD §2 | RISK-023 (language expectations), ASM-008 |
| G-2 | The reference book "Remotion untuk Pemula" (Septianus Angga, "Experthinker") and its readers are a launch channel; the author is assumed to be a channel partner **[ASSUMPTION, Operator to confirm]** | ASSESSMENT §3 | partner terms undefined |
| G-3 | Distribution is a direct download from the Operator's landing page plus a storefront link; no app store at launch | §3.1 | SmartScreen reputation on an unknown OV-signed installer (RISK-004) |
| G-4 | Trial Mode is the main acquisition tool; the watermark is the main conversion trigger | §3.1 | low conversion (K-08) |
| G-5 | Launch content: a 10-minute Indonesian walkthrough video and three Golden Scenario templates | GOLDEN_SCENARIOS.md | — |
| G-6 | Support channel: email only at launch; FAQ page in EN/ID; response within 2 business days | BO-3 | RISK-016, RISK-026 |
| G-7 | Pricing in IDR for Indonesian buyers | §3.2 | payment gateway choice |
| G-8 | No paid advertising until K-02 and K-03 are met in beta | BO-1 | — |

## 9. Stakeholders

| Stakeholder | Role | Interest | Interaction |
|---|---|---|---|
| Operator (Andre) | builds, signs, licences, supports; owns the private signing key and the licence private key | revenue, low support load, legal safety | all decisions marked `[Operator decision]` |
| Creator (persona Septi; small business owner) | buyer and user | fast results, honest pricing, privacy, offline use | Trial Mode, ToS, support |
| Remotion (remotion.dev / remotion.pro) | licensor of the Engine | licence compliance, Company License revenue if applicable | written confirmation request (BRD-010); possible Company License |
| Provider vendors (OpenRouter, OpenAI, Anthropic, Google) | LLM providers paid by the Creator | API terms, usage policies | the Creator's own account; the app follows their API terms (RISK-011) |
| Model publishers (OpenAI Whisper, Black Forest Labs, Stability AI, ACE-Step, Piper/rhasspy, sherpa-onnx) | licensors of Local Models and Engine Binaries | licence compliance, attribution | notices; registry (LOCAL_AI_MODELS.md) |
| Certificate authority | issues the OV code-signing certificate | identity validation | annual renewal |
| Storefront / payment gateway | collects payment | fees, chargebacks | manual issuance at launch |
| Channel partner (book author) | reaches the first audience | **[ASSUMPTION]** | G-2 |

## 10. Business requirements

Priority codes: MoSCoW (Must/Should/Could/Won't) and P0/P1/P2 (PRD.md). Status is `planned` for all rows.

| ID | Requirement | Rationale | Priority | Dependencies | Acceptance criteria | Verification | Status |
|---|---|---|---|---|---|---|---|
| BRD-001 | Expertmotion is sold as a one-time perpetual Licence Key bound to one Machine Fingerprint with 12 months of updates (`updatesUntil`), with no account and no licence server at launch | zero running cost, ADR-014, BO-2 | Must / P0 | ADR-014, LICENSE_OPERATIONS.md §3–§6 | A valid key activates offline; a key from another machine is refused with EM-5003; a build released after `updatesUntil` is refused with EM-5005 while earlier builds keep working | TEST_PLAN licence cases (LICENSE_OPERATIONS.md §15) | planned |
| BRD-002 | Trial Mode is available without registration, without time limit, with watermark and 720p cap as the only restrictions | acquisition (G-4), no accounts | Must / P0 | PRD-017, LICENSE_OPERATIONS.md §7 | Fresh install exports a 720p file with the watermark; every editor feature works; EM-5001 notice shown at export | clean-VM test | planned |
| BRD-003 | Operator variable cost per Creator is zero: no Operator-paid inference, no Operator-run servers; Creators use their own provider keys; generative Tools run locally | BO-2, brief §4.3 "never embed developer-owned API secrets" | Must / P0 | PRD-010, ADR-009 | Static scan of the build finds no Operator credentials; network capture shows outbound calls only to the Creator-configured provider, model hosts and the update feed | VULNERABILITY_CHECKLIST + network capture | planned |
| BRD-004 | The launch price, renewal price and `pro` tier definition are recorded as Operator decisions in this document before Stage 7 (Hardening and release) | release readiness | Must / P0 | §3.2 | §3.2 contains numbers, not placeholders; DECISIONS.md records the decision | document review at Stage 6 gate | planned |
| BRD-005 | The Purchase action in the Header (`hdr.action.purchase`) opens `scr.license`, which offers "Buy" (external store URL) and "I have a key" (activation) | conversion path (G-4) | Must / P0 | ELEMENT_IDS.md, LICENSE_OPERATIONS.md §16 | Clicking Buy opens the system browser at the configured store URL; the app never processes payment | UI test | planned |
| BRD-006 | Update renewals are sold as a new Licence Key with a later `updatesUntil` for the same `licenseId` and fingerprint | perpetual-fallback model | Should / P1 | BRD-001 | Renewal key replaces the old one; old key is listed in `revoked.json` with the new revocation epoch | LICENSE_OPERATIONS.md §9 | planned |
| BRD-007 | Re-bind to another computer is allowed 3 times per rolling 12 months without charge, via new key issuance | fairness, hardware changes | Should / P1 | LICENSE_OPERATIONS.md §8 | Audit log enforces the count; fourth request within 12 months requires Operator approval | runbook test | planned |
| BRD-008 | Refund within 14 days of first purchase after revocation of the key | consumer trust; legal minimums **[UNVERIFIED]** | Should / P0 | LICENSE_OPERATIONS.md §11 | Procedure documented and rehearsed once before launch | runbook rehearsal | planned |
| BRD-009 | Headcount rule: while the Operator's company has ≤ 3 people, Expertmotion uses Remotion under the free licence; the moment a fourth person joins, a Company License is purchased before the next release | §5 | Must / P0 | ADR-017 | Headcount reviewed at each Roadmap Stage gate and recorded in process.md | stage-gate checklist | planned |
| BRD-010 | **Launch blocker**: written confirmation from Remotion, on file, stating (a) that selling a desktop editor that renders on the Creator's PC is permitted under the free licence for a ≤ 3-person company, (b) how renders on end-user PCs are counted if a Company License becomes necessary, (c) how v5 mandatory reporting interacts with an offline/Private Mode product, and (d) that redistributing Chrome Headless Shell and FFmpeg inside the installer is permitted | ADR-017; PRD §7 criterion 4; RISK-001 | Must / P0 | §5 | A dated written answer from Remotion is stored in `docs/legal/` (path to be created) and summarised in DECISIONS.md; no commercial sale before it exists | document check at the Stage 7 gate | planned |
| BRD-011 | The Engine passes a Remotion `licenseKey` when, and only when, a Company License exists; the key is treated as a build-time secret of the Operator and is never shown to the Creator | ADR-017 | Should / P1 | BRD-009 | Build with the key: renders report per Remotion; build without: no key present | DEPLOYMENT_AND_PACKAGING.md build matrix | planned |
| BRD-012 | **Open question** (decide before adopting Remotion v5): if Remotion requires render telemetry, Expertmotion either stays on the last v4 release or discloses the telemetry in `scr.about` and ToS, gates it behind explicit consent, and documents what Private Mode does to it (block → render refused? or allowed with deferred reporting?) | PRD §4.4; brief §4.1 | Must / P1 | BRD-010 answer (c) | An ADR records the decision; no v5 upgrade without it | DECISIONS.md | planned |
| BRD-013 | No Operator-owned telemetry or analytics in the product; KPIs are measured outside the app | PRD §4.4, T-4 | Must / P0 | — | Network capture shows no connection to Operator infrastructure except the update feed and the Buy link opened in the browser | VULNERABILITY_CHECKLIST | planned |
| BRD-014 | Indonesian creators first: all generated content, errors, onboarding and tour copy exist in Indonesian from v1; English UI is acceptable for MVP | ADR-012; G-1 | Must / P0 | ACCESSIBILITY_AND_I18N.md | Traceability matrix "String → ID variant" complete | INDEX.md matrix | planned |
| BRD-015 | The installer is signed with an OV code-signing certificate held by the Operator; updates are signed and verified | SmartScreen reputation, trust, ADR-007 | Must / P0 | DEPLOYMENT_AND_PACKAGING.md | `signtool verify` passes on installer and updater artefacts; certificate renewal date is in process.md | packaging test | planned |
| BRD-016 | A Windows build machine or CI is available from Stage 2 (PoC) onwards; the Linux dev server is used only for headless parts | ASSESSMENT §10; RISK-015 | Must / P0 | ROADMAP.md | A Windows build of the PoC exists at the Stage 2 gate | stage-gate evidence | planned |
| BRD-017 | Remotion Store paid items (e.g. `cube`) and Elements with unclear terms are excluded from the shipped catalogue until their terms are verified | §6.4; cost control | Must / P0 | DESIGN_CATALOGUE.md | No `licence:paid` preset is implemented in the Engine | catalogue lint | planned |
| BRD-018 | Only models with a verified commercially usable licence are listed in the Model Manager; non-commercial models (MusicGen, XTTS-v2, F5-TTS, Fish/OpenAudio, OmniVoice) are excluded | §6.2 | Must / P1 | LOCAL_AI_MODELS.md | Registry entries carry licence name + URL + verification date; an automated check fails the build for entries without them | registry lint | planned |
| BRD-019 | GPL-3 components (the espeak-ng phonemizer inside the sherpa-onnx TTS binary; piper1-gpl if ever shipped) run as separate processes only; GPL text and a source offer are included in Third-Party Notices; no GPL code is linked into Expertmotion modules | §6.1; ADR-009 | Must / P1 | DEPLOYMENT_AND_PACKAGING.md | Dependency graph shows no GPL package in the bundled JavaScript; notices contain the offer | licence checker in CI | planned |
| BRD-020 | Third-Party Notices (npm licence report + hand-maintained binary/model/font entries) are generated per release and shown in `scr.about` | §6.3–§6.4 | Must / P0 | build pipeline | Every bundled binary, font and model appears with licence name and text | release checklist | planned |
| BRD-021 | The Model Manager shows the licence of every Local Model next to its size and tier | T-5; GLOSSARY "Model Manager" | Must / P1 | ELEMENT_IDS `scr.models.row` | Each row displays the licence name linking to the full text | UI test | planned |
| BRD-022 | Terms of Service and Privacy Notice (EN/ID) containing points T-1…T-12 are published on the landing page and linked from onboarding and `scr.about` before launch | §6.5, §7 | Must / P0 | counsel review | Documents exist, are linked, and the onboarding wizard requires acknowledgement | release checklist | planned |
| BRD-023 | Personal data collected for licensing is limited to name, email and Machine Code; retained in the audit log for the life of the licence plus 2 years **[Operator decision]**; deleted on request where the law allows | §7 UU PDP | Must / P0 | LICENSE_OPERATIONS.md §10 | Audit log columns match this list exactly; a deletion procedure is written | runbook review | planned |
| BRD-024 | The Operator obtains counsel review of ToS, Privacy Notice, GPL position and refund terms before commercial launch | §7 **[UNVERIFIED items]** | Should / P0 | BRD-022 | Review notes stored in `docs/legal/` | document check | planned |
| BRD-025 | Business KPIs K-05…K-11 are tracked in a simple spreadsheet maintained by the Operator and reviewed at each Stage gate after launch | BO-3 | Should / P1 | §2.2 | Spreadsheet exists with monthly rows | review | planned |
| BRD-026 | The `pro` tier is reserved in the Licence Key format but is not sold until its features are defined and never gates P0 functionality | §3.1 | Could / P2 | LICENSE_OPERATIONS.md §3 | Token schema accepts `pro`; UI shows "Pro" badge only; no feature check depends on it in v1 | code review | planned |
| BRD-027 | Trademark availability of "Expertmotion" is checked before the landing page goes live | §7 | Should / P0 | — | Search result recorded in `docs/legal/` | document check | planned |

## 11. Business risks (register in RISKS_AND_ASSUMPTIONS.md)

| Risk ID | Business impact summary | BRD requirements affected |
|---|---|---|
| RISK-001 | Remotion licence ambiguity for end-user renders and v5 telemetry could force a Company License (US$100/month minimum), a product change or a launch delay | BRD-009, BRD-010, BRD-011, BRD-012 |
| RISK-002 | Indonesian TTS quality may disappoint the primary market; the GPL-3 espeak-ng phonemizer adds compliance work; the `id_ID-news_tts-medium` voice card cites a dataset of unclear licence | BRD-018, BRD-019 |
| RISK-003 | Local music generation hardware needs limit the Tools story on T0 machines | BRD-018 |
| RISK-004 | Code-signing cost and SmartScreen warnings on an unknown OV certificate reduce conversion | BRD-015, K-08 |
| RISK-007 | Creator LLM cost surprises damage trust even though the Operator pays nothing | BRD-003, K-04 |
| RISK-008 | Code extraction and licence bypass via patched binary | BRD-001 (accepted boundary, ADR-007) |
| RISK-010 | Scope creep delays the P0 release | BRD-004, BRD-016 |
| RISK-015, RISK-016 | Dev-server limits and single-developer bus factor delay delivery and support | BRD-016, G-6 |
| RISK-021 | Licence private key compromise would invalidate all keys | LICENSE_OPERATIONS.md §10 |
| RISK-022 | Manual issuance and refunds do not scale and invite fraud/chargebacks | BRD-007, BRD-008, K-07 |
| RISK-023 | Indonesian PDP and consumer-law specifics unverified | BRD-022, BRD-023, BRD-024 |
| RISK-024 | Model licence or hosting changes remove a Tool after launch | BRD-018, BRD-021 |
| RISK-025 | Trademark conflict on the product name | BRD-027 |
| RISK-026 | Operator availability for manual licence issuance | K-07, G-6 |

## 12. Open Operator decisions collected in this document

| # | Decision | Where | Needed by |
|---|---|---|---|
| D-1 | Launch price, renewal price, re-bind fee | §3.2 | Stage 6 gate (BRD-004) |
| D-2 | Storefront / payment gateway (Indonesian gateway vs merchant of record) | §3.1 | Stage 6 |
| D-3 | 14-day soft reminder in Trial Mode: keep, change, or remove | §3.1; LICENSE_OPERATIONS.md §7 | Stage 4 |
| D-4 | `pro` tier content | §3.1 | post-launch |
| D-5 | Refund window and conditions (after counsel) | §3.1 | Stage 7 |
| D-6 | Audit-log retention period | BRD-023 | Stage 7 |
| D-7 | Channel partnership with the book author | §8 G-2 | Stage 6 |
| D-8 | Remotion v5 telemetry stance | BRD-012 | before any v5 upgrade |
