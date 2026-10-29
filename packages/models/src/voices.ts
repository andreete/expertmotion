// Narrator voices (FR-246, ADR-035; QA 2026-10-28 #8 "belum bisa memilih suara narator"). One catalogue for local voices (Piper /
// Kokoro through sherpa-onnx, offline) and cloud voices of the Creator's own connections (OpenAI TTS, Google Gemini TTS, and
// ElevenLabs with its own key). Voice ids are stable strings the Editor Agent and plans can name:
//   local:<modelKey>[:<variant>]       local:piper-id-news-medium, local:piper-id-news-medium:deep
//   openai:<model>:<voice>             openai:gpt-4o-mini-tts:coral
//   gemini:<model>:<voice>             gemini:gemini-3.8-flash-tts:Sulafat
//   elevenlabs:<model>:<voiceId>       (listed from the Creator's ElevenLabs account at run time)
// Facts per provider (endpoints, voice names, limits, prices) were read from the providers' docs on 2026-10-28 (LOCAL_AI_MODELS
// §2.2a). Gender / character words for cloud voices are listening impressions or the provider's one-word style label, not a
// provider promise; they only steer "pick a voice by description".
// Local Indonesian: Piper id_ID news_tts is the ONLY offline Indonesian voice found with an engine we ship (single speaker;
// dataset licence unverified, RISK-002). "deep" / "bright" are pitch variants of that one voice (ffmpeg, ±2 semitones), named
// as variants, never as other speakers. MMS-TTS ind is CC-BY-NC (excluded, §2.7).

export type VoiceProvider = 'local' | 'openai' | 'gemini' | 'elevenlabs' | 'azure' | 'google';
export type VoiceGender = 'female' | 'male' | 'neutral';
export interface VoiceDef {
  id: string;
  provider: VoiceProvider;
  /** Display name (provider voice name or product name). */
  name: string;
  gender: VoiceGender;
  /** Short character words in Indonesian and English (search + description). */
  traits: { id: string[]; en: string[] };
  /** Languages it speaks well (BCP-47 primary tags). Cloud voices are multilingual. */
  languages: string[];
  /** Local model behind it (local voices). */
  modelKey?: string;
  /** Pitch variant in semitones (local variants). */
  pitch?: number;
  /** Provider model id (cloud voices). */
  model?: string;
  /** Provider's own voice name / id. */
  voice?: string;
  cloud: boolean;
  /** Controls the provider supports. */
  supports: { speed: boolean; pitch: boolean; style: boolean };
  /** Rough price per 1,000 characters of Indonesian narration (USD), from the provider's price page (estimate). */
  usdPer1kChars?: number;
  /** One-line note shown under the voice (licence / quality). */
  note?: { id: string; en: string };
  /** Local multi-speaker models (Supertonic): the speaker index (`--sid`). */
  speakerId?: number;
  /**
   * FR-268: how natural it sounds in Indonesian, 1 (robotic) … 10 (human-like): the picker sorts by it and recommends the best
   * voice that can run. A JUDGEMENT from public descriptions and model class (LOCAL_AI_MODELS §2.2b), not a measured MOS.
   */
  naturalness?: number;
}

/** Indonesian narration speed used for estimates: ≈ 14 characters per second (measured on Piper id_ID at speed 1.0, ±20 %). */
export const ID_CHARS_PER_SECOND = 14;
export const estimateSpeechMs = (text: string, speed = 1): number => Math.round(([...text].length / ID_CHARS_PER_SECOND / Math.max(0.25, speed)) * 1000);
/** Estimated cost of `text` with `voice` (USD), or 0 for local voices. */
export function estimateVoiceCostUsd(voice: Pick<VoiceDef, 'usdPer1kChars' | 'cloud'>, text: string): number {
  if (!voice.cloud || !voice.usdPer1kChars) return 0;
  return Math.round(((([...text].length) / 1000) * voice.usdPer1kChars) * 10000) / 10000;
}

