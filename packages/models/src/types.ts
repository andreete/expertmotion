// Shared vocabulary of the Model Manager (docs/LOCAL_AI_MODELS.md §2, §4.2; docs/PERFORMANCE.md §1).
export type Tier = 'T0' | 'T1' | 'T2';
export const TIERS: readonly Tier[] = ['T0', 'T1', 'T2'];

/** Engines that own an installed-model folder `<modelsDir>/<engine>/<model>/` (manifest.json `engine`, LOCAL_AI_MODELS §4.2). */
export type ManifestEngine = 'whisper.cpp' | 'sherpa-onnx' | 'stable-diffusion.cpp' | 'ace-step' | 'loops';
export const MANIFEST_ENGINES: readonly ManifestEngine[] = ['whisper.cpp', 'sherpa-onnx', 'stable-diffusion.cpp', 'ace-step', 'loops'];
/** Registry-only engines: `none` = no model (frame-composite); `stable-audio` = evaluate-only row with no shipped runner. */
export type ModelEngine = ManifestEngine | 'none' | 'stable-audio';

/** manifest.json `task` (LOCAL_AI_MODELS §4.2). */
export type ModelTask = 'stt' | 'tts' | 'music' | 'image' | 'library';
/** Tasks of the Hardware Tier → defaults table (LOCAL_AI_MODELS §5). */
export type DefaultTask = 'stt' | 'tts' | 'music' | 'image';
export type Language = 'id' | 'en';
