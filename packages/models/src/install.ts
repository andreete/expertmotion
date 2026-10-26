// Model Manager core operations on disk: install (download all files + manifest), verify, remove, paths
// (docs/LOCAL_AI_MODELS.md §4.1 storage layout, §4.3 first-use flow, §4.4 other operations).
import { appendFile, copyFile, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { emError } from './errors.js';
import { downloadFile, sha256File, type DownloadOptions } from './download.js';
import { manifestFromRegistry, readManifest, writeManifest, type ModelManifestT, type VerifiedFile } from './manifest.js';
import { isPinned, type ModelDef } from './registry.js';

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
function segment(s: string): string {
  if (!SAFE_SEGMENT.test(s) || s === '.' || s === '..') throw new RangeError(`unsafe path segment ${s}`);
  return s;
}

/** `<modelsDir>/<engine>/<model>/` */
export function modelDir(modelsDir: string, def: ModelDef): string {
  return join(resolve(modelsDir), segment(def.engine), segment(def.key));
}
export function modelFilePath(modelsDir: string, def: ModelDef, fileName: string): string {
  return join(modelDir(modelsDir, def), segment(fileName));
}
/** `<modelsDir>/.partial/<modelId>/<file>.part` */
export function partPath(modelsDir: string, def: ModelDef, fileName: string): string {
  return join(resolve(modelsDir), '.partial', segment(def.key), `${segment(fileName)}.part`);
}

/** LOCAL_AI_MODELS §4.3 step 2: Σ bytes × 1.1 + 500 MB. */
export const requiredInstallBytes = (remainingBytes: number): number => Math.ceil(remainingBytes * 1.1) + 500_000_000;

export interface InstallOptions extends Omit<DownloadOptions, 'onProgress'> {
  modelsDir: string;
  now?: () => number;
  onProgress?: (p: { modelId: string; file: string; bytesDone: number; bytesTotal: number; fileBytesDone: number; bps: number }) => void;
}

/**
 * Installs a registry model: Private-Mode precheck (EM-7006), disk precheck (EM-7004), one file at a time through
 * downloadFile (resume, hash), Piper tokens.txt derivation, then manifest.json (state 'installed') written last.
 */
export async function installModel(def: ModelDef, opts: InstallOptions): Promise<ModelManifestT> {
  if (def.availability !== 'download') throw new RangeError(`model ${def.key} is not downloadable (${def.availability})`);
  if (!isPinned(def)) throw emError('EM-7003', `${def.key} has no pinned checksums yet; refusing to download`, { modelId: def.key, reason: 'unpinned' });
  if (opts.privateMode?.()) throw emError('EM-7006', 'Downloads are paused while Private Mode is on', { modelId: def.key, reason: 'private' });
  const now = opts.now ?? Date.now;
  const verifiedAt = (): string => new Date(now()).toISOString();

  // Remaining bytes: skip files already in place with a matching sidecar; subtract partial bytes.
  const done = new Map<string, VerifiedFile>();
  let remaining = 0;
  for (const f of def.files) {
    const dest = modelFilePath(opts.modelsDir, def, f.name);
    const sidecar = await readFile(`${dest}.sha256`, 'utf8').then((s) => s.trim(), () => null);
    const size = await stat(dest).then((s) => s.size, () => -1);
    if (sidecar === f.sha256 && size >= 0) { done.set(f.name, { name: f.name, bytes: size, sha256: f.sha256, url: f.url, verifiedAt: verifiedAt() }); continue; }
    const part = await stat(partPath(opts.modelsDir, def, f.name)).then((s) => s.size, () => 0);
    remaining += Math.max(0, f.bytes - part);
  }
  const free = await opts.freeBytes(resolve(opts.modelsDir));
  const required = requiredInstallBytes(remaining);
  if (free < required) throw emError('EM-7004', `${def.key} needs more free disk`, { modelId: def.key, requiredBytes: required, freeBytes: free });

  const total = def.files.reduce((a, f) => a + f.bytes, 0);
  let before = [...done.values()].reduce((a, f) => a + f.bytes, 0);
  for (const f of def.files) {
    if (done.has(f.name)) continue;
    const r = await downloadFile(
      { name: f.name, url: f.url, bytes: f.bytes, bytesExact: f.bytesExact, sha256: f.sha256, modelKey: def.key },
      { partPath: partPath(opts.modelsDir, def, f.name), destPath: modelFilePath(opts.modelsDir, def, f.name) },
      { ...opts, onProgress: (p) => opts.onProgress?.({ modelId: def.key, file: p.file, bytesDone: before + p.bytesDone, bytesTotal: total, fileBytesDone: p.bytesDone, bps: p.bps }) },
    );
    done.set(f.name, { name: f.name, bytes: r.bytes, sha256: r.sha256, url: f.url, verifiedAt: verifiedAt() });
    before += r.bytes;
  }
  let extra = 0;
  if (def.postInstall === 'piper-tokens') {
    // tokens.txt + the sherpa-onnx copy of the voice (the upstream .onnx stays byte-identical for verification)
    const prepared = await preparePiperVoice(modelDir(opts.modelsDir, def));
    extra += prepared.extraBytes;
  }
  await rm(join(resolve(opts.modelsDir), '.partial', segment(def.key)), { recursive: true, force: true });
  const files = def.files.map((f) => done.get(f.name)!);
  const manifest = manifestFromRegistry(def, files, { installedAt: verifiedAt(), sizeOnDiskBytes: files.reduce((a, f) => a + f.bytes, 0) + extra });
  await writeManifest(modelDir(opts.modelsDir, def), manifest);
  return manifest;
}

/**
 * sherpa-onnx `tokens.txt` for a Piper voice: one `<symbol> <id>` line per entry of the voice config's `phoneme_id_map`
 * (the same derivation as sherpa-onnx's Piper export script). Deterministic, no network.
 */
export function piperTokensFromConfig(configJson: string): string {
  const cfg = JSON.parse(configJson) as { phoneme_id_map?: Record<string, unknown> };
  const map = cfg.phoneme_id_map;
  if (!map || typeof map !== 'object') throw new SyntaxError('Piper config has no phoneme_id_map');
  const lines: string[] = [];
  for (const [sym, ids] of Object.entries(map)) {
    const id = Array.isArray(ids) ? ids[0] : ids;
    if (typeof id !== 'number' || !Number.isInteger(id)) throw new SyntaxError(`Piper phoneme ${JSON.stringify(sym)} has no integer id`);
    lines.push(`${sym} ${id}`);
  }
  return `${lines.join('\n')}\n`;
}

// --- Piper voices for sherpa-onnx -------------------------------------------------------------------------------
// sherpa-onnx loads a VITS/Piper model only when the .onnx carries its metadata (model_type, comment=piper, language,
// voice, has_espeak, n_speakers, sample_rate); without it the engine exits 255 with "'sample_rate' does not exist in the
// metadata" (reproduced 2026-10-26 with the official v1.13.8 build and the pinned rhasspy files). The rhasspy/piper-voices
// files have no such metadata, so we derive a copy with the same key/values sherpa-onnx's own Piper export script adds.

/** File name of the sherpa-onnx-ready copy of a Piper voice, next to the upstream files. */
export const PIPER_SHERPA_MODEL = 'sherpa-model.onnx';

/** The metadata sherpa-onnx's Piper export adds (scripts/piper in k2-fsa/sherpa-onnx), read from the voice's .onnx.json. */
export function piperSherpaMetadata(configJson: string): Record<string, string> {
  const cfg = JSON.parse(configJson) as { audio?: { sample_rate?: unknown }; espeak?: { voice?: unknown }; num_speakers?: unknown; language?: { name_english?: unknown; code?: unknown } };
  const rate = cfg.audio?.sample_rate; const voice = cfg.espeak?.voice;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate <= 0) throw new SyntaxError('Piper config has no audio.sample_rate');
  if (typeof voice !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(voice)) throw new SyntaxError('Piper config has no espeak.voice');
  const speakers = typeof cfg.num_speakers === 'number' && Number.isInteger(cfg.num_speakers) && cfg.num_speakers > 0 ? cfg.num_speakers : 1;
  const language = typeof cfg.language?.name_english === 'string' ? cfg.language.name_english : typeof cfg.language?.code === 'string' ? cfg.language.code : voice;
  return { model_type: 'vits', comment: 'piper', language, voice, has_espeak: '1', n_speakers: String(speakers), sample_rate: String(rate) };
}

