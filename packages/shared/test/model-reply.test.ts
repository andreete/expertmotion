import { describe, expect, it } from 'vitest';
import { extractReplyText, parseLooseJson, repairJsonStrings, unescapeLiteral } from '../src/index.js';

// QA 2026-10-25 #16: "Recursive: Flint (free)" showed {"reply": "Siap! …\n\n**Hook (0-3 detik):** …"} in the chat bubble.
const REPLY = 'Siap! Untuk kelas online:\n\n**Hook (0-3 detik):** buka dengan pertanyaan.';
const enc = JSON.stringify({ reply: REPLY });
const x = (s: string) => extractReplyText(s).text;

describe('extractReplyText (tolerant model replies)', () => {
  it('plain JSON, fenced JSON, prose before / after the JSON', () => {
    expect(x(enc)).toBe(REPLY);
    expect(x('```json\n' + enc + '\n```')).toBe(REPLY);
    expect(x('```\n' + enc + '\n```')).toBe(REPLY);
    expect(x('Berikut jawabannya:\n' + enc)).toBe(REPLY);
    expect(x(enc + '\nSemoga membantu!')).toBe(REPLY);
    expect(x('Oke.\n```json\n' + enc + '\n```\nAda lagi?')).toBe(REPLY);
    expect(extractReplyText(enc).source).toBe('json');
  });
  it('truncated JSON (unterminated string) still yields the decoded text', () => {
    const cut = enc.slice(0, enc.length - 12);
    const r = extractReplyText(cut);
    expect(r.source).toBe('partial');
    expect(r.text).toBe(REPLY.slice(0, REPLY.length - 10));
    expect(r.text).not.toContain('{');
    expect(x('{"reply": "Halo \\"kopi\\" \\\\ senja\\n')).toBe('Halo "kopi" \\ senja');
  });
  it('double-encoded JSON (a JSON string holding the object) is unwrapped', () => {
    expect(x(JSON.stringify(enc))).toBe(REPLY);
    expect(x(JSON.stringify(JSON.stringify(enc)))).toBe(REPLY);
    expect(x(JSON.stringify(enc).slice(0, -20))).toContain('Siap! Untuk kelas online:\n\n**Hook');
    expect(x(JSON.stringify({ reply: enc }))).toBe(REPLY);                 // reply that itself holds the wrapper
  });
  it('raw newlines inside the JSON string are repaired', () => {
    expect(x('{"reply": "Baris satu\nBaris dua", "questions": []}')).toBe('Baris satu\nBaris dua');
    expect(repairJsonStrings('{"a": "x\ny"}\n')).toBe('{"a": "x\\ny"}\n');
  });
  it('other reply keys and the empty-object case', () => {
    expect(x('{"message": "Halo"}')).toBe('Halo');
    expect(x('{"response": "Halo"}')).toBe('Halo');
    expect(extractReplyText('{"tool":"x","input":{}}').text).toBe('');
  });
  it('plain text is kept; a fence-only answer keeps its content; literal escapes are undone', () => {
    expect(x('Halo! Mau bikin video apa?')).toBe('Halo! Mau bikin video apa?');
    expect(x('Contoh objek: {"a": 1} begitu.')).toBe('Contoh objek: {"a": 1} begitu.');
    expect(x('```\nBaris satu\nBaris dua\n```')).toBe('Baris satu\nBaris dua');
    expect(x('Siap!\\n\\n**Hook**: \\"tanya\\"')).toBe('Siap!\n\n**Hook**: "tanya"');
    expect(unescapeLiteral('Line one\nC:\\new')).toBe('Line one\nC:\\new');     // real line breaks: escapes left alone
    expect(x('')).toBe('');
  });
  it('parseLooseJson: fences anywhere, repaired strings, bare string literals are not objects', () => {
    expect(parseLooseJson('a ```json\n{"a":1}\n``` b')).toEqual({ a: 1 });
    expect(parseLooseJson('"just a string"')).toBeUndefined();
    expect(parseLooseJson(JSON.stringify('{"a":2}'))).toEqual({ a: 2 });
    expect(parseLooseJson('no json here')).toBeUndefined();
  });
});
