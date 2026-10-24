// Parses docs/ELEMENT_IDS.md (the owner of element ids) so tests stay in sync with the document.
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';

export function parseElementIds(): string[] {
  const md = readFileSync(fileURLToPath(new NodeURL('../../../docs/ELEMENT_IDS.md', import.meta.url)), 'utf8');
  const out = new Set<string>();
  for (const line of md.split('\n')) {
    if (!line.startsWith('| `')) continue;
    const first = line.split('|')[1] ?? '';
    const tokens = [...first.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    let base: string | null = null;
    for (const tok of tokens) {
      if (tok.startsWith('.') && base) {
        const rel = tok.slice(1).split('.');
        const parts = base.split('.');
        out.add([...parts.slice(0, parts.length - rel.length), ...rel].join('.'));
      } else if (/^[a-z]+\.[a-z0-9.]+$/.test(tok)) { base = tok; out.add(tok); }
    }
  }
  return [...out];
}
