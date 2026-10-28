// Chat document attachments: dependency-free text extraction from PDF, DOCX, text / subtitles / RTF. All fixtures are
// built here (no binary files in the repo).
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { EmError } from '@expertmotion/shared';
import { DOC_MAX_BYTES, DOC_MAX_CHARS, docKindOf, extractDocumentText } from '../../src/s3/doc-extract.js';

// ---------------------------------------------------------------- PDF builder
type Obj = string | Buffer | null;   // null: number unused at top level (e.g. lives in an object stream)
const stream = (dict: string, data: Buffer | string): Buffer => {
  const d = typeof data === 'string' ? Buffer.from(data, 'latin1') : data;
  return Buffer.concat([Buffer.from(`<< ${dict} /Length ${d.length} >>\nstream\n`, 'latin1'), d, Buffer.from('\nendstream', 'latin1')]);
};
const flate = (dict: string, data: string): Buffer => stream(`${dict} /Filter /FlateDecode`, zlib.deflateSync(Buffer.from(data, 'latin1')));
/** Objects are numbered 1..n in order; object 1 is the catalog. */
function pdf(objects: Obj[]): Buffer {
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let len = parts[0]!.length; const offsets: number[] = [];
  objects.forEach((o, k) => {
    offsets.push(len);
    if (o === null) return;
    const b = Buffer.concat([Buffer.from(`${k + 1} 0 obj\n`, 'latin1'), typeof o === 'string' ? Buffer.from(o, 'latin1') : o, Buffer.from('\nendobj\n', 'latin1')]);
    parts.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}
const catalog = '<< /Type /Catalog /Pages 2 0 R >>';
const helvetica = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

// ---------------------------------------------------------------- ZIP builder (stored + deflate, zlib.crc32)
interface ZEntry { name: string; data: string | Buffer; store?: boolean; fakeSize?: number }
function zip(entries: ZEntry[]): Buffer {
  const locals: Buffer[] = []; const centrals: Buffer[] = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : e.data;
    const comp = e.store ? raw : zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0; const method = e.store ? 0 : 8; const usize = e.fakeSize ?? raw.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(usize, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name); offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const contentTypes = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const docx = (body: string, extra: ZEntry[] = [], docOpts: Partial<ZEntry> = {}): Buffer => zip([
  { name: '[Content_Types].xml', data: contentTypes },
  { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body}</w:body></w:document>`, ...docOpts },
  ...extra,
]);

async function emCode(p: Promise<unknown>): Promise<EmError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(EmError); return e as EmError; }
  throw new Error('expected an EmError');
}

describe('docKindOf', () => {
  it('maps extensions', () => {
    expect(docKindOf('Laporan.PDF')).toBe('pdf');
    expect(docKindOf('naskah.docx')).toBe('docx');
    for (const n of ['a.txt', 'b.md', 'c.markdown', 'd.srt', 'e.vtt', 'f.csv', 'g.json', 'h.fountain', 'i.rtf', 'skrip.py']) expect(docKindOf(n)).toBe('text');
    expect(docKindOf('video.mp4')).toBeNull();
    expect(docKindOf('noext')).toBeNull();
    expect(docKindOf('.md')).toBeNull();
  });
  it('prefers magic bytes over the name', () => {
    expect(docKindOf('upload.bin', Buffer.from('%PDF-1.4\n…', 'latin1'))).toBe('pdf');
    expect(docKindOf('upload.bin', docx('<w:p><w:r><w:t>x</w:t></w:r></w:p>'))).toBe('docx');
    expect(docKindOf('arsip.zip', zip([{ name: 'a.txt', data: 'x' }]))).toBeNull();
    expect(docKindOf('catatan.txt', new Uint8Array([0x68, 0x69]))).toBe('text');
  });
});

describe('extractDocumentText: PDF', () => {
  it('reads an uncompressed content stream (Tj, TJ, T*, Td, escapes, octal)', async () => {
    const content = 'BT /F1 12 Tf 72 720 Td (Halo, dunia!) Tj 0 -14 Td (Baris kedua \\(dengan kurung\\) dan \\\\ garis) Tj T* '
      + '[(Kata)-300(terpisah)20(ok)] TJ T* (Caf\\351 \\0501\\051) Tj ET';
    const buf = pdf([catalog, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      helvetica, stream('', content)]);
    const r = await extractDocumentText(buf, 'contoh.pdf');
    expect(r.kind).toBe('pdf');
    expect(r.pages).toBe(1);
    expect(r.text).toBe('Halo, dunia!\nBaris kedua (dengan kurung) dan \\ garis\nKata terpisahok\nCafé (1)');
    expect(r.truncated).toBe(false);
    expect(r.chars).toBe(r.text.length);
  });

  it('inflates FlateDecode streams and keeps page order from the page tree', async () => {
    const buf = pdf([catalog, '<< /Type /Pages /Kids [4 0 R 3 0 R] /Count 2 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 7 0 R >> >> /Contents [6 0 R] >>',
      flate('', 'BT /F1 11 Tf 1 0 0 1 72 700 Tm (Halaman dua) Tj 1 0 0 1 72 680 Tm (baris berikut) Tj ET'),
      flate('', "BT /F1 11 Tf 72 700 Td (Halaman satu) Tj (lanjut) ' ET"),
      helvetica]);
    const r = await extractDocumentText(buf, 'dua.pdf');
    expect(r.pages).toBe(2);
    expect(r.text).toBe('Halaman satu\nlanjut\n\nHalaman dua\nbaris berikut');
  });

  it('maps hex glyph codes through a ToUnicode CMap (bfchar, bfrange, array range)', async () => {
    const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def\n'
      + '1 begincodespacerange <0000> <FFFF> endcodespacerange\n'
      + '2 beginbfchar <0100> <00E9> <0101> <2014> endbfchar\n'
      + '2 beginbfrange <0003> <005D> <0020> <0200> <0201> [<0041> <D835DC00>] endbfrange\n'
      + 'endcmap CMapName currentdict /CMap defineresource pop end end';
    // "Kafe" with é: K=0x4B→code 0x4B-0x20+3=0x2E, a→0x44, f→0x49; space→0x03
    const g = (s: string): string => [...s].map((ch) => (ch.charCodeAt(0) - 0x20 + 3).toString(16).padStart(4, '0')).join('');
    const content = `BT /F2 12 Tf 72 700 Td <${g('Kaf')}0100> Tj <0003> Tj [<${g('di')}> -250 <${g('Bandung')}>] TJ T* <0101 0200 0201> Tj ET`;
    const buf = pdf([catalog, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources 4 0 R /Contents 5 0 R >>',
      '<< /Font << /F2 6 0 R >> >>',
      flate('', content),
      '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+Arial /Encoding /Identity-H /DescendantFonts [8 0 R] /ToUnicode 7 0 R >>',
      flate('', cmap),
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ABCDEF+Arial >>']);
    const r = await extractDocumentText(buf, 'cmap.pdf');
    expect(r.text).toBe('Kafé di Bandung\n—A\u{1D400}');
    expect(r.warnings).toEqual([]);
  });

  it('skips Identity-H text without a Unicode map and warns', async () => {
    const buf = pdf([catalog, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 6 0 R >> >> /Contents 5 0 R >>',
      helvetica,
      stream('', 'BT /F1 10 Tf (Terbaca) Tj /F2 10 Tf <00230045> Tj ET'),
      '<< /Type /Font /Subtype /Type0 /BaseFont /X /Encoding /Identity-H >>']);
    const r = await extractDocumentText(buf, 'campur.pdf');
    expect(r.text).toBe('Terbaca');
    expect(r.warnings.join(' ')).toMatch(/Unicode map/);
  });

  it('decodes UTF-16BE strings and reads objects inside an object stream', async () => {
    // Objects 2..4 (pages, page, font) live in object stream 6.
    const inner = ['<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', helvetica];
    let header = ''; let body = ''; for (let k = 0; k < inner.length; k++) { header += `${k + 2} ${body.length} `; body += `${inner[k]}\n`; }
    const objstm = flate(`/Type /ObjStm /N 3 /First ${header.length}`, header + body);
    const buf = pdf([catalog, null, null, null,
      flate('', 'BT /F1 12 Tf (\\376\\377\\000S\\000e\\000l\\000a\\000m\\000a\\000t\\000 \\001\\034) Tj ET'), objstm]);
    const r = await extractDocumentText(buf, 'objstm.pdf');
    expect(r.pages).toBe(1);
    expect(r.text).toBe('Selamat Ĝ');
  });

  it('a PDF with only an image is a scanned PDF (EM-4309)', async () => {
    const buf = pdf([catalog, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
      stream('/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', Buffer.from([0xff, 0xd8, 0x28, 0x29, 0x54, 0x6a, 0xff, 0xd9])),
      stream('', 'q 612 0 0 792 0 0 cm /Im1 Do Q')]);
    const e = await emCode(extractDocumentText(buf, 'pindaian.pdf'));
    expect(e.code).toBe('EM-4309');
    expect(e.status).toBe(422);
    expect(e.message).toBe('This PDF has no text layer (scanned pages); paste the text or attach a text file.');
  });

  it('never throws on garbage, only EM-4309 with the file name', async () => {
    const junk = Buffer.concat([Buffer.from('%PDF-1.4\n1 0 obj << /Length 999999 >> stream\n', 'latin1'), Buffer.from(Array.from({ length: 4000 }, (_, k) => (k * 37) & 255)), Buffer.from('\n7 0 obj << /Filter /FlateDecode >> stream\nnot zlib', 'latin1')]);
    const e = await emCode(extractDocumentText(junk, 'rusak.pdf'));
    expect(e.code).toBe('EM-4309');
    expect(e.message).toBe('No readable text was found in rusak.pdf.');
  });
});

describe('extractDocumentText: DOCX', () => {
  const body = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Judul: Kopi &amp; Teh di Yogyakarta</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t xml:space="preserve">Harga naik 5 &lt; 10 </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>persen</w:t></w:r><w:r><w:tab/><w:t>&quot;caf&#233;&quot; &#x2014; &apos;ok&apos;</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>baris</w:t><w:br/><w:t>baru</w:t></w:r><w:r><w:delText>dihapus</w:delText></w:r></w:p><w:p/><w:p><w:r><w:t>Akhir</w:t></w:r></w:p>';
  it('reads paragraphs, runs, tabs, breaks and entities (deflate entries) plus footnotes (stored)', async () => {
    const buf = docx(body, [{ name: 'word/footnotes.xml', store: true, data: `<w:footnotes ${W}><w:footnote w:id="1"><w:p><w:r><w:t>Sumber: BPS 2025</w:t></w:r></w:p></w:footnote></w:footnotes>` }]);
    const r = await extractDocumentText(buf, 'naskah.docx');
    expect(r.kind).toBe('docx');
    expect(r.pages).toBeUndefined();
    expect(r.text).toBe('Judul: Kopi & Teh di Yogyakarta\nHarga naik 5 < 10 persen\t"café" — \'ok\'\nbaris\nbaru\n\nAkhir\n\nSumber: BPS 2025');
  });
  it('guards zip bombs: an entry over 50 MB uncompressed is not read', async () => {
    const declared = docx(body, [], { fakeSize: 60 * 1024 * 1024 });
    expect((await emCode(extractDocumentText(declared, 'bom.docx'))).code).toBe('EM-4309');
    const zeros = Buffer.alloc(51 * 1024 * 1024, 0x20);
    const lying = zip([{ name: 'word/document.xml', data: zeros, fakeSize: 1000 }]);
    expect(lying.length).toBeLessThan(1024 * 1024);
    const e = await emCode(extractDocumentText(lying, 'bom2.docx'));
    expect(e.code).toBe('EM-4309');
    expect(e.message).toBe('No readable text was found in bom2.docx.');
  });
  it('a broken DOCX is EM-4309', async () => {
    expect((await emCode(extractDocumentText(Buffer.from('PK\x03\x04 bukan zip', 'latin1'), 'x.docx'))).code).toBe('EM-4309');
  });
});

describe('extractDocumentText: text', () => {
  const id = 'Ringkasan: “Pembangunan” di Nusa Tenggara — angka naik 1.234,5 ton.\nCatatan: é, ñ, ü.';
  it('UTF-8 with BOM, UTF-16LE/BE with BOM, Latin-1 fallback', async () => {
    expect((await extractDocumentText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(id)]), 'a.md')).text).toBe(id);
    expect((await extractDocumentText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(id, 'utf16le')]), 'a.txt')).text).toBe(id);
    const be = Buffer.from(id, 'utf16le'); be.swap16();
    expect((await extractDocumentText(Buffer.concat([Buffer.from([0xfe, 0xff]), be]), 'a.txt')).text).toBe(id);
    const l1 = await extractDocumentText(Buffer.from('Kafe caf\xe9 di Bali', 'latin1'), 'lama.txt');
    expect(l1.text).toBe('Kafe café di Bali');
    expect(l1.warnings[0]).toMatch(/Latin-1/);
    expect((await extractDocumentText(Buffer.from('Halo semua', 'utf16le'), 'nobom.txt')).text).toBe('Halo semua');
  });
  it('keeps SRT/VTT as is and normalises whitespace', async () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,500\r\nSelamat pagi   \r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nApa kabar?\r\n';
    expect((await extractDocumentText(Buffer.from(srt), 'sub.srt')).text).toBe('1\n00:00:01,000 --> 00:00:02,500\nSelamat pagi\n\n2\n00:00:03,000 --> 00:00:04,000\nApa kabar?');
    expect((await extractDocumentText(Buffer.from('\n\nA  \n\n\n\n\n\nB\t\n'), 'n.md')).text).toBe('A\n\n\nB');
  });
  it('strips RTF control words', async () => {
    const rtf = '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}{\\colortbl;\\red0\\green0\\blue0;}{\\*\\generator Word;}\\f0\\fs24 Kota {\\b Bandung}\\par Caf\\\'e9 \\u8212? enak\\tab ok\\par}';
    expect((await extractDocumentText(Buffer.from(rtf, 'latin1'), 'surat.rtf')).text).toBe('Kota Bandung\nCafé — enak\tok');
  });
  it('an empty or whitespace-only file is EM-4309', async () => {
    const e = await emCode(extractDocumentText(Buffer.from(' \n\t\n'), 'kosong.txt'));
    expect(e.code).toBe('EM-4309');
    expect(e.message).toBe('No readable text was found in kosong.txt.');
  });
});

describe('extractDocumentText: limits', () => {
  it('truncates on a paragraph boundary and warns', async () => {
    const paras = Array.from({ length: 10 }, (_, k) => `Paragraf ${k + 1}: ${'kata '.repeat(6).trim()}.`);
    const full = paras.join('\n\n');
    const r = await extractDocumentText(Buffer.from(full), 'panjang.md', { maxChars: 100 });
    expect(r.truncated).toBe(true);
    expect(r.chars).toBeLessThanOrEqual(100);
    expect(r.chars).toBe(r.text.length);
    expect(full.startsWith(r.text)).toBe(true);
    expect(full.slice(r.text.length, r.text.length + 2)).toBe('\n\n');
    expect(r.warnings.some((w) => w.includes(`${full.length} characters`))).toBe(true);
    const def = await extractDocumentText(Buffer.from('a'.repeat(DOC_MAX_CHARS + 50)), 'x.txt');
    expect(def.truncated).toBe(true);
    expect(def.chars).toBe(DOC_MAX_CHARS);
  });
  it('rejects files over 20 MB (EM-1002) and unknown types (EM-1001)', async () => {
    const e = await emCode(extractDocumentText(Buffer.alloc(DOC_MAX_BYTES + 1, 0x41), 'besar.txt'));
    expect(e.code).toBe('EM-1002');
    expect(e.message).toBe('This file is 20.0 MB; the limit is 20 MB.');
    expect(e.details).toMatchObject({ fileName: 'besar.txt', bytes: DOC_MAX_BYTES + 1, limitBytes: DOC_MAX_BYTES });
    expect((await emCode(extractDocumentText(Buffer.from([1, 2, 3]), 'program.exe'))).code).toBe('EM-1001');
  });
});
