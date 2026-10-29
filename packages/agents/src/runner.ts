// Editor Agent and Brainstorming Agent runs (AI_WORKFLOW §7, §9–§12; AGENT_DESIGN §2–§5; SYSTEM_PROMPT P-1/P-2).
import { conflictsWithLocked, deriveTiming, propertyKeysOf, type ElementRefT, type OperationT } from '@expertmotion/composition-model';
import { EmError, extractReplyText, stripToolMarkup, type Issue } from '@expertmotion/shared';
import { prompts } from './prompt-store.js';
import { parseModelReply, validatePlan, extractJson, type PlanContext } from './plan.js';
import { normalizeModelReply, presetParamShape } from './plan-normalize.js';
import { listPresets } from '@expertmotion/catalogue';
import { BrainstormTurn, normalizeProposedIntents, type EditPlanT } from './schemas.js';
import type { RewriteEnvelope } from './envelope.js';
import type { ChatActivity, ChatImage, ChatMessage, ChatProvider, ChatRequest, ChatUsage, ToolCall, ToolResultPart, WebSource } from './providers.js';
import { mergeSources, researchPromptBlock, sourcesOfToolCalls, type ResearchConfig } from './research.js';
import { compileIntents, createIntents, pickFromIntent } from './intents.js';
import { describeSchema, opSignature } from './op-args.js';
import { isOpName, type OpName } from '@expertmotion/composition-model';
import { MAX_TOOL_ROUNDS, ReplyStreamer, fromWireToolName, runTool, summarizeThread, toolRequestsOf, toolResultContent, toolResultMessage, toolSpecs, toolsPromptBlock, BRAINSTORM_TOOL_NAMES, EDITOR_TOOL_NAMES, type BrainstormToolName, type ThreadSummary, type ToolCallRecord, type ToolHandlers, type ToolName } from './tools.js';

export interface RunOptions {
  maxCorrections?: number; maxTokens?: number; temperature?: number; signal?: AbortSignal; timeoutMs?: number; budgetCheck?: () => void;
  /** FR-075: receives streamed text deltas when the provider can stream (otherwise never called). */
  onDelta?: (delta: string) => void;
  /** FR-216: internet research for this run (prompt block + native web tools or web.* handlers). Absent = not mentioned. */
  research?: ResearchConfig;
  /** FR-190: what the run is doing now (chat shows "Membaca proyek…", "Menyusun rencana…", "Memeriksa rencana…"). */
  onProgress?: (p: RunProgress) => void;
}
/** `thinking` / `writing`: the provider stream shows the model reasoning / writing its answer (native streams only). */
export type RunPhase = 'reading' | 'planning' | 'checking' | 'correcting' | 'tool' | 'waiting' | 'thinking' | 'writing';
/** `attempt` of `of` (correcting: reply n of the allowed replies; waiting: rate-limit retry n of m, `waitMs` before it). */
export interface RunProgress { phase: RunPhase; attempt?: number; of?: number; tool?: string; waitMs?: number;
  /** FR-216: what web.search looks for / which page web.fetch reads ("Mencari di internet: <query>…"). */ query?: string; url?: string }
/** Output budget of one Editor plan reply: reasoning models count their thinking here, and a 5-scene plan is ~2–3k tokens. */
export const EDITOR_MAX_TOKENS = 8192;
/**
 * FR-190 diagnostics of one Editor Agent run, for the service log (never prompt text, user text or keys): how many replies,
 * which repairs the lenient parser made, and the codes / paths of the last rejection.
 */
export interface EditorRunDiagnostics { attempts: number; toolRounds: number; repairs: number; repairKinds: string[]; parseFailures: number; truncated?: number; lastIssues: Array<{ code: string; path: string }>; intentsReturned: boolean; fallbackQuestion?: boolean }
export interface EditorRunResult { ok: true; plan: EditPlanT; issues: Issue[]; attempts: number; usage: ChatUsage[]; droppedOps: number; toolCalls: ToolCallRecord[]; predicted?: ReturnType<typeof validatePlan>['predicted']; diagnostics: EditorRunDiagnostics;
  /** FR-216: web sources the Editor used while planning. */ sources?: WebSource[] }
export interface EditorRunFailure { ok: false; error: EmError; attempts: number; usage: ChatUsage[]; toolCalls: ToolCallRecord[]; lastText?: string; diagnostics: EditorRunDiagnostics }
export interface EditorRunOptions extends RunOptions {
  /** FR-080: read-only tool handlers from the Local Service (AI_WORKFLOW §8); `composition.validateOps` is added here (dry run). */
  tools?: ToolHandlers;
  /** FR-072: images attached to the Creator's message; the caller passes them only for models with image input. */
  images?: ChatImage[];
}

