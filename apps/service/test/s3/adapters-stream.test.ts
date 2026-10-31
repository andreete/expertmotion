// FR-210 streaming and FR-211 native tool calling in the direct adapters (Anthropic Messages SSE, OpenAI Chat Completions SSE,
// Gemini streamGenerateContent?alt=sse), FR-213 image parts, Anthropic Models API capabilities. Event shapes follow each provider's
// streaming docs (Anthropic: message_start → content_block_start / _delta / _stop → message_delta → message_stop, error events).
import { describe, expect, it } from 'vitest';
import type { ChatActivity, ChatRequest } from '@expertmotion/agents';
import { anthropicMessages, chatProviderFor, geminiContents, listModels, openAiMessages, sseEvents, STREAM_MIN_MAX_TOKENS } from '../../src/s3/adapters.js';

const sse = (events: Array<[string | null, unknown]>, chunk = 37): Response => {
  const text = events.map(([e, d]) => `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (i >= bytes.length) { c.close(); return; } c.enqueue(bytes.slice(i, i + chunk)); i += chunk; } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};
const capture = (res: () => Response) => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (u: string, init: RequestInit = {}) => { seen.push({ url: String(u), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> }); return res(); }) as unknown as typeof fetch;
  return { f, seen };
};
const TOOLS = [{ name: 'catalogue_search', description: 'Search the catalogue', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } }];
const base = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ system: 'sys', messages: [{ role: 'user', content: 'ide video' }], maxTokens: 4000, temperature: 0.4, ...extra });

describe('sseEvents', () => {
  it('splits records on blank lines across chunk borders, joins data lines, skips comments', async () => {
    const body = new Response(': ping\n\nevent: a\ndata: {"x":\ndata: 1}\n\r\n\r\ndata: tail').body!;
    const got: Array<{ event: string; data: string }> = [];
    for await (const e of sseEvents(body)) got.push(e);
    expect(got).toEqual([{ event: 'a', data: '{"x":\n1}' }, { event: 'message', data: 'tail' }]);
  });
});

describe('Anthropic Messages streaming + tools (FR-210, FR-211)', () => {
  const stream = () => sse([
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, usage: { input_tokens: 812, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EqQBCgIYAhIM' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['ping', { type: 'ping' }],
    ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Saya cari ' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'dulu.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_01', name: 'catalogue_search', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"query": "gra' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'dient"}' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 2 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 96 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
  it('streams text deltas, collects tool_use input from input_json_delta, keeps thinking + signature for the replay', async () => {
    const { f, seen } = capture(stream);
    const deltas: string[] = []; const act: ChatActivity[] = [];
    const r = await chatProviderFor('anthropic', 'sk-ant-k', 'claude-sonnet-5-5', f).stream!(base({ tools: TOOLS, toolChoice: 'auto', onActivity: (a) => act.push(a) }), (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Saya cari dulu.');
    expect(r.text).toBe('Saya cari dulu.');
    expect(r.toolCalls).toEqual([{ id: 'toolu_01', name: 'catalogue_search', input: { query: 'gradient' } }]);
    expect(r.finishReason).toBe('tool-calls');
    expect(r.usage).toMatchObject({ inputTokens: 812, outputTokens: 96 });
    expect(r.providerRaw).toEqual([{ type: 'thinking', thinking: '', signature: 'EqQBCgIYAhIM' }, { type: 'text', text: 'Saya cari dulu.' }, { type: 'tool_use', id: 'toolu_01', name: 'catalogue_search', input: { query: 'gradient' } }]);
    expect(act).toEqual([{ type: 'thinking' }, { type: 'text' }, { type: 'tool', name: 'catalogue_search' }]);
    const b = seen[0]!.body;
    expect(seen[0]!.url).toMatch(/\/v1\/messages$/);
    expect(b).toMatchObject({ model: 'claude-sonnet-5-5', system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }], stream: true, tool_choice: { type: 'auto' }, tools: [{ name: 'catalogue_search', description: 'Search the catalogue', input_schema: TOOLS[0]!.inputSchema }] });
    expect(b['max_tokens']).toBeGreaterThanOrEqual(STREAM_MIN_MAX_TOKENS);
    expect(b).not.toHaveProperty('temperature');
  });
  it('replays the tool turn unchanged with the tool_result blocks first; images as base64 parts before the text; toolChoice none', async () => {
    const msgs = anthropicMessages([
      { role: 'user', content: 'pakai gambar ini', images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] },
      { role: 'assistant', content: 'Saya cari dulu.', toolCalls: [{ id: 'toolu_01', name: 'catalogue_search', input: { query: 'gradient' } }], providerRaw: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_01', name: 'catalogue_search', input: { query: 'gradient' } }] },
      { role: 'user', content: '', toolResults: [{ id: 'toolu_01', name: 'catalogue_search', content: '[{"id":"preset:background.gradient"}]' }, { id: 'toolu_02', name: 'assets_list', content: '{"error":{}}', isError: true }] },
    ]);
    expect(msgs[0]).toEqual({ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }, { type: 'text', text: 'pakai gambar ini' }] });
    expect(msgs[1]).toEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'toolu_01', name: 'catalogue_search', input: { query: 'gradient' } }] });
    expect(msgs[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01', content: '[{"id":"preset:background.gradient"}]' }, { type: 'tool_result', tool_use_id: 'toolu_02', content: '{"error":{}}', is_error: true }] });
    const { f, seen } = capture(() => sse([['message_start', { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 1 } } }], ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Jawaban.' } }], ['content_block_stop', { type: 'content_block_stop', index: 0 }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }], ['message_stop', { type: 'message_stop' }]]));
    const r = await chatProviderFor('anthropic', 'sk-ant-k', 'claude-sonnet-5-5', f).stream!(base({ tools: TOOLS, toolChoice: 'none' }), () => undefined);
    expect(r.text).toBe('Jawaban.');
    expect(r.toolCalls).toBeUndefined();
    expect(seen[0]!.body['tool_choice']).toEqual({ type: 'none' });
  });
  it('an error event mid-stream maps to its EM code (overloaded → EM-4102 provider busy, QA UX round 1, rate limit → EM-4102); a refusal is EM-4104', async () => {
    const err = (type: string) => capture(() => sse([['message_start', { type: 'message_start', message: { usage: {} } }], ['error', { type: 'error', error: { type, message: 'Overloaded' } }]])).f;
    await expect(chatProviderFor('anthropic', 'k', 'claude-sonnet-5-5', err('overloaded_error'), { retries: 0 }).stream!(base(), () => undefined)).rejects.toMatchObject({ code: 'EM-4102' });
    await expect(chatProviderFor('anthropic', 'k', 'claude-sonnet-5-5', err('rate_limit_error'), { retries: 0 }).stream!(base(), () => undefined)).rejects.toMatchObject({ code: 'EM-4102' });
    const refusal = capture(() => sse([['message_start', { type: 'message_start', message: { usage: {} } }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } }]])).f;
    await expect(chatProviderFor('anthropic', 'k', 'claude-sonnet-5-5', refusal).stream!(base(), () => undefined)).rejects.toMatchObject({ code: 'EM-4104' });
  });
  it('HTTP errors before the stream keep their mapping (401 → EM-4002) and a model that refuses tools is retried once without them', async () => {
    const r401 = capture(() => new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), { status: 401 })).f;
    await expect(chatProviderFor('anthropic', 'bad', 'claude-sonnet-5-5', r401).stream!(base(), () => undefined)).rejects.toMatchObject({ code: 'EM-4002' });
    let n = 0;
    const { f, seen } = capture(() => (n++ === 0 ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'tools: this model does not support tool use' } }), { status: 400 })
      : sse([['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]])));
    const p = chatProviderFor('anthropic', 'k', 'claude-old-x', f);
    expect((await p.stream!(base({ tools: TOOLS }), () => undefined)).text).toBe('ok');
    expect(seen.map((s) => 'tools' in s.body)).toEqual([true, false]);
    expect(chatProviderFor('anthropic', 'k', 'claude-old-x', f).nativeTools).toBeFalsy();          // remembered for this session
  });
});

describe('OpenAI Chat Completions streaming + tools', () => {
  it('assembles text, tool_calls fragments by index and the usage chunk; messages carry images and tool results', async () => {
    const { f, seen } = capture(() => sse([
      [null, { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }],
      [null, { id: 'c1', choices: [{ index: 0, delta: { content: 'Sebentar.' }, finish_reason: null }] }],
      [null, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'catalogue_search', arguments: '' } }] }, finish_reason: null }] }],
      [null, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":' } }] }, finish_reason: null }] }],
      [null, { id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"fade"}' } }] }, finish_reason: null }] }],
      [null, { id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }],
      [null, { id: 'c1', choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 4 } } }],
      [null, '[DONE]'],
    ]));
    const deltas: string[] = [];
    const r = await chatProviderFor('openai', 'sk-proj-k', 'gpt-5.5', f).stream!(base({ tools: TOOLS }), (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Sebentar.');
    expect(r.toolCalls).toEqual([{ id: 'call_a', name: 'catalogue_search', input: { query: 'fade' } }]);
    expect(r.usage).toMatchObject({ inputTokens: 40, outputTokens: 12 });
    expect(seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true }, tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'catalogue_search', parameters: TOOLS[0]!.inputSchema } }] });
    expect(seen[0]!.body).not.toHaveProperty('temperature');                                       // reasoning family
    expect(openAiMessages('sys', [
      { role: 'user', content: 'lihat', images: [{ mediaType: 'image/jpeg', data: 'AAA' }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call_a', name: 'catalogue_search', input: { query: 'fade' } }] },
      { role: 'user', content: '', toolResults: [{ id: 'call_a', name: 'catalogue_search', content: '[]' }] },
    ])).toEqual([{ role: 'system', content: 'sys' }, { role: 'user', content: [{ type: 'text', text: 'lihat' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'catalogue_search', arguments: '{"query":"fade"}' } }] }, { role: 'tool', tool_call_id: 'call_a', content: '[]' }]);
  });
});

describe('Gemini streamGenerateContent (alt=sse) + function calling', () => {
  it('merges text parts, hides thoughts, returns function calls with their thought signatures for the replay', async () => {
    const { f, seen } = capture(() => sse([
      [null, { candidates: [{ content: { role: 'model', parts: [{ text: 'thinking', thought: true }] } }] }],
      [null, { candidates: [{ content: { role: 'model', parts: [{ text: 'Saya ' }] } }] }],
      [null, { candidates: [{ content: { role: 'model', parts: [{ text: 'cek.' }] } }] }],
      [null, { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'catalogue_search', args: { query: 'zoom' } }, thoughtSignature: 'c2ln' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 8, thoughtsTokenCount: 20 } }],
    ]));
    const deltas: string[] = []; const act: ChatActivity[] = [];
    const r = await chatProviderFor('google', 'AIzaK', 'gemini-3.5-flash', f).stream!(base({ tools: TOOLS, onActivity: (a) => act.push(a) }), (d) => deltas.push(d));
    expect(deltas.join('')).toBe('Saya cek.');
    expect(r.text).toBe('Saya cek.');
    expect(r.toolCalls).toEqual([{ id: 'call_2', name: 'catalogue_search', input: { query: 'zoom' } }]);
    expect(r.providerRaw).toEqual([{ text: 'thinking', thought: true }, { text: 'Saya cek.' }, { functionCall: { name: 'catalogue_search', args: { query: 'zoom' } }, thoughtSignature: 'c2ln' }]);
    expect(r.usage).toMatchObject({ inputTokens: 30, outputTokens: 28 });
    expect(act).toEqual([{ type: 'thinking' }, { type: 'text' }, { type: 'tool', name: 'catalogue_search' }]);
    expect(seen[0]!.url).toMatch(/models\/gemini-3\.5-flash:streamGenerateContent\?alt=sse$/);
    expect(seen[0]!.body).toMatchObject({ tools: [{ functionDeclarations: [{ name: 'catalogue_search', parametersJsonSchema: TOOLS[0]!.inputSchema }] }], toolConfig: { functionCallingConfig: { mode: 'AUTO' } } });
    expect(geminiContents([
      { role: 'assistant', content: '', toolCalls: r.toolCalls!, providerRaw: r.providerRaw },
      { role: 'user', content: '', toolResults: [{ id: 'call_2', name: 'catalogue_search', content: '[{"id":"preset:motion.zoom"}]' }], images: [{ mediaType: 'image/webp', data: 'UklG' }] },
    ])).toEqual([{ role: 'model', parts: r.providerRaw }, { role: 'user', parts: [{ functionResponse: { name: 'catalogue_search', response: { result: [{ id: 'preset:motion.zoom' }] } } }, { inlineData: { mimeType: 'image/webp', data: 'UklG' } }] }]);
  });
});

describe('Anthropic model list (FR-213, FR-215)', () => {
  it('maps max_input_tokens and capabilities (image input, structured outputs), follows has_more pages', async () => {
    const pages = [
      { data: [{ type: 'model', id: 'claude-sonnet-5-5', display_name: 'Claude Sonnet 5.5', created_at: '2026-08-20T00:00:00Z', max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { image_input: { supported: true }, structured_outputs: { supported: true } } }], has_more: true, last_id: 'claude-sonnet-5-5' },
      { data: [{ type: 'model', id: 'claude-text-only', display_name: 'Text Only', max_input_tokens: 200_000, capabilities: { image_input: { supported: false } } }], has_more: false, last_id: 'claude-text-only' },
    ];
    const urls: string[] = [];
    const f = (async (u: string) => { urls.push(String(u)); return new Response(JSON.stringify(pages[urls.length - 1]), { status: 200, headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch;
    const rows = await listModels('anthropic', 'sk-ant-k', f);
    expect(rows).toEqual([
      { modelId: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', contextLength: 1_000_000, toolCalling: true, structuredOutput: true, streaming: true, imageInput: true, pricePerMInput: null, pricePerMOutput: null, created: 1_787_184_000 },
      { modelId: 'claude-text-only', label: 'Text Only', contextLength: 200_000, toolCalling: true, structuredOutput: null, streaming: true, imageInput: false, pricePerMInput: null, pricePerMOutput: null },
    ]);
    expect(urls[1]).toContain('after_id=claude-sonnet-5-5');
  });
});

describe('output budget floor for streamed calls (FR-210)', () => {
  it('a model whose output limit is lower than the floor refuses it once and gets the caller budget (remembered)', async () => {
    let n = 0;
    const { f, seen } = capture(() => (n++ === 0 ? new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 16000 > 8192, which is the maximum allowed number of output tokens for claude-old' } }), { status: 400 })
      : sse([['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } }], ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }]])));
    expect((await chatProviderFor('anthropic', 'k', 'claude-old', f).stream!(base(), () => undefined)).text).toBe('ok');
    expect(seen.map((s) => s.body['max_tokens'])).toEqual([STREAM_MIN_MAX_TOKENS, 4000]);
    await chatProviderFor('anthropic', 'k', 'claude-old', f).stream!(base(), () => undefined);
    expect(seen.at(-1)!.body['max_tokens']).toBe(4000);
  });
  it('OpenAI: only reasoning models get the floor', async () => {
    const ok = () => sse([[null, { choices: [{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }] }], [null, '[DONE]']]);
    const a = capture(ok); await chatProviderFor('openai', 'k', 'gpt-4.1-mini', a.f).stream!(base(), () => undefined);
    expect(a.seen[0]!.body['max_completion_tokens']).toBe(4000);
    const b = capture(ok); await chatProviderFor('openai', 'k', 'o5-mini', b.f).stream!(base(), () => undefined);
    expect(b.seen[0]!.body['max_completion_tokens']).toBe(STREAM_MIN_MAX_TOKENS);
  });
});
