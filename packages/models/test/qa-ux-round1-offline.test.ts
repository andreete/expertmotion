// QA P1-9 (QA UX round 1): with no route to the internet the download keeps retrying past the usual 6-in-a-row limit (up to
// maxAttempts), so it resumes by itself when the network returns; every retry carries the network code for the "no internet" line.
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadFile, type DownloadOptions, type DownloadRetry } from '../src/index.js';
import { fakeServer, tempDir } from './helpers.js';

const URL1 = 'https://huggingface.co/org/repo/resolve/abc/model.bin';
let tmp: { dir: string; done: () => Promise<void> };
beforeEach(async () => { tmp = await tempDir(); });
afterEach(async () => { await tmp.done(); });

describe('offline downloads (QA P1-9)', () => {
  it('ENETUNREACH is waited out beyond the 6 retries in a row, then the download completes', async () => {
    const data = new Uint8Array(4000).map((_, i) => (i * 7) & 0xff);
    const srv = fakeServer({ files: { [URL1]: { body: data } } });
    let down = 9;                                                   // nine failed tries without network, then the network is back
    const fetch: DownloadOptions['fetch'] = async (url, init) => {
      if (down-- > 0) throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ENETUNREACH'), { code: 'ENETUNREACH' }) });
      return srv.fetch(url, init);
    };
    const retries: DownloadRetry[] = [];
    const r = await downloadFile({ name: 'model.bin', url: URL1, bytes: data.length, bytesExact: true, sha256: createHash('sha256').update(data).digest('hex'), modelKey: 'm' },
      { partPath: join(tmp.dir, 'p', 'model.bin.part'), destPath: join(tmp.dir, 'd', 'model.bin') },
      { fetch, freeBytes: async () => 100e9, sleep: async () => undefined, onRetry: (x) => retries.push(x) });
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(retries.length).toBe(9);
    expect(retries[0]).toMatchObject({ netCode: 'ENETUNREACH' });
  });
  it('Entry 35: offlineRetries (an interactive music download) ends with EM-7002 after a few tries instead of waiting 40 minutes', async () => {
    const data = new Uint8Array(100).fill(3);
    const fetch: DownloadOptions['fetch'] = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND huggingface.co'), { code: 'ENOTFOUND' }) }); };
    const retries: DownloadRetry[] = [];
    const e = await downloadFile({ name: 'track.mp3', url: URL1, bytes: data.length, bytesExact: true, sha256: createHash('sha256').update(data).digest('hex'), modelKey: 'music:x' },
      { partPath: join(tmp.dir, 'p', 'track.mp3.part'), destPath: join(tmp.dir, 'd', 'track.mp3') },
      { fetch, freeBytes: async () => 100e9, sleep: async () => undefined, onRetry: (x) => retries.push(x), offlineRetries: 2 }).then(() => null, (x: unknown) => x as { code?: string; details?: Record<string, unknown> });
    expect(e?.code).toBe('EM-7002');
    expect(e?.details).toMatchObject({ netCode: 'ENOTFOUND' });
    expect(retries.length).toBe(2);
  });
});