/** `composition.validateOps` (AI_WORKFLOW §8): dry run of operations against the plan base; never mutates. */
export function dryRunOps(input: Record<string, unknown>, ctx: PlanContext & { planId: string; projectId: string }) {
  // The model's baseVersion echo is not trusted (it is the runtime's); ops are repaired like a plan reply (plan-normalize.ts).
  const n = normalizeModelReply({ steps: [{ ops: Array.isArray(input['ops']) ? input['ops'] : [] }] }, { model: ctx.model, baseVersion: ctx.baseVersion, assets: ctx.assets });
  const ops = (((n.value?.['steps'] as Array<{ ops: unknown[] }> | undefined)?.[0]?.ops) ?? []) as OperationT[];
  const v = validatePlan({ id: ctx.planId, projectId: ctx.projectId, baseVersion: ctx.baseVersion, origin: 'editor-agent', goal: 'dry run', steps: [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: 'dry run', dependsOn: [] }], touchesLockedKeys: [], risks: [], status: 'draft', validation: [] }, ctx);
  return { ok: v.plan.status === 'valid', issues: v.issues.slice(0, 20).map((i) => ({ code: i.code, severity: i.severity, path: i.path, message: i.message })),
    predictedDiff: (v.predicted?.diff ?? []).slice(0, 50), predictedDurationMs: v.predicted ? deriveTiming(v.predicted.model).durationMs : null };
}

const langName = (l: 'id' | 'en') => (l === 'id' ? 'Bahasa Indonesia' : 'English');
export const editorSystemPrompt = (env: RewriteEnvelope) => prompts().EDITOR_SYSTEM.replaceAll('{{language_name}}', langName(env.project.language)).replaceAll('{{base_version}}', env.baseVersion);

