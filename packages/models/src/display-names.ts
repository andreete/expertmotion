// Creator-facing product names for registry models (Operator decision 2026-10-25, beginner audience). The Model Manager,
// Generators, onboarding and toasts show these instead of the upstream model names; the internal `key` (APIs, DB, presets)
// and the licence name/notices (legal requirement) stay unchanged. Agent prompts and tool outputs for the LLM may keep keys.
import type { ModelDef } from './registry.js';

export interface DisplayName { en: string; id: string }

/** One entry per registry key (the registry test requires every row to have one). */
export const DISPLAY_NAMES: Readonly<Record<string, DisplayName>> = Object.freeze({
  'whisper-small': { en: 'Auto Captions — Fast', id: 'Teks Otomatis — Cepat' },
  'whisper-medium': { en: 'Auto Captions — Balanced', id: 'Teks Otomatis — Seimbang' },
  'whisper-large-v3-turbo': { en: 'Auto Captions — Accurate', id: 'Teks Otomatis — Akurat' },
  'whisper-large-v3': { en: 'Auto Captions — Best', id: 'Teks Otomatis — Terbaik' },
  'piper-id-news-medium': { en: 'Indonesian Voice — News', id: 'Suara Indonesia — Berita' },
  'supertonic-3-int8': { en: 'Indonesian Voices — Natural (10)', id: 'Suara Indonesia — Natural (10)' },   // FR-267
  'piper-en-lessac-medium': { en: 'English Voice', id: 'Suara Inggris' },
  'kokoro-82m-v1.0': { en: 'English Voice — Natural', id: 'Suara Inggris — Natural' },
  'espeak-ng-data': { en: 'Pronunciation Data', id: 'Data Pelafalan' },
  'ace-step-v1-3.5b': { en: 'Music Generator', id: 'Generator Musik' },
  'stable-audio-open-1.0': { en: 'Music Generator — Preview', id: 'Generator Musik — Pratinjau' },
  'loop-library-cc0': { en: 'Music Library', id: 'Pustaka Musik' },
  'flux1-schnell-q4': { en: 'Image Generator — High Quality (GPU)', id: 'Generator Gambar — Kualitas Tinggi (GPU)' },
  'sd15-emaonly': { en: 'Image Generator — Standard', id: 'Generator Gambar — Standar' },
  'frame-composite': { en: 'Thumbnail from a Frame', id: 'Thumbnail dari Frame' },
});

/** The friendly name of a model; rows without an entry (e.g. a test registry) fall back to their `label` in both languages. */
export function displayNameOf(def: Pick<ModelDef, 'key' | 'label'>): DisplayName {
  return DISPLAY_NAMES[def.key] ?? { en: def.label, id: def.label };
}