// ───────────────────────────── local ─────────────────────────────
const PIPER_ID_NOTE = { id: 'Suara luring (tanpa internet), gaya pembaca berita. Data latihnya kemungkinan berlisensi non-komersial (RISK-002): jangan dipakai untuk video komersial sampai dikonfirmasi.', en: 'Offline voice, news-reader style. Its training data is probably non-commercial (RISK-002): do not use it for commercial videos until confirmed.' };
// FR-267 (ADR-036, provisional): Supertonic 3 (Supertone, 31 languages incl. Indonesian), sherpa-onnx int8 export, 10 speakers.
// Weights: OpenRAIL-M — commercial use allowed, with use restrictions that are passed on to the Creator (no impersonation /
// deepfakes without consent, no unlawful or harmful use). Speaker genders follow the voice-style order of the export
// (F1…F5 = sid 0…4, M1…M5 = sid 5…9; inferred from the export script, not documented).
const SUPERTONIC_NOTE = { id: 'Suara luring yang lebih natural (Supertonic 3). Lisensi OpenRAIL-M: boleh komersial, dilarang meniru orang tanpa izin.', en: 'More natural offline voice (Supertonic 3). OpenRAIL-M: commercial use allowed; no impersonation without consent.' };
const ST: Array<[number, VoiceGender, string, string[], string[]]> = [
  [0, 'female', 'Perempuan 1', ['natural', 'hangat', 'jelas'], ['natural', 'warm', 'clear']], [1, 'female', 'Perempuan 2', ['natural', 'lembut'], ['natural', 'soft']],
  [2, 'female', 'Perempuan 3', ['ceria', 'muda'], ['bright', 'young']], [3, 'female', 'Perempuan 4', ['tenang', 'dewasa'], ['calm', 'mature']], [4, 'female', 'Perempuan 5', ['tegas', 'percaya diri'], ['firm', 'confident']],
  [5, 'male', 'Laki-laki 1', ['natural', 'hangat', 'jelas'], ['natural', 'warm', 'clear']], [6, 'male', 'Laki-laki 2', ['berat', 'berwibawa'], ['deep', 'authoritative']],
  [7, 'male', 'Laki-laki 3', ['santai', 'ramah'], ['casual', 'friendly']], [8, 'male', 'Laki-laki 4', ['tenang', 'stabil'], ['calm', 'even']], [9, 'male', 'Laki-laki 5', ['enerjik', 'ceria'], ['energetic', 'upbeat']],
];
export const SUPERTONIC_KEY = 'supertonic-3-int8';
export const SUPERTONIC_VOICES: readonly VoiceDef[] = Object.freeze(ST.map(([sid, gender, name, id, en]) => ({
  id: `local:${SUPERTONIC_KEY}:s${sid}`, provider: 'local' as const, name: `Supertonic · ${name}`, gender, traits: { id, en }, languages: ['id', 'en'], modelKey: SUPERTONIC_KEY, speakerId: sid, cloud: false,
  supports: { speed: true, pitch: false, style: false }, naturalness: sid === 0 || sid === 5 ? 6 : 5.5, note: SUPERTONIC_NOTE })));
export const LOCAL_VOICES: readonly VoiceDef[] = Object.freeze([
  ...SUPERTONIC_VOICES,
  { id: 'local:piper-id-news-medium', provider: 'local', name: 'Narator Berita', gender: 'neutral', traits: { id: ['jelas', 'formal', 'berita'], en: ['clear', 'formal', 'news'] }, languages: ['id'], modelKey: 'piper-id-news-medium', cloud: false, supports: { speed: true, pitch: true, style: false }, naturalness: 3, note: PIPER_ID_NOTE },
  { id: 'local:piper-id-news-medium:deep', provider: 'local', name: 'Narator Berita · berat', gender: 'neutral', traits: { id: ['berat', 'berwibawa', 'tegas'], en: ['deep', 'authoritative', 'firm'] }, languages: ['id'], modelKey: 'piper-id-news-medium', pitch: -2, cloud: false, supports: { speed: true, pitch: true, style: false }, naturalness: 2.5, note: PIPER_ID_NOTE },
  { id: 'local:piper-id-news-medium:bright', provider: 'local', name: 'Narator Berita · ringan', gender: 'neutral', traits: { id: ['ringan', 'muda', 'ceria'], en: ['light', 'young', 'bright'] }, languages: ['id'], modelKey: 'piper-id-news-medium', pitch: 2, cloud: false, supports: { speed: true, pitch: true, style: false }, naturalness: 2.5, note: PIPER_ID_NOTE },
  { id: 'local:piper-en-lessac-medium', provider: 'local', name: 'Lessac (English)', gender: 'female', traits: { id: ['jelas', 'netral'], en: ['clear', 'neutral'] }, languages: ['en'], modelKey: 'piper-en-lessac-medium', cloud: false, supports: { speed: true, pitch: true, style: false } },
  { id: 'local:kokoro-82m-v1.0', provider: 'local', name: 'Kokoro (English)', gender: 'female', traits: { id: ['natural', 'hangat'], en: ['natural', 'warm'] }, languages: ['en'], modelKey: 'kokoro-82m-v1.0', cloud: false, supports: { speed: true, pitch: true, style: false } },
] satisfies VoiceDef[]);

