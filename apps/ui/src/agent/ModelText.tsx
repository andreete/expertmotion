// Model text in the agent chats (QA 2026-10-25 #16): the reply is first unwrapped from any JSON wrapper (extractReplyText,
// shared with the agents runner, so messages stored before the fix display cleanly too), then a safe markdown subset is
// rendered as React nodes: **bold** / __bold__, *italic* / _italic_, `inline code`, line breaks, paragraphs, "- " / "* " /
// "• " bullet lists, "1." / "1)" numbered lists, "#" headings as bold lines. No raw HTML, no links, no dangerouslySetInnerHTML:
// every piece of model text ends up as a React text node, so markup in it is shown as text and never interpreted.
import { Fragment, type ReactNode } from 'react';
import { extractReplyText } from '@expertmotion/shared';

/** The readable text of a model message (never the JSON wrapper). */
export const modelReplyText = (raw: string): string => extractReplyText(raw).text;

export type MdBlock =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; start: number; items: string[] };

const BULLET = /^\s{0,6}[-*+•]\s+(.*)$/;
const NUMBERED = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;

/** Splits text into blocks (pure; exported for tests). */
export function markdownBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  const last = () => out[out.length - 1];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!line.trim()) { out.push({ kind: 'p', lines: [] }); continue; }                 // blank line ends the block
    const b = BULLET.exec(line), n = NUMBERED.exec(line), h = HEADING.exec(line);
    const l = last();
    if (b && !/^\s*\*\*/.test(line)) { if (l?.kind === 'ul') l.items.push(b[1]!); else out.push({ kind: 'ul', items: [b[1]!] }); continue; }
    if (n) { if (l?.kind === 'ol') l.items.push(n[2]!); else out.push({ kind: 'ol', start: Number(n[1]), items: [n[2]!] }); continue; }
    if (h) { out.push({ kind: 'h', text: h[1]! }); continue; }
    if ((l?.kind === 'ul' || l?.kind === 'ol') && /^\s{2,}\S/.test(line)) { l.items[l.items.length - 1] += ` ${line.trim()}`; continue; }   // wrapped list item
    if (l?.kind === 'p' && l.lines.length) l.lines.push(line); else out.push({ kind: 'p', lines: [line] });
  }
  return out.filter((x) => (x.kind === 'p' ? x.lines.length > 0 : true));
}

// Inline: `code` first (its content is literal), then **bold** / __bold__, then *italic* / _italic_ (underscores only at
// word boundaries, so snake_case stays as it is). Unmatched markers stay literal text.
const INLINE = /(`[^`\n]+`)|(\*\*(?=\S)[^\n]*?\S\*\*|__(?=\S)[^\n]*?\S__)|(\*(?=[^\s*])[^*\n]*?[^\s*]\*|\*[^\s*]\*)|((?<![\p{L}\p{N}_])_(?=[^\s_])[^_\n]*?[^\s_]_(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])_[^\s_]_(?![\p{L}\p{N}_]))/u;

/** Inline markdown → React nodes (pure; exported for tests). */
export function inlineNodes(text: string, keyBase = 'i'): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text; let k = 0;
  while (rest) {
    const m = INLINE.exec(rest);
    if (!m) { nodes.push(rest); break; }
    if (m.index > 0) nodes.push(rest.slice(0, m.index));
    const key = `${keyBase}.${k++}`;
    const tok = m[0];
    if (m[1]) nodes.push(<code key={key} className="t-mono rounded-[4px] bg-em-panel px-1 text-[12px]">{tok.slice(1, -1)}</code>);
    else if (m[2]) nodes.push(<strong key={key} className="font-semibold">{inlineNodes(tok.slice(2, -2), key)}</strong>);
    else nodes.push(<em key={key}>{inlineNodes(tok.slice(1, -1), key)}</em>);
    rest = rest.slice(m.index + tok.length);
  }
  return nodes;
}

/** A model message rendered as safe markdown. `inline`: one line of inline formatting only (Plan Card goal, chips). */
export function ModelText({ text, inline = false, raw = false, el }: { text: string; inline?: boolean; raw?: boolean; el?: string }) {
  const clean = raw ? text : modelReplyText(text);
  if (inline) return <span data-el={el}>{inlineNodes(clean.replace(/\s*\n+\s*/g, ' '))}</span>;
  const blocks = markdownBlocks(clean);
  return (
    <div data-el={el} data-md="" className="flex flex-col gap-1.5 break-words">
      {blocks.map((b, i) => {
        const key = `b${i}`;
        switch (b.kind) {
          case 'h': return <p key={key} className="font-semibold">{inlineNodes(b.text, key)}</p>;
          case 'ul': return <ul key={key} className="list-disc space-y-0.5 pl-4">{b.items.map((it, j) => <li key={j}>{inlineNodes(it, `${key}.${j}`)}</li>)}</ul>;
          case 'ol': return <ol key={key} start={b.start} className="list-decimal space-y-0.5 pl-5">{b.items.map((it, j) => <li key={j}>{inlineNodes(it, `${key}.${j}`)}</li>)}</ol>;
          default: return <p key={key}>{b.lines.map((l, j) => <Fragment key={j}>{j > 0 && <br />}{inlineNodes(l, `${key}.${j}`)}</Fragment>)}</p>;
        }
      })}
    </div>
  );
}
