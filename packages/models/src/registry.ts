// The Local Model registry as data. Source of truth: docs/LOCAL_AI_MODELS.md §2 (rows), §4.2 (shape), §5 (tier defaults).
// Model ids are the doc's ids (e.g. `whisper-small`); DATABASE_SCHEMA.md's `models.key` example `whisper.large-v3-turbo`
// is accepted through normalizeModelKey().
//
// Pinning: LOCAL_AI_MODELS §4.2 requires Hugging Face `resolve/<commit-sha>/<file>` URLs with a sha256 per file. The pins
// live in pins.ts (commit, sha256, exact bytes per "repo/path", read from the HF API on 2026-10-25); a file without a pin
// keeps TO_PIN and the download manager refuses it (no download without a hash to verify, SEC-074).
import type { DefaultTask, Language, ModelEngine, ModelTask, Tier } from './types.js';
import { HF_PINS } from './pins.js';

export const TO_PIN = 'TO_PIN' as const;
/** Registry entry version (manifest.json `version`). */
export const REGISTRY_VERSION = '2026.10';

/** SEC-071 pinned download-host allow-list (the Operator's release host is added at runtime: `allowedHosts({ operatorHost })`). */
export const DOWNLOAD_HOSTS: readonly string[] = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cas-bridge.xethub.hf.co', '*.hf.co', 'github.com', 'objects.githubusercontent.com'];
export function allowedHosts(opts: { operatorHost?: string; extra?: readonly string[] } = {}): string[] {
  return [...DOWNLOAD_HOSTS, ...(opts.operatorHost ? [opts.operatorHost] : []), ...(opts.extra ?? [])].map((h) => h.toLowerCase());
}

export interface ModelFileDef {
  name: string;
  bytes: number;
  /** true once the Operator has pinned the exact byte count; false = rounded doc figure. */
  bytesExact: boolean;
  sha256: string;               // hex, or TO_PIN
  url: string;                  // https only, host in DOWNLOAD_HOSTS
  revision: string;             // HF commit sha, or TO_PIN
}

export interface LicenceDef {
  spdx?: string;
  name: string;
  url: string;
  redistribution: 'yes' | 'no' | 'verify';
  useRestrictions?: string;
}

export type CommercialUse = 'yes' | 'conditional' | 'no';
export type Availability =
  | 'download'      // Model Download through the Model Manager
  | 'bundled'       // ships inside an Engine Binary (no download)
  | 'virtual'       // no model at all (frame-composite)
  | 'evaluate';     // listed for evaluation only; not installable in MVP

export interface ModelDef {
  key: string;
  label: string;
  engine: ModelEngine;
  task: ModelTask;
  version: string;
  availability: Availability;
  files: ModelFileDef[];
  /** Total download size (sum of files when files are listed; doc estimate otherwise). */
  bytes: number;
  licence: LicenceDef;
  commercialUse: CommercialUse;
  languages: string[];
  minTier: Tier;
  recommendedFor: Tier[];
  ramBytes: number;
  vramBytes?: number;
  /** DESIGN_CATALOGUE.md / Catalogue Card flag, or null when the row has none. */
  flag: `model:${string}` | null;
  priority: 'P1' | 'P2';
  /** Install-time step derived from downloaded files (no network). */
  postInstall?: 'piper-tokens';
  notes: string[];
}

const HF = (repo: string, path: string): string => `https://huggingface.co/${repo}/resolve/main/${path}`;
const MB = 1_000_000;
const GB = 1_000_000_000;
/** A registry file; when HF_PINS has its "repo/path", the URL resolves at the pinned commit with the exact size and sha256. */
const file = (name: string, bytes: number, url: string): ModelFileDef => {
  const m = /^https:\/\/huggingface\.co\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url);
  const pin = m ? HF_PINS[`${m[1]}/${m[2]}`] : undefined;
  if (!pin || !m) return { name, bytes: Math.round(bytes), bytesExact: false, sha256: TO_PIN, url, revision: TO_PIN };   // unpinned fallback: TO_PIN (refused at download; the registry test requires a pin for every file)
  return { name, bytes: pin.bytes, bytesExact: true, sha256: pin.sha256, url: `https://huggingface.co/${m[1]}/resolve/${pin.commit}/${m[2]}`, revision: pin.commit };
};
const sum = (files: readonly ModelFileDef[]): number => files.reduce((a, f) => a + f.bytes, 0);