type CallResult = { text: string; finishReason?: string; toolCalls?: ToolCall[]; providerRaw?: unknown; citations?: WebSource[]; webQueries?: string[]; webNotice?: { code: string; reason: string } };
async function call(provider: ChatProvider, system: string, messages: ChatMessage[], o: RunOptions, usage: ChatUsage[]): Promise<string> {
  return (await callFull(provider, system, messages, o, usage)).text;
}
/** `extra`: native tools / tool choice / wire activity for this call (AI_WORKFLOW §8.1). */
async function callFull(provider: ChatProvider, system: string, messages: ChatMessage[], o: RunOptions, usage: ChatUsage[], extra: Pick<ChatRequest, 'tools' | 'toolChoice' | 'onActivity' | 'webResearch'> = {}): Promise<CallResult> {
  o.budgetCheck?.();
  for (let attempt = 0; ; attempt++) {
    try {
      const onRetry = o.onProgress ? (r: { n: number; of: number; waitMs: number }) => { try { o.onProgress!({ phase: 'waiting', attempt: r.n, of: r.of, waitMs: r.waitMs }); } catch { /* hint */ } } : undefined;
      const req: ChatRequest = { system, messages, maxTokens: o.maxTokens ?? 4000, temperature: o.temperature ?? 0.2, ...(o.signal ? { signal: o.signal } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(onRetry ? { onRetry } : {}),
        ...(extra.tools?.length && provider.nativeTools ? { tools: extra.tools, toolChoice: extra.toolChoice ?? 'auto' } : {}), ...(extra.onActivity ? { onActivity: extra.onActivity } : {}),
        ...(extra.webResearch && provider.nativeWebResearch ? { webResearch: extra.webResearch } : {}) };
      let streamed = false;
      const r = o.onDelta && provider.stream ? await provider.stream(req, (d) => { streamed = true; o.onDelta!(d); }).catch((e: unknown) => { throw Object.assign(e as object, { streamed }); })
        : await provider.complete(req);
      usage.push(r.usage);
      return { text: r.text, ...(r.finishReason ? { finishReason: r.finishReason } : {}), ...(r.toolCalls?.length ? { toolCalls: r.toolCalls } : {}), ...(r.providerRaw !== undefined ? { providerRaw: r.providerRaw } : {}),
        ...(r.citations?.length ? { citations: r.citations } : {}), ...(r.webQueries?.length ? { webQueries: r.webQueries } : {}), ...(r.webNotice ? { webNotice: r.webNotice } : {}) };
    } catch (e) {
      const em = e instanceof EmError ? e : new EmError('EM-4003', String(e));
      const partial = (e as { streamed?: boolean })?.streamed === true;                                       // text already shown: never replay it
      // Retry once (AI_WORKFLOW §12); a rate limit the adapter already retried with backoff (details.retries) is not retried again.
      const retried = typeof (em.details as { retries?: unknown } | undefined)?.retries === 'number';
      if (attempt === 0 && !partial && (em.code === 'EM-4101' || (em.code === 'EM-4102' && !retried)) && !o.signal?.aborted) continue;
      throw em;
    }
  }
}

/** Wire activity → progress (each kind once per call; a tool is named by its registry name). */
function activityProgress(progress: (p: RunProgress) => void, allowed: readonly string[]): (a: ChatActivity) => void {
  const seen = new Set<string>();
  return (a) => {
    const key = a.type === 'tool' ? `tool:${a.name}` : a.type === 'web' ? `web:${a.kind}:${a.query ?? a.url ?? ''}` : a.type;
    if (seen.has(key)) return; seen.add(key);
    if (a.type === 'thinking') progress({ phase: 'thinking' });
    else if (a.type === 'text') progress({ phase: 'writing' });
    else if (a.type === 'web') progress({ phase: 'tool', tool: a.kind === 'search' ? 'web.search' : 'web.fetch', ...(a.query ? { query: a.query.slice(0, 200) } : {}), ...(a.url ? { url: a.url.slice(0, 300) } : {}) });
    else progress({ phase: 'tool', tool: fromWireToolName(a.name, allowed) });
  };
}
/** FR-216: native web research for a call: search + fetch, bounded per answer (Anthropic `max_uses`). */
function nativeWeb(cfg: ResearchConfig | undefined, editor = false): ChatRequest['webResearch'] | undefined {
  return cfg?.available && cfg.mode === 'native' ? { search: true, fetch: true, maxSearches: editor ? 3 : 5, maxFetches: editor ? 2 : 3 } : undefined;
}

/** Tool calls run per reply; any call after these still gets an error tool_result (C7, review 2026-10-29). */
export const MAX_TOOL_CALLS_PER_TURN = 8;
/**
 * Runs the tool calls of one reply (native or written as text) through the closed registry, in order. Native calls get one
 * tool_result each (errors flagged), so the next request carries every result in one user message. Only the first
 * MAX_TOOL_CALLS_PER_TURN run; every later call is answered with an EM-4503 error result (never left without a result, which
 * providers reject on the next request).
 */
export async function runToolCalls(calls: ReadonlyArray<{ id?: string; name: string; input: unknown }>, handlers: ToolHandlers, allowed: readonly ToolName[], progress: (p: RunProgress) => void, records: ToolCallRecord[]): Promise<ToolResultPart[]> {
  const out: ToolResultPart[] = [];
  for (const c of calls.slice(0, MAX_TOOL_CALLS_PER_TURN)) {
    const name = fromWireToolName(c.name, allowed);
    const inp = (c.input && typeof c.input === 'object' ? c.input : {}) as { query?: unknown; url?: unknown };
    progress({ phase: 'tool', tool: name, ...(typeof inp.query === 'string' && name.startsWith('web.') ? { query: inp.query.slice(0, 200) } : {}), ...(typeof inp.url === 'string' && name === 'web.fetch' ? { url: inp.url.slice(0, 300) } : {}) });
    const rec = await runTool(name, c.input, handlers, allowed);
    records.push(rec);
    out.push({ id: c.id ?? '', name: c.name, content: toolResultContent(rec), ...(rec.ok ? {} : { isError: true }) });
  }
  for (const c of calls.slice(MAX_TOOL_CALLS_PER_TURN)) {
    const rec: ToolCallRecord = { name: fromWireToolName(c.name, allowed), input: c.input, output: { error: { code: 'EM-4503', message: `Not run: at most ${MAX_TOOL_CALLS_PER_TURN} tool calls per reply. Ask again for what you still need.` } }, ok: false };
    out.push({ id: c.id ?? '', name: c.name, content: toolResultContent(rec), isError: true });
  }
  return out;
}

/** Correction text for a rejected plan: each blocking issue with its step / op, plus the exact args signature of that op. */
export function correctionMessage(plan: EditPlanT, blocking: readonly Issue[], fixes: readonly string[] = []): string {
  const lines = blocking.slice(0, 8).map((i) => {
    const m = /^steps\[(\d+)\]\.ops\[(\d+)\]/.exec(i.path);
    const op = m ? plan.steps[Number(m[1])]?.ops[Number(m[2])] : undefined;
    const where = m ? `step ${plan.steps[Number(m[1])]?.n ?? Number(m[1]) + 1}, op ${Number(m[2]) + 1}${op ? ` (${op.op})` : ''}` : i.path || 'plan';
    const sig = op && isOpName(op.op) ? ` Expected: ${op.op} ${opSignature(op.op as OpName)}.` : '';
    return `- ${where}: [${i.code}] ${i.message}${sig}${op ? presetHint(op, i) : ''}`;
  });
  const dropped = fixes.filter((f) => f.includes('dropped unknown arg')).slice(0, 5);
  return `The plan was rejected by validation:\n${lines.join('\n')}${dropped.length ? `\nIgnored argument names (not in the op's args): ${dropped.map((d) => d.replace(/^.*dropped unknown arg /, '')).join(', ')}.` : ''}\nFix only these problems, keep the rest of the plan, and reply with the whole EditPlan JSON only.`;
}

const PRESET_FIELDS: Record<string, Array<[string, string, string]>> = {          // [preset id arg, params arg, category]
  'op:scene.add': [['background', 'backgroundParams', 'background'], ['transition', '', 'transition'], ['motionId', '', 'motion'], ['titleVariant', '', 'text'], ['textVariant', '', 'text']],
  'op:transition.set': [['presetId', 'params', 'transition']], 'op:background.set': [['presetId', 'params', 'background']], 'op:scene.setBackground': [['presetId', 'params', 'background']],
  'op:motion.set': [['presetId', 'params', 'motion']], 'op:caption.setStyle': [['presetId', 'params', 'caption']], 'op:text.setEffect': [['presetId', 'params', 'texteffect']],
  'op:effect.add': [['presetId', 'params', 'effect']], 'op:shape.add': [['presetId', 'params', 'shape'], ['motionId', '', 'motion']], 'op:text.add': [['variant', '', 'text']],
};
/**
 * For a rejected preset id or preset params: the valid ids of that category (EM-2101) or the preset's params with their
 * types / values (EM-2102 on …params…), so the model can fix the value instead of guessing again.
 */
function presetHint(op: OperationT, i: Issue): string {
  const args = (op.args ?? {}) as Record<string, unknown>;
  for (const [idArg, pArg, cat] of PRESET_FIELDS[op.op] ?? []) {
    const onId = i.path.endsWith(`.args.${idArg}`) || (i.code === 'EM-2101' && typeof args[idArg] === 'string' && i.message.includes(String(args[idArg])));
    if (onId) {
      const ids = listPresets({ category: cat as never }).filter((p) => !p.flags.includes('licence:paid') && !p.flags.includes('webgpu')).map((p) => p.id).slice(0, 24);
      return ` Valid ${idArg} values: ${ids.join(', ')}.`;
    }
    if (pArg && (i.path.includes(`.args.${pArg}`) || (pArg === 'backgroundParams' && i.path.includes('.args.params')))) {
      const pid = args[idArg] ?? (op.op === 'op:scene.add' ? 'preset:background.gradient' : undefined);
      const shape = presetParamShape(pid);
      if (shape) return ` Allowed ${pArg} for ${String(pid)}: {${Object.entries(shape).map(([k, v]) => `${k}?: ${describeSchema(v as never)}`).join(', ')}} (or leave ${pArg} out for the defaults).`;
    }
  }
  return '';
}

/** A short question instead of a failure when the Creator pointed at elements but the request was too vague (FR-189). */
function askPlan(env: RewriteEnvelope, ctx: { planId: string; projectId: string; baseVersion: string }): EditPlanT {
  const names = (env.targets ?? []).map((t) => t.label).slice(0, 3).join(', ');
  const q = env.project.language === 'en' ? `What should I change on ${names}? For example: trim it, make it louder, add a title over it, or move it.` : `Apa yang ingin diubah pada ${names}? Misalnya: potong, keraskan suaranya, beri judul di atasnya, atau pindahkan.`;
  return { id: ctx.planId, projectId: ctx.projectId, baseVersion: ctx.baseVersion, origin: 'editor-agent', goal: q.slice(0, 300), steps: [], touchesLockedKeys: [], risks: [{ code: 'needs-input', message: q, severity: 'block' }], status: 'valid', validation: [] };
}

/** Intents returned instead of a plan: the fully specified ones compile deterministically into one step (no second model call). */
function compileReturnedIntents(raw: unknown[], ctx: PlanContext & { projectId: string }): OperationT[] | null {
  const ops: OperationT[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') return null;
    const p = x as Record<string, unknown>;
    if (typeof p['presetId'] !== 'string' || p['needsInterpretation'] === true) return null;
    const target = p['target'] as ElementRefT | undefined;
    const r = createIntents({ projectId: ctx.projectId, source: 'chat', presetId: p['presetId'], ...(typeof p['category'] === 'string' ? { category: p['category'] as never } : {}), ...(p['params'] && typeof p['params'] === 'object' ? { params: p['params'] as Record<string, unknown> } : {}), ...(target ? { selection: [target] } : {}) },
      { model: ctx.model, baseVersion: ctx.baseVersion, newId: ctx.newId });
    if (!r.ok) return null;
    const c = compileIntents(r.value, (i) => pickFromIntent(i), ctx.model);
    if (!c.ok) return null;
    ops.push(...c.value.map((o) => { const { intentId: _i, ...rest } = o; void _i; return rest; }));
  }
  return ops.length ? ops : null;
}

/** One Editor Agent run → a validated Edit Plan, or EM-4301 after 1 + maxCorrections invalid replies. */
export async function runEditorAgent(env: RewriteEnvelope, provider: ChatProvider, ctx: PlanContext & { planId: string; projectId: string }, o: EditorRunOptions = {}): Promise<EditorRunResult | EditorRunFailure> {
  const usage: ChatUsage[] = []; const toolCalls: ToolCallRecord[] = [];
  const diag: EditorRunDiagnostics = { attempts: 0, toolRounds: 0, repairs: 0, repairKinds: [], parseFailures: 0, lastIssues: [], intentsReturned: false };
  const progress = (p: RunProgress) => { try { o.onProgress?.(p); } catch { /* UI hint only */ } };
  // FR-080: JSON-mode read-only tool loop (same protocol as the Brainstorm loop); tool rounds do not count as corrections.
  const handlers: ToolHandlers = o.tools ? { ...o.tools, 'composition.validateOps': (i) => dryRunOps(i, ctx) } : {};
  const names = o.tools ? EDITOR_TOOL_NAMES.filter((n) => !!handlers[n]) : [];
  // AI_WORKFLOW §8.1: providers with a tools API get the tools natively; others keep the JSON-mode protocol (§12).
  const native = !!provider.nativeTools && names.length > 0;
  const specs = native ? toolSpecs(names) : undefined;
  const system = editorSystemPrompt(env) + toolsPromptBlock(names, 'reply with the EditPlan JSON only', native ? 'native' : 'json') + researchPromptBlock(o.research, 'editor');
  const web = nativeWeb(o.research, true); const cited: WebSource[][] = [];
  const messages: ChatMessage[] = [{ role: 'user', content: JSON.stringify(env), ...(o.images?.length ? { images: o.images } : {}) }];
  const maxCorrections = o.maxCorrections ?? 2;
  const replies = maxCorrections + 1;
  let noJsonInARow = 0; let used = 0;
  const norm = { model: ctx.model, baseVersion: ctx.baseVersion, assets: ctx.assets, language: env.project.language };
  let lockedRetryUsed = false; let lastText: string | undefined; let toolRounds = 0;
  const fail = (error: EmError, attempts: number, text?: string): EditorRunFailure => ({ ok: false, error, attempts, usage, toolCalls, ...(text ? { lastText: text } : {}), diagnostics: { ...diag, attempts, toolRounds } });
  progress({ phase: 'reading' });
  for (let attempt = 0; attempt <= maxCorrections + 1; attempt++) {
    let text: string;
    progress(attempt === 0 ? { phase: 'planning' } : { phase: 'correcting', attempt: attempt + 1, of: replies });
    // FR-084: the plan's goal streams while the model writes it (first attempt only, so a correction never repeats it).
    // Later attempts still stream (a silent stream is the timeout, not the whole answer time) but show nothing.
    const streamer = o.onDelta && attempt === 0 ? new ReplyStreamer('goal') : null;
    const co: RunOptions = { maxTokens: EDITOR_MAX_TOKENS, ...o }; delete co.onDelta;
    co.onProgress = (p) => progress(p.phase === 'waiting' ? p : { phase: attempt === 0 ? 'planning' : 'correcting', attempt: attempt + 1, of: replies });
    if (streamer) co.onDelta = (d: string) => { const v = streamer.push(d); if (v) o.onDelta!(v); };
    else if (o.onDelta) co.onDelta = () => { /* streamed for liveness only */ };
    let finishReason: string | undefined; let r: CallResult;
    const extra = { ...(specs ? { tools: specs, toolChoice: toolRounds >= MAX_TOOL_ROUNDS ? 'none' as const : 'auto' as const } : {}), onActivity: activityProgress(progress, EDITOR_TOOL_NAMES), ...(web ? { webResearch: web } : {}) };
    try { r = await callFull(provider, system, [...messages], co, usage, extra); text = r.text; finishReason = r.finishReason; } catch (e) { return fail(e as EmError, attempt + 1); }
    if (r.citations?.length) cited.push(r.citations);
    lastText = text; used = attempt + 1;
    if (r.toolCalls?.length) {                                          // native tool calls (AI_WORKFLOW §8.1)
      const turn: ChatMessage = { role: 'assistant', content: text, toolCalls: r.toolCalls, ...(r.providerRaw !== undefined ? { providerRaw: r.providerRaw } : {}) };
      if (toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        messages.push(turn, { role: 'user', content: '', toolResults: await runToolCalls(r.toolCalls, handlers, EDITOR_TOOL_NAMES, progress, toolCalls) });
        attempt--; continue;
      }
      messages.push(turn, { role: 'user', content: 'No more tool calls. Reply with the EditPlan JSON only.', toolResults: r.toolCalls.map((c) => ({ id: c.id, name: c.name, content: '{"error":{"message":"No more tool calls in this answer."}}', isError: true })) });
      continue;
    }
    const reqs = names.length ? toolRequestsOf(text, extractJson(text), EDITOR_TOOL_NAMES) : [];
    if (reqs.length) {                                                  // JSON-mode protocol, or tool calls written as markup
      messages.push({ role: 'assistant', content: text });
      if (toolRounds < MAX_TOOL_ROUNDS) {
        toolRounds++;
        const recs: ToolCallRecord[] = [];
        await runToolCalls(reqs, handlers, EDITOR_TOOL_NAMES, progress, recs);
        toolCalls.push(...recs); messages.push({ role: 'user', content: recs.map((x) => toolResultMessage(x).content).join('\n') }); attempt--; continue;
      }
      messages.push({ role: 'user', content: 'No more tool calls. Reply with the EditPlan JSON only.' }); continue;
    }
    progress({ phase: 'checking' });
    const truncated = finishReason === 'length';
    if (truncated) diag.truncated = (diag.truncated ?? 0) + 1;
    const parsed = parseModelReply(text, { id: ctx.planId, projectId: ctx.projectId }, norm, { truncated });
    if (parsed.fixes?.length) { diag.repairs += parsed.fixes.length; diag.repairKinds = [...new Set([...diag.repairKinds, ...parsed.fixes.map((f) => f.replace(/^step \d+( op \d+)?: /, '').replace(/ .*$/, ''))])].slice(0, 20); }
    let planIn = parsed.plan;
    if (parsed.intents) {
      diag.intentsReturned = true;
      const ops = compileReturnedIntents(parsed.intents, ctx);
      if (ops) planIn = { id: ctx.planId, projectId: ctx.projectId, baseVersion: ctx.baseVersion, origin: 'editor-agent', goal: env.project.language === 'en' ? 'Apply the suggested changes' : 'Terapkan perubahan yang diusulkan', steps: [{ n: 1, tool: 'composition.applyOps', ops, args: {}, expectedDiff: '', dependsOn: [] }], touchesLockedKeys: [], risks: [], status: 'draft', validation: [] };
      else {
        if (attempt >= maxCorrections) break;
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'You returned intents, but the Editor Agent must return an EditPlan with operations. Translate each intent into ops from capabilities.ops (args as in capabilities.opArgs) and reply with {"goal", "steps": [{"n": 1, "tool": "composition.applyOps", "ops": [...], "expectedDiff"}], "risks"} only.' });
        continue;
      }
    }
    if (!planIn) {
      diag.parseFailures++;
      noJsonInARow = parsed.noJson ? noJsonInARow + 1 : 0;
      // Two replies in a row without any JSON: this model does not follow the JSON contract; a third try only costs time.
      if (attempt >= maxCorrections || noJsonInARow >= 2) break;
      messages.push({ role: 'assistant', content: text }, { role: 'user', content: parsed.problem! }); continue;
    }
    let plan = planIn; let dropped = 0;
    let v = validatePlan(plan, ctx);
    if (v.plan.touchesLockedKeys.length) {
      if (!lockedRetryUsed && attempt < maxCorrections + 1) {
        lockedRetryUsed = true;
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: `Rejected: these keys are locked because the Creator chose them: ${v.plan.touchesLockedKeys.join(', ')}. Remove every operation that changes them, add a risk {code:"locked-key", severity:"info"}, and reply with the EditPlan JSON only.` });
        continue;
      }
      // Second violation: drop the offending operations with a notice (AI_WORKFLOW §6 conflict matrix). FR-081: every step that
      // lost operations is listed as an EM-2302 validation entry (path `droppedSteps[n]`) so the Plan Card shows it struck through.
      const locked = ctx.lockedKeys;
      const lost: Array<{ n: number; expectedDiff: string; keys: string[] }> = [];
      plan = { ...v.plan, status: 'draft', steps: v.plan.steps.map((s) => {
        const keys = new Set<string>();
        const keep = s.ops.filter((op) => { const hit = conflictsWithLocked(propertyKeysOf(op), locked); hit.forEach((k) => keys.add(k)); return hit.length === 0; });
        if (keep.length < s.ops.length) { dropped += s.ops.length - keep.length; lost.push({ n: s.n, expectedDiff: s.expectedDiff, keys: [...keys] }); }
        return { ...s, ops: keep };
      }).filter((s) => s.ops.length > 0 || s.tool !== 'composition.applyOps'),
        risks: [...v.plan.risks, { code: 'locked-key', message: `${dropped} change(s) to your own picks were left out.`, severity: 'info' }] };
      v = validatePlan(plan, ctx);
      v = { ...v, plan: { ...v.plan, validation: [...v.plan.validation, ...lost.map((d) => ({ path: `droppedSteps[${d.n}]`, code: 'EM-2302', message: `${d.n}. ${d.expectedDiff} (${d.keys.join(', ')})` }))] } };
    }
    diag.lastIssues = v.issues.filter((i) => i.severity === 'block').slice(0, 8).map((i) => ({ code: i.code, path: i.path }));
    if (v.plan.status === 'valid') { const sources = mergeSources([...cited, sourcesOfToolCalls(toolCalls)]); return { ok: true, plan: v.plan, issues: v.issues, attempts: attempt + 1, usage, droppedOps: dropped, toolCalls, ...(v.predicted ? { predicted: v.predicted } : {}), diagnostics: { ...diag, attempts: attempt + 1, toolRounds }, ...(sources.length ? { sources } : {}) }; }
    if (v.plan.status === 'stale') return fail(new EmError('EM-2301', 'The composition changed while the agent was planning; plan again.'), attempt + 1, text);
    if (attempt >= maxCorrections) break;
    messages.push({ role: 'assistant', content: text }, { role: 'user', content: correctionMessage(v.plan, v.issues.filter((i) => i.severity === 'block'), parsed.fixes) });
  }
  // FR-189: the Creator pointed at elements but no plan came out — ask what to change instead of failing.
  if (env.targets?.length) { diag.fallbackQuestion = true; return { ok: true, plan: askPlan(env, ctx), issues: [], attempts: used, usage, droppedOps: 0, toolCalls, diagnostics: { ...diag, attempts: used, toolRounds } }; }
  return fail(new EmError('EM-4301', 'The model could not produce a valid plan.', { details: { lastIssues: diag.lastIssues.slice(0, 5), ...(diag.truncated ? { truncated: diag.truncated } : {}) } }), used, lastText);
}

