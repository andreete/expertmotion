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
  // Reels prep (FR-285): quantised whisper models for low-RAM PCs (sha256 + bytes read from the HF LFS metadata at the same commit, 2026-10-31).
  "ggerganov/whisper.cpp/ggml-small-q5_1.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb", bytes: 190085487 },
  "ggerganov/whisper.cpp/ggml-medium-q5_0.bin": { commit: "5359861c739e955e79d9a303bcbc70fb988958b1", sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f", bytes: 539212467 },
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
  // FR-267 (ADR-036, provisional): Supertonic 3 sherpa-onnx int8 export, per-file HF mirror (read 2026-10-29: models/<repo>, tree/<commit>; tts.json hashed after download) + the upstream OpenRAIL-M LICENSE (Supertone/supertonic-3, hashed after download). All seven model files were downloaded here and match.
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/duration_predictor.int8.onnx": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "c3eb91414d5ff8a7a239b7fe9e34e7e2bf8a8140d8375ffb14718b1c639325db", bytes: 3700147 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/text_encoder.int8.onnx": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "c7befd5ea8c3119769e8a6c1486c4edc6a3bc8365c67621c881bbb774b9902ff", bytes: 36416150 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/vector_estimator.int8.onnx": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "20cd86fa5c6effedfda0e7cffe5b0569ca401c440a0c3a1d72bf39286c0db3fd", bytes: 78400833 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/vocoder.int8.onnx": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "e923d60f53f95eb1ce235f1dc33ec56d9c057823c96fa6f8acf98f32b0da6152", bytes: 25991073 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/unicode_indexer.bin": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "8402ca48e5189a8950138580b0fff64db6f072f24ac07cd54ba8b2fbb9883b30", bytes: 262144 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/voice.bin": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "67d5209b0ee8ce6c74105ffbe12fe6a7628aea3b4ba2fcb308a4a67938a93ce8", bytes: 517168 },
  "csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11/tts.json": { commit: "cca5a0e6c96e1d2c720986bf7e75fcc81dee3ae4", sha256: "42078d3aef1cd43ab43021f3c54f47d2d75ceb4e75f627f118890128b06a0d09", bytes: 8253 },
  "Supertone/supertonic-3/LICENSE": { commit: "3cadd1ee6394adea1bd021217a0e650ede09a323", sha256: "0d944a9110fed9a9602d60e0423a272903e7bd21ab060490774efc77c2275e9f", bytes: 15007 },
});
