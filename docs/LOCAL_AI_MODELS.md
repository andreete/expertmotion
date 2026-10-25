# Local AI Models: registry, engines, Model Manager, download policy

| Field | Value |
|---|---|
| Status | baseline (licences and sizes checked on 2026-10-24; speed figures are estimates until POC-010/011 measure them) |
| Owner | ML engineer (Engine lead co-owns the Engine Binary packaging) |
| Last updated | 2026-10-24 |
| Depends on | GLOSSARY.md, DECISIONS.md (ADR-008, ADR-009, ADR-016), PERFORMANCE.md (Hardware Tiers), ARCHITECTURE.md (§3 Engine Binaries, §8 filesystem), AI_WORKFLOW.md §8 (tools), DESIGN_CATALOGUE.md (`model:<id>` flags), ASSESSMENT.md §7, MASTER_PROJECT_PROMPT.md §15 |
| Used by | Model Manager (`scr.models`), Generator Cards (`lib.generator.card.*`), DEPLOYMENT_AND_PACKAGING.md, BRD.md (compliance), THREAT_MODEL.md, TEST_PLAN.md, ERROR_CATALOGUE.md, RISKS_AND_ASSUMPTIONS.md |
| Owner of | the Local Model registry (ids, sources, hashes policy, licences, tiers), Engine Binary invocation contracts, Model Manager behaviour, the generator tool contracts (`captions.generate`, `tts.generate`, `music.generate`, `thumbnail.generate`), the embedded-Python plan and its fallback |

Scope: Local Models and Engine Binaries only. Social caption text and hashtag suggestions (`lib.generator.card.hashtags`) are produced by the Creator's connected LLM through the Provider Connection (ADR-009) and are **not** a Local Model; a small local LLM is a later option (§2.6). Priorities follow ADR-016: voice and captions P1, music and thumbnails P2.

Error codes `EM-6xxx` below are **proposed** for ERROR_CATALOGUE.md (which owns them).

---

## 1. Principles

1. **Engines are shipped, weights are downloaded** (ADR-008). Every Engine Binary is a prebuilt, Operator-signed executable inside the installer; every model is a Model Download with size, progress, resume and sha256 verification.
2. **Commercial-use licences only.** Every registry row names its licence by SPDX id or exact licence name and states whether Expertmotion may redistribute (host/mirror) the weights. Non-commercial models are excluded (§2.7) even when technically superior.
3. **One task, one process, files in, files out.** Engine Binaries never see the network, the database or the Composition Model (ARCHITECTURE.md §3 "must not").
4. **Hardware Tier decides defaults, never availability of the editor.** Insufficient hardware degrades to a smaller model or a non-AI fallback (§6); it never blocks editing or rendering.
5. **Indonesian first, English second**, judged on measured quality (§7), not vendor claims.

---

## 2. Registry

Column notes: "Redist." = may the Operator mirror the weights on an Operator-controlled host (yes/no/verify); sizes are the download size; RAM/VRAM are working-set estimates for one job; speed is wall-clock per unit of output on the PERFORMANCE.md reference machines (T0 = CPU i5/Ryzen 5, 16 GB; T1 = ≥ 4 GB VRAM; T2 = ≥ 8 GB VRAM) and is **an estimate until measured**; the `model:` flag is what DESIGN_CATALOGUE.md and the Catalogue Cards use.

### 2.1 Speech-to-text (captions) — engine `whisper.cpp`

| Model id | File (Hugging Face `ggerganov/whisper.cpp`) | Size | Languages | Indonesian quality | Licence | Redist. | RAM | Speed T0 / T1 / T2 (est.) | Status | Flag |
|---|---|---|---|---|---|---|---|---|---|---|
| `whisper-small` | `ggml-small.bin` (alt. `ggml-small-q5_1.bin`) | 488 MB (190 MB) | multilingual (id, en) | usable for clean speech; WER est. 20–30 % on CV-style Indonesian **[estimate]** | MIT (engine) + MIT (OpenAI weights) | yes | ≈ 1.0 GB | 1–2× realtime / 8× / 10× | P1 (T0 default) | `model:whisper` |
| `whisper-medium` | `ggml-medium.bin` (alt. `ggml-medium-q5_0.bin`) | 1.53 GB (539 MB) | multilingual | WER est. 12–18 % **[estimate]** | MIT + MIT | yes | ≈ 2.6 GB | 0.3–0.5× / 6× / 8× | P1 (T0 option) | `model:whisper` |
| `whisper-large-v3-turbo` | `ggml-large-v3-turbo.bin` (alt. `-q5_0.bin` 574 MB, `-q8_0.bin` 874 MB) | 1.62 GB | multilingual | close to large-v3; large-v3 Indonesian WER ≈ 7.4 % (Common Voice 17, ASSESSMENT.md §7); turbo est. 8–10 % **[estimate]** | MIT + MIT | yes | ≈ 2.5 GB (+ VRAM when GPU) | 0.2× / 10–15× / 20× | P1 (T1/T2 default) | `model:whisper` |
| `whisper-large-v3` | `ggml-large-v3.bin` | 3.1 GB | multilingual | best (≈ 7.4 % WER id) | MIT + MIT | yes | ≈ 4.7 GB | 0.1× / 4× / 8× | P2 (T2 "best quality" option) | `model:whisper` |

Sizes from https://huggingface.co/ggerganov/whisper.cpp/tree/main (2026-10-24). RAM figures approximate whisper.cpp's README memory table **[approximate]**. Word timestamps: `whisper-cli -ml 1 -sow` gives one word per segment with timings; token-level timestamps are marked experimental upstream, so the Caption sub-agent re-pages words with `createTikTokStyleCaptions` (REMOTION_CAPABILITY_MAP.md §D.5) rather than trusting sub-word timings.

### 2.2 Text-to-speech (voice) — engine `sherpa-onnx` (offline TTS)