export interface BrainstormResult { ok: true; turn: ReturnType<typeof BrainstormTurn.parse>; usage: ChatUsage[]; toolCalls: ToolCallRecord[]; summary: ThreadSummary | null;
  /** FR-216: the sources of this answer (citations first), the searches the provider ran, and why research could not run. */
  sources: WebSource[]; webQueries: string[]; researchNotice?: { code: string; reason: string } }
export interface BrainstormOptions extends RunOptions {
  /** Model context length in tokens (Capability Table); the thread window is 60 % of it (AI_WORKFLOW §10). Unknown → 32k. */
  contextLength?: number | null;
  /** Read-only tool handlers supplied by the Local Service (AI_WORKFLOW §9); omitted tools are not offered to the model. */
  tools?: ToolHandlers;
  /** FR-072: images attached to the newest user message (sent as image parts; the caller checks image input capability). */
  images?: ChatImage[];
}
/** Characters of thread history that fit: 60 % of the context minus the system prompt and the reply budget (≈ 4 chars per token). */
export function threadBudgetChars(contextLength: number | null | undefined, systemChars: number, maxReplyTokens = 4000): number {
  const ctx = contextLength && contextLength > 0 ? contextLength : 32_000;
  return Math.max(2000, Math.floor(0.6 * ctx * 4) - systemChars - maxReplyTokens * 4);
}
/**
 * Brainstorming turn (read-only; never mutates, ADR-003). JSON-mode tool loop: up to MAX_TOOL_ROUNDS read-only tool calls,
 * then the BrainstormTurn reply. Prose replies are accepted as plain text (no proposed intents) rather than failing the chat.
 */