const WHISPER_LICENCE: LicenceDef = { spdx: 'MIT', name: 'MIT (whisper.cpp engine) + MIT (OpenAI Whisper weights)', url: 'https://github.com/openai/whisper/blob/main/LICENSE', redistribution: 'yes' };
// RISK-002 (2026-10-29): the id_ID news_tts card is a copy of another voice's card; the name and description match the ATR
// INDspeech_NEWS_TTS corpus (CC BY-NC-SA 4.0, no public copies) — so the Indonesian voice's training data is very probably NC.
const PIPER_LICENCE: LicenceDef = { spdx: 'MIT', name: 'MIT (repository label); training data probably INDspeech_NEWS_TTS, CC BY-NC-SA 4.0 (RISK-002)', url: 'https://huggingface.co/rhasspy/piper-voices', redistribution: 'verify' };

function whisper(key: string, fileName: string, bytes: number, ramBytes: number, minTier: Tier, recommendedFor: Tier[], priority: 'P1' | 'P2', notes: string[]): ModelDef {
  const files = [file(fileName, bytes, HF('ggerganov/whisper.cpp', fileName))];
  return { key, label: `Whisper ${key.slice('whisper-'.length)}`, engine: 'whisper.cpp', task: 'stt', version: REGISTRY_VERSION, availability: 'download', files, bytes: sum(files),
    licence: WHISPER_LICENCE, commercialUse: 'yes', languages: ['id', 'en'], minTier, recommendedFor, ramBytes, flag: 'model:whisper', priority, notes };
}

function piper(key: string, label: string, lang: Language, dir: string, base: string, notes: string[], recommendedFor: Tier[]): ModelDef {
  const files = [file(`${base}.onnx`, 63 * MB, HF('rhasspy/piper-voices', `${dir}/${base}.onnx`)), file(`${base}.onnx.json`, 5_000, HF('rhasspy/piper-voices', `${dir}/${base}.onnx.json`))];
  return { key, label, engine: 'sherpa-onnx', task: 'tts', version: REGISTRY_VERSION, availability: 'download', files, bytes: sum(files), licence: PIPER_LICENCE, commercialUse: lang === 'id' ? 'conditional' : 'yes',
    languages: [lang], minTier: 'T0', recommendedFor, ramBytes: 300 * MB, flag: lang === 'id' ? 'model:piper-id' : 'model:piper-en', priority: 'P1', postInstall: 'piper-tokens', notes };
}

const FLUX_FILES: ModelFileDef[] = [
  file('flux1-schnell-Q4_0.gguf', 6.77 * GB, HF('city96/FLUX.1-schnell-gguf', 'flux1-schnell-Q4_0.gguf')),
  file('clip_l.safetensors', 246 * MB, HF('comfyanonymous/flux_text_encoders', 'clip_l.safetensors')),
  file('t5xxl_fp8_e4m3fn.safetensors', 4.9 * GB, HF('comfyanonymous/flux_text_encoders', 't5xxl_fp8_e4m3fn.safetensors')),
  file('ae.safetensors', 335 * MB, HF('second-state/FLUX.1-schnell-GGUF', 'ae.safetensors')),
];

