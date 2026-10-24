import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { ModelManifest, manifestFromRegistry, manifestMatchesRegistry, parseManifest, readManifest, registry, writeManifest, type ModelDef } from '../src/index.js';
import { sha, tempDir } from './helpers.js';

const def: ModelDef = { ...registry['whisper-small']!, files: [{ ...registry['whisper-small']!.files[0]!, sha256: sha('w'), bytesExact: true, bytes: 1 }] };
const files = [{ name: 'ggml-small.bin', bytes: 1, sha256: sha('w'), url: def.files[0]!.url, verifiedAt: '2026-10-24T10:00:00.000Z' }];

describe('manifest.json (LOCAL_AI_MODELS §4.2)', () => {
  it('builds a valid manifest from a registry entry', () => {
    const m = manifestFromRegistry(def, files, { installedAt: '2026-10-24T10:00:00.000Z' });
    expect(m).toMatchObject({ schema: 1, id: 'whisper-small', engine: 'whisper.cpp', task: 'stt', version: '2026.10', minTier: 'T0', state: 'installed', sizeOnDiskBytes: 1, languages: ['id', 'en'] });
    expect(m.licence.spdx).toBe('MIT');
    expect(manifestMatchesRegistry(m, def)).toBe(true);
    expect(manifestMatchesRegistry(m, { ...def, version: '2027.01' })).toBe(false);
    expect(manifestMatchesRegistry(m, { ...def, files: [{ ...def.files[0]!, sha256: sha('other') }] })).toBe(false);
    const sd = registry['sd15-emaonly']!;
    const sdm = manifestFromRegistry({ ...sd, files: [{ ...sd.files[0]!, sha256: sha('s') }] }, [{ ...files[0]!, name: sd.files[0]!.name, sha256: sha('s') }], { installedAt: '2026-10-24T10:00:00Z' });
    expect(sdm.licence.useRestrictions).toMatch(/OpenRAIL/);
    expect(sdm.vramBytes).toBe(3e9);
    expect(() => manifestFromRegistry(registry['frame-composite']!, files, { installedAt: '2026-10-24T10:00:00Z' })).toThrow(RangeError);
  });
  it('rejects bad shapes', () => {
    const m = manifestFromRegistry(def, files, { installedAt: '2026-10-24T10:00:00.000Z' });
    expect(ModelManifest.safeParse({ ...m, engine: 'llama.cpp' }).success).toBe(false);
    expect(ModelManifest.safeParse({ ...m, files: [{ ...m.files[0]!, url: 'http://huggingface.co/x' }] }).success).toBe(false);
    expect(ModelManifest.safeParse({ ...m, files: [{ ...m.files[0]!, name: '../evil' }] }).success).toBe(false);
    expect(ModelManifest.safeParse({ ...m, files: [{ ...m.files[0]!, sha256: 'TO_PIN' }] }).success).toBe(false);
    expect(ModelManifest.safeParse({ ...m, files: [] }).success).toBe(false);
    expect(parseManifest('{nope')).toBeNull();
    expect(parseManifest('{"schema":2}')).toBeNull();
  });
  it('writes atomically and reads back; corrupt file reads as null', async () => {
    const t = await tempDir();
    try {
      const m = manifestFromRegistry(def, files, { installedAt: '2026-10-24T10:00:00.000Z' });
      const dir = join(t.dir, 'whisper.cpp', 'whisper-small');
      await writeManifest(dir, m);
      expect(await readManifest(dir)).toEqual(m);
      await writeFile(join(dir, 'manifest.json'), '{"schema":1');
      expect(await readManifest(dir)).toBeNull();
      await mkdir(join(t.dir, 'empty'));
      expect(await readManifest(join(t.dir, 'empty'))).toBeNull();
      await expect(writeManifest(dir, { ...m, schema: 2 as 1 })).rejects.toThrow();
    } finally { await t.done(); }
  });
});
