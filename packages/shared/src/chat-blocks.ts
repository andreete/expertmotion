// Read-time normaliser for stored chat messages (FR-212, QA 2026-10-27): a Diskusi answer stored with a proposed intent that had
// no `params` crashed the chat on every open ("Cannot read properties of undefined (reading '__output')"). Every message block
// read from the database (Local Service) or received from it (Editor) passes through here, so a message stored by an older build
// with a bad shape renders instead of crashing. Pure, no dependencies; unknown block types are dropped (the chat ignores them).

export type ChatBlockOut =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'proposed_intents'; intents: Array<Record<string, unknown> & { id: string; category: string; params: Record<string, unknown>; needsInterpretation: boolean; source: string }>; handoffState: 'pending' | 'sent' | 'dismissed' }
  | { type: 'attachment'; assetId?: string; mime: string; name: string; sent?: 'image' | 'name' }
  | { type: 'targets'; items: Array<{ kind: string; id?: string; index?: number; label: string }> };

const PRESET_RE = /^preset:[a-z]+\.[a-z0-9-]+$/;
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : d);

/** One stored proposal made safe to show: id + category required; params {} when missing; bad preset / target fields dropped. */
export function normalizeStoredProposal(x: unknown): (Record<string, unknown> & { id: string; category: string; params: Record<string, unknown>; needsInterpretation: boolean; source: string }) | null {
  if (!obj(x) || typeof x['id'] !== 'string' || !x['id']) return null;
  const category = s(x['category']).trim();
  if (!category) return null;
  const presetId = typeof x['presetId'] === 'string' && PRESET_RE.test(x['presetId']) ? x['presetId'] : undefined;
  const target = obj(x['target']) && typeof x['target']['kind'] === 'string' ? x['target'] : undefined;
  const instruction = typeof x['instruction'] === 'string' && x['instruction'].trim() ? x['instruction'].slice(0, 2000) : undefined;
  return { id: x['id'], category, params: obj(x['params']) ? x['params'] : {}, needsInterpretation: typeof x['needsInterpretation'] === 'boolean' ? x['needsInterpretation'] : !presetId,
    source: s(x['source'], 'brainstorm') || 'brainstorm', ...(presetId ? { presetId } : {}), ...(target ? { target } : {}), ...(instruction ? { instruction } : {}) };
}

/** The blocks of a stored message in a shape every reader can rely on (see the file comment). */
export function normalizeMessageBlocks(raw: unknown): ChatBlockOut[] {
  let list = raw;
  if (typeof raw === 'string') { try { list = JSON.parse(raw) as unknown; } catch { return raw.trim() ? [{ type: 'text', text: raw }] : []; } }
  if (!Array.isArray(list)) return obj(list) ? normalizeMessageBlocks([list]) : [];
  const out: ChatBlockOut[] = [];
  for (const b of list) {
    if (!obj(b)) { if (typeof b === 'string' && b) out.push({ type: 'text', text: b }); continue; }
    switch (b['type']) {
      case 'text': out.push({ type: 'text', text: s(b['text']) }); break;
      case 'tool_call': out.push({ type: 'tool_call', name: s(b['name'], 'tool'), input: b['input'] ?? null }); break;
      case 'tool_result': out.push({ type: 'tool_result', name: s(b['name'], 'tool'), output: b['output'] ?? null }); break;
      case 'proposed_intents': {
        const intents = (Array.isArray(b['intents']) ? b['intents'] : []).map(normalizeStoredProposal).filter((x): x is NonNullable<typeof x> => x !== null);
        const st = b['handoffState'];
        if (intents.length) out.push({ type: 'proposed_intents', intents, handoffState: st === 'sent' || st === 'dismissed' ? st : 'pending' });
        break;
      }
      case 'attachment': out.push({ type: 'attachment', ...(typeof b['assetId'] === 'string' ? { assetId: b['assetId'] } : {}), mime: s(b['mime'], 'application/octet-stream'), name: s(b['name'], 'file'),
        ...(b['sent'] === 'image' || b['sent'] === 'name' ? { sent: b['sent'] } : {}) }); break;
      case 'targets': {
        const items = (Array.isArray(b['items']) ? b['items'] : []).flatMap((t) => (obj(t) && typeof t['kind'] === 'string' && s(t['label']).trim()
          ? [{ kind: t['kind'], label: s(t['label']), ...(typeof t['id'] === 'string' ? { id: t['id'] } : {}), ...(typeof t['index'] === 'number' ? { index: t['index'] } : {}) }] : []));
        if (items.length) out.push({ type: 'targets', items });
        break;
      }
      default: break;
    }
  }
  return out;
}

/** A message DTO with normalised blocks (role / id / createdAt kept; a missing blocks array becomes []). */
export function normalizeMessageDto<T extends { blocks?: unknown }>(m: T): T & { blocks: ChatBlockOut[] } {
  return { ...m, blocks: normalizeMessageBlocks(m?.blocks) };
}