const MODEL_LIST: ModelDef[] = [
  // §2.1 Speech-to-text — whisper.cpp
  whisper('whisper-small', 'ggml-small.bin', 488 * MB, 1.0 * GB, 'T0', ['T0'], 'P1', ['alt. ggml-small-q5_1.bin (190 MB)', 'T0 default']),
  whisper('whisper-medium', 'ggml-medium.bin', 1.53 * GB, 2.6 * GB, 'T0', [], 'P1', ['alt. ggml-medium-q5_0.bin (539 MB)', 'T0 option with a speed warning']),
  whisper('whisper-large-v3-turbo', 'ggml-large-v3-turbo.bin', 1.62 * GB, 2.5 * GB, 'T0', ['T1', 'T2'], 'P1', ['alt. -q5_0.bin 574 MB, -q8_0.bin 874 MB', 'T1/T2 default (Vulkan engine)']),
  whisper('whisper-large-v3', 'ggml-large-v3.bin', 3.1 * GB, 4.7 * GB, 'T0', [], 'P2', ['T2 "best quality" option']),
  // §2.2 Text-to-speech — sherpa-onnx
  piper('piper-id-news-medium', 'Piper id_ID news_tts (medium)', 'id', 'id/id_ID/news_tts/medium', 'id_ID-news_tts-medium',
    ['"news reader" prosody; the only offline Indonesian voice found', 'dataset licence UNVERIFIED (RISK-002): do not mirror until verified'], ['T0', 'T1', 'T2']),
  piper('piper-en-lessac-medium', 'Piper en_US lessac (medium)', 'en', 'en/en_US/lessac/medium', 'en_US-lessac-medium',
    ['size by analogy (UNVERIFIED)', 'dataset per its MODEL_CARD (UNVERIFIED)'], ['T0', 'T1']),
  (() => {
    // sherpa-onnx's Kokoro v1.0 export (model + voice table + tokens + US English lexicon); espeak-ng-data ships with the engine.
    const K = (f: string) => HF('csukuangfj/kokoro-multi-lang-v1_0', f);
    const files = [file('model.onnx', 326 * MB, K('model.onnx')), file('voices.bin', 28 * MB, K('voices.bin')), file('tokens.txt', 1_000, K('tokens.txt')), file('lexicon-us-en.txt', 6 * MB, K('lexicon-us-en.txt'))];
    return { key: 'kokoro-82m-v1.0', label: 'Kokoro 82M v1.0', engine: 'sherpa-onnx', task: 'tts', version: REGISTRY_VERSION, availability: 'download', files, bytes: sum(files),
      licence: { spdx: 'Apache-2.0', name: 'Apache-2.0', url: 'https://huggingface.co/csukuangfj/kokoro-multi-lang-v1_0', redistribution: 'yes' }, commercialUse: 'yes',
      languages: ['en'], minTier: 'T0', recommendedFor: ['T2'], ramBytes: 600 * MB, flag: 'model:kokoro', priority: 'P2',
      notes: ['no Indonesian', 'sherpa-onnx Kokoro v1.0 export; US English lexicon; espeak-ng-data from the engine'] } satisfies ModelDef;
  })(),
  (() => {
    // FR-267 (ADR-036, provisional): Supertonic 3 — 31 languages incl. Indonesian, 10 speakers, sherpa-onnx ≥ 1.13.2 (shipped 1.13.8),
    // no espeak-ng; the upstream OpenRAIL-M licence file ships with the weights (its use restrictions must be passed on).
    const S = (f: string) => HF('csukuangfj2/sherpa-onnx-supertonic-3-tts-int8-2026-05-11', f);
    const files = [file('duration_predictor.int8.onnx', 3.7 * MB, S('duration_predictor.int8.onnx')), file('text_encoder.int8.onnx', 36.4 * MB, S('text_encoder.int8.onnx')),
      file('vector_estimator.int8.onnx', 78.4 * MB, S('vector_estimator.int8.onnx')), file('vocoder.int8.onnx', 26 * MB, S('vocoder.int8.onnx')), file('unicode_indexer.bin', 262_144, S('unicode_indexer.bin')),
      file('voice.bin', 517_168, S('voice.bin')), file('tts.json', 8253, S('tts.json')), file('LICENSE', 15_007, HF('Supertone/supertonic-3', 'LICENSE'))];
    return { key: 'supertonic-3-int8', label: 'Supertonic 3 (int8)', engine: 'sherpa-onnx', task: 'tts', version: REGISTRY_VERSION, availability: 'download', files, bytes: sum(files),
      licence: { name: 'OpenRAIL-M (weights) + MIT (code)', url: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE', redistribution: 'yes',
        useRestrictions: 'OpenRAIL-M Attachment A: no impersonation / deepfakes of people without consent, no unlawful, discriminatory or harmful use; the restrictions pass on to every user' },
      commercialUse: 'conditional', languages: ['id', 'en'], minTier: 'T0', recommendedFor: ['T0', 'T1', 'T2'], ramBytes: 400 * MB, flag: 'model:supertonic', priority: 'P1',
      notes: ['ADR-036 provisional: Operator to confirm the OpenRAIL-M terms', '10 speakers (sid 0–4 female, 5–9 male: inferred)', 'measured here: 272 MB peak RSS, RTF 0.37–0.45 on 2 vCPUs, 44.1 kHz (process.md Entry 34)'] } satisfies ModelDef;
  })(),
  { key: 'espeak-ng-data', label: 'espeak-ng phonemiser data', engine: 'sherpa-onnx', task: 'tts', version: REGISTRY_VERSION, availability: 'bundled', files: [], bytes: 15 * MB,
    licence: { spdx: 'GPL-3.0-or-later', name: 'GPL-3.0-or-later (espeak-ng)', url: 'https://github.com/espeak-ng/espeak-ng', redistribution: 'yes' }, commercialUse: 'yes',
    languages: [], minTier: 'T0', recommendedFor: [], ramBytes: 0, flag: null, priority: 'P1', notes: ['shipped inside the sherpa-onnx TTS Engine Binary; GPL written offer in Third-Party Notices'] },
  // §2.3 Music
  // FR-247 (QA 2026-10-28 #9): no embedded Python runtime ships yet and the file list is not pinned, so ACE-Step is listed for
  // evaluation only (never installable, never offered); the Music card explains it and uses the CC0 library instead.
  { key: 'ace-step-v1-3.5b', label: 'ACE-Step v1 3.5B', engine: 'ace-step', task: 'music', version: REGISTRY_VERSION, availability: 'evaluate', files: [], bytes: 7 * GB,
    licence: { spdx: 'Apache-2.0', name: 'Apache-2.0', url: 'https://huggingface.co/ACE-Step/ACE-Step-v1-3.5B', redistribution: 'yes' }, commercialUse: 'yes',
    languages: [], minTier: 'T1', recommendedFor: ['T1', 'T2'], ramBytes: 8 * GB, vramBytes: 4 * GB, flag: 'model:ace-step', priority: 'P2',
    notes: ['≈ 7 GB weights [estimate] + ≈ 3 GB Python runtime', 'file list TO_PIN (HF snapshot)', 'ramBytes derived (no doc figure)'] },
  { key: 'stable-audio-open-1.0', label: 'Stable Audio Open 1.0', engine: 'stable-audio', task: 'music', version: REGISTRY_VERSION, availability: 'evaluate', files: [], bytes: 5 * GB,
    licence: { name: 'Stability AI Community License', url: 'https://huggingface.co/stabilityai/stable-audio-open-1.0', redistribution: 'no', useRestrictions: 'free below US$1 M annual revenue; gated download, each Creator accepts the licence on HF' },
    commercialUse: 'conditional', languages: [], minTier: 'T2', recommendedFor: [], ramBytes: 6 * GB, vramBytes: 6 * GB, flag: 'model:stable-audio', priority: 'P2',
    notes: ['P2 evaluate only; revenue-conditional licence (BRD)', 'sizes are estimates'] },
  // FR-247: the CC0 library is a curated track list (music-library.ts); each track downloads on demand, so the row itself is virtual.
  { key: 'loop-library-cc0', label: 'CC0 music library', engine: 'loops', task: 'library', version: REGISTRY_VERSION, availability: 'virtual', files: [], bytes: 85 * MB,
    licence: { spdx: 'CC0-1.0', name: 'CC0-1.0 (every track)', url: 'https://creativecommons.org/publicdomain/zero/1.0/', redistribution: 'yes' }, commercialUse: 'yes',
    languages: [], minTier: 'T0', recommendedFor: ['T0'], ramBytes: 0, flag: null, priority: 'P2', notes: ['tracks pinned per file (Hugging Face mirror of FreePD.com, CC0), downloaded on demand', 'default on every tier and universal music fallback'] },
  // §2.4 Image / thumbnail — stable-diffusion.cpp
  { key: 'flux1-schnell-q4', label: 'FLUX.1-schnell Q4', engine: 'stable-diffusion.cpp', task: 'image', version: REGISTRY_VERSION, availability: 'download', files: FLUX_FILES, bytes: sum(FLUX_FILES),
    licence: { spdx: 'Apache-2.0', name: 'Apache-2.0', url: 'https://huggingface.co/black-forest-labs/FLUX.1-schnell', redistribution: 'yes' }, commercialUse: 'yes',
    languages: [], minTier: 'T2', recommendedFor: ['T2'], ramBytes: 5.5 * GB, vramBytes: 8 * GB, flag: 'model:flux-schnell', priority: 'P2',
    notes: ['encoder sizes approximate', 'T5 on CPU (--clip-on-cpu); ramBytes derived from the T5 size (no doc figure)', 'hidden on T0'] },
  (() => {
    const files = [file('v1-5-pruned-emaonly.safetensors', 4.3 * GB, HF('stable-diffusion-v1-5/stable-diffusion-v1-5', 'v1-5-pruned-emaonly.safetensors'))];
    return { key: 'sd15-emaonly', label: 'Stable Diffusion 1.5 (EMA-only)', engine: 'stable-diffusion.cpp', task: 'image', version: REGISTRY_VERSION, availability: 'download', files, bytes: sum(files),
      licence: { spdx: 'CreativeML-OpenRAIL-M', name: 'CreativeML OpenRAIL-M', url: 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5', redistribution: 'yes',
        useRestrictions: 'use-based restrictions of OpenRAIL-M Attachment A must be passed on; shown before install' },
      commercialUse: 'yes', languages: [], minTier: 'T0', recommendedFor: ['T1'], ramBytes: 2.3 * GB, vramBytes: 3 * GB, flag: 'model:sd15', priority: 'P2',
      notes: ['size approximate (fp32 ≈ 4.3 GB; fp16 variant ≈ 2.1 GB)', 'T0 option with a "2–5 minutes" warning'] } satisfies ModelDef;
  })(),
  { key: 'frame-composite', label: 'Frame + title composite', engine: 'none', task: 'image', version: REGISTRY_VERSION, availability: 'virtual', files: [], bytes: 0,
    licence: { name: 'none (no model)', url: 'https://www.remotion.dev/docs/renderer/render-still', redistribution: 'yes' }, commercialUse: 'yes',
    languages: [], minTier: 'T0', recommendedFor: ['T0'], ramBytes: 0, flag: null, priority: 'P2', notes: ['renderStill of a chosen frame + title overlay; always available'] },
];