// ───────────────────────────── OpenAI ─────────────────────────────
/** POST https://api.openai.com/v1/audio/speech; `input` ≤ 4096 characters; speed 0.25–4; `instructions` (style) only on gpt-4o-mini-tts. */
export const OPENAI_TTS = { url: 'https://api.openai.com/v1/audio/speech', maxChars: 4096, model: 'gpt-4o-mini-tts', legacyModel: 'tts-1' } as const;
// gpt-4o-mini-tts: $0.60 / 1M text tokens + $12 / 1M audio tokens (≈ $0.015 per audio minute per OpenAI) → ≈ $0.018 per 1,000 Indonesian characters (≈ 71 s)
const OA: Array<[string, VoiceGender, string[], string[]]> = [
  ['coral', 'female', ['hangat', 'ramah', 'natural'], ['warm', 'friendly', 'natural']], ['nova', 'female', ['ceria', 'enerjik', 'muda'], ['bright', 'energetic', 'young']],
  ['shimmer', 'female', ['lembut', 'jernih'], ['soft', 'clear']], ['sage', 'female', ['tenang', 'bijak'], ['calm', 'wise']], ['marin', 'female', ['natural', 'percaya diri', 'jelas'], ['natural', 'confident', 'clear']],
  ['alloy', 'neutral', ['netral', 'seimbang'], ['neutral', 'balanced']], ['ash', 'male', ['tegas', 'jelas'], ['firm', 'clear']], ['ballad', 'male', ['ekspresif', 'hangat'], ['expressive', 'warm']],
  ['echo', 'male', ['tenang', 'datar'], ['calm', 'even']], ['fable', 'male', ['bercerita', 'ekspresif'], ['storyteller', 'expressive']], ['onyx', 'male', ['berat', 'berwibawa'], ['deep', 'authoritative']],
  ['verse', 'male', ['dinamis', 'ekspresif'], ['dynamic', 'expressive']], ['cedar', 'male', ['natural', 'hangat', 'percaya diri'], ['natural', 'warm', 'confident']],
];
export const OPENAI_VOICES: readonly VoiceDef[] = Object.freeze(OA.map(([v, gender, id, en]) => ({
  id: `openai:${OPENAI_TTS.model}:${v}`, provider: 'openai' as const, name: v[0]!.toUpperCase() + v.slice(1), gender, traits: { id, en }, languages: ['id', 'en'], model: OPENAI_TTS.model, voice: v, cloud: true,
  supports: { speed: true, pitch: false, style: true }, usdPer1kChars: 0.018, naturalness: v === 'marin' || v === 'cedar' ? 8 : 7.5, note: { id: 'Suara AI OpenAI (wajib diberi tahu ke penonton bahwa suara ini buatan AI).', en: 'OpenAI AI voice (tell viewers the voice is AI-generated).' } })));

