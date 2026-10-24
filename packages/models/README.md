# @expertmotion/models

Model Manager core + Engine Binary adapters (docs/LOCAL_AI_MODELS.md, BLUEPRINT.md §3.5). Node-only, React-free;
imports only `@expertmotion/shared`, `zod` and Node built-ins.

- `registry.ts` — Local Model registry as data (ids = LOCAL_AI_MODELS ids; sha256/revision `TO_PIN` until the Operator pins them), §5 tier defaults.
- `manifest.ts` — `manifest.json` Zod schema + atomic read/write.
- `download.ts` / `install.ts` — resumable, hash-verified Model Downloads through an injected egress `fetch`; install/verify/remove.
- `engines/` — whisper.cpp, sherpa-onnx TTS, stable-diffusion.cpp, ACE-Step wrapper; injected `spawn`, scrubbed env, timeouts.
- `captions/` — `parseSrt`/`parseVtt`, TikTok-style paging (`createTikTokStyleCaptions` equivalent), `CaptionPage` conversion.
- `jobs.ts` — generator job runner with `queued|running|progress|done|failed|cancelled` events.