export type ModelKey = string;
const rounded = (m: ModelDef): ModelDef => ({ ...m, bytes: Math.round(m.bytes), ramBytes: Math.round(m.ramBytes), ...(m.vramBytes === undefined ? {} : { vramBytes: Math.round(m.vramBytes) }) });
export const registry: Readonly<Record<ModelKey, ModelDef>> = Object.freeze(Object.fromEntries(MODEL_LIST.map((m) => [m.key, Object.freeze(rounded(m))])));
export const MODEL_KEYS: readonly string[] = MODEL_LIST.map((m) => m.key);

/** Accepts the DATABASE_SCHEMA.md dotted form (`whisper.large-v3-turbo`) and returns the registry id, or null. */
export function normalizeModelKey(key: string): ModelKey | null {
  if (Object.hasOwn(registry, key)) return key;
  const dashed = key.replace('.', '-');
  return Object.hasOwn(registry, dashed) ? dashed : null;
}
export function getModel(key: string): ModelDef | undefined {
  const k = normalizeModelKey(key);
  return k === null ? undefined : registry[k];
}
export function requireModel(key: string): ModelDef {
  const m = getModel(key);
  if (!m) throw new RangeError(`unknown model key ${key}`);
  return m;
}

/** A file is downloadable only with a pinned sha256 (SEC-074). */
export const isPinned = (def: ModelDef): boolean =>
  def.files.length > 0 && def.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256));
