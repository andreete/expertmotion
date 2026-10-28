// Text extraction for chat document attachments (PDF, DOCX, plain text / Markdown / subtitles / scripts, RTF). Pure Node,
// no dependencies: PDF content streams are parsed directly (FlateDecode via node:zlib, ToUnicode CMaps, PDFDoc/WinAnsi
// bytes, UTF-16BE strings), DOCX through a minimal central-directory ZIP reader. The extracted text goes to the AI agent
// as context, so it is normalised and capped at a paragraph boundary. Malformed input never throws except EM-4309
// ("no readable text") and EM-1002 / EM-1001 (too large / not a document).
import zlib from 'node:zlib';
import { EmError } from '@expertmotion/shared';

export const DOC_MAX_BYTES = 20 * 1024 * 1024;
export const DOC_MAX_CHARS = 60_000;

export type DocKind = 'pdf' | 'docx' | 'text';
export interface DocExtract { kind: DocKind; text: string; chars: number; truncated: boolean; pages?: number; warnings: string[] }

const ZIP_ENTRY_MAX = 50 * 1024 * 1024;     // zip-bomb guard per entry (uncompressed)
const ZIP_MAX_ENTRIES = 20_000;
const PDF_MAX_STREAMS = 2000;
const PDF_STREAM_MAX = 32 * 1024 * 1024;    // inflated size of one stream
const PDF_TOTAL_MAX = 96 * 1024 * 1024;     // inflated bytes over the whole file
const PDF_MAX_OPS = 3_000_000;              // content-stream tokens over the whole file
const CMAP_MAX_ENTRIES = 200_000;

const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'mdown', 'srt', 'vtt', 'csv', 'tsv', 'json', 'fountain', 'fdx', 'rtf', 'log',
  'yaml', 'yml', 'xml', 'html', 'htm', 'ini', 'toml', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'sql',
]);

function extOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(i + 1).toLowerCase() : '';
}
const asBuffer = (u: Uint8Array): Buffer => (Buffer.isBuffer(u) ? u : Buffer.from(u.buffer, u.byteOffset, u.byteLength));

/** Document kind from magic bytes (`%PDF-` in the first 1 KiB; a ZIP containing `word/document.xml`), else the extension. */
export function docKindOf(fileName: string, head?: Uint8Array): DocKind | null {
  if (head && head.length > 0) {
    const b = asBuffer(head);
    if (b.subarray(0, 1024).indexOf('%PDF-', 0, 'latin1') >= 0) return 'pdf';
    if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && b.indexOf('word/document.xml', 0, 'latin1') >= 0) return 'docx';
  }
  const ext = extOf(fileName);
  if (ext === 'pdf') return 'pdf';
  if (ext === 'docx') return 'docx';
  return TEXT_EXT.has(ext) ? 'text' : null;
}

const noText = (fileName: string, scanned = false): EmError => new EmError('EM-4309',
  scanned ? 'This PDF has no text layer (scanned pages); paste the text or attach a text file.' : `No readable text was found in ${fileName}.`,
  { status: 422, details: { fileName } });

export async function extractDocumentText(buf: Buffer, fileName: string, opts: { maxChars?: number } = {}): Promise<DocExtract> {
  if (buf.length > DOC_MAX_BYTES) {
    throw new EmError('EM-1002', `This file is ${(buf.length / 1048576).toFixed(1)} MB; the limit is ${DOC_MAX_BYTES / 1048576} MB.`,
      { status: 422, details: { fileName, bytes: buf.length, limitBytes: DOC_MAX_BYTES } });
  }
  const kind = docKindOf(fileName, buf);
  if (!kind) {
    throw new EmError('EM-1001', 'This file type cannot be read as a document. Attach PDF, DOCX, TXT, MD, SRT, VTT, CSV, JSON or a script file.',
      { status: 422, details: { fileName } });
  }
  const warnings: string[] = [];
  let raw = ''; let pages: number | undefined;
  if (kind === 'pdf') {
    const r = pdfText(buf, warnings);
    pages = r.pages;
    raw = r.text;
    if (!normalise(raw)) throw noText(fileName, r.images > 0 && !r.encrypted);
  } else if (kind === 'docx') {
    raw = docxText(buf, warnings);
  } else {
    raw = decodeText(buf, warnings);
    if (extOf(fileName) === 'rtf' || raw.startsWith('{\\rtf')) raw = rtfToText(raw);
  }
  const text0 = normalise(raw);
  if (!text0) throw noText(fileName);
  const max = Math.max(1, Math.floor(opts.maxChars ?? DOC_MAX_CHARS));
  const { text, truncated } = truncateText(text0, max);
  if (truncated) warnings.push(`The document has ${text0.length} characters; only the first ${text.length} are sent.`);
  return { kind, text, chars: text.length, truncated, ...(pages === undefined ? {} : { pages }), warnings };
}

