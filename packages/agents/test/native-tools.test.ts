// FR-211 native tool calling for the read-only agent tools (AI_WORKFLOW §8.1) with the JSON-mode protocol as fallback, tool calls
// written as markup (QA 2026-10-27, Claude Sonnet 5.5) read as calls and never shown; FR-212 proposals normalised before storing;
// FR-214 wire activity → progress. Fake providers only; no network.
import { describe, expect, it } from 'vitest';
import { applyOperations, createEmptyModel, hashModel, type AssetFacts, type CompositionModelT } from '@expertmotion/composition-model';
import {
  BRAINSTORM_TOOL_NAMES, ReplyStreamer, buildRewriteEnvelope, fakeProvider, fromWireToolName, normalizeProposedIntents, parseBrainstormReply, runBrainstorm, runEditorAgent,
  toolSpecs, toolsPromptBlock, wireToolName, type ChatProvider, type RunProgress, type ToolHandlers,
} from '../src/index.js';

const QA_INVOKE = '<invoke>\n<parameter name="input">{"query": "gradient", "category": "backgrounds"}</parameter>\n<parameter name="tool">catalogue.search</parameter>\n</invoke>';
const searched: unknown[] = [];
const tools: ToolHandlers = {
  'catalogue.search': (i) => { searched.push(i); return [{ id: 'preset:background.gradient', category: 'background', label: 'Gradient' }]; },
  'composition.get': () => ({ scenes: 0 }), 'assets.list': () => [{ id: 'img1', kind: 'image', name: 'logo.png' }],
};
const reply = (o: Record<string, unknown>) => JSON.stringify(o);

describe('tool specs (FR-211)', () => {
  it('wire names are provider-safe and map back; every brainstorm tool has a JSON Schema object', () => {
    const specs = toolSpecs(BRAINSTORM_TOOL_NAMES);
    expect(specs.map((s) => s.name)).toEqual(['composition_get', 'assets_list', 'catalogue_search', 'hardware_profile', 'project_settings_get', 'render_estimate', 'web_search', 'web_fetch', 'web_images', 'media_analyze', 'media_frames', 'media_analysis_get']);   // FR-216 (web) + ADR-039 (media prep tools) …: research tools (offered only with handlers)
    for (const s of specs) { expect(s.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/); expect(s.inputSchema['type']).toBe('object'); expect(s.description.length).toBeGreaterThan(10); }
    expect(specs.find((s) => s.name === 'catalogue_search')!.inputSchema).toMatchObject({ required: ['query'], properties: { category: { enum: expect.arrayContaining(['background', 'transition']) } } });
    expect(fromWireToolName('catalogue_search')).toBe('catalogue.search');
    expect(fromWireToolName('Catalogue.Search')).toBe('catalogue.search');
    expect(fromWireToolName('render_estimate')).toBe('render.estimate');
    expect(wireToolName('project.settings.get')).toBe('project_settings_get');
    expect(toolsPromptBlock(['catalogue.search'], 'reply normally', 'native')).not.toContain('{"tool"');
    expect(toolsPromptBlock(['catalogue.search'], 'reply normally', 'native')).toMatch(/Never write tool calls/);
    expect(toolsPromptBlock(['catalogue.search'])).toContain('{"tool": "<name>", "input": { ... }}');
  });
});

