import { describe, expect, it } from 'vitest';
import { fakeProvider, parseBrainstormReply, runBrainstorm } from '../src/index.js';

// QA 2026-10-25 #16: the Brainstorming Agent bubble must never show the JSON wrapper, literal "\n" or the raw object.
const REPLY = 'Siap! Untuk kelas …\n\n**Hook (0-3 detik):** sapa penonton.';

describe('parseBrainstormReply', () => {
  it('a valid BrainstormTurn is kept, with its reply unwrapped when it nests JSON', () => {
    const t = parseBrainstormReply(JSON.stringify({ reply: REPLY, questions: ['Durasi?'], suggestedNextStep: 'none' }));
    expect(t).toEqual({ reply: REPLY, questions: ['Durasi?'], suggestedNextStep: 'none' });
    expect(parseBrainstormReply(JSON.stringify({ reply: JSON.stringify({ reply: REPLY }) })).reply).toBe(REPLY);
  });
  it('fenced, prose-wrapped, truncated and double-encoded replies give the text', () => {
    const enc = JSON.stringify({ reply: REPLY });
    for (const raw of ['```json\n' + enc + '\n```', 'Jawaban:\n' + enc + '\nSelesai.', JSON.stringify(enc)]) expect(parseBrainstormReply(raw).reply, raw).toBe(REPLY);
    const cut = parseBrainstormReply(enc.slice(0, -8)).reply;
    expect(cut.startsWith('Siap! Untuk kelas …\n\n**Hook')).toBe(true);
    expect(cut).not.toMatch(/[{}]|\\n|"reply"/);
  });
  it('an object that fails the schema keeps its reply and the valid parts', () => {
    const t = parseBrainstormReply(JSON.stringify({ reply: REPLY, questions: ['a', 'b', 'c'], suggestedNextStep: 'later',
      proposedIntents: [{ category: 'transition', presetId: 'preset:transition.fade', needsInterpretation: false, source: 'brainstorm' }, { category: 'nope' }] }));
    expect(t.reply).toBe(REPLY);
    expect(t.questions).toEqual(['a', 'b']);
    expect(t.proposedIntents?.map((p) => p.presetId)).toEqual(['preset:transition.fade']);
    expect(t.suggestedNextStep).toBeUndefined();
    expect(parseBrainstormReply(JSON.stringify({ reply: 'x'.repeat(5000) })).reply).toHaveLength(4000);
  });
  it('prose stays prose; an empty object becomes a placeholder', () => {
    expect(parseBrainstormReply('Halo! Mau bikin video apa?').reply).toBe('Halo! Mau bikin video apa?');
    expect(parseBrainstormReply('{}').reply).toBe('…');
  });
  it('runBrainstorm stores the clean reply for a fenced / literal-escape answer', async () => {
    const raw = '```json\n{"reply": "Siap!\\n\\n**Hook:** sapa", "questions": ["Untuk siapa?"]}\n```';
    const r = await runBrainstorm([{ role: 'user', content: 'ide video' }], {}, 'id', fakeProvider([raw]));
    expect(r.ok && r.turn).toEqual({ reply: 'Siap!\n\n**Hook:** sapa', questions: ['Untuk siapa?'] });
    const t = await runBrainstorm([{ role: 'user', content: 'ide video' }], {}, 'id', fakeProvider(['{"reply": "Siap! Untuk kelas…\\n\\n**Hook']));
    expect(t.ok && t.turn.reply).toBe('Siap! Untuk kelas…\n\n**Hook');
  });
});