// ───────────────────────────── Gemini ─────────────────────────────
/** POST https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent (x-goog-api-key); 30 prebuilt voices; 24 kHz mono 16-bit. */
export const GEMINI_TTS = { base: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'gemini-3.8-flash-tts', fallbackModel: 'gemini-2.5-flash-preview-tts', tokensPerSecond: 25 } as const;
// gemini-3.8-flash-tts output audio: $9 / 1M tokens until 2026-12-31 ($18 from 2027-01-01), 25 tokens per second → ≈ $0.016 per 1,000 Indonesian characters (2026 price)
const GV: Array<[string, string, VoiceGender, string, string]> = [
  ['Zephyr', 'Bright', 'female', 'cerah', 'bright'], ['Puck', 'Upbeat', 'male', 'ceria', 'upbeat'], ['Charon', 'Informative', 'male', 'informatif', 'informative'], ['Kore', 'Firm', 'female', 'tegas', 'firm'],
  ['Fenrir', 'Excitable', 'male', 'bersemangat', 'excitable'], ['Leda', 'Youthful', 'female', 'muda', 'youthful'], ['Orus', 'Firm', 'male', 'tegas', 'firm'], ['Aoede', 'Breezy', 'female', 'santai', 'breezy'],
  ['Callirrhoe', 'Easy-going', 'female', 'santai', 'easy-going'], ['Autonoe', 'Bright', 'female', 'cerah', 'bright'], ['Enceladus', 'Breathy', 'male', 'berbisik', 'breathy'], ['Iapetus', 'Clear', 'male', 'jelas', 'clear'],
  ['Umbriel', 'Easy-going', 'male', 'santai', 'easy-going'], ['Algieba', 'Smooth', 'male', 'halus', 'smooth'], ['Despina', 'Smooth', 'female', 'halus', 'smooth'], ['Erinome', 'Clear', 'female', 'jelas', 'clear'],
  ['Algenib', 'Gravelly', 'male', 'serak', 'gravelly'], ['Rasalgethi', 'Informative', 'male', 'informatif', 'informative'], ['Laomedeia', 'Upbeat', 'female', 'ceria', 'upbeat'], ['Achernar', 'Soft', 'female', 'lembut', 'soft'],
  ['Alnilam', 'Firm', 'male', 'tegas', 'firm'], ['Schedar', 'Even', 'male', 'stabil', 'even'], ['Gacrux', 'Mature', 'female', 'dewasa', 'mature'], ['Pulcherrima', 'Forward', 'female', 'lugas', 'forward'],
  ['Achird', 'Friendly', 'male', 'ramah', 'friendly'], ['Zubenelgenubi', 'Casual', 'male', 'kasual', 'casual'], ['Vindemiatrix', 'Gentle', 'female', 'lembut', 'gentle'], ['Sadachbia', 'Lively', 'male', 'hidup', 'lively'],
  ['Sadaltager', 'Knowledgeable', 'male', 'berwawasan', 'knowledgeable'], ['Sulafat', 'Warm', 'female', 'hangat', 'warm'],
];
export const GEMINI_VOICES: readonly VoiceDef[] = Object.freeze(GV.map(([v, style, gender, id, en]) => ({
  id: `gemini:${GEMINI_TTS.model}:${v}`, provider: 'gemini' as const, name: v, gender, traits: { id: [id, 'natural'], en: [en, 'natural'] }, languages: ['id', 'en'], model: GEMINI_TTS.model, voice: v, cloud: true,
  supports: { speed: true, pitch: false, style: true }, usdPer1kChars: 0.016, naturalness: 9,
  note: { id: `Gaya Google: ${style}. Tingkat gratis Gemini memakai data untuk melatih model Google.`, en: `Google style label: ${style}. Gemini's free tier uses data to improve Google's models.` } })));

// ───────────────────────────── Azure AI Speech ─────────────────────────────
/**
 * FR-269: Azure AI Speech REST text to speech (learn.microsoft.com …/rest-text-to-speech, read 2026-10-29): POST
 * https://<region>.tts.speech.microsoft.com/cognitiveservices/v1 with `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`,
 * `X-Microsoft-OutputFormat`, `User-Agent`; SSML body; audio bytes back (≤ 10 min). Key check: GET …/cognitiveservices/voices/list.
 * Prices (Azure Retail Prices API, eastus, 2026-10-29): Neural $15 / 1M characters, Neural HD $22 / 1M; free tier F0 0.5M / month.
 * No word timings over REST (SDK / batch only): captions are timed by alignment (transcript.ts).
 */