describe('Brainstorm with native tools (FR-211)', () => {
  it('sends the tools, runs the native calls, replays the turn with its raw content and the results; proposals without params are stored with {}', async () => {
    searched.length = 0;
    const prov = fakeProvider([
      { text: 'Saya cari dulu di katalog.', toolCalls: [{ id: 'toolu_1', name: 'catalogue_search', input: { query: 'gradient', category: 'background' } }, { id: 'toolu_2', name: 'assets_list', input: {} }] },
      reply({ reply: 'Ide: latar gradasi hangat, logo kamu sebagai CTA di akhir.', proposedIntents: [{ category: 'asset', needsInterpretation: true, instruction: 'logo.png sebagai CTA di akhir', source: 'brainstorm' }, { category: 'backgrounds', presetId: 'preset:background.gradient', source: 'brainstorm' }] }),
    ], 'claude-sonnet-5-5', { nativeTools: true });
    const phases: RunProgress[] = [];
    const r = await runBrainstorm([{ role: 'user', content: 'pakai gambar ini sebagai CTA' }], {}, 'id', prov, { tools, onProgress: (p) => phases.push(p) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(prov.calls[0]!.tools!.map((t) => t.name)).toEqual(['composition_get', 'assets_list', 'catalogue_search']);
    expect(prov.calls[0]!.toolChoice).toBe('auto');
    expect(prov.calls[0]!.system).toContain('through the tools interface');
    expect(prov.calls[0]!.system).not.toContain('{"tool": "<name>"');
    expect(searched).toEqual([{ query: 'gradient', category: 'background' }]);
    const second = prov.calls[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'toolu_1' }, { id: 'toolu_2' }], providerRaw: [expect.objectContaining({ fake: true })] });
    expect(second.at(-1)!.toolResults!.map((x) => [x.id, x.name, x.isError ?? false])).toEqual([['toolu_1', 'catalogue_search', false], ['toolu_2', 'assets_list', false]]);
    expect(JSON.parse(second.at(-1)!.toolResults![0]!.content)).toEqual([{ id: 'preset:background.gradient', category: 'background', label: 'Gradient' }]);
    expect(r.toolCalls.map((c) => c.name)).toEqual(['catalogue.search', 'assets.list']);
    expect(r.turn.reply).toBe('Ide: latar gradasi hangat, logo kamu sebagai CTA di akhir.');
    expect(r.turn.proposedIntents).toEqual([
      { category: 'asset', params: {}, needsInterpretation: true, instruction: 'logo.png sebagai CTA di akhir', source: 'brainstorm' },
      { category: 'background', presetId: 'preset:background.gradient', params: {}, needsInterpretation: false, source: 'brainstorm' }]);
    expect(phases.filter((p) => p.phase === 'tool').map((p) => p.tool)).toEqual(['catalogue.search', 'assets.list']);
  });
  it('after the tool rounds the call asks for an answer with toolChoice none; extra calls get error results', async () => {
    const call = { text: '', toolCalls: [{ id: 'c', name: 'catalogue_search', input: { query: 'x' } }] };
    const prov = fakeProvider([call, call, call, call, call, reply({ reply: 'Jawaban akhir.' })], 'm', { nativeTools: true });
    const r = await runBrainstorm([{ role: 'user', content: 'ide' }], {}, 'id', prov, { tools });
    expect(r.ok && r.turn.reply).toBe('Jawaban akhir.');
    expect(prov.calls.map((c) => c.toolChoice)).toEqual(['auto', 'auto', 'auto', 'auto', 'none', 'none']);
    expect(prov.calls[5]!.messages.at(-1)!.toolResults![0]!.isError).toBe(true);
  });
  it('streams only the prose: a later round starts a new paragraph; wire activity becomes thinking / writing progress', async () => {
    const think: ChatProvider = { id: 'x', model: 'm', nativeTools: true,
      complete: async () => { throw new Error('stream only'); },
      async stream(req, onDelta) {
        const first = !req.messages.some((m) => m.toolResults?.length);
        req.onActivity?.({ type: 'thinking' }); req.onActivity?.({ type: 'thinking' });
        if (first) { onDelta('Sebentar, saya cek.'); req.onActivity?.({ type: 'tool', name: 'catalogue_search' }); return { text: 'Sebentar, saya cek.', usage: { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: null, approximate: true }, toolCalls: [{ id: '1', name: 'catalogue_search', input: { query: 'a' } }] }; }
        req.onActivity?.({ type: 'text' }); onDelta('Ini idenya.');
        return { text: 'Ini idenya.', usage: { model: 'm', inputTokens: 1, outputTokens: 1, costUsd: null, approximate: true } };
      } };
    const deltas: string[] = []; const phases: string[] = [];
    const r = await runBrainstorm([{ role: 'user', content: 'ide' }], {}, 'id', think, { tools, onDelta: (d) => deltas.push(d), onProgress: (p) => phases.push(p.tool ? `${p.phase}:${p.tool}` : p.phase) });
    expect(r.ok && r.turn.reply).toBe('Ini idenya.');
    expect(deltas.join('')).toBe('Sebentar, saya cek.\n\nIni idenya.');
    expect(phases).toEqual(['planning', 'thinking', 'tool:catalogue.search', 'tool:catalogue.search', 'planning', 'thinking', 'writing']);
  });
});

describe('Brainstorm in JSON mode: tool calls written as markup (QA 2026-10-27)', () => {
  it('the QA reply (only invoke blocks) runs the tool and the stored answer has no markup', async () => {
    searched.length = 0;
    const prov = fakeProvider([`${QA_INVOKE}\n<invoke>\n<parameter name="name">catalogue.search</parameter>\n</invoke>`, reply({ reply: 'Ide: 6 adegan, latar gradasi.' })]);
    const r = await runBrainstorm([{ role: 'user', content: 'konten edukasi data center' }], {}, 'id', prov, { tools });
    expect(r.ok && r.turn.reply).toBe('Ide: 6 adegan, latar gradasi.');
    expect(searched).toEqual([{ query: 'gradient', category: 'backgrounds' }]);
    expect(r.ok && r.toolCalls.map((c) => [c.name, c.ok])).toEqual([['catalogue.search', true], ['catalogue.search', false]]);   // second block had no query → EM-4503
    expect(prov.calls[1]!.messages.at(-1)!.content).toContain('"toolResult"');
  });
  it('prose with markup and no tools offered: the markup never reaches the stored reply; streamed text hides it too', async () => {
    const r = await runBrainstorm([{ role: 'user', content: 'ide' }], {}, 'id', fakeProvider([`Berikut ide saya.\n${QA_INVOKE}\nHook: "Data center tumbuh 3x"`]));
    expect(r.ok && r.turn.reply).toBe('Berikut ide saya.\n\nHook: "Data center tumbuh 3x"');
    const s = new ReplyStreamer(); let shown = '';
    for (const ch of `Ide A.\n${QA_INVOKE}\nIde B.`.match(/[\s\S]{1,5}/g)!) shown += s.push(ch);
    expect(shown).not.toMatch(/invoke|parameter|catalogue/);
    expect(shown).toContain('Ide A.');
    expect(shown).toContain('Ide B.');
  });
  it('parseBrainstormReply: a schema-valid turn with proposals lacking params is normalised (the crash of QA 2026-10-27)', () => {
    const t = parseBrainstormReply(reply({ reply: 'ok', proposedIntents: [{ category: 'text', needsInterpretation: true, instruction: 'CTA "Bangun Bersama Kami"', source: 'brainstorm' }] }));
    expect(t.proposedIntents).toEqual([{ category: 'text', params: {}, needsInterpretation: true, instruction: 'CTA "Bangun Bersama Kami"', source: 'brainstorm' }]);
  });
});

