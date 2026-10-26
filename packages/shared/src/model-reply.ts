// Tolerant reading of model replies (QA 2026-10-25 #16): free / small models wrap the chat reply in JSON, put it in a code
// fence, add prose around it, stop mid-string, double-encode it or send literal "\n" escapes. Pure, no dependencies; shared by
// the agents runner (what is stored) and the Editor UI (what is shown, including messages stored before this fix).

const FENCE_RE = /```[ \t]*([A-Za-z0-9_-]*)[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g;
/** Keys a model may use for the chat text when it does not follow the BrainstormTurn schema exactly. */
export const REPLY_KEYS = ['reply', 'message', 'response', 'answer', 'content', 'text'] as const;

/** Escapes raw control characters inside JSON strings (models often emit real newlines there, which JSON.parse rejects). */
export function repairJsonStrings(s: string): string {
  let out = ''; let inStr = false; let esc = false;
  for (const c of s) {
    if (!inStr) { if (c === '"') inStr = true; out += c; continue; }
    if (esc) { esc = false; out += c; continue; }
    if (c === '\\') { esc = true; out += c; continue; }
    if (c === '"') { inStr = false; out += c; continue; }
    out += c === '\n' ? '\\n' : c === '\r' ? '' : c === '\t' ? '\\t' : c < ' ' ? '' : c;
  }
  return out;
}

/**
 * Repairs closing brackets (live QA 2026-10-26, nemotron-3-ultra: `…]}]}` where `…]}}` was meant): a closer that does not match
 * the innermost open bracket is replaced by the one that does, a stray closer after the outermost value ends the text, and up to
 * two missing closers are appended when the text ends after a complete value (never inside a string, never for more).
 * Returns null when nothing needed fixing or the text cannot be fixed this way.
 */
export function repairJsonClosers(s: string): string | null {
  const stack: string[] = []; let out = ''; let inStr = false, esc = false, changed = false, started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) { out += c; if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '{' || c === '[') { stack.push(c === '{' ? '}' : ']'); started = true; out += c; continue; }
    if (c === '}' || c === ']') {
      if (!stack.length) { if (started) { changed = true; break; } out += c; continue; }
      const want = stack.pop()!;
      if (c !== want) changed = true;
      out += want;
      if (!stack.length) { if (s.slice(i + 1).trim()) changed = true; break; }
      continue;
    }
    out += c;
  }
  if (inStr) return null;
  if (stack.length) {
    if (stack.length > 2 || !/[}\]"\d el]\s*$/.test(out)) return null;
    out += stack.reverse().join(''); changed = true;
  }
  return changed ? out : null;
}

function tryParse(s: string | undefined): { ok: true; value: unknown } | { ok: false } {
  if (!s) return { ok: false };
  try { return { ok: true, value: JSON.parse(s) }; } catch { /* repaired below */ }
  try { return { ok: true, value: JSON.parse(repairJsonStrings(s)) }; } catch { /* closers below */ }
  const fixed = repairJsonClosers(repairJsonStrings(s));
  if (fixed) { try { return { ok: true, value: JSON.parse(fixed) }; } catch { /* not repairable */ } }
  return { ok: false };
}

/** The first balanced {...} object starting at or after `from` (string-aware), or null. */
function balancedObject(t: string, from = 0): string | null {
  const first = t.indexOf('{', from);
  if (first < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = first; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) return t.slice(first, i + 1);
  }
  return null;
}

/**
 * Parses JSON out of a model reply: the whole text, any ```json fence, or the first balanced object; raw newlines inside
 * strings are repaired; a JSON string that itself holds JSON (double encoding) is unwrapped (up to 3 levels).
 * Returns undefined when no JSON value is found.
 */
/**
 * Removes reasoning that some models (and OpenRouter routes) put into the answer text: `<think>…</think>`, `<thinking>`,
 * `<reasoning>`, `<reflection>` blocks, and an unclosed leading `<think>` (the answer starts after its last closing tag, or,
 * when the reply was cut off inside it, nothing is left). JSON examples inside the reasoning are never taken as the reply.
 */
