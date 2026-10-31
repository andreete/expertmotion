// @expertmotion/models — Model Manager core + Engine Binary adapters (docs/LOCAL_AI_MODELS.md, BLUEPRINT.md §3.5).
export * from './types.js';
export * from './errors.js';
export * from './registry.js';
export * from './display-names.js';
export * from './manifest.js';
export * from './signed-registry.js';
export * from './download.js';
export * from './install.js';
export * from './jobs.js';
export * from './captions/types.js';
export * from './captions/pages.js';
export * from './captions/subtitles.js';
export * from './engines/process.js';
export * from './engines/common.js';
export * from './engines/whisper.js';
export * from './engines/sherpa.js';
export * from './engines/sdcpp.js';
export * from './engines/acestep.js';
export * from './transcript.js';
export * from './voices.js';
export * from './music-library.js';
export * from './audio-energy.js';
export * as analysis from './analysis/index.js';   // footage analysis (FR-280 … FR-284): sync, phrases, takes, word timing, loudness, SFX, rotation
