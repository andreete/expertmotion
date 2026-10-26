// Engine Binary verification (FR-140, FR-003, SEC-061): Chrome Headless Shell, the compositor FFmpeg and the prebuilt Engine bundle.
// The bundle files and the Chrome Headless Shell / compositor executables are hashed once per launch (background, cached) against
// resources/engine-manifest.json (written by scripts/stage-desktop.mjs); preflight reuses the cached result plus cheap presence
// checks. A failure blocks rendering only (EM-3001 missing, EM-3003 damaged).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ServiceContext } from '../context.js';

export interface EngineStatus {
  ok: boolean;
  code?: 'EM-3001' | 'EM-3003';
  bundle: boolean; browser: boolean; ffmpeg: boolean;
  /** null when no manifest was shipped (development builds). */
  bundleHash: 'ok' | 'mismatch' | null;
  missing: string[];
  mismatched: string[];
}

interface ManifestFile { path: string; size: number; sha256: string }
const cache = new WeakMap<ServiceContext, Promise<{ hash: EngineStatus['bundleHash']; mismatched: string[] }>>();

/** `resources/engine-manifest.json` sits two levels above `resources/engine/bundle`. */
export const manifestPathOf = (ctx: ServiceContext): string => path.resolve(ctx.resources.engineBundle, '..', '..', 'engine-manifest.json');

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/**
 * Extension-less executables of Linux and macOS (DEPLOYMENT_AND_PACKAGING §17): Chrome Headless Shell and its crash handler, the
 * compositor, FFmpeg/ffprobe and the Generator Engine Binaries. Versioned shared objects (`libwhisper.so.1`) match the `.so` rule.
 */
const ENGINE_EXECUTABLE_NAMES = /^(chrome-headless-shell|chrome_crashpad_handler|remotion|ffmpeg|ffprobe|whisper-cli|sherpa-onnx-offline-tts|sd-cli|python3?)$/;
/** SEC-061: executables under engine/chrome and engine/compositor (same rule as apps/desktop/src/lib/integrity.ts). */
export function isEngineExecutable(file: string): boolean {
  const name = file.split(/[\\/]/).pop() ?? '';
  return /\.(exe|dll|node|dylib)$/i.test(name) || /\.so(\.\d+)*$/.test(name) || ENGINE_EXECUTABLE_NAMES.test(name);
}
const checkedByEngineCheck = (p: string): boolean => p.startsWith('engine/bundle/') || ((p.startsWith('engine/chrome/') || p.startsWith('engine/compositor/')) && isEngineExecutable(p));

/** Hashes every `engine/bundle/**` entry and every Chrome/compositor executable of the manifest (streamed, one file at a time). */
export async function verifyBundleHash(ctx: ServiceContext): Promise<{ hash: EngineStatus['bundleHash']; mismatched: string[] }> {
  const file = manifestPathOf(ctx);
  if (!fs.existsSync(file)) return { hash: null, mismatched: [] };
  let files: ManifestFile[];
  try { files = (JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: ManifestFile[] }).files ?? []; } catch { return { hash: 'mismatch', mismatched: ['engine-manifest.json'] }; }
  const root = path.dirname(file);
  const mismatched: string[] = [];
  for (const f of files.filter((x) => checkedByEngineCheck(x.path))) {
    const abs = path.resolve(root, f.path);
    try {
      if (fs.statSync(abs).size !== f.size || (await sha256(abs)) !== f.sha256) mismatched.push(f.path);
    } catch { mismatched.push(f.path); }
  }
  return { hash: mismatched.length ? 'mismatch' : 'ok', mismatched };
}

/** Starts (or returns) the once-per-launch bundle hash check. */
export function startEngineCheck(ctx: ServiceContext): Promise<{ hash: EngineStatus['bundleHash']; mismatched: string[] }> {
  let p = cache.get(ctx);
  if (!p) {
    p = verifyBundleHash(ctx).then((r) => {
      if (r.hash === 'mismatch') ctx.log.error({ code: 'EM-3003', files: r.mismatched.slice(0, 20) }, 'engine hash mismatch (bundle / Chrome Headless Shell / compositor)');
      return r;
    }).catch((e: unknown) => { ctx.log.warn({ err: String(e) }, 'engine bundle hash check failed'); return { hash: null, mismatched: [] }; });
    cache.set(ctx, p);
  }
  return p;
}

const exe = (n: string) => (process.platform === 'win32' ? `${n}.exe` : n);

/** Presence checks (cheap) + the cached bundle hash. */
export async function engineStatus(ctx: ServiceContext): Promise<EngineStatus> {
  const bundle = fs.existsSync(path.join(ctx.resources.engineBundle, 'index.html'));
  const browser = !ctx.resources.browserExecutable || fs.existsSync(ctx.resources.browserExecutable);
  // Remotion renders through the compositor's own FFmpeg; only a configured compositor folder can be checked
  const ffmpeg = !ctx.resources.binariesDirectory || fs.existsSync(path.join(ctx.resources.binariesDirectory, exe('ffmpeg')));
  const missing = [...(bundle ? [] : ['bundle']), ...(browser ? [] : ['chrome-headless-shell']), ...(ffmpeg ? [] : ['ffmpeg'])];
  const { hash, mismatched } = await startEngineCheck(ctx);
  const code = missing.length ? 'EM-3001' : hash === 'mismatch' ? 'EM-3003' : undefined;
  return { ok: !code, ...(code ? { code } : {}), bundle, browser, ffmpeg, bundleHash: hash, missing, mismatched };
}