export const AZURE_TTS = { hostSuffix: 'tts.speech.microsoft.com', path: '/cognitiveservices/v1', listPath: '/cognitiveservices/voices/list', format: 'riff-24khz-16bit-mono-pcm', maxChars: 5000 } as const;
const AZ: Array<['neural' | 'dragonhd', string, VoiceGender, number, number, string[], string[]]> = [
  ['dragonhd', 'id-ID-Gadis', 'female', 0.022, 8.5, ['natural', 'hangat', 'ekspresif'], ['natural', 'warm', 'expressive']],
  ['dragonhd', 'id-ID-Ardi', 'male', 0.022, 8.5, ['natural', 'hangat', 'percaya diri'], ['natural', 'warm', 'confident']],
  ['neural', 'id-ID-Gadis', 'female', 0.015, 7.5, ['jelas', 'ramah', 'natural'], ['clear', 'friendly', 'natural']],
  ['neural', 'id-ID-Ardi', 'male', 0.015, 7.5, ['jelas', 'tegas', 'natural'], ['clear', 'firm', 'natural']],
];
/** The Azure voice name behind an id: azure:neural:id-ID-Gadis → id-ID-GadisNeural; azure:dragonhd:id-ID-Gadis → id-ID-Gadis:DragonHDLatestNeural. */
export const azureVoiceName = (model: string, voice: string): string => (model === 'dragonhd' ? `${voice}:DragonHDLatestNeural` : `${voice}Neural`);
export const AZURE_VOICES: readonly VoiceDef[] = Object.freeze(AZ.map(([model, v, gender, usd, nat, id, en]) => ({
  id: `azure:${model}:${v}`, provider: 'azure' as const, name: `${v.replace('id-ID-', '')}${model === 'dragonhd' ? ' HD' : ''} (Azure)`, gender, traits: { id, en }, languages: ['id', 'en'], model, voice: v, cloud: true,
  supports: { speed: true, pitch: true, style: false }, usdPer1kChars: usd, naturalness: nat,
  note: model === 'dragonhd' ? { id: 'Azure Neural HD (pratinjau Microsoft): paling ekspresif.', en: 'Azure Neural HD (Microsoft preview): the most expressive.' } : { id: 'Suara neural Indonesia dari Azure AI Speech.', en: 'Azure AI Speech Indonesian neural voice.' } })));

// ───────────────────────────── Google Cloud Text-to-Speech ─────────────────────────────
/**
 * FR-269: POST https://texttospeech.googleapis.com/v1/text:synthesize (docs.cloud.google.com …/rest/v1/text/synthesize, read
 * 2026-10-29) with the key in `x-goog-api-key` (Google's API-key page; the TTS pages name only OAuth, but the service accepts
 * keys: an invalid key answers 400 API_KEY_INVALID — that is the key check, see LOCAL_AI_MODELS §2.2a); 5,000 bytes of input
 * per request; LINEAR16 comes back with a WAV header (base64 `audioContent`). id-ID: Chirp 3 HD (30 voices, the Gemini voice
 * names), WaveNet A–D. Prices (cloud.google.com/text-to-speech/pricing, 2026-10-29): Chirp 3 HD $30 / 1M characters (1M free per
 * month), WaveNet $4 / 1M as shown on the page (re-check), Standard $4 / 1M.
 */
export const GOOGLE_TTS = { url: 'https://texttospeech.googleapis.com/v1/text:synthesize', voicesUrl: 'https://texttospeech.googleapis.com/v1/voices', maxBytes: 5000 } as const;
/** The Google voice name behind an id: google:chirp3-hd:Kore → id-ID-Chirp3-HD-Kore; google:wavenet:A → id-ID-Wavenet-A. */
export const googleVoiceName = (model: string, voice: string, language: 'id' | 'en' = 'id'): string => `${language === 'en' ? 'en-US' : 'id-ID'}-${model === 'wavenet' ? 'Wavenet' : 'Chirp3-HD'}-${voice}`;
export const GOOGLE_VOICES: readonly VoiceDef[] = Object.freeze([
  ...GV.map(([v, style, gender, id, en]) => ({ id: `google:chirp3-hd:${v}`, provider: 'google' as const, name: `${v} HD (Google Cloud)`, gender, traits: { id: [id, 'natural'], en: [en, 'natural'] }, languages: ['id', 'en'], model: 'chirp3-hd', voice: v, cloud: true,
    supports: { speed: true, pitch: false, style: false }, usdPer1kChars: 0.03, naturalness: 8.5, note: { id: `Google Cloud Chirp 3 HD, gaya: ${style}. 1 juta karakter pertama per bulan gratis.`, en: `Google Cloud Chirp 3 HD, style: ${style}. The first 1M characters per month are free.` } })),
  ...([['A', 'female'], ['B', 'male'], ['C', 'male'], ['D', 'female']] as const).map(([v, gender]) => ({ id: `google:wavenet:${v}`, provider: 'google' as const, name: `WaveNet ${v} (Google Cloud)`, gender, traits: { id: ['jelas', 'formal'], en: ['clear', 'formal'] }, languages: ['id'], model: 'wavenet', voice: v, cloud: true,
    supports: { speed: true, pitch: true, style: false }, usdPer1kChars: 0.004, naturalness: 6.5, note: { id: 'Google Cloud WaveNet (harga per halaman Google).', en: 'Google Cloud WaveNet (price per Google\'s page).' } })),
] satisfies VoiceDef[]);

