// Brainstorming Agent read-only tools (AI_WORKFLOW §8–§9, AGENT_DESIGN §2.1, MCP_AND_TOOLING §3.3) in JSON mode: the model
// asks with {"tool": "<name>", "input": {...}} and gets {"toolResult": ...} back. The registry is closed and read-only; the
// Local Service supplies the handlers. Inputs are Zod-validated; failures go back to the model as {error:{code,message}}.
import { z } from 'zod';
import { Operation } from '@expertmotion/composition-model';
import { parseToolMarkup, stripToolMarkup } from '@expertmotion/shared';
import type { ChatImage, ChatMessage, ToolSpec } from './providers.js';

/** FR-216 / FR-217: internet research tools (read-only; offered only when research is allowed and the Service supplies the handler). */
export const WEB_TOOL_NAMES = ['web.search', 'web.fetch', 'web.images'] as const;
/** ADR-039 (Reels pipeline): footage prep + analysis reads; `media.analyze` / `media.frames` are Brainstorm (PRD) tools, `media.analysis.get` both agents'. */
export const MEDIA_TOOL_NAMES = ['media.analyze', 'media.frames', 'media.analysis.get'] as const;
export const BRAINSTORM_TOOL_NAMES = ['composition.get', 'assets.list', 'catalogue.search', 'hardware.profile', 'project.settings.get', 'render.estimate', ...WEB_TOOL_NAMES, ...MEDIA_TOOL_NAMES] as const;
export type BrainstormToolName = (typeof BRAINSTORM_TOOL_NAMES)[number];
/** FR-080 / AI_WORKFLOW §8: the Editor Agent's read-only set = the Brainstorm set (without the prep tools) + the dry run `composition.validateOps` + `assets.probe`. */
export const EDITOR_TOOL_NAMES = ['composition.get', 'assets.list', 'catalogue.search', 'hardware.profile', 'project.settings.get', 'render.estimate', ...WEB_TOOL_NAMES, 'media.analysis.get', 'media.analyze', 'composition.validateOps', 'assets.probe'] as const;
export type ToolName = (typeof EDITOR_TOOL_NAMES)[number] | BrainstormToolName;
export const ALL_TOOL_NAMES: readonly ToolName[] = [...new Set<ToolName>([...BRAINSTORM_TOOL_NAMES, ...EDITOR_TOOL_NAMES])];

