import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetFacts } from '@expertmotion/composition-model';
import { tempDir } from '../helpers.js';
import { ZipReader, ZipWriter, assertSafeName } from '../../src/s1/zip.js';
import { decryptFile, encryptFile } from '../../src/s1/crypto-box.js';
import { newProject, startS1, type S1Service } from './helpers.js';

const hasPython = (() => { try { execFileSync('python3', ['-c', 'import zipfile'], { stdio: 'ignore' }); return true; } catch { return false; } })();
async function makeZip(file: string, entries: Record<string, Buffer>) { const w = await ZipWriter.create(file); for (const [n, b] of Object.entries(entries)) await w.addBuffer(n, b); await w.close(); }

describe('store-only zip writer/reader', () => {
  it('round-trips buffers and files with CRC verification, and interoperates with Python zipfile', async () => {
    const dir = tempDir('em-zip-'); const src = path.join(dir, 'big.bin'); const big = crypto.randomBytes(3 * 1024 * 1024 + 17); fs.writeFileSync(src, big);
    const file = path.join(dir, 'a.zip');
    const w = await ZipWriter.create(file);
    await w.addBuffer('manifest.json', Buffer.from('{"a":1}')); await w.addFile('media/x/original.mp4', src); await w.addBuffer('empty.txt', Buffer.alloc(0)); await w.close();
    const r = await ZipReader.open(file);
    expect(r.entries.map((e) => e.name)).toEqual(['manifest.json', 'media/x/original.mp4', 'empty.txt']);
    expect((await r.readBuffer(r.get('manifest.json')!, 100)).toString()).toBe('{"a":1}');
    const out = path.join(dir, 'out.bin'); await r.extractTo(r.get('media/x/original.mp4')!, out);
    expect(fs.readFileSync(out).equals(big)).toBe(true);
    await r.close();
    if (hasPython) {
      expect(execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(z.testzip(), len(z.read("media/x/original.mp4")))', file]).toString().trim()).toBe(`None ${big.length}`);
      const py = path.join(dir, 'py.zip');
      execFileSync('python3', ['-I', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_STORED); z.writestr("a/b.txt","halo"); z.close()', py]);
      const pr = await ZipReader.open(py); expect((await pr.readBuffer(pr.get('a/b.txt')!, 10)).toString()).toBe('halo'); await pr.close();
    }
  });
  it('rejects unsafe names (traversal, absolute, backslash, drive), duplicates, oversize entries and CRC tampering', async () => {
    for (const n of ['../evil', 'a/../../b', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', '.', 'a/./b', '']) expect(() => assertSafeName(n), n).toThrow();
    const dir = tempDir('em-zip-');
    const file = path.join(dir, 't.zip'); await makeZip(file, { 'aa/evil.txt': Buffer.from('pwned'), 'ok.txt': Buffer.from('fine') });
    const raw = fs.readFileSync(file); fs.writeFileSync(file, Buffer.from(raw.toString('latin1').replaceAll('aa/evil.txt', '../evil.txt'), 'latin1'));
    await expect(ZipReader.open(file)).rejects.toThrow(/unsafe entry name/);
    const big = path.join(dir, 'big.zip'); await makeZip(big, { 'a.bin': Buffer.alloc(100) });
    await expect(ZipReader.open(big, { maxEntries: 10, maxEntryBytes: 50, maxTotalBytes: 1e9, maxCentralDirBytes: 1e6 })).rejects.toThrow(/too large/);
    await expect(ZipReader.open(big, { maxEntries: 0, maxEntryBytes: 1e9, maxTotalBytes: 1e9, maxCentralDirBytes: 1e6 })).rejects.toThrow(/too many/);
    const w = await ZipWriter.create(path.join(dir, 'dup.zip')); await w.addBuffer('x', Buffer.from('1')); await expect(w.addBuffer('x', Buffer.from('2'))).rejects.toThrow(/duplicate/); await w.abort();
    const t = path.join(dir, 'crc.zip'); await makeZip(t, { 'f.txt': Buffer.from('hello world') });
    const b = fs.readFileSync(t); b[b.indexOf('hello world')] = 0x48; fs.writeFileSync(t, b);
    const r = await ZipReader.open(t); await expect(r.readBuffer(r.get('f.txt')!, 100)).rejects.toThrow(/CRC/); await r.close();
    fs.writeFileSync(path.join(dir, 'junk.zip'), crypto.randomBytes(500));
    await expect(ZipReader.open(path.join(dir, 'junk.zip'))).rejects.toThrow();
  });
  it('encrypted container: right passphrase round-trips, wrong one fails and leaves no output', async () => {
    const dir = tempDir('em-box-'); const src = path.join(dir, 'p.zip'); fs.writeFileSync(src, crypto.randomBytes(100_000));
    const kdf = { N: 1 << 14, r: 8, p: 1 };
    await encryptFile(src, path.join(dir, 'p.emproj'), 'rahasia-panjang', kdf);
    await decryptFile(path.join(dir, 'p.emproj'), path.join(dir, 'back.zip'), 'rahasia-panjang');
    expect(fs.readFileSync(path.join(dir, 'back.zip')).equals(fs.readFileSync(src))).toBe(true);
    await expect(decryptFile(path.join(dir, 'p.emproj'), path.join(dir, 'bad.zip'), 'salah-sekali')).rejects.toMatchObject({ reason: 'wrong-passphrase' });
    expect(fs.existsSync(path.join(dir, 'bad.zip'))).toBe(false);
  });
});

describe('backup R-020 → restore R-021', () => {
  let s: S1Service; let pid: string; let assetId: string; let media: Buffer;
  const folder = tempDir('em-backups-');
  const done = (kind: string, jobId: string) => s.waitFor((e) => e.name === 'service.notice' && e.data['kind'] === kind && e.data['jobId'] === jobId && e.data['done'] === true, 20_000);
  const shell = { 'X-Expertmotion-Caller': 'shell' };
  beforeAll(async () => {
    s = await startS1();
    s.ctx.hooks.assetFacts = (projectId) => (s.ctx.db.prepare('SELECT id, kind, status, duration_ms, name FROM assets WHERE project_id = ?').all(projectId) as Array<{ id: string; kind: AssetFacts['kind']; status: AssetFacts['status']; duration_ms: number; name: string }>)
      .map((a) => ({ id: a.id, kind: a.kind, status: a.status, durationMs: a.duration_ms, name: a.name }));
    pid = (await newProject(s, 'Kopi Backup')).id; assetId = s.ctx.newId();
    media = crypto.randomBytes(256 * 1024);
    fs.mkdirSync(path.join(s.ctx.paths.media, pid, assetId), { recursive: true });
    fs.writeFileSync(path.join(s.ctx.paths.media, pid, assetId, 'original.mp4'), media);
    s.ctx.db.prepare("INSERT INTO assets (id, project_id, kind, name, sha256, bytes, original_path, playable_path, duration_ms, status, created_at, updated_at) VALUES (?,?,'video','kopi.mp4',?,?,?,?,8000,'ready','t','t')")
      .run(assetId, pid, crypto.createHash('sha256').update(media).digest('hex'), media.length, `${pid}/${assetId}/original.mp4`, `${pid}/${assetId}/original.mp4`);
    s.ctx.hooks.applyOps(pid, [{ op: 'op:clip.insert', target: { kind: 'sequence' }, args: { assetId } }], { kind: 'asset', summary: 'insert' });
    // FR-017: a Brainstorming thread with an attachment that references the asset
    const conv = s.ctx.newId();
    s.ctx.db.prepare("INSERT INTO conversations (id, project_id, agent, summary_json, created_at, updated_at) VALUES (?,?,'brainstorm',NULL,'t','t')").run(conv, pid);
    s.ctx.db.prepare("INSERT INTO messages (id, conversation_id, role, blocks_json, agent_run_id, created_at) VALUES (?,?,'user',?,NULL,'2026-10-24T00:00:00.000Z')")
      .run(s.ctx.newId(), conv, JSON.stringify([{ type: 'text', text: 'Ide video kopi' }, { type: 'attachment', assetId }]));
  });
  afterAll(async () => { await s.close(); });

  it('plain backup → restore as a renamed copy (EM-6303) with media, versions and remapped ids', async () => {
    const b = await s.json(`/projects/${pid}/backup`, { method: 'POST', json: { folder } });
    expect(b.status).toBe(202);
    const bd = await done('backup', b.body.jobId);
    const file = bd.data['path'] as string;
    expect(file.endsWith('.zip')).toBe(true);
    const r = await ZipReader.open(file);
    const manifest = JSON.parse((await r.readBuffer(r.get('manifest.json')!, 1e6)).toString());
    expect(manifest).toMatchObject({ format: 'expertmotion-backup', formatVersion: 1, projectId: pid, form: 'plain' });
    expect(r.entries.map((e) => e.name)).toContain(`media/${assetId}/original.mp4`);
    await r.close();
    expect((await s.json('/projects/restore', { method: 'POST', json: { path: file } })).body.error.code).toBe('EM-8005');
    const reingested: Array<{ projectId: string; assetIds: string[] }> = [];
    s.ctx.hooks.reingest = (projectId, assetIds) => { reingested.push({ projectId, assetIds }); };
    const rs = await s.json('/projects/restore', { method: 'POST', json: { path: file }, headers: shell });
    expect(rs.status).toBe(202);
    const rd = await done('restore', rs.body.jobId);
    expect(rd.data).toMatchObject({ code: 'EM-6303', name: 'Kopi Backup (restored)' });
    const np = rd.data['projectId'] as string;
    expect(np).not.toBe(pid);
    const m = (await s.json(`/projects/${np}/composition`)).body;
    expect(m.head.model.projectId).toBe(np);
    expect(m.issues).toEqual([]);
    const newAsset = m.head.model.tracks.video[0].assetId as string;
    expect(newAsset).not.toBe(assetId);
    const row = s.ctx.db.prepare('SELECT original_path, status FROM assets WHERE id = ?').get(newAsset) as { original_path: string; status: string };
    expect(row.status).toBe('ready');
    expect(fs.readFileSync(path.join(s.ctx.paths.media, row.original_path)).equals(media)).toBe(true);
    expect((await s.json(`/projects/${np}/composition/versions`)).body.total).toBe(2);
    // FR-017 / FR-018: the conversation comes back (attachment remapped) and derived media is queued for regeneration
    const msgs = s.ctx.db.prepare("SELECT m.blocks_json FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.project_id = ? AND c.agent = 'brainstorm'").all(np) as Array<{ blocks_json: string }>;
    expect(msgs).toHaveLength(1);
    expect(JSON.parse(msgs[0]!.blocks_json)).toEqual([{ type: 'text', text: 'Ide video kopi' }, { type: 'attachment', assetId: newAsset }]);
    expect(reingested).toEqual([{ projectId: np, assetIds: [newAsset] }]);
  });
  it('encrypted backup: passphrase required (EM-6305), wrong passphrase fails the job, right one restores', async () => {
    const b = await s.json(`/projects/${pid}/backup`, { method: 'POST', json: { folder, passphrase: 'kata-sandi-panjang' } });
    const file = (await done('backup', b.body.jobId)).data['path'] as string;
    expect(file.endsWith('.emproj')).toBe(true);
    expect(fs.readFileSync(file).subarray(0, 4).toString('latin1')).toBe('EMBK');
    expect(fs.readFileSync(file).includes(media.subarray(0, 64))).toBe(false);
    const need = await s.json('/projects/restore', { method: 'POST', json: { path: file }, headers: shell });
    expect([need.status, need.body.error.code]).toEqual([422, 'EM-6305']);
    const count = () => (s.ctx.db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n;
    const before = count();
    const wrong = await s.json('/projects/restore', { method: 'POST', json: { path: file, passphrase: 'salah' }, headers: shell });
    expect((await done('restore', wrong.body.jobId)).data['code']).toBe('EM-6305');
    expect(count()).toBe(before);
    const right = await s.json('/projects/restore', { method: 'POST', json: { path: file, passphrase: 'kata-sandi-panjang' }, headers: shell });
    expect((await done('restore', right.body.jobId)).data['projectId']).toBeTruthy();
    expect(count()).toBe(before + 1);
  });
  it('refuses folders outside the allowed roots (403 EM-8302), non-backups (EM-6302) and archives with traversal or bad hashes', async () => {
    const out = await s.json(`/projects/${pid}/backup`, { method: 'POST', json: { folder: '/etc' } });
    expect([out.status, out.body.error.code]).toEqual([403, 'EM-8302']);
    expect((await s.json(`/projects/${pid}/backup`, { method: 'POST', json: { folder: 'relative/dir' } })).body.error.code).toBe('EM-8302');
    const junk = path.join(folder, 'junk.zip'); fs.writeFileSync(junk, 'not a zip at all');
    expect((await s.json('/projects/restore', { method: 'POST', json: { path: junk }, headers: shell })).body.error.code).toBe('EM-6302');
    const count = () => (s.ctx.db.prepare('SELECT count(*) AS n FROM projects').get() as { n: number }).n;
    const before = count();
    const evil = path.join(folder, 'evil.zip');
    await makeZip(evil, { 'manifest.json': Buffer.from('{}'), 'aa/evil.txt': Buffer.from('x') });
    fs.writeFileSync(evil, Buffer.from(fs.readFileSync(evil).toString('latin1').replaceAll('aa/evil.txt', '../evil.txt'), 'latin1'));
    const e1 = await s.json('/projects/restore', { method: 'POST', json: { path: evil }, headers: shell });
    expect((await done('restore', e1.body.jobId)).data['code']).toBe('EM-6302');
    expect(fs.existsSync(path.join(folder, '..', 'evil.txt'))).toBe(false);
    // tamper with a JSON entry of a real backup: the manifest hash check refuses it
    const b = await s.json(`/projects/${pid}/backup`, { method: 'POST', json: { folder } });
    const good = (await done('backup', b.body.jobId)).data['path'] as string;
    const raw = fs.readFileSync(good); const at = raw.indexOf('"Kopi Backup"'); raw[at + 1] = 'X'.charCodeAt(0);
    const tampered = path.join(folder, 'tampered.zip'); fs.writeFileSync(tampered, raw);
    const e2 = await s.json('/projects/restore', { method: 'POST', json: { path: tampered }, headers: shell });
    expect((await done('restore', e2.body.jobId)).data['code']).toBe('EM-6302');
    expect(count()).toBe(before);
  });
});
