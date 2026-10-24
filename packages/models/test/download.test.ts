import { readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmError } from '@expertmotion/shared';
import {
  CancelledError, assertAllowedUrl, downloadFile, installModel, modelDir, modelFilePath, partPath, quickCheckInstalled, readInstallState, readManifest,
  registry, removeModel, requiredInstallBytes, sizeCap, verifyInstalled, type DownloadOptions, type ModelDef, type ReadableStreamLike,
} from '../src/index.js';
import { expectEm, fakeServer, sha, tempDir } from './helpers.js';

const URL1 = 'https://huggingface.co/org/repo/resolve/abc/model.bin';
const body = (n: number): Uint8Array => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff; return b; };
const BIG_FREE = async (): Promise<number> => 100e9;
const noSleep = async (): Promise<void> => undefined;

let tmp: { dir: string; done: () => Promise<void> };
beforeEach(async () => { tmp = await tempDir(); });
afterEach(async () => { await tmp.done(); });
const paths = (): { partPath: string; destPath: string } => ({ partPath: join(tmp.dir, '.partial', 'm', 'model.bin.part'), destPath: join(tmp.dir, 'eng', 'm', 'model.bin') });
const opts = (fetch: DownloadOptions['fetch'], extra: Partial<DownloadOptions> = {}): DownloadOptions => ({ fetch, freeBytes: BIG_FREE, sleep: noSleep, ...extra });

