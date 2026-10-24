// Brainstorming Agent read-only tools (AI_WORKFLOW §8–§9, AGENT_DESIGN §2.1, MCP_AND_TOOLING §3.3) in JSON mode: the model
// asks with {"tool": "<name>", "input": {...}} and gets {"toolResult": ...} back. The registry is closed and read-only; the
// Local Service supplies the handlers. Inputs are Zod-validated; failures go back to the model as {error:{code,message}}.
import { z } from 'zod';
import type { ChatMessage } from './providers.js';

export const BRAINSTORM_TOOL_NAMES = ['composition.get', 'assets.list', 'catalogue.search', 'hardware.profile', 'project.settings.get', 'render.estimate'] as const;
export type BrainstormToolName = (typeof BRAINSTORM_TOOL_NAMES)[number];

export const BRAINSTORM_TOOL_INPUTS: Record<BrainstormToolName, z.ZodType> = {
  'composition.get': z.object({}).strict(),
  'assets.list': z.object({}).strict(),
  'catalogue.search': z.object({ query: z.string().max(200), category: z.string().max(40).optional() }).strict(),
  'hardware.profile': z.object({}).strict(),
  'project.settings.get': z.object({}).strict(),
  'render.estimate': z.object({ resolution: z.enum(['720p', '1080p', '2k', '2160p']).optional(), performanceProfile: z.enum(['standard', 'accelerated', 'turbo']).optional() }).strict(),
};

export type ToolHandlers = Partial<Record<BrainstormToolName, (input: Record<string, unknown>) => unknown>>;
export interface ToolCallRecord { name: string; input: unknown; output: unknown; ok: boolean }

/** Max serialised size of one tool result sent back to the model (MCP_AND_TOOLING §3.3 output caps; 16 KB). */
const MAX_RESULT_CHARS = 16_000;
export const MAX_TOOL_ROUNDS = 4;

/** Appended to the Brainstorming system prompt: the JSON-mode tool protocol (AI_WORKFLOW §12 "Model lacks tool calling"). */
export function toolsPromptBlock(names: readonly BrainstormToolName[]): string {
  if (!names.length) return '';
  const lines = names.map((n) => `- ${n} ${n === 'catalogue.search' ? '{"query": string, "category"?: string}' : n === 'render.estimate' ? '{"resolution"?: "720p"|"1080p"|"2k"|"2160p", "performanceProfile"?: "standard"|"accelerated"|"turbo"}' : '{}'}`);
  return ['', '## Read-only tools', 'Before answering you may look things up. To call a tool, reply with only this JSON and nothing else:',
    '{"tool": "<name>", "input": { ... }}', 'You will receive {"toolResult": ...}. At most 4 tool calls per answer; then reply normally. Tools never change the project.', ...lines].join('\n');
}

/** A tool request when the reply is exactly a {"tool", "input"} object without a "reply". */
export function asToolRequest(json: unknown): { name: string; input: unknown } | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o['tool'] !== 'string' || 'reply' in o) return null;
  return { name: o['tool'], input: o['input'] ?? {} };
}

/** Runs one tool call through the closed registry. Never throws; unknown or disallowed tools return EM-4501 / EM-4502. */
export async function runTool(name: string, input: unknown, handlers: ToolHandlers): Promise<ToolCallRecord> {
  const err = (code: string, message: string): ToolCallRecord => ({ name, input, output: { error: { code, message } }, ok: false });
  if (!(BRAINSTORM_TOOL_NAMES as readonly string[]).includes(name)) {
    return /\.(apply|validate|start|generate|remove|set|exec)/i.test(name) ? err('EM-4502', `${name} is not allowed for the Brainstorming Agent.`) : err('EM-4501', `Unknown tool ${name}.`);
  }
  const tool = name as BrainstormToolName;
  const handler = handlers[tool];
  if (!handler) return err('EM-4506', `${name} is not available right now.`);
  const parsed = BRAINSTORM_TOOL_INPUTS[tool].safeParse(input ?? {});
  if (!parsed.success) return err('EM-4503', `${name}: ${parsed.error.issues[0]?.message ?? 'invalid input'}`);
  try {
    const output = await handler(parsed.data as Record<string, unknown>);
    return { name, input: parsed.data, output, ok: true };
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === 'string' && /^EM-\d{4}$/.test((e as { code: string }).code) ? (e as { code: string }).code : 'EM-4505';
    return err(code, `${name} failed.`);
  }
}