export function stripReasoning(text: string): string {
  let t = text.replace(/<(think|thinking|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '');
  const close = /<\/(think|thinking|reasoning|reflection)>/gi;
  let last = -1; for (const m of t.matchAll(close)) last = m.index! + m[0].length;
  if (last >= 0) t = t.slice(last);                                      // "…reasoning</think> {json}" without an opening tag
  if (/^\s*<(think|thinking|reasoning|reflection)>/i.test(t)) t = '';     // opened, never closed: reasoning only
  return t;
}

/** Every top-level balanced {...} object in the text, in order (string-aware). */
export function balancedObjects(t: string, max = 20): string[] {
  const out: string[] = []; let from = 0;
  while (out.length < max) { const o = balancedObject(t, from); if (!o) break; const at = t.indexOf(o, from); out.push(o); from = at + o.length; }
  return out;
}

export function parseLooseJson(text: string): unknown {
  const t = stripReasoning(text.replace(/^﻿/, '')).trim();
  const candidates: Array<string | undefined> = [t];
  for (const m of t.matchAll(FENCE_RE)) candidates.push(m[2]?.trim());
  candidates.push(balancedObject(t) ?? undefined);
  for (const c of candidates) {
    const r = tryParse(c);
    if (!r.ok) continue;
    let v = r.value;
    for (let depth = 0; depth < 3 && typeof v === 'string'; depth++) {
      const inner = v.trim();
      if (!/^[{["]/.test(inner)) break;
      const n = tryParse(inner);
      if (!n.ok) break;
      v = n.value;
    }
    if (typeof v === 'string' && !/^\s*[{[]/.test(v)) continue;     // a bare JSON string literal is prose, not a reply object
    return v;
  }
  return undefined;
}

/** Decodes a JSON string body starting right after its opening quote; stops at the closing quote or the end (truncated). */
function decodeJsonStringBody(s: string, start: number): { text: string; closed: boolean } {
  let out = '';
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"') return { text: out, closed: true };
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === undefined) break;
    i++;
    if (n === 'n') out += '\n'; else if (n === 't') out += '\t'; else if (n === 'r') { /* drop */ }
    else if (n === 'u') { const hex = s.slice(i + 1, i + 5); if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 4; } else break; }
    else out += n;                                                    // \" \\ \/ and anything else: the character itself
  }
  return { text: out, closed: false };
}

/** Unescapes literal \n, \t, \", \\ left in prose, only when the text clearly carries JSON escapes (no real line breaks). */
export function unescapeLiteral(s: string): string {
  const looksEscaped = (/\\n/.test(s) && !s.includes('\n')) || /\\"/.test(s);
  if (!looksEscaped) return s;
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : c.length === 5 ? String.fromCharCode(parseInt(c.slice(1), 16)) : c));
}

function stringField(o: unknown, keys: readonly string[]): string | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  for (const k of keys) { const v = (o as Record<string, unknown>)[k]; if (typeof v === 'string') return v; }
  return null;
}

export interface ModelReplyText {
  text: string;
  /** json: a complete JSON object held the reply; partial: decoded from a truncated / malformed JSON string; plain: prose. */
  source: 'json' | 'partial' | 'plain';
  /** The parsed object when the reply was a complete JSON object (other fields such as questions / proposedIntents). */
  json?: Record<string, unknown>;
}

/**
 * The human-readable reply inside a model answer. Never returns the JSON wrapper: `{"reply": "…"}` in any form (fenced,
 * with prose around it, truncated, double-encoded, with raw newlines) yields the decoded string; anything else is returned
 * as plain text with a wrapping code fence removed and literal escapes undone.
 */
export function extractReplyText(raw: string, keys: readonly string[] = REPLY_KEYS, depth = 0): ModelReplyText {
  const t = (raw ?? '').replace(/^﻿/, '').trim();
  if (!t) return { text: '', source: 'plain' };
  const json = parseLooseJson(t);
  const field = stringField(json, keys);
  if (field !== null) {
    const inner = depth < 3 && /^\s*(```|\{|")/.test(field) ? extractReplyText(field, keys, depth + 1) : null;
    return { text: inner && inner.source !== 'plain' ? inner.text : field.trim(), source: 'json', json: json as Record<string, unknown> };
  }
  // A truncated or malformed object (nothing parsed): decode the reply string from its key onwards (single- or double-encoded).
  if (json === undefined) for (const k of keys) {
    const plainKey = new RegExp(`"${k}"\\s*:\\s*"`).exec(t);
    if (plainKey) {
      const d = decodeJsonStringBody(t, plainKey.index + plainKey[0].length);
      return { text: unescapeLiteral(d.text).trim(), source: 'partial' };
    }
    if (depth < 3 && new RegExp(`\\\\"${k}\\\\"\\s*:`).test(t)) {
      // Double-encoded: undo one level of escaping (\" → ", \\ → \, \n → newline), then read it again.
      const once = t.replace(/\\(["\\/nrt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '' : c));
      const r = extractReplyText(once.slice(Math.max(0, once.indexOf('{'))), keys, depth + 1);
      if (r.source !== 'plain') return { text: r.text, source: 'partial' };
    }
  }
  if (json !== null && typeof json === 'object' && /^(\{|```)/.test(t)) return { text: '', source: 'json', ...(json && !Array.isArray(json) ? { json: json as Record<string, unknown> } : {}) };
  // Prose. A reply that is only a code fence keeps its content; literal escapes are undone.
  const whole = /^```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  const body = whole ? whole[1]! : t;
  return { text: unescapeLiteral(body).trim(), source: 'plain' };
}