// ---------------------------------------------------------------------------------------------------------------- text

function normalise(t: string): string {
  return t.replace(/\r\n?/g, '\n').replace(/\f/g, '\n').replace(/﻿/g, '')
    .replace(/[\x00-\x08\x0B\x0E-\x1F\x7F]/g, '')
    .replace(/[ \t ]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/^\n+/, '').replace(/\s+$/, '');
}

function truncateText(t: string, max: number): { text: string; truncated: boolean } {
  if (t.length <= max) return { text: t, truncated: false };
  const half = max * 0.5;
  let cut = t.lastIndexOf('\n\n', max);
  if (cut < half) cut = t.lastIndexOf('\n', max);
  if (cut < half) cut = t.lastIndexOf(' ', max);
  if (cut < half) cut = max;
  const c = t.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;            // never split a surrogate pair
  return { text: t.slice(0, cut).replace(/\s+$/, ''), truncated: true };
}

function decodeText(buf: Buffer, warnings: string[]): string {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return utf8OrLatin1(buf.subarray(3), warnings);
  if (buf[0] === 0xff && buf[1] === 0xfe) return utf16le(buf.subarray(2));
  if (buf[0] === 0xfe && buf[1] === 0xff) return utf16be(buf.subarray(2));
  // UTF-16 without a BOM: most of the high bytes of ASCII text are zero.
  const probe = buf.subarray(0, 4096);
  if (probe.length >= 4) {
    let evenZero = 0, oddZero = 0;
    for (let i = 0; i + 1 < probe.length; i += 2) { if (probe[i] === 0) evenZero++; if (probe[i + 1] === 0) oddZero++; }
    const pairs = Math.floor(probe.length / 2);
    if (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) return utf16le(buf);
    if (evenZero > pairs * 0.3 && oddZero < pairs * 0.05) return utf16be(buf);
  }
  return utf8OrLatin1(buf, warnings);
}
function utf8OrLatin1(buf: Buffer, warnings: string[]): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {
    warnings.push('The file is not valid UTF-8; it was read as Latin-1.');
    return buf.toString('latin1');
  }
}
const utf16le = (b: Buffer): string => b.subarray(0, b.length & ~1).toString('utf16le');
function utf16be(b: Buffer): string {
  const s = Buffer.from(b.subarray(0, b.length & ~1));
  s.swap16();
  return s.toString('utf16le');
}

// WinAnsi (cp1252) 0x80–0x9F; the undefined slots stay C1 controls and are dropped.
const CP1252_HI = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f'
  + '\u0090‘’“”•–—˜™š›œ\u009džŸ';
const winAnsi = (b: number): string => (b >= 0x80 && b <= 0x9f ? CP1252_HI[b - 0x80]! : String.fromCharCode(b));

const RTF_SKIP = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr',
  'footerl', 'footerr', 'expandedcolortbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'themedata', 'colorschememapping',
  'latentstyles', 'datastore', 'xmlnstbl', 'mmathPr', 'pgdsctbl', 'filetbl', 'revtbl', 'bkmkstart', 'bkmkend', 'fldinst']);