describe('downloadFile', () => {
  it('downloads, verifies sha256, renames atomically and writes the sidecar', async () => {
    const data = body(10_000);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const progress: number[] = [];
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch, { onProgress: (p) => progress.push(p.bytesDone), progressIntervalMs: 0 }));
    expect(r.sha256).toBe(sha(data));
    expect(Buffer.compare(await readFile(paths().destPath), Buffer.from(data))).toBe(0);
    expect((await readFile(`${paths().destPath}.sha256`, 'utf8')).trim()).toBe(sha(data));
    await expect(stat(paths().partPath)).rejects.toThrow();
    expect(progress.at(-1)).toBe(10_000);
    expect(srv.calls[0]!.init.redirect).toBe('manual');
    expect(srv.calls[0]!.init.headers.Range).toBeUndefined();
  });

  it('resumes from an existing .part with a Range request (QA-LM-002)', async () => {
    const data = body(20_000);
    await mkdir(dirname(paths().partPath), { recursive: true });
    await writeFile(paths().partPath, data.subarray(0, 7_000));
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch));
    expect(srv.calls[0]!.init.headers.Range).toBe('bytes=7000-');
    expect(r.resumedFromBytes).toBe(7000);
    expect(sha(await readFile(paths().destPath))).toBe(sha(data));
  });

  it('retries a broken stream and resumes from the bytes already written', async () => {
    const data = body(50_000);
    const srv = fakeServer({ files: { [URL1]: { body: data } }, breakAfter: { url: URL1, bytes: 12_000, times: 2 } });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch));
    expect(r.sha256).toBe(sha(data));
    expect(srv.calls.map((c) => c.init.headers.Range)).toEqual([undefined, 'bytes=12000-', 'bytes=24000-']);
  });

  it('gives up with EM-7002 after the retries, keeping the .part', async () => {
    const data = body(50_000);
    const srv = fakeServer({ files: { [URL1]: { body: data } }, breakAfter: { url: URL1, bytes: 1_000, times: 10 } });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data), modelKey: 'm' }, paths(), opts(srv.fetch)), 'EM-7002');
    expect(srv.calls.length).toBe(3);
    expect(d.bytesDone).toBe(3000);
    expect(d.percent).toBe(6);
    expect((await stat(paths().partPath)).size).toBe(3000);
  });

  it('restarts cleanly when the server ignores Range (200 instead of 206)', async () => {
    const data = body(5_000);
    await mkdir(dirname(paths().partPath), { recursive: true });
    await writeFile(paths().partPath, body(2_000).map((x) => x ^ 0xff));
    const srv = fakeServer({ files: { [URL1]: { body: data, ignoreRange: true } } });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch));
    expect(r.sha256).toBe(sha(data));
  });

  it('a corrupt .part: hash mismatch → .part deleted, one automatic re-download (QA-LM-003)', async () => {
    const data = body(8_000);
    await mkdir(dirname(paths().partPath), { recursive: true });
    const bad = new Uint8Array(data.subarray(0, 4_000)); bad[10] = bad[10]! ^ 1;
    await writeFile(paths().partPath, bad);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch));
    expect(r.sha256).toBe(sha(data));
    expect(srv.calls.map((c) => c.init.headers.Range)).toEqual(['bytes=4000-', undefined]);
  });

  it('persistent hash mismatch → EM-7003 and no file left', async () => {
    const data = body(8_000);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha('other') }, paths(), opts(srv.fetch)), 'EM-7003');
    expect(d.actualHash).toBe(sha(data));
    await expect(stat(paths().partPath)).rejects.toThrow();
    await expect(stat(paths().destPath)).rejects.toThrow();
    expect(srv.calls.length).toBe(2);
  });

  it('size cap: a body larger than registry size + 1 % aborts with EM-7003 and removes the partial (SEC-073)', async () => {
    const data = body(10_000);
    const srv = fakeServer({ files: { [URL1]: { body: data, contentLength: Number.NaN } }, extra: { [URL1]: 500 } });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch)), 'EM-7003');
    expect(d.reason).toBe('size-exceeded');
    expect(sizeCap(10_000)).toBe(10_100);
    await expect(stat(paths().partPath)).rejects.toThrow();
  });

  it('rejects an oversized Content-Length before writing', async () => {
    const data = body(2_000);
    const srv = fakeServer({ files: { [URL1]: { body: data, contentLength: 999_999 } } });
    await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: 2_000, bytesExact: false, sha256: sha(data) }, paths(), opts(srv.fetch)), 'EM-7003');
  });

  it('host allow-list and https only (SEC-070/071) → EM-8203', async () => {
    expect(() => assertAllowedUrl('http://huggingface.co/x')).toThrow(EmError);
    expect(() => assertAllowedUrl('https://evil.example.com/x')).toThrow(/not allowed/);
    expect(() => assertAllowedUrl('https://user:pw@huggingface.co/x')).toThrow(/credentials/);
    expect(() => assertAllowedUrl('not a url')).toThrow(EmError);
    expect(assertAllowedUrl('https://HuggingFace.co/x').hostname).toBe('huggingface.co');
    const srv = fakeServer({ files: {} });
    await expectEm(downloadFile({ name: 'x', url: 'https://evil.example.com/x', bytes: 1, bytesExact: true, sha256: sha('x') }, paths(), opts(srv.fetch)), 'EM-8203');
    expect(srv.calls.length).toBe(0);
  });

  it('follows redirects only to allow-listed hosts', async () => {
    const data = body(3_000);
    const cdn = 'https://cdn-lfs.huggingface.co/blob/1';
    const ok = fakeServer({ files: { [cdn]: { body: data } }, redirects: { [URL1]: cdn } });
    await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(ok.fetch));
    expect(ok.calls.map((c) => c.url)).toEqual([URL1, cdn]);
    const bad = fakeServer({ files: {}, redirects: { [URL1]: 'https://attacker.example/blob' } });
    await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, { partPath: join(tmp.dir, 'p2'), destPath: join(tmp.dir, 'd2') }, opts(bad.fetch)), 'EM-8203');
    const loop = fakeServer({ files: {}, redirects: { [URL1]: URL1 } });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: 1, bytesExact: true, sha256: sha('x') }, { partPath: join(tmp.dir, 'p3'), destPath: join(tmp.dir, 'd3') }, opts(loop.fetch)), 'EM-7002');
    expect(d.reason).toBe('too-many-redirects');
    expect(loop.calls.length).toBe(6);
  });

  it('Private Mode: egress EM-8202 → EM-7006, .part kept; precheck blocks before any request (SEC-076, QA-LM-004)', async () => {
    const data = body(4_000);
    await mkdir(dirname(paths().partPath), { recursive: true });
    await writeFile(paths().partPath, data.subarray(0, 1000));
    const gate = fakeServer({ files: { [URL1]: { body: data } }, throwOnFetch: () => new EmError('EM-8202', 'blocked by Private Mode') });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(gate.fetch)), 'EM-7006');
    expect(d.reason).toBe('private');
    expect((await stat(paths().partPath)).size).toBe(1000);
    const offline = fakeServer({ files: {}, throwOnFetch: () => new EmError('EM-8201', 'offline') });
    expect((await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(offline.fetch)), 'EM-7006')).reason).toBe('offline');
    const pre = fakeServer({ files: { [URL1]: { body: data } } });
    await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(pre.fetch, { privateMode: () => true })), 'EM-7006');
    expect(pre.calls.length).toBe(0);
    const other = fakeServer({ files: {}, throwOnFetch: () => new EmError('EM-8203', 'blocked host') });
    await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: 1, bytesExact: true, sha256: sha('x') }, paths(), opts(other.fetch)), 'EM-8203');
  });

  it('cancellation via AbortSignal keeps the .part for resume', async () => {
    const data = body(200_000);
    const ctrl = new AbortController();
    const srv = fakeServer({ files: { [URL1]: { body: data } }, chunk: 1000 });
    const p = downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(),
      opts(srv.fetch, { signal: ctrl.signal, progressIntervalMs: 0, onProgress: (pr) => { if (pr.bytesDone >= 5000) ctrl.abort(); } }));
    await expect(p).rejects.toBeInstanceOf(CancelledError);
    const size = (await stat(paths().partPath)).size;
    expect(size).toBeGreaterThanOrEqual(5000);
    expect(size).toBeLessThan(data.length);
  });

  it('aborts with EM-7004 when free disk drops under the floor while downloading', async () => {
    const data = body(10_000);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const d = await expectEm(downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(),
      opts(srv.fetch, { freeBytes: async () => 10, diskCheckEveryBytes: 4096 })), 'EM-7004');
    expect(d.freeBytes).toBe(10);
  });

  it('HTTP 404 is not retried (EM-7002); 503 is', async () => {
    const s404 = fakeServer({ files: {} });
    expect((await expectEm(downloadFile({ name: 'm', url: URL1, bytes: 1, bytesExact: true, sha256: sha('x') }, paths(), opts(s404.fetch)), 'EM-7002')).httpStatus).toBe(404);
    expect(s404.calls.length).toBe(1);
    const s503 = fakeServer({ files: {}, status: { [URL1]: 503 } });
    await expectEm(downloadFile({ name: 'm', url: URL1, bytes: 1, bytesExact: true, sha256: sha('x') }, paths(), opts(s503.fetch)), 'EM-7002');
    expect(s503.calls.length).toBe(3);
  });

  it('416 on a complete .part verifies it in place', async () => {
    const data = body(3_000);
    await mkdir(dirname(paths().partPath), { recursive: true });
    await writeFile(paths().partPath, data);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(srv.fetch));
    expect(r.bytes).toBe(3000);
  });

  it('refuses unpinned checksums', async () => {
    const srv = fakeServer({ files: {} });
    expect((await expectEm(downloadFile({ name: 'm', url: URL1, bytes: 1, bytesExact: true, sha256: 'TO_PIN' }, paths(), opts(srv.fetch)), 'EM-7003')).reason).toBe('unpinned');
  });

  it('reads a WHATWG ReadableStream body too', async () => {
    const data = body(4_096);
    const fetch: DownloadOptions['fetch'] = async () => ({ status: 200, headers: { get: () => null }, body: new Blob([new Uint8Array(data)]).stream() as unknown as ReadableStreamLike });
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: sha(data) }, paths(), opts(fetch));
    expect(r.sha256).toBe(sha(data));
  });
});

