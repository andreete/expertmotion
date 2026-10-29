// Regression tests for the 2026-10-29 review findings in the Local Service: R2 (linear htmlToText), R3 (DNS rebinding),
// R8 (PDF object scan).
import { describe, expect, it } from 'vitest';
import { EmError } from '@expertmotion/shared';
import { createEgress, guardedLookup, isPrivateAddress } from '../../src/services/egress.js';
import { HTML_MAX_CHARS, htmlToText } from '../../src/s3/research.js';
import { extractDocumentText } from '../../src/s3/doc-extract.js';

/** Best of three runs: the shared server swaps under other jobs, a single sample measures the machine, not the algorithm. */
const best = (f: () => void): number => { let m = Infinity; for (let k = 0; k < 3; k++) { const t0 = performance.now(); f(); m = Math.min(m, performance.now() - t0); } return m; };

describe('R2: htmlToText runs in linear time', () => {
  it('a 4 MB page of unclosed <nav>/<header>/<article> tags is read in < 500 ms', { timeout: 30_000 }, () => {
    const unit = '<nav x><header y><article z>a ';
    const html = `<html><title>T</title><body>${unit.repeat(Math.ceil((4 * 1024 * 1024) / unit.length))}</body></html>`;
    expect(html.length).toBeGreaterThan(4_000_000);
    let r = { title: '', text: '' };
    expect(best(() => { r = htmlToText(html); })).toBeLessThan(500);
    expect(r.title).toBe('T');
    expect(r.text.startsWith('a a a')).toBe(true);
  });
  it('unclosed comments, <title>, <script>, bare "<", entities and blank runs stay linear too', { timeout: 30_000 }, () => {
    for (const unit of ['<!-- x ', '<title>', '<script>', '< < <', '<a b="', '<main>', '&aaaaaaaaaaaaaaaaaaaaaa', '&amp;', ' \n']) {
      const html = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(best(() => htmlToText(html)), unit).toBeLessThan(500);
    }
  });
  it('markup beyond HTML_MAX_CHARS is ignored', () => {
    const html = `<p>${'x'.repeat(HTML_MAX_CHARS)}</p><p>LATE</p>`;
    expect(htmlToText(html).text).not.toContain('LATE');
  });
  it('keeps the old behaviour: blocks dropped, main preferred, lists and cells', () => {
    const body = `<p>${'Isi utama. '.repeat(60)}</p>`;
    const html = `<!doctype html><html><head><title>Ekspor &amp; Impor</title><style>p{}</style></head><body><nav>Menu</nav><HEADER>Kop</HEADER>
      <!-- komentar --><MAIN class="m">${body}<ul><li>satu</li><li>dua</li></ul><table><tr><td>a</td><th>b</th></tr></table><script>alert(1)</script></MAIN><footer>Kaki</footer></body></html>`;
    const r = htmlToText(html);
    expect(r.title).toBe('Ekspor & Impor');
    for (const x of ['Menu', 'Kop', 'komentar', 'Kaki', 'alert', 'p{}']) expect(r.text).not.toContain(x);
    expect(r.text).toContain('• satu\n\n• dua');   // same as before: </li> ends a line, <li> starts one
    expect(r.text).toContain('a b');
    expect(r.text.startsWith('Isi utama.')).toBe(true);
    expect(htmlToText('<p>1 < 2 &lt; 3</p><nav>tanpa penutup<p>sisa</p>').text).toBe('1 < 2 < 3\ntanpa penutup sisa');
  });
});

describe('R3: research connects only to the address that was checked', () => {
  it('isPrivateAddress covers IPv4-compatible, NAT64, site-local and hex-mapped forms', () => {
    for (const a of ['::7f00:1', '::127.0.0.1', '::ffff:7f00:1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', 'fec0::1', 'fe80::1%eth0', '::ffff:10.0.0.1', '[::1]']) expect(isPrivateAddress(a)).toBe(true);
    for (const a of ['93.184.216.34', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect(isPrivateAddress(a)).toBe(false);
  });
  it('guardedLookup refuses private answers and serves public ones in both callback shapes', async () => {
    const call = (answers: string[], o: object) => new Promise<{ err: NodeJS.ErrnoException | null; a: unknown; f?: number }>((res) => guardedLookup(async () => answers)('h.example', o as never, (err, a, f) => res({ err, a, ...(f !== undefined ? { f } : {}) })));
    expect((await call(['93.184.216.34', '127.0.0.1'], { all: true })).err?.code).toBe('EM_PRIVATE_ADDRESS');
    expect((await call(['93.184.216.34', '2606:4700::1'], { all: true })).a).toEqual([{ address: '93.184.216.34', family: 4 }, { address: '2606:4700::1', family: 6 }]);
    expect(await call(['2606:4700::1', '93.184.216.34'], { family: 4 })).toEqual({ err: null, a: '93.184.216.34', f: 4 });
    expect((await call([], {})).err?.code).toBe('ENOTFOUND');
  });
  it('a DNS answer that flips to 127.0.0.1 after the check is refused at connect time (EM-8203)', async () => {
    let n = 0;
    const lookup = async (): Promise<string[]> => (++n === 1 ? ['93.184.216.34'] : ['127.0.0.1']);   // TTL 0 rebinding
    const egress = createEgress({ isPrivate: () => false, lookup });
    const err = await egress.for('research')('https://rebind.example.com/page').then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(EmError);
    expect((err as EmError).code).toBe('EM-8203');
    expect(n).toBe(2);   // the pre-check AND the socket's own lookup ran; no connection was made to the second answer
  });
});

describe('R8: PDF object scan is linear', () => {
  it('300 000 objects without endobj (≈ 3 MB) are scanned in well under 2 s', async () => {
    const parts: string[] = ['%PDF-1.4\n'];
    for (let k = 1; k <= 300_000; k++) parts.push(`${k} 0 obj\n`);
    const buf = Buffer.from(parts.join(''), 'latin1');
    const t0 = performance.now();
    await extractDocumentText(buf, 'x.pdf').catch(() => undefined);   // no text: may report EM-1xxx; only the time matters
    expect(performance.now() - t0).toBeLessThan(2000);
  });
  it('a long run of digits does not backtrack quadratically', async () => {
    const buf = Buffer.from(`%PDF-1.4\n${'7'.repeat(2_000_000)} 0 obj\n`, 'latin1');
    const t0 = performance.now();
    await extractDocumentText(buf, 'y.pdf').catch(() => undefined);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