const RTF_CHARS: Record<string, string> = { par: '\n', line: '\n', sect: '\n\n', page: '\n\n', row: '\n', cell: '\t', tab: '\t',
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' };

/** RTF → plain text: control words stripped, destinations such as font tables skipped, \'hh and \uN decoded. */
function rtfToText(s: string): string {
  const out: string[] = [];
  const stack: { skip: boolean; uc: number }[] = [];
  let skip = false, uc = 1, pending = 0;
  const emit = (t: string): void => { if (pending > 0) { pending--; return; } if (!skip) out.push(t); };
  for (let i = 0; i < s.length;) {
    const ch = s[i]!;
    if (ch === '{') { stack.push({ skip, uc }); i++; continue; }
    if (ch === '}') { const g = stack.pop(); if (g) { skip = g.skip; uc = g.uc; } pending = 0; i++; continue; }
    if (ch === '\\') {
      const nx = s[i + 1] ?? '';
      if (/[a-zA-Z]/.test(nx)) {
        const m = /^([a-zA-Z]+)(-?\d+)? ?/.exec(s.slice(i + 1, i + 64))!;
        i += 1 + m[0].length;
        const word = m[1]!; const arg = m[2] === undefined ? undefined : Number(m[2]);
        if (RTF_SKIP.has(word)) skip = true;
        else if (word === 'u' && arg !== undefined) { if (!skip) out.push(String.fromCharCode(arg < 0 ? arg + 65536 : arg)); pending = uc; }
        else if (word === 'uc' && arg !== undefined) uc = Math.max(0, arg);
        else if (Object.hasOwn(RTF_CHARS, word)) { pending = 0; emit(RTF_CHARS[word]!); }
        continue;
      }
      if (nx === '\'') { const h = parseInt(s.slice(i + 2, i + 4), 16); i += 4; if (!Number.isNaN(h)) emit(winAnsi(h)); continue; }
      if (nx === '*') { skip = true; i += 2; continue; }
      if (nx === '~') { emit(' '); i += 2; continue; }
      if (nx === '_') { emit('-'); i += 2; continue; }
      if (nx === '-') { i += 2; continue; }
      if (nx === '\n' || nx === '\r') { emit('\n'); i += 2; continue; }
      emit(nx); i += 2; continue;
    }
    if (ch === '\n' || ch === '\r') { i++; continue; }
    emit(ch); i++;
  }
  return out.join('');
}

// ---------------------------------------------------------------------------------------------------------------- DOCX

interface CdEntry { name: string; method: number; flags: number; csize: number; usize: number; local: number }

function zipDirectory(buf: Buffer): Map<string, CdEntry> | null {
  const out = new Map<string, CdEntry>();
  let eocd = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 65535); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) return null;
  const count = Math.min(buf.readUInt16LE(eocd + 10), ZIP_MAX_ENTRIES);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    if (p < 0 || p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(p + 28), extra = buf.readUInt16LE(p + 30), comment = buf.readUInt16LE(p + 32);
    if (p + 46 + nameLen > buf.length) break;
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    out.set(name, { name, flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), local: buf.readUInt32LE(p + 42) });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

function zipEntry(buf: Buffer, e: CdEntry, warnings: string[]): Buffer | null {
  if (e.flags & 1) { warnings.push(`${e.name} is encrypted.`); return null; }
  if (e.usize > ZIP_ENTRY_MAX || e.csize === 0xffffffff) { warnings.push(`${e.name} is larger than ${ZIP_ENTRY_MAX / 1048576} MB and was skipped.`); return null; }
  const l = e.local;
  if (l + 30 > buf.length || buf.readUInt32LE(l) !== 0x04034b50) return null;
  const start = l + 30 + buf.readUInt16LE(l + 26) + buf.readUInt16LE(l + 28);
  const end = start + e.csize;
  if (end > buf.length) return null;
  const data = buf.subarray(start, end);
  if (e.method === 0) return data;
  if (e.method !== 8) return null;
  try { return zlib.inflateRawSync(data, { maxOutputLength: ZIP_ENTRY_MAX }); } catch {
    warnings.push(`${e.name} could not be decompressed.`);
    return null;
  }
}

function docxText(buf: Buffer, warnings: string[]): string {
  const dir = zipDirectory(buf);
  if (!dir) return '';
  const read = (name: string): string => { const e = dir.get(name); const b = e ? zipEntry(buf, e, warnings) : null; return b ? b.toString('utf8') : ''; };
  const parts = [wordXmlToText(read('word/document.xml')).replace(/\s+$/, '')];
  for (const extra of ['word/footnotes.xml', 'word/endnotes.xml']) {
    if (!dir.has(extra)) continue;
    const t = wordXmlToText(read(extra)).trim();
    if (t) parts.push(t);
  }
  return parts.join('\n\n');
}