| Model id | Source | Size | Language | Quality note | Licence | Redist. | RAM | Speed (est.) | Status | Flag |
|---|---|---|---|---|---|---|---|---|---|---|
| `piper-id-news-medium` | HF `rhasspy/piper-voices` → `id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx` + `.onnx.json` | 63 MB + 5 kB | Indonesian | "news reader" prosody; finetuned from `en_US-lessac-medium` (MODEL_CARD); the only offline Indonesian voice found (ASSESSMENT.md §7) | repo labelled MIT on HF; MODEL_CARD lists a Kaggle dataset URL ("indic-tts-malayalam-speech-corpus") with licence "See URL" → dataset licence **[UNVERIFIED]** | **verify** before mirroring; until then the Creator downloads from HF on first use | ≈ 300 MB | ≈ 0.1× realtime on T0 (10 s of speech in ≈ 1 s) | P1 (default id voice) | `model:piper-id` |
| `piper-en-lessac-medium` | `rhasspy/piper-voices` → `en/en_US/lessac/medium/en_US-lessac-medium.onnx` + `.json` | ≈ 63 MB **[size by analogy, UNVERIFIED]** | English (US) | neutral, clear | MIT label; dataset per its MODEL_CARD **[UNVERIFIED]** | verify | ≈ 300 MB | ≈ 0.1× realtime T0 | P1 (default en voice) | `model:piper-en` |
| `kokoro-82m-v1.0` | HF `onnx-community/Kokoro-82M-v1.0-ONNX` → `onnx/model.onnx` (326 MB) or `model_q8f16.onnx` (86 MB) + `voices/*.bin` | 86–326 MB | English (+ 7 other languages; **no Indonesian**) | markedly more natural than Piper for English | Apache-2.0 (model); training data stated as permissive/non-copyrighted (https://huggingface.co/hexgrad/Kokoro-82M) | yes | ≈ 600 MB | ≈ 0.3× realtime T0, faster with GPU | P2 (English upgrade voice) | `model:kokoro` |
| `espeak-ng-data` | shipped with the sherpa-onnx TTS Engine Binary (phonemiser data for Piper and Kokoro) | ≈ 15 MB | — | — | **GPL-3.0-or-later** (espeak-ng) | yes, under GPL terms | — | — | P1 (part of the engine) | — |

Engine: `sherpa-onnx` (Apache-2.0; k2-fsa; Windows x64 prebuilts; v2.0.0 released 2026-10-23 per https://github.com/k2-fsa/sherpa-onnx/releases) runs Piper VITS voices and Kokoro offline. `piper1-gpl` (OHF-Voice, GPL-3.0) is the alternative engine and is **not** shipped in MVP; §3.4 covers the GPL handling that applies to espeak-ng (and to piper1-gpl if ever adopted).

### 2.3 Music — engine: embedded Python (§9) or none

| Model id | Source | Size | Quality / limits | Licence | Redist. | VRAM / RAM | Speed (est.) | Status | Flag |
|---|---|---|---|---|---|---|---|---|---|
| `ace-step-v1-3.5b` | HF `ACE-Step/ACE-Step-v1-3.5B` (PyTorch, Diffusers) | ≈ 7 GB weights (3.5 B params, bf16) **[estimate]** + ≈ 3 GB Python/torch runtime | full tracks, 17 languages for lyrics; instrumental beds for Expertmotion | Apache-2.0 | yes | ≥ 4 GB VRAM with CPU offload (ASSESSMENT.md §7); ≥ 8 GB comfortable; CPU-only impractical | RTF 12.8× on RTX 3090, 2.3× on M2 Max (model card); T1 est. 30–90 s per 60 s bed, T2 est. 10–30 s **[estimate]** | P2 (T1/T2) | `model:ace-step` |
| `stable-audio-open-1.0` | HF `stabilityai/stable-audio-open-1.0` | ≈ 5 GB **[estimate]** | ≤ 47 s stereo 44.1 kHz per generation; sound effects and loops rather than songs | Stability AI Community License (free below US$1 M annual revenue; gated download, licence acceptance on HF) | **no** (gated; each Creator must accept) | ≥ 6 GB VRAM est. | T2 est. 20–40 s per clip **[estimate]** | P2 evaluate (alternative; licence is revenue-conditional, see BRD) | `model:stable-audio` |
| `loop-library-cc0` | curated royalty-free loops (§9.3) | ≈ 150 MB | rule-based arrangement; no generation | CC0-1.0 only | yes | — | instant | P2 (T0 default and universal fallback) | — |

### 2.4 Image / thumbnail — engine `stable-diffusion.cpp`

| Model id | Source | Size | Output | Licence | Redist. | VRAM / RAM | Speed (est.) | Status | Flag |
|---|---|---|---|---|---|---|---|---|---|
| `flux1-schnell-q4` | HF `city96/FLUX.1-schnell-gguf` → `flux1-schnell-Q4_0.gguf` (6.77 GB) + text encoders `clip_l.safetensors` (≈ 246 MB) and `t5xxl_fp8_e4m3fn.safetensors` (≈ 4.9 GB) + VAE `ae.safetensors` (335 MB) from `second-state/FLUX.1-schnell-GGUF` (byte-identical Apache-2.0 copy of the gated `black-forest-labs/FLUX.1-schnell` file, same sha256; no Hugging Face account needed) / `comfyanonymous/flux_text_encoders` **[encoder sizes approximate]** | ≈ 12 GB total | 1024² in 1–4 steps; strong text rendering (titles) | Apache-2.0 (FLUX.1-schnell and the GGUF repo) | yes | ≈ 8 GB VRAM with the Q4 transformer resident and T5 offloaded to CPU (`--clip-on-cpu`); ASSESSMENT.md's "≈ 6.5 GB" is optimistic (the Q4 file alone is 6.77 GB) → **T2 only** | T2 est. 10–30 s per image **[estimate]** | P2 (T2 default) | `model:flux-schnell` |
| `sd15-emaonly` | HF `stable-diffusion-v1-5/stable-diffusion-v1-5` → `v1-5-pruned-emaonly.safetensors` (≈ 4.3 GB fp32; ≈ 2.1 GB fp16 variant) **[size approximate]** | 2.1–4.3 GB | 512² in 20 steps; weak text rendering → titles are composited by Remotion (`renderStill`), never drawn by the model | CreativeML OpenRAIL-M (use-restriction licence; commercial use allowed; restrictions must be passed on, shown in the Model Manager licence sheet) | yes, with licence text | CPU 512² ≈ 2.3 GB RAM (ASSESSMENT.md §7); ≈ 3 GB VRAM on GPU | T0 est. 2–5 min; T1 est. 10–20 s; T2 est. 5–10 s **[estimate]** | P2 (T0/T1 default) | `model:sd15` |
| `frame-composite` | no model: `renderStill` of a chosen frame + title overlay | — | always available | — | — | — | ≈ 3 s | P2 (fallback and default when no model installed) | — |

Engine: `stable-diffusion.cpp` (MIT; https://github.com/leejet/stable-diffusion.cpp) with prebuilt Windows binaries (AVX2 CPU, CUDA 12, Vulkan variants on its releases page). Memory-reduction flags used: `--vae-tiling`, `--clip-on-cpu`, `--offload-to-cpu` (per its performance guide); `--diffusion-fa` where the backend supports it.

### 2.5 Summary of engines

| Engine Binary | Upstream | Licence | Variants shipped (Windows x64) | Approx. size | Tasks |
|---|---|---|---|---|---|
| `whisper-cli` | ggml-org/whisper.cpp v1.9.x line (release page shows v1.9.5 as latest; exact asset names **[UNVERIFIED]**) | MIT | CPU (AVX2) and Vulkan (GPU-vendor neutral; CUDA build skipped because CUDA runtime DLLs add ≈ 500 MB) | ≈ 15 MB + 20 MB | STT |
| `sherpa-onnx-offline-tts` | k2-fsa/sherpa-onnx v2.0.0 | Apache-2.0 (+ espeak-ng GPL-3.0-or-later data) | CPU (onnxruntime); GPU not needed for Piper/Kokoro | ≈ 40 MB | TTS |
| `sd` (stable-diffusion.cpp CLI) | leejet/stable-diffusion.cpp (rolling `master-*` releases; pin one commit) | MIT | AVX2 and Vulkan; CUDA 12 build optional download for T2 (≈ 300 MB with runtime) | ≈ 10 MB + 15 MB | image |
| embedded Python | python-build-standalone 3.11 + uv | PSF-2.0 / MIT (uv) / BSD-3 (torch) | on-demand download, not in the installer (§9) | ≈ 3 GB installed | music |

### 2.6 Later: small local LLM (not in registry yet)

If the Operator later wants hashtag/caption text without a Provider Connection: `llama.cpp` (MIT) `llama-cli`/`llama-server` with an Apache-2.0 instruct model ≤ 2 B parameters in GGUF Q4 (≈ 1 GB) with Indonesian support, evaluated on the §7 set. Candidate families to evaluate: Qwen2.5-1.5B-Instruct (Apache-2.0), SmolLM2 (Apache-2.0). Status: idea; no registry row until evaluated.

### 2.7 Excluded models and why

| Model | Reason | Source |
|---|---|---|
| MusicGen (Meta) | CC-BY-NC-4.0 weights: non-commercial | ASSESSMENT.md §7 |
| XTTS-v2 (Coqui) | Coqui Public Model License (CPML): non-commercial | ASSESSMENT.md §7 |
| F5-TTS | CC-BY-NC-4.0 weights (code MIT) | https://github.com/SWivid/F5-TTS |
| Fish Speech / OpenAudio S1 | CC-BY-NC-SA weights | ASSESSMENT.md §7 |
| OmniVoice | non-commercial terms | ASSESSMENT.md §7 |
| SDXL-Turbo | licence to re-check (Stability non-commercial research licence at release; Community License status **[UNVERIFIED]**) → excluded until confirmed | ASSESSMENT.md §7 |
| YuE | Apache-2.0 but too heavy for consumer GPUs | plan Appendix |
| Chatterbox (MIT), Qwen3-TTS (Apache-2.0), MeloTTS (MIT), Orpheus | permissive but **no Indonesian** and Python-only; watch list for an English upgrade or if Indonesian appears | ASSESSMENT.md §7 |
| `@remotion/install-whisper-cpp` | Windows prebuilt capped at whisper.cpp 1.6.0; compiles from source elsewhere | REMOTION_CAPABILITY_MAP.md §H |

---

## 3. Engine Binary packaging and sandboxing

### 3.1 Packaging rules

| Rule | Detail |
|---|---|
| Prebuilt, pinned, signed | each engine is pinned to an upstream release tag or commit in `packages/models/engines.json` (name, version, sha256 of the zip, licence id); binaries are re-signed with the Operator's code-signing certificate (DEPLOYMENT_AND_PACKAGING.md) so SmartScreen sees one publisher |
| Location | `%LOCALAPPDATA%\Expertmotion\app\resources\engines\<engine>\<version>\` (read-only, installed); the Vulkan variant is chosen when the Hardware Monitor reports a Vulkan-capable GPU, else CPU |
| Verification at startup | sha256 of each engine executable compared with `engines.json`; mismatch → `EM-7108` "engine damaged, reinstall" and the Generator Card is disabled |
| Third-Party Notices | every engine and model licence text in `scr.about` ▸ Third-Party Notices and in `resources/licenses/` |
| Updates | engines update only with Expertmotion releases; models can be updated independently through the registry (§4) |

### 3.2 Invocation contracts (child process, arguments array, never a shell)

All spawns use `child_process.spawn(exe, args, {cwd: jobDir, env: minimalEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true})`. `minimalEnv` = `{SYSTEMROOT, TEMP: jobDir, TMP: jobDir, PATH: engineDir, NO_PROXY: '*', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1'}`; nothing else from the parent environment is inherited (no proxy variables, no credentials). `jobDir = %APPDATA%\Expertmotion\tmp\jobs\<jobId>\` is created before the spawn and deleted after the result is copied into `media\<projectId>\<assetId>\`.

| Tool | Pre-step (Local Service) | Command (exact args) | Output parsed | Post-step |
|---|---|---|---|---|
| `captions.generate` | `ffmpeg -v error -i <asset original> -vn -ac 1 -ar 16000 -c:a pcm_s16le <jobDir>\in.wav` (full FFmpeg from ASSET_INGESTION.md) | `whisper-cli -m <models>\whisper.cpp\<model>\ggml-<model>.bin -f <jobDir>\in.wav -l <id|en|auto> -t <threads> -oj -ojf -ml 1 -sow -np -of <jobDir>\out` (`-ojf` = full JSON incl. token data; `-ml 1 -sow` = one word per segment, split on word) | `out.json` → `Caption[]` (`text` with leading space, `startMs`, `endMs`, `timestampMs` = midpoint, `confidence` = mean token probability or `null`) → `createTikTokStyleCaptions` → pages | pages stored via `op:caption.setPages`; raw `Caption[]` kept as `captions.json` beside the asset |
| `tts.generate` | text normalised (numbers to words for `id` via a deterministic rule table; max 2 000 characters per job; longer text split on sentence boundaries into chunks, concatenated with 250 ms silence) | `sherpa-onnx-offline-tts --vits-model=<models>\sherpa-onnx\<voice>\<voice>.onnx --vits-tokens=<...>\tokens.txt --vits-data-dir=<engineDir>\espeak-ng-data --num-threads=<threads> --output-filename=<jobDir>\out.wav "<text chunk>"` (Kokoro: `--kokoro-model`, `--kokoro-voices`, `--kokoro-tokens`, `--kokoro-data-dir` **[exact flag names to pin against the sherpa-onnx v2.0.0 CLI help; UNVERIFIED]**) | `out.wav` (22.05 kHz mono for Piper; 24 kHz for Kokoro) | `ffmpeg … -c:a aac -b:a 160k voice.m4a` → ingested as an Asset of kind `audio` (ASSET_INGESTION.md), inserted via `op:generated.insert` as an Audio Layer; waveform JSON generated |
| `music.generate` | prompt built from style tags + "instrumental, no vocals" + duration | `python.exe -I -m expertmotion_music --model <models>\ace-step\<model>\ --prompt "<p>" --duration <s> --seed <n> --out <jobDir>\out.wav --device <cuda|cpu> --offload` (our wrapper module around ACE-Step's inference API; see §9) | `out.wav` 44.1 kHz stereo | encoded to AAC, ingested as audio Asset, `op:audio.addBed` with `preset:audio.bed-soft` |
| `thumbnail.generate` | if `frameMs` given: `renderStill` of that frame (REMOTION_CAPABILITY_MAP.md §E.4); if `prompt` given and a model is installed: sd.cpp | `sd -M txt2img -m <models>\stable-diffusion.cpp\<model>\<file> -p "<prompt>" -n "<negative>" -W <w> -H <h> --steps <4 for FLUX | 20 for SD1.5> --cfg-scale <1.0 | 7.0> -s <seed> --vae-tiling --clip-on-cpu -o <jobDir>\out.png -t <threads>` (FLUX adds `--diffusion-model <gguf> --clip_l <clip_l> --t5xxl <t5> --vae <ae>`) | `out.png` | composited with the title by `renderStill` of a `ThumbnailComposite` still (title text via `fitText`), saved as `Output` kind `still` and offered for insertion as an Overlay |

Threads: `threads = max(1, min(8, os.cpus().length - 2))` on T0 so the Editor stays responsive; GPU variants use defaults.

### 3.3 Sandboxing

| Control | Implementation | Note |
|---|---|---|
| No network | Private Mode is checked before every spawn (downloads) but engines themselves never need the network: no proxy env, `HF_HUB_OFFLINE=1`, no URLs in args; Python runs with `-I` (isolated) and a wrapper that monkey-patches `socket` to raise | a Windows Firewall outbound rule per engine is an optional hardening step (THREAT_MODEL.md) |
| Filesystem | `cwd` and `TEMP` are the job directory; inputs are copied/transcoded into it; outputs are read only from it; paths are validated to stay under app data | engines still have the user's file permissions; this is containment of accidents, not of a hostile binary (ADR-007 honesty rule) |
| Timeouts | `captions`: `10 × audioSeconds + 60 s`; `tts`: `60 s` per chunk; `thumbnail`: `15 min` (T0) / `3 min` (GPU); `music`: `20 min`; on expiry → `taskkill /PID <pid> /T /F` (kills the process tree) and `EM-7102` | ETA shown from progress parsing (whisper prints segment times; sd.cpp prints step progress; wrapper prints JSON lines) |
| Memory limit | preferred: Windows Job Object with `JOB_OBJECT_LIMIT_PROCESS_MEMORY` set to the Performance Profile ceiling — Node has no built-in API; needs a tiny native helper or a PowerShell launcher **[UNVERIFIED feasibility]**; fallback: a watchdog polls the child's working set every 2 s (`process.memoryUsage` is not available for children → `Get-Process` via the Hardware Monitor's cached PowerShell channel, or `wmic`-free `tasklist /FI "PID eq <pid>" /FO CSV`) and kills above the ceiling with `EM-7109` | the Hardware Monitor's "background workload" row shows the engine's memory |
| Output limits | stdout/stderr capped at 1 MB each (older lines dropped), stored in `logs\jobs\<jobId>.log`; result files size-checked (`captions.json` ≤ 10 MB, wav ≤ 500 MB, png ≤ 50 MB) | — |
| Concurrency | one generator job at a time per Project; generator jobs are paused while a Render Job runs under Standard/Accelerated (PERFORMANCE.md §2 "Background tasks") | queue shared with ingest |
| Crash | non-zero exit → `EM-7101` with the last 20 stderr lines in Diagnostics; the Local Service never crashes with the child | PRD-015 analogue |

### 3.4 GPL-3 handling (espeak-ng data/library; piper1-gpl if ever used)

| Measure | Detail |
|---|---|
| Process boundary | GPL components run only inside the separate `sherpa-onnx-offline-tts` executable invoked over argv/files; no Expertmotion code links against them; Expertmotion's own code stays proprietary (ADR-007). This is the "separate program communicating at arm's length" position; it is recorded as a legal-review item in BRD.md, not asserted as settled law. |
| Unmodified or source-published | the shipped binary is either the unmodified upstream release (sha256 recorded) or an Operator build whose exact source tree is published at a URL named in the notices |
| Written offer | `scr.about` ▸ Third-Party Notices contains the GPL-3.0 text, the component list (`espeak-ng`, version, copyright), the source URL and a written offer valid for three years |
| No GPL weights | Piper voices are not GPL; their dataset licences are tracked per voice (§2.2) |
| Alternative | if legal review rejects the arm's-length position, Expertmotion downloads the TTS engine on first use like a model (keeping the installer GPL-free) — the Model Manager already supports engine-sized downloads |

---

## 4. Model Manager

### 4.1 Storage layout (ARCHITECTURE.md §8)

```
%APPDATA%\Expertmotion\models\
  registry.json                       copy of the shipped registry + Creator-visible state (installed, pinned)
  whisper.cpp\whisper-large-v3-turbo\ ggml-large-v3-turbo.bin, ggml-large-v3-turbo.bin.sha256, manifest.json
  sherpa-onnx\piper-id-news-medium\   id_ID-news_tts-medium.onnx, id_ID-news_tts-medium.onnx.json, tokens.txt, manifest.json
  stable-diffusion.cpp\sd15-emaonly\  v1-5-pruned-emaonly.safetensors, manifest.json
  stable-diffusion.cpp\flux1-schnell-q4\ flux1-schnell-Q4_0.gguf, clip_l.safetensors, t5xxl_fp8_e4m3fn.safetensors, ae.safetensors, manifest.json
  ace-step\ace-step-v1-3.5b\          (weights) + manifest.json
  python\3.11.x\                      embedded runtime + venv (§9)
  loops\cc0-v1\                       loop library + index.json + manifest.json
  .partial\<modelId>\<file>.part      resumable downloads
```

### 4.2 `manifest.json` schema (per installed model)

```ts
type ModelManifest = {
  schema: 1;
  id: string;                              // e.g. "whisper-large-v3-turbo"
  engine: 'whisper.cpp' | 'sherpa-onnx' | 'stable-diffusion.cpp' | 'ace-step' | 'loops';
  task: 'stt' | 'tts' | 'music' | 'image' | 'library';
  version: string;                         // registry entry version, e.g. "2026.10"
  files: { name: string; bytes: number; sha256: string; url: string; verifiedAt: string }[];
  licence: { spdx?: string; name: string; url: string; redistribution: 'yes' | 'no' | 'verify'; useRestrictions?: string };
  languages: string[];                     // ["id","en"]
  minTier: 'T0' | 'T1' | 'T2';
  ramBytes: number; vramBytes?: number;    // working-set estimates shown in the UI
  installedAt: string; lastUsedAt?: string; sizeOnDiskBytes: number;
  state: 'installed' | 'partial' | 'corrupt';
};
```

The shipped `registry.json` (in `packages/models/registry.json`, signed as part of the installer) has the same shape per model minus the installation fields, plus `recommendedFor: Tier[]` and `flag: 'model:<id>'`. URLs are Hugging Face `resolve/<commit-sha>/<file>` links pinned to a commit so that the sha256 in the registry is stable; the Operator recomputes hashes when bumping a model and ships the new registry with a release. Since 2026-10-25 release builds take pinned URLs and hashes from the signed `models.json` on the Operator's model CDN instead (§4.5).

### 4.3 First-use download flow (`scr.models.row.install`, or from a Generator Card / Catalogue Card badge)

| Step | Behaviour | Error |
|---|---|---|
| 0 Private Mode | if on → dialog "Private Mode blocks downloads. Turn it off to install this model (≈ 1.6 GB)." Installed models keep working. | `EM-7006` |
| 1 Confirm | sheet shows: model, task, size, licence name + link + use restrictions (OpenRAIL-M), tier recommendation, estimated speed on this PC, disk needed | — |
| 2 Disk check | free space on the models volume ≥ `Σ bytes × 1.1 + 500 MB`; else refuse | `EM-7004` |
| 3 Download | one file at a time, HTTP GET with `Range: bytes=<partSize>-` when a `.part` exists (resume); 2 retries with backoff per network error; progress (bytes, %, speed, ETA) via SSE `model.progress {modelId, file, bytes, total, bps}`; pause/cancel buttons; app restart resumes automatically; download runs through the single egress module (AI_WORKFLOW.md §1) so Private Mode toggling mid-download pauses it | `EM-7003` after retries exhausted |
| 4 Verify | streaming sha256 of the completed file compared with the registry; mismatch → file deleted, one automatic retry, then `EM-7003` "download corrupted" | `EM-7003` |
| 5 Install | move from `.partial` into the model folder; write `manifest.json` with `state: 'installed'`; SSE `model.installed`; Catalogue Card badges (`lib.catalogue.card.badge.model`) and Generator Cards update | — |
| 6 Self-test (P1) | a 2-second smoke run of the engine on a bundled sample (`captions`: 2 s Indonesian wav; `tts`: "Halo"; `image`: 64² 1-step) with the usual timeout; failure marks `corrupt` with a "re-download" action | `EM-7101` |

### 4.4 Other operations

| Operation | Behaviour |
|---|---|
| Remove | `scr.models.row.remove`: confirmation with size reclaimed; deletes the folder; running jobs using the model are cancelled first; Generator Card returns to "install" |
| Verify | re-hash all files (used by Diagnostics and after a crash during install) |
| Disk watch | Hardware Monitor disk row includes the models folder total; a warning appears when free space < 2 GB |
| Multiple versions | one installed version per model id; a registry bump shows "update available" (download new, then delete old) |
| Import from file (P2) | a Creator may point to an already-downloaded file; it is hashed and accepted only if the hash matches the registry (no arbitrary weights, to keep licences known) |
| Move models folder (P2) | setting for a different drive; the folder is moved, `registry.json` updated |
| Private Mode | downloads, registry updates and self-tests that need downloads are blocked; everything installed works offline, which is the point of local models |

### 4.5 Download policy: the Operator's model CDN (ADR-026)

Operator decision 2026-10-25: Creators download model files only from the Operator's CDN (Cloudflare R2 behind a custom domain), never from Hugging Face or GitHub directly. Runbook and free-tier budget: DEPLOYMENT_AND_PACKAGING.md §16.

| Rule | Behaviour |
|---|---|
| Source of files | `<cdn>/m/<sha256>`, mirrored by the Operator with `tools/model-mirror` (`prepare` → `sign` → `rclone copy`); the upstream URL and Hugging Face revision are recorded in the manifest (`revision`), the original file name in `name` |
| Host allow-list (SEC-071) | release builds carry `EM_MODEL_CDN_URL`; the model-download allow-list is then exactly its host. Development builds without it keep the Hugging Face/GitHub hosts of the built-in registry |
| Manifest | `<cdn>/models.json` + `models.json.sig` (Ed25519, manifest key, SEC-072), schema 1 with a monotonic `seq`. The Service fetches both through the egress module (purpose `model-download`; Private Mode → EM-8202 before any request) at most once per 24 h when the Model Manager list is requested (R-140), on Refresh (R-147), and when an unpinned model is installed; bodies capped at 2 MB / 4 KB, 10 s budget |
| Acceptance | signature verified before parsing, then schema, then `seq` ≥ last accepted; only then are both files written atomically into the models folder and the registry reloaded. Entries on a host outside the allow-list are not applied |
| Failure | offline (EM-8201), Private Mode (EM-8202), HTTP error, oversize, bad signature, stale or malformed (EM-7111, logged with `reason`): the last accepted manifest, or the built-in registry, stays in use; R-140 reports it as `registryUpdate` |
| Licences | `redistribution: 'no'` is never mirrored; `'verify'` only after the Operator verified it (`--include-verify`) |

---

## 5. Hardware Tier → defaults

Tiers come from PERFORMANCE.md §1 (T0 CPU-only, T1 ≥ 4 GB VRAM, T2 ≥ 8 GB VRAM); RAM gates (warn < 8 GB total; generator jobs refuse when free RAM < model `ramBytes` + 1 GB → `EM-7109`).

| Task | T0 | T1 | T2 | Universal fallback |
|---|---|---|---|---|
| Captions (STT) | `whisper-small` default; `whisper-medium` offered with a speed warning | `whisper-large-v3-turbo` (Vulkan engine) | `whisper-large-v3-turbo`; `whisper-large-v3` offered | SRT/VTT import (`op:caption.importSrt`, P0) |
| Voice (TTS, id) | `piper-id-news-medium` | same | same | import a recorded voice file |
| Voice (TTS, en) | `piper-en-lessac-medium` | same; `kokoro-82m-v1.0` offered (P2) | `kokoro-82m-v1.0` default (P2) | import |
| Music | `loop-library-cc0` (no generation) | `ace-step-v1-3.5b` with `--offload`, warning "1–3 minutes" | `ace-step-v1-3.5b` | `loop-library-cc0` |
| Thumbnail | `frame-composite`; `sd15-emaonly` offered with "2–5 minutes" warning | `sd15-emaonly` | `flux1-schnell-q4` | `frame-composite` |
| Hashtags / caption text | connected LLM (not local) | same | same | none (requires a Provider Connection; disabled in Private Mode) |

Resolution defaults for images: SD 1.5 512×512 (or 512×896 for 9:16 thumbnails), FLUX 1024×1024 (or 768×1344); the thumbnail is then placed by Remotion at the project's ratio.

---

## 6. Fallback behaviour (brief §15 "when a model is unavailable or hardware is insufficient")

| Situation | Behaviour | Code |
|---|---|---|
| Model not installed | Generator Card shows "Install (size)"; Catalogue Cards flagged `model:<id>` show `lib.catalogue.card.badge.model`; the Editor Agent's capability list excludes the tool so plans never reference it | `EM-7107` if a plan step still calls it |
| Tier below `minTier` | model hidden from defaults, shown greyed with "needs a GPU tier" and still installable at the Creator's risk (except WebGPU/VRAM-bound FLUX, which is hidden on T0) | `EM-7109` when run and memory check fails |
| Free RAM insufficient at run time | refuse with the number needed; suggest closing apps or the smaller model | `EM-7109` |
| Engine crash / timeout | job `failed`; the Creator can retry with the smaller model (one-click) | `EM-7101` / `EM-7102` |
| Private Mode | downloads blocked; installed models work | `EM-7006` |
| Python runtime missing (music) | offer the download (§9) or the loop library | `EM-7107` |
| Quality below acceptance (§7) for Indonesian TTS | the Generator Card states "news-reader quality"; the Brainstorming Agent may suggest recording or a cloud voice (not MVP) | — |

---

## 7. Quality evaluation plan

| Item | Content | Metric | Acceptance |
|---|---|---|---|
| STT test set (id) | 30 clips, 10–60 s: 10 clean studio voice, 10 phone recordings with music bed, 10 fast conversational (Jakarta colloquial), with human transcripts; from the Operator's own recordings or CC0/CC-BY speech (licence recorded per clip) | WER (jiwer-style normalisation: lowercase, strip punctuation, numbers as digits); word-timing error: median |start error| vs forced alignment | `whisper-large-v3-turbo` WER ≤ 12 % clean / ≤ 25 % noisy; `whisper-small` ≤ 30 % clean; median timing error ≤ 120 ms |
| STT test set (en) | 15 clips, same mix | WER | ≤ 10 % clean (turbo) |
| TTS sentences (id) | 20 sentences: numbers ("Rp 1.250.000", "tahun 2026"), abbreviations ("dll.", "Jl."), loanwords ("smartphone", "update"), names, questions, one long 180-character sentence | intelligibility (transcribe-back with whisper: WER of the TTS output), MOS mini-survey | transcribe-back WER ≤ 10 %; MOS ≥ 3.0 / 5 for `piper-id-news-medium` (documented as "news reader") |
| TTS sentences (en) | 20 sentences, same categories | same | MOS ≥ 3.0 (Piper), ≥ 3.8 (Kokoro) |
| MOS mini-survey | 5 Indonesian listeners from the usability panel (PRD.md §5), 10 samples each, 1–5 naturalness and 1–5 intelligibility, blind A/B vs a reference cloud voice | mean ± sd | reported in POC-011; no hard gate beyond the floors above |
| Music | 10 prompts × 3 seeds × 30 s; checks: loudness (EBU R128 integrated −16 LUFS ± 2 after normalisation), no vocals detected (whisper returns < 3 words), loop seam audibility | pass/fail per check + listener rating | ≥ 80 % pass |
| Thumbnails | 10 prompts × 2 ratios; checks: no text artefacts (titles are composited), subject present (manual), time | manual rubric | ≥ 70 % usable on first try (T2 FLUX), ≥ 50 % (SD 1.5) |
| Speed | every job logs model, tier, input length, wall-clock → Diagnostics; the estimate columns of §2 are replaced by medians after POC-010/011 | seconds per unit | — |

Test assets live in `packages/models/eval/` with a `LICENSES.md`; evaluation scripts run on the Windows QA machine (the shared Linux server cannot run GPU engines, ASSESSMENT.md §1).

---

## 8. API surface for the agents' Tools (AI_WORKFLOW.md §8)

All four tools are plan steps executed by the runtime after Execute (never called by the model directly); they create a **job** and return `{jobId}`; results arrive as job events and end with an Operation that the runtime applies within the same plan (`op:caption.setPages`, `op:generated.insert`, `op:audio.addBed`). The Local Service exposes them over REST + SSE (API_SPECIFICATION.md owns routes); the shapes below are the contracts.

| Tool | Input (Zod summary) | Output on completion | Job events (SSE `job.*`) | Preconditions / errors |
|---|---|---|---|---|
| `captions.generate` | `{projectId, assetId, language: 'id'|'en'|'auto', modelId?: string, combineTokensWithinMs?: number (1200), maxLines?: 1..3}` | `{jobId}` → `{captions: Caption[], pages: TikTokPage[], language, modelId, durationMs}`; applied as `op:caption.setPages` | `job.queued`, `job.progress {percent, stage: 'extract-audio'|'transcribe'|'paginate', eta}`, `job.done {result}`, `job.failed {code}` | asset must have audio (`EM-1004` family) and be probed; model installed (`EM-7107`); RAM (`EM-7109`); duration ≤ 30 min |
| `tts.generate` | `{projectId, text: string (≤ 2000), voiceId: 'piper-id-news-medium'|'piper-en-lessac-medium'|'kokoro-82m-v1.0', language: 'id'|'en', speed?: 0.8..1.2, atMs?: number}` | `{jobId}` → `{assetId, durationMs, waveform: true}`; applied as `op:generated.insert {kind: 'voice', jobId}` → Audio Layer at `atMs` (playhead default) | `job.progress {percent, stage: 'synthesize'|'encode'|'ingest'}` … | voice installed; text non-empty; Private Mode irrelevant (local) |
| `music.generate` | `{projectId, prompt: string (≤ 300), durationMs: 5000..300000, style: string[] (tags from a closed list), seed?: number, instrumental: true}` | `{jobId}` → `{assetId, durationMs, source: 'ace-step'|'loop-library', loudnessLufs}`; applied as `op:audio.addBed {assetId, volume: 0.2, loop: true}` | `job.progress {percent, stage: 'prepare'|'generate'|'normalize'|'ingest'}` … | T1/T2 + Python runtime for ACE-Step, else loop library automatically with a notice |
| `thumbnail.generate` | `{projectId, frameMs?: number, prompt?: string, titleText?: string, ratio?: AspectRatio, modelId?: string, seed?: number}` | `{jobId}` → `{outputId, assetId, width, height, source: 'frame-composite'|'sd15'|'flux'}`; offered for `op:generated.insert {kind: 'thumbnail'}` as an Overlay, and listed as an Output | `job.progress {percent, stage: 'still'|'diffuse'|'composite'}` … | `frameMs` requires a Composition Version with ≥ 1 Clip; `prompt` requires an installed image model |

Common job envelope: `{jobId, projectId, tool, status: 'queued'|'running'|'done'|'failed'|'cancelled', createdAt, startedAt?, finishedAt?, progress, eta?, error?: {code, message}}`; `DELETE /jobs/:id` cancels (kills the process tree, deletes the job dir). Jobs are persisted; on service restart running jobs are marked `failed` with `EM-7101` and the Plan Card shows "interrupted, re-run" (AI_WORKFLOW.md §12).

Model Manager API (Creator only, not a Tool): `GET /models` (registry + state), `POST /models/:id/install`, `POST /models/:id/pause`, `DELETE /models/:id`, `POST /models/:id/verify`; SSE `model.progress`, `model.installed`, `model.removed`, `model.failed`.

---

## 9. Embedded Python plan for ACE-Step (P2) and the explicit fallback

### 9.1 Runtime

| Item | Decision | Size (est.) |
|---|---|---|
| Interpreter | python-build-standalone CPython 3.11 (Windows x86-64, `install_only` build), downloaded on demand into `models\python\3.11.x\`, sha256-verified like a model; never in the installer | ≈ 30 MB zip, ≈ 100 MB installed |
| Package manager | `uv` (single binary, MIT) shipped with the installer (≈ 20 MB) to create a venv from a **locked** requirements file shipped in the app (`packages/models/python/ace-step.lock`), with `--offline` after a one-time wheel download into `models\python\wheels\` | wheels: torch CUDA 12.x ≈ 2.5 GB, diffusers/transformers/accelerate ≈ 200 MB; CPU-only torch ≈ 200 MB (T0 is not supported for music, so CUDA wheels are the default on T1/T2) |
| Model | `ace-step-v1-3.5b` weights ≈ 7 GB **[estimate]** | — |
| Total first-use download for music | ≈ 10 GB on T1/T2 **[estimate]**, shown before confirming | — |
| Wrapper | `expertmotion_music` package (ours, MIT) with a `__main__` that loads the pipeline once per job, prints JSON progress lines, writes `out.wav`; no network (`HF_HUB_OFFLINE=1`, socket disabled) | ≈ 50 kB |
| Isolation | venv under app data; `python -I` (ignore user site and env); `PYTHONNOUSERSITE=1`; job dir as cwd/TEMP; timeout 20 min; memory watchdog (§3.3) | — |
| Updates | wheel lock and wrapper versioned with the app; re-created venv on lock change | — |
| GPU detection | `torch.cuda.is_available()` at self-test; if false on T1/T2 (driver too old) → fall back to the loop library with `EM-7109` reason | — |

### 9.2 Why not Python in the installer

Installer budget ≤ 450 MB (PERFORMANCE.md §5); the torch runtime alone exceeds it; most Creators (T0) cannot use ACE-Step; and Python packaging is the single largest maintenance risk (ARCHITECTURE.md §11.3). Downloading it like a model keeps the P0 product free of Python.

### 9.3 Fallback: curated royalty-free loop library with rule-based arrangement

| Item | Decision |
|---|---|
| Sources (to verify per track before inclusion; only **CC0-1.0** accepted) | FreePD.com (CC0 catalogue); Free Music Archive filtered to CC0; OpenGameArt.org CC0 music filter; Freesound.org CC0 filter for stingers. **Not** accepted: Pixabay (own licence, not CC0), Incompetech/Kevin MacLeod (CC-BY-4.0, attribution required), Bensound (own licence). Each track's licence page URL and a snapshot are stored in `loops\cc0-v1\LICENSES.md`. |
| Content | ≈ 60 loops, 8–16 bars each, tagged `mood` (calm, upbeat, dramatic, corporate, playful, lo-fi), `bpm`, `key`, `energy` 1–5, `instrumental: true`; plus 20 stingers for `preset:audio.sfx-hit`; 48 kHz, −16 LUFS normalised; ≈ 150 MB |
| Arrangement algorithm (deterministic, seeded) | 1 pick candidates by `style` tags → mood map; 2 choose the loop whose bar length divides the target duration best; 3 tile the loop to `durationMs`, cutting at bar boundaries; 4 apply 2-bar crossfades at seams and a 1 s fade-in / 2 s fade-out; 5 optional variation: drop the last 2 bars to a lower-energy sibling loop (same key/bpm) for an outro; 6 export wav → AAC → Asset |
| Where arrangement runs | the Local Service with the full FFmpeg (`aloop`/`acrossfade`/`afade` filters) — no Python |
| Quality | §7 music checks apply; seams must pass the "loop seam audibility" listener check |
| Status | P2, but it is the **T0 default** and the universal fallback, so it ships before ACE-Step |

---

## 10. Requirements and tests (placeholders for TEST_PLAN.md)

| ID (proposed) | Check |
|---|---|
| QA-LM-001 | Every registry row has licence id/name, redistribution flag, sha256 for every file, `minTier`, flag id used by DESIGN_CATALOGUE.md |
| QA-LM-002 | Download: interrupt at 50 %, restart app → resumes from `.part`, hash verifies |
| QA-LM-003 | Corrupted file (flip one byte) → `EM-7003`, file removed, retry offered |
| QA-LM-004 | Private Mode on → install refused with `EM-7006`; installed model still runs |
| QA-LM-005 | Engine with no network: packet capture shows zero connections during `captions.generate`, `tts.generate`, `thumbnail.generate` |
| QA-LM-006 | Timeout kill: a hung engine (debug flag) is killed with its child processes; job `EM-7102`; service alive |
| QA-LM-007 | T0 machine: FLUX hidden, SD 1.5 warns, whisper-small default |
| QA-LM-008 | WER and MOS gates of §7 met on the QA machine; results recorded in POC-010/011 |
| QA-LM-009 | Third-Party Notices lists espeak-ng (GPL-3.0-or-later) with source URL and written offer; OpenRAIL-M use restrictions shown before installing SD 1.5 |
| QA-LM-010 | Loop library: every track has a CC0 licence snapshot; arranged bed of 90 s has no audible seam in the listener check |
