// Review 2026-10-29 A8 (minor service issues): the transcript route is scoped to its project; a downloaded library track is
// hashed once per file version, not on every Range request.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MusicTrack } from '@expertmotion/models';
import { health } from '../../src/modules/health.js';
import { createGeneratorsModule } from '../../src/modules/generators.js';
import { musicLibraryOf } from '../../src/s2/music-library-service.js';
import { json, startS2, type S2Service } from './harness.js';

let s: S2Service;
beforeAll(async () => { s = await startS2([health, createGeneratorsModule({ enabledKinds: ['voice', 'music'] })]); });
afterAll(async () => { await s.close(); });

describe('A8', () => {
  it('GET /projects/:id/assets/:assetId/transcript serves only the transcript of that project', async () => {
    const a = s.project('A'); const b = s.project('B');
    const asset = '01JREVEWA8TRANSCRPT0000001';
    s.ctx.db.prepare('INSERT INTO voice_transcripts (asset_id, project_id, voice_id, method, json, srt, created_at) VALUES (?,?,?,?,?,?,?)')
      .run(asset, a, 'local:x', 'proportional', JSON.stringify({ version: 1, cues: [], spoken: 'halo' }), '', new Date().toISOString());
    const ok = await s.api(`/projects/${a}/assets/${asset}/transcript`);
    expect(ok.status).toBe(200);
    expect((await json<{ spoken: string }>(ok)).spoken).toBe('halo');
    const other = await s.api(`/projects/${b}/assets/${asset}/transcript`);
    expect(other.status).toBe(404);
  });

  it('music readyFile re-hashes only when the file changed (size or mtime)', async () => {
    const lib = musicLibraryOf(s.ctx);
    const data = crypto.randomBytes(4096);
    const track = { id: 'test-a8', file: 'test-a8.mp3', bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') } as unknown as MusicTrack;
    (lib as unknown as { require: (id: string) => MusicTrack }).require = () => track;
    fs.mkdirSync(lib.dir(), { recursive: true });
    const file = lib.filePath(track); fs.writeFileSync(file, data);
    const T = new Date('2026-01-01T00:00:00Z'); fs.utimesSync(file, T, T);   // whole seconds: utimes cannot restore sub-ms mtimes
    expect(await lib.readyFile('test-a8')).toBe(file);
    // same size and mtime: served from the verified stamp (a hash would now fail, so this proves no re-hash)
    const bad = Buffer.from(data); bad[0] = bad[0]! ^ 0xff; fs.writeFileSync(file, bad); fs.utimesSync(file, T, T);
    expect(await lib.readyFile('test-a8')).toBe(file);
    // a newer mtime: hashed again, the damage is found (EM-7108) and the file removed
    fs.utimesSync(file, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'));
    await expect(lib.readyFile('test-a8')).rejects.toMatchObject({ code: 'EM-7108' });
    expect(fs.existsSync(file)).toBe(false);
  });
});