export async function runBrainstorm(history: ChatMessage[], contextBlock: unknown, language: 'id' | 'en', provider: ChatProvider, o: BrainstormOptions = {}): Promise<BrainstormResult | { ok: false; error: EmError; usage: ChatUsage[]; toolCalls: ToolCallRecord[] }> {
  const usage: ChatUsage[] = []; const toolCalls: ToolCallRecord[] = [];
  const names = BRAINSTORM_TOOL_NAMES.filter((n): n is BrainstormToolName => !!o.tools?.[n]);
  // AI_WORKFLOW §8.1: tools through the provider's tools API when it has one (Claude wrote the JSON-mode protocol as its own XML
  // markup, QA 2026-10-27); the JSON-mode protocol otherwise, where markup the model writes is read as tool calls too.
  const native = !!provider.nativeTools && names.length > 0;
  const specs = native ? toolSpecs(names) : undefined;
  const system = prompts().BRAINSTORM_SYSTEM.replaceAll('{{language_name}}', langName(language)).replaceAll('{{language_code}}', language).replaceAll('{{context_block}}', JSON.stringify(contextBlock)) + toolsPromptBlock(names, 'reply normally', native ? 'native' : 'json')
    + researchPromptBlock(o.research, 'brainstorm');
  const web = nativeWeb(o.research); const cited: WebSource[][] = []; const queries: string[] = []; let notice: { code: string; reason: string } | undefined;
  const w = windowThread(history, threadBudgetChars(o.contextLength, system.length, o.maxTokens ?? 4000));
  const messages = [...w.messages];
  const lastUser = messages.map((m) => m.role).lastIndexOf('user');
  if (o.images?.length && lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, images: o.images };
  const progress = (p: RunProgress) => { try { o.onProgress?.(p); } catch { /* UI hint only */ } };
  let rounds = 0; let forced = false; let shownAny = false;
  try {
    for (;;) {
      // Each round streams its visible prose; a later round starts on a new paragraph in the live bubble.
      const streamer = o.onDelta ? new ReplyStreamer() : null;
      let first = true;
      progress({ phase: 'planning' });
      const extra = { ...(specs ? { tools: specs, toolChoice: rounds >= MAX_TOOL_ROUNDS ? 'none' as const : 'auto' as const } : {}), onActivity: activityProgress(progress, BRAINSTORM_TOOL_NAMES), ...(web ? { webResearch: web } : {}) };
      const r = await callFull(provider, system, [...messages], { temperature: 0.4, ...o, ...(streamer ? { onDelta: (d: string) => {
        const v = streamer.push(d); if (!v) return;
        o.onDelta!(first && shownAny ? `\n\n${v.replace(/^\s+/, '')}` : v); first = false; shownAny = true;
      } } : {}) }, usage, extra);
      if (r.citations?.length) cited.push(r.citations);
      if (r.webQueries?.length) queries.push(...r.webQueries);
      if (r.webNotice) notice = r.webNotice;
      if (r.toolCalls?.length) {                                         // native tool calls
        const turn: ChatMessage = { role: 'assistant', content: r.text, toolCalls: r.toolCalls, ...(r.providerRaw !== undefined ? { providerRaw: r.providerRaw } : {}) };
        if (rounds < MAX_TOOL_ROUNDS) {
          rounds++;
          messages.push(turn, { role: 'user', content: '', toolResults: await runToolCalls(r.toolCalls, o.tools ?? {}, BRAINSTORM_TOOL_NAMES, progress, toolCalls) });
          continue;
        }
        if (!forced) {
          forced = true;
          messages.push(turn, { role: 'user', content: 'No more tool calls. Answer the Creator now with the BrainstormTurn JSON only (reply, optional proposedIntents / questions).',
            toolResults: r.toolCalls.map((c) => ({ id: c.id, name: c.name, content: '{"error":{"message":"No more tool calls in this answer."}}', isError: true })) });
          continue;
        }
      }
      const reqs = names.length ? toolRequestsOf(r.text, extractJson(r.text), BRAINSTORM_TOOL_NAMES) : [];
      if (reqs.length && rounds < MAX_TOOL_ROUNDS) {                     // JSON-mode protocol, or tool calls written as markup
        rounds++;
        const recs: ToolCallRecord[] = [];
        await runToolCalls(reqs, o.tools ?? {}, BRAINSTORM_TOOL_NAMES, progress, recs);
        toolCalls.push(...recs);
        messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: recs.map((x) => toolResultMessage(x).content).join('\n') });
        continue;
      }
      // Tool rounds used up and the model still asks for a tool: one last call that must answer (never a bare "…" reply).
      if (reqs.length && !forced) {
        forced = true;
        messages.push({ role: 'assistant', content: r.text }, { role: 'user', content: 'No more tool calls. Answer the Creator now with the BrainstormTurn JSON only (reply, optional proposedIntents / questions).' });
        continue;
      }
      const turn = parseBrainstormReply(r.text);
      return { ok: true, turn, usage, toolCalls, summary: w.summary, sources: mergeSources([...cited, sourcesOfToolCalls(toolCalls)]),
        webQueries: [...new Set([...queries, ...toolCalls.filter((c) => c.name === 'web.search' && c.ok).map((c) => String((c.input as { query?: unknown })?.query ?? ''))].filter(Boolean))].slice(0, 10), ...(notice ? { researchNotice: notice } : {}) };
    }
  } catch (e) { return { ok: false, error: e as EmError, usage, toolCalls }; }
}

