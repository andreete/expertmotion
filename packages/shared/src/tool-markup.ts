// Tool-call markup that models write as plain text (QA 2026-10-27, Claude Sonnet 5.5 in Diskusi): instead of the JSON-mode
// protocol {"tool", "input"} the model answered in its own XML-ish style, e.g.
//   <invoke><parameter name="input">{"query":"gradient"}</parameter><parameter name="tool">catalogue.search</parameter></invoke>
// and the chat showed it raw. Native tool calling (AI_WORKFLOW §8.1) avoids it for providers that support tools; this module is
// the fallback: it reads such markup as tool calls and removes it from every text the Creator sees (stored messages included).
// Recognised: <function_calls>/<invoke name=…>/<parameter name=…> (any `ns:` prefix), <invoke> with tool/name + input
// parameters, <tool_call>{json}</tool_call>, <tool_use>{json}</tool_use>, <function=name>{json}</function>. Pure, no dependencies.

export interface MarkupToolCall { name: string; input: unknown }

const NS = '(?:[A-Za-z_]+:)?';
const TAGS = ['function_calls', 'invoke', 'tool_call', 'tool_use', 'tool_calls'] as const;
const BLOCKS: RegExp[] = [
  new RegExp(`<${NS}function_calls\\b[^>]*>[\\s\\S]*?</${NS}function_calls\\s*>`, 'gi'),
  new RegExp(`<${NS}invoke\\b[^>]*>[\\s\\S]*?</${NS}invoke\\s*>`, 'gi'),
  /<tool_calls?\b[^>]*>[\s\S]*?<\/tool_calls?\s*>/gi,
  /<tool_use\b[^>]*>[\s\S]*?<\/tool_use\s*>/gi,
  /<function=[^>\s]+>[\s\S]*?<\/function\s*>/gi,
];
/** An opening tag that was never closed: everything after it is tool markup still being written (or cut off). */
const OPEN = new RegExp(`<(?:${NS}function_calls|${NS}invoke|tool_calls?|tool_use|function=)[\\s\\S]*$`, 'i');
const STRAY = new RegExp(`</?${NS}(?:function_calls|invoke|parameter|tool_calls?|tool_use)\\b[^>]*>`, 'gi');
const PARAM = new RegExp(`<${NS}parameter\\s+name\\s*=\\s*["']([^"']+)["'][^>]*>([\\s\\S]*?)</${NS}parameter\\s*>`, 'gi');
const NAME_KEYS = ['tool', 'name', 'tool_name', 'toolName', 'function', 'function_name'];
const INPUT_KEYS = ['input', 'arguments', 'parameters', 'args', 'params'];

/** True when the text contains tool-call markup (complete or still open). */
export function hasToolMarkup(text: string): boolean {
  return BLOCKS.some((r) => { r.lastIndex = 0; return r.test(text); }) || OPEN.test(text);
}

/** Index of a trailing fragment that may be the start of a markup tag (`<`, `<inv`, `<ns:fun`) while a reply streams, else -1. */
function partialTagAt(text: string): number {
  const i = text.lastIndexOf('<');
  if (i < 0 || text.length - i > 24 || text.slice(i).includes('>')) return -1;
  const raw = text.slice(i + 1).toLowerCase();
  if (!/^[a-z_:=]*$/.test(raw)) return -1;
  const frag = raw.replace(/^[a-z_]+:/, '');
  if (!frag || raw.endsWith(':')) return i;
  return [...TAGS, 'function='].some((tag) => tag.startsWith(frag)) || (!raw.includes(':') && raw.length <= 8) ? i : -1;
}

/**
 * The text without any tool-call markup. `partial` (streaming): also hides a trailing fragment that may become a tag. Blank
 * lines left behind are collapsed; prose around the markup is kept.
 */
export function stripToolMarkup(text: string, opts: { partial?: boolean } = {}): string {
  if (!text || !text.includes('<')) return text ?? '';
  let t = text;
  for (const r of BLOCKS) { r.lastIndex = 0; t = t.replace(r, '\n'); }
  t = t.replace(OPEN, '').replace(STRAY, '');
  if (opts.partial) { const at = partialTagAt(t); if (at >= 0) t = t.slice(0, at); }
  if (t === text) return text;
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');
  return opts.partial ? t : t.replace(/\s+$/, '');
}

const parseValue = (raw: string): unknown => {
  const v = raw.trim();
  if (/^[{["\d-]|^(true|false|null)$/.test(v)) { try { return JSON.parse(v); } catch { /* keep as text */ } }
  return v;
};
const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

/** A {name, arguments|input|parameters} or {tool, input} JSON body (tool_call / tool_use / function= styles). */
function fromJsonBody(body: string, name?: string): MarkupToolCall | null {
  const v = asObject(parseValue(body));
  if (name) return { name, input: v ?? {} };
  if (!v) return null;
  const n = NAME_KEYS.map((k) => v[k]).find((x): x is string => typeof x === 'string' && x.length > 0);
  if (!n) return null;
  const inp = INPUT_KEYS.map((k) => v[k]).find((x) => x !== undefined);
  return { name: n, input: typeof inp === 'string' ? (asObject(parseValue(inp)) ?? {}) : (inp ?? {}) };
}

/** Every tool call written as markup in the text, in order (at most 8). Calls without a tool name are skipped. */
export function parseToolMarkup(text: string): MarkupToolCall[] {
  if (!text || !text.includes('<')) return [];
  const found: Array<{ at: number; call: MarkupToolCall }> = [];
  const invoke = new RegExp(`<${NS}invoke\\b([^>]*)>([\\s\\S]*?)</${NS}invoke\\s*>`, 'gi');
  for (const m of text.matchAll(invoke)) {
    const attrName = /\bname\s*=\s*["']([^"']+)["']/i.exec(m[1] ?? '')?.[1];
    const params: Record<string, unknown> = {};
    for (const p of (m[2] ?? '').matchAll(PARAM)) params[p[1]!] = parseValue(p[2] ?? '');
    let name = attrName;
    if (!name) { const k = NAME_KEYS.find((x) => typeof params[x] === 'string'); if (k) { name = String(params[k]); delete params[k]; } }
    if (!name) { const j = fromJsonBody(m[2] ?? ''); if (j) { found.push({ at: m.index ?? 0, call: j }); } continue; }
    const k = INPUT_KEYS.find((x) => params[x] !== undefined);
    const input = k ? (typeof params[k] === 'string' ? (asObject(parseValue(String(params[k]))) ?? { value: params[k] }) : params[k]) : params;
    found.push({ at: m.index ?? 0, call: { name: name.trim(), input: input ?? {} } });
  }
  for (const m of text.matchAll(/<(tool_calls?|tool_use)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)) {
    const body = (m[2] ?? '').trim();
    const v = parseValue(body);
    const list = Array.isArray(v) ? v : [v];
    for (const x of list) { const c = typeof x === 'string' ? fromJsonBody(x) : fromJsonBody(JSON.stringify(x)); if (c) found.push({ at: m.index ?? 0, call: c }); }
  }
  for (const m of text.matchAll(/<function=([^>\s]+)>([\s\S]*?)<\/function\s*>/gi)) { const c = fromJsonBody(m[2] ?? '', m[1]); if (c) found.push({ at: m.index ?? 0, call: c }); }
  return found.sort((a, b) => a.at - b.at).slice(0, 8).map((f) => f.call);
}
