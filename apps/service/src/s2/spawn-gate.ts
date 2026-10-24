// Spawn gate for Engine Binaries (SECURITY.md SEC-061, SEC-066; LOCAL_AI_MODELS §3.1).
//  - SEC-066: every Engine Binary declares whether it needs the network. All shipped engines declare `network: false`; an engine
//    that declares (or is not known to declare) a network need is refused with EM-8202 while Private Mode is on.
//  - SEC-061: before a generator engine (whisper.cpp, sherpa-onnx, stable-diffusion.cpp, ACE-Step) is spawned its executables are
//    hashed against resources/engine-manifest.json where the manifest lists them (`engines/<engine>/…`); a mismatch disables the
//    feature with EM-7108 and is logged. Results are cached per file (size + mtime), so a run re-hashes only changed files.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EmError } from '@expertmotion/shared';
import type { ServiceContext } from '../context.js';
import { isEngineExecutable, manifestPathOf } from './engine-check.js';

/** Declared network need per Engine Binary (SEC-066). Unknown engines are treated as needing the network (fail closed). */
export const ENGINE_NETWORK: Readonly<Record<string, boolean>> = {
  'whisper.cpp': false, 'sherpa-onnx': false, 'stable-diffusion.cpp': false, 'ace-step': false,
  ffmpeg: false, ffprobe: false, 'chrome-headless-shell': false, compositor: false,
  loops: false, none: false,                                    // loop library (FFmpeg) and frame stills (Engine render)
};

export function spawnRefusal(engine: string, privateMode: boolean): EmError | null {
  const needsNetwork = ENGINE_NETWORK[engine] !== false;
  if (privateMode && needsNetwork) return new EmError('EM-8202', 'Private Mode is on, so this engine (which needs the internet) was not started.', { details: { engine } });
  return null;
}

interface Entry { path: string; size: number; sha256: string }
const verified = new Map<string, { size: number; mtimeMs: number; ok: boolean }>();

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** Returns the manifest paths of `engineDir` executables whose hash differs (empty when fine or when no hashes exist). */
export async function engineBinaryMismatches(ctx: ServiceContext, engineDir: string): Promise<string[]> {
  const file = manifestPathOf(ctx);
  if (!fs.existsSync(file)) return [];                                   // development: no manifest shipped
  let entries: Entry[];
  try { entries = (JSON.parse(fs.readFileSync(file, 'utf8')) as { files?: Entry[] }).files ?? []; } catch { return ['engine-manifest.json']; }
  const root = path.dirname(file);
  const dir = path.resolve(engineDir) + path.sep;
  const bad: string[] = [];
  for (const e of entries) {
    if (!e.path.startsWith('engines/') || !isEngineExecutable(e.path)) continue;
    const abs = path.resolve(root, e.path);
    if (!abs.startsWith(dir)) continue;
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { bad.push(e.path); continue; }
    const c = verified.get(abs);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) { if (!c.ok) bad.push(e.path); continue; }
    const ok = st.size === e.size && (await sha256(abs).catch(() => '')) === e.sha256;
    verified.set(abs, { size: st.size, mtimeMs: st.mtimeMs, ok });
    if (!ok) bad.push(e.path);
  }
  return bad;
}

/** Both checks, in order: Private Mode / network declaration, then the binary hashes. Throws the EM error to show. */
export async function assertEngineSpawnAllowed(ctx: ServiceContext, engine: string, engineDir: string): Promise<void> {
  const refusal = spawnRefusal(engine, ctx.settings.get().privateMode);
  if (refusal) throw refusal;
  const bad = await engineBinaryMismatches(ctx, engineDir);
  if (bad.length) {
    ctx.log.error({ code: 'EM-7108', engine, files: bad.slice(0, 10) }, 'engine binary hash mismatch');
    throw new EmError('EM-7108', `The ${engine} engine files are damaged. Reinstall Expertmotion to repair them.`, { details: { model: engine, hashCheck: 'mismatch' } });
  }
}