const assetId = z.string().min(1).max(64);
export const BRAINSTORM_TOOL_INPUTS: Record<ToolName, z.ZodType> = {
  'media.analyze': z.object({ voiceAssetId: assetId, cameraAssetId: assetId.optional(), script: z.string().max(12_000).optional(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional() }).strict(),
  'media.frames': z.object({ atMs: z.array(z.number().int().min(0)).min(1).max(12).optional(), cutIds: z.array(z.string().min(1).max(40)).min(1).max(12).optional(), rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional() }).strict()
    .refine((v) => !!(v.atMs?.length || v.cutIds?.length), { message: 'give atMs or cutIds' }),
  'media.analysis.get': z.object({}).strict(),
  'composition.validateOps': z.object({ baseVersion: z.string().max(128).optional(), ops: z.array(Operation).max(200) }).strict(),
  'composition.get': z.object({}).strict(),
  'assets.list': z.object({}).strict(),
  'assets.probe': z.object({ assetId: z.string().min(1).max(64) }).strict(),
  'catalogue.search': z.object({ query: z.string().max(200), category: z.string().max(40).optional() }).strict(),
  'hardware.profile': z.object({}).strict(),
  'project.settings.get': z.object({}).strict(),
  'render.estimate': z.object({ resolution: z.enum(['720p', '1080p', '2k', '2160p']).optional(), performanceProfile: z.enum(['standard', 'accelerated', 'turbo']).optional() }).strict(),
  'web.search': z.object({ query: z.string().trim().min(2).max(300) }).strict(),
  'web.fetch': z.object({ url: z.string().trim().min(8).max(2000) }).strict(),
  'web.images': z.object({ query: z.string().trim().min(2).max(200) }).strict(),
};

export type ToolHandlers = Partial<Record<ToolName, (input: Record<string, unknown>) => unknown>>;
/** `image` (ADR-039 `media.frames`): a picture the tool returned (contact sheet), attached to the next message for models with image input. */
export interface ToolCallRecord { name: string; input: unknown; output: unknown; ok: boolean; image?: ChatImage }

/** Max serialised size of one tool result sent back to the model (MCP_AND_TOOLING §3.3 output caps; 16 KB). */
const MAX_RESULT_CHARS = 16_000;
export const MAX_TOOL_ROUNDS = 4;

/** Catalogue categories `catalogue.search` accepts (the Local Service also maps plural / case slips). */
export const CATALOGUE_SEARCH_CATEGORIES = ['transition', 'caption', 'background', 'motion', 'shape', 'easing', 'effect', 'audio', 'text', 'texteffect', 'font', 'palette', 'fontpair'] as const;
const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const;
/** AI_WORKFLOW §8.1: description + JSON Schema of each read-only tool, as offered through a provider's native tools API. */
export const TOOL_DEFINITIONS: Record<ToolName, { description: string; inputSchema: Record<string, unknown> }> = {
  'composition.get': { description: 'Read the current video project: scenes, texts, images, audio, captions, transitions and duration (compact summary). Read-only.', inputSchema: NO_INPUT },
  'assets.list': { description: 'List the media the Creator imported into this project (id, kind, name, duration, size). Read-only.', inputSchema: NO_INPUT },
  'assets.probe': { description: 'Technical facts of one imported asset: fps, codecs, audio channels and sample rate, duration. Read-only.',
    inputSchema: { type: 'object', properties: { assetId: { type: 'string', description: 'Asset id from assets.list' } }, required: ['assetId'], additionalProperties: false } },
  'catalogue.search': { description: 'Search the design catalogue (transitions, captions, backgrounds, motions, shapes, effects, texts, fonts, palettes) for preset ids. Read-only.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A few words, e.g. "gradient calm" or "slide"' }, category: { type: 'string', enum: [...CATALOGUE_SEARCH_CATEGORIES], description: 'Optional catalogue category (singular)' } }, required: ['query'], additionalProperties: false } },
  'hardware.profile': { description: 'The Creator\'s computer tier, CPU threads, RAM and GPU. Read-only.', inputSchema: NO_INPUT },
  'project.settings.get': { description: 'Project settings: ratio, resolution, fps, language. Read-only.', inputSchema: NO_INPUT },
  'render.estimate': { description: 'Estimate render time and file size for this project. Read-only.',
    inputSchema: { type: 'object', properties: { resolution: { type: 'string', enum: ['720p', '1080p', '2k', '2160p'] }, performanceProfile: { type: 'string', enum: ['standard', 'accelerated', 'turbo'] } }, additionalProperties: false } },
  'composition.validateOps': { description: 'Dry run: check operations against the current project without changing it. Returns ok, issues, predictedDiff, predictedDurationMs.',
    inputSchema: { type: 'object', properties: { ops: { type: 'array', description: 'Operation objects {op, target, args}', items: { type: 'object' } } }, required: ['ops'], additionalProperties: false } },
  'web.search': { description: 'Search the internet for current facts, statistics, news, examples and sources. Returns a short summary and the source links (title, url). Use it for research; cite the sources.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search words, e.g. "ekspor nikel Indonesia 2026 ESDM"' } }, required: ['query'], additionalProperties: false } },
  'web.fetch': { description: 'Read one web page or PDF by its URL (a URL the Creator gave or a search returned). Returns its title and text (truncated).',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'https:// URL' } }, required: ['url'], additionalProperties: false } },
  'web.images': { description: 'Find openly licensed pictures (CC0 / CC BY / CC BY-SA, Openverse and Wikimedia Commons) for a topic. Returns candidates with licence and author; the Creator confirms before any picture is downloaded into the Library.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'What the picture should show (English works best)' } }, required: ['query'], additionalProperties: false } },
  'media.analyze': { description: 'Prepare the Creator\'s talking-head footage: sync the separate voice recording with the camera video, build the master, find the spoken phrases, listen (speech to text), pick the kept takes per script line and time the words. Returns offset, phrase count, the cut table (ids, recording times, spoken text), the dropped takes with reasons, loudness, warnings — or {status: "running", jobId} when it takes longer; call again later. Call it first when footage was uploaded.',
    inputSchema: { type: 'object', properties: { voiceAssetId: { type: 'string', description: 'The voice recording (audio asset id); or the video itself when it carries the speech' }, cameraAssetId: { type: 'string', description: 'The camera video asset id (optional)' }, script: { type: 'string', description: 'The script the Creator read (optional; lines are matched to takes)' }, rotation: { type: 'integer', enum: [0, 90, 180, 270], description: 'Rotate the camera picture (degrees clockwise) when it was stored sideways' } }, required: ['voiceAssetId'], additionalProperties: false } },
  'media.frames': { description: 'Look at the footage: a contact sheet of frames at the given master times or cuts (small JPEG grid; returned as an image when this model can see images, else the grid metadata). Use it to check the picture, the rotation and to pick the cover frame.',
    inputSchema: { type: 'object', properties: { atMs: { type: 'array', items: { type: 'integer' }, description: 'Master times in ms (1–12)' }, cutIds: { type: 'array', items: { type: 'string' }, description: 'Cut ids of the analysis (1–12); one frame per cut' }, rotation: { type: 'integer', enum: [0, 90, 180, 270] } }, additionalProperties: false } },
  'media.analysis.get': { description: 'The stored footage analysis of this project: master asset, offset, cuts (id, recording times, spoken words), dropped takes, loudness, warnings. Read-only; use the cut ids in a talking-head VideoSpec.', inputSchema: NO_INPUT },
};
/** Provider-safe tool name: providers accept [A-Za-z0-9_-] only, so `catalogue.search` is offered as `catalogue_search`. */
export const wireToolName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_');
/** The registry name of a tool name a model used (wire name, dotted name, or a near spelling), or the name unchanged. */
export function fromWireToolName(name: string, allowed: readonly string[] = EDITOR_TOOL_NAMES): string {
  const n = String(name ?? '').trim();
  return allowed.find((a) => a === n || wireToolName(a) === n || wireToolName(a).toLowerCase() === wireToolName(n).toLowerCase()) ?? n;
}
/** Native tool specs for the offered tools. */
export function toolSpecs(names: readonly ToolName[]): ToolSpec[] {
  return names.map((n) => ({ name: wireToolName(n), description: TOOL_DEFINITIONS[n].description, inputSchema: TOOL_DEFINITIONS[n].inputSchema }));
}