export const isInstallable = (def: ModelDef): boolean => def.availability === 'download' && isPinned(def);

/** §2.7 Excluded models (non-commercial or unconfirmed licences). Never in the registry. */
export const EXCLUDED_MODELS: readonly { name: string; reason: string }[] = [
  { name: 'MusicGen (Meta)', reason: 'CC-BY-NC-4.0 weights: non-commercial' },
  { name: 'XTTS-v2 (Coqui)', reason: 'Coqui Public Model License: non-commercial' },
  { name: 'F5-TTS', reason: 'CC-BY-NC-4.0 weights' },
  { name: 'Fish Speech / OpenAudio S1', reason: 'CC-BY-NC-SA weights' },
  { name: 'OmniVoice', reason: 'non-commercial terms' },
  { name: 'SDXL-Turbo', reason: 'licence to re-check' },
  { name: 'YuE', reason: 'too heavy for consumer GPUs' },
  { name: 'Chatterbox, Qwen3-TTS, MeloTTS, Orpheus', reason: 'no Indonesian; Python-only (watch list)' },
  { name: '@remotion/install-whisper-cpp', reason: 'Windows prebuilt capped at whisper.cpp 1.6.0' },
];

/** True only for registry rows whose licence allows commercial use without conditions (Principle 2). */
export function isCommerciallyAllowed(key: string): boolean {
  const m = getModel(key);
  return m !== undefined && m.commercialUse === 'yes';
}