const XML_ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return XML_ENT[e]!;
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '�';
  });
}

/** WordprocessingML → text: <w:t> runs, <w:p> → newline, <w:tab/> → tab (not the tab stops in <w:tabs>), <w:br/>/<w:cr/> → newline. */
function wordXmlToText(xml: string): string {
  const out: string[] = [];
  let inT = false, inTabs = 0;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*)>|([^<]+)/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    if (m[4] !== undefined) { if (inT) out.push(decodeEntities(m[4])); continue; }
    const close = m[1] === '/'; const tag = m[2]!; const self = (m[3] ?? '').endsWith('/');
    switch (tag) {
      case 'w:t': inT = !close && !self; break;
      case 'w:tabs': if (!self) inTabs += close ? -1 : 1; break;
      case 'w:p': if (close || self) out.push('\n'); break;
      case 'w:tab': if (!close && inTabs <= 0) out.push('\t'); break;
      case 'w:br': case 'w:cr': if (!close) out.push('\n'); break;
      case 'w:noBreakHyphen': if (!close) out.push('-'); break;
      default: break;
    }
  }
  return out.join('');
}

// ---------------------------------------------------------------------------------------------------------------- PDF

interface PdfObj { dict: string; raw?: Buffer | undefined; decoded?: string | null }
interface CMap { bytes: 1 | 2; map: Map<number, string> }
interface FontInfo { cmap: CMap | null; identity: boolean }

const REF = /(\d+)\s+\d+\s+R/g;
const refsIn = (s: string): number[] => [...s.matchAll(REF)].map((m) => Number(m[1]));
const typeIs = (dict: string, t: string): boolean => new RegExp(`/Type\\s*/${t}(?![A-Za-z0-9])`).test(dict);

function inflate(raw: Buffer, max: number): Buffer | null {
  const o = { maxOutputLength: max, finishFlush: zlib.constants.Z_SYNC_FLUSH };
  try { return zlib.inflateSync(raw, o); } catch { /* fall through */ }
  try { return zlib.inflateRawSync(raw, o); } catch { return null; }
}

function hexToUnits(h: string): string {
  if (h.length <= 2) return String.fromCharCode(parseInt(h || '0', 16));
  const p = h.length % 4 ? h + '0'.repeat(4 - (h.length % 4)) : h;
  let s = '';
  for (let i = 0; i < p.length; i += 4) s += String.fromCharCode(parseInt(p.slice(i, i + 4), 16));
  return s;
}

function parseCMap(s: string): CMap {
  const map = new Map<number, string>();
  let bytes: 1 | 2 = 1; let sawSpace = false;
  const cs = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(s);
  if (cs) { const h = /<([0-9A-Fa-f]+)>/.exec(cs[1]!); if (h) { sawSpace = true; if (h[1]!.length >= 4) bytes = 2; } }
  for (const blk of s.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) {
      if (map.size >= CMAP_MAX_ENTRIES) break;
      if (!sawSpace && m[1]!.length >= 4) bytes = 2;
      map.set(parseInt(m[1]!, 16), hexToUnits(m[2]!));
    }
  }
  for (const blk of s.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of blk[1]!.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1]!, 16), hi = parseInt(m[2]!, 16);
      if (!sawSpace && m[1]!.length >= 4) bytes = 2;
      if (hi < lo || hi - lo > 65535 || map.size + (hi - lo) > CMAP_MAX_ENTRIES) continue;
      const dst = m[3]!;
      if (dst.startsWith('[')) {
        const list = [...dst.matchAll(/<([0-9A-Fa-f]*)>/g)].map((x) => hexToUnits(x[1]!));
        for (let c = lo; c <= hi && c - lo < list.length; c++) map.set(c, list[c - lo]!);
      } else {
        const base = hexToUnits(dst.slice(1, -1));
        const head = base.slice(0, -1); const last = base.charCodeAt(base.length - 1);
        for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode((last + c - lo) & 0xffff));
      }
    }
  }
  return { bytes, map };
}

interface PdfState { ops: number; unmapped: number }

