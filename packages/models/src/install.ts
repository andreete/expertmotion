// Model Manager core operations on disk: install (download all files + manifest), verify, remove, paths
// (docs/LOCAL_AI_MODELS.md §4.1 storage layout, §4.3 first-use flow, §4.4 other operations).
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    const json = def.files.find((f) => f.name.endsWith('.onnx.json'));
    if (json) {
      const tokens = piperTokensFromConfig(await readFile(modelFilePath(opts.modelsDir, def, json.name), 'utf8'));
      await writeFile(join(modelDir(opts.modelsDir, def), 'tokens.txt'), tokens, 'utf8');
      extra += Buffer.byteLength(tokens);
    }
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