describe('normalizeProposedIntents (FR-212)', () => {
  it('defaults params, maps categories, drops invalid preset ids / targets / empty items', () => {
    expect(normalizeProposedIntents([
      { category: 'Transitions', presetId: 'preset:transition.fade' },
      { category: 'texteffect', presetId: 'preset:texteffect.glow', params: { strength: 2 }, needsInterpretation: false },
      { category: 'background', presetId: 'gradient!!', instruction: 'latar gradasi' },
      { presetId: 'preset:caption.bold' },
      { category: 'asset', target: { kind: 'nope' }, instruction: 'logo' },
      { category: 'unknown-thing', instruction: 'x' }, { category: 'text' }, 42, null,
    ], 12)).toEqual([
      { category: 'transition', presetId: 'preset:transition.fade', params: {}, needsInterpretation: false, source: 'brainstorm' },
      { category: 'text', presetId: 'preset:texteffect.glow', params: { strength: 2 }, needsInterpretation: false, source: 'brainstorm' },
      { category: 'background', params: {}, needsInterpretation: true, instruction: 'latar gradasi', source: 'brainstorm' },
      { category: 'caption', presetId: 'preset:caption.bold', params: {}, needsInterpretation: false, source: 'brainstorm' },
      { category: 'asset', params: {}, needsInterpretation: true, instruction: 'logo', source: 'brainstorm' },
    ]);
    expect(normalizeProposedIntents('x')).toEqual([]);
  });
});

describe('Editor Agent with native tools (FR-211)', () => {
  const ASSETS: AssetFacts[] = [{ id: 'a1', kind: 'video', status: 'ready', durationMs: 10_000, name: 'a.mp4' }, { id: 'a2', kind: 'video', status: 'ready', durationMs: 6000, name: 'b.mp4' }];
  let n = 0; const newId = () => `n${++n}`;
  const model = (): CompositionModelT => { const r = applyOperations(createEmptyModel('p1', { autoRatio: false }), [{ op: 'op:clip.insert', args: { assetId: 'a1' } }, { op: 'op:clip.insert', args: { assetId: 'a2' } }], { assets: ASSETS, tier: 'T1', newId }); if (!r.ok) throw new Error('fixture'); return r.value.model; };
  it('a native validateOps dry run, then the plan; markup in a reply is a tool call too', async () => {
    const m = model(); const h = hashModel(m);
    const env = buildRewriteEnvelope({ model: m, baseVersion: h, assets: ASSETS, intents: [], lockedKeys: [], creatorMessage: 'transisi pudar', tier: 'T1' });
    const ctx = { model: m, baseVersion: h, assets: ASSETS, tier: 'T1' as const, lockedKeys: [], newId, planId: 'pl', projectId: 'p1' };
    const ops = [{ op: 'op:transition.set', target: { kind: 'cut', index: 0 }, args: { presetId: 'preset:transition.fade', durationMs: 400 } }];
    const plan = JSON.stringify({ goal: 'Transisi pudar', baseVersion: h, risks: [], steps: [{ n: 1, tool: 'composition.applyOps', expectedDiff: 'fade', ops }] });
    const prov = fakeProvider([{ text: '', toolCalls: [{ id: 'v1', name: 'composition_validateOps', input: { ops } }] }, '<tool_call>{"name": "assets.list", "arguments": {}}</tool_call>', plan], 'm', { nativeTools: true });
    const r = await runEditorAgent(env, prov, ctx, { tools: { 'assets.list': () => ASSETS.map((a) => ({ id: a.id })) } });
    expect(r.ok).toBe(true);
    expect(r.toolCalls.map((c) => [c.name, c.ok])).toEqual([['composition.validateOps', true], ['assets.list', true]]);
    expect(prov.calls[0]!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(['composition_validateOps', 'assets_list']));
    expect(prov.calls[1]!.messages.at(-1)!.toolResults![0]).toMatchObject({ id: 'v1', name: 'composition_validateOps' });
    expect(r.ok && r.attempts).toBe(1);
  });
});
