// Narrator voices (FR-246, ADR-035): one catalogue of local voices (sherpa-onnx / Piper, offline) and cloud voices through the
// Creator's own keys (OpenAI and Google connections of the Providers screen; ElevenLabs with its own key stored here, sealed
// like provider keys). Cloud calls go through the egress module's `tts` purpose (SEC-135: fixed hosts, no redirects, 40 MB cap,
// Private Mode → EM-8202 before any DNS lookup). Request / response shapes follow each provider's docs (read 2026-10-28,
// LOCAL_AI_MODELS §2.2a); the keys are decrypted only for the call and never logged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EmError } from '@expertmotion/shared';
import { AZURE_TTS, BUILTIN_VOICES, ELEVENLABS_TTS, GEMINI_TTS, GOOGLE_TTS, OPENAI_TTS, azureVoiceName, elevenLabsVoices, encodeWav, estimateVoiceCostUsd, googleVoiceName, parseVoiceId, rankVoices, recommendedVoice, sortByNaturalness, wordsFromCharAlignment,
  type RecognisedToken, type VoiceDef } from '@expertmotion/models';
import type { ServiceContext } from '../context.js';
import { createSecretBox, secretHint, type SecretBox } from '../s3/crypto.js';
import { normalizeKey } from '../s3/keys.js';
import { em } from './common.js';
import { modelsServiceOf } from './models-service.js';

export type VoiceAvailability = 'ready' | 'model-missing' | 'private-mode' | 'no-connection';
export interface VoiceDto extends VoiceDef { availability: VoiceAvailability; installed: boolean; /** FR-268: the one voice recommended by default */ recommended?: true }
/** FR-269: voice-only keys stored here (sealed like provider keys): ElevenLabs, Azure AI Speech (key + region), Google Cloud TTS. */
export type VoiceKeyProvider = 'elevenlabs' | 'azure' | 'google-cloud';
/** Azure regions are short lowercase words ("southeastasia", "eastus2"); anything else is refused before a request. */
export const AZURE_REGION_RE = /^[a-z][a-z0-9]{2,30}$/;
export interface CloudTtsResult { audio: Buffer; ext: 'wav' | 'mp3'; tokens: RecognisedToken[] | null; chars: number; usd: number }

const boxes = new WeakMap<ServiceContext, { provider: SecretBox; voice: SecretBox }>();
const box = (ctx: ServiceContext) => { let b = boxes.get(ctx); if (!b) { b = { provider: createSecretBox(ctx.cfg.dbKeyHex), voice: createSecretBox(ctx.cfg.dbKeyHex, 'voice-secrets') }; boxes.set(ctx, b); } return b; };
const elCache = new WeakMap<ServiceContext, { at: number; voices: VoiceDef[] }>();