// ───────────────────────────── ElevenLabs ─────────────────────────────
/** POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps (xi-api-key); voices: GET /v2/voices. */
export const ELEVENLABS_TTS = { base: 'https://api.elevenlabs.io', model: 'eleven_multilingual_v2', maxChars: 10_000, usdPer1kChars: 0.08 } as const;
/** Voice rows from GET /v2/voices (`voices[] {voice_id, name, labels{gender, age, accent, description, use_case}}`). */
export function elevenLabsVoices(raw: unknown): VoiceDef[] {
  const list = (raw as { voices?: unknown[] } | null)?.voices;
  if (!Array.isArray(list)) return [];
  const out: VoiceDef[] = [];
  for (const v of list.slice(0, 200)) {
    const x = v as { voice_id?: unknown; name?: unknown; labels?: Record<string, unknown> };
    if (typeof x.voice_id !== 'string' || !/^[A-Za-z0-9]{8,64}$/.test(x.voice_id) || typeof x.name !== 'string') continue;
    const g = String(x.labels?.['gender'] ?? '').toLowerCase();
    const words = ['description', 'age', 'use_case', 'accent'].map((k) => x.labels?.[k]).filter((s): s is string => typeof s === 'string').map((s) => s.slice(0, 40));
    out.push({ id: `elevenlabs:${ELEVENLABS_TTS.model}:${x.voice_id}`, provider: 'elevenlabs', name: x.name.slice(0, 60), gender: g === 'female' ? 'female' : g === 'male' ? 'male' : 'neutral',
      traits: { id: words, en: words }, languages: ['id', 'en'], model: ELEVENLABS_TTS.model, voice: x.voice_id, cloud: true, supports: { speed: true, pitch: false, style: true }, usdPer1kChars: ELEVENLABS_TTS.usdPer1kChars, naturalness: 8.5 });
  }
  return out;
}

/** Parses a voice id; null when malformed. */
export function parseVoiceId(id: string): { provider: VoiceProvider; modelKey?: string; variant?: string; model?: string; voice?: string } | null {
  const p = id.split(':');
  if (p[0] === 'local' && p[1] && /^[a-z0-9.-]+$/.test(p[1])) return { provider: 'local', modelKey: p[1], ...(p[2] ? { variant: p[2] } : {}) };
  if ((p[0] === 'openai' || p[0] === 'gemini' || p[0] === 'elevenlabs' || p[0] === 'azure' || p[0] === 'google') && p.length === 3 && /^[A-Za-z0-9._-]+$/.test(p[1]!) && /^[A-Za-z0-9_-]+$/.test(p[2]!)) return { provider: p[0], model: p[1]!, voice: p[2]! };
  return null;
}
/** Static catalogue (ElevenLabs voices come from the Creator's account and are appended by the Service). */
export const BUILTIN_VOICES: readonly VoiceDef[] = Object.freeze([...LOCAL_VOICES, ...OPENAI_VOICES, ...GEMINI_VOICES, ...AZURE_VOICES, ...GOOGLE_VOICES]);

/**
 * FR-268: picker order for a language — voices that can run now first, then by naturalness (cloud neural voices when connected,
 * then Supertonic, then Piper), then the provider's order. `ready` says whether a voice can run now.
 */
