// ADR-040 prompt caching in the direct adapters: the Anthropic Messages body carries the stable system prefix as a cached block, the
// per-call tail uncached, and a cache breakpoint on the last message of a multi-turn thread; cache usage comes back in ChatUsage;
// OpenAI and Gemini receive the system prompt joined (the marker never reaches a model).
import { describe, expect, it } from 'vitest';
import { SYSTEM_DYNAMIC_MARK, type ChatRequest } from '@expertmotion/agents';
import { anthropicCacheLastMessage, anthropicSystem, chatProviderFor } from '../../src/s3/adapters.js';

const sse = (events: Array<[string, unknown]>): Response => new Response(events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const capture = (res: () => Response) => {
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  const f = (async (u: string, init: RequestInit = {}) => { seen.push({ url: String(u), body: JSON.parse(String(init.body ?? '{}')) as Record<string, unknown> }); return res(); }) as unknown as typeof fetch;
  return { f, seen };
};
const answer = (usage: Record<string, number>) => () => sse([
  ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, usage: { ...usage, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Siap.' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 7 } }],
  ['message_stop', { type: 'message_stop' }],
]);
const SYSTEM = `You are the agent.${SYSTEM_DYNAMIC_MARK}CONTEXT\n{"assets":[]}`;
const req = (extra: Partial<ChatRequest> = {}): ChatRequest => ({ system: SYSTEM, messages: [{ role: 'user', content: 'ide video' }], maxTokens: 4000, temperature: 0.4, ...extra });

describe('anthropicSystem / anthropicCacheLastMessage', () => {
  it('splits the stable prefix (cached) from the per-call tail; the web note joins the tail', () => {
    expect(anthropicSystem(SYSTEM)).toEqual([{ type: 'text', text: 'You are the agent.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'CONTEXT\n{"assets":[]}' }]);
    expect(anthropicSystem(SYSTEM, 'Internet research failed.')).toEqual([{ type: 'text', text: 'You are the agent.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'CONTEXT\n{"assets":[]}\n\nInternet research failed.' }]);
    expect(anthropicSystem('plain')).toEqual([{ type: 'text', text: 'plain', cache_control: { type: 'ephemeral' } }]);
  });
  it('marks the last block of the last message only when the thread has two or more messages; never a thinking block', () => {
    const one = [{ role: 'user' as const, content: 'halo' }];
    expect(anthropicCacheLastMessage(one)).toBe(one);
    const two = [{ role: 'user' as const, content: 'halo' }, { role: 'assistant' as const, content: 'hai' }];
    expect(anthropicCacheLastMessage(two)[1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: 'hai', cache_control: { type: 'ephemeral' } }] });
    const blocks = [{ role: 'user' as const, content: 'a' }, { role: 'user' as const, content: [{ type: 'tool_result', tool_use_id: 't1', content: '{}' }, { type: 'text', text: 'lanjut' }] }];
    expect(anthropicCacheLastMessage(blocks)[1]!.content).toEqual([{ type: 'tool_result', tool_use_id: 't1', content: '{}' }, { type: 'text', text: 'lanjut', cache_control: { type: 'ephemeral' } }]);
    expect(blocks[1]!.content).toHaveLength(2);                                                      // input untouched
    const thinking = [{ role: 'user' as const, content: 'a' }, { role: 'assistant' as const, content: [{ type: 'thinking', thinking: '', signature: 's' }] }];
    expect(anthropicCacheLastMessage(thinking)).toBe(thinking);
  });
});

describe('Anthropic adapter (ADR-040)', () => {
  it('sends system blocks with the breakpoint, the tail uncached, and reports cache reads / writes in the usage', async () => {
    const { f, seen } = capture(answer({ input_tokens: 12, cache_read_input_tokens: 700, cache_creation_input_tokens: 100 }));
    const r = await chatProviderFor('anthropic', 'sk-ant-k', 'claude-sonnet-5-5', f).stream!(req({ messages: [{ role: 'user', content: 'halo' }, { role: 'assistant', content: 'hai' }, { role: 'user', content: 'lanjut' }] }), () => undefined);
    const b = seen[0]!.body;
    expect(b['system']).toEqual([{ type: 'text', text: 'You are the agent.', cache_control: { type: 'ephemeral' } }, { type: 'text', text: 'CONTEXT\n{"assets":[]}' }]);
    const msgs = b['messages'] as Array<{ content: unknown }>;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.content).toBe('halo');
    expect(msgs[2]!.content).toEqual([{ type: 'text', text: 'lanjut', cache_control: { type: 'ephemeral' } }]);
    expect(JSON.stringify(b)).not.toContain('EM:DYNAMIC');
    expect(r.usage).toMatchObject({ inputTokens: 812, outputTokens: 7, cacheReadTokens: 700, cacheWriteTokens: 100 });
  });
  it('a single-message thread gets no message breakpoint and no cache fields when the API reports none', async () => {
    const { f, seen } = capture(answer({ input_tokens: 40 }));
    const r = await chatProviderFor('anthropic', 'sk-ant-k', 'claude-sonnet-5-5', f).stream!(req(), () => undefined);
    expect((seen[0]!.body['messages'] as Array<{ content: unknown }>)[0]!.content).toBe('ide video');
    expect(r.usage).toEqual({ model: 'claude-sonnet-5-5', inputTokens: 40, outputTokens: 7, costUsd: null, approximate: true });
  });
});

describe('OpenAI and Gemini adapters receive the system prompt joined', () => {
  const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  it('OpenAI: one system message without the marker', async () => {
    const { f, seen } = capture(json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 1 } }));
    await chatProviderFor('openai', 'sk-k', 'gpt-5', f).complete(req());
    const msgs = seen[0]!.body['messages'] as Array<{ role: string; content: string }>;
    expect(msgs[0]).toEqual({ role: 'system', content: 'You are the agent.\n\nCONTEXT\n{"assets":[]}' });
    expect(JSON.stringify(seen[0]!.body)).not.toContain('EM:DYNAMIC');
  });
  // Gemini connections are disabled in this version (EM-9004); its adapter uses joinSystem the same way (covered by the agents test).
});