/** OpenAI / Google key of a saved Provider Connection (a `valid` one first, never an `invalid` one). */
function providerKey(ctx: ServiceContext, provider: 'openai' | 'google'): string | null {
  const r = ctx.db.prepare("SELECT id, secret_enc FROM provider_connections WHERE provider = ? AND status != 'invalid' ORDER BY (status = 'valid') DESC, updated_at DESC LIMIT 1").get(provider) as { id: string; secret_enc: Buffer } | undefined;
  if (!r) return null;
  try { return box(ctx).provider.open(r.secret_enc, `provider_connections:${r.id}`); } catch { return null; }
}
function voiceKey(ctx: ServiceContext, provider: VoiceKeyProvider): string | null {
  let r: { secret_enc: Buffer } | undefined;
  try { r = ctx.db.prepare('SELECT secret_enc FROM voice_keys WHERE provider = ?').get(provider) as typeof r; } catch { return null; }
  if (!r) return null;
  try { return box(ctx).voice.open(r.secret_enc, `voice_keys:${provider}`); } catch { return null; }
}
const elevenKey = (ctx: ServiceContext): string | null => voiceKey(ctx, 'elevenlabs');
/** Azure: stored as "<region>|<key>". */
function azureKey(ctx: ServiceContext): { region: string; key: string } | null {
  const v = voiceKey(ctx, 'azure'); if (!v) return null;
  const i = v.indexOf('|'); const region = v.slice(0, i), key = v.slice(i + 1);
  return i > 0 && AZURE_REGION_RE.test(region) && key ? { region, key } : null;
}
const xmlText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export class VoicesService {
  constructor(private readonly ctx: ServiceContext) {}

  connected(provider: VoiceDef['provider']): boolean {
    if (provider === 'local') return true;
    if (provider === 'openai') return providerKey(this.ctx, 'openai') !== null;
    if (provider === 'gemini') return providerKey(this.ctx, 'google') !== null;
    if (provider === 'azure') return azureKey(this.ctx) !== null;
    if (provider === 'google') return voiceKey(this.ctx, 'google-cloud') !== null;
    return elevenKey(this.ctx) !== null;
  }
  /** R-215: every voice for a language with its availability (installed model / connection / Private Mode). */
  async list(language: 'id' | 'en' = 'id', o: { refresh?: boolean } = {}): Promise<VoiceDto[]> {
    const priv = this.ctx.settings.get().privateMode;
    const models = modelsServiceOf(this.ctx);
    const el = this.connected('elevenlabs') && !priv ? await this.elevenLabsList(o.refresh === true).catch(() => []) : [];
    const out: VoiceDto[] = [];
    // every other installed / registered voice model (a signed-registry addition, test registries) is a plain local voice too
    const extra: VoiceDef[] = models.defs().filter((d) => d.task === 'tts' && !BUILTIN_VOICES.some((v) => v.modelKey === d.key)).map((d) => ({
      id: `local:${d.key}`, provider: 'local', name: d.label, gender: 'neutral', traits: { id: [], en: [] }, languages: d.languages?.length ? d.languages : ['id', 'en'], modelKey: d.key, cloud: false,
      supports: { speed: true, pitch: true, style: false } }));
    for (const v of [...BUILTIN_VOICES, ...extra, ...el]) {
      if (!v.languages.includes(language)) continue;
      if (!v.cloud) {
        if (!models.def(v.modelKey!)) continue;
        const installed = await models.isInstalled(v.modelKey!);
        out.push({ ...v, installed, availability: installed ? 'ready' : 'model-missing' });
      } else out.push({ ...v, installed: true, availability: priv ? 'private-mode' : this.connected(v.provider) ? 'ready' : 'no-connection' });
    }
    // FR-268: most natural first among what can run now (cloud neural voices when connected), one recommended voice
    const ready = (v: VoiceDto) => v.availability === 'ready';
    const sorted = sortByNaturalness(out, ready);
    const rec = recommendedVoice(sorted, ready, language);
    return sorted.map((v) => (rec && v.id === rec.id ? { ...v, recommended: true as const } : v));
  }
  async resolve(idOrDescription: string, language: 'id' | 'en'): Promise<VoiceDto | null> {
    const all = await this.list(language);
    const exact = all.find((v) => v.id === idOrDescription) ?? all.find((v) => !v.cloud && v.modelKey === idOrDescription && !v.pitch);
    if (exact) return exact;
    if (parseVoiceId(idOrDescription)) return null;
    // a description ("suara perempuan hangat") or a stray name: the best voice that can run now, else the best one at all
    const ranked = rankVoices(idOrDescription, all, { language, available: (v) => (v as VoiceDto).availability === 'ready' });
    const top = ranked[0]?.voice as VoiceDto | undefined;
    // nothing can run yet: an installable local voice beats a cloud voice without a connection (one-click install, FR-252)
    if (top && top.availability !== 'ready') return (ranked.find((r) => !r.voice.cloud)?.voice as VoiceDto | undefined) ?? top;
    return top ?? null;
  }

  private async elevenLabsList(refresh: boolean): Promise<VoiceDef[]> {
    const c = elCache.get(this.ctx);
    if (c && !refresh && Date.now() - c.at < 10 * 60_000) return c.voices;
    const key = elevenKey(this.ctx); if (!key) return [];
    const res = await this.ctx.egress.for('tts')(`${ELEVENLABS_TTS.base}/v2/voices?page_size=100`, { method: 'GET', headers: { 'xi-api-key': key } });
    if (res.status !== 200) throw this.refused('elevenlabs', res.status, await res.text().catch(() => ''));
    const voices = elevenLabsVoices(await res.json());
    elCache.set(this.ctx, { at: Date.now(), voices });
    return voices;
  }
  /** R-217: stores / replaces the ElevenLabs key after a check against GET /v1/user (or /v2/voices for scoped keys). */
  async setElevenLabsKey(raw: string): Promise<{ provider: 'elevenlabs'; secretHint: string; status: 'valid' }> {
    if (this.ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the ElevenLabs key was not checked.', { details: { action: 'ElevenLabs key' } });
    const key = normalizeKey(raw);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(key)) throw em('EM-9002', 'Invalid request: this does not look like an ElevenLabs key.', { status: 400, path: 'body.key' });
    const f = this.ctx.egress.for('tts');
    let res = await f(`${ELEVENLABS_TTS.base}/v1/user`, { method: 'GET', headers: { 'xi-api-key': key } });
    if (res.status !== 200) res = await f(`${ELEVENLABS_TTS.base}/v2/voices?page_size=1`, { method: 'GET', headers: { 'xi-api-key': key } });
    if (res.status !== 200) throw this.refused('elevenlabs', res.status, await res.text().catch(() => ''));
    const now = this.ctx.now();
    this.ctx.db.prepare(`INSERT INTO voice_keys (provider, secret_enc, secret_hint, created_at, updated_at) VALUES ('elevenlabs', ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET secret_enc = excluded.secret_enc, secret_hint = excluded.secret_hint, updated_at = excluded.updated_at`).run(box(this.ctx).voice.seal(key, 'voice_keys:elevenlabs'), secretHint(key), now, now);
    elCache.delete(this.ctx);
    return { provider: 'elevenlabs', secretHint: secretHint(key), status: 'valid' };
  }
  removeElevenLabsKey(): void { this.removeVoiceKey('elevenlabs'); }
  elevenLabsKeyHint(): string | null { return this.voiceKeyHint('elevenlabs'); }
  removeVoiceKey(provider: VoiceKeyProvider): void { this.ctx.db.prepare('DELETE FROM voice_keys WHERE provider = ?').run(provider); if (provider === 'elevenlabs') elCache.delete(this.ctx); }
  voiceKeyHint(provider: VoiceKeyProvider): string | null { try { return (this.ctx.db.prepare('SELECT secret_hint FROM voice_keys WHERE provider = ?').get(provider) as { secret_hint: string } | undefined)?.secret_hint ?? null; } catch { return null; } }
  /** FR-269 keys: where each is stored and what is shown (hint only), for the voice picker. */
  voiceKeys(): Record<VoiceKeyProvider, { hint: string | null; region?: string }> {
    const az = azureKey(this.ctx);
    return { elevenlabs: { hint: this.voiceKeyHint('elevenlabs') }, azure: { hint: this.voiceKeyHint('azure'), ...(az ? { region: az.region } : {}) }, 'google-cloud': { hint: this.voiceKeyHint('google-cloud') } };
  }
  private storeVoiceKey(provider: VoiceKeyProvider, secret: string, hint: string): void {
    const now = this.ctx.now();
    this.ctx.db.prepare(`INSERT INTO voice_keys (provider, secret_enc, secret_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(provider) DO UPDATE SET secret_enc = excluded.secret_enc, secret_hint = excluded.secret_hint, updated_at = excluded.updated_at`).run(provider, box(this.ctx).voice.seal(secret, `voice_keys:${provider}`), hint, now, now);
  }
  /**
   * R-217b (FR-269): Azure AI Speech key + region, checked with GET https://<region>.tts.speech.microsoft.com/cognitiveservices/voices/list
   * (401 = wrong key or wrong region). Stored sealed as "<region>|<key>"; only the hint is returned.
   */
  async setAzureKey(raw: string, regionRaw: string): Promise<{ provider: 'azure'; secretHint: string; region: string; status: 'valid' }> {
    if (this.ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the Azure key was not checked.', { details: { action: 'Azure key' } });
    const key = normalizeKey(raw), region = regionRaw.trim().toLowerCase().replace(/\s+/g, '');
    if (!AZURE_REGION_RE.test(region)) throw em('EM-9002', 'Invalid request: this is not an Azure region name (e.g. southeastasia).', { status: 400, path: 'body.region' });
    if (!/^[A-Za-z0-9]{20,128}$/.test(key)) throw em('EM-9002', 'Invalid request: this does not look like an Azure Speech key.', { status: 400, path: 'body.key' });
    const res = await this.ctx.egress.for('tts')(`https://${region}.${AZURE_TTS.hostSuffix}${AZURE_TTS.listPath}`, { method: 'GET', headers: { 'Ocp-Apim-Subscription-Key': key } });
    if (res.status !== 200) throw this.refused('azure', res.status, await res.text().catch(() => ''));
    void res.body?.cancel().catch(() => undefined);
    this.storeVoiceKey('azure', `${region}|${key}`, secretHint(key));
    return { provider: 'azure', secretHint: secretHint(key), region, status: 'valid' };
  }
  /**
   * R-217c (FR-269): Google Cloud Text-to-Speech API key, checked with GET https://texttospeech.googleapis.com/v1/voices?languageCode=id-ID
   * (an invalid key: 400 API_KEY_INVALID; the API not enabled on the key's project: 403).
   */
  async setGoogleCloudKey(raw: string): Promise<{ provider: 'google-cloud'; secretHint: string; status: 'valid' }> {
    if (this.ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the Google Cloud key was not checked.', { details: { action: 'Google Cloud key' } });
    const key = normalizeKey(raw);
    if (!/^[A-Za-z0-9_-]{30,128}$/.test(key)) throw em('EM-9002', 'Invalid request: this does not look like a Google Cloud API key.', { status: 400, path: 'body.key' });
    const res = await this.ctx.egress.for('tts')(`${GOOGLE_TTS.voicesUrl}?languageCode=id-ID`, { method: 'GET', headers: { 'x-goog-api-key': key } });
    if (res.status !== 200) throw this.refused('google', res.status === 400 ? 401 : res.status, await res.text().catch(() => ''));
    void res.body?.cancel().catch(() => undefined);
    this.storeVoiceKey('google-cloud', key, secretHint(key));
    return { provider: 'google-cloud', secretHint: secretHint(key), status: 'valid' };
  }

  private refused(provider: string, status: number, body: string): EmError {
    // never echo the body: providers sometimes quote the key prefix. Only a short reason word is kept.
    const reason = status === 401 || status === 403 ? 'key' : status === 429 ? (/quota|credit|billing|exhaust|limit/i.test(body) ? 'quota' : 'rate-limit') : status >= 500 ? 'server' : 'request';
    return em('EM-7112', `The ${provider} voice was refused (HTTP ${status}).`, { status: 502, details: { provider, httpStatus: status, reason } });
  }

  /** One cloud synthesis call. Audio comes back as WAV (OpenAI wav, Gemini PCM/WAV wrapped) or MP3 (ElevenLabs); the caller converts. */
  async synthesizeCloud(voice: VoiceDef, text: string, o: { language: 'id' | 'en'; speed?: number; style?: string; signal?: AbortSignal }): Promise<CloudTtsResult> {
    const ctx = this.ctx;
    if (ctx.settings.get().privateMode) throw em('EM-8202', 'Private Mode is on, so the cloud voice was not used.', { details: { action: 'cloud voice' } });
    const f = ctx.egress.for('tts');
    const chars = [...text].length; const usd = estimateVoiceCostUsd(voice, text);
    const langWord = o.language === 'id' ? 'Bahasa Indonesia' : 'English';
    const signal = o.signal ? { signal: o.signal } : {};
    if (voice.provider === 'openai') {
      const key = providerKey(ctx, 'openai'); if (!key) throw em('EM-7113', 'Connect OpenAI on the Providers screen to use this voice.', { details: { provider: 'openai', reason: 'no-connection' } });
      if (chars > OPENAI_TTS.maxChars) throw em('EM-7106', `This voice accepts up to ${OPENAI_TTS.maxChars} characters at a time.`, { details: { chars, limit: OPENAI_TTS.maxChars } });
      const body = { model: voice.model ?? OPENAI_TTS.model, input: text, voice: voice.voice, response_format: 'wav', ...(o.speed && o.speed !== 1 ? { speed: Math.max(0.25, Math.min(4, o.speed)) } : {}),
        ...(voice.model === 'gpt-4o-mini-tts' ? { instructions: `Speak natural ${langWord}${o.style ? `, ${o.style}` : ''}. Read every word exactly as written.` } : {}) };
      const res = await f(OPENAI_TTS.url, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...signal });
      if (res.status !== 200) throw this.refused('openai', res.status, await res.text().catch(() => ''));
      return { audio: Buffer.from(await res.arrayBuffer()), ext: 'wav', tokens: null, chars, usd };
    }
    if (voice.provider === 'gemini') {
      const key = providerKey(ctx, 'google'); if (!key) throw em('EM-7113', 'Connect Google Gemini on the Providers screen to use this voice.', { details: { provider: 'google', reason: 'no-connection' } });
      const pace = o.speed && o.speed > 1.05 ? 'a slightly fast pace' : o.speed && o.speed < 0.95 ? 'a slightly slow pace' : 'a natural pace';
      const style = [o.style, pace].filter(Boolean).join(', ');
      const call = async (model: string, legacy: boolean) => {
        const parts = legacy ? [{ text: `Say in ${langWord}, ${style}: ${text}` }] : [{ text, speech_metadata: { style: `${langWord}, ${style}` } }];
        const voiceConfig = legacy ? { prebuiltVoiceConfig: { voiceName: voice.voice } } : { voice: voice.voice };
        return f(`${GEMINI_TTS.base}/${model}:generateContent`, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig } } }), ...signal });
      };
      let res = await call(voice.model ?? GEMINI_TTS.model, false);
      if (res.status === 400 || res.status === 404) res = await call(GEMINI_TTS.fallbackModel, true);   // request shape of the older preview models
      if (res.status !== 200) throw this.refused('gemini', res.status, await res.text().catch(() => ''));
      const j = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> };
      const inline = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
      if (!inline?.data) throw em('EM-7103', 'The voice provider returned no audio.', { details: { provider: 'gemini' } });
      const raw = Buffer.from(inline.data, 'base64');
      const isWav = raw.subarray(0, 4).toString('latin1') === 'RIFF';
      const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1] ?? 24000);
      const audio = isWav ? raw : Buffer.from(encodeWav({ audioFormat: 1, channels: 1, sampleRate: rate, bitsPerSample: 16, blockAlign: 2 }, raw));
      return { audio, ext: 'wav', tokens: null, chars, usd };
    }
    if (voice.provider === 'azure') {
      // FR-269: SSML body, 24 kHz 16-bit mono RIFF back; speed / pitch through <prosody>; no word timings over REST
      const az = azureKey(ctx); if (!az) throw em('EM-7113', 'Add your Azure AI Speech key to use this voice.', { details: { provider: 'azure', reason: 'no-connection' } });
      if (chars > AZURE_TTS.maxChars) throw em('EM-7106', `This voice accepts up to ${AZURE_TTS.maxChars} characters at a time.`, { details: { chars, limit: AZURE_TTS.maxChars } });
      const lang = o.language === 'en' ? 'en-US' : 'id-ID';
      const name = azureVoiceName(voice.model ?? 'neural', voice.voice ?? 'id-ID-Gadis');
      const rate = o.speed && o.speed !== 1 ? `${Math.round((Math.max(0.5, Math.min(2, o.speed)) - 1) * 100)}%` : null;
      const inner = rate ? `<prosody rate="${rate.startsWith('-') ? rate : `+${rate}`}">${xmlText(text)}</prosody>` : xmlText(text);
      const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}"><voice name="${xmlText(name)}"><lang xml:lang="${lang}">${inner}</lang></voice></speak>`;
      const res = await f(`https://${az.region}.${AZURE_TTS.hostSuffix}${AZURE_TTS.path}`, { method: 'POST', headers: { 'Ocp-Apim-Subscription-Key': az.key, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': AZURE_TTS.format, 'User-Agent': 'Expertmotion' }, body: ssml, ...signal });
      if (res.status !== 200) throw this.refused('azure', res.status, await res.text().catch(() => ''));
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.subarray(0, 4).toString('latin1') !== 'RIFF') throw em('EM-7103', 'The voice provider returned no audio.', { details: { provider: 'azure' } });
      return { audio, ext: 'wav', tokens: null, chars, usd };
    }
    if (voice.provider === 'google') {
      // FR-269: text:synthesize, LINEAR16 (WAV header included), base64 audioContent; ≤ 5,000 bytes of input
      const key = voiceKey(ctx, 'google-cloud'); if (!key) throw em('EM-7113', 'Add your Google Cloud Text-to-Speech key to use this voice.', { details: { provider: 'google', reason: 'no-connection' } });
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > GOOGLE_TTS.maxBytes) throw em('EM-7106', `This voice accepts up to ${GOOGLE_TTS.maxBytes} bytes of text at a time.`, { details: { chars, limit: GOOGLE_TTS.maxBytes } });
      const body = { input: { text }, voice: { languageCode: o.language === 'en' ? 'en-US' : 'id-ID', name: googleVoiceName(voice.model ?? 'chirp3-hd', voice.voice ?? 'Kore', o.language) },
        audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000, ...(o.speed && o.speed !== 1 ? { speakingRate: Math.max(0.25, Math.min(2, o.speed)) } : {}) } };
      const res = await f(GOOGLE_TTS.url, { method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...signal });
      if (res.status !== 200) throw this.refused('google', res.status === 400 && /API_KEY_INVALID/.test(await res.clone().text().catch(() => '')) ? 401 : res.status, await res.text().catch(() => ''));
      const j = await res.json() as { audioContent?: string };
      if (!j.audioContent) throw em('EM-7103', 'The voice provider returned no audio.', { details: { provider: 'google' } });
      const raw = Buffer.from(j.audioContent, 'base64');
      const audio = raw.subarray(0, 4).toString('latin1') === 'RIFF' ? raw : Buffer.from(encodeWav({ audioFormat: 1, channels: 1, sampleRate: 24000, bitsPerSample: 16, blockAlign: 2 }, raw));
      return { audio, ext: 'wav', tokens: null, chars, usd };
    }
    const key = elevenKey(ctx); if (!key) throw em('EM-7113', 'Add your ElevenLabs key to use this voice.', { details: { provider: 'elevenlabs', reason: 'no-connection' } });
    if (chars > ELEVENLABS_TTS.maxChars) throw em('EM-7106', `This voice accepts up to ${ELEVENLABS_TTS.maxChars} characters at a time.`, { details: { chars, limit: ELEVENLABS_TTS.maxChars } });
    const body = { text, model_id: voice.model ?? ELEVENLABS_TTS.model, language_code: o.language,
      voice_settings: { stability: 0.5, similarity_boost: 0.75, style: o.style ? 0.3 : 0, use_speaker_boost: true, ...(o.speed ? { speed: Math.max(0.7, Math.min(1.2, o.speed)) } : {}) } };
    const res = await f(`${ELEVENLABS_TTS.base}/v1/text-to-speech/${encodeURIComponent(voice.voice ?? '')}/with-timestamps?output_format=mp3_44100_128`, { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...signal });
    if (res.status !== 200) throw this.refused('elevenlabs', res.status, await res.text().catch(() => ''));
    const j = await res.json() as { audio_base64?: string; alignment?: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } | null };
    if (!j.audio_base64) throw em('EM-7103', 'The voice provider returned no audio.', { details: { provider: 'elevenlabs' } });
    const tokens = j.alignment && Array.isArray(j.alignment.characters) ? wordsFromCharAlignment(text, j.alignment) : null;
    return { audio: Buffer.from(j.audio_base64, 'base64'), ext: 'mp3', tokens, chars, usd };
  }

  /** Preview cache file for a voice (`<models>/voice-previews/<sha>.wav`). */
  previewPath(voiceId: string, language: string): string {
    const h = crypto.createHash('sha256').update(`${voiceId}|${language}|v1`).digest('hex').slice(0, 32);
    const dir = path.join(this.ctx.paths.models, 'voice-previews'); fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${h}.wav`);
  }
}
export const PREVIEW_TEXT = { id: 'Halo! Ini contoh suara narator untuk videomu. Energi bersih, ekonomi tumbuh, dan cerita yang jelas.', en: 'Hi! This is a sample of the narrator voice for your video.' } as const;

const services = new WeakMap<ServiceContext, VoicesService>();
export const voicesServiceOf = (ctx: ServiceContext): VoicesService => { let s = services.get(ctx); if (!s) { s = new VoicesService(ctx); services.set(ctx, s); } return s; };