describe('installModel / verify / remove', () => {
  const piperCfg = JSON.stringify({ audio: { sample_rate: 22050 }, phoneme_id_map: { _: [0], '^': [1], $: [2], ' ': [3], a: [14] } });
  const onnx = body(6_000);
  const def = (): ModelDef => {
    const base = registry['piper-id-news-medium']!;
    return { ...base, files: [
      { ...base.files[0]!, bytes: onnx.length, bytesExact: true, sha256: sha(onnx) },
      { ...base.files[1]!, bytes: Buffer.byteLength(piperCfg), bytesExact: true, sha256: sha(piperCfg) },
    ] };
  };
  const server = (): ReturnType<typeof fakeServer> => fakeServer({ files: { [def().files[0]!.url]: { body: onnx }, [def().files[1]!.url]: { body: new TextEncoder().encode(piperCfg) } } });

  it('installs into <modelsDir>/<engine>/<model>/ with manifest.json and tokens.txt', async () => {
    const srv = server();
    const events: number[] = [];
    const m = await installModel(def(), { modelsDir: tmp.dir, fetch: srv.fetch, freeBytes: BIG_FREE, sleep: noSleep, now: () => Date.parse('2026-10-24T10:00:00Z'), progressIntervalMs: 0, onProgress: (p) => events.push(p.bytesDone) });
    expect(modelDir(tmp.dir, def())).toBe(join(tmp.dir, 'sherpa-onnx', 'piper-id-news-medium'));
    expect(m.state).toBe('installed');
    expect(m.installedAt).toBe('2026-10-24T10:00:00.000Z');
    expect(m.files.map((f) => f.name)).toEqual(['id_ID-news_tts-medium.onnx', 'id_ID-news_tts-medium.onnx.json']);
    expect(await readFile(join(modelDir(tmp.dir, def()), 'tokens.txt'), 'utf8')).toBe('_ 0\n^ 1\n$ 2\n  3\na 14\n');
    expect((await readManifest(modelDir(tmp.dir, def())))?.id).toBe('piper-id-news-medium');
    expect(events.at(-1)).toBe(onnx.length + Buffer.byteLength(piperCfg));
    expect(await quickCheckInstalled(def(), tmp.dir)).toBe(true);
    expect(await verifyInstalled(def(), tmp.dir)).toEqual({ ok: true, missing: [], mismatched: [] });
    // second install skips verified files
    const again = server();
    await installModel(def(), { modelsDir: tmp.dir, fetch: again.fetch, freeBytes: BIG_FREE });
    expect(again.calls.length).toBe(0);
    // flip one byte → verify reports it
    const p = modelFilePath(tmp.dir, def(), 'id_ID-news_tts-medium.onnx');
    const buf = await readFile(p); buf[0] = buf[0]! ^ 1; await writeFile(p, buf);
    expect((await verifyInstalled(def(), tmp.dir)).mismatched).toEqual(['id_ID-news_tts-medium.onnx']);
    await removeModel(def(), tmp.dir);
    expect(await readManifest(modelDir(tmp.dir, def()))).toBeNull();
    expect((await verifyInstalled(def(), tmp.dir)).missing).toContain('manifest.json');
  });

  it('disk precheck Σ × 1.1 + 500 MB → EM-7004', async () => {
    expect(requiredInstallBytes(1_000_000_000)).toBe(1_600_000_000);
    const d = await expectEm(installModel(def(), { modelsDir: tmp.dir, fetch: server().fetch, freeBytes: async () => 100_000_000 }), 'EM-7004');
    expect(d.requiredBytes).toBe(requiredInstallBytes(onnx.length + Buffer.byteLength(piperCfg)));
  });

  it('Private Mode precheck → EM-7006; unpinned registry entry → EM-7003; non-downloadable → RangeError', async () => {
    await expectEm(installModel(def(), { modelsDir: tmp.dir, fetch: server().fetch, freeBytes: BIG_FREE, privateMode: () => true }), 'EM-7006');
    await expectEm(installModel(registry['whisper-small']!, { modelsDir: tmp.dir, fetch: server().fetch, freeBytes: BIG_FREE }), 'EM-7003');
    await expect(installModel(registry['frame-composite']!, { modelsDir: tmp.dir, fetch: server().fetch, freeBytes: BIG_FREE })).rejects.toThrow(RangeError);
  });

  it('reports partial bytes for an interrupted install', async () => {
    const d = def();
    await mkdir(dirname(partPath(tmp.dir, d, d.files[0]!.name)), { recursive: true });
    await writeFile(partPath(tmp.dir, d, d.files[0]!.name), onnx.subarray(0, 1234));
    expect(await readInstallState(d, tmp.dir)).toEqual({ key: d.key, manifest: null, partialBytes: 1234 });
  });
});
