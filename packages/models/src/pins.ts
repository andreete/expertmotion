// Pinned Hugging Face files (LOCAL_AI_MODELS.md §4.2, SEC-074): commit sha, sha256 and exact byte count per "repo/path".
// Read from the public Hugging Face API on 2026-10-25 (models/<repo>, tree/<commit>; LFS oid = sha256; the two small Piper
// .onnx.json files and Kokoro tokens.txt were hashed after download). Kokoro uses the sherpa-onnx export
// csukuangfj/kokoro-multi-lang-v1_0 (model.onnx, voices.bin, tokens.txt, lexicon-us-en.txt; Apache-2.0). Every file is downloadable without a Hugging Face account (no gated repo):
// the FLUX VAE comes from second-state/FLUX.1-schnell-GGUF, a byte-identical Apache-2.0 copy of the gated
// black-forest-labs/FLUX.1-schnell ae.safetensors (same sha256). To re-pin: update commit/sha256/bytes here; the
// download manager verifies every file against these values.
export interface FilePin { readonly commit: string; readonly sha256: string; readonly bytes: number }
export const HF_PINS: Readonly<Record<string, FilePin>> = Object.freeze({
  "ggerganov/whisper.cpp/ggml-small.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b", bytes: 487601967 },
  "ggerganov/whisper.cpp/ggml-medium.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208", bytes: 1533763059 },
  "ggerganov/whisper.cpp/ggml-large-v3-turbo.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69", bytes: 1624555275 },
  "ggerganov/whisper.cpp/ggml-large-v3.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2", bytes: 3095033483 },
  "rhasspy/piper-voices/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx": { commit: "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd", sha256: "ed8f02aa593f7af6b19acbdb8142e0da0dd72f46194eb33d38e0eb10a52597e8", bytes: 62950044 },
  "rhasspy/piper-voices/id/id_ID/news_tts/medium/id_ID-news_tts-medium.onnx.json": { commit: "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd", sha256: "1ef677072668a5e172e0759b1d3871f129009d1167f093325a17607f7add5ad7", bytes: 5050 },
  "rhasspy/piper-voices/en/en_US/lessac/medium/en_US-lessac-medium.onnx": { commit: "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd", sha256: "5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f", bytes: 63201294 },
  "rhasspy/piper-voices/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json": { commit: "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd", sha256: "efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0", bytes: 4885 },
  "city96/FLUX.1-schnell-gguf/flux1-schnell-Q4_0.gguf": { commit: "f495746ed9c5efcf4661f53ef05401dceadc17d2", sha256: "90a393d3a44bec691c707003f434fdde06064b870bb3c206eb7a4f109b25ff4e", bytes: 6770707360 },
  "comfyanonymous/flux_text_encoders/clip_l.safetensors": { commit: "6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5", sha256: "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd", bytes: 246144152 },
  "comfyanonymous/flux_text_encoders/t5xxl_fp8_e4m3fn.safetensors": { commit: "6af2a98e3f615bdfa612fbd85da93d1ed5f69ef5", sha256: "7d330da4816157540d6bb7838bf63a0f02f573fc48ca4d8de34bb0cbfd514f09", bytes: 4893934904 },
  "second-state/FLUX.1-schnell-GGUF/ae.safetensors": { commit: "8c45a2ba25e2d02bd34230989fb54983f39e44ec", sha256: "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38", bytes: 335304388 },
  "stable-diffusion-v1-5/stable-diffusion-v1-5/v1-5-pruned-emaonly.safetensors": { commit: "451f4fe16113bff5a5d2269ed5ad43b0592e9a14", sha256: "6ce0161689b3853acaa03779ec93eafe75a02f4ced659bee03f50797806fa2fa", bytes: 4265146304 },
  "csukuangfj/kokoro-multi-lang-v1_0/model.onnx": { commit: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b", sha256: "b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11", bytes: 325560556 },
  "csukuangfj/kokoro-multi-lang-v1_0/voices.bin": { commit: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b", sha256: "1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29", bytes: 28200960 },
  "csukuangfj/kokoro-multi-lang-v1_0/tokens.txt": { commit: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b", sha256: "6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425", bytes: 687 },
  "csukuangfj/kokoro-multi-lang-v1_0/lexicon-us-en.txt": { commit: "f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b", sha256: "7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14", bytes: 5956885 },
});