/**
 * Appended to the agent system prompt. `json` (AI_WORKFLOW §12 "Model lacks tool calling"): the JSON-mode protocol. `native`
 * (AI_WORKFLOW §8.1): the tools come through the provider's tools API; the prompt only says when to use them and forbids
 * writing tool syntax into the answer (Claude otherwise imitated the protocol in its own XML style, QA 2026-10-27).
 */
export function toolsPromptBlock(names: readonly ToolName[], finalReply = 'reply normally', mode: 'json' | 'native' = 'json'): string {
  if (!names.length) return '';
  if (mode === 'native') {
    return ['', '## Read-only tools', `You can call these read-only tools through the tools interface of this request before answering: ${names.join(', ')}.`,
      `Use them only when they help. At most ${MAX_TOOL_ROUNDS} rounds of tool calls per answer; then ${finalReply}. Tools never change the project.`,
      'Never write tool calls, XML tags or tool JSON into your answer text: the Creator reads it.'].join('\n');
  }
  const sig = (n: ToolName) => (n === 'catalogue.search' ? '{"query": string, "category"?: string}' : n === 'web.search' || n === 'web.images' ? '{"query": string}' : n === 'web.fetch' ? '{"url": string}' : n === 'render.estimate' ? '{"resolution"?: "720p"|"1080p"|"2k"|"2160p", "performanceProfile"?: "standard"|"accelerated"|"turbo"}'
    : n === 'assets.probe' ? '{"assetId": string} (fps, codecs, audio channels and sample rate, duration)' : n === 'composition.validateOps' ? '{"ops": Operation[]} (dry run against baseVersion: ok, issues, predictedDiff, predictedDurationMs)'
    : n === 'media.analyze' ? '{"voiceAssetId": string, "cameraAssetId"?: string, "script"?: string, "rotation"?: 0|90|180|270} (footage prep: sync, master, phrases, takes, word timing; may return {status: "running", jobId})'
    : n === 'media.frames' ? '{"atMs"?: number[], "cutIds"?: string[], "rotation"?: 0|90|180|270} (contact sheet of the footage)' : n === 'media.analysis.get' ? '{} (the stored footage analysis: cuts with ids and spoken words)' : '{}');
  const lines = names.map((n) => `- ${n} ${sig(n)}`);
  return ['', '## Read-only tools', 'Before answering you may look things up. To call a tool, reply with only this JSON and nothing else:',
    '{"tool": "<name>", "input": { ... }}', `You will receive {"toolResult": ...}. At most ${MAX_TOOL_ROUNDS} tool calls per answer; then ${finalReply}. Tools never change the project.`,
    'Write only that JSON object for a tool call, in no other format.', ...lines].join('\n');
}

