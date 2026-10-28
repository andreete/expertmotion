// Read-time normaliser for stored chat messages (FR-212, QA 2026-10-27): a Diskusi answer stored with a proposed intent that had
// no `params` crashed the chat on every open ("Cannot read properties of undefined (reading '__output')"). Every message block
// read from the database (Local Service) or received from it (Editor) passes through here, so a message stored by an older build
// with a bad shape renders instead of crashing. Pure, no dependencies; unknown block types are dropped (the chat ignores them).

export type ChatBlockOut =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'proposed_intents'; intents: Array<Record<string, unknown> & { id: string; category: string; params: Record<string, unknown>; needsInterpretation: boolean; source: string }>; handoffState: 'pending' | 'sent' | 'dismissed' }
  | { type: 'attachment'; assetId?: string; documentId?: string; mime: string; name: string; sent?: 'image' | 'name' | 'text'; chars?: number; truncated?: boolean }
  | { type: 'targets'; items: Array<{ kind: string; id?: string; index?: number; label: string; startMs?: number; endMs?: number }> }
  /** FR-216 web sources of an answer. */
  | { type: 'sources'; items: Array<{ url: string; title?: string; citedText?: string; pageAge?: string; cited?: boolean }>; queries?: string[] }
  /** FR-217 openly licensed picture candidates. */
  | { type: 'image_candidates'; items: Array<{ source: 'openverse' | 'wikimedia'; id: string; title: string; creator: string | null; license: string; licenseVersion: string | null; licenseUrl: string | null; landingUrl: string | null; width: number | null; height: number | null; provider: string | null; importedAssetId?: string }> }
  /** A notice line (research could not run, …) with its EM code. */
  | { type: 'notice'; code: string; text: string }
  /** FR-219 / ADR-033: a Brainstorm draft handed to the Editor (state follows the Editor run). */
  /** FR-219: this Editor message came from a Brainstorm draft ("Kirim ke Editor"). */
  | { type: 'origin'; from: 'brainstorm'; messageId: string; auto?: boolean }
  | { type: 'handoff'; draftTitle: string; editorMessageId?: string; editorRunId?: string; state: 'sent' | 'planning' | 'ready' | 'applied' | 'failed'; scenes?: number };

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
      case 'attachment': out.push({ type: 'attachment', ...(typeof b['assetId'] === 'string' ? { assetId: b['assetId'] } : {}), ...(typeof b['documentId'] === 'string' ? { documentId: b['documentId'] } : {}), mime: s(b['mime'], 'application/octet-stream'), name: s(b['name'], 'file'),
        ...(b['sent'] === 'image' || b['sent'] === 'name' || b['sent'] === 'text' ? { sent: b['sent'] } : {}), ...(typeof b['chars'] === 'number' ? { chars: b['chars'] } : {}), ...(b['truncated'] === true ? { truncated: true } : {}) }); break;
      case 'sources': {
        const items = (Array.isArray(b['items']) ? b['items'] : []).flatMap((x) => (obj(x) && typeof x['url'] === 'string' && /^https?:\/\//i.test(x['url'])
          ? [{ url: x['url'], ...(typeof x['title'] === 'string' ? { title: x['title'] } : {}), ...(typeof x['citedText'] === 'string' ? { citedText: x['citedText'] } : {}), ...(typeof x['pageAge'] === 'string' ? { pageAge: x['pageAge'] } : {}), ...(x['cited'] === true ? { cited: true } : {}) }] : [])).slice(0, 20);
        const queries = Array.isArray(b['queries']) ? b['queries'].filter((q): q is string => typeof q === 'string').slice(0, 10) : [];
        if (items.length) out.push({ type: 'sources', items, ...(queries.length ? { queries } : {}) });
        break;
      }
      case 'image_candidates': {
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null); const sn = (v: unknown) => (typeof v === 'string' ? v : null);
        const items = (Array.isArray(b['items']) ? b['items'] : []).flatMap((x) => (obj(x) && (x['source'] === 'openverse' || x['source'] === 'wikimedia') && typeof x['id'] === 'string'
          ? [{ source: x['source'] as 'openverse' | 'wikimedia', id: x['id'], title: s(x['title'], 'Untitled'), creator: sn(x['creator']), license: s(x['license']), licenseVersion: sn(x['licenseVersion']), licenseUrl: sn(x['licenseUrl']), landingUrl: sn(x['landingUrl']), width: n(x['width']), height: n(x['height']), provider: sn(x['provider']), ...(typeof x['importedAssetId'] === 'string' ? { importedAssetId: x['importedAssetId'] } : {}) }] : [])).slice(0, 12);
        if (items.length) out.push({ type: 'image_candidates', items });
        break;
      }
      case 'notice': if (typeof b['code'] === 'string') out.push({ type: 'notice', code: b['code'], text: s(b['text']) }); break;
      case 'origin': if (typeof b['messageId'] === 'string') out.push({ type: 'origin', from: 'brainstorm', messageId: b['messageId'], ...(b['auto'] === true ? { auto: true } : {}) }); break;
      case 'handoff': {
        const st = b['state'];
        out.push({ type: 'handoff', draftTitle: s(b['draftTitle']), ...(typeof b['editorMessageId'] === 'string' ? { editorMessageId: b['editorMessageId'] } : {}), ...(typeof b['editorRunId'] === 'string' ? { editorRunId: b['editorRunId'] } : {}),
          state: st === 'planning' || st === 'ready' || st === 'applied' || st === 'failed' ? st : 'sent', ...(typeof b['scenes'] === 'number' ? { scenes: b['scenes'] } : {}) });
        break;
      }
      case 'targets': {
        const items = (Array.isArray(b['items']) ? b['items'] : []).flatMap((t) => (obj(t) && typeof t['kind'] === 'string' && s(t['label']).trim()
          ? [{ kind: t['kind'], label: s(t['label']), ...(typeof t['id'] === 'string' ? { id: t['id'] } : {}), ...(typeof t['index'] === 'number' ? { index: t['index'] } : {}),
            ...(typeof t['startMs'] === 'number' ? { startMs: t['startMs'] } : {}), ...(typeof t['endMs'] === 'number' ? { endMs: t['endMs'] } : {}) }] : []));
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