export function sortByNaturalness<T extends VoiceDef>(voices: readonly T[], ready: (v: T) => boolean): T[] {
  return voices.map((v, i) => ({ v, i })).sort((a, b) => Number(ready(b.v)) - Number(ready(a.v)) || (b.v.naturalness ?? 4) - (a.v.naturalness ?? 4) || a.i - b.i).map((x) => x.v);
}
/** FR-268: the voice recommended by default: the most natural one that can run now; else the most natural installable local one. */
export function recommendedVoice<T extends VoiceDef>(voices: readonly T[], ready: (v: T) => boolean, language = 'id'): T | null {
  const forLang = voices.filter((v) => v.languages.includes(language) && !v.pitch);
  const best = sortByNaturalness(forLang, ready);
  return best.find(ready) ?? best.find((v) => !v.cloud) ?? null;
}

// ───────────────────────────── pick by description ─────────────────────────────
const FEMALE = /perempuan|wanita|cewek|female|woman|ibu|feminin/i; const MALE = /laki|pria|cowok|male\b|\bman\b|bapak|maskulin/i;
const TRAIT_SYNONYMS: Array<[RegExp, string[]]> = [
  [/hangat|warm/i, ['hangat', 'warm', 'ramah', 'friendly']], [/jelas|jernih|clear/i, ['jelas', 'clear', 'jernih', 'informatif']], [/tegas|firm|percaya diri|confident|yakin/i, ['tegas', 'firm', 'percaya diri', 'confident', 'lugas']],
  [/ceria|upbeat|semangat|enerjik|energik|cepat/i, ['ceria', 'upbeat', 'enerjik', 'bersemangat', 'hidup', 'cerah']], [/tenang|calm|kalem/i, ['tenang', 'calm', 'stabil']],
  [/lembut|soft|gentle|halus/i, ['lembut', 'soft', 'gentle', 'halus']], [/berat|dalam|deep|berwibawa|wibawa/i, ['berat', 'deep', 'berwibawa']], [/muda|young|youth/i, ['muda', 'young', 'youthful']],
  [/dewasa|mature/i, ['dewasa', 'mature']], [/santai|casual|kasual/i, ['santai', 'kasual', 'casual', 'easy-going']], [/berita|news|formal/i, ['berita', 'news', 'formal', 'informatif']],
  [/natural|alami/i, ['natural']], [/cerita|story/i, ['bercerita', 'storyteller', 'ekspresif']],
];
export interface PickVoiceOptions { language?: string; /** voices that can run now (installed local / connected cloud) */ available?: (v: VoiceDef) => boolean; allowCloud?: boolean }
/** Scores every voice against a free-text description ("suara perempuan hangat", "natural, jelas, percaya diri"). Best first. */
export function rankVoices(description: string, voices: readonly VoiceDef[], o: PickVoiceOptions = {}): Array<{ voice: VoiceDef; score: number }> {
  const lang = o.language ?? 'id';
  const wantF = FEMALE.test(description), wantM = MALE.test(description);
  const wanted = TRAIT_SYNONYMS.filter(([re]) => re.test(description)).map(([, words]) => words);
  return voices.filter((v) => v.languages.includes(lang) && (o.allowCloud !== false || !v.cloud)).map((voice) => {
    let score = 0;
    if (wantF) score += voice.gender === 'female' ? 3 : voice.gender === 'neutral' ? 0.5 : -3;
    if (wantM) score += voice.gender === 'male' ? 3 : voice.gender === 'neutral' ? 0.5 : -3;
    const traits = [...voice.traits.id, ...voice.traits.en].map((s) => s.toLowerCase());
    for (const group of wanted) if (group.some((w) => traits.includes(w))) score += 2;
    if (/natural|alami|hangat|warm/i.test(description) && voice.cloud) score += 1;          // cloud voices sound more natural than the news-reader Piper voice
    if (o.available) score += o.available(voice) ? 4 : -100;
    if (voice.id.endsWith(':deep') || voice.id.endsWith(':bright')) score -= 0.25;          // a variant only wins on its trait
    score += (voice.naturalness ?? 4) * 0.15;                                                // FR-268: between equals, the more natural voice
    return { voice, score };
  }).sort((a, b) => b.score - a.score || a.voice.id.localeCompare(b.voice.id));
}
export const pickVoice = (description: string, voices: readonly VoiceDef[], o: PickVoiceOptions = {}): VoiceDef | null => rankVoices(description, voices, o)[0]?.voice ?? null;