function showString(bytes: string, font: FontInfo | null, st: PdfState): string {
  if (font?.cmap) {
    const { cmap } = font; let r = '';
    for (let k = 0; k < bytes.length; k += cmap.bytes) {
      const code = cmap.bytes === 2 ? (bytes.charCodeAt(k) << 8) | (bytes.charCodeAt(k + 1) || 0) : bytes.charCodeAt(k);
      const u = cmap.map.get(code);
      if (u !== undefined) r += u;
      else if (cmap.bytes === 1) r += winAnsi(code);
      else st.unmapped++;
    }
    return r;
  }
  if (bytes.charCodeAt(0) === 0xfe && bytes.charCodeAt(1) === 0xff) return utf16be(Buffer.from(bytes.slice(2), 'latin1'));
  if (font?.identity) { st.unmapped++; return ''; }                 // 2-byte glyph ids without a Unicode map: unreadable
  let r = '';
  for (let k = 0; k < bytes.length; k++) r += winAnsi(bytes.charCodeAt(k));
  return r;
}

type Tok = { t: 'num'; v: number } | { t: 'str'; v: string } | { t: 'name'; v: string } | { t: 'arr'; v: Tok[] };
const isWs = (c: number): boolean => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c: number): boolean => isWs(c) || c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;

/** Text from one content stream: Tj / TJ / ' / " with T* / Td / TD / Tm / ET as line breaks. */
function contentText(s: string, fontOf: (name: string) => FontInfo | null, st: PdfState): string {
  const out: string[] = []; let last = '\n';
  const push = (t: string): void => {
    let clean = '';
    for (const ch of t) { const c = ch.charCodeAt(0); if (ch === '\r') clean += '\n'; else if ((c >= 32 && !(c >= 0x7f && c <= 0x9f)) || ch === '\n' || ch === '\t') clean += ch; }
    if (clean) { out.push(clean); last = clean[clean.length - 1]!; }
  };
  const nl = (): void => { if (last !== '\n') { out.push('\n'); last = '\n'; } };
  const sp = (): void => { if (last !== ' ' && last !== '\n' && last !== '\t') { out.push(' '); last = ' '; } };
  const stack: Tok[] = []; const arrs: Tok[][] = [];
  const put = (t: Tok): void => { (arrs.length ? arrs[arrs.length - 1]! : stack).push(t); };
  let font: FontInfo | null = null; let lastY: number | null = null;
  const num = (k: number): number => { const t = stack[stack.length - k]; return t && t.t === 'num' ? t.v : 0; };
  const n = s.length; let i = 0;
  while (i < n) {
    if (++st.ops > PDF_MAX_OPS) break;
    const c = s.charCodeAt(i);
    if (isWs(c)) { i++; continue; }
    if (c === 37) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }          // % comment
    if (c === 40) {                                                                              // ( literal string )
      i++; let depth = 1; let r = '';
      while (i < n) {
        const ch = s[i]!;
        if (ch === '\\') {
          const e = s[i + 1] ?? ''; i += 2;
          switch (e) {
            case 'n': r += '\n'; break; case 'r': r += '\r'; break; case 't': r += '\t'; break;
            case 'b': r += '\b'; break; case 'f': r += '\f'; break;
            case '\r': if (s[i] === '\n') i++; break;
            case '\n': break;
            default:
              if (e >= '0' && e <= '7') {
                let o = e;
                while (o.length < 3 && s[i]! >= '0' && s[i]! <= '7') o += s[i++];
                r += String.fromCharCode(parseInt(o, 8) & 0xff);
              } else r += e;                                                                     // \( \) \\ and unknown escapes
          }
          continue;
        }
        if (ch === '(') depth++;
        else if (ch === ')' && --depth === 0) { i++; break; }
        r += ch; i++;
      }
      put({ t: 'str', v: r }); continue;
    }
    if (c === 60) {                                                                              // <hex> or <<
      if (s.charCodeAt(i + 1) === 60) { i += 2; continue; }
      const end = s.indexOf('>', i + 1); const stop = end < 0 ? n : end;
      let h = s.slice(i + 1, stop).replace(/[^0-9A-Fa-f]/g, '');
      if (h.length % 2) h += '0';
      let r = '';
      for (let k = 0; k < h.length; k += 2) r += String.fromCharCode(parseInt(h.slice(k, k + 2), 16));
      put({ t: 'str', v: r }); i = stop + 1; continue;
    }
    if (c === 62 || c === 123 || c === 125) { i++; continue; }
    if (c === 91) { arrs.push([]); i++; continue; }
    if (c === 93) { const a = arrs.pop(); i++; if (a) put({ t: 'arr', v: a }); continue; }
    if (c === 41) { i++; continue; }
    if (c === 47) {                                                                              // /Name
      let j = i + 1; while (j < n && !isDelim(s.charCodeAt(j))) j++;
      put({ t: 'name', v: s.slice(i + 1, j) }); i = j; continue;
    }
    let j = i; while (j < n && !isDelim(s.charCodeAt(j))) j++;
    if (j === i) { i++; continue; }
    const word = s.slice(i, j); i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) { put({ t: 'num', v: Number(word) }); continue; }
    if (arrs.length) continue;                                                                   // true/false/null inside an array
    const top = stack[stack.length - 1];
    switch (word) {
      case 'Tf': { const f = stack[stack.length - 2]; if (f && f.t === 'name') font = fontOf(f.v); break; }
      case 'Tj': if (top?.t === 'str') push(showString(top.v, font, st)); break;
      case '\'': nl(); if (top?.t === 'str') push(showString(top.v, font, st)); break;
      case '"': nl(); if (top?.t === 'str') push(showString(top.v, font, st)); break;
      case 'TJ':
        if (top?.t === 'arr') for (const el of top.v) {
          if (el.t === 'str') push(showString(el.v, font, st));
          else if (el.t === 'num' && el.v < -200) sp();
        }
        break;
      case 'T*': nl(); break;
      case 'Td': case 'TD': { const ty = num(1), tx = num(2); if (ty !== 0) nl(); else if (tx !== 0) sp(); break; }
      case 'Tm': { const y = num(1); if (lastY !== null) { if (Math.abs(y - lastY) > 0.5) nl(); else sp(); } lastY = y; break; }
      case 'ET': nl(); break;
      case 'ID': {                                                                               // inline image: skip binary data up to EI
        let k = i;
        for (;;) {
          k = s.indexOf('EI', k);
          if (k < 0) { k = n; break; }
          if (isWs(s.charCodeAt(k - 1)) && (k + 2 >= n || isWs(s.charCodeAt(k + 2)))) break;
          k += 2;
        }
        i = k + 2; break;
      }
      default: break;
    }
    stack.length = 0;
  }
  return out.join('');
}