type BrainstormTurnT = ReturnType<typeof BrainstormTurn.parse>;
/**
 * QA 2026-10-25 #16: the BrainstormTurn from any model answer. A schema-valid object is taken as is (its reply unwrapped
 * when the model nested JSON inside it); otherwise the reply text is extracted tolerantly (fences, prose around the JSON,
 * truncated or double-encoded strings, literal escapes; extractReplyText) and the valid parts of the object are kept
 * (questions, each valid proposed intent, suggestedNextStep). The JSON wrapper never reaches the chat.
 */
export function parseBrainstormReply(text: string): BrainstormTurnT {
  const r = extractReplyText(text);
  const json = r.json ?? (() => { const j = extractJson(text); return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, unknown> : undefined; })();
  const reply = (r.text || (json ? '' : stripToolMarkup(text).trim())).slice(0, 4000);
  const turn: BrainstormTurnT = { reply };
  if (json) {
    const shape = BrainstormTurn.shape;
    const q = shape.questions.safeParse(Array.isArray(json['questions']) ? json['questions'].filter((x) => typeof x === 'string' && x.trim()).slice(0, 2) : undefined);
    if (q.success && q.data?.length) turn.questions = q.data;
    // QA 2026-10-27: every proposal is normalised (params default {}, invalid items dropped) before it is stored.
    const items = normalizeProposedIntents(json['proposedIntents'] ?? json['proposed_intents'] ?? json['proposals']);
    if (items.length) turn.proposedIntents = items;
    const n = shape.suggestedNextStep.safeParse(json['suggestedNextStep']);
    if (n.success && n.data) turn.suggestedNextStep = n.data;
  }
  if (!turn.reply && !turn.proposedIntents?.length && !turn.questions?.length) turn.reply = '…';
  return turn;
}

/** windowMessages plus the deterministic summary of what fell out of the window (AI_WORKFLOW §10 `threadSummary`). */
export function windowThread(history: ChatMessage[], maxChars: number): { messages: ChatMessage[]; summary: ThreadSummary | null } {
  const kept: ChatMessage[] = []; let used = 0;
  for (let i = history.length - 1; i >= 0; i--) { const m = history[i]!; if (used + m.content.length > maxChars && kept.length) break; kept.unshift(m); used += m.content.length; }
  const dropped = history.slice(0, history.length - kept.length);
  const summary = dropped.length ? summarizeThread(dropped) : null;
  if (summary) kept.unshift({ role: 'user', content: `(threadSummary) ${summary.text}` });
  if (kept[0]?.role === 'assistant') kept.unshift({ role: 'user', content: '(continuing)' });
  return { messages: kept, summary };
}

/** Context windowing (AI_WORKFLOW §10): keep the newest messages within the character budget; older ones become a summary block. */
export function windowMessages(history: ChatMessage[], maxChars: number): ChatMessage[] {
  return windowThread(history, maxChars).messages;
}
