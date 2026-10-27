// FR-211 (QA 2026-10-27, Claude Sonnet 5.5 in Diskusi): tool-call markup written as text is read as tool calls and never shown.
import { describe, expect, it } from 'vitest';
import { extractReplyText, hasToolMarkup, normalizeMessageBlocks, parseToolMarkup, stripToolMarkup } from '../src/index.js';

// The exact shape the QA screenshots show (p2_X11 / p3_X14).
const QA_INVOKE = '<invoke>\n<parameter name="input">{"query": "gradient", "category": "backgrounds"}</parameter>\n<parameter name="tool">catalogue.search</parameter>\n</invoke>';
const QA_NAME_ONLY = '<invoke>\n<parameter name="name">catalogue.search</parameter>\n</invoke>';
const NS = ['an', 'tml:'].join('');                                     // a namespaced variant some models write

describe('parseToolMarkup', () => {
  it('reads the QA invoke blocks: tool + input parameters, and a name-only block', () => {
    expect(parseToolMarkup(QA_INVOKE)).toEqual([{ name: 'catalogue.search', input: { query: 'gradient', category: 'backgrounds' } }]);
    expect(parseToolMarkup(`${QA_INVOKE}\n${QA_NAME_ONLY}\n${QA_NAME_ONLY}`)).toEqual([
      { name: 'catalogue.search', input: { query: 'gradient', category: 'backgrounds' } }, { name: 'catalogue.search', input: {} }, { name: 'catalogue.search', input: {} }]);
  });
  it('reads function_calls / invoke name= / parameter (with a namespace prefix), tool_call JSON and function=name', () => {
    const fc = `<${NS}function_calls>\n<${NS}invoke name="catalogue_search">\n<${NS}parameter name="query">slide</${NS}parameter>\n<${NS}parameter name="category">transition</${NS}parameter>\n</${NS}invoke>\n</${NS}function_calls>`;
    expect(parseToolMarkup(fc)).toEqual([{ name: 'catalogue_search', input: { query: 'slide', category: 'transition' } }]);
    expect(parseToolMarkup('<tool_call>{"name": "assets.list", "arguments": {}}</tool_call>')).toEqual([{ name: 'assets.list', input: {} }]);
    expect(parseToolMarkup('<tool_call>{"tool": "render.estimate", "input": "{\\"resolution\\":\\"720p\\"}"}</tool_call>')).toEqual([{ name: 'render.estimate', input: { resolution: '720p' } }]);
    expect(parseToolMarkup('<function=composition.get>{}</function>')).toEqual([{ name: 'composition.get', input: {} }]);
    expect(parseToolMarkup('Just prose about <b>bold</b> and a < b.')).toEqual([]);
  });
});

describe('stripToolMarkup', () => {
  it('removes complete and unclosed markup, keeps the prose around it', () => {
    expect(stripToolMarkup(`Saya cari dulu.\n${QA_INVOKE}\n${QA_NAME_ONLY}\nIde: gradasi hangat.`)).toBe('Saya cari dulu.\n\nIde: gradasi hangat.');
    expect(stripToolMarkup(`Ide pertama.\n<invoke>\n<parameter name="tool">catalogue.search`)).toBe('Ide pertama.');
    expect(stripToolMarkup('stray </invoke> closer')).toBe('stray  closer');
    expect(stripToolMarkup('a < b and <b>x</b>')).toBe('a < b and <b>x</b>');
    expect(hasToolMarkup(QA_INVOKE)).toBe(true);
    expect(hasToolMarkup('nothing here')).toBe(false);
  });
  it('partial (streaming): hides a trailing fragment that may become a tag', () => {
    expect(stripToolMarkup('Halo <inv', { partial: true })).toBe('Halo ');
    expect(stripToolMarkup('Halo <', { partial: true })).toBe('Halo ');
    expect(stripToolMarkup(`Halo <${NS}fun`, { partial: true })).toBe('Halo ');
    expect(stripToolMarkup('5 < 6', { partial: true })).toBe('5 < 6');
  });
  it('extractReplyText (what the chat shows, stored messages included) never shows the markup', () => {
    expect(extractReplyText(`${QA_INVOKE}\n${QA_NAME_ONLY}`).text).toBe('');
    expect(extractReplyText(`Berikut idenya:\n${QA_INVOKE}\n1. Hook`).text).toBe('Berikut idenya:\n\n1. Hook');
    expect(extractReplyText(`{"reply": "Ide video siap."}`).text).toBe('Ide video siap.');
  });
});

describe('normalizeMessageBlocks (FR-212: stored messages render instead of crashing)', () => {
  it('a proposal without params gets params {}; invalid items and unknown blocks are dropped; text survives', () => {
    const stored = JSON.stringify([
      { type: 'text', text: 'Pakai gambar ini sebagai CTA.' },
      { type: 'proposed_intents', handoffState: 'pending', intents: [
        { id: '01M5Y4763PWR5JSNT0P476WH7J', category: 'asset', needsInterpretation: true, instruction: 'gambar sebagai CTA', source: 'brainstorm' },
        { id: '01M5Y4763PWR5JSNT0P476WH7K', category: 'background', presetId: 'not a preset', params: 'oops', source: 'brainstorm' },
        { category: 'text' }, null, 'x'] },
      { type: 'mystery', foo: 1 }, { type: 'attachment', name: 'logo.png', mime: 'image/*', sent: 'name' }, { type: 'targets', items: [{ kind: 'clip', label: 'Klip 1' }, { kind: 3 }] }]);
    const b = normalizeMessageBlocks(stored);
    expect(b.map((x) => x.type)).toEqual(['text', 'proposed_intents', 'attachment', 'targets']);
    const p = b[1] as Extract<(typeof b)[number], { type: 'proposed_intents' }>;
    expect(p.intents).toHaveLength(2);
    expect(p.intents[0]).toMatchObject({ params: {}, category: 'asset', needsInterpretation: true, instruction: 'gambar sebagai CTA' });
    expect(p.intents[1]).toMatchObject({ params: {}, needsInterpretation: true });
    expect(p.intents[1]).not.toHaveProperty('presetId');
    expect(b[2]).toMatchObject({ sent: 'name' });
    expect((b[3] as { items: unknown[] }).items).toHaveLength(1);
    expect(normalizeMessageBlocks('not json')).toEqual([{ type: 'text', text: 'not json' }]);
    expect(normalizeMessageBlocks(null)).toEqual([]);
    expect(normalizeMessageBlocks([{ type: 'proposed_intents', intents: 'x' }])).toEqual([]);
  });
});