function pdfText(buf: Buffer, warnings: string[]): { text: string; pages: number; images: number; encrypted: boolean } {
  const src = buf.toString('latin1');
  const objs = new Map<number, PdfObj>();
  const streamOrder: number[] = [];
  let streams = 0;
  // 1. Objects, top level. Stream data is skipped using /Length (direct) or the next `endstream`.
  const objRe = /(\d+)\s+(\d+)\s+obj\b/g;
  for (let pos = 0; ;) {
    objRe.lastIndex = pos;
    const m = objRe.exec(src);
    if (!m) break;
    const num = Number(m[1]); const bodyStart = m.index + m[0].length;
    const endobj = src.indexOf('endobj', bodyStart);
    const st = src.indexOf('stream', bodyStart);
    if (st >= 0 && (endobj < 0 || st < endobj)) {
      const dict = src.slice(bodyStart, st);
      let ds = st + 6; if (src[ds] === '\r') ds++; if (src[ds] === '\n') ds++;
      let de = -1; let after = -1;
      const lm = /\/Length\s+(\d+)(?!\d)(?!\s+\d+\s+R)/.exec(dict);
      if (lm) {
        const L = Number(lm[1]);
        if (ds + L <= src.length && /^\s*endstream/.test(src.slice(ds + L, ds + L + 32))) { de = ds + L; after = src.indexOf('endstream', de) + 9; }
      }
      if (de < 0) {
        const es = src.indexOf('endstream', ds);
        if (es < 0) { de = src.length; after = src.length; } else {
          de = es; if (src[de - 1] === '\n') de--; if (src[de - 1] === '\r') de--; after = es + 9;
        }
      }
      if (streams < PDF_MAX_STREAMS) { objs.set(num, { dict, raw: buf.subarray(ds, Math.max(ds, de)) }); streamOrder.push(num); }
      streams++;
      pos = Math.max(after, bodyStart);
    } else {
      const end = endobj < 0 ? Math.min(src.length, bodyStart + 65536) : endobj;
      objs.set(num, { dict: src.slice(bodyStart, Math.min(end, bodyStart + (1 << 20))) });
      pos = endobj < 0 ? bodyStart : endobj + 6;
    }
  }
  if (streams > PDF_MAX_STREAMS) warnings.push(`Only the first ${PDF_MAX_STREAMS} streams of this PDF were read.`);
  const encrypted = /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(src);
  if (encrypted) warnings.push('This PDF is encrypted; its text may not be readable.');

  let budget = PDF_TOTAL_MAX;
  const decode = (o: PdfObj): string | null => {
    if (o.decoded !== undefined) return o.decoded;
    const raw = o.raw; o.decoded = null;
    if (!raw) return null;
    const fm = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(o.dict);
    const filters = fm ? (fm[1]!.match(/\/[A-Za-z0-9]+/g) ?? []).map((f) => f.slice(1)) : [];
    let out: Buffer | null = null;
    if (filters.length === 0) out = raw;
    else if (filters.length === 1 && (filters[0] === 'FlateDecode' || filters[0] === 'Fl')) out = inflate(raw, Math.min(PDF_STREAM_MAX, Math.max(1, budget)));
    if (!out || out.length > budget) return null;
    budget -= out.length;
    o.decoded = out.toString('latin1');
    return o.decoded;
  };

  // 2. Classify streams; object streams add their objects (top-level definitions win).
  let images = 0;
  const cmaps = new Map<number, CMap>();
  const contentCandidates: number[] = [];
  const skipDict = /\/Length[123](?![0-9])|\/Subtype\s*\/(Type1C|CIDFontType0C|OpenType|XML)(?![A-Za-z0-9])|\/Type\s*\/(XRef|Metadata|EmbeddedFile)(?![A-Za-z0-9])|\/(FunctionType|PatternType|ShadingType|Alternate)(?![A-Za-z0-9])/;
  for (const num of streamOrder) {
    const o = objs.get(num)!;
    if (/\/Subtype\s*\/Image(?![A-Za-z0-9])/.test(o.dict)) { images++; o.raw = undefined; continue; }
    if (!typeIs(o.dict, 'ObjStm')) continue;
    const s = decode(o); o.decoded = null; o.raw = undefined;
    if (!s) continue;
    const first = Number(/\/First\s+(\d+)/.exec(o.dict)?.[1] ?? NaN); const count = Number(/\/N\s+(\d+)/.exec(o.dict)?.[1] ?? 0);
    if (!Number.isFinite(first)) continue;
    const nums = (s.slice(0, first).match(/\d+/g) ?? []).map(Number);
    for (let k = 0; k < Math.min(count, nums.length / 2); k++) {
      const objNum = nums[2 * k]!, off = nums[2 * k + 1]!;
      const next = 2 * k + 3 < nums.length ? nums[2 * k + 3]! : s.length - first;
      if (!objs.has(objNum)) objs.set(objNum, { dict: s.slice(first + off, first + Math.max(off, next)) });
    }
  }
  for (const num of streamOrder) {
    const o = objs.get(num)!;
    if (!o.raw || typeIs(o.dict, 'ObjStm') || skipDict.test(o.dict)) { o.raw = undefined; continue; }
    const s = decode(o); o.raw = undefined;
    if (!s) continue;
    if (s.includes('beginbfchar') || s.includes('beginbfrange') || s.includes('begincmap')) { cmaps.set(num, parseCMap(s)); o.decoded = null; continue; }
    if (/(Tj|TJ|')/.test(s)) contentCandidates.push(num); else o.decoded = null;
  }

  // 3. Fonts: resource name → font object → ToUnicode CMap.
  const fontCache = new Map<number, FontInfo>();
  const fontInfo = (num: number): FontInfo => {
    let f = fontCache.get(num);
    if (!f) {
      const d = objs.get(num)?.dict ?? '';
      const tu = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(d);
      f = { cmap: tu ? cmaps.get(Number(tu[1])) ?? null : null, identity: /\/Identity-[HV]/.test(d) };
      fontCache.set(num, f);
    }
    return f;
  };
  const fontPairs = (res: string, into: Map<string, number>, overwrite: boolean): void => {
    for (const m of res.matchAll(/\/Font(?![A-Za-z0-9])\s*(<<[\s\S]*?>>|(\d+)\s+\d+\s+R)/g)) {
      const body = m[2] !== undefined ? objs.get(Number(m[2]))?.dict ?? '' : m[1]!;
      for (const p of body.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) if (overwrite || !into.has(p[1]!)) into.set(p[1]!, Number(p[2]));
    }
  };
  const globalFonts = new Map<string, number>();
  for (const o of objs.values()) if (o.dict.includes('/Font')) fontPairs(o.dict, globalFonts, false);
  const resolver = (local: Map<string, number>) => (name: string): FontInfo | null => {
    const num = local.get(name) ?? globalFonts.get(name);
    return num === undefined ? null : fontInfo(num);
  };
  const resourcesOf = (num: number): string => {
    for (let k = 0, cur: number | undefined = num; k < 32 && cur !== undefined; k++) {
      const d: string = objs.get(cur)?.dict ?? '';
      const rr = /\/Resources\s+(\d+)\s+\d+\s+R/.exec(d);
      if (rr) return objs.get(Number(rr[1]))?.dict ?? '';
      if (d.includes('/Resources')) return d.slice(d.indexOf('/Resources'));
      const pm = /\/Parent\s+(\d+)\s+\d+\s+R/.exec(d);
      cur = pm ? Number(pm[1]) : undefined;
    }
    return '';
  };

  // 4. Page order from the page tree (Root → Pages → Kids).
  const pageList: number[] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): void => {
    if (seen.has(num) || depth > 64 || pageList.length > 50_000) return;
    seen.add(num);
    const d = objs.get(num)?.dict; if (!d) return;
    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(d);
    if (kids) { for (const k of refsIn(kids[1]!)) walk(k, depth + 1); return; }
    if (typeIs(d, 'Page')) pageList.push(num);
  };
  const roots = [...src.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)];
  const rootNum = roots.length ? Number(roots[roots.length - 1]![1]) : undefined;
  const pagesRef = rootNum === undefined ? null : /\/Pages\s+(\d+)\s+\d+\s+R/.exec(objs.get(rootNum)?.dict ?? '');
  if (pagesRef) walk(Number(pagesRef[1]), 0);

  let pageTypeCount = 0;
  for (const o of objs.values()) pageTypeCount += (o.dict.match(/\/Type\s*\/Page(?![A-Za-z0-9])/g) ?? []).length;
  const pages = pageTypeCount || pageList.length;

  // 5. Text: page contents in page order, then text-bearing streams no page referenced (form XObjects, broken trees).
  const st: PdfState = { ops: 0, unmapped: 0 };
  const used = new Set<number>();
  const pageTexts: string[] = [];
  const run = (num: number, fonts: Map<string, number>): string => {
    const o = objs.get(num); const s = o?.decoded;
    if (!o || !s) return '';
    used.add(num); o.decoded = null;
    return contentText(s, resolver(fonts), st);
  };
  for (const p of pageList) {
    const d = objs.get(p)!.dict;
    const cm = /\/Contents\s*(\[[^\]]*\]|\d+\s+\d+\s+R)/.exec(d);
    if (!cm) continue;
    let refs = refsIn(cm[1]!);
    if (refs.length === 1 && !objs.get(refs[0]!)?.decoded && !used.has(refs[0]!)) {
      const inner = objs.get(refs[0]!)?.dict ?? '';
      if (!/stream/.test(inner) && /\[/.test(inner)) refs = refsIn(inner);                        // /Contents 9 0 R → [ … ] array object
    }
    const local = new Map<string, number>(); fontPairs(resourcesOf(p), local, true);
    const t = refs.map((r) => run(r, local)).join('\n').trim();
    if (t) pageTexts.push(t);
  }
  for (const num of contentCandidates) {
    if (used.has(num)) continue;
    const local = new Map<string, number>(); fontPairs(objs.get(num)!.dict, local, true);
    const t = run(num, local).trim();
    if (t) pageTexts.push(t);
  }
  if (st.ops > PDF_MAX_OPS) warnings.push('This PDF is very long; only part of its text was read.');
  if (st.unmapped > 0) warnings.push('Some text in this PDF uses fonts without a Unicode map and was left out.');
  return { text: pageTexts.join('\n\n'), pages, images, encrypted };
}