// §5 Hardware Tier → defaults. `offered` = shown with a warning, never the default.
export interface TierChoice { default: ModelKey; offered: ModelKey[] }
export type TierTable = Record<Tier, TierChoice>;
export const TIER_DEFAULTS: Readonly<{ stt: TierTable; 'tts.id': TierTable; 'tts.en': TierTable; music: TierTable; image: TierTable }> = Object.freeze({
  stt: { T0: { default: 'whisper-small', offered: ['whisper-medium'] }, T1: { default: 'whisper-large-v3-turbo', offered: [] }, T2: { default: 'whisper-large-v3-turbo', offered: ['whisper-large-v3'] } },
  // FR-267 (ADR-036, provisional): Supertonic 3 is the default offline Indonesian voice (more natural; OpenRAIL-M allows commercial
  // use); Piper news_tts stays offered (smaller, but its training data is probably non-commercial, RISK-002).
  'tts.id': { T0: { default: 'supertonic-3-int8', offered: ['piper-id-news-medium'] }, T1: { default: 'supertonic-3-int8', offered: ['piper-id-news-medium'] }, T2: { default: 'supertonic-3-int8', offered: ['piper-id-news-medium'] } },
  'tts.en': { T0: { default: 'piper-en-lessac-medium', offered: [] }, T1: { default: 'piper-en-lessac-medium', offered: ['kokoro-82m-v1.0'] }, T2: { default: 'kokoro-82m-v1.0', offered: [] } },
  music: { T0: { default: 'loop-library-cc0', offered: [] }, T1: { default: 'loop-library-cc0', offered: [] }, T2: { default: 'loop-library-cc0', offered: [] } },
  image: { T0: { default: 'frame-composite', offered: ['sd15-emaonly'] }, T1: { default: 'sd15-emaonly', offered: [] }, T2: { default: 'flux1-schnell-q4', offered: [] } },
});
/** §5 "Universal fallback" column. `srt-import` / `voice-import` are non-model flows of the Local Service. */
export const UNIVERSAL_FALLBACK: Readonly<Record<DefaultTask, string>> = Object.freeze({ stt: 'srt-import', tts: 'voice-import', music: 'loop-library-cc0', image: 'frame-composite' });

function tableFor(task: DefaultTask, language: Language): TierTable {
  if (task === 'tts') return language === 'en' ? TIER_DEFAULTS['tts.en'] : TIER_DEFAULTS['tts.id'];
  return TIER_DEFAULTS[task];
}
/** Default model for a task on a Hardware Tier (§5). TTS uses `language` (default 'id'). */
export function defaultModelFor(task: DefaultTask, tier: Tier, opts: { language?: Language } = {}): ModelKey {
  return tableFor(task, opts.language ?? 'id')[tier].default;
}
/** Default first, then the models offered with a warning on this tier. */
export function modelsOfferedFor(task: DefaultTask, tier: Tier, opts: { language?: Language } = {}): ModelKey[] {
  const c = tableFor(task, opts.language ?? 'id')[tier];
  return [c.default, ...c.offered];
}
const TIER_RANK: Record<Tier, number> = { T0: 0, T1: 1, T2: 2 };
/** Below minTier → EM-7005 warning when installing/running ("may be slow here"). */
export const isBelowMinTier = (key: string, tier: Tier): boolean => TIER_RANK[tier] < TIER_RANK[requireModel(key).minTier];
