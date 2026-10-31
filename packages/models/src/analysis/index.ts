// Footage analysis (FR-280 … FR-284, ADR-039): pure functions behind the Footage prep job — sync, phrases, listen helpers,
// takes, syllable word timing, loudness strings, procedural SFX, rotation guess. No I/O: the Service decodes media with FFmpeg.
export * from './types.js';
export * from './pcm.js';
export * from './sync.js';
export * from './phrases.js';
export * from './listen.js';
export * from './takes.js';
export * from './word-timing.js';
export * from './loudness.js';
export * from './sfx.js';
export * from './orientation.js';