export function toolResultMessage(rec: ToolCallRecord): ChatMessage {
  let body = JSON.stringify({ toolResult: { tool: rec.name, ...(rec.ok ? { output: rec.output } : (rec.output as object)) } });
  if (body.length > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}…(truncated)`;
  return { role: 'user', content: body };
}

/**
 * Incremental filter for streamed Brainstorming replies: prose passes through; a JSON turn streams only the decoded
 * value of its "reply" string; a tool request streams nothing. Push raw deltas, get the visible text to append.
 */
export class ReplyStreamer {
  private raw = '';
  private mode: 'unknown' | 'prose' | 'json' = 'unknown';
  private pos = -1;           // index in raw just after the opening quote of "reply"
  private done = false;
  private escape = false;
  push(delta: string): string {
    this.raw += delta;
    if (this.mode === 'unknown') {
      const s = this.raw.replace(/^\s+/, '');
      if (!s) return '';
      if (s.startsWith('{') || s.startsWith('`')) this.mode = 'json';
      else { this.mode = 'prose'; return this.raw.replace(/^\s+/, ''); }
    }
    if (this.mode === 'prose') return delta;
    if (this.done) return '';
    if (this.pos < 0) {
      const m = /"reply"\s*:\s*"/.exec(this.raw);
      if (!m) return '';
      this.pos = m.index + m[0].length;
    }
    let out = '';
    while (this.pos < this.raw.length) {
      const c = this.raw[this.pos]!;
      if (this.escape) {
        if (c === 'u') { const hex = this.raw.slice(this.pos + 1, this.pos + 5); if (hex.length < 4) break; out += String.fromCharCode(parseInt(hex, 16) || 0x3f); this.pos += 5; this.escape = false; continue; }
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : c; this.escape = false; this.pos++; continue;
      }
      if (c === '\\') { this.escape = true; this.pos++; continue; }
      if (c === '"') { this.done = true; this.pos++; break; }
      out += c; this.pos++;
    }
    return out;
  }
}

/**
 * Deterministic thread summariser (AI_WORKFLOW §10, no LLM): keeps what was asked, what was proposed and handed off,
 * and what failed, from the messages that fall out of the context window.
 */
export interface ThreadSummary { droppedMessages: number; requests: string[]; proposals: string[]; text: string }
export function summarizeThread(dropped: readonly ChatMessage[]): ThreadSummary {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const all = dropped.filter((m) => m.role === 'user' && !m.content.startsWith('{"toolResult"')).map((m) => clip(m.content.replace(/\s+/g, ' ').trim(), 120)).filter(Boolean);
  const requests = all.length > 8 ? [...all.slice(0, 3), ...all.slice(-5)] : all;    // the opening brief and the latest asks
  const proposals = dropped.flatMap((m) => [...m.content.matchAll(/\(proposed (\d+) change\(s\); (pending|sent|dismissed)\)/g)].map((x) => `${x[1]} change(s) ${x[2]}`)).slice(-6);
  const parts = [`Earlier conversation (${dropped.length} message(s) summarised; decisions already applied are visible in the composition).`];
  if (requests.length) parts.push(`The Creator asked: ${requests.map((r) => `“${r}”`).join('; ')}.`);
  if (proposals.length) parts.push(`You proposed: ${proposals.join('; ')}.`);
  return { droppedMessages: dropped.length, requests, proposals, text: parts.join(' ') };
}