/** A tool request when the reply is exactly a {"tool", "input"} object without a "reply". */
export function asToolRequest(json: unknown): { name: string; input: unknown } | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (typeof o['tool'] !== 'string' || 'reply' in o) return null;
  return { name: o['tool'], input: o['input'] ?? {} };
}
/**
 * Every tool request in a JSON-mode reply: the {"tool", "input"} object, or tool calls the model wrote as markup instead
 * (<invoke>, <function_calls>, <tool_call>, …; QA 2026-10-27). Names are mapped back to registry names.
 */
export function toolRequestsOf(text: string, json: unknown, allowed: readonly string[] = EDITOR_TOOL_NAMES): Array<{ name: string; input: unknown }> {
  const one = asToolRequest(json);
  if (one) return [{ name: fromWireToolName(one.name, allowed), input: one.input }];
  return parseToolMarkup(text).map((c) => ({ name: fromWireToolName(c.name, allowed), input: c.input ?? {} }));
}

/** Runs one tool call through the closed registry. Never throws; unknown or disallowed tools return EM-4501 / EM-4502. */
export async function runTool(name: string, input: unknown, handlers: ToolHandlers, allowed: readonly ToolName[] = BRAINSTORM_TOOL_NAMES): Promise<ToolCallRecord> {
  const err = (code: string, message: string): ToolCallRecord => ({ name, input, output: { error: { code, message } }, ok: false });
  if (!(allowed as readonly string[]).includes(name)) {
    const who = allowed.includes('composition.validateOps') ? 'the Editor Agent' : 'the Brainstorming Agent';
    return /\.(apply|validate|start|generate|remove|set|exec)/i.test(name) ? err('EM-4502', `${name} is not allowed for ${who}.`) : err('EM-4501', `Unknown tool ${name}.`);
  }
  const tool = name as ToolName;
  const handler = handlers[tool];
  if (!handler) return err('EM-4506', `${name} is not available right now.`);
  const parsed = BRAINSTORM_TOOL_INPUTS[tool].safeParse(input ?? {});
  if (!parsed.success) return err('EM-4503', `${name}: ${parsed.error.issues[0]?.message ?? 'invalid input'}`);
  try {
    const output = await handler(parsed.data as Record<string, unknown>);
    // ADR-039 media.frames: a picture in the result travels as an image part (never as 1.5 MB of base64 text in the tool result).
    if (output && typeof output === 'object' && typeof (output as { imageBase64?: unknown }).imageBase64 === 'string') {
      const { imageBase64, ...rest } = output as { imageBase64: string; mediaType?: string };
      return { name, input: parsed.data, output: { ...rest, image: 'attached as a picture of this message' }, ok: true, image: { mediaType: (output as { mediaType?: string }).mediaType ?? 'image/jpeg', data: imageBase64, name: 'contact-sheet.jpg' } };
    }
    return { name, input: parsed.data, output, ok: true };
  } catch (e) {
    const code = typeof (e as { code?: unknown })?.code === 'string' && /^EM-\d{4}$/.test((e as { code: string }).code) ? (e as { code: string }).code : 'EM-4505';
    return err(code, `${name} failed.`);
  }
}

/** The result text of one tool call for a native tool_result (same body as the JSON-mode message, ≤ 16 KB). */
export function toolResultContent(rec: ToolCallRecord): string {
  const body = JSON.stringify(rec.ok ? rec.output ?? null : rec.output);
  return body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}…(truncated)` : body;
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
  /** `key`: the JSON string field that is streamed ("reply" for Brainstorm, "goal" for an Edit Plan, FR-084). */
  constructor(private readonly key = 'reply') {}
  private raw = '';
  private mode: 'unknown' | 'prose' | 'json' = 'unknown';
  private pos = -1;           // index in raw just after the opening quote of "reply"
  private done = false;
  private escape = false;
  private shown = '';
  push(delta: string): string {
    this.raw += delta;
    if (this.mode === 'unknown') {
      const s = this.raw.replace(/^\s+/, '');
      if (!s) return '';
      if (s.startsWith('{') || s.startsWith('`')) this.mode = 'json';
      else this.mode = 'prose';
    }
    if (this.mode === 'prose') {
      // QA 2026-10-27: tool-call markup a model writes into its prose is never shown, not even while it streams.
      const visible = stripToolMarkup(this.raw.replace(/^\s+/, ''), { partial: true });
      if (!visible.startsWith(this.shown)) return '';
      const out = visible.slice(this.shown.length); this.shown = visible; return out;
    }
    if (this.done) return '';
    if (this.pos < 0) {
      const m = new RegExp(`"${this.key}"\\s*:\\s*"`).exec(this.raw);
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