const varint = (n: number): number[] => { const out: number[] = []; let v = n; while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); } out.push(v); return out; };
const lenField = (field: number, bytes: Uint8Array): Uint8Array => Uint8Array.from([...varint((field << 3) | 2), ...varint(bytes.byteLength), ...bytes]);
/**
 * Serialized ONNX `ModelProto.metadata_props` entries (field 14, `StringStringEntryProto {key = 1, value = 2}`).
 * Protobuf parsers merge fields in any order and concatenate repeated fields, so appending these bytes to a model file
 * adds the entries without re-encoding the (large) graph.
 */
export function onnxMetadataBytes(meta: Readonly<Record<string, string>>): Uint8Array {
  const enc = new TextEncoder();
  const parts = Object.entries(meta).map(([k, v]) => {
    const entry = new Uint8Array([...lenField(1, enc.encode(k)), ...lenField(2, enc.encode(v))]);
    return lenField(14, entry);
  });
  const out = new Uint8Array(parts.reduce((a, p) => a + p.byteLength, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

export interface PreparedPiperVoice { modelPath: string; tokensPath: string; extraBytes: number }
/**
 * Makes a Piper voice folder usable by sherpa-onnx (idempotent; also repairs voices installed before this step existed):
 * tokens.txt from the config's phoneme_id_map, and `sherpa-model.onnx` = the upstream .onnx + sherpa metadata
 * (copy + append; never loads the model into memory). Throws EM-7108 when the folder has no Piper voice.
 */
export async function preparePiperVoice(dir: string): Promise<PreparedPiperVoice> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const json = names.find((n) => n.endsWith('.onnx.json'));
  const onnx = json ? json.slice(0, -'.json'.length) : undefined;
  if (!json || !onnx || !names.includes(onnx)) throw emError('EM-7108', 'The installed voice is incomplete', { reason: 'piper-files-missing', dir: 'model' });
  const config = await readFile(join(dir, json), 'utf8');
  const tokens = piperTokensFromConfig(config);
  const tokensPath = join(dir, 'tokens.txt');
  if ((await readFile(tokensPath, 'utf8').catch(() => null)) !== tokens) await writeFile(tokensPath, tokens, 'utf8');
  const meta = onnxMetadataBytes(piperSherpaMetadata(config));
  const modelPath = join(dir, PIPER_SHERPA_MODEL);
  const srcSize = (await stat(join(dir, onnx))).size;
  const have = await stat(modelPath).then((s) => s.size, () => -1);
  if (have !== srcSize + meta.byteLength) {
    const tmp = `${modelPath}.tmp`;
    await copyFile(join(dir, onnx), tmp);
    await appendFile(tmp, meta);
    await rename(tmp, modelPath);
  }
  return { modelPath, tokensPath, extraBytes: Buffer.byteLength(tokens) + srcSize + meta.byteLength };
}

export interface VerifyResult { ok: boolean; missing: string[]; mismatched: string[] }

/** Re-hash all files against the registry (Diagnostics, SEC-075 full check). A failure maps to EM-7108 in the service. */
export async function verifyInstalled(def: ModelDef, modelsDir: string): Promise<VerifyResult> {
  const missing: string[] = []; const mismatched: string[] = [];
  const manifest = await readManifest(modelDir(modelsDir, def));
  if (!manifest) missing.push('manifest.json');
  for (const f of def.files) {
    const p = modelFilePath(modelsDir, def, f.name);
    const hash = await sha256File(p).catch(() => null);
    if (hash === null) missing.push(f.name); else if (hash !== f.sha256) mismatched.push(f.name);
  }
  return { ok: missing.length === 0 && mismatched.length === 0, missing, mismatched };
}

/** SEC-075 quick check: sidecars equal the registry hashes and sizes match the manifest. */
export async function quickCheckInstalled(def: ModelDef, modelsDir: string): Promise<boolean> {
  const manifest = await readManifest(modelDir(modelsDir, def));
  if (!manifest || manifest.state !== 'installed') return false;
  for (const f of def.files) {
    const p = modelFilePath(modelsDir, def, f.name);
    const side = await readFile(`${p}.sha256`, 'utf8').then((s) => s.trim(), () => null);
    const size = await stat(p).then((s) => s.size, () => -1);
    const mf = manifest.files.find((x) => x.name === f.name);
    if (side !== f.sha256 || !mf || mf.bytes !== size) return false;
  }
  return true;
}

/** Deletes the model folder and its partial downloads. The "in use" check (EM-7104) belongs to the caller. */
export async function removeModel(def: ModelDef, modelsDir: string): Promise<void> {
  const dir = modelDir(modelsDir, def);
  if (!dir.startsWith(resolve(modelsDir) + sep)) throw new RangeError('model dir escapes modelsDir');
  await rm(dir, { recursive: true, force: true });
  await rm(join(resolve(modelsDir), '.partial', segment(def.key)), { recursive: true, force: true });
}

export interface InstalledState { key: string; manifest: ModelManifestT | null; partialBytes: number }
/** Installed manifest (or null) and partial bytes per registry model. */
export async function readInstallState(def: ModelDef, modelsDir: string): Promise<InstalledState> {
  const manifest = await readManifest(modelDir(modelsDir, def));
  let partialBytes = 0;
  for (const f of def.files) partialBytes += await stat(partPath(modelsDir, def, f.name)).then((s) => s.size, () => 0);
  return { key: def.key, manifest, partialBytes };
}
