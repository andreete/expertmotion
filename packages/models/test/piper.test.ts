// Piper voices for sherpa-onnx (QA 2026-10-25 items 10–12): the rhasspy .onnx has no sherpa metadata, so sherpa-onnx v1.13.8 exits 255
// with "'sample_rate' does not exist in the metadata". preparePiperVoice derives tokens.txt and sherpa-model.onnx (+ metadata).
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PIPER_SHERPA_MODEL, onnxMetadataBytes, piperSherpaMetadata, preparePiperVoice } from '../src/index.js';
import { expectEm, tempDir } from './helpers.js';

// The fields sherpa-onnx reads, as in the pinned id_ID-news_tts-medium.onnx.json (piper 1.3.0) and en_US-lessac-medium.onnx.json.
const ID_CFG = { audio: { sample_rate: 22050, quality: 'medium' }, espeak: { voice: 'id' }, num_speakers: 1, phoneme_type: 'espeak',
  language: { code: 'id_ID', family: 'id', name_english: 'Indonesian' }, phoneme_id_map: { _: [0], '^': [1], $: [2], ' ': [3], a: [14], 'ə': [59] } };
const EN_CFG = { ...ID_CFG, espeak: { voice: 'en-us' }, language: { code: 'en_US', family: 'en', name_english: 'English' } };

/** Minimal protobuf reader for the appended ModelProto field 14 (StringStringEntryProto). */
function readMetadata(bytes: Uint8Array, from: number): Record<string, string> {
  const dec = new TextDecoder(); const out: Record<string, string> = {}; let o = from;
  const varint = (): number => { let v = 0, m = 1, b: number; do { b = bytes[o++]!; v += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return v; };
  while (o < bytes.length) {
    const tag = varint(); expect(tag).toBe((14 << 3) | 2);
    const end = varint() + o; let key = '', value = '';
    while (o < end) { const t = varint(); const len = varint(); const s = dec.decode(bytes.subarray(o, o + len)); o += len; if (t === 0x0a) key = s; else if (t === 0x12) value = s; }
    out[key] = value;
  }
  return out;
}

let tmp: { dir: string; done: () => Promise<void> };
beforeEach(async () => { tmp = await tempDir(); });
afterEach(async () => { await tmp.done(); });

describe('Piper → sherpa-onnx voice preparation', () => {
  it('metadata is what sherpa-onnx\'s Piper export adds', () => {
    expect(piperSherpaMetadata(JSON.stringify(ID_CFG))).toEqual({ model_type: 'vits', comment: 'piper', language: 'Indonesian', voice: 'id', has_espeak: '1', n_speakers: '1', sample_rate: '22050' });
    expect(piperSherpaMetadata(JSON.stringify(EN_CFG)).voice).toBe('en-us');
    expect(() => piperSherpaMetadata(JSON.stringify({ espeak: { voice: 'id' } }))).toThrow(/sample_rate/);
    expect(() => piperSherpaMetadata(JSON.stringify({ audio: { sample_rate: 22050 } }))).toThrow(/espeak.voice/);
  });
  it('encodes ONNX metadata_props entries (field 14) that a protobuf reader decodes back', () => {
    const meta = { sample_rate: '22050', comment: 'piper', long: 'x'.repeat(300) };   // 300 > 127: multi-byte length varints
    expect(readMetadata(onnxMetadataBytes(meta), 0)).toEqual(meta);
  });
  it('writes tokens.txt and sherpa-model.onnx = upstream bytes + metadata, keeps the upstream file, is idempotent and repairs', async () => {
    const onnx = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    await writeFile(join(tmp.dir, 'id_ID-news_tts-medium.onnx'), onnx);
    await writeFile(join(tmp.dir, 'id_ID-news_tts-medium.onnx.json'), JSON.stringify(ID_CFG));
    const r = await preparePiperVoice(tmp.dir);
    expect(r.modelPath).toBe(join(tmp.dir, PIPER_SHERPA_MODEL));
    expect(await readFile(r.tokensPath, 'utf8')).toBe('_ 0\n^ 1\n$ 2\n  3\na 14\nə 59\n');
    const out = new Uint8Array(await readFile(r.modelPath));
    expect(Buffer.from(out.subarray(0, onnx.length)).equals(Buffer.from(onnx))).toBe(true);
    expect(readMetadata(out, onnx.length)).toEqual(piperSherpaMetadata(JSON.stringify(ID_CFG)));
    expect(Buffer.from(await readFile(join(tmp.dir, 'id_ID-news_tts-medium.onnx'))).equals(Buffer.from(onnx))).toBe(true);
    const m1 = (await stat(r.modelPath)).mtimeMs;
    await preparePiperVoice(tmp.dir);
    expect((await stat(r.modelPath)).mtimeMs).toBe(m1);                              // nothing rewritten
    await writeFile(r.modelPath, onnx.subarray(0, 10));                               // a truncated copy is rebuilt
    await preparePiperVoice(tmp.dir);
    expect((await stat(r.modelPath)).size).toBe(out.length);
  });
  it('a folder without the Piper pair is EM-7108', async () => {
    await expectEm(preparePiperVoice(tmp.dir), 'EM-7108');
    await writeFile(join(tmp.dir, 'v.onnx.json'), JSON.stringify(ID_CFG));
    await expectEm(preparePiperVoice(tmp.dir), 'EM-7108');
  });
});
