// manifest.json per installed model (docs/LOCAL_AI_MODELS.md §4.2) and the registry-entry shape it derives from.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MANIFEST_ENGINES, type ManifestEngine } from './types.js';
import type { ModelDef } from './registry.js';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const IsoDate = z.string().datetime({ offset: true });
const TierZ = z.enum(['T0', 'T1', 'T2']);

export const ManifestFile = z.object({
  name: z.string().min(1).regex(/^[^/\\]+$/, 'file name must not contain a path separator').refine((n) => n !== '.' && n !== '..'),
  bytes: z.number().int().nonnegative(),
  sha256: Sha256,
  url: z.string().url().startsWith('https://'),
  verifiedAt: IsoDate,
});

export const ManifestLicence = z.object({
  spdx: z.string().optional(),
  name: z.string().min(1),
  url: z.string().url(),
  redistribution: z.enum(['yes', 'no', 'verify']),
  useRestrictions: z.string().optional(),
});

export const ModelManifest = z.object({
  schema: z.literal(1),
  id: z.string().min(1),
  engine: z.enum(MANIFEST_ENGINES as [ManifestEngine, ...ManifestEngine[]]),
  task: z.enum(['stt', 'tts', 'music', 'image', 'library']),
  version: z.string().min(1),
  files: z.array(ManifestFile).min(1),
  licence: ManifestLicence,
  languages: z.array(z.string()),
  minTier: TierZ,
  ramBytes: z.number().int().nonnegative(),
  vramBytes: z.number().int().nonnegative().optional(),
  installedAt: IsoDate,
  lastUsedAt: IsoDate.optional(),
  sizeOnDiskBytes: z.number().int().nonnegative(),
  state: z.enum(['installed', 'partial', 'corrupt']),
});
export type ModelManifestT = z.infer<typeof ModelManifest>;

/** `parseManifest(text)` → manifest or null (malformed JSON or schema mismatch: the model counts as not installed). */
export function parseManifest(text: string): ModelManifestT | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const r = ModelManifest.safeParse(raw);
  return r.success ? r.data : null;
}

export const MANIFEST_FILE = 'manifest.json';

export async function readManifest(modelDir: string): Promise<ModelManifestT | null> {
  try { return parseManifest(await readFile(join(modelDir, MANIFEST_FILE), 'utf8')); } catch { return null; }
}

/** Validates, then writes atomically (tmp file + rename). */
export async function writeManifest(modelDir: string, manifest: ModelManifestT): Promise<void> {
  const valid = ModelManifest.parse(manifest);
  await mkdir(modelDir, { recursive: true });
  const tmp = join(modelDir, `${MANIFEST_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  await rename(tmp, join(modelDir, MANIFEST_FILE));
}

export interface VerifiedFile { name: string; bytes: number; sha256: string; url: string; verifiedAt: string }

/** Builds the manifest of a freshly installed model from its registry entry and the verified files. */
export function manifestFromRegistry(def: ModelDef, files: VerifiedFile[], opts: { installedAt: string; sizeOnDiskBytes?: number; state?: ModelManifestT['state'] }): ModelManifestT {
  if (def.engine === 'none' || def.engine === 'stable-audio') throw new RangeError(`model ${def.key} has no installable engine`);
  const m: ModelManifestT = {
    schema: 1, id: def.key, engine: def.engine, task: def.task, version: def.version,
    files: files.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256, url: f.url, verifiedAt: f.verifiedAt })),
    licence: { name: def.licence.name, url: def.licence.url, redistribution: def.licence.redistribution,
      ...(def.licence.spdx === undefined ? {} : { spdx: def.licence.spdx }), ...(def.licence.useRestrictions === undefined ? {} : { useRestrictions: def.licence.useRestrictions }) },
    languages: [...def.languages], minTier: def.minTier, ramBytes: def.ramBytes, ...(def.vramBytes === undefined ? {} : { vramBytes: def.vramBytes }),
    installedAt: opts.installedAt, sizeOnDiskBytes: opts.sizeOnDiskBytes ?? files.reduce((a, f) => a + f.bytes, 0), state: opts.state ?? 'installed',
  };
  return ModelManifest.parse(m);
}

/** Does an installed manifest still match the registry entry (same version and the same pinned hashes)? */
export function manifestMatchesRegistry(manifest: ModelManifestT, def: ModelDef): boolean {
  if (manifest.id !== def.key || manifest.version !== def.version || manifest.files.length !== def.files.length) return false;
  return def.files.every((f) => manifest.files.some((mf) => mf.name === f.name && mf.sha256 === f.sha256));
}
